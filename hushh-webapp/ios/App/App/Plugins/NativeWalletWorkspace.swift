import SwiftUI
import UIKit
import ImageIO

/// Collection and selected-card presentation share one native scroll/presentation
/// owner. These are private display replicas, never a card store or operation API.
struct NativeWalletTile: Decodable, Identifiable {
    let id: String; let kind: String; let title: String; let subtitle: String
    var imageData: String?; var overlayDetails: Bool?
    let network: String; let last4: String; let holder: String; let expiry: String
    var valid: Bool {
        (imageData == nil || NativeWalletCollection.imageSource(imageData!) != nil) && NativeDrawerIdentity.identifier(id) && ["payment", "profile", "referral", "nws"].contains(kind) &&
        NativeDrawerProjection.text(title, 256) && subtitle.utf16.count <= 256 && network.utf16.count <= 64 &&
        holder.utf16.count <= 120 && expiry.utf16.count <= 7 && (last4.isEmpty || last4.range(of: "^[0-9]{4}$", options: .regularExpression) != nil)
    }
}
struct NativeWalletVisitor: Decodable {
    let name: String; let headline: String; let organisation: String; let location: String; let summary: String
    let skills: [String]; var portraitData: String?
    var valid: Bool {
        [name, headline, organisation, location].allSatisfy { $0.utf16.count <= 512 } && summary.utf16.count <= 4096 &&
            skills.count <= 64 && skills.allSatisfy { NativeDrawerProjection.text($0, 256) } &&
            (portraitData == nil || portraitData!.utf16.count <= 100_000 && portraitData!.range(of: "^data:image/jpeg;base64,[A-Za-z0-9+/]+=*$", options: .regularExpression) != nil)
    }
}
struct NativeWalletDetailNavigation: Decodable {
    let sectionId: String; let allId: String; let previousId: String; let nextId: String; let addId: String
    let position: Int; let total: Int
    var actionIds: [String] { [allId, previousId, nextId, addId] }
    var valid: Bool {
        let ids = [sectionId] + actionIds
        return ids.allSatisfy(NativeDrawerIdentity.identifier) && Set(ids).count == ids.count &&
            position > 0 && position <= total && total <= 100
    }
}
struct NativeWalletCollection: Decodable {
    let cards: [NativeWalletTile]; let addId: String; let addEnabled: Bool
    var accessId: String?; var sharedTabId: String?; var view: String?
    let selectedId: String?; let detailVisitId: String?; let closeId: String; let detailTitle: String; let detailBusy: Bool
    var detailQrData: String?; var detailImageData: String?
    var navigation: NativeWalletDetailNavigation?
    var visitor: NativeWalletVisitor?
    var valid: Bool {
        let ids = cards.map(\.id) + [addId, closeId] + (accessId.map { [$0] } ?? [])
        return (visitor == nil || visitor!.valid && navigation == nil && cards.contains(where: { $0.id == selectedId && ["profile", "nws"].contains($0.kind) })) &&
            (navigation == nil || navigation!.valid && navigation!.total == cards.count && selectedId != nil && selectedId != accessId &&
            !([navigation!.sectionId] + navigation!.actionIds).contains(where: { ids.contains($0) })) &&
            (sharedTabId == nil || NativeDrawerIdentity.identifier(sharedTabId!)) && (view == nil || ["cards", "sharing"].contains(view!)) &&
            (view != "sharing" || selectedId == nil && detailVisitId == nil) &&
            [detailQrData, detailImageData].allSatisfy { $0 == nil || Self.imageSource($0!) != nil } && cards.count <= 100 && cards.allSatisfy(\.valid) && ids.allSatisfy(NativeDrawerIdentity.identifier) &&
            Set(ids).count == ids.count && detailTitle.utf16.count <= 256 && (selectedId == nil ? detailVisitId == nil : detailVisitId.map(NativeDrawerIdentity.identifier) == true && (selectedId == accessId || cards.contains { $0.id == selectedId }))
    }
    static func closed(_ value: [String: Any]) -> Bool {
        guard Set(value.keys).isSubset(of: ["cards", "addId", "addEnabled", "selectedId", "detailVisitId", "closeId", "detailTitle", "detailBusy", "detailQrData", "detailImageData", "accessId", "sharedTabId", "view", "navigation", "visitor"]),
              let cards = value["cards"] as? [[String: Any]] else { return false }
        if let raw = value["navigation"] {
            guard let nav = raw as? [String: Any], Set(nav.keys) == ["sectionId", "allId", "previousId", "nextId", "addId", "position", "total"] else { return false }
        }
        if let raw = value["visitor"] {
            guard let visitor = raw as? [String: Any], Set(visitor.keys).isSubset(of: ["name", "headline", "organisation", "location", "summary", "skills", "portraitData"]) else { return false }
        }
        return cards.allSatisfy { Set($0.keys).isSubset(of: ["id", "kind", "title", "subtitle", "network", "last4", "holder", "expiry", "imageData", "overlayDetails"]) }
    }
    static func imageSource(_ value: String) -> CGImageSource? {
        let prefix = "data:image/png;base64,"
        guard value.hasPrefix(prefix), value.utf16.count <= 400_000, let bytes = Data(base64Encoded: String(value.dropFirst(prefix.count))),
              let source = CGImageSourceCreateWithData(bytes as CFData, nil), let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= 640, height <= 640 else { return nil }
        return source
    }
    static func image(_ value: String) -> UIImage? {
        guard let source = imageSource(value), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
        return UIImage(cgImage: image)
    }
    func permits(_ row: String) -> Bool {
        if row == closeId { return selectedId != nil && !detailBusy }
        if row == accessId { return selectedId == nil }
        if row == addId { return addEnabled && selectedId == nil }
        return selectedId == nil && cards.contains { $0.id == row }
    }
}

