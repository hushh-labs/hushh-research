# Definition of Done

A standing, repo-wide bar that every change must clear before it counts as done. Acceptance criteria vary per task and answer "did we build the right thing?"; this list is the same every time and answers "is it finished to our standard?". A task is done only when BOTH are satisfied. Adapted from the definition-of-done mechanism in addyosmani/agent-skills, fitted to the hushh operating contracts.

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md). Use that map for the top-down system view; this page is the standing completion bar beneath it.

```
per task            per feature              per release
┌──────────────┐    ┌───────────────────┐    ┌─────────────────────────┐
│ Correctness  │ →  │ Integration       │ →  │ full checklist (floor)  │
│ Quality      │    │ Documentation     │    │ + pre-pr-readiness      │
└──────────────┘    └───────────────────┘    │ + release-readiness     │
  acceptance          cross-surface +        └─────────────────────────┘
  criteria AND        wiki freshness           lane bundles add gates
  this list           both satisfied           on top, never subtract
```

This document is the floor. Workflow verification bundles, the premise gate, and the blocker gates add lane-specific requirements on top; they never subtract from it.

## The standing checklist

### Correctness

- [ ] All acceptance criteria for the task are met
- [ ] Behavior verified at runtime — not just compiled, typechecked, or reasoned about (the verification ladder in AGENTS.md: static inspection → typecheck/lint → focused unit test → integration → runtime/browser → build/deploy smoke; use the smallest authoritative rung, but an authoritative rung must actually run)
- [ ] New behavior covered by tests that fail without the change and pass with it
- [ ] Existing tests still pass; no regressions introduced
- [ ] Edge cases and error paths handled, not just the happy path

### Quality

- [ ] Code reveals intent through naming and structure; comments explain why, not what
- [ ] No duplicated business logic; the existing canonical helper was extended, not near-duplicated
- [ ] No dead code, debug output, or commented-out blocks left behind
- [ ] Changes scoped to the task; no unrelated refactors mixed in
- [ ] Lint and formatting pass

### Integration

- [ ] Change works with the rest of the system, not just in isolation (cross-surface callers checked when a contract moved)
- [ ] Database migrations, config changes, and feature flags accounted for; migrations follow the expand/contract discipline (`docs/reference/architecture/schema-migration-discipline.md`)
- [ ] Backward compatibility considered for any public or generated contract change
- [ ] Generated contracts regenerated and committed when their source changed (AgentManifestV2 rule: no parallel hand-edited copies)

### Documentation

- [ ] Public interfaces, contracts, and user-facing behavior documented in their canonical docs home (per `docs/reference/README.md` classification)
- [ ] Founder Wiki articles made stale by this change upgraded as part of shipping it (AGENTS.md doctrine #3: wiki freshness is part of done, not a follow-up)
- [ ] Docs describe the current state in timeless language, not the change history

### Ship-readiness

- [ ] Security implications reviewed for any untrusted input, auth, consent, vault, or PKM handling (route to `security-audit` when the boundary is non-trivial)
- [ ] Observability in place for new critical paths (logs, metrics, or telemetry the on-call can actually query)
- [ ] Rollback path exists for anything risky; a migration with no tested down path is a deploy that cannot be reversed
- [ ] The operator has reviewed and approved before merge or deploy where the lane requires it (approve-only is not merge authority)

## How to apply

- **Per task:** Correctness + Quality before checking the task off.
- **Per feature:** Integration + Documentation before calling the feature complete.
- **Per release:** the full list is the floor; `pre-pr-readiness` and `release-readiness` workflow bundles add the deploy-specific gates on top.

## Red flags

- "It's done, I just haven't run it yet" — unverified work is not done
- "Tests pass" used as a synonym for done while runtime verification, docs, or wiki freshness were skipped
- A different bar applied under deadline pressure — the list does not renegotiate per sprint
- "Done" declared with a stale generated contract, a missing migration down path, or an un-upgraded wiki article the change made stale
