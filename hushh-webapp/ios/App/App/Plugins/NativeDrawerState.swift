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

struct NativeDrawerOption: Codable, Identifiable {
    let id: String
    let label: String
    let selected: Bool
    var symbol: String? = nil
    var colorHex: String? = nil
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
    var readOnly: Bool? = nil
    var artworkId: String? = nil
    var renameActionId: String? = nil
    var deleteActionId: String? = nil
    var iconHex: String? = nil
    var chevron: Bool? = nil
    var trailing: String? = nil
    var progress: NativeDrawerProgress? = nil
    var options: [NativeDrawerOption]? = nil
    var toggle: Bool? = nil
    var portrait: Bool? = nil
    var portraitData: String? = nil
}

struct NativeDrawerProgress: Codable {
    let value: Double
    let total: Double
    var valid: Bool { value.isFinite && total.isFinite && total > 0 && value >= 0 && value <= total }
}

struct NativeDrawerSection: Codable, Identifiable {
    let id: String
    let title: String?
    let rows: [NativeDrawerRow]
}

struct NativeMemorySearch: Codable {
    let id: String
    let query: String
}
struct NativeProfilePage: Codable, Identifiable {
    let id: String
    let title: String
    let sections: [NativeDrawerSection]
    var legalDocument: NativeLegalDocument? = nil
    var memorySearch: NativeMemorySearch? = nil
}

