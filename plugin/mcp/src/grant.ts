/**
 * The orchestrator grant: one credential per machine, from which each agent on
 * it gets its own.
 *
 * WHAT PROBLEM THIS SOLVES, IN ONE PARAGRAPH
 *
 * A session runs one MCP server process, and config.ts resolves one key for it,
 * so every agent in that session acts as one role. A Head that dispatches a
 * planner, a builder, and a verifier therefore has all three writing as whatever
 * the session's key happens to be. The obvious repair — hand the process several
 * keys and let each agent name the role it wants — is not a boundary at all: an
 * agent that selects its own credential can select the one that lets it rewrite
 * the criteria it is about to be judged against, and the database will honour it,
 * because a genuine planner key really did make the request.
 *
 * So the role is pinned to the SERVER, not requested by the caller. The plugin
 * declares one MCP server per role, each launched with SUPERDEV_PINNED_ROLE set
 * to a literal in plugin.json. Each registers for its own role and no other. An
 * agent reaches exactly one of them, because its `tools:` frontmatter names one
 * tool namespace — and frontmatter is a file on disk, not something the model
 * emits. There is no argument anywhere in this path that names a role.
 *
 * WHY THE GRANT HAS ITS OWN FILE, AND WHY THERE IS NO PROJECT SCOPE FOR IT
 *
 * config.json resolves across three levels so a repository can say which role it
 * works as. A grant must not be one of the things a repository can say. If a
 * project-scope file could supply a grant, then checking out a repository would
 * be enough to hand this machine a minting authority — so the grant lives in its
 * own file, at user scope only, and no amount of project configuration can
 * introduce one.
 *
 * WHY A FAILED REGISTRATION NEVER FALLS BACK TO A CONFIGURED KEY
 *
 * This is the load-bearing rule of the whole module. A server pinned to
 * `engineer` whose registration fails must start UNCONFIGURED — never with
 * whatever key config.json happens to hold. Falling back would mean an agent
 * that was supposed to be an engineer quietly acting as a planner because a
 * network call failed, which is precisely the escalation the pinning exists to
 * prevent, arriving through the one path nobody would think to test. A pinned
 * server gets its own credential or it gets none.
 *
 * WHY THE DEFAULT IDENTITY INCLUDES THE PROCESS ID
 *
 * config.ts's default is deliberately stable across restarts, because a lease is
 * held by an identity and one that changed every restart would leave an agent
 * unable to recognise its own in-flight work. Derived keys need the opposite:
 * registering supersedes the previous key for the same identity, so two sessions
 * on one machine sharing a default identity would revoke each other's
 * credentials mid-run. The pid makes concurrent processes distinct, which is the
 * property that matters here; the short TTL makes the churn harmless.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  ConfigError,
  deprecationWarning,
  isRole,
  readEnv,
  ROLES,
  sanitizeAgentId,
  withoutUnexpandedPlaceholders,
  type Role,
} from "./config.ts";

/** How long a derived key lives unless something says otherwise. */
export const DEFAULT_TTL_MINUTES = 720;

export interface GrantConfig {
  readonly apiUrl: string;
  readonly grant: string;
  /** The role this server registers as. Never chosen by a caller. */
  readonly pinnedRole: Role;
  readonly productKey: string;
  readonly agentId: string;
  readonly ttlMinutes: number;
  readonly sources: readonly string[];
}

export interface GrantLoad {
  readonly config: GrantConfig;
  readonly warnings: readonly string[];
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

export function grantConfigPath(env: NodeJS.ProcessEnv): string {
  const home = str(env.SUPERDEV_HOME) ?? homedir();
  return join(home, ".superdev", "orchestrator.json");
}

/**
 * Where the product binding lives. Shared, committed, and deliberately NOT the
 * file the key is in — `.superdev/product.json` says which product this
 * repository is, which is a fact about the checkout that everyone working in it
 * should agree on.
 */
export function productConfigPath(env: NodeJS.ProcessEnv, cwd: string): string {
  const explicit = str(env.SUPERDEV_PRODUCT_CONFIG);
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
  const projectDir = str(env.CLAUDE_PROJECT_DIR) ?? cwd;
  return join(projectDir, ".superdev", "product.json");
}

function readJsonObject(path: string): { raw: Record<string, unknown>; insecure: boolean } | undefined {
  if (!existsSync(path)) return undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigError(`${path} exists but could not be read: ${String(error)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError(`${path} is not valid JSON`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${path} must contain a JSON object`);
  }
  let insecure = false;
  try {
    insecure = (statSync(path).mode & 0o077) !== 0;
  } catch {
    /* a mode we cannot read is not a mode worth complaining about */
  }
  return { raw: raw as Record<string, unknown>, insecure };
}

