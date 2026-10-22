# Source and Release Rollback Runbook

## Visual Context

Canonical visual owner: [Operations Index](./README.md). This runbook covers
source, hosted runtime, and native release recovery; merge and release
authority stays in the [Admin merge and release SOP](../../../.agents/skills/repo-operations/references/admin-release-sop.md).

## Purpose and scope

Use this procedure during an explicitly authorized recovery if a dev merge
breaks `hushh-labs/hushh-research/main`. Reading or saving this runbook does not
authorize running its restore, push, merge, or deployment commands.

## Recovery coverage

Choose the affected surface first. A source restore does not automatically
recover hosted services, distributed binaries, installed apps, or their records.

| Surface | Existing recovery lane | Required distinction |
| --- | --- | --- |
| GitHub `main` | Steps 1–5 below: exact snapshot tree, new commit, reviewed PR | Retains main history; replaces every tracked file with the chosen snapshot. |
| UAT web and backend | Governed `./bin/hushh rollback uat` or exact-SHA `deploy-uat.yml` | Traffic recovery and source repair are separate; verify each affected service. |
| Production web and backend | Governed `./bin/hushh rollback production` or exact-SHA `deploy-production.yml` | Production authority, compatibility, traffic, provenance, and product checks remain required. |
| Database and encrypted records | Existing database recovery and migration procedures | Neither Git nor traffic rollback reverses writes, migrations, vault state, or consent records. |
| iOS TestFlight, UAT | Available earlier build, existing-upload resume, or `ship-ios-testflight.yml` | Ordinary TestFlight builds target UAT; source recovery does not replace installed builds. |
| iOS TestFlight, production | Production-targeted App Store upload followed by the existing TestFlight resume lane | Preserve the uploaded build's production target; ordinary TestFlight rebuilds a UAT binary. |
| Public iOS App Store | `release-ios-appstore.yml`: new recovery version from approved main | Prepare, submit for review, and public release are distinct transitions. |
| Android / Google Play | Eligible store halt or new recovery build through `ship-android-playstore-v1.yml` | Current workflow targets UAT; Play's `production` track is public distribution, not a production backend selector. |
| Local iOS and Android | Fresh native preparation/build from reviewed recovery source | Use the existing mobile build and verification guides; a Git restore does not update a device. |

The procedure replaces all tracked files with the chosen snapshot, including
deleting files introduced afterward. It also removes unrelated later fixes.
It preserves the original repository's commit history through a restore PR.
The backup contains new snapshot commits with different SHAs from the original
source commits; copy its file tree rather than merging its unrelated history.

This is source recovery. Databases, secrets, infrastructure, and running services
are separate. For traffic recovery, use the existing governed
`./bin/hushh rollback --help` entrypoint and its environment authority. Database
recovery belongs to [Production DB Backup and Recovery](./production-db-backup-and-recovery.md).

## Pinned backup choices

