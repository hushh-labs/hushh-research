import SwiftUI
import UIKit

struct NativeWorkspaceOwner: Hashable { let documentId: String; let ownerEpoch: String; let generation: Int }
struct NativeWorkspaceRetirementFence {
    private var revisions = [NativeWorkspaceOwner: Int]()
    mutating func retire(_ identity: NativeWorkspaceIdentity) {
        guard identity.valid else { return }
        revisions[identity.ownerKey] = max(revisions[identity.ownerKey] ?? 0, identity.revision)
    }
    func retired(_ identity: NativeWorkspaceIdentity) -> Bool { identity.valid && identity.revision <= (revisions[identity.ownerKey] ?? 0) }
}

/// Private route-body replica. A route visit is independent of a Profile
/// drawer visit and cannot borrow its modal admission or operation authority.
struct NativeWorkspaceIdentity: Codable, Equatable, Hashable {
    let documentId: String; let ownerEpoch: String; let ownerGeneration: Int; let revision: Int; let workspace: String
    var valid: Bool {
        NativeDrawerIdentity.identifier(documentId) && NativeDrawerIdentity.identifier(ownerEpoch) && ["referrals", "wallet", "memory", "consent", "tasks", "feed", "connect", "email", "launcher", "mail", "calendar", "finance", "career", "location", "setup"].contains(workspace) &&
        ownerGeneration > 0 && revision > 0 && [ownerGeneration, revision].allSatisfy { $0 <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration }
    }
    var event: [String: Any] { ["documentId": documentId, "ownerEpoch": ownerEpoch, "ownerGeneration": ownerGeneration, "revision": revision, "workspace": workspace] }
    var ownerKey: NativeWorkspaceOwner { .init(documentId: documentId, ownerEpoch: ownerEpoch, generation: ownerGeneration) }
}
struct NativeWorkspaceFrame: Codable, Equatable {
    let x: Double; let y: Double; let width: Double; let height: Double
    let viewportWidth: Double; let viewportHeight: Double; let layoutRevision: Int
    var contentInset: Double? = nil
    var bottomContentInset: Double? = nil
    var gutter: CGFloat { CGFloat(contentInset ?? 16) }
    var bottomClearance: CGFloat { CGFloat(bottomContentInset ?? 0) }
    var rect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
    var valid: Bool {
        [x,y,width,height,viewportWidth,viewportHeight].allSatisfy(\.isFinite) && x >= 0 && y >= 0 && width > 0 && height > 0 &&
        viewportWidth > 0 && viewportHeight > 0 && viewportWidth <= 10000 && viewportHeight <= 10000 &&
        x + width <= viewportWidth + 1 && y + height <= viewportHeight + 1 && layoutRevision > 0 && layoutRevision <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration &&
        (contentInset == nil || (contentInset!.isFinite && contentInset! >= 0 && contentInset! <= 64 && contentInset! * 2 < width)) &&
        (bottomContentInset == nil || (bottomContentInset!.isFinite && bottomContentInset! >= 0 && bottomContentInset! < height))
    }
}
struct NativeWorkspaceNavigation: Codable { let id: String; let depth: Int; var valid: Bool { NativeDrawerIdentity.identifier(id) && (0...8).contains(depth) } }
struct NativeWorkspaceTabs: Codable { let label: String; let options: [NativeDrawerOption] }
struct NativeWorkspaceSearch: Codable { let id: String; let query: String; let label: String; var live: Bool? = nil; var afterSection: Int? = nil }
struct NativeWorkspaceMemoryDraft: Codable, NativeProfileEditorDraft {
    var text: String; var identifierApproved: Bool
    static let empty = Self(text: "", identifierApproved: false)
    var valid: Bool { text.utf16.count <= 50_000 }
    var event: [String: Any] { ["text": text, "identifierApproved": identifierApproved] }
    subscript(_ field: String) -> String {
        get { field == "text" ? text : "" }
        set {
            guard field == "text", newValue != text else { return }
            text = newValue; identifierApproved = false
        }
    }
}
struct NativeWorkspaceMemoryEditor: Codable {
    let destinationId: String; var draft: NativeWorkspaceMemoryDraft; let draftRevision: Int; let acknowledgedEditRevision: Int
    let busy: Bool; let canSave: Bool; let canToggleIdentifier: Bool; let reviewing: Bool; var error: String?
    var valid: Bool {
        NativeDrawerIdentity.identifier(destinationId) && draft.valid &&
        [draftRevision, acknowledgedEditRevision].allSatisfy { $0 >= 0 && $0 <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration } &&
        (error?.utf16.count ?? 0) <= 1024
    }
    static func closed(_ value: [String: Any]) -> Bool {
        Set(value.keys) == ["destinationId", "draft", "draftRevision", "acknowledgedEditRevision", "busy", "canSave", "canToggleIdentifier", "reviewing", "error"] &&
            (value["draft"] as? [String: Any]).map { Set($0.keys) == ["text", "identifierApproved"] } == true
    }
}
struct NativeWorkspaceMemoryProjection: NativeProfileEditorProjection {
    let identity: NativeWorkspaceIdentity; let destinationId: String; let updateSequence: Int; let privacyGeneration: Int
    let acknowledgedEditRevision: Int; let draftRevision: Int; var draft: NativeWorkspaceMemoryDraft
    let busy: Bool; let canSave: Bool; let canToggleIdentifier: Bool; let reviewing: Bool; var error: String?; let accentHex: String
    var scene: String { "memory-capture" }; var checking: Bool { false }; var primary: String { "save" }
    var valid: Bool { identity.valid && identity.workspace == "memory" && draft.valid }
    init(_ state: NativeWorkspaceProjection, _ editor: NativeWorkspaceMemoryEditor) {
        identity = state.identity; destinationId = editor.destinationId; updateSequence = state.updateSequence; privacyGeneration = state.privacyGeneration
        acknowledgedEditRevision = editor.acknowledgedEditRevision; draftRevision = editor.draftRevision; draft = editor.draft
        busy = editor.busy; canSave = editor.canSave; canToggleIdentifier = editor.canToggleIdentifier; reviewing = editor.reviewing; error = editor.error; accentHex = state.accentHex
    }
}
struct NativeWorkspaceTextDraft: Codable, NativeProfileEditorDraft {
    var text: String
    static let empty = Self(text: "")
    var valid: Bool { text.utf16.count <= 4096 }
    var event: [String: Any] { ["text": text] }
    subscript(_ field: String) -> String { get { field == "text" ? text : "" } set { if field == "text" { text = newValue } } }
}
struct NativeWorkspaceTextEditor: Codable {
    let destinationId: String; var draft: NativeWorkspaceTextDraft; let draftRevision: Int; let acknowledgedEditRevision: Int
    let busy: Bool; let canSave: Bool; var error: String?
    let label: String; let placeholder: String; let maximum: Int; let submitLabel: String; let cancelLabel: String; var format: String?
    static func closed(_ value: [String: Any]) -> Bool {
        Set(value.keys).subtracting(["format"]) == ["destinationId", "draft", "draftRevision", "acknowledgedEditRevision", "busy", "canSave", "error", "label", "placeholder", "maximum", "submitLabel", "cancelLabel"] &&
            (value["format"] == nil || value["format"] as? String == "circle-code") &&
            (value["draft"] as? [String: Any]).map { Set($0.keys) == ["text"] } == true
    }
    var valid: Bool {
        NativeDrawerIdentity.identifier(destinationId) && draft.valid && (1...4096).contains(maximum) && (format == nil || format == "circle-code") &&
            [draftRevision, acknowledgedEditRevision].allSatisfy { $0 >= 0 && $0 <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration } &&
            NativeDrawerProjection.text(label, 256) && placeholder.utf16.count <= 256 && NativeDrawerProjection.text(submitLabel, 64) && NativeDrawerProjection.text(cancelLabel, 64) && (error?.utf16.count ?? 0) <= 1024
    }
}
struct NativeWorkspaceTextProjection: NativeProfileEditorProjection {
    let identity: NativeWorkspaceIdentity; let destinationId: String; let updateSequence: Int; let privacyGeneration: Int
    let acknowledgedEditRevision: Int; let draftRevision: Int; var draft: NativeWorkspaceTextDraft
    let busy: Bool; let canSave: Bool; var error: String?; let accentHex: String
    let label: String; let placeholder: String; let maximum: Int; let submitLabel: String; let cancelLabel: String; var format: String?
    var scene: String { "location-text" }; var checking: Bool { false }; var primary: String { "save" }
    var valid: Bool { identity.valid && identity.workspace == "location" && draft.valid }
    init(_ state: NativeWorkspaceProjection, _ editor: NativeWorkspaceTextEditor) {
        identity = state.identity; destinationId = editor.destinationId; updateSequence = state.updateSequence; privacyGeneration = state.privacyGeneration
        acknowledgedEditRevision = editor.acknowledgedEditRevision; draftRevision = editor.draftRevision; draft = editor.draft
        busy = editor.busy; canSave = editor.canSave; error = editor.error; accentHex = state.accentHex
        label = editor.label; placeholder = editor.placeholder; maximum = editor.maximum; submitLabel = editor.submitLabel; cancelLabel = editor.cancelLabel; format = editor.format
    }
}
struct NativeWorkspaceTaskDraft: Codable, NativeProfileEditorDraft {
    var title: String; var date: String; var time: String; var notes: String
    static let empty = Self(title: "", date: "", time: "", notes: "")
    var valid: Bool {
        title.utf16.count <= 240 && notes.utf16.count <= 1200 &&
        date.range(of: "^(?:|[0-9]{4}-[0-9]{2}-[0-9]{2})$", options: .regularExpression) != nil &&
        time.range(of: "^(?:|(?:[01][0-9]|2[0-3]):[0-5][0-9])$", options: .regularExpression) != nil
    }
    var event: [String: Any] { ["title": title, "date": date, "time": time, "notes": notes] }
    subscript(_ field: String) -> String {
        get { switch field { case "title": title; case "date": date; case "time": time; case "notes": notes; default: "" } }
        set { switch field { case "title": title = newValue; case "date": date = newValue; case "time": time = newValue; case "notes": notes = newValue; default: break } }
    }
}
struct NativeWorkspaceTaskEditor: Codable {
    let destinationId: String; var draft: NativeWorkspaceTaskDraft; let draftRevision: Int; let acknowledgedEditRevision: Int
    let busy: Bool; let canSave: Bool; var error: String?
    var valid: Bool {
        NativeDrawerIdentity.identifier(destinationId) && draft.valid &&
        [draftRevision, acknowledgedEditRevision].allSatisfy { $0 >= 0 && $0 <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration } && (error?.utf16.count ?? 0) <= 1024
    }
    static func closed(_ value: [String: Any]) -> Bool {
        Set(value.keys) == ["destinationId", "draft", "draftRevision", "acknowledgedEditRevision", "busy", "canSave", "error"] &&
        (value["draft"] as? [String: Any]).map { Set($0.keys) == ["title", "date", "time", "notes"] } == true
    }
}
struct NativeWorkspaceTaskProjection: NativeProfileEditorProjection {
    let identity: NativeWorkspaceIdentity; let destinationId: String; let updateSequence: Int; let privacyGeneration: Int
    let acknowledgedEditRevision: Int; let draftRevision: Int; var draft: NativeWorkspaceTaskDraft
    let busy: Bool; let canSave: Bool; var error: String?; let accentHex: String
    var scene: String { "task-add" }; var checking: Bool { false }; var primary: String { "save" }
    var valid: Bool { identity.valid && identity.workspace == "tasks" && draft.valid }
    init(_ state: NativeWorkspaceProjection, _ editor: NativeWorkspaceTaskEditor) {
        identity = state.identity; destinationId = editor.destinationId; updateSequence = state.updateSequence; privacyGeneration = state.privacyGeneration
        acknowledgedEditRevision = editor.acknowledgedEditRevision; draftRevision = editor.draftRevision; draft = editor.draft
        busy = editor.busy; canSave = editor.canSave; error = editor.error; accentHex = state.accentHex
    }
}
struct NativeWorkspaceCircleDraft: Codable, NativeProfileEditorDraft {
    var name: String; var kind: String; var customTypeLabel: String? = nil
    static let empty = Self(name: "", kind: "family")
    var valid: Bool { name.utf16.count <= 80 && ["family", "friends", "other"].contains(kind) && (customTypeLabel?.utf16.count ?? 0) <= 32 }
    var event: [String: Any] { var value: [String: Any] = ["name": name, "kind": kind]; if let customTypeLabel { value["customTypeLabel"] = customTypeLabel }; return value }
    subscript(_ field: String) -> String {
        get { field == "name" ? name : field == "kind" ? kind : field == "customTypeLabel" ? customTypeLabel ?? "" : "" }
        set { if field == "name" { name = newValue }; if field == "kind" { kind = newValue }; if field == "customTypeLabel" { customTypeLabel = newValue } }
    }
}
struct NativeWorkspaceCircleEditor: Codable {
    let destinationId: String; var draft: NativeWorkspaceCircleDraft; let draftRevision: Int; let acknowledgedEditRevision: Int
    let busy: Bool; let canSave: Bool; var error: String?; var customTypes: [String]? = nil
    var valid: Bool {
        NativeDrawerIdentity.identifier(destinationId) && draft.valid && [draftRevision, acknowledgedEditRevision].allSatisfy { $0 >= 0 && $0 <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration } &&
        (error?.utf16.count ?? 0) <= 1024 && (customTypes == nil || (customTypes!.count <= 3 && customTypes!.allSatisfy { !$0.isEmpty && $0.utf16.count <= 32 }))
    }
}
struct NativeWorkspaceCircleProjection: NativeProfileEditorProjection {
    let identity: NativeWorkspaceIdentity; let destinationId: String; let updateSequence: Int; let privacyGeneration: Int
    let acknowledgedEditRevision: Int; let draftRevision: Int; var draft: NativeWorkspaceCircleDraft; let busy: Bool; let canSave: Bool; var error: String?
    let accentHex: String; let customTypes: [String]?
    var scene: String { "referral-circle" }; var checking: Bool { false }; var primary: String { "save" }
    var valid: Bool { identity.valid && draft.valid }
    init(_ state: NativeWorkspaceProjection, _ editor: NativeWorkspaceCircleEditor) {
        identity = state.identity; destinationId = editor.destinationId; updateSequence = state.updateSequence; privacyGeneration = state.privacyGeneration
        acknowledgedEditRevision = editor.acknowledgedEditRevision; draftRevision = editor.draftRevision; draft = editor.draft; busy = editor.busy; canSave = editor.canSave; error = editor.error; accentHex = state.accentHex; customTypes = editor.customTypes
    }
}
struct NativeWorkspaceCalendarDate: Codable {
    let id: String; let label: String; let value: String; let timeZone: String; let enabled: Bool
    var formatter: DateFormatter {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = TimeZone(identifier: timeZone); f.dateFormat = "yyyy-MM-dd"; f.isLenient = false; return f
    }
    var date: Date? { formatter.date(from: value) }
    var valid: Bool {
        NativeDrawerIdentity.identifier(id) && NativeDrawerProjection.text(label, 64) && NativeDrawerProjection.text(timeZone, 128) &&
        TimeZone(identifier: timeZone) != nil && value.utf16.count == 10 && date.map { formatter.string(from: $0) == value } == true
    }
    func accepts(_ value: String) -> Bool { formatter.date(from: value).map { formatter.string(from: $0) == value } == true }
}
struct NativeWorkspaceAgent: Codable {
    let id: String; let label: String; let description: String; let metricValue: String; let metricLabel: String; let artworkId: String; let iconHex: String
    var valid: Bool {
        NativeDrawerIdentity.identifier(id) && NativeDrawerProjection.text(label, 64) && NativeDrawerProjection.text(description, 1024) &&
        NativeDrawerProjection.text(metricValue, 64) && NativeDrawerProjection.text(metricLabel, 64) &&
        artworkId.hasPrefix("roster-") && NativeProfileArtwork.resolve(artworkId) != nil && iconHex.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil
    }
}
struct NativeWorkspaceLauncher: Codable { let view: String; let agents: [NativeWorkspaceAgent] }
struct NativeWorkspaceProjection: Decodable {
    let documentId: String; let ownerEpoch: String; let ownerGeneration: Int; let revision: Int; let workspace: String
    let updateSequence: Int; let privacyGeneration: Int; let isolationGeneration: Int; let frame: NativeWorkspaceFrame
    let appearance: String; let accentHex: String; let foregroundHex: String
    var canvasHex: String?
    let page: String; var title: String; let enabled: Bool; let backEnabled: Bool
    var navigation: NativeWorkspaceNavigation?
    var sections: [NativeDrawerSection]; var tabs: NativeWorkspaceTabs?; var secondaryTabs: NativeWorkspaceTabs?
    var feedback: NativePresentationFeedback?
    var walletProfileEditor: NativeWalletProfileEditor?
    var wallet: NativeWalletCollection?
    var launcher: NativeWorkspaceLauncher?
    var calendarDate: NativeWorkspaceCalendarDate?
    var taskEditor: NativeWorkspaceTaskEditor?
    var textEditor: NativeWorkspaceTextEditor?
    var memoryEditor: NativeWorkspaceMemoryEditor?
    var search: NativeWorkspaceSearch?; var circleEditor: NativeWorkspaceCircleEditor?
    var identity: NativeWorkspaceIdentity { .init(documentId: documentId, ownerEpoch: ownerEpoch, ownerGeneration: ownerGeneration, revision: revision, workspace: workspace) }
    var isLocationRoot: Bool { workspace == "location" && tabs != nil && (navigation?.depth ?? 0) < 3 }
    static let keys: Set<String> = ["documentId", "ownerEpoch", "ownerGeneration", "revision", "workspace", "updateSequence", "privacyGeneration", "isolationGeneration", "frame", "appearance", "accentHex", "foregroundHex", "canvasHex", "page", "title", "enabled", "backEnabled", "sections", "navigation", "tabs", "secondaryTabs", "search", "circleEditor", "wallet", "walletProfileEditor", "memoryEditor", "textEditor", "taskEditor", "feedback", "launcher", "calendarDate"]
    static func closed(_ value: [String: Any]) -> Bool {
        guard Set(value.keys).isSubset(of: keys), let frame = value["frame"] as? [String: Any], Set(frame.keys).isSubset(of: ["x", "y", "width", "height", "viewportWidth", "viewportHeight", "layoutRevision", "contentInset", "bottomContentInset"]),
              let sections = value["sections"] as? [[String: Any]] else { return false }
        for section in sections {
            guard Set(section.keys).isSubset(of: ["id", "title", "rows", "layout"]), !(section["layout"] is NSNull), let rows = section["rows"] as? [[String: Any]] else { return false }
            for row in rows where !Set(row.keys).isSubset(of: ["id", "label", "detail", "formattedText", "avatar", "inlineActions", "sosActivation", "menuOnTap", "locationShare", "milestone", "expanded", "symbol", "artworkId", "iconHex", "chevron", "trailing", "enabled", "destructive", "prominent", "selected", "pending", "readOnly", "toggle", "options"]) { return false }
            for row in rows {
                if let raw = row["formattedText"], !NativeMemoryText.closed(raw) { return false }
                if let raw = row["locationShare"], !NativeWorkspaceLocationShare.closed(raw) { return false }
                if let raw = row["avatar"] {
                    guard NativeWorkspaceAvatar.closed(raw) else { return false }
                }
                if let raw = row["inlineActions"] {
                    guard let actions = raw as? [[String: Any]], actions.allSatisfy({ action in
                        Set(action.keys).isSubset(of: ["id", "label", "enabled", "pending", "tone", "symbol", "avatar", "placement"]) &&
                            !action.values.contains(where: { $0 is NSNull }) && (action["avatar"] == nil || NativeWorkspaceAvatar.closed(action["avatar"]!))
                    }) else { return false }
                }
                if row["milestone"] is NSNull || row["expanded"] is NSNull || row["prominent"] is NSNull || row["menuOnTap"] is NSNull || row["sosActivation"] is NSNull { return false }
                if let raw = row["options"] {
                    guard let options = raw as? [[String: Any]], options.allSatisfy({ Set($0.keys) == ["id", "label", "selected"] }) else { return false }
                }
            }
        }
        if let raw = value["navigation"] { guard let navigation = raw as? [String: Any], Set(navigation.keys) == ["id", "depth"] else { return false } }
        if let raw = value["calendarDate"] {
            guard let date = raw as? [String: Any], Set(date.keys) == ["id", "label", "value", "timeZone", "enabled"] else { return false }
        }
        if let raw = value["launcher"] {
            guard let launcher = raw as? [String: Any], Set(launcher.keys) == ["view", "agents"], let agents = launcher["agents"] as? [[String: Any]],
                  agents.allSatisfy({ Set($0.keys) == ["id", "label", "description", "metricValue", "metricLabel", "artworkId", "iconHex"] }) else { return false }
        }
        for raw in [value["tabs"], value["secondaryTabs"]].compactMap({ $0 }) {
            guard let tabs = raw as? [String: Any], Set(tabs.keys) == ["label", "options"], let options = tabs["options"] as? [[String: Any]],
                  options.allSatisfy({ Set($0.keys) == ["id", "label", "selected"] }) else { return false }
        }
        if let raw = value["search"] {
            guard let search = raw as? [String: Any], Set(search.keys).isSuperset(of: ["id", "query", "label"]),
                  Set(search.keys).isSubset(of: ["id", "query", "label", "live", "afterSection"]) else { return false }
        }
        if let raw = value["circleEditor"] {
            let required: Set<String> = ["destinationId", "draft", "draftRevision", "acknowledgedEditRevision", "busy", "canSave", "error"]
            guard let editor = raw as? [String: Any], Set(editor.keys).isSuperset(of: required), Set(editor.keys).isSubset(of: required.union(["customTypes"])),
                  let draft = editor["draft"] as? [String: Any], Set(draft.keys).isSuperset(of: ["name", "kind"]), Set(draft.keys).isSubset(of: ["name", "kind", "customTypeLabel"]) else { return false }
        }
        if let raw = value["feedback"] { guard let feedback = raw as? [String: Any], Set(feedback.keys) == NativePresentationFeedback.keys else { return false } }
        if let raw = value["walletProfileEditor"] { guard let editor = raw as? [String: Any], NativeWalletProfileEditor.closed(editor) else { return false } }
        if let raw = value["textEditor"] { guard let editor = raw as? [String: Any], NativeWorkspaceTextEditor.closed(editor) else { return false } }
        if let raw = value["taskEditor"] { guard let editor = raw as? [String: Any], NativeWorkspaceTaskEditor.closed(editor) else { return false } }
        if let raw = value["memoryEditor"] { guard let editor = raw as? [String: Any], NativeWorkspaceMemoryEditor.closed(editor) else { return false } }
        if let raw = value["wallet"] { guard let wallet = raw as? [String: Any], NativeWalletCollection.closed(wallet) else { return false } }
        return true
    }
    var valid: Bool {
        let max = HushhSessionPrivacyState.maximumJavaScriptSafeGeneration
        guard identity.valid, updateSequence > 0, updateSequence <= max, privacyGeneration >= 0, privacyGeneration <= max, isolationGeneration >= 0, isolationGeneration <= max,
              frame.valid, ["overview", "rules", "circle-picker", "circle-create", "circle-people"].contains(page), NativeDrawerProjection.text(title, 256), sections.count <= 32,
              HushhNativeControlAppearance(appearance: appearance, accentHex: accentHex, foregroundHex: foregroundHex) != nil else { return false }
        guard workspace == "wallet" ? wallet?.valid == true && page == "overview" && circleEditor == nil && HushhNativeControlAppearance.color(canvasHex) != nil : wallet == nil else { return false }
        guard navigation == nil || (workspace == "location" && navigation?.valid == true) else { return false }
        guard textEditor == nil || (workspace == "location" && page == "overview" && circleEditor == nil && walletProfileEditor == nil && memoryEditor == nil && taskEditor == nil && textEditor?.valid == true) else { return false }
        guard taskEditor == nil || (workspace == "tasks" && page == "overview" && circleEditor == nil && walletProfileEditor == nil && memoryEditor == nil && taskEditor?.valid == true) else { return false }
        guard circleEditor?.customTypes == nil || workspace == "connect" else { return false }
        guard memoryEditor == nil || (workspace == "memory" && page == "overview" && circleEditor == nil && walletProfileEditor == nil && memoryEditor?.valid == true) else { return false }
        guard (workspace != "memory" && workspace != "consent") || (page == "overview" && circleEditor == nil && walletProfileEditor == nil && HushhNativeControlAppearance.color(canvasHex) != nil) else { return false }
        var ids = Set<String>(); var count = 0; var avatars = 0; var avatarBytes = 0
        if let wallet { ids.formUnion(wallet.cards.map(\.id) + [wallet.addId, wallet.closeId] + (wallet.accessId.map { [$0] } ?? [])) }
        for section in sections {
            guard NativeDrawerIdentity.identifier(section.id), ids.insert(section.id).inserted, section.title == nil || NativeDrawerProjection.text(section.title!, 256) else { return false }
            guard section.layout == nil || (workspace == "location" && ["cards", "tiles"].contains(section.layout!) && (section.layout != "tiles" || section.rows.count <= 3)) else { return false }
            for row in section.rows {
                count += 1
                guard count <= 200, NativeDrawerIdentity.identifier(row.id), ids.insert(row.id).inserted, NativeDrawerProjection.text(row.label, 4096),
                      row.detail == nil || NativeDrawerProjection.text(row.detail!, 4096), row.trailing == nil || NativeDrawerProjection.text(row.trailing!, 32),
                      row.symbol == nil || NativeDrawerIdentity.identifier(row.symbol!), row.artworkId == nil || NativeDrawerIdentity.identifier(row.artworkId!),
                      row.iconHex == nil || row.iconHex!.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil else { return false }
                if let activation = row.sosActivation { guard workspace == "location", ["hold", "countdown"].contains(activation), row.readOnly != true, row.options == nil, row.toggle != true, row.inlineActions == nil, row.menuOnTap == nil else { return false } }
                if row.menuOnTap != nil { guard workspace == "location", row.inlineActions?.contains(where: { $0.placement == "menu" }) == true else { return false } }
                if row.prominent != nil { guard workspace == "location", row.readOnly != true, row.options == nil, row.toggle != true, row.inlineActions == nil, row.avatar == nil, row.formattedText == nil else { return false } }
                if row.avatar != nil || row.inlineActions != nil || row.milestone != nil || row.expanded != nil {
                    guard ["feed", "connect", "location"].contains(workspace), row.formattedText == nil, row.options == nil, row.toggle != true else { return false }
                }
                if let avatar = row.avatar {
                    avatars += 1; avatarBytes += avatar.jpeg?.utf16.count ?? 0
                    guard avatar.valid, avatars <= 48, avatarBytes <= 1_920_000, avatar.verified == nil || ["connect", "location"].contains(workspace), avatar.active == nil || workspace == "location" else { return false }
                }
                if let share = row.locationShare {
                    guard workspace == "location", share.valid, row.avatar == nil, row.formattedText == nil, row.options == nil, row.toggle != true,
                          row.prominent == nil, row.readOnly == true, let actions = row.inlineActions, (1...3).contains(actions.count) else { return false }
                    avatars += share.people.count; avatarBytes += share.people.reduce(0) { $0 + ($1.jpeg?.utf16.count ?? 0) }
                    guard avatars <= 48, avatarBytes <= 1_920_000 else { return false }
                }
                if let actions = row.inlineActions {
                    guard (1...6).contains(actions.count), actions.filter({ $0.avatar != nil }).count <= 1 else { return false }
                    for action in actions {
                        guard action.valid, ids.insert(action.id).inserted else { return false }
                        if action.placement != nil { guard ["connect", "location"].contains(workspace) else { return false } }
                        if let avatar = action.avatar {
                            avatars += 1; avatarBytes += avatar.jpeg?.utf16.count ?? 0
                            guard workspace == "connect", avatar.active == nil, avatars <= 48, avatarBytes <= 1_920_000 else { return false }
                        }
                    }
                }
                if let milestone = row.milestone { guard workspace == "feed", (0...4).contains(milestone) else { return false } }
                if row.expanded != nil { guard workspace == "feed" else { return false } }
                if let formatted = row.formattedText {
                    guard workspace == "memory", formatted.valid, row.options == nil, row.toggle != true,
                          formatted.runs.map(\.text).joined() == row.label,
                          formatted.actionIds.isEmpty || row.readOnly != true else { return false }
                    for action in formatted.actionIds { guard ids.insert(action).inserted else { return false } }
                }
                if let options = row.options {
                    guard row.readOnly != true, (2...32).contains(options.count), (workspace == "location" && row.toggle != true ? options.filter(\.selected).count <= 1 : options.filter(\.selected).count == 1) else { return false }
                    if row.toggle == true && (options.count != 2 || options[0].label != "On" || options[1].label != "Off") { return false }
                    for option in options { guard NativeDrawerIdentity.identifier(option.id), ids.insert(option.id).inserted, NativeDrawerProjection.text(option.label, 256) else { return false } }
                } else if row.toggle == true { return false }
            }
        }
        if let calendarDate {
            guard workspace == "calendar", page == "overview", calendarDate.valid, ids.insert(calendarDate.id).inserted else { return false }
        }
        if let launcher {
            guard workspace == "launcher", page == "overview", ["grid", "list"].contains(launcher.view), launcher.agents.count <= 32 else { return false }
            for agent in launcher.agents { guard agent.valid, ids.insert(agent.id).inserted else { return false } }
        }
        guard secondaryTabs == nil || (workspace == "connect" && tabs != nil) else { return false }
        for tabs in [tabs, secondaryTabs].compactMap({ $0 }) {
            guard NativeDrawerProjection.text(tabs.label, 64), (2...4).contains(tabs.options.count), tabs.options.filter(\.selected).count == 1 else { return false }
            for option in tabs.options { guard NativeDrawerIdentity.identifier(option.id), ids.insert(option.id).inserted, NativeDrawerProjection.text(option.label, 64) else { return false } }
        }
        if let wallet, wallet.view == "sharing" {
            guard let sharedTabId = wallet.sharedTabId, tabs?.options.contains(where: { $0.id == sharedTabId && $0.selected }) == true else { return false }
        }
        if let wallet, wallet.view == "cards", let sharedTabId = wallet.sharedTabId,
           tabs?.options.contains(where: { $0.id == sharedTabId && $0.selected }) == true { return false }
        if let search {
            guard NativeDrawerIdentity.identifier(search.id), ids.insert(search.id).inserted,
                  search.query.utf16.count <= 256, NativeDrawerProjection.text(search.label, 64),
                  search.afterSection == nil || (workspace == "memory" && (0...sections.count).contains(search.afterSection!)) else { return false }
        }
        if let feedback { guard feedback.valid else { return false } }
        if let nav = wallet?.navigation {
            guard walletProfileEditor == nil, let section = sections.first(where: { $0.id == nav.sectionId }),
                  section.rows.count == nav.actionIds.count,
                  section.rows.allSatisfy({ nav.actionIds.contains($0.id) && $0.readOnly != true && $0.options == nil && $0.toggle != true }) else { return false }
        }
        if let walletProfileEditor { guard workspace == "wallet", wallet?.selectedId != nil, walletProfileEditor.valid else { return false } }
        if let circleEditor { guard page == "circle-create", circleEditor.valid else { return false } }
        return true
    }
    func receipt(_ phase: String, settled: Bool) -> [String: Any] {
        identity.event.merging(["updateSequence": updateSequence, "privacyGeneration": privacyGeneration, "layoutRevision": frame.layoutRevision, "phase": phase, "settled": settled]) { _, new in new }
    }
    func permits(_ action: String, row: String?, text: String? = nil, actionToken: String? = nil) -> Bool {
        guard enabled else { return false }
        if wallet != nil && wallet?.selectedId != nil, let row, tabs?.options.contains(where: { $0.id == row }) == true { return false }
        if action == "feedback-dismiss" { return feedback?.id == row && feedback?.dismissible == true && text == nil && actionToken == nil }
        if action == "feedback-action" {
            return feedback?.id == row && feedback?.actionToken == actionToken && actionToken != nil && text == nil
        }
        guard actionToken == nil else { return false }
        if action == "wallet-save" || action == "wallet-cancel" { return walletProfileEditor != nil && walletProfileEditor?.busy == false && row == nil && text == nil && (action == "wallet-cancel" || walletProfileEditor?.canSave == true) }
        if action == "circle-save" || action == "circle-cancel" { return circleEditor != nil && circleEditor?.busy == false && row == nil && text == nil && (action == "circle-cancel" || circleEditor?.canSave == true) }
        if action == "text-save" || action == "text-cancel" { return textEditor != nil && textEditor?.busy == false && row == nil && text == nil && (action == "text-cancel" || textEditor?.canSave == true) }
        if action == "task-save" || action == "task-cancel" { return taskEditor != nil && taskEditor?.busy == false && row == nil && text == nil && (action == "task-cancel" || taskEditor?.canSave == true) }
        if action == "memory-review" { return memoryEditor?.busy == false && memoryEditor?.canSave == true && row == nil && text == nil }
        if action == "back" { return backEnabled && row == nil }
        guard action == "row", let row else { return false }
        if let wallet, wallet.permits(row) { return text == nil }
        if launcher?.agents.contains(where: { $0.id == row }) == true { return text == nil }
        if let date = calendarDate, date.id == row { return date.enabled && text.map { date.accepts($0) } == true }
        if search?.id == row { return text != nil && (text?.utf16.count ?? 257) <= 256 }
        guard text == nil else { return false }
        if [tabs, secondaryTabs].compactMap({ $0 }).contains(where: { $0.options.contains(where: { $0.id == row && !$0.selected }) }) { return true }
        return sections.contains { $0.rows.contains { item in
            if item.inlineActions?.contains(where: { $0.id == row && $0.enabled && $0.pending != true }) == true {
                return item.enabled && item.pending != true
            }
            if let formatted = item.formattedText {
                return item.enabled && item.pending != true && formatted.actionIds.contains(row)
            }
            return item.enabled && item.pending != true && item.readOnly != true &&
                (item.options?.contains(where: { $0.id == row && !$0.selected }) ?? (item.id == row))
        } }
    }
}
/// The native clock paints locally. The retained feature still owns expiry and
/// server reconciliation; this view never grants, revokes or starts a reader.
private struct NativeLocationShareSchedule: TimelineSchedule {
    let endsAt: Double?
    func entries(from startDate: Date, mode: Mode) -> Entries { Entries(date: startDate, endsAt: endsAt) }
    struct Entries: Sequence, IteratorProtocol {
        var date: Date
        let endsAt: Double?
        mutating func next() -> Date? {
            let current = date
            date.addTimeInterval(endsAt.map { $0 - current.timeIntervalSince1970 * 1000 > 3_600_000 ? 15 : 1 } ?? 1)
            return current
        }
    }
}
@available(iOS 26.0, *)
private struct NativeLocationShareSummary: View {
    let share: NativeWorkspaceLocationShare
    let title: String
    private func duration(_ milliseconds: Double) -> String {
        let seconds = Int(max(0, milliseconds) / 1000)
        if milliseconds < 3_600_000 { return String(format: "%02d:%02d", seconds / 60, seconds % 60) }
        if milliseconds < 86_400_000 { return String(format: "%dh %02dm", seconds / 3600, (seconds % 3600) / 60) }
        return "\(seconds / 86400)d \((seconds % 86400) / 3600)h"
    }
    private var identities: some View {
        HStack(spacing: -8) {
            if share.people.isEmpty {
                ForEach(0..<min(share.count, 2), id: \.self) { index in
                    NativeProfilePortraitImage(data: nil, initials: "\(index + 1)", initialsFont: .caption2.weight(.medium)).frame(width: 28, height: 28)
                        .overlay(Circle().stroke(Color(uiColor: .secondarySystemGroupedBackground), lineWidth: 2))
                }
            } else {
                ForEach(Array(share.people.enumerated()), id: \.offset) { _, person in
                    NativeProfilePortraitImage(data: person.jpeg, initials: person.initials, initialsFont: .caption2.weight(.medium)).frame(width: 28, height: 28)
                        .overlay(Circle().stroke(Color(uiColor: .secondarySystemGroupedBackground), lineWidth: 2))
                }
            }
            let visible = share.people.isEmpty ? min(share.count, 2) : share.people.count
            if share.count > visible {
                Text("+\(share.count - visible)").font(.caption.weight(.semibold)).foregroundStyle(.secondary).padding(.leading, 14)
            }
        }.accessibilityHidden(true)
    }
    @ViewBuilder private var audience: some View {
        if let audience = share.audience {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 16) { audienceLabels(audience) }
                VStack(alignment: .leading, spacing: 6) { audienceLabels(audience) }
            }.font(.subheadline).foregroundStyle(.secondary)
            if audience.bothCount > 0 {
                Text("\(audience.bothCount) \(audience.bothCount == 1 ? "person receives" : "people receive") both").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
    @ViewBuilder private func audienceLabels(_ audience: NativeWorkspaceLocationShare.Audience) -> some View {
        if audience.locationCount > 0 { Label("\(audience.locationCount) Location \(audience.locationCount == 1 ? "share" : "shares")", systemImage: "mappin.and.ellipse") }
        if audience.smsCount > 0 { Label("\(audience.smsCount) SMS", systemImage: "message").foregroundStyle(.red) }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                identities
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(.body.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                    if share.singleGrant && (share.startedAt != nil || share.endsAt != nil) {
                        TimelineView(NativeLocationShareSchedule(endsAt: share.endsAt)) { context in
                            let now = context.date.timeIntervalSince1970 * 1000
                            let elapsed = max(0, now - (share.startedAt ?? now))
                            let remaining = share.endsAt.map { max(0, $0 - now) }
                            VStack(alignment: .leading, spacing: 6) {
                            Text(share.endsAt != nil && remaining == 0 ? "Stopping now" : "\(duration(remaining ?? elapsed)) \(share.endsAt == nil ? "so far" : "left")")
                                .font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
                                .accessibilityLabel(share.endsAt != nil && remaining == 0 ? "Sharing is stopping now" : "\(duration(remaining ?? elapsed)) \(share.endsAt == nil ? "elapsed" : "remaining")")
                            if let start = share.startedAt, let end = share.endsAt, end > start {
                                ProgressView(value: min(1, max(0, (now - start) / (end - start))))
                                    .tint(.green).accessibilityHidden(true)
                            }
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    if let footer = share.footer { Text(footer).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            audience
        }
    }
}

/// Identity and decisions share a visual row, while each tap has its own
/// registered action. A secondary control is never nested inside a button.
@available(iOS 26.0, *)
private struct NativeWorkspaceRichRow: View {
    let row: NativeDrawerRow
    let enabled: Bool
    let accentHex: String
    let choose: (String) -> Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var accent: Color { Color(uiColor: HushhNativeControlAppearance.color(accentHex) ?? .label) }
    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            if row.artworkId == "location-share-pulse" {
                ZStack {
                    Circle().fill(accent.opacity(0.07))
                    Circle().fill(accent.opacity(0.12)).padding(7)
                    Circle().fill(accent.opacity(0.2)).padding(15)
                    Circle().fill(accent).padding(22)
                }.frame(width: 64, height: 64).accessibilityHidden(true)
            } else if let avatar = row.avatar {
                NativeProfilePortraitImage(data: avatar.jpeg, initials: avatar.initials).frame(width: 42, height: 42)
                    .overlay(alignment: .bottomTrailing) {
                        if avatar.verified == true {
                            Image(systemName: "checkmark.seal.fill").font(.caption).foregroundStyle(accent)
                                .background(Color(uiColor: .secondarySystemGroupedBackground), in: Circle()).accessibilityLabel("Verified RIA")
                        }
                    }.overlay(alignment: .topTrailing) {
                        if avatar.active == true { Circle().fill(.green).frame(width: 10, height: 10).overlay(Circle().stroke(Color(uiColor: .secondarySystemGroupedBackground), lineWidth: 2)).accessibilityHidden(true) }
                    }.accessibilityHidden(avatar.verified != true)
            } else if let symbol = row.symbol {
                Image(systemName: symbol).font(.title3).foregroundStyle(Color(uiColor: HushhNativeControlAppearance.color(row.iconHex ?? accentHex) ?? .label)).frame(width: 36).accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 5) {
                Text(row.label).font(.body.weight(.medium)).foregroundStyle(.primary).fixedSize(horizontal: false, vertical: true)
                if let detail = row.detail { Text(detail).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
                if let trailing = row.trailing { Text(trailing).font(.caption).foregroundStyle(.secondary) }
            }.frame(maxWidth: .infinity, alignment: .leading)
            if let expanded = row.expanded {
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(expanded ? 90 : 0))
                    .animation(reduceMotion ? nil : .smooth(duration: 0.2), value: expanded)
            }
            else if let selected = row.selected { Image(systemName: selected ? "checkmark.circle.fill" : "circle").foregroundStyle(selected ? accent : .secondary) }
            else if row.chevron == true { Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary) }
        }.frame(maxWidth: .infinity, alignment: .leading).frame(minHeight: 44).contentShape(Rectangle())
    }
    @ViewBuilder private var primary: some View {
        if row.menuOnTap == true, let actions = row.inlineActions {
            Menu {
                ForEach(actions.filter { $0.placement == "menu" }) { action in
                    Button(role: action.tone == "danger" ? .destructive : nil) { _ = choose(action.id) } label: { Text(action.label) }
                        .disabled(!enabled || !row.enabled || row.pending == true || !action.enabled || action.pending == true)
                }
            } label: { header }.buttonStyle(.plain).disabled(!enabled || !row.enabled || row.pending == true)
                .accessibilityLabel(row.label).accessibilityIdentifier("native-workspace-row-\(row.id)")
        } else if row.readOnly == true { header.accessibilityElement(children: .combine) }
        else {
            Button { _ = choose(row.id) } label: { header }.buttonStyle(.plain)
                .disabled(!enabled || !row.enabled || row.pending == true)
                .accessibilityAddTraits(row.selected == true ? .isSelected : [])
                .accessibilityIdentifier("native-workspace-row-\(row.id)")
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let share = row.locationShare, let actions = row.inlineActions {
                HStack {
                    Label("Sharing now", systemImage: "circle.fill").font(.caption.weight(.semibold)).foregroundStyle(.green)
                    Spacer(minLength: 8)
                    if let first = actions.first { decision(first) }
                }
                NativeLocationShareSummary(share: share, title: row.label)
            } else if row.avatar?.active != nil, let actions = row.inlineActions {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { primary; ForEach(actions.filter { $0.placement != "menu" }) { decision($0) } }
                    VStack(alignment: .leading, spacing: 12) { primary; HStack(spacing: 8) { ForEach(actions.filter { $0.placement != "menu" }) { decision($0) } } }
                }
            } else { primary }
            if let stage = row.milestone {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 4) {
                        ForEach(0..<4, id: \.self) { index in
                            Capsule().fill(index <= stage ? accent.opacity(index == stage ? 1 : 0.65) : Color.secondary.opacity(0.15)).frame(height: 4)
                        }
                    }.accessibilityHidden(true)
                    Text(["Scheduled", "Finishing current work", "Installing", "Restarting and verifying", "Installation verified"][stage])
                        .font(.caption).foregroundStyle(.secondary)
                }.animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: stage)
            }
            if row.avatar?.active == nil, let allActions = row.inlineActions {
                let actions = row.locationShare == nil ? allActions : Array(allActions.dropFirst())
                if row.artworkId == "location-share-pulse" {
                    ForEach(actions) { action in decision(action).controlSize(.large) }.padding(.leading, 76)
                } else {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { ForEach(actions.filter { $0.placement != "menu" }) { action in decision(action) }; Spacer(minLength: 0); options(actions) }
                    VStack(alignment: .leading, spacing: 8) { ForEach(actions.filter { $0.placement != "menu" }) { action in decision(action) }; options(actions) }
                }
                }
            }
        }.padding(16)
    }
    @ViewBuilder private func options(_ actions: [NativeWorkspaceInlineAction]) -> some View {
        let overflow = actions.filter { $0.placement == "menu" }
        if !overflow.isEmpty && row.menuOnTap != true {
            Menu {
                ForEach(overflow) { action in
                    Button(role: action.tone == "danger" ? .destructive : nil) { _ = choose(action.id) } label: { Text(action.label) }
                        .disabled(!enabled || !row.enabled || row.pending == true || !action.enabled || action.pending == true)
                        .accessibilityIdentifier("native-workspace-action-\(action.id)")
                }
            } label: { Image(systemName: "ellipsis").frame(width: 44, height: 44).contentShape(Circle()) }
                .disabled(!enabled || !row.enabled || row.pending == true)
                .accessibilityLabel("Options").accessibilityIdentifier("native-workspace-options-\(row.id)")
        }
    }
    private func decision(_ action: NativeWorkspaceInlineAction) -> some View {
        Group {
            if action.tone == "primary" || action.tone == "success" {
                decisionButton(action).buttonStyle(.borderedProminent).tint(action.tone == "success" ? .green : accent)
            } else { decisionButton(action).buttonStyle(.bordered).tint(action.tone == "danger" ? .red : accent) }
        }.disabled(!enabled || !row.enabled || row.pending == true || !action.enabled || action.pending == true)
            .accessibilityIdentifier("native-workspace-action-\(action.id)")
            .accessibilityLabel(row.avatar != nil ? "\(action.label), \(row.label)" : action.label)
    }
    private func decisionButton(_ action: NativeWorkspaceInlineAction) -> some View {
        Button(role: action.tone == "danger" ? .destructive : nil) { _ = choose(action.id) } label: {
            HStack(spacing: 6) {
                if action.pending == true { ProgressView().controlSize(.small) }
                if let avatar = action.avatar { NativeProfilePortraitImage(data: avatar.jpeg, initials: avatar.initials).frame(width: 22, height: 22).accessibilityHidden(true) }
                if let symbol = action.symbol { Image(systemName: symbol).accessibilityHidden(true) }
                Text(action.label).fixedSize(horizontal: false, vertical: true)
            }.font(.subheadline.weight(.medium)).frame(maxWidth: row.artworkId == "location-share-pulse" ? .infinity : nil).frame(minHeight: 32)
        }
    }
}

