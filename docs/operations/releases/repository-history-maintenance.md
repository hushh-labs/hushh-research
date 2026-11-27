# Repository history maintenance

Prepared November 10, 2026. Target the next agreed weekend maintenance window;
November 14–15 is provisional. The exact window, operator and collaborator
acknowledgements must be confirmed. No rewrite or deployment is scheduled.

## Visual Context

The [operations index](./README.md) owns the governance map. This plan follows
that ownership from inventory and rehearsal through publication and recovery.

## Objective and current status

Remove reviewed sensitive material and generated run evidence from shared Git
history while preserving source, required runtime contracts, assets, branch
names and unique contributor work. Keep the existing Dev, UAT and Main source
differences. Rewriting these branches does not automatically migrate feature
branches, PRs, forks or local clones.

The November 10 audit inventoried a frozen scope of 38,711 commits, including
advertised PR refs. Its strict credential scans completed with potential
matches requiring contextual review. Known removal material remains reachable;
no shared-history purge has been published. Dev and UAT advanced during that
audit, so its captured tips are not publication inputs.

Keep detailed findings, exact removal manifests, owner-identifying paths and
scan receipts in restricted, ignored local or controlled CI artifacts. This
document is the maintained execution plan, not a copy of those reports.

## Before the maintenance window

1. Land prevention rules and the corresponding evidence-reader changes on the
   current central implementations through normal governed PRs. Preserve
   authored contracts, runtime mirrors, dependency locks, synthetic fixtures
   and required app artwork. Do not bring unrelated feature work along.
2. Curate exact historical path/blob removals. Verify producer and consumer
   ownership; ignore rules and file extensions alone do not authorize erasure.
   The reviewed simulation-output boundary is the historical `.sim` directory
   under `consent-protocol`, not all
   binary records or SQLite files. Credential recovery remains a separate
   owner-controlled action.
3. Capture retained branches/tags, active and stacked PR dependencies,
   protections/rulesets, queue state, unpublished work and per-service serving
   provenance. Resolve inactive branch/PR retirement separately. An old tip
   commit timestamp is not a last-push timestamp.
4. Resolve immutable deployment/release tags and SHA-pinned consumers. Keeping
   old tags can retain targeted history; silently retagging them misrepresents
   provenance. Record the approved treatment before publication.
5. Rehearse one consistent old-to-new commit mapping in a fresh isolated bare
   candidate. Preserve each retained tip's source outside approved removals.
   Do not reset Dev/UAT to Main or merge cleaned Main into tainted old parents.
   Measure affected PRs, representative contributor migration conflicts and
   actual packed-size savings. Do not reuse an old sanitized candidate.

Use current protected-Main governance for control-workflow authority and
application-source admission. Reconcile serving baselines, compatibility,
rollback and protected-source membership explicitly; a SHA map is not a new
build, test receipt or release acceptance.

## Maintenance window

1. Confirm the writer pause and drain merge queues, auto-merge, ref-writing bots
   and deployment/tag workflows. Plan CI trigger handling so the migration does
   not launch redundant validation for thousands of historical refs. Required
   security and release qualification remain mandatory.
2. Capture fresh expected-old SHAs for every selected writable ref. Scan and
   rehearse the delta since the audit. Stop on unexplained drift.
3. Snapshot and minimally amend the necessary protections under the existing
   maintainer procedure. Preflight restoration and the supported exact-SHA
   qualification path. Admin access does not bypass every ruleset.
4. Publish explicit ref mappings with explicit expected-old leases. Update the
   three central refs atomically when support is verified; keep the pause while
   other selected refs are migrated. Never use a blanket mirror force-push.
5. Read back outcomes, then restore and verify protections. A partial result
   requires reconciliation before retrying. Keep writers paused; restoring old
   sensitive history is a separate security decision, not automatic recovery.
6. Qualify rewritten protected tips and release admission before resuming normal
   queues and writers. A history rewrite deploys nothing; deployments remain
   separately authorized.

## Contributor and external closure

Preserve uncommitted/unpublished work before clone migration. Prefer fresh
clones on the same named branches; replay only reviewed unmapped work onto the
new bases. Keep an explicit migration record for active PRs and stacks. Never
merge the old history back into the cleaned graph. Do not promise zero conflicts
without the representative rehearsals.

GitHub PR refs, cached views, forks, clones, LFS objects, submodule repositories,
release attachments and Actions artifacts/logs/caches have separate retention
boundaries. Record confirmed cleanup or an explicit remaining exception for
each. Closing a PR or deleting its branch does not prove historical erasure.

## Acceptance and handoff

| Gate | Required outcome |
|---|---|
| Scope | Every retained/retired ref and unresolved finding has an explicit disposition. |
| Preservation | Zero unintended non-removal tree differences; required blob IDs and modes retained. |
| Purge | Selected paths and sensitive blob identities absent from every retained candidate ref and independently checked candidate storage. |
| Races | Final leases match; no unaccounted writer or ref drift. |
| People | Active owners receive mapped bases and a verified migration path; conflicts are recorded. |
| Release | Required new-tip checks pass; protections restored; serving provenance preserved. |
| External copies | Confirmed outcomes or explicit exceptions; no universal-erasure claim from branch updates alone. |
| Resources | Original named checkout preserved; task worktrees, processes and disposable private inputs cleaned. |

Retain restricted recovery material only for its agreed recovery obligation,
with an owner and expiry. Do not publish backup branches containing the removed
material. Keep the final sanitized receipt outside source commits.

## Operating references

- [Branch governance](./branch-governance.md)
- [CI and controlled validation](./ci.md)
- [GitHub sensitive-history guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)
- [Git push leases and atomic updates](https://git-scm.com/docs/git-push)
