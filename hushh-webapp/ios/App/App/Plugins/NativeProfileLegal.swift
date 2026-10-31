import SwiftUI

/// Complete Legal content from the existing authored documents. No URL, route,
/// executable schema or persistence belongs to this presentation replica.
struct NativeLegalInline: Codable {
    let text: String
    var actionId: String? = nil
}

enum NativeLegalBlock: Codable {
    case paragraph([NativeLegalInline]), heading(String), list([[NativeLegalInline]])
    private enum Keys: String, CodingKey { case kind, text, items }
    init(from decoder: Decoder) throws {
        let value = try decoder.container(keyedBy: Keys.self)
        switch try value.decode(String.self, forKey: .kind) {
        case "p": self = .paragraph(try value.decode([NativeLegalInline].self, forKey: .text))
        case "h": self = .heading(try value.decode(String.self, forKey: .text))
        case "list": self = .list(try value.decode([[NativeLegalInline]].self, forKey: .items))
        default: throw DecodingError.dataCorruptedError(forKey: .kind, in: value, debugDescription: "Unsupported Legal block")
        }
    }
    func encode(to encoder: Encoder) throws {
        var value = encoder.container(keyedBy: Keys.self)
        switch self {
        case .paragraph(let parts): try value.encode("p", forKey: .kind); try value.encode(parts, forKey: .text)
        case .heading(let text): try value.encode("h", forKey: .kind); try value.encode(text, forKey: .text)
        case .list(let items): try value.encode("list", forKey: .kind); try value.encode(items, forKey: .items)
        }
    }
    var inlineGroups: [[NativeLegalInline]] {
        switch self { case .paragraph(let parts): return [parts]; case .heading: return []; case .list(let items): return items }
    }
}

struct NativeLegalSection: Codable, Identifiable {
    let id: String
    let title: String
    let blocks: [NativeLegalBlock]
}
struct NativeLegalRelated: Codable {
    let label: String
    let actionId: String
}
struct NativeLegalDocument: Codable {
    let type: String
    let version: String
    let effectiveDate: String
    let summary: String
    let sections: [NativeLegalSection]
    let related: NativeLegalRelated
    var actionIds: [String] {
        [related.actionId] + sections.flatMap { $0.blocks.flatMap { $0.inlineGroups.flatMap { $0.compactMap(\.actionId) } } }
    }
    static func hasClosedShape(_ value: [String: Any]) -> Bool {
        guard Set(value.keys).isSubset(of: ["type", "version", "effectiveDate", "summary", "sections", "related"]),
              let related = value["related"] as? [String: Any], Set(related.keys).isSubset(of: ["label", "actionId"]),
              let sections = value["sections"] as? [[String: Any]] else { return false }
        func inline(_ value: Any?) -> Bool {
            guard let parts = value as? [[String: Any]] else { return false }
            return parts.allSatisfy { Set($0.keys).isSubset(of: ["text", "actionId"]) }
        }
        return sections.allSatisfy { section in
            guard Set(section.keys).isSubset(of: ["id", "title", "blocks"]), let blocks = section["blocks"] as? [[String: Any]] else { return false }
            return blocks.allSatisfy { block in
                switch block["kind"] as? String {
                case "p": return Set(block.keys).isSubset(of: ["kind", "text"]) && inline(block["text"])
                case "h": return Set(block.keys).isSubset(of: ["kind", "text"]) && block["text"] is String
                case "list": return Set(block.keys).isSubset(of: ["kind", "items"]) &&
                    (block["items"] as? [Any]).map { $0.allSatisfy { inline($0) } } == true
                default: return false
                }
            }
        }
    }
    var valid: Bool {
        func text(_ value: String, _ max: Int) -> Bool { !value.isEmpty && value.utf16.count <= max }
        guard ["privacy", "terms"].contains(type), text(version, 32), text(effectiveDate, 128), text(summary, 4096),
              (1...64).contains(sections.count), text(related.label, 256), NativeDrawerIdentity.identifier(related.actionId),
              Set(sections.map(\.id)).count == sections.count, Set(actionIds).count == actionIds.count else { return false }
        var length = 0, blockCount = 0, runCount = 0
        for section in sections {
            guard NativeDrawerIdentity.identifier(section.id), text(section.title, 256), (1...128).contains(section.blocks.count) else { return false }
            for block in section.blocks {
                blockCount += 1
                if case .heading(let title) = block { guard text(title, 256) else { return false }; continue }
                guard (1...128).contains(block.inlineGroups.count) else { return false }
                for group in block.inlineGroups {
                    guard (1...128).contains(group.count) else { return false }
                    for part in group {
                        length += part.text.utf16.count; runCount += 1
                        guard text(part.text, 16384), part.actionId.map(NativeDrawerIdentity.identifier) ?? true else { return false }
                    }
                }
            }
        }
        return blockCount <= 1024 && runCount <= 4096 && length <= 262144
    }
}