@available(iOS 26.0, *)
struct NativeWalletWorkspaceBody: View {
    @ObservedObject var model: NativeWorkspaceModel
    @State private var scrollingFromPerson = false
    var body: some View {
        if let wallet = model.state.wallet {
            let isSharing = wallet.view == "sharing"
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    HStack {
                        Text(model.state.title).font(.title2.bold()).accessibilityAddTraits(.isHeader)
                        Spacer(minLength: 12)
                        Button { model.choice("row", row: wallet.addId) } label: {
                            HStack(spacing: 6) { NativeAuthoredIcon(id: "action-add", accentHex: model.state.accentHex, foregroundHex: model.state.accentHex, size: 18); Text("Add card") }.font(.body.weight(.medium)).padding(.horizontal, 12).frame(minHeight: 44)
                        }.buttonStyle(.glass).buttonBorderShape(.capsule)
                            .disabled(!wallet.addEnabled || model.pending != nil)
                            .accessibilityIdentifier("native-wallet-add")
                    }
                    if let accessId = wallet.accessId {
                        Button { model.choice("row", row: accessId) } label: {
                            NativeSettingsRowLabel(row: NativeDrawerRow(id: accessId, label: "Wallet access", detail: nil, symbol: nil, enabled: true,
                                destructive: nil, selected: nil, pending: nil, artworkId: "security", chevron: true), accentHex: model.state.accentHex)
                        }.buttonStyle(.plain).disabled(model.pending != nil || wallet.selectedId != nil).accessibilityIdentifier("native-wallet-access")
                    }
                    if !isSharing {
                    ForEach(model.state.wallet?.selectedId == nil ? model.state.sections : []) { section in
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(section.rows) { row in
                                if row.readOnly == true { NativeSettingsRowLabel(row: row, accentHex: model.state.accentHex) }
                                else { Button { model.choice("row", row: row.id) } label: { NativeSettingsRowLabel(row: row, accentHex: model.state.accentHex) }.disabled(!row.enabled || model.pending != nil) }
                            }
                        }
                    }
                    }
                    if let tabs = model.state.tabs {
                        NativeWorkspaceTabStrip(tabs: tabs, model: model, identifier: "segmented-tabs:wallet")
                    }
                    if isSharing {
                        VStack(alignment: .leading, spacing: 18) {
                            ForEach(model.state.sections) { section in
                                VStack(alignment: .leading, spacing: 8) {
                                    if let title = section.title { Text(title).font(.subheadline).foregroundStyle(.secondary).padding(.horizontal, 6).accessibilityAddTraits(.isHeader) }
                                    VStack(spacing: 0) {
                                        ForEach(Array(section.rows.enumerated()), id: \.element.id) { index, row in
                                            if row.readOnly == true { NativeSettingsRowLabel(row: row, accentHex: model.state.accentHex).accessibilityElement(children: .combine) }
                                            else {
                                                Button { model.choice("row", row: row.id) } label: { NativeSettingsRowLabel(row: row, accentHex: model.state.accentHex) }
                                                    .buttonStyle(.plain).disabled(!row.enabled || row.pending == true || model.pending != nil)
                                                    .accessibilityLabel(row.label).accessibilityValue([row.detail, row.trailing].compactMap { $0 }.joined(separator: ", "))
                                                    .accessibilityIdentifier("native-wallet-shared-row-\(row.id)")
                                            }
                                            if index < section.rows.count - 1 { Divider().padding(.horizontal, 16) }
                                        }
                                    }.background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
                                }
                            }
                        }.accessibilityIdentifier("native-wallet-shared-history")
                    } else {
                    if wallet.cards.filter({ $0.kind == "payment" }).isEmpty {
                        Text("No payment cards yet").foregroundStyle(.secondary)
                    }
                    collection(wallet.cards.filter { $0.kind == "payment" })
                    Text("Your One cards").font(.headline).accessibilityAddTraits(.isHeader)
                    collection(wallet.cards.filter { $0.kind != "payment" })
                    }
                }.padding(.horizontal, model.state.frame.gutter).padding(.top, 16).padding(.bottom, 16 + model.state.frame.bottomClearance)
            }.background(Color(uiColor: model.canvasColor)).accessibilityIdentifier(isSharing ? "native-wallet-shared-history-scroll" : "native-wallet-collection")
                .contentMargins(.bottom, model.state.frame.bottomClearance, for: .scrollIndicators)
                .onScrollPhaseChange { _, phase in scrollingFromPerson = phase == .interacting || phase == .decelerating }
                .onScrollGeometryChange(for: CGFloat.self, of: { max(0, $0.contentOffset.y + $0.contentInsets.top) }) { _, value in model.scrolled?(value, scrollingFromPerson) }
        }
    }
    private func collection(_ cards: [NativeWalletTile]) -> some View {
        LazyVStack(spacing: 20) {
            ForEach(cards) { card in
                Button { model.choice("row", row: card.id) } label: {
                    VStack(alignment: .leading, spacing: 10) {
                        if card.kind == "payment" { NativeWalletCardArtwork(card: card) }
                        HStack(spacing: 12) {
                            if card.kind != "payment" {
                                NativeWalletCardArtwork(card: card).frame(width: 340, height: 214).scaleEffect(88.0 / 340, anchor: .topLeading)
                                    .frame(width: 88, height: 56, alignment: .topLeading).clipped()
                            }
                            VStack(alignment: .leading, spacing: 3) {
                                Text(card.kind == "payment" ? card.title : card.kind == "profile" ? "Profile" : card.kind == "referral" ? "Referral" : "NWS").font(.system(size: 14, weight: .semibold))
                                Text(card.subtitle).font(.system(size: 12)).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 8)
                            Image(systemName: "chevron.right").foregroundStyle(.secondary)
                        }
                    }.padding(card.kind == "payment" ? 0 : 12).background(card.kind == "payment" ? Color.clear : Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18)).contentShape(Rectangle())
                }.buttonStyle(.plain).disabled(model.pending != nil || model.state.wallet?.selectedId != nil)
                    .accessibilityLabel(card.title).accessibilityValue(card.subtitle)
                    .accessibilityIdentifier(card.kind == "payment" ? "native-wallet-payment-\(card.id)" : "native-wallet-card-\(card.id)")
            }
        }
    }
}

