/**
 * Every tool, asserted on the request it produces.
 *
 * These are the assertions that survive the server having moved repositories:
 * the path a tool calls, the verb it uses, where each argument lands, and which
 * arguments are consumed by the path rather than the body. A rename on either
 * side of that seam shows up here and nowhere else in this repository.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { call, startStub, TEST_AGENT, TEST_KEY, type StubHarness } from "./harness.ts";

let h: StubHarness;

beforeAll(async () => {
  h = await startStub();
});

afterAll(async () => {
  await h.close();
});

/** Fresh recorder per test, so `only()` means what it says. */
function reset(): void {
  h.sent.length = 0;
}

describe("reads", () => {
  test("whoami takes no arguments and hits /v1/whoami", async () => {
    reset();
    await call(h.client, "catalog_whoami");
    expect(h.only()).toMatchObject({ method: "GET", path: "/v1/whoami" });
  });

  test("a filter becomes a query string, not a path segment", async () => {
    reset();
    await call(h.client, "catalog_list_capabilities", {
      product_key: "trenchcoat",
      status: "active",
    });
    const req = h.only();
    expect(req.path).toBe("/v1/products/trenchcoat/capabilities");
    expect(req.query).toBe("?status=active");
  });

  test("an omitted filter sends no query string at all", async () => {
    reset();
    await call(h.client, "catalog_list_features", { product_key: "trenchcoat" });
    expect(h.only().query).toBe("");
  });

  test("story and criterion reads are global — no product in the path", async () => {
    reset();
    await call(h.client, "catalog_get_story", { story_key: "story_9f3k2a" });
    expect(h.only().path).toBe("/v1/stories/story_9f3k2a");

    reset();
    await call(h.client, "catalog_get_acceptance_criterion", { ac_key: "ac_7bq1lm" });
    expect(h.only().path).toBe("/v1/acceptance-criteria/ac_7bq1lm");
  });

  test("keys are percent-encoded, because a key is user data", async () => {
    reset();
    await call(h.client, "catalog_get_capability", {
      product_key: "trenchcoat",
      capability_key: "a/b",
    });
    expect(h.only().path).toBe("/v1/products/trenchcoat/capabilities/a%2Fb");
  });
});

describe("writes", () => {
  test("create_product posts the whole body to the collection", async () => {
    reset();
    await call(h.client, "catalog_create_product", { key: "reelmates", name: "Reelmates" });
    const req = h.only();
    expect(req).toMatchObject({ method: "POST", path: "/v1/products" });
    expect(req.body).toEqual({ key: "reelmates", name: "Reelmates" });
  });

  test("product_key addresses the capability route and is stripped from the body", async () => {
    reset();
    await call(h.client, "catalog_create_capability", {
      product_key: "trenchcoat",
      key: "telemetry-capture",
      name: "Telemetry capture",
      description: "d",
      scope_boundary: "In: x. Out: y.",
    });
    const req = h.only();
    expect(req.path).toBe("/v1/products/trenchcoat/capabilities");
    expect(req.body.product_key).toBeUndefined();
    expect(req.body.key).toBe("telemetry-capture");
  });

  test("create_story keeps product_key IN the body, since the route is global", async () => {
    reset();
    await call(h.client, "catalog_create_story", {
      key: "story_9f3k2a",
      product_key: "trenchcoat",
      role: "r",
      want: "w",
      benefit: "b",
      feature_key: "cost-attribution",
    });
    const req = h.only();
    expect(req.path).toBe("/v1/stories");
    expect(req.body.product_key).toBe("trenchcoat");
    // The same-transaction link, which is why a story never exists unlinked.
    expect(req.body.feature_key).toBe("cost-attribution");
  });

  test("when_/then_ keep their trailing underscores on the wire", async () => {
    reset();
    await call(h.client, "catalog_create_acceptance_criterion", {
      key: "ac_7bq1lm",
      product_key: "trenchcoat",
      given: "g",
      when_: "w",
      then_: "t",
    });
    const body = h.only().body;
    expect(body.when_).toBe("w");
    expect(body.then_).toBe("t");
    expect(body.when).toBeUndefined();
  });

  test("a patch sends only the fields given", async () => {
    reset();
    await call(h.client, "catalog_update_capability", {
      product_key: "trenchcoat",
      capability_key: "telemetry-capture",
      description: "Revised.",
    });
    const req = h.only();
    expect(req.method).toBe("PATCH");
    expect(req.path).toBe("/v1/products/trenchcoat/capabilities/telemetry-capture");
    expect(req.body).toEqual({ description: "Revised." });
  });
});

