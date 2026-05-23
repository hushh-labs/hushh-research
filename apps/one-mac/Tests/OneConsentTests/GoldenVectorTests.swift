// SPDX-FileCopyrightText: 2026 Hushh
// SPDX-License-Identifier: Apache-2.0

@testable import OneConsent
import XCTest

/// Byte-for-byte parity gate between the Swift ``TokenCodec`` and the canonical
/// Python signer at ``consent-protocol/hushh_mcp/consent/token.py``.
///
/// Loads the committed golden JSON at
/// ``consent-protocol/tests/fixtures/hct_golden_vectors.json`` and, for every
/// vector, asserts that
///
///   ``TokenCodec.issue(...) == vector.expected_token``
///
/// If this test breaks, either the Python source-of-truth changed or the
/// Swift port drifted — either way, fix or regenerate before merging.
final class GoldenVectorTests: XCTestCase {
    func testEveryGoldenVectorRoundTrips() throws {
        let payload = try loadGoldenPayload()
        XCTAssertEqual(payload.version, 1)
        XCTAssertEqual(payload.vectors.count, 12, "expected 12 golden vectors")

        for vector in payload.vectors {
            let issued = TokenCodec.issue(
                userId: vector.input.userId,
                agentId: vector.input.agentId,
                scope: vector.input.scope,
                issuedAt: vector.input.issuedAt,
                expiresAt: vector.input.expiresAt,
                commercial: vector.input.commercial,
                signingKey: vector.input.signingKey
            )
            XCTAssertEqual(
                issued,
                vector.expectedToken,
                "Swift HCT parity drift on vector \(vector.name)"
            )
        }
    }

    func testEveryGoldenVectorValidatesCleanly() throws {
        let payload = try loadGoldenPayload()
        for vector in payload.vectors {
            // Validate at the vector's issuedAt + 1ms so it's well within
            // expiresAt for every vector regardless of TTL.
            let result = TokenCodec.validate(
                vector.expectedToken,
                signingKey: vector.input.signingKey,
                nowMs: vector.input.issuedAt + 1
            )
            switch result {
            case .invalid(let reason):
                XCTFail("Vector \(vector.name) failed to validate: \(reason)")
            case .valid(let hct):
                XCTAssertEqual(hct.userId, vector.input.userId)
                XCTAssertEqual(hct.agentId, vector.input.agentId)
                XCTAssertEqual(hct.scope, vector.input.scope)
                XCTAssertEqual(hct.issuedAt, vector.input.issuedAt)
                XCTAssertEqual(hct.expiresAt, vector.input.expiresAt)
                XCTAssertEqual(hct.commercial, vector.input.commercial)
                XCTAssertEqual(hct.token, vector.expectedToken)
            }
        }
    }

    func testExpiredTokensAreRejected() throws {
        let payload = try loadGoldenPayload()
        guard let vector = payload.vectors.first else { return XCTFail("no vectors") }
        let result = TokenCodec.validate(
            vector.expectedToken,
            signingKey: vector.input.signingKey,
            nowMs: vector.input.expiresAt
        )
        XCTAssertEqual(result, .invalid(reason: "Token expired"))
    }

    func testTamperedSignaturesAreRejected() throws {
        let payload = try loadGoldenPayload()
        guard let vector = payload.vectors.first else { return XCTFail("no vectors") }
        let originalSuffix = String(vector.expectedToken.suffix(64))
        let tamperedSuffix = String(
            originalSuffix.prefix(63) + (originalSuffix.last == "0" ? "1" : "0")
        )
        let tampered = String(vector.expectedToken.dropLast(64)) + tamperedSuffix
        let result = TokenCodec.validate(
            tampered,
            signingKey: vector.input.signingKey,
            nowMs: vector.input.issuedAt + 1
        )
        XCTAssertEqual(result, .invalid(reason: "Invalid signature"))
    }

    func testScopeMismatchIsRejected() throws {
        let payload = try loadGoldenPayload()
        guard let vector = payload.vectors.first(where: { $0.input.scope == "pkm.read" }) else {
            return XCTFail("no pkm.read vector")
        }
        let result = TokenCodec.validate(
            vector.expectedToken,
            expectedScope: "vault.owner",
            signingKey: vector.input.signingKey,
            nowMs: vector.input.issuedAt + 1
        )
        switch result {
        case .invalid(let reason):
            XCTAssertTrue(
                reason.contains("Scope mismatch"),
                "unexpected reason: \(reason)"
            )
        case .valid:
            XCTFail("scope mismatch should have failed")
        }
    }

    func testCommercialGateAcceptsAndRejectsCorrectly() throws {
        let payload = try loadGoldenPayload()
        guard
            let commercialVector = payload.vectors.first(where: { $0.input.commercial }),
            let nonCommercialVector = payload.vectors.first(where: { !$0.input.commercial })
        else {
            return XCTFail("missing vectors")
        }

        let commercialAccepted = TokenCodec.validate(
            commercialVector.expectedToken,
            requireCommercial: true,
            signingKey: commercialVector.input.signingKey,
            nowMs: commercialVector.input.issuedAt + 1
        )
        if case .invalid = commercialAccepted {
            XCTFail("commercial token rejected when requireCommercial=true")
        }

        let nonCommercialRejected = TokenCodec.validate(
            nonCommercialVector.expectedToken,
            requireCommercial: true,
            signingKey: nonCommercialVector.input.signingKey,
            nowMs: nonCommercialVector.input.issuedAt + 1
        )
        XCTAssertEqual(
            nonCommercialRejected,
            .invalid(reason: "Commercial consent required for this operation")
        )

        let commercialBlocked = TokenCodec.validate(
            commercialVector.expectedToken,
            requireCommercial: false,
            signingKey: commercialVector.input.signingKey,
            nowMs: commercialVector.input.issuedAt + 1
        )
        XCTAssertEqual(
            commercialBlocked,
            .invalid(reason: "Non-commercial consent required for this operation")
        )
    }

    // MARK: - Fixture loading

    private struct GoldenPayload: Decodable {
        let version: Int
        let vectors: [GoldenVector]
    }

    private struct GoldenVector: Decodable {
        let name: String
        let input: GoldenInput
        let expectedToken: String

        private enum CodingKeys: String, CodingKey {
            case name
            case input
            case expectedToken = "expected_token"
        }
    }

    private struct GoldenInput: Decodable {
        let userId: String
        let agentId: String
        let scope: String
        let issuedAt: Int64
        let expiresAt: Int64
        let commercial: Bool
        let signingKey: String

        private enum CodingKeys: String, CodingKey {
            case userId = "user_id"
            case agentId = "agent_id"
            case scope
            case issuedAt = "issued_at"
            case expiresAt = "expires_at"
            case commercial
            case signingKey = "signing_key"
        }
    }

    private func loadGoldenPayload() throws -> GoldenPayload {
        // Walk up from this test file to the repo root, then resolve
        // consent-protocol/tests/fixtures/hct_golden_vectors.json.
        let thisFile = URL(fileURLWithPath: #filePath)
        var dir = thisFile.deletingLastPathComponent()
        while dir.path != "/" {
            let candidate = dir
                .appendingPathComponent("consent-protocol")
                .appendingPathComponent("tests")
                .appendingPathComponent("fixtures")
                .appendingPathComponent("hct_golden_vectors.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                let data = try Data(contentsOf: candidate)
                return try JSONDecoder().decode(GoldenPayload.self, from: data)
            }
            dir = dir.deletingLastPathComponent()
        }
        XCTFail("hct_golden_vectors.json not found walking up from \(thisFile.path)")
        throw CocoaError(.fileNoSuchFile)
    }
}
