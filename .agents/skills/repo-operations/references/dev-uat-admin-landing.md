# Ordinary Dev/UAT maintainer landing

An eligible maintainer may land their own ordinary product PR into Dev or UAT
through the verified queue after this authority is installed on the destination.
They do not need Kushal or Ankit to review
an ordinary product change. GitHub's `allowed-maintainers-to-approve` team is the
maintainer mirror; the target's canonical policy and live branch exceptions must
both authorize the operator. Team membership does not grant Main or production
permission. If an ordinary review is requested, use the maintainer team rather than
requesting Kushal/Ankit personally.

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
   current-head authorization of Kushal or Ankit. Maintainer/Admin membership
   does not bypass this gate. Do not add either person to ordinary PRs merely
   because the author wants to use Admin SOP.
4. Only after those checks, request the ordinary queue for the exact head:

   ```bash
   gh pr merge <number> --repo hushh-labs/hushh-research \
     --match-head-commit <verified-head>
   ```

5. Confirm the queue validated the combined tree and read back the landed PR.
   An uncertain response requires reconciliation before retry. A merge never
   dispatches Dev, UAT or production; deployment is a separate authorized action.

The queue reads the maintainer and protected-owner lists from the exact current
protected Main revision, rechecks them before clearance and requires an owner
approval for protected changes. A direct `--admin` command is a separate bypass;
do not use it as a substitute for combined-result evidence.

`./bin/hushh codex admin-merge` also admits Kushal or Ankit's own Dev/UAT PRs after
the destination's strict owner guard is installed and verified. Other Dev/UAT
maintainers use the queue; Main's additional direct operators do not inherit this
exception. It verifies the current destination, exact head and successful CI
evidence. A direct-route refusal does not imply an ordinary product PR needs a
personal review. Main has its own
merger cohort and code-owner review requirements, described in the
[branch governance runbook](../../../../docs/reference/operations/branch-governance.md).

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
