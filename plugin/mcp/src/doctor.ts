/**
 * What this machine is actually holding, and what each server would do with it.
 *
 * WHY A DIAGNOSTIC EXISTS AT ALL
 *
 * Because the question "why is the catalogue not working" had no answer short
 * of reading source. There are two credential kinds, four servers, three
 * configuration precedences, two spellings of every environment variable, and a
 * placeholder-expansion failure mode that silences the file it was supposed to
 * defer to. Every one of those is documented, and the documentation is in this
 * repository rather than on the machine that is failing.
 *
 * The specific failure this replaces: a maintainer with a live grant and no
 * config.json read three source files and made an HTTP call to establish that
 * the unpinned server was unconfigured while the pinned ones were fine. That is
 * a ten-second question and it cost an afternoon, twice.
 *
 * WHY IT MAKES NO NETWORK CALL
 *
 * Because the states worth diagnosing include "the catalogue is unreachable",
 * and a diagnostic that hangs in exactly the case it is most needed is not one.
 * Everything here is answerable from the filesystem and the environment, and it
 * says plainly which questions it did NOT answer — whether a credential is
 * accepted is `catalog_whoami`'s job, and it needs a network.
 *
 * WHAT MUST NEVER APPEAR IN THE OUTPUT
 *
 * A key, a grant, or any part of either beyond the 14-character prefix that
 * `@superdev/catalog-keys` documents as "the only part safe to log or display".
 * This tool's output goes into a transcript by construction — that is the whole
 * point of it — so a secret reaching it is a secret that has to be re-minted.
 * Nothing here reads a credential except to measure its shape.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { environmentOf, isWellFormedKey, keyPrefix } from "@superdev/catalog-keys";
import {
  grantConfigPath,
  isUnexpandedPlaceholder,
  LEGACY_ENV_NAMES,
  projectConfigPath,
  ROLES,
  userConfigPath,
  withoutUnexpandedPlaceholders,
  type Role,
} from "./config.ts";
import { productConfigPath } from "./grant.ts";

/** The three servers plugin.json pins, in the order their agents are listed. */
const PINNED: readonly Role[] = ["product-manager", "engineer", "quality-assurance"];

export interface FileReport {
  readonly path: string;
  readonly present: boolean;
  /** Set when the file is present and could not be parsed. */
  readonly problem: string | undefined;
  /** Mode 0600 or tighter. Only meaningful for files holding a credential. */
  readonly privateMode: boolean;
  /** Top-level field names. Never values — several of them are secrets. */
  readonly fields: readonly string[];
}

export interface CredentialReport {
  /** Where it came from, so "which of the six places" is answered. */
  readonly source: string;
  readonly prefix: string;
  /** `live`, `test`, or undefined when it is not shaped like a key at all. */
  readonly environment: string | undefined;
  readonly wellFormed: boolean;
}

export interface ServerReport {
  readonly name: string;
  /** What it would run on: a derived key, a configured key, or nothing. */
  readonly outcome: string;
  readonly detail: string | undefined;
}

export interface Diagnosis {
  readonly files: readonly FileReport[];
  readonly environment: readonly string[];
  readonly credentials: readonly CredentialReport[];
  readonly servers: readonly ServerReport[];
  readonly problems: readonly string[];
  /**
   * 046. Days until the grant lapses, when orchestrator.json records it.
   * Undefined for a grant minted before mint-grant wrote the field, which is
   * not the same as "no expiry" — a grant always has one.
   */
  readonly grantExpiresInDays: number | undefined;
  readonly nextStep: string;
}

function fileReport(path: string, secret: boolean): FileReport {
  if (!existsSync(path)) {
    return { path, present: false, problem: undefined, privateMode: true, fields: [] };
  }
  let privateMode = true;
  try {
    privateMode = (statSync(path).mode & 0o077) === 0;
  } catch {
    /* a mode we cannot read is not one worth reporting on */
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { path, present: true, problem: "not a JSON object", privateMode, fields: [] };
    }
    return {
      path,
      present: true,
      problem: undefined,
      privateMode: secret ? privateMode : true,
      fields: Object.keys(raw).sort(),
    };
  } catch {
    // Named rather than swallowed. A trailing comma presents as a missing key,
    // which sends the reader to look at their credential rather than their JSON.
    return { path, present: true, problem: "not valid JSON", privateMode, fields: [] };
  }
}

