#!/usr/bin/env node
/**
 * The stdio entrypoint.
 *
 * WHY THIS RUNS UNDER NODE
 *
 * The bundle is built `--target=node` and .claude-plugin/plugin.json launches
 * it with `node`, because the plugin's install is a git checkout on someone
 * else's machine. Requiring `bun` on their PATH made the most likely failure of
 * a public install "the catalog_* tools are not there", for a reason that has
 * nothing to do with superdev. Nothing here uses a Bun API — the server speaks
 * fetch, node:fs, node:os, and node:path — so the runtime was a build flag
 * rather than a dependency. `bundle.test.ts` pins that by driving the committed
 * bundle with the interpreter plugin.json actually names.
 *
 * WHY NOTHING HERE MAY WRITE TO STDOUT
 *
 * Under the stdio transport, stdout IS the protocol channel — every byte on it
 * is parsed as a JSON-RPC frame. A single console.log anywhere in this process,
 * including one left in for debugging, corrupts the stream and the session dies
 * with a parse error that points nowhere near the cause. Diagnostics go to
 * stderr, which the client surfaces as server logs. `no-stdout.test.ts` asserts
 * this for the whole package rather than trusting review.
 *
 * The key is read once, never logged, never echoed on failure, and never
 * included in an error message.
 *
 * WHY AN UNCONFIGURED INSTALL STILL STARTS
 *
 * It used to exit, which presented to a new user as a plugin with no tools —
 * the same symptom as a broken install, several steps away from the cause, and
 * with the one message that would have explained it discarded by the process
 * that composed it. So a server with no key starts, registers its tools, and
 * answers every call with those instructions. It is inert: it holds no key, so
 * it makes no request and there is nothing for it to overstate.
 *
 * WHY THE SERVER ASKS THE CATALOGUE WHO IT IS BEFORE REGISTERING ANYTHING
 *
 * So that the tools an agent is offered are the tools its key can actually use.
 * The alternative — offer all 26 and let the refusals teach — costs a turn per
 * discovery and, worse, invites an agent to treat a deliberate boundary as an
 * obstacle to route around.
 *
 * That call is best-effort and short. If the catalogue does not answer, the
 * server starts anyway with the full surface: this narrowing is an ergonomic
 * layer over a boundary Postgres already enforces (see roles.ts), so failing
 * open costs a wider menu, while failing closed would stand up a session with
 * no tools because one HTTP call timed out.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CatalogClient } from "./client.ts";
import {
  ConfigError,
  isRole,
  loadConfig,
  withoutUnexpandedPlaceholders,
  type LoadResult,
  type Role,
} from "./config.ts";
import {
  loadGrant,
  pinnedRoleOf,
  ProductBindingMissingError,
  registerAgent,
  RegistrationError,
} from "./grant.ts";
import { createBootstrapServer } from "./bootstrap.ts";
import { workspaceRoot } from "./workspace.ts";
import { resolveSurface } from "./roles.ts";
import { createMcpServer } from "./server.ts";

/**
 * The environment this process was actually given, with unexpanded `${NAME}`
 * placeholders removed — see withoutUnexpandedPlaceholders in config.ts for
 * what they are and what they broke.
 *
 * Read once, at the top, and used everywhere below instead of process.env, so
 * that "which environment did we decide from" has exactly one answer. loadConfig
 * and loadGrant scrub again on the way in; that is deliberate belt-and-braces,
 * because they are also called from tests and from a future caller who will not
 * have read this comment.
 */
const ENV: NodeJS.ProcessEnv = withoutUnexpandedPlaceholders(process.env);

const note = (line: string): void => {
  process.stderr.write(`superdev: ${line}\n`);
};

/**
 * Asks the catalogue what this key carries: its role, and since 043 its tenants.
 *
 * Bounded rather than left to the default HTTP timeout: this call is on the
 * startup path, and a catalogue that is merely slow must not turn into a
 * session that never gets its tools.
 */
