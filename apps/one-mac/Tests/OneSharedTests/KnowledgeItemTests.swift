// SPDX-FileCopyrightText: 2026 Hushh
// SPDX-License-Identifier: Apache-2.0

import XCTest
@testable import OneShared

final class KnowledgeItemTests: XCTestCase {
    func testCodableRoundTrip() throws {
        let original = KnowledgeItem(
            id: "item-1",
            source: "local_fs",
            kind: "markdown",
            title: "Test",
            body: "body",
            createdAt: Date(timeIntervalSince1970: 1_700_000_000),
            modifiedAt: Date(timeIntervalSince1970: 1_700_000_100),
            sourceURL: URL(string: "file:///tmp/test.md"),
            embeddingId: "emb-1",
            encryptionKeyId: "key-1",
            transparencyLogId: "tlog-1"
        )

        let encoder = JSONEncoder()
        let decoder = JSONDecoder()
        let data = try encoder.encode(original)
        let restored = try decoder.decode(KnowledgeItem.self, from: data)

        XCTAssertEqual(original, restored)
    }
}
