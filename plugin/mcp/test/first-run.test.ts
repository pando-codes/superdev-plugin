/**
 * What a fresh install does before anyone has configured a key.
 *
 * WHY THIS IS WORTH ITS OWN FILE
 *
 * The first thing a new user experiences is the failure path, and it used to be
 * the worst-described state the server had: loadConfig threw, the process
 * exited, and the catalog_* tools were absent from the session. Absent tools
 * are the symptom of a broken plugin, a bad marketplace install, a version
 * mismatch, and a missing key alike — indistinguishable from each other, and
 * several steps removed from the one message that would have told them apart,
 * which the exiting process wrote to a log they had no reason to open.
 *
 * So an unconfigured server now starts, registers its tools, and hands the
 * instructions to whoever calls one. Three things have to stay true for that to
 * be an improvement rather than a lie, and each is a test below: the tools are
 * really there, a call really does return the guidance instead of crashing, and
 * NOTHING is sent to a catalogue it has no key for.
 *
 * The fourth is the one that matters most and is easiest to lose: a CONFIGURED
 * server is untouched by any of it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCESS_REQUEST_URL, ConfigError, loadConfig, PORTAL_URL } from "../src/config.ts";
import { allTools } from "../src/tools/index.ts";
import { toolsForRole } from "../src/roles.ts";
import { call, startStub, type StubHarness } from "./harness.ts";

const temps: string[] = [];
const open: StubHarness[] = [];

afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function stub(options: Parameters<typeof startStub>[0] = {}): Promise<StubHarness> {
  const h = await startStub(options);
  open.push(h);
  return h;
}

/**
 * The genuine article, not a hand-written stand-in.
 *
 * The entrypoint hands ConfigError's own message to every tool, so a test that
 * invented its own text would pass while the server said something else
 * entirely. This provokes the real one, from a directory that holds no config.
 */
function realGuidance(): string {
  const dir = mkdtempSync(join(tmpdir(), "superdev-firstrun-"));
  temps.push(dir);
  try {
    loadConfig({ SUPERDEV_HOME: dir, CLAUDE_PROJECT_DIR: dir }, dir);
  } catch (error) {
    if (error instanceof ConfigError) return error.message;
    throw error;
  }
  throw new Error("loadConfig accepted an empty directory as configuration");
}

describe("an install with no key", () => {
  test("still registers every tool — an empty session is the symptom of a broken plugin", async () => {
    const h = await stub({ unconfigured: realGuidance() });
    const listed = await h.client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual(allTools.map((t) => t.name).sort());
  });

  test("answers a tool call with the setup instructions rather than crashing", async () => {
    const guidance = realGuidance();
    const h = await stub({ unconfigured: guidance });

    const result = await call(h.client, "catalog_whoami");

    // isError, not a thrown exception: this is a refusal the model can act on,
    // the same distinction the API's own 403s get.
    expect(result.isError).toBe(true);
    // Every precedence, because the reader does not know which one applies.
    expect(result.text).toContain("PANDO_CATALOG_API_URL");
    expect(result.text).toContain(".superdev/config.json");
    // And how to obtain a key at all, since the repository that mints one is
    // not the repository they are standing in.
    expect(result.text).toContain("mint-key");
    // And, for the reader who holds no owner credential and never will, the one
    // instruction in the message they can actually act on.
    // The portal first: the common case is a person whose account exists and
    // whose key has lapsed, and sending them to ask for access is sending them
    // to queue for something they can do themselves.
    expect(result.text).toContain(PORTAL_URL);
    expect(result.text).toContain(ACCESS_REQUEST_URL);
    expect(result.text.indexOf(PORTAL_URL)).toBeLessThan(result.text.indexOf(ACCESS_REQUEST_URL));
    expect(result.text).toContain(guidance);
  });

  test("says so on a WRITE too, instead of appearing to have recorded something", async () => {
    const h = await stub({ unconfigured: realGuidance() });
    const result = await call(h.client, "catalog_push_progress", {
      work_item_key: "wi_a1b2c3",
      kind: "progress",
      body: "Anything at all.",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("PANDO_CATALOG_API_URL");
  });

  test("sends nothing anywhere — it holds no key, so there is nothing to send", async () => {
    const h = await stub({ unconfigured: realGuidance() });
    await call(h.client, "catalog_whoami");
    await call(h.client, "catalog_list_products");
    expect(h.sent).toEqual([]);
  });

  test("says in its instructions that it is unconfigured, before any tool is called", async () => {
    const h = await stub({ unconfigured: realGuidance() });
    const instructions = h.client.getInstructions() ?? "";
    expect(instructions).toContain("HOLDS NO KEY");
  });

  test("still narrows by role, and still cannot widen", async () => {
    // The rule is unchanged by there being no key: a declared role subtracts
    // tools and never adds one. Asserted against roles.ts rather than a literal
    // list, so the two cannot drift apart.
    const engineer = toolsForRole("engineer");
    const h = await stub({ unconfigured: realGuidance(), toolNames: engineer });
    const listed = (await h.client.listTools()).tools.map((t) => t.name);
    expect(listed.sort()).toEqual([...engineer].sort());
    expect(listed).not.toContain("catalog_update_acceptance_criterion");
  });
});

describe("an install WITH a key", () => {
  test("is unchanged: a tool call reaches the catalogue as it always did", async () => {
    const h = await stub();
    h.reply(200, { pando_role: "engineer" });

    const result = await call(h.client, "catalog_whoami");

    expect(result.isError).toBe(false);
    expect(h.only().path).toBe("/v1/whoami");
  });

  test("carries no unconfigured notice in its instructions", async () => {
    const h = await stub();
    expect(h.client.getInstructions() ?? "").not.toContain("HOLDS NO KEY");
  });
});
