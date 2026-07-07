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

