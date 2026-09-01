import { z } from "zod";
import { drain } from "../drain.ts";
import * as journal from "../journal.ts";
import { workspaceRoot } from "../workspace.ts";
import { ApiError, seg } from "../client.ts";
import type { ToolDefinition } from "./types.ts";

/**
 * The work queue: how an agent finds out what to do, and says what happened.
 *
 * WHY THESE DESCRIPTIONS ARE LONGER THAN THE OTHERS
 *
 * Every other tool in this server is called by a model a person is watching. These
 * are called by a model running a loop with nobody reading the intermediate
 * steps, so the description is the ENTIRE briefing an agent gets about how the
 * queue behaves. The two things it must not get wrong are both counter-intuitive:
 * an empty answer is success, and a lease can be lost while you still hold the
 * work in your head.
 */

const agentIdField = z
  .string()
  .min(1)
  .max(64)
  .optional()
  .describe(
    "Who is acting, if not this server's configured identity. Pass a distinct id " +
      "when several agents share one session — otherwise they are the same agent to " +
      "the backlog and can release or finish each other's work by accident. It " +
      "changes WHO holds a claim, never WHAT this key is allowed to do.",
  );

const productKey = z.string().describe("Product slug, from .superdev/product.json.");

const workItemKey = z
  .string()
  .regex(/^wi_[a-z0-9]{6}$/, "wi_ followed by exactly six lowercase alphanumerics")
  .describe("Work item key, e.g. wi_a1b2c3.");

/**
 * Wraps the three operations that CANNOT be journalled, so an offline agent is
 * told the rule rather than handed a transport error.
 *
 * Claiming is mutual exclusion; heartbeating and finishing both assert a live
 * lease. None of them can be deferred to a drain, because two agents claiming
 * locally and reconciling afterwards produces a conflict resolvable only by
 * discarding work somebody already did — which is why the claim is
 * `for update skip locked` in Postgres and not a client concern.
 *
 * An `ApiError` is a real answer and passes straight through: "this item is
 * already held" is information, and dressing it up as an outage would be a lie.
 * Only a request that never reached anything is rewritten, and the rewrite says
 * what an agent can still do — because "keep working the item you hold and keep
 * journalling progress" is the correct behaviour here and is not obvious.
 */
async function serverOnly<T>(what: string, run: () => Promise<T>): Promise<T | ServerOnlyOffline> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return {
      unavailable: true,
      operation: what,
      reason: error instanceof Error ? error.message : String(error),
      explanation:
        `${what} cannot be done offline and cannot be journalled: it is the queue's mutual ` +
        "exclusion, and two agents resolving that after the fact would mean discarding work " +
        "somebody already did.",
      what_you_can_still_do:
        "Keep working the item you already hold, and keep calling backlog_push_progress — " +
        "notes are append-only and journal locally, so they will land when the backlog is " +
        "reachable again, even if this lease has expired by then. Do not take new work.",
    };
  }
}

interface ServerOnlyOffline {
  readonly unavailable: true;
  readonly operation: string;
  readonly reason: string;
  readonly explanation: string;
  readonly what_you_can_still_do: string;
}