function objectAt(path: string): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/** Every credential this machine holds, measured but never quoted. */
function credentials(
  rawEnv: NodeJS.ProcessEnv,
  userPath: string,
  projectPath: string,
  grantPath: string,
): CredentialReport[] {
  const found: CredentialReport[] = [];

  const measure = (source: string, value: string | undefined): void => {
    if (value === undefined) return;
    // An unexpanded `${...}` is not a malformed credential, it is an unset
    // variable wearing one's name, and every normal install has several. Listing
    // them here put three "is not shaped like a credential" problems in front of
    // a reader whose credentials were fine. The ENVIRONMENT section names them.
    if (isUnexpandedPlaceholder(value)) return;
    found.push({
      source,
      // Truncated by the package that defines the format, rather than by a
      // slice written here that could drift from it.
      prefix: isWellFormedKey(value) ? keyPrefix(value) : value.slice(0, 10),
      environment: environmentOf(value) ?? undefined,
      wellFormed: isWellFormedKey(value),
    });
  };

  measure("SUPERDEV_API_KEY", str(rawEnv.SUPERDEV_API_KEY));
  measure("PANDO_CATALOG_API_KEY", str(rawEnv.PANDO_CATALOG_API_KEY));
  measure("SUPERDEV_GRANT", str(rawEnv.SUPERDEV_GRANT));

  for (const [label, path] of [
    ["user config.json", userPath],
    ["project config.json", projectPath],
  ] as const) {
    if (!existsSync(path)) continue;
    const raw = objectAt(path);
    measure(`${label} api_key`, str(raw.api_key));
    const keys = raw.keys;
    if (typeof keys === "object" && keys !== null && !Array.isArray(keys)) {
      for (const role of ROLES) {
        measure(`${label} keys.${role}`, str((keys as Record<string, unknown>)[role]));
      }
    }
  }

  if (existsSync(grantPath)) measure("orchestrator.json grant", str(objectAt(grantPath).grant));

  return found;
}

/**
 * Diagnoses the machine. Pure: everything comes from the environment and the
 * filesystem, so a test can drive it without a process or a network.
 */
