# superdev

A Claude Code plugin that turns ideas into working code through gated stages, recording what was
decided in the catalog backend (`apps/backend`) rather than in
scattered prose — and then letting agents **pull that work back out**, one well-defined item at
a time. Follows the principles of ATDD and the Agile SDLC.

The plugin is self-contained: it ships the MCP server that reaches the catalog, so installing
superdev is the whole setup bar a key.

Two ways to use it. **Driven**, where you run the skills in order and the catalog records what
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

Autonomous, the catalog deciding:

```
        plan files work        ┌──────────── nothing ready ────────────┐
              │                │                                       │
              ▼                ▼                                       │
   ┌──→  catalog_claim_work ───┴──→ read the brief ──→ do the work ──→ │
   │              (a lease)            (intent, stories, criteria)     │
   │                                          │                        │
   │                                    heartbeat ⟲                    │
   │                                          │                        ▼
   └──────── next item ←─── finish ←──── push progress            report and stop
```

| Skill | What it does | What it writes |
|---|---|---|
| **init** | Bootstraps an empty catalog — derives the Product and Capabilities from an existing project, or interviews you when it's fresh. Run once | `product`, `capability` |
| **brainstorm** | Refines an idea one question at a time into User Stories | `story` |
| **plan** | Turns stories into Features, links them to Capabilities, and writes the Acceptance Criteria that define *how*. May add `proposed` Capabilities, never scores them | `feature`, `acceptance_criterion`, links |
| **recalibrate** | Scores the Capabilities — promotes `proposed` ones, rebalances VBO across the product, redraws boundaries, deprecates. The only skill that sets a `vbo` | `capability` |
| **execute** | Builds the code in a git worktree, one Task per criterion, via agent teams | code, a PR |
| **evaluate** | Verifies every in-scope criterion against real test output, and gates the PR | `ac_evaluation` |
| **work** | Runs the loop: claim work addressed to your role, do it, push progress, finish, next | `work_item`, `work_item_note` |

`init` runs **exactly once per repository** to seed the catalog; everything downstream assumes a
Product and its Capabilities already exist. It refuses to run a second time — a second product
would silently split the catalog, and nothing in the schema prevents it. Changing capabilities
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
catalog_claim_work  product_key=reelmates
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
sees `catalog_update_acceptance_criterion`. That is a surface, not a boundary: RLS is still what
refuses, and if the catalog is unreachable at startup the full menu is offered and the database
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

The server is launched with **`node`**, which is the only thing this plugin needs on your PATH.
It ships as a single bundle with its dependencies inlined, so there is nothing to install.

Then configure a key, at whichever scope fits. `superdev:connect` walks through the whole of
this section interactively — which scope, how to get a key, and how to check it took. Highest
precedence first:

| | Where | Good for |
|---|---|---|
| 1 | `SUPERDEV_API_URL` / `SUPERDEV_API_KEY` in the environment | CI, one-off runs |
| 2 | `<project>/.superdev/config.json` | a repository that works as one role |
| 3 | `~/.superdev/config.json` | your keys, wherever you are |

Levels merge **field by field**, so the arrangement most people want works: keys belong to you,
the role belongs to the repository.

```json
// ~/.superdev/config.json          (mode 0600; config.json is gitignored, product.json is not)
{ "api_url": "https://pando-catalog-api.fly.dev",
  "keys": { "engineer": "pcat_live_…", "product-manager": "pcat_live_…" } }

// <project>/.superdev/config.json
{ "role": "engineer" }
```

### Getting a key