Backup: [hushh-labs/agent-one-backup-2026-10-20](https://github.com/hushh-labs/agent-one-backup-2026-10-20).
Its private, archived status and the following commit/tree mappings were verified
on **2026-10-20**. It can be fetched while archived; leave it archived and keep
GitHub Actions disabled.

| Choice | Backup ref | Original source commit | Backup snapshot commit |
| --- | --- | --- | --- |
| Production baseline, default | `main` / `production-stable-2026-10-20` | `20164297730c54e7ec6110bb4f95e34fb6529704` | `f945753942565eff04eceb414178f24736a50da2` |
| All latest captured fixes | `latest-fixes-2026-10-20` | `588e3e32dcc1da5152687539d2a4dfc28f29037f` | `4df0d1f8a0f6a00f942909fcd010894c32e79b0c` |

The production baseline had successful frontend and backend release provenance
in [production run 39406852410](https://github.com/hushh-labs/hushh-research/actions/runs/39406852410).
The latest-fixes snapshot had UAT verification pending at capture; its presence
in the backup is not proof of deployment readiness. Fixes after capture are not
included. Older source Git history was excluded from the backup.

## Before starting an incident recovery

1. Confirm the chosen snapshot and the full rollback scope with the incident
   owner. Coordinate other merges until the landed tree comparison passes.
2. Preserve the developer's active checkout and serving runtime. Use a fresh,
   full, non-sparse clone below; do not copy local environment files or secrets.
3. Authenticate `gh` with access to both repositories. Direct PRs to `main`
   require a governed maintainer author under [Branch Governance](./branch-governance.md).
4. Use the normal development prerequisites and CI-compatible tools, including
   `uv`, Node.js, and the `gitleaks` version pinned by `.github/workflows/ci.yml`.
   Coordinate shared host resources before the core verification run; do not
   overlap full core runs in the same worktree.
5. Run the blocks in order in the **same Bash shell**. Variables set in step 1
   are used later. Each action block stops on failure. Stop the procedure after
   any failed block; do not continue to push or merge.

## 1. Choose the snapshot and recovery directory

Default to the verified production source. Select the second SHA instead when
the authorized recovery scope is every latest captured fix.

```bash
ROLLBACK_CHECKOUT="$HOME/Desktop/AgentOne-recovery"
ROLLBACK_BRANCH=codex/restore-pre-dev-merge

# Verified production source: original SHA 20164297730c.
RESTORE_SNAPSHOT=f945753942565eff04eceb414178f24736a50da2

# Alternative: all latest captured fixes, original SHA 588e3e32dcc1.
# RESTORE_SNAPSHOT=4df0d1f8a0f6a00f942909fcd010894c32e79b0c
```

Choose an unused directory. If `AgentOne-recovery` already exists, inspect it and
choose another path; the next block deliberately refuses to reuse it.

## 2. Fetch, verify, and stage the exact source tree

This block creates only the dedicated recovery checkout and branch. The ref and
tree assertions must pass before any file restoration.

```bash
(
  set -euo pipefail

  case "$RESTORE_SNAPSHOT" in
    f945753942565eff04eceb414178f24736a50da2)
      SNAPSHOT_REF=main
      EXPECTED_TREE=12b2fc3b2924106d42f8e8d4c1842569c1a9c49b
      ;;
    4df0d1f8a0f6a00f942909fcd010894c32e79b0c)
      SNAPSHOT_REF=latest-fixes-2026-10-20
      EXPECTED_TREE=1f79802c20ab26b0ab424b4c1953f53f22d63c6e
      ;;
    *)
      printf '%s\n' 'Stop: choose one of the pinned backup snapshot SHAs.' >&2
      exit 1
      ;;
  esac

  test ! -e "$ROLLBACK_CHECKOUT"
  gh repo clone hushh-labs/hushh-research "$ROLLBACK_CHECKOUT"
  cd "$ROLLBACK_CHECKOUT"

  git remote add backup \
    https://github.com/hushh-labs/agent-one-backup-2026-10-20.git
  git fetch --no-tags backup \
    main:refs/remotes/backup/main \
    latest-fixes-2026-10-20:refs/remotes/backup/latest-fixes-2026-10-20

  test "$(git rev-parse "refs/remotes/backup/$SNAPSHOT_REF")" = "$RESTORE_SNAPSHOT"
  test "$(git rev-parse "${RESTORE_SNAPSHOT}^{tree}")" = "$EXPECTED_TREE"

  git fetch origin main
  git switch -c "$ROLLBACK_BRANCH" origin/main
  git restore --source="$RESTORE_SNAPSHOT" \
    --staged --worktree --no-overlay -- .

  test "$(git write-tree)" = "$EXPECTED_TREE"
  git diff --cached --stat
  git diff --cached --name-status
)
```

## 3. Review the staged recovery

```bash
git -C "$ROLLBACK_CHECKOUT" diff --cached
```

Review the complete diff, especially migration, schema, workflow, governance,
and runtime configuration reversions. If there is no staged difference, the
current source already matches the selected snapshot; stop rather than creating
an empty restore commit. Confirm compatibility with the current deployed schema
under [Migration Governance](./migration-governance.md) before a later rollout.

## 4. Commit, verify, push once, and open the restore PR

Run only after the diff review. The assertions catch changes from commit hooks
or verification commands. The freshness check stops if `main` advanced beyond
the restore branch. A failed core check blocks the push; resolve its cause
without bypassing gates.

```bash
(
  set -euo pipefail
  cd "$ROLLBACK_CHECKOUT"

  test "$(git branch --show-current)" = "$ROLLBACK_BRANCH"
  EXPECTED_TREE="$(git rev-parse "${RESTORE_SNAPSHOT}^{tree}")"
  test "$(git write-tree)" = "$EXPECTED_TREE"

  git commit -s -m "Restore source snapshot $RESTORE_SNAPSHOT"
  test "$(git rev-parse 'HEAD^{tree}')" = "$EXPECTED_TREE"

  CORE_SERIAL=1 bash scripts/ci/orchestrate.sh core

  test "$(git rev-parse 'HEAD^{tree}')" = "$EXPECTED_TREE"
  git diff --exit-code
  git diff --cached --exit-code

  git fetch origin main
  git merge-base --is-ancestor origin/main HEAD
  git push -u origin "$ROLLBACK_BRANCH"

  gh pr create \
    --repo hushh-labs/hushh-research \
    --base main \
    --head "$ROLLBACK_BRANCH" \
    --title "Restore source from pre-dev-merge backup" \
    --body "Restore tracked files exactly to backup snapshot $RESTORE_SNAPSHOT while retaining main history."
)
```

## 5. Merge and verify the landed main tree

Use the returned PR link. Follow the canonical
[Admin merge and release SOP](../../../.agents/skills/repo-operations/references/admin-release-sop.md):
require CI and reviews on the exact current PR head, request the normal merge
queue, and confirm the PR actually lands. This runbook grants no Admin bypass
or direct push to `main`.

If `main` advances before landing, refresh the **same** recovery branch through
the [maintainer freshness procedure](../../../.agents/skills/repo-operations/references/maintainer-branch-freshness.md),
reapply the selected snapshot, review the new diff, and rerun the required
verification before another push. Do not repeat the initial clone block over
an existing recovery checkout or assume a queued merge preserves the snapshot.

After the PR lands, compare the actual main tree:

```bash
(
  set -euo pipefail
  cd "$ROLLBACK_CHECKOUT"

  git fetch origin main
  test "$(git rev-parse 'origin/main^{tree}')" = \
    "$(git rev-parse "${RESTORE_SNAPSHOT}^{tree}")"
  printf 'Restored main SHA: %s\n' "$(git rev-parse origin/main)"
)
```

Require `Main Post-Merge Smoke Gate` success for that printed main SHA. If the
tree differs, stop before deployment and reconcile concurrent changes through
the same recovery workflow. Record the snapshot, PR, landed main SHA, tree
comparison, and smoke run as recovery evidence.

## 6. UAT and production runtime recovery

If users are affected, assess the existing traffic recovery lane immediately;
it does not require waiting for the source restore PR. Record the environment,
affected services, serving revisions, source SHAs, image identities, and active
or queued releases. Start UAT investigation through
`./bin/hushh codex rca --surface uat --text` and reconcile overlapping releases
before dispatching recovery.

1. Select compatible prior backend/frontend revisions from release evidence.
   Verify each target exists and is Ready in the correct environment. Review
   current schema, API, consent, worker, and scheduler compatibility first.
2. After explicit incident authorization, use the governed rollback entrypoint.
   Its supported scopes are `backend`, `frontend`, and `all`, without `auto`:

   ```text
   ./bin/hushh rollback <uat|production> <backend|frontend|all> \
     --reason "<incident and recovery purpose>" \
     --backend-revision "<verified Ready backend revision>" \
     --frontend-revision "<verified Ready frontend revision>"
   ```

   Omit revision flags for unaffected services. This dispatches `rollback.yml`
   from `main` under the selected environment's actor policy and deployment
   lock. It changes primary service traffic; it does not undo database writes,
   migrations, runtime configuration changes, workers, or schedulers.
3. Inspect the exact correlated run's terminal conclusion and jobs. Then verify
   actual traffic, Ready revisions, image identity, original source/run labels,
   health, applicable schema and semantic checks, and the affected product
   journey. Record both changed and unchanged services. The rollback workflow's
   health summary alone is not a complete deployment acceptance receipt.
4. For durable recovery, land the source repair, require its exact main smoke
   gate, and separately authorize the existing deployment lane. UAT
   `deploy-uat.yml` accepts `sha` and defaults `scope=auto`; production
   `deploy-production.yml` accepts `sha` and `scope=backend|frontend|all`.
   Dispatch from `main`. Use an approved main source SHA, normally the **new
   restored main SHA**, rather than a synthetic backup commit. Preserve the
   normal UAT signoff and production release gates. If a prior revision was
   pruned, this existing rebuild/redeploy path requires its own authorization.

Blank revision flags use `deployed/<environment>-latest`. That tag may point to
the release now found to be defective; explicitly select a proven older
revision in that case. Tags can also be stale or refer to pruned revisions, and
scoped releases can leave different source SHAs on backend and frontend. Read
service-specific release evidence rather than inferring both lanes from the
tag's commit.

For database work follow [Migration Governance](./migration-governance.md) and
the [database recovery runbook](./production-db-backup-and-recovery.md).
`./bin/hushh db verify-release-contract` and `./bin/hushh db report-prod-posture`
check repository contracts, not live production state. Use the existing live
environment verification procedures before rollout. A matching schema is only
one part of compatibility; do not downgrade migrations merely because source
or traffic was rolled back.

## 7. TestFlight, iOS, and Android recovery

First record the affected platform, app version/build, source SHA, baked backend
target, release track or tester group, and workflow/store receipt. Select the
intended backend deliberately and prove its compatibility with both existing
clients and the proposed recovery binary. A backend incident can affect native
clients without requiring a new binary; a bundled native defect can require one
even after hosted recovery.

### TestFlight

- For a tester who needs a prior working binary, select an available previous
  build in TestFlight. Availability is limited by expiry and distribution;
  builds are testable for up to 90 days. See
  [Apple TestFlight](https://beta.itunes.apple.com/) and
  [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/).
- If an upload succeeded but processing/distribution did not finish, inspect
  its retained upload receipt and existing App Store Connect state before a
  retry. The existing `resume-ios-testflight.yml` accepts the original
  `upload_run_id` from either TestFlight or App Store upload workflows. It
  reconciles processing and tester-group assignment without a rebuild, a new
  upload, or a beta-review submission; it preserves that binary's backend.
- A new UAT binary uses `ship-ios-testflight.yml` from `main` with the exact
  green recovery `sha`. Its `dry_run` and optional `marketing_version` inputs
  retain the existing signing, backend provenance, and packaging gates.
- A new production-backed TestFlight binary uses the production-targeted App
  Store upload lane, then the existing resume lane for distribution. Ordinary
  TestFlight does not offer a production backend switch.

Use [Ship iOS to TestFlight](../../guides/mobile/ship-ios-testflight.md) and the
[production-backed TestFlight procedure](../../guides/mobile/release-ios-appstore.md)
for the exact operator steps and receipt checks.

### Public iOS App Store

Apple does not allow reverting a public app to an earlier App Store version;
prepare and submit an incremental recovery version. See
[Apple: Create a new version](https://developer.apple.com/help/app-store-connect/update-your-app/create-a-new-version/).

Use [Release iOS to App Store](../../guides/mobile/release-ios-appstore.md) and
`release-ios-appstore.yml` from `main`. Set the exact green recovery `sha` and
explicit `backend_target=uat|production`; the default is UAT. A production
recovery must not silently move users to UAT, or the reverse: their records and
vaults do not migrate with the binary. Confirm matching backend deployment
evidence; this workflow enforces exact serving-backend provenance for production,
while matching UAT deployment evidence also needs operator verification.

The normal preparation leaves `submit_for_review=false` and
`release_after_approval=false`. Public submission requires separate explicit
approval under the release skill; approval and public availability are separate
states. Preserve automatic build-number resolution. If Apple has closed or
locked a version train, use an authorized higher `marketing_version` to package
the same recovery source; do not bypass version/signing gates. Record the exact
attached build, review/submission state, release mode, and actual public status.

### Android and Google Play

Use [Ship Android to Google Play](../../guides/mobile/ship-android-playstore.md),
`scripts/release/dispatch-android-playstore.mjs`, and
`ship-android-playstore-v1.yml`. Select the exact green recovery `sha` and an
explicit `track=internal|production`. The default track is **public production**;
an internal test upload is still a separately authorized external write.

The current workflow builds against **UAT** and validates UAT backend provenance.
There is no implemented production-backend selector in this Android lane. Do
not interpret Play's production track as production runtime support or change
the target as an incidental rollback step. If the incident needs an unsupported
runtime target, stop that lane and resolve its owning release contract first.

Google Play supports halting eligible fully rolled-out releases on tracks other
than internal, with an eligible prior fully rolled-out release available to
new/eligible users. This does not repair clients already updated; inspect the
current store state and use [Google's halt procedure](https://support.google.com/googleplay/android-developer/answer/16285429?hl=en).
For updated clients needing a recovery binary, rebuild reviewed recovery source
with a fresh higher `versionCode`; Android protects against lower-version
updates. See [Android versioning](https://developer.android.com/studio/publish/versioning).

Preserve the existing version resolver and explicit track confirmation. The
Android upload workflow uses completed releases, so it is not an App Store-style
prepare-only public release gate. There is no sibling Android resume workflow;
inspect uncertain upload/store outcomes before retrying.

## 8. Cross-surface acceptance and closeout

Follow the existing [Mobile Build and Release](../../guides/mobile/build-release.md)
and [Mobile Verification](../../guides/mobile/verification.md) guides for fresh
iOS/Android preparation, native parity, and device verification. Do not use a
browser-only pass as proof that installed native binaries work.

Before declaring recovery, record evidence for every affected surface:

- Actual environment/service source SHA, Ready revision, traffic, and image
  identity; schema, worker, scheduler, and provider compatibility as applicable.
- Native source SHA, backend target, app identity, marketing version/build or
  versionCode, exact workflow run, upload receipt, and store/tester availability.
- The affected web, iOS, and Android journeys, including authentication and
  vault continuity, consent, record access, and the failing feature. Use the
  governed reviewer/device flows; keep credentials and decrypted records out of
  logs, screenshots, runbooks, and PRs.
- Compatibility for clients already on older/newer binaries while distribution
  catches up. No source snapshot restores client storage or forces all devices
  onto a particular app version.
- Explicit unaffected or blocked lanes and their reasons; pending store review,
  processing, or unavailable runtime targets are not completed recovery.

After successful recovery, record release evidence and follow the canonical
SOP for back-sync, returning to the preserved development checkout, and cleaning
up the recovery branch only after its work is safely retained. Keep the archived
backup available.
