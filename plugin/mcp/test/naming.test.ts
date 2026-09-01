/**
 * The rename's guard: the plugin's TypeScript source and its schemas may not
 * say "catalog".
 *
 * WHY THIS TEST EXISTS
 *
 * A rename of 1,694 occurrences cannot be reviewed by reading it. What can be
 * checked is the invariant it leaves behind — that the scanned files say one
 * word — and that is a property a test can hold forever, long after the
 * rename that motivated it is forgotten.
 *
 * WHAT IS SCANNED
 *
 * Every `.ts` file under `mcp/src`, and every `.json` schema under
 * `apps/plugin/schemas`. The schemas are included because they compile into
 * the committed bundle exactly as the source does — a stale `$id` in one of
 * them is exactly as much a defect as a stale identifier in a `.ts` file,
 * and the omission of the schemas from this scan is what let one through
 * once already. Nothing outside these two locations is scanned: this test
 * is a guard on the plugin's compiled surface, not a claim about the rest of
 * the repository.
 *
 * WHAT THE FENCE IS
 *
 * A handful of tokens keep the old name, in three categories. Most of them
 * because moving them breaks something outside this repository: the key
 * prefix is inside the hash of every live credential, the deprecated
 * environment aliases are sitting in shell profiles, and the Fly host is in
 * every issued key's api_url. One, the project's former name, is fenced for
 * a different reason — it is simply true history, and CLAUDE.md's naming
 * table keeps it on purpose. The last is neither: `/v1/products/` marks a
 * path already served under `/v1`, and releasing.md's contract makes any
 * such path permanent for the life of `v1` — renaming it 404s every
 * installed plugin the instant this backend deploys, with no version for a
 * frozen bundle to pin against and no way for it to find out. A line
 * containing one of the tokens below is allowed to say "catalog"; every
 * other line is not.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * WHAT THIS GUARDS NOW
 *
 * The plugin has no TypeScript left — the server moved to apps/backend when the
 * transport went remote — so the two directories this originally scanned are
 * gone. What remains here is the surface an installed plugin actually presents:
 * the manifest that names four servers, the three agents that address them, and
 * the skills and reference that tell a reader what to call. Those are the files
 * a rename would break in a way nothing compiles, and they are precisely the
 * ones a compiler was never going to catch.
 */
const PLUGIN = join(import.meta.dir, "..", "..");
const SURFACE = [".claude-plugin", "agents", "skills", "reference"].map((d) =>
  join(PLUGIN, d),
);

const FENCE = [
  "PANDO_CATALOG_API_URL",
  "PANDO_CATALOG_API_KEY",
  "PANDO_CATALOG_GRANT",
  "pando-catalog-api.fly.dev",
  "pcat_",
  // The project's former name, kept because CLAUDE.md keeps it. Fenced for a
  // different reason than the two above it: those are inside live credentials
  // and issued keys, this is simply true history.
  "pando-catalog",
  // A frozen v1 route path, not a credential or history: releasing.md's
  // contract makes any path already served under /v1 permanent for the life
  // of v1, so a line naming one is allowed to say "catalog" and must not be
  // swept by the next rename.
  "/v1/products/",
  // An identifier this repository does not own. CLAUDE.md draws the line
  // explicitly — `pg_catalog` is Postgres's, `catalog-access` is agent-suite's,
  // and renaming an address does not rename the thing it addresses. This one is
  // a class in a testing example that has nothing to do with the backlog, and a
  // sweep that "fixed" it would be corrupting somebody else's name.
  "ToolCatalog",
];

function filesMatching(dir: string, extension: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return filesMatching(full, extension);
    return full.endsWith(extension) ? [full] : [];
  });
}

function scan(root: string, files: string[]) {
  for (const file of files) {
    test(file.slice(root.length + 1), () => {
      const offending = readFileSync(file, "utf8")
        .split("\n")
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => /catalog(ue)?/i.test(line))
        .filter(({ line }) => !FENCE.some((allowed) => line.includes(allowed)));

      expect(offending.map(({ number, line }) => `${number}: ${line.trim()}`)).toEqual([]);
    });
  }
}

describe("nothing the manifest declares says catalog", () => {
  for (const dir of SURFACE) scan(PLUGIN, filesMatching(dir, ".json"));
});

describe("nothing the plugin ships as prose says catalog", () => {
  for (const dir of SURFACE) scan(PLUGIN, filesMatching(dir, ".md"));
});
