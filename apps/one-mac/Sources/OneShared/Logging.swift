// SPDX-FileCopyrightText: 2026 Hushh
// SPDX-License-Identifier: Apache-2.0

import Foundation
import os

/// OSLog subsystem + category factory for the One Mac app and daemon.
///
/// Every logger in this codebase MUST be obtained through `OneLog`. The
/// observability doc at `apps/one-mac/docs/observability.md` enumerates the
/// canonical categories; tests assert no `Logger` literals are created
/// elsewhere.
public enum OneLog {
    /// Reverse-DNS root subsystem used by every One Mac binary.
    public static let subsystem = "ai.hushh.one"

    /// Pre-baked categories that map 1:1 to the documented signpost surfaces.
    public enum Category: String, CaseIterable, Sendable {
        case app
        case daemon
        case indexer
        case mcp
        case consent
        case connectors
    }

    /// Returns the canonical `Logger` for a given category.
    ///
    /// Privacy posture: never log user content; never log token bytes; never
    /// log file contents. Identifiers (agent_id, scope strings) are public
    /// only when they carry no PII — see threat-model.md §Observability.
    public static func logger(_ category: Category) -> Logger {
        Logger(subsystem: subsystem, category: category.rawValue)
    }
}
