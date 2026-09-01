/**
 * What an agent can and cannot do when the backlog is unreachable.
 *
 * The design's local-first table has four rows, and three of them are proved
 * elsewhere: appends journal (journal.test.ts), drains replay idempotently
 * (journal.test.ts and apps/backend), and the tenants gate on the credential
 * (apps/backend). This file is the fourth row and its counterpart:
 *
 *   * A READ falls back to the last good answer, and says it is old.
 *   * CLAIMING, HEARTBEATING, and FINISHING do not fall back at all, because
 *     they are mutual exclusion and a lease, and neither can be reconciled
 *     after the fact without discarding somebody's work.
 *
 * THE ASSERTION THAT MATTERS MOST
 *
 * "A 403 does not serve a cached success." Everything else here is ergonomics;
 * that one is the boundary. A cache that answered a refusal with yesterday's
 * success would tell an agent it may read something the backlog has just said
 * it may not, which inverts the tenant gate and RLS in the one place neither can
 * see.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, BacklogClient } from "../src/client.ts";
import { toolsByName } from "../src/tools/index.ts";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "superdev-offline-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

type Answer = { status: number; body: unknown } | "unreachable";

function clientAnswering(answers: Answer[]): BacklogClient {
  let i = 0;
  return new BacklogClient({
    baseUrl: "http://backlog.test",
    apiKey: "pcat_test_key",
    agentId: "agent-1",
    cacheHome: home,
    fetch: (async () => {
      const answer = answers[Math.min(i++, answers.length - 1)]!;
      if (answer === "unreachable") throw new TypeError("fetch failed");
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch,
  });
}

describe("reading with no backlog", () => {
  test("falls back to the last good answer and says how old it is", async () => {
    const client = clientAnswering([
      { status: 200, body: { capabilities: [{ key: "checkout" }] } },
      "unreachable",
    ]);

    const fresh = await client.get<any>("/v1/products/alpha/capabilities");
    expect(fresh.body.capabilities).toHaveLength(1);
    expect(fresh.body.stale_as_of).toBeUndefined();

    const stale = await client.get<any>("/v1/products/alpha/capabilities");
    expect(stale.body.capabilities).toHaveLength(1);
    // Merged into the body rather than logged, because the reader is a model and
    // a model not told an answer is old will treat it as current.
    expect(typeof stale.body.stale_as_of).toBe("string");
  });

  test("a 403 is an ANSWER and never served from cache", async () => {
    const client = clientAnswering([
      { status: 200, body: { messages: [{ body: "hello" }] } },
      { status: 403, body: { error: "forbidden", message: "this key may not reach that tenant" } },
    ]);

    await client.get("/v1/products/alpha/messages");

    // The cache holds a success for this exact path. Serving it here would tell
    // the agent it may read a tenant the backlog has just refused it.
    expect(client.get("/v1/products/alpha/messages")).rejects.toBeInstanceOf(ApiError);
  });

  test("a 404 is an answer too", async () => {
    const client = clientAnswering([
      { status: 200, body: { key: "checkout" } },
      { status: 404, body: { error: "not_found", message: "no such capability" } },
    ]);
    await client.get("/v1/products/alpha/capabilities/checkout");
    expect(
      client.get("/v1/products/alpha/capabilities/checkout"),
    ).rejects.toBeInstanceOf(ApiError);
  });

  test("a path never read before rethrows rather than inventing an empty answer", async () => {
    const client = clientAnswering(["unreachable"]);
    // An agent told a product has no capabilities, when the truth is that nobody
    // could ask, is worse off than one told the backlog is unreachable.
    expect(client.get("/v1/products/alpha/capabilities")).rejects.toThrow("fetch failed");
  });

  test("each path is cached separately", async () => {
    const client = clientAnswering([
      { status: 200, body: { key: "alpha" } },
      { status: 200, body: { key: "beta" } },
      "unreachable",
    ]);
    await client.get("/v1/products/alpha");
    await client.get("/v1/products/beta");

    const alpha = await client.get<any>("/v1/products/alpha");
    expect(alpha.body.key).toBe("alpha");
  });

  test("a client with no cacheHome keeps nothing and falls back to nothing", async () => {
    const client = new BacklogClient({
      baseUrl: "http://backlog.test",
      apiKey: "k",
      agentId: "a",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof globalThis.fetch,
    });
    expect(client.get("/v1/products/alpha")).rejects.toThrow("fetch failed");
  });
});

describe("the operations that cannot be deferred", () => {
  const offline = () => clientAnswering(["unreachable"]);

  for (const [tool, args] of [
    ["backlog_claim_work", { product_key: "alpha" }],
    ["backlog_heartbeat_work", { work_item_key: "wi_a1b2c3" }],
    ["backlog_finish_work", { work_item_key: "wi_a1b2c3", state: "done", outcome: "built it" }],
  ] as const) {
    test(`${tool} explains the rule instead of surfacing a transport error`, async () => {
      const result = (await toolsByName.get(tool)!.handler(offline(), args)) as any;
      expect(result.unavailable).toBe(true);
      // The part that changes what the agent does next. Without it, a model that
      // cannot claim will improvise — invent a work item, or report that the
      // queue is broken.
      expect(result.what_you_can_still_do).toContain("backlog_push_progress");
      expect(result.explanation).toContain("mutual exclusion");
    });
  }

  test("but a real refusal still comes through as a refusal", async () => {
    const held = clientAnswering([
      { status: 409, body: { error: "conflict", message: "already held by another agent" } },
    ]);
    // "This item is already held" is information. Dressing it as an outage would
    // send the agent looking for a network problem that does not exist.
    expect(
      toolsByName.get("backlog_claim_work")!.handler(held, { product_key: "alpha" }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
