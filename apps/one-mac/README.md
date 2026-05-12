# 🤫 One for macOS

> **Hussh = `[hu]man [s]ecure [s]ocket [h]ost`.**
> One for macOS is the **host**: the user's latest Apple-silicon Mac runs the daemon, the on-device index, and the secure socket (local MCP server) that exposes user-owned knowledge — under PCHP consent — to BYOA agents and trusted people.

Status: **Phase 0 skeleton.** Connectors, MCP server logic, and consent-protocol writeback land in Phases 1+. See [`docs/future/one-mac-knowledge-base-app.md`](../../docs/future/one-mac-knowledge-base-app.md) for the planning-only roadmap and promotion criteria.

## What this package will become

A native SwiftUI Mac app + LaunchAgent daemon that:

1. Ingests local + cloud knowledge sources (Files, Spotlight, Apple Notes, Apple Mail, Calendar, Obsidian, Notion, Google Drive, Slack) into an encrypted SQLite + MLX vector index.
2. Exposes that index to BYOA AI agents (Claude / ChatGPT / Cursor / local MLX) via a local MCP HTTP/SSE server on `127.0.0.1:31070`.
3. Serves as the first concrete **OpenClaw** reference implementation — Apache-2.0, forkable, pluggable `DataSourceBinding` interface.
4. Mirrors PKM ciphertext to the cloud via the existing PKM contract at [`consent-protocol/api/routes/pkm_routes_shared.py`](../../consent-protocol/api/routes/pkm_routes_shared.py). **Plaintext never traverses cloud.**
5. Bridges to the existing iOS Capacitor app via the existing hosted Consent MCP at `https://api.uat.hushh.ai/mcp/` — ciphertext-only relay.

## Layout

```
apps/one-mac/
  Package.swift
  Sources/
    OneShared/          KnowledgeItem, protocols, errors
    OneIndexer/         SQLite + MLX embedder (stubbed in Phase 0)
    OneMCPServer/       OpenClaw DataSourceBinding host (stubbed in Phase 0)
    OneDaemon/          LaunchAgent (SMAppService) — stubbed in Phase 0
    OneMac/             SwiftUI app shell
  Tests/
    OneSharedTests/
  Resources/            entitlements, Info.plist, LaunchAgent plist
```

## Build

```bash
./bin/hushh native mac build
./bin/hushh native mac run
```

Or directly:

```bash
cd apps/one-mac
swift build
swift test
```

## License

Apache-2.0. See repo-root `LICENSE`. Per-file SPDX headers conform to the [REUSE](https://reuse.software/) specification.
