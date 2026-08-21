/**
 * The shipped agent definitions, checked against the role map they were cut from.
 *
 * WHY THIS TEST EXISTS
 *
 * Each agent's `tools:` list is a second, softer expression of the same least-
 * privilege decision roles.ts makes — and it is written in a markdown file that
 * nothing compiles, imports, or type-checks. A tool added to a role would be
 * invisible to that agent forever; a tool renamed would silently remove it. Both
 * failures present as an agent that "just doesn't use" a capability it was meant
 * to have, which is close to impossible to notice from the outside.
 *
 * WHAT WOULD MAKE THIS TEST WORTHLESS
 *
 * Asserting only that every tool an agent lists is a real tool. That would pass
 * for an agent listing one tool out of seventeen. So the comparison is an exact
 * set equality in both directions: nothing missing, nothing extra.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { toolsForRole } from "../src/roles.ts";
import type { Role } from "../src/config.ts";

const AGENTS_DIR = join(import.meta.dir, "..", "..", "agents");
const PREFIX = "mcp__plugin_superdev_pando-catalog__";

/** Which role each shipped agent is cut for. */
const AGENT_ROLES: Record<string, Role> = {
  "superdev-engineer": "engineer",
  "superdev-verifier": "quality-assurance",
  "superdev-planner": "product-manager",
};

interface Agent {
  readonly file: string;
  readonly name: string;
  readonly description: string;
  readonly tools: string[];
}

function parse(file: string): Agent {
  const text = readFileSync(join(AGENTS_DIR, file), "utf8");
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error(`${file} has no frontmatter`);
  const field = (key: string): string => {
    const m = new RegExp(`^${key}: (.*)$`, "m").exec(match[1]!);
    if (!m) throw new Error(`${file} has no ${key}`);
    return m[1]!.trim();
  };
  return {
    file,
    name: field("name"),
    description: field("description"),
    tools: field("tools").split(",").map((t) => t.trim()),
  };
}

const agents = readdirSync(AGENTS_DIR)
  .filter((f) => f.endsWith(".md"))
  .map(parse);

describe("the shipped agents", () => {
  test("are exactly the three roles that do superdev's work", () => {
    expect(agents.map((a) => a.name).sort()).toEqual(Object.keys(AGENT_ROLES).sort());
  });

  test("name themselves after their file", () => {
    for (const a of agents) expect(a.file).toBe(`${a.name}.md`);
  });

  test("say when to use them, which is the only reason they get selected", () => {
    for (const a of agents) {
      expect([a.name, a.description.length > 80]).toEqual([a.name, true]);
      expect([a.name, /\bUse when\b/.test(a.description)]).toEqual([a.name, true]);
    }
  });
});

describe("each agent is offered exactly its role's tools", () => {
  for (const agent of agents) {
    const role = AGENT_ROLES[agent.name]!;

    test(`${agent.name} matches the ${role} surface, in both directions`, () => {
      const listed = agent.tools
        .filter((t) => t.startsWith(PREFIX))
        .map((t) => t.slice(PREFIX.length))
        .sort();
      const expected = [...toolsForRole(role)].sort();
      expect(listed).toEqual(expected);
    });

    test(`${agent.name} still has the ordinary tools it needs to do the work`, () => {
      // An agent narrowed to catalog tools alone could claim work and then not
      // be able to do any of it.
      expect(agent.tools).toContain("Read");
      expect(agent.tools).toContain("Skill");
    });
  }
});

describe("the boundary each agent is built around", () => {
  test("the engineer cannot revise the criteria it is judged against", () => {
    const engineer = agents.find((a) => a.name === "superdev-engineer")!;
    for (const forbidden of [
      "catalog_update_acceptance_criterion",
      "catalog_create_acceptance_criterion",
      "catalog_record_evaluation",
      "catalog_file_work",
    ]) {
      expect([forbidden, engineer.tools.includes(PREFIX + forbidden)]).toEqual([forbidden, false]);
    }
  });

  test("the verifier cannot rewrite what it is verifying", () => {
    const verifier = agents.find((a) => a.name === "superdev-verifier")!;
    expect(verifier.tools).toContain(PREFIX + "catalog_record_evaluation");
    expect(verifier.tools).not.toContain(PREFIX + "catalog_update_acceptance_criterion");
  });

  test("only the planner can file work", () => {
    for (const agent of agents) {
      expect([agent.name, agent.tools.includes(PREFIX + "catalog_file_work")]).toEqual([
        agent.name,
        agent.name === "superdev-planner",
      ]);
    }
  });

  test("every agent can take and finish work, because every role is addressable", () => {
    for (const agent of agents) {
      expect(agent.tools).toContain(PREFIX + "catalog_claim_work");
      expect(agent.tools).toContain(PREFIX + "catalog_finish_work");
      expect(agent.tools).toContain(PREFIX + "catalog_heartbeat_work");
    }
  });
});
