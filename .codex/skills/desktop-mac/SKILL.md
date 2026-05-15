---
name: desktop-mac
description: Use when the request is broadly about the native macOS One app, the LaunchAgent daemon, the on-device knowledge index, the local MCP host, or BYOA agent surfaces on a Mac, and the correct Mac specialist spoke is not yet clear.
---

# Hussh Desktop Mac Skill

## Purpose and Trigger

- Primary scope: `desktop-mac-intake`
- Trigger on broad native macOS requests across the SwiftUI app shell, the LaunchAgent daemon, the local MCP host, BYOA agent bridges, and Mac-side knowledge indexing.
- Avoid overlap with `mobile-native` and `repo-context`.

## Coverage and Ownership

- Role: `owner`
- Owner family: `desktop-mac`

Owned repo surfaces:

1. `apps/one-mac`
2. `docs/future/one-mac-knowledge-base-app.md`

Non-owned surfaces:

1. `mobile-native`
2. `backend`
3. `docs-governance`

## Do Use

1. Broad Mac-app intake before the correct spoke (connectors vs MCP host) is clear.
2. SwiftUI shell, App Intents, Nav UI parity, and BYOA pane work on the Mac surface.
3. Choosing whether a request belongs to the connectors spoke or the MCP host spoke.

## Do Not Use

1. iOS or Android Capacitor work — route to `mobile-native`.
2. Backend-only consent-protocol route or service work.
3. Generic frontend or docs work without a Mac surface.

## Read First

1. `docs/future/one-mac-knowledge-base-app.md`
2. `apps/one-mac/README.md`
3. `docs/future/README.md`

## Workflow

1. Classify the request: SwiftUI shell + App Intents + Nav UI, connector ingestion, or local MCP host.
2. Keep the Mac index canonical and the cloud a ciphertext mirror — never invent a plaintext writeback path.
3. Match the shipped ZK definition (AES-256-GCM + HMAC bearer); do not introduce Merkle or Pedersen primitives without a promotion gate.
4. Treat `apps/one-mac/Sources/OneMCPServer/` as the first OpenClaw reference implementation — Apache-2.0, no Hussh-only dependencies.
5. Reuse the Python `hushh_mcp/consent/token.py` payload format byte-for-byte in the Swift port — do not fork the token shape.

## Handoff Rules

1. Route connector ingestion work to `desktop-mac-connectors`.
2. Route local MCP host + OpenClaw conformance work to `desktop-mac-mcp-host`.
3. Route consent-protocol vault and PKM writeback changes to `vault-pkm-governance`.
4. Route MCP surface or consent-MCP changes to `mcp-developer-surface` or `hushh-consent-mcp` when the boundary is server-side.
5. Route broad repo mapping back to `repo-context`.

## Required Checks

```bash
./bin/hushh native mac build
./bin/hushh native mac test
python3 .codex/skills/codex-skill-authoring/scripts/skill_lint.py
```
