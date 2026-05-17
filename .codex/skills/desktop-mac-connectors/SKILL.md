---
name: desktop-mac-connectors
description: Use when implementing or reviewing Mac-side knowledge connectors (local filesystem, Spotlight, Apple Notes, Apple Mail, Calendar, Obsidian, Notion, Google Drive, Slack) inside the desktop-mac owner family.
---

# Hussh Desktop Mac Connectors Skill

## Purpose and Trigger

- Primary scope: `desktop-mac-connectors`
- Trigger on Mac-side knowledge connector implementation, OAuth refresh handling, AppleScript bridges, and connector revocation propagation.
- Avoid overlap with `desktop-mac-mcp-host` and `vault-pkm-governance`.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `desktop-mac`

Owned repo surfaces:

1. `apps/one-mac/Sources/OneIndexer`

Non-owned surfaces:

1. `desktop-mac`
2. `mobile-native`
3. `backend`

## Do Use

1. Implementing or extending the `Connector` SwiftPM protocol per source.
2. AppleScript bridges, MailKit, EventKit, FSEvents watchers, and OAuth refresh flows.
3. Connector revocation cascades, permission state machines, and ingestion backpressure.

## Do Not Use

1. Local MCP server or OpenClaw conformance work — use `desktop-mac-mcp-host`.
2. Vault encryption or PKM writeback shape changes — use `vault-pkm-governance`.
3. Broad Mac-app intake where the connector boundary is unclear.

## Read First

1. `docs/future/one-mac-knowledge-base-app.md`
2. `apps/one-mac/README.md`
3. `hushh-webapp/ios/App/CapApp-SPM/Package.swift`

## Workflow

1. Pick one connector at a time; never bundle connectors across PRs.
2. Each connector is its own SwiftPM target with its own permission state machine.
3. Persist OAuth refresh tokens in Keychain access group `ai.hushh.one`, never in SQLite.
4. AppleScript-dependent sources must ship an alternative path for when the bridge is TCC-denied.
5. Connector revocation must cascade: invalidate all derived DATs, flush ciphertext blobs for that domain, and append to the local consent log.

## Handoff Rules

1. If the request is broad Mac-app intake, route it back to `desktop-mac`.
2. If the work touches the local MCP server, OpenClaw bindings, or CRT minting, use `desktop-mac-mcp-host`.
3. If the work touches vault encryption, PKM domain shapes, or cloud ciphertext routes, use `vault-pkm-governance`.

## Required Checks

```bash
./bin/hushh native mac build
./bin/hushh native mac test
```
