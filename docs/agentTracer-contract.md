# agentTracer contract

Status: canonical product contract.

## Objective

`agentTracer` is a narrow, profile-local improvement tracker for `agents/*.md`. It turns explicit correction signals into auditable, reviewer-facing proposals before any prompt change is made.

## Non-goals

- No autonomous file edits, approvals, evals, acceptance, or rollback.
- No broad implicit learning from general chat history, telemetry, or unstated operator intent.
- No cross-profile or shared storage; all artifacts stay local to the parent profile root.
- No hidden mutation from `/agent-selfimprove` or `agenttracer_selfimprove`.

## Preserved invariants

- Scope stays profile-local.
- Plugin-managed runtime artifacts stay under the parent profile's `./.agentTracer/`.
- Trusted explicit correction input stays the canonical `agenttracer-correction` fenced block.
- Supported signal sources stay limited to:
  - `user-correction`
  - `same-agent-correction-loop`
- Proposal creation stays thresholded and deduped:
  - 1 normalized issue key = `agent + kind + normalized summary`
  - at least 2 corroborating signals inside 30 days
  - at least 1 tagged user correction
  - at most 1 open proposal per issue key
- Default operator UX stays review-first and read-only via `/agent-selfimprove`.
- Approval and eval stay manual.
- Promotion stays fail-closed: lineage only advances when the proposal, base snapshot, candidate snapshot, eval manifest, and eval result all exist and link correctly.

## Supported signal contract

### Canonical correction block

````markdown
```agenttracer-correction
agent: coder
kind: instruction
summary: Ask one clarifying question before coding when the API surface is ambiguous.
why: The last pass guessed an API contract.
```
````

Required keys:

- `agent`
- `kind`
- `summary`

Allowed `kind` values:

- `instruction`
- `workflow`
- `verification`
- `communication`

Anything outside this canonical block contract is ignored.

### Same-agent correction loop

The only implicit companion signal allowed in the Phase 1 contract is `same-agent-correction-loop`: the same detected agent is re-engaged in the same session with explicit corrective retry wording after a tagged correction. This signal can support a proposal, but it cannot replace the requirement for at least one tagged user correction.

## Lifecycle scope

### Required proposal states

- `open` — evidence-backed and waiting for operator review/decision.
- `accepted` — explicitly approved, eval-passing, and promoted into lineage.
- `dismissed` — explicitly closed as obsolete or not worth pursuing, but retained on disk for auditability.

Open proposals also expose read-only health cues in review output:

- `awaiting-candidate`
- `awaiting-eval`
- `eval-failed`
- `ready-to-accept`

An open proposal becomes `stale` after 14 days without proposal activity. Staleness is a review cue, not an automatic mutation.

### Preserved direction for future changes

Further lifecycle or UX work is still allowed only if it preserves the narrow core: review-first UX, explicit operator control, manual approval/eval, profile-local storage, and fail-closed promotion.

### Not approved by this contract

- Autonomous mutation of `agents/*.md`
- Automatic acceptance or rollback
- Broad heuristic learning from untagged conversations
- Expansion into general telemetry, scoring, or cross-profile memory

## Operator workflow

1. Capture qualifying signals.
2. Review open proposals with `/agent-selfimprove`.
3. Do not edit anything until a reviewer or human explicitly approves a proposal.
4. If the proposal is obsolete or no longer worth pursuing, close it explicitly with `agenttracer_dismiss_proposal`.
5. If approved, update only `agents/<agent>.md` for that proposal.
6. Run `agenttracer_snapshot_candidate`.
7. Run the manifest manually, then record the outcome with `agenttracer_record_eval`.
8. Only after explicit approval and a passing eval may `agenttracer_accept_proposal` update lineage.
9. Use `agenttracer_record_rollback` only to document a manual restore.

`/agent-selfimprove` is the primary entrypoint. `agenttracer_selfimprove` is the backend/manual fallback. Both are read-only review tools.

## Roles

- Operator/user: provides explicit corrections and decides whether a proposal should proceed.
- Implementer: edits agent guidance only after approval.
- Reviewer/human approver: checks evidence and eval results before acceptance.
- `agentTracer`: records artifacts, renders review material, and enforces fail-closed promotion rules.

## Data-root guarantee

All plugin-managed runtime artifacts stay under the parent profile root `./.agentTracer/`:

- `signals/` — append-only captured signals
- `proposals/` — proposal `.json` and reviewer-facing `.md`
- `evals/` — eval manifests and recorded results
- `versions/` — stored agent snapshots
- `lineage/` — current and previous accepted lineage pointers per agent
- `history/` — append-only dismiss/accept/rollback ledger

## Baseline and lineage bootstrap

Baseline snapshots and lineage stay profile-local and auditable. The current contract allows minimal bootstrap behavior, including lazy lineage initialization from the first proposal/base snapshot path. Better empty-state guidance and smoother bootstrap ergonomics are approved follow-on targets, but they must not weaken manual review, manual eval, or fail-closed acceptance.

## Success criteria

- Operators can trace a change from signal -> proposal -> candidate snapshot -> eval -> lineage/history.
- Operator-facing docs describe the same signal sources, thresholds, lifecycle scope, health cues, and manual controls.
- The product remains narrow, explicit, and auditable.
