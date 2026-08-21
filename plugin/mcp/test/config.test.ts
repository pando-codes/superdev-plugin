/**
 * Configuration resolution: which file wins, and what happens when none does.
 *
 * WHY THIS IS TESTED AT ALL, GIVEN IT IS "JUST READING A FILE"
 *
 * Because every failure mode of this function presents identically to the
 * person hitting it: the catalog_* tools are not in the session. A precedence
 * bug, a merge bug, and a missing file are the same symptom, several tools away
 * from the cause, and the only way to tell them apart is to have pinned the
 * behaviour here.
 *
 * The precedence itself is the load-bearing claim. `keys` living user-scope
 * while `role` lives project-scope is not an exotic arrangement — it is the one
 * most people will end up with, because credentials belong to a person and the
 * role a repository works as belongs to the repository. That only works if
 * levels MERGE per field rather than the higher one winning outright.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACCESS_REQUEST_URL,
  ConfigError,
  loadConfig,
  PORTAL_URL,
  sanitizeAgentId,
  withoutUnexpandedPlaceholders,
} from "../src/config.ts";

const temps: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "superdev-config-"));
  temps.push(dir);
  return dir;
}

function writeConfig(root: string, body: unknown): string {
  mkdirSync(join(root, ".superdev"), { recursive: true });
  const path = join(root, ".superdev", "config.json");
  writeFileSync(path, JSON.stringify(body), { mode: 0o600 });
  return path;
}

/** Only what loadConfig reads, so the ambient environment cannot leak in. */
function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...overrides };
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("where configuration comes from", () => {
  test("the environment alone is enough, as it always was", () => {
    const { config } = loadConfig(
      env({ SUPERDEV_API_URL: "https://api.test", SUPERDEV_API_KEY: "pcat_live_x" }),
      scratch(),
    );
    expect(config.apiUrl).toBe("https://api.test");
    expect(config.apiKey).toBe("pcat_live_x");
    expect(config.sources).toEqual([]);
  });

  test("the PANDO_CATALOG_* names still work, and say they are the old ones", () => {
    // They are sitting in shell profiles, CI definitions, and container
    // manifests on machines this repository has no reach into. A renamed
    // variable that is silently ignored presents as a missing key, several steps
    // from the cause — so the old names keep working and explain themselves.
    const { config, warnings } = loadConfig(
      env({
        PANDO_CATALOG_API_URL: "https://api.test",
        PANDO_CATALOG_API_KEY: "pcat_live_legacy",
      }),
      scratch(),
    );
    expect(config.apiUrl).toBe("https://api.test");
    expect(config.apiKey).toBe("pcat_live_legacy");
    expect(warnings.join(" ")).toContain("PANDO_CATALOG_API_KEY is the old name");
    expect(warnings.join(" ")).toContain("SUPERDEV_API_KEY");
  });

  test("the current name wins when both are exported, and says nothing about it", () => {
    // Someone mid-migration has both. The one they just added is the one they
    // meant, and warning about the other would be nagging rather than helping.
    const { config, warnings } = loadConfig(
      env({
        SUPERDEV_API_URL: "https://new.test",
        SUPERDEV_API_KEY: "pcat_live_new",
        PANDO_CATALOG_API_URL: "https://old.test",
        PANDO_CATALOG_API_KEY: "pcat_live_old",
      }),
      scratch(),
    );
    expect(config.apiUrl).toBe("https://new.test");
    expect(config.apiKey).toBe("pcat_live_new");
    expect(warnings).toEqual([]);
  });

  test("a user-scope file works with no environment at all", () => {
    const home = scratch();
    writeConfig(home, { api_url: "https://api.test", api_key: "pcat_live_user" });
    const { config } = loadConfig(env({ SUPERDEV_HOME: home }), scratch());
    expect(config.apiKey).toBe("pcat_live_user");
  });

  test("a project-scope file overrides the user's, field by field", () => {
    const home = scratch();
    const project = scratch();
    writeConfig(home, { api_url: "https://api.test", api_key: "pcat_live_user" });
    // The arrangement most people land on: credentials belong to the person,
    // the role belongs to the repository. It only works if these MERGE.
    writeConfig(project, { role: "engineer" });

    const { config } = loadConfig(env({ SUPERDEV_HOME: home }), project);
    expect(config.apiUrl).toBe("https://api.test");
    expect(config.apiKey).toBe("pcat_live_user");
    expect(config.declaredRole).toBe("engineer");
    expect(config.sources).toHaveLength(2);
  });

  test("the environment still beats both", () => {
    const home = scratch();
    const project = scratch();
    writeConfig(home, { api_url: "https://user.test", api_key: "pcat_live_user" });
    writeConfig(project, { api_url: "https://project.test", api_key: "pcat_live_project" });

    const { config } = loadConfig(
      env({
        SUPERDEV_HOME: home,
        SUPERDEV_API_URL: "https://env.test",
        SUPERDEV_API_KEY: "pcat_live_env",
      }),
      project,
    );
    expect(config.apiUrl).toBe("https://env.test");
    expect(config.apiKey).toBe("pcat_live_env");
  });

  test("SUPERDEV_CONFIG points at a file anywhere", () => {
    const home = scratch();
    const elsewhere = scratch();
    const path = join(elsewhere, "custom.json");
    writeFileSync(path, JSON.stringify({ api_url: "https://x.test", api_key: "pcat_live_c" }));
    const { config } = loadConfig(env({ SUPERDEV_HOME: home, SUPERDEV_CONFIG: path }), scratch());
    expect(config.apiKey).toBe("pcat_live_c");
    expect(config.sources).toEqual([path]);
  });
});

