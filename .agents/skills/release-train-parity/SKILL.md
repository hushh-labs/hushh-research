---
name: release-train-parity
description: Use when planning or executing Dev, UAT, or Main cross-syncs, Calendar Release Train promotions, or auditing the 4-dimension Environment Parity Matrix (code ancestry, schema watermarks, runtime capability flags, and live cloud provenance).
---

# Hussh Release Train Parity Skill

## Purpose and Trigger

- Primary scope: `release-train-parity-scope`
- Trigger on bidirectional Dev/UAT/Main cross-syncs, upstream-first back-sync before Dev-to-UAT promotion, migration sequence collision checks, Calendar Release Train cuts, and live 4-dimension Environment Parity Matrix audits.
- Avoid overlap with `repo-operations`, `uat-scoped-deploy`, and `subtree-upstream-governance`.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `repo-operations`

Owned repo surfaces:

1. `scripts/ops/release_train_parity.py`
2. `consent-protocol/tests/test_release_train_parity.py`

Non-owned surfaces:

1. `repo-operations`
2. `uat-scoped-deploy`
3. `subtree-upstream-governance`
4. `backend`

## Do Use

1. Auditing code, schema, runtime capability flag, and cloud provenance parity across Dev, UAT, and Production.
2. Enforcing upstream-first back-sync (`Main -> UAT -> Dev`) and resolving code or migration collisions on Dev before promoting Dev to UAT.
3. Computing the next sequential Calendar Release Train (`YYYY.MM.N`) and verifying post-merge parity with zero cherry-pick drift.

## Do Not Use

1. Broad CI triage, branch-protection edits, or production incident recovery; route those to `repo-operations`.
2. Choosing or executing Cloud Run deploy scopes directly; hand off to `uat-scoped-deploy` and `repo-operations`.
3. Synchronizing external `consent-protocol` mirrors; route that to `subtree-upstream-governance`.

## Read First

1. `.agents/skills/release-train-parity/references/parity-matrix-contract.md`
2. `.agents/skills/repo-operations/references/admin-release-sop.md`
3. `.agents/skills/repo-operations/references/maintainer-branch-freshness.md`
4. `docs/operations/releases/branch-governance.md`
5. `docs/operations/releases/migration-governance.md`

## Workflow

1. Fetch fresh `origin/main`, `origin/uat`, and `origin/dev` and run `./bin/hushh agents release-parity --require-clean-upstream --live-cloud --text`.
2. Inspect the 5-dimension report: code ancestry, symmetric two-parent merge fidelity, database schema watermarks, live cloud capability closure plus branch-versus-serving SHA drift, and the per-feature/per-author Candidate Release Train Manifest.
3. If upstream `uat` or `main` has commits missing from `dev`, or any migration sequence collision exists, stop upward promotion and back-sync upstream into an isolated `dev` task worktree first.
4. Resolve every merge conflict symmetrically on `dev` (never use `-s ours` or `-X ours` against `uat` or `main`, which `compute_merge_fidelity` blocks automatically), regenerate contracts, and re-sequence any colliding Dev-only migrations above the shared watermark without altering accepted UAT/Main SQL.
5. Prove `dev` green through CI, land the back-sync PR into `dev` under `admin-release-sop.md`, and deploy `dev` so live Dev serves the exact candidate commit.
6. Re-run `./bin/hushh agents release-parity --require-clean-upstream --text`, verify `status=ready` (zero upstream delta, zero asymmetric merge violations, zero schema collisions), and review the Candidate Release Train Manifest to confirm every Dev-only experimental surface (such as BYOC or Puppy One) is cleanly build-gated outside Dev.
7. Promote converged `dev` into `uat` in a single unified Release Train wave (`train/YYYY.MM.N`) via true merge (never cherry-pick), qualify exact UAT source (`scope=all`, `uat_base_sha=<SERVING_UAT_SHA>`), deploy via `uat-scoped-deploy`, back-sync the tagged `uat` ref downstream to `dev`, and run `./bin/hushh agents release-parity --live-cloud --require-clean-upstream --require-serving-parity --text` to prove zero branch-to-cloud drift.

## Handoff Rules

1. Route all PR review routing, merge queue / Admin SOP landings, and Main governance updates to `repo-operations`.
2. Route UAT deployment dispatch and Cloud Run service provenance verification to `uat-scoped-deploy`.
3. Route database migration authority or schema contract questions to `backend` and `quality-contracts`.

## Required Checks

```bash
./bin/hushh agents release-parity --text
./bin/hushh agents release-parity --require-clean-upstream --text
python3 scripts/ops/release_train_parity.py --text
python3 .agents/skills/skill-authoring/scripts/skill_lint.py
```
