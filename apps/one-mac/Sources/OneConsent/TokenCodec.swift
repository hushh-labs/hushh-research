// SPDX-FileCopyrightText: 2026 Hushh
// SPDX-License-Identifier: Apache-2.0

import CryptoKit
import Foundation

/// Hushh Consent Token (HCT) — Swift port of the canonical signer at
/// ``consent-protocol/hushh_mcp/consent/token.py``.
///
/// Byte-for-byte parity with Python is guaranteed by the golden-vector test
/// at ``apps/one-mac/Tests/OneConsentTests/GoldenVectorTests.swift``, which
/// loads ``consent-protocol/tests/fixtures/hct_golden_vectors.json`` and
/// asserts every Swift-produced token matches the Python source-of-truth
/// output for the same input.
public enum TokenCodec {
    /// Canonical token prefix used by every HCT.
    public static let prefix = "HCT"

    /// Parsed Hushh Consent Token returned by a successful ``validate(_:...)`` call.
    public struct HCT: Equatable, Sendable {
        public let token: String
        public let userId: String
        public let agentId: String
        public let scope: String
        public let issuedAt: Int64
        public let expiresAt: Int64
        public let signature: String
        public let commercial: Bool

        public init(
            token: String,
            userId: String,
            agentId: String,
            scope: String,
            issuedAt: Int64,
            expiresAt: Int64,
            signature: String,
            commercial: Bool
        ) {
            self.token = token
            self.userId = userId
            self.agentId = agentId
            self.scope = scope
            self.issuedAt = issuedAt
            self.expiresAt = expiresAt
            self.signature = signature
            self.commercial = commercial
        }
    }

    /// Outcome of ``validate(_:expectedScope:requireCommercial:signingKey:nowMs:)``.
    public enum ValidationResult: Equatable, Sendable {
        case valid(HCT)
        case invalid(reason: String)
    }

    /// Issue a new consent token.
    ///
    /// Inputs are encoded as canonical payload bytes and HMAC-SHA256-signed
    /// with ``signingKey`` (UTF-8 encoded). Format mirrors
    /// ``hushh_mcp.consent.token.issue_token`` exactly:
    ///
    /// - Legacy (non-commercial):
    ///   ``HCT:<urlsafe_b64(user_id|agent_id|scope|issued_at|expires_at)>.<hex_sig>``
    /// - Commercial:
    ///   ``HCT:<urlsafe_b64(user_id|agent_id|scope|issued_at|expires_at|commercial)>.<hex_sig>``
    ///
    /// All fields are UTF-8; base64 keeps standard `=` padding; signature is
    /// lowercase hex (64 chars).
    public static func issue(
        userId: String,
        agentId: String,
        scope: String,
        issuedAt: Int64,
        expiresAt: Int64,
        commercial: Bool = false,
        signingKey: String
    ) -> String {
        let raw = canonicalPayload(
            userId: userId,
            agentId: agentId,
            scope: scope,
            issuedAt: issuedAt,
            expiresAt: expiresAt,
            commercial: commercial
        )
        let signature = sign(raw, signingKey: signingKey)
        let encoded = urlSafeBase64Encode(raw)
        return "\(prefix):\(encoded).\(signature)"
    }

    /// Validate a token string.
    ///
    /// Mirrors ``hushh_mcp.consent.token.validate_token`` (without the
    /// in-memory revocation check, which is the caller's responsibility via
    /// ``RevocationCache``). Returns ``.valid(HCT)`` or ``.invalid(reason:)``
    /// with a reason string that matches the Python canonical messages so
    /// downstream UI rendering is portable.
    public static func validate(
        _ token: String,
        expectedScope: String? = nil,
        requireCommercial: Bool? = nil,
        signingKey: String,
        nowMs: Int64? = nil
    ) -> ValidationResult {
        let currentMs = nowMs ?? Int64(Date().timeIntervalSince1970 * 1000)

        guard let parts = parseTokenString(token) else {
            return .invalid(reason: "Malformed token")
        }

        if parts.prefix != prefix {
            return .invalid(reason: "Invalid token prefix")
        }

        guard let rawPayload = urlSafeBase64Decode(parts.encoded) else {
            return .invalid(reason: "Malformed token")
        }

        guard let parsed = parseCanonicalPayload(rawPayload) else {
            return .invalid(reason: "Malformed token")
        }

        let canonical = canonicalPayload(
            userId: parsed.userId,
            agentId: parsed.agentId,
            scope: parsed.scope,
            issuedAt: parsed.issuedAt,
            expiresAt: parsed.expiresAt,
            commercial: parsed.commercial
        )
        let expectedSignature = sign(canonical, signingKey: signingKey)

        guard constantTimeEqual(parts.signature, expectedSignature) else {
            return .invalid(reason: "Invalid signature")
        }

        if let expectedScope, !scopeMatches(granted: parsed.scope, expected: expectedScope) {
            return .invalid(
                reason: "Scope mismatch: token has '\(parsed.scope)', but '\(expectedScope)' required"
            )
        }

        if currentMs >= parsed.expiresAt {
            return .invalid(reason: "Token expired")
        }

        if requireCommercial == true && !parsed.commercial {
            return .invalid(reason: "Commercial consent required for this operation")
        }
        if requireCommercial == false && parsed.commercial {
            return .invalid(reason: "Non-commercial consent required for this operation")
        }

        return .valid(
            HCT(
                token: token,
                userId: parsed.userId,
                agentId: parsed.agentId,
                scope: parsed.scope,
                issuedAt: parsed.issuedAt,
                expiresAt: parsed.expiresAt,
                signature: parts.signature,
                commercial: parsed.commercial
            )
        )
    }

