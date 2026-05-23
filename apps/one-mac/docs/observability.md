# One for macOS — Observability

> Every `Logger` and `OSSignposter` in `apps/one-mac/` is enumerated here. CI greps for `Logger(subsystem:` literals outside `OneShared/Logging.swift` and fails the build if any are found.

## Subsystem

`ai.hushh.one` — used by every binary (`OneMac.app`, `ai.hushh.one.daemon`, every test binary).

## Categories (Logger)

| Category | Source | What it logs |
|---|---|---|
| `app` | `Sources/OneMac/**` | UI lifecycle, window state, Nav approval sheets, App Intent dispatch |
| `daemon` | `Sources/OneDaemon/**` | Daemon startup, shutdown, lifecycle, SMAppService register/unregister |
| `indexer` | `Sources/OneIndexer/**` | Ingest progress, query dispatch, MLX cold-load, SQLite WAL events |
| `mcp` | `Sources/OneMCPServer/**` | Tool dispatch, CRT validation outcome (success/expired/scope-mismatch), rate-limit decisions |
| `consent` | `Sources/OneConsent/**` | CRT issue, validate, revoke; SE keystore wrap/unwrap (never the wrapped bytes themselves) |
| `connectors` | `Sources/OneConnectors/**` | Bookmark scope grant/deny, FSEvents debounce, OAuth refresh (never tokens) |

## Signposts (OSSignposter)

| Name | Subsystem | Where |
|---|---|---|
| `indexer.ingest` | `ai.hushh.one.indexer.signpost` | `OneIndexer/Ingest.swift` |
| `indexer.query.bm25` | same | `OneIndexer/HybridRanker.swift` |
| `indexer.query.vector` | same | `OneIndexer/HybridRanker.swift` |
| `mcp.tool.invoke` | `ai.hushh.one.mcp.signpost` | `OneMCPServer/Tools/*.swift` |
| `consent.token.validate` | `ai.hushh.one.consent.signpost` | `OneConsent/TokenCodec.swift` |

## Privacy posture (never log)

- User content (titles, bodies, file paths beyond the bookmark root).
- Token bytes (CRTs, DATs, signing key material, wrapped keys).
- Decrypted vault payloads.
- OAuth access or refresh tokens.

## Privacy posture (OK to log)

- `agent_id` (public identifier registered in the agent registry).
- `scope` strings (e.g., `attr.financial.gmail`, `vault.read.macos_local_fs`).
- Counts, durations, byte sizes.
- Boolean outcomes (`valid`, `revoked`, `expired`, `scope_mismatch`).

## How to instrument new code

Always go through `OneLog.logger(.category)` — never construct a `Logger` directly. Same for `OSSignposter` — use the constants in `OneSignpost`. CI lint (`scripts/ci/one-mac-log-audit.sh`, added in PR-2) greps the source tree.

## How to inspect at runtime

```bash
# Stream all One categories
log stream --predicate 'subsystem == "ai.hushh.one"' --info --debug

# Filter to MCP tool invocations
log stream --predicate 'subsystem == "ai.hushh.one" AND category == "mcp"' --info

# Capture an Instruments trace targeting signposts
xcrun xctrace record --template 'Time Profiler' --launch -- /Applications/One.app/Contents/MacOS/One
```