interface KeyIdentity {
  /** What the catalogue says this key carries, or undefined if it could not say. */
  readonly role: string | undefined;
  /**
   * 043's tenants, or undefined if the catalogue could not say.
   *
   * `undefined` and `[]` are deliberately different: the first means "unknown,
   * show everything and let the database refuse", the second means "this key
   * really does carry no tenant beyond delivery". Collapsing them would turn an
   * unreachable catalogue into a session missing half its tools.
   */
  readonly tenants: readonly string[] | undefined;
}

async function identifyKey(apiUrl: string, apiKey: string, agentId: string): Promise<KeyIdentity> {
  const timeout = AbortSignal.timeout(5_000);
  try {
    const response = await fetch(`${apiUrl.replace(/\/+$/, "")}/v1/whoami`, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        "x-pando-agent-id": agentId,
      },
      signal: timeout,
    });
    if (!response.ok) {
      // 401 is worth naming: it is the single most common cause of "the
      // catalog_* tools are not there", and the message an operator needs is
      // "your key was rejected", not "the surface could not be narrowed".
      note(
        response.status === 401
          ? "the catalogue rejected this API key (401). It may be revoked, expired, or " +
              "from another environment. Every tool will still be offered, and every " +
              "call will fail until the key is replaced."
          : `whoami returned ${response.status}; offering every tool and letting the ` +
              "catalogue decide.",
      );
      return { role: undefined, tenants: undefined };
    }
    const body = (await response.json()) as {
      pando_role?: unknown;
      writes?: { product_key?: unknown };
      key?: { expires_in_days?: unknown };
      tenants?: unknown;
    };
    const scope = body.writes?.product_key;
    if (typeof scope === "string") note(`this key writes product "${scope}" and no other`);
    const expiry = expiryWarning(body.key?.expires_in_days);
    if (expiry !== undefined) note(expiry);
    return {
      role: typeof body.pando_role === "string" ? body.pando_role : undefined,
      // A catalogue predating 043 has no `tenants` field at all, and that is
      // not the same as a key with none — so an absent field stays undefined
      // and nothing is narrowed.
      tenants: Array.isArray(body.tenants)
        ? body.tenants.filter((t): t is string => typeof t === "string")
        : undefined,
    };
  } catch (error) {
    note(
      `could not reach ${apiUrl} to identify this key ` +
        `(${error instanceof Error ? error.message : String(error)}); ` +
        "offering every tool and letting the catalogue decide.",
    );
    return { role: undefined, tenants: undefined };
  }
}

/**
 * How much warning is worth giving about a key that is about to stop working.
 *
 * Two weeks, because the fix is not something the holder can do themselves —
 * a key is minted by whoever holds the catalogue's owner credential, so the
 * window has to be long enough to ask someone else and wait.
 */
const EXPIRY_WARNING_DAYS = 14;

/**
 * Says so while the key still works, which is the only time anyone can be told.
 *
 * A lapsed key gets a 401 whose message deliberately will not say whether it
 * was invalid, revoked, or expired — distinguishing them would confirm to a
 * stranger that a key exists. That ambiguity is correct at the API boundary and
 * completely useless to the person whose agent has just stopped, and this is the
 * only place the difference can be surfaced without weakening it.
 *
 * The failure being prevented is not one bad afternoon. Keys minted in the same
 * week expire in the same week, so a cohort onboarded together fails together,
 * ninety days later, with the same uninformative message.
 *
 * `null` means a key that never expires, which is a real and deliberate option
 * (`--no-expiry`) and not a missing value: it must warn about nothing at all.
 * Anything else non-numeric — an older API with no `key` block at all — is also
 * silence, because a client must not warn about a field the server never sent.
 */
export function expiryWarning(daysRaw: unknown): string | undefined {
  // Returns the sentence rather than printing it, so the decision of WHAT to
  // say is testable without capturing a stream. The caller does the printing.
  if (typeof daysRaw !== "number" || !Number.isFinite(daysRaw)) return undefined;
  const days = Math.round(daysRaw);
  if (days > EXPIRY_WARNING_DAYS) return undefined;
  return days <= 0
    ? "this API key expires TODAY. Ask for a replacement now — when it lapses, " +
        "every call fails with a 401 that will not say why."
    : `this API key expires in ${days} day${days === 1 ? "" : "s"}. Ask for a ` +
        "replacement before then: a lapsed key fails with a 401 that cannot tell " +
        "you it was expiry rather than revocation.";
}

