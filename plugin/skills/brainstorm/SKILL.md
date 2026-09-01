---
name: brainstorm
description: You MUST use this before any development work like creating features, building components, adding functionality, or modifying behavior. Explores user intent, requirements, and design before implementation.
---

# Brainstorming

Goal: Turn ideas into fully completed specifications of User Stories, Features, and Acceptance Criterias

- Start by understanding the current project context
- Then ask questions one at a time to refine the user's idea

**Announce at start:** "I'm using the Brainstorm skill to refine this idea."

## Precondition

The backlog must already hold a Product and its Capabilities.  Check before you start: if the
`product` table is empty, stop and use superdev:init first — it bootstraps the backlog from the
existing project or by interview.  Come back here once it has.

## Grounding Process

1. Understand the idea

- Check out the current project state first (files, docs, recent commits)
- Ask questions one at a time to refine the idea
- Prefer multiple choice questions when possible, but open-ended is fine too
- Only one question per message - if a topic needs more exploration, break it into multiple questions
- Focus on understanding: purpose, constraints, success criteria

2. Refine the idea

- Propose 2-3 different approaches with trade-offs
- Present options conversationally with your recommendation and reasoning
- Lead with your recommended option and explain why

3. Synthesize the idea into user experience and User Story(s)

- Determine what the desired user experience is based on the *why* of the idea
- Leverage `${CLAUDE_PLUGIN_ROOT}/reference/user-story.md` to build one-or-more User Stories that reflect how users should experience the idea.

## Review the design with existing user stories

- Read the existing User Stories from the backlog, following `${CLAUDE_PLUGIN_ROOT}/reference/datastore.md`, scoped to this repository's product by `story.product_id`
- Compare the newly made user story (or user stories) with existing user stories.  
- If they are similar, consolidate into an existing user story (you can update pre-existing user stories if needed).  
- If they are not similar, stick with creating a new user story.  Raise a flag to the user if there is ambiguity or uncertainty about the user story.


## After new data objects are made

- Write the validated User Stories to the backlog, following `${CLAUDE_PLUGIN_ROOT}/reference/datastore.md`, each carrying the `product_id` of this repository's product — a story is written before any Feature exists to link it, so its own `product_id` is the only thing that makes it findable
- List all of the created User Stories, by `key`, and hand them off to superdev:plan

## Key Principles

- **One question at a time** - Don't overwhelm with multiple questions
- **Multiple choice preferred** - Easier to answer than open-ended when possible
- **Explore alternatives** - Always propose 2-3 approaches before settling
- **Be flexible** - Go back and clarify when something doesn't make sense