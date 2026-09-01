# superdev

A Claude Code plugin that turns ideas into working code through gated stages, recording what was
decided in the backlog backend (`apps/backend`) rather than in
scattered prose — and then letting agents **pull that work back out**, one well-defined item at
a time. Follows the principles of ATDD and the Agile SDLC.

The plugin is self-contained: it ships the MCP server that reaches the backlog, so installing
superdev is the whole setup bar a key.

Two ways to use it. **Driven**, where you run the skills in order and the backlog records what
was decided. **Autonomous**, where agents claim work addressed to their role, do it, push
updates, and take the next item — several of them at once, safely, because the queue lives in
the database and a claim is an atomic lease.

## The workflow

Driven, one person deciding what happens next:

```
init ──→ brainstorm ──→ plan ──→ execute ──→ evaluate
  (once)                   ↑ │                     │
                           │ └──→ recalibrate      │
                           └───────────────────────┘
                            criterion not observable
```

Autonomous, the backlog deciding:

```
        plan files work        ┌──────────── nothing ready ────────────┐
              │                │                                       │
              ▼                ▼                                       │
   ┌──→  backlog_claim_work ───┴──→ read the brief ──→ do the work ──→ │
   │              (a lease)            (intent, stories, criteria)     │
   │                                          │                        │
   │                                    heartbeat ⟲                    │
   │                                          │                        ▼
   └──────── next item ←─── finish ←──── push progress            report and stop
```

| Skill | What it does | What it writes |
|---|---|---|
| **init** | Bootstraps an empty backlog — derives the Product and Capabilities from an existing project, or interviews you when it's fresh. Run once | `product`, `capability` |
| **brainstorm** | Refines an idea one question at a time into User Stories | `story` |
| **plan** | Turns stories into Features, links them to Capabilities, and writes the Acceptance Criteria that define *how*. May add `proposed` Capabilities, never scores them | `feature`, `acceptance_criterion`, links |
| **recalibrate** | Scores the Capabilities — promotes `proposed` ones, rebalances VBO across the product, redraws boundaries, deprecates. The only skill that sets a `vbo` | `capability` |
| **execute** | Builds the code in a git worktree, one Task per criterion, via agent teams | code, a PR |
| **evaluate** | Verifies every in-scope criterion against real test output, and gates the PR | `ac_evaluation` |
| **work** | Runs the loop: claim work addressed to your role, do it, push progress, finish, next | `work_item`, `work_item_note` |

`init` runs **exactly once per repository** to seed the backlog; everything downstream assumes a
Product and its Capabilities already exist. It refuses to run a second time — a second product
would silently split the backlog, and nothing in the schema prevents it. Changing capabilities
after that is `recalibrate`'s job, which `plan` hands off to whenever an idea fits no existing
capability.

Each active Capability carries a **VBO** — its share of the product's value — and those shares
sum to 100. That is why scoring is its own skill: no score moves alone, so `plan` may add a
Capability as `proposed` at VBO 0 (excluded from the sum, forcing no rebalance) while
`recalibrate` owns promotion and the rebalance that pays for it.

Otherwise each stage hands off to the next, and `evaluate` hands *back* to `plan` when a
criterion turns out not to be observable as written — that loop is the point of writing criteria
before code.

## Pulling work

```
backlog_claim_work  product_key=reelmates
```

What comes back is a **brief**, not a ticket: why this work exists now, how the author wants it
done, the capability it serves, the user stories that explain who wants it, and the acceptance
criteria it will be judged against. An agent that has this needs no further orientation.

```
intent:     the acceptance criterion is written and nothing implements it
guidance:   write the failing acceptance test first
capability: ingest — In: files. Out: reporting.
story:      as an analyst with a spreadsheet, I want to upload it without asking anyone
criterion:  ac_1fff00 — given a valid CSV of 1000 rows / when it is uploaded /
                        then all 1000 rows appear in the table within 5 seconds
done when:  every criterion in must_satisfy is observably true
```

Six things worth knowing before you loop on it:

- **`claimed: null` is success.** Your role's queue is empty. Not an error, not a retry.
- **Work is addressed to a role — yours.** You cannot draw from another queue, and naming an
  item is a filter, never an override.
- **A claim is a lease.** It expires; heartbeat while you work. An agent that dies returns its
  item to the queue on its own, with no sweeper process.
- **Claims are atomic** (`for update skip locked`, in the database). Concurrent claimers each
  get a different item, so a fleet is safe by construction.
- **`done` is terminal.** Nothing reopens it.
- **Finishing is not a verdict.** It says you did the work, not that the criteria pass — that
  is `evaluate`'s, and deliberately not available to the role that builds.

## Roles, and why the builder's is the narrowest

Your key carries exactly one `pando_role`, and **the database decides what it may write** — not
the API, and not this plugin.

