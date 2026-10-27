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
struct NativeWalletCollection: Decodable {
    let cards: [NativeWalletTile]; let addId: String; let addEnabled: Bool
    var accessId: String?
    let selectedId: String?; let detailVisitId: String?; let closeId: String; let detailTitle: String; let detailBusy: Bool
    var detailQrData: String?; var detailImageData: String?
    var valid: Bool {
        let ids = cards.map(\.id) + [addId, closeId] + (accessId.map { [$0] } ?? [])
        return [detailQrData, detailImageData].allSatisfy { $0 == nil || Self.imageSource($0!) != nil } && cards.count <= 100 && cards.allSatisfy(\.valid) && ids.allSatisfy(NativeDrawerIdentity.identifier) &&
            Set(ids).count == ids.count && detailTitle.utf16.count <= 256 && (selectedId == nil ? detailVisitId == nil : detailVisitId.map(NativeDrawerIdentity.identifier) == true && (selectedId == accessId || cards.contains { $0.id == selectedId }))
    }
    static func closed(_ value: [String: Any]) -> Bool {
        guard Set(value.keys).isSubset(of: ["cards", "addId", "addEnabled", "selectedId", "detailVisitId", "closeId", "detailTitle", "detailBusy", "detailQrData", "detailImageData", "accessId"]),
              let cards = value["cards"] as? [[String: Any]] else { return false }
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
                    ForEach(model.state.wallet?.selectedId == nil ? model.state.sections : []) { section in
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(section.rows) { row in
                                if row.readOnly == true { NativeSettingsRowLabel(row: row, accentHex: model.state.accentHex) }
                                else { Button { model.choice("row", row: row.id) } label: { NativeSettingsRowLabel(row: row, accentHex: model.state.accentHex) }.disabled(!row.enabled || model.pending != nil) }
                            }
                        }
                    }
                    if let tabs = model.state.tabs {
                        Picker(tabs.label, selection: Binding(get: { tabs.options.first(where: \.selected)?.id ?? "" }, set: { model.choice("row", row: $0) })) {
                            ForEach(tabs.options, id: \.id) { Text($0.label).tag($0.id) }
                        }.pickerStyle(.segmented)
                    }
                    if wallet.cards.filter({ $0.kind == "payment" }).isEmpty {
                        Text("No payment cards yet").foregroundStyle(.secondary)
                    }
                    collection(wallet.cards.filter { $0.kind == "payment" })
                    Text("Your One cards").font(.headline).accessibilityAddTraits(.isHeader)
                    collection(wallet.cards.filter { $0.kind != "payment" })
                }.padding(.horizontal, model.state.frame.gutter).padding(.vertical, 16)
            }.accessibilityIdentifier("native-wallet-collection")
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
    @Published var feedback: NativePresentationFeedback?
    var dismissFeedback: ((String, String) -> Void)?
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
    @Published var appearance = "light"
    var action: ((String, String?) -> Void)?
    init(_ state: NativeWorkspaceProjection, wallet: NativeWalletCollection, visit: String) {
        self.visit = visit; closeId = wallet.closeId; update(state, wallet: wallet)
    }
    func update(_ state: NativeWorkspaceProjection, wallet: NativeWalletCollection) {
        guard let nextVisit = wallet.detailVisitId else { return }; visit = nextVisit
        card = wallet.cards.first { $0.id == wallet.selectedId }; sections = state.sections
        if qrSource != wallet.detailQrData { qrSource = wallet.detailQrData; qr = qrSource.flatMap(NativeWalletCollection.image) }
        if imageSource != wallet.detailImageData { imageSource = wallet.detailImageData; image = imageSource.flatMap(NativeWalletCollection.image) }
        feedback = state.feedback; search = state.search; title = wallet.detailTitle; busy = wallet.detailBusy; accentHex = state.accentHex; appearance = state.appearance
    }
    func choose(_ id: String, from origin: String, text: String? = nil) { guard origin == visit, enabled, !busy else { return }; action?(id, text) }
    func clear() { enabled = false; card = nil; sections = []; search = nil; editor = nil; feedback = nil; dismissFeedback = nil; qr = nil; image = nil; qrSource = nil; imageSource = nil; title = ""; action = nil }
}

@available(iOS 26.0, *)
struct NativeWalletCardDetailBody: View {
    @ObservedObject var model: NativeWalletDetailModel
    @State private var query = ""
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
                if let image = model.image { Image(uiImage: image).resizable().scaledToFit().listRowBackground(Color.clear).accessibilityLabel("Your card") }
                else if let card = model.card {
                    NativeWalletCardArtwork(card: card).listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 12, trailing: 0))
                }
                if let qr = model.qr { Image(uiImage: qr).interpolation(.none).resizable().scaledToFit().frame(maxWidth: 240).frame(maxWidth: .infinity).accessibilityLabel("Your card QR code") }
                ForEach(model.sections) { section in
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
            }.listStyle(.insetGrouped).accessibilityIdentifier("native-wallet-detail-content")
            }
            }.overlay(alignment: .top) {
                if let feedback = model.feedback {
                    NativeTextFeedbackBanner(message: feedback.message, tone: feedback.tone, dismissible: feedback.dismissible) { model.dismissFeedback?(feedback.id, origin) }
                        .padding(.horizontal, 16).padding(.top, 8)
                }
            }.navigationTitle(model.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { model.choose(model.closeId, from: origin) }
                            .disabled(model.busy || !model.enabled)
                            .accessibilityIdentifier("native-wallet-detail-close")
                    }
                }
        }.tint(Color(uiColor: HushhNativeControlAppearance.color(model.accentHex) ?? .label))
            .preferredColorScheme(model.appearance == "dark" ? .dark : .light)
            .accessibilityIdentifier("native-wallet-card-detail")
            .onChange(of: model.search?.id) { _, _ in searching = false; query = model.search?.query ?? "" }
            .onChange(of: model.search?.query) { _, value in if !searching { query = value ?? "" } }
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
