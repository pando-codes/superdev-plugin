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
 *   1. Environment       SUPERDEV_API_URL / SUPERDEV_API_KEY
 *   2. Project scope     <project>/.superdev/config.json
 *   3. User scope        ~/.superdev/config.json
 *
 * WHY THE ENVIRONMENT VARIABLES HAVE TWO NAMES
 *
 * They used to be PANDO_CATALOG_*, from when this project was called
 * pando-catalog. The project is superdev; the variables are SUPERDEV_*. The old
 * names are still read, because they are sitting in shell profiles, CI
 * definitions, and container manifests on machines this repository has no
 * reach into — and a renamed variable that is silently ignored presents as a
 * missing key, which is several steps from the cause. They warn on stderr and
 * will keep working until there is a reason to stop them.
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
/**
 * Where someone who already has an account issues themselves a key.
 *
 * Listed BEFORE the access request, because the two audiences arrive here in
 * different proportions: the common case is a person whose account exists and
 * whose key has lapsed or was never configured on this machine, and telling
 * them to ask for access is telling them to queue behind a human for something
 * they can do in a browser in thirty seconds.
 */
export const PORTAL_URL = "https://superdev-portal.vercel.app";

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
  /**
   * Whether `apiKey` came from `keys.<declaredRole>` rather than from a bare
   * `api_key` or the environment.
   *
   * Exists for one caller: a role-pinned server (grant.ts) deciding whether it
   * may use a configured key at all. Falling back to `keys.engineer` is safe for
   * a server pinned to `engineer` — the key was chosen by the ROLE, not by the
   * agent, which is the property that matters. Falling back to a bare `api_key`
   * is not safe, because that key carries whatever role it happens to carry and
   * the pinning would become a suggestion.
   */
  readonly keyedByRole: boolean;
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

/** A value that is nothing but `${NAME}` — the whole of it, not a mention inside it. */
const UNEXPANDED = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/**
 * Whether a value is an unexpanded placeholder rather than something a person set.
 *
 * Exported for doctor.ts, which deliberately reads the RAW environment so that a
 * set-but-unexpanded variable is still visible. Reading raw means it has to make
 * this distinction itself, and it must make it the same way the scrub does —
 * a doctor that disagreed with the loader about what counts as configured would
 * be diagnosing a machine other than the one it is running on.
 */
export const isUnexpandedPlaceholder = (value: string): boolean => UNEXPANDED.test(value.trim());

/**
 * Drops environment entries whose value is an unexpanded `${NAME}` placeholder.
 *
 * WHY THIS EXISTS
 *
 * `plugin.json` declares each server's environment as `"SUPERDEV_API_URL":
 * "${SUPERDEV_API_URL}"`, which is how a plugin says "pass this through if the
 * user exported it". When the user did not export it, the host passes the
 * placeholder through LITERALLY, and every reader below then treats the string
 * `"${SUPERDEV_API_URL}"` as a configured value.
 *
 * That is not a cosmetic wrong answer. Environment beats file everywhere in
 * this module and in grant.ts, so a literal placeholder does not merely fail —
 * it SILENCES the file it was supposed to defer to. 0.6.0 shipped with all four
 * servers in that state: `SUPERDEV_HOME` resolved to `${SUPERDEV_HOME}`, so the
 * orchestrator grant was looked for under a relative directory that cannot
 * exist and the real one was never read; `SUPERDEV_PRODUCT` satisfied the
 * product-binding check, so the message that tells someone to bind their
 * repository never fired. Every one of those failures pointed somewhere other
 * than at the cause.
 *
 * Only a value that is EXACTLY a placeholder is dropped. A value that merely
 * contains one is something a person typed, and guessing at what they meant is
 * a worse failure than carrying it through to a message that quotes it back.
 */
export function withoutUnexpandedPlaceholders(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = { ...env };
  for (const [name, value] of Object.entries(scrubbed)) {
    if (typeof value === "string" && isUnexpandedPlaceholder(value)) delete scrubbed[name];
  }
  return scrubbed;
}

/**
 * The environment variable names, and the ones they used to have.
 *
 * Exported so grant.ts reads them the same way: two modules disagreeing about
 * whether a legacy name is honoured would make "it works for the key but not
 * the grant" a real and very confusing state.
 */
