# One for macOS — Distribution

> Two distribution channels: Developer ID + Notarization (v1, full feature set) and Mac App Store (v2, sandbox subset). Both built from the same SwiftPM packages but with separate Xcode schemes + entitlements.

## v1 — Developer ID + Notarization

| Property | Value |
|---|---|
| Scheme | `OneMac` |
| Bundle ID | `ai.hushh.one` |
| Entitlements | `Resources/OneMac/OneMac.entitlements` |
| Sandbox | OFF |
| Hardened Runtime | ON |
| Library Validation | ON |
| Notarization | Required (see `scripts/notarize.sh`) |
| Stapler | Required |
| Code Signing Identity | "Developer ID Application: Hushh Inc. (XXXXXXXXXX)" — injected by CI |
| Distribution | Direct `.dmg` via the One website |

**CI pipeline** (`.github/workflows/one-mac.yml`):

1. `xcodegen generate` (generates `OneMac.xcodeproj/`).
2. `swiftlint --strict` + `swift-format lint -r --strict`.
3. `xcodebuild -scheme OneMac archive` with ad-hoc cert on PRs; real Developer-ID cert on `main`-merge.
4. `codesign --verify --strict --deep --verbose=4`.
5. `notarytool submit --wait` (DRY_RUN=true on PRs; real submit on tagged releases).
6. `xcrun stapler staple` + `stapler validate`.
7. `spctl --assess --type execute`.

## v2 — Mac App Store (planned, Phase 5+)

| Property | Value |
|---|---|
| Scheme | `OneMacMAS` |
| Bundle ID | `ai.hushh.one.mas` |
| Entitlements | `Resources/OneMac/OneMac.MAS.entitlements` |
| Sandbox | **ON** |
| Hardened Runtime | ON |
| AppleEvents | Dropped (AppleScript Notes bridge unavailable) |
| MailKit | Dropped (no private SPI under sandbox) |
| SMAppService LaunchAgent | Dropped (sandbox forbids; use XPC service-in-app) |
| Connector subset | LocalFS (user-selected only) + Calendar + Reminders |
| Distribution | App Store Connect |

**Code paths**: `#if MAS` compile guards everywhere the two schemes diverge. The `OneMacMAS` scheme defines `SWIFT_ACTIVE_COMPILATION_CONDITIONS: "$(inherited) MAS"`.

## Cert injection

Local development uses a self-signed `Apple Development` cert. CI injects the real Developer-ID cert via:

- macOS keychain populated from the GitHub Actions encrypted secret `APPLE_DEVELOPER_ID_P12`.
- `APPLE_TEAM_ID`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` env vars on the `macos-15` runner.
- `xcconfig` overlay file generated at CI runtime sets `CODE_SIGN_IDENTITY` and `DEVELOPMENT_TEAM`.

Secrets never appear in logs (`add-mask::` directives in the workflow).

## Release cadence (Phase 1 target)

- Every merged PR produces a notarized dry-run archive.
- Tagged releases (`v0.x.0`) produce a real notarized + stapled `.dmg`.
- Phase 1 ships `v0.1.0` (skeleton + foundation) at end of PR-7.

## Migration to MAS

When MAS variant is enabled:

1. New users on a sandboxed Mac install from App Store → land on `ai.hushh.one.mas` bundle.
2. Existing Developer-ID users keep `ai.hushh.one` and can continue receiving direct-download updates.
3. Both variants share the same cloud PKM ciphertext namespace; user vault on Mac is identical.
4. Vault migration script (`scripts/migrate-mas.sh`) copies SE-wrapped keys into the new app's Keychain access group if the user opts in.

See `docs/threat-model.md` §Elevation of privilege for the MAS sandbox-escape mitigation.
