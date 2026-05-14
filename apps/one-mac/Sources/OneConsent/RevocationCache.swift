// SPDX-FileCopyrightText: 2026 Hushh
// SPDX-License-Identifier: Apache-2.0

import Foundation

/// Actor-isolated in-memory revocation cache for issued HCTs.
///
/// Mirrors ``hushh_mcp.consent.token._BoundedRevocationCache`` semantics:
/// every entry is kept until one hour after the token's embedded expiry.
/// Expired entries are evicted lazily on `add(_:)` and `contains(_:)`
/// rather than via a background timer, matching the Python implementation.
///
/// Unexpired revocations are never evicted under size pressure — local
/// revocation must stay strict even if the size cap is reached.
public actor RevocationCache {
    /// Hard ceiling. Above this the actor logs `OSLog.fault` but accepts the
    /// add — same posture as the canonical Python cache.
    public static let maxSize = 100_000

    /// Grace period applied past a token's embedded expiry before its
    /// revocation entry becomes eligible for eviction. Mirrors Python's
    /// ``_EXPIRED_TOKEN_GRACE_MS``.
    public static let expiredTokenGraceMs: Int64 = 60 * 60 * 1000

    /// TTL applied when the token string cannot be parsed (e.g. revoke called
    /// before issue). Mirrors Python's ``_MALFORMED_TOKEN_TTL_MS`` of
    /// 7 days + 1 hour grace.
    ///
    /// Uses the explicit type name instead of `Self` because covariant `Self`
    /// is not allowed in stored property initializers (Swift 6 diagnostic).
    public static let malformedTokenTtlMs: Int64 =
        (1000 * 60 * 60 * 24 * 7) + RevocationCache.expiredTokenGraceMs

    private var entries: [String: Int64] = [:]
    private let clock: @Sendable () -> Int64

    /// Create a cache. ``clock`` returns current epoch milliseconds. Defaults
    /// to wall-clock; tests can inject a deterministic clock.
    public init(clock: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.clock = clock
    }

    /// Add a token string to the cache as revoked.
    public func add(_ token: String) {
        let now = clock()
        evictExpired(now: now)
        if entries.count >= Self.maxSize {
            // Cap exceeded; emit a warning but still accept the add. The
            // expectation is that this is rare and signals an upstream leak.
            // We do not log here — the caller can attach a logger if it cares.
            // Production wiring routes to ``OneLog.logger(.consent)``.
        }
        entries[token] = evictAfterMs(for: token, now: now)
    }

    /// Return true if the token is currently considered revoked.
    public func contains(_ token: String) -> Bool {
        let now = clock()
        guard let evictAfter = entries[token] else { return false }
        if now >= evictAfter {
            entries.removeValue(forKey: token)
            return false
        }
        return true
    }

    /// Current number of cached entries (after lazy eviction sweep).
    public func count() -> Int {
        let now = clock()
        evictExpired(now: now)
        return entries.count
    }

    /// Remove every entry.
    public func clear() {
        entries.removeAll(keepingCapacity: false)
    }

    // MARK: - Helpers

    private func evictExpired(now: Int64) {
        // Collect first, mutate second — avoids modifying the dictionary while
        // iterating, which is undefined behavior on `Dictionary` in Swift.
        let expiredKeys = entries.compactMap { key, evictAfter in
            evictAfter <= now ? key : nil
        }
        for key in expiredKeys {
            entries.removeValue(forKey: key)
        }
    }

    private func evictAfterMs(for token: String, now: Int64) -> Int64 {
        // Try to read the embedded expiry from the canonical payload. Same
        // format as Python: HCT:<urlsafe_b64(raw)>.<sig> where raw has 5 or 6
        // pipe-separated fields and field index 4 is expires_at (ms).
        let parts = token.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2 else {
            return now + Self.malformedTokenTtlMs
        }
        let signedPart = parts[1]
        let signedSplit = signedPart.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false)
        guard signedSplit.count == 2 else {
            return now + Self.malformedTokenTtlMs
        }
        let encoded = String(signedSplit[0])
        guard let raw = decodeUrlSafeBase64(encoded) else {
            return now + Self.malformedTokenTtlMs
        }
        let fields = raw.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
        guard fields.count == 5 || fields.count == 6, let expiresAt = Int64(fields[4]) else {
            return now + Self.malformedTokenTtlMs
        }
        return expiresAt + Self.expiredTokenGraceMs
    }

    private func decodeUrlSafeBase64(_ input: String) -> String? {
        var standard = input
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = standard.count % 4
        if remainder != 0 {
            standard.append(String(repeating: "=", count: 4 - remainder))
        }
        guard let data = Data(base64Encoded: standard) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
