---
name: repo-operations
description: Use when working on Hushh CI/CD, branch protection, merge queue, GitHub Actions, deploys, env or secret parity, Cloud Run or Cloud Build operations, UAT or production rollout, incident triage, or operational verification.
---

# Hushh Repo Operations Skill

## Purpose and Trigger

- Primary scope: `repo-operations-intake`
- Trigger on CI/CD, branch protection, merge queue, deploys, env parity, runtime rollout, and operational verification.
- Avoid overlap with `repo-context`, `planning-board`, and `docs-governance`.

## Coverage and Ownership

- Role: `owner`
- Owner family: `repo-operations`

Owned repo surfaces:

1. `bin`
2. `scripts`
3. `config`
4. `deploy`

Non-owned surfaces:

1. `docs-governance`
2. `planning-board`
3. `frontend`
4. `backend`
5. `analytics-observability-governance`

## Do Use

1. Failing CI or GitHub Actions investigation.
2. Branch protection, merge queue, freshness policy, and approval-state questions.
3. UAT or production deployment work, Cloud Run or Cloud Build issues, and environment parity checks.
4. Live PR check monitoring, failing-job classification, and fix-and-rerun ownership.

## Do Not Use

1. Product implementation or broad repo mapping work.
2. GitHub board/project-management workflows.
3. Documentation-home governance or frontend design-system work.

## Read First

1. `docs/reference/operations/README.md`
2. `docs/reference/operations/ci.md`
3. `docs/reference/operations/branch-governance.md`
4. `docs/reference/operations/cli.md`
5. `.codex/skills/repo-operations/references/agent-trigger-policy.md`

## Workflow

1. Prefer live verification over assumptions for GitHub, CI, deploy, and ruleset state.
2. Use `./bin/hushh` as the canonical repo command surface and `gh` for live repository state.
3. Move from diagnosis into fix-and-rerun for failures inside the repo-operations surface.
4. Use `./bin/hushh codex ci-status` for PR-check status and `scripts/ci/watch-gh-workflow-chain.sh` for long-running post-merge or deploy workflow chains.
5. Treat the delivery model as three stages: PR feedback lane, queue authority lane, and post-merge deploy-authority lane.
6. Treat GitHub approval and GitHub bypass as separate states: a PR author still cannot self-approve, but a bypass-listed actor may waive the review gate and, when configured, use the dedicated queue-bypass owner path.
7. Do not flag the sanctioned `main` owner-bypass cohort as governance drift when the live review-bypass allowlist exactly matches `config/ci-governance.json` and includes `kushaltrivedi5`.
8. Monitor the resulting workflow chain until terminal success or a concrete blocker.
9. For core authority surfaces, the task is not complete while GitHub still shows any relevant run for the touched SHA as `queued`, `in_progress`, or `requested`.
10. Core authority surfaces are `PR Validation`, `Queue Validation`, `Main Post-Merge Smoke`, `Deploy to UAT`, and any RCA-triggered release-authority rerun for the same SHA.
11. Before opening or updating a pull request, run `./bin/hushh codex pre-pr` as the canonical local mirror of `PR Validation` and `CI Status Gate`.
12. Before the first push of any branch that is headed to GitHub review or merge, verify that every local commit on the branch carries a DCO signoff trailer. Prefer `git commit -s` for new commits. If unsigned commits already exist, repair them before pushing with `git rebase --signoff <base>`.
13. If the change touches `.codex/`, `docs/`, `config/`, `scripts/`, or other governance-owned surfaces, rerun `bash scripts/ci/orchestrate.sh governance` after the final local edit instead of relying only on an earlier green `pre-pr` result.
14. Treat user intent literally: `merge to main` means land the change and monitor through `Main Post-Merge Smoke` only; do not dispatch UAT unless the user explicitly asks to deploy to UAT.
15. Treat `deploy to UAT` as a separate cadence: land the change on `main`, identify the exact green `main` SHA, manually dispatch `Deploy to UAT` for that SHA, then monitor the deploy chain to terminal state.
16. If a core run fails, default to the smallest safe repair and rerun loop before declaring a blocker. Only stop early for a real permissions, product, or platform boundary.
17. Default runtime launch behavior must be visible separate OS terminal windows, not hidden Codex sessions.
18. For local app work, prefer separate `./bin/hushh terminal backend --mode local --reload` and `./bin/hushh terminal web --mode <mode>` commands unless the user explicitly asks for something else.
19. Use hidden long-lived Codex sessions only for background monitoring, one-off debugging, or when a visible terminal is not desired.
20. Use `./bin/hushh terminal stack --mode local` only when one combined visible terminal is explicitly preferred.
21. When the user says `restart servers`, treat that as a graceful terminal-managed restart, not just a port kill. First inspect existing repo-launched visible terminals, stop the running backend/web processes, then terminate the login shells cleanly before closing any leftover windows so Terminal does not prompt `Do you want to terminate running processes in this window?`.
22. For macOS Terminal restarts, prefer this order:
   - identify the repo-launched Terminal tabs/windows and their ttys
   - stop the backend/web processes attached to those ttys
   - verify the ports are no longer listening
   - send `exit` into the affected Terminal tabs so the login shells terminate cleanly
   - wait for the windows to disappear on their own or become truly idle
   - only then close any leftover idle Terminal windows
   - relaunch fresh visible terminals
