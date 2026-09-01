#if canImport(AppIntents)
import AppIntents

@available(iOS 16.0, *)
struct TalkToHusshOneIntent: AppIntent {
    static let title: LocalizedStringResource = "Talk to One"
    static let description = IntentDescription(
        "Open Hussh One and begin a conversation with your private agent."
    )
    static let authenticationPolicy: IntentAuthenticationPolicy =
        .requiresLocalDeviceAuthentication

    // AppIntent uses this on iOS 16-25. iOS 26 uses supportedModes below.
    static let openAppWhenRun = true

    @available(iOS 26.0, *)
    static let supportedModes: IntentModes = [.foreground(.immediate)]

    func perform() async throws -> some IntentResult {
        OneVoiceInvocationCoordinator.shared.enqueue()
        return .result()
    }
}

@available(iOS 16.0, *)
struct HusshOneAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: TalkToHusshOneIntent(),
            phrases: [
                "Talk to \(.applicationName)",
                "Ask \(.applicationName)"
            ],
            shortTitle: "Talk to One",
            systemImageName: "waveform.circle.fill"
        )
    }

    static let shortcutTileColor: ShortcutTileColor = .navy
}
#endif
