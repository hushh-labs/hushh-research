// SPDX-FileCopyrightText: 2026 Hushh
// SPDX-License-Identifier: Apache-2.0

import Foundation

public struct KnowledgeItem: Codable, Equatable, Sendable {
    public let id: String
    public let source: String
    public let kind: String
    public let title: String
    public let body: String
    public let createdAt: Date
    public let modifiedAt: Date
    public let sourceURL: URL?
    public let embeddingId: String?
    public let encryptionKeyId: String
    public let transparencyLogId: String?

    public init(
        id: String,
        source: String,
        kind: String,
        title: String,
        body: String,
        createdAt: Date,
        modifiedAt: Date,
        sourceURL: URL? = nil,
        embeddingId: String? = nil,
        encryptionKeyId: String,
        transparencyLogId: String? = nil
    ) {
        self.id = id
        self.source = source
        self.kind = kind
        self.title = title
        self.body = body
        self.createdAt = createdAt
        self.modifiedAt = modifiedAt
        self.sourceURL = sourceURL
        self.embeddingId = embeddingId
        self.encryptionKeyId = encryptionKeyId
        self.transparencyLogId = transparencyLogId
    }
}
