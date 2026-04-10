# Deploy and Release Reference

Use this reference when the task touches release flow, deploy verification, or rollback planning.

## Current release model

1. feature work merges into `main`
2. green `main` SHA is the deployable source of truth
3. UAT deploy is driven from green `main`
4. production deploy is an approved green `main` SHA

## Required verification order

1. verify workflow policy in `docs/reference/operations/ci.md`
2. verify branch/release policy in `docs/reference/operations/branch-governance.md`
3. verify env contract in `docs/reference/operations/env-and-secrets.md`
4. inspect live GitHub workflow state before concluding there is a deploy bug

## Common task classes

### CI or PR gate issue

1. inspect the failing check live
2. determine whether the failure is code, workflow, policy, or repository-config drift
3. verify the repo docs still describe the live rule correctly

### UAT deploy issue

1. confirm the source SHA is reachable from `origin/main`
2. confirm `CI Status Gate` succeeded for that SHA
3. inspect the UAT workflow run before changing deploy config
4. verify env and secret contract before treating the issue as app code

### Production release issue

1. confirm the chosen SHA is a green `main` SHA
2. confirm environment approval rules are the intended gate
3. do not bypass release policy in repo code to work around repo settings

## Rollback mindset

1. prefer redeploying a previously green `main` SHA over ad hoc hot edits
2. if the bug is in workflow or runtime config, isolate the smallest corrective change
3. document whether the failure was code, config, repo setting, or external platform state