| Role | May write |
|---|---|
| `product-manager` | the whole model, every link, and the backlog |
| `head-of-engineering` | products, weighting policy, and the backlog |
| `engineer` | **only the work item it currently holds**, and notes on it |
| `quality-assurance` | `ac_evaluation`, and the work item it holds |
| `ci` | `ac_evaluation`, `evidence_signal` |
| `revops` | `evidence_signal` |

`engineer` exists so that least privilege is a claim worth making. The agent that builds against
a criterion cannot revise that criterion, cannot grade its own work, and cannot fill its own
queue. Handing it `product-manager` — the only alternative before this role existed — would have
made the criteria a description of whatever it happened to build.

On top of that, the server **only registers the tools your role can use**. An engineer key never
sees `backlog_update_acceptance_criterion`. That is a surface, not a boundary: RLS is still what
refuses, and if the backlog is unreachable at startup the full menu is offered and the database
refuses exactly as it always would. `SUPERDEV_ROLE` may narrow the surface, never widen it.

The three shipped agents in `agents/` carry the same narrowing in their tool lists, so a
subagent is offered its role's tools and no others.

## Installation

```
/plugin marketplace add https://github.com/pando-codes/pando-plugins.git
/plugin install superdev@pando-plugins
```

**Use the full HTTPS URL, not the `pando-codes/pando-plugins` shorthand.** The shorthand resolves
to `git@github.com:` and clones over SSH, which works if you already have a GitHub SSH key and
fails with an authentication error if you do not — for a public marketplace, on a machine that has
never pushed to GitHub, that is the common case. The HTTPS form was verified to work with SSH
entirely disabled.

The plugin ships **no code and no runtime**. It is a manifest naming four HTTPS endpoints on the
backlog's own deployment, so there is nothing on your PATH to install and nothing to build.

Then export a credential for each. `superdev:connect` walks through the whole of this section
interactively — where to get them, where to put them, and how to check it took.

| Variable | Server | Role |
|---|---|---|
| `SUPERDEV_GRANT_PRODUCT_MANAGER` | `backlog-product-manager` | plans, authors the model |
| `SUPERDEV_GRANT_ENGINEER` | `backlog-engineer` | builds |
| `SUPERDEV_GRANT_QUALITY_ASSURANCE` | `backlog-quality-assurance` | verifies |
| `SUPERDEV_GRANT` | `backlog` | the main thread, and driving the skills by hand |

```sh
# in ~/.zshrc or ~/.bashrc — read before Claude Code starts
export SUPERDEV_GRANT_ENGINEER='pcat_live_…'
```

Each holds an **orchestrator grant naming one role and one product**. The role and the product both
come off the credential, never off the URL and never off anything an agent says, so a builder has
no way to act as a planner and no way to reach another product. The server mints a twelve-hour key
from the grant at the first call and replaces it before it lapses; no agent ever sees that key.

**It must be exported in the shell that launches Claude Code.** A manifest expands `${VAR}` from
there and nowhere else — not from `.claude/settings.json`, not from anything inside a repository —
so a machine that works two products holds two sets of grants, and exporting inside a running
session changes nothing until you restart it.

### Getting the grants

