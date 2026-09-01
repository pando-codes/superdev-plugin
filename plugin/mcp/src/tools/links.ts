import { z } from "zod";
import type { ToolDefinition } from "./types.ts";

/**
 * Link and unlink, as two tools rather than twelve.
 *
 * Tool count is context an agent pays for on every turn, and six near-identical
 * link tools would be six near-identical descriptions to read past. The cost of
 * folding them is that MCP input schemas are flat object shapes with no
 * discriminated union, so the per-kind fields are all optional here and the
 * required combination is checked in the handler.
 *
 * That check is worth writing carefully: a bad error message on a tool with six
 * modes is the difference between an agent correcting itself and an agent
 * guessing. So the failure names the kind, lists exactly what that kind needs,
 * and says what was missing.
 */

const KINDS = {
  "capability-feature": {
    required: ["product_key", "capability_key", "feature_key"],
    note:
      "A feature SERVES a capability. Link on value served, never on dependency. " +
      "Optionally carries cost_score and value_score, which are per-EDGE: the same " +
      "feature may cost and contribute differently to each capability it serves. " +
      "Re-linking an existing edge is how you attach them later, and omitting them " +
      "leaves any already recorded untouched. Leave them unset rather than guessing " +
      "— an unscored edge is honest, a zero claims the feature contributes nothing.",
  },
  "feature-story": {
    required: ["product_key", "feature_key", "story_key"],
    note: "A story belongs to at most one feature; a second link is refused.",
  },
  "feature-ac": {
    required: ["product_key", "feature_key", "ac_key"],
    note: "A criterion belongs to at most one feature; a second link is refused.",
  },
  "capability-dependency": {
    required: ["product_key", "from_capability_key", "to_capability_key", "kind_of_dependency"],
    note: "from REQUIRES or DEGRADES_WITHOUT to. Both must be in the same product.",
  },
  "work-item-feature": {
    required: ["work_item_key", "product_key", "feature_key"],
    note: "A wi_* work item targets a feature.",
  },
  "work-item-ac": {
    required: ["work_item_key", "ac_key"],
    note:
      "A wi_* work item satisfies a criterion. Refused if the work item targets features and " +
      "the criterion belongs to none of them — the database does not check this, so the API does.",
  },
} as const;

type Kind = keyof typeof KINDS;

const shape = {
  kind: z
    .enum(Object.keys(KINDS) as [Kind, ...Kind[]])
    .describe(
      Object.entries(KINDS)
        .map(([k, v]) => `${k}: needs ${v.required.join(", ")}. ${v.note}`)
        .join("\n"),
    ),
  product_key: z.string().optional(),
  capability_key: z.string().optional(),
  feature_key: z.string().optional(),
  story_key: z.string().optional(),
  ac_key: z.string().optional(),
  from_capability_key: z.string().optional(),
  to_capability_key: z.string().optional(),
  work_item_key: z.string().optional().describe("wi_ followed by six lowercase alphanumerics."),
  cost_score: z
    .number()
    .min(0)
    .optional()
    .describe("Only for kind='capability-feature'. Per-edge, not per-feature."),
  value_score: z
    .number()
    .min(0)
    .optional()
    .describe("Only for kind='capability-feature'. Per-edge, not per-feature."),
  kind_of_dependency: z
    .enum(["requires", "degrades_without"])
    .optional()
    .describe("Only for kind='capability-dependency'."),
};

/**
 * Builds the API payload for one kind, or explains precisely what is missing.
 * Field names are translated where the API's differ (`kind_of_dependency` exists
 * so the dependency's own kind does not collide with the tool's `kind`).
 */
function payloadFor(args: any): { path: string; payload: Record<string, unknown> } {
  const kind = args.kind as Kind;
  const spec = KINDS[kind];
  const missing = spec.required.filter((field) => args[field] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `kind="${kind}" requires ${spec.required.join(", ")}; missing: ${missing.join(", ")}. ${spec.note}`,
    );
  }

  switch (kind) {
    case "capability-feature":
      return {
        path: "/v1/links/capability-feature",
        payload: {
          product_key: args.product_key,
          capability_key: args.capability_key,
          feature_key: args.feature_key,
          // Omitted rather than sent as null: the API is .strict() about
          // unknown fields but treats an absent optional as "no opinion", and
          // null would be a value the schema rejects.
          ...(args.cost_score === undefined ? {} : { cost_score: args.cost_score }),
          ...(args.value_score === undefined ? {} : { value_score: args.value_score }),
        },
      };
    case "feature-story":
      return {
        path: "/v1/links/feature-story",
        payload: {
          product_key: args.product_key,
          feature_key: args.feature_key,
          story_key: args.story_key,
        },
      };
    case "feature-ac":
      return {
        path: "/v1/links/feature-ac",
        payload: {
          product_key: args.product_key,
          feature_key: args.feature_key,
          ac_key: args.ac_key,
        },
      };
    case "capability-dependency":
      return {
        path: "/v1/links/capability-dependency",
        payload: {
          product_key: args.product_key,
          from_capability_key: args.from_capability_key,
          to_capability_key: args.to_capability_key,
          kind: args.kind_of_dependency,
        },
      };
    case "work-item-feature":
      return {
        path: "/v1/links/work-item-feature",
        payload: {
          work_item_key: args.work_item_key,
          product_key: args.product_key,
          feature_key: args.feature_key,
        },
      };
    case "work-item-ac":
      return {
        path: "/v1/links/work-item-ac",
        payload: { work_item_key: args.work_item_key, ac_key: args.ac_key },
      };
  }
}

export const linkTools: ToolDefinition[] = [
  {
    name: "backlog_link",
    title: "Link two records",
    description:
      "Create a link between two backlog records. Requires product-manager.\n\n" +
      "Which fields are required depends on `kind` — see its description. Stories and " +
      "acceptance criteria are SIBLINGS under a feature, not parent and child: each links to " +
      "the feature independently, and there is no story-to-criterion link.",
    inputSchema: shape,
    handler: async (client, args) => {
      const { path, payload } = payloadFor(args);
      return (await client.post(path, payload)).body;
    },
  },
  {
    name: "backlog_unlink",
    title: "Remove a link",
    description:
      "Remove a link. Requires product-manager.\n\n" +
      "Unlinking is not deletion — a feature legitimately stops serving a capability, and " +
      "nothing in this model is ever hard-deleted. Note that removing a feature's LAST " +
      "capability is refused: the database does not hold an orphaned feature even briefly. " +
      "To retire a record, set its lifecycle field instead.",
    inputSchema: shape,
    annotations: { destructiveHint: true, idempotentHint: true },
    handler: async (client, args) => {
      const { path, payload } = payloadFor(args);
      return (await client.delete(path, payload)).body;
    },
  },
];
