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
import { ConfigError, isRole, loadConfig, type LoadResult, type Role } from "./config.ts";
import { resolveSurface } from "./roles.ts";
import { createMcpServer } from "./server.ts";

const note = (line: string): void => {
  process.stderr.write(`pando-catalog-mcp: ${line}\n`);
};

/**
 * Asks the catalogue which role this key carries.
 *
 * Bounded rather than left to the default HTTP timeout: this call is on the
 * startup path, and a catalogue that is merely slow must not turn into a
 * session that never gets its tools.
 */
async function actualRole(apiUrl: string, apiKey: string, agentId: string): Promise<string | undefined> {
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
      return undefined;
    }
    const body = (await response.json()) as { pando_role?: unknown; writes?: { product_key?: unknown } };
    const scope = body.writes?.product_key;
    if (typeof scope === "string") note(`this key writes product "${scope}" and no other`);
    return typeof body.pando_role === "string" ? body.pando_role : undefined;
  } catch (error) {
    note(
      `could not reach ${apiUrl} to identify this key ` +
        `(${error instanceof Error ? error.message : String(error)}); ` +
        "offering every tool and letting the catalogue decide.",
    );
    return undefined;
  }
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
  });

  const role = await actualRole(config.apiUrl, config.apiKey, config.agentId);
  const surface = resolveSurface(role, config.declaredRole);

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

async function startUnconfigured(error: ConfigError): Promise<void> {
  note(error.message);
  note(
    "starting anyway with every tool registered — each one answers with those instructions " +
      "until a key is configured, because a plugin that vanishes is harder to fix than one " +
      "that explains itself.",
  );

  // SUPERDEV_ROLE still narrows, exactly as it does when the catalogue is
  // unreachable — it may never widen, and there is nothing to widen here in any
  // case: this server holds no key. Read straight from the environment rather
  // than from loadConfig, whose precedence is unchanged and which has already
  // thrown; an unparseable role is simply not a narrowing.
  const declared = process.env.SUPERDEV_ROLE?.trim();
  const declaredRole: Role | undefined =
    declared !== undefined && declared !== "" && isRole(declared) ? declared : undefined;
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

async function main(): Promise<void> {
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
