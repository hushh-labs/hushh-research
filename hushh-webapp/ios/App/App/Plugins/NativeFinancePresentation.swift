import SwiftUI
import Charts
import UIKit

/// Bounded private Finance composition. Registered workspace actions remain the
/// only route, provider and mutation authority.
struct NativeFinanceContent: Codable {
    struct Point: Codable { let date: String; let value: Double }
    struct Slice: Codable { let label: String; let value: Double; let colorHex: String }
    let kind: String
    var value: String?; var change: String?; var tone: String?; var points: [Double]?
    var quotedAt: String?; var amount: Double?; var maximum: Double?
    var style: String?; var symbol: String?; var artwork: NativeMarketNewsStory.Artwork?; var price: String?; var metadata: String?; var note: String?
    var publisher: String?; var publishedAt: String?; var sources: [NativeFinanceArtworkSource]?
    var history: [Point]?; var period: String?; var invested: String?; var cash: String?
    var slices: [Slice]?; var showBar: Bool?
    var name: String?; var percent: Double?; var sector: String?
    // Discriminated JSON has value/points/change with different scalar types.
    // Keep the wire shape concrete without inventing a second rendering API.
    enum CodingKeys: String, CodingKey { case kind, value, change, tone, points, quotedAt, maximum, style, symbol, artwork, price, metadata, note, publisher, publishedAt, sources, period, invested, cash, slices, showBar, name, percent, sector, history }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decode(String.self, forKey: .kind)
        if kind == "sector" { amount = try c.decode(Double.self, forKey: .value) }
        else { value = try c.decodeIfPresent(String.self, forKey: .value) }
        if kind == "security" { amount = try c.decodeIfPresent(Double.self, forKey: .change) }
        else { change = try c.decodeIfPresent(String.self, forKey: .change) }
        if kind == "balance" { history = try c.decode([Point].self, forKey: .points) }
        else { points = try c.decodeIfPresent([Double].self, forKey: .points) }
        style = try c.decodeIfPresent(String.self, forKey: .style)
        tone = try c.decodeIfPresent(String.self, forKey: .tone); quotedAt = try c.decodeIfPresent(String.self, forKey: .quotedAt)
        maximum = try c.decodeIfPresent(Double.self, forKey: .maximum); symbol = try c.decodeIfPresent(String.self, forKey: .symbol)
        artwork = try c.decodeIfPresent(NativeMarketNewsStory.Artwork.self, forKey: .artwork); price = try c.decodeIfPresent(String.self, forKey: .price)
        metadata = try c.decodeIfPresent(String.self, forKey: .metadata); note = try c.decodeIfPresent(String.self, forKey: .note)
        publisher = try c.decodeIfPresent(String.self, forKey: .publisher); publishedAt = try c.decodeIfPresent(String.self, forKey: .publishedAt)
        sources = try c.decodeIfPresent([NativeFinanceArtworkSource].self, forKey: .sources)
        period = try c.decodeIfPresent(String.self, forKey: .period); invested = try c.decodeIfPresent(String.self, forKey: .invested)
        cash = try c.decodeIfPresent(String.self, forKey: .cash); slices = try c.decodeIfPresent([Slice].self, forKey: .slices)
        showBar = try c.decodeIfPresent(Bool.self, forKey: .showBar); name = try c.decodeIfPresent(String.self, forKey: .name)
        percent = try c.decodeIfPresent(Double.self, forKey: .percent); sector = try c.decodeIfPresent(String.self, forKey: .sector)
        if kind == "briefing" { note = try c.decode(String.self, forKey: .history) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self); try c.encode(kind, forKey: .kind)
        if kind == "sector" { try c.encode(amount, forKey: .value) } else { try c.encodeIfPresent(value, forKey: .value) }
        if kind == "security" { try c.encodeIfPresent(amount, forKey: .change) } else { try c.encodeIfPresent(change, forKey: .change) }
        if kind == "balance" { try c.encode(history, forKey: .points) } else { try c.encodeIfPresent(points, forKey: .points) }
        try c.encodeIfPresent(tone, forKey: .tone); try c.encodeIfPresent(quotedAt, forKey: .quotedAt); try c.encodeIfPresent(maximum, forKey: .maximum)
        try c.encodeIfPresent(style, forKey: .style); try c.encodeIfPresent(symbol, forKey: .symbol); try c.encodeIfPresent(artwork, forKey: .artwork); try c.encodeIfPresent(price, forKey: .price)
        try c.encodeIfPresent(metadata, forKey: .metadata); if kind == "briefing" { try c.encodeIfPresent(note, forKey: .history) } else { try c.encodeIfPresent(note, forKey: .note) }
        try c.encodeIfPresent(publisher, forKey: .publisher); try c.encodeIfPresent(publishedAt, forKey: .publishedAt); try c.encodeIfPresent(sources, forKey: .sources)
        try c.encodeIfPresent(period, forKey: .period); try c.encodeIfPresent(invested, forKey: .invested); try c.encodeIfPresent(cash, forKey: .cash)
        try c.encodeIfPresent(slices, forKey: .slices); try c.encodeIfPresent(showBar, forKey: .showBar); try c.encodeIfPresent(name, forKey: .name)
        try c.encodeIfPresent(percent, forKey: .percent); try c.encodeIfPresent(sector, forKey: .sector)
    }
    static func closed(_ raw: Any) -> Bool {
        guard let v = raw as? [String: Any], let kind = v["kind"] as? String, !v.values.contains(where: { $0 is NSNull }) else { return false }
        let fields: [String: Set<String>] = [
            "index": ["value", "change", "tone", "points", "quotedAt"], "sector": ["value", "maximum"],
            "security": ["style", "symbol", "artwork", "price", "change", "metadata", "note"], "headline": ["publisher", "publishedAt", "sources"],
            "balance": ["value", "change", "points", "period", "invested", "cash"], "allocation": ["slices", "showBar"],
            "briefing": ["name", "symbol", "percent", "cash", "sector", "history"]]
        guard let allowed = fields[kind], Set(v.keys).isSubset(of: allowed.union(["kind"])) else { return false }
        if let art = v["artwork"] { guard let art = art as? [String: Any], Set(art.keys).isSubset(of: ["glyph", "hue", "png"]), !art.values.contains(where: { $0 is NSNull }) else { return false } }
        if let sources = v["sources"] as? [Any], !sources.allSatisfy(NativeFinanceArtworkSource.closed) { return false }
        if kind == "balance", let points = v["points"] as? [[String: Any]], !points.allSatisfy({ Set($0.keys) == ["date", "value"] }) { return false }
        if let slices = v["slices"] as? [[String: Any]], !slices.allSatisfy({ Set($0.keys) == ["label", "value", "colorHex"] }) { return false }
        return true
    }
    var valid: Bool {
        func text(_ v: String?, _ max: Int = 256) -> Bool { v.map { NativeDrawerProjection.text($0, max) } ?? false }
        func finite(_ v: Double?) -> Bool { v.map { $0.isFinite && abs($0) <= 1e18 } ?? false }
        switch kind {
        case "index": return text(value) && text(change) && ["positive", "negative", "neutral"].contains(tone ?? "") && text(quotedAt) && points != nil && points!.count <= 1000 && points!.allSatisfy { finite($0) }
        case "sector": return finite(amount) && finite(maximum) && maximum! > 0 && abs(amount!) <= maximum!
        case "security": return (style == nil || ["holding", "mover"].contains(style!)) && text(symbol, 64) && artwork?.valid == true && text(price) && text(metadata, 1024) && (amount == nil || finite(amount)) && (note == nil || text(note))
        case "headline": return text(publisher) && text(publishedAt) && sources != nil && sources!.count <= 3 && Set(sources!.map(\.url)).count == sources!.count && sources!.allSatisfy { $0.admittedURL != nil }
        case "balance": return text(value) && (change == nil || text(change)) && text(period, 1024) && text(invested) && text(cash) && history != nil && history!.count <= 1000 && history!.allSatisfy { text($0.date, 128) && finite($0.value) }
        case "allocation": return showBar != nil && slices != nil && slices!.count <= 32 && slices!.allSatisfy { text($0.label) && finite($0.value) && $0.value >= 0 && $0.colorHex.range(of: "^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$", options: .regularExpression) != nil } && (showBar != true || slices!.reduce(0) { $0 + $1.value } <= 100.1)
        case "briefing": return (name == nil || text(name)) && (symbol == nil || text(symbol, 64)) && (percent == nil || finite(percent) && percent! >= 0) && text(cash) && (sector == nil || text(sector)) && text(note)
        default: return false
        }
    }
}

