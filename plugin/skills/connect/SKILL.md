---
name: connect
description: You MUST use this when the backlog_* tools answer with setup instructions instead of data, when they are missing from the session entirely, or when the user asks to configure, connect, or re-key superdev. Walks through putting an API key or an orchestrator grant at the right scope - environment, project, or user - and verifying it.
---

# Connecting to the Backlog

Every other superdev skill reads and writes a backlog it reaches over HTTPS with one API key.
This skill is the one that gets that key into place.

It is the first-run path, and it is also the path back from a revoked key, a rotated URL, or a
repository that should be working as a different role than your laptop does.

**Announce at start:** "I'm using the Connect skill to configure this project's backlog key."

## Step 0: Find out what is actually wrong

**Call `backlog_doctor` first.** It is the only tool that works when nothing else does — it reads
this machine's files and environment, makes no network call, and prints which credential each of
the four servers would run on. Show its output to the user; every fix it names is a file on their
machine and only they can apply it.

It answers the local half. If it reports no problems, the remaining question is whether the
backlog *accepts* the credential, and that is `backlog_whoami`.

Two states it exists to tell apart, which used to look identical:

- **A grant is present and only the unpinned `backlog` server is unconfigured.** Nothing is
  wrong with the credential. Declare a `role` for the repository, or accept the
  `product-manager` default.
- **No credential at all.** This is the fresh-install case, and the only one where Step 1 applies.

Then call `backlog_whoami` and read the answer literally. Four outcomes, and they need four
different things:

| What you get back | What it means | Where to go |
|---|---|---|
| A role and a write scope | Already configured. **Stop.** Report the role and the scope, and do not rewrite a working config | — |
| Setup instructions naming three paths | No key was found anywhere. This is the fresh-install case | Step 1 |
| `401` / "the backlog rejected this API key" | A key exists but the backlog will not accept it — revoked, expired, or from another environment | Step 1, with a replacement key |
| The `backlog_*` tools are not in the session at all | The MCP server is not running, which is **not** a key problem | See "When there are no tools at all" |
| Instructions naming an **orchestrator grant** | This machine has no grant. It is what most setups want — go to Step 1G rather than issuing keys | Step 1G |

When the answer is setup instructions, **show them to the user verbatim before doing anything
else**. They name the exact three paths that were consulted on *this* machine, which is more
specific than anything this document can say.

## Step 1: Decide which scope the key belongs at

Configuration resolves at three levels, highest precedence first, and levels merge **field by
field** rather than the highest one winning outright:

| | Where | Good for |
|---|---|---|
| 1 | `SUPERDEV_API_URL` / `SUPERDEV_API_KEY` in the environment | CI, a container, one-off runs |
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

Where a key comes from depends on whose backlog it is, and the two cases have different answers.
Ask which one applies before giving either.

**The hosted backlog, and the user has an account.** Send them to the portal, where they issue
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

**The hosted backlog, and the user has no account.** Accounts are created by hand while the beta
is invite-only — the portal issues keys, it does not create accounts. Give them the link and stop:

```
https://github.com/pando-codes/superdev-plugin/issues/new?template=access-request.yml
```

**Their own backlog.** Minting is an operator action, run by whoever holds the owner database
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
same setup instructions until the MCP server is restarted.

**Say the whole shape up front.** Each restart below is documented where it happens, but a user
coming from nothing meets three of them and is told about each only on arrival, which reads as
one thing going wrong repeatedly rather than a three-stage setup going right. From zero:

| | After you | Restart, because |
|---|---|---|
| 1 | install the plugin | the servers have to start at all |
| 2 | put the grant in place | a server resolves its credential once, at startup |
| 3 | bind the repository | registration names a product, and it registers at startup |

Fewer if some of it is already done — a machine with a grant that clones a second repository
meets only the third. And **restart means restart**: `/reload-plugins` reloads skills, agents and
hooks but does not restart MCP server processes, so the servers keep whatever they resolved when
they started. The symptom is `backlog_doctor` and `backlog_whoami` disagreeing — doctor reads the
files live, whoami reports what the running process holds.

Say that plainly, then after the restart:

1. Call `backlog_whoami`. Report `pando_role`, `writes.product_key`, and `agent_id`.
2. If the role is not the one the repository asked for, **stop and say so**. The key decides,
   not the config file, and every write will be refused on the basis of what the key carries.
3. If a product scope is named, say which product it is. A key scoped to another repository's
   product reads fine and writes nothing.

## When there are no tools at all

If `backlog_*` is missing from the session entirely, no key would fix it — the server is not
running. In order:

- The plugin is installed: `/plugin marketplace add pando-codes/pando-plugins` then
  `/plugin install superdev@pando-plugins`.
- `node` is on `PATH`. The bundled server is launched with it, and a shell where `node` cannot
  be found produces exactly this symptom.
- The server's own stderr, in the MCP server logs, says which of those it is.

