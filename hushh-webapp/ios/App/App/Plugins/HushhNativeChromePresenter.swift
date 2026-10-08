import SwiftUI
import UIKit

/// Public preference controls use the existing fenced presenter outside the chat pilot.
enum HushhNativePreferencePresentation {
    static var families: [String] {
        families(for: UIDevice.current.userInterfaceIdiom)
    }
    static func families(for idiom: UIUserInterfaceIdiom) -> [String] {
        if #available(iOS 17.0, *), idiom == .phone || idiom == .pad {
            return ["appearance", "accent"]
        }
        return []
    }
    static func admitsWidth(_ width: Double, kind: String) -> Bool {
        width.isFinite && ((132...320).contains(width) || (kind == "accent" && width == 44))
    }
    @available(iOS 17.0, *)
    static func control(kind: String, value: String?, width: CGFloat, theme: HushhNativeControlAppearance, focus: ChromeFocusRequest,
                        select: @escaping (String) -> Void, open: @escaping () -> Void, layout: @escaping (CGSize) -> Void) -> AnyView? {
        if kind == "appearance" {
            return AnyView(NativeAppearanceSelector(selected: value ?? "system", width: width, theme: theme, action: select, layout: layout))
        }
        if kind == "accent", width >= 132 {
            return AnyView(NativeAccentSelector(selected: value ?? "blue", width: width, theme: theme, action: open, layout: layout, focus: focus))
        }
        return nil // Preserve the previous icon presentation for legacy 44pt accent slots.
    }
}

/// System remains the saved preference; it is never replaced by resolved darkness.
@available(iOS 17.0, *)
struct NativeAppearanceSelector: View {
    let selected: String
    let width: CGFloat
    let theme: HushhNativeControlAppearance
    let action: (String) -> Void
    let layout: (CGSize) -> Void
    var body: some View {
        Picker("Appearance", selection: Binding(get: { selected }, set: action)) {
            Image(systemName: "sun.max").tag("light").accessibilityLabel("Light")
            Image(systemName: "moon").tag("dark").accessibilityLabel("Dark")
            Image(systemName: "desktopcomputer").tag("system").accessibilityLabel("System")
        }
        .pickerStyle(.segmented).controlSize(.large)
        .tint(Color(uiColor: theme.accent)).accessibilityIdentifier("profile-appearance")
        .frame(width: width, height: 44)
        .onGeometryChange(for: CGSize.self, of: { $0.size }, action: layout)
    }
}

/// The saved color and its menu opener occupy one native, accessible control.
@available(iOS 17.0, *)
struct NativeAccentSelector: View {
    let selected: String
    let width: CGFloat
    let theme: HushhNativeControlAppearance
    let action: () -> Void
    let layout: (CGSize) -> Void
    @ObservedObject var focus: ChromeFocusRequest
    @AccessibilityFocusState private var accessibilityFocused: Bool
    var body: some View {
        styledButton
        .buttonBorderShape(.capsule).tint(Color(uiColor: theme.accent))
        .accessibilityLabel("App accent color").accessibilityValue(selected == "gold" ? "Molten Gold" : "iOS Blue")
        .accessibilityIdentifier("profile-accent").accessibilityFocused($accessibilityFocused)
        .onChange(of: focus.sequence) { _, _ in accessibilityFocused = true }
        .frame(width: width, height: 44)
        .onGeometryChange(for: CGSize.self, of: { $0.size }, action: layout)
    }

    @ViewBuilder
    private var styledButton: some View {
        if #available(iOS 26.0, *) { button.buttonStyle(.glass) }
        else { button.buttonStyle(.bordered) }
    }

    private var button: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Circle().fill(Color(uiColor: theme.accent)).frame(width: 12, height: 12)
                Text(selected == "gold" ? "Molten Gold" : "iOS Blue").font(.subheadline)
                Image(systemName: "chevron.down").font(.caption.weight(.semibold))
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
                .foregroundStyle(Color(uiColor: theme.foreground))
        }
    }
}

struct HushhChromeOption {
    let value: String
    let label: String
    let disabled: Bool
}

