/**
 * A role-pinned server, driven as an installed plugin actually runs it.
 *
 * WHY THIS SPAWNS THE BUNDLE INSTEAD OF CALLING A FUNCTION
 *
 * The property under test is not "startPinned behaves" — it is "a server
 * launched by plugin.json with SUPERDEV_PINNED_ROLE set to a literal ends up
 * offering that role's tools and no others, or offers a menu that cannot be
 * used at all". Every part of that lives in process startup: which environment
 * variable is read, which credential is accepted, what happens on the failure
 * paths. A unit test of the middle of it would pass while the arrangement was
 * broken at either end.
 *
 * THE ASSERTION THAT IS THE WHOLE POINT
 *
 * "a bare api_key is refused". A pinned server that accepted one would advertise
 * the engineer's menu while holding whatever authority that key carries — which
 * could be the planner's. It would work, every day, until the day a builder
 * rewrote the acceptance criteria it was being judged against, and nothing
 * anywhere would have reported a problem. It is the failure this whole feature
 * exists to make impossible, so it is asserted directly and end to end.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolsForRole } from "../src/roles.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BUNDLE = join(ROOT, "mcp", "dist", "stdio.js");

const scratch: string[] = [];

function dir(): string {
  const made = mkdtempSync(join(tmpdir(), "superdev-pinned-"));
  scratch.push(made);
  return made;
}

async function runtime(): Promise<string> {
  const manifest = await Bun.file(join(ROOT, ".claude-plugin", "plugin.json")).json();
  return manifest.mcpServers["catalog"].command;
}

function writeJson(root: string, name: string, body: unknown, mode = 0o600): void {
  mkdirSync(join(root, ".superdev"), { recursive: true });
  writeFileSync(join(root, ".superdev", name), JSON.stringify(body), { mode });
}

interface Started {
  readonly tools: string[];
  /** The text `catalog_whoami` answered with, and whether it was an error. */
  readonly whoami: { text: string; isError: boolean };
}

/**
 * Starts the bundle with exactly the environment given — nothing inherited but
 * PATH, so a machine that happens to hold a real grant cannot change the result.
 */
async function start(env: Record<string, string>, cwd: string): Promise<Started> {
  const client = new Client({ name: "pinned", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: await runtime(),
    args: [BUNDLE],
    cwd,
    env: { PATH: process.env.PATH ?? "", ...env },
  });

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const result: any = await client.callTool({ name: "catalog_whoami", arguments: {} });
    return {
      tools: listed.tools.map((t) => t.name).sort(),
      whoami: {
        text: (result.content ?? []).map((c: any) => c.text ?? "").join("\n"),
        isError: result.isError === true,
      },
    };
  } finally {
    await client.close();
  }
}

/** Somewhere that does not exist, so nothing on the host machine is consulted. */
const nowhere = (): Record<string, string> => ({
  SUPERDEV_HOME: join(ROOT, "test-fixture-no-such-home"),
  CLAUDE_PROJECT_DIR: join(ROOT, "test-fixture-no-such-project"),
});

afterAll(() => {
  for (const path of scratch) rmSync(path, { recursive: true, force: true });
});

describe("a pinned server with nothing configured", () => {
  test("offers its own role's menu and explains that a grant is missing", async () => {
    const started = await start({ ...nowhere(), SUPERDEV_PINNED_ROLE: "engineer" }, ROOT);

    // Narrowed to the pinned role even with no credential at all: the menu is
    // honest about what this server would be, which is what an agent reading it
    // needs. The full surface would invite it to plan around tools this server
    // is never going to offer.
    expect(started.tools).toEqual([...toolsForRole("engineer")].sort());

    expect(started.whoami.isError).toBe(true);
    expect(started.whoami.text).toContain("orchestrator grant");
    expect(started.whoami.text).toContain("mint-grant");
    // And it must say the single-key arrangement still works, or the reader
    // concludes this release broke their setup.
    expect(started.whoami.text).toContain('the unpinned "catalog" server');
  }, 30_000);
});

describe("what a pinned server will and will not accept as a credential", () => {
  test("REFUSES a bare api_key, and says why", async () => {
    const home = dir();
    const project = dir();
    writeJson(home, "config.json", {
      api_url: "http://catalog.invalid",
      // No role attached to this key anywhere. Its authority is whatever it
      // happens to carry, which is exactly what a pinned server must not build
      // its menu on top of.
      api_key: "pcat_test_0000000000000000000000000000000000000000",
    });
    writeJson(project, "product.json", { product_key: "reelmates" }, 0o644);

    const started = await start(
      {
        SUPERDEV_HOME: home,
        CLAUDE_PROJECT_DIR: project,
        SUPERDEV_PINNED_ROLE: "engineer",
      },
      project,
    );

    expect(started.whoami.isError).toBe(true);
    expect(started.whoami.text).toContain("not one belonging to the \"engineer\" role");
    // The fix, both ways, because the reader has a working key in front of them
    // and needs to know what to do with it.
    expect(started.whoami.text).toContain('"keys": { "engineer"');
  }, 30_000);

  test("ACCEPTS a key named for its own role, because the role chose it", async () => {
    const home = dir();
    const project = dir();
    writeJson(home, "config.json", {
      api_url: "http://catalog.invalid",
      keys: { engineer: "pcat_test_0000000000000000000000000000000000000000" },
    });
    writeJson(project, "product.json", { product_key: "reelmates" }, 0o644);

    const started = await start(
      {
        SUPERDEV_HOME: home,
        CLAUDE_PROJECT_DIR: project,
        SUPERDEV_PINNED_ROLE: "engineer",
      },
      project,
    );

    // Configured: whoami is a real call that fails on the unreachable host,
    // rather than the setup instructions an unconfigured server answers with.
    expect(started.whoami.text).not.toContain("mint-grant");
    // The catalogue is unreachable, so the surface fails open to everything —
    // documented in stdio.ts as deliberate. What matters here is that the server
    // got past configuration at all.
    expect(started.tools.length).toBeGreaterThan(0);
  }, 30_000);

  test("ignores an exported SUPERDEV_API_KEY, which is a bare key in disguise", async () => {
    const home = dir();
    const project = dir();
    writeJson(project, "product.json", { product_key: "reelmates" }, 0o644);

    const started = await start(
      {
        SUPERDEV_HOME: home,
        CLAUDE_PROJECT_DIR: project,
        SUPERDEV_PINNED_ROLE: "engineer",
        SUPERDEV_API_URL: "http://catalog.invalid",
        // The old single-role setup told people to export exactly this. A pinned
        // server that honoured it would inherit whatever role that key carries.
        SUPERDEV_API_KEY: "pcat_test_0000000000000000000000000000000000000000",
      },
      project,
    );

    expect(started.whoami.isError).toBe(true);
    expect(started.whoami.text).toContain("orchestrator grant");
  }, 30_000);
});