@MainActor final class NativeWalletDetailModel: ObservableObject {
    private(set) var visit: String
    let closeId: String
    @Published var card: NativeWalletTile?
    @Published var sections: [NativeDrawerSection] = []
    @Published var navigation: NativeWalletDetailNavigation?
    @Published var visitor: NativeWalletVisitor?
    @Published var feedback: NativePresentationFeedback?
    var dismissFeedback: ((String, String) -> Void)?
    var activateFeedback: ((String, String, String) -> Void)?
    @Published var qr: UIImage?
    @Published var image: UIImage?
    private var qrSource: String?
    private var imageSource: String?
    @Published var editor: NativeProfileEditorModel<NativeWalletProfileProjection>?
    @Published var search: NativeWorkspaceSearch?
    @Published var title = ""
    @Published var busy = false
    @Published var enabled = false
    @Published var accentHex = ""
    @Published var canvasHex = ""
    @Published var appearance = "light"
    @Published var gutter: CGFloat = 16
    var canvasColor: UIColor { HushhNativeControlAppearance.color(canvasHex) ?? .systemGroupedBackground }
    var action: ((String, String?) -> Void)?
    init(_ state: NativeWorkspaceProjection, wallet: NativeWalletCollection, visit: String) {
        self.visit = visit; closeId = wallet.closeId; update(state, wallet: wallet)
    }
    func update(_ state: NativeWorkspaceProjection, wallet: NativeWalletCollection) {
        guard let nextVisit = wallet.detailVisitId else { return }; visit = nextVisit
        card = wallet.cards.first { $0.id == wallet.selectedId }; sections = state.sections; navigation = wallet.navigation; visitor = wallet.visitor
        if qrSource != wallet.detailQrData { qrSource = wallet.detailQrData; qr = qrSource.flatMap(NativeWalletCollection.image) }
        if imageSource != wallet.detailImageData { imageSource = wallet.detailImageData; image = imageSource.flatMap(NativeWalletCollection.image) }
        feedback = state.feedback; search = state.search; title = wallet.detailTitle; busy = wallet.detailBusy
        accentHex = state.accentHex; canvasHex = state.canvasHex ?? ""; appearance = state.appearance; gutter = state.frame.gutter
    }
    func choose(_ id: String, from origin: String, text: String? = nil) { guard origin == visit, enabled, !busy else { return }; action?(id, text) }
    func navigationEnabled(_ id: String) -> Bool {
        enabled && !busy && sections.first(where: { $0.id == navigation?.sectionId })?.rows.contains(where: { $0.id == id && $0.enabled && $0.pending != true }) == true
    }
    func clear() { enabled = false; card = nil; sections = []; navigation = nil; visitor = nil; search = nil; editor = nil; feedback = nil; dismissFeedback = nil; activateFeedback = nil; qr = nil; image = nil; qrSource = nil; imageSource = nil; title = ""; action = nil }
}

