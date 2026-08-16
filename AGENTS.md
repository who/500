# AGENTS.md

Session rules for AI agents working in this repo.

Project type: **polyglot**. Issue prefix: **fh**.
Bootstrapped by ortus 0.1.5.dev5+g89f5fcaa5.d20260719 on 2026-07-20.

<!-- BEGIN ortus block=agents schema=1 generated-by=ortus@0.1.5.dev199+ge492e07.d20260814 -->
## Ortus session rules

Managed by Ortus 0.1.5.dev199+ge492e07.d20260814. Edit outside the markers freely — `ortus init`
rewrites only what sits between them, and `ortus check` reports drift.

### Issue tracking with bd

All work goes through bd. Find ready work, claim it, do it, close it:

```bash
bd ready                              # see what has no blockers
bd update <id> --status=in_progress   # claim
# ... do the work ...
bd close <id> --reason "..."          # close
```

One context window, one issue. Do not carry leftover work on a closed id; file
it as a new bead instead.

### Issue authoring contract (readiness v1)

Every non-epic issue must satisfy Ortus readiness schema v1 to be workable:
`ortus grind` skips an unready issue rather than running it. Epics are
containers and are exempt. Three bd fields carry the contract, each under the
exact Markdown headings readiness v1 requires:

- `description` — the objective, and the behavior before and after.
- `design` — the schema version, scope and non-goals, concrete file and symbol
  locations, resolved decisions, compatibility constraints, ordered steps,
  dependencies, edge cases, and plan-gap guidance.
- `acceptance_criteria` — observable criteria with stable identifiers, one
  exact check per identifier, and the targeted test commands.

Every section needs concrete content: `TODO`, `TBD`, `N/A`, and empty or
template text are rejected. When something is genuinely absent, write
`None — <why that is safe>`.

Run `ortus spec` for the authoritative heading list and shape rules. It prints
the contract generated from the installed Ortus, so it cannot drift from what
grind enforces; this block only points at it.

### Orchestrator (ortus grind)

Drive the queue to zero via Ortus's subprocess-per-task loop. Each iteration
spawns a fresh agent with a narrow per-task condition ("close one issue"); the
outer loop trusts only observable bd state to decide success, orphan-claim, or
no-change retry.

Claude workers run `claude -p "/goal ..."`. Codex and Grok workers run a plain
`exec` prompt, because those non-interactive surfaces do not expand slash
commands. Never invoke `ortus grind` from inside a worker.

```bash
ortus grind .                            # drain bd ready
ortus grind . --tasks 1                  # exactly one task closed
ortus grind . --orphan-policy revert     # revert claimed-but-unclosed
ortus grind . -c "<custom condition>"    # custom per-iteration task text
```

### CodeGraph

CodeGraph is a prerequisite of this repo, not an enhancement. Ask it
before grep, find, or opening files: the `codegraph_explore` MCP tool
when it is registered, `codegraph explore "<symbols or question>"`
otherwise. A missing CLI, index, or MCP capability is fatal under
`codegraph = "required"` — stop and report the missing prerequisite
instead of falling back to a slower search.

### Session-close protocol

Before saying "done", verify:

1. `git status` — what changed
2. `git add` the relevant files
3. `git commit` with a clear message
4. `bd close <id> --reason "..."` — the issue, not just the code
5. `git push` to the remote, when one is configured

Work is not done until it is pushed.
<!-- END ortus block=agents -->