export const LEGACY_ENV_NAMES: Readonly<Record<string, string>> = {
  SUPERDEV_API_URL: "PANDO_CATALOG_API_URL",
  SUPERDEV_API_KEY: "PANDO_CATALOG_API_KEY",
  SUPERDEV_GRANT: "PANDO_CATALOG_GRANT",
};

export interface EnvRead {
  readonly value: string | undefined;
  /** The superseded name this value came from, when it did. */
  readonly deprecated: string | undefined;
}

/**
 * Reads a SUPERDEV_* variable, falling back to the PANDO_CATALOG_* name it
 * replaced.
 *
 * The current name wins outright when both are set, rather than the two being
 * merged or the older one being treated as an error: someone mid-migration has
 * both exported, and the one they just added is the one they meant.
 */
export function readEnv(env: NodeJS.ProcessEnv, name: string): EnvRead {
  const current = str(env[name]);
  if (current !== undefined) return { value: current, deprecated: undefined };
  const legacyName = LEGACY_ENV_NAMES[name];
  const legacy = legacyName === undefined ? undefined : str(env[legacyName]);
  return legacy === undefined
    ? { value: undefined, deprecated: undefined }
    : { value: legacy, deprecated: legacyName };
}

/** The sentence a superseded variable earns. Shared so both modules say it identically. */
export function deprecationWarning(legacyName: string, currentName: string): string {
  return (
    `${legacyName} is the old name for ${currentName}, from when this project was called ` +
    `pando-catalog. It still works and will keep working; rename it when convenient.`
  );
}

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

/**
 * Where the machine's orchestrator grant lives. User scope only — grant.ts's
 * header explains at length why a repository must never be able to supply one.
 *
 * DEFINED HERE, of all places, so that loadConfig can say whether one is
 * present. That matters more than the tidiness of keeping it beside its own
 * loader: the failure this module reports most often is "no api_key", and the
 * single most misleading version of it is the one printed on a machine that is
 * holding a perfectly good grant three lines away in the same directory.
 * grant.ts re-exports it, so there is still one definition.
 */
export function grantConfigPath(env: NodeJS.ProcessEnv): string {
  const home = str(env.SUPERDEV_HOME) ?? homedir();
  return join(home, ".superdev", "orchestrator.json");
}

export interface LoadResult {
  readonly config: SuperdevConfig;
  readonly warnings: readonly string[];
}