/**
 * Whether this process is a role-pinned server at all.
 *
 * Only plugin.json sets SUPERDEV_PINNED_ROLE, and it sets it to a literal.
 * Deliberately NOT the same variable as SUPERDEV_ROLE: that one is a user
 * preference that a shell may export, and a shell that exported it would
 * otherwise re-pin every server in the session to one role — turning three
 * separately-credentialled servers back into the single-role arrangement this
 * exists to replace.
 */
export function pinnedRoleOf(env: NodeJS.ProcessEnv): Role | undefined {
  const raw = str(env.SUPERDEV_PINNED_ROLE);
  if (raw === undefined) return undefined;
  if (!isRole(raw)) {
    throw new ConfigError(
      `SUPERDEV_PINNED_ROLE is "${raw}", which is not a role this catalogue defines. ` +
        `Known roles: ${ROLES.join(", ")}. This is set by plugin.json, so a bad value ` +
        `here is a packaging bug rather than anything you can fix in a config file.`,
    );
  }
  return raw;
}

/**
 * Everything a pinned server needs to register, or an explanation of what is
 * missing. Throws ConfigError; the caller starts inert and shows the message.
 */
export function loadGrant(
  pinnedRole: Role,
  rawEnv: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): GrantLoad {
  // See withoutUnexpandedPlaceholders. A pinned server is the case that fails
  // worst without this: SUPERDEV_HOME, SUPERDEV_GRANT, and SUPERDEV_PRODUCT are
  // all declared in plugin.json and all normally unset, and each one silences a
  // file that would otherwise have supplied the right answer.
  const env = withoutUnexpandedPlaceholders(rawEnv);
  const warnings: string[] = [];
  const sources: string[] = [];

  const grantPath = grantConfigPath(env);
  const found = readJsonObject(grantPath);
  if (found) {
    sources.push(grantPath);
    if (found.insecure) {
      warnings.push(
        `${grantPath} is readable by other users on this machine (mode is not 0600). ` +
          "It holds a credential that MINTS credentials, which is worse than a key " +
          `being exposed; run: chmod 600 ${grantPath}`,
      );
    }
  }

  const grantFromEnv = readEnv(env, "SUPERDEV_GRANT");
  if (grantFromEnv.deprecated) {
    warnings.push(deprecationWarning(grantFromEnv.deprecated, "SUPERDEV_GRANT"));
  }
  const grant = grantFromEnv.value ?? str(found?.raw.grant);

  const urlFromEnv = readEnv(env, "SUPERDEV_API_URL");
  if (urlFromEnv.deprecated) {
    warnings.push(deprecationWarning(urlFromEnv.deprecated, "SUPERDEV_API_URL"));
  }
  const apiUrl = urlFromEnv.value ?? str(found?.raw.api_url);

  if (!grant) {
    throw new ConfigError(
      `no orchestrator grant configured, so the ${pinnedRole} server has no way to get ` +
        `a key of its own.\n\n` +
        `A grant is one credential per MACHINE. Every agent on it gets its own short-lived,\n` +
        `role-bound key, so a builder cannot act as a planner and two agents cannot take\n` +
        `each other's work. Put it at:\n\n` +
        `  ${grantPath}   (mode 0600)\n` +
        `  { "api_url": "https://pando-catalog-api.fly.dev", "grant": "pcat_live_..." }\n\n` +
        `Mint one with the owner database credential this plugin deliberately does not hold:\n` +
        `  cd apps/backend && DATABASE_URL=... bun run mint-grant \\\n` +
        `      --org <account> --label "<this machine>" \\\n` +
        `      --roles agent_engineer,agent_quality_assurance,agent_product_manager\n\n` +
        `Until then this server offers its tools and refuses every call. The single-key\n` +
        `arrangement still works: the unpinned "catalog" server reads config.json exactly\n` +
        `as it always has.`,
    );
  }

  if (!apiUrl) {
    throw new ConfigError(
      `${grantPath} has a grant but no api_url, and SUPERDEV_API_URL is not set. ` +
        `Add "api_url" beside the grant.`,
    );
  }

  const productPath = productConfigPath(env, cwd);
  const productFile = readJsonObject(productPath);
  const productKey = str(env.SUPERDEV_PRODUCT) ?? str(productFile?.raw.product_key);
  if (!productKey) {
    throw new ConfigError(
      `this repository is not bound to a product, so there is nothing to register an ` +
        `agent against.\n\n` +
        `  ${productPath}\n` +
        `  { "product_key": "<the product this repository is>" }\n\n` +
        `superdev:init writes this file. Do not guess it from the directory name — a key ` +
        `bound to the wrong product writes nothing and says little about why.`,
    );
  }
  if (productFile) sources.push(productPath);

  const ttlRaw = str(env.SUPERDEV_KEY_TTL_MINUTES);
  let ttlMinutes = DEFAULT_TTL_MINUTES;
  if (ttlRaw !== undefined) {
    const parsed = Number(ttlRaw);
    if (!Number.isInteger(parsed) || parsed < 5 || parsed > 10_080) {
      warnings.push(
        `SUPERDEV_KEY_TTL_MINUTES is "${ttlRaw}", which is not a whole number of minutes ` +
          `between 5 and 10080; using ${DEFAULT_TTL_MINUTES}.`,
      );
    } else {
      ttlMinutes = parsed;
    }
  }

  return {
    config: {
      apiUrl,
      grant,
      pinnedRole,
      productKey,
      agentId: defaultAgentId(env, pinnedRole),
      ttlMinutes,
      sources,
    },
    warnings,
  };
}