struct NativeProfileLegalReader: View {
    @ObservedObject var model: NativeDrawerModel
    let document: NativeLegalDocument
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        ScrollViewReader { scroll in
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    Text(document.summary).foregroundStyle(.secondary)
                    Text("Effective \(document.effectiveDate) · Version \(document.version)")
                        .font(.footnote).foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 0) {
                        Text("On this page").font(.headline).accessibilityAddTraits(.isHeader)
                        ForEach(document.sections) { section in
                            Button { withAnimation(reduceMotion ? nil : .easeOut(duration: 0.15)) { scroll.scrollTo(section.id, anchor: .top) } } label: {
                                Text(section.title).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            }.buttonStyle(.plain).foregroundStyle(.tint)
                                .accessibilityIdentifier("native-legal-contents-\(section.id)")
                        }
                    }
                    ForEach(document.sections) { section in
                        VStack(alignment: .leading, spacing: 12) {
                            Text(section.title).font(.title3.weight(.semibold)).accessibilityAddTraits(.isHeader)
                            ForEach(Array(section.blocks.enumerated()), id: \.offset) { _, block in
                                switch block {
                                case .heading(let title): Text(title).font(.headline).accessibilityAddTraits(.isHeader)
                                case .paragraph(let parts): Text(attributed(parts)).fixedSize(horizontal: false, vertical: true)
                                case .list(let items):
                                    ForEach(Array(items.enumerated()), id: \.offset) { _, parts in
                                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                                            Text("•").accessibilityHidden(true)
                                            Text(attributed(parts)).fixedSize(horizontal: false, vertical: true)
                                        }
                                    }
                                }
                            }
                        }.id(section.id).frame(maxWidth: .infinity, alignment: .leading)
                    }
                    VStack(alignment: .leading, spacing: 0) {
                        Text("See also").font(.headline).accessibilityAddTraits(.isHeader)
                        Button(document.related.label) { model.choice("row", row: document.related.actionId) }
                            .frame(minHeight: 44).accessibilityIdentifier("native-legal-related")
                    }
                }.padding(.horizontal, 16).padding(.vertical, 16)
            }.accessibilityIdentifier("native-legal-reader-\(document.type)")
        }.background(Color(uiColor: .systemGroupedBackground).ignoresSafeArea())
            .allowsHitTesting(!model.awaitingBackAcknowledgement && model.controlsEnabled && !model.choicePending)
            .accessibilityHidden(model.awaitingBackAcknowledgement)
            .environment(\.openURL, OpenURLAction { url in
                guard url.scheme == "hussh-legal-action", document.actionIds.contains(url.lastPathComponent) else { return .discarded }
                model.choice("row", row: url.lastPathComponent); return .handled
            })
    }
    private func attributed(_ parts: [NativeLegalInline]) -> AttributedString {
        parts.reduce(into: AttributedString()) { result, part in
            var run = AttributedString(part.text)
            if let id = part.actionId { run.link = URL(string: "hussh-legal-action:///\(id)") }
            result.append(run)
        }
    }
}
