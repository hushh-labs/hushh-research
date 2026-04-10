# DevOps Operations Surface

Use this reference to orient DevOps work in `hushh-research`.

## Canonical sources of truth

1. `docs/reference/operations/ci.md`
2. `docs/reference/operations/branch-governance.md`
3. `docs/reference/operations/cli.md`
4. `docs/reference/operations/env-and-secrets.md`
5. `docs/reference/operations/env-secrets-key-matrix.md`
6. `docs/reference/operations/observability-google-first.md`
7. `docs/reference/operations/production-db-backup-and-recovery.md`

## Canonical repo-level commands

```bash
./bin/hushh codex ci-status
./bin/hushh ci
./bin/hushh docs verify
./bin/hushh sync main
./bin/hushh doctor --mode uat
./bin/hushh env use --mode uat
```

## Live-state verification surfaces

1. GitHub branch protection and rulesets via `gh api`
2. GitHub PR and Actions state via `gh pr`, `gh run`, and `gh api`
3. deploy workflow state via repository Actions runs
4. Cloud Run and Cloud Build only after verifying the repo workflow and env contract
5. Codex PR check routing via `./bin/hushh codex ci-status`

## Repo invariants

1. `main` is the only integration branch.
2. Merge queue is the standard path to `main`.
3. `CI Status Gate` is the blocking queue/PR check on pre-merge commits.
4. `Main Freshness Gate` is advisory on PRs and blocking on `merge_group`.
5. `Main Post-Merge Smoke Gate` is the deploy-authority check on the real `main` SHA.
6. UAT deploys from a green `main` SHA that passed post-merge smoke.
7. Production deploys from an approved green `main` SHA that passed post-merge smoke.

## Review bypass semantics

1. Review approval and review bypass are different GitHub states.
2. A PR author cannot self-approve through GitHub.
3. A bypass-listed actor may still waive the review gate when the live branch protection allows it.
4. Merge-queue rules remain separate from review bypass and must be verified independently.
5. The privileged three may dispatch UAT manually; only `kushaltrivedi5` may dispatch Production.