async function startConfigured({ config, warnings }: LoadResult): Promise<void> {
  // Reported FIRST, before anything that can fail. Which file supplied the key
  // is the thing an operator needs in order to debug every later failure — a
  // stale URL, a revoked key, a role that is not the one they meant — and
  // saying it only after a successful startup means it is missing from exactly
  // the logs where it would have helped.
  if (config.sources.length > 0) note(`configuration from ${config.sources.join(", ")}`);
  for (const warning of warnings) note(warning);

  const client = new CatalogClient({
    baseUrl: config.apiUrl,
    apiKey: config.apiKey,
    agentId: config.agentId,
    // So a read still answers when the catalogue cannot be reached. See
    // cache.ts for why only a dropped connection falls back and a 403 does not.
    cacheHome: workspaceRoot(),
  });

  const identity = await identifyKey(config.apiUrl, config.apiKey, config.agentId);
  const surface = resolveSurface(identity.role, config.declaredRole, identity.tenants);

  const server = createMcpServer(client, {
    toolNames: surface.names,
    surfaceBasis: surface.basis,
    agentId: config.agentId,
  });

  await server.connect(new StdioServerTransport());

  note(`connected to ${config.apiUrl}`);
  note(`acting as "${config.agentId}"; ${surface.names.size} tools offered, based on ${surface.basis}`);
}

/**
 * A client that cannot be used, for a server that must not use one.
 *
 * The tool handlers return before touching it (see server.ts), so this is the
 * second lock on the same door: were that guard ever removed, the failure would
 * be a loud one here rather than a request built out of an empty key.
 */
function unusableClient(): CatalogClient {
  return new CatalogClient({
    baseUrl: "http://superdev-unconfigured.invalid",
    apiKey: "",
    fetch: (async () => {
      throw new Error("the catalogue was never configured, so nothing may be requested from it");
    }) as unknown as typeof globalThis.fetch,
  });
}

async function startUnconfigured(error: ConfigError, pinned?: Role): Promise<void> {
  note(error.message);
  note(
    "starting anyway with every tool registered — each one answers with those instructions " +
      "until a key is configured, because a plugin that vanishes is harder to fix than one " +
      "that explains itself.",
  );

  // A pinned server narrows to its own role even with no credential at all. The
  // menu is then honest about what this server would be if it were working,
  // which is what the agent reading it needs; showing the full surface would
  // invite it to plan around tools this server is never going to offer.
  //
  // Otherwise SUPERDEV_ROLE still narrows, exactly as it does when the catalogue
  // is unreachable — it may never widen, and there is nothing to widen here in
  // any case: this server holds no key. Read straight from the environment
  // rather than from loadConfig, whose precedence is unchanged and which has
  // already thrown; an unparseable role is simply not a narrowing.
  const declared = ENV.SUPERDEV_ROLE?.trim();
  const declaredRole: Role | undefined =
    pinned ??
    (declared !== undefined && declared !== "" && isRole(declared) ? declared : undefined);
  const surface = resolveSurface(undefined, declaredRole);

  const server = createMcpServer(unusableClient(), {
    toolNames: surface.names,
    unconfigured:
      "The superdev catalogue is not configured, so this tool did nothing. No request was " +
      "made. Show the following to the user; it is the whole of the fix, and only they can " +
      `apply it.\n\n${error.message}`,
  });

  await server.connect(new StdioServerTransport());

  note(`${surface.names.size} tools offered, none of which will work until a key is configured`);
}

