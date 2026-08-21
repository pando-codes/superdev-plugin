/**
 * The role surface: what each role is offered, and what it is never offered.
 *
 * WHY THE NEGATIVES ARE THE POINT
 *
 * A positive assertion here ("the planner can author capabilities") would keep
 * passing if the filter were deleted outright, because deleting it offers every
 * tool to everyone. Every claim this file makes about least privilege is
 * therefore written as an ABSENCE, and the one absence that matters most is
 * asserted on its own: the agent that builds against a criterion is never shown
 * a way to revise that criterion.
 *
 * None of this is the security boundary — Postgres is, and roles.ts says so at
 * length. These assertions are about what an agent SEES, which is what decides
 * whether it wastes a turn on a refusal or goes looking for a way around one.
 */

import { describe, expect, test } from "bun:test";
import { ROLES } from "../src/config.ts";
import { resolveSurface, toolsForRole } from "../src/roles.ts";
import { allTools } from "../src/tools/index.ts";

const ALL = new Set(allTools.map((t) => t.name));

describe("every role", () => {
  test("is offered only tools that exist", () => {
    for (const role of ROLES) {
      for (const name of toolsForRole(role)) {
        expect([role, name, ALL.has(name)]).toEqual([role, name, true]);
      }
    }
  });

  test("can read the whole catalogue — reading is not an assertion", () => {
    for (const role of ROLES) {
      const tools = toolsForRole(role);
      for (const name of ["catalog_get_feature", "catalog_get_acceptance_criterion",
                          "catalog_coverage", "catalog_list_work", "catalog_get_work"]) {
        expect([role, name, tools.has(name)]).toEqual([role, name, true]);
      }
    }
  });

  test("can take, hold, report on, and finish work addressed to it", () => {
    for (const role of ROLES) {
      const tools = toolsForRole(role);
      for (const name of ["catalog_claim_work", "catalog_heartbeat_work",
                          "catalog_push_progress", "catalog_finish_work"]) {
        expect([role, name, tools.has(name)]).toEqual([role, name, true]);
      }
    }
  });

  test("is offered strictly less than everything, except the planner", () => {
    for (const role of ROLES) {
      if (role === "product-manager") continue;
      expect([role, toolsForRole(role).size < ALL.size]).toEqual([role, true]);
    }
  });
});

describe("the engineer holds the narrowest surface that can still build", () => {
  const tools = toolsForRole("engineer");

  test("it cannot see a way to revise the criteria it will be judged against", () => {
    expect(tools.has("catalog_update_acceptance_criterion")).toBe(false);
    expect(tools.has("catalog_create_acceptance_criterion")).toBe(false);
  });

  test("nor to author any part of the model", () => {
    for (const name of [
      "catalog_create_capability",
      "catalog_update_capability",
      "catalog_create_feature",
      "catalog_update_feature",
      "catalog_create_story",
      "catalog_update_story",
      "catalog_create_product",
      "catalog_link",
      "catalog_unlink",
    ]) {
      expect([name, tools.has(name)]).toEqual([name, false]);
    }
  });

  test("nor to record the verdict on its own work", () => {
    expect(tools.has("catalog_record_evaluation")).toBe(false);
  });

  test("nor to file its own work — a self-filed backlog is a to-do list", () => {
    expect(tools.has("catalog_file_work")).toBe(false);
    expect(tools.has("catalog_steward_work")).toBe(false);
  });
});

describe("quality-assurance renders verdicts and changes nothing it judges", () => {
  const tools = toolsForRole("quality-assurance");

  test("it records evaluations", () => {
    expect(tools.has("catalog_record_evaluation")).toBe(true);
  });

  test("but cannot rewrite a criterion that turned out to be unobservable", () => {
    // Deliberate: an unobservable criterion goes back to the planner, because
    // rewriting it is a change to what the product promises, not a test fix.
    expect(tools.has("catalog_update_acceptance_criterion")).toBe(false);
  });
});

describe("a declared role narrows and never widens", () => {
  test("an engineer key asking to be the planner is still an engineer", () => {
    const { names } = resolveSurface("engineer", "product-manager");
    expect(names.has("catalog_create_capability")).toBe(false);
    expect(names).toEqual(toolsForRole("engineer"));
  });

  test("a planner key asking to be an engineer is given the engineer's menu", () => {
    // The useful direction: run a broad key deliberately narrowed for a task,
    // so a build agent cannot reach for authoring tools it should not use.
    const { names, basis } = resolveSurface("product-manager", "engineer");
    expect(names.has("catalog_create_capability")).toBe(false);
    expect(names.has("catalog_claim_work")).toBe(true);
    expect(basis).toContain("narrowed");
  });

  test("with no declaration, the key's own role decides", () => {
    const { names } = resolveSurface("quality-assurance", undefined);
    expect(names).toEqual(toolsForRole("quality-assurance"));
  });
});

describe("when the catalogue cannot be reached", () => {
  test("everything is offered, because the database is still the boundary", () => {
    const { names, basis } = resolveSurface(undefined, undefined);
    expect(names.size).toBe(ALL.size);
    expect(basis).toContain("unavailable");
  });

  test("but a declared role still narrows, since that was asked for locally", () => {
    const { names } = resolveSurface(undefined, "engineer");
    expect(names).toEqual(toolsForRole("engineer"));
  });

  test("a role this build has never heard of does not empty the session", () => {
    // Forward compatibility: the catalogue may grow a seventh role before this
    // plugin knows about it, and a client that responded by offering no tools
    // would be broken by an additive change on the other side.
    const { names } = resolveSurface("archivist", undefined);
    expect(names.size).toBe(ALL.size);
  });
});
