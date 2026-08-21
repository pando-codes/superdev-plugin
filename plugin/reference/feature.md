# Feature

Use this reference when you need to create, update, archive, or understand a Feature.

## Purpose

A Feature is a unit of building that captures an instruction set for how a piece of functionality gets implemented in a product.  Features are valuable because they allow for incremental and iterative changes to a product.  Features offer:
- audit history of functionality changes
- context on how functionality change decisions were made
- theoretical idempotence - a product can be made infinite times using the same instruction set
- abstraction of functional purpose from code

## Usage

Features can be created, read, updated, and archived.  In a Feature, you will...
- capture the *value proposition* of the functionality, which lists the arguments *for* adding the functionality to the product and is organized by new_revenue, revenue_growth, cost_reduction.  This provides context that helps make the decision on how to prioritize working on the functionality or deciding whether or not to even implement the functionality.
- capture the *cost assessment* of the functionality, which lists the arguments *against* adding the functionality to the product and is organized by cost, risk, and uncertainty.  This provides context that helps make the decision on how to prioritize working on the functionality or deciding whether or not to even implement the functionality.
- capture the *scope boundary* of the functionality, which draws the line between what the functionality does and explicitly does not cover.
- track the *lifecycle state* of the functionality, which clarifies whether functionality is proposed, active, deprecated, or removed.  A newly planned Feature is `proposed`, never `active`.  A *deprecated* feature is still shipping but on its way out; a *removed* feature's code is gone.
- track the *visibility* of the functionality, which dictates whether the functionality is internal-only or released publicly.

Our primary goal in this step is to define the scope of the functionality and capture appropriate context for prioritizing working on the functionality.  This is used by engineers to plan and coordinate writing code.

## Schema

```json
{
  "feature": {
    "name": {
      "type": "string",
      "description": "The name of the feature"
    },
    "description": {
      "type": "string",
      "description": "The description of the feature"
    },
    "value_prop": {
      "type": "object",
      "properties": {
        "new_revenue": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Potential new revenue this feature enables"
        },
        "revenue_growth": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Potential growth of existing revenue this feature enables"
        },
        "cost_reduction": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Potential cost reduction this feature enables"
        }
      }
    },
    "cost_assessment": {
      "type": "object",
      "properties": {
        "cost": {
          "type": "array",
          "items": { "type": "string" },
          "description": "The cost(s) to implement this feature"
        },
        "risk": {
          "type": "array",
          "items": { "type": "string" },
          "description": "The risk(s) of implementing this feature"
        },
        "uncertainty": {
          "type": "array",
          "items": { "type": "string" },
          "description": "The unknown(s) of working on this feature"
        }
      }
    },
    "scope_boundary": {
      "type": "object",
      "properties": {
        "in_scope": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Loose context(s) of what is in-scope of the feature"
        },
        "out_of_scope": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Loose context(s) of what is out-of-scope of the feature"
        }
      }
    },
    "lifecycle_state": {
      "type": "string",
      "enum": ["proposed", "active", "deprecated", "removed"],
      "description": "The lifecycle state of the feature.  Named lifecycle_state, not status, unlike every other entity here"
    },
    "deprecated_at": {
      "type": ["string", "null"],
      "format": "date-time",
      "description": "When the feature entered deprecation.  Null until it does"
    },
    "removed_at": {
      "type": ["string", "null"],
      "format": "date-time",
      "description": "When the feature's code was removed.  Null until it is"
    },
    "visibility": {
      "type": "string",
      "enum": ["internal", "public"],
      "description": "The visibility of the feature"
    }
  }
}
```

## Linking

Every edge is defined once, in the reference for the parent side of the relationship, and traversed in either direction.  There is no separate edge for reading a relationship backwards.

Features have a relationship with the Capabilities they serve, defined as `capability_has_feature` in the Capability reference ([capability.md](capability.md)).  That edge carries `cost_score` and `value_score`, because a Feature can serve more than one Capability and may cost and contribute differently to each.

Features can have relationships with User Stories.  This provides context into which user needs the Feature is being built to satisfy.  A Feature can be informed by many User Stories, and a User Story can inform many Features.

```json
{
  "feature_has_story": {
    "feature_id": {
      "type": "integer",
      "description": "The id of the feature"
    },
    "story_id": {
      "type": "integer",
      "description": "The id of the user story.  Unique — a story belongs to exactly one feature"
    }
  }
}
```

Features can have relationships with Acceptance Criteria.  This ties test evaluation to specific functionality.

```json
{
  "feature_has_ac": {
    "feature_id": {
      "type": "integer",
      "description": "The id of the feature"
    },
    "criterion_id": {
      "type": "integer",
      "description": "The id of the acceptance criterion.  Unique — a criterion belongs to exactly one feature"
    }
  }
}
```
