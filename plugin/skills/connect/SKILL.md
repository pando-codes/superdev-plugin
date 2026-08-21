---
name: connect
description: You MUST use this when the catalog_* tools answer with setup instructions instead of data, when they are missing from the session entirely, or when the user asks to configure, connect, or re-key superdev. Walks through putting an API key at the right scope - environment, project, or user - and verifying it.
---

# Connecting to the Catalog

Every other superdev skill reads and writes a catalog it reaches over HTTPS with one API key.
This skill is the one that gets that key into place.

It is the first-run path, and it is also the path back from a revoked key, a rotated URL, or a
repository that should be working as a different role than your laptop does.

**Announce at start:** "I'm using the Connect skill to configure this project's catalog key."

## Step 0: Find out what is actually wrong

Call `catalog_whoami` and read the answer literally. Four outcomes, and they need four different
things:

| What you get back | What it means | Where to go |
|---|---|---|
| A role and a write scope | Already configured. **Stop.** Report the role and the scope, and do not rewrite a working config | — |
| Setup instructions naming three paths | No key was found anywhere. This is the fresh-install case | Step 1 |
| `401` / "the catalogue rejected this API key" | A key exists but the catalog will not accept it — revoked, expired, or from another environment | Step 1, with a replacement key |
| The `catalog_*` tools are not in the session at all | The MCP server is not running, which is **not** a key problem | See "When there are no tools at all" |

When the answer is setup instructions, **show them to the user verbatim before doing anything
else**. They name the exact three paths that were consulted on *this* machine, which is more
specific than anything this document can say.

## Step 1: Decide which scope the key belongs at

Configuration resolves at three levels, highest precedence first, and levels merge **field by
field** rather than the highest one winning outright:

| | Where | Good for |
|---|---|---|
| 1 | `PANDO_CATALOG_API_URL` / `PANDO_CATALOG_API_KEY` in the environment | CI, a container, one-off runs |
| 2 | `<project>/.superdev/config.json` | a repository that works as one role |
| 3 | `~/.superdev/config.json` | your keys, wherever you are |

The per-field merge is what makes the arrangement most people want possible, so recommend it by
default:

- **Keys belong to the person.** They go user-scope, in `~/.superdev/config.json`, because a
  credential minted for a human follows that human between repositories.
- **The role belongs to the repository.** It goes project-scope, in
  `<project>/.superdev/config.json`, because "this checkout works as the engineer" is a fact
  about the checkout and should be the same for everyone in it.

```json
// ~/.superdev/config.json          — yours, mode 0600
{ "api_url": "https://pando-catalog-api.fly.dev",
  "keys": { "engineer": "pcat_live_…", "product-manager": "pcat_live_…" } }

// <project>/.superdev/config.json  — the repository's
{ "role": "engineer" }
```

A declared role picks its own key out of `keys`. Ask before choosing one for the user: a key
carries exactly one role, the roles differ deliberately, and `engineer` — which can hold and
report on work but cannot author criteria or grade its own output — is the right default for a
repository whose agents build.

`SUPERDEV_ROLE` in the environment does the same thing for one session. It can only ever
**narrow** what is offered: running a planner key as `SUPERDEV_ROLE=engineer` gets the
engineer's menu, and running an engineer key as `SUPERDEV_ROLE=product-manager` also gets the
engineer's menu, because the key is what the database will honour.

## Step 2: Get a key, without it passing through this session

**Never ask the user to paste a key into the conversation, and never echo one you have seen.**
A transcript is not a secret store, and a key that appears in one has to be treated as
compromised and re-minted.

Instead, tell them where the key comes from and let them put it in place themselves:

Where a key comes from depends on whose catalog it is, and the two cases have different answers.
Ask which one applies before giving either.

**The hosted catalog, and the user has an account.** Send them to the portal, where they issue
the key themselves:

```
https://superdev-portal.vercel.app
```

Sign in by emailed link, pick the product, pick the role, and the key is shown **once**. This is
the common case and it should be offered first — a person whose key has lapsed, or who is setting
up a second machine, does not need to ask anyone.

