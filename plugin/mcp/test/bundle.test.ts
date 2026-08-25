/**
 * The committed bundle, treated as the artifact it is.
 *
 * WHY THE BUNDLE IS COMMITTED AT ALL
 *
 * A plugin installed from GitHub is a git checkout and nothing more — no
 * install step runs, so there is no node_modules for an import to resolve
 * against. `mcp/src/stdio.ts` imports @modelcontextprotocol/sdk and zod, so
 * shipping the source alone would leave every fresh install depending on Bun's
 * auto-install reaching the registry at the exact moment Claude Code launches
 * the server. When that fails it fails as an MCP that never connects, which is
 * about the least diagnosable failure available. `mcp/dist/stdio.js` inlines
 * both dependencies, so the plugin works the instant it is cloned.
 *
 * WHAT A COMMITTED ARTIFACT COSTS, AND WHAT PAYS FOR IT
 *
 * It can go stale. Someone edits mcp/src, runs the suite, sees green, and ships
 * a bundle built from the previous revision — the tests all passed because they
 * import the SOURCE, and nothing in them ever loaded the file that actually
 * runs in production. That is what the staleness test below exists for, and it
 * is the reason it compares bytes rather than trusting a timestamp.
 *
 * WHY EVERY SPAWN HERE USES THE INTERPRETER plugin.json NAMES
 *
 * The bundle used to be built `--target=bun` and launched with `bun`, which
 * made a Bun installation a hard requirement of installing this plugin — for a
 * server that speaks only fetch, node:fs, node:os, and node:path, and uses no
 * Bun API at all. On a machine without Bun that presents as an MCP server that
 * never connects, which is the least diagnosable failure available and the most
 * likely one for a public install.
 *
 * So the runtime is read out of .claude-plugin/plugin.json and the build
 * command out of package.json, and every process below is started the way an
 * installed copy would be. Reverting either to Bun fails here rather than on
 * someone else's laptop.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCESS_REQUEST_URL, PORTAL_URL } from "../src/config.ts";
import { allTools } from "../src/tools/index.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BUNDLE = join(ROOT, "mcp", "dist", "stdio.js");

const scratch: string[] = [];

/** The interpreter an installed plugin launches the bundle with. */
async function runtime(): Promise<string> {
  const manifest = await Bun.file(join(ROOT, ".claude-plugin", "plugin.json")).json();
  return manifest.mcpServers["catalog"].command;
}

/** The build command as shipped, with its outfile pointed somewhere else. */
async function buildCommand(outfile: string): Promise<string[]> {
  const pkg = await Bun.file(join(ROOT, "package.json")).json();
  const argv: string[] = String(pkg.scripts.build).split(/\s+/);
  const at = argv.indexOf("--outfile");
  if (at === -1) throw new Error(`the build script names no --outfile: ${pkg.scripts.build}`);
  argv[at + 1] = outfile;
  return argv;
}

afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

describe("the committed bundle", () => {
  /**
   * WHY "IS IT TRACKED" IS A SEPARATE TEST FROM "DOES IT EXIST"
   *
   * Every other assertion in this file reads the bundle off the DISK, where it
   * is sitting because a build just wrote it. None of them can tell the
   * difference between a file that ships and a file that merely exists locally.
   *
   * That difference cost a broken release. Consolidating the two repositories
   * brought a root .gitignore containing a bare `dist`, which matched
   * apps/plugin/mcp/dist and silently excluded the bundle from `git add -A`.
   * Every test here still passed — the file was on disk — and the plugin
   * installed from GitHub with all seven skills, all three agents, and no MCP
   * server whatsoever. It was caught by installing it.
   *
   * So this asserts the property that actually matters for a plugin whose
   * install is a git checkout: the bundle is in the INDEX, not just the
   * directory.
   */
  test("is tracked by git — an untracked bundle ships as a plugin with no server", () => {
    const inRepo = Bun.spawnSync({
      cmd: ["git", "rev-parse", "--is-inside-work-tree"],
      cwd: ROOT,
      stderr: "pipe",
    });
    // Vendored somewhere without git, this question has no answer and the file
    // being present is all that can be checked. Skip rather than fail.
    if (inRepo.exitCode !== 0) return;

    const tracked = Bun.spawnSync({
      cmd: ["git", "ls-files", "--error-unmatch", "mcp/dist/stdio.js"],
      cwd: ROOT,
      stderr: "pipe",
    });
    expect({
      bundle: "mcp/dist/stdio.js",
      tracked: tracked.exitCode === 0,
    }).toEqual({ bundle: "mcp/dist/stdio.js", tracked: true });
  });

  test("exists where .claude-plugin/plugin.json says it does", async () => {
    const manifest = await Bun.file(join(ROOT, ".claude-plugin", "plugin.json")).json();
    const args: string[] = manifest.mcpServers["catalog"].args;
    // The manifest addresses it through ${CLAUDE_PLUGIN_ROOT}, which is the
    // plugin root at runtime; the tail of that path is what must exist here.
    expect(args.some((a) => a.endsWith("/mcp/dist/stdio.js"))).toBe(true);
    expect(await Bun.file(BUNDLE).exists()).toBe(true);
  });

  test("is current with mcp/src", async () => {
    const dir = await mkdtemp(join(tmpdir(), "superdev-bundle-"));
    scratch.push(dir);
    const rebuilt = join(dir, "stdio.js");

    // The SHIPPED build command, not a copy of it. A copy would keep passing
    // after `bun run build` changed target, and the committed bundle would then
    // be the only thing built the old way.
    const build = Bun.spawnSync({ cmd: await buildCommand(rebuilt), cwd: ROOT });
    expect(build.exitCode).toBe(0);

    const [committed, fresh] = await Promise.all([
      Bun.file(BUNDLE).text(),
      Bun.file(rebuilt).text(),
    ]);
    // If this fails, `bun run build` was not run after the last edit to mcp/src.
    // Every other test in this repository imports the source and would stay
    // green while the file that actually ships was a revision behind.
    expect(fresh).toBe(committed);
  });

  test("runs a real stdio session with no node_modules to resolve against", async () => {
    // The cwd is a scratch directory precisely so nothing can resolve upward
    // into this repository's node_modules. If the bundle were not self-contained
    // this is where it would fail, and it is the exact condition every installed
    // copy of the plugin runs under.
    const dir = await mkdtemp(join(tmpdir(), "superdev-run-"));
    scratch.push(dir);

    const client = new Client({ name: "bundle-smoke", version: "0.0.0" });
    const transport = new StdioClientTransport({
      command: await runtime(),
      args: [BUNDLE],
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "",
        // Never contacted: listing tools is answered by the server itself.
        SUPERDEV_API_URL: "http://catalog.invalid",
        SUPERDEV_API_KEY: "pcat_live_0000000000000000000000000000000000000000",
      },
    });

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name).sort()).toEqual(allTools.map((t) => t.name).sort());

      const resources = await client.listResources();
      expect(resources.resources).toHaveLength(5);
    } finally {
      await client.close();
    }
  }, 30_000);

  /**
   * WHY THESE POINT SUPERDEV_HOME AND CLAUDE_PROJECT_DIR AT NOTHING
   *
   * Configuration now resolves from files as well as the environment, and
   * `os.homedir()` does not need HOME to find a real home directory. Left
   * unset, this test would consult whatever config the machine running it
   * happens to have — passing on a laptop with no key and failing on one with
   * a key, for reasons nothing about the test would explain. Both directories
   * are named, and named at somewhere that does not exist.
   */
  const nowhere = (): Record<string, string> => ({
    PATH: process.env.PATH ?? "",
    SUPERDEV_HOME: join(ROOT, "test-fixture-no-such-home"),
    CLAUDE_PROJECT_DIR: join(ROOT, "test-fixture-no-such-project"),
  });

  /**
   * WHY THIS NO LONGER ASSERTS AN EXIT CODE
   *
   * It used to: nothing configured meant the process wrote its instructions to
   * stderr and exited 1. The instructions were excellent and nobody read them —
   * what a new user saw was a session with no catalog_* tools in it, which is
   * also what a failed install, a bad marketplace entry, and a crashed server
   * look like. The one process holding the explanation threw it away.
   *
   * So an unconfigured server starts and puts the explanation where the person
   * who can act on it will see it: in the answer to any tool they call.
   */
  test("starts with nothing configured, and every tool explains what is missing", async () => {
    const client = new Client({ name: "first-run", version: "0.0.0" });
    const transport = new StdioClientTransport({
      command: await runtime(),
      args: [BUNDLE],
      cwd: ROOT,
      env: nowhere(),
    });

    try {
      await client.connect(transport);

      // The whole menu is there. An absent tool is the symptom this exists to
      // stop producing.
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name).sort()).toEqual(allTools.map((t) => t.name).sort());

      const result: any = await client.callTool({ name: "catalog_whoami", arguments: {} });
      const text = (result.content ?? []).map((c: any) => c.text ?? "").join("\n");
      expect(result.isError).toBe(true);
      // All three precedences, because the whole point of the message is that
      // the reader does not have to know which one applies to them.
      expect(text).toContain("SUPERDEV_API_URL");
      expect(text).toContain(".superdev/config.json");
      // And how to get a key, since the repository that mints one is not the
      // repository the user is standing in.
      expect(text).toContain("mint-key");
      expect(text).toContain(ACCESS_REQUEST_URL);
      expect(text).toContain(PORTAL_URL);
    } finally {
      await client.close();
    }
  }, 30_000);

  test("starts from a project-scope config file alone, with no environment", async () => {
    const project = mkdtempSync(join(tmpdir(), "superdev-bundle-"));
    try {
      mkdirSync(join(project, ".superdev"));
      writeFileSync(
        join(project, ".superdev", "config.json"),
        JSON.stringify({ api_url: "http://catalog.invalid", api_key: "pcat_test_x" }),
        { mode: 0o600 },
      );
      // The server must get past configuration and reach the transport. It
      // cannot reach http://catalog.invalid, which is the point — an
      // unreachable catalogue must not stop it starting, because the tool
      // surface is an optimisation and the database is the real boundary.
      const child = Bun.spawn({
        cmd: [await runtime(), BUNDLE],
        cwd: ROOT,
        env: { ...nowhere(), CLAUDE_PROJECT_DIR: project },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      // Waits for the LAST line asserted on, not the first. An earlier version
      // waited for "connected to" and then asserted on two lines the server
      // writes after it — which passed in isolation, where all three arrived in
      // one chunk, and failed in the full suite, where they did not. A stream
      // assertion has to wait for the thing it is actually asserting.
      const stderr = await readUntil(child.stderr as ReadableStream, "tools offered", 15_000);
      child.kill();
      expect(stderr).toContain("connected to http://catalog.invalid");
      // Derived rather than written out: the count is incidental, and a literal
      // here turns "a tool was added" into a failure that says nothing.
      expect(stderr).toContain(`${allTools.length} tools offered`);
      expect(stderr).toContain(join(project, ".superdev", "config.json"));
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * The runtime contract, pinned so that going back to a Bun-only bundle is loud.
 *
 * The tests above already PROVE it — every process they spawn is started with
 * whatever plugin.json names, so pointing the manifest back at `bun` while the
 * bundle stayed `--target=node` would still pass on a developer's machine,
 * where both interpreters exist. These three make the claim directly, because
 * the machine that would actually break is one nobody here is sitting at.
 */
describe("the runtime an installed plugin needs", () => {
  test("is node — a plugin that requires bun on PATH fails at the install nobody watches", async () => {
    const manifest = await Bun.file(join(ROOT, ".claude-plugin", "plugin.json")).json();
    expect(manifest.mcpServers["catalog"].command).toBe("node");
  });

  test("is what the bundle is built for", async () => {
    const pkg = await Bun.file(join(ROOT, "package.json")).json();
    // --target=bun emits a bundle that may lean on Bun's own module resolution
    // and globals. The build flag and the launch command have to agree, and the
    // failure when they do not is an MCP server that never connects.
    expect(String(pkg.scripts.build)).toContain("--target=node");
  });

  test("is a choice mcp/src permits: nothing in it calls a Bun API", async () => {
    // This is what makes the target a build flag rather than a dependency. If
    // it ever stops being true, the honest answer is to go back to bun and say
    // so — not to ship a node bundle that dies on the first call.
    for await (const file of new Glob("**/*.ts").scan({ cwd: join(ROOT, "mcp", "src") })) {
      const source = await Bun.file(join(ROOT, "mcp", "src", file)).text();
      const usesBun = /(^|[^\w.])Bun\s*\./.test(source.replace(/\/\*[\s\S]*?\*\//g, ""));
      expect([file, usesBun]).toEqual([file, false]);
    }
  });
});

/** Reads a stream until it contains `needle`, or the timeout elapses. */
async function readUntil(stream: ReadableStream, needle: string, ms: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + ms;
  let seen = "";
  try {
    while (!seen.includes(needle) && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return seen;
}
