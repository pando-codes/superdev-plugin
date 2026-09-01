---
name: connect
description: You MUST use this when the backlog_* tools are missing from the session, when they answer with a credential error, or when the user asks to configure, connect, or re-key superdev. Walks through exporting the right grants into the right shell and verifying them, and diagnoses the case where the tools never appeared at all.
---

# Connecting to the Backlog

Every other superdev skill reads and writes a backlog it reaches over HTTPS. The plugin ships no
code and holds no key: it is a manifest naming four URLs, and each one carries a credential read
from an environment variable. This skill is what gets those credentials into place.

It is the first-run path, and it is also the path back from a revoked grant, an expired one, or a
machine that should be working a different product than it is.

**Announce at start:** "I'm using the Connect skill to configure this machine's backlog access."

## The one fact that explains almost every failure

**Claude Code expands `${VAR}` in an MCP manifest only from the shell that launched it.** Not from
`.claude/settings.json`'s `env` block, not from `.env`, not from anything per-repository — even
though a `settings.json` `env` value *does* reach the session and *will* show up in `printenv`.
This was tested, not assumed; the method is in `docs/designs/effort-http-mcp-transport.md`,
Appendix A.

Two consequences you will use constantly:

- **The export must happen before `claude` starts.** Exporting in a shell *inside* a running
  session changes nothing about that session. The fix always ends in a restart.
- **Nothing per-repository can travel this way.** Which product a credential is for is on the
  credential itself, not in any file the user can edit. A machine that works two products holds
  two sets of grants.

## Step 0: Find out what is actually wrong

There is no `backlog_doctor` tool, and deliberately so — a diagnostic reached over the connection
it exists to diagnose answers nothing in the one case it is for. Diagnose locally instead.

**Run this first**, from the user's own shell:

```sh
claude mcp list 2>&1 | grep -i backlog
```

Read it literally. It distinguishes the three failures that otherwise look identical:

| What you see | What it means | Where to go |
|---|---|---|
| `✔ Connected` on all four | Working. Confirm with `backlog_whoami` and **stop** | — |
| `Missing environment variables: SUPERDEV_GRANT_…` | The variable is not exported in the shell that launched Claude Code | Step 1 |
| Listed, not connected, no missing-variable warning | A credential is present and the server refused it | Step 2 |
| Not listed at all | The plugin is not installed or not enabled | `/plugin`, not this skill |

Then call `backlog_whoami`. If the tools are not in the session at all, that is not a tool
failure — it is Step 0 above, because a connection refused at `initialize` produces a server with
no tools rather than tools that return errors.

## Step 1: Get the grants

**Three grants, one per role, each naming one role and one product.** This is not overhead to
work around — a connection holds one authority for its whole life, and both halves of that
authority have to be unambiguous before the first call. A grant that allows two roles, or that
names no product, is refused at connect with a 403 and its tools never appear.

**From the portal**, under **Machines** — sign in by emailed link, name the machine, choose the
product, and issue the set:

```
https://superdev-portal.vercel.app
```

**Or from a checkout of this repository**, once per role:

```sh
cd apps/backend
bun run mint-grant --org <account> --product <product> \
  --roles agent_product_manager --label "<machine>"
bun run mint-grant --org <account> --product <product> \
  --roles agent_engineer --label "<machine>"
bun run mint-grant --org <account> --product <product> \
  --roles agent_quality_assurance --label "<machine>"
```

Each prints its value **once** and tells you which variable it belongs in. If the user has no
account, the hosted backlog is invite-only — the portal issues credentials, it does not create
accounts. Give them the link and stop:

```
https://github.com/pando-codes/superdev-plugin/issues/new?template=access-request.yml
```

## Step 2: Export them, in the right shell

Put them in the file that runs before `claude` does — `~/.zshrc`, `~/.bashrc`, or whatever the
user's shell reads at login. **Never** write a credential into a repository, a
`.claude/settings.json`, or anything a `git add` could reach.

```sh
export SUPERDEV_GRANT_PRODUCT_MANAGER='pcat_live_…'
export SUPERDEV_GRANT_ENGINEER='pcat_live_…'
export SUPERDEV_GRANT_QUALITY_ASSURANCE='pcat_live_…'

# Optional. The unpinned `backlog` server, for the main thread and for driving
# the skills by hand. Any single-role, product-scoped grant works; give it the
# role you want to act as when you are not inside an agent.
export SUPERDEV_GRANT='pcat_live_…'
```

Then **restart Claude Code**. Say so explicitly — the session's environment was fixed when it
launched, and every symptom will persist until it is restarted, which reads as "the fix did not
work."

## Step 3: Verify

```sh
claude mcp list 2>&1 | grep -i backlog
```

All four `✔ Connected`, then `backlog_whoami` in the session. It should report the role the
namespace implies and the product the grant names. If it reports a *different* role than you
expect, the grant in that variable is for another role — the endpoint reads the role off the
credential, never off the URL, so the variable and the credential have drifted apart.

## Reading a refusal

Both refusals below are refusals of the **connection**, so the symptom is always "the tools are
missing", never "a tool returned an error".

| Message | Cause | Fix |
|---|---|---|
| `must have exactly one` role | The grant allows several roles. Legal, and still fine for `/v1/agents/register`, but a session cannot use it | Mint one grant per role |
| `names no product` | An org-scoped grant, the pre-050 shape | Re-mint with `--product` |
| `this endpoint is X and the presented grant is Y` | The right grant is in the wrong variable | Swap them |
| `invalid, revoked, or expired` | Unknown, revoked, or lapsed — deliberately indistinguishable | Mint a replacement |

A grant lasts up to 365 days and the keys it mints last twelve hours, refreshed by the server
without anyone noticing. So the credential that will eventually stop working is the **grant**, and
when it does, every agent on the machine stops at once with a 401 that cannot say why. That is
what the expiry printed at mint time is for.

## What this skill cannot do

It cannot put a credential anywhere for the user, and should not try. Every step above is a change
to the user's own shell profile, and a skill that edited one would be writing a secret into a file
it cannot see the rest of. Show the exact lines; let them paste.