describe("one machine, several roles", () => {
  test("a declared role picks its own key", () => {
    const home = scratch();
    writeConfig(home, {
      api_url: "https://api.test",
      api_key: "pcat_live_fallback",
      keys: { engineer: "pcat_live_eng", "product-manager": "pcat_live_pm" },
    });

    const asEngineer = loadConfig(env({ SUPERDEV_HOME: home, SUPERDEV_ROLE: "engineer" }), scratch());
    expect(asEngineer.config.apiKey).toBe("pcat_live_eng");

    const asPlanner = loadConfig(
      env({ SUPERDEV_HOME: home, SUPERDEV_ROLE: "product-manager" }),
      scratch(),
    );
    expect(asPlanner.config.apiKey).toBe("pcat_live_pm");
  });

  test("a role with no key of its own falls back, and SAYS SO", () => {
    const home = scratch();
    writeConfig(home, {
      api_url: "https://api.test",
      api_key: "pcat_live_fallback",
      keys: { "product-manager": "pcat_live_pm" },
    });
    const { config, warnings } = loadConfig(
      env({ SUPERDEV_HOME: home, SUPERDEV_ROLE: "engineer" }),
      scratch(),
    );
    // Silently handing the planner's key to something that asked to be an
    // engineer is the exact opposite of least privilege, and it would be
    // invisible. The key is used, because refusing would break a working
    // single-key setup — but the warning names it.
    expect(config.apiKey).toBe("pcat_live_fallback");
    expect(warnings.join(" ")).toContain("catalog_whoami");
  });

  test("a role the catalogue does not define is refused, with the list", () => {
    expect(() =>
      loadConfig(
        env({
          SUPERDEV_API_URL: "https://api.test",
          SUPERDEV_API_KEY: "pcat_live_x",
          SUPERDEV_ROLE: "wizard",
        }),
        scratch(),
      ),
    ).toThrow(/not a role this catalogue defines/);
  });
});

