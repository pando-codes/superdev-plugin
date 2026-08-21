# superdev — Claude Code plugin

**This repository is a read-only mirror.** The plugin lives in [`plugin/`](plugin/) and is
developed in the superdev monorepo, from which it is republished on every release. Pull requests
opened here cannot be merged — file an issue instead and it will be picked up on the other side.

## Install

```
/plugin marketplace add https://github.com/pando-codes/pando-plugins.git
/plugin install superdev@pando-plugins
```

Use the full HTTPS URL rather than the `pando-codes/pando-plugins` shorthand: the shorthand
clones over SSH, which works if you already have a GitHub SSH key and fails with an
authentication error if you do not.

## What it is

superdev turns an idea into working code through a brainstorm → plan → execute → evaluate
workflow, recording user stories, features, and acceptance criteria as catalog records — and then
lets agents pull that work back out one well-defined, role-scoped item at a time.

The whole of it is in [`plugin/README.md`](plugin/README.md), including the part worth reading
before you install anything: [what is not true
yet](plugin/README.md#what-is-not-true-yet).

## Why the plugin is one directory down

The marketplace resolves this repository with a `git-subdir` source, which names an explicit
HTTPS URL and a path inside it. That is deliberate: the `github` source type clones over SSH, so
a plugin published that way is installable only by people who already have a GitHub SSH key —
which, on a machine that has never pushed to GitHub, is nobody.

## Requesting access to the hosted catalog

The plugin is free and public. The catalog it talks to is invite-only while it is in beta, and
each account is provisioned by hand.

**[Request access →](https://github.com/pando-codes/superdev-plugin/issues/new?template=access-request.yml)**
