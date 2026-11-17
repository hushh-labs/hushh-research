# Release, Governance, And Pod Authority

Detailed operating rules referenced from `.agents/skills/repo-operations/SKILL.md`.

## Protected Review, Partitions, And Owner Merge

1. GitHub teams own access membership; only authorized leadership accounts manage team membership. Never run an old roster reconciler or restore revoked access from `config/ci-governance.json` arrays. `scripts/ci/apply-governance.py` manages repository safeguards only and never writes team membership.
2. The five governed destinations are `main`, `dev`, `uat`, `uat-isolated`, and `integration/pr-train`. Ordinary maintainers use the merge queue so trusted destination-owned authority validates the combined result rather than raw branch age.
3. Native protected-path review remains independent on every destination: changing CI, release policy, or `.agents/skills/` requires `@hushh-labs/pipeline-editors` authority. Installed native path partitions keep their exact assignments; new protected entrypoints append supplemental partitions of at most 15 patterns, never an in-place coverage shift.
4. Dev/UAT review reduction is staged: verify additive native review rulesets, install/read back owner strict-status and PR guards, narrow queue exceptions to configured protected owners, then reduce classic blanket review only after read-only verification passes against exact synced Main queue/guard/classifier blobs.
5. The trusted protected-edit classifier separates CI-reachable npm script changes (including lifecycle/transitive hooks) from dependency or local-only edits; backend test additions stay ordinary while removing CI identities requires owner authority. `uat-isolated` retains strict classic CI and blanket review with live pipeline-editor Admin exceptions under `admin-release-sop.md`.
6. When a configured pipeline editor authored a Main, Dev, UAT, or isolated UAT PR and needs self-approval bypass, use `queue_combined_result.py owner-merge` under `admin-release-sop.md` with exact head, destination ancestry, uncontested reviews, live strict status/PR protection, and identical successful combined-tree evidence. Generic organization-admin status is not merge authority.

## Release Control, CI Timing, And Verification Selection

1. Follow [Main-owned release control](../../../../docs/operations/releases/ci.md#main-owned-release-control): all explicit deployment entrypoints execute from `main` using protected inline/broker identity while application sources stay isolated on `dev` or `uat`. Verify caller and reusable-workflow permissions, exact source/attempt receipts, and live admission. No merge on any destination deploys an application.
2. For CI timing work, follow [deployment-overhead policy](../../../../docs/operations/releases/ci.md#deployment-overhead-and-retention-limits). Keep normal worker rollout until accepted input/state proof and measured benefit qualify reuse; report measurements separately from the 10–15 minute routine target.
3. Resolve expensive PKM and reviewer-browser checks exclusively through `scripts/ci/resolve-uat-verification-plan.py` without adding a parallel path classifier. App-browser reviewer diagnostics require explicit dispatch inputs and do not certify automatically.
4. For production GitHub WIF drift, inspect `python3 scripts/ci/verify-deploy-identity-provenance.py` (`--record-only` offline; live GCP requires read access rather than treating refused reads as pass) and update via `deploy/iam/setup_production_github_wif.sh` without creating parallel providers or JSON keys.
5. Batch CI pushes, keep Gitleaks read-only credentials isolated on PRs with repository-wide unresolved-secret clearance reserved for protected Deployment Security jobs, and use `./bin/hushh agents ci-rerun --run-id <id> --expected-attempt <n> --sha <sha>` for exact-source attempt retries.

## Private Pod Hosting

For private pod hosting, owner updates, and legacy bootstrap, follow the [Dev pod runbook](../../../../docs/operations/hosting/dev-pod-first-light-runbook.md), which owns durable admission, spend limits, owner custody, release provenance, and cleanup.
