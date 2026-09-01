---
name: work
description: You MUST use this to run autonomously against the backlog work queue - claim work addressed to your role, do it, push progress, finish it, and take the next one. Use whenever asked to "pull work", "work the queue", "run the backlog", or to run unattended until there is nothing left.
---

# Working the Queue

## Overview

Every other superdev skill starts with a person saying what to do. This one starts with the
backlog saying it. You claim work addressed to your role, do it, report what happened, and take
the next item — until the queue is empty or something stops you.

**Announce at start:** "I'm using the Work skill to pull work from the backlog."

**The core discipline:** *you do not decide what to work on.* Priority, ordering, and
dependencies were decided when the work was filed. Claiming is the whole of your input into
that question. An agent that skips its claim and starts on something it noticed is an agent
nobody can coordinate with.

## Before the first claim

1. **Read `.superdev/product.json`** at the repository root for `product_key`. Missing means
   this repository was never initialized — stop and say so; do not guess from the directory
   name.

2. **Call `backlog_whoami`.** It answers three things you need before doing anything:
   - `pando_role` — which queue is yours. You cannot work another one.
   - `writes.product_key` — the product this key may write, or `any`.
   - `agent_id` — the identity your claims are recorded under.

   If the role is not the one you expected, **stop and say so**. Do not proceed hoping the
   writes will land; they will not, and you will have burned the run discovering it.

3. **If several agents share this session,** pass a distinct `agent_id` on every work tool
   call. Without it they are one agent to the backlog and will release and finish each other's
   items.

## The loop

### 1. Claim

```
backlog_claim_work  product_key=<key>  lease_seconds=<how long you expect this to take>
```

**`claimed: null` is success.** It means your role's queue is empty. Report that plainly and
stop. Do not poll in a tight loop, do not widen the search, and do not go looking for work in
the code — an empty queue is the correct answer to "what should I do next", not an obstacle.

Ask for a lease roughly the length of the work, not the length of the session. A long lease on
an agent that dies keeps the item out of the queue for that whole time.

### 2. Read the brief, and restate it

The claim returns everything needed to start. Read all of it before touching anything:

| Field | What it is |
|---|---|
| `intent` | why this work exists **now**. The thing that changed. |
| `guidance` | how the author wants it done, where that differs from the obvious |
| `features[]` | what you are building on, with the `capabilities` it serves |
| `features[].stories[]` | who wants it and why — the context, not the instruction |
| `must_satisfy[]` | the acceptance criteria this item is judged against — **the instruction** |
| `definition_of_done` | which of those two is the standard for this item |
| `notes[]` | what previous agents said. Read `decision` and `handoff` notes carefully. |

**Then restate, in your own words: the goal, and every criterion you must satisfy.** If you
cannot state what "done" will look like from what you were given, the brief is defective —
push a `blocker` note saying exactly what is missing and move the item to `blocked`. Do not
invent the missing half. A criterion you guessed at is worse than one nobody wrote.

### 3. Do the work

Which skill does the work depends on which role you hold:

| Your role | Load | What finishing means |
|---|---|---|
| `engineer` | `superdev:execute` | the code exists and its tests pass |
| `quality-assurance` | `superdev:evaluate` | a verdict is recorded per in-scope criterion |
| `product-manager` | `superdev:plan` or `superdev:brainstorm` | the records exist and are linked |
| `head-of-engineering` | `superdev:recalibrate` | the scores are rebalanced |

Those skills are the method. This skill is only the loop around them.

**Heartbeat between steps.** Call `backlog_heartbeat_work` whenever a step finishes and before
anything long. A lapsed lease returns your item to the queue, and another agent picking it up
is how the same work gets built twice.

**A `lease_lost` 409 is a full stop.** You no longer hold the item; another agent may already
be on it. Stop working, discard anything uncommitted that assumed you owned it, say what
happened, and claim again. Never push through it.

### 4. Push what is worth keeping

`backlog_push_progress` writes a permanent note. Write few, and write them worth reading.

- **`decision`** — the one that earns its place. A choice you made and *why*: why you rejected
  the obvious approach, which trade-off you took, what you found out that the brief did not
  say. It is the only record of why the code looks like this, and the next agent has no other
  way to recover it.
- **`blocker`** — before moving an item to `blocked`, always. The outcome field is one line;
  this is where the detail goes.
- **`handoff`** — before releasing an item, if you learned anything the next agent needs.
- **`progress`** — sparingly. A note per file touched is noise.

### 5. Finish honestly

```
backlog_finish_work  work_item_key=<key>  state=<done|blocked|open|cancelled>  outcome="<what happened>"
```

**`done` is terminal and nothing reopens it.** Only use it when every criterion in
`must_satisfy` is *observably* true — not when the code merely exists, and not when the tests
you wrote pass but the criterion says something you did not test. If you are not sure, you are
not done.

**Finishing a work item is not a verdict.** It says you did the work; it does not say the
criteria pass. That is `backlog_record_evaluation`, and it is deliberately not yours if your
role cannot call it — the agent that builds does not get to grade itself.

**Release rather than hold.** An item you cannot make progress on is better given back with a
`handoff` note than held under a lease nobody is working.

### 6. Take the next one

Go back to step 1. Between items, keep nothing from the last one except what you wrote down.

## Stopping

Stop and report — do not claim again — when any of these is true:

- The queue returned `claimed: null`. **This is the normal ending.**
- You have moved two consecutive items to `blocked`. Something upstream is wrong and more
  attempts will only produce more blocked items.
- A tool refused you in a way `backlog_whoami` does not explain.
- You were given an item limit and reached it.

If no limit was given, ask for one before starting an unattended run, or default to **five
items** and report back. An agent that finishes the entire backlog before anyone reads a line
of it has removed every chance to correct it early.

## What this skill will not do

- **Work another role's queue.** If the engineer queue is empty and there is quality-assurance
  work waiting, that is not yours. Say so and stop.
- **File its own work.** If you notice something worth doing, say so in the report or push a
  `decision` note. An agent that can fill its own queue has no backlog, only a to-do list —
  and the roles that can file work are the ones with the standing to decide it is worth doing.
- **Finish an item on someone else's behalf.** If a work item you did not claim looks
  abandoned, leave it. Its lease will lapse and the queue will offer it to you properly.
