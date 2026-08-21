/**
 * Under the stdio transport, stdout IS the JSON-RPC channel.
 *
 * One console.log anywhere in this package — including one left behind after
 * debugging — writes a non-frame onto that channel and the session dies with a
 * parse error pointing nowhere near the cause. It is the single easiest way to
 * break an MCP server and one of the hardest to diagnose from the symptom, so
 * it is a test rather than a convention.
 */

import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

async function sourceFiles(): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = [];
  for await (const file of new Glob("**/*.ts").scan({ cwd: SRC })) {
    out.push([file, stripComments(await Bun.file(join(SRC, file)).text())]);
  }
  return out;
}

describe("nothing in mcp/src writes to stdout", () => {
  test("no console.log, console.info, console.debug, or console.warn", async () => {
    // console.error is fine and is what the server uses — stderr is surfaced by
    // the client as server logs and is not part of the protocol stream.
    for (const [file, source] of await sourceFiles()) {
      expect([file, /console\.(log|info|debug|warn)\s*\(/.test(source)]).toEqual([file, false]);
    }
  });

  test("no direct process.stdout writes", async () => {
    for (const [file, source] of await sourceFiles()) {
      expect([file, /process\.stdout/.test(source)]).toEqual([file, false]);
    }
  });

  test("the API key is never logged", async () => {
    // It reaches exactly one place: the Authorization header in client.ts.
    for (const [file, source] of await sourceFiles()) {
      const logsKey = /console\.\w+\([^)]*apiKey/.test(source) || /stderr[^;]*apiKey/.test(source);
      expect([file, logsKey]).toEqual([file, false]);
    }
  });
});
