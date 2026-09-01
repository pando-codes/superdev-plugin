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
 * never sees `backlog_update_acceptance_criterion` does not spend a turn
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

/**
 * Tools every server offers, whatever it holds and whether it holds anything.
 *
 * Separate from READS because these are not backlog reads — they ask nothing
 * of the database and are not narrowed by anything it decides. A diagnostic
 * that disappeared from the menu when a role narrowed, or when a credential was
 * missing, would be absent from every session that needed it.
 */
const ALWAYS = ["backlog_doctor"] as const;

/** Reads are open to every provisioned role: reading is not an assertion (012). */
const READS = [
  "backlog_whoami",
  "backlog_list_products",
  "backlog_list_capabilities",
  "backlog_get_capability",
  "backlog_list_features",
  "backlog_get_feature",
  "backlog_get_story",
  "backlog_get_acceptance_criterion",
  "backlog_model_health",
  "backlog_coverage",
  "backlog_public_view",
  "backlog_list_work",
  "backlog_get_work",
] as const;

/** Holding and reporting on work. Any role can be addressed work. */
const HOLD_WORK = [
  "backlog_claim_work",
  "backlog_heartbeat_work",
  "backlog_push_progress",
  "backlog_finish_work",
] as const;

/**
 * The tools each non-delivery tenant contributes, and who gets them.
 *
 * 043 makes tenant enablement a property of the CREDENTIAL, enforced by policy.
 * What happens here is the same kind of narrowing this file already does for
 * roles: a courtesy that keeps an agent from spending a turn on a tool that
 * would be refused. It is not the boundary, and a modified copy of this file
 * changes what an agent SEES and nothing about what it can DO.
 *
 * Correspondence goes to every role, because 041 lets any role in scope send
 * and the useful messages are usually cross-role. Decisions split: everyone
 * reads them, because a ruling binds the agents who did not make it, and only a
 * Head records one.
 */
const TENANT_TOOLS: Record<string, readonly string[]> = {
  correspondence: ["backlog_send_message", "backlog_read_messages"],
  decision: ["backlog_read_decisions"],
};

/** Recording a ruling, which 042's policy allows to a Head alone. */
const RULE = ["backlog_record_decision"] as const;

/**
 * Local journal tools. Not gated by any single tenant, because they are about
 * the FILE rather than about either tenant's rows — but pointless when neither
 * tenant is enabled, so they appear only when at least one is.
 */
const JOURNAL = ["backlog_drain_journal", "backlog_journal_status"] as const;

/** Filing and ordering the backlog. Deliberately not the doer's. */
const STEWARD_WORK = ["backlog_file_work", "backlog_steward_work"] as const;

const AUTHOR_MODEL = [
  "backlog_create_capability",
  "backlog_update_capability",
  "backlog_create_feature",
  "backlog_update_feature",
  "backlog_create_story",
  "backlog_update_story",
  "backlog_create_acceptance_criterion",
  "backlog_update_acceptance_criterion",
  "backlog_link",
  "backlog_unlink",
] as const;

const WRITES_BY_ROLE: Record<Role, readonly string[]> = {
  // Authors the model and owns the backlog. The broadest role there is, which
  // is why the builder is deliberately not it.
  "product-manager": [...AUTHOR_MODEL, ...STEWARD_WORK, ...HOLD_WORK, "backlog_create_product"],

  // Sets direction and orders the queue; does not author the model.
  "head-of-engineering": [...STEWARD_WORK, ...HOLD_WORK, "backlog_create_product"],

  // Builds. Its entire write authority is the work item it currently holds —
  // it cannot author a capability, feature, story, or criterion, and it cannot
  // record the verdict on its own work.
  engineer: [...HOLD_WORK],

  // Renders verdicts. Can take verification work; cannot change what it is
  // verifying against, which is the point.
  "quality-assurance": [...HOLD_WORK, "backlog_record_evaluation"],

  // A pipeline. Records what a run observed, in both shapes.
  ci: [...HOLD_WORK, "backlog_record_evaluation", "backlog_record_evidence"],

  // Reports the business signals capability weight is derived from.
  revops: [...HOLD_WORK, "backlog_record_evidence"],
};

