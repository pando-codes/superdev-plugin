# Datastore

Use this reference whenever a skill reads from or writes to the catalog.  The other reference
docs describe what each entity *means*; this one describes how you actually reach it and what
the store will accept.

## Reaching it

This plugin ships its own MCP server.  Installing superdev installs it, and the tools below are
the whole of the catalog surface — there is no second path and you should not construct one.

The server needs an API URL and a key, resolved at three precedences, highest first:

| | Where | Good for |
|---|---|---|
| 1 | `PANDO_CATALOG_API_URL` / `PANDO_CATALOG_API_KEY` in the environment | CI, one-off runs |
| 2 | `<project>/.superdev/config.json` | a repository that works as one role |
| 3 | `~/.superdev/config.json` | your keys, wherever you are |

Levels **merge field by field** rather than the higher one winning outright, so the usual
arrangement works: your keys live user-scope, and the repository says which role it works as.

```json
// ~/.superdev/config.json          (mode 0600)
{ "api_url": "https://pando-catalog-api.fly.dev",
  "keys": { "engineer": "pcat_live_…", "product-manager": "pcat_live_…" } }

// <project>/.superdev/config.json
{ "role": "engineer" }
```

If the `catalog_*` tools are not in the session, that is the reason — the server exits rather
than running unconfigured, and says on stderr exactly which of the three places it looked.
Keys are minted per holder from `apps/backend`, which holds the owner database credential this
plugin deliberately does not.

### The tools you are offered are the ones your key can use

At startup the server asks `whoami` and registers only the tools your role can actually call.
An engineer key never sees `catalog_update_acceptance_criterion`.

**This is a surface, not a boundary.** Authority is still decided by Postgres; this only stops
you spending a turn discovering a refusal — and stops a deliberate boundary looking like an
obstacle to route around. If the catalog cannot be reached at startup the full surface is
offered and the database still refuses what it always would.

`SUPERDEV_ROLE` may **narrow** the surface below what your key carries, never widen it.

### Who you are, as distinct from which key you hold

Work items are held under a lease by an **agent id**, sent on every request. It defaults to
`<host>-<role>`, and `SUPERDEV_AGENT_ID` sets it.

**Several agents in one session share one server, and therefore one identity.** Pass a distinct
`agent_id` on each work tool call, or they can release and finish each other's items. It changes
who holds a claim, never what the key may do.

**If the tools are missing, stop and say so.**  Do not fall back to writing catalog records into
markdown files, and do not go looking for a database connection — a story that isn't in the
store isn't in the catalog, and a half-written plan scattered across the working tree is worse
than an honest failure.

### What the plugin holds, and what it does not

One API key, and nothing else.  No database credential, no project ref, no host.  That is
deliberate: a local plugin is the least trustworthy link in the chain, so compromising it yields
a key scoped to a single role and revocable with one `UPDATE` — not a Postgres login.

## Authority

Your key carries exactly one role, and **the role is the authority**.  There is no separate
permission check to reason about: the request reaches Postgres, and its policies decide.

| Role | May write |
|---|---|
| `product-manager` | `product` (create only), `capability`, `feature`, `story`, `acceptance_criterion`, every link, and `work_item` |
| `engineer` | **only the work item it currently holds**, and notes on it |
| `quality-assurance` | `ac_evaluation`, and the work item it holds |
| `ci` | `ac_evaluation`, `evidence_signal` |
| `revops` | `evidence_signal` |
| `head-of-engineering` | `product`, `weight_policy`, `coverage_review`, `work_item` |

`engineer` is deliberately the narrowest role in the system. The agent that builds against an
acceptance criterion cannot revise that criterion, cannot record the verdict on its own work,
and cannot file its own work. Every one of those would let the party doing the work decide
whether the work was done.

Reads are open to every role — reading is not an assertion.

### A key may also be bound to one product

Beyond its role, a key can be **scoped** to a single product (027, 028). A scoped key
writes that product and refuses every other, and **reads only that product's catalog** —
both decided by the database rather than by this document. The product *list* stays
visible, so you can always see which products exist; you just cannot see inside the
ones your key is not bound to.

`catalog_whoami` reports it, and is worth calling once at the start of a session
rather than discovering it from a refusal:

```json
{ "pando_role": "product-manager",
  "writes": { "scope": "product", "product_key": "reelmates" } }
```

`"scope": "any"` means the key is unbound and may write any product. Two consequences
worth knowing before you plan a write:

- **A scoped key cannot create a product**, so superdev:init needs an unscoped one.
  Everything after init works on a scoped key.
- **A refusal names 42501** and is not about your role. If `catalog_whoami` says
  product-manager and a capability write is still refused, check the product you
  passed against the product the key is bound to.
