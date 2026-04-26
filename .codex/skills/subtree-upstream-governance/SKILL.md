---
name: subtree-upstream-governance
description: Use when changing upstream-first coordination, subtree sync policy, or maintainer-only subtree governance between consent-protocol and hushh-research.
---

# Hussh Subtree Upstream Governance Skill

## Purpose and Trigger

- Primary scope: `subtree-upstream-governance-intake`
- Trigger on upstream-first sync rules, subtree metadata parity, maintainer-only subtree docs, or sync validation between `consent-protocol` upstream and `hushh-research`.
- Avoid overlap with `repo-operations`, `docs-governance`, and `backend`.

## Coverage and Ownership

- Role: `owner`
- Owner family: `subtree-upstream-governance`

Owned repo surfaces:

1. `docs/reference/operations/subtree-maintainers.md`
2. `scripts/ci/subtree-sync-check.sh`
3. `.codex/skills/subtree-upstream-governance`

Non-owned surfaces:

1. `repo-operations`
2. `docs-governance`
3. `backend`
4. `contributor-onboarding`
5. `oss-license-governance`

## Do Use

1. Upstream-first routing rules for `consent-protocol`.
2. Subtree sync and parity validation.
3. Maintainer-only subtree docs and contributor-invisible subtree policy.
4. Coordinating license or onboarding parity across upstream and subtree surfaces.

## Do Not Use

1. Normal contributor bootstrap or first-run docs.
2. Generic CI/deploy operations not specific to subtree/upstream drift.
3. Backend runtime implementation work.

## Read First

1. `docs/reference/operations/subtree-maintainers.md`
2. `scripts/ci/subtree-sync-check.sh`
3. `consent-protocol/README.md`
4. `contributing.md`

## Workflow

1. Keep upstream-first rules explicit and keep subtree mechanics out of normal contributor onboarding.
2. Treat subtree sync metadata drift as a governance problem, not a casual local workaround.
3. Keep root and subtree license and onboarding contracts aligned when the same policy spans both.
4. Run a second subtree/parity check after edits.
5. For cross-repo contract changes that affect release authority, contributor docs, or licensing, run a third verification before calling the subtree contract stable.

## Handoff Rules

1. If the task becomes generic CI/deploy governance, use `repo-operations`.
2. If the task becomes docs-home governance, use `docs-governance`.
3. If the task becomes licensing governance, use `oss-license-governance`.
4. If the task becomes contributor onboarding, use `contributor-onboarding`.
5. If the task becomes backend implementation, use `backend`.

## Required Checks

```bash
./scripts/ci/subtree-sync-check.sh
python3 scripts/licenses/verify_apache_surface.py
./bin/hushh docs verify
```