describe("links", () => {
  const CASES: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
    [
      "capability-feature",
      { product_key: "p", capability_key: "c", feature_key: "f" },
      "/v1/links/capability-feature",
      { product_key: "p", capability_key: "c", feature_key: "f" },
    ],
    [
      "feature-story",
      { product_key: "p", feature_key: "f", story_key: "story_aaaaaa" },
      "/v1/links/feature-story",
      { product_key: "p", feature_key: "f", story_key: "story_aaaaaa" },
    ],
    [
      "feature-ac",
      { product_key: "p", feature_key: "f", ac_key: "ac_aaaaaa" },
      "/v1/links/feature-ac",
      { product_key: "p", feature_key: "f", ac_key: "ac_aaaaaa" },
    ],
    [
      "capability-dependency",
      {
        product_key: "p",
        from_capability_key: "a",
        to_capability_key: "b",
        kind_of_dependency: "requires",
      },
      "/v1/links/capability-dependency",
      // kind_of_dependency is renamed back to `kind` for the API: the tool had to
      // rename it to avoid colliding with its own discriminator.
      { product_key: "p", from_capability_key: "a", to_capability_key: "b", kind: "requires" },
    ],
    [
      "work-item-feature",
      { work_item_key: "wi_a1b2c3", product_key: "p", feature_key: "f" },
      "/v1/links/work-item-feature",
      { work_item_key: "wi_a1b2c3", product_key: "p", feature_key: "f" },
    ],
    [
      "work-item-ac",
      { work_item_key: "wi_a1b2c3", ac_key: "ac_aaaaaa" },
      "/v1/links/work-item-ac",
      { work_item_key: "wi_a1b2c3", ac_key: "ac_aaaaaa" },
    ],
  ];

  for (const [kind, args, path, body] of CASES) {
    test(`${kind} routes to ${path} with exactly its own fields`, async () => {
      reset();
      await call(h.client, "catalog_link", { kind, ...args });
      const req = h.only();
      expect([kind, req.method, req.path]).toEqual([kind, "POST", path]);
      // Exact equality, not a subset: a link carrying a field from another kind
      // is how a cross-wired payload would slip through a toMatchObject.
      expect([kind, req.body]).toEqual([kind, body]);
    });

    test(`${kind} unlinks through the same path with DELETE`, async () => {
      reset();
      await call(h.client, "catalog_unlink", { kind, ...args });
      expect([kind, h.only().method, h.only().path]).toEqual([kind, "DELETE", path]);
    });
  }

  test("capability-feature carries the per-edge scores when they are given", async () => {
    reset();
    await call(h.client, "catalog_link", {
      kind: "capability-feature",
      product_key: "p",
      capability_key: "c",
      feature_key: "f",
      cost_score: 3,
      value_score: 8,
    });
    expect(h.only().body).toEqual({
      product_key: "p",
      capability_key: "c",
      feature_key: "f",
      cost_score: 3,
      value_score: 8,
    });
  });

  test("an omitted score is absent from the body, not sent as null", async () => {
    // The API is .strict(), and "no opinion" has to stay distinguishable from
    // "assessed as zero" all the way to the column.
    reset();
    await call(h.client, "catalog_link", {
      kind: "capability-feature",
      product_key: "p",
      capability_key: "c",
      feature_key: "f",
      value_score: 8,
    });
    const body = h.only().body;
    expect("cost_score" in body).toBe(false);
    expect(body.value_score).toBe(8);
  });

  test("a missing field is refused BEFORE any request is made", async () => {
    reset();
    const result = await call(h.client, "catalog_link", {
      kind: "capability-dependency",
      product_key: "p",
      from_capability_key: "a",
    });
    expect(result.isError).toBe(true);
    // The message has to be actionable on a six-mode tool: it names the kind,
    // everything that kind needs, and what was actually missing.
    expect(result.text).toContain("kind=\"capability-dependency\" requires");
    expect(result.text).toContain("missing: to_capability_key, kind_of_dependency");
    expect(h.sent).toHaveLength(0);
  });
});

describe("evidence", () => {
  test("an evaluation is addressed by criterion and the key leaves the body", async () => {
    reset();
    await call(h.client, "catalog_record_evaluation", {
      ac_key: "ac_7bq1lm",
      verdict: "pass",
      method: "automated",
      source: "ci:bun-test",
    });
    const req = h.only();
    expect(req.path).toBe("/v1/acceptance-criteria/ac_7bq1lm/evaluations");
    expect(req.body.ac_key).toBeUndefined();
    expect(req.body.verdict).toBe("pass");
  });

  test("an evidence window posts the whole batch in one request", async () => {
    reset();
    await call(h.client, "catalog_record_evidence", {
      product_key: "trenchcoat",
      kind: "active_users",
      as_of: "2026-08-01",
      source: "warehouse",
      signals: [
        { capability_key: "telemetry-capture", value: 41 },
        // The zero row is the whole point of the batch API — see the tool's
        // description, and the ingester contract it exists to enforce.
        { capability_key: "usage-analytics", value: 0 },
      ],
    });
    const req = h.only();
    expect(req.path).toBe("/v1/evidence-signals");
    expect(req.body.signals).toHaveLength(2);
  });
});

