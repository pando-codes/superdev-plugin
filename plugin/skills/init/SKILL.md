---
name: init
description: You MUST use this before any other superdev skill when the catalog is empty - no Product row, or no Capabilities. Bootstraps the catalog by deriving the Product and its Capabilities from an existing project, or by interviewing the user when the project is fresh.
---

# Initializing the Catalog

Every other skill in this plugin reads and writes a catalog that assumes two things already
exist: a **Product**, and the **Capabilities** it offers.  Nothing else can run without them —
`feature.product_id` and `capability.product_id` are both `NOT NULL`, so the first insert of a
planning session fails outright against an empty catalog.

This skill creates them, once.

**Announce at start:** "I'm using the Init skill to set up this project's catalog."

## Step 0: Make sure there is somewhere to write

Confirm the catalog is reachable before doing anything else: call `catalog_whoami` and report
the role it names.  If the `catalog_*` tools are not in this session, stop here and say so —
everything below is pointless without them, and the fix is two environment variables rather than
anything you can do from inside the session.  See
`${CLAUDE_PLUGIN_ROOT}/reference/datastore.md`.

Creating a product needs **product-manager** or **head-of-engineering**, and an **unscoped**
key.  `catalog_whoami` reports both:

- a different `pando_role` — stop and say which key would be needed
- `"writes": { "scope": "product", ... }` — this key is bound to an existing product and cannot
  create one.  If it names *this* repository's product, the catalog is already initialized and
  this skill should not be running; if it names another, stop and ask for the bootstrap key

Either way, stop before interviewing the user for a product you will not be allowed to write.

## Step 1: Refuse if THIS repository is already initialized

**This skill runs exactly once per repository.**  A catalog may hold many products — several
coexist there correctly — so the question is never "does a product exist" but "does *this
repository's* product exist."  Answering the broader question would make init refuse to set up a
new product simply because some unrelated one is already catalogued.

Read the repository's product binding at `.superdev/product.json`, then branch:

| State | What to do |
|---|---|
| Binding exists, and its product has capabilities | **STOP. Do not run.**  Report the product and its capabilities, state that this repository is already initialized, and direct the user to superdev:recalibrate. |
| Binding exists, but its product has **no** capabilities | A previous init was interrupted.  Say so, then resume at Step 2 — do **not** create another product row. |
| Binding exists, but names a product **not in the catalog** | The catalog was reset, or the binding was copied from another repository.  Stop and ask; do not silently recreate the product under a key someone else may be using. |
| No binding | This repository is uninitialized.  Continue — **regardless of what other products the catalog holds.** |

### One product per repository

**Never create a second product row for this repository.**  Not on a re-run, not because the
user's idea feels like a different product, not because the bound product looks wrong.

The binding is what makes this enforceable, and it is why every other skill reads it too: in a
shared catalog, "which product am I working on" has no answer without it, and a skill that
guesses will eventually write a feature under the wrong product where nothing errors and every
per-product view quietly reports on a fraction of reality.

If the bound product is genuinely wrong — wrong name, wrong key, wrong framing — that is a
correction to the row that exists, made deliberately by the user, not a new row alongside it.
Say what's wrong and stop.

**A genuinely different product belongs to a different repository**, with its own binding and
its own init.  If the user describes one while this repository is already bound, raise it and
stop.  Do not resolve it by writing.

## Step 2: Choose a path

Look at the working directory and decide which situation you're in:

- **Existing project** — there is source code, a populated README, a manifest
  (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`), or meaningful git history.
- **Fresh project** — an empty or near-empty directory, a scaffold with no real code, or a
  README that is still a placeholder.

State which you concluded and why in one line.  **If it's genuinely ambiguous, ask** — the two
paths produce very different conversations, and guessing wrong wastes the user's time.

---

## Path A: Derive from the project

Use this when the project already exists.  You are reconstructing what this product *offers*,
which is not the same as cataloguing what its code *contains*.

1. **Read for value, not structure.**  The README's opening, `docs/`, the manifest's
   description, the top-level directory names, and recent commit subjects.  You are looking for
   the promises this product makes to whoever uses it.

2. **Propose the Product** — a `key` (`^[a-z0-9][a-z0-9-]*$`) and a `name`.  Usually the repo
   name and its human title.  Show it and confirm before writing.

3. **Propose Capabilities.**  Draft each as:
   - `name` — a short handle for the offering
   - `description` — what this capability is, in the customer's language
   - `scope_boundary` — what it explicitly covers and what it explicitly does not

   Both `description` and `scope_boundary` are required by the store.  `scope_boundary` is the
   one that does the real work: naming what a capability is *not* responsible for is what stops
   two capabilities from quietly overlapping later.

4. **Present the full set for approval before writing anything.**  Show your reasoning — which
   parts of the project led you to each capability — so the user can correct a bad read rather
   than discover it three features later.

---

## Path B: Interview

Use this when the project is fresh.  Follow the same conversational rules as the brainstorm
skill: **one question per message**, multiple choice where it fits, open-ended where it doesn't.

Work through, in order:

1. What is this product, in a sentence?
2. Who is it for?  (This is what makes `description` concrete rather than generic.)
3. What are the two or three things it must do for that person to be worth using at all?
4. For each of those, what is deliberately *not* in scope?
5. What is the product's `key` and `name`?

Then draft the Product and Capabilities exactly as in Path A steps 2–3, and present them for
approval.

Don't interview past the point of usefulness.  Three or four solid capabilities are a better
starting catalog than eight speculative ones — capabilities are cheap to add later, through
`plan`, once real features force the question.

---

## Step 3: Write

On approval, write the Product first with **`catalog_create_product`** (`key`, `name`), then
each Capability with **`catalog_create_capability`**, passing the new product's `product_key`.

Per capability: `key`, `name`, `description`, `scope_boundary`, `vbo`,
`status` = `active`, `visibility` = `internal`.

The product must exist before any capability can name it, and `catalog_create_product` is the
one call in this workflow with no undo — there is no tool to rename or delete a product, because
its key scopes every other row in the catalog.  Read the tool's description before calling it.

### The initial VBO distribution

Each capability carries a `vbo` — its share of the product's total value — and **the vbo of
every active capability must sum to exactly 100.**  Seeding that distribution is part of
initializing, because every later change is a *rebalance* of it, and superdev:recalibrate has
nothing to rebalance from otherwise.

Ask the user directly rather than deriving it: given this set, which capabilities carry the
most of what makes the product worth using?  An even split is a legitimate answer for a young
product and a much better starting point than invented precision.  Present the proposed
distribution as a table and confirm it totals 100 before writing.

Do not weight by how much code a capability will take.  VBO is worth, not effort — the hardest
thing to build is frequently not the most valuable.

Capability `key` matches `^[a-z0-9][a-z0-9-]*$` and is unique **per product**, so a short
kebab-case handle derived from the name.

### Record the binding

Write `.superdev/product.json` in the repository root, holding the product key this repository
owns:

```json
{ "product_key": "reelmates" }
```

This is what Step 1 reads on any future run, and what every other skill uses to scope its
queries to the right product.  **Write it in the same breath as the product row** — a product
created without a binding leaves the repository looking uninitialized, and the next init would
try to create it again.

Commit it.  The binding is a fact about the repository, not a local preference.

## Step 4: Hand off

Report what was created, then hand off to superdev:brainstorm — that is the normal entry point
for the first real idea, and the catalog is now able to receive it.

## Pitfalls to Avoid

**Capabilities are not modules.**  The strongest temptation in Path A is to walk the top-level
directories and emit one capability each.  That produces an architecture diagram, not a catalog.
A capability is something a *user* gets; `auth/`, `utils/`, and `api/` are almost never
capabilities, and one capability frequently spans several directories.

**Don't invent offerings the product doesn't make.**  If the README promises something the code
plainly doesn't do yet, that's a Feature someone hasn't built — not a Capability to seed. Ask.

**Don't over-partition.**  Three to eight capabilities carve most products cleanly.  Twenty
means you've catalogued features, and every one of them will need rebalancing later.

**Never write without approval.**  Creating capabilities requires explicit approval — see
`${CLAUDE_PLUGIN_ROOT}/reference/capability.md`.  Show the full proposed set, then write.

**Don't re-initialize a live catalog.**  An initialized catalog is superdev:recalibrate's
territory, not this skill's.  Changing the capability set after init is an ongoing activity with
its own hazards — dependency edges, attached features, boundary overlap — and none of them are
handled here.

## Key Principles

- **One question at a time** — Path B is a conversation, not a form
- **Value over structure** — what the product offers, never what its code contains
- **Boundaries are the work** — `scope_boundary` prevents the overlap that costs you later
- **Start small** — a thin true catalog beats a broad speculative one
- **Approval before writing** — always