**If you have an account, issue your own key at
[superdev-portal.vercel.app](https://superdev-portal.vercel.app).** Sign in by emailed link, pick
the product and the role, and the key is shown once — only its hash is stored, so it cannot be
read back. You can revoke any key from the same page.

**Accounts themselves are still created by hand**, because the isolation a public signup would
have to promise is not finished — see [what is not true yet](#what-is-not-true-yet). The portal
issues keys; it does not create accounts. If you want one:

**[Request access →](https://github.com/pando-codes/superdev-plugin/issues/new?template=access-request.yml)**

You get back an account with a product in it, and a walk through `init` if you want one.

If you operate your own catalogue, a key is minted per holder with the owner database credential
this plugin deliberately does not hold:

```sh
cd apps/backend
DATABASE_URL=… bun run mint-key --role agent_engineer --label "alex laptop" --product reelmates
```

The key is printed once and only its hash is stored. Losing it means minting a replacement and
revoking the old one.

**With nothing configured the server still starts.** It registers every tool, and every one of
them answers with the setup instructions — naming all three places it looked, on this machine —
rather than doing anything. It holds no key, so it sends nothing anywhere. This is deliberate:
the server used to exit, and a session with no `catalog_*` tools in it is indistinguishable from
a broken install, several steps from the cause, with the one message that would have explained
it discarded by the process that wrote it. Tools that are present and complaining are a missing
key; tools that are absent are a server that did not start at all.

Configuration is read **once, at startup**. A key written while a session is running takes
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
.claude-plugin/plugin.json    declares the bundled MCP server
mcp/
  src/                        the server — client, tools, schema resources
  dist/stdio.js               the committed single-file bundle, what actually runs
  test/                       request-shape, surface, and bundle tests
schemas/                      the five entity JSON Schemas, served as MCP resources
reference/                    the entity model — what a good record looks like
  user-story.md     capability.md    feature.md
  acceptance-criteria.md             clause.md
  datastore.md      how to reach the catalog and what it will accept
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

`skills/connect/` is the one skill that is not part of the workflow: it is the first-run path,
and the path back from a revoked key. It is what an unconfigured server's instructions are
pointing at.

## What is not true yet

Said here rather than discovered later, because some of it decides whether this is a reasonable
thing for you to depend on right now.

- **The hosted catalogue is invite-only, and that is a technical fact rather than a marketing
  one.** Its schema has no account entity: a key is scoped to a *product*, and each account is
  provisioned by hand so that scoping lines up with a customer boundary. Self-serve signup opens
  when the account entity does, and not before.
- **The plugin and the API are versioned separately and deploy separately.** Your copy is a git
  checkout that changes when you update it; the API changes when it is deployed. What `/v1`
  promises is written down in `docs/guides/releasing.md`, and additions are the only change it
  permits.
- **One region, one machine, no SLO, no status page.** Every deploy is a short gap in service.
- **No terms of service, privacy policy, or DPA yet.** They are being written. Until they exist,
  do not put anything in the catalogue that would need them.

## The catalog server

`mcp/dist/stdio.js` is committed, and that is deliberate. A plugin installed from GitHub is a
git checkout — no install step runs, so there is no `node_modules` for an import to resolve
against. The bundle inlines its two dependencies, so the plugin works the instant it is cloned.

It is built `--target=node` and launched with `node`, so **`bun` is a development dependency of
this repository and not a requirement of installing the plugin**. Nothing in `mcp/src` calls a
Bun API — the server speaks `fetch`, `node:fs`, `node:os`, and `node:path` — so the runtime was
only ever a build flag, while requiring Bun on a stranger's PATH made the most likely failure of
a public install an MCP server that never connects. `bundle.test.ts` drives the committed bundle
with whatever interpreter `plugin.json` names, so going back to a Bun-only bundle is a red test.

A committed build artifact is a stronger thing to ask you to trust than an ordinary dependency:
there is no registry, no version, and no lockfile standing between whoever pushed it and what
runs on your machine. What that is worth being clear about:

- **`mcp/src` ships beside `mcp/dist` in this repository**, so the program you execute and the
  source it was built from arrive together and you can read the second.
- **CI rebuilds the bundle from that source on every change and compares it byte for byte.** The
  comparison runs on a pinned bun against a frozen lockfile, because a different bun emits a
  different and perfectly correct bundle.
- **You cannot currently reproduce that comparison yourself from this repository**, because the
  lockfile and the pinned toolchain live in the source repository this one is mirrored from. That
  is a real gap rather than a detail, and closing it means publishing a digest built from a tag —
  it is tracked, not forgotten.

If you are evaluating this and that matters to you, say so in an access request and you will get
the commit and the lockfile to check against.

It holds **one API key per role** and speaks HTTPS to the catalog API. It holds no database credential:
a local plugin is the least trustworthy link in the chain, so compromising it yields a key
scoped to a single role and revocable with one `UPDATE`, not a Postgres login. Authority is
decided by the database — your key carries one role, and a refusal is a normal answer rather
than a fault. Ask `catalog_whoami` when a write is refused.

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

`reference/*.md` describes a slightly richer model than the catalog stores — the **Clause**
index, which has no record type. `reference/datastore.md` records it in full. Where they
disagree, the catalog wins, because it is the thing that accepts the write.