describe("the key", () => {
  test("travels as a bearer header and never as a query parameter", async () => {
    reset();
    await call(h.client, "catalog_list_products");
    const req = h.only();
    expect(req.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(req.query).toBe("");
  });
});

describe("refusals", () => {
  test("a 403 is a tool error carrying the API's own wording, not a thrown protocol fault", async () => {
    reset();
    h.reply(403, {
      error: "forbidden",
      message: "this operation requires product-manager; this key carries quality-assurance",
    });
    const result = await call(h.client, "catalog_create_product", { key: "p", name: "P" });
    expect(result.isError).toBe(true);
    // Verbatim: the API's sentence names both roles and is the actionable part.
    expect(result.text).toContain("this operation requires product-manager");
    expect(result.text).toContain("HTTP 403");
  });

  test("a refused write reports details when the API sent them", async () => {
    reset();
    h.reply(422, {
      error: "check_violation",
      message: 'the row violates the constraint "feature_value_prop_shape"',
      details: { constraint: "feature_value_prop_shape" },
    });
    const result = await call(h.client, "catalog_create_feature", {
      product_key: "p",
      key: "f",
      name: "n",
      description: "d",
      capability_keys: ["c"],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("feature_value_prop_shape");
  });
});

/**
 * The work queue's requests.
 *
 * Two things here exist nowhere else in the roster and are worth pinning
 * precisely. First, `agent_id` is not a body field — it is a HEADER, and a
 * regression that let it fall into the body would be invisible to every other
 * assertion in this file while quietly making every agent anonymous to the
 * queue. Second, the tools that take a work item key put it in the PATH, and a
 * key that leaked into the body would produce a request against a route that
 * does not exist.
 */
describe("the work queue", () => {
  test("claiming posts the product to /v1/work-items/claim", async () => {
    reset();
    await call(h.client, "catalog_claim_work", {
      product_key: "trenchcoat",
      lease_seconds: 600,
    });
    const req = h.only();
    expect(req).toMatchObject({ method: "POST", path: "/v1/work-items/claim" });
    expect(req.body).toEqual({ product_key: "trenchcoat", lease_seconds: 600 });
  });

  test("the session's identity travels as a header on every call", async () => {
    reset();
    await call(h.client, "catalog_claim_work", { product_key: "trenchcoat" });
    expect(h.only().headers["x-pando-agent-id"]).toBe(TEST_AGENT);
  });

  test("a per-call agent_id overrides it, and never reaches the body", async () => {
    reset();
    await call(h.client, "catalog_claim_work", {
      product_key: "trenchcoat",
      agent_id: "worker-3",
    });
    const req = h.only();
    expect(req.headers["x-pando-agent-id"]).toBe("worker-3");
    expect(req.body).toEqual({ product_key: "trenchcoat" });
  });

  test("listing turns filters into a query string", async () => {
    reset();
    await call(h.client, "catalog_list_work", {
      product_key: "trenchcoat",
      role_required: "engineer",
      ready: true,
    });
    const req = h.only();
    expect(req.path).toBe("/v1/products/trenchcoat/work-items");
    expect(req.query).toBe("?role_required=engineer&ready=true");
  });

  test("ready=false is omitted rather than sent, so it cannot read as a filter", async () => {
    reset();
    await call(h.client, "catalog_list_work", { product_key: "trenchcoat", ready: false });
    expect(h.only().query).toBe("");
  });

  test("the work item key is a path segment on every tool that takes one", async () => {
    for (const [name, method, suffix, args] of [
      ["catalog_get_work", "GET", "", {}],
      ["catalog_heartbeat_work", "POST", "/heartbeat", {}],
      ["catalog_push_progress", "POST", "/notes", { kind: "progress", body: "did a thing" }],
      ["catalog_finish_work", "PATCH", "", { state: "done", outcome: "built it" }],
    ] as const) {
      reset();
      await call(h.client, name, { work_item_key: "wi_a1b2c3", ...args });
      const req = h.only();
      expect([name, req.method, req.path]).toEqual([
        name,
        method,
        `/v1/work-items/wi_a1b2c3${suffix}`,
      ]);
      expect([name, req.body?.work_item_key]).toEqual([name, undefined]);
    }
  });

  test("filing posts under the product and leaves product_key out of the body", async () => {
    reset();
    await call(h.client, "catalog_file_work", {
      product_key: "trenchcoat",
      key: "wi_a1b2c3",
      title: "Build it",
      intent: "the criterion has no implementation",
      role_required: "engineer",
      priority: 10,
    });
    const req = h.only();
    expect(req.path).toBe("/v1/products/trenchcoat/work-items");
    expect(req.body).toEqual({
      key: "wi_a1b2c3",
      title: "Build it",
      intent: "the criterion has no implementation",
      role_required: "engineer",
      priority: 10,
    });
  });

  test("a malformed work item key is refused before any request is made", async () => {
    reset();
    const result = await call(h.client, "catalog_get_work", { work_item_key: "wi_TOOLONG" });
    expect(result.isError).toBe(true);
    expect(h.sent).toHaveLength(0);
  });
});
