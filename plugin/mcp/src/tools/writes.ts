import { z } from "zod";
import { seg } from "../client.ts";
import type { ToolDefinition } from "./types.ts";

/**
 * Write tools.
 *
 * None of these checks authority. A key that may not write reaches the API,
 * reaches Postgres, and is refused by 012's policies; the API turns that into a
 * 403 whose message names both roles, and the tool surfaces it verbatim. A
 * permission check here would be a third copy of an authority table that already
 * exists in exactly one correct place.
 *
 * Descriptions carry the quality bar the database cannot enforce. the catalogue
 * enforces SHAPE, not QUALITY — `scope_boundary = 'stuff'` satisfies every
 * constraint in the schema. An agent reading only the schema would write records
 * that pass and are worthless, so the bar travels with the tool.
 */

const productKey = z.string().describe("Product slug, e.g. 'trenchcoat'.");

const valueProp = z
  .object({
    new_revenue: z.array(z.string()),
    revenue_growth: z.array(z.string()),
    cost_reduction: z.array(z.string()),
  })
  .describe("All three headings are required, each an array (021 rejects a missing heading).");

const costAssessment = z
  .object({
    cost: z.array(z.string()),
    risk: z.array(z.string()),
    uncertainty: z.array(z.string()),
  })
  .describe("All three headings are required, each an array.");

const featureScopeBoundary = z
  .object({ in_scope: z.array(z.string()), out_of_scope: z.array(z.string()) })
  .describe("Both headings are required, each an array.");

