---
name: oss-license-governance
description: Use when changing Apache-2.0 licensing, SPDX/REUSE coverage, package license metadata, or third-party notice generation across consent-protocol and hushh-research.
---

# Hushh OSS License Governance Skill

## Purpose and Trigger

- Primary scope: `oss-license-governance-intake`
- Trigger on Apache-2.0 transition work, `LICENSE` or `NOTICE` updates, SPDX/REUSE coverage, package license metadata changes, or third-party notice inventory generation.
- Avoid overlap with `docs-governance`, `repo-operations`, and `backend`.

## Coverage and Ownership

- Role: `owner`
- Owner family: `oss-license-governance`

Owned repo surfaces:

1. `LICENSE`
2. `LICENSES`
3. `NOTICE`
4. `REUSE.toml`
5. `THIRD_PARTY_NOTICES.md`
6. `consent-protocol/LICENSE`
7. `consent-protocol/NOTICE`
8. `consent-protocol/THIRD_PARTY_NOTICES.md`
9. `scripts/licenses`
10. `.codex/skills/oss-license-governance`

Non-owned surfaces:

1. `docs-governance`
2. `repo-operations`
3. `backend`
4. `frontend`
5. `subtree-upstream-governance`

## Do Use

1. Apache-2.0 license-surface changes across root and subtree.
2. SPDX/REUSE coverage and notice-generation policy.
3. Package-manifest license cleanup for first-party published packages.
4. Third-party notice inventory generation and verification.

## Do Not Use

1. Generic docs-home placement work.
2. CI/deploy operations work unless the issue is license-gate specific.
3. Broad backend or frontend implementation that only incidentally touches licensed files.

## Read First

1. `LICENSE`
2. `NOTICE`
3. `REUSE.toml`
4. `consent-protocol/pyproject.toml`
5. `hushh-webapp/package.json`
6. `packages/hushh-mcp/package.json`

## Workflow

1. Keep Apache-2.0 as the first-party default across root and subtree unless an explicit exception is documented.
2. Keep `NOTICE`, REUSE coverage, and third-party inventories aligned in the same change.
3. Treat package-manifest license drift as a release blocker for public packages.
4. Generate notice artifacts from real lockfiles and dependency metadata rather than hand-editing lists.
5. Run a second verification pass after editing the license surface.
6. For root plus subtree licensing changes, run a third check from the canonical repo entrypoint before closing the work.

## Handoff Rules

1. If the task is broader repo governance, use `repo-operations`.
2. If the task is documentation-home governance, use `docs-governance`.
3. If the task is subtree routing or upstream-first sync policy, use `subtree-upstream-governance`.
4. If the task is package-runtime behavior beyond the license surface, use `backend` or `frontend`.

## Required Checks

```bash
python3 scripts/licenses/verify_apache_surface.py
python3 scripts/licenses/generate_third_party_notices.py
./bin/hushh docs verify
```
