# Changelog — the superdev plugin

What changed in the thing you installed, and what you have to do about it.

This is the plugin's history, not the project's. The catalogue API is deployed separately and on
its own schedule; where a plugin release needs a particular API behaviour to be live, the entry
says so under **Requires**.

Versions mean what `docs/guides/releasing.md` says they mean: **major** if a tool was removed,
renamed, or had an argument's meaning changed — which breaks the agent definitions by name;
**minor** for a new tool, skill, or argument, or a materially rewritten tool description;
**patch** for anything that changes no tool's name, arguments, or contract.

## 0.10.0 — 2026-09-01

**Breaking. Every tool and every MCP server is renamed.** By the rule above this is a *major*
change — tools were renamed, which breaks agent definitions by name. It ships as `0.10.0` rather
than `1.0.0` because the leading zero is doing exactly the job it exists for: the backlog is
invite-only beta, and `1.0.0` would promise a stability this has not earned yet. The break is
announced here, loudly, rather than encoded in a digit.

### What you must change

In any custom agent definition or settings file:

    mcp__plugin_superdev_catalog__catalog_X   →   mcp__plugin_superdev_backlog__backlog_X

The four servers are now `backlog`, `backlog-product-manager`, `backlog-engineer` and
`backlog-quality-assurance`. All forty tools take the `backlog_` prefix, with one exception:
`catalog_public_catalog` is now **`backlog_public_view`**, because `backlog_public_backlog` is not
a name.

An agent you do not update keeps working. It silently has fewer tools than it was written to have,
which presents as an agent that "just doesn't use" a capability — the failure this repository's own
`agents.test.ts` exists to prevent internally and cannot prevent for you.

The three shipped agents are already updated. If you use those and nothing of your own, there is
nothing for you to do.

### What did not change

Nothing about credentials. Keys still begin `pcat_`, no key needs reissuing, and both `SUPERDEV_*`
and the deprecated `PANDO_CATALOG_*` environment variables are still read. The API host is still
`pando-catalog-api.fly.dev` — it is in every issued key's `api_url`, so it cannot move.

`GET /v1/products/:productKey/catalog` also keeps its name. A path served under `/v1` is permanent;
renaming it would 404 every installed copy of this plugin the moment the backend deployed. The tool
in front of it is `backlog_public_view`, which is the name you actually address.

### Requires

The backend deploy that carries migration `048`, which renames the view behind
`backlog_public_view`. Migrations go **first** for this release — a new API against the old schema
500s on that one route. Until the backend is deployed, `backlog_public_view` is the only tool
affected; everything else works against the old and new schema alike.

## 0.9.2 — 2026-08-26

**Patch**: no tool's name, arguments, or contract changed. `catalog_doctor` stopped reporting
problems on machines that have none.

### Fixed

- **`catalog_doctor` no longer calls a healthy install broken.** `plugin.json` declares each
  server's environment as `"NAME": "${NAME}"`, which is how a plugin says "pass this through if
  the user exported it". Almost nobody exports them, so the host passes eight literal
  placeholders through — and the doctor reported every one of them as a problem reading *"it
  BEATS the config file it was meant to defer to, so the file is being silenced."*

  That sentence was true in 0.6.0 and has been false since `withoutUnexpandedPlaceholders`
  landed: the scrub runs in `stdio.ts` before anything reads a credential, and again inside
  `loadConfig` and `loadGrant`, so the file wins. The message outlived the defect it described.

  The cost was not just a wrong sentence. `nextStep` branches on whether `problems` is empty, so
  a machine with a good grant and nothing wrong with it was told *"fix the problems above"* and
  never got the advice it needed — bind this repository, or call `catalog_whoami`. Three of the
  eight also came back a second time through the credential inventory, as `SUPERDEV_API_KEY is
  not shaped like a credential`, which sends a reader to inspect a key they never set.

  An unexpanded placeholder is now what it actually is: an unset variable, listed once under
  `ENVIRONMENT` as `IGNORED, files still win`, and not a problem. A placeholder that ever *does*
  silence a file would be caught by the regression tests in `config.test.ts`, `grant.test.ts`,
  and `doctor.test.ts` — which is where that guarantee belongs, rather than in a warning printed
  to everyone whether or not it applies.