- **Another product's records read as absent, not forbidden.** A capability list for a
  product you are not bound to comes back empty and a record by key comes back missing.
  That is the scope, not a bad key — `catalog_whoami` is how you tell the difference.

**A refusal is a normal answer, not a fault.**  It arrives naming both roles: *"this operation
requires product-manager; this key carries quality-assurance."*  Do not retry it and do not
route around it.  Call **`catalog_whoami`** when a write is unexpectedly refused; it reports the
role your key actually carries, which is the answer to nearly every unexpected 403.

`ac_evaluation` and `evidence_signal` are **append-only**.  A wrong verdict is corrected by
recording a newer one, never by updating or deleting the old row — the model reads the most
recent per criterion, so the correction supersedes rather than rewrites.

## Which product you are working on

A catalog holds many products, and **every entity names its product directly** — `capability`,
`feature`, `story`, and `acceptance_criterion` all carry a product.  So almost every call below
is meaningless until you know which product it belongs to.

The answer is never inferred.  It is recorded in `.superdev/product.json` at the repository
root, written by superdev:init:

```json
{ "product_key": "reelmates" }
```

Read it before any other catalog access and pass that `product_key` to every call that takes
one.  If it is missing, the repository has not been initialized — stop and use superdev:init
rather than guessing from the repository name or picking the only product that happens to be
there.  If it names a product the catalog does not hold, stop and ask; do not create it, because
the key may belong to someone else's repository.

**One repository owns exactly one product.**  A second product is a second repository, with its
own binding and its own init.

## The tools

### Reading

| Tool | Answers |
|---|---|
| `catalog_whoami` | which role this key carries, and which product it may write |
| `catalog_list_products` | every product in the catalog |
| `catalog_list_capabilities` | a product's capabilities, optionally filtered by `status` |
| `catalog_get_capability` | one capability, its features, and its computed weight |
| `catalog_list_features` | a product's features, optionally filtered by `lifecycle_state` |
| `catalog_get_feature` | one feature with its stories, criteria, and verified state |
| `catalog_get_story` | one story with its derived confidence |
| `catalog_get_acceptance_criterion` | one criterion with its latest evaluation |
| `catalog_coverage` | the product's weighted verified share |
| `catalog_model_health` | problems the model detects in itself |
| `catalog_public_catalog` | the GTM projection — public capabilities only |
| `catalog_list_work` | the work queue, every role's, with a `ready` flag |
| `catalog_get_work` | one work item's full brief |

These return the views rather than raw rows, so they already encode rules you would otherwise
re-derive: confidence decay from `last_reviewed_at`, latest-verdict-per-criterion, coverage and
weighting.  Two readings are easy to get backwards:

- **A null weight means "not yet measurable", not "worth nothing."**
- **"Never evaluated" is the ABSENCE of an evaluation, not a third verdict.**  A criterion with
  no `ac_evaluation` row has not failed.

`catalog_model_health` is the first thing to check when a figure looks wrong.

### Writing

| Tool | Requires |
|---|---|
| `catalog_create_product` | product-manager or head-of-engineering |
| `catalog_create_capability`, `catalog_update_capability` | product-manager |
| `catalog_create_feature`, `catalog_update_feature` | product-manager |
| `catalog_create_story`, `catalog_update_story` | product-manager |
| `catalog_create_acceptance_criterion`, `catalog_update_acceptance_criterion` | product-manager |
| `catalog_link`, `catalog_unlink` | product-manager |
| `catalog_record_evaluation` | quality-assurance or ci |
| `catalog_record_evidence` | revops or ci |
| `catalog_claim_work`, `catalog_heartbeat_work`, `catalog_push_progress`, `catalog_finish_work` | any role, for work addressed to it |
| `catalog_file_work`, `catalog_steward_work` | product-manager or head-of-engineering |

**Read each write tool's description before calling it.**  The database enforces **shape, not
quality** — a capability whose `scope_boundary` reads `stuff` satisfies every constraint in the
schema, and so does `given: the system / when: it runs / then: it works`.  The quality bar lives
in the tool descriptions because nothing downstream will catch a record that passes validation
and says nothing.

There is no tool to rename or delete a product, and no tool to delete anything else.  Removal is
a lifecycle transition — `status` or `lifecycle_state` — because evaluation history has to
outlive the thing it evaluated.

## Records are addressed by key

Every entity has an `id` the catalog generates and never hands you in advance.  You address rows
by `key`, which is what you actually type.

- `story.key` — `^story_[a-z0-9]{6}$`, **globally unique**
- `acceptance_criterion.key` — `^ac_[a-z0-9]{6}$`, **globally unique**
- `feature.key`, `capability.key`, `product.key` — `^[a-z0-9][a-z0-9-]*$`, unique **per product**