export interface ConfigLayers {
  /** The two files' contents, project overwriting user, field by field. */
  readonly merged: RawConfig;
  readonly sources: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Reads the two config files and merges them, without deciding anything.
 *
 * Split out of loadConfig so that the ROLE can be resolved even when the load
 * as a whole fails. That is not a hypothetical: a machine holding an
 * orchestrator grant and no `config.json` at all still has a role to register
 * as — declared in either file, or defaulted — and loadConfig throws before it
 * can be asked. Two readers of the same layers must not disagree about
 * precedence, so there is one function that does the merging and both use it.
 */
export function readConfigLayers(
  rawEnv: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): ConfigLayers {
  const env = withoutUnexpandedPlaceholders(rawEnv);
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

  return { merged: Object.assign({}, ...layers), sources, warnings };
}

/**
 * The role this machine says it works as, or undefined when it says nothing.
 *
 * `SUPERDEV_ROLE` then the merged `role` field — the same precedence loadConfig
 * uses, because it is the same question. Deliberately NOT SUPERDEV_PINNED_ROLE:
 * that one is set by plugin.json to a literal and means something stronger (see
 * grant.ts's pinnedRoleOf).
 */
export function declaredRoleOf(
  rawEnv: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Role | undefined {
  const env = withoutUnexpandedPlaceholders(rawEnv);
  return roleFrom(str(env.SUPERDEV_ROLE) ?? str(readConfigLayers(env, cwd).merged.role));
}

/** Validates a role name, or explains that it is not one. */
function roleFrom(raw: string | undefined): Role | undefined {
  if (raw === undefined) return undefined;
  if (!isRole(raw)) {
    throw new ConfigError(
      `"${raw}" is not a role this catalogue defines. Known roles: ${ROLES.join(", ")}.`,
    );
  }
  return raw;
}

/**
 * What the "no key" message says about the grant sitting next to it.
 *
 * WHY THIS PARAGRAPH IS WORTH THE COMPLICATION
 *
 * A machine can hold a live orchestrator grant and no `config.json` at all —
 * that is the ordinary state after `mint-grant`, because a grant is the only
 * credential a person is meant to install. Before this, the message printed in
 * that state opened with "no api_key configured" and closed by sending the
 * reader to the portal to mint one, while the credential that would have worked
 * sat unmentioned in the same directory. The reader then has two plausible
 * theories and no way to tell them apart, and the likelier one is wrong.
 *
 * Presence is all that is checked. Whether the grant is VALID needs a network
 * call, and this function is composing an error message — a message that
 * blocked on HTTP would be a message that sometimes never arrives.
 */
function grantSituation(env: NodeJS.ProcessEnv): string {
  const path = grantConfigPath(env);
  return existsSync(path)
    ? `A GRANT IS PRESENT at ${path}. It is a separate credential, resolved separately,\n` +
        `and reaching this message means it was not usable here — it did not merely go\n` +
        `unnoticed. Whatever is wrong with it is a different problem from the one above,\n` +
        `and minting a key will not touch it.\n\n`
    : `No orchestrator grant was found either:\n` +
        `  ${path}\n` +
        `That is the OTHER way to credential this machine, and usually the better one:\n` +
        `one file, from which every agent on the machine gets its own role-scoped key.\n\n`;
}

/**
 * Resolves configuration, or explains precisely what is missing.
 *
 * `warnings` are things worth saying on stderr that must not stop the server:
 * an insecure file mode, a declared role with no key of its own. Anything that
 * makes the server unable to function throws instead.
 */
export function loadConfig(
  rawEnv: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): LoadResult {
  // Scrubbed here rather than at the call sites, so that every path into this
  // function is covered by construction — including the one in stdio.ts that
  // builds its own environment object out of process.env.
  const env = withoutUnexpandedPlaceholders(rawEnv);
  const layers = readConfigLayers(env, cwd);
  const warnings: string[] = [...layers.warnings];
  const sources = layers.sources;
  const merged = layers.merged;

  const declaredRole = roleFrom(str(env.SUPERDEV_ROLE) ?? str(merged.role));

  const urlFromEnv = readEnv(env, "SUPERDEV_API_URL");
  if (urlFromEnv.deprecated) {
    warnings.push(deprecationWarning(urlFromEnv.deprecated, "SUPERDEV_API_URL"));
  }
  const apiUrl = urlFromEnv.value ?? str(merged.api_url);

  // A role picks its own key when one is configured for it. This is the whole
  // point of the `keys` map: one machine, several credentials, and the choice
  // made by naming a role rather than by re-exporting a secret.
  const keyed = ((): string | undefined => {
    if (declaredRole === undefined) return undefined;
    const keys = merged.keys;
    if (typeof keys !== "object" || keys === null || Array.isArray(keys)) return undefined;
    return str((keys as Record<string, unknown>)[declaredRole]);
  })();

  const keyFromEnv = readEnv(env, "SUPERDEV_API_KEY");
  if (keyFromEnv.deprecated) {
    warnings.push(deprecationWarning(keyFromEnv.deprecated, "SUPERDEV_API_KEY"));
  }
  const apiKey = keyFromEnv.value ?? keyed ?? str(merged.api_key);

  if (declaredRole !== undefined && keyed === undefined && keyFromEnv.value === undefined) {
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
        `  1. the environment: SUPERDEV_API_URL / SUPERDEV_API_KEY\n` +
        `  2. this project:    ${projectConfigPath(env, cwd)}\n` +
        `  3. this user:       ${userConfigPath(env)}\n\n` +
        `A config file looks like:\n` +
        `  {\n` +
        `    "api_url": "https://pando-catalog-api.fly.dev",\n` +
        `    "api_key": "pcat_live_...",\n` +
        `    "role": "engineer",\n` +
        `    "keys": { "engineer": "pcat_live_...", "product-manager": "pcat_live_..." }\n` +
        `  }\n\n` +
        grantSituation(env) +
        `If you have an account on the hosted catalogue, issue yourself a key:\n` +
        `  ${PORTAL_URL}\n\n` +
        `The catalogue is invite-only while it is in beta. If you do not have an\n` +
        `account yet, ask for one:\n` +
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
      keyedByRole: keyed !== undefined,
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