/// An owned presentation, not a second router. Completion means UIKit has
/// actually detached the presenter, including retirement during its opening.
final class HushhNativeChromePresenter: NSObject, UIAdaptivePresentationControllerDelegate {
    private weak var parent: UIViewController?
    private let controller: UIViewController
    private var opening = true
    private var closing = false
    private var retired = false
    private var completions: [() -> Void] = []
    private var retirementToken: UUID?
    private var result: String?
    private let onChoice: (String, Int) -> Void
    private var updateSequence: Int
    private var sourceValue: String?
    private var draft: HushhChromeDraft?
    private var menuActions = [(UIAlertAction, Bool)]()
    var didRetire: (() -> Void)?

    init(parent: UIViewController, controller: UIViewController, updateSequence: Int, onChoice: @escaping (String, Int) -> Void) {
        self.parent = parent
        self.controller = controller
        self.onChoice = onChoice
        self.updateSequence = updateSequence
    }
    func update(theme: HushhNativeControlAppearance, value: String?, enabled: Bool, sequence: Int) {
        guard !closing, !retired, sequence > updateSequence else { return }
        updateSequence = sequence
        controller.overrideUserInterfaceStyle = theme.style
        controller.view.tintColor = theme.accent
        draft?.accent = theme.accent
        draft?.enabled = enabled
        menuActions.forEach { action, admitted in action.isEnabled = enabled && admitted }
        // Appearance alone must not overwrite a wheel's transient draft.
        if value != sourceValue, let value { draft?.value = value }
        sourceValue = value
    }

    func present() {
        parent?.present(controller, animated: true) { [self] in
            opening = false
            HushhSessionPrivacyShield.shared.reassertCover()
            if closing { dismissOwned() }
        }
        controller.presentationController?.delegate = self
    }

    func choose(_ value: String?) {
        guard !closing, !retired else { return }
        result = value
        retire {}
    }

    func retire(completion: @escaping () -> Void) {
        if retired { completion(); return }
        completions.append(completion)
        if closing { return }
        closing = true
        retirementToken = HushhSessionPrivacyShield.shared.beginPresentationRetirement()
        if !opening { dismissOwned() }
    }

    private func dismissOwned() {
        guard controller.presentingViewController != nil else { finish(); return }
        controller.dismiss(animated: false) { [self] in finish() }
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        result = nil
        finish()
    }

    private func finish() {
        guard !retired, controller.presentingViewController == nil else { return }
        retired = true
        didRetire?()
        if let retirementToken { HushhSessionPrivacyShield.shared.completePresentationRetirement(retirementToken) }
        let callbacks = completions
        completions.removeAll()
        // Invalidating the owning slot before dismissal makes this a no-op.
        if let result { onChoice(result, updateSequence) }
        callbacks.forEach { $0() }
    }

    static func menu(parent: UIViewController, source: UIView, title: String, options: [HushhChromeOption],
                     theme: HushhNativeControlAppearance, sequence: Int, onChoice: @escaping (String, Int) -> Void) -> HushhNativeChromePresenter {
        let alert = UIAlertController(title: title, message: nil, preferredStyle: .actionSheet)
        let presenter = HushhNativeChromePresenter(parent: parent, controller: alert, updateSequence: sequence, onChoice: onChoice)
        for option in options {
            let action = UIAlertAction(title: option.label, style: .default) { [weak presenter] _ in presenter?.choose(option.value) }
            action.isEnabled = !option.disabled
            presenter.menuActions.append((action, !option.disabled))
            alert.addAction(action)
        }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak presenter] _ in presenter?.choose(nil) })
        alert.overrideUserInterfaceStyle = theme.style
        alert.view.tintColor = theme.accent
        alert.popoverPresentationController?.sourceView = source
        alert.popoverPresentationController?.sourceRect = source.bounds
        return presenter
    }

    static func selection(parent: UIViewController, title: String, value: String, options: [HushhChromeOption],
                          theme: HushhNativeControlAppearance, sequence: Int, onChoice: @escaping (String, Int) -> Void) -> HushhNativeChromePresenter {
        // Bind via a weak box to avoid retaining the presenter through rootView.
        let box = WeakChromePresenter()
        let draft = HushhChromeDraft(value: value, accent: theme.accent)
        let root = HushhBoundedSelection(title: title, draft: draft, options: options,
                                        complete: { [box] value in box.value?.choose(value) })
        let host = UIHostingController(rootView: root)
        let presenter = HushhNativeChromePresenter(parent: parent, controller: host, updateSequence: sequence, onChoice: onChoice)
        presenter.draft = draft
        presenter.sourceValue = value
        box.value = presenter
        configure(host, theme: theme)
        return presenter
    }

    static func date(parent: UIViewController, title: String, value: Date, bounds: ClosedRange<Date>,
                     theme: HushhNativeControlAppearance, sequence: Int, onChoice: @escaping (String, Int) -> Void) -> HushhNativeChromePresenter {
        let box = WeakChromePresenter()
        let draft = HushhChromeDraft(value: HushhBoundedDate.format(value), accent: theme.accent)
        let host = UIHostingController(rootView: HushhBoundedDate(title: title, draft: draft, initialValue: value, bounds: bounds,
            complete: { [box] value in box.value?.choose(value) }))
        let presenter = HushhNativeChromePresenter(parent: parent, controller: host, updateSequence: sequence, onChoice: onChoice)
        presenter.draft = draft
        presenter.sourceValue = draft.value
        box.value = presenter
        configure(host, theme: theme)
        return presenter
    }

    private static func configure(_ host: UIViewController, theme: HushhNativeControlAppearance) {
        host.overrideUserInterfaceStyle = theme.style
        host.modalPresentationStyle = .pageSheet
        host.sheetPresentationController?.detents = [.medium(), .large()]
        host.view.backgroundColor = .systemBackground
    }
    static func parseDate(_ value: String?) -> Date? { HushhBoundedDate.parse(value) }
}

