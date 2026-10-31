# Maintainer Branch Freshness

Use this when freshness drift is detected on the current maintainer-owned work
branch before a PR update, merge, or admin-mode landing.

## Mandate

1. Update the existing branch, not a convenience replacement branch, unless the
   user explicitly asked for a new branch or the preserved branch is unsafe.
2. Fetch only the merge-relevant refs, then compare `origin/main...HEAD` and
   `origin/main...origin/<branch>` before changing history.
3. If local work is unpublished and the branch is behind `origin/main`, rebase
   the local commits onto `origin/main`.
4. If the branch already has shared remote commits, prefer a normal merge unless
   the branch owner explicitly accepts a lease-protected history rewrite.
5. After any freshness rebase or merge, rerun DCO, changed-surface generation
   checks, and the owning skill verification before push.
6. Push the same branch. Use `--force-with-lease` only when the freshness update
   rewrote commits this session owns and after confirming the remote branch head
   has not advanced unexpectedly.
7. Pre-push subtree checks on feature branches should inspect the branch delta
   from `origin/main`, not the stale remote feature branch range; otherwise
   already-landed `main` subtree commits create false-positive slow checks.

## Reconcile live and PR base refs before strict status

The PR event's base SHA and the API's `baseRefOid` describe recorded PR state;
they can lag the live destination branch. Fetch and compare the current target
tip before deciding whether checks are current:

```bash
BASE="main" # replace with the PR's actual base branch
REPO="hushh-labs/hushh-research" # replace if the PR is in another repository
PR=123 # replace with the PR number
git fetch --no-tags origin "+refs/heads/$BASE:refs/remotes/origin/$BASE"
git rev-parse "origin/$BASE"
gh api "repos/$REPO/pulls/$PR" --jq '{base: .base.sha, head: .head.sha}'
gh api graphql \
  -F owner="${REPO%/*}" -F name="${REPO#*/}" -F number="$PR" \
  -f query='query($owner:String!, $name:String!, $number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){baseRefOid headRefOid}}}'
git merge-base "origin/$BASE" HEAD
git diff --name-status "origin/$BASE...HEAD"
```

If the REST base, GraphQL `baseRefOid`, and live `origin/$BASE` do not agree,
re-fetch and read REST then GraphQL again, then recompute the merge base and
three-dot diff. Do not run
`./bin/hushh codex ci-status --require-success` until the refs are reconciled;
the command must evaluate the same branch state the current PR checks tested.
Freshness or a newer Main SHA never grants deployment authority.

Before publishing, start from the exact current
`.github/pull_request_template.md` and validate the draft body with
`validate_pr_impact` in `scripts/ci/live-memory-source-gate.py`. Keep its section
markers and required headers intact so the canonical validator can catch missing
or malformed impact sections.

## Verified pushes while main remains active

For a finished, locally verified candidate, carry the tested main SHA into the
normal push hook so overlapping changes arriving during pre-push checks block
before a stale CI run is created:

```bash
MAIN_SYNC_MODE=bounded MAIN_SYNC_TESTED_BASE_SHA=<tested-main-sha> \
  git push origin HEAD:<existing-branch>
```

The shared hook honors this explicit mode; ordinary feature pushes retain their
advisory default and main retains its existing forced mode and Admin preflight.
On overlap, integrate and verify the existing branch again, then push one finished
batch. This does not replace the final freshness check or authorize an Admin bypass.

A bounded no-overlap result is not merged-tree UI-contract proof. Back/Search
review fingerprints can change when Main updates unrelated frontend modules.
Before landing after such an advance, check the combined tree with the existing
UI verifier. If its review is stale, preserve Main, review the combined behavior
and regenerate receipts through the normal authoring commands. Do not use an
Admin queue bypass to land a tree already known to fail those checks. Reuse
unchanged verification evidence and run the affected checks; this adds no CI lane
or alternative freshness classifier.

## Prepared Dev and UAT destinations

For a PR targeting `dev` or `uat`, set `MAIN_SYNC_BRANCH` to that actual base and
use `MAIN_SYNC_MODE=block`. Synchronizing only from Main does not prove freshness
against either destination. CI requires the freshness job to succeed and queue
validation refuses a missing or unsupported base instead of falling back to Main.
These branches are being prepared; follow the active intake/deployment rules in
[branch governance](../../../../docs/reference/operations/branch-governance.md#dev--uat-branch-preparation)
until the promotion transition is activated.

Stable fixes propagate through manual reviewed sync PRs from Main to UAT/Dev and
from UAT to Dev. There is no sync bot or automatic deployment. Record unresolved
downstream sync obligations in the existing release record. Main receives reviewed
operations/hotfix deltas or separately approved UAT-qualified product changes.

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
   edits, and a budget failure must be fixed without waiving the contract.