    // MARK: - Internal helpers

    struct ParsedPayload: Sendable {
        let userId: String
        let agentId: String
        let scope: String
        let issuedAt: Int64
        let expiresAt: Int64
        let commercial: Bool
    }

    struct ParsedTokenParts: Sendable {
        let prefix: String
        let encoded: String
        let signature: String
    }

    static func canonicalPayload(
        userId: String,
        agentId: String,
        scope: String,
        issuedAt: Int64,
        expiresAt: Int64,
        commercial: Bool
    ) -> String {
        let head = "\(userId)|\(agentId)|\(scope)|\(issuedAt)|\(expiresAt)"
        return commercial ? "\(head)|commercial" : head
    }

    static func sign(_ input: String, signingKey: String) -> String {
        let key = SymmetricKey(data: Data(signingKey.utf8))
        let mac = HMAC<SHA256>.authenticationCode(for: Data(input.utf8), using: key)
        return mac.map { String(format: "%02x", $0) }.joined()
    }

    static func urlSafeBase64Encode(_ input: String) -> String {
        Data(input.utf8)
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
    }

    static func urlSafeBase64Decode(_ input: String) -> String? {
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

    static func parseTokenString(_ token: String) -> ParsedTokenParts? {
        guard let colonRange = token.range(of: ":") else { return nil }
        let prefixSubstring = token[token.startIndex ..< colonRange.lowerBound]
        let signedPart = token[colonRange.upperBound ..< token.endIndex]
        guard let dotRange = signedPart.range(of: ".") else { return nil }
        let encoded = signedPart[signedPart.startIndex ..< dotRange.lowerBound]
        let signature = signedPart[dotRange.upperBound ..< signedPart.endIndex]
        if encoded.isEmpty || signature.isEmpty { return nil }
        return ParsedTokenParts(
            prefix: String(prefixSubstring),
            encoded: String(encoded),
            signature: String(signature)
        )
    }

    static func parseCanonicalPayload(_ raw: String) -> ParsedPayload? {
        let parts = raw.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
        let userId: String
        let agentId: String
        let scope: String
        let issuedAtStr: String
        let expiresAtStr: String
        let commercial: Bool
        if parts.count == 5 {
            userId = parts[0]
            agentId = parts[1]
            scope = parts[2]
            issuedAtStr = parts[3]
            expiresAtStr = parts[4]
            commercial = false
        } else if parts.count == 6 && parts[5] == "commercial" {
            userId = parts[0]
            agentId = parts[1]
            scope = parts[2]
            issuedAtStr = parts[3]
            expiresAtStr = parts[4]
            commercial = true
        } else {
            return nil
        }
        guard let issuedAt = Int64(issuedAtStr), let expiresAt = Int64(expiresAtStr) else {
            return nil
        }
        return ParsedPayload(
            userId: userId,
            agentId: agentId,
            scope: scope,
            issuedAt: issuedAt,
            expiresAt: expiresAt,
            commercial: commercial
        )
    }

    /// Constant-time string comparison to prevent signature-timing attacks.
    static func constantTimeEqual(_ left: String, _ right: String) -> Bool {
        let leftBytes = Array(left.utf8)
        let rightBytes = Array(right.utf8)
        if leftBytes.count != rightBytes.count { return false }
        var diff: UInt8 = 0
        for index in 0 ..< leftBytes.count {
            diff |= leftBytes[index] ^ rightBytes[index]
        }
        return diff == 0
    }

    /// Scope match supporting both static equality and ``attr.<domain>.*`` wildcards.
    ///
    /// Mirrors the helper at ``consent-protocol/hushh_mcp/consent/scope_helpers.py``
    /// for the Mac-relevant subset (Phase 1 PR-5 ports the full helper alongside
    /// the MCP server).
    static func scopeMatches(granted: String, expected: String) -> Bool {
        if granted == expected { return true }
        if granted.hasSuffix(".*") {
            let stem = String(granted.dropLast(2))
            return expected.hasPrefix(stem + ".")
        }
        if expected.hasSuffix(".*") {
            let stem = String(expected.dropLast(2))
            return granted.hasPrefix(stem + ".")
        }
        return false
    }
}
