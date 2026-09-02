---
name: connect
description: You MUST use this when the backlog_* tools are missing from the session, when they answer with a credential error, or when the user asks to configure, connect, bind, or re-key superdev in a repository. Binds this project to a product by writing its .mcp.json, and diagnoses the case where the tools never appeared at all.
---

# Binding a Project to the Backlog

Every other superdev skill reads and writes a backlog it reaches over HTTPS. The plugin ships no
code, holds no key, and declares no MCP servers: a repository gets them by being **bound to a
product**, which is what this skill does.

It is the first-run path in every new repository, and it is also the path back from a revoked or
expired identity, or a project that should be working a different product than it is.

**Announce at start:** "I'm using the Connect skill to bind this project to a product."

## What binds a project

superdev is **product-scoped**, and a repository is where a product lives. So the credential is
per-project, not per-machine: a **product identity** is issued for one product, and it goes in that
repository's own `.mcp.json`.

Nothing is bound until you do this. A fresh install of superdev has skills and agents and **no
backlog tools at all** — which is correct, because a repository nobody has bound to a product has
no backlog to reach.

**Why not an environment variable.** Claude Code expands `${VAR}` in an MCP manifest only from the
shell that launched it — not from `.claude/settings.json`, not from anything inside a repository,
even though a `settings.json` `env` value does reach the session and shows up in `printenv`. This
was tested, not assumed; the method is in `docs/designs/effort-http-mcp-transport.md`, Appendix A.
A shell variable is therefore machine-global, and a machine working two products needs two
identities. So the credential goes in the file, as a literal, and the file is ignored by git.

## Step 0: Find out what is actually wrong

There is no `backlog_doctor` tool, and deliberately so — a diagnostic reached over the connection
it exists to diagnose answers nothing in the one case it is for. Diagnose locally instead, from the
project directory:

```sh
ls .mcp.json 2>/dev/null && echo "bound" || echo "not bound"
claude mcp list 2>&1 | grep -i backlog
```

| What you see | What it means | Where to go |
|---|---|---|
| No `.mcp.json`, no `backlog` servers | This repository is not bound to a product yet | Step 1 |
| Servers listed, `✔ Connected` | Working. Confirm with `backlog_whoami` and **stop** | — |
| Servers listed, not connected | A credential is present and the server refused it | "Reading a refusal" |
| `⏸ Pending approval` | Project-scoped servers need approving once, interactively | Run `claude` and approve |

If the `backlog_*` tools are missing from a session, that is Step 0 — not a tool failure. A
connection refused at `initialize` produces a server with no tools rather than tools that error.

## Step 1: Get a product identity for this project

**One credential, naming one product and carrying a ceiling of roles** — planner, builder,
verifier. The ceiling is enforced by the database; each of the four servers binds one role from the
URL it is declared at, so a builder still cannot act as a planner and none of them can reach
another product.

### If a user identity is available, mint one here

A **user identity** is the tier above: a credential that signs product identities for products in
its account and can read or write nothing itself. It is kept in the user's shell profile because it
belongs to the person rather than to any repository.

```sh
[ -n "$SUPERDEV_USER_IDENTITY" ] && echo "available" || echo "not set"
```

If it is set, bind this project without sending anyone to a browser:

```sh
curl -sS -X POST https://pando-catalog-api.fly.dev/v1/identities \
  -H "authorization: Bearer $SUPERDEV_USER_IDENTITY" \
  -H 'content-type: application/json' \
  -d '{"product_key":"<product>","roles":["agent_product_manager","agent_engineer","agent_quality_assurance"],"label":"<machine>"}'
```

The response's `identity` field is the credential, and it exists **once** — it is not stored
anywhere and cannot be read back. Write it straight into `.mcp.json` in Step 2. Do not echo it, do
not put it in a scratch file, and do not repeat it back to the user: this output goes into a
transcript by construction.

If the product does not exist yet, the answer is a 403 naming the account — create it in the portal
first, or with `backlog_create_product` from a project that is already bound.

### Otherwise, the user issues one

**From the portal**, under **Product identities** — sign in by emailed link, choose the product,
name the machine, and issue it:

```
https://superdev-portal.vercel.app
```

**Or from a checkout of the superdev repository:**

```sh
cd apps/backend
bun run mint-grant --org <account> --product <product> \
  --roles agent_product_manager,agent_engineer,agent_quality_assurance \
  --label "<machine>"
```

The **first** role is the primary one — what the unpinned `backlog` server acts as. Name the
planner first unless you want otherwise. The value prints **once**.

If the user has no account, the hosted backlog is invite-only. Give them the link and stop:

```
https://github.com/pando-codes/superdev-plugin/issues/new?template=access-request.yml
```

## Step 2: Write it into this project

Create `.mcp.json` at the repository root, with the identity as a literal. The four entries and
their URLs come from `servers.json` in the plugin — copy them exactly; the server **names** are
what every agent's frontmatter addresses, and renaming one gives that agent no tools.

```json
{
  "mcpServers": {
    "backlog": {
      "type": "http",
      "url": "https://pando-catalog-api.fly.dev/mcp",
      "headers": { "Authorization": "Bearer pcat_live_…" }
    },
    "backlog-product-manager": {
      "type": "http",
      "url": "https://pando-catalog-api.fly.dev/mcp/product-manager",
      "headers": { "Authorization": "Bearer pcat_live_…" }
    },
    "backlog-engineer": {
      "type": "http",
      "url": "https://pando-catalog-api.fly.dev/mcp/engineer",
      "headers": { "Authorization": "Bearer pcat_live_…" }
    },
    "backlog-quality-assurance": {
      "type": "http",
      "url": "https://pando-catalog-api.fly.dev/mcp/quality-assurance",
      "headers": { "Authorization": "Bearer pcat_live_…" }
    }
  }
}
```

The same value in all four. They differ only by URL, and the URL is what binds the role.

**Then ignore it.** This file contains a live credential:

```sh
grep -qxF '.mcp.json' .gitignore || echo '.mcp.json' >> .gitignore
```

Do this in the same step, not afterwards. A `.mcp.json` is ordinarily a committed, shared file —
that is what project scope is for — and this one is the exception because it carries a secret. An
identity that reaches a public repository has to be revoked and reissued.

**Restart Claude Code**, then approve the servers when prompted: project-scoped servers are
approved once, interactively, and that prompt is the only thing standing between a checked-out
repository and a server definition you did not write.

## Step 3: Verify

```sh
claude mcp list 2>&1 | grep -i backlog
```

Four `✔ Connected`, then `backlog_whoami` in the session. It should report the product the identity
names, and the role the namespace implies — `mcp__backlog-engineer__*` is the engineer whatever
else is in the session, because the role is bound by the endpoint's URL.

## Reading a refusal

Both refusals below are refusals of the **connection**, so the symptom is always "the tools are
missing", never "a tool returned an error".

| Message | Cause | Fix |
|---|---|---|
| `is still the literal text ${...}` | A `${VAR}` was left in `.mcp.json` and never expanded. Put the credential in as a literal | Step 2 |
| `names no product` | An org-scoped credential — a user identity, or the pre-050 shape | Issue a **product** identity for this repository |
| `this endpoint is X, and this identity carries …` | The identity's ceiling does not include the role that endpoint binds | Re-issue naming all three roles |
| `invalid, revoked, or expired` | Unknown, revoked, or lapsed — deliberately indistinguishable | Issue a replacement |

A product identity lasts up to 365 days and the keys it mints last twelve hours, refreshed by the
server without anyone noticing. So the credential that will eventually stop working is the
identity, and when it does every agent on the machine stops at once with a 401 that cannot say
why. That is what the expiry printed at issue time is for.

## What this skill cannot do

It cannot obtain a credential from nothing. With a **user identity** it can sign one, because that
is precisely what a user identity is for and the ceiling is enforced by the database rather than by
this skill's good behaviour. Without one, issuing requires the portal or a database credential this
plugin deliberately does not hold, and Step 1 is the user's.

What it must never do: invent or guess a credential, reuse one from another project, or print one.
A credential that reaches a transcript is a credential to revoke.