describe("when it cannot be resolved", () => {
  test("the failure names every place a key could have gone", () => {
    let message = "";
    try {
      loadConfig(env({ SUPERDEV_HOME: scratch() }), scratch());
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("SUPERDEV_API_URL");
    expect(message).toContain(".superdev/config.json");
    expect(message).toContain("mint-key");
    // And somewhere a reader who holds no database credential can actually go.
    expect(message).toContain(ACCESS_REQUEST_URL);
    expect(message).toContain(PORTAL_URL);
  });

  test("malformed JSON is named, not silently treated as absent", () => {
    const home = scratch();
    mkdirSync(join(home, ".superdev"), { recursive: true });
    writeFileSync(join(home, ".superdev", "config.json"), "{ nope");
    expect(() => loadConfig(env({ SUPERDEV_HOME: home }), scratch())).toThrow(ConfigError);
    expect(() => loadConfig(env({ SUPERDEV_HOME: home }), scratch())).toThrow(/not valid JSON/);
  });

  test("a world-readable config warns without refusing to start", () => {
    const home = scratch();
    mkdirSync(join(home, ".superdev"), { recursive: true });
    const path = join(home, ".superdev", "config.json");
    writeFileSync(path, JSON.stringify({ api_url: "https://api.test", api_key: "pcat_live_x" }), {
      mode: 0o644,
    });
    const { config, warnings } = loadConfig(env({ SUPERDEV_HOME: home }), scratch());
    expect(config.apiKey).toBe("pcat_live_x");
    expect(warnings.join(" ")).toContain("chmod 600");
  });
});

describe("who this process is in the queue", () => {
  test("an explicit id wins", () => {
    const { config } = loadConfig(
      env({
        SUPERDEV_API_URL: "https://api.test",
        SUPERDEV_API_KEY: "pcat_live_x",
        SUPERDEV_AGENT_ID: "builder-07",
      }),
      scratch(),
    );
    expect(config.agentId).toBe("builder-07");
  });

  test("the default is stable across restarts, because a lease is held by an identity", () => {
    const args = env({
      SUPERDEV_API_URL: "https://api.test",
      SUPERDEV_API_KEY: "pcat_live_x",
      SUPERDEV_ROLE: "engineer",
    });
    const first = loadConfig(args, scratch()).config.agentId;
    const second = loadConfig(args, scratch()).config.agentId;
    expect(first).toBe(second);
    expect(first).toContain("engineer");
  });

  test("an id the API would reject is repaired here rather than failing per request", () => {
    expect(sanitizeAgentId("  my agent!  ")).toBe("my-agent-");
    expect(sanitizeAgentId("--nope")).toBe("nope");
    expect(sanitizeAgentId("!!!")).toBe("agent");
    expect(sanitizeAgentId("x".repeat(200))).toHaveLength(64);
  });
});

describe("unexpanded placeholders in the environment", () => {
  /**
   * The unpinned `catalog` server's half of the same defect. Its plugin.json
   * block declares SUPERDEV_ROLE, and an unexported one arrived as the literal
   * "${SUPERDEV_ROLE}" — which is not a role, so loadConfig threw, and every
   * tool in the session answered with `"${SUPERDEV_ROLE}" is not a role this
   * catalogue defines`. The user had not named a role at all.
   */
  test("a placeholder role is no role, rather than an invalid one", () => {
    const root = scratch();
    writeConfig(root, { api_url: "https://api.test", api_key: "pcat_live_x" });

    const { config } = loadConfig(
      env({ SUPERDEV_ROLE: "${SUPERDEV_ROLE}", CLAUDE_PROJECT_DIR: root }),
      root,
    );
    expect(config.declaredRole).toBeUndefined();
    expect(config.apiKey).toBe("pcat_live_x");
  });

  test("a placeholder never outranks the file it was meant to defer to", () => {
    const root = scratch();
    writeConfig(root, { api_url: "https://api.test", api_key: "pcat_live_fromfile" });

    const { config, warnings } = loadConfig(
      env({
        SUPERDEV_API_URL: "${SUPERDEV_API_URL}",
        SUPERDEV_API_KEY: "${SUPERDEV_API_KEY}",
        PANDO_CATALOG_API_URL: "${PANDO_CATALOG_API_URL}",
        PANDO_CATALOG_API_KEY: "${PANDO_CATALOG_API_KEY}",
        CLAUDE_PROJECT_DIR: root,
      }),
      root,
    );
    expect(config.apiUrl).toBe("https://api.test");
    expect(config.apiKey).toBe("pcat_live_fromfile");
    expect(warnings.join(" ")).not.toContain("is the old name");
  });

  test("a value that merely mentions one is carried through untouched", () => {
    // Someone who typed this meant something by it, and quietly discarding it
    // would be a second silent failure on top of the one being fixed here.
    const scrubbed = withoutUnexpandedPlaceholders({
      SUPERDEV_API_URL: "https://${host}.example",
      SUPERDEV_API_KEY: "${SUPERDEV_API_KEY}",
      SUPERDEV_ROLE: "engineer",
    });
    expect(scrubbed.SUPERDEV_API_URL).toBe("https://${host}.example");
    expect(scrubbed.SUPERDEV_API_KEY).toBeUndefined();
    expect(scrubbed.SUPERDEV_ROLE).toBe("engineer");
  });
});
