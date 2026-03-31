# Subtree Maintainers

This page is maintainer-only context.

## Visual Context

Canonical visual owner: [Operations Index](README.md). Use that map for the top-down operations view; this page defines one maintainer-only boundary.

Normal contributors should not need subtree knowledge to clone the repo, boot the app, or open a PR.

## What Stays True

- `consent-protocol/` still has an upstream synchronization contract.
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

The older, more detailed subtree notes may still exist temporarily during cleanup, but this page is the canonical ownership boundary.
