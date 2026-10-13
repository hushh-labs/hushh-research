import Foundation

/// Private, memory-only presentation. Not an action router or credential store.
struct NativeDrawerIdentity: Codable, Equatable {
    let documentId: String
    let ownerEpoch: String
    let ownerGeneration: Int
    let revision: Int
    let family: String
    var valid: Bool {
        Self.identifier(documentId) && Self.identifier(ownerEpoch) && ownerGeneration > 0 &&
            ownerGeneration <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration &&
            revision > 0 && revision <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration &&
            ["history", "profile", "agent-profile"].contains(family)
    }
    static func identifier(_ value: String) -> Bool { !value.isEmpty && value.utf16.count <= 128 }
}

struct NativeDrawerRow: Codable, Identifiable {
    let id: String
    let label: String
    let detail: String?
    let symbol: String?
    let enabled: Bool
    let destructive: Bool?
    let selected: Bool?
    let pending: Bool?
    var renameActionId: String? = nil
    var deleteActionId: String? = nil
    var iconHex: String? = nil
    var chevron: Bool? = nil
    var trailing: String? = nil
}

struct NativeDrawerSection: Codable, Identifiable {
    let id: String
    let title: String?
    let rows: [NativeDrawerRow]
}

struct NativeDrawerProjection: Codable {
    let documentId: String
    let ownerEpoch: String
    let ownerGeneration: Int
    let revision: Int
    let family: String
    let updateSequence: Int
    let privacyGeneration: Int
    let appearance: String
    let accentHex: String
    let foregroundHex: String
    let title: String
    let sections: [NativeDrawerSection]
    let open: Bool
    let enabled: Bool
    let backEnabled: Bool
    var searchable: Bool? = nil
    var loading: Bool? = nil
    var identity: NativeDrawerIdentity {
        NativeDrawerIdentity(documentId: documentId, ownerEpoch: ownerEpoch, ownerGeneration: ownerGeneration, revision: revision, family: family)
    }
    static func hasClosedShape(_ options: [String: Any]) -> Bool {
        let keys: Set<String> = ["documentId", "ownerEpoch", "ownerGeneration", "revision", "family", "updateSequence", "privacyGeneration",
            "appearance", "accentHex", "foregroundHex", "title", "sections", "open", "enabled", "backEnabled", "searchable", "loading"]
        guard Set(options.keys).isSubset(of: keys), let sections = options["sections"] as? [[String: Any]] else { return false }
        for section in sections {
            guard Set(section.keys).isSubset(of: ["id", "title", "rows"]), let rows = section["rows"] as? [[String: Any]] else { return false }
            for row in rows {
                guard Set(row.keys).isSubset(of: ["id", "label", "detail", "symbol", "iconHex", "chevron", "trailing", "enabled", "destructive", "selected", "pending", "renameActionId", "deleteActionId"]) else { return false }
            }
        }
        return true
    }
    var valid: Bool {
        guard identity.valid, updateSequence > 0,
              updateSequence <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration,
              privacyGeneration >= 0, privacyGeneration <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration,
              HushhNativeControlAppearance(appearance: appearance, accentHex: accentHex, foregroundHex: foregroundHex) != nil,
              Self.text(title, 256), sections.count <= 32 else { return false }
        var ids = Set<String>()
        var count = 0
        for section in sections {
            guard NativeDrawerIdentity.identifier(section.id), ids.insert(section.id).inserted,
                  section.title == nil || Self.text(section.title!, 256) else { return false }
            for row in section.rows {
                count += 1
                guard count <= 500, NativeDrawerIdentity.identifier(row.id), ids.insert(row.id).inserted,
                      Self.text(row.label, 4096), row.detail == nil || Self.text(row.detail!, 4096),
                      row.symbol == nil || NativeDrawerIdentity.identifier(row.symbol!),
                      row.iconHex == nil || row.iconHex!.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil,
                      row.trailing == nil || Self.text(row.trailing!, 32) else { return false }
                for action in [row.renameActionId, row.deleteActionId].compactMap({ $0 }) {
                    guard NativeDrawerIdentity.identifier(action), ids.insert(action).inserted else { return false }
                }
            }
        }
        return true
    }
    private static func text(_ value: String, _ maximum: Int) -> Bool { !value.isEmpty && value.utf16.count <= maximum }
    var cleared: NativeDrawerProjection {
        NativeDrawerProjection(documentId: documentId, ownerEpoch: ownerEpoch, ownerGeneration: ownerGeneration, revision: revision, family: family,
            updateSequence: updateSequence, privacyGeneration: privacyGeneration, appearance: appearance,
            accentHex: accentHex, foregroundHex: foregroundHex, title: "", sections: [], open: false, enabled: false, backEnabled: false)
    }
    func allows(action: String, row: String?, text: String? = nil) -> Bool {
        guard enabled else { return false }
        guard action == "row" || text == nil else { return false }
        if action == "open" { return !open && row == nil }
        guard open else { return false }
        if action == "close" { return row == nil }
        if action == "back" { return backEnabled && row == nil }
        guard action == "row", let row else { return false }
        return sections.contains { $0.rows.contains {
            guard $0.enabled, $0.pending != true else { return false }
            if $0.renameActionId == row {
                return text.map { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.utf16.count <= 160 } == true
            }
            return ($0.id == row || $0.deleteActionId == row) && text == nil
        } }
    }
}

