import { z } from "zod";
import { seg } from "../client.ts";
import type { ToolDefinition } from "./types.ts";

const productKey = z.string().describe("Product slug, e.g. 'trenchcoat'.");

/**
 * Read tools.
 *
 * Every one is marked readOnlyHint. Reads are open to every mapped pando_role
 * (012: "Reading is not an assertion"), so these work for any provisioned key
 * regardless of what it may write.
 */
export const readTools: ToolDefinition[] = [
  {
    name: "catalog_whoami",
    title: "Who is this key",
    description:
      "Report which Postgres role and pando_role this API key carries, and what the " +
      "database sees for the connection a request runs on. Call this first when a write " +
      "is unexpectedly refused: the answer says which role you actually hold.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
    handler: async (client) => (await client.get("/v1/whoami")).body,
  },
  {
    name: "catalog_list_products",
    title: "List products",
    description: "List every product in the catalogue.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
    handler: async (client) => (await client.get("/v1/products")).body,
  },
  {
    name: "catalog_list_capabilities",
    title: "List capabilities",
    description:
      "List a product's capabilities. The capability set is the denominator for every " +
      "weight and coverage figure the model reports, so this is the partition, not a tag list.",
    inputSchema: {
      product_key: productKey,
      status: z
        .enum(["proposed", "active", "deprecated", "archived"])
        .optional()
        .describe("Filter by lifecycle status. Omit for all."),
    },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => {
      const query = args.status ? `?status=${seg(args.status)}` : "";
      return (await client.get(`/v1/products/${seg(args.product_key)}/capabilities${query}`)).body;
    },
  },
  {
    name: "catalog_get_capability",
    title: "Get a capability",
    description:
      "One capability with the features that serve it and its computed weight. " +
      "A null weight means 'not yet measurable', not 'worth nothing'.",
    inputSchema: {
      product_key: productKey,
      capability_key: z.string().describe("Capability slug. Unique per product, not globally."),
    },
    annotations: { readOnlyHint: true },
    handler: async (client, args) =>
      (
        await client.get(
          `/v1/products/${seg(args.product_key)}/capabilities/${seg(args.capability_key)}`,
        )
      ).body,
  },
  {
    name: "catalog_list_features",
    title: "List features",
    description:
      "List a product's features. Only 'active' features count toward verification and " +
      "coverage, so lifecycle_state is worth reading rather than skimming.",
    inputSchema: {
      product_key: productKey,
      lifecycle_state: z
        .enum(["proposed", "active", "deprecated", "removed"])
        .optional()
        .describe("Filter by lifecycle state. Omit for all."),
    },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => {
      const query = args.lifecycle_state ? `?lifecycle_state=${seg(args.lifecycle_state)}` : "";
      return (await client.get(`/v1/products/${seg(args.product_key)}/features${query}`)).body;
    },
  },
  {
    name: "catalog_get_feature",
    title: "Get a feature",
    description:
      "One feature with its stories, acceptance criteria, and verified state. Stories and " +
      "criteria are SIBLINGS under a feature, not parent and child — neither links through " +
      "the other.",
    inputSchema: {
      product_key: productKey,
      feature_key: z.string().describe("Feature slug. Unique per product, not globally."),
    },
    annotations: { readOnlyHint: true },
    handler: async (client, args) =>
      (await client.get(`/v1/products/${seg(args.product_key)}/features/${seg(args.feature_key)}`))
        .body,
  },
  {
    name: "catalog_get_story",
    title: "Get a user story",
    description:
      "One user story with its derived confidence. Confidence decays from last_reviewed_at, " +
      "so an accurate story that looks stale is as misleading as the reverse. " +
      "Story keys are GLOBAL — no product is needed to address one.",
    inputSchema: { story_key: z.string().describe("e.g. 'story_9f3k2a'.") },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => (await client.get(`/v1/stories/${seg(args.story_key)}`)).body,
  },
  {
    name: "catalog_get_acceptance_criterion",
    title: "Get an acceptance criterion",
    description:
      "One acceptance criterion with its latest evaluation. 'Never evaluated' is the ABSENCE " +
      "of an evaluation, not a third verdict. Criterion keys are GLOBAL.",
    inputSchema: { ac_key: z.string().describe("e.g. 'ac_7bq1lm'.") },
    annotations: { readOnlyHint: true },
    handler: async (client, args) =>
      (await client.get(`/v1/acceptance-criteria/${seg(args.ac_key)}`)).body,
  },
  {
    name: "catalog_model_health",
    title: "Model health",
    description:
      "Problems the model can detect in itself for one product — orphaned features, " +
      "partially populated signal kinds, overdue coverage reviews. The first thing to check " +
      "when a figure looks wrong.",
    inputSchema: { product_key: productKey },
    annotations: { readOnlyHint: true },
    handler: async (client, args) =>
      (await client.get(`/v1/products/${seg(args.product_key)}/model-health`)).body,
  },
  {
    name: "catalog_coverage",
    title: "Coverage",
    description:
      "A product's weighted verified share, and how many of its capabilities carry no weight. " +
      "A high unweighted count makes the share unrepresentative.",
    inputSchema: { product_key: productKey },
    annotations: { readOnlyHint: true },
    handler: async (client, args) =>
      (await client.get(`/v1/products/${seg(args.product_key)}/coverage`)).body,
  },
  {
    name: "catalog_public_catalog",
    title: "Public catalogue",
    description:
      "The GTM projection: public capabilities with their public feature counts. This is the " +
      "view intended to reach customers, so its contents are a claim you are making publicly.",
    inputSchema: { product_key: productKey },
    annotations: { readOnlyHint: true },
    handler: async (client, args) =>
      (await client.get(`/v1/products/${seg(args.product_key)}/catalog`)).body,
  },
];
