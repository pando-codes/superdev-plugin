# Capability

Use this reference when you need to create, update, archive, or understand a Capability.

## Purpose

A Capability is a unit of building that captures each of the offerings a product makes to a customer.  Capabilities are valuable because they tie the functionality that is built to the value story that is *sold* to customers.  Capabilities offer:
- organization of similar sets of functionality
- guidance on how to measure whether functionality is having a positive impact or not
- structure and common language that product reporting (financial, operational, marketing, etc.) can be built off of

## Usage

Capabilities can be read at will, but creating, updating, or archiving capabilities need explicit approval.  In a Capability, you will...
- capture the *description* of the capability, which states what it is in the customer's terms.
- capture the *scope boundary* of the capability, which states what it explicitly covers and what it explicitly does not.  This is the field that stops two capabilities quietly claiming the same ground, and it is required — a capability without one is a capability nobody can tell the edges of.
- capture the *Key Performance Indicators* of the capability, which are the metrics we measure the capability on.
- capture the *Vital Business Offering* of the capability, which scores how vital the capability is to the entire product as a percentage.  There is exactly one score per capability, and the scores of all capabilities in a product add up to 100%.
- track the *status* of the capability, which clarifies whether the capability is proposed, active, deprecated, or archived.

A capability's *vbo* moves with its status.  A *proposed* capability scores 0 and is excluded from the sum until it is approved, so that proposing an idea never forces a rebalance.  A *deprecated* capability is tuned down toward zero as it is sunset.  An *archived* capability scores 0.  Every time a score moves, the remaining capabilities are rebalanced so the product still sums to 100%.
- track the *visibility* of the capability, which dictates whether the capability is actively reachable by all users, some users, or no users.

Our primary goal in this step is to clearly define and containerize a set of functionality based on what it offers to our users.

## Schema

```json
{
  "capability": {
    "name": {
      "type": "string",
      "description": "The name of the capability"
    },
    "description": {
      "type": "string",
      "description": "What this capability is, in the customer's terms.  Required"
    },
    "scope_boundary": {
      "type": "string",
      "description": "What this capability explicitly covers and what it explicitly does not.  Required"
    },
    "kpi": {
      "type": "array",
      "items": { "type": "string" },
      "description": "The metrics we measure this capability on"
    },
    "vbo": {
      "type": "number",
      "minimum": 0,
      "maximum": 100,
      "description": "Vital Business Offering: how vital this capability is to the entire product, in percentage points. One per capability; the vbo of all capabilities in a product sums to 100. Proposed and archived capabilities score 0; deprecated capabilities are tuned down toward zero"
    },
    "status": {
      "type": "string",
      "enum": ["proposed", "active", "deprecated", "archived"],
      "description": "The lifecycle status of the capability"
    },
    "visibility": {
      "type": "string",
      "description": "The visibility of the capability: whether it is reachable by all users, some users, or no users"
    }
  }
}
```

## Linking

Capabilities can have relationships with Features.  This provides context into which functionality delivers the capability's offering, and at what cost and value.  A Feature can serve more than one Capability, and it may cost and contribute differently to each — so the scores live on the edge, not on the Feature.

```json
{
  "capability_has_feature": {
    "capability_id": {
      "type": "integer",
      "description": "The id of the capability"
    },
    "feature_id": {
      "type": "integer",
      "description": "The id of the feature"
    },
    "cost_score": {
      "type": "number",
      "description": "How costly this feature is to the capability it serves"
    },
    "value_score": {
      "type": "number",
      "description": "How valuable this feature is to the capability it serves"
    }
  }
}
```

Because a Feature can serve several Capabilities, any measure rolled up from Features to a Capability is *attributed*, not summed — summing would count a shared Feature once per Capability.
