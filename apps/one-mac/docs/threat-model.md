# One for macOS — Threat Model

> Status: Phase 1. STRIDE-formatted. Reviewed by `desktop-mac` owner before each Phase 1 PR merge.

## Trust Boundary Map

```
+-----------------------------------------------------+
|  User's Mac (trusted)                               |
|                                                     |
|  +-----------------+   XPC    +-------------------+ |
|  | OneMac.app GUI  | <------> |  ai.hushh.one     | |
|  | (SwiftUI)       |          |  .daemon          | |
|  +-----------------+          |  (LaunchAgent)    | |
|                               |                   | |
|                               | OneIndexer +      | |
|                               | OneMCPServer +    | |
|                               | OneConnectors +   | |
|                               | SE-wrapped keys   | |
|                               +---------+---------+ |
|                                         |           |
|     127.0.0.1:31070 (loopback only)     |           |
|     <---------------------------------- /           |
|     |                                               |
|     v                                               |
|  BYOA agents (Claude Desktop / Cursor /             |
|  ChatGPT MCP / local MLX) — semi-trusted            |
|  (gated by per-agent CRT)                           |
+-----------------------------------------------------+
        |                                  |
        | HTTPS (ciphertext blobs only)    |
        v                                  v
+--------------------+          +------------------------+
| Hushh cloud        |          | iPhone One             |
| (untrusted)        | <------> | (existing Capacitor    |
| - pkm_blobs        |          |  PersonalKnowledgeModel|
| - pkm_manifests    |          |  Plugin)               |
| - audit log        |          +------------------------+
+--------------------+
```

The trust boundary is the user's Mac. Everything inside the Mac is trusted; everything outside is not. Per-device Secure-Enclave keys never leave the device. Cloud holds ciphertext + manifests only; the server cannot decrypt vault contents.

## STRIDE

### Spoofing

- **S-1. Agent impersonation.** An attacker forges a CRT to impersonate Claude Desktop. **Mitigation**: `OneConsent.TokenCodec` validates HMAC-SHA256 over the canonical payload using the device-bound signing key stored in Keychain access group `ai.hushh.one`; signing key is Secure-Enclave-wrapped; rotation every hour invalidates leaked tokens within at most 60 minutes; CRT carries `agent_id` so per-agent revocation is one-call.
- **S-2. Daemon impersonation on loopback.** An attacker process on the Mac binds `127.0.0.1:31070` first. **Mitigation**: daemon bind-fail-fast on `EADDRINUSE`; logs `OSLog.fault`; surfaces a Nav alert; user is asked to investigate before any CRT issuance.

### Tampering

- **T-1. SQLite index tampering.** An attacker writes plaintext into `~/Library/Application Support/ai.hushh.one/index.sqlite`. **Mitigation**: every payload column is AES-256-GCM ciphertext + GCM auth tag; integrity check on read; bad tag triggers `OSLog.fault` + connector quarantine.
- **T-2. Bookmark scope escalation.** An attacker tricks the FSEvents watcher into following a symlink into `~/Library/Mail`. **Mitigation**: walker resolves bookmarks lazily, rejects any URL whose security-scoped resolved path falls outside the bookmark scope; deny-test asserts `~/Library/Mail` cannot be read in `OneConnectorsTests`.

### Repudiation

- **R-1. Agent claims it never made a call.** **Mitigation**: every MCP tool invocation appends a row to `consent_log` (local, append-only) AND a transparency POST to the cloud `pkm_index` audit table; both rows carry `crt_id`, `dat_id`, `agent_id`, `scope`, `ts`. Cloud transparency log is the user's source of truth.

### Information disclosure

- **I-1. Plaintext over network.** **Mitigation**: invariants asserted in CI by `IntentParityTests` + `NetworkEgressTests`:
  - Only `127.0.0.1:31070` bind addresses appear in `lsof`.
  - Only `https://api.uat.hushh.ai/pkm/blobs` and `/pkm/manifests` POSTs egress the Mac, and only `{ciphertext, iv, tag, manifest_entry}` JSON payloads are accepted by the request encoder.
  - `URLSession` configuration disables redirects to non-HTTPS, sets `tls12+`.
- **I-2. Plaintext to disk.** **Mitigation**: plaintext exists only in daemon RAM during a consented read. Ciphertext blobs at rest; AES key derived from SE-wrapped material; key never written to disk in cleartext; integration test reads the Keychain blob and confirms it is a wrapped form.
- **I-3. Log leakage.** **Mitigation**: `OneLog` privacy policy (see `Logging.swift`): never log user content, never log token bytes, never log file contents. `XCUITest` greps build logs for forbidden substrings.

### Denial of service

- **D-1. CRT flood.** **Mitigation**: token-bucket rate limit per `agent_id` in `OneMCPServer/Middleware/RateLimit.swift`; 60 requests / min default; 429 on burst.
- **D-2. Connector ingest stall blocks query.** **Mitigation**: ingest and query are separate event loops; query path never awaits ingest backpressure.

### Elevation of privilege

- **E-1. AppleScript bridge to Apple Notes is escalated to write privileges.** **Mitigation**: AppleScript surface is read-only by design; integration test asserts no `tell application "Notes" to make` or `to delete` constructs in the source; entitlements declare only the read intent in Info.plist purpose string.
- **E-2. MAS sandbox escape.** **Mitigation**: MAS variant drops AppleEvents, MailKit, and SMAppService LaunchAgent at compile time (`#if MAS`). Distribution matrix documented in `distribution.md`.

## Hardened-runtime opt-out matrix

| Opt-out | Decision | Reason |
|---|---|---|
| `com.apple.security.cs.allow-jit` | **OFF** | mlx-swift uses MTLBuffer pinning, not JIT |
| `com.apple.security.cs.allow-unsigned-executable-memory` | **OFF** | Never accept unsigned code |
| `com.apple.security.cs.disable-library-validation` | **OFF** | We sign every binary including embedded daemon |
| `com.apple.security.cs.allow-dyld-environment-variables` | **OFF** | No injection vectors |

## Supply chain

- `mlx-swift` (MIT, Apple), `grdb.swift` (MIT), `hummingbird` (Apache-2.0), `swift-snapshot-testing` (MIT) — pinned by exact version in `Package.swift`; Dependabot configured to alert on `major` updates, auto-PR `patch`/`minor`; reviewed by `desktop-mac` owner.

## Open risks tracked outside this doc

See `apps/one-mac/docs/distribution.md` for Developer-ID vs MAS posture, and `docs/future/one-mac-knowledge-base-app.md` for the Phase 5+ Merkle-sealed transparency log + Pedersen commitments that are deliberately deferred today.