The patterns are database constraints and are **case-sensitive** even though keys compare
case-insensitively — uppercase is rejected outright.  Story and criterion tools take no
`product_key`, because their keys are global; capability and feature tools always do.

`when_` and `then_` carry trailing underscores because `when` and `then` are reserved words in
SQL.  The underscore is part of the wire name, not a typo to correct.

### Enum values

Use these exactly; anything else is refused.

- `story.status` — `current` | `stale` | `retired`
- `acceptance_criterion.status` — `active` | `retired`
- `feature.lifecycle_state` — `proposed` | `active` | `deprecated` | `removed`
- `capability.status` — `proposed` | `active` | `deprecated` | `archived`
- `visibility` (feature and capability) — `internal` | `public`

A newly planned Feature is `proposed`, not `active`.  So is a newly proposed Capability — and a
Capability that is not `active` or `deprecated` **must** carry a `vbo` of 0, which is a database
constraint, not a convention.

## Linking

`catalog_link` and `catalog_unlink` take a `kind` naming which two things to join:

| `kind` | Also needs | Rule |
|---|---|---|
| `capability-feature` | `product_key`, `capability_key`, `feature_key` | link on value SERVED, never on dependency; optional `cost_score` / `value_score` |
| `feature-story` | `product_key`, `feature_key`, `story_key` | a story belongs to at most one feature |
| `feature-ac` | `product_key`, `feature_key`, `ac_key` | a criterion belongs to at most one feature |
| `capability-dependency` | `product_key`, `from_capability_key`, `to_capability_key`, `kind_of_dependency` | `requires` or `degrades_without` |
| `work-item-feature` | `work_item_key`, `product_key`, `feature_key` | `wi_` + six lowercase alphanumerics |
| `work-item-ac` | `work_item_key`, `ac_key` | refused if the criterion belongs to none of the work item's features |

`cost_score` and `value_score` sit on the **edge**, not on the Feature: the same Feature may
cost and contribute differently to each Capability it serves.  Creating a Feature leaves them
unset, and re-linking an existing edge is how you attach them afterwards — a re-link that omits
them leaves any already recorded untouched.  **Leave them unset rather than guessing.**  An
unscored edge reads as "not yet assessed"; a zero claims the Feature contributes nothing.

**A Story belongs to exactly one Feature, and an Acceptance Criterion belongs to exactly one
Feature.**  A Feature may hold many of each, but the reverse is not true — so if one Story
genuinely informs two Features, that is a signal the Story is too broad and should be split, not
an attempt to link it twice.  A second link is refused.

Story and Acceptance Criterion are **siblings under a Feature, not parent and child.**  Neither
links through the other.  This is deliberate: a Story is context, a criterion is an instruction,
and tying them would impose a hierarchy the domain doesn't have.

**Creating a Feature requires a Capability in the same call.**  `capability_keys` is required
and must be non-empty, because a feature that reaches commit unlinked is rejected outright —
there is no way to create one first and link it after.  The same rule makes unlinking a
feature's *last* capability a refusal rather than an unlink.

A product is **immutable** on every entity.  A link whose two sides name different products is
refused, and so is any attempt to move an entity between products.  Reassigning a product is not
an operation this model has: write the entity under the new product and retire the old one.

## Worked example

A story and a criterion authored under an existing feature, then a work item joined to both.
`feature_key` on create does the link in the same transaction, so a story and its feature link
land together or not at all:

```
catalog_create_story
  key=story_9f3k2a  product_key=reelmates  feature_key=cost-attribution
  role="engineer investigating a costly session"
  want="to know which parts of a session are responsible for its cost"
  benefit="so that I can tell which components drive cost"

catalog_create_acceptance_criterion
  key=ac_7bq1lm  product_key=reelmates  feature_key=cost-attribution
  given="a session with recorded token usage across multiple components"
  when_="the cost breakdown is rendered"
  then_="every component type with recorded token usage in that session appears,
         with its token count and cost"

catalog_link kind=work-item-feature  work_item_key=wi_a1b2c3
             product_key=reelmates   feature_key=cost-attribution
catalog_link kind=work-item-ac       work_item_key=wi_a1b2c3  ac_key=ac_7bq1lm
```

## The entity schemas

The server publishes each entity's full field documentation as a resource:

```
catalog://schema/product      catalog://schema/capability   catalog://schema/feature
catalog://schema/story        catalog://schema/acceptance-criterion
```

Read one when a field's meaning is in question.  They are generated from the migrations that
define them, so where a reference doc in this folder disagrees with a schema resource, **the
schema wins** — it describes the thing that accepts the write.

## Divergences — read before writing

The reference docs in this folder describe a richer model than the catalog currently stores.
These gaps are open decisions, not bugs to work around silently.  If a skill needs one, raise it
with the user rather than inventing a place to put it.

One remains open, deliberately.

