---
name: recalibrate
description: Use to score and rescore Capabilities - promoting a proposed Capability to active, rebalancing VBO across the product, revising what a Capability covers, or deprecating one that no longer applies. This is the only skill that may set a vbo or change a Capability's status; plan may add proposed Capabilities but never scores them.
---

# Recalibrating Capabilities

A capability set is a claim about what the product offers, and each capability's **VBO** — its
Vital Business Offering — is a claim about how much of the product's value it carries.  The VBO
of every active capability in a product sums to **100**.

That sum is what makes this a distinct skill.  No capability's score can be changed in
isolation: raising one means lowering others, so every scoring decision is a decision about the
whole product at once.  A skill working on a single idea cannot make it correctly, which is why
superdev:plan may add capabilities but never scores them.

Products also move, so the claim itself goes stale — boundaries blur until two capabilities
both plausibly own the same feature, and some stop describing anything still true.  That
correction lives here too.

**What this skill owns:** every `vbo`, every `status` transition, and every revision to an
existing capability's `description` or `scope_boundary`.

**What it does not own:** creating capabilities from nothing.  superdev:init seeds the first
set; superdev:plan adds `proposed` ones at VBO 0 as ideas require them.  This skill is what
turns those into scored, active parts of the product.

**Announce at start:** "I'm using the Recalibrate skill to revise this product's capabilities."

## Precondition

The catalog must already be initialized.  If there is no product row, this is the wrong skill —
use superdev:init.  Read the catalog per `${CLAUDE_PLUGIN_ROOT}/reference/datastore.md`, scoped
to this repository's product, and state which product you resolved to.

## Step 1: Load the current state

You cannot judge drift from the capability rows alone.  Pull all of it:

- Every capability: `key`, `name`, `description`, `scope_boundary`, `status`, `vbo`
- Which features attach to each, via `capability_has_feature`
- The dependency edges in `capability_has_dependency`, with their `kind`
  (`requires` or `degrades_without`)
- Features attached to **no** capability

Where the backend has `v_model_health`, its `feature belongs to no capability` rows give you
the last item directly.  Where it doesn't, compute it — a left join from `feature` through
`capability_has_feature`.

**Then check the sum.**  Total the `vbo` of every `active` capability and state it.  If it is
not 100, the catalog is already in an invalid state — report that before proposing anything
else, because whatever you change has to land on a valid distribution, and starting from a
broken one just hides the original error.  `proposed` and `deprecated` capabilities are excluded
from this total.

## Step 2: Find the drift, on evidence

Do not eyeball the list and opine.  Each of these is a specific, checkable signal:

| Signal | What it usually means |
|---|---|
| A `proposed` capability with features attached | It's earning its place — a candidate for promotion and a score |
| A capability carrying far more delivered features than its VBO implies | The score understates it; the product moved and the number didn't |
| A high VBO on a capability nothing has been built for in a long time | The score is a historical claim, not a current one |
| Features attached to no capability | An offering exists that the set doesn't describe — likely a missing capability |
| A capability with no features, long after init | It was speculative, or it's been absorbed by another |
| Two `scope_boundary` values that both plausibly claim the same feature | The boundary needs redrawing, not a third capability |
| A `description` that describes something the product no longer does | Deprecation, or a rewrite |
| A capability whose features all serve a different capability's value prop | It's a Feature grouping wearing a Capability's clothes |

Delivered features are evidence about a score, never the score itself.  A capability can be
mature and stable — carrying real value with little recent work — and a burst of features can
mean something was hard rather than valuable.  Use the mismatch as a prompt to ask the user, not
as an arithmetic input.

State what you found and the evidence for each.  **Finding nothing is a valid, common
outcome** — say so and stop.  A capability set that still fits is not a problem to solve.

## Step 3: Propose the change set

Present every proposed change as an explicit diff, one of four kinds:

- **Promote** — a `proposed` capability becoming `active`, with the VBO it should carry and
  the rebalance that pays for it
- **Rescore** — a VBO moving, and the offsetting moves that keep the sum at 100
- **Revise** — the exact before and after of a `description` or `scope_boundary`, and why
- **Deprecate** — which capability, why, what happens to everything attached to it, and where
  its VBO goes

Nothing is written until the user approves.  Creating, updating, and deprecating capabilities
each require explicit approval — see `${CLAUDE_PLUGIN_ROOT}/reference/capability.md`.

### The rebalance

Any change touching a VBO is a change to **every** active capability's share, because they sum
to 100.  Present it as a full table — every active capability, its current score, its proposed
score, the delta — and show the new total.  Never present a single score in isolation; the
number is meaningless without what paid for it.

