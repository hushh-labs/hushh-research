# Release Train and Environment Parity Contract

This reference defines the uniform team-wide versioning and bidirectional promotion discipline across `dev`, `uat`, and `main` (Production). All merge approvals, Admin SOP exceptions, and environment deployments remain governed by `.agents/skills/repo-operations/references/admin-release-sop.md`.

## Core Invariants

1. **Zero Friction on Dev, Merge-Only Between Lanes:** Individual feature PRs into `dev` carry no manual version-manifest burden. Between environments (`main`, `uat`, `dev`), cherry-picking is prohibited because it severs Git ancestry and causes silent feature and schema drift.
2. **Upstream-First Bidirectional Back-Sync:** Before opening any `dev -> uat` promotion, reconcile every un-synced commit from `main` and `uat` downward into `dev` first. Resolve every merge conflict, contract regeneration, and schema sequence collision on `dev` until `dev` CI is green. Only after `dev` is a clean superset of `uat` and `main` may `dev` promote upward into `uat`.
3. **Never Alter Accepted Upstream Migrations:** When `dev` and `uat` claim the same integer migration number with different SQL files, preserve the upstream `uat` (or `main`) migration byte-for-byte and re-sequence the `dev`-only migration above the shared high-water mark before landing on `dev`.
4. **Calendar Release Trains (`YYYY.MM.N`):** Each `dev -> uat` convergence cut receives the next sequential calendar train identifier (aligned with `deploy/pod-release.json`, e.g., `2026.11.40`, tagged `train/2026.11.40` after qualification). Train `N` guarantees inclusion of every change from trains `1..N-1` plus the converged branch cut.

## 5-Dimension Live Parity Matrix

Run `./bin/hushh agents release-parity --live-cloud --text` (or `--json`) before and after every promotion to inspect all five dimensions from live Git and cloud truth:

| Dimension | Source of Truth | Blocking Condition |
|---|---|---|
| Code Parity and Merge Fidelity | Git ancestry and two-parent tree-blob inspection across `origin/dev`, `origin/uat`, `origin/main` | Blocks unsynced upstream commits with `--require-clean-upstream`, and always blocks asymmetric `-s ours` / `-X ours` back-sync merges that silently drop upstream UAT or Main changes |
| Schema Parity | `consent-protocol/db/migrations/` filenames and blob SHAs | Any duplicate migration sequence number or divergent SQL body across lanes blocks immediately |
| Calendar Release Trains | `train/YYYY.MM.N` tags, `deployed/*` tags, `deploy/pod-release.json` | Computes the next sequential train ID (`YYYY.MM.N`) |
| Runtime Capability Closure and Serving Drift | Read-only Cloud Run metadata and health/verification probes across `hushh-pda-dev`, `hushh-pda-uat`, `hushh-pda` | Fails closed on simulation or BYOC-live leakage on UAT/Prod, missing Ed25519/Edge Gateway closure when sandbox cutover is active, and branch-ahead-of-serving drift with `--require-serving-parity` |
| Candidate Release Train Manifest | Per-feature and per-author trace of `uat..dev` commits | Prevents opaque whole-branch dumps by surfacing every feature domain and author included in the candidate train |

## Standard Promotion Sequence

1. **Preflight Parity and Feature Manifest Audit:** Run `./bin/hushh agents release-parity --require-clean-upstream --live-cloud --text` and review the feature/author manifest to verify incomplete Dev-only surfaces are cleanly build-gated outside Dev.
2. **Symmetric Back-Sync Upstream to Dev (When Blocked):** In an isolated `dev` task worktree, merge `origin/main` and `origin/uat` symmetrically (never `-X ours`), re-sequence any colliding Dev-only migrations above the watermark, prove CI green, land via `admin-release-sop.md`, and deploy `dev`.
3. **Re-Verify Clean Upstream and Merge Fidelity:** Confirm `./bin/hushh agents release-parity --require-clean-upstream --text` reports `status=ready`.
4. **Promote Single Unified Wave to UAT:** In an isolated `uat` task worktree, merge converged `origin/dev` while preserving Main-owned release-authority paths, tag `train/YYYY.MM.N`, run exact-source UAT qualification (`scope=all`, `uat_base_sha=<SERVING_UAT_SHA>`), deploy via `uat-scoped-deploy`, and immediately back-sync `uat -> dev`.
5. **Post-Deploy Serving Parity Proof:** Re-run `./bin/hushh agents release-parity --live-cloud --require-clean-upstream --require-serving-parity --text` to prove `status=ready` with `branch_ahead=0` on both Dev and UAT (verified through `train/2026.11.42`).