@available(iOS 26.0, *)
private struct NativeLocationHeader: View {
    let rows: [NativeDrawerRow]
    let enabled: Bool
    let accentHex: String
    let choose: (String) -> Bool
    var body: some View {
        VStack(spacing: 8) {
            ForEach(rows) { row in
                if let action = row.inlineActions?.first {
                    HStack(spacing: 12) {
                        Text(row.label).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
                        Button { _ = choose(action.id) } label: { Text(action.label).font(.subheadline.weight(.medium)).frame(minHeight: 32) }
                            .buttonStyle(.bordered).disabled(!enabled || !row.enabled || row.pending == true || !action.enabled || action.pending == true)
                            .accessibilityIdentifier("native-workspace-action-\(action.id)")
                    }.padding(12).background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
                } else if row.toggle == true, let options = row.options, options.count == 2 {
                    Toggle(isOn: Binding(get: { options[0].selected }, set: { _ = choose(options[$0 ? 0 : 1].id) })) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(row.label).font(.subheadline.weight(.medium))
                            if let detail = row.detail { Text(detail).font(.caption).foregroundStyle(.secondary) }
                        }
                    }.disabled(!enabled || !row.enabled || row.pending == true).tint(.green)
                        .accessibilityIdentifier("native-workspace-row-\(row.id)")
                } else if row.readOnly == true {
                    NativeSettingsRowLabel(row: row, accentHex: accentHex).accessibilityElement(children: .combine)
                } else {
                    Button { _ = choose(row.id) } label: { NativeSettingsRowLabel(row: row, accentHex: accentHex) }
                        .buttonStyle(.plain).disabled(!enabled || !row.enabled || row.pending == true)
                        .accessibilityIdentifier("native-workspace-row-\(row.id)")
                }
            }
        }
    }
}

