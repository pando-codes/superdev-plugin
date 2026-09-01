/**
 * The pinning, and the things that must not be able to undo it.
 *
 * WHAT IS ACTUALLY UNDER TEST
 *
 * Not "registration works" — the backend suite proves that against a real
 * backlog. What only exists here is the property that makes an agent's role
 * something it was GIVEN: that nothing reachable from a session can change which
 * role this server registers as.
 *
 * There are exactly three ways that could be undone, and each has a test:
 *
 *   1. A shell exporting SUPERDEV_ROLE re-pins the server. It must not — that
 *      variable is a user preference and would otherwise collapse three
 *      separately-credentialled servers back into one role.
 *   2. A repository supplies a grant. It must not — checking out a repository
 *      would then be enough to hand this machine a minting authority.
 *   3. A failed registration falls back to the key in config.json. It must not —
 *      that is an agent acting as a role it was not given, arriving through a
 *      network failure.
 *
 * The third is asserted in stdio's shape rather than here (this module has no
 * fallback path to test); what this file pins down is that `registerAgent` sends
 * the pinned role and nothing else, so there is no argument for a caller to
 * reach.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../src/config.ts";
import {
  DEFAULT_TTL_MINUTES,
  defaultAgentId,
  grantConfigPath,
  loadGrant,
  pinnedRoleOf,
  registerAgent,
  RegistrationError,
  type GrantConfig,
} from "../src/grant.ts";

const temps: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "superdev-grant-"));
  temps.push(dir);
  return dir;
}

function writeGrantFile(home: string, body: unknown, mode = 0o600): string {
  mkdirSync(join(home, ".superdev"), { recursive: true });
  const path = join(home, ".superdev", "orchestrator.json");
  writeFileSync(path, JSON.stringify(body), { mode });
  return path;
}

function writeProduct(project: string, productKey: string): void {
  mkdirSync(join(project, ".superdev"), { recursive: true });
  writeFileSync(
    join(project, ".superdev", "product.json"),
    JSON.stringify({ product_key: productKey }),
  );
}

/** Only what these functions read, so the ambient environment cannot leak in. */
function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...overrides };
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("which role a server is pinned to", () => {
  test("an unpinned server is not pinned", () => {
    expect(pinnedRoleOf(env())).toBeUndefined();
  });

  test("plugin.json's literal is what pins it", () => {
    expect(pinnedRoleOf(env({ SUPERDEV_PINNED_ROLE: "engineer" }))).toBe("engineer");
  });

  test("SUPERDEV_ROLE does NOT pin anything", () => {
    // The separation that makes several role-servers possible in one session. If
    // this variable pinned, a shell that exported it — which is exactly what the
    // old single-role setup told people to do — would re-pin every server in the
    // session to one role, silently undoing the whole arrangement.
    expect(pinnedRoleOf(env({ SUPERDEV_ROLE: "product-manager" }))).toBeUndefined();
  });

  test("a role this backlog does not define is a packaging bug, and says so", () => {
    expect(() => pinnedRoleOf(env({ SUPERDEV_PINNED_ROLE: "superuser" }))).toThrow(ConfigError);
    try {
      pinnedRoleOf(env({ SUPERDEV_PINNED_ROLE: "superuser" }));
    } catch (error) {
      expect((error as Error).message).toContain("plugin.json");
    }
  });
});

describe("where a grant may come from", () => {
  test("user scope, and the path is under the home directory", () => {
    const home = scratch();
    expect(grantConfigPath(env({ SUPERDEV_HOME: home }))).toBe(
      join(home, ".superdev", "orchestrator.json"),
    );
  });

  test("a project cannot supply one", () => {
    // THE ONE THAT MATTERS. A grant mints credentials; if a repository could
    // carry one, cloning a repository would be enough to give this machine a
    // minting authority. There is deliberately no project-scope path in this
    // module, and this test fails the day someone adds one.
    const home = scratch();
    const project = scratch();
    writeProduct(project, "reelmates");

    // A project-scope config.json carrying a grant-looking field, which the
    // grant loader must never read.
    mkdirSync(join(project, ".superdev"), { recursive: true });
    writeFileSync(
      join(project, ".superdev", "config.json"),
      JSON.stringify({ grant: "pcat_live_fromtherepo", api_url: "https://api.test" }),
    );

    expect(() =>
      loadGrant("engineer", env({ SUPERDEV_HOME: home, CLAUDE_PROJECT_DIR: project }), project),
    ).toThrow(ConfigError);
  });

  test("the environment may supply one, for a container or a scheduled run", () => {
    const home = scratch();
    const project = scratch();
    writeProduct(project, "reelmates");

    const { config } = loadGrant(
      "engineer",
      env({
        SUPERDEV_HOME: home,
        CLAUDE_PROJECT_DIR: project,
        SUPERDEV_GRANT: "pcat_live_fromenv",
        SUPERDEV_API_URL: "https://api.test",
      }),
      project,
    );
    expect(config.grant).toBe("pcat_live_fromenv");
    expect(config.pinnedRole).toBe("engineer");
    expect(config.productKey).toBe("reelmates");
  });

  test("a world-readable grant file warns, loudly, but still works", () => {
    const home = scratch();
    const project = scratch();
    writeProduct(project, "reelmates");
    writeGrantFile(home, { api_url: "https://api.test", grant: "pcat_live_x" }, 0o644);

    const { warnings } = loadGrant(
      "engineer",
      env({ SUPERDEV_HOME: home, CLAUDE_PROJECT_DIR: project }),
      project,
    );
    // Refusing would break a working setup over a permission bit; saying nothing
    // would leave a credential-minting credential world-readable in silence.
    expect(warnings.join(" ")).toContain("MINTS credentials");
  });
});