export const workTools: ToolDefinition[] = [
  {
    name: "backlog_claim_work",
    title: "Claim the next work item",
    description:
      "Take the next piece of work addressed to THIS KEY'S ROLE in the given product, " +
      "and get the whole brief back in the same answer.\n\n" +
      "This is the first call of an autonomous run. What comes back is everything " +
      "needed to start without asking anyone: `intent` (why this work exists now), " +
      "`guidance` (how the author wants it done), `features` (each with the " +
      "capabilities it serves and the user stories that explain who it is for), " +
      "`must_satisfy` (the acceptance criteria this item is judged against), " +
      "`definition_of_done`, and `notes` (what previous agents said).\n\n" +
      "THREE THINGS TO KNOW BEFORE YOU LOOP ON THIS:\n\n" +
      "1. `claimed: null` IS SUCCESS. It means this role's queue is empty right now — " +
      "not that the product has no work, and not that anything failed. Stop and report " +
      "that; do not retry in a tight loop and do not go looking for work elsewhere.\n\n" +
      "2. WORK IS ADDRESSED TO A ROLE, and the role is your key's — you cannot ask for " +
      "another role's queue. An engineer will never be handed a quality-assurance item " +
      "even if it is the highest priority thing in the product. That is the design, not " +
      "a misconfiguration.\n\n" +
      "3. THE CLAIM IS A LEASE, not an assignment. It expires. Call " +
      "`backlog_heartbeat_work` while you work, and treat a lost lease as a full stop: " +
      "another agent may already have taken the item.",
    inputSchema: {
      product_key: productKey,
      lease_seconds: z
        .number()
        .int()
        .min(30)
        .max(86400)
        .optional()
        .describe(
          "How long you are claiming it for, default 900. Ask for roughly how long " +
            "you expect the work to take and heartbeat rather than asking for hours: a " +
            "long lease on an agent that dies keeps the item out of the queue for that " +
            "whole time.",
        ),
      work_item_key: workItemKey
        .optional()
        .describe(
          "Claim this specific item instead of the next one. A FILTER, never an " +
            "override — the same role, state, lease, and dependency rules still apply, " +
            "so naming an item you may not have returns claimed: null.",
        ),
      agent_id: agentIdField,
    },
    handler: async (client, args) => {
      const { agent_id, ...payload } = args;
      return serverOnly(
        "Claiming work",
        async () => (await client.post("/v1/work-items/claim", payload, agent_id)).body,
      );
    },
  },
  {
    name: "backlog_list_work",
    title: "List the work queue",
    description:
      "See the queue without taking anything from it. Read-only, and it shows EVERY " +
      "role's work, not just yours — useful for reporting on what is outstanding and " +
      "for seeing what is blocked on whom.\n\n" +
      "`ready` is the field that matters: it is true when an item would actually be " +
      "handed out by a claim right now (open or lapsed, and its dependency finished). " +
      "An item that is not ready is not yours to start, whatever its priority says.\n\n" +
      "Ordering is priority ascending — SMALLER IS SOONER — then oldest first, which " +
      "is the same order a claim uses.",
    inputSchema: {
      product_key: productKey,
      role_required: z
        .string()
        .optional()
        .describe("Filter to one role's queue, e.g. 'engineer'. Omit for all roles."),
      state: z
        .enum(["open", "claimed", "blocked", "done", "cancelled"])
        .optional()
        .describe("Filter by state. Omit for all."),
      ready: z
        .boolean()
        .optional()
        .describe("True to show only items a claim would actually hand out now."),
      limit: z.number().int().min(1).max(500).optional().describe("Default 100."),
    },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => {
      const query = new URLSearchParams();
      if (args.role_required) query.set("role_required", args.role_required);
      if (args.state) query.set("state", args.state);
      if (args.ready === true) query.set("ready", "true");
      if (args.limit) query.set("limit", String(args.limit));
      const qs = query.toString();
      return (
        await client.get(
          `/v1/products/${seg(args.product_key)}/work-items${qs ? `?${qs}` : ""}`,
        )
      ).body;
    },
  },
  {
    name: "backlog_get_work",
    title: "Read a work item's brief",
    description:
      "The full brief for one work item — the same payload a claim returns, without " +
      "claiming anything. Use it to re-read your instructions mid-task, to check " +
      "whether an item you were about to start is still held by someone, or to read " +
      "the notes another agent left before you picked up its handoff.",
    inputSchema: { work_item_key: workItemKey },
    annotations: { readOnlyHint: true },
    handler: async (client, args) =>
      (await client.get(`/v1/work-items/${seg(args.work_item_key)}`)).body,
  },
  {
    name: "backlog_heartbeat_work",
    title: "Extend your lease",
    description:
      "Tell the backlog you are still working on an item you hold, pushing its lease " +
      "out.\n\n" +
      "Call this whenever a step finishes and before anything long. A lapsed lease " +
      "returns the item to the queue, and another agent taking it is how the same work " +
      "gets done twice.\n\n" +
      "A 409 `lease_lost` means YOU NO LONGER HOLD THIS. Do not retry it and do not " +
      "keep working: stop, discard anything uncommitted that assumed you owned the " +
      "item, and claim again. The three causes — lapsed, taken by another agent, no " +
      "such item — are reported identically because there is nothing you would do " +
      "differently between them.",
    inputSchema: {
      work_item_key: workItemKey,
      lease_seconds: z.number().int().min(30).max(86400).optional().describe("Default 900."),
      agent_id: agentIdField,
    },
    handler: async (client, args) => {
      const { work_item_key, agent_id, ...payload } = args;
      return serverOnly(
        "Heartbeating a lease",
        async () =>
          (await client.post(`/v1/work-items/${seg(work_item_key)}/heartbeat`, payload, agent_id))
            .body,
      );
    },
  },
  {
    name: "backlog_push_progress",
    title: "Push a progress note",
    description:
      "Append a note to a work item you are holding. Notes are permanent and cannot be " +
      "edited — a note is what you observed at a moment, and one that could be revised " +
      "afterwards would be evidence of nothing.\n\n" +
      "Choose the kind honestly, because they are read for different reasons:\n" +
      "  progress — what is now done. The thing a human checking on a long run wants.\n" +
      "  decision — a choice you made and WHY you made it. The most valuable kind by a\n" +
      "             wide margin: it is the only record of why the code looks like this,\n" +
      "             and the next agent has no other way to recover it.\n" +
      "  blocker  — what stopped you. Write this BEFORE moving the item to blocked.\n" +
      "  handoff  — what the next agent needs to know. Write it before you release.\n\n" +
      "Write few and write them worth reading. A note per file touched is noise; a note " +
      "recording why you rejected the obvious approach is the reason this table exists.",
    inputSchema: {
      work_item_key: workItemKey,
      kind: z.enum(["progress", "decision", "blocker", "handoff"]),
      body: z.string().min(1).describe("What happened, in prose. Complete sentences."),
      agent_id: agentIdField,
    },
    handler: async (client, args) => {
      const { work_item_key, agent_id, ...payload } = args;
      // Local-first, like a message and a decision and for the same reason: a
      // note is an append, two agents appending never conflict, and 029's policy
      // has never required a lease to write one. An agent that loses its network
      // mid-task keeps recording what it did, and the notes land later — even if
      // the lease it was working under expired in the meantime, which is
      // deliberate. Losing the record of real work is worse than a note on an
      // item that has moved on.
      const home = workspaceRoot();
      const record = await journal.append(
        home,
        "work-progress",
        // No product in the path for this stream; the note names its work item
        // and 029's policy resolves the product from it.
        "",
        { ...payload, work_item_key },
        agent_id,
      );
      const outcome = await drain(client, home, "work-progress");
      return {
        journalled: true,
        client_id: record.client_id,
        delivered: outcome.still_pending === 0,
        drain: outcome,
      };
    },
  },
  {
    name: "backlog_finish_work",
    title: "Finish, block, or release a work item",
    description:
      "Move an item you hold out of `claimed`, and say what happened. The outcome is " +
      "required for everything except a release, and it is read by whoever picks up " +
      "what you left.\n\n" +
      "  done      — the work is complete. TERMINAL: nothing reopens it, ever. Only use\n" +
      "              it when every criterion in `must_satisfy` is actually observable,\n" +
      "              not when the code merely exists.\n" +
      "  blocked   — you stopped and it needs someone else. Push a `blocker` note first\n" +
      "              with the detail; the outcome here is the one-line version.\n" +
      "  open      — you are giving it back untouched. Honest and cheap; an item you\n" +
      "              cannot do is better released than held under a lease nobody is\n" +
      "              working. Push a `handoff` note first if you learned anything.\n" +
      "  cancelled — the work should not be done at all. TERMINAL. This is a planning\n" +
      "              judgement; if you are the one building it, prefer blocked and say\n" +
      "              why, and let the planner decide.\n\n" +
      "RECORDING A VERDICT IS A DIFFERENT ACT. Finishing a work item says you did the " +
      "work; it does not say the criteria pass. That is `backlog_record_evaluation`, " +
      "and deliberately not yours if your role cannot call it.",
    inputSchema: {
      work_item_key: workItemKey,
      state: z.enum(["done", "blocked", "open", "cancelled"]),
      outcome: z
        .string()
        .min(1)
        .optional()
        .describe(
          "What happened, in one or two sentences. Required for done, blocked, and " +
            "cancelled. Write it for someone who was not here.",
        ),
      agent_id: agentIdField,
    },
    handler: async (client, args) => {
      const { work_item_key, agent_id, ...payload } = args;
      return serverOnly(
        "Finishing work",
        async () =>
          (await client.patch(`/v1/work-items/${seg(work_item_key)}`, payload, agent_id)).body,
      );
    },
  },
  {
    name: "backlog_file_work",
    title: "File a work item",
    description:
      "Put a piece of work on the queue for a role to pick up. Requires product-manager " +
      "or head-of-engineering — an agent that could file its own work would have a " +
      "to-do list rather than a backlog.\n\n" +
      "THE QUALITY BAR, WHICH THE DATABASE CANNOT ENFORCE. A work item whose intent " +
      "reads 'improve things' satisfies every constraint in the schema and is worthless " +
      "to the agent that claims it. What you write here IS the briefing:\n\n" +
      "  title    — one line, what will be true when this is done. Not a topic.\n" +
      "  intent   — why this work exists NOW. The backlog already says what the\n" +
      "             feature is; this says why it is worth an agent's turn today. A\n" +
      "             criterion with no implementation, a verdict that came back failing,\n" +
      "             a capability whose weight moved. Name the thing that changed.\n" +
      "  guidance — how you want it done, where it differs from the obvious. Leave it\n" +
      "             out if there is nothing to say; empty guidance is better than\n" +
      "             restating the intent.\n\n" +
      "Then LINK IT. `backlog_link` with kind='work-item-feature' and " +
      "kind='work-item-ac' is what puts the stories and the acceptance criteria into " +
      "the brief. An unlinked work item hands the agent a sentence and no criteria, " +
      "which is the failure this whole model exists to prevent.\n\n" +
      "Address it to the role that does the work, not the role that wants it: building " +
      "is 'engineer', verifying is 'quality-assurance', planning is 'product-manager'.",
    inputSchema: {
      product_key: productKey,
      key: workItemKey.describe(
        "wi_ plus six lowercase alphanumerics you choose, e.g. wi_7bq1lm. Must be unique.",
      ),
      title: z.string().min(1),
      intent: z.string().min(1),
      guidance: z.string().min(1).optional(),
      role_required: z
        .enum([
          "product-manager",
          "quality-assurance",
          "engineer",
          "ci",
          "revops",
          "head-of-engineering",
        ])
        .describe("Which role may claim this."),
      priority: z
        .number()
        .int()
        .min(0)
        .max(1000)
        .optional()
        .describe("SMALLER IS SOONER. Default 100, leaving room on both sides."),
      depends_on_key: workItemKey
        .optional()
        .describe(
          "Another work item that must be `done` before this one is handed out. Use it " +
            "for genuine ordering, not for grouping — a dependency on something nobody " +
            "is doing makes this item invisible.",
        ),
    },
    handler: async (client, args) => {
      const { product_key, ...payload } = args;
      return (await client.post(`/v1/products/${seg(product_key)}/work-items`, payload)).body;
    },
  },
  {
    name: "backlog_steward_work",
    title: "Reprioritise or reword a work item",
    description:
      "Change a work item's wording or its place in the queue without touching its " +
      "state. Requires product-manager or head-of-engineering.\n\n" +
      "What cannot be changed, by design: the role it is addressed to, and its product. " +
      "Both would re-address work an agent may be holding mid-flight. Cancel and re-file " +
      "instead.",
    inputSchema: {
      work_item_key: workItemKey,
      title: z.string().min(1).optional(),
      intent: z.string().min(1).optional(),
      guidance: z.string().min(1).optional(),
      priority: z.number().int().min(0).max(1000).optional().describe("Smaller is sooner."),
    },
    handler: async (client, args) => {
      const { work_item_key, ...payload } = args;
      return (await client.patch(`/v1/work-items/${seg(work_item_key)}`, payload)).body;
    },
  },
];