/// Local motion only. No animation-frame messages or CSS pose synchronization.
struct NativeDrawerMotion {
    private(set) var generation = 0
    private(set) var committedOpen = false
    private(set) var progress: CGFloat = 0
    private(set) var retired = false
    @discardableResult mutating func begin(at progress: CGFloat) -> Int {
        guard !retired, progress.isFinite else { return generation }
        generation += 1
        self.progress = min(1, max(0, progress))
        return generation
    }
    mutating func move(to progress: CGFloat) {
        guard !retired, progress.isFinite else { return }
        self.progress = min(1, max(0, progress))
    }
    func destination(velocity: CGFloat, cancelled: Bool) -> Bool {
        if cancelled { return committedOpen }
        if abs(velocity) > 350 { return velocity > 0 }
        return progress >= 0.5
    }
    @discardableResult mutating func commit(open: Bool, generation: Int) -> Bool {
        guard !retired, generation == self.generation else { return false }
        committedOpen = open
        progress = open ? 1 : 0
        return true
    }
    mutating func retire() { generation += 1; retired = true }
}

/// Bounded, volatile choice snapshots, including exact rename text until
/// confirmation. No credentials, persistence, diagnostics or provider bodies.
struct NativeDrawerLease {
    private(set) var identity: NativeDrawerIdentity?
    private(set) var retiredIdentity: NativeDrawerIdentity?
    private(set) var sequence = 0
    private(set) var updateSequence = 0
    private(set) var privacyGeneration = -1
    private var latestRevision = -1
    private var document: String?
    private var retiredDocuments = Set<String>()
    private var consumed = 0
    private var terminalUpdateFloor = 0
    private var terminalOpen = false
    private var terminalEnabled = false
    private var pendingSettlements = Set<Int>()
    private(set) var interactionGeneration = 1
    private var emitted: [Int: (update: Int, interaction: Int, action: String, row: String?, text: String?)] = [:]

