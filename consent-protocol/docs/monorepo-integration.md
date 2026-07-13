# Monorepo Integration (Git Subtree)


## Visual Context

Canonical visual owner: [consent-protocol](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

This guide is for teams embedding `consent-protocol` inside a host monorepo via git subtree.

## Why this exists

Subtree sync state is easy to lose across branch switches because local bookmark refs (`refs/subtree-sync/...`) are not committed. The monorepo toolkit in `ops/monorepo/` uses two signals to prevent false drift blocks:

1. Local bookmark ref (`refs/subtree-sync/consent-protocol`)
2. Latest subtree split SHA from commit metadata (`git-subtree-split`)

This allows branch merges that already contain newer subtree sync commits to pass without requiring a redundant `./bin/hushh protocol sync`.

## Files provided

- `ops/monorepo/protocol.mk` - Make targets for sync/check/push/setup
- `ops/monorepo/setup.sh` - installs hooks + upstream remote + initial bookmark
- `ops/monorepo/pre-commit.sh` - lint gate + upstream push reminder
- `ops/monorepo/pre-push.sh` - branch freshness + lint gate, with opt-in subtree verification

## Host monorepo setup

1. Add `consent-protocol` as a subtree at `consent-protocol/`.
2. Include the shared targets in your root `Makefile`:

```makefile
include consent-protocol/ops/monorepo/protocol.mk
```

3. Wire hook wrappers in your host repo:

```sh
# .githooks/pre-commit
exec sh consent-protocol/ops/monorepo/pre-commit.sh "$@"

# .githooks/pre-push
exec sh consent-protocol/ops/monorepo/pre-push.sh "$@"
```

4. Run setup once:

```bash
./bin/hushh protocol setup
```

## Daily workflow

```bash
./bin/hushh protocol sync      # pull upstream consent-protocol into monorepo
# ... edit backend code under consent-protocol/ ...
./bin/hushh protocol push      # push subtree changes back to upstream
```

Normal pushes intentionally skip the expensive subtree projection. Verify it
explicitly with `./bin/hushh protocol check-sync`, or enable it for one push
with `CONSENT_PRE_PUSH_SYNC_CHECK=1 git push`.

## Branch behavior notes

If branch A syncs subtree and branch B does not, merging A into B can still leave B's local bookmark stale. The explicit sync check reconciles bookmark + subtree commit metadata and auto-heals the bookmark when content is already in sync.

If the explicit check reports that upstream is truly ahead, run:

```bash
./bin/hushh protocol sync
```
