/**
 * 040. What repository this checkout is, and where its product binding lives.
 *
 * WHY THE REMOTE IS READ HERE RATHER THAN ASKED FOR
 *
 * Because the whole value of recording it is that two machines working one
 * repository agree without anybody coordinating. A remote the caller types is a
 * remote the caller can get wrong — and getting it wrong does not fail, it
 * quietly makes a second product, which is the exact outcome 040 exists to
 * prevent. The checkout already knows the answer; asking a model to restate it
 * only adds a way for the answer to change.
 *
 * WHAT IT IS NOT
 *
 * Not a security boundary, and 040's header says so at length: the string
 * travels to the catalogue from this process, and anything on this machine could
 * send a different one. It is a coordination key between cooperating machines.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The `origin` remote, or undefined.
 *
 * Undefined is a perfectly ordinary answer — a local-only repository, a fresh
 * `git init`, a worktree checked out by SHA — and it must not be an error: 040's
 * partial index leaves products with no repository alone rather than collapsing
 * them into one, so a checkout with no remote still gets a product. It simply
 * gets no protection from duplication, which is the honest trade.
 */
export function originRemote(cwd: string): string | undefined {
  try {
    const out = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    const trimmed = out.trim();
    return trimmed === "" ? undefined : trimmed;
  } catch {
    // No git, no repository, or no origin. All three mean the same thing here.
    return undefined;
  }
}

/**
 * Writes the binding that every other part of this plugin reads.
 *
 * Mode 0644 and not 0600, deliberately, and the opposite of every other file
 * this plugin writes: it holds no credential, it is meant to be COMMITTED, and
 * .gitignore says so in as many words. A binding readable only by the person who
 * ran init is a binding their colleague's checkout does not have.
 */
export function writeProductBinding(
  productPath: string,
  productKey: string,
  repo: string | undefined,
): void {
  mkdirSync(dirname(productPath), { recursive: true });
  const body = {
    product_key: productKey,
    ...(repo ? { repo } : {}),
  };
  writeFileSync(productPath, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o644 });
}
