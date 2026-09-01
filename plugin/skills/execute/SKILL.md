---
name: execute
description: You MUST use this to implement a plan once Features, User Stories, and Acceptance Criteria exist in the backlog. Builds the code in a worktree, one Task per Acceptance Criterion, and gates the PR on verification.
---

# Executing Plans

## Overview

Load plan of Features, User Stories, and Acceptance Criteria. Then review the plan fully and draft a complete list of Tasks completely. Once all Tasks are drafted, start pulling from the list of Tasks until they are all complete

**Core principle:** Prefer Agent Teams when possible, but don't run any more than 4 Agent teammates.  If Agent Teams are unavailable, run Tasks as Subagents using worktrees and use your discretion on which Tasks can be done concurrently.

**Announce at start:** "I'm using the Execute skill to implement this plan."

## The Process

1. Load and Read all Features, User Stories, and Acceptance Criteria specified by the plan instructions.  Read them from the backlog following `${CLAUDE_PLUGIN_ROOT}/reference/datastore.md`
2. Draft Tasks using the principles of `${CLAUDE_PLUGIN_ROOT}/skills/execute/atdd.md` and `${CLAUDE_PLUGIN_ROOT}/skills/execute/testing-antipatterns.md`
- Every Acceptance Criterion in scope must map to at least one Task, and every Task must trace back to a criterion.  State the mapping before starting — a criterion with no Task ships unmet, and a Task with no criterion is unspecified work
3. Start an Agent Team
- **REQUIRED**: You must create a git worktrees to properly containerize your work on the Feature or set of Features that is about to be implemented.  Use the `${CLAUDE_PLUGIN_ROOT}/skills/execute/git-worktrees.md` reference.  Our completed work will all be worked as Feature branch and put into a PR.
- Start an Agent Team using the list of Tasks (TaskList) using an appropriate amount of teammates for the TaskList size
- If Agent Teams are unavailable, coordinate Subagents to complete Tasks from the TaskList and leverage concurrency when work will not cause coding conflicts or collisions
- When agents return: read each summary, verify fixes don't conflict, run full test suite, and integrate all changes

4. Iterate based on feedback:
- Apply changes if needed
- Execute on based on updates
- Repeat until complete

5. Verify before claiming anything
- Run the project's test suite (i.e. `npm test / cargo test / pytest / go test`)
- If tests fail: State the number of failures, list which tests are failing, and state that we cannot proceed until code changes are made to achieve test passing.  **Do not proceed until all tests pass**
- **REQUIRED SUB-SKILL:** hand off to superdev:evaluate to confirm every in-scope Acceptance Criterion is actually met and recorded.  Do this *while still in the worktree* — evaluate needs to run the tests, and it gates the PR
- Do not open the PR until evaluate returns a clean verdict

6. Complete Development
- Once evaluate passes, open a PR for the completed work.
```bash
# Push branch
git push -u origin <feature-branch>

# Create PR
gh pr create --title "<title>" --body "$(cat <<'EOF'
## Summary
<2-3 bullets of what changed>

## Test Plan
- [ ] <verification steps>
EOF
)"
```
Then cleanup worktree
Check if in worktree:
```bash
git worktree list | grep $(git branch --show-current)
```

If yes:
```bash
git worktree remove <worktree-path>
```

## When to Stop and Ask for Help

**STOP executing immediately when:**
- Hit a blocker mid-Task (missing dependency, test fails, instruction unclear)
- The criteria have critical gaps preventing starting, or an in-scope criterion maps to no Task
- You don't understand an instruction
- Verification fails repeatedly

**Ask for clarification rather than guessing.**

**Don't force through blockers** - stop and ask.

## Remember
- Review the criteria critically first
- Every Task traces to an Acceptance Criterion
- Verify with superdev:evaluate before the PR, not after
- Stop when blocked, don't guess

## Common Mistakes

**Skipping test verification**
- **Problem:** Merge broken code, open a failing PR
- **Fix:** Run the suite and read the output before any completion claim — superdev:evaluate is the gate

**Implementing past the criteria**
- **Problem:** Agents build what seems reasonable instead of what the Acceptance Criteria specify, and the extra work is unspecified and untested
- **Fix:** Every Task traces to a criterion; if a Task doesn't, it's scope creep — stop and raise it

**Leaving criteria unimplemented**
- **Problem:** A criterion in scope has no Task, so it silently ships unmet
- **Fix:** Before starting, confirm every in-scope criterion maps to at least one Task

**Deleting a worktree with unmerged work**
- **Problem:** Removing the worktree before the PR is open discards the branch's only checkout
- **Fix:** Only remove the worktree after the PR exists and the branch is pushed

## Red Flags

**Never:**
- Proceed with failing tests
- Merge without verifying tests on result
- Delete work without confirmation
- Force-push without explicit request
