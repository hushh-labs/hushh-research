// SPDX-FileCopyrightText: 2026 Hushh
// SPDX-License-Identifier: Apache-2.0

import Foundation
import os.signpost

/// Canonical `OSSignposter` instances + named signpost identities for One.
///
/// Every performance-sensitive code path emits one of these signposts so
/// Instruments can attribute time deterministically. The documented contract
/// lives in `apps/one-mac/docs/observability.md`; tests assert each named
/// signpost fires at least once during the relevant scenario.
public enum OneSignpost {
    /// Indexer subsystem signposter.
    public static let indexer = OSSignposter(subsystem: OneLog.subsystem, category: "indexer.signpost")
    /// MCP server signposter.
    public static let mcp = OSSignposter(subsystem: OneLog.subsystem, category: "mcp.signpost")
    /// Consent + token signposter.
    public static let consent = OSSignposter(subsystem: OneLog.subsystem, category: "consent.signpost")

    /// Documented signpost names.
    ///
    /// Tests assert these strings stay stable across releases so external
    /// profiling tooling does not break.
    public enum Name {
        public static let indexerIngest: StaticString = "indexer.ingest"
        public static let indexerQueryBM25: StaticString = "indexer.query.bm25"
        public static let indexerQueryVector: StaticString = "indexer.query.vector"
        public static let mcpToolInvoke: StaticString = "mcp.tool.invoke"
        public static let consentTokenValidate: StaticString = "consent.token.validate"
    }
}