@available(iOS 26.0, *)
struct NativeWalletCardDetailBody: View {
    @ObservedObject var model: NativeWalletDetailModel
    @State private var query = ""
    @State private var showingQR = false
    @FocusState private var searching: Bool
    var body: some View {
        let origin = model.visit
        NavigationStack {
            Group {
            if let editor = model.editor { NativeWalletProfileForm(model: editor) } else {
            List {
                if let search = model.search {
                    TextField(search.label, text: $query).focused($searching).submitLabel(.search).autocorrectionDisabled()
                        .onSubmit { if query.utf16.count <= 256 { model.choose(search.id, from: origin, text: query); searching = false } }
                        .disabled(!model.enabled || model.busy).accessibilityIdentifier("native-wallet-detail-search")
                        .onAppear { query = search.query }
                }
                if let visitor = model.visitor {
                    NativeWalletVisitorBody(visitor: visitor).listRowBackground(Color.clear)
                } else if let image = model.image { Image(uiImage: image).resizable().scaledToFit().listRowBackground(Color.clear).accessibilityLabel("Your card") }
                else if let card = model.card {
                    NativeWalletCardArtwork(card: card).listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 12, trailing: 0))
                }
                if let qr = model.qr {
                    DisclosureGroup("QR code", isExpanded: $showingQR) {
                        Image(uiImage: qr).interpolation(.none).resizable().scaledToFit().frame(maxWidth: 240).frame(maxWidth: .infinity).accessibilityLabel("Your card QR code")
                    }.accessibilityIdentifier("native-wallet-detail-qr")
                }
                ForEach(model.sections.filter { $0.id != model.navigation?.sectionId }) { section in
                    Section {
                        ForEach(section.rows) { row in
                            if row.readOnly == true { NativeSettingsRowLabel(row: row, accentHex: model.accentHex) }
                            else {
                                Button { model.choose(row.id, from: origin) } label: { NativeSettingsRowLabel(row: row, accentHex: model.accentHex) }
                                    .disabled(!row.enabled || row.pending == true || !model.enabled)
                                    .accessibilityIdentifier("native-wallet-detail-\(row.id)")
                            }
                        }.listRowInsets(EdgeInsets())
                    } header: { if let title = section.title { Text(title) } }
                }
            }.listStyle(.insetGrouped)
                .scrollContentBackground(.hidden)
                .background(Color(uiColor: model.canvasColor))
                .accessibilityIdentifier("native-wallet-detail-content")
            }
            // Reserve space below the navigation bar so feedback never sits
            // on top of native Wallet detail controls.
            }.safeAreaInset(edge: .top, spacing: 8) {
                if let feedback = model.feedback {
                    NativeTextFeedbackBanner(message: feedback.message, tone: feedback.tone, dismissible: feedback.dismissible,
                        actionLabel: feedback.actionLabel, dismiss: { model.dismissFeedback?(feedback.id, origin) },
                        activate: { if let token = feedback.actionToken { model.activateFeedback?(feedback.id, origin, token) } })
                        .padding(.horizontal, model.gutter).padding(.top, 8)
                }
            }.navigationTitle(model.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    if let editor = model.editor {
                        NativeWalletProfileActions(model: editor)
                    } else {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Done") { model.choose(model.closeId, from: origin) }
                                .disabled(model.busy || !model.enabled)
                                .accessibilityIdentifier("native-wallet-detail-close")
                        }
                        if let nav = model.navigation {
                            ToolbarItemGroup(placement: .bottomBar) {
                                Button("All cards") { model.choose(nav.allId, from: origin) }
                                    .disabled(!model.navigationEnabled(nav.allId)).accessibilityIdentifier("native-wallet-detail-all")
                                Spacer()
                                Button("Previous card", systemImage: "chevron.left") { model.choose(nav.previousId, from: origin) }
                                    .labelStyle(.iconOnly).disabled(!model.navigationEnabled(nav.previousId)).accessibilityIdentifier("native-wallet-detail-previous")
                                Text("\(nav.position) / \(nav.total)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                                    .accessibilityLabel("Card \(nav.position) of \(nav.total)").accessibilityIdentifier("native-wallet-detail-position")
                                Button("Next card", systemImage: "chevron.right") { model.choose(nav.nextId, from: origin) }
                                    .labelStyle(.iconOnly).disabled(!model.navigationEnabled(nav.nextId)).accessibilityIdentifier("native-wallet-detail-next")
                                Spacer()
                                Button("Add a card", systemImage: "plus") { model.choose(nav.addId, from: origin) }
                                    .labelStyle(.iconOnly).disabled(!model.navigationEnabled(nav.addId)).accessibilityIdentifier("native-wallet-detail-add")
                            }
                        }
                    }
                }
        }.background(Color(uiColor: model.canvasColor))
            .tint(Color(uiColor: HushhNativeControlAppearance.color(model.accentHex) ?? .label))
            .preferredColorScheme(model.appearance == "dark" ? .dark : .light)
            .accessibilityIdentifier("native-wallet-card-detail")
            .onChange(of: model.search?.id) { _, _ in searching = false; query = model.search?.query ?? "" }
            .onChange(of: model.visit) { _, _ in showingQR = false }
            .onChange(of: model.search?.query) { _, value in if !searching { query = value ?? "" } }
    }
}

