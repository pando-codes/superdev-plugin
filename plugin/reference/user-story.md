# User Story

Use this reference when you need to create, update, archive, or understand a User Story.

## Purpose

A User Story is a unit of context that captures the wants and needs of a product's users.  User Stories are valuable because they keep the purpose of our product oriented to **outstanding user experience** rather than optimized toward suboptimal outcomes.

As User Stories are collected over time, they offer both an audit trail and context around how user experience has changed and why historical decisions about user experience have been made.

## Usage

User Stories can be created, read, updated, and retired.  A story carries no name or title of its own — the role/want/benefit triple *is* its identity, and it is referred to by its `key`.  In a User Story, you will...
- capture the *role* of the user, which provides context on who the user is that's interacting with our product.
- capture the *want* of the user, which provides context on what the user wants to be able to accomplish with our product.
- capture the *benefit* of the user, which provides context on why the user wants to fulfill their goal with our product.
- capture the *importance* of the user story, which weights how much this story matters relative to the others.  A story that no longer reflects our users is tuned down rather than given a state of its own.
- track the *status* of the user story, which is `current`, `stale`, or `retired`.  A story is never "done" — it is a durable description, not a work ticket, so the only meaningful question is whether it still accurately describes the experience.  `stale` is author-declared and says the description may no longer be true.
- record *when the story was last reviewed*, which is what lets a story's confidence decay over time.  A story nobody has looked at in a year is a liability whether or not anyone has noticed.

User Stories explicitly **do not** prescribe how something should be done, because that will be determined via other decision processes (in the Feature definition).  Our primary goal in this step is only to capture information from the User's perspective that reflects their desired experience with our product.

## Schema

```json
{
  "user_story": {
    "product_id": {
      "type": "integer",
      "description": "The product whose users this story describes.  Required and immutable"
    },
    "story": {
      "type": "object",
      "properties": {
        "role": {
          "type": "string",
          "description": "The role of the user in the user story ('As a...')"
        },
        "want": {
          "type": "string",
          "description": "What the user wants to accomplish ('I want...')"
        },
        "benefit": {
          "type": "string",
          "description": "The benefit to the user in the user story ('So that...')"
        }
      }
    },
    "status": {
      "type": "string",
      "enum": ["current", "stale", "retired"],
      "description": "Whether the story still describes reality.  Not a completion state — a story is never 'done'"
    },
    "last_reviewed_at": {
      "type": ["string", "null"],
      "format": "date-time",
      "description": "When the story was last confirmed accurate.  Null means never reviewed; feeds confidence decay"
    },
    "importance": {
      "type": "number",
      "description": "A weighting of how important this user story is compared to others. A story that no longer reflects our users is tuned down rather than given a status of its own"
    }
  }
}
```

## Linking

User Stories can have relationships with Features.  This provides context into which user needs a Feature is being built to satisfy.  Features use this information to help define their value proposition.

**A User Story belongs to exactly one Feature.**  A Feature may be informed by many stories, but the reverse does not hold — so if a story genuinely informs two Features, that is a signal the story is too broad and should be split, not a second link to add.

The edge is `feature_has_story`, and is traversed in either direction.

A Story and an Acceptance Criterion are **siblings under a Feature, not parent and child**.  A Story is context — why a Feature exists, in the user's terms.  A criterion is an instruction — a binary check of whether the Feature does its job.  Tying them would impose a hierarchy the domain does not have.