describe("what a pinned server refuses to start without", () => {
  test("a grant, and the message says how to get one", () => {
    const home = scratch();
    const project = scratch();
    writeProduct(project, "reelmates");

    try {
      loadGrant("engineer", env({ SUPERDEV_HOME: home, CLAUDE_PROJECT_DIR: project }), project);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as Error).message;
      expect(message).toContain("mint-grant");
      expect(message).toContain(join(home, ".superdev", "orchestrator.json"));
      // And it must say the old arrangement still works, or the reader concludes
      // this release broke their setup.
      expect(message).toContain('the unpinned "backlog" server');
    }
  });

  test("a product binding, and it refuses to guess one", () => {
    const home = scratch();
    const project = scratch();
    writeGrantFile(home, { api_url: "https://api.test", grant: "pcat_live_x" });

    try {
      loadGrant("engineer", env({ SUPERDEV_HOME: home, CLAUDE_PROJECT_DIR: project }), project);
      throw new Error("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("product.json");
      // A key bound to the wrong product writes nothing and explains little, so
      // guessing from the directory name is worse than refusing.
      expect(message).toContain("Do not guess");
    }
  });
});

describe("the identity a derived key is minted for", () => {
  test("is distinct per process, so two sessions do not revoke each other", () => {
    // config.ts's default is deliberately stable across restarts. Derived keys
    // need the opposite: registering supersedes the previous key for the same
    // identity, so two concurrent sessions sharing one would take turns
    // destroying each other's credentials.
    const a = defaultAgentId(env(), "engineer", 111);
    const b = defaultAgentId(env(), "engineer", 222);
    expect(a).not.toBe(b);
    expect(a).toContain("engineer");
  });

  test("an explicit id still wins, which is how a fleet names its members", () => {
    expect(defaultAgentId(env({ SUPERDEV_AGENT_ID: "builder-7" }), "engineer", 111)).toBe(
      "builder-7",
    );
  });

  test("is always something the API's pattern accepts", () => {
    const id = defaultAgentId(env({ SUPERDEV_AGENT_ID: "has spaces & symbols!" }), "engineer", 1);
    expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/);
  });
});

describe("registering", () => {
  const config: GrantConfig = {
    apiUrl: "https://api.test/",
    grant: "pcat_live_grant",
    pinnedRole: "engineer",
    productKey: "reelmates",
    agentId: "builder-1",
    ttlMinutes: 720,
    sources: [],
  };

  test("asks for the pinned role and nothing else", async () => {
    let seen: { url: string; body: any; auth: string } | undefined;
    const fetchImpl = (async (url: string, init: any) => {
      seen = {
        url,
        body: JSON.parse(init.body),
        auth: init.headers.authorization,
      };
      return new Response(
        JSON.stringify({
          api_key: "pcat_live_derived",
          key_prefix: "pcat_live_ab12",
          pando_role: "engineer",
          agent_id: "builder-1",
          expires_at: "2026-08-22T00:00:00.000Z",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    const registered = await registerAgent(config, fetchImpl);

    expect(seen!.url).toBe("https://api.test/v1/agents/register");
    expect(seen!.auth).toBe("Bearer pcat_live_grant");
    // The role in the request is the pinned one, taken from configuration this
    // process was launched with. There is no parameter on this function a caller
    // could use to ask for a different one.
    expect(seen!.body.role).toBe("engineer");
    expect(seen!.body.agent_id).toBe("builder-1");
    expect(seen!.body.product_key).toBe("reelmates");
    expect(registered.apiKey).toBe("pcat_live_derived");
    expect(registered.pandoRole).toBe("engineer");
  });

  test("a refusal carries its status, so the caller can explain the right fix", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "forbidden", message: "this grant may not mint engineer keys" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch;

    try {
      await registerAgent(config, fetchImpl);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RegistrationError);
      expect((error as RegistrationError).status).toBe(403);
      expect((error as Error).message).toContain("may not mint");
    }
  });

  test("an unreachable backlog is a registration failure, not a crash", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;

    try {
      await registerAgent(config, fetchImpl);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RegistrationError);
      expect((error as RegistrationError).status).toBeUndefined();
    }
  });

  test("a 201 with no key is refused rather than half-used", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ pando_role: "engineer" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch;

    await expect(registerAgent(config, fetchImpl)).rejects.toBeInstanceOf(RegistrationError);
  });
});

