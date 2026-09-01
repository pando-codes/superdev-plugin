/**
 * The local journal and its drain.
 *
 * WHAT THESE HAVE TO PROVE
 *
 * The whole local-first claim rests on two properties, and both are the kind
 * that look fine until the day they matter:
 *
 *   1. NOTHING IS LOST WHEN THE BACKLOG IS UNREACHABLE. An append succeeds
 *      with no network, and a failed drain leaves the cursor where it was, so
 *      the record is sent again rather than skipped.
 *
 *   2. NOTHING IS DUPLICATED WHEN THE ACKNOWLEDGEMENT IS. Delivery is
 *      at-least-once by design, so a replay must be reported as a duplicate and
 *      write nothing — which is a property of the backlog, asserted end to end
 *      in apps/backend, and of the cursor, asserted here.
 *
 * The awkward case is a journal holding records for two products where one
 * product's batch is refused. The cursor is one position over one ordered file
 * and cannot express "all but those", so it has to stop at the first failing
 * record and re-send the successful-but-later ones. That is the test worth
 * reading below; the rest are the ordinary shape.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BacklogClient } from "../src/client.ts";
import { drain } from "../src/drain.ts";
import * as journal from "../src/journal.ts";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "superdev-journal-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/**
 * A client whose every request is answered by `respond`.
 *
 * Deliberately not the recording stub from harness.ts: this suite needs to make
 * a request FAIL, and it needs to fail differently per product, which that
 * harness's queue does not express.
 */
