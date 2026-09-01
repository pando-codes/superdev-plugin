/**
 * The local journal: append here first, drain to the backlog later.
 *
 * WHY THIS EXISTS
 *
 * Correspondence and decisions are how agents coordinate, and coordination that
 * requires a credential and a network is coordination that stops the moment
 * either is missing. Before this file, a workspace worked on clone-and-init
 * with nothing configured; a hosted message bus would have replaced that with a
 * 401 in the middle of a conversation.
 *
 * So every append-only write lands in a file first and reaches the backlog
 * afterwards. The agent's call succeeds whether or not anything is reachable,
 * and `backlog_drain_journal` is what eventually moves it.
 *
 * WHAT DELIBERATELY DOES NOT COME THROUGH HERE
 *
 * Claiming a work item, and finishing one. A claim is MUTUAL EXCLUSION: two
 * agents claiming the same item locally and draining afterwards produces a
 * conflict that cannot be resolved without discarding work somebody already
 * did. That is why the claim is `for update skip locked` in Postgres and not a
 * client concern, and it is why an offline agent can keep working the item it
 * already holds but cannot take a new one.
 *
 * The rule, stated once: APPEND-ONLY WRITES ARE LOCAL-FIRST; MUTUAL EXCLUSION
 * IS SERVER-ONLY.
 *
 * WHY NDJSON IN A DIRECTORY RATHER THAN SQLITE
 *
 * Because a hosted bus otherwise loses something the file-based one had, and it
 * is not a small thing: coordination you can read with `cat` and `grep`. When an
 * agent does something inexplicable, the record of what it said and when is a
 * text file, not a database that needs a client.
 *
 * Append is also the only write, which makes concurrent writers safe without a
 * lock: `appendFile` of a single line under the platform's buffer size is
 * atomic in practice on both POSIX and Windows, and two agents interleaving
 * whole lines is exactly the outcome wanted.
 *
 * WHY IT SHOULD NOT BE COMMITTED
 *
 * The journal is a machine's outbox, not shared state — the backlog is where
 * the shared record lives, and anything drained is already there. The cursor in
 * particular is per-machine: committing it would mean two checkouts disagreeing
 * about how much of a shared file had been sent, and resolving that conflict by
 * hand would either re-send records or drop them.
 *
 * So `.superdev/journal/` belongs in a workspace's .gitignore. Nothing here
 * enforces that — it is the user's repository — but the skills say so and this
 * repository's own .gitignore does it.
 *
 * WHY THE CURSOR IS A SEPARATE FILE AND NOT A REWRITE
 *
 * Marking a record drained by editing the line would mean rewriting a file that
 * other processes are appending to. Instead the journal is never modified after
 * a line is written, and `<stream>.cursor` records how many records have been
 * confirmed landed. Re-draining from a stale cursor is harmless: the backlog
 * is idempotent on `client_id`, so a replay reports duplicates and writes
 * nothing.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * The streams that may be journalled.
 *
 * Keyed by OPERATION rather than by tenant, which is the distinction the design
 * turns on. `work-progress` is delivery's append-only half: a note asserts
 * nothing, two agents appending never conflict, and 029's policy has never
 * required a lease to write one. Claiming and finishing are delivery's
 * contended half and have no stream here, deliberately — there is nowhere to
 * put them, which is the point.
 */
export type JournalStream = "correspondence" | "decision" | "work-progress";

/** @deprecated The old name, kept so a caller mid-rename still compiles. */
export type JournalTenant = JournalStream;

export interface JournalRecord {
  /** Minted here, before the record can ever reach a network. The idempotency key. */
  readonly client_id: string;
  /**
   * Which product this belongs to, for the streams whose drain endpoint is per
   * product. Empty for `work-progress`, which names its work item in the
   * payload and is scoped by the policy rather than by the path.
   */
  readonly product_key: string;
  /**
   * WHICH AGENT WROTE THIS, when it was not the process itself.
   *
   * Several subagents share one MCP server and therefore one process identity.
   * The backlog FORCES a note's author from the connection's declared agent
   * id, so a record drained under the process identity would be attributed to
   * the wrong agent — and attribution is the one thing correspondence and notes
   * are for. Carried here and replayed on the drain request so a note written
   * offline by `eng-alpha` still lands as `eng-alpha`.
   */
  readonly as_agent?: string;
  /** When it was appended, which is when the agent actually said it. */
  readonly journalled_at: string;
  /** The stream's own payload, sent to the API verbatim. */
  readonly payload: Record<string, unknown>;
}

export interface JournalStatus {
  readonly stream: JournalStream;
  readonly total: number;
  readonly drained: number;
  readonly pending: number;
}

function journalDir(home: string): string {
  return join(home, ".superdev", "journal");
}

function journalPath(home: string, stream: JournalStream): string {
  return join(journalDir(home), `${stream}.ndjson`);
}

function cursorPath(home: string, stream: JournalStream): string {
  return join(journalDir(home), `${stream}.cursor`);
}

/**
 * Appends one record and returns it.
 *
 * The `client_id` is minted here rather than accepted from the caller, for the
 * same reason the sender is forced in the database: an id supplied by whatever
 * is calling can be supplied twice, and the whole idempotency story rests on it
 * being unique to one logical record.
 */
export async function append(
  home: string,
  stream: JournalStream,
  productKey: string,
  payload: Record<string, unknown>,
  asAgent?: string,
): Promise<JournalRecord> {
  const record: JournalRecord = {
    client_id: randomUUID(),
    product_key: productKey,
    journalled_at: new Date().toISOString(),
    ...(asAgent === undefined ? {} : { as_agent: asAgent }),
    payload,
  };
  const path = journalPath(home, stream);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

/** Every record in the journal, in the order it was written. */
export async function readAll(home: string, stream: JournalStream): Promise<JournalRecord[]> {
  const path = journalPath(home, stream);
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf8");
  const records: JournalRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      records.push(JSON.parse(trimmed) as JournalRecord);
    } catch {
      // A truncated final line is what a process killed mid-append leaves, and
      // it is the one corruption this format can produce. Skipping it loses one
      // record; refusing to read the file would strand every record before it.
      continue;
    }
  }
  return records;
}

export async function readCursor(home: string, stream: JournalStream): Promise<number> {
  const path = cursorPath(home, stream);
  if (!existsSync(path)) return 0;
  const value = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export async function writeCursor(
  home: string,
  stream: JournalStream,
  position: number,
): Promise<void> {
  const path = cursorPath(home, stream);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${position}\n`, "utf8");
}

/** What is waiting, and how far the cursor has got. */
export async function status(home: string, stream: JournalStream): Promise<JournalStatus> {
  const [records, cursor] = await Promise.all([readAll(home, stream), readCursor(home, stream)]);
  // Clamped rather than trusted: a cursor past the end means the journal was
  // truncated or replaced under it, and treating that as "everything is
  // drained" would silently discard whatever is actually there.
  const drained = Math.min(cursor, records.length);
  return {
    stream,
    total: records.length,
    drained,
    pending: records.length - drained,
  };
}