## 0.9.1 — 2026-08-25

**Patch**: no tool's name, arguments, or contract changed. One file stopped shipping.

### Fixed

- **This plugin no longer ships a journal from the machine it was built on.**
  `.superdev/journal/work-progress.ndjson` held two drained records — `did a thing`, against
  the `wi_a1b2c3` fixture — swept into a commit during 045's development because the journal is
  written under `CLAUDE_PROJECT_DIR`, which falls back to the working directory when a tool is
  driven by hand. It has been in every release since 0.7.0.

  Harmless in this instance: the payloads were test text, no credential was in it, and the
  cursor said both records were already sent. Not harmless in principle — a journal is an
  outbox of writes that have **not** reached the catalogue, so shipping one hands every
  installer somebody else's pending records, which `catalog_drain_journal` would then try to
  send. If you have installed 0.7.0, 0.8.0, or 0.9.0 and never ran a drain from the plugin's own
  directory, nothing happened; the file is simply gone now.

  `.superdev/journal/` and `.superdev/cache/` are ignored here as well as at the repository
  root, and `bundle.test.ts` now asserts neither is tracked — the mirror image of the assertion
  that keeps `mcp/dist/stdio.js` in the index, and for the same reason: an ignore rule does not
  untrack a file already in it.

## 0.9.0 — 2026-08-25

**Minor**, by `docs/guides/releasing.md`'s rule: a new tool. `catalog_doctor` is added and no
existing tool's name, arguments, or contract changed.

**Requires migrations 046-047** (live in production since 2026-08-25) **and the API deployed
after them.** The grant-expiry warning is silent against an older API rather than wrong — it
warns about nothing when the server sent nothing — so this plugin is safe to install before that
deploy lands. `catalog_doctor` needs no API at all and works with no credential.

### Added

- **`catalog_doctor`** — the one tool that works when nothing else does. It reports which files
  and environment variables this machine holds, which credentials are in them (prefixes only),
  and what each of the four servers would actually run on. It makes **no network call**: the
  states most worth diagnosing include a catalogue that cannot be reached, and a diagnostic that
  hangs in exactly that case is not one. Call it first whenever a catalog tool answers with setup
  instructions, returns 401, or is missing from the session.
- **A warning when the machine's orchestrator grant is about to expire**, for the last thirty
  days. Longer than the fourteen a key gets, because a key stops one agent and a grant stops
  every agent on the machine at once — and grants minted in the same week expire in the same
  week, so a team onboarded together stops together.

### Changed

- **The unpinned `catalog` server now uses your orchestrator grant** when no `api_key` is
  configured, registering as the role `.superdev/config.json` declares and defaulting to
  `product-manager`. If you have a grant and no `config.json` — which is exactly what
  `mint-grant` leaves behind — that server used to be the only one that did not work.
- **A repository with no product binding now offers `catalog_bind_repository` from the unpinned
  server too**, so the main thread, where `superdev:init` actually runs, can bind a checkout.
- **An unconfigured server narrows its tool menu by a `role` in `config.json`**, not only by
  `SUPERDEV_ROLE`.
- **`superdev:connect` opens with `catalog_doctor`.**
- The three shipped agents list `catalog_doctor` in their `tools:` frontmatter.

### Fixed

- **The "no api_key configured" message no longer sends you to mint a credential you already
  have.** It now says whether an orchestrator grant is present, and a failed registration says
  the grant was *found and used* rather than implying a key is missing. These were two different
  problems with two different fixes, and the message pointed at neither.
- **A grant that is present but unusable no longer silently falls back** to a `keys.<role>` from
  `config.json`. Only a machine with no grant at all does that. Before, a malformed
  `orchestrator.json` would quietly run your agents on a different credential.

## 0.6.0 — 2026-08-21

### Added

- **Three role-pinned MCP servers**, alongside the one you already have:
  `catalog-product-manager`, `catalog-engineer`, `catalog-quality-assurance`.
  Each is launched with its role fixed in `plugin.json`, registers for that role and no other, and
  holds its own credential. An agent reaches one of them by naming its namespace in `tools:` —
  which means several agents of DIFFERENT roles can now work in one session, which was impossible
  before.
- **Orchestrator grants.** One credential per machine, at `~/.superdev/orchestrator.json`, which
  can read and write nothing and exists only to mint short-lived role-bound keys for the agents on
  that machine. Adding an agent then costs one line of frontmatter — no key to mint, no file to
  write, no restart. See `docs/guides/registering-an-agent.md`.

### Changed

- **The shipped agents address their own role's server.** `superdev-engineer` now names
  `mcp__plugin_superdev_catalog-engineer__*`, the planner and verifier likewise. An agent
  able to reach two role servers is an agent able to choose between two authorities.
- **`superdev:connect` knows about grants** — which of the two credentials is missing, where each
  belongs, and why there is deliberately no project scope for a grant.
- **Your identity can now come from your key.** With a grant, `catalog_whoami` reports
  `agent_id_source: "credential"` and `X-Pando-Agent-Id` is ignored — two agents in one session can
  no longer finish each other's work. Without one, nothing changes.

### Renamed

The project is superdev; the plugin was still calling things `pando-catalog`.

- **Tool ids** are now `mcp__plugin_superdev_catalog__…` and
  `mcp__plugin_superdev_catalog-<role>__…`. If you have written your own agent against these, its
  `tools:` list needs the new names — the old ones no longer resolve to anything.
- **Environment variables** are `SUPERDEV_API_URL`, `SUPERDEV_API_KEY`, `SUPERDEV_GRANT`. The
  `PANDO_CATALOG_*` names still work and warn; nothing you have exported stops working.
- **Log lines** on stderr are prefixed `superdev:`.

`pando-catalog-api.fly.dev` and the `pcat_` key prefix are unchanged — your `api_url` and your keys
are exactly as they were.

### Requires

The catalogue API deployed on or after 2026-08-21 (migration 039 and `POST /v1/agents/register`).
Against an older API the pinned servers report that registration failed and start inert; the
unpinned `catalog` server is unaffected.

### If you are upgrading

**Nothing to do** if `~/.superdev/config.json` names your keys by role:

```json
{ "keys": { "engineer": "pcat_live_…" } }
```

A pinned server uses the key for its own role, which is not an agent choosing a role.

**Something to do** if you have only a bare `api_key`, or export `SUPERDEV_API_KEY`. The
pinned servers will not use either — those carry whatever role they carry — so the three shipped
agents will report that they are unconfigured. Name the key by role as above, or mint a grant.
The unpinned `catalog` server, the skills, and everything you drive by hand are unchanged.

## 0.5.2 — 2026-08-21

### Changed

