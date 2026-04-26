---
name: repo-operations
description: Use when working on Hussh CI/CD, branch protection, merge queue, GitHub Actions, deploys, env or secret parity, Cloud Run or Cloud Build operations, UAT or production rollout, incident triage, or operational verification.
---

# Hussh Repo Operations Skill

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

### Branch Preservation Gate

Run this gate before CI, deploy, PR, hotfix, or validation work:

1. Inspect and record the current branch before making edits, dispatching CI, merging, or deploying.
2. Treat the user's active development branch as the return target. Continue on that branch for incremental fixes, validation follow-up, and polish whenever it can safely carry the work.
3. Do not create a temporary branch for routine follow-up work. Create one only when the user explicitly asks for branch isolation, the repo workflow requires an isolated hotfix from latest `main`, or unrelated in-flight changes on the current branch make the fix unsafe to ship.
4. If a temporary branch is unavoidable, record the preserved development branch before switching. After merge and rollout validation, delete the temporary branch locally and remotely when safe, switch back to the preserved development branch, and back-sync the landed `main` commits into it.
5. If a fix lands directly on `main`, update the preserved development branch from `origin/main` before handoff so developer work does not drift behind the deployed fix.
6. Do not leave the workspace detached, parked on `main`, or parked on a temporary branch at handoff unless the user explicitly asked for that state. If conflicts or local-only edits prevent restoration, state the blocker and the exact branch left checked out.

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
19. If the user explicitly says `inline`, `inside Codex`, `in Codex`, or asks to keep the servers/background logs in the Codex session, run the same canonical backend/web commands directly through long-lived Codex `exec_command` sessions and keep those sessions open until the user asks to stop or the task ends.
20. Use hidden long-lived Codex sessions only for the explicit inline override, background monitoring, one-off debugging, or when a visible terminal is not desired.
21. Use `./bin/hushh terminal stack --mode local` only when one combined visible terminal is explicitly preferred.
22. When the user says `restart servers`, treat that as a graceful terminal-managed restart, not just a port kill. First inspect existing repo-launched visible terminals, stop the running backend/web processes, then terminate the login shells cleanly before closing any leftover windows so Terminal does not prompt `Do you want to terminate running processes in this window?`.
23. When the user says `restart servers inline`, stop any existing repo-launched backend/web listeners first, then run `./bin/hushh backend --mode local --reload` and `./bin/hushh web --mode local` in long-lived Codex sessions instead of reopening Terminal windows.
24. For macOS Terminal restarts, prefer this order:
   - identify the repo-launched Terminal tabs/windows and their ttys
   - stop the backend/web processes attached to those ttys
   - verify the ports are no longer listening
   - send `exit` into the affected Terminal tabs so the login shells terminate cleanly
   - wait for the windows to disappear on their own or become truly idle
   - only then close any leftover idle Terminal windows
   - relaunch fresh visible terminals
25. Do not close a Terminal window that still has a live shell just because the app listener is gone. A plain `close ... saving no` still triggers the terminate-process prompt on macOS if `zsh` is alive.
26. If a terminal refuses to disappear after `exit`, treat force-close as fallback only. Prefer proving the shell is gone first, then closing the leftover idle window.
27. If `./bin/hushh terminal web` opens but the frontend never binds, inspect the actual package surface before retrying. A common failure mode is `npm run dev` -> `sh: next: command not found`, which means the frontend install surface is broken even if dependencies appear partially present.
28. In that case, verify the local Next binary resolves from the `hushh-webapp` package context, for example by checking `npm exec next -- --version` or an equivalent package-local resolution step. If Next does not resolve, repair the workspace through the canonical bootstrap path (`./bin/hushh bootstrap`) before relaunching the web terminal.
29. Do not claim the server restart succeeded until both backend and web have been probed successfully after relaunch (`:8000/health` and `:3000`).
30. Default branch policy: continue work on the user's active development branch. At task start, identify and preserve that branch as the return target before any temporary hotfix, detached checkout, or merge/deploy operation.
31. If the workspace is detached or sitting on a temporary branch and the user has an established development branch, switch back to that branch before starting new edits unless the user explicitly asks for a different base.
32. Do not create a new temporary branch for incremental fixes, validation follow-ups, or polish work unless the user explicitly asks for branch isolation.
33. Create a new branch only when one of these is true:
   - the fix is a post-merge blocker and must start from the latest `main`
   - the repo workflow requires an isolated hotfix from `main`
   - the current branch contains unrelated in-flight work that would make the fix unsafe to ship
34. After a merge-driven hotfix is complete, delete the temporary branch remotely and locally when it is safe to do so, then return local state to the user's preserved development branch; use `main` only when the user has no development branch.
35. Back-sync merged hotfixes into the preserved development branch before closing the task so the real working branch does not drift behind `main`.
36. Do not leave the workspace detached or parked on a temporary branch at handoff. If a branch switch is unsafe because of conflicts or local-only edits, state the blocker explicitly and leave the user on their development branch whenever possible.
37. For CI workflows, branch protection, env/bootstrap, or deploy-authority changes, do a second verification pass after edits instead of trusting the first green run.
38. For branch protection, merge queue, release authority, or production deploy-governance changes, do a third independent check against live GitHub or runtime state before calling the work complete.
39. For UAT runtime failures, start with `./bin/hushh codex rca --surface uat --text` so secret drift, legacy runtime mounts, DB drift, and semantic runtime breakage are classified before editing or redeploying.
40. Treat only core runtime/release surfaces as blocking in the RCA loop: runtime contract, deploy/runtime env contract, DB release contract, semantic UAT verification, and Gmail/voice/auth availability on the release lane. Helper-only drift stays advisory unless it masks one of those surfaces.
41. For Firebase Auth env parity work, verify the shared auth project, API key restrictions, auth domain, authorized domains, phone provider state, and app-verification flag separately; do not treat a local real-SMS `too-many-requests` throttle as proof that UAT is misconfigured.
42. Before claiming a UAT auth rollout is ready, confirm the hosted UAT origin is authorized in Firebase Auth and that local origin changes did not break vault/passkey behavior.
43. Do not conflate `Upstream Sync` with `Main Freshness Gate`. Freshness is branch-to-main currency; upstream sync is consent-protocol subtree state and must route through `subtree-upstream-governance`.
44. When rendering or summarizing PR operations, show the actual subtree status from `scripts/ci/subtree-sync-check.sh`, not a generic freshness or status-gate description.

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
