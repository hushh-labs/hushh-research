import SwiftUI
import UIKit

/// Stationary map actions only. The map, permissions, location publication and
/// check-in state remain with their existing owners. No moving tray controls.
enum NativeMapActionPresentation {
    static let ids = ["map-close": "action-close", "map-locate": "action-locate", "map-check-in": "action-people"]
    static func sizeAllowed(_ kind: String, width: Double, height: Double) -> Bool {
        kind == "map-check-in" ? width == 112 && height == 44 : width == 56 && height == 56
    }
    @available(iOS 26.0, *) static func control(kind: String, label: String, value: String?, theme: HushhNativeControlAppearance,
        focus: ChromeFocusRequest, action: @escaping () -> Void, layout: @escaping (CGSize) -> Void) -> AnyView? {
        guard let id = ids[kind], NativeProfileArtwork.resolve(id) != nil else { return nil }
        return AnyView(MapActionButton(kind: kind, label: label, value: value, theme: theme, focus: focus, action: action, layout: layout))
    }
}
@available(iOS 26.0, *) private struct MapActionButton: View {
    let kind: String; let label: String; let value: String?
    let theme: HushhNativeControlAppearance
    @ObservedObject var focus: ChromeFocusRequest
    let action: () -> Void; let layout: (CGSize) -> Void
    @AccessibilityFocusState private var focused: Bool
    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                NativeAuthoredIcon(id: NativeMapActionPresentation.ids[kind] ?? "", theme: theme, size: 20)
                if kind == "map-check-in" { Text(value == "active" ? "Checked in" : "Check in").font(.system(size: 14, weight: .semibold)) }
            }.frame(maxWidth: .infinity, maxHeight: .infinity).contentShape(Rectangle())
        }.buttonStyle(.glass).buttonBorderShape(kind == "map-check-in" ? .capsule : .circle)
            .tint(Color(uiColor: theme.accent)).accessibilityLabel(label).accessibilityValue(value == "active" ? "Checked in" : "")
            .accessibilityIdentifier(kind).accessibilityFocused($focused)
            .onChange(of: focus.sequence) { _, _ in focused = true }
            .frame(width: kind == "map-check-in" ? 112 : 56, height: kind == "map-check-in" ? 44 : 56)
            .onGeometryChange(for: CGSize.self, of: { $0.size }, action: layout)
    }
}
