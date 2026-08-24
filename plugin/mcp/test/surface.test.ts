/**
 * The catalogue surface this plugin actually exposes, asserted as a whole.
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
  "catalog_whoami",
  "catalog_list_products",
  "catalog_list_capabilities",
  "catalog_get_capability",
  "catalog_list_features",
  "catalog_get_feature",
  "catalog_get_story",
  "catalog_get_acceptance_criterion",
  "catalog_model_health",
  "catalog_coverage",
  "catalog_public_catalog",
  "catalog_list_work",
  "catalog_get_work",
  // 041/042's tenants. Reads, so they carry readOnlyHint like the rest.
  "catalog_read_messages",
  "catalog_read_decisions",
  // Touches the local journal and no network, which makes it a read of this
  // machine's state — it changes nothing anywhere.
  "catalog_journal_status",
];

/** Authority varies per tool; the database decides, not this list. */
const WRITES = [
  "catalog_create_product",
  "catalog_create_capability",
  "catalog_update_capability",
  "catalog_create_feature",
  "catalog_update_feature",
  "catalog_create_story",
  "catalog_update_story",
  "catalog_create_acceptance_criterion",
  "catalog_update_acceptance_criterion",
  "catalog_link",
  "catalog_unlink",
  "catalog_record_evaluation",
  "catalog_record_evidence",
  "catalog_claim_work",
  "catalog_heartbeat_work",
  "catalog_push_progress",
  "catalog_finish_work",
  "catalog_file_work",
  "catalog_steward_work",
  "catalog_send_message",
  "catalog_record_decision",
  // A write even though it sends nothing new: it moves records from this
  // machine to the catalogue, which is a change of state somewhere.
  "catalog_drain_journal",
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
    // 026 widened INSERT only. A catalogue's product key scopes every other row
    // in it, so the absence of these is the design, not an oversight.
    const names = allTools.map((t) => t.name);
    expect(names).not.toContain("catalog_update_product");
    expect(names).not.toContain("catalog_delete_product");
  });
});

describe("the schema resources", () => {
  test("cover all five entities under catalog://schema/", () => {
    expect(schemaResources.map((r) => r.uri).sort()).toEqual([
      "catalog://schema/acceptance-criterion",
      "catalog://schema/capability",
      "catalog://schema/feature",
      "catalog://schema/product",
      "catalog://schema/story",
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