**If you have an account, issue them at
[superdev-portal.vercel.app](https://superdev-portal.vercel.app).** Sign in by emailed link, name
the machine, pick the product, and the set is shown once — only hashes are stored, so they cannot
be read back. You can revoke any of them from the same page, and revoking one stops every key it
has minted, instantly.

**Accounts themselves are still created by hand**, because the isolation a public signup would
have to promise is not finished — see [what is not true yet](#what-is-not-true-yet). The portal
issues credentials; it does not create accounts. If you want one:

**[Request access →](https://github.com/pando-codes/superdev-plugin/issues/new?template=access-request.yml)**

You get back an account with a product in it, and a walk through `init` if you want one.

If you operate your own backlog, mint them with the owner database credential this plugin
deliberately does not hold — once per role:

```sh
cd apps/backend
DATABASE_URL=… bun run mint-grant --org pando --product reelmates \
  --roles agent_engineer --label "alex laptop"
```

Each is printed once, with the variable it belongs in. A grant that allows several roles, or that
names no product, is still valid for `POST /v1/agents/register` but **cannot open a session** —
the command says so at mint time rather than leaving you to discover it as an absent plugin.

**With nothing exported, the servers do not connect and the tools are simply absent.** That is a
worse first-run experience than the local server's — it used to start unconfigured and answer
every call with instructions naming the three files it had looked in — and it is the price of a
transport where there is no local process to hold the explanation. `claude mcp list | grep backlog`
is what recovers it: a missing variable is reported there by name, and `superdev:connect` reads it
for you.

Credentials are read **once, when Claude Code starts**. One exported into a running session takes
effect at the next one.

## Running a fleet

A fleet is **one process per agent**, each with its own key and its own identity:

```sh
# terminal 1 — the builder
SUPERDEV_ROLE=engineer          SUPERDEV_AGENT_ID=builder-1 claude
# terminal 2 — another builder, same role, different identity
SUPERDEV_ROLE=engineer          SUPERDEV_AGENT_ID=builder-2 claude
# terminal 3 — the verifier
SUPERDEV_ROLE=quality-assurance SUPERDEV_AGENT_ID=verifier-1 claude
```

They coordinate through the queue and nothing else. Two builders never get the same item.

`SUPERDEV_AGENT_ID` matters: a lease is held by an **identity**, and two agents sharing one can
finish each other's work. Within a single session, several subagents share one MCP server and
therefore one identity — pass a distinct `agent_id` on each work tool call to separate them.

## Structure

```
.claude-plugin/plugin.json    declares four HTTP endpoints, one per role plus the unpinned one
mcp/test/naming.test.ts       guards the surface this plugin ships against the old name
reference/                    the entity model — what a good record looks like
  user-story.md     capability.md    feature.md
  acceptance-criteria.md             clause.md
  datastore.md      how to reach the backlog and what it will accept
skills/
  connect/                    getting a key into the right place, and checking it took
  init/  brainstorm/  plan/  execute/  evaluate/  recalibrate/  work/
agents/
  superdev-engineer.md   superdev-verifier.md   superdev-planner.md
```

`agents/` holds one agent per role that does superdev's work, each narrowed to its role's tools.
A test asserts those lists against the role map, so the two cannot drift.

`skills/execute/` bundles `atdd.md`, `testing-antipatterns.md`, and `git-worktrees.md`, loaded
on demand rather than up front.

`skills/connect/` is the one skill that is not part of the workflow: it is the first-run path, and
the path back from a revoked or expired grant. It is also the only thing that can help when the
tools are missing entirely, which is what a refused connection looks like.

The tools themselves are not here. They live in `apps/backend/src/mcp` with the database they
speak to — a tool's description is the quality bar for what gets written, and it belongs beside
the constraints it is describing.

## What is not true yet

Said here rather than discovered later, because some of it decides whether this is a reasonable
thing for you to depend on right now.

- **The hosted backlog is invite-only, and that is a technical fact rather than a marketing
  one.** Its schema has no account entity: a key is scoped to a *product*, and each account is
  provisioned by hand so that scoping lines up with a customer boundary. Self-serve signup opens
  when the account entity does, and not before.
- **The plugin and the API are versioned separately and deploy separately.** Your copy is a git
  checkout that changes when you update it; the API changes when it is deployed. What `/v1`
  promises is written down in `docs/guides/releasing.md`, and additions are the only change it
  permits.
- **One region, one machine, no SLO, no status page.** Every deploy is a short gap in service.
- **No terms of service, privacy policy, or DPA yet.** They are being written. Until they exist,
  do not put anything in the backlog that would need them.

## There is no server to trust

This plugin ships no executable code. It is `plugin.json`, three agent definitions, and the
skills and reference they read — nothing that runs on your machine, nothing on your PATH, no
runtime, no bundle, and no dependencies at all.

That is a recent and deliberate change. The plugin used to ship `mcp/dist/stdio.js`, a committed
build artifact, because a plugin installed from GitHub is a git checkout with no install step and
therefore no `node_modules` to resolve against. A committed bundle is a stronger thing to ask a
stranger to trust than an ordinary dependency — no registry, no version, no lockfile between
whoever pushed it and what executes — and the honest caveat at the time was that you could not
reproduce the build yourself from the mirrored repository.

Moving the server to the backlog's own deployment removes the question rather than answering it.
What you now run locally is a JSON file. What executes is a service you reach over HTTPS with a
credential you can revoke, and which holds a key of its own that lasts twelve hours.

The trade is real and worth stating: you can no longer read the code that answers your tool calls
by reading this repository, and there is no offline path — no cached reads, no journalled writes.
When the backlog is unreachable, superdev stops.

### Working on it

```sh
bun install
bun test          # request shapes, tool surface, and the bundle itself
bun run build     # rebuild mcp/dist/stdio.js — REQUIRED after editing mcp/src
bunx tsc
```

**Run `bun run build` after any change to `mcp/src`.** Every other test imports the source, so
they would stay green while the file that actually ships was a revision behind; `bundle.test.ts`
rebuilds and compares bytes to make that a red test instead.

The integration suite that runs the tools against a real API, a real database, and real RLS
lives in `apps/backend/test/`, alongside the migrations it asserts against. What runs
here is what belongs to this repository: which request each tool produces.

### Known model divergence

`reference/*.md` describes a slightly richer model than the backlog stores — the **Clause**
index, which has no record type. `reference/datastore.md` records it in full. Where they
disagree, the backlog wins, because it is the thing that accepts the write.