export const writeTools: ToolDefinition[] = [
  {
    name: "catalog_create_product",
    title: "Create a product",
    description:
      "Create a product — the root of a catalogue, and the partition every capability, " +
      "feature, story, and criterion is scoped by. Requires product-manager or " +
      "head-of-engineering (026).\n\n" +
      "THIS IS A ONCE-PER-REPOSITORY OPERATION. There is deliberately no tool to rename or " +
      "delete a product, because the key scopes every other row in the catalogue: getting it " +
      "wrong is not something a later call can undo. Call catalog_list_products first and " +
      "confirm the product does not already exist under another name.\n\n" +
      "A second product for a repository that already has one silently SPLITS its catalogue — " +
      "nothing in the schema prevents it and nothing downstream will notice, because every " +
      "query scopes by product_id and will simply return the half it was pointed at.\n\n" +
      "The key is the durable identifier and belongs in .superdev/product.json; the name is " +
      "display text and is the only part worth agonising over less.",
    inputSchema: {
      key: z
        .string()
        .describe("kebab-case slug, globally unique, e.g. 'trenchcoat'. Permanent."),
      name: z.string().describe("Display name, e.g. 'Trenchcoat'."),
    },
    handler: async (client, args) => (await client.post("/v1/products", args)).body,
  },
  {
    name: "catalog_create_capability",
    title: "Create a capability",
    description:
      "Add a capability to a product. Requires product-manager.\n\n" +
      "A capability is a VALUE PROPOSITION, not a component — if you have named a component " +
      "you have written a Feature. Before calling this, check all four bars: a customer would " +
      "recognise it as something they get; two people given only the boundaries would assign " +
      "the same features to the same capabilities; every 'Out:' clause names a SIBLING " +
      "capability rather than a date or a roadmap ('at this time', 'currently', 'not yet' are " +
      "the tell); and no sibling's scope_boundary is made inaccurate by adding this one.\n\n" +
      "Adding a capability re-derives every sibling's weight share, so this is the most " +
      "expensive record in the model to get wrong.",
    inputSchema: {
      product_key: productKey,
      key: z.string().describe("kebab-case slug, e.g. 'telemetry-capture'."),
      name: z.string(),
      description: z.string().describe("What this is, in the customer's terms."),
      scope_boundary: z
        .string()
        .describe("'In: ... Out: ...' — every Out clause naming a neighbouring capability."),
      status: z.enum(["proposed", "active", "deprecated", "archived"]).optional(),
      visibility: z.enum(["internal", "public"]).optional(),
      vbo: z.number().min(0).max(100).optional(),
    },
    handler: async (client, args) => {
      const { product_key, ...payload } = args;
      return (await client.post(`/v1/products/${seg(product_key)}/capabilities`, payload)).body;
    },
  },
  {
    name: "catalog_update_capability",
    title: "Update a capability",
    description:
      "Revise a capability. Requires product-manager. Only the fields you send change.\n\n" +
      "Re-read every sibling's scope_boundary after changing one and confirm each is still " +
      "true — that is the step that gets skipped, and it is how a partition rots.",
    inputSchema: {
      product_key: productKey,
      capability_key: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      scope_boundary: z.string().optional(),
      status: z.enum(["proposed", "active", "deprecated", "archived"]).optional(),
      visibility: z.enum(["internal", "public"]).optional(),
      vbo: z.number().min(0).max(100).optional(),
    },
    annotations: { idempotentHint: true },
    handler: async (client, args) => {
      const { product_key, capability_key, ...payload } = args;
      return (
        await client.patch(
          `/v1/products/${seg(product_key)}/capabilities/${seg(capability_key)}`,
          payload,
        )
      ).body;
    },
  },
  {
    name: "catalog_create_feature",
    title: "Create a feature",
    description:
      "Add a feature and link it to at least one capability, in one transaction. " +
      "Requires product-manager.\n\n" +
      "capability_keys is REQUIRED and must be non-empty: the database rejects a feature that " +
      "reaches commit unlinked, so there is no way to create one first and link it later.\n\n" +
      "Link on VALUE SERVED, not on dependency. A public API that authenticates with API keys " +
      "does not thereby serve team-administration — it depends on it. Every spurious link " +
      "widens blast-radius traversal until everything touches everything.\n\n" +
      "lifecycle_state must be honest: 'proposed' until it actually ships. Only 'active' " +
      "features count toward verification, so an optimistic 'active' reports as unverified " +
      "product and drags coverage down.",
    inputSchema: {
      product_key: productKey,
      key: z.string().describe("kebab-case slug."),
      name: z.string(),
      description: z.string(),
      capability_keys: z
        .array(z.string())
        .min(1)
        .describe("Capabilities whose value this feature delivers. At least one."),
      lifecycle_state: z.enum(["proposed", "active", "deprecated", "removed"]).optional(),
      visibility: z.enum(["internal", "public"]).optional(),
      value_prop: valueProp.optional(),
      cost_assessment: costAssessment.optional(),
      scope_boundary: featureScopeBoundary.optional(),
    },
    handler: async (client, args) => {
      const { product_key, ...payload } = args;
      return (await client.post(`/v1/products/${seg(product_key)}/features`, payload)).body;
    },
  },
  {
    name: "catalog_update_feature",
    title: "Update a feature",
    description:
      "Revise a feature. Requires product-manager. Only the fields you send change.\n\n" +
      "lifecycle_state is the field with consequences. Only 'active' features count toward " +
      "verification and coverage, so promoting one to 'active' before it ships reports as " +
      "unverified product and drags the coverage figure down until it is either built or " +
      "demoted — and the number it drags down is the one anyone reads to decide what to build " +
      "next.\n\n" +
      "value_prop, cost_assessment, and scope_boundary are WHOLE-OBJECT replacements, not " +
      "merges. Sending scope_boundary with only in_scope discards out_of_scope; read the " +
      "current value first and send it back complete.\n\n" +
      "To retire a feature, move lifecycle_state to 'deprecated' or 'removed'. There is no " +
      "delete, here or in the database: verification history has to outlive the thing it " +
      "evaluated.",
    inputSchema: {
      product_key: productKey,
      feature_key: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      lifecycle_state: z.enum(["proposed", "active", "deprecated", "removed"]).optional(),
      visibility: z.enum(["internal", "public"]).optional(),
      value_prop: valueProp.optional(),
      cost_assessment: costAssessment.optional(),
      scope_boundary: featureScopeBoundary.optional(),
    },
    annotations: { idempotentHint: true },
    handler: async (client, args) => {
      const { product_key, feature_key, ...payload } = args;
      return (
        await client.patch(
          `/v1/products/${seg(product_key)}/features/${seg(feature_key)}`,
          payload,
        )
      ).body;
    },
  },
  {
    name: "catalog_create_story",
    title: "Create a user story",
    description:
      "Add a user story, optionally linked to a feature in the same transaction. " +
      "Requires product-manager.\n\n" +
      "The `want` must survive a redesign — it is the user's desire, not the screen. " +
      "'to see each session's cost broken down by component type' IS the feature and goes " +
      "stale on a redesign; 'to know which parts of a session are responsible for its cost' " +
      "does not.\n\n" +
      "The `benefit` must be a RESULT, not the want restated. 'so that I can see the " +
      "dashboard' restates; 'so that I can tell which components drive cost' is a result.\n\n" +
      "A story is never 'done', only accurate or stale. Delivery lives in wi_* work items.",
    inputSchema: {
      key: z.string().describe("story_ followed by six lowercase alphanumerics."),
      product_key: productKey,
      role: z.string().describe("Who wants this, e.g. 'engineer investigating a costly session'."),
      want: z.string(),
      benefit: z.string(),
      status: z.enum(["current", "stale", "retired"]).optional(),
      last_reviewed_at: z
        .string()
        .optional()
        .describe("ISO 8601. Confidence decays from here — set it when you revise."),
      importance: z.number().min(0).optional(),
      feature_key: z.string().optional().describe("Link to this feature in the same transaction."),
    },
    handler: async (client, args) => (await client.post("/v1/stories", args)).body,
  },
  {
    name: "catalog_update_story",
    title: "Update a user story",
    description:
      "Revise a story. Requires product-manager. Only the fields you send change.\n\n" +
      "Set last_reviewed_at when you revise. Leaving it untouched is the most common mistake " +
      "here: confidence decays from that timestamp, and an accurate story that looks stale is " +
      "as misleading as the reverse.",
    inputSchema: {
      story_key: z.string(),
      role: z.string().optional(),
      want: z.string().optional(),
      benefit: z.string().optional(),
      status: z.enum(["current", "stale", "retired"]).optional(),
      last_reviewed_at: z.string().optional().describe("ISO 8601."),
      importance: z.number().min(0).optional(),
    },
    annotations: { idempotentHint: true },
    handler: async (client, args) => {
      const { story_key, ...payload } = args;
      return (await client.patch(`/v1/stories/${seg(story_key)}`, payload)).body;
    },
  },
  {
    name: "catalog_create_acceptance_criterion",
    title: "Create an acceptance criterion",
    description:
      "Add an acceptance criterion, optionally linked to a feature in the same transaction. " +
      "Requires product-manager.\n\n" +
      "Four bars, and the second is the one authors skip: NAME THE BUG THIS WOULD CATCH, then " +
      "check the `given` actually reaches it. A criterion only discriminates if the correct " +
      "and the broken implementation produce DIFFERENT results under the setup you wrote. Most " +
      "unfalsifiable criteria have a fine `then` and a `given` describing a case where both " +
      "behaviours look identical.\n\n" +
      "It must also be checkable by someone else without asking what you meant, verify purpose " +
      "rather than presentation (criteria bound to the current UI shatter on the next refactor " +
      "and get retired, quietly eroding coverage), and be binary — no 'works well' or " +
      "'fast enough'.\n\n" +
      "Bars 2 and 3 pull against each other. Moving a criterion off presentation usually leaves " +
      "the `then` intact and quietly stops the `given` from discriminating; the repair is in " +
      "the `given`, not the `then`.",
    inputSchema: {
      key: z.string().describe("ac_ followed by six lowercase alphanumerics."),
      product_key: productKey,
      given: z.string().describe("The setup. This is where falsifiability is usually lost."),
      when_: z.string().describe("Trailing underscore: 'when' is a reserved word."),
      then_: z.string().describe("The assertion. Trailing underscore: 'then' is reserved."),
      status: z.enum(["active", "retired"]).optional(),
      feature_key: z.string().optional().describe("Link to this feature in the same transaction."),
    },
    handler: async (client, args) => (await client.post("/v1/acceptance-criteria", args)).body,
  },
  {
    name: "catalog_update_acceptance_criterion",
    title: "Update an acceptance criterion",
    description:
      "Revise a criterion. Requires product-manager. Only the fields you send change.\n\n" +
      "If a criterion broke during a refactor because it tested presentation, REWRITE it " +
      "against purpose rather than retiring it. Retiring removes coverage without removing risk.",
    inputSchema: {
      ac_key: z.string(),
      given: z.string().optional(),
      when_: z.string().optional(),
      then_: z.string().optional(),
      status: z.enum(["active", "retired"]).optional(),
    },
    annotations: { idempotentHint: true },
    handler: async (client, args) => {
      const { ac_key, ...payload } = args;
      return (await client.patch(`/v1/acceptance-criteria/${seg(ac_key)}`, payload)).body;
    },
  },
];
