/**
 * Moving the journal to the backlog.
 *
 * Separate from journal.ts because that file touches only the filesystem and
 * this one needs the network. The split is what lets the journal be tested
 * without a server and lets an agent append with no credential configured at
 * all.
 *
 * WHY A FAILED DRAIN IS NOT AN ERROR
 *
 * Being unable to reach the backlog is the ordinary state this design was
 * built for, not an exception. An agent that journalled a message has already
 * done the thing it was asked to do; whether the record has reached a server yet
 * is operational news, and turning it into a thrown error would make every
 * offline send look like a failure to the model, which would then "helpfully"
 * retry, or work around it, or report to the user that coordination is broken.
 *
 * So drain reports what happened and does not throw. The cursor advances only
 * over records the backlog confirmed, so a failure costs a retry and never a
 * record.
 *
 * WHY THE CURSOR ADVANCES ONLY ON A CLEAN PRODUCT
 *
 * A journal can hold records for several products, and each drains to its own
 * endpoint. If one product's batch is refused — its tenant not enabled on this
 * key, say — the records for the others still landed, but the cursor is a single
 * position over one ordered file and cannot express "all but those".
 *
 * Advancing anyway would silently drop the refused records. So the cursor stops
 * at the first record belonging to a product that failed, everything before it
 * is confirmed, and the successful-but-later records are simply re-sent next
 * time — where the backlog reports them as duplicates and writes nothing. That
 * is the whole reason at-least-once was chosen over trying for exactly-once.
 */

import type { BacklogClient } from "./client.ts";
import { ApiError, seg } from "./client.ts";
import * as journal from "./journal.ts";
import type { JournalRecord, JournalStream } from "./journal.ts";

/**
 * Where each stream's batch goes, and what the API calls the array.
 *
 * `path` is a function because the endpoints are not the same shape.
 * Correspondence and decisions are addressed per product; work notes name their
 * work item in each record instead, and are scoped by 029's policy rather than
 * by the URL — so a journal spanning several products drains its notes in one
 * request rather than one per product.
 */
const ENDPOINT: Record<JournalStream, { path: (productKey: string) => string; field: string }> = {
  correspondence: {
    path: (product) => `/v1/products/${seg(product)}/messages/drain`,
    field: "messages",
  },
  decision: {
    path: (product) => `/v1/products/${seg(product)}/decisions/drain`,
    field: "rulings",
  },
  "work-progress": {
    path: () => "/v1/work-notes/drain",
    field: "notes",
  },
};

export interface DrainOutcome {
  readonly stream: JournalStream;
  readonly attempted: number;
  readonly landed: number;
  readonly duplicates: number;
  readonly still_pending: number;
  /** Present only when something stopped the drain. Never thrown. */
  readonly problem?: string;
}

/**
 * Sends everything past the cursor, in journal order, one product at a time.
 *
 * Batches are capped to match the API's own limit. A journal that has been
 * offline for a week drains over several calls rather than one request the body
 * limit would refuse.
 */
const MAX_BATCH = 500;

/**
 * Records are batched per (product, acting agent).
 *
 * The agent is part of the key and not just the product because the backlog
 * FORCES a record's author from the connection's declared agent id. Two
 * subagents journalling through one process must therefore drain in two
 * requests, or the second one's notes land under the first one's name — which
 * would quietly undo the attribution the whole design rests on.
 */
const groupKey = (r: JournalRecord): string => `${r.product_key}\u0000${r.as_agent ?? ""}`;

export async function drain(
  client: BacklogClient,
  home: string,
  stream: JournalStream,
): Promise<DrainOutcome> {
  const records = await journal.readAll(home, stream);
  const cursor = Math.min(await journal.readCursor(home, stream), records.length);
  const waiting = records.slice(cursor);

  if (waiting.length === 0) {
    return { stream, attempted: 0, landed: 0, duplicates: 0, still_pending: 0 };
  }

  const { path, field } = ENDPOINT[stream];
  const failedGroups = new Set<string>();
  let landed = 0;
  let duplicates = 0;
  let problem: string | undefined;

  const groups = new Map<string, JournalRecord[]>();
  for (const record of waiting) {
    const key = groupKey(record);
    const existing = groups.get(key);
    if (existing) existing.push(record);
    else groups.set(key, [record]);
  }

  for (const [key, group] of groups) {
    const productKey = group[0]!.product_key;
    const asAgent = group[0]!.as_agent;
    for (let i = 0; i < group.length; i += MAX_BATCH) {
      const batch = group.slice(i, i + MAX_BATCH);
      const body = {
        [field]: batch.map((r) => ({ ...r.payload, client_id: r.client_id })),
      };
      try {
        // `post` throws on any non-2xx, so there is no status to branch on here
        // — a refusal and an unreachable network arrive by the same path, which
        // is right: both mean "these records are still waiting".
        const result = await client.post<{ landed?: number; duplicates?: number }>(
          path(productKey),
          body,
          asAgent,
        );
        landed += result.body?.landed ?? 0;
        duplicates += result.body?.duplicates ?? 0;
      } catch (error) {
        failedGroups.add(key);
        const where = productKey === "" ? (asAgent ?? "this agent") : productKey;
        problem ??=
          error instanceof ApiError
            ? `${where}: the backlog answered ${error.status} (${error.message})`
            : `${where}: ${error instanceof Error ? error.message : String(error)}`;
        break;
      }
    }
  }

  // The first record belonging to a group that failed is where the cursor
  // stops. See this file's header for why it is not "everything that worked".
  let advance = waiting.length;
  if (failedGroups.size > 0) {
    const firstBad = waiting.findIndex((r) => failedGroups.has(groupKey(r)));
    advance = firstBad === -1 ? waiting.length : firstBad;
  }
  await journal.writeCursor(home, stream, cursor + advance);

  return {
    stream,
    attempted: waiting.length,
    landed,
    duplicates,
    still_pending: waiting.length - advance,
    ...(problem === undefined ? {} : { problem }),
  };
}