export function diagnose(
  rawEnv: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  defaultRole: Role = "product-manager",
): Diagnosis {
  const env = withoutUnexpandedPlaceholders(rawEnv);

  const userPath = userConfigPath(env);
  const projectPath = projectConfigPath(env, cwd);
  const grantPath = grantConfigPath(env);
  const productPath = productConfigPath(env, cwd);

  const files = [
    fileReport(userPath, true),
    fileReport(projectPath, true),
    fileReport(grantPath, true),
    fileReport(productPath, false),
  ];
  const grantFile = files[2]!;
  const productFile = files[3]!;

  // Names only, never values. Reported from the RAW environment so that a
  // variable which is set-but-unexpanded still shows up — being invisible is
  // exactly how that failure mode stayed unfound for a release.
  const environment: string[] = [];
  for (const name of [
    "SUPERDEV_API_URL",
    "SUPERDEV_API_KEY",
    "SUPERDEV_GRANT",
    "SUPERDEV_ROLE",
    "SUPERDEV_PINNED_ROLE",
    "SUPERDEV_HOME",
    "SUPERDEV_CONFIG",
    "SUPERDEV_PRODUCT",
    "SUPERDEV_PRODUCT_CONFIG",
    "SUPERDEV_AGENT_ID",
    "SUPERDEV_KEY_TTL_MINUTES",
    "CLAUDE_PROJECT_DIR",
    ...Object.values(LEGACY_ENV_NAMES),
  ]) {
    const raw = rawEnv[name];
    if (raw === undefined || raw.trim() === "") continue;
    environment.push(
      env[name] === undefined
        ? `${name}  (unexpanded \${...} placeholder — IGNORED, files still win)`
        : name,
    );
  }

  const creds = credentials(rawEnv, userPath, projectPath, grantPath);

  const apiUrl =
    str(env.SUPERDEV_API_URL) ??
    str(env.PANDO_CATALOG_API_URL) ??
    str(objectAt(projectPath).api_url) ??
    str(objectAt(userPath).api_url) ??
    str(objectAt(grantPath).api_url);

  const declaredRole = str(env.SUPERDEV_ROLE) ?? str(objectAt(projectPath).role) ??
    str(objectAt(userPath).role);

  const haveGrant = grantFile.present && grantFile.problem === undefined &&
    str(objectAt(grantPath).grant) !== undefined;

  // 046. The grant's expiry, if mint-grant recorded it beside the credential.
  // Advisory — the catalogue decides — but it is the only way to answer "is my
  // grant about to lapse" WITHOUT a network call, which matters because once it
  // has lapsed the call that would have said so is the call that fails.
  const grantExpiryDays = ((): number | undefined => {
    const raw = str(objectAt(grantPath).expires_at);
    if (raw === undefined) return undefined;
    const at = Date.parse(raw);
    return Number.isNaN(at) ? undefined : Math.round((at - Date.now()) / 86_400_000);
  })();
  const bareKey =
    str(env.SUPERDEV_API_KEY) ??
    str(env.PANDO_CATALOG_API_KEY) ??
    str(objectAt(projectPath).api_key) ??
    str(objectAt(userPath).api_key);

  const roleKey = (role: Role): boolean =>
    creds.some((c) => c.source.endsWith(`keys.${role}`));

  const servers: ServerReport[] = [];

  // The unpinned server, resolved by the same precedence stdio.ts uses.
  servers.push({
    name: "catalog",
    outcome: bareKey !== undefined
      ? "a configured api_key"
      : haveGrant
        ? `a key derived from the grant, as "${declaredRole ?? defaultRole}"`
        : "NOTHING — it will report setup instructions",
    detail: bareKey === undefined && haveGrant && declaredRole === undefined
      ? `no role is declared, so it defaults to "${defaultRole}"`
      : bareKey === undefined && haveGrant && !productFile.present
        ? "this repository has no product binding, so it offers catalog_bind_repository only"
        : undefined,
  });

  for (const role of PINNED) {
    servers.push({
      name: `catalog-${role}`,
      outcome: haveGrant
        ? "a key derived from the grant"
        : roleKey(role)
          ? `the configured keys.${role}`
          : "NOTHING — it will report setup instructions",
      detail: haveGrant && !productFile.present
        ? role === "product-manager"
          ? "no product binding, so it offers catalog_bind_repository only"
          : "no product binding, so it cannot register"
        : !haveGrant && !roleKey(role) && bareKey !== undefined
          ? "a bare api_key is present and a pinned server will NOT use one"
          : undefined,
    });
  }

  const problems: string[] = [];
  for (const file of files) {
    if (file.problem !== undefined) problems.push(`${file.path} is ${file.problem}`);
    if (file.present && !file.privateMode) {
      problems.push(`${file.path} is readable by other users; run: chmod 600 ${file.path}`);
    }
  }
  for (const cred of creds) {
    if (!cred.wellFormed) {
      problems.push(
        `${cred.source} is not shaped like a credential (expected pcat_live_… or pcat_test_…)`,
      );
      continue;
    }
    // The mismatch that produces a 401 nobody can explain: a key minted against
    // a local stack, pointed at production. Both are valid; only together are
    // they wrong, and nothing else in the system is positioned to notice.
    if (cred.environment === "test" && apiUrl !== undefined && !isLocal(apiUrl)) {
      problems.push(
        `${cred.source} is a TEST credential but api_url is ${apiUrl}. A test key ` +
          `against a live catalogue is rejected as though it were invalid.`,
      );
    }
  }
  if (grantExpiryDays !== undefined && grantExpiryDays <= 30) {
    problems.push(
      grantExpiryDays <= 0
        ? `the grant at ${grantPath} records an expiry that has PASSED. Every agent on this ` +
          `machine derives its key from it, so all of them have stopped.`
        : `the grant at ${grantPath} expires in ${grantExpiryDays} days. Every agent on this ` +
          `machine derives its key from it, so all of them stop together when it lapses.`,
    );
  }
  if (apiUrl === undefined && (haveGrant || bareKey !== undefined)) {
    problems.push("a credential is configured but no api_url is, so nothing knows where to send it");
  }
  // An unexpanded `${...}` is deliberately NOT a problem. It was one before
  // withoutUnexpandedPlaceholders existed — see the comment on it in config.ts
  // for what it broke — but it is scrubbed now, in stdio.ts and again inside
  // loadConfig and loadGrant, so the file it was meant to defer to wins. It is
  // also the state of every normal install: plugin.json declares each variable
  // as `"NAME": "${NAME}"`, so a user who exported none of them gets eight of
  // these. Calling that eight problems buries the real ones and, because
  // nextStep branches on problems being empty, replaces the advice that reader
  // actually needs with "fix the problems above". The ENVIRONMENT section
  // reports them, marked IGNORED, which is the whole of what is true.

  const nextStep = !haveGrant && bareKey === undefined
    ? "This machine holds no credential. Install one — a grant is the one to want."
    : problems.length > 0
      ? "Fix the problems above; they are local and none of them needs the catalogue."
      : !productFile.present
        ? `Nothing is wrong with the credentials. This repository is not bound to a ` +
          `product — run superdev:init, or call catalog_bind_repository.`
        : "Nothing is wrong locally. Call catalog_whoami to find out whether the " +
          "catalogue accepts this credential — that is the half this tool cannot answer.";

  return {
    files,
    environment,
    credentials: creds,
    servers,
    problems,
    grantExpiresInDays: grantExpiryDays,
    nextStep,
  };
}

