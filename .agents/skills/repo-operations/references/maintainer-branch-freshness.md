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

## Prepared Dev and UAT destinations

For a PR targeting `dev` or `uat`, set `MAIN_SYNC_BRANCH` to that actual base and
use `MAIN_SYNC_MODE=block`. Synchronizing only from Main does not prove freshness
against either destination. CI requires the freshness job to succeed and queue
validation refuses a missing or unsupported base instead of falling back to Main.
These branches are being prepared; follow the active intake/deployment rules in
[branch governance](../../../../docs/reference/operations/branch-governance.md#dev--uat-branch-preparation)
until the promotion transition is activated.