/// Location's authored two action tiles and separate emergency card share the
/// existing registered callbacks and scroll owner, including large-type fitting.
@available(iOS 26.0, *)
private struct NativeLocationActionTiles: View {
    let rows: [NativeDrawerRow]
    let enabled: Bool
    let accentHex: String
    let choose: (String) -> Bool
    @Environment(\.dynamicTypeSize) private var textSize
    private func tile(_ row: NativeDrawerRow) -> some View {
        Button(role: row.destructive == true ? .destructive : nil) { _ = choose(row.id) } label: {
            Group {
                if row.destructive == true {
                    HStack(spacing: 12) {
                        Image(systemName: row.symbol ?? "sos.circle").font(.title2).foregroundStyle(.red)
                            .frame(width: 44, height: 44).background(.red.opacity(0.12), in: Circle()).accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(row.label).font(.body.weight(.semibold)).foregroundStyle(.primary)
                            if let detail = row.detail { Text(detail).font(.subheadline).foregroundStyle(.red) }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary).accessibilityHidden(true)
                    }
                } else {
                    VStack(alignment: .leading, spacing: 10) {
                        if let symbol = row.symbol { Image(systemName: symbol).font(.title2).foregroundStyle(Color(uiColor: HushhNativeControlAppearance.color(accentHex) ?? .label)).accessibilityHidden(true) }
                        Text(row.label).font(.body.weight(.semibold)).foregroundStyle(.primary)
                        if let detail = row.detail { Text(detail).font(.subheadline).foregroundStyle(.secondary) }
                    }.frame(maxWidth: .infinity, alignment: .leading).frame(minHeight: 76)
                }
            }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
                .contentShape(RoundedRectangle(cornerRadius: 18))
        }.buttonStyle(.plain).tint(row.destructive == true ? .red : Color(uiColor: HushhNativeControlAppearance.color(accentHex) ?? .label))
            .disabled(!enabled || !row.enabled || row.pending == true)
            .accessibilityIdentifier("native-workspace-row-\(row.id)")
    }
    var body: some View {
        VStack(spacing: 10) {
            if textSize.isAccessibilitySize { ForEach(Array(rows.prefix(2))) { tile($0) } }
            else { HStack(alignment: .top, spacing: 10) { ForEach(Array(rows.prefix(2))) { tile($0) } } }
            ForEach(Array(rows.dropFirst(2))) { tile($0) }
        }
    }
}

