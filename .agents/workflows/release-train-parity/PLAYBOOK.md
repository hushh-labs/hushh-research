# Release Train Bidirectional Parity Playbook

Use this workflow before any Dev-to-UAT promotion, after any UAT or Main hotfix, or whenever verifying what is live across Dev, UAT, and Production.

## Steps

1. Refresh remote refs (`git fetch origin main uat dev`) without switching branches in the serving checkout.
2. Run `./bin/hushh agents release-parity --require-clean-upstream --live-cloud --text` to audit code ancestry, migration watermarks and collisions, Calendar Release Trains, and live cloud capability flags.
3. If upstream `uat` or `main` is ahead of `dev`, or any migration collision exists, create an isolated `dev` task worktree, merge `origin/main` and `origin/uat`, preserve accepted upstream migrations verbatim, re-sequence colliding Dev-only migrations above the shared watermark, prove Dev CI green, and land via `repo-operations` (`admin-release-sop.md`).
4. Re-run `./bin/hushh agents release-parity --require-clean-upstream --text` and confirm `status=ready`.
5. Promote converged `dev` into an isolated `uat` task worktree via true merge (never cherry-pick), preserve Main-owned release-authority paths, prove exact-source UAT CI green, and hand off merge and deploy to `repo-operations` and `uat-scoped-deploy`.
6. Record the sequential Calendar Release Train (`YYYY.MM.N`) and run `./bin/hushh agents release-parity --live-cloud --text` after deploy to verify live revisions, capability parity, and zero Dev-simulation leakage on UAT or Production.