/**
 * A pinned server on a machine with no grant, falling back to the key that was
 * configured FOR ITS OWN ROLE.
 *
 * THE LINE THAT MUST HOLD
 *
 * `keys.engineer` is an acceptable credential for the server pinned to
 * `engineer`, because the role picked the key. A bare `api_key` is NOT, because
 * it carries whatever role it happens to carry — and a server that accepted one
 * would offer the engineer's menu while holding the planner's authority, which
 * is worse than offering nothing. `keyedByRole` is how the two are told apart,
 * and every environment variable that could supply a bare key is removed before
 * asking, because an exported shell variable is exactly the bare-key case
 * wearing a different hat.
 *
 * BOTH names are deleted. SUPERDEV_API_KEY is the current one; PANDO_CATALOG_API_KEY
 * is the name it had when this project was called pando-catalog, and config.ts
 * still honours it. Deleting only one would leave the other as a way in — and it
 * would be the OLD one, sitting in shell profiles nobody has revisited, which is
 * the worse half to miss.
 */
async function startPinnedFromConfiguredKey(pinned: Role, absent: ConfigError): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...ENV, SUPERDEV_ROLE: pinned };
  delete env.SUPERDEV_API_KEY;
  delete env.PANDO_CATALOG_API_KEY;

  let loaded: LoadResult;
  try {
    loaded = loadConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    // Neither a grant nor a role-scoped key. Report the grant's message, which
    // is the one that leads somewhere, with the other option named after it.
    await startUnconfigured(
      new ConfigError(
        `${absent.message}\n\nAlternatively, configure a key for this role specifically:\n` +
          `  { "keys": { "${pinned}": "pcat_live_..." } }\n` +
          `A key chosen by the role is not the same as an agent choosing its role, so this\n` +
          `server will use one — but it will not use a bare "api_key", whose authority is\n` +
          `whatever that key happens to carry.`,
      ),
      pinned,
    );
    return;
  }

  if (!loaded.config.keyedByRole) {
    await startUnconfigured(
      new ConfigError(
        `${absent.message}\n\nA key IS configured here, but not one belonging to the ` +
          `"${pinned}" role, so this server will not use it. Its authority is whatever that\n` +
          `key carries, which may be more than a ${pinned} should have — and a server that\n` +
          `offered the ${pinned} menu while holding something else would be lying about the\n` +
          `one thing it exists to be honest about.\n\n` +
          `Either mint a grant, or name the key by role:\n` +
          `  { "keys": { "${pinned}": "pcat_live_..." } }`,
      ),
      pinned,
    );
    return;
  }

  note(
    `no orchestrator grant found; using the configured keys.${pinned} instead. ` +
      "Each agent shares this one credential and therefore one identity — mint a grant " +
      "to give them their own.",
  );
  await startConfigured(loaded);
}

/**
 * A server whose role was pinned by plugin.json: it registers for that role with
 * the machine's grant, and uses the key it is given.
 *
 * THE RULE THIS FUNCTION EXISTS TO KEEP
 *
 * Every failure path here ends in startUnconfigured, and NONE of them falls back
 * to loadConfig(). A server pinned to `engineer` that could not register must
 * hold no credential at all rather than whatever key config.json happens to
 * carry — falling back would mean an agent acting as a role it was not given,
 * arriving through a network failure nobody would think to test, which is the
 * exact escalation the pinning exists to prevent.
 */
/**
 * 040. A live grant, an unbound repository, and one tool that fixes it.
 *
 * WHY THIS DOES NOT REGISTER, RETRY, OR RESTART ITSELF
 *
 * Because a server's credential is resolved once, at startup, and that is the
 * property the pinning rests on. A server that re-registered mid-session after
 * something a tool call did would be a server whose authority changed in
 * response to a request — which is the shape of the thing 039 removed, arriving
 * by a back door. So the tool binds the repository, says plainly that a reload
 * is needed, and this process stays exactly as unprivileged as it started.
 */
async function startBootstrap(missing: ProductBindingMissingError): Promise<void> {
  note(missing.message.split("\n")[0]!);
  note(
    "this machine's grant may be able to create it — offering catalog_bind_repository " +
      "and nothing else, because this server holds no key until a product exists.",
  );

  const server = createBootstrapServer({
    apiUrl: missing.apiUrl,
    grant: missing.grant,
    productPath: missing.productPath,
    projectDir: ENV.CLAUDE_PROJECT_DIR?.trim() || process.cwd(),
    note,
  });

  await server.connect(new StdioServerTransport());
  note("1 tool offered: catalog_bind_repository");
}

