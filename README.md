# agentTracer

Local plugin for self-improving agent proposals.

## What it does

Tracks agent-driven proposals (e.g., agent instruction improvements), validates them via evals, and commits accepted versions to lineage. Provides the `/agent-selfimprove` command as a read-only review entrypoint; mutation steps remain separate.

## Key constraints

- **Runtime-root rule**: All artifacts (signals, proposals, evals, versions, lineage, history) live under the parent profile `.agentTracer/` directory, not inside this package. The plugin derives runtime root from the profile context.
- **One open proposal per issue key**: At most one open proposal per agent + kind + normalized summary.
- **Eval required before accept**: No proposal is accepted without recorded eval evidence.
- **Manual fallback**: `agenttracer_selfimprove` tool provides backend/manual invocation when the command is unavailable.

## Runtime data

| Path | Contents |
|------|----------|
| `.agentTracer/signals/` | Raw improvement signals from agents |
| `.agentTracer/proposals/` | Formal proposals (keyed by agent + kind + summary) |
| `.agentTracer/evals/` | Eval results validating proposals |
| `.agentTracer/versions/` | Accepted instruction versions |
| `.agentTracer/lineage/` | Version history and ancestry |
| `.agentTracer/history/` | Audit log of actions |

## Local verification

```bash
npm run typecheck
npm run test
npm run dryrun
```

Or from parent root:

```bash
npm run typecheck:agenttracer
npm run test:agenttracer
npm run dryrun:agenttracer
```

## Deeper details

- Canonical contract: [`docs/agentTracer-contract.md`](docs/agentTracer-contract.md)
- Entry point: [`src/index.ts`](src/index.ts)
- Tests: [`tests/`](tests/)
