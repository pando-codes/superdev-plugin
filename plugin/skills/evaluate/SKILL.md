---
name: evaluate
description: You MUST use this before claiming work is complete, opening a PR, or moving on - verifies every in-scope Acceptance Criterion against real test output and records the verdict in the backlog. Evidence before assertions, always.
---

# Verification Before Completion

## Overview

Claiming work is complete without verification is dishonesty, not efficiency.

This skill is the gate between "the code is written" and "the work is done."  It is not a
general reminder to be careful — it has a specific job: **decide, per Acceptance Criterion,
whether the criterion is met, on evidence, and record that decision.**

**Core principle:** Evidence before claims, always.

**Announce at start:** "I'm using the Evaluate skill to verify this work against its criteria."

## The Iron Law

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

If you haven't run the verification command in this message, you cannot claim it passes.
A criterion you did not check is **not evaluated** — which is a distinct state from passing,
and you must report it as such.

## The Process

### Step 1: Load the criteria in scope

Read every Acceptance Criterion attached to the Feature(s) this work implements, following
`${CLAUDE_PLUGIN_ROOT}/reference/datastore.md`.  Criteria come from the backlog, not from
memory of the conversation and not from the implementation — reading them off the code you
just wrote is circular and proves nothing.

State the list before you evaluate anything.  If the list is empty, stop: there is nothing to
verify against, which is a planning defect, not a pass.

### Step 2: Build the evidence table

For each criterion, identify the command that proves it and run it fresh.  One row per
criterion, no exceptions and no summarising:

| Criterion | `then_` (what must be observable) | Command run | Output | Verdict |
|---|---|---|---|---|
| `ac_7bq1lm` | every component with token usage appears with its cost | `pytest tests/test_cost.py -k breakdown` | 3 passed | pass |

Rules for this table:
- **Fresh runs only.** A result from earlier in the session is not evidence now.
- **Full command output.** Read it, check the exit code, count the failures.
- **No extrapolation.** A passing suite does not prove a specific criterion is met — the
  criterion needs a check that actually exercises its `then_`.
- **A criterion with no test is `not evaluated`**, not `pass`.  Say so plainly and name it.

### Step 3: Render the verdict

- **All in-scope criteria pass** → state that, with the table as evidence.
- **Any criterion fails** → state the count, name each failing criterion, and stop.  Do not
  open a PR, do not claim partial completion, do not describe the work as "done except."
- **Any criterion is unevaluated** → treat it exactly as a failure of the gate.  Unmeasured is
  not met.  Either write the check, or take it back to superdev:plan because the criterion
  cannot be observed as written.

### Step 4: Record the verdicts

Write each verdict to `ac_evaluation` per `${CLAUDE_PLUGIN_ROOT}/reference/datastore.md`,
carrying `criterion_id`, `evaluated_at`, `verdict`, `method`, and `source` (and `run_ref` where
there is a CI run to point at).

The table is **append-only**: a mistaken verdict is corrected by recording a newer one, never
by editing or deleting the old row.  `verdict` is `pass` or `fail` only — there is no third
value for "didn't check," which is precisely why an unevaluated criterion is the absence of a
row rather than a soft pass.

Recording requires `agent_quality_assurance` or `agent_ci`.  If the session can't authenticate
as either, say so and report the verdict in the conversation rather than silently skipping the
write.

## The Gate Function

```
BEFORE claiming any status or expressing satisfaction:

1. IDENTIFY: Which criterion am I claiming, and what command proves it?
2. RUN: Execute the FULL command (fresh, complete)
3. READ: Full output, check exit code, count failures
4. VERIFY: Does the output actually demonstrate this criterion's `then_`?
   - If NO: State actual status with evidence
   - If YES: State claim WITH evidence
5. RECORD: Write the verdict to ac_evaluation
6. ONLY THEN: Make the claim

Skip any step = lying, not verifying
```

## Common Failures

| Claim | Requires | Not Sufficient |
|-------|----------|----------------|
| Criterion met | A check exercising that criterion's `then_`, passing | Whole suite green |
| Feature done | Every attached criterion evaluated `pass` | Most of them pass |
| Tests pass | Test command output: 0 failures | Previous run, "should pass" |
| Linter clean | Linter output: 0 errors | Partial check, extrapolation |
| Build succeeds | Build command: exit 0 | Linter passing, logs look good |
| Bug fixed | Test original symptom: passes | Code changed, assumed fixed |
| Regression test works | Red-green cycle verified | Test passes once |
| Agent completed | VCS diff shows changes | Agent reports "success" |

## Red Flags - STOP

- Using "should", "probably", "seems to"
- Expressing satisfaction before verification ("Great!", "Perfect!", "Done!")
- About to commit/push/PR without the evidence table
- Counting a criterion as met because related code exists
- Trusting agent success reports
- Relying on partial verification
- Thinking "just this once"
- **ANY wording implying success without having run verification**

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "Should work now" | RUN the verification |
| "The suite is green" | Green ≠ this criterion was exercised |
| "It's obviously covered" | Name the test or it isn't |
| "I'm confident" | Confidence ≠ evidence |
| "Just this once" | No exceptions |
| "Linter passed" | Linter ≠ compiler |
| "Agent said success" | Verify independently |
| "Partial check is enough" | Partial proves nothing |
| "Different words so rule doesn't apply" | Spirit over letter |

## Key Patterns

**Per criterion:**
```
✅ [Read ac_7bq1lm] [Run pytest -k breakdown] [See: 3 passed] "ac_7bq1lm passes" → record
❌ "Suite is green, so the criteria are met"
```

**Regression tests (TDD Red-Green):**
```
✅ Write → Run (pass) → Revert fix → Run (MUST FAIL) → Restore → Run (pass)
❌ "I've written a regression test" (without red-green verification)
```

**Build:**
```
✅ [Run build] [See: exit 0] "Build passes"
❌ "Linter passed" (linter doesn't check compilation)
```

**Agent delegation:**
```
✅ Agent reports success → Check VCS diff → Verify changes → Report actual state
❌ Trust agent report
```

## When To Apply

**ALWAYS before:**
- ANY variation of success/completion claims
- ANY expression of satisfaction
- Opening a PR, committing, marking a task complete
- Moving to the next Feature
- Delegating to agents

**Rule applies to** exact phrases, paraphrases, synonyms, implications of success, and any
communication suggesting completion or correctness.

## Feeding Back

A criterion that cannot be verified is a defect in the criterion, not a reason to wave it
through.  When you hit one — it names no observable outcome, or observing it would require
something the product doesn't expose — record nothing, and hand it back to superdev:plan with
the specific reason.  That is the loop closing, and it is the point of writing criteria before
writing code.

## The Bottom Line

**No shortcuts for verification.**

Run the command. Read the output. Record the verdict. THEN claim the result.

This is non-negotiable.