private final class WeakChromePresenter { weak var value: HushhNativeChromePresenter? }

private final class HushhChromeDraft: ObservableObject {
    @Published var value: String
    @Published var accent: UIColor
    @Published var enabled = true
    init(value: String, accent: UIColor) { self.value = value; self.accent = accent }
}

private struct HushhBoundedSelection: View {
    let title: String
    @ObservedObject var draft: HushhChromeDraft
    let options: [HushhChromeOption]
    let complete: (String?) -> Void
    var body: some View {
        VStack(spacing: 16) {
            HStack {
                Button("Cancel") { complete(nil) }.frame(minWidth: 44, minHeight: 44)
                Text(title).font(.headline).multilineTextAlignment(.center).frame(maxWidth: .infinity)
                Button("Done") { complete(draft.value) }.frame(minWidth: 44, minHeight: 44)
                    .disabled(!draft.enabled || !options.contains { $0.value == draft.value && !$0.disabled })
            }.frame(minHeight: 44)
            Picker(title, selection: $draft.value) {
                ForEach(options.filter { !$0.disabled }, id: \.value) { Text($0.label).tag($0.value) }
            }.pickerStyle(.wheel).disabled(!draft.enabled)
        }.padding().tint(Color(uiColor: draft.accent))
    }
}

private struct HushhBoundedDate: View {
    let title: String
    @ObservedObject var draft: HushhChromeDraft
    let initialValue: Date
    let bounds: ClosedRange<Date>
    let complete: (String?) -> Void
    var body: some View {
        VStack(spacing: 16) {
            HStack {
                Button("Cancel") { complete(nil) }.frame(minWidth: 44, minHeight: 44)
                Text(title).font(.headline).multilineTextAlignment(.center).frame(maxWidth: .infinity)
                Button("Done") { complete(draft.value) }.frame(minWidth: 44, minHeight: 44).disabled(!draft.enabled)
            }.frame(minHeight: 44)
            DatePicker(title, selection: Binding(get: { Self.parse(draft.value) ?? initialValue },
                set: { draft.value = Self.format($0) }), in: bounds, displayedComponents: .date)
                .datePickerStyle(.wheel).labelsHidden()
                .disabled(!draft.enabled)
                .environment(\.timeZone, TimeZone(secondsFromGMT: 0)!)
        }.padding().tint(Color(uiColor: draft.accent))
    }
    static func parse(_ value: String?) -> Date? {
        guard let value else { return nil }
        let formatter = formatter()
        guard let date = formatter.date(from: value), formatter.string(from: date) == value else { return nil }
        return date
    }
    static func format(_ value: Date) -> String { formatter().string(from: value) }
    private static func formatter() -> DateFormatter {
        let value = DateFormatter()
        value.locale = Locale(identifier: "en_US_POSIX")
        value.timeZone = TimeZone(secondsFromGMT: 0)
        value.dateFormat = "yyyy-MM-dd"
        value.isLenient = false
        return value
    }
}
