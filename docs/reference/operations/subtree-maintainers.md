# Subtree Maintainers

This page is maintainer-only context.

## Visual Context

Canonical visual owner: [Operations Index](README.md). Use that map for the top-down operations view; this page defines one maintainer-only boundary.

Normal contributors should not need subtree knowledge to clone the repo, boot the app, or open a PR.

## What Stays True

- `consent-protocol/` still has an upstream synchronization contract.
- upstream-first routing remains the default when the same policy must exist in both repos.
- day-to-day contributors work monorepo-first
- subtree sync and push behavior is a maintainer concern

## Contributor Rule

Do not teach subtree commands in:

- root onboarding
- first-run guides
- first-PR guidance

If a contributor only needs to build and ship against the monorepo, the subtree should be invisible.

## Maintainer Rule

When subtree coordination is required:

- keep it in maintainer docs
- keep the commands small and explicit
- avoid turning upstream sync into repo-wide onboarding complexity

Normal `git push` does not run the expensive upstream subtree projection. It
still checks branch freshness and runs the fast protocol lint gate when
protocol files changed. Maintainers choose either explicit verification:

```bash
./bin/hushh protocol check-sync
```

or opt in for a single push:

```bash
CONSENT_PRE_PUSH_SYNC_CHECK=1 git push
```

CI keeps the advisory upstream-sync check as the shared evidence lane. Actual
`sync` and `push` operations remain explicit maintainer commands and are never
performed by the pre-push hook.

The older, more detailed subtree notes may still exist temporarily during cleanup, but this page is the canonical ownership boundary.