23. Do not close a Terminal window that still has a live shell just because the app listener is gone. A plain `close ... saving no` still triggers the terminate-process prompt on macOS if `zsh` is alive.
24. If a terminal refuses to disappear after `exit`, treat force-close as fallback only. Prefer proving the shell is gone first, then closing the leftover idle window.
25. If `./bin/hushh terminal web` opens but the frontend never binds, inspect the actual package surface before retrying. A common failure mode is `npm run dev` -> `sh: next: command not found`, which means the frontend install surface is broken even if dependencies appear partially present.
26. In that case, verify the local Next binary resolves from the `hushh-webapp` package context, for example by checking `npm exec next -- --version` or an equivalent package-local resolution step. If Next does not resolve, repair the workspace through the canonical bootstrap path (`./bin/hushh bootstrap`) before relaunching the web terminal.
27. Do not claim the server restart succeeded until both backend and web have been probed successfully after relaunch (`:8000/health` and `:3000`).
28. Default branch policy: continue work on the user's active development branch. Do not create a new temporary branch for incremental fixes, validation follow-ups, or polish work unless the user explicitly asks for branch isolation.
29. Create a new branch only when one of these is true:
   - the fix is a post-merge blocker and must start from the latest `main`
   - the repo workflow requires an isolated hotfix from `main`
   - the current branch contains unrelated in-flight work that would make the fix unsafe to ship
30. After a merge-driven hotfix is complete, delete the temporary branch remotely and locally when it is safe to do so, then return local state to the user's normal working branch or `main`; do not leave Codex parked on a temporary branch.
31. If the user has an active development branch, back-sync merged hotfixes into that branch before closing the task so the real working branch does not drift behind `main`.
32. For CI workflows, branch protection, env/bootstrap, or deploy-authority changes, do a second verification pass after edits instead of trusting the first green run.
33. For branch protection, merge queue, release authority, or production deploy-governance changes, do a third independent check against live GitHub or runtime state before calling the work complete.
34. For UAT runtime failures, start with `./bin/hushh codex rca --surface uat --text` so secret drift, legacy runtime mounts, DB drift, and semantic runtime breakage are classified before editing or redeploying.
35. Treat only core runtime/release surfaces as blocking in the RCA loop: runtime contract, deploy/runtime env contract, DB release contract, semantic UAT verification, and Gmail/voice/auth availability on the release lane. Helper-only drift stays advisory unless it masks one of those surfaces.
36. Do not conflate `Upstream Sync` with `Main Freshness Gate`. Freshness is branch-to-main currency; upstream sync is consent-protocol subtree state and must route through `subtree-upstream-governance`.
37. When rendering or summarizing PR operations, show the actual subtree status from `scripts/ci/subtree-sync-check.sh`, not a generic freshness or status-gate description.

## Handoff Rules

1. If the task is broad repo orientation, start with `repo-context`.
2. If the task is board/project work, use `planning-board`.
3. If the task is docs-home governance, use `docs-governance`.
4. If the task is GA4/Firebase/BigQuery observability topology or growth dashboard verification, use `analytics-observability-governance`.
5. If the task is licensing or third-party notice governance, use `oss-license-governance`.
6. If the task is contributor bootstrap, devcontainer, or first-run onboarding drift, use `contributor-onboarding`.
7. If the task is subtree/upstream coordination policy, use `subtree-upstream-governance`.
8. If the task is domain-specific backend or security implementation beyond repo operations, use `backend` or `security-audit`.

## Required Checks

```bash
./bin/hushh codex ci-status
./bin/hushh codex pre-pr
./bin/hushh codex rca --surface uat --text
./bin/hushh docs verify
./bin/hushh ci
./scripts/ci/verify-main-branch-protection.sh
./scripts/ci/verify-production-environment-governance.sh
```