private struct NativeWalletVisitorBody: View {
    let visitor: NativeWalletVisitor
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            if !visitor.name.isEmpty || !visitor.headline.isEmpty {
                HStack(alignment: .top, spacing: 16) {
                    NativeProfilePortraitImage(data: visitor.portraitData,
                        initials: visitor.name.split(whereSeparator: \.isWhitespace).prefix(2).compactMap(\.first).map(String.init).joined().uppercased())
                        .frame(width: 64, height: 64).accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 6) {
                        if !visitor.name.isEmpty {
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text(visitor.name).font(.title2.weight(.semibold)).accessibilityAddTraits(.isHeader)
                                Image(systemName: "checkmark.seal.fill").font(.caption).foregroundStyle(.tint)
                                    .accessibilityLabel("Hushh profile badge, not identity verification")
                            }
                        }
                        if !visitor.headline.isEmpty { Text(visitor.headline).font(.subheadline).foregroundStyle(.secondary) }
                    }
                }
            }
            if !visitor.organisation.isEmpty || !visitor.location.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    if !visitor.organisation.isEmpty { Label(visitor.organisation, systemImage: "briefcase") }
                    if !visitor.location.isEmpty { Label(visitor.location, systemImage: "mappin.and.ellipse") }
                }.font(.subheadline).foregroundStyle(.secondary)
            }
            if !visitor.summary.isEmpty { Text(visitor.summary).font(.body).lineSpacing(3).fixedSize(horizontal: false, vertical: true) }
            if !visitor.skills.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Skills").font(.headline).accessibilityAddTraits(.isHeader)
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 88), alignment: .leading)], alignment: .leading, spacing: 8) {
                        ForEach(Array(visitor.skills.enumerated()), id: \.offset) { _, skill in
                            Text(skill).font(.footnote).padding(.horizontal, 10).padding(.vertical, 7)
                                .background(Color(uiColor: .tertiarySystemFill), in: Capsule())
                        }
                    }
                }
            }
        }.padding(.vertical, 8).frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("native-wallet-visitor-profile")
    }
}

