# Subtree Sync Enforcement — Developer Guide

> How `consent-protocol/` stays in sync between the monorepo and the standalone upstream repo.


## Visual Context

Canonical visual owner: [Guides Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

---

## Architecture

```
hushh-research  (monorepo)                 consent-protocol  (standalone)
├── consent-protocol/  ◄── git subtree ──►  github.com/hushh-labs/consent-protocol
├── hushh-webapp/                           (independent repo, own CI, own contributors)
└── ...
```

`consent-protocol/` is a **git subtree** (with `--squash`) of the standalone repo.
They share the same code but have **independent commit histories** — squash merges
flatten upstream commits into a single merge commit, which means git cannot natively
tell whether you're "up to date" or not.

### Sync Baseline

To solve that, we track sync state with two signals:

```
refs/subtree-sync/consent-protocol = <SHA of last-synced upstream commit>
git-subtree-split in commit message = <last squash-pull upstream SHA>
```

The bookmark ref is **local-only** (never pushed), while `git-subtree-split` is
branch-aware commit metadata that survives merges. The hook now reconciles both
signals and auto-heals stale local bookmarks when branch content is already synced.

**Why not `git rev-list HEAD..upstream/main`?**
Because `--squash` subtree pulls don't link commit ancestry. After a squash pull,
`git rev-list` still reports upstream as "ahead" even though the content is synced.
The dual-baseline approach compares known upstream SHAs instead of subtree ancestry.

---

## Setup (One-Time)

Hooks install automatically via **either** path:

```bash
make setup              # explicit setup (recommended)
cd hushh-webapp && npm install   # "prepare" lifecycle hook triggers setup
```

Both run `scripts/setup-hooks.sh`, which delegates to `consent-protocol/ops/monorepo/setup.sh` and is idempotent (safe to run repeatedly):

1. Sets `core.hooksPath = .githooks`
2. Makes all hooks executable (`chmod +x`)
3. Adds `consent-upstream` remote pointing to the standalone repo
4. Fetches upstream HEAD and initializes a sync bookmark (history-aware)

Verify everything is configured:

```bash
make verify-setup
```

### What `verify-setup` Checks

| Check | Pass | Fail |
|-------|------|------|
| Git hooks path | `.githooks` configured | Run `make setup` |
| pre-commit hook | Installed + executable | Run `make setup` |
| pre-push hook | Installed + executable | Run `make setup` |
| consent-upstream remote | Configured | Run `make setup` |
| python3 | Available | Install Python 3 |
| ruff | Available via `python3 -m ruff` | `pip3 install ruff` |
| node | Available | Install Node.js |

---

## Developer Flows

### Flow 1: Editing Only `hushh-webapp/` (No consent-protocol)

```
git commit → pre-commit: no consent-protocol files → passes silently
git push   → pre-push: no consent-protocol files   → passes silently
```

**Nothing happens.** Both hooks only activate when `consent-protocol/` files are in the diff.

---

### Flow 2: Editing `consent-protocol/` — Upstream In Sync

```
edit consent-protocol/api/routes.py
         │
         ▼
git commit
         │
    ┌─ pre-commit ────────────────────────────────────────┐
    │  ● Detects consent-protocol/ files staged           │
    │  ● Prints reminder: "run make push-protocol later"  │
    │  ● Runs ruff check + ruff format --check            │
    │    ├─ PASS → commit proceeds                        │
    │    └─ FAIL → commit BLOCKED                         │
    └─────────────────────────────────────────────────────┘
         │ (lint passed)
         ▼
git push
         │
    ┌─ pre-push ──────────────────────────────────────────┐
    │  ● URL matches *hushh-research* → check activates   │
    │  ● Diff shows consent-protocol/ files in push range │
    │  ● Fetches consent-upstream/main                    │
    │  ● Uses bookmark + git-subtree-split baseline       │
    │    → "Upstream is in sync. ✓"                       │
    │  ● Runs ruff lint gate                              │
    │    ├─ PASS → push succeeds ✅                       │
    │    └─ FAIL → push BLOCKED                           │
    └─────────────────────────────────────────────────────┘
```

---

### Flow 3: Editing `consent-protocol/` — Upstream Has Drifted (BLOCKED)

Someone pushed to the standalone repo while you were working:

```
  You (monorepo)                    Them (standalone)
  ──────────────                    ──────────────────
  bookmark = abc123                 HEAD = abc123
       │                                 │
       │                            push new commit
       │                                 │
       │                            HEAD = def456  ← drift
       │
  edit consent-protocol/
  git commit (passes)
  git push
       │
  ┌─ pre-push ──────────────────────────────────────────────────┐
  │  ● Fetches consent-upstream/main → def456                   │
  │  ● Effective sync baseline is abc123                        │
  │  ● Counts: 1 commit(s) ahead                               │
  │                                                             │
  │  ┌───────────────────────────────────────────────────────┐  │
  │  │  [pre-push] BLOCKED                                   │  │
  │  │  consent-upstream/main is 1 commit(s) ahead          │  │
  │  │  Sync baseline:   abc123                             │  │
  │  │  Current upstream:def456                             │  │
  │  │                                                       │  │
  │  │  Run:                                                 │  │
  │  │    make sync-protocol    # pull + update bookmark     │  │
  │  │    # resolve conflicts if any                         │  │
  │  │    git push              # try again                  │  │
  │  └───────────────────────────────────────────────────────┘  │
  │  exit 1                                                     │
  └─────────────────────────────────────────────────────────────┘
```

**Recovery:**

```bash
make sync-protocol   # pulls upstream, updates bookmark
# resolve any merge conflicts, then:
git push             # now succeeds ✅
```

---

### Flow 4: Pushing Monorepo Changes Back to Standalone

After your PR is merged to main, sync changes back to the standalone repo:

```bash
make push-protocol       # checks sync first, then pushes
make push-protocol-force # escape hatch: skip sync check
```

---

## Edge Cases

### No Baseline Metadata (First-Time Developer)

```
pre-push: bookmark missing + no subtree split metadata
→ YELLOW WARNING in hook mode
→ RED failure in `make check-protocol-sync` mode
```

After one `make sync-protocol`, both local bookmark and history metadata become usable.

### Branch Switch / Merge With Stale Local Bookmark

If branch A synced subtree and branch B did not, merging A into B can leave B's
local bookmark stale. The hook detects this via `git-subtree-split` metadata and
updates the local bookmark automatically when the upstream baseline is already present.

### No Internet / Fetch Fails

```
pre-push: git fetch consent-upstream → FAILS
→ YELLOW WARNING: "Could not fetch. Skipping sync check."
→ Push proceeds (lint gate still active)
```

### `consent-upstream` Remote Missing

```
pre-push: git remote | grep consent-upstream → NOT FOUND
→ YELLOW WARNING: "Remote not configured. Run: make setup"
→ Push proceeds
```

### Pushing to a Fork or Different Remote

```
pre-push: URL = "github.com/yourname/my-fork"
→ case *hushh-research* → NO MATCH
→ Hook skips entirely, push proceeds
```

The hook only activates for URLs containing `hushh-research`.

### CI Environment (No .git Directory)

```
setup-hooks.sh: [ ! -d .git ] → exit 0
```

The setup script silently exits in CI tarballs or `npm pack`.

---

## Decision Tree

```
git push to *hushh-research*
  │
  ├─ consent-protocol/ files in diff?
  │   ├─ NO → pass (no checks)
  │   └─ YES ↓
  │
  ├─ consent-upstream remote exists?
  │   ├─ NO → warn, pass
  │   └─ YES ↓
  │
  ├─ can fetch upstream?
  │   ├─ NO → warn, pass
  │   └─ YES ↓
  │
  ├─ derive effective baseline from:
  │   ├─ local bookmark ref
  │   └─ git-subtree-split metadata
  │
  ├─ baseline missing?
  │   ├─ YES → warn (hook mode) / fail (check mode)
  │   └─ NO ↓
  │
  ├─ baseline == upstream HEAD?
  │   ├─ YES → ✅ "in sync", continue to lint
  │   └─ NO  → ❌ BLOCKED, exit 1
  │
  └─ ruff lint + format passes?
      ├─ YES → push succeeds ✅
      └─ NO  → BLOCKED, exit 1
```

**Hard blocks** (exit 1): upstream ahead of effective baseline, lint check fail, lint format fail.
**Soft warnings** (pass through in hook mode): missing remote, no internet, non-hushh URL.

---

## Commands Reference

| Command | What it does |
|---------|-------------|
| `make setup` | Install hooks + remote + bookmark (first-time) |
| `make verify-setup` | Print checklist of configuration status |
| `make sync-protocol` | Pull upstream → monorepo + update bookmark |
| `make check-protocol-sync` | Check sync status (read-only) |
| `make push-protocol` | Push monorepo → upstream (checks sync first) |
| `make push-protocol-force` | Push monorepo → upstream (skip sync check) |

---

## File Map

| File | Purpose |
|------|---------|
| `.githooks/pre-commit` | Wrapper to delegated hook in `consent-protocol/ops/monorepo/` |
| `.githooks/pre-push` | Wrapper to delegated hook in `consent-protocol/ops/monorepo/` |
| `scripts/setup-hooks.sh` | Wrapper to delegated setup in `consent-protocol/ops/monorepo/` |
| `consent-protocol/ops/monorepo/*` | Source of truth for subtree hook/setup/make logic |
| `Makefile` | Includes shared subtree targets from `consent-protocol/ops/monorepo/protocol.mk` |
| `hushh-webapp/package.json` | `"prepare"` script triggers `setup-hooks.sh` on `npm install` |
| `.github/workflows/ci.yml` | `subtree-sync-check` job (tree comparison in CI) |

---

## FAQ

**Q: I just cloned the repo. Do I need to do anything special?**
A: Run `make setup` (or just `cd hushh-webapp && npm install` — both install hooks automatically).

**Q: I got BLOCKED on push. What do I do?**
A: Run `make sync-protocol`, resolve any conflicts, then `git push` again.

**Q: Can I bypass the hook in an emergency?**
A: `git push --no-verify` skips all hooks. Use sparingly — CI will still flag drift.

**Q: The bookmark seems wrong / I want to reset it.**
A: `git update-ref -d refs/subtree-sync/consent-protocol` deletes it. Next `make sync-protocol` sets a fresh one.

**Q: I only work on `hushh-webapp/`. Do the hooks affect me?**
A: No. Both hooks check for `consent-protocol/` files in the diff. If you don't touch that directory, nothing fires.