const ALL_TOOL_NAMES = new Set(allTools.map((t) => t.name));

/** Every tenant tool a role could hold, before enablement narrows it. */
function tenantToolsForRole(role: Role): string[] {
  const names = [...TENANT_TOOLS.correspondence!, ...TENANT_TOOLS.decision!, ...JOURNAL];
  return role === "head-of-engineering" ? [...names, ...RULE] : names;
}

/** Every tool a role may successfully call, if every tenant were enabled. */
export function toolsForRole(role: Role): Set<string> {
  const names = new Set<string>([
    ...ALWAYS,
    ...READS,
    ...WRITES_BY_ROLE[role],
    ...tenantToolsForRole(role),
  ]);
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
/**
 * Removes the tools for tenants this credential does not carry.
 *
 * `undefined` means the backlog's answer was unavailable, and that fails
 * OPEN for the same reason an unknown role does: this narrowing sits over a
 * boundary the database already holds, so being wrong costs a refusal an agent
 * can read, while failing closed would strand a session because a network call
 * timed out.
 *
 * The database does the opposite and fails CLOSED — an undeclared
 * `pando.tenants` enables nothing. The two directions are correct together:
 * the menu guesses generously, the policy refuses precisely.
 */
function narrowToTenants(
  names: Set<string>,
  tenants: readonly string[] | undefined,
): { names: Set<string>; note: string | undefined } {
  if (tenants === undefined) return { names, note: undefined };

  const enabled = new Set(tenants);
  const gated = new Set<string>();
  for (const [tenant, tools] of Object.entries(TENANT_TOOLS)) {
    if (!enabled.has(tenant)) for (const tool of tools) gated.add(tool);
  }
  if (!enabled.has("decision")) for (const tool of RULE) gated.add(tool);
  // The journal tools serve both tenants, so they go only when BOTH are absent.
  if (!enabled.has("correspondence") && !enabled.has("decision")) {
    for (const tool of JOURNAL) gated.add(tool);
  }

  const kept = new Set([...names].filter((n) => !gated.has(n)));
  const missing = ["correspondence", "decision"].filter((t) => !enabled.has(t));
  return {
    names: kept,
    note: missing.length === 0 ? undefined : `without ${missing.join(" and ")}`,
  };
}

export function resolveSurface(
  actualRole: string | undefined,
  declaredRole: Role | undefined,
  tenants?: readonly string[],
): { names: Set<string>; basis: string } {
  if (actualRole === undefined || !(ROLES as readonly string[]).includes(actualRole)) {
    // Unknown role — whoami was unreachable, or the backlog grew a role this
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
      return withTenants(
        new Set([...names].filter((n) => narrowed.has(n))),
        `declared role "${declaredRole}" (the backlog's answer was unavailable)`,
        tenants,
      );
    }
    return withTenants(names, "every tool (the backlog's answer was unavailable)", tenants);
  }

  const actual = toolsForRole(actualRole as Role);
  if (declaredRole === undefined || declaredRole === actualRole) {
    return withTenants(actual, `role "${actualRole}"`, tenants);
  }
  const declared = toolsForRole(declaredRole);
  return withTenants(
    new Set([...actual].filter((n) => declared.has(n))),
    `role "${actualRole}", narrowed to what "${declaredRole}" needs`,
    tenants,
  );
}

/** Applies the tenant narrowing and folds it into the basis sentence. */
function withTenants(
  names: Set<string>,
  basis: string,
  tenants: readonly string[] | undefined,
): { names: Set<string>; basis: string } {
  const narrowed = narrowToTenants(names, tenants);
  return {
    names: narrowed.names,
    basis: narrowed.note === undefined ? basis : `${basis}, ${narrowed.note}`,
  };
}
