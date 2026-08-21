/**
 * Where the server gets its API URL, its key, its role, and its identity.
 *
 * WHY THIS IS NOT JUST TWO ENVIRONMENT VARIABLES ANY MORE
 *
 * Two variables in the launching shell can express exactly one thing: this
 * machine, this key. That was enough while superdev was a workflow one person
 * drove. It is not enough for the three things this plugin now has to support:
 *
 *   * A PROJECT-SCOPE install and a USER-SCOPE install differing. A key minted
 *     for one repository's product should not follow you into another
 *     repository, and a personal key should not have to be re-exported per
 *     project. Env vars cannot tell those two cases apart; a file per scope can.
 *   * ONE MACHINE HOLDING SEVERAL ROLES. A planner key and an engineer key are
 *     different credentials with deliberately different authority, and choosing
 *     between them by re-exporting a variable means the choice is invisible and
 *     easy to get wrong.
 *   * WORKING AT ALL WITHOUT A SHELL. A key exported in one terminal does not
 *     exist in the next one, which is the most common way for the catalog_*
 *     tools to be mysteriously absent.
 *
 * So configuration resolves at three precedences, and the environment stays the
 * highest of them — nothing that worked before stops working.
 *
 *   1. Environment       PANDO_CATALOG_API_URL / PANDO_CATALOG_API_KEY
 *   2. Project scope     <project>/.superdev/config.json
 *   3. User scope        ~/.superdev/config.json
 *
 * Fields merge across levels rather than a whole level winning: a user-scope
 * file can hold the URL and the keys while a project-scope file names only which
 * role this repository works as, which is the arrangement most people actually
 * want.
 *
 * WHY THE KEY MAY LIVE IN A FILE AT ALL
 *
 * It is a scoped, revocable API key, not a database credential — that is the
 * whole reason the plugin was built to hold one. A key in a mode-600 file in a
 * home directory is not a weaker position than a key in a shell profile, which
 * is where it was already living.
 *
 * Two things are checked, and only those two, so that this comment stays true.
 * The mode is read on load and a file other users can read earns a warning on
 * stderr — a warning rather than a refusal, since refusing would break a working
 * setup over a permission bit the holder is the only one able to fix. Nothing
 * here inspects .gitignore. The project-scope file is the one at risk of being
 * committed, and keeping it out of a repository is the holder's job: this
 * plugin's own .gitignore ignores `.superdev/config.json` and deliberately not
 * `.superdev/`, because product.json next to it is meant to be shared.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Where someone with no key is sent.
 *
 * This message used to end at "mint a key with the owner database credential",
 * which is a true instruction and an unreachable one: the person reading it has
 * just installed a plugin from a marketplace and does not hold that credential,
 * does not know who does, and has no way to find out from here. For an internal
 * user that sentence was a formality. For everyone else it was the end of the
 * road, several steps after the last thing that worked.
 *
 * So the unconfigured path names somewhere a stranger can actually go. It is a
 * link and nothing else — this process holds no key and sends nothing anywhere,
 * which is the property the whole unconfigured path exists to preserve.
 */
export const ACCESS_REQUEST_URL =
  "https://github.com/pando-codes/superdev-plugin/issues/new?template=access-request.yml";

/** The six roles the catalogue defines. Mirrors private.db_role_map. */
export const ROLES = [
  "product-manager",
  "quality-assurance",
  "engineer",
  "ci",
  "revops",
  "head-of-engineering",
] as const;

export type Role = (typeof ROLES)[number];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export interface SuperdevConfig {
  readonly apiUrl: string;
  readonly apiKey: string;
  /**
   * The role this process INTENDS to act as, when it was stated. Only ever used
   * to pick a key and to narrow the tool surface — never to claim authority.
   * What the key actually carries is decided by the database and reported by
   * `catalog_whoami`.
   */
  readonly declaredRole: Role | undefined;
  readonly agentId: string;
  /** Every file that contributed, for `catalog_whoami`'s diagnostics. */
  readonly sources: readonly string[];
}

export class ConfigError extends Error {}

interface RawConfig {
  api_url?: unknown;
  api_key?: unknown;
  role?: unknown;
  agent_id?: unknown;
  keys?: unknown;
}

