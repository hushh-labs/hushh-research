# One for macOS

> **Hussh = `[hu]man [s]ecure [s]ocket [h]ost`.**
> One for macOS is the planned **host**: the user's latest Apple-silicon Mac will run the daemon, the on-device index, and the secure socket (local MCP server) that exposes user-owned knowledge under PCHP consent to BYOA agents and trusted people.

Status: **Phase 1 in progress.** PR-1 (this branch) lands the infra root: Xcode project (via XcodeGen), entitlements + Info.plist + PrivacyInfo.xcprivacy + LaunchAgent plist, OSLog scaffold, SwiftLint + swift-format + .swift-version, notarization runbook, threat model + observability + distribution docs, CODEOWNERS, dependabot, and expanded CI. See [`docs/future/one-mac-knowledge-base-app.md`](../../docs/future/one-mac-knowledge-base-app.md) for the full Phase 1 plan and exit criteria.

## What this package will become

A native SwiftUI Mac app + LaunchAgent daemon that:

1. Ingests local + cloud knowledge sources (Files, Spotlight, Apple Notes, Apple Mail, Calendar, Obsidian, Notion, Google Drive, Slack) into an encrypted SQLite + MLX vector index.
2. Exposes that index to BYOA AI agents (Claude / ChatGPT / Cursor / local MLX) via a local MCP HTTP/SSE server on `127.0.0.1:31070`.
3. Is intended to serve as the first concrete **OpenClaw** reference implementation after the MCP host, conformance harness, and pluggable `DataSourceBinding` interface ship.
4. Mirrors PKM ciphertext to the cloud via the existing PKM contract at [`consent-protocol/api/routes/pkm_routes_shared.py`](../../consent-protocol/api/routes/pkm_routes_shared.py). **Plaintext never traverses cloud.**
5. Bridges to the existing iOS Capacitor app via the existing hosted Consent MCP at `https://api.uat.hushh.ai/mcp/` — ciphertext-only relay.

## Layout

```
apps/one-mac/
  project.yml                 XcodeGen spec; CI regenerates OneMac.xcodeproj
  Package.swift               SwiftPM build engine
  .swiftlint.yml              Strict; force-unwrap is an error
  .swift-format               Apple swift-format config
  .swift-version              Swift 5.10
  scripts/
    notarize.sh               codesign + notarytool + stapler runbook
  docs/
    threat-model.md           STRIDE, trust boundary, hardened-runtime matrix
    observability.md          OSLog subsystems + signpost catalog
    distribution.md           Developer-ID v1 + MAS v2 channels
  Resources/
    OneMac/{Info.plist, OneMac.entitlements, OneMac.MAS.entitlements,
            PrivacyInfo.xcprivacy}
    OneDaemon/{Info.plist, OneDaemon.entitlements}
    ai.hushh.one.daemon.plist  SMAppService LaunchAgent plist
  Sources/
    OneShared/   KnowledgeItem, Logging, Signposts
    OneIndexer/  SQLite + MLX embedder (stubbed; lands in PR-3)
    OneMCPServer/ OpenClaw DataSourceBinding host (stubbed; lands in PR-5)
    OneDaemon/   LaunchAgent entrypoint (full lifecycle lands in PR-7)
    OneMac/      SwiftUI app shell (Nav UI + handshake + AppIntents land in PR-6)
  Tests/
    OneSharedTests/
```

## Build

```bash
# Local SwiftPM build/test (works without Xcode):
./bin/hushh native mac build
./bin/hushh native mac test

# Xcode archive (requires Xcode 16 + xcodegen):
brew install xcodegen
cd apps/one-mac
xcodegen generate
xcodebuild -scheme OneMac -configuration Release archive
```

## Phase 1 PR sequence

| PR | Title | Status |
|---|---|---|
| **PR-1** | Infra root: Xcode project, entitlements, PrivacyInfo, OSLog, lint, CODEOWNERS, dependabot | **in progress** |
| PR-2 | OneConsent: Swift HCT port + golden-vector parity + SE keystore | pending |
| PR-3 | OneIndexer: SQLite + MLX + hybrid ranker + perf budgets | pending |
| PR-4 | OneConnectors: LocalFS + Spotlight + bookmark sandbox tests | pending |
| PR-5 | OneMCPServer: Hummingbird + 3 tools + OpenClaw conformance | pending |
| PR-6 | OneMac UI: Nav 5-tab + handshake + AppIntents + design tokens + xcstrings | pending |
| PR-7 | OneDaemon: SMAppService lifecycle + idle RSS budget + notarize dry-run | pending |
> Contributor note: this README tracks the active One Mac Phase 1 implementation plan.

## License

Apache-2.0. See repo-root `LICENSE`. Per-file SPDX headers conform to the [REUSE](https://reuse.software/) specification.