- **If you have an account, you no longer have to ask anyone for a key.** There is a portal now —
  [superdev-portal.vercel.app](https://superdev-portal.vercel.app) — and an unconfigured server
  points at it *first*, before the access request.

  The order is the change. The common case is not a new user: it is someone whose key has lapsed,
  or who is setting up a second machine, and who has an account already. Sending them to request
  access was sending them to queue behind a human for something they can do in a browser in thirty
  seconds.

  `superdev:connect` now distinguishes three cases rather than two — you have an account, you do
  not, or the catalogue is your own — and tells anyone going to the portal the two things that are
  otherwise learned the hard way: the key is shown exactly once and cannot be read back, and the
  plugin reads its configuration once at startup, so the session has to be restarted afterwards.

  **Accounts are still created by hand.** The portal issues keys; it does not create accounts, and
  the catalogue stays invite-only while the isolation a public signup would have to promise is
  unfinished.

## 0.5.1 — 2026-08-21

### Fixed

- **`superdev:init` works for a key that was issued to you.** It required an *unscoped* key,
  because creating a product needs one — so anyone whose key was scoped to a single product, which
  is what a hosted catalog issues, was stopped on the first screen and told their catalog was
  already initialized. It was not: their product existed and was empty, which is exactly what an
  operator leaves behind after setting up an account.

  `init` now reads `catalog_whoami` first and takes one of two paths. With an unscoped key it
  creates the product as before. With a scoped key it checks whether that product has any
  capabilities, and if it has none, writes the repository binding and goes straight to the
  interview — creating the capabilities, which a scoped key has always been allowed to do.

  Nothing about what the database permits changed. The skill was asking for a privilege it did not
  need.

## 0.5.0 — 2026-08-21

### Added

- **The server now tells you when your key is about to stop working.** At startup it already asks
  the catalogue who it is; that answer now carries the key's expiry, and if it is within 14 days
  the server says so on stderr, next to where it reports which file the key came from.

  This exists because of an asymmetry that cannot be fixed at the other end. When a key does
  lapse, every call fails with `401 invalid, revoked, or expired API key` — deliberately
  ambiguous, because saying which would confirm to a stranger that a key exists. That is right at
  the API boundary and useless to the person whose agent has just stopped. The only moment anyone
  can be told is while the key still works.

  Keys default to 90 days, and keys minted in the same week expire in the same week — so without
  this, a team onboarded together fails together, three months later, with a message that does not
  say why.

- **`catalog_whoami` reports `key.expires_at` and `key.expires_in_days`**, the latter computed
  from the server's clock rather than yours. A machine whose clock has drifted would otherwise
  disagree with the catalogue about whether its own credential is still good.

  **Requires** the backend at migration 035 or later. Against an older one the field is absent and
  the plugin stays silent — it will not warn about a credential on the strength of a field it
  never received.

  A key minted with `--no-expiry` reports `null`, which is a real state and not a missing value.

## 0.4.1 — 2026-08-20

The first release distributed to people outside Pando. No tool changed; what changed is what
happens to someone who has none of Pando's credentials.

### Changed

- **An unconfigured install now points somewhere a stranger can go.** The setup instructions used
  to end at "mint a key with the owner database credential" — a true instruction and an
  unreachable one for anyone who does not hold that credential and has no way to find out who
  does. They now name the access request first, and keep the operator command for people running
  their own catalogue.
- **`superdev:connect` asks whose catalogue it is** before answering where a key comes from, for
  the same reason. The two cases have genuinely different answers and it used to give only one.
- **The product list narrows to your key's scope.** A key scoped to one product now lists that
  product; an unscoped key still lists all of them. Nothing else about the catalogue changed —
  the product row is still resolvable by key, so a write against the wrong product is still
  refused with a message naming the real problem rather than claiming the product does not exist.

  **Requires** the backend at migration 031 or later. An older backend simply behaves as it did.

### Added

- **A statement of what is not true yet**, in the README: invite-only access and why it is a
  technical fact rather than a marketing one, independent versioning of the plugin and the API,
  one region and no SLO, and no terms or DPA yet.
- **An honest account of the committed bundle** — what is checked, by whom, and the one thing you
  cannot currently check yourself.

## 0.4.0 — 2026-08-20

### Added

- **`superdev:connect`** — the first-run path, and the path back from a revoked key.

### Changed

- **The MCP server runs under `node`, not `bun`.** The bundle is built `--target=node` and
  launched with `node`, so installing the plugin no longer requires Bun on your PATH. If the
  server previously failed to appear in your session, this is why.
- **An unconfigured install starts instead of exiting.** It registers all of its tools, and each
  one answers with the setup instructions. Before this, the process exited and the `catalog_*`
  tools were simply absent — indistinguishable from a broken plugin.

## 0.3.0 and earlier

Recorded in the project's internal history rather than here. The short version: 0.3.0 shipped the
work queue — `catalog_claim_work`, `catalog_push_progress`, `catalog_finish_work` and the
`superdev:work` skill — which is what lets several agents pull from one product without colliding.
