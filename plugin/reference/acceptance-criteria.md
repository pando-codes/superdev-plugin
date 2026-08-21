# Acceptance Criteria

Use this reference when you need to create, update, archive, or understand Acceptance Criteria.

## Purpose

Acceptance Criteria are a unit of building that captures the outcomes of what we want code to accomplish.  Acceptance Criteria are valuable because they provide clear testing requirements that can evaluate to a boolean pass/fail value.

Acceptance Criteria offer:
- reusable pass/fail tests that make each iteration more resilient
- a more understandable abstraction of how a product works (compared to the product's code)

Acceptance Criteria are *composed*, not written.  Their preconditions and actions are references to indexed Clauses rather than prose, which means the same precondition is worded identically everywhere it appears, and a change to a shared statement is a single edit instead of a search across every criteria.  It also makes the set queryable: given a Clause, every criteria depending on it is one hop away.

## Usage

Acceptance Criteria can be read or created at will, but updating or archiving Acceptance Criteria need explicit approval.  In Acceptance Criteria, you will...
- compose the *Given* as a list of `given` Clause references, which state the circumstances these Acceptance Criteria apply to.  The Givens are an unordered set and all of them must hold.
- compose the *When* as a list of `when` Clause references, which state the actions these Acceptance Criteria apply to.  The Whens are an ordered sequence and all of them must occur, in list order.
- bind the parameters of every Clause referenced, supplying a value for each slot its statement leaves open.  The binding belongs to the reference, not to the Clause — the same Clause is bound differently by every criteria that uses it.
- write the *Then*, which states the single outcome expected to happen (in a way that can evaluate to True or False).
- track the *role(s)* these Acceptance Criteria apply to, which ties the expected outcome back to who experiences it.
- track the *status* of the acceptance criteria, which clarifies whether they are active or archived.

When composing, search the Clause index first and reference what is already there.  Only create a new Clause when no existing one says the same thing — a near-duplicate Clause defeats the entire point of the index.  See [clause.md](clause.md) for the Clause schema and the rules governing when one may be created, updated, or archived.

Our primary goal in this step is to ensure that functionality we add to our product actually enables the user experience we are aiming to fulfill.

Many inputs, one output: *Given* and *When* may each reference several Clauses, joined by AND, but there is exactly one *Then*, so the whole criteria still evaluate to a single pass/fail.  If you find yourself wanting a second *Then*, that is a second Acceptance Criteria.

## Example

Composed from four Clauses in the index — `1` is `user-logged-in`, `2` is `field-updated-on-page`, `3` is `submit-button-clicked`, and `4` is `input-written-to-database`.  Only Clause `2` takes parameters, so only its reference carries a non-empty binding:

```json
{
  "acceptance_criteria": {
    "product_id": {
      "type": "integer",
      "description": "The product this criterion tests.  Required and immutable; must match the Feature it is linked to"
    },
    "name": "submitting-a-valid-field-update-succeeds",
    "eval": {
      "given": [
        { "clause_id": 1, "binding": {} },
        { "clause_id": 2, "binding": { "field": "X", "page": "Y", "input": "Z" } }
      ],
      "when": [
        { "clause_id": 3, "binding": {} },
        { "clause_id": 4, "binding": {} }
      ],
      "then": "I should see a success response on the screen"
    },
    "role": ["account holder"],
    "status": "active"
  }
}
```

## Rendering

Acceptance Criteria render to prose from the `eval` object alone, resolving each reference to its Clause and substituting the binding into the Clause's statement.  Walk `given` and join with AND, then walk `when` in list order and join with AND, then append the criteria's own `then`.  The example above renders as:

> **GIVEN** I am logged into my account
> **AND** I have updated the X field on the Y page with Z input
> **WHEN** I click the Submit button
> **AND** the input is successfully written to the database
> **THEN** I should see a success response on the screen

The prose form is always derived, never stored.  Rewording a Clause reissues every criteria that references it.

## Schema

```json
{
  "acceptance_criteria": {
    "name": {
      "type": "string",
      "description": "The name of the acceptance criteria"
    },
    "eval": {
      "type": "object",
      "properties": {
        "given": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "clause_id": {
                "type": "integer",
                "description": "The id of a clause whose kind is given"
              },
              "binding": {
                "type": "object",
                "description": "The value supplied for each parameter in the clause statement, keyed by parameter name.  Empty when the clause has no parameters"
              }
            }
          },
          "description": "The given clauses; an unordered set, all of which must hold"
        },
        "when": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "clause_id": {
                "type": "integer",
                "description": "The id of a clause whose kind is when"
              },
              "binding": {
                "type": "object",
                "description": "The value supplied for each parameter in the clause statement, keyed by parameter name.  Empty when the clause has no parameters"
              }
            }
          },
          "description": "The when clauses; an ordered sequence, all of which must occur in list order"
        },
        "then": {
          "type": "string",
          "description": "The single observable outcome expected to happen, phrased so it can evaluate to True or False"
        }
      }
    },
    "status": {
      "type": "string",
      "enum": ["active", "archived"],
      "description": "The lifecycle status of the acceptance criteria"
    },
    "role": {
      "type": "array",
      "items": { "type": "string" },
      "description": "The roles these acceptance criteria are associated to"
    }
  }
}
```

## Composition

The `eval` object is the single source of truth for how a criteria is composed.  Order and grouping live there — `given` and `when` are separate lists, and a Clause's place in the sequence is its place in its list — so nothing about the composition needs to be reconstructed from anywhere else to render it.

One edge is *derived* from `eval`, carrying no properties of its own, so that the relationship can be traversed backwards:

```json
{
  "acceptance_criteria_has_clause": {
    "acceptance_criteria_id": {
      "type": "integer",
      "description": "The id of the acceptance criteria"
    },
    "clause_id": {
      "type": "integer",
      "description": "The id of the clause"
    }
  }
}
```

This is what answers "which criteria depend on this Clause?" before anybody edits it.  It is maintained from `eval` and never authored directly — writing it by hand would create a second, drifting account of the same composition.

A Clause's `kind` must match the list it appears in: a `when` Clause in the `given` list is invalid.  Because the lists already carry the grouping, `kind` exists to enforce that placement rather than to determine it.

## Linking

Acceptance Criteria attach most directly to Features.  This ties test evaluation to specific functionality.

The edge is defined as `feature_has_acceptance_criteria` in the Feature reference ([feature.md](feature.md)), and is traversed in either direction.
