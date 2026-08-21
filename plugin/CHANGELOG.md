# Changelog — the superdev plugin

What changed in the thing you installed, and what you have to do about it.

This is the plugin's history, not the project's. The catalogue API is deployed separately and on
its own schedule; where a plugin release needs a particular API behaviour to be live, the entry
says so under **Requires**.

Versions mean what `docs/guides/releasing.md` says they mean: **major** if a tool was removed,
renamed, or had an argument's meaning changed — which breaks the agent definitions by name;
**minor** for a new tool, skill, or argument, or a materially rewritten tool description;
**patch** for anything that changes no tool's name, arguments, or contract.

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