```
capability          now    →  proposed   Δ
cost-attribution     35    →     30     -5
session-capture      40    →     38     -2
team-analytics       25    →     25      0
alerting (promote)    0    →      7     +7
                    ---        ---
                    100        100
```

State explicitly which capabilities are being *lowered* and why that's acceptable.  A promotion
is a claim that a new offering matters more than something that already exists — the user should
approve the subtraction, not just the addition.

Prefer redrawing a boundary over adding a capability.  Most apparent gaps are a
`scope_boundary` that stopped being accurate, and adding a capability to cover one is how a set
of six becomes a set of twenty that nobody can use — and a twenty-way split of 100 makes every
score too small to mean anything.

## Step 4: Check the blast radius before deprecating

Deprecation is the only change here that can break something silently.  Before proposing one:

1. **Features attached to it.**  Every feature in `capability_has_feature` for that capability
   needs somewhere to go.  Name the destination capability for each, or say plainly that the
   feature is genuinely being retired.  A feature orphaned by deprecation shows up later as a
   `feature belongs to no capability` health row and nobody remembers why.
2. **Dependency edges pointing at it.**  Check `capability_has_dependency` for rows where
   `to_capability_id` is the capability being deprecated:
   - `requires` — the dependent capability is broken by this, not degraded.  Resolve it before
     proceeding, and say what the resolution is.
   - `degrades_without` — the dependent capability survives in weakened form.  State which
     capability degrades and how, so it's a recorded consequence rather than a surprise.

Report the blast radius even when it's empty.  "Nothing depends on this and it has no features"
is a finding that makes the deprecation safe to approve.

## Step 5: Write

On approval, write per `${CLAUDE_PLUGIN_ROOT}/reference/datastore.md`.

- **Write the whole rebalance, or none of it.**  A partial write leaves the product summing to
  something other than 100, which is a broken state every later run has to clean up. If the
  backend supports a transaction, use one; if it doesn't, write the offsetting decreases before
  the increase, so an interruption leaves the total low rather than over.
- **Verify the sum after writing.**  Re-read the active capabilities, total the VBO, and state
  it.  Do not report success on the basis of having issued the writes.
- **Promoting** sets `status` to `active` and assigns the approved `vbo` in the same change.
  A capability is never `active` at VBO 0, and never `proposed` at a non-zero VBO.
- **Deprecating** sets `status` to `deprecated` and tunes its VBO toward 0, redistributing the
  released share across the remaining active capabilities.  **Never delete a capability row:**
  features, dependency edges, and every historical rollup reference it, and removing it rewrites
  the past rather than recording that the offering ended.
- **Reattach features first**, then deprecate — in that order, so nothing is transiently
  orphaned.
- **Don't change a capability's `key`.**  The key is the stable handle; the `name` can be
  reworded freely.  Renaming the handle breaks every reference that used it, in exchange for
  nothing.

Report what changed, as a list of the writes actually made, and end with the verified total.

## Pitfalls to Avoid

**Recalibrating because a single feature doesn't fit.**  One awkward feature is not evidence
the set is wrong.  Two or three consecutive planning sessions ending in "none of these fit"
is.  Come back with the pattern, not the instance.

**Adding instead of redrawing.**  The set is meant to stay small.  If a proposed capability
overlaps an existing one at all, the honest change is almost always to the existing one's
`scope_boundary`.

**Deprecating what is merely quiet.**  A capability with no recent features may be finished
rather than dead — mature, stable, still delivering. Absence of activity is not absence of
value; check what it does before proposing to sunset it.

**Silent scope creep.**  Widening a `scope_boundary` to swallow an inconvenient feature is a
real decision about what the product claims to do.  Surface it as one.

**Rescoring to make the arithmetic easy.**  When a promotion needs 7 points, the tempting move
is to shave a little off whichever capabilities make the numbers land neatly.  That silently
restates what the product is for.  Take the points from where the value actually moved, and if
that isn't obvious, ask.

**Treating VBO as a measurement.**  It is a *judgement* about what matters, informed by
evidence but not derived from it.  Never compute it from feature counts, lines changed, or
anything else the catalog happens to hold.

**Treating this as init.**  If there's no product row, stop and use superdev:init.  This skill
never creates a product.

## Key Principles

- **The sum is the invariant** — active VBOs total 100, before and after, verified by reading back
- **No score moves alone** — every rescore is a full-set rebalance, presented as one table
- **Evidence, not opinion** — every proposed change cites a signal from Step 2
- **Judgement, not arithmetic** — evidence prompts the question; the user answers it
- **Redraw before you add** — boundaries drift far more often than offerings are missing
- **Deprecate, never delete** — the record of an ended offering is worth keeping
- **Blast radius first** — features and `requires` edges get resolved before deprecation, not after
- **Finding nothing is a result** — a set that still fits needs no change
