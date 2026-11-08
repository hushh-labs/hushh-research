# Destination synchronization and combined validation

Start from the branch that will receive the change. Freshness is a development
procedure; being behind the destination is not, by itself, a reason to reject a PR.
The merge queue verifies the actual combined result before landing.

## Preserve and reconcile

1. Record the current branch, dirty files and peer work. Do not switch the root
   checkout or discard edits to synchronize.
2. Fetch the actual destination (`main`, `uat`, `dev` or `integration/pr-train`).
   Inspect its new commits, the merge base and the change's dependency boundaries.
3. Reconcile relevant Main fixes into UAT/Dev and UAT fixes into Dev when starting
   or continuing work. Preserve provenance in the existing release record.
4. Use a normal merge for shared published history. Rebase unpublished owned
   commits only when appropriate; never rewrite someone else's branch.
5. Resolve conflicts by behavior, preserving both owners' contracts. Regenerate
   affected contracts and run the nearest authoritative checks.
6. Push a finished batch. Another push cancels the previous PR validation run.
   Do not synchronize repeatedly only to make ancestry equal.

Selected Dev changes may be assembled on UAT with their dependencies; Dev is not
promoted wholesale. UAT-directed work can start on UAT. Main receives reviewed
operations/hotfix deltas and approved product content. None of these source
operations deploys any environment. There is no sync bot or scheduled merge.

## Agent-owned downstream completion

The coding agent completing a merge owns its downstream source syncs as part of
that same task. Do not hand routine sync commands back to the developer.

| Landed source | Required destinations |
|---|---|
| Main | UAT and Dev |
| UAT | Dev |
| Dev | No automatic upward promotion |

1. Pin the landed PR, commit and required dependencies. Reconcile that reviewed
   change into each destination by behavior, preserving its independent work and
   environment configuration; do not replace whole branch trees.
2. Reuse an existing sync PR or record the destination commit when equivalent
   content is already present. Coalesce overlapping Main/UAT syncs so the same
   patch is carried once; do not create recursive sync PRs merely for ancestry.
3. Use the destination's normal review, combined-result CI and authorized merge
   route. Record each sync PR, landed commit and verification in the existing
   release record before closing the merge task.
4. Prepare downstream syncs while an admitted release runs; its source and
   workflow revision remain pinned. Do not delay preparation merely because a
   release is active. An ordinary UAT descendant merge does not replace the
   admitted source; serving-baseline and current-attempt checks still apply.
   Legacy isolated-UAT exact-tip admission remains separate.
5. Resolve routine conflicts and dependencies within the task. Pause only the
   affected sync for unresolved conflicts or missing authority/evidence, including
   migration collisions that cannot yet be reconciled. Preserve accepted SQL and
   ledger checksums; record the exact reconciliation and owner/action needed.
   Continue independent safe syncs; never report a pending destination as synchronized.
6. If a sync is already open, compare its captured source and dependencies with
   the current destination, coalesce overlapping patches and preserve peer work.
   A changed head or combined tree needs current validation; an older green run
   cannot certify it. Record the pending PR and missing tooling when inspection
   is blocked. After landing, read back execution-authority parity and the sync
   receipt before closing the original merge task. No sync retargets an admitted
   release, dispatches deployment or clears a changed serving baseline.

This is an agent-owned procedure, not a GitHub bot, schedule or unattended merge
service. A GitHub UI merge with no agent running does not itself execute it.
Neither the original merge nor any downstream sync authorizes a deployment,
provider mutation or database migration. Existing deployment permissions and
explicit environment approval remain unchanged.

## What CI proves

PR validation records the exact tree, source, base, selection level and attempt it
tested. The queue checks every included PR's current approval and validation.
Evidence is reused only when it proves the combined inputs. Otherwise, affected
checks run on the combined tree through the existing CI workflow. A replaced
head, newer failed attempt or changed queue group invalidates older evidence.

GitHub's PR `baseRefOid` can lag the current destination. Read the live ref and
queue event; do not treat the PR field as proof that the destination is unchanged.
A destination update causes the queue to qualify its rebuilt result, rather than
requiring developers to manufacture another feature commit.

Queue execution is required while there is no mechanically enforced Admin bypass
that proves the same current combined result. Admin privileges do not make old
PR-head validation proof of new combined code. Review, merge and deployment are
separate authorities; follow [Admin SOP](admin-release-sop.md).

## Local preparation

Use the current PR template and existing protected-edit and impact validators.
Run affected contract checks before pushing. Full local diagnostics remain
available explicitly; ordinary pushes do not require a whole-repository mirror.
Use the actual destination in local diff/selection inputs. `check-main-sync.sh`
remains a diagnostic tool; its optional strict mode is not the ordinary merge gate.
The push hook uses an explicitly supplied `MAIN_SYNC_BRANCH`, the current stable
branch, or the open PR's base. If no destination can be established, it says so
and skips ancestry guidance rather than comparing a Dev/UAT change to Main.
Ordinary feature pushes stay advisory; explicit operator diagnostics retain their
requested mode. This does not replace combined-result validation or direct-push
Admin preflight.

## Target and execution preflight

1. Before treating review or bypass as blocked, inspect live protection and
   applicable rulesets for the PR's actual base, including that target's bypass
   actors. Do not infer access from Main's policy, an Admin role, or deploy-user
   allowlists. For same-repository PRs, `maintainer_can_modify` is not applicable;
   record `N/A` rather than retrying or changing that setting.
2. Before hooks, builds, or generators, set the matched repository Python and Node
   profiles, dependency link, and actual target-base SHA required by the command.
   Reuse an installed environment only after its lockfile and install-affecting
   inputs match, including package manager, engines, workspace, dependencies,
   overrides, resolutions, lifecycle scripts, and platform settings. A
   script-only difference does not by itself prove dependency drift.
3. Reuse the repository's common Git object store: fetch the required exact SHA and
   add an owned worktree rather than cloning a second repository. Keep durable
   checkpoints and patch/ref/index evidence under ignored `tmp/ops/<task>`; an OS
   temporary directory is not a durable handoff location.
4. Run final changed-owner checks and the architecture/AST ratchet against the exact
   final tree after formatting and generation. Earlier receipts do not cover later
   edits, and fix any failed security or public contract before publishing.
