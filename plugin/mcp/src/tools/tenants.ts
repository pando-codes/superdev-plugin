import { z } from "zod";
import { seg } from "../client.ts";
import { drain } from "../drain.ts";
import * as journal from "../journal.ts";
import { workspaceRoot } from "../workspace.ts";
import type { ToolDefinition } from "./types.ts";

/**
 * Correspondence and decisions: the two tenants that are not delivery.
 *
 * WHY SENDING SUCCEEDS WHEN THE BACKLOG IS UNREACHABLE
 *
 * Both tenants are append-only and uncontended, which is exactly the class of
 * write that can be journalled locally and drained later. So a send writes to
 * `.superdev/journal/` first, then tries to drain; the tool succeeds either way
 * and reports whether the record has reached the backlog yet.
 *
 * This is not a convenience. An agent whose "tell quality-assurance the spec is
 * ready" call fails will do something else — retry, work around it, or tell the
 * user coordination is broken — and none of those is better than a message
 * sitting in a file waiting for a network.
 *
 * The counterpart rule is in the work tools and is deliberately different:
 * claiming an item is MUTUAL EXCLUSION and cannot be journalled, because two
 * agents claiming locally and draining afterwards produces a conflict that can
 * only be resolved by discarding work somebody already did.
 *
 * WHY THERE IS NO `sender` OR `decided_by` ARGUMENT
 *
 * For the same reason there is no `role` argument anywhere: it is not the
 * caller's to assert. The backlog forces both from the connection's declared
 * agent id, and a parameter here would be a field the database overwrites —
 * which reads, to anyone calling it, like something they get to choose.
 */

const SUBJECT_HELP =
  "Optional. What this is ABOUT, as a namespaced reference: " +
  "'superdev:delivery/work_item/wi_a1b2c3', 'local:agent-suite/work-item/wi_a1b2c3'. " +
  "A bare 'wi_a1b2c3' is REFUSED — two systems mint that shape over different id " +
  "spaces, and an unnamespaced reference is ambiguous between them. The target is " +
  "never verified: it may live in a tenant this backlog does not have.";

const subject = z.string().optional().describe(SUBJECT_HELP);