    mutating func apply(_ projection: NativeDrawerProjection) -> Bool {
        guard projection.valid, !retiredDocuments.contains(projection.documentId) else { return false }
        if let document, document != projection.documentId {
            retiredDocuments.insert(document)
            latestRevision = -1
        }
        if identity != projection.identity {
            guard projection.revision > latestRevision else { return false }
            latestRevision = projection.revision
            document = projection.documentId
            identity = projection.identity
            sequence = 0; updateSequence = 0; consumed = 0; emitted.removeAll(); pendingSettlements.removeAll()
            terminalUpdateFloor = 0
        }
        guard projection.updateSequence > updateSequence else { return false }
        if terminalUpdateFloor == 0 || terminalOpen != projection.open || terminalEnabled != projection.enabled ||
            privacyGeneration != projection.privacyGeneration {
            terminalUpdateFloor = projection.updateSequence
        }
        terminalOpen = projection.open
        terminalEnabled = projection.enabled
        updateSequence = projection.updateSequence
        privacyGeneration = projection.privacyGeneration
        return true
    }
    mutating func invalidateInteractions() {
        interactionGeneration += 1
        emitted.removeAll()
    }
    mutating func emit(action: String, row: String?, state: NativeDrawerProjection, text: String? = nil) -> Int? {
        guard identity == state.identity, updateSequence == state.updateSequence, state.allows(action: action, row: row, text: text),
              action != "row" || pendingSettlements.count < 128,
              sequence < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration else { return nil }
        sequence += 1
        emitted[sequence] = (updateSequence, interactionGeneration, action, row, text)
        emitted.removeValue(forKey: sequence - 128)
        return sequence
    }
    mutating func confirm(identity: NativeDrawerIdentity, update: Int, privacy: Int, sequence: Int, interaction: Int,
                          action: String, row: String?, allowed: Bool, text: String? = nil) -> Bool {
        let terminal = action == "open" || action == "close"
        let currentUpdate = terminal ? update >= terminalUpdateFloor && update <= updateSequence : update == updateSequence
        guard allowed, identity == self.identity, currentUpdate, privacy == privacyGeneration,
              interaction == interactionGeneration,
              sequence > consumed, let choice = emitted[sequence], choice.update == update,
              choice.interaction == interaction,
              choice.action == action, choice.row == row, choice.text == text else { return false }
        consumed = sequence
        if action == "row" { pendingSettlements.insert(sequence) }
        emitted = emitted.filter { $0.key > sequence }
        return true
    }
    func acceptsSettlement(identity: NativeDrawerIdentity, privacy: Int, sequence: Int) -> Bool {
        self.identity == identity && privacyGeneration == privacy && pendingSettlements.contains(sequence)
    }
    mutating func settle(identity: NativeDrawerIdentity, privacy: Int, sequence: Int, success: Bool) -> Bool {
        guard self.identity == identity, privacyGeneration == privacy else { return false }
        let confirmed = pendingSettlements.contains(sequence)
        let unconfirmedRow = emitted[sequence]?.action == "row"
        guard confirmed || !success && unconfirmedRow else { return false }
        pendingSettlements.remove(sequence)
        emitted.removeValue(forKey: sequence)
        return true
    }
    @discardableResult mutating func retire(_ identity: NativeDrawerIdentity) -> Bool {
        if self.identity == nil {
            if retiredIdentity == identity { return true }
            guard identity.valid, document == nil || document == identity.documentId,
                  !retiredDocuments.contains(identity.documentId), identity.revision > latestRevision else { return false }
            // A cancelled, not-yet-applied lease is tombstoned before a late
            // apply can place private content on screen.
            document = identity.documentId
            latestRevision = identity.revision
            updateSequence = 0
            privacyGeneration = -1
        } else if self.identity != identity { return false }
        self.identity = nil
        retiredIdentity = identity
        emitted.removeAll()
        pendingSettlements.removeAll()
        return true
    }
}

/// One owner boundary for both families. A late projection from the departing
/// owner may not revive either drawer or retain its private content offscreen.
struct NativeDrawerSessionFence {
    private(set) var document: String?
    private(set) var owner: String?
    private(set) var generation = 0
    private var retiredDocuments = Set<String>()
    mutating func admit(_ identity: NativeDrawerIdentity) -> Bool {
        guard identity.valid, !retiredDocuments.contains(identity.documentId) else { return false }
        if let document, document != identity.documentId {
            retiredDocuments.insert(document)
            generation = 0
        }
        guard identity.ownerGeneration >= generation,
              identity.ownerGeneration != generation || identity.ownerEpoch == owner else { return false }
        document = identity.documentId
        owner = identity.ownerEpoch
        generation = identity.ownerGeneration
        return true
    }
    func contains(_ identity: NativeDrawerIdentity) -> Bool {
        identity.documentId == document && identity.ownerEpoch == owner && identity.ownerGeneration == generation
    }
}
