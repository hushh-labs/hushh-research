# Release Train Bidirectional Parity Playbook

Use this workflow before any Dev-to-UAT promotion, after any UAT or Main hotfix, or whenever verifying what is live across Dev, UAT, and Production.

## Steps

1. Refresh remote refs (`git fetch origin main uat dev`) without switching branches in the serving checkout.
2. Run `./bin/hushh agents release-parity --require-clean-upstream --live-cloud --text` to audit code ancestry, symmetric merge fidelity, migration watermarks, Calendar Release Trains, live cloud capability closure plus branch-versus-serving drift, and the per-feature/per-author Candidate Release Train Manifest.
3. If upstream `uat` or `main` is ahead of `dev`, or any migration collision exists, create an isolated `dev` task worktree, merge `origin/main` and `origin/uat` symmetrically (never `-X ours`), preserve accepted upstream migrations verbatim, re-sequence colliding Dev-only migrations above the shared watermark, prove Dev CI green, land via `repo-operations` (`admin-release-sop.md`), and roll out Dev.
4. Re-run `./bin/hushh agents release-parity --require-clean-upstream --text`, confirm `status=ready`, and verify the Candidate Release Train Manifest shows every incomplete Dev-only feature cleanly build-gated outside Dev.
5. Promote converged `dev` into an isolated `uat` task worktree as a single unified wave (`train/YYYY.MM.N`) via true merge, qualify exact UAT source (`scope=all`, `uat_base_sha=<SERVING_UAT_SHA>`), deploy via `uat-scoped-deploy`, and immediately back-sync `uat -> dev`.
6. Run `./bin/hushh agents release-parity --live-cloud --require-clean-upstream --require-serving-parity --text` after deploy to verify `status=ready` with zero serving drift, complete capability closure, and zero Dev-simulation or BYOC-live leakage on UAT or Production.