/// Attributed Memory text keeps its inline action handles in the existing
/// workspace action domain. Native never receives or opens a destination URL.
private struct NativeMemoryTextBody: View {
    let text: NativeMemoryText
    let enabled: Bool
    let choose: (String) -> Bool
    private var attributed: AttributedString {
        var result = AttributedString()
        for run in text.runs {
            var part = AttributedString(run.text)
            var emphasis: InlinePresentationIntent = []
            if run.bold == true { emphasis.insert(.stronglyEmphasized) }
            if run.italic == true { emphasis.insert(.emphasized) }
            if !emphasis.isEmpty { part.inlinePresentationIntent = emphasis }
            if let action = run.actionId {
                var link = URLComponents(); link.scheme = "hushh-memory-action"; link.path = action
                part.link = link.url
            }
            result.append(part)
        }
        return result
    }
    private var font: Font {
        switch text.level {
        case 1: return .title2.weight(.semibold)
        case 2: return .title3.weight(.semibold)
        case 3: return .headline
        case .some: return .subheadline.weight(.semibold)
        case nil: return .body
        }
    }
    var body: some View {
        Text(attributed).font(font).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16).padding(.vertical, text.level == nil ? 10 : 14)
            .accessibilityAddTraits(text.level == nil ? [] : .isHeader)
            .environment(\.openURL, OpenURLAction { url in
                guard enabled, url.scheme == "hushh-memory-action", text.actionIds.contains(url.path) else { return .discarded }
                _ = choose(url.path); return .handled
            })
    }
}
struct NativeWorkspaceAction: Equatable {
    let sequence: Int; let updateSequence: Int; let action: String; let row: String?
    var text: String? = nil; var editRevision: Int? = nil
    var domain: String? = nil; var detailVisitId: String? = nil; var dismissed: Bool? = nil; var actionToken: String? = nil
}
@MainActor final class NativeWorkspaceDraftEditor<P: NativeProfileEditorProjection> where P.Identity == NativeWorkspaceIdentity {
    let model: NativeProfileEditorModel<P>
    private var action: NativeProfileNameAction?
    init(_ projection: P, workspace: NativeWorkspaceModel, destination: @escaping (NativeWorkspaceProjection) -> String?,
         payload: @escaping (P.Draft) -> [String: Any], actionName: @escaping (String) -> String) {
        let model = NativeProfileEditorModel(projection); self.model = model
        let emit: (P.Draft, Int, Bool, Bool) -> Void = { [weak workspace, weak model] draft, revision, composing, final in
            guard let workspace, let model else { return }
            let projection = model.projection
            var event = projection.identity.event.merging(["destinationId": projection.destinationId, "updateSequence": projection.updateSequence,
                "privacyGeneration": projection.privacyGeneration, "editRevision": revision, "composing": composing, "draft": payload(draft)]) { _, new in new }
            if final { event["baseDraftRevision"] = projection.draftRevision }
            workspace.emitEdit?(final ? "workspaceFinalEdit" : "workspaceEdit", event)
        }
        model.edit = { [weak workspace, weak model] draft, composing, revision in
            guard let workspace, let model, workspace.active, destination(workspace.state) == model.projection.destinationId,
                  workspace.canInteract?() == true else { return false }
            emit(draft, revision, composing, false); return true
        }
        model.finalEdit = { draft, revision in emit(draft, revision, false, true) }
        model.choose = { [weak self, weak workspace] action in
            guard let self, let workspace else { return false }
            self.action = action
            return workspace.choice(actionName(action.action), editRevision: action.editRevision)
        }
    }
    func update(_ projection: P) -> Bool { model.update(projection) }
    func confirm(_ choice: NativeWorkspaceAction) -> Bool { action.map { $0.editRevision == choice.editRevision && model.confirm($0) } == true }
    func settle() { if let action { _ = model.settle(action) }; action = nil }
    func clear() { model.clear(); action = nil }
}
@MainActor final class NativeWorkspaceModel: ObservableObject {
    @Published private(set) var state: NativeWorkspaceProjection
    @Published private(set) var pending: NativeWorkspaceAction?
    @Published private(set) var active = true
    private(set) var navigationForward = true
    var canvasColor: UIColor { HushhNativeControlAppearance.color(state.canvasHex) ?? .systemGroupedBackground }
    var emit: (([String: Any]) -> Void)?
    var emitEdit: ((String, [String: Any]) -> Void)?
    var canInteractDetail: ((String, Bool) -> Bool)?
    var canInteract: (() -> Bool)?
    private var retiringWalletEditors = [UUID: NativeWalletWorkspaceEditor]()
    private var retiringDraftEditors = [UUID: AnyObject]()
    var editorRetirementChanged: (() -> Void)?
    var hasRetiringEditorPresentations: Bool { !retiringWalletEditors.isEmpty || !retiringDraftEditors.isEmpty }
    private var editorRetirementWaiters = [() -> Void]()
    func afterEditorRetirement(_ completion: @escaping () -> Void) {
        if !hasRetiringEditorPresentations { completion() } else { editorRetirementWaiters.append(completion) }
    }
    private func retireWalletEditor() {
        guard let old = walletEditor else { return }; walletEditor = nil
        let key = UUID(); retiringWalletEditors[key] = old
        let finish = { [weak self] in
            guard let self else { return }; self.retiringWalletEditors.removeValue(forKey: key)
            if !self.hasRetiringEditorPresentations { let callbacks = self.editorRetirementWaiters; self.editorRetirementWaiters = []; callbacks.forEach { $0() } }
        }
        var cleared = false, dismissed = false
        old.model.dismissEditorMenus { dismissed = true; if cleared { finish() } }
        old.clear(); cleared = true
        if dismissed { finish() }
    }
    private func retireDraftEditor<P>(_ old: NativeWorkspaceDraftEditor<P>?) {
        guard let old else { return }
        let key = UUID(); retiringDraftEditors[key] = old
        DispatchQueue.main.async { [weak self] in self?.editorRetirementChanged?() }
        let finish = { [weak self] in
            guard let self else { return }; self.retiringDraftEditors.removeValue(forKey: key)
            if !self.hasRetiringEditorPresentations { let callbacks = self.editorRetirementWaiters; self.editorRetirementWaiters = []; callbacks.forEach { $0() } }
            DispatchQueue.main.async { [weak self] in self?.editorRetirementChanged?() }
        }
        var cleared = false, dismissed = false
        old.model.dismissEditorMenus { dismissed = true; if cleared { finish() } }
        old.clear(); cleared = true
        if dismissed { finish() }
    }
    private func retireTextEditor() { let old = textEditor; textEditor = nil; retireDraftEditor(old) }
    private func retireMemoryEditor() { let old = memoryEditor; memoryEditor = nil; retireDraftEditor(old) }
    private func retireTaskEditor() { let old = taskEditor; taskEditor = nil; retireDraftEditor(old) }
    private(set) var walletEditor: NativeWalletWorkspaceEditor?
    @Published private(set) var textEditor: NativeWorkspaceDraftEditor<NativeWorkspaceTextProjection>?
    @Published private(set) var memoryEditor: NativeWorkspaceDraftEditor<NativeWorkspaceMemoryProjection>?
    @Published private(set) var taskEditor: NativeWorkspaceDraftEditor<NativeWorkspaceTaskProjection>?
    var scrolled: ((CGFloat, Bool) -> Void)?
    let searchMenus = NativeEditorMenuLifetime()
    weak var searchField: UITextField?
    fileprivate var searchOwner: ObjectIdentifier?
    fileprivate var searchDidSettle: ((NativeWorkspaceAction) -> Void)?
    fileprivate var scrubSearch: (() -> Void)?
    private var sequence = 0; private var confirmed = 0
    var interactionSequence: Int { sequence }
    @Published private(set) var editor: NativeProfileEditorModel<NativeWorkspaceCircleProjection>?
    private var editorAction: NativeProfileNameAction?
    init(_ state: NativeWorkspaceProjection) { self.state = state; _ = reconcileEditor() }
    var presentationComplete: Bool { (state.circleEditor == nil || editor?.retired == false) && (state.walletProfileEditor == nil || walletEditor?.model.retired == false) && (state.memoryEditor == nil || memoryEditor?.model.retired == false) && (state.taskEditor == nil || taskEditor?.model.retired == false) && (state.textEditor == nil || textEditor?.model.retired == false) && !hasRetiringEditorPresentations }
    @discardableResult private func reconcileEditor() -> Bool {
        if let next = state.textEditor {
            if let textEditor, textEditor.model.projection.destinationId == next.destinationId {
                if !textEditor.update(NativeWorkspaceTextProjection(state, next)) { return false }
            } else { retireTextEditor(); textEditor = NativeWorkspaceDraftEditor(NativeWorkspaceTextProjection(state, next), workspace: self, destination: { $0.textEditor?.destinationId }, payload: { $0.event }, actionName: { "text-" + $0 }) }
        } else { retireTextEditor() }
        if let next = state.memoryEditor {
            if let memoryEditor, memoryEditor.model.projection.destinationId == next.destinationId {
                if !memoryEditor.update(NativeWorkspaceMemoryProjection(state, next)) { return false }
            } else { retireMemoryEditor(); memoryEditor = NativeWorkspaceDraftEditor(NativeWorkspaceMemoryProjection(state, next), workspace: self, destination: { $0.memoryEditor?.destinationId }, payload: { $0.event }, actionName: { _ in "memory-review" }) }
        } else { retireMemoryEditor() }
        if let next = state.taskEditor {
            if let taskEditor, taskEditor.model.projection.destinationId == next.destinationId {
                if !taskEditor.update(NativeWorkspaceTaskProjection(state, next)) { return false }
            } else {
                retireTaskEditor()
                taskEditor = NativeWorkspaceDraftEditor(NativeWorkspaceTaskProjection(state, next), workspace: self,
                    destination: { $0.taskEditor?.destinationId }, payload: { $0.event }, actionName: { "task-" + $0 })
            }
        } else { retireTaskEditor() }
        if let next = state.walletProfileEditor {
            if let walletEditor, walletEditor.model.projection.destinationId == next.destinationId {
                if !walletEditor.update(state, editor: next) { return false }
            } else { retireWalletEditor(); walletEditor = NativeWalletWorkspaceEditor(state: state, editor: next, workspace: self) }
        } else { retireWalletEditor() }
        guard let next = state.circleEditor else { editor?.clear(); editor = nil; editorAction = nil; return true }
        let projection = NativeWorkspaceCircleProjection(state, next)
        if let editor, editor.projection.destinationId == next.destinationId {
            if !editor.update(projection) { editor.clear(); self.editor = nil; return false }
            return true
        }
        editor?.clear()
        let model = NativeProfileEditorModel(projection); editor = model
        model.edit = { [weak self, weak model] draft, composing, revision in
            guard let self, let model, self.editor === model, self.active else { return false }
            self.emitEditor("workspaceEdit", draft, composing: composing, revision: revision, model: model); return true
        }
        model.finalEdit = { [weak self, weak model] draft, revision in
            guard let self, let model else { return }
            self.emitEditor("workspaceFinalEdit", draft, composing: false, revision: revision, model: model)
        }
        model.choose = { [weak self, weak model] action in
            guard let self, let model, self.editor === model else { return false }
            self.editorAction = action
            return self.choice(action.action == "save" ? "circle-save" : "circle-cancel", editRevision: action.editRevision)
        }
        return true
    }
    private func emitEditor(_ event: String, _ draft: NativeWorkspaceCircleDraft, composing: Bool, revision: Int, model: NativeProfileEditorModel<NativeWorkspaceCircleProjection>) {
        let projection = model.projection
        var payload = projection.identity.event.merging(["destinationId": projection.destinationId, "updateSequence": projection.updateSequence, "privacyGeneration": projection.privacyGeneration,
            "editRevision": revision, "composing": composing, "draft": draft.event]) { _, new in new }
        if event == "workspaceFinalEdit" { payload["baseDraftRevision"] = projection.draftRevision }
        emitEdit?(event, payload)
    }
    func acceptsUpdate(_ next: NativeWorkspaceProjection) -> Bool {
        active && next.identity == state.identity && next.updateSequence > state.updateSequence &&
              next.privacyGeneration == state.privacyGeneration && next.frame.layoutRevision >= state.frame.layoutRevision &&
              (next.frame.layoutRevision != state.frame.layoutRevision || next.frame == state.frame)
    }
    func update(_ next: NativeWorkspaceProjection) -> Bool {
        guard acceptsUpdate(next) else { return false }
        navigationForward = (next.navigation?.depth ?? 0) >= (state.navigation?.depth ?? 0)
        state = next
        return reconcileEditor()
    }
    @discardableResult func choice(_ action: String, row: String? = nil, text: String? = nil, editRevision: Int? = nil,
                                   detailVisitId: String? = nil, dismissed: Bool = false, actionToken: String? = nil) -> Bool {
        let admitted = detailVisitId.map { canInteractDetail?($0, dismissed) == true } ?? (canInteract?() == true && state.wallet?.selectedId == nil)
        guard !dismissed || row == state.wallet?.closeId, active, pending == nil, admitted,
              state.permits(action, row: row, text: text, actionToken: actionToken),
              sequence < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration else { return false }
        sequence += 1
        let choice = NativeWorkspaceAction(sequence: sequence, updateSequence: state.updateSequence, action: action, row: row,
            text: text, editRevision: editRevision, domain: detailVisitId == nil ? nil : "wallet-detail",
            detailVisitId: detailVisitId, dismissed: detailVisitId == nil ? nil : dismissed, actionToken: actionToken)
        pending = choice
        var event = state.identity.event.merging(["privacyGeneration": state.privacyGeneration, "sequence": sequence, "updateSequence": state.updateSequence, "action": action]) { _, new in new }
        if let detailVisitId { event["domain"] = "wallet-detail"; event["detailVisitId"] = detailVisitId; event["dismissed"] = dismissed }
        if let row { event["rowId"] = row }; if let text { event["text"] = text }; if let editRevision { event["editRevision"] = editRevision }
        if let actionToken { event["actionToken"] = actionToken }; emit?(event); return true
    }
    func confirm(_ action: NativeWorkspaceAction) -> Bool {
        let admitted = action.detailVisitId.map { action.domain == "wallet-detail" && canInteractDetail?($0, action.dismissed == true) == true } ?? (action.domain == nil && canInteract?() == true && state.wallet?.selectedId == nil)
        guard active, admitted, pending == action, action.sequence > confirmed,
              (action.dismissed == true || action.action == "text-cancel" ? action.updateSequence <= state.updateSequence : action.updateSequence == state.updateSequence),
              state.permits(action.action, row: action.row, text: action.text, actionToken: action.actionToken) else { return false }
        if action.action.hasPrefix("circle-") {
            guard let editorAction, editorAction.editRevision == action.editRevision, editor?.confirm(editorAction) == true else { return false }
        }
        if action.action.hasPrefix("wallet-") { guard walletEditor?.confirm(action) == true else { return false } }
        if action.action.hasPrefix("text-") { guard textEditor?.confirm(action) == true else { return false } }
        if action.action.hasPrefix("task-") { guard taskEditor?.confirm(action) == true else { return false } }
        if action.action == "memory-review" { guard memoryEditor?.confirm(action) == true else { return false } }
        confirmed = action.sequence; return true
    }
    func isConfirmed(_ action: NativeWorkspaceAction) -> Bool { active && pending == action && confirmed == action.sequence }
    func settle(_ action: NativeWorkspaceAction) -> Bool {
        guard pending == action else { return false }; pending = nil
        if action.action.hasPrefix("wallet-") { walletEditor?.settle() }
        if action.action.hasPrefix("text-") { textEditor?.settle() }
        if action.action.hasPrefix("task-") { taskEditor?.settle() }
        if action.action == "memory-review" { memoryEditor?.settle() }
        if let editorAction { _ = editor?.settle(editorAction); self.editorAction = nil }
        searchDidSettle?(action)
        return true
    }
    func clear() {
        retireWalletEditor()
        retireTextEditor()
        retireMemoryEditor()
        retireTaskEditor()
        active = false; pending = nil; emit = nil; canInteract = nil; canInteractDetail = nil; scrolled = nil; editor?.clear(); editor = nil; emitEdit = nil
        let scrub = scrubSearch; scrubSearch = nil; searchDidSettle = nil; searchOwner = nil; scrub?()
        searchField?.unmarkText(); searchField?.resignFirstResponder(); searchField?.text = ""; searchField?.undoManager?.removeAllActions()
        state.sections = []; state.navigation = nil; state.textEditor = nil; state.calendarDate = nil; state.launcher = nil; state.tabs = nil; state.secondaryTabs = nil; state.search = nil; state.circleEditor = nil; state.wallet = nil; state.walletProfileEditor = nil; state.memoryEditor = nil; state.taskEditor = nil; state.feedback = nil; state.title = ""
    }
}
/// Local safety gesture only; the feature's existing trigger remains the sole
/// authority for recipient refresh, encryption and delivery.
@available(iOS 26.0, *) private struct NativeLocationSafetyControl: View {
    let label: String; let mode: String; let enabled: Bool; let revision: () -> Int; let trigger: () -> Bool
    @Environment(\.scenePhase) private var scenePhase
    @State private var started: Date?
    @State private var countdown: Task<Void, Never>?
    @State private var fired = false
    @State private var armedRevision: Int?
    private func cancel() { countdown?.cancel(); countdown = nil; started = nil; armedRevision = nil }
    private func complete() {
        guard enabled, scenePhase == .active, !fired, armedRevision == revision() else { cancel(); return }
        fired = trigger(); cancel()
    }
    private func beginCountdown() {
        guard enabled, !fired else { return }
        if started != nil { cancel(); return }
        started = .now; armedRevision = revision()
        countdown = Task { @MainActor in
            do { try await Task.sleep(for: .seconds(2)) } catch { return }
            guard !Task.isCancelled else { return }; complete()
        }
    }
    var body: some View {
        VStack(spacing: 12) {
            TimelineView(.animation(minimumInterval: 1 / 30, paused: started == nil)) { context in
                let progress = started.map { min(1, max(0, context.date.timeIntervalSince($0) / 2)) } ?? 0
                ZStack {
                    Circle().fill(Color.red.opacity(enabled ? 0.14 : 0.05))
                    Circle().stroke(Color.red.opacity(0.25), lineWidth: 5)
                    Circle().trim(from: 0, to: progress).stroke(.red, style: StrokeStyle(lineWidth: 5, lineCap: .round)).rotationEffect(.degrees(-90))
                    VStack(spacing: 6) { Image(systemName: "sos.circle.fill").font(.system(size: 36)); Text(label).font(.headline).multilineTextAlignment(.center) }.padding(20)
                }.foregroundStyle(enabled ? .red : .secondary).frame(width: 168, height: 168).contentShape(Circle())
            }
            .onLongPressGesture(minimumDuration: 2, maximumDistance: 28, pressing: { pressing in
                guard mode == "hold" else { return }
                if pressing && enabled && !fired { started = .now; armedRevision = revision() } else { started = nil }
            }) { if mode == "hold" { complete() } }
            .onTapGesture { if mode == "countdown" { beginCountdown() } }
            .accessibilityElement(children: .ignore).accessibilityLabel(label).accessibilityAddTraits(.isButton)
            .accessibilityHint(mode == "hold" ? "Hold for two seconds. Release to cancel." : "Starts a two-second countdown. Tap again to cancel.")
            .accessibilityAction { beginCountdown() }
            Text(started == nil ? (mode == "hold" ? "Hold for 2 seconds" : "Tap to send · 2 seconds to cancel") : "Release or tap again to cancel")
                .font(.caption).foregroundStyle(.secondary)
        }.frame(maxWidth: .infinity).padding(20).allowsHitTesting(enabled)
            .onChange(of: enabled) { _, next in cancel(); if next { fired = false } }
            .onChange(of: scenePhase) { _, phase in if phase != .active { cancel() } }
            .onDisappear { cancel() }
    }
}