@available(iOS 26.0, *)
struct NativeFinanceRow: View {
    let row: NativeDrawerRow
    @ObservedObject var model: NativeWorkspaceModel
    let content: NativeFinanceContent
    private var tint: Color { Color(uiColor: HushhNativeControlAppearance.color(model.state.accentHex) ?? .label) }
    private func signed(_ value: Double) -> String { String(format: "%+.2f%%", value) }
    private func color(_ value: Double) -> Color { value >= 0 ? .green : .red }
    var body: some View {
        Group {
            if row.readOnly == true { bodyContent }
            else { Button { _ = model.choice("row", row: row.id) } label: { bodyContent }.buttonStyle(.plain).disabled(!row.enabled || row.pending == true || model.pending != nil) }
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("native-workspace-row-\(row.id)")
    }
    @ViewBuilder private var bodyContent: some View {
        switch content.kind {
        case "index":
            VStack(alignment: .leading, spacing: 7) {
                HStack { Text(row.label).font(.subheadline.weight(.semibold)); Spacer(); if row.readOnly != true { Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary) } }
                Text(content.value ?? "").font(.title2.weight(.semibold)).monospacedDigit()
                Text(content.change ?? "").font(.subheadline.weight(.semibold)).foregroundStyle(content.tone == "positive" ? Color.green : content.tone == "negative" ? Color.red : Color.secondary)
                NativeFinanceSparkline(points: content.points ?? [], tint: content.tone == "positive" ? .green : content.tone == "negative" ? .red : .secondary).frame(height: 42).accessibilityHidden(true)
                Text(content.quotedAt ?? "").font(.caption).foregroundStyle(.secondary)
            }
        case "sector":
            HStack(spacing: 12) {
                Text(row.label).font(.caption).frame(maxWidth: .infinity, alignment: .leading)
                GeometryReader { geometry in
                    let value = content.amount ?? 0, width = abs(value) / (content.maximum ?? 1) * geometry.size.width / 2
                    Capsule().fill(.quaternary).frame(height: 4)
                    Rectangle().fill(.secondary.opacity(0.4)).frame(width: 1, height: 8).offset(x: geometry.size.width / 2, y: -2)
                    Capsule().fill(color(value)).frame(width: width, height: 4).offset(x: value >= 0 ? geometry.size.width / 2 : geometry.size.width / 2 - width)
                }.frame(width: 86, height: 4).accessibilityHidden(true)
                Text(signed(content.amount ?? 0)).font(.caption.weight(.semibold)).monospacedDigit().foregroundStyle(color(content.amount ?? 0)).frame(width: 65, alignment: .trailing)
            }.frame(minHeight: 22)
        case "headline":
            HStack(spacing: 16) {
                VStack(alignment: .leading, spacing: 7) { Text(row.label).font(.subheadline.weight(.semibold)).fixedSize(horizontal: false, vertical: true); Text("\(content.publisher ?? "") · \(content.publishedAt ?? "")").font(.caption).foregroundStyle(.secondary) }
                Spacer(minLength: 0)
                NativeFinanceNewsCover(model: model, sources: content.sources ?? [])
            }.frame(minHeight: 68)
        case "security":
            if content.style == "mover" {
                VStack(alignment: .leading, spacing: 6) {
                    if let detail = row.detail { Text(detail).font(.caption.weight(.semibold)).foregroundStyle(.secondary).padding(.bottom, 4) }
                    HStack(alignment: .firstTextBaseline, spacing: 4) { Text(row.label).font(.subheadline.weight(.semibold)); Spacer(minLength: 0); Text(content.price ?? "").font(.subheadline.weight(.semibold)).monospacedDigit().foregroundStyle(content.amount.map(color) ?? .secondary) }
                    HStack(alignment: .top, spacing: 5) { symbolMark.scaleEffect(0.4).frame(width: 16, height: 16); Text(content.metadata ?? "").font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
                    Text(content.note ?? "").font(.caption2).foregroundStyle(.secondary)
                }
            } else {
                HStack(spacing: 12) {
                    symbolMark
                    VStack(alignment: .leading, spacing: 4) { Text(row.label).font(.subheadline.weight(.semibold)); Text(content.metadata ?? "").font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
                    Spacer(minLength: 8)
                    VStack(alignment: .trailing, spacing: 4) { Text(content.price ?? "").font(.subheadline.weight(.semibold)); if let value = content.amount { Text(signed(value)).font(.caption.weight(.semibold)).foregroundStyle(color(value)) }; if let note = content.note { Text(note).font(.caption).foregroundStyle(.secondary) } }.monospacedDigit()
                }.frame(minHeight: 48)
            }
        case "balance":
            VStack(alignment: .leading, spacing: 14) {
                Text(row.label).font(.subheadline).foregroundStyle(.secondary)
                Text(content.value ?? "").font(.largeTitle.weight(.semibold)).monospacedDigit()
                if let change = content.change { Text(change).font(.subheadline.weight(.medium)); Text("Period balance change · includes cash flows").font(.caption).foregroundStyle(.secondary) }
                NativeFinanceBalanceHistory(points: content.history ?? [])
                HStack { fact("Invested", content.invested ?? "Unavailable"); Spacer(); fact("Cash", content.cash ?? "Unavailable") }
                Text(content.period ?? "").font(.caption).foregroundStyle(.secondary)
            }
        case "allocation":
            VStack(alignment: .leading, spacing: 14) {
                HStack { Text(row.label).font(.subheadline.weight(.semibold)); Spacer(); Text("% of portfolio").font(.caption).foregroundStyle(.secondary) }
                if content.showBar == true { GeometryReader { geometry in HStack(spacing: 0) { ForEach(Array((content.slices ?? []).enumerated()), id: \.offset) { _, slice in Rectangle().fill(Color(uiColor: HushhNativeControlAppearance.color(slice.colorHex) ?? .secondaryLabel)).frame(width: geometry.size.width * slice.value / 100) } } }.frame(height: 9).clipShape(Capsule()).accessibilityHidden(true) }
                ForEach(Array((content.slices ?? []).enumerated()), id: \.offset) { _, slice in HStack { Circle().fill(Color(uiColor: HushhNativeControlAppearance.color(slice.colorHex) ?? .secondaryLabel)).frame(width: 9, height: 9); Text(slice.label); Spacer(); Text(String(format: "%.1f%%", slice.value)).monospacedDigit() }.font(.subheadline) }
                if content.slices?.isEmpty != false { Text("Allocation is unavailable for this source.").font(.subheadline).foregroundStyle(.secondary) }
            }
        case "briefing":
            VStack(alignment: .leading, spacing: 16) {
                Text(row.label).font(.subheadline.weight(.semibold))
                if let percent = content.percent {
                    HStack(spacing: 16) {
                        ZStack { if percent <= 100 { Circle().stroke(.quaternary, lineWidth: 8); Circle().trim(from: 0, to: percent / 100).stroke(tint, style: StrokeStyle(lineWidth: 8, lineCap: .round)).rotationEffect(.degrees(-90)) }; VStack(spacing: 2) { Text(String(format: "%.1f%%", percent)).font(.title3.weight(.semibold)); Text("of portfolio").font(.caption2).foregroundStyle(.secondary) } }.frame(width: 108, height: 108)
                        VStack(alignment: .leading, spacing: 5) { Text("Largest tracked position").font(.caption).foregroundStyle(.secondary); Text(content.name ?? "").font(.headline); Text(content.symbol ?? "").font(.caption).foregroundStyle(.secondary) }
                    }
                } else { Text("Position concentration is unavailable for this source.").font(.subheadline).foregroundStyle(.secondary) }
                HStack { Text("Cash share"); Spacer(); Text(content.cash ?? "Unavailable").monospacedDigit() }.font(.subheadline)
                if let sector = content.sector { Text(sector).font(.subheadline) }
                Label(content.note ?? "", systemImage: "calendar").font(.caption).foregroundStyle(.secondary)
            }
        default: EmptyView()
        }
    }
    @ViewBuilder private var symbolMark: some View {
        let art = content.artwork
        ZStack {
            if content.style == "holding" { RoundedRectangle(cornerRadius: 10).fill(.quaternary); Text(art?.glyph ?? "").font(.caption.weight(.semibold)) } else {
            RoundedRectangle(cornerRadius: 12).fill(LinearGradient(colors: [Color(hue: Double(art?.hue ?? 0) / 360, saturation: 0.6, brightness: 0.3), Color(hue: Double((art?.hue ?? 0) + 38) / 360, saturation: 0.66, brightness: 0.22)], startPoint: .topLeading, endPoint: .bottomTrailing))
            if let png = art?.png, let data = Data(base64Encoded: String(png.dropFirst("data:image/png;base64,".count))), let image = UIImage(data: data) { Image(uiImage: image).resizable().scaledToFit().padding(8) }
            else { Text(art?.glyph ?? "").font(.caption.weight(.semibold)).foregroundStyle(.white) }
            }
        }.frame(width: 40, height: 40).accessibilityHidden(true)
    }
    private func fact(_ label: String, _ value: String) -> some View { VStack(alignment: .leading, spacing: 4) { Text(label).foregroundStyle(.secondary); Text(value).fontWeight(.semibold).monospacedDigit() }.font(.subheadline) }
}

@available(iOS 26.0, *)
private struct NativeFinanceSparkline: View {
    let points: [Double]; let tint: Color
    var body: some View {
        if points.count >= 2, let first = points.first {
            Chart { ForEach(Array(points.enumerated()), id: \.offset) { index, value in
                AreaMark(x: .value("Point", index), yStart: .value("Base", points.min() ?? first), yEnd: .value("Level", value)).foregroundStyle(LinearGradient(colors: [tint.opacity(0.24), .clear], startPoint: .top, endPoint: .bottom))
                LineMark(x: .value("Point", index), y: .value("Level", value)).foregroundStyle(tint).lineStyle(StrokeStyle(lineWidth: 2))
            }; RuleMark(y: .value("First", first)).foregroundStyle(tint.opacity(0.45)).lineStyle(StrokeStyle(dash: [3, 4])) }.chartXAxis(.hidden).chartYAxis(.hidden).chartYScale(domain: (points.min() ?? first)...max((points.max() ?? first), (points.min() ?? first) + 0.01))
        } else { Path { path in path.move(to: CGPoint(x: 0, y: 21)); path.addLine(to: CGPoint(x: 300, y: 21)) }.stroke(.secondary.opacity(0.5), style: StrokeStyle(lineWidth: 1.4, dash: [3, 4])) }
    }
}

@available(iOS 26.0, *)
private struct NativeFinanceBalanceHistory: View {
    let points: [NativeFinanceContent.Point]
    @State private var range = 0
    @State private var selected: Int?
    private let ranges = [(7, "1W"), (30, "1M"), (90, "3M"), (365, "1Y"), (0, "All")]
    private func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter(), input = value.count == 10 ? value + "T00:00:00Z" : value
        if let result = formatter.date(from: input) { return result }
        formatter.formatOptions.insert(.withFractionalSeconds); return formatter.date(from: input)
    }
    private func label(_ value: String, short: Bool = false) -> String {
        guard let parsed = date(value) else { return value }
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US"); formatter.timeZone = TimeZone(identifier: value.count == 10 ? "UTC" : "America/New_York"); formatter.dateFormat = short ? "MMM d" : "MMM d, yyyy"
        return formatter.string(from: parsed)
    }
    private func slice(_ days: Int) -> [NativeFinanceContent.Point] { guard days > 0, let last = points.last, let end = date(last.date) else { return points }; return points.filter { (date($0.date) ?? .distantPast) >= end.addingTimeInterval(-Double(days) * 86400) } }
    var body: some View {
        let available = ranges.filter { $0.0 == 0 || slice($0.0).count >= 2 }
        let visible = slice(available.contains(where: { $0.0 == range }) ? range : 0)
        if visible.count >= 2, let first = visible.first, let last = visible.last {
            VStack(alignment: .leading, spacing: 12) {
                HStack { Text("Portfolio performance").fontWeight(.semibold); Spacer(); Text("\(last.value >= first.value ? "+" : "−")\(abs(last.value - first.value).formatted(.currency(code: "USD")))\(first.value > 0 ? String(format: " (%+.2f%%)", (last.value - first.value) / first.value * 100) : "")").foregroundStyle(last.value >= first.value ? Color.green : Color.red) }.font(.caption)
                Picker("Portfolio performance range", selection: $range) { ForEach(available, id: \.0) { value in Text(value.1).tag(value.0) } }.pickerStyle(.segmented).onChange(of: range) { _, _ in selected = nil }
                Chart {
                    ForEach(Array(visible.enumerated()), id: \.offset) { index, point in
                        AreaMark(x: .value("Date", index), yStart: .value("Base", visible.map(\.value).min() ?? 0), yEnd: .value("Balance", point.value)).foregroundStyle(LinearGradient(colors: [(last.value >= first.value ? Color.green : Color.red).opacity(0.24), .clear], startPoint: .top, endPoint: .bottom))
                        LineMark(x: .value("Date", index), y: .value("Balance", point.value)).foregroundStyle(last.value >= first.value ? Color.green : Color.red)
                    }
                    RuleMark(y: .value("First balance", first.value)).lineStyle(StrokeStyle(dash: [3, 4])).foregroundStyle(.secondary.opacity(0.5))
                    if let selected, visible.indices.contains(selected) { RuleMark(x: .value("Date", selected)).foregroundStyle(.secondary); PointMark(x: .value("Date", selected), y: .value("Balance", visible[selected].value)).foregroundStyle(.primary) }
                }.chartYScale(domain: max(0, (visible.map(\.value).min() ?? 0) * 0.999)...max((visible.map(\.value).max() ?? 0) * 1.001, 0.01))
                    .chartXAxis { AxisMarks(values: [0, visible.count - 1]) { value in if let index = value.as(Int.self), visible.indices.contains(index) { AxisValueLabel(label(visible[index].date, short: true)) } } }
                    .chartYAxis { AxisMarks(position: .trailing, values: .automatic(desiredCount: 4)) { value in AxisGridLine(); if let number = value.as(Double.self) { AxisValueLabel(number.formatted(.currency(code: "USD").notation(.compactName))) } } }
                    .chartOverlay { proxy in GeometryReader { geometry in Color.clear.contentShape(Rectangle()).onTapGesture { location in guard let plot = proxy.plotFrame else { return }; let x = location.x - geometry[plot].minX; if let value: Double = proxy.value(atX: x) { selected = min(visible.count - 1, max(0, Int(value.rounded()))) } } } }
                    .frame(height: 220).accessibilityLabel("Dated portfolio balances")
                if let selected, visible.indices.contains(selected) { Text("\(label(visible[selected].date)) · \(visible[selected].value.formatted(.currency(code: "USD")))").font(.caption).monospacedDigit() }
                Text("\(label(first.date)) to \(label(last.date)) · USD · Tap a point to inspect").font(.caption).foregroundStyle(.secondary)
            }
        } else { Text("Dated balance history unavailable.").font(.subheadline).foregroundStyle(.secondary) }
    }
}
