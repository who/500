# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

## Issue Tracking

This project uses **bd (beads)** for issue tracking. Run `bd prime` for workflow
context (session-start hooks auto-inject it).

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files
- `AGENTS.md` is the session contract, including the session-close protocol
## Build & Test

_Add your build and test commands here_

```bash
# Example:
# npm install
# npm test
```

## Architecture Overview

_Add a brief overview of your project architecture_

## Conventions & Patterns

_Add your project-specific conventions here_

<!-- BEGIN ortus block=pointer schema=1 generated-by=ortus@0.1.5.dev199+ge492e07.d20260814 -->
## Ortus session rules

Managed by Ortus 0.1.5.dev199+ge492e07.d20260814. Edit outside the markers freely — `ortus init`
rewrites only what sits between them, and `ortus check` reports drift.

`AGENTS.md` in this repo is the session contract: read it first, and follow its
issue-authoring, orchestrator, and session-close sections rather than restating
them here.

The short version: claim with `bd update <id> --status=in_progress`, do exactly that one issue,
close it with `bd close <id> --reason "..."`, and push before calling the
session done.

### CodeGraph

CodeGraph is a prerequisite of this repo, not an enhancement. Ask it
before grep, find, or opening files: the `codegraph_explore` MCP tool
when it is registered, `codegraph explore "<symbols or question>"`
otherwise. A missing CLI, index, or MCP capability is fatal under
`codegraph = "required"` — stop and report the missing prerequisite
instead of falling back to a slower search.
<!-- END ortus block=pointer -->
