/**
 * The unpinned `backlog` server on a machine credentialled by a GRANT.
 *
 * WHY THIS FILE EXISTS
 *
 * `mint-grant` leaves exactly one file behind: `~/.superdev/orchestrator.json`.
 * No `config.json`, because a grant is meant to be the only credential a person
 * installs. That is the ordinary, documented, successful outcome of setting a
 * machine up — and until this file's subject existed, it produced a session in
 * which the three role-pinned servers worked and the unpinned one reported "no
 * api_url and api_key configured".
 *
 * Two credentials on the machine, one never consulted, and the message named
 * the one that was absent. It sends every reader to mint a key they do not
 * need, and it did so on the maintainer's own laptop for weeks.
 *
 * WHAT IS ACTUALLY UNDER TEST
 *
 * Not that registration succeeds — that needs a backlog, and the backend
 * suite proves it against a real one. What lives only here is WHICH CREDENTIAL
 * IS CONSULTED and WHAT IS SAID WHEN IT DOES NOT WORK. Both are decided in
 * process startup, so every test drives the committed bundle the way
 * plugin.json launches it, and points it at a host that cannot answer.
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
  const made = mkdtempSync(join(tmpdir(), "superdev-unpinned-"));
  scratch.push(made);
  return made;
}

function writeJson(root: string, name: string, body: unknown, mode = 0o600): void {
  mkdirSync(join(root, ".superdev"), { recursive: true });
  writeFileSync(join(root, ".superdev", name), JSON.stringify(body), { mode });
}

async function runtime(): Promise<string> {
  const manifest = await Bun.file(join(ROOT, ".claude-plugin", "plugin.json")).json();
  return manifest.mcpServers["backlog"].command;
}

interface Started {
  readonly tools: string[];
  readonly whoami: { text: string; isError: boolean };
}

/**
 * Starts the bundle with exactly the environment given — nothing inherited but
 * PATH, so the real grant on a maintainer's machine cannot change a result.
 *
 * Deliberately never sets SUPERDEV_PINNED_ROLE: every test here is about the
 * server that plugin.json launches WITHOUT one.
 */
async function start(env: Record<string, string>, cwd: string): Promise<Started> {
  const client = new Client({ name: "unpinned", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: await runtime(),
    args: [BUNDLE],
    cwd,
    env: { PATH: process.env.PATH ?? "", ...env },
  });

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const tools = listed.tools.map((t) => t.name).sort();
    // The bootstrap server has no whoami, so asking for one there would throw
    // rather than answer. Nothing is lost: its whole surface is the tool list.
    if (!tools.includes("backlog_whoami")) {
      return { tools, whoami: { text: "", isError: false } };
    }
    const result: any = await client.callTool({ name: "backlog_whoami", arguments: {} });
    return {
      tools,
      whoami: {
        text: (result.content ?? []).map((c: any) => c.text ?? "").join("\n"),
        isError: result.isError === true,
      },
    };
  } finally {
    await client.close();
  }
}

/** A machine set up the way `mint-grant` leaves it: a grant, and nothing else. */
function granted(): { env: Record<string, string>; project: string } {
  const home = dir();
  const project = dir();
  writeJson(home, "orchestrator.json", {
    api_url: "http://backlog.invalid",
    grant: "pcat_live_0000000000000000000000000000000000000000",
  });
  return { env: { SUPERDEV_HOME: home, CLAUDE_PROJECT_DIR: project }, project };
}

afterAll(() => {
  for (const path of scratch) rmSync(path, { recursive: true, force: true });
});