/// Keep the existing row rendering at a concrete SwiftUI boundary so the
/// section/pager expression does not accumulate every control's generic type.
@available(iOS 26.0, *)
private struct NativeWorkspaceCollectionRow: View {
    let row: NativeDrawerRow
    @ObservedObject var model: NativeWorkspaceModel
    var body: some View {
        if let activation = row.sosActivation {
            NativeLocationSafetyControl(label: row.label, mode: activation, enabled: row.enabled && row.pending != true && model.pending == nil, revision: { model.interactionSequence }) { model.choice("row", row: row.id) }
                .accessibilityIdentifier("native-workspace-row-\(row.id)")
        } else if let formatted = row.formattedText {
            NativeMemoryTextBody(text: formatted, enabled: row.enabled && row.pending != true && model.pending == nil) { model.choice("row", row: $0) }
        } else if row.avatar != nil || row.inlineActions != nil || row.locationShare != nil || row.milestone != nil || row.expanded != nil || row.artworkId == "location-share-pulse" {
            NativeWorkspaceRichRow(row: row, enabled: model.pending == nil, accentHex: model.state.accentHex) { model.choice("row", row: $0) }
        } else if row.toggle == true, let options = row.options, options.count == 2 {
            Toggle(isOn: Binding(get: { options[0].selected }, set: { value in model.choice("row", row: options[value ? 0 : 1].id) })) {
                NativeSettingsRowLabel(row: row, accentHex: model.state.accentHex)
            }.tint(Color(uiColor: HushhNativeControlAppearance.color(model.state.accentHex) ?? .label))
                .padding(.trailing, 16).disabled(!row.enabled || row.pending == true || model.pending != nil)
                .accessibilityIdentifier("native-workspace-row-\(row.id)")
        } else if let options = row.options {
            Menu {
                ForEach(options, id: \.id) { option in
                    Button { model.choice("row", row: option.id) } label: {
                        HStack { Text(option.label); if option.selected { Image(systemName: "checkmark") } }
                    }.disabled(option.selected)
                }
            } label: {
                HStack { NativeSettingsRowLabel(row: row, accentHex: model.state.accentHex); Image(systemName: "chevron.up.chevron.down").font(.caption).foregroundStyle(.secondary).padding(.trailing, 16) }
            }.buttonStyle(.plain).disabled(!row.enabled || row.pending == true || model.pending != nil)
                .accessibilityLabel(row.label).accessibilityValue(options.first(where: \.selected)?.label ?? "")
                .accessibilityIdentifier("native-workspace-row-\(row.id)")
        } else if row.prominent == true {
            Button { model.choice("row", row: row.id) } label: { Text(row.label).font(.body.weight(.semibold)).frame(maxWidth: .infinity).frame(minHeight: 32) }
                .buttonStyle(.borderedProminent).controlSize(.large).padding(16)
                .disabled(!row.enabled || row.pending == true || model.pending != nil)
                .accessibilityIdentifier("native-workspace-row-\(row.id)")
        } else if row.readOnly == true { NativeSettingsRowLabel(row: row, accentHex: model.state.accentHex).accessibilityElement(children: .combine) }
        else {
            Button { model.choice("row", row: row.id) } label: { NativeSettingsRowLabel(row: row, accentHex: model.state.accentHex) }
                .buttonStyle(.plain).disabled(!row.enabled || row.pending == true)
                .accessibilityLabel(row.label).accessibilityValue([row.detail, row.trailing].compactMap { $0 }.joined(separator: ", "))
                .accessibilityAddTraits(row.selected == true ? .isSelected : [])
                .accessibilityIdentifier("native-workspace-row-\(row.id)")
        }
    }
}
@available(iOS 26.0, *) private struct NativeWorkspaceBody: View {
    @ObservedObject var model: NativeWorkspaceModel
    @State private var scrollingFromPerson = false
    var body: some View {
        Group {
        if model.state.wallet != nil { NativeWalletWorkspaceBody(model: model) } else {
        VStack(spacing: 0) {
            if model.state.workspace != "memory" && model.state.workspace != "consent" && model.state.workspace != "feed" && model.state.workspace != "connect" && model.state.workspace != "email" && model.state.workspace != "mail" && model.state.workspace != "calendar" && model.state.workspace != "finance" && model.state.workspace != "career" && model.state.workspace != "location" && model.state.workspace != "setup" {
                HStack {
                    if model.state.backEnabled {
                        Button { model.choice("back") } label: { Image(systemName: "chevron.left").frame(width: 44, height: 44) }
                            .buttonStyle(.glass).buttonBorderShape(.circle).accessibilityLabel("Back").accessibilityIdentifier("native-workspace-back")
                    }
                    Text(model.state.title).font(.title2.bold()).frame(maxWidth: .infinity, alignment: .leading).accessibilityAddTraits(.isHeader)
                }.padding(.horizontal, model.state.frame.gutter).padding(.vertical, 8)
            }
            if model.state.isLocationRoot, let header = model.state.sections.first {
                NativeLocationHeader(rows: header.rows, enabled: model.pending == nil, accentHex: model.state.accentHex) { model.choice("row", row: $0) }
                    .padding(.horizontal, model.state.frame.gutter).padding(.bottom, 8)
            }
            if let tabs = model.state.tabs {
                NativeWorkspaceTabStrip(tabs: tabs, model: model, identifier: "native-workspace-tabs")
                    .padding(.horizontal, model.state.frame.gutter).padding(.bottom, 8)
            }
            if let tabs = model.state.secondaryTabs {
                NativeWorkspaceTabStrip(tabs: tabs, model: model, identifier: "native-workspace-secondary-tabs")
                    .padding(.horizontal, model.state.frame.gutter).padding(.bottom, 8)
            }
            if let search = model.state.search, search.afterSection == nil {
                NativeWorkspaceSearchField(model: model, search: search).padding(.horizontal, model.state.frame.gutter).padding(.bottom, 8)
            }
            if let editor = model.editor {
                NativeWorkspaceCircleForm(model: editor, gutter: model.state.frame.gutter).padding(.bottom, model.state.frame.bottomClearance)
            } else {
            ScrollViewReader { position in
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    if let search = model.state.search, search.afterSection == 0 {
                        NativeWorkspaceSearchField(model: model, search: search)
                    }
                    if let date = model.state.calendarDate { NativeWorkspaceCalendarDatePicker(model: model, control: date) }
                    if let taskEditor = model.taskEditor { NativeWorkspaceTaskForm(model: taskEditor.model) }
                    if let memoryEditor = model.memoryEditor {
                        NativeWorkspaceMemoryForm(model: memoryEditor.model)
                    }
                    if let launcher = model.state.launcher { NativeWorkspaceAgentRoster(model: model, launcher: launcher) }
                    ForEach(Array(model.state.sections.enumerated()).filter { !(model.state.isLocationRoot && $0.offset == 0) }, id: \.element.id) { sectionIndex, section in
                        VStack(alignment: .leading, spacing: 6) {
                            if let title = section.title { Text(title).font(.subheadline).foregroundStyle(.secondary).padding(.horizontal, 6).accessibilityAddTraits(.isHeader) }
                            if section.layout == "tiles" {
                                NativeLocationActionTiles(rows: section.rows, enabled: model.pending == nil, accentHex: model.state.accentHex) { model.choice("row", row: $0) }
                            } else {
                            VStack(spacing: section.layout == "cards" ? 10 : 0) {
                                ForEach(Array(section.rows.enumerated()), id: \.element.id) { index, row in
                                    NativeWorkspaceCollectionRow(row: row, model: model).background(section.layout == "cards" ? Color(uiColor: .secondarySystemGroupedBackground) : .clear, in: RoundedRectangle(cornerRadius: 18))
                                    if section.layout == nil && index < section.rows.count - 1 && !(row.formattedText != nil && section.rows[index + 1].formattedText != nil) { Divider().padding(.horizontal, 16) }
                                }
                            }.background(section.layout == "cards" ? .clear : Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
                            }
                        }
                        if let search = model.state.search, search.afterSection == sectionIndex + 1 {
                            NativeWorkspaceSearchField(model: model, search: search)
                        }
                    }
                    if let textEditor = model.textEditor { NativeWorkspaceTextForm(model: textEditor.model) }
                }.id("native-workspace-content-top").padding(.horizontal, model.state.frame.gutter).padding(.top, 8).padding(.bottom, 24 + model.state.frame.bottomClearance)
            }.background(Color(uiColor: model.canvasColor))
                .id(model.state.navigation?.id ?? "workspace-content")
                .transition(.asymmetric(
                    insertion: .move(edge: model.navigationForward ? .trailing : .leading),
                    removal: .move(edge: model.navigationForward ? .leading : .trailing)))
                .scrollDismissesKeyboard(.interactively).accessibilityIdentifier("native-workspace-scroll")
                .contentMargins(.bottom, model.state.frame.bottomClearance, for: .scrollIndicators)
                .onScrollPhaseChange { _, phase in scrollingFromPerson = phase == .interacting || phase == .decelerating }
                .onScrollGeometryChange(for: CGFloat.self, of: { max(0, $0.contentOffset.y + $0.contentInsets.top) }) { _, value in model.scrolled?(value, scrollingFromPerson) }
                .onChange(of: model.state.sections.first(where: { $0.layout == "cards" })?.rows.first?.id) { _, _ in
                    position.scrollTo("native-workspace-content-top", anchor: .top)
                }
            }.clipped()
                .animation(UIAccessibility.isReduceMotionEnabled ? nil : .snappy(duration: 0.24), value: model.state.navigation?.id)
            }
        }
        }
        }.background(Color(uiColor: model.canvasColor))
            // Keep transient feedback in the owning native surface without
            // covering Wallet's title, tabs, or first actionable row.
            .safeAreaInset(edge: .top, spacing: 8) {
                if model.state.wallet?.selectedId == nil, let feedback = model.state.feedback {
                    NativeTextFeedbackBanner(message: feedback.message, tone: feedback.tone, dismissible: feedback.dismissible,
                        actionLabel: feedback.actionLabel, dismiss: { model.choice("feedback-dismiss", row: feedback.id) },
                        activate: { if let token = feedback.actionToken { model.choice("feedback-action", row: feedback.id, actionToken: token) } })
                        .padding(.horizontal, model.state.frame.gutter).padding(.top, 8)
                }
            }
            .tint(Color(uiColor: HushhNativeControlAppearance.color(model.state.accentHex) ?? .label))
            .preferredColorScheme(model.state.appearance == "dark" ? .dark : .light)
            .disabled(!model.active || !model.state.enabled)
    }
}
/// Both navigation levels use the same native control; React supplies the
/// acknowledged selection and each opaque action remains lifetime-fenced.
@available(iOS 26.0, *)
struct NativeWorkspaceTabStrip: View {
    let tabs: NativeWorkspaceTabs
    @ObservedObject var model: NativeWorkspaceModel
    let identifier: String
    var body: some View {
        Picker(tabs.label, selection: Binding(get: { tabs.options.first(where: \.selected)?.id ?? "" },
            set: { model.choice("row", row: $0) })) {
            ForEach(tabs.options, id: \.id) { option in Text(option.label).tag(option.id) }
        }.pickerStyle(.segmented).controlSize(.large).frame(minHeight: 44)
            .disabled(!model.active || !model.state.enabled || model.pending != nil)
            .accessibilityIdentifier(identifier)
    }
}
@available(iOS 26.0, *) private struct NativeWorkspaceCalendarDatePicker: View {
    @ObservedObject var model: NativeWorkspaceModel
    let control: NativeWorkspaceCalendarDate
    @State private var selection = Date()
    private func restore() { if let date = control.date { selection = date } }
    var body: some View {
        DatePicker(control.label, selection: Binding(get: { selection }, set: { value in
            let previous = selection; selection = value
            if !model.choice("row", row: control.id, text: control.formatter.string(from: value)) { selection = previous }
        }), displayedComponents: .date)
            .environment(\.timeZone, TimeZone(identifier: control.timeZone) ?? .current)
            .disabled(!control.enabled || model.pending != nil)
            .onAppear { restore() }
            .onChange(of: control.value) { _, _ in restore() }
            .onChange(of: model.pending == nil) { _, settled in if settled { restore() } }
            .accessibilityIdentifier("native-calendar-date")
    }
}

