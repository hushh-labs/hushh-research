import SwiftUI
import UIKit

/// Shared rendering of generated, authored Hussh SVG geometry. Native never
/// guesses an operation or substitutes a different symbol for an unknown ID.
struct NativeAuthoredIcon: View {
    let id: String
    private let accent: UIColor
    private let foreground: UIColor?
    let size: CGFloat
    init(id: String, accentHex: String, foregroundHex: String? = nil, size: CGFloat = 24) {
        self.id = id; accent = HushhNativeControlAppearance.color(accentHex) ?? .label
        foreground = HushhNativeControlAppearance.color(foregroundHex); self.size = size
    }
    init(id: String, theme: HushhNativeControlAppearance, size: CGFloat = 24) {
        self.id = id; accent = theme.accent; foreground = theme.foreground; self.size = size
    }
    var body: some View {
        if let artwork = NativeProfileArtwork.resolve(id) {
            ZStack {
                Image(uiImage: artwork.base).resizable()
                    .foregroundStyle(Color(uiColor: HushhNativeControlAppearance.color(artwork.colorHex) ?? foreground ?? .label))
                if let accent = artwork.accent {
                    Image(uiImage: accent).resizable()
                        .foregroundStyle(Color(uiColor: HushhNativeControlAppearance.color(artwork.accentColorHex) ?? self.accent))
                }
            }.frame(width: size, height: size).accessibilityHidden(true)
        }
    }
}
