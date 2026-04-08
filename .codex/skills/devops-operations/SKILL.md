---
name: devops-operations
description: Use when working on Hushh CI/CD, branch protection, merge queue, GitHub Actions, deploys, env or secret parity, Cloud Run or Cloud Build operations, UAT or production rollout, incident triage, or operational verification. This skill is repo-scoped to hushh-research and stays single-agent unless the user explicitly asks for delegation or parallel agent work.
---

# Hushh DevOps Operations Skill

Use this skill for repository operations and delivery work.

## Read first

1. `docs/reference/operations/README.md`
2. `docs/reference/operations/ci.md`
3. `docs/reference/operations/branch-governance.md`
4. `docs/reference/operations/cli.md`
5. `docs/reference/operations/env-and-secrets.md`

Load these references only when needed:

1. `references/operations-surface.md`
2. `references/deploy-and-release.md`
3. `references/agent-trigger-policy.md`

## Trigger rules

Trigger this skill when the request is about:

1. CI or GitHub Actions failures
2. branch protection, merge queue, or freshness policy
3. UAT or production deploys
4. Cloud Run, Cloud Build, or runtime rollout issues
5. environment or secret parity
6. operational readiness, rollback, or incident triage

Do not use this skill for:

1. frontend UI or design-system changes
2. generic backend feature work without an operations angle
3. GitHub board/project management only
4. ordinary product coding tasks

## Operating rules

1. Prefer live verification over assumptions for GitHub, CI, branch protection, and deploy state.
2. Use `./bin/hushh` as the canonical repo command surface.
3. Use repo docs for policy and `gh` for live GitHub state.
4. Treat `main` as the only integration branch.
5. Treat merge queue as the standard merge path for `main`.
6. Treat `CI Status Gate` as the classic blocking status check and `Main Freshness Gate` as advisory on pull requests, blocking on `merge_group`.
7. Treat approval, mergeability, and admin bypass as separate states. Do not infer one from another.
8. Self-approval is not valid approval. If the active GitHub identity is the PR author, Codex must not claim the PR is approved.
9. When a user says they are an admin, verify the live ruleset before taking action. Admin can bypass only if the repository rules actually permit it.
10. If review is still required, say that explicitly and prefer queue or ruleset-compliant action over pretending the requirement is satisfied.
11. After any PR merge, bypass merge, workflow dispatch, or deploy trigger, keep monitoring the resulting CI and downstream workflows until they reach a terminal state.
12. Do not stop at "triggered". Report the final state or the first concrete blocker.
13. For failures inside the DevOps/CI/release ownership surface, do not stop at diagnosis. Attempt the fix, rerun the affected workflow path, and continue the loop until the change is merged or a hard blocker remains.
14. Escalate only when the blocker is outside the safe operating surface, such as product-behavior regressions, missing external credentials, policy restrictions the current identity cannot bypass, or ambiguous ownership.

## Tooling preferences

1. Use local shell and `gh` for live repository, PR, branch protection, and Actions checks.
2. Use the root CLI for local operational workflows:

```bash
./bin/hushh ci
./bin/hushh docs verify
./bin/hushh sync main
./bin/hushh doctor --mode uat
```

3. Use MCP only when it directly improves repo operations work and is already configured. Do not invent MCP dependencies.

## Post-action monitoring

1. After merges to `main`, monitor:
   - the resulting `Tri-Flow CI` push run
   - the downstream `Deploy to UAT` workflow if the `main` run goes green
2. After manual deploy or workflow dispatch actions, monitor the triggered workflow until:
   - success
   - failure with a concrete failing job/step
   - explicit skip or policy block
3. Prefer `gh run list`, `gh run view`, and `gh pr checks` for live monitoring.
4. Report exact failing workflow, job, and step when available. Do not summarize a failed rollout as merely "CI failed".
5. If the failure is operational and locally actionable, move immediately into fix mode:
   - inspect the failing job and exact step
   - patch the workflow, policy, script, or deploy config in scope
   - rerun the smallest authoritative validation
   - push the fix through the correct PR or bypass path
   - continue monitoring until terminal success or a hard blocker
6. Do not claim completion while a merge, `main` CI run, or downstream deploy remains unresolved.

## Approval and admin handling

1. Use `gh auth status` and `gh pr view` to verify:
   - active GitHub identity
   - PR author
   - review decision
   - merge state
2. If the active identity matches the PR author, do not attempt self-approval.
3. If the user is an admin, inspect whether the current ruleset allows:
   - admin merge bypass
   - merge queue only
   - required reviews without bypass
4. When merge queue is enabled, prefer enabling auto-merge or queue entry instead of forcing a direct merge.
5. If a PR is green but blocked only by review, report that as a policy blocker, not as a CI blocker.
6. If the active identity is an allowed bypass actor, Codex may use the bypass path only after required CI is green and only when the live rules permit it.
7. Do not treat direct pushes to `main` as the standard bypass workflow. Prefer a green PR plus bypass merge over direct branch pushes.
8. If the user explicitly wants a bypass landing, Codex should:
   - verify required checks are green
   - verify bypass eligibility on the live branch protection/ruleset
   - use the least-destructive allowed path
   - restore any temporarily changed rules immediately after the merge
9. If rules do not permit bypass, Codex must say so directly instead of improvising a pseudo-approval flow.

## Delegation policy

1. Stay single-agent by default.
2. Do not spawn sub-agents automatically for DevOps work.
3. Only use parallel agents when the user explicitly asks for delegation or parallel agent work.
4. If delegation is explicitly allowed, split work by bounded ops surfaces such as:
   - CI log triage
   - deploy configuration audit
   - env or secret parity audit

## Required checks

Use the smallest real validation set that matches the change:

```bash
./bin/hushh docs verify
./bin/hushh ci
./scripts/ci/verify-main-branch-protection.sh
```

For deploy or secrets changes, also verify the relevant workflow or runtime docs path before concluding.
