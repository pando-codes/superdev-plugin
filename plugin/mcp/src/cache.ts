/**
 * The last answer the catalogue gave, kept so a read still works offline.
 *
 * WHY READS ARE CACHED AND WRITES ARE JOURNALLED
 *
 * They are the two halves of the same rule and they are not symmetrical. A
 * write that cannot reach the catalogue is a fact the catalogue does not have
 * yet, so it waits in the journal and is sent later. A read that cannot reach
 * the catalogue is a question with a slightly old answer already on disk, so it
 * is answered from there and SAID TO BE OLD.
 *
 * The design's reasoning for allowing the stale answer at all: the criterion an
 * agent is building against is the thing in this system that changes least, and
 * an agent that cannot read its own brief cannot work at all. A brief that is
 * an hour out of date is very nearly always the same brief.
 *
 * WHY ONLY A DROPPED CONNECTION FALLS BACK
 *
 * A 403 is an ANSWER. So is a 404, and so is a 401. Serving a cached success in
 * place of any of them would tell an agent it may read something the catalogue
 * has just said it may not — the exact inversion of the boundary the tenant gate
 * and RLS exist to hold. Only a request that never got an answer falls back,
 * which is why the client distinguishes a thrown `ApiError` from a thrown
 * anything-else before it looks here.
 *
 * WHY THE STALENESS IS IN THE BODY AND NOT ONLY IN A LOG
 *
 * Because the reader is a model, and a model that is not told an answer is old
 * will treat it as current. `stale_as_of` is merged into the returned object so
 * it is impossible to read the answer without also reading when it was true.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface CacheEntry {
  readonly path: string;
  readonly fetched_at: string;
  readonly body: unknown;
}

function cacheDir(home: string): string {
  return join(home, ".superdev", "cache");
}

/**
 * Hashed rather than sanitised.
 *
 * A path carries user data — product keys, criterion keys, arbitrary query
 * strings — and turning that into a filename by escaping is a long tail of
 * platform-specific traps: length limits, reserved names, case-insensitive
 * collisions. A hash has none of them, and the full path is stored inside the
 * file so the cache is still legible to anyone reading it.
 */
function entryPath(home: string, path: string): string {
  const digest = createHash("sha256").update(path).digest("hex").slice(0, 32);
  return join(cacheDir(home), `${digest}.json`);
}

/** Records a successful answer. Failure to write is never allowed to fail the read. */
export async function remember(home: string, path: string, body: unknown): Promise<void> {
  try {
    const file = entryPath(home, path);
    await mkdir(cacheDir(home), { recursive: true });
    const entry: CacheEntry = { path, fetched_at: new Date().toISOString(), body };
    await writeFile(file, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // A read-only filesystem, a full disk, a sandbox. None of these is a reason
    // to fail a request that already succeeded.
  }
}

/**
 * The last good answer for this path, with `stale_as_of` merged in.
 *
 * Returns undefined when nothing was ever cached, which the caller must treat
 * as "the read failed" rather than as an empty result — an agent told a product
 * has no capabilities when the truth is that nobody could ask is worse off than
 * one told the catalogue is unreachable.
 */
export async function recall(home: string, path: string): Promise<unknown | undefined> {
  try {
    const file = entryPath(home, path);
    if (!existsSync(file)) return undefined;
    const entry = JSON.parse(await readFile(file, "utf8")) as CacheEntry;
    if (entry.path !== path) return undefined; // digest collision, or a corrupted file
    if (entry.body !== null && typeof entry.body === "object" && !Array.isArray(entry.body)) {
      return { ...(entry.body as Record<string, unknown>), stale_as_of: entry.fetched_at };
    }
    // A non-object answer cannot carry the marker inline, so it is wrapped.
    return { stale_as_of: entry.fetched_at, body: entry.body };
  } catch {
    return undefined;
  }
}
