/**
 * The backlog surface this plugin actually exposes, asserted as a whole.
 *
 * WHY A TEST AND NOT A DOC
 *
 * reference/datastore.md tells every skill which tools exist and what they may
 * write. A tool quietly renamed, dropped, or added leaves that document wrong
 * with nothing failing — the skills would keep calling a name that no longer
 * resolves and the failure would surface as an agent improvising. Pinning the
 * roster here makes that a red test instead.
 *
 * The read/write split is pinned for the same reason from the other side: a
 * client may act on readOnlyHint (auto-approving reads, prompting for writes),
 * so a write tool that loses its hint distinction becomes a write a user was
 * never asked about.
 */

import { describe, expect, test } from "bun:test";
import { allTools, toolsByName } from "../src/tools/index.ts";
import { schemaResources } from "../src/resources.ts";

/** Reads are open to every provisioned role — 012: "reading is not an assertion". */
const READS = [
  "backlog_whoami",
  "backlog_list_products",
  "backlog_list_capabilities",
  "backlog_get_capability",
  "backlog_list_features",
  "backlog_get_feature",
  "backlog_get_story",
  "backlog_get_acceptance_criterion",
  "backlog_model_health",
  "backlog_coverage",
  "backlog_public_view",
  "backlog_list_work",
  "backlog_get_work",
  // 041/042's tenants. Reads, so they carry readOnlyHint like the rest.
  "backlog_read_messages",
  "backlog_read_decisions",
  // Touches the local journal and no network, which makes it a read of this
  // machine's state — it changes nothing anywhere.
  "backlog_journal_status",
  // Reads this machine's files and environment and nothing else. The only tool
  // that answers on a server holding no credential at all.
  "backlog_doctor",
];

/** Authority varies per tool; the database decides, not this list. */
const WRITES = [
  "backlog_create_product",
  "backlog_create_capability",
  "backlog_update_capability",
  "backlog_create_feature",
  "backlog_update_feature",
  "backlog_create_story",
  "backlog_update_story",
  "backlog_create_acceptance_criterion",
  "backlog_update_acceptance_criterion",
  "backlog_link",
  "backlog_unlink",
  "backlog_record_evaluation",
  "backlog_record_evidence",
  "backlog_claim_work",
  "backlog_heartbeat_work",
  "backlog_push_progress",
  "backlog_finish_work",
  "backlog_file_work",
  "backlog_steward_work",
  "backlog_send_message",
  "backlog_record_decision",
  // A write even though it sends nothing new: it moves records from this
  // machine to the backlog, which is a change of state somewhere.
  "backlog_drain_journal",
];

describe("the tool roster", () => {
  test("is exactly what the skills are documented to call", () => {
    expect(allTools.map((t) => t.name).sort()).toEqual([...READS, ...WRITES].sort());
  });

  test("has no duplicate names", () => {
    expect(toolsByName.size).toBe(allTools.length);
  });

  test("every read is marked readOnlyHint", () => {
    for (const name of READS) {
      expect([name, toolsByName.get(name)?.annotations?.readOnlyHint]).toEqual([name, true]);
    }
  });

  test("no write claims to be read-only", () => {
    for (const name of WRITES) {
      expect([name, toolsByName.get(name)?.annotations?.readOnlyHint ?? false]).toEqual([
        name,
        false,
      ]);
    }
  });

  test("every write carries the quality bar the database cannot enforce", () => {
    // The schema enforces SHAPE; the description is the only place QUALITY
    // lives, and it is the writes that need it — `scope_boundary = 'stuff'`
    // satisfies every constraint the database has. A write tool whose
    // description shrinks to a restatement of its own name is the regression
    // this catches. Reads are held only to being described at all: several are
    // genuinely one sentence, and padding them would cost context on every turn.
    for (const tool of allTools) {
      const floor = WRITES.includes(tool.name) ? 200 : 20;
      expect([tool.name, tool.description.length >= floor]).toEqual([tool.name, true]);
      expect([tool.name, tool.title.length > 0]).toEqual([tool.name, true]);
    }
  });

  test("there is no tool that renames or deletes a product", () => {
    // 026 widened INSERT only. A backlog's product key scopes every other row
    // in it, so the absence of these is the design, not an oversight.
    const names = allTools.map((t) => t.name);
    expect(names).not.toContain("backlog_update_product");
    expect(names).not.toContain("backlog_delete_product");
  });
});

describe("the schema resources", () => {
  test("cover all five entities under backlog://schema/", () => {
    expect(schemaResources.map((r) => r.uri).sort()).toEqual([
      "backlog://schema/acceptance-criterion",
      "backlog://schema/capability",
      "backlog://schema/feature",
      "backlog://schema/product",
      "backlog://schema/story",
    ]);
  });

  test("each carries a real schema, not a placeholder", () => {
    for (const resource of schemaResources) {
      const schema = resource.schema as { properties?: Record<string, unknown> };
      expect([resource.name, Object.keys(schema.properties ?? {}).length > 0]).toEqual([
        resource.name,
        true,
      ]);
    }
  });

  test("are bundled, not read from disk at runtime", async () => {
    // resources.ts imports the JSON statically on purpose: the server runs from
    // a plugin directory with no fixed relationship to any repository root, so
    // anything resolved relative to cwd would work everywhere except where it
    // ships. Asserted by loading the module with a cwd that has no schemas/.
    const previous = process.cwd();
    try {
      process.chdir("/");
      const fresh = await import(`../src/resources.ts?cwd-probe=${Date.now()}`);
      expect(fresh.schemaResources).toHaveLength(5);
    } finally {
      process.chdir(previous);
    }
  });
});
