# Third-Party Notices — One for macOS

This package is Apache-2.0 licensed. Below are third-party dependencies that will be introduced in later phases. Phase 0 has no third-party Swift dependencies — only the Swift / SwiftUI / Foundation standard libraries.

## Phase 1+ planned dependencies

| Library | License | Used for | Phase |
|---|---|---|---|
| [mlx-swift](https://github.com/ml-explore/mlx-swift) | MIT | On-device embeddings + classification | 1 |
| [Hummingbird](https://github.com/hummingbird-project/hummingbird) | Apache-2.0 | Local MCP HTTP/SSE server | 1 |
| [swift-log](https://github.com/apple/swift-log) | Apache-2.0 | Structured logging | 1 |
| [GRDB.swift](https://github.com/groue/GRDB.swift) | MIT | SQLite + FTS5 + migrations | 1 |
| [swift-syntax](https://github.com/apple/swift-syntax) | Apache-2.0 | App Intents codegen helpers | 3 |

Each new dependency added in a subsequent PR must update this file with library name, license, role, and the phase that introduced it.