| Described in reference | State in the catalog |
|---|---|
| **Clauses** — [clause.md](clause.md), and the composed `eval` object in [acceptance-criteria.md](acceptance-criteria.md) | **Deferred by decision, not oversight.**  There is no clause record; a criterion stores `given`/`when_`/`then_` as plain text.  Clause reuse and coverage analysis are unavailable, and `clause.md` documents a direction rather than a thing you can write to. |

**Clauses are out of the skills' path.**  Do not attempt to create one, and do not treat
`clause.md` as an instruction — it is kept so the idea survives, and it will move back into the
workflow only when the index actually exists.

Write Acceptance Criteria as prose in `given`/`when_`/`then_`, and keep each one atomic — one
precondition set, one action sequence, one observable outcome.  That preserves the discipline
the Clause model exists to enforce, which is what keeps today's criteria migratable if the index
is ever built.

### Resolved, for anyone reading an older draft

Story `goal` is stored as `want`; story status is `current`/`stale`/`retired`, not
`active`/`archived`; and a Story and a criterion each belong to **exactly one** Feature — the
many-to-many the reference docs once implied was never real.  Capability `description`, `vbo`,
and `kpi` are now stored, as are `story.importance`, the per-edge `cost_score`/`value_score`,
and Feature's `value_prop`/`cost_assessment`/`scope_boundary`.

One of those is stored but **not reachable from here**: a Capability's `kpi` lives in its own
junction and no tool writes it.  Nothing in this plugin's workflow sets one, so this is a limit
rather than a gap — if a skill ever needs it, raise it rather than working around it.

## The work queue

Everything above describes what the catalog *records*. This describes what it *hands out*.

A **work item** is one piece of work: a title, why it exists, how to do it, and the role that
may claim it. It is the answer to "what should I do next", and it is the only sanctioned answer
— an agent that picks its own work is an agent nobody can coordinate with.

```
catalog_claim_work  product_key=reelmates  lease_seconds=900
```

### Six things about the queue that are easy to get backwards

**1. An empty answer is success.** `claimed: null` means your role's queue is empty. It is not
an error, not a reason to retry in a loop, and not a reason to go looking for work elsewhere.

**2. Work is addressed to a ROLE, and the role is your key's.** You cannot draw from another
role's queue, and naming a specific item does not change that — `work_item_key` is a filter,
never an override. An engineer will never be handed a quality-assurance item, whatever its
priority.

**3. A claim is a LEASE, not an assignment.** It expires. `catalog_heartbeat_work` extends it;
an agent that dies simply stops, and its item returns to the queue on its own with no sweeper
process involved. A `lease_lost` 409 means you no longer hold the work — **stop**, do not retry.

**4. Claims are atomic.** Concurrent claimers each take a different item (`for update skip
locked` in the database, not a check in the API). Several agents can safely work one product.

**5. Smaller priority is sooner.** Ordering is `(priority, created_at)`; the default is 100,
leaving room on both sides. `ready` in `catalog_list_work` is the same three-part condition a
claim applies — state, lease, dependency — so what the list calls ready is what a claim hands
out.

**6. `done` and `cancelled` are terminal.** Nothing reopens them. An item that turns out to
need more work is a new work item.

### The brief is the point

A claim returns everything needed to start:

| Field | What it is |
|---|---|
| `intent` | why this work exists **now** — the thing that changed |
| `guidance` | how the author wants it done, where that differs from the obvious |
| `features[]` | with the `capabilities` each serves |
| `features[].stories[]` | who wants it and why — **context** |
| `must_satisfy[]` | the acceptance criteria this item is judged against — **instruction** |
| `definition_of_done` | which of those two is the standard for this item |
| `notes[]` | what previous agents recorded, newest first |

That payload is why pulling work from the catalog beats being told what to do in prose. If it
does not contain enough to say what "done" will look like, **the brief is defective** — push a
`blocker` note naming what is missing and block the item. Do not invent the missing half.

### Filing work worth claiming

`catalog_file_work` needs product-manager or head-of-engineering, and the database enforces
**shape, not quality**: an intent reading "improve things" satisfies every constraint and is
worthless to whoever claims it.

Then **link it** — `catalog_link` with `kind='work-item-feature'` and `kind='work-item-ac'` is
what puts the stories and criteria into the brief. An unlinked work item hands an agent one
sentence and no criteria.

### Notes are append-only

`catalog_push_progress` writes a permanent row; there is no edit and no delete. `decision` is
the kind that earns its place — why you rejected the obvious approach is the only thing nobody
can recover later. Notes are filed under the connection's agent id, not one you name.

### Finishing is not a verdict

`catalog_finish_work state=done` says you did the work. It does not say the criteria pass —
that is `catalog_record_evaluation`, and it is deliberately unavailable to the role that builds.