@available(iOS 26.0, *) private struct NativeWorkspaceAgentRoster: View {
    @ObservedObject var model: NativeWorkspaceModel
    let launcher: NativeWorkspaceLauncher
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        Group {
            if launcher.view == "grid" {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), alignment: .top), count: typeSize.isAccessibilitySize ? 2 : 3), spacing: 24) {
                    ForEach(launcher.agents, id: \.id) { agent in item(agent, grid: true) }
                }.padding(16)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(launcher.agents.enumerated()), id: \.element.id) { index, agent in
                        item(agent, grid: false)
                        if index < launcher.agents.count - 1 { Divider().padding(.leading, 58) }
                    }
                }
            }
        }.background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20))
    }
    private func item(_ agent: NativeWorkspaceAgent, grid: Bool) -> some View {
        Button { model.choice("row", row: agent.id) } label: {
            Group {
                if grid {
                    VStack(spacing: 8) {
                        icon(agent).frame(width: 36, height: 36).frame(width: 60, height: 60)
                        Text(agent.label).font(.subheadline.weight(.medium)).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                        Text("\(agent.metricValue) \(agent.metricLabel)").font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                    }.frame(maxWidth: .infinity).frame(minHeight: 108, alignment: .top)
                } else {
                    HStack(spacing: 12) {
                        icon(agent).frame(width: 28, height: 28).frame(width: 40, height: 40)
                        Text(agent.label).font(.body).fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 8)
                        Text("\(agent.metricValue) \(agent.metricLabel)").font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.trailing)
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                    }.padding(12).frame(minHeight: 56)
                }
            }.foregroundStyle(Color(uiColor: .label)).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityElement(children: .ignore)
            .accessibilityLabel("Open \(agent.label)").accessibilityValue("\(agent.metricValue) \(agent.metricLabel)")
            .accessibilityHint(agent.description).accessibilityIdentifier("native-launcher-agent-\(agent.id)")
    }
    @ViewBuilder private func icon(_ agent: NativeWorkspaceAgent) -> some View {
        if let artwork = NativeProfileArtwork.resolve(agent.artworkId) {
            Image(uiImage: artwork.base).resizable().scaledToFit()
                .foregroundStyle(Color(uiColor: HushhNativeControlAppearance.color(artwork.colorHex ?? agent.iconHex) ?? .label))
        }
    }
}