/** Whether an api_url points somewhere a test credential belongs. */
function isLocal(apiUrl: string): boolean {
  try {
    const host = new URL(apiUrl).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local");
  } catch {
    return false;
  }
}

/** The diagnosis as something a person reads, rather than as JSON. */
export function render(d: Diagnosis): string {
  const lines: string[] = [];
  const mark = (ok: boolean): string => (ok ? "✓" : "✗");

  lines.push("FILES");
  for (const f of d.files) {
    // Three states, not two. A missing config.json on a machine credentialled
    // by a grant is the CORRECT arrangement, and marking it ✗ sends the reader
    // to fix something that is not broken — which is the exact failure this
    // whole tool was written to stop. ✗ means present and wrong.
    const glyph = !f.present ? "·" : f.problem !== undefined || !f.privateMode ? "✗" : "✓";
    const state = !f.present
      ? "not present"
      : f.problem !== undefined
        ? f.problem.toUpperCase()
        : `${f.fields.join(", ") || "empty"}${f.privateMode ? "" : "  [WORLD-READABLE]"}`;
    lines.push(`  ${glyph} ${f.path}`);
    lines.push(`      ${state}`);
  }

  lines.push("", "ENVIRONMENT");
  lines.push(
    d.environment.length === 0
      ? "  nothing set — configuration comes from the files above"
      : d.environment.map((n) => `  ${n}`).join("\n"),
  );

  lines.push("", "CREDENTIALS  (prefixes only — the rest is never displayed)");
  lines.push(
    d.credentials.length === 0
      ? "  none found"
      : d.credentials
          .map((c) => `  ${mark(c.wellFormed)} ${c.prefix}…  ${c.source}`)
          .join("\n"),
  );

  lines.push("", "WHAT EACH SERVER WOULD RUN ON  (not verified against the catalogue)");
  for (const s of d.servers) {
    lines.push(`  ${mark(!s.outcome.startsWith("NOTHING"))} ${s.name.padEnd(26)} ${s.outcome}`);
    if (s.detail !== undefined) lines.push(`      ${s.detail}`);
  }

  if (d.problems.length > 0) {
    lines.push("", "PROBLEMS");
    for (const p of d.problems) lines.push(`  ! ${p}`);
  }

  if (d.grantExpiresInDays !== undefined) {
    lines.push(
      "",
      `GRANT EXPIRY  ${d.grantExpiresInDays} days remaining (as recorded locally by ` +
        `mint-grant; the catalogue decides)`,
    );
  }

  lines.push("", `NEXT: ${d.nextStep}`);
  return lines.join("\n");
}