describe("a grant on the machine and no api_key", () => {
  test("USES the grant instead of reporting a missing key", async () => {
    const { env, project } = granted();
    writeJson(project, "product.json", { product_key: "reelmates" }, 0o644);

    const started = await start(env, project);

    // The host cannot answer, so the session is still inert — but for the right
    // reason, and saying so. This is the assertion the whole file is for: the
    // reader must not be sent to mint a key.
    expect(started.whoami.text).toContain("registering this product-manager agent");
    expect(started.whoami.text).toContain("was FOUND and used");
    expect(started.whoami.text).toContain("not a missing key");
    expect(started.whoami.text).not.toContain("no api_url and api_key configured");
  }, 30_000);

  test("registers as the role the repository declares, not the default", async () => {
    const { env, project } = granted();
    writeJson(project, "product.json", { product_key: "reelmates" }, 0o644);
    // A fact about the checkout, exactly as the connect skill recommends
    // arranging it: keys belong to the person, the role belongs to the repo.
    writeJson(project, "config.json", { role: "engineer" });

    const started = await start(env, project);

    expect(started.whoami.text).toContain("registering this engineer agent");
  }, 30_000);

  test("SUPERDEV_ROLE decides it too, for one session", async () => {
    const { env, project } = granted();
    writeJson(project, "product.json", { product_key: "reelmates" }, 0o644);

    const started = await start({ ...env, SUPERDEV_ROLE: "quality-assurance" }, project);

    expect(started.whoami.text).toContain("registering this quality-assurance agent");
  }, 30_000);

  test("an unbound repository gets the bootstrap tool, because the default role creates products", async () => {
    const { env, project } = granted();

    const started = await start(env, project);

    // 040's server, reached from the unpinned entrypoint for the first time.
    // The main thread is where a person runs superdev:init, so this is the
    // server that most needs to be able to fix an unbound checkout.
    expect(started.tools).toEqual(["backlog_bind_repository"]);
  }, 30_000);

  test("but NOT when the declared role is one that may not create products", async () => {
    const { env, project } = granted();
    writeJson(project, "config.json", { role: "engineer" });

    const started = await start(env, project);

    // A builder that could conjure the product it then writes features under
    // would be choosing its own subject. The rule is the role's, not the
    // server's, so it holds on the unpinned path exactly as it does on a pinned
    // one — and the menu narrows to what the declared role would have been.
    expect(started.tools).not.toContain("backlog_bind_repository");
    expect(started.tools).toEqual([...toolsForRole("engineer")].sort());
    expect(started.whoami.text).toContain("not bound to a product");
  }, 30_000);
});

describe("a machine with neither credential", () => {
  test("says so about BOTH, rather than only the key", async () => {
    const home = dir();
    const project = dir();

    const started = await start(
      { SUPERDEV_HOME: home, CLAUDE_PROJECT_DIR: project },
      project,
    );

    expect(started.whoami.isError).toBe(true);
    // The path that has always been named.
    expect(started.whoami.text).toContain("no api_url and api_key configured");
    // And the one that was not. A reader who has a grant in a password manager
    // and no idea this system wants one is the common case in beta.
    expect(started.whoami.text).toContain("No orchestrator grant was found either");
    expect(started.whoami.text).toContain("orchestrator.json");
  }, 30_000);
});

describe("what is unchanged", () => {
  test("a configured api_key still wins, and the grant is never consulted", async () => {
    const { env, project } = granted();
    writeJson(project, "product.json", { product_key: "reelmates" }, 0o644);
    writeJson(project, "config.json", {
      api_url: "http://backlog.invalid",
      api_key: "pcat_test_0000000000000000000000000000000000000000",
    });

    const started = await start(env, project);

    // An explicit key is an explicit instruction. The grant path exists for the
    // machine that has NO key, and must not quietly displace one that was set.
    expect(started.whoami.text).not.toContain("registering this");
    expect(started.whoami.text).not.toContain("was FOUND and used");
  }, 30_000);

  test("an unconfigured server still narrows by a declared role", async () => {
    const home = dir();
    const project = dir();
    writeJson(project, "config.json", { role: "engineer" });

    const started = await start(
      { SUPERDEV_HOME: home, CLAUDE_PROJECT_DIR: project },
      project,
    );

    // Previously only SUPERDEV_ROLE narrowed here, so a repository that declared
    // its role in a file got all 38 tools and an agent was invited to plan
    // around every one of them.
    expect(started.tools).toEqual([...toolsForRole("engineer")].sort());
  }, 30_000);
});
