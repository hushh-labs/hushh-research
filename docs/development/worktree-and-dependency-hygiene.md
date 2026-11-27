# Local Worktree and Dependency Hygiene

[Development](README.md) · **Intent:** Reference and operational guardrail

Canonical organization standard: [Local Worktree and Dependency Hygiene Standard](https://wiki.hussh.si/wiki/reference/local-worktree-and-dependency-hygiene)

## Why This Guardrail Exists

Multi-agent sessions across repositories previously pushed developer workstations to 100% disk capacity because temporary worktrees accumulated without teardown, every task worktree materialized a full 1.4+ GB duplicate `node_modules` under `hushh-webapp` tree (zero symlinks), and parked rehearsal checkouts retained multi-gigabyte `.next` and native iOS build caches under `hushh-webapp/ios` build artifacts alongside orphaned non-git stub directories.

## Mandatory Thresholds and Rules

1. **Pre-Flight Disk and Worktree Gate:**
   Run `python3 scripts/ops/worktree_hygiene.py --check` before creating a git worktree, installing dependencies, or starting heavy Next.js, Xcode/iOS, or container builds.
   - **Below 30 GB free (Warning):** Surface free disk space, active worktree count, and largest worktree footprints before proceeding.
   - **Below 15 GB free (Hard Stop):** Refuse to create new worktrees or duplicate `node_modules` under `hushh-webapp`; run `--audit` and reclaim safe bloat first.
2. **Containment and Mandatory Remove-After-Use:**
   - Keep ephemeral task worktrees strictly inside `~/.local/share/hushh-task-worktrees/<task>`, never ad-hoc sibling directories next to the primary clone.
   - Reuse an existing matching task worktree before spawning a new one. Parallel worktrees are allowed while actively in use (no static concurrency cap), **but every temporary worktree MUST be permanently removed immediately after its task lands, merges, or finishes**.
3. **Zero Silent Dependency or Build Multiplication:**
   - Do not run a blind fresh `npm install` inside `hushh-webapp/` in a temporary worktree when dependency manifests and lockfiles match the active base checkout; prefer verified read-only symlinks or shared package stores where supported.
   - Strip ignored build caches (`.next`, native iOS build caches under `hushh-webapp/ios` build outputs, `out`, and temporary `node_modules`) before parking any checkout.
4. **Verified End-of-Task Teardown (Zero Orphaned Stubs):**
   A task is incomplete until every session-created worktree is either:
   - **Permanently removed:** verify every unique commit is merged or pushed to `origin/<base>`, confirm zero active processes hold open handles in the checkout, unlink checkout-local dependency symlinks without recursing into shared targets, strip gitignored caches and `node_modules` (`git clean -fdX` after confirming clean tracked status), run `git worktree remove <path>` without `--force`, run `git worktree prune --dry-run --verbose` (and prune stale task metadata), and verify the directory no longer exists on disk.
   - **Explicitly handed off** with its disk footprint, branch, and dirty or unpushed delta count.
5. **Preserve Unique Work Before Deletion:**
   Never delete a dirty worktree or unpushed commits without first pushing a safety branch, exporting verified git bundles, diff patches, and untracked archives, or receiving explicit owner approval to discard.

## CLI Usage

```bash
# Read-only audit of linked worktrees, duplicate node_modules, orphan stubs, and disk free space
python3 scripts/ops/worktree_hygiene.py --audit

# Preflight gate (exits non-zero if free disk < 15 GB or orphan stubs exist; add --fail-on-unused to fail on unremoved clean worktrees)
python3 scripts/ops/worktree_hygiene.py --check

# Preview safe pruning (clean, remote-backed worktrees and orphan stubs only)
python3 scripts/ops/worktree_hygiene.py --prune-safe

# Execute verified safe pruning (never touches dirty or unpushed worktrees)
python3 scripts/ops/worktree_hygiene.py --prune-safe --execute
```
