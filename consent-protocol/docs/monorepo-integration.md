# Monorepo Integration (Git Subtree)


## Visual Context

Canonical visual owner: [consent-protocol](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

This guide is for teams embedding `consent-protocol` inside a host monorepo via git subtree.

## Why this exists

Subtree sync state is easy to lose across branch switches because local bookmark refs (`refs/subtree-sync/...`) are not committed. The monorepo toolkit in `ops/monorepo/` uses two signals to prevent false drift blocks:

1. Local bookmark ref (`refs/subtree-sync/consent-protocol`)
2. Latest subtree split SHA from commit metadata (`git-subtree-split`)

This allows branch merges that already contain newer subtree sync commits to pass without requiring a redundant `make sync-protocol`.

## Files provided

- `ops/monorepo/protocol.mk` - Make targets for sync/check/push/setup
- `ops/monorepo/setup.sh` - installs hooks + upstream remote + initial bookmark
- `ops/monorepo/pre-commit.sh` - lint gate + upstream push reminder
- `ops/monorepo/pre-push.sh` - subtree drift guard + lint gate

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
make setup
```

## Daily workflow

```bash
make sync-protocol      # pull upstream consent-protocol into monorepo
# ... make backend changes under consent-protocol/ ...
make push-protocol      # push subtree changes back to upstream
```

## Branch behavior notes

If branch A syncs subtree and branch B does not, merging A into B can still leave B's local bookmark stale. The pre-push guard now reconciles bookmark + subtree commit metadata and auto-heals bookmark when content is already in sync.

If upstream is truly ahead, push is blocked and you must run:

```bash
make sync-protocol
```
