# Release Train and Environment Parity Contract

This reference defines the uniform team-wide versioning and bidirectional promotion discipline across `dev`, `uat`, and `main` (Production). All merge approvals, Admin SOP exceptions, and environment deployments remain governed by `.agents/skills/repo-operations/references/admin-release-sop.md`.

## Core Invariants

1. **Zero Friction on Dev, Merge-Only Between Lanes:** Individual feature PRs into `dev` carry no manual version-manifest burden. Between environments (`main`, `uat`, `dev`), cherry-picking is prohibited because it severs Git ancestry and causes silent feature and schema drift.
2. **Upstream-First Bidirectional Back-Sync:** Before opening any `dev -> uat` promotion, reconcile every un-synced commit from `main` and `uat` downward into `dev` first. Resolve every merge conflict, contract regeneration, and schema sequence collision on `dev` until `dev` CI is green. Only after `dev` is a clean superset of `uat` and `main` may `dev` promote upward into `uat`.
3. **Never Alter Accepted Upstream Migrations:** When `dev` and `uat` claim the same integer migration number with different SQL files, preserve the upstream `uat` (or `main`) migration byte-for-byte and re-sequence the `dev`-only migration above the shared high-water mark before landing on `dev`.
4. **Calendar Release Trains (`YYYY.MM.N`):** Each `dev -> uat` convergence cut receives the next sequential calendar train identifier (aligned with `deploy/pod-release.json`, e.g., `2026.11.40`, tagged `train/2026.11.40` after qualification). Train `N` guarantees inclusion of every change from trains `1..N-1` plus the converged branch cut.

## 4-Dimension Live Parity Matrix

Run `./bin/hushh agents release-parity --live-cloud --text` (or `--json`) before and after every promotion to inspect all four dimensions from live Git and cloud truth:

| Dimension | Source of Truth | Blocking Condition |
|---|---|---|
| Code Parity | Git ancestry across `origin/dev`, `origin/uat`, `origin/main` | With `--require-clean-upstream`, any commit in `uat` or `main` missing from `dev` blocks upward promotion |
| Schema Parity | `consent-protocol/db/migrations/` filenames and blob SHAs | Any duplicate migration sequence number or divergent SQL body across lanes blocks immediately |
| Calendar Release Trains | `train/YYYY.MM.N` tags, `deployed/*` tags, `deploy/pod-release.json` | Advisory version visibility; computes next sequential train ID |
| Runtime Capability Flags and Live Provenance | Read-only Cloud Run metadata across `hushh-pda-dev`, `hushh-pda-uat`, `hushh-pda` | Fails closed if `HUSHH_DEV_SIMULATION_ENABLED` is active on UAT or Production; exposes dark-code drift where code landed without required cloud bindings or gateway services |

## Standard Promotion Sequence

1. **Preflight Parity Check:** Run `./bin/hushh agents release-parity --require-clean-upstream --live-cloud --text`.
2. **Back-Sync Upstream to Dev (When Blocked):** In an isolated `dev` task worktree, merge `origin/main` and `origin/uat`, resolve conflicts and re-sequence any colliding Dev-only migrations, keep Dev-only runtime boundaries intact, prove CI green, and land via `admin-release-sop.md`.
3. **Re-Verify Clean Upstream:** Confirm `./bin/hushh agents release-parity --require-clean-upstream --text` reports `status=ready`.
4. **Promote Dev to UAT:** In an isolated `uat` task worktree, merge converged `origin/dev` while preserving Main-owned release-authority paths, prove exact-source UAT CI green, land via `admin-release-sop.md`, and hand off to `uat-scoped-deploy`.
5. **Post-Deploy Parity Proof:** Re-run `./bin/hushh agents release-parity --live-cloud --text` to prove live revisions, Edge Gateway presence, capability flags, and zero unsafe simulation leakage.
