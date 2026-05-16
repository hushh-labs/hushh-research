// SPDX-FileCopyrightText: 2026 Hushh
// SPDX-License-Identifier: Apache-2.0

@testable import OneConsent
import XCTest

/// Verifies that ``RevocationCache`` matches the semantics of
/// ``hushh_mcp.consent.token._BoundedRevocationCache``: revoked tokens are
/// surfaced until one hour past their embedded expiry, then evicted lazily.
final class RevocationCacheTests: XCTestCase {
    func testAddedTokenIsRevokedImmediately() async {
        let clock = MutableClock(start: 1_000_000_000_000)
        let cache = RevocationCache(clock: { clock.read() })
        let token = TokenCodec.issue(
            userId: "user_a",
            agentId: "agent_a",
            scope: "vault.owner",
            issuedAt: clock.read(),
            expiresAt: clock.read() + 60_000,
            signingKey: "test-key"
        )
        await cache.add(token)
        let isRevoked = await cache.contains(token)
        XCTAssertTrue(isRevoked, "token should be revoked immediately after add")
    }

    func testRevocationSurvivesUntilExpiryPlusGrace() async {
        let issuedAt: Int64 = 1_000_000_000_000
        let expiresAt: Int64 = issuedAt + 60_000
        let clock = MutableClock(start: issuedAt)
        let cache = RevocationCache(clock: { clock.read() })
        let token = TokenCodec.issue(
            userId: "user_b",
            agentId: "agent_b",
            scope: "pkm.read",
            issuedAt: issuedAt,
            expiresAt: expiresAt,
            signingKey: "test-key"
        )
        await cache.add(token)

        // Move past expiry but within the 1-hour grace window — still revoked.
        clock.set(expiresAt + (30 * 60 * 1000))
        let withinGrace = await cache.contains(token)
        XCTAssertTrue(withinGrace, "revocation should hold within grace window")

        // Move past grace — evicted lazily on the next contains().
        clock.set(expiresAt + RevocationCache.expiredTokenGraceMs + 1)
        let pastGrace = await cache.contains(token)
        XCTAssertFalse(pastGrace, "revocation should drop after grace window")
    }

    func testUnknownTokenIsNotRevoked() async {
        let cache = RevocationCache(clock: { 0 })
        let present = await cache.contains("HCT:not-a-real-token.deadbeef")
        XCTAssertFalse(present)
    }

    func testClearEmptiesCache() async {
        let cache = RevocationCache(clock: { 1_000_000_000_000 })
        await cache.add("HCT:abc.def")
        await cache.add("HCT:ghi.jkl")
        let countBefore = await cache.count()
        XCTAssertEqual(countBefore, 2)
        await cache.clear()
        let countAfter = await cache.count()
        XCTAssertEqual(countAfter, 0)
    }

    func testMalformedTokenStillCachedWithFallbackTtl() async {
        let cache = RevocationCache(clock: { 1_000_000_000_000 })
        let malformed = "not-even-a-token-shape"
        await cache.add(malformed)
        let present = await cache.contains(malformed)
        XCTAssertTrue(present, "malformed tokens still cached with fallback TTL")
    }
}

/// Thread-safe mutable clock for tests that need to advance time deterministically.
/// Class-based so the closure captured by ``RevocationCache.init(clock:)`` can
/// observe mutations from the test, satisfying Swift 6 strict concurrency.
private final class MutableClock: @unchecked Sendable {
    private let lock = NSLock()
    private var nowMs: Int64

    init(start: Int64) {
        self.nowMs = start
    }

    func read() -> Int64 {
        lock.lock(); defer { lock.unlock() }
        return nowMs
    }

    func set(_ newValue: Int64) {
        lock.lock(); defer { lock.unlock() }
        nowMs = newValue
    }
}