async function startPinned(pinned: Role): Promise<void> {
  let grant;
  try {
    grant = loadGrant(pinned);
  } catch (error) {
    // 040. A live grant and an unbound repository is the one failure this
    // session can fix by itself, and only on the server whose role creates
    // products anyway. Checked before the ConfigError branch below, because
    // this IS a ConfigError and the generic path would swallow it.
    if (error instanceof ProductBindingMissingError && pinned === "product-manager") {
      await startBootstrap(error);
      return;
    }
    if (!(error instanceof ConfigError)) throw error;
    // No grant on this machine. That is not automatically a dead end: a
    // configured `keys.<role>` was already the arrangement before grants
    // existed, and using it here is not an escalation, because the key is
    // chosen by the ROLE this server is pinned to and never by the agent
    // calling it. See startPinnedFromConfiguredKey for the line that must hold.
    await startPinnedFromConfiguredKey(pinned, error);
    return;
  }

  if (grant.config.sources.length > 0) {
    note(`configuration from ${grant.config.sources.join(", ")}`);
  }
  for (const warning of grant.warnings) note(warning);

  let registered;
  try {
    registered = await registerAgent(grant.config);
  } catch (error) {
    if (!(error instanceof RegistrationError)) throw error;
    await startUnconfigured(
      new ConfigError(
        `registering this ${pinned} agent with the catalogue failed: ${error.message}\n\n` +
          (error.status === 401
            ? "The machine's orchestrator grant was not accepted — it is unknown, revoked, or\n" +
              "expired. Mint a replacement; note that revoking a grant deliberately stops every\n" +
              "key it ever issued, so other agents on this machine will have stopped too.\n\n"
            : error.status === 403
              ? `This machine's grant exists but may not mint ${pinned} keys, or may not reach\n` +
                `the product "${grant.config.productKey}". Both are decided by the grant itself,\n` +
                "so the fix is a grant with a wider ceiling — not a change here.\n\n"
              : "") +
          "This server is starting with no credential rather than falling back to one\n" +
          "configured for a different role. An agent quietly acting as a role it was not\n" +
          "given is a worse outcome than an agent that cannot act at all.",
      ),
      pinned,
    );
    return;
  }

  const client = new CatalogClient({
    baseUrl: grant.config.apiUrl,
    apiKey: registered.apiKey,
    agentId: registered.agentId,
    cacheHome: workspaceRoot(),
  });

  // No whoami round trip: the registration response already said which role the
  // key carries, and it came from the same statement that minted it. The
  // intersection is still taken, so a catalogue that somehow answered with a
  // different role than was asked for narrows rather than widens.
  const surface = resolveSurface(registered.pandoRole, pinned, registered.tenants);

  const server = createMcpServer(client, {
    toolNames: surface.names,
    surfaceBasis: surface.basis,
    agentId: registered.agentId,
  });

  await server.connect(new StdioServerTransport());

  note(`connected to ${grant.config.apiUrl}`);
  note(
    `registered as "${registered.agentId}" for role "${registered.pandoRole}" on product ` +
      `"${grant.config.productKey}" (key ${registered.keyPrefix}, expires ${registered.expiresAt})`,
  );
  note(`${surface.names.size} tools offered, based on ${surface.basis}`);
}

async function main(): Promise<void> {
  // Asked first, because it decides which of two entirely different credential
  // paths this process is on.
  let pinned: Role | undefined;
  try {
    pinned = pinnedRoleOf(ENV);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    await startUnconfigured(error);
    return;
  }

  if (pinned !== undefined) {
    await startPinned(pinned);
    return;
  }

  let loaded: LoadResult;
  try {
    loaded = loadConfig();
  } catch (error) {
    // Anything that is not a ConfigError is a fault rather than a setup
    // problem, and must still be loud.
    if (!(error instanceof ConfigError)) throw error;
    await startUnconfigured(error);
    return;
  }
  await startConfigured(loaded);
}

await main();