/**
 * Distinct per process, so two sessions on one machine do not supersede each
 * other's keys. An explicit SUPERDEV_AGENT_ID still wins, which is how a fleet
 * names its members deliberately.
 */
export function defaultAgentId(env: NodeJS.ProcessEnv, role: Role, pid = process.pid): string {
  const explicit = str(env.SUPERDEV_AGENT_ID);
  if (explicit) return sanitizeAgentId(explicit);
  const host = sanitizeAgentId(hostname().split(".")[0] ?? "agent");
  return sanitizeAgentId(`${host}-${role}-${pid}`);
}

export interface RegisteredKey {
  readonly apiKey: string;
  readonly keyPrefix: string;
  readonly pandoRole: string;
  readonly agentId: string;
  readonly expiresAt: string;
}

/** A registration the catalogue refused, as distinct from one that failed to reach it. */
export class RegistrationError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
  ) {
    super(message);
  }
}

/**
 * Exchanges the machine's grant for this agent's key.
 *
 * Bounded rather than left to the default HTTP timeout, for the reason
 * stdio.ts's whoami call is: this is on the startup path, and a catalogue that
 * is merely slow must not turn into a session that never gets its tools.
 */
export async function registerAgent(
  config: GrantConfig,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  timeoutMs = 10_000,
): Promise<RegisteredKey> {
  const url = `${config.apiUrl.replace(/\/+$/, "")}/v1/agents/register`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.grant}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        product_key: config.productKey,
        role: config.pinnedRole,
        agent_id: config.agentId,
        ttl_minutes: config.ttlMinutes,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new RegistrationError(
      `could not reach ${config.apiUrl} to register this agent ` +
        `(${error instanceof Error ? error.message : String(error)})`,
      undefined,
    );
  }

  if (!response.ok) {
    // The API's message is the useful part and is safe to repeat: a 403 here
    // names what this machine's grant may not do, which is a fact about a
    // credential the reader already holds.
    let detail = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { message?: unknown };
      if (typeof body.message === "string") detail = body.message;
    } catch {
      /* a body that is not JSON adds nothing to the status */
    }
    throw new RegistrationError(detail, response.status);
  }

  const body = (await response.json()) as Record<string, unknown>;
  const apiKey = str(body.api_key);
  if (!apiKey) {
    throw new RegistrationError(
      "the catalogue accepted the registration but returned no key",
      response.status,
    );
  }

  return {
    apiKey,
    keyPrefix: str(body.key_prefix) ?? "",
    pandoRole: str(body.pando_role) ?? config.pinnedRole,
    agentId: str(body.agent_id) ?? config.agentId,
    expiresAt: str(body.expires_at) ?? "",
  };
}