describe("what pins a server", () => {
  test("SUPERDEV_ROLE does not — an exported preference cannot re-pin anything", async () => {
    const home = dir();
    const project = dir();
    writeJson(home, "config.json", {
      api_url: "http://catalog.invalid",
      api_key: "pcat_test_0000000000000000000000000000000000000000",
    });

    // No SUPERDEV_PINNED_ROLE: this is the ordinary unpinned server, and it must
    // behave exactly as it always has — bare api_key accepted, role narrowed by
    // preference only.
    const started = await start(
      {
        SUPERDEV_HOME: home,
        CLAUDE_PROJECT_DIR: project,
        SUPERDEV_ROLE: "engineer",
      },
      project,
    );

    expect(started.whoami.text).not.toContain("orchestrator grant");
  }, 30_000);
});

/**
 * 040. The bootstrap server, and the line it must not cross.
 *
 * WHAT IS ACTUALLY UNDER TEST
 *
 * Not that binding works — that needs a catalogue, and the backend suite proves
 * it against a real one. What only exists here is WHICH SERVER IS OFFERED THE
 * TOOL. A builder that could conjure the product it then writes features under
 * would be choosing its own subject, which is the same shape of mistake as
 * choosing its own role, and it would look like a convenience while it did it.
 */
describe("a repository with no product binding (040)", () => {
  /** Lists tools without calling one — the bootstrap server has no whoami. */
  async function toolsOf(env: Record<string, string>, cwd: string): Promise<string[]> {
    const client = new Client({ name: "bootstrap", version: "0.0.0" });
    const transport = new StdioClientTransport({
      command: await runtime(),
      args: [BUNDLE],
      cwd,
      env: { PATH: process.env.PATH ?? "", ...env },
    });
    try {
      await client.connect(transport);
      return (await client.listTools()).tools.map((t) => t.name).sort();
    } finally {
      await client.close();
    }
  }

  /** A grant on disk, and a project directory deliberately holding no binding. */
  function machine(): { env: Record<string, string>; project: string } {
    const home = dir();
    const project = dir();
    writeJson(home, "orchestrator.json", {
      api_url: "http://catalog.invalid",
      grant: "pcat_live_0000000000000000000000000000000000000000",
    });
    return {
      env: { SUPERDEV_HOME: home, CLAUDE_PROJECT_DIR: project },
      project,
    };
  }

  test("the product-manager server offers exactly one tool, and it is the one that fixes this", async () => {
    const { env, project } = machine();
    const tools = await toolsOf({ ...env, SUPERDEV_PINNED_ROLE: "product-manager" }, project);

    // Exactly one. Registering the catalogue surface here would be a lie — this
    // server holds no key and every one of those tools would refuse — and worse,
    // it would invite an agent to plan around them.
    expect(tools).toEqual(["catalog_bind_repository"]);
  });

  test("the engineer server does NOT, and stays inert", async () => {
    const { env, project } = machine();
    const tools = await toolsOf({ ...env, SUPERDEV_PINNED_ROLE: "engineer" }, project);

    expect(tools).not.toContain("catalog_bind_repository");
    // Its own menu, unusable, exactly as before 040: the fix for a builder is
    // still somebody else binding the repository.
    expect(tools).toEqual([...toolsForRole("engineer")].sort());
  });

  test("the quality-assurance server does not either", async () => {
    const { env, project } = machine();
    const tools = await toolsOf({ ...env, SUPERDEV_PINNED_ROLE: "quality-assurance" }, project);
    expect(tools).not.toContain("catalog_bind_repository");
  });

  test("and once a binding exists, the product-manager server is an ordinary pinned server again", async () => {
    const { env, project } = machine();
    writeJson(project, "product.json", { product_key: "reelmates" }, 0o644);

    const tools = await toolsOf({ ...env, SUPERDEV_PINNED_ROLE: "product-manager" }, project);

    // It cannot reach http://catalog.invalid to register, so it is inert — but
    // inert with its ROLE's menu, not with the bootstrap tool. The bootstrap
    // server exists for one condition and disappears when that condition does.
    expect(tools).not.toContain("catalog_bind_repository");
    expect(tools).toEqual([...toolsForRole("product-manager")].sort());
  });
});