@available(iOS 26.0, *) private struct NativeWorkspaceTaskForm: View {
    @ObservedObject var model: NativeProfileEditorModel<NativeWorkspaceTaskProjection>
    private func formatter(_ format: String) -> DateFormatter {
        let result = DateFormatter(); result.locale = Locale(identifier: "en_US_POSIX"); result.calendar = Calendar(identifier: .gregorian)
        result.dateFormat = format; return result
    }
    private func date(_ field: String, format: String) -> Binding<Date> {
        Binding(get: { formatter(format).date(from: model.draft[field]) ?? Date() },
                set: { value in model.change { $0[field] = formatter(format).string(from: value) } })
    }
    private func enabled(_ field: String, format: String) -> Binding<Bool> {
        Binding(get: { !model.draft[field].isEmpty }, set: { value in
            model.change { $0[field] = value ? formatter(format).string(from: Date()) : "" }
        })
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Title").font(.subheadline).foregroundStyle(.secondary)
            NativeProfilePrivateField(model: model, name: "title", label: "What do you want to do?", maximum: 240, identifier: "native-task-title")
                .frame(minHeight: 44).padding(.horizontal, 12)
                .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
            Toggle("Date", isOn: enabled("date", format: "yyyy-MM-dd")).accessibilityIdentifier("native-task-date-enabled")
            if !model.draft.date.isEmpty {
                DatePicker("Date", selection: date("date", format: "yyyy-MM-dd"), displayedComponents: .date)
                    .accessibilityIdentifier("native-task-date")
            }
            Toggle("Time", isOn: enabled("time", format: "HH:mm")).accessibilityIdentifier("native-task-time-enabled")
            if !model.draft.time.isEmpty {
                DatePicker("Time", selection: date("time", format: "HH:mm"), displayedComponents: .hourAndMinute)
                    .accessibilityIdentifier("native-task-time")
            }
            Text("Notes").font(.subheadline).foregroundStyle(.secondary)
            NativeProfilePrivateText(model: model, name: "notes", label: "Notes", maximum: 1200, identifier: "native-task-notes")
                .frame(minHeight: 100).padding(12)
                .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
            HStack {
                Button("Cancel") { model.action("cancel") }.buttonStyle(.glass).disabled(!model.canCancel).accessibilityIdentifier("native-task-cancel")
                Spacer()
                Button { model.action("save") } label: {
                    HStack { if model.projection.busy { ProgressView() }; Text(model.projection.busy ? "Saving…" : "Save") }.frame(minHeight: 44)
                }.buttonStyle(.glassProminent).disabled(!model.canSave).accessibilityIdentifier("native-task-save")
            }
            if let error = model.projection.error { Text(error).foregroundStyle(.red).accessibilityAddTraits(.updatesFrequently) }
        }.disabled(!model.canEdit)
    }
}
/// Formatting may insert separators before the caret; keep its code-character
/// position instead of restoring the old UTF-16 offset into the formatted value.
enum NativeCircleCodeSelection {
    static func restore(_ old: String, _ next: String, _ range: NSRange) -> NSRange {
        let previous = Array(old.utf16), formatted = Array(next.utf16)
        func isCode(_ unit: UInt16) -> Bool { (48...57).contains(unit) || (65...90).contains(unit) || (97...122).contains(unit) }
        func offset(_ count: Int) -> Int {
            if count == 0 { return 0 }
            var seen = 0
            for (index, unit) in formatted.enumerated() where isCode(unit) {
                seen += 1; if seen == count { return index + 1 }
            }
            return formatted.count
        }
        let start = min(range.location, previous.count), end = start + min(range.length, previous.count - start)
        let mappedStart = offset(previous.prefix(start).filter(isCode).count)
        let mappedEnd = offset(previous.prefix(end).filter(isCode).count)
        return NSRange(location: mappedStart, length: max(0, mappedEnd - mappedStart))
    }
}
@available(iOS 26.0, *) private struct NativeWorkspaceTextForm: View {
    @ObservedObject var model: NativeProfileEditorModel<NativeWorkspaceTextProjection>
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.projection.label).font(.subheadline.weight(.medium))
            NativeProfilePrivateText(model: model, name: "text", label: model.projection.label, maximum: 4096, identifier: "native-location-text",
                restoreSelection: model.projection.format == "circle-code" ? NativeCircleCodeSelection.restore : nil,
                autocorrection: model.projection.format == "circle-code" ? .no : .default)
                .frame(minHeight: 92).padding(12).background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
                .overlay(alignment: .topLeading) {
                    if model.draft.text.isEmpty { Text(model.projection.placeholder).foregroundStyle(.secondary).padding(16).allowsHitTesting(false).accessibilityHidden(true) }
                }
            Text("\(model.draft.text.utf16.count) / \(model.projection.maximum)").font(.caption).foregroundStyle(model.draft.text.utf16.count > model.projection.maximum ? .red : .secondary)
            if let error = model.projection.error { Text(error).font(.subheadline).foregroundStyle(.red) }
            Button { model.action("save") } label: {
                HStack { if model.projection.busy { ProgressView() }; Text(model.projection.submitLabel) }.frame(maxWidth: .infinity).frame(minHeight: 44)
            }.buttonStyle(.glassProminent).disabled(!model.canSave || model.draft.text.utf16.count > model.projection.maximum).accessibilityIdentifier("native-location-submit")
            Button { model.action("cancel") } label: {
                Text(model.projection.cancelLabel).frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
            }.buttonStyle(.plain).foregroundStyle(Color(uiColor: model.accent))
                .disabled(!model.canCancel).accessibilityIdentifier("native-location-cancel")
        }
    }
}
@available(iOS 26.0, *) private struct NativeWorkspaceMemoryForm: View {
    @ObservedObject var model: NativeProfileEditorModel<NativeWorkspaceMemoryProjection>
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            NativeProfilePrivateText(model: model, name: "text", label: "Memory note", maximum: 50_000, identifier: "native-memory-capture-note")
                .frame(minHeight: 140)
                .padding(12)
                .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
                .overlay(alignment: .topLeading) {
                    if model.draft.text.isEmpty {
                        Text("I prefer morning flights whenever possible.")
                            .foregroundStyle(.secondary).padding(.horizontal, 12).padding(.vertical, 20)
                            .allowsHitTesting(false).accessibilityHidden(true)
                    }
                }
            Toggle(isOn: Binding(get: { model.draft.identifierApproved }, set: { approved in
                guard model.projection.canToggleIdentifier else { return }
                model.change { $0.identifierApproved = approved }
            })) {
                Text("Allow my private agent’s configured model to process personal identifiers in this note, including SSN, to prepare Memory. Sharing requires a separate approval.")
                    .font(.subheadline)
            }.disabled(!model.canEdit || model.composing || !model.projection.canToggleIdentifier)
                .accessibilityIdentifier("native-memory-capture-identifier-approval")
            Button { model.action("save") } label: {
                HStack {
                    if model.projection.reviewing { ProgressView() }
                    Text(model.projection.reviewing ? "Reviewing…" : "Review memory")
                }.frame(maxWidth: .infinity).frame(minHeight: 44)
            }.buttonStyle(.glassProminent).disabled(!model.canSave)
                .accessibilityIdentifier("native-memory-capture-review")
            if let error = model.projection.error {
                Text(error).foregroundStyle(.red).accessibilityAddTraits(.updatesFrequently)
            }
        }
    }
}
@available(iOS 26.0, *) private struct NativeWorkspaceCircleForm: View {
    @ObservedObject var model: NativeProfileEditorModel<NativeWorkspaceCircleProjection>
    let gutter: CGFloat
    var body: some View {
        Form {
            Section("Circle name") {
                NativeProfilePrivateField(model: model, name: "name", label: "Circle name", maximum: 80, identifier: "native-referral-circle-name").frame(minHeight: 44)
            }
            Picker("Circle type", selection: Binding(get: { model.draft.kind }, set: { value in model.change { $0.kind = value } })) {
                Text("Family").tag("family"); Text("Friends").tag("friends"); Text("Other").tag("other")
            }.pickerStyle(.segmented).disabled(!model.canEdit || model.composing).accessibilityIdentifier("native-referral-circle-kind")
            if model.draft.kind == "other", let types = model.projection.customTypes {
                Section("Type name") {
                    if !types.isEmpty {
                        Picker("Existing type", selection: Binding(get: { types.contains(model.draft.customTypeLabel ?? "") ? model.draft.customTypeLabel! : "" }, set: { value in model.change { $0.customTypeLabel = value } })) {
                            Text("New type").tag("")
                            ForEach(types, id: \.self) { Text($0).tag($0) }
                        }.disabled(!model.canEdit || model.composing)
                    }
                    NativeProfilePrivateField(model: model, name: "customTypeLabel", label: "Type name", maximum: 32, identifier: "native-connect-circle-type-name").frame(minHeight: 44)
                }
            }
            if let error = model.projection.error { Text(error).foregroundStyle(.red).accessibilityAddTraits(.updatesFrequently) }
            Section {
                Button(model.projection.busy ? "Saving…" : "Next") { model.action("save") }.disabled(!model.canSave).accessibilityIdentifier("native-referral-circle-next")
                Button("Cancel") { model.action("cancel") }.disabled(!model.canCancel)
            }
        }.contentMargins(.horizontal, gutter, for: .scrollContent).scrollContentBackground(.hidden)
    }
}
@available(iOS 26.0, *) private struct NativeWorkspaceSearchField: View {
    @ObservedObject var model: NativeWorkspaceModel
    let search: NativeWorkspaceSearch
    @ScaledMetric(relativeTo: .body) private var height: CGFloat = 44
    var body: some View {
        NativeWorkspaceSearchInput(model: model, search: search).padding(.horizontal, 14).frame(height: height).glassEffect(.regular, in: Capsule())
    }
}
@available(iOS 26.0, *) private struct NativeWorkspaceSearchInput: UIViewRepresentable {
    let model: NativeWorkspaceModel; let search: NativeWorkspaceSearch
    func makeUIView(context: Context) -> NativeWorkspaceSearchControl { NativeWorkspaceSearchControl(model: model, search: search) }
    func updateUIView(_ view: NativeWorkspaceSearchControl, context: Context) { view.update(search) }
    static func dismantleUIView(_ view: NativeWorkspaceSearchControl, coordinator: ()) { view.scrub() }
}
@available(iOS 26.0, *) @MainActor final class NativeWorkspaceSearchControl: UIStackView, UITextFieldDelegate {
    private weak var model: NativeWorkspaceModel?
    private var search: NativeWorkspaceSearch
    private let field = UITextField()
    private let clear = UIButton(type: .system)
    // The focused field owns immediate edits. The model receives only the
    // latest committed value, never marked-text composition or a stale echo.
    private var desiredLiveQuery: String?
    private var lastInput: String
    private var submittedSequence: Int?
    private var submittedRevision = -1
    private var queuedRevision = -1
    private var observedRevision: Int
    private var retired = false
    init(model: NativeWorkspaceModel, search: NativeWorkspaceSearch) {
        self.model = model; self.search = search; lastInput = search.query; observedRevision = model.state.updateSequence; super.init(frame: .zero)
        axis = .horizontal; spacing = 8; alignment = .center
        let icon = UIImageView(image: UIImage(systemName: "magnifyingglass")); icon.tintColor = .secondaryLabel; icon.isAccessibilityElement = false
        addArrangedSubview(icon); icon.widthAnchor.constraint(equalToConstant: 20).isActive = true
        field.delegate = self; field.font = .preferredFont(forTextStyle: .body); field.adjustsFontForContentSizeCategory = true
        field.autocapitalizationType = .none; field.autocorrectionType = .no; field.returnKeyType = .search
        field.text = search.query; field.placeholder = search.label; field.accessibilityLabel = search.label; field.accessibilityIdentifier = "native-workspace-search"
        field.addTarget(self, action: #selector(changed), for: .editingChanged); field.setContentHuggingPriority(.defaultLow, for: .horizontal); addArrangedSubview(field)
        clear.setImage(UIImage(systemName: "xmark.circle.fill"), for: .normal); clear.accessibilityLabel = "Clear search"
        clear.addTarget(self, action: #selector(clearSearch), for: .touchUpInside); addArrangedSubview(clear)
        clear.widthAnchor.constraint(equalToConstant: 44).isActive = true; clear.heightAnchor.constraint(equalToConstant: 44).isActive = true
        model.searchField = field; model.searchOwner = ObjectIdentifier(self)
        model.searchDidSettle = { [weak self] in self?.didSettle($0) }
        model.scrubSearch = { [weak self] in self?.scrub() }
        clear.isHidden = field.text?.isEmpty != false
    }
    required init(coder: NSCoder) { fatalError("Native workspace search is programmatic") }
    func update(_ next: NativeWorkspaceSearch) {
        guard !retired else { return }
        if next.id != search.id {
            desiredLiveQuery = nil; submittedSequence = nil; submittedRevision = -1; queuedRevision = -1
        }
        if field.markedTextRange == nil && (next.id != search.id || (desiredLiveQuery == nil && field.text == search.query)) {
            field.text = next.query; lastInput = next.query
        }
        search = next; field.placeholder = next.label; field.accessibilityLabel = next.label; field.textColor = .label
        field.tintColor = HushhNativeControlAppearance.color(model?.state.accentHex ?? "") ?? .label
        clear.isHidden = field.text?.isEmpty != false
        guard let revision = model?.state.updateSequence, revision > observedRevision else { return }
        observedRevision = revision
        if desiredLiveQuery == next.query && submittedSequence == nil { desiredLiveQuery = nil }
        DispatchQueue.main.async { [weak self] in self?.flushLive(allowSameRevision: false) }
    }
    @objc private func changed() {
        clear.isHidden = field.text?.isEmpty != false
        queueCommittedEdit()
    }
    private func queueCommittedEdit() {
        guard !retired, search.live == true, field.markedTextRange == nil, let model, model.active, model.state.search?.id == search.id else { return }
        let value = field.text ?? ""
        guard value != lastInput else { return }
        lastInput = value; desiredLiveQuery = value
        queuedRevision = submittedSequence == nil ? model.state.updateSequence : submittedRevision
        flushLive(allowSameRevision: true)
    }
    private func flushLive(allowSameRevision: Bool) {
        guard !retired, search.live == true, field.markedTextRange == nil, let model, model.active,
              model.searchOwner == ObjectIdentifier(self), model.state.search?.id == search.id,
              model.pending == nil, submittedSequence == nil, let value = desiredLiveQuery else { return }
        if value == model.state.search?.query { desiredLiveQuery = nil; return }
        guard allowSameRevision || model.state.updateSequence > submittedRevision else { return }
        let revision = model.state.updateSequence
        if model.choice("row", row: search.id, text: value) {
            submittedSequence = model.pending?.sequence; submittedRevision = revision
        }
    }
    func didSettle(_ action: NativeWorkspaceAction) {
        guard !retired, search.live == true else { return }
        if action.sequence == submittedSequence { submittedSequence = nil }
        // Settlement alone is not proof that JS applied the value. Retry only
        // after a newer projection, a later edit, or an explicit submit.
        guard desiredLiveQuery != nil, let revision = model?.state.updateSequence,
              revision > max(submittedRevision, queuedRevision) else { return }
        DispatchQueue.main.async { [weak self] in self?.flushLive(allowSameRevision: false) }
    }
    @objc private func clearSearch() {
        field.unmarkText(); field.text = ""; changed()
        if search.live != true { submit() }
    }
    private func submit() {
        guard !retired, field.markedTextRange == nil, let model, model.state.search?.id == search.id else { return }
        if search.live == true {
            desiredLiveQuery = field.text ?? ""; lastInput = field.text ?? ""; queuedRevision = model.state.updateSequence
            flushLive(allowSameRevision: true)
        } else { _ = model.choice("row", row: search.id, text: field.text ?? "") }
    }
    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        guard textField.markedTextRange == nil else { return false }
        submit()
        if search.live == true && ["memory", "consent", "connect", "mail"].contains(model?.state.workspace ?? "") { textField.resignFirstResponder() }
        return false
    }
    func textFieldDidChangeSelection(_ textField: UITextField) { queueCommittedEdit() }
    func textField(_ textField: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
        guard model?.active == true, let text = textField.text, let span = Range(range, in: text) else { return false }
        return text.replacingCharacters(in: span, with: string).utf16.count <= 256
    }
    func textField(_ textField: UITextField, willPresentEditMenuWith animator: any UIEditMenuInteractionAnimating) { model?.searchMenus.presented(textField) }
    func textField(_ textField: UITextField, willDismissEditMenuWith animator: any UIEditMenuInteractionAnimating) {
        guard let menus = model?.searchMenus, let token = menus.beginDismissal(textField) else { return }
        animator.addCompletion { menus.dismissed(textField, token: token) }
    }
    func scrub() {
        guard !retired else { return }; retired = true
        desiredLiveQuery = nil; submittedSequence = nil; lastInput = ""
        if model?.searchOwner == ObjectIdentifier(self) { model?.searchOwner = nil; model?.searchDidSettle = nil; model?.scrubSearch = nil }
        field.unmarkText(); field.resignFirstResponder(); field.text = ""; field.undoManager?.removeAllActions()
        if model?.searchMenus.detach(field) != true { field.delegate = nil }
        search = NativeWorkspaceSearch(id: search.id, query: "", label: search.label)
    }
}
@MainActor final class NativeWorkspacePresentation {
    static let installationID = "route-workspace"
    let model: NativeWorkspaceModel
    private let host: UIViewController
    private var walletPanel: NativeWalletPanelPresentation?
    var coverage: (() -> Void)?
    var coversPresentation: Bool { walletPanel?.coversPresentation == true || model.hasRetiringEditorPresentations || retiring && host.parent != nil }
    // Add borrows only the settled Wallet parent, including its current detail.
    var feedbackPresenter: UIViewController? { ready && !retiring ? (model.state.wallet?.selectedId == nil ? host : walletPanel?.feedbackPresenter) : nil }
    var walletFormParent: UIViewController? {
        guard !retiring, ready, model.state.workspace == "wallet", let wallet = model.state.wallet else { return nil }
        if wallet.selectedId == nil { return !coversPresentation ? host : nil }
        guard wallet.navigation != nil, !wallet.detailBusy, model.walletEditor == nil,
              let detail = walletPanel?.feedbackPresenter, detail.viewIfLoaded?.window != nil,
              detail.presentedViewController == nil else { return nil }
        return detail
    }
    var permitsWalletForm: Bool { walletFormParent != nil }
    func setExternalCoverage(_ covered: Bool) { walletPanel?.setExternalCoverage(covered) }
    func prepare(completion: @escaping (Bool) -> Void) {
        model.afterEditorRetirement { [weak self] in
            guard let self else { completion(false); return }; self.refresh()
            guard let walletPanel = self.walletPanel else { completion(self.ready); return }
            walletPanel.prepare { [weak self] settled in completion(settled && self?.ready == true) }
        }
    }
    private weak var container: NativePresentationContainer?
    private var retiring = false
    private var retirement = [() -> Void]()
    private var menusDismissed = false
    private var presentationsDismissed = false
    var ready: Bool { (walletPanel?.ready ?? true) && model.active && model.presentationComplete && host.parent != nil && host.viewIfLoaded?.window != nil && host.viewIfLoaded?.superview != nil }
    init?(_ state: NativeWorkspaceProjection, parent: UIViewController, container: NativePresentationContainer) {
        guard #available(iOS 26.0, *) else { return nil }
        model = NativeWorkspaceModel(state)
        host = UIHostingController(rootView: NativeWorkspaceBody(model: model))
        self.container = container
        walletPanel = NativeWalletPanelPresentation(model: model, parent: parent)
        walletPanel?.coverage = { [weak self] in self?.coverage?() }
        model.canInteractDetail = { [weak self] visit, dismissed in self?.walletPanel?.allows(visit, dismissed: dismissed) == true }
        host.view.backgroundColor = model.canvasColor
        host.view.accessibilityIdentifier = "native-route-workspace"
        parent.addChild(host)
        container.install(host.view, id: Self.installationID, group: nil)
        container.ownWorkspaceScroll(state.identity)
        host.view.frame = state.frame.rect
        host.didMove(toParent: parent)
        model.canInteract = { [weak container, weak model] in
            guard let container, let model else { return false }
            let privacy = HushhSessionPrivacyShield.shared.snapshot()
            return model.active && container.allowsControl(Self.installationID) && container.isolationGeneration == model.state.isolationGeneration && privacy.appIsActive && !privacy.shielded && privacy.generation == model.state.privacyGeneration
        }
        model.scrolled = { [weak container, weak model] y, fromPerson in
            guard let model, model.active else { return }; container?.reportWorkspaceScroll(model.state.identity, y: y, fromPerson: fromPerson)
        }
        model.editorRetirementChanged = { [weak self] in self?.coverage?() }
        refresh()
    }
    func refresh() {
        host.overrideUserInterfaceStyle = model.state.appearance == "dark" ? .dark : .light
        host.view.backgroundColor = model.canvasColor
        host.view.frame = model.state.frame.rect; host.view.setNeedsLayout(); host.view.layoutIfNeeded()
        container?.setAdmission(Self.installationID, admitted: model.state.enabled && container?.isolationGeneration == model.state.isolationGeneration)
        model.textEditor?.model.setPresentationEnabled(model.state.enabled && model.canInteract?() == true)
        model.taskEditor?.model.setPresentationEnabled(model.state.enabled && model.canInteract?() == true)
        model.memoryEditor?.model.setPresentationEnabled(model.state.enabled && model.canInteract?() == true)
    }
    func retire(completion: @escaping () -> Void) {
        retirement.append(completion)
        guard !retiring else { return }; retiring = true
        let menus = DispatchGroup()
        if let walletPanel { menus.enter(); walletPanel.retire { menus.leave() } }
        if let editor = model.walletEditor { menus.enter(); editor.model.dismissEditorMenus { menus.leave() } }
        if let editor = model.textEditor { menus.enter(); editor.model.dismissEditorMenus { menus.leave() } }
        if let editor = model.taskEditor { menus.enter(); editor.model.dismissEditorMenus { menus.leave() } }
        if let editor = model.memoryEditor { menus.enter(); editor.model.dismissEditorMenus { menus.leave() } }
        if let editor = model.editor { menus.enter(); editor.dismissEditorMenus { menus.leave() } }
        menus.enter(); model.searchMenus.dismiss(model.searchField.map { [$0] } ?? []) { menus.leave() }
        container?.releaseWorkspaceScroll(model.state.identity)
        model.clear(); menus.enter(); model.afterEditorRetirement { menus.leave() }; host.view.endEditing(true); host.willMove(toParent: nil)
        menus.notify(queue: .main) { [self] in menusDismissed = true; finishRetirementIfReady() }
        func dismissOwnedPresentation(_ completion: @escaping () -> Void) {
            guard host.presentedViewController != nil else { completion(); return }
            host.dismiss(animated: false, completion: completion)
        }
        dismissOwnedPresentation { [self] in presentationsDismissed = true; finishRetirementIfReady() }
    }
    private func finishRetirementIfReady() {
        guard menusDismissed, presentationsDismissed else { return }
        container?.remove(Self.installationID); host.removeFromParent()
        guard host.parent == nil, host.view.superview == nil else { return }
        // Detachment changes coverage after the last child-sheet callback.
        // Reconcile before acknowledging retirement so returning routes do not
        // inherit the departing workspace's touch/accessibility isolation.
        coverage?()
        let callbacks = retirement; retirement.removeAll(); callbacks.forEach { $0() }
    }
}
