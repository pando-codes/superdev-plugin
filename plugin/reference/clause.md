# Clause

Use this reference when you need to create, update, archive, or understand a Clause.

## Purpose

A Clause is a unit of context that captures a single reusable statement of precondition or action.  Clauses are valuable because they let Acceptance Criteria be *composed* from an index of known statements rather than written as one-off prose, which is what keeps a growing set of criteria consistent instead of letting the same idea drift into a dozen phrasings.  Clauses offer:
- one definition of a shared statement, so wording never drifts between criteria
- traversal — given a Clause, every Acceptance Criteria that depends on it is one hop away
- coverage analysis across the whole criteria set, which free text cannot answer
- parameterization, so one statement template covers many concrete cases

## Usage

Clauses can be read or created at will, but updating or archiving a Clause needs explicit approval.  This is the inverse of most entities, and it is deliberate: creating a Clause is cheap and harmless, while editing one that criteria already reference silently rewrites every criteria using it.  Check what references a Clause before changing it.  In a Clause, you will...
- capture the *kind* of the clause, which states whether it is a precondition (`given`) or an action (`when`).
- capture the *name* of the clause, which is its stable handle.  The statement can be reworded without breaking references; the name is the identity.
- capture the *statement* of the clause, which is the template text a criteria renders into prose.  Parameters appear in the statement as named slots in braces.
- capture the *parameters* of the clause, which are the typed slots the statement leaves open.  A clause with no slots has an empty list.
- track the *status* of the clause, which clarifies whether the clause is active or archived.

A Clause must be *atomic* — exactly one precondition or one action.  If a statement contains an AND, it is two Clauses.  This matters because a criteria joins its Clauses with AND when it renders, so a Clause that already contains one produces a statement nobody can reference, reuse, or reason about independently.

Our primary goal in this step is to build an index of the finite statements our product can be described with, so that Acceptance Criteria become compositions of known parts rather than new prose each time.

## Example

A literal clause, with no parameters:

```json
{
  "name": "user-logged-in",
  "kind": "given",
  "statement": "I am logged into my account",
  "parameters": [],
  "status": "active"
}
```

A parameterized clause, whose slots are bound by each criteria that uses it:

```json
{
  "name": "field-updated-on-page",
  "kind": "given",
  "statement": "I have updated the {field} field on the {page} page with {input} input",
  "parameters": [
    { "name": "field", "type": "string", "description": "The field being updated" },
    { "name": "page",  "type": "string", "description": "The page the field is on" },
    { "name": "input", "type": "string", "description": "The value entered into the field" }
  ],
  "status": "active"
}
```

## Schema

```json
{
  "clause": {
    "name": {
      "type": "string",
      "description": "The stable handle of the clause"
    },
    "kind": {
      "type": "string",
      "enum": ["given", "when"],
      "description": "Whether the clause states a precondition (given) or an action (when)"
    },
    "statement": {
      "type": "string",
      "description": "The template text of the clause, with parameters as named slots in braces"
    },
    "parameters": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "description": "The name of the parameter, matching a slot in the statement"
          },
          "type": {
            "type": "string",
            "enum": ["string", "number", "boolean"],
            "description": "The type a binding must supply for this parameter"
          },
          "description": {
            "type": "string",
            "description": "What this parameter stands for"
          }
        }
      },
      "description": "The typed slots the statement leaves open.  Empty when the statement is literal"
    },
    "status": {
      "type": "string",
      "enum": ["active", "archived"],
      "description": "The lifecycle status of the clause"
    }
  }
}
```

There is deliberately no `then` kind.  A *Then* asserts a specific observable outcome, and a statement general enough to be reused is usually too weak to assert anything worth testing — so Acceptance Criteria hold their *Then* as their own text rather than composing it.  Promoting *Then* into this index later means adding it to the `kind` enum and moving the field off the criteria; nothing else in the model changes.

## Linking

Clauses are composed into Acceptance Criteria.  A criteria references a Clause from its `eval` object and supplies a *binding* for the Clause's parameters there — the binding belongs to the reference rather than to the Clause, because the same Clause is bound differently by every criteria that uses it.  A Clause therefore never stores its own values, only the slots where values go.

The `acceptance_criteria_has_clause` edge is defined in the Acceptance Criteria reference ([acceptance-criteria.md](acceptance-criteria.md)) and derived from those references.  Traverse it to find every criteria that depends on a Clause, which is what to check before editing one.