export const tenantTools: ToolDefinition[] = [
  {
    name: "backlog_send_message",
    title: "Send a message to another agent",
    description:
      "Send one message to one named agent. Requires the `correspondence` tenant.\n\n" +
      "ONE RECIPIENT. To reach two agents, send two messages. Asking one agent to pass " +
      "something on loses the record that the second was told, and makes the sender's account " +
      "of what happened depend on a third party doing something it was never asked to do.\n\n" +
      "WRITES LOCALLY FIRST and drains to the backlog afterwards, so this succeeds with no " +
      "network. The answer says whether it has reached the backlog yet; if it has not, it " +
      "will on the next drain and nothing is lost.\n\n" +
      "This is for JUDGMENT — an opinion, an escalation, a question, a heads-up. A request " +
      "that is a UNIT OF WORK belongs in the queue instead: file it with backlog_file_work so " +
      "it can be claimed, leased, and judged against criteria. A message asking someone to " +
      "build something is a message nobody is accountable for.",
    inputSchema: {
      product_key: z.string().describe("Which product's correspondence this belongs to."),
      recipient: z.string().describe("The agent this is addressed to, e.g. 'quality-assurance'."),
      kind: z
        .enum(["event", "metric", "request", "decision-request"])
        .describe(
          "event: something happened. metric: a measurement. request: please do/answer this. " +
            "decision-request: a Head must rule on this.",
        ),
      body: z.string().describe("What you are actually saying. Write it for the recipient."),
      subject,
    },
    handler: async (client, args) => {
      const { product_key, ...payload } = args;
      const home = workspaceRoot();
      const record = await journal.append(home, "correspondence", product_key, payload);
      const outcome = await drain(client, home, "correspondence");
      return {
        journalled: true,
        client_id: record.client_id,
        delivered: outcome.still_pending === 0,
        drain: outcome,
      };
    },
  },

  {
    name: "backlog_read_messages",
    title: "Read messages",
    description:
      "Read correspondence in a product, newest first. Requires the `correspondence` tenant.\n\n" +
      "Reads the BACKLOG, not the local journal, so a message this machine has journalled " +
      "but not yet drained will not appear. Call backlog_drain_journal first if you have just " +
      "sent something and need to see it here.\n\n" +
      "Not restricted to messages addressed to you: reconstructing what happened between two " +
      "other agents is a normal thing to need, and a report that could only see its own inbox " +
      "would be wrong about everything else.",
    inputSchema: {
      product_key: z.string(),
      recipient: z.string().optional().describe("Only messages addressed to this agent."),
      sender: z.string().optional().describe("Only messages from this agent."),
      subject: z.string().optional().describe("Only messages about this exact subject key."),
      since: z.string().optional().describe("ISO 8601. Only messages after this instant."),
      limit: z.number().int().positive().max(500).optional(),
    },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => {
      const { product_key, ...query } = args;
      const qs = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) qs.set(key, String(value));
      }
      const suffix = qs.toString();
      return (
        await client.get(
          `/v1/products/${seg(product_key)}/messages${suffix ? `?${suffix}` : ""}`,
        )
      ).body;
    },
  },

  {
    name: "backlog_record_decision",
    title: "Record a decision",
    description:
      "Record one ruling on one question. Requires the `decision` tenant AND a Head role — " +
      "every other role is refused by the database, and that refusal is the point.\n\n" +
      "A decision is the one thing here written to be READ LATER, by someone who was not in " +
      "the room. So `rationale` is required and is the field that matters: what was traded " +
      "against what. 'Approved' is not a rationale, and a ruling whose reasoning was not " +
      "written down cannot be revisited — only re-argued.\n\n" +
      "APPEND-ONLY. A ruling that turns out to be wrong is superseded by a NEWER one with " +
      "disposition 'superseded' or a fresh verdict; nothing is edited, because the history of " +
      "what was believed when is what makes the record worth keeping.\n\n" +
      "You may not rule on your own request. `requested_by` must be somebody else.\n\n" +
      "Writes locally first and drains afterwards, exactly as backlog_send_message does.",
    inputSchema: {
      product_key: z.string(),
      key: z
        .string()
        .describe("'dec_' plus exactly six lowercase alphanumerics, e.g. 'dec_7bq1lm'. Global."),
      domain: z
        .string()
        .describe("Which org ruled, e.g. 'engineering', 'growth', 'creative', 'operations'."),
      requested_by: z.string().describe("Who asked. Must not be you."),
      question: z.string().describe("What was being decided, in one line."),
      disposition: z
        .enum(["accepted", "rejected", "deferred", "superseded"])
        .describe(
          "deferred is a real decision and worth recording as one — it says the question was " +
            "considered and left open, which silence does not.",
        ),
      rationale: z.string().describe("The trade-off, named. What was given up for what."),
      consequences: z.string().optional().describe("What follows. 'Nothing changes' is a real answer."),
      subject,
    },
    handler: async (client, args) => {
      const { product_key, ...payload } = args;
      const home = workspaceRoot();
      const record = await journal.append(home, "decision", product_key, payload);
      const outcome = await drain(client, home, "decision");
      return {
        journalled: true,
        client_id: record.client_id,
        delivered: outcome.still_pending === 0,
        drain: outcome,
      };
    },
  },

  {
    name: "backlog_read_decisions",
    title: "Read decisions",
    description:
      "Read rulings in a product, newest first. Requires the `decision` tenant.\n\n" +
      "Open to every role, not only Heads: a decision binds the agents who did not make it, " +
      "and one they cannot read is one they cannot follow.\n\n" +
      "Read these before re-arguing something. A `deferred` ruling means the question was " +
      "considered and left open on purpose, which is different from nobody having thought " +
      "about it.",
    inputSchema: {
      product_key: z.string(),
      domain: z.string().optional().describe("Only rulings from this domain."),
      subject: z.string().optional().describe("Only rulings about this exact subject key."),
      limit: z.number().int().positive().max(500).optional(),
    },
    annotations: { readOnlyHint: true },
    handler: async (client, args) => {
      const { product_key, ...query } = args;
      const qs = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) qs.set(key, String(value));
      }
      const suffix = qs.toString();
      return (
        await client.get(
          `/v1/products/${seg(product_key)}/decisions${suffix ? `?${suffix}` : ""}`,
        )
      ).body;
    },
  },

  {
    name: "backlog_drain_journal",
    title: "Drain the local journal",
    description:
      "Send everything this machine has journalled but not yet delivered.\n\n" +
      "Sends, decisions, and progress notes already drain themselves, so this is for the case " +
      "where that " +
      "failed: the backlog was unreachable, the key was not yet configured, or the tenant " +
      "was not enabled at the time. Call it after fixing any of those, or when you want to " +
      "know whether anything is still waiting.\n\n" +
      "Safe to call repeatedly and safe to call when there is nothing to do. Delivery is " +
      "AT-LEAST-ONCE: a record the backlog already has is reported as a duplicate and " +
      "written again by nobody. `still_pending` above zero means something is still waiting, " +
      "and `problem` says what stopped it.",
    inputSchema: {
      stream: z
        .enum(["correspondence", "decision", "work-progress"])
        .optional()
        .describe("Which journal. Omitted drains all three."),
    },
    handler: async (client, args) => {
      const home = workspaceRoot();
      const streams: journal.JournalStream[] =
        args.stream === undefined
          ? ["correspondence", "decision", "work-progress"]
          : [args.stream];
      const outcomes = [];
      for (const stream of streams) {
        outcomes.push(await drain(client, home, stream));
      }
      return { journal_root: home, drained: outcomes };
    },
  },

  {
    name: "backlog_journal_status",
    title: "What is waiting in the local journal",
    description:
      "How many records this machine has journalled, and how many have reached the backlog.\n\n" +
      "Touches no network, so it answers while the backlog is down — which is exactly when " +
      "'has anything been lost?' is worth asking. Nothing has: `pending` is what is still on " +
      "disk waiting, and backlog_drain_journal is what moves it.\n\n" +
      "The journal is this MACHINE's outbox, not shared state — anything drained already lives " +
      "in the backlog, and the cursor is per-machine. `.superdev/journal/` belongs in the " +
      "workspace's .gitignore; committing it makes two checkouts disagree about what has been " +
      "sent.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
    handler: async (_client, _args) => {
      const home = workspaceRoot();
      return {
        journal_root: home,
        streams: [
          await journal.status(home, "correspondence"),
          await journal.status(home, "decision"),
          await journal.status(home, "work-progress"),
        ],
      };
    },
  },
];
