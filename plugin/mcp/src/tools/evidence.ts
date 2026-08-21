import { z } from "zod";
import { seg } from "../client.ts";
import type { ToolDefinition } from "./types.ts";

/**
 * Evaluations and evidence.
 *
 * These are the tools that make the model's numbers mean anything. Before any
 * of these records exist, `latest_ac_state` is empty, nothing is verified, every
 * capability weight is NULL, and coverage is zero — which is precisely the state
 * a fresh catalogue reports, and it looks like bad news rather than missing
 * input.
 *
 * Both tables are append-only. There is no update or delete tool because the
 * database rejects both regardless of role.
 */
export const evidenceTools: ToolDefinition[] = [
  {
    name: "catalog_record_evaluation",
    title: "Record an evaluation",
    description:
      "Record one evaluation of one acceptance criterion. Requires quality-assurance or ci.\n\n" +
      "APPEND-ONLY. There is no way to edit or delete an evaluation, and that is deliberate: " +
      "evaluation history must outlive the thing it evaluated. A mistaken evaluation is " +
      "corrected by recording a NEWER one — the model reads the most recent per criterion, so " +
      "the correction supersedes rather than rewrites.\n\n" +
      "The verdict is binary. 'Never evaluated' is the ABSENCE of a record, not a third value, " +
      "so do not record a placeholder for a check that did not run.\n\n" +
      "evaluated_at is when the check RAN, not when you are reporting it. Send the real one " +
      "for a run being uploaded after the fact, or the verification history is misdated.",
    inputSchema: {
      ac_key: z.string().describe("e.g. 'ac_7bq1lm'."),
      verdict: z.enum(["pass", "fail"]),
      method: z
        .enum(["automated", "manual", "agent"])
        .describe("How it was checked. 'agent' means a model judged it."),
      source: z.string().describe("What produced this, e.g. 'ci:pytest' or a person's name."),
      evaluated_at: z.string().optional().describe("ISO 8601. Defaults to now."),
      run_ref: z.string().optional().describe("Link back to the run, e.g. a CI job URL."),
      notes: z.string().optional(),
    },
    handler: async (client, args) => {
      const { ac_key, ...payload } = args;
      return (
        await client.post(`/v1/acceptance-criteria/${seg(ac_key)}/evaluations`, payload)
      ).body;
    },
  },
  {
    name: "catalog_record_evidence",
    title: "Record an evidence window",
    description:
      "Record one signal kind across a product for one window. Requires revops or ci.\n\n" +
      "SEND A ROW FOR EVERY ACTIVE CAPABILITY, INCLUDING THOSE MEASURING ZERO. This is the " +
      "one instruction that matters here, because getting it wrong fails silently: a signal " +
      "kind participates in capability weighting only once it has FULL coverage for the " +
      "window, so a batch that skips zero-activity capabilities never reaches it. The kind " +
      "never participates, every weight tied to it stays null, and NOTHING ERRORS — rows land " +
      "and the pipeline looks healthy. Call catalog_list_capabilities with status=active first " +
      "and send one entry per key it returns.\n\n" +
      "An incomplete batch is refused and names what is missing. allow_partial overrides that " +
      "and is rarely the right answer.\n\n" +
      "Full coverage is necessary, not sufficient: a window whose values are all zero is " +
      "excluded too, as is a kind carrying a zero coefficient in the product's weight policy. " +
      "Neither shows up as a model-health problem.",
    inputSchema: {
      product_key: z.string(),
      kind: z.enum(["revenue", "active_users", "incidents", "support_tickets"]),
      as_of: z.string().describe("The window this measures, YYYY-MM-DD."),
      source: z.string().describe("What produced these numbers."),
      signals: z
        .array(z.object({ capability_key: z.string(), value: z.number() }))
        .min(1)
        .describe("One entry per ACTIVE capability. Include zeros."),
      allow_partial: z
        .boolean()
        .optional()
        .describe("Accept a batch missing some active capabilities. Rarely correct."),
    },
    handler: async (client, args) => (await client.post("/v1/evidence-signals", args)).body,
  },
];