describe("an environment full of unexpanded placeholders", () => {
  /**
   * WHAT BROKE, AND WHY IT IS TESTED HERE
   *
   * plugin.json declares every one of these variables as `"NAME": "${NAME}"`,
   * which is how a plugin says "pass this through if the user exported it". When
   * the user did not, the host passes the placeholder through LITERALLY. The
   * environment beats the file at every one of these fields, so a literal
   * placeholder does not merely fail — it silences the file that held the right
   * answer.
   *
   * 0.6.0 shipped in exactly that state. Every pinned server tried to register
   * against the URL `${SUPERDEV_API_URL}`, using `${SUPERDEV_GRANT}` as its
   * grant, for a product literally named `${SUPERDEV_PRODUCT}` — while a
   * perfectly good orchestrator.json sat unread, because SUPERDEV_HOME was a
   * placeholder too and the file was looked for under a relative directory that
   * cannot exist.
   *
   * The failure surfaced as "could not reach ${SUPERDEV_API_URL}", which points
   * at the network. Nothing in it points at the environment.
   */
  const poisoned = {
    SUPERDEV_API_URL: "${SUPERDEV_API_URL}",
    SUPERDEV_GRANT: "${SUPERDEV_GRANT}",
    PANDO_CATALOG_API_URL: "${PANDO_CATALOG_API_URL}",
    PANDO_CATALOG_GRANT: "${PANDO_CATALOG_GRANT}",
    SUPERDEV_AGENT_ID: "${SUPERDEV_AGENT_ID}",
    SUPERDEV_PRODUCT: "${SUPERDEV_PRODUCT}",
    SUPERDEV_PRODUCT_CONFIG: "${SUPERDEV_PRODUCT_CONFIG}",
    SUPERDEV_KEY_TTL_MINUTES: "${SUPERDEV_KEY_TTL_MINUTES}",
  };

  test("the files still win, exactly as if the environment were empty", () => {
    const home = scratch();
    const project = scratch();
    writeProduct(project, "reelmates");
    writeGrantFile(home, { api_url: "https://api.test", grant: "pcat_live_fromfile" });

    const { config, warnings } = loadGrant(
      "engineer",
      env({ ...poisoned, SUPERDEV_HOME: home, CLAUDE_PROJECT_DIR: project }),
      project,
    );

    expect(config.apiUrl).toBe("https://api.test");
    expect(config.grant).toBe("pcat_live_fromfile");
    expect(config.productKey).toBe("reelmates");
    expect(config.pinnedRole).toBe("engineer");
    // A placeholder is an absent variable, so it earns neither the deprecation
    // sentence the PANDO_CATALOG_* names get nor the complaint an unparseable
    // TTL gets. Both would be the server blaming the user for the host's syntax.
    expect(config.ttlMinutes).toBe(DEFAULT_TTL_MINUTES);
    expect(warnings.join(" ")).not.toContain("SUPERDEV_KEY_TTL_MINUTES");
    expect(warnings.join(" ")).not.toContain("is the old name");
  });

  test("a missing product still says the repository is unbound", () => {
    // The placeholder previously SATISFIED this check, so the one message that
    // tells someone what to do never fired and they got a network error instead.
    const home = scratch();
    const project = scratch();
    writeGrantFile(home, { api_url: "https://api.test", grant: "pcat_live_fromfile" });

    expect(() =>
      loadGrant(
        "engineer",
        env({ ...poisoned, SUPERDEV_HOME: home, CLAUDE_PROJECT_DIR: project }),
        project,
      ),
    ).toThrow(/not bound to a product/);
  });

  test("an agent id is derived rather than taken from the placeholder", () => {
    // The id names the agent in every lease it takes, so a literal "${SUPERDEV_AGENT_ID}"
    // would be the name two machines' agents both held.
    const home = scratch();
    const project = scratch();
    writeProduct(project, "reelmates");
    writeGrantFile(home, { api_url: "https://api.test", grant: "pcat_live_fromfile" });

    const { config } = loadGrant(
      "engineer",
      env({ ...poisoned, SUPERDEV_HOME: home, CLAUDE_PROJECT_DIR: project }),
      project,
    );
    expect(config.agentId).not.toContain("$");
    expect(config.agentId).toContain("engineer");
  });
});