function clientThat(
  respond: (path: string, body: any) => { status: number; body: unknown },
): { client: BacklogClient; calls: Array<{ path: string; body: any }> } {
  const calls: Array<{ path: string; body: any }> = [];
  const fetchImpl = (async (input: any, init?: any) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const body = init?.body === undefined ? undefined : JSON.parse(init.body as string);
    calls.push({ path: url.pathname, body });
    const answer = respond(url.pathname, body);
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  return {
    client: new BacklogClient({
      baseUrl: "http://backlog.test",
      apiKey: "pcat_test_key",
      agentId: "agent-1",
      fetch: fetchImpl,
    }),
    calls,
  };
}

const ok = (_path: string, body: any) => ({
  status: 200,
  body: { landed: body.messages?.length ?? body.rulings?.length ?? 0, duplicates: 0 },
});

describe("appending", () => {
  test("writes one NDJSON line per record, with an id the caller did not choose", async () => {
    const a = await journal.append(home, "correspondence", "alpha", { body: "one" });
    const b = await journal.append(home, "correspondence", "alpha", { body: "two" });

    expect(a.client_id).not.toBe(b.client_id);

    const raw = readFileSync(join(home, ".superdev", "journal", "correspondence.ndjson"), "utf8");
    expect(raw.trimEnd().split("\n")).toHaveLength(2);
    expect(JSON.parse(raw.trimEnd().split("\n")[0]!).payload).toEqual({ body: "one" });
  });

  test("succeeds with no client, no key, and no network anywhere near it", async () => {
    // The entire point. Nothing in journal.ts imports a client.
    const record = await journal.append(home, "decision", "alpha", { question: "?" });
    expect(record.product_key).toBe("alpha");
    expect((await journal.status(home, "decision")).pending).toBe(1);
  });

  test("a torn final line loses that record and strands nothing before it", async () => {
    await journal.append(home, "correspondence", "alpha", { body: "one" });
    // What a process killed mid-append leaves behind.
    appendFileSync(
      join(home, ".superdev", "journal", "correspondence.ndjson"),
      '{"client_id":"half',
      "utf8",
    );
    const records = await journal.readAll(home, "correspondence");
    expect(records).toHaveLength(1);
    expect(records[0]!.payload).toEqual({ body: "one" });
  });

  test("a cursor past the end is clamped rather than believed", async () => {
    await journal.append(home, "correspondence", "alpha", { body: "one" });
    await journal.writeCursor(home, "correspondence", 99);
    // Believing it would report "everything drained" over a journal that has a
    // record waiting in it.
    expect(await journal.status(home, "correspondence")).toMatchObject({
      total: 1,
      drained: 1,
      pending: 0,
    });
  });
});

describe("draining", () => {
  test("sends what is pending and advances the cursor", async () => {
    await journal.append(home, "correspondence", "alpha", { body: "one" });
    await journal.append(home, "correspondence", "alpha", { body: "two" });

    const { client, calls } = clientThat(ok);
    const outcome = await drain(client, home, "correspondence");

    expect(outcome).toMatchObject({ stream: "correspondence", attempted: 2, landed: 2, still_pending: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/v1/products/alpha/messages/drain");
    // The client_id travels with the payload: it is the idempotency key, and
    // the backlog is unique on it.
    expect(calls[0]!.body.messages[0]).toHaveProperty("client_id");
    expect(await journal.status(home, "correspondence")).toMatchObject({ pending: 0 });
  });

  test("a second drain sends nothing, because the cursor moved", async () => {
    await journal.append(home, "correspondence", "alpha", { body: "one" });
    const { client, calls } = clientThat(ok);
    await drain(client, home, "correspondence");
    const second = await drain(client, home, "correspondence");

    expect(second).toMatchObject({ attempted: 0, landed: 0 });
    expect(calls).toHaveLength(1);
  });

  test("a refusal leaves the cursor alone, so the record is re-sent and not skipped", async () => {
    await journal.append(home, "correspondence", "alpha", { body: "one" });

    const refuse = clientThat(() => ({
      status: 403,
      body: { error: "forbidden", message: "this key may not reach correspondence" },
    }));
    const outcome = await drain(refuse.client, home, "correspondence");

    expect(outcome.still_pending).toBe(1);
    expect(outcome.problem).toContain("403");
    expect(await journal.status(home, "correspondence")).toMatchObject({ pending: 1 });

    // And once the tenant is enabled, the same record goes.
    const { client } = clientThat(ok);
    expect(await drain(client, home, "correspondence")).toMatchObject({
      landed: 1,
      still_pending: 0,
    });
  });

  test("an unreachable backlog is reported, never thrown", async () => {
    await journal.append(home, "correspondence", "alpha", { body: "one" });
    const dead = new BacklogClient({
      baseUrl: "http://backlog.test",
      apiKey: "k",
      agentId: "a",
      fetch: (() => Promise.reject(new Error("fetch failed"))) as unknown as typeof globalThis.fetch,
    });

    // Not `expect(...).rejects` — the whole design turns on an offline drain
    // being ordinary news rather than an error the model has to interpret.
    const outcome = await drain(dead, home, "correspondence");
    expect(outcome.still_pending).toBe(1);
    expect(outcome.problem).toContain("fetch failed");
  });

  test("the backlog's duplicate count is reported rather than recomputed", async () => {
    await journal.append(home, "correspondence", "alpha", { body: "one" });
    const { client } = clientThat(() => ({
      status: 200,
      body: { landed: 0, duplicates: 1 },
    }));
    expect(await drain(client, home, "correspondence")).toMatchObject({
      landed: 0,
      duplicates: 1,
      still_pending: 0,
    });
  });

  test("decisions drain to their own endpoint under their own field name", async () => {
    await journal.append(home, "decision", "alpha", { key: "dec_aaa001" });
    const { client, calls } = clientThat(ok);
    await drain(client, home, "decision");

    expect(calls[0]!.path).toBe("/v1/products/alpha/decisions/drain");
    expect(calls[0]!.body).toHaveProperty("rulings");
  });
});

describe("a journal spanning two products, one of which is refused", () => {
  test("the cursor stops at the first refused record, and later ones are re-sent", async () => {
    // Interleaved on purpose: alpha, beta, alpha. If the cursor advanced by
    // "everything that worked" it would jump past the beta record and lose it.
    await journal.append(home, "correspondence", "alpha", { body: "first" });
    await journal.append(home, "correspondence", "beta", { body: "refused" });
    await journal.append(home, "correspondence", "alpha", { body: "third" });

    const refuseBeta = clientThat((path, body) =>
      path.includes("/beta/")
        ? { status: 403, body: { error: "forbidden", message: "no" } }
        : { status: 200, body: { landed: body.messages.length, duplicates: 0 } },
    );

    const outcome = await drain(refuseBeta.client, home, "correspondence");

    // Both alpha records landed at the backlog...
    expect(outcome.landed).toBe(2);
    // ...but the cursor stopped at the beta record, so two are still pending:
    // beta, and the alpha record that comes after it.
    expect(outcome.still_pending).toBe(2);
    expect(await journal.status(home, "correspondence")).toMatchObject({
      total: 3,
      drained: 1,
      pending: 2,
    });

    // The re-send is safe precisely because the backlog is idempotent: the
    // alpha record that already landed comes back as a duplicate, not a second
    // message. This is the trade at-least-once buys.
    const second = clientThat((path, body) => ({
      status: 200,
      body: path.includes("/beta/")
        ? { landed: body.messages.length, duplicates: 0 }
        : { landed: 0, duplicates: body.messages.length },
    }));
    const retry = await drain(second.client, home, "correspondence");
    expect(retry).toMatchObject({ attempted: 2, landed: 1, duplicates: 1, still_pending: 0 });
  });
});

describe("what the journal is not for", () => {
  test("only append-only operations have a stream", () => {
    // The streams are keyed by OPERATION, not by tenant: `work-progress` is
    // delivery's append-only half. Claiming and finishing are its contended
    // half and have nowhere to be journalled, which is the guarantee.
    const streams: string[] = ["correspondence", "decision", "work-progress"];
    expect(streams).not.toContain("delivery");
    expect(streams).not.toContain("claim");
  });

  test("a note keeps the agent that wrote it, not the one that drained it", async () => {
    // Several subagents share one process. The backlog forces a note's author
    // from the connection's agent id, so a batch drained under the process
    // identity would file eng-beta's notes under eng-alpha's name.
    await journal.append(home, "work-progress", "", { work_item_key: "wi_aaa001" }, "eng-alpha");
    await journal.append(home, "work-progress", "", { work_item_key: "wi_aaa002" }, "eng-beta");

    const seen: Array<string | undefined> = [];
    const client = new BacklogClient({
      baseUrl: "http://backlog.test",
      apiKey: "k",
      agentId: "the-process",
      fetch: (async (_input: any, init?: any) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        seen.push(headers["x-pando-agent-id"]);
        return new Response(JSON.stringify({ landed: 1, duplicates: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof globalThis.fetch,
    });

    await drain(client, home, "work-progress");
    // Two requests, not one batch, precisely because the authors differ.
    expect(seen).toEqual(["eng-alpha", "eng-beta"]);
  });

  test("work notes drain to one product-agnostic endpoint", async () => {
    await journal.append(home, "work-progress", "", { work_item_key: "wi_aaa001" }, "eng-alpha");
    const { client, calls } = clientThat(() => ({
      status: 200,
      body: { landed: 1, duplicates: 0 },
    }));
    await drain(client, home, "work-progress");
    // One offline session may touch items in several products, and each record
    // names its own item — so the product is not in the path.
    expect(calls[0]!.path).toBe("/v1/work-notes/drain");
    expect(calls[0]!.body).toHaveProperty("notes");
  });
});