/// Native masked composition. The card ratio and safe printed fields follow
/// wallet-card-presentation; full numbers and security codes never paint here.
private struct NativeWalletCardArtwork: View {
    let card: NativeWalletTile
    @State private var decoded: UIImage?
    @State private var source: String?
    var body: some View {
        ZStack {
        if source == card.imageData, let decoded { Image(uiImage: decoded).resizable().scaledToFit() }
        if source != card.imageData || decoded == nil || card.overlayDetails == true {
        VStack(alignment: .leading, spacing: 18) {
            HStack { Text(card.kind == "payment" ? card.network : "Hussh One").font(.headline); Spacer(); Image(systemName: card.kind == "payment" ? "creditcard" : "person.crop.rectangle") }
            Spacer(minLength: 8)
            Text(card.kind == "payment" ? "••••  ••••  ••••  \(card.last4)" : card.title).font(.title3.monospaced())
            HStack {
                Text(card.holder.isEmpty ? card.network : card.holder).font(.subheadline)
                Spacer(minLength: 12)
                Text(card.expiry).font(.subheadline.monospacedDigit())
            }
        }.padding(22).foregroundStyle(card.overlayDetails == true ? Color.white : Color.primary).frame(maxWidth: .infinity)
        }
        }.aspectRatio(85.60 / 53.98, contentMode: .fit)
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
            .overlay { RoundedRectangle(cornerRadius: 16).stroke(Color(uiColor: .separator), lineWidth: 0.5) }
            .accessibilityHidden(true)
            .onAppear(perform: decode)
            .onChange(of: card.imageData) { _, _ in decode() }
    }
    private func decode() { decoded = nil; source = nil; if let data = card.imageData { decoded = NativeWalletCollection.image(data); source = data } }
}