Tell them two things while they are there, because both are easy to discover the hard way: the key
is shown exactly once and only its hash is stored, so it cannot be read back; and the plugin reads
its configuration once at startup, so the session has to be restarted afterwards.

**The hosted catalog, and the user has no account.** Accounts are created by hand while the beta
is invite-only — the portal issues keys, it does not create accounts. Give them the link and stop:

```
https://github.com/pando-codes/superdev-plugin/issues/new?template=access-request.yml
```

**Their own catalog.** Minting is an operator action, run by whoever holds the owner database
credential:

```sh
cd apps/backend
DATABASE_URL=… bun run mint-key --role agent_engineer --label "<who>" --product <product>
```

The key is printed **exactly once** and only its hash is stored. Losing it means minting a
replacement and revoking the old one — there is no way to read it back.

If the user holds neither the credential nor an invitation, the answer is not a workaround. Give
them the link above, or say who they need to ask, and stop.

## Step 3: Write the file at the right scope

You may create the file and its structure. Two rules:

1. **Mode 0600.** The server checks on load and warns on stderr about a file other users on the
   machine can read. Create the directory and file, then `chmod 600` the file.
2. **Ignore the file, not the directory.** Add `.superdev/config.json` to the repository's
   `.gitignore`. Do **not** add `.superdev/` — `superdev:init` writes `.superdev/product.json`
   next to it, which binds the repository to its product and is exactly the kind of thing the
   whole team should share. Ignoring the folder makes that binding per-checkout, and the first
   symptom is a teammate's `init` creating a second product.

Leave the key itself to the user: write the file with every other field in place, then tell them
which line to fill in and with what.

## Step 4: Restart the session, then verify

**The server reads its configuration once, at startup.** A key written into a file while a
session is running changes nothing for that session — the tools will keep answering with the
same setup instructions until the MCP server is restarted, which for Claude Code means
restarting the session.

Say that plainly, then after the restart:

1. Call `catalog_whoami`. Report `pando_role`, `writes.product_key`, and `agent_id`.
2. If the role is not the one the repository asked for, **stop and say so**. The key decides,
   not the config file, and every write will be refused on the basis of what the key carries.
3. If a product scope is named, say which product it is. A key scoped to another repository's
   product reads fine and writes nothing.

## When there are no tools at all

If `catalog_*` is missing from the session entirely, no key would fix it — the server is not
running. In order:

- The plugin is installed: `/plugin marketplace add pando-codes/pando-plugins` then
  `/plugin install superdev@pando-plugins`.
- `node` is on `PATH`. The bundled server is launched with it, and a shell where `node` cannot
  be found produces exactly this symptom.
- The server's own stderr, in the MCP server logs, says which of those it is.

An unconfigured server is *not* this case: it starts, registers all of its tools, and answers
every call with instructions. Tools that are present and complaining are a Step 1 problem; tools
that are absent are this one.

## Running a fleet

Several agents on one machine each need their own identity, not just their own key:

```sh
SUPERDEV_ROLE=engineer          SUPERDEV_AGENT_ID=builder-1  claude
SUPERDEV_ROLE=engineer          SUPERDEV_AGENT_ID=builder-2  claude
SUPERDEV_ROLE=quality-assurance SUPERDEV_AGENT_ID=verifier-1 claude
```

A lease is held by an **identity**. Two agents sharing one can release and finish each other's
work, and nothing errors when they do. Within a single session several subagents share one MCP
server and therefore one identity, so pass a distinct `agent_id` on each work tool call instead.

## What this skill must not do

- **Do not put a key anywhere the repository can commit it.** Project scope is a real option,
  but only alongside the `.gitignore` entry from Step 3.
- **Do not work around a refusal.** A 403 from the catalog is the database answering correctly.
  The fix is the right key, never a different tool call.
- **Do not claim a role.** `SUPERDEV_ROLE` and the `role` field pick which key is used and
  narrow what is offered. Authority is whatever the key carries, and `catalog_whoami` is the
  only thing that knows.