function readJson(path: string): { raw: RawConfig; insecure: boolean } | undefined {
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
    // Named explicitly. A malformed config that fell back to "unconfigured"
    // would present as the catalog_* tools simply not being there, which sends
    // people looking at their key rather than at their comma.
    throw new ConfigError(`${path} is not valid JSON`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${path} must contain a JSON object`);
  }
  // World-readable is worth a warning but not a refusal: refusing would break a
  // working setup over a permission bit, and the holder is the only one who can
  // fix it anyway.
  let insecure = false;
  try {
    insecure = (statSync(path).mode & 0o077) !== 0;
  } catch {
    /* a mode we cannot read is not a mode worth complaining about */
  }
  return { raw: raw as RawConfig, insecure };
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/**
 * Where the project-scope file is looked for.
 *
 * CLAUDE_PROJECT_DIR when the host sets it, otherwise the working directory the
 * server was launched in — which for a plugin MCP server is the project root.
 * SUPERDEV_CONFIG overrides both and is absolute, for the case where an agent
 * runs somewhere neither of those is meaningful (a worktree, a container, a
 * scheduled job).
 */
export function projectConfigPath(env: NodeJS.ProcessEnv, cwd: string): string {
  const explicit = str(env.SUPERDEV_CONFIG);
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
  const projectDir = str(env.CLAUDE_PROJECT_DIR) ?? cwd;
  return join(projectDir, ".superdev", "config.json");
}

export function userConfigPath(env: NodeJS.ProcessEnv): string {
  const home = str(env.SUPERDEV_HOME) ?? homedir();
  return join(home, ".superdev", "config.json");
}

export interface LoadResult {
  readonly config: SuperdevConfig;
  readonly warnings: readonly string[];
}

/**
 * Resolves configuration, or explains precisely what is missing.
 *
 * `warnings` are things worth saying on stderr that must not stop the server:
 * an insecure file mode, a declared role with no key of its own. Anything that
 * makes the server unable to function throws instead.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): LoadResult {
  const warnings: string[] = [];
  const sources: string[] = [];

  // Lowest precedence first, so each level overwrites the one below it.
  const layers: RawConfig[] = [];
  for (const path of [userConfigPath(env), projectConfigPath(env, cwd)]) {
    const found = readJson(path);
    if (!found) continue;
    sources.push(path);
    if (found.insecure) {
      warnings.push(
        `${path} is readable by other users on this machine (mode is not 0600). ` +
          "It holds an API key; run: chmod 600 " + path,
      );
    }
    layers.push(found.raw);
  }

  const merged: RawConfig = Object.assign({}, ...layers);

  const declaredRoleRaw = str(env.SUPERDEV_ROLE) ?? str(merged.role);
  if (declaredRoleRaw !== undefined && !isRole(declaredRoleRaw)) {
    throw new ConfigError(
      `"${declaredRoleRaw}" is not a role this catalogue defines. ` +
        `Known roles: ${ROLES.join(", ")}.`,
    );
  }
  const declaredRole = declaredRoleRaw as Role | undefined;

  const apiUrl = str(env.PANDO_CATALOG_API_URL) ?? str(merged.api_url);

  // A role picks its own key when one is configured for it. This is the whole
  // point of the `keys` map: one machine, several credentials, and the choice
  // made by naming a role rather than by re-exporting a secret.
  const keyed = ((): string | undefined => {
    if (declaredRole === undefined) return undefined;
    const keys = merged.keys;
    if (typeof keys !== "object" || keys === null || Array.isArray(keys)) return undefined;
    return str((keys as Record<string, unknown>)[declaredRole]);
  })();

  const apiKey = str(env.PANDO_CATALOG_API_KEY) ?? keyed ?? str(merged.api_key);

  if (declaredRole !== undefined && keyed === undefined && str(env.PANDO_CATALOG_API_KEY) === undefined) {
    warnings.push(
      `role "${declaredRole}" was requested but no keys.${declaredRole} is configured, ` +
        "so the default api_key is being used. Its ACTUAL authority is whatever that key " +
        "carries — ask catalog_whoami rather than assuming the requested role was honoured.",
    );
  }

  if (!apiUrl || !apiKey) {
    const missing = [!apiUrl && "api_url", !apiKey && "api_key"].filter(Boolean).join(" and ");
    throw new ConfigError(
      `no ${missing} configured. Set it in one of, highest precedence first:\n` +
        `  1. the environment: PANDO_CATALOG_API_URL / PANDO_CATALOG_API_KEY\n` +
        `  2. this project:    ${projectConfigPath(env, cwd)}\n` +
        `  3. this user:       ${userConfigPath(env)}\n\n` +
        `A config file looks like:\n` +
        `  {\n` +
        `    "api_url": "https://pando-catalog-api.fly.dev",\n` +
        `    "api_key": "pcat_live_...",\n` +
        `    "role": "engineer",\n` +
        `    "keys": { "engineer": "pcat_live_...", "product-manager": "pcat_live_..." }\n` +
        `  }\n\n` +
        `The hosted catalogue is invite-only while it is in beta. If you do\n` +
        `not have a key yet, ask for one:\n` +
        `  ${ACCESS_REQUEST_URL}\n\n` +
        `If you run your own catalogue, a key is minted with the owner database\n` +
        `credential this plugin deliberately does not hold:\n` +
        `  cd apps/backend && DATABASE_URL=... bun run mint-key \\\n` +
        `      --role agent_engineer --label "<who>" --product <product>`,
    );
  }

  return {
    config: {
      apiUrl,
      apiKey,
      declaredRole,
      agentId: resolveAgentId(env, merged, declaredRole),
      sources,
    },
    warnings,
  };
}

/**
 * Who this process is in the queue, as distinct from which key it holds.
 *
 * A default is supplied rather than left empty because an agent with no
 * identity cannot claim work at all (029 treats undeclared as deny), and
 * "configure an id before you can do anything" is a bad first experience. The
 * default is stable across restarts — host and role, not a pid — because a
 * lease is held by an IDENTITY, and one that changed on every restart would
 * make an agent unable to recognise its own in-flight work.
 *
 * A fleet on one machine and one role MUST set SUPERDEV_AGENT_ID per member, or
 * they will share an identity and be able to finish each other's items. The
 * per-call override on the work tools exists for the same reason.
 */
function resolveAgentId(
  env: NodeJS.ProcessEnv,
  merged: RawConfig,
  role: Role | undefined,
): string {
  const explicit = str(env.SUPERDEV_AGENT_ID) ?? str(merged.agent_id);
  if (explicit) return sanitizeAgentId(explicit);
  const host = sanitizeAgentId(hostname().split(".")[0] ?? "agent");
  return sanitizeAgentId(role ? `${host}-${role}` : host);
}

/** Mirrors the API's own pattern, so a bad id is caught here rather than as a 400. */
export function sanitizeAgentId(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9._:-]/g, "-").replace(/^[^A-Za-z0-9]+/, "");
  const trimmed = cleaned.slice(0, 64);
  return trimmed === "" ? "agent" : trimmed;
}
