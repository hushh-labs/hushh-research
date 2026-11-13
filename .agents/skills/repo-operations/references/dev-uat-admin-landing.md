# Ordinary Dev/UAT maintainer landing

An eligible maintainer may land their own ordinary product PR into Dev or UAT
through the verified queue after this authority is installed on the destination.
They do not need personal pipeline-editor review for an ordinary product
change. GitHub's live `allowed-maintainers-to-approve` team is the
maintainer authority; the target's canonical policy and live branch exceptions must
both authorize the operator. Team membership does not grant Main or production
permission. If an ordinary review is requested, use the maintainer team rather than
requesting individuals merely for routing.
CODEOWNERS defaults ordinary changes to the maintainer Team. Run
`./bin/hushh agents review-route --pr <number> --apply` after creation or updates
to reconcile mixed or semantic-protected changes to `pipeline-editors` only.
The ordinary maintainer Team cannot override protected approval.

Use this bounded preflight before requesting the queue:

1. Confirm the actual destination is `dev` or `uat`. Check `gh api user`:
   the authenticated operator must be the PR author and belong to the destination
   maintainer cohort to use ordinary self-approval. Inspect the complete diff
   and live rules before requesting the queue.
2. Capture the exact head and current destination. Required checks on the current
   head must be terminal and successful; resolve conversations and review
   objections. Verify the combined result against the current destination. If
   that result is unproven, use the ordinary merge queue to validate it.
3. CI, release policy and protected fundamental guidance still require the
   current-head authorization from the live `pipeline-editors` team. Maintainer/Admin membership
   does not bypass this gate. Do not add personal reviewers to ordinary PRs merely
   because the author wants to use Admin SOP.
4. Only after those checks, request the ordinary queue for the exact head:

   ```bash
   gh pr merge <number> --repo hushh-labs/hushh-research \
     --match-head-commit <verified-head>
   ```

5. Confirm the queue validated the combined tree and read back the landed PR.
   An uncertain response requires reconciliation before retry. A merge never
   dispatches Dev, UAT or production; deployment is a separate authorized action.

Main-owned queue admission reads current GitHub Team membership, rechecks
authorization before clearance and requires pipeline-editor approval for protected
changes. A direct `--admin` command is a separate bypass;
do not use it as a substitute for combined-result evidence.

`./bin/hushh agents admin-merge` is the bounded **pipeline-editor author exception**
for Main, Dev and UAT. An eligible live pipeline-editor may explicitly approve
their own exact-head PR, subject to destination merge authority, successful CI
and combined-result proof.
Other Dev/UAT maintainers use the queue above; a refusal from the owner command
does not mean their ordinary PR needs a personal review. Main has its own
merger cohort and code-owner review requirements, described in the
[branch governance runbook](../../../../docs/operations/releases/branch-governance.md).

An owner direct merge advances the destination and can invalidate in-flight
queue checks. Prefer the queue for ordinary work and inspect active queue work
before using the direct exception; do not force a stale queue run green.

If canonical and live branch exceptions differ, record that specific drift and
reconcile it through a reviewed operations change. Keep required CI and protected
review intact.

## Stacked pull requests

Land the predecessor into its intended protected destination first. Then retarget
the dependent PR to that destination, preserve its unique changes and resolve any
actual conflicts. Retargeting requires validation against the new base. A PR into
a feature branch does not by itself qualify a Dev, UAT or production deployment.
The author requests each eligible queue entry under their own CLI identity.

