/**
 * Where this machine's local state lives.
 *
 * The journal is workspace state, not user state: what an engineer said about
 * one repository's work belongs with that repository, in the same place
 * `.superdev/config.json` already sits at project scope. A single journal in
 * `~` would interleave every product an operator works on into one file and
 * make "what is waiting for this project" unanswerable.
 *
 * WHY THIS IS READ AT CALL TIME AND NOT CAPTURED AT STARTUP
 *
 * So a test can point it somewhere temporary without standing up a server, and
 * so the answer follows the host if it ever changes the variable mid-session.
 * The cost is a `process.env` read per call, which is nothing next to the write
 * it precedes.
 */

/**
 * The directory `.superdev/journal/` is created under.
 *
 * `CLAUDE_PROJECT_DIR` when the host sets it — which it does, via plugin.json's
 * env block — and otherwise the working directory the server was launched from.
 * The same resolution config.ts uses for project-scope configuration, and
 * deliberately so: an operator debugging one should not have to learn a second
 * rule to find the other.
 */
export function workspaceRoot(): string {
  const declared = process.env.CLAUDE_PROJECT_DIR;
  return declared !== undefined && declared.trim() !== "" ? declared : process.cwd();
}