An unconfigured server is *not* this case: it starts, registers all of its tools, and answers
every call with instructions. Tools that are present and complaining are a Step 1 problem; tools
that are absent are this one.

## Step 1G: The machine grant — the credential most setups actually want

There are two kinds of credential, and for a person's computer it is almost always this one.

A grant is **one file per machine**. Every agent on it derives its own short-lived, role-bound key
at startup, so a builder cannot act as a planner and two agents cannot take each other's work.
Three separate keys on one machine give every agent in a session the same authority, which is the
arrangement grants exist to replace — so reach for this before Step 1 unless the caller genuinely
does one job forever, like a CI runner.

It also credentials the unpinned `backlog` server, not only the role-pinned ones: with a grant and
no `config.json`, all four servers work.

| | An **API key** | An **orchestrator grant** |
|---|---|---|
| Reaches | `mcp__…backlog__*` — the unpinned server | `mcp__…backlog-engineer__*` and its siblings |
| Carries | one role, for as long as it lives | no role at all; it *mints* keys |
| Can read the backlog | yes | **no** — presented as a key it is simply not one |
| Lives at | `~/.superdev/config.json` or a project's | `~/.superdev/orchestrator.json`, **user scope only** |
| Who has one | a caller that only ever does one job | **anyone setting up a computer** — this is the one to want |

The grant is what makes an agent's role something it is **given**. One per machine; each agent
registers with it at startup and gets its own short-lived key, bound to one role and one identity.
An agent never sees a credential and never names a role — plugin.json pins the role per server,
and the agent's `tools:` frontmatter names one server.

**There is deliberately no project scope for a grant.** A repository that could carry one would be
a repository that hands your machine the ability to manufacture credentials by being cloned.

**Issue one from the portal**, under **Machines**. Sign in by emailed link, name the machine,
leave all three roles ticked, and the grant is shown once:

```
https://superdev-portal.vercel.app
```

The roles are the **ceiling**, enforced by the database: a grant that cannot mint
`agent_product_manager` cannot be talked into it by anything an agent says. All three is the right
answer for a person's machine — a missing role shows up as one server that cannot start while the
other two work, which is a confusing state to reach by unticking a box. Narrow it only for a
machine that genuinely does one job.

If you run your **own** backlog, the CLI still exists and needs the owner credential:

```sh
cd apps/backend
DATABASE_URL=… bun run mint-grant --org <account> --label "<this machine>" \
    --roles agent_engineer,agent_quality_assurance,agent_product_manager
```

Either way it goes at `~/.superdev/orchestrator.json`, mode 0600:

```json
{ "api_url": "https://pando-catalog-api.fly.dev", "grant": "pcat_live_…" }
```

Never ask the user to paste the grant into the conversation. Tell them where the file goes and let
them write it, or write it for them from a value they place — a credential in a transcript has to
be treated as compromised, and a grant *mints* credentials.

Then **call `backlog_doctor` in a fresh session** to confirm all four servers resolve. The plugin
reads its configuration once at startup, so the session has to be restarted first.

The repository also needs `.superdev/product.json` (superdev:init writes it) — registration names
a product, and the plugin refuses to guess one from the directory name.

### If there is no grant and you do not want one yet

A pinned server falls back to `keys.<role>` from `~/.superdev/config.json`. That is not an
escalation: the key is chosen by the role the server is pinned to, never by the agent calling it.

What it will **not** accept is a bare `api_key`, or an exported `SUPERDEV_API_KEY`. Those
carry whatever role they happen to carry, and a server that offered the engineer's menu while
holding the planner's authority would be lying about the one thing it exists to be honest about.
So name the key by role, or mint a grant.

### What the grant does not defend against

An agent with `Bash` can read `~/.superdev/orchestrator.json` and call the register endpoint
itself. Nothing stops that, and this skill should not pretend otherwise. What is prevented is an
agent **choosing** a role through the tools it was given — which is the failure that actually
happens, because it happens by reasoning rather than by intent. The defence against the other one
is the grant's own scope: a narrow `--roles`, a short expiry, and one revocation that kills every
key it ever minted.

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

**With a grant, none of the above is necessary.** Each role-pinned server registers its own key,
carrying its own identity, and the backlog takes the identity from the CREDENTIAL rather than
from the request — so `X-Pando-Agent-Id` cannot be used to reach a peer's lease, and the three
roles coexist in one session without any per-call bookkeeping. `backlog_whoami` reports
`agent_id_source`, which says which of the two arrangements you are in.

## What this skill must not do

- **Do not put a key anywhere the repository can commit it.** Project scope is a real option,
  but only alongside the `.gitignore` entry from Step 3.
- **Do not work around a refusal.** A 403 from the backlog is the database answering correctly.
  The fix is the right key, never a different tool call.
- **Do not claim a role.** `SUPERDEV_ROLE` and the `role` field pick which key is used and
  narrow what is offered. Authority is whatever the key carries, and `backlog_whoami` is the
  only thing that knows.
