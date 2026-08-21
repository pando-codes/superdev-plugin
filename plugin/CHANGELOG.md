# Changelog — the superdev plugin

What changed in the thing you installed, and what you have to do about it.

This is the plugin's history, not the project's. The catalogue API is deployed separately and on
its own schedule; where a plugin release needs a particular API behaviour to be live, the entry
says so under **Requires**.

Versions mean what `docs/guides/releasing.md` says they mean: **major** if a tool was removed,
renamed, or had an argument's meaning changed — which breaks the agent definitions by name;
**minor** for a new tool, skill, or argument, or a materially rewritten tool description;
**patch** for anything that changes no tool's name, arguments, or contract.

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
