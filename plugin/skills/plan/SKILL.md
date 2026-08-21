---
name: plan
description: You must use this when progressing from an idea to technical requirements.  Collects desired user experience and translated it into testable Acceptance Criteria before touching any code.
---

# Planning Work

Use this skill for planning out how an idea gets implemented within a product and creates the artifacts that code will be based off of.

**Announce at start:** "I'm using the Plan skill to build this solution."

## Grounding Process

1. Understand the context
- Clearly state the user's refined idea from the conversation history
- Read from the catalog following `${CLAUDE_PLUGIN_ROOT}/reference/datastore.md`, scoping every query to this repository's product — the binding in `.superdev/product.json` says which one, and a shared catalog will happily hand you another product's Capabilities if you don't
- Pull relevant Capabilities for the idea into context
- Pull relevant User Stories for the idea into context.  If there are more than 10 User Stories, filter them by semantic relevance to the idea until you have 10 User Stories

## Planning Process

1. Design the Feature(s)

- Determine *what* should be implemented based on your gathered context. Leverage `${CLAUDE_PLUGIN_ROOT}/reference/feature.md` to build one-or-more Features that reflect the cost-benefit of implementing the idea.
- When uncertain, make more Features than necessary so that can we scope down or consolidate them later

2. Review the Feature(s)

- Compare the newly made Feature(s) with existing Features to determine if there are any overlaps, redundancies, or duplicates
- Get User validation on the Features that were created

3. Assess Capabilities

- Perform a capability assessment of the idea by reviewing existing capabilities
- Aim to identify the capabilities that are most relevant to the idea. Use `${CLAUDE_PLUGIN_ROOT}/reference/capability.md` for reference on Capabilities.
- **If the idea genuinely fits no existing Capability, create one** — with the user's approval, and always as `proposed` with a `vbo` of 0.  A proposed Capability is excluded from the product's 100% sum, which is exactly what lets you add one here without forcing every other Capability to be rescored mid-planning.
- A new Capability needs a `name`, a `description` (what it is, in the customer's terms), and a `scope_boundary` (what it covers and what it explicitly does not).  **`description` and `scope_boundary` are both required by the store** — an insert without them is rejected.  The boundary is the one worth thinking about: it is what stops the new Capability from quietly overlapping the ones already there
- **Do not set or adjust any `vbo`, and do not promote a Capability to `active`.**  Scoring is a decision about the whole product, not about the idea in front of you — it belongs to superdev:recalibrate, which rebalances the full set at once.  Leave the new Capability `proposed` and say so in your report.
- Prefer redrawing an existing Capability's scope over adding a new one, and note that revising an existing Capability's `description` or `scope_boundary` is also recalibrate's call, not this step's.
- **If there are no Capabilities at all**, the catalog was never initialized — stop and use superdev:init rather than inventing a first Capability here.  Seeding the catalog is a decision the user makes deliberately, not a side effect of planning one idea.
- Capture relationship edges between the Feature(s) and the Capability (or Capabilities).  Each edge may carry a `cost_score` and a `value_score` — how costly and how valuable this Feature is *to that particular Capability*.  Leave them unset rather than guessing; an unscored edge is honest, a zero claims the Feature contributes nothing
- Note which of the Capability's KPIs the Feature is expected to move.  **Do not touch `vbo`** — that is superdev:recalibrate's, for the reasons above

4. Define *How*

- We want to describe specifically how the user accomplishes the Feature within our product
- Use the `${CLAUDE_PLUGIN_ROOT}/reference/acceptance-criteria.md` to make as many Acceptance Criteria's as are needed to capture the user experience; this is likely the majority of the work of the entire planning process
- **Do not create Clauses.**  The Clause index is documented in `${CLAUDE_PLUGIN_ROOT}/reference/clause.md` but is deliberately not implemented, so there is nowhere to put one.  Write each criterion as prose in `given`/`when_`/`then_`, keeping it atomic — one precondition set, one action sequence, one observable outcome — which is what keeps it migratable if the index is ever built
- Evaluate if any Acceptance Criteria are duplicative of existing Acceptance Criteria, and consolidate towards the existing Acceptance Criteria as needed
- Associate each Acceptance Criteria to their relevant Feature(s)

## Wrapping Up

- Write the validated Features and Acceptance Criteria to the catalog, following `${CLAUDE_PLUGIN_ROOT}/reference/datastore.md`, along with their edges to the Capabilities you identified
- Any Capability created during this session is written as `proposed` with `vbo` 0.  Report it as pending scoring, and tell the user that superdev:recalibrate is what promotes it to `active` and rebalances the product
- Ask: "Ready to begin executing the plan?"
- Upon confirmation, create a brief directive and list all of the Features, User Stories, and Acceptance Criteria and share it to the superdev:execute skill

## Pitfalls to Avoid

**STOP and ask rather than guessing when:**
- The idea doesn't map onto any existing Capability and you can't tell whether it needs a new one
- A Feature you're drafting overlaps an existing Feature and the right call is consolidation vs. addition
- An Acceptance Criterion can't be stated observably — you can't name what a reader would look at to judge pass or fail
- You're about to write a record whose shape the catalog can't store

**Never invent a Capability to make a Feature fit.** Raise it instead — a missing Capability is a real
finding, and burying it inside a Feature hides it.

## Key Principles

- **Criteria are the work** - Features are cheap to name; the Acceptance Criteria are where planning actually happens
- **Observable or it doesn't count** - every criterion states something a reader can check, not an intention
- **Reuse before you create** - search existing Stories, Features, and Capabilities first; a near-duplicate is worse than a reference
- **Over-generate Features, then consolidate** - splitting is easier than discovering a Feature did two things
- **Stop when blocked, don't guess** - an unresolved ambiguity written down as fact costs more than the question