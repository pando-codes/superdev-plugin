import { ROLES, type Role } from "./config.ts";
import { allTools } from "./tools/index.ts";

/**
 * Which tools each role is given, and why the surface is narrowed at all.
 *
 * WHAT THIS IS NOT
 *
 * It is not the security boundary. Authority is decided by Postgres — one
 * pando_role per key, checked by RLS on the row — and nothing here can grant
 * anything the database would refuse. A modified copy of this file would change
 * which tools an agent can SEE and change nothing about what it can DO.
 *
 * WHAT IT IS FOR
 *
 * "Do not give an agent more access than its role needs" has a second half that
 * the database cannot cover: an agent that is SHOWN a tool it may not use will
 * eventually call it. It costs a turn, it produces a refusal that reads like a
 * fault, and — the part that actually matters — it invites the agent to go
 * looking for a way around a boundary that was deliberate. An engineer that
 * never sees `catalog_update_acceptance_criterion` does not spend a turn
 * discovering it may not revise the criteria it is judged against.
 *
 * It also shrinks the menu. Tool descriptions are context an agent pays for on
 * every single turn, and an engineer carrying the planner's authoring guidance
 * is paying for advice it cannot act on.
 *
 * WHY EVERY ROLE HOLDS THE WORK-ITEM TOOLS
 *
 * Work is addressed to a role, and every role can be addressed. The engineer
 * builds, quality-assurance verifies, the planner refines — all of them claim,
 * heartbeat, report, and finish. What differs is what they may write BESIDES
 * the item they hold, which is the whole of the table below.
 */

/** Reads are open to every provisioned role: reading is not an assertion (012). */
const READS = [
  "catalog_whoami",
  "catalog_list_products",
  "catalog_list_capabilities",
  "catalog_get_capability",
  "catalog_list_features",
  "catalog_get_feature",
  "catalog_get_story",
  "catalog_get_acceptance_criterion",
  "catalog_model_health",
  "catalog_coverage",
  "catalog_public_catalog",
  "catalog_list_work",
  "catalog_get_work",
] as const;

/** Holding and reporting on work. Any role can be addressed work. */
const HOLD_WORK = [
  "catalog_claim_work",
  "catalog_heartbeat_work",
  "catalog_push_progress",
  "catalog_finish_work",
] as const;

/** Filing and ordering the backlog. Deliberately not the doer's. */
const STEWARD_WORK = ["catalog_file_work", "catalog_steward_work"] as const;

const AUTHOR_MODEL = [
  "catalog_create_capability",
  "catalog_update_capability",
  "catalog_create_feature",
  "catalog_update_feature",
  "catalog_create_story",
  "catalog_update_story",
  "catalog_create_acceptance_criterion",
  "catalog_update_acceptance_criterion",
  "catalog_link",
  "catalog_unlink",
] as const;

const WRITES_BY_ROLE: Record<Role, readonly string[]> = {
  // Authors the model and owns the backlog. The broadest role there is, which
  // is why the builder is deliberately not it.
  "product-manager": [...AUTHOR_MODEL, ...STEWARD_WORK, ...HOLD_WORK, "catalog_create_product"],

  // Sets direction and orders the queue; does not author the model.
  "head-of-engineering": [...STEWARD_WORK, ...HOLD_WORK, "catalog_create_product"],

  // Builds. Its entire write authority is the work item it currently holds —
  // it cannot author a capability, feature, story, or criterion, and it cannot
  // record the verdict on its own work.
  engineer: [...HOLD_WORK],

  // Renders verdicts. Can take verification work; cannot change what it is
  // verifying against, which is the point.
  "quality-assurance": [...HOLD_WORK, "catalog_record_evaluation"],

  // A pipeline. Records what a run observed, in both shapes.
  ci: [...HOLD_WORK, "catalog_record_evaluation", "catalog_record_evidence"],

  // Reports the business signals capability weight is derived from.
  revops: [...HOLD_WORK, "catalog_record_evidence"],
};

const ALL_TOOL_NAMES = new Set(allTools.map((t) => t.name));

/** Every tool a role may successfully call. */
export function toolsForRole(role: Role): Set<string> {
  const names = new Set<string>([...READS, ...WRITES_BY_ROLE[role]]);
  // A name that no longer exists would silently shrink a role's surface, and a
  // role missing one tool is far harder to notice than one missing all of them.
  for (const name of names) {
    if (!ALL_TOOL_NAMES.has(name)) {
      throw new Error(`roles.ts lists "${name}" for ${role}, but no such tool is registered`);
    }
  }
  return names;
}

/**
 * The surface for a session, given what the key turned out to carry and what
 * the operator asked for.
 *
 * The intersection is the important line. A declared role can only ever NARROW:
 * an operator who runs a planner key as `SUPERDEV_ROLE=engineer` gets the
 * engineer's menu, and one who runs an engineer key as
 * `SUPERDEV_ROLE=product-manager` also gets the engineer's menu, because the key
 * is what the database will actually honour. Widening by configuration would
 * make this file a way to ask for authority, which is exactly what it must not
 * be.
 */
export function resolveSurface(
  actualRole: string | undefined,
  declaredRole: Role | undefined,
): { names: Set<string>; basis: string } {
  if (actualRole === undefined || !(ROLES as readonly string[]).includes(actualRole)) {
    // Unknown role — whoami was unreachable, or the catalogue grew a role this
    // build has never heard of. Show everything and let the database refuse.
    //
    // Fail-OPEN, deliberately, and only here. This filter is an ergonomic
    // narrowing over a boundary the database already enforces, so the cost of
    // being wrong is a refusal an agent can read. Failing closed would instead
    // strand a session with no tools because a network call timed out, which is
    // a far worse outcome for a boundary that was never this file's to hold.
    const names = new Set(ALL_TOOL_NAMES);
    if (declaredRole !== undefined) {
      const narrowed = toolsForRole(declaredRole);
      return {
        names: new Set([...names].filter((n) => narrowed.has(n))),
        basis: `declared role "${declaredRole}" (the catalogue's answer was unavailable)`,
      };
    }
    return { names, basis: "every tool (the catalogue's answer was unavailable)" };
  }

  const actual = toolsForRole(actualRole as Role);
  if (declaredRole === undefined || declaredRole === actualRole) {
    return { names: actual, basis: `role "${actualRole}"` };
  }
  const declared = toolsForRole(declaredRole);
  return {
    names: new Set([...actual].filter((n) => declared.has(n))),
    basis: `role "${actualRole}", narrowed to what "${declaredRole}" needs`,
  };
}