struct NativeProfilePreparationDescription: Codable {
    let visitId: String
    let formScene: String?
    var valid: Bool {
        NativeDrawerIdentity.identifier(visitId) && (formScene == nil || NativeProfilePreparationTarget.scenes.contains(formScene!))
    }
    enum CodingKeys: String, CodingKey { case visitId, formScene }
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(visitId, forKey: .visitId)
        try container.encode(formScene, forKey: .formScene)
    }
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
    var navigationLocked: Bool? = nil
    var searchable: Bool? = nil
    var loading: Bool? = nil
    /// Profile menu visibility is distinct from its enclosing drawer lifetime.
    var surfaceOpen: Bool? = nil
    var profileStack: [NativeProfilePage]? = nil
    var profileDestinationId: String? = nil
    var profileSupportDestinationId: String? = nil
    var profilePreparation: NativeProfilePreparationDescription? = nil
    var activeSections: [NativeDrawerSection] { profileStack?.last?.sections ?? sections }
    var identity: NativeDrawerIdentity {
        NativeDrawerIdentity(documentId: documentId, ownerEpoch: ownerEpoch, ownerGeneration: ownerGeneration, revision: revision, family: family)
    }
    static func hasClosedShape(_ options: [String: Any]) -> Bool {
        let keys: Set<String> = ["documentId", "ownerEpoch", "ownerGeneration", "revision", "family", "updateSequence", "privacyGeneration",
            "appearance", "accentHex", "foregroundHex", "title", "sections", "open", "enabled", "backEnabled", "navigationLocked", "searchable", "loading", "surfaceOpen", "profileStack", "profileDestinationId", "profileSupportDestinationId"]
        guard Set(options.keys).isSubset(of: keys.union(["profilePreparation"])), let sections = options["sections"] as? [[String: Any]] else { return false }
        if let preparation = options["profilePreparation"] {
            guard let preparation = preparation as? [String: Any], Set(preparation.keys) == ["visitId", "formScene"] else { return false }
        }
        var allSections = sections
        if let stack = options["profileStack"] {
            guard let pages = stack as? [[String: Any]] else { return false }
            for page in pages {
                guard Set(page.keys).isSubset(of: ["id", "title", "sections", "legalDocument", "memorySearch"]), let sections = page["sections"] as? [[String: Any]] else { return false }
                if let search = page["memorySearch"] {
                    guard let search = search as? [String: Any], Set(search.keys) == ["id", "query"] else { return false }
                }
                if let document = page["legalDocument"] {
                    guard let document = document as? [String: Any], NativeLegalDocument.hasClosedShape(document) else { return false }
                }
                allSections += sections
            }
        }
        for section in allSections {
            guard Set(section.keys).isSubset(of: ["id", "title", "rows"]), let rows = section["rows"] as? [[String: Any]] else { return false }
            for row in rows {
                guard Set(row.keys).isSubset(of: ["id", "label", "detail", "symbol", "iconHex", "chevron", "trailing", "progress", "options", "toggle", "enabled", "destructive", "selected", "pending", "renameActionId", "deleteActionId", "readOnly", "artworkId", "portrait", "portraitData"]) else { return false }
                if let progress = row["progress"] {
                    guard let progress = progress as? [String: Any], Set(progress.keys) == ["value", "total"] else { return false }
                }
                if let options = row["options"] {
                    guard let choices = options as? [[String: Any]], choices.allSatisfy({ Set($0.keys).isSubset(of: ["id", "label", "selected", "symbol", "colorHex"]) }) else { return false }
                }
            }
        }
        return true
    }
    var valid: Bool {
        guard identity.valid, updateSequence > 0,
              updateSequence <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration,
              privacyGeneration >= 0, privacyGeneration <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration,
              HushhNativeControlAppearance(appearance: appearance, accentHex: accentHex, foregroundHex: foregroundHex) != nil,
              Self.text(title, 256), sections.count <= 32,
              navigationLocked == nil || family == "profile",
              surfaceOpen == nil || family == "profile" && (!open || surfaceOpen == true) else { return false }
        if let preparation = profilePreparation {
            guard family == "profile", open, preparation.valid,
                  preparation.formScene == nil || profileDestinationId != nil || profileSupportDestinationId != nil else { return false }
        }
        if let stack = profileStack {
            guard family == "profile", stack.count <= (stack.first?.id == "payouts" ? 8 : ["memory", "connectors"].contains(stack.first?.id ?? "") ? 5 : stack.first?.id == "world-model" ? 4 : 3), Set(stack.map(\.id)).count == stack.count,
                  stack.first?.id != "payouts" || Self.validPayoutPath(stack.map(\.id)),
                  stack.first?.id != "memory" || Self.validMemoryPath(stack.map(\.id)),
                  stack.first?.id != "world-model" || Self.validWorldModelPath(stack.map(\.id)),
                  stack.first?.id != "connectors" || Self.validConnectorPath(stack.map(\.id)),
                  !stack.contains(where: { ["finance-preferences", "finance-anchor"].contains($0.id) }) || Self.validFinancePath(stack.map(\.id)),
                  stack.isEmpty || backEnabled && profileDestinationId.map(NativeDrawerIdentity.identifier) == true,
                  stack.enumerated().allSatisfy({ index, page in
                      (index == 0 ? ["referrals", "connectors", "world-model", "memory", "payouts", "request-pricing", "account", "preferences", "gemini", "finance-preferences", "voice", "security", "devices", "vault", "legal", "privacy", "terms"].contains(page.id) :
                        Self.validFinancePath(stack.map(\.id)) ||
                        stack.first?.id == "memory" && Self.validMemoryPath(stack.map(\.id)) ||
                        stack.first?.id == "world-model" && Self.validWorldModelPath(stack.map(\.id)) ||
                        stack.first?.id == "connectors" && Self.validConnectorPath(stack.map(\.id)) ||
                        stack.first?.id == "payouts" && Self.validPayoutPath(stack.map(\.id)) ||
                        ["account-reset", "account-delete"].contains(page.id) && index == 1 && stack.first?.id == "account" ||
                        ["voice", "gemini"].contains(page.id) && index == 1 && stack.first?.id == "preferences" ||
                        ["session", "devices"].contains(page.id) && index == 1 && stack.first?.id == "security" ||
                        page.id == "device-unlink" && (index == 1 && stack.first?.id == "devices" || index == 2 && stack.first?.id == "security" && stack[1].id == "devices") ||
                        page.id == "vault" && index == 1 && stack.first?.id == "security" ||
                        ["vault-method", "vault-remove"].contains(page.id) && (index == 1 && stack.first?.id == "vault" || index == 2 && stack.first?.id == "security" && stack[1].id == "vault") ||
                        ["privacy", "terms"].contains(page.id) && index == 1 && stack.first?.id == "legal") &&
                          Self.text(page.title, 256) && page.sections.count <= 32 &&
                          (page.memorySearch == nil || ["memory", "connectors"].contains(page.id) && NativeDrawerIdentity.identifier(page.memorySearch!.id) && page.memorySearch!.query.utf16.count <= 256) &&
                          (["privacy", "terms"].contains(page.id) ? page.legalDocument?.valid == true &&
                            page.legalDocument?.type == page.id && page.sections.isEmpty : page.legalDocument == nil)
                  }) else { return false }
        }
        if let id = profileDestinationId { guard profileStack?.isEmpty == false, NativeDrawerIdentity.identifier(id) else { return false } }
        if let id = profileSupportDestinationId {
            guard family == "profile", open, surfaceOpen == true, profileStack?.isEmpty == true,
                  profileDestinationId == nil, NativeDrawerIdentity.identifier(id) else { return false }
        }
        var ids = Set<String>()
        var count = 0
        for section in sections + (profileStack?.flatMap(\.sections) ?? []) {
            guard NativeDrawerIdentity.identifier(section.id), ids.insert(section.id).inserted,
                  section.title == nil || Self.text(section.title!, 256) else { return false }
            for row in section.rows {
                count += 1
                guard count <= 500, NativeDrawerIdentity.identifier(row.id), ids.insert(row.id).inserted,
                      Self.text(row.label, 4096), row.detail == nil || Self.text(row.detail!, 4096),
                      row.symbol == nil || NativeDrawerIdentity.identifier(row.symbol!),
                      row.artworkId == nil || NativeDrawerIdentity.identifier(row.artworkId!),
                      row.iconHex == nil || row.iconHex!.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil,
                      row.trailing == nil || Self.text(row.trailing!, 32),
                      row.progress?.valid != false,
                      row.toggle != true || row.options?.count == 2 else { return false }
                if let portrait = row.portrait {
                    guard portrait, family == "profile",
                          section.id == "identity-section" && row.id == "identity" || section.id == "account-portrait" && row.id == "account-photo",
                          row.readOnly != true, row.options == nil, row.toggle != true,
                          row.renameActionId == nil, row.deleteActionId == nil else { return false }
                }
                if let image = row.portraitData {
                    guard row.portrait == true, image.utf16.count <= 100_000,
                          image.range(of: "^data:image/jpeg;base64,[A-Za-z0-9+/]+=*$", options: .regularExpression) != nil else { return false }
                }
                for action in [row.renameActionId, row.deleteActionId].compactMap({ $0 }) {
                    guard NativeDrawerIdentity.identifier(action), ids.insert(action).inserted else { return false }
                }
                if let options = row.options {
                    guard family == "profile", (2...8).contains(options.count), options.filter(\.selected).count == 1,
                          row.readOnly != true, row.renameActionId == nil, row.deleteActionId == nil else { return false }
                    for option in options {
                        guard NativeDrawerIdentity.identifier(option.id), ids.insert(option.id).inserted, Self.text(option.label, 64),
                              option.symbol == nil || NativeDrawerIdentity.identifier(option.symbol!),
                              option.colorHex == nil || option.colorHex!.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil else { return false }
                    }
                }
            }
        }
        for page in profileStack ?? [] {
            if let search = page.memorySearch { guard ids.insert(search.id).inserted else { return false } }
            for action in page.legalDocument?.actionIds ?? [] {
                guard ids.insert(action).inserted else { return false }
            }
        }
        return true
    }
    static func validPayoutPath(_ path: [String]) -> Bool {
        guard path.first == "payouts", path.count <= 8 else { return false }
        let start = path.count > 1 && ["payout-activity", "payout-stripe"].contains(path[1]) ? 2 : 1
        guard path.count - start <= 6 else { return false }
        return path.dropFirst(start).enumerated().allSatisfy { $0.element == "payout-receipt-\($0.offset + 1)" }
    }
    static func validMemoryPath(_ path: [String]) -> Bool {
        guard path.first == "memory", path.count <= 5 else { return false }
        let children: [String: Set<String>] = [
            "memory": ["memory-domain", "memory-sharing", "memory-live", "memory-shared", "memory-received", "memory-secrets"],
            "memory-secrets": ["memory-secret", "memory-identity"], "memory-secret": ["memory-secret-remove", "memory-identity"],
            "memory-shared": ["memory-shared-person"], "memory-received": ["memory-received-files"],
            "memory-domain": ["memory-section"], "memory-section": ["memory-entity"],
            "memory-entity": ["memory-confirm"], "memory-sharing": ["memory-connection"],
            "memory-connection": ["memory-confirm"], "memory-live": ["memory-record"]
        ]
        return path.dropFirst().enumerated().allSatisfy { children[path[$0.offset]]?.contains($0.element) == true }
    }
    static func validFinancePath(_ path: [String]) -> Bool {
        let start = path.first == "preferences" ? 1 : 0
        guard path.count > start, path[start] == "finance-preferences", path.count <= start + 2 else { return false }
        return path.count == start + 1 || path[start + 1] == "finance-anchor"
    }
    static func validConnectorPath(_ path: [String]) -> Bool {
        guard path.first == "connectors", path.count <= 5 else { return false }
        let children: [String: Set<String>] = ["connectors": ["connector-detail", "connector-confirm", "connector-custom", "connector-custom-detail", "connector-custom-confirm"],
            "connector-detail": ["connector-confirm", "connector-preparation", "connector-files", "connector-selection", "connector-packets", "connector-trust"],
            "connector-files": ["connector-confirm", "connector-selection"], "connector-packets": ["connector-packet"], "connector-trust": ["connector-trust-rule"], "connector-trust-rule": ["connector-trust-confirm"],
            "connector-custom-detail": ["connector-custom-confirm"]]
        return path.dropFirst().enumerated().allSatisfy { children[path[$0.offset]]?.contains($0.element) == true }
    }
    static func validWorldModelPath(_ path: [String]) -> Bool {
        guard path.first == "world-model", path.count <= 4 else { return false }
        let children: [String: Set<String>] = [
            "world-model": ["world-model-fact", "world-model-research", "world-model-sources", "world-model-invitations"],
            "world-model-fact": ["world-model-remove"], "world-model-sources": ["world-model-review"],
            "world-model-review": ["world-model-review-fact"]
        ]
        return path.dropFirst().enumerated().allSatisfy { children[path[$0.offset]]?.contains($0.element) == true }
    }
    static func text(_ value: String, _ maximum: Int) -> Bool { !value.isEmpty && value.utf16.count <= maximum }
    var cleared: NativeDrawerProjection {
        NativeDrawerProjection(documentId: documentId, ownerEpoch: ownerEpoch, ownerGeneration: ownerGeneration, revision: revision, family: family,
            updateSequence: updateSequence, privacyGeneration: privacyGeneration, appearance: appearance,
            accentHex: accentHex, foregroundHex: foregroundHex, title: "", sections: [], open: false, enabled: false, backEnabled: false)
    }
    func allows(action: String, row: String?, text: String? = nil) -> Bool {
        guard enabled else { return false }
        if navigationLocked == true && ["back", "root", "ancestor", "close"].contains(action) { return false }
        guard action == "row" || text == nil else { return false }
        if action == "open" { return !open && row == nil }
        guard open else { return false }
        if action == "close" { return row == nil }
        if action == "back" { return backEnabled && row == nil }
        if action == "root" { return family == "profile" && backEnabled && (profileStack?.count ?? 0) > 1 && row == nil }
        if action == "ancestor" {
            let path = profileStack?.map(\.id) ?? []
            return family == "profile" && backEnabled &&
                (row == "security" && [["security", "devices", "device-unlink"], ["security", "vault", "vault-method"], ["security", "vault", "vault-remove"]].contains(path) ||
                  (Self.validPayoutPath(path) || Self.validMemoryPath(path) || Self.validFinancePath(path) || Self.validWorldModelPath(path) || Self.validConnectorPath(path)) && path.dropLast(2).contains(where: { $0 == row }))
        }
        guard action == "row", let row else { return false }
        if profileStack?.last?.memorySearch?.id == row { return text.map { $0.utf16.count <= 256 } == true }
        if text == nil, profileStack?.last?.legalDocument?.actionIds.contains(row) == true { return true }
        return activeSections.contains { $0.rows.contains {
            guard $0.enabled, $0.readOnly != true, $0.pending != true else { return false }
            if $0.renameActionId == row {
                return text.map { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.utf16.count <= 160 } == true
            }
            if let options = $0.options { return text == nil && options.contains { $0.id == row && !$0.selected } }
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
    private struct BackBoundary: Equatable {
        let privacy: Int
        let open, enabled, backEnabled, locked: Bool
        let surfaceOpen: Bool?
        let destination, supportDestination: String?
        let path: [String]?
        init(_ state: NativeDrawerProjection) {
            privacy = state.privacyGeneration
            open = state.open; enabled = state.enabled; backEnabled = state.backEnabled
            locked = state.navigationLocked == true; surfaceOpen = state.surfaceOpen
            destination = state.profileDestinationId; supportDestination = state.profileSupportDestinationId
            path = state.profileStack?.map(\.id)
        }
    }
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
    private var backUpdateFloor = 0
    private var backBoundary: BackBoundary?
    private var terminalOpen = false
    private var terminalEnabled = false
    private var settlesBack = false
    private var pendingSettlements: [Int: String] = [:]
    // Invalidating a gesture revokes choice authority immediately, but React
    // must still acknowledge that exact cancellation. These bounded receipts
    // cannot confirm a choice, authorize an effect, or report success.
    private var cancelledChoices: [Int: (privacy: Int, action: String)] = [:]
    private var confirmedRowEffects: [Int: (row: String?, update: Int, interaction: Int)] = [:]
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
            sequence = 0; updateSequence = 0; consumed = 0; emitted.removeAll(); pendingSettlements.removeAll(); confirmedRowEffects.removeAll(); cancelledChoices.removeAll()
            terminalUpdateFloor = 0
            backUpdateFloor = 0; backBoundary = nil
        }
        guard projection.updateSequence > updateSequence else { return false }
        if privacyGeneration != projection.privacyGeneration {
            cancelledChoices.removeAll()
            emitted.removeAll()
        }
        if terminalUpdateFloor == 0 || terminalOpen != projection.open || terminalEnabled != projection.enabled ||
            privacyGeneration != projection.privacyGeneration {
            terminalUpdateFloor = projection.updateSequence
        }
        terminalOpen = projection.open
        terminalEnabled = projection.enabled
        let nextBackBoundary = BackBoundary(projection)
        if nextBackBoundary != backBoundary {
            backUpdateFloor = projection.updateSequence
            backBoundary = nextBackBoundary
        }
        settlesBack = projection.profileStack != nil
        updateSequence = projection.updateSequence
        privacyGeneration = projection.privacyGeneration
        return true
    }
    mutating func invalidateInteractions() {
        interactionGeneration += 1
        for (sequence, choice) in emitted where ["row", "close", "back", "root", "ancestor"].contains(choice.action) {
            cancelledChoices[sequence] = (privacyGeneration, choice.action)
        }
        let oldestAllowed = sequence - 128
        cancelledChoices = cancelledChoices.filter { $0.key > oldestAllowed }
        emitted.removeAll()
        confirmedRowEffects.removeAll()
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
        let back = settlesBack && ["back", "root", "ancestor"].contains(action)
        let currentUpdate = terminal ? update >= terminalUpdateFloor && update <= updateSequence :
            back ? update >= backUpdateFloor && update <= updateSequence : update == updateSequence
        guard allowed, identity == self.identity, currentUpdate, privacy == privacyGeneration,
              interaction == interactionGeneration,
              sequence > consumed, let choice = emitted[sequence], choice.update == update,
              choice.interaction == interaction,
              choice.action == action, choice.row == row, choice.text == text else { return false }
        consumed = sequence
        // Older clients do not acknowledge Close. A subsequent Close replaces
        // only that terminal bookkeeping, never pending row/Back operations.
        if action == "close" { pendingSettlements = pendingSettlements.filter { $0.value != "close" } }
        if action == "row" || action == "close" || (action == "back" || action == "root" || action == "ancestor") && settlesBack {
            pendingSettlements[sequence] = action
        }
        if action == "row", row == "referral-copy" { confirmedRowEffects[sequence] = (row, update, interaction) }
        emitted = emitted.filter { $0.key > sequence }
        return true
    }
    mutating func consumeConfirmedRowEffect(identity: NativeDrawerIdentity, update: Int, privacy: Int,
                                           sequence: Int, interaction: Int, row: String) -> Bool {
        guard self.identity == identity, updateSequence == update, privacyGeneration == privacy,
              interactionGeneration == interaction, pendingSettlements[sequence] == "row",
              let effect = confirmedRowEffects[sequence], effect.row == row,
              effect.update == update, effect.interaction == interaction else { return false }
        confirmedRowEffects.removeValue(forKey: sequence)
        return true
    }
    func acceptsSettlement(identity: NativeDrawerIdentity, privacy: Int, sequence: Int) -> Bool {
        self.identity == identity && privacyGeneration == privacy && pendingSettlements[sequence] != nil
    }
    func isCloseSettlement(sequence: Int) -> Bool {
        pendingSettlements[sequence] == "close" || emitted[sequence]?.action == "close" || cancelledChoices[sequence]?.action == "close"
    }
    mutating func settle(identity: NativeDrawerIdentity, privacy: Int, sequence: Int, success: Bool) -> Bool {
        guard self.identity == identity, privacyGeneration == privacy else { return false }
        if !success, cancelledChoices[sequence]?.privacy == privacy {
            cancelledChoices.removeValue(forKey: sequence)
            return true
        }
        let confirmed = pendingSettlements[sequence] != nil
        let unconfirmed = emitted[sequence]?.action == "row" || emitted[sequence]?.action == "close" || emitted[sequence]?.action == "back" || emitted[sequence]?.action == "root" || emitted[sequence]?.action == "ancestor"
        guard confirmed || !success && unconfirmed else { return false }
        pendingSettlements.removeValue(forKey: sequence)
        confirmedRowEffects.removeValue(forKey: sequence)
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
        confirmedRowEffects.removeAll()
        cancelledChoices.removeAll()
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
        guard identity.valid else { return false }
        return admitOwner(documentId: identity.documentId, ownerEpoch: identity.ownerEpoch, ownerGeneration: identity.ownerGeneration)
    }
    mutating func admitOwner(documentId: String, ownerEpoch: String, ownerGeneration: Int) -> Bool {
        guard NativeDrawerIdentity.identifier(documentId), NativeDrawerIdentity.identifier(ownerEpoch), ownerGeneration > 0,
              ownerGeneration <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration, !retiredDocuments.contains(documentId) else { return false }
        if let document, document != documentId {
            retiredDocuments.insert(document)
            generation = 0
        }
        guard ownerGeneration >= generation, ownerGeneration != generation || ownerEpoch == owner else { return false }
        document = documentId; owner = ownerEpoch; generation = ownerGeneration
        return true
    }
    func contains(_ identity: NativeDrawerIdentity) -> Bool {
        containsOwner(documentId: identity.documentId, ownerEpoch: identity.ownerEpoch, ownerGeneration: identity.ownerGeneration)
    }
    func containsOwner(documentId: String, ownerEpoch: String, ownerGeneration: Int) -> Bool {
        documentId == document && ownerEpoch == owner && ownerGeneration == generation
    }
}
