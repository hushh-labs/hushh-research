#if canImport(AppIntents)
import AppIntents
import Foundation

// MARK: - Thin entities backed by the current One Location index

@available(iOS 16.0, *)
struct OneContactEntity: AppEntity, Identifiable, Hashable {
    let id: String
    let name: String

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "HUSSH Contact"
    static let defaultQuery = OneContactEntityQuery()

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }
}

@available(iOS 16.0, *)
struct OneContactEntityQuery: EntityStringQuery {
    func entities(for identifiers: [OneContactEntity.ID]) async throws -> [OneContactEntity] {
        let requested = Set(identifiers)
        return OneSystemActionInvocationCoordinator.shared
            .contacts()
            .filter { requested.contains($0.id) }
            .map { OneContactEntity(id: $0.id, name: $0.name) }
    }

    func entities(matching string: String) async throws -> [OneContactEntity] {
        OneSystemActionInvocationCoordinator.shared
            .contacts(matching: string)
            .map { OneContactEntity(id: $0.id, name: $0.name) }
    }

    func suggestedEntities() async throws -> [OneContactEntity] {
        OneSystemActionInvocationCoordinator.shared
            .contacts()
            .map { OneContactEntity(id: $0.id, name: $0.name) }
    }
}

@available(iOS 16.0, *)
struct OneCircleEntity: AppEntity, Identifiable, Hashable {
    let id: String
    let name: String

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "HUSSH Circle"
    static let defaultQuery = OneCircleEntityQuery()

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }
}

@available(iOS 16.0, *)
struct OneCircleEntityQuery: EntityStringQuery {
    func entities(for identifiers: [OneCircleEntity.ID]) async throws -> [OneCircleEntity] {
        let requested = Set(identifiers)
        return OneSystemActionInvocationCoordinator.shared
            .circles()
            .filter { requested.contains($0.id) }
            .map { OneCircleEntity(id: $0.id, name: $0.name) }
    }

    func entities(matching string: String) async throws -> [OneCircleEntity] {
        OneSystemActionInvocationCoordinator.shared
            .circles(matching: string)
            .map { OneCircleEntity(id: $0.id, name: $0.name) }
    }

    func suggestedEntities() async throws -> [OneCircleEntity] {
        OneSystemActionInvocationCoordinator.shared
            .circles()
            .map { OneCircleEntity(id: $0.id, name: $0.name) }
    }
}

@available(iOS 16.0, *)
enum OneLocationDuration: String, AppEnum {
    case fifteenMinutes = "0.25"
    case thirtyMinutes = "0.5"
    case oneHour = "1"
    case twoHours = "2"
    case fourHours = "4"
    case eightHours = "8"
    case twentyFourHours = "24"

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Location Duration"
    static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .fifteenMinutes: "15 minutes",
        .thirtyMinutes: "30 minutes",
        .oneHour: "1 hour",
        .twoHours: "2 hours",
        .fourHours: "4 hours",
        .eightHours: "8 hours",
        .twentyFourHours: "24 hours"
    ]
}

@available(iOS 16.0, *)
enum OneLocationStateIntentValue: String, AppEnum {
    case on
    case off

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Location State"
    static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .on: "On",
        .off: "Off"
    ]
}

// MARK: - Shared App Intent adapter

@available(iOS 16.0, *)
struct OneAppIntentActionRequest: Equatable {
    let actionID: OneSystemActionID
    let slots: [String: String]
    let confirmedBySystem: Bool
}

@available(iOS 16.0, *)
enum OneAppIntentActionRequestFactory {
    static func shareLocation(
        recipientID: String,
        recipientName: String,
        duration: OneLocationDuration
    ) -> OneAppIntentActionRequest {
        .init(
            actionID: .shareLocation,
            slots: [
                "person": recipientName,
                "resolvedRecipientId": recipientID,
                "duration_hours": duration.rawValue
            ],
            confirmedBySystem: true
        )
    }

    static func askForLocation(
        personID: String,
        personName: String,
        duration: OneLocationDuration
    ) -> OneAppIntentActionRequest {
        .init(
            actionID: .askForLocation,
            slots: [
                "person": personName,
                "resolvedRecipientId": personID,
                "duration_hours": duration.rawValue
            ],
            confirmedBySystem: true
        )
    }

    static func stopShare(personID: String, personName: String) -> OneAppIntentActionRequest {
        .init(
            actionID: .stopShare,
            slots: ["person": personName, "resolvedRecipientId": personID],
            confirmedBySystem: true
        )
    }

    static func setLocationState(_ state: OneLocationStateIntentValue) -> OneAppIntentActionRequest {
        .init(
            actionID: state == .on ? .resumeLocation : .pauseLocation,
            slots: [:],
            confirmedBySystem: state == .on
        )
    }

    static func createCircle(name: String) -> OneAppIntentActionRequest {
        .init(
            actionID: .createCircle,
            slots: ["name": name],
            confirmedBySystem: true
        )
    }

    static func renameCircle(
        circleID: String,
        circleName: String,
        newName: String
    ) -> OneAppIntentActionRequest {
        .init(
            actionID: .renameCircle,
            slots: [
                "circle": circleName,
                "resolvedCircleId": circleID,
                "name": newName
            ],
            confirmedBySystem: true
        )
    }

    static func open(_ actionID: OneSystemActionID) -> OneAppIntentActionRequest {
        .init(actionID: actionID, slots: [:], confirmedBySystem: false)
    }
}

@available(iOS 16.0, *)
private enum OneAppIntentActionExecutor {
    static func run(_ request: OneAppIntentActionRequest) async -> String {
        guard let invocation = OneSystemActionInvocationCoordinator.shared.enqueue(
            actionID: request.actionID,
            slots: request.slots,
            confirmedBySystem: request.confirmedBySystem
        ) else {
            return "HUSSH could not prepare that action."
        }
        guard let completion = await OneSystemActionInvocationCoordinator.shared.waitForCompletion(
            id: invocation.id
        ) else {
            return "Continue in HUSSH to finish. Your request is waiting."
        }
        return completion.summary
    }
}

// MARK: - Conversational fallback

@available(iOS 16.0, *)
struct TalkToHusshOneIntent: AppIntent {
    static let title: LocalizedStringResource = "Talk to One"
    static let description = IntentDescription(
        "Open HUSSH One and begin a conversation with your private agent."
    )
    static let authenticationPolicy: IntentAuthenticationPolicy =
        .requiresLocalDeviceAuthentication
    static let openAppWhenRun = true

    @available(iOS 26.0, *)
    static let supportedModes: IntentModes = [.foreground(.immediate)]

    func perform() async throws -> some IntentResult {
        OneVoiceInvocationCoordinator.shared.enqueue()
        return .result()
    }
}

// MARK: - Direct Location actions

@available(iOS 16.0, *)
struct ShareLocationWithOneIntent: AppIntent {
    static let title: LocalizedStringResource = "Share Location"
    static let description = IntentDescription(
        "Share your live location with an existing HUSSH connection."
    )
    static let authenticationPolicy: IntentAuthenticationPolicy =
        .requiresLocalDeviceAuthentication
    static let openAppWhenRun = true

    @available(iOS 26.0, *)
    static let supportedModes: IntentModes = [.foreground(.immediate)]

    @Parameter(title: "Person")
    var recipient: OneContactEntity

    @Parameter(title: "Duration")
    var duration: OneLocationDuration

    static var parameterSummary: some ParameterSummary {
        Summary("Share location with \(\.$recipient) for \(\.$duration)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        try await requestConfirmation()
        let summary = await OneAppIntentActionExecutor.run(
            OneAppIntentActionRequestFactory.shareLocation(
                recipientID: recipient.id,
                recipientName: recipient.name,
                duration: duration
            )
        )
        return .result(dialog: "\(summary)")
    }
}

@available(iOS 16.0, *)
struct AskForLocationWithOneIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask for Location"
    static let description = IntentDescription(
        "Ask an existing HUSSH connection to share their location."
    )
    static let authenticationPolicy: IntentAuthenticationPolicy =
        .requiresLocalDeviceAuthentication
    static let openAppWhenRun = true

    @available(iOS 26.0, *)
    static let supportedModes: IntentModes = [.foreground(.immediate)]

    @Parameter(title: "Person")
    var person: OneContactEntity

    @Parameter(title: "Duration")
    var duration: OneLocationDuration

    static var parameterSummary: some ParameterSummary {
        Summary("Ask \(\.$person) for location for \(\.$duration)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        try await requestConfirmation()
        let summary = await OneAppIntentActionExecutor.run(
            OneAppIntentActionRequestFactory.askForLocation(
                personID: person.id,
                personName: person.name,
                duration: duration
            )
        )
        return .result(dialog: "\(summary)")
    }
}

@available(iOS 16.0, *)
struct StopLocationSharingWithOneIntent: AppIntent {
    static let title: LocalizedStringResource = "Stop Location Sharing"
    static let description = IntentDescription(
        "Stop sharing with one person, or pause all location updates."
    )
    static let authenticationPolicy: IntentAuthenticationPolicy =
        .requiresLocalDeviceAuthentication
    static let openAppWhenRun = true

    @available(iOS 26.0, *)
    static let supportedModes: IntentModes = [.foreground(.immediate)]

    @Parameter(title: "Person")
    var person: OneContactEntity?

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let summary: String
        if let person {
            try await requestConfirmation()
            summary = await OneAppIntentActionExecutor.run(
                OneAppIntentActionRequestFactory.stopShare(
                    personID: person.id,
                    personName: person.name
                )
            )
        } else {
            summary = await OneAppIntentActionExecutor.run(
                OneAppIntentActionRequestFactory.setLocationState(.off)
            )
        }
        return .result(dialog: "\(summary)")
    }
}

@available(iOS 16.0, *)
struct SetOneLocationStateIntent: AppIntent {
    static let title: LocalizedStringResource = "Set Location State"
    static let description = IntentDescription(
        "Turn HUSSH location updates on or off."
    )
    static let authenticationPolicy: IntentAuthenticationPolicy =
        .requiresLocalDeviceAuthentication
    static let openAppWhenRun = true

    @available(iOS 26.0, *)
    static let supportedModes: IntentModes = [.foreground(.immediate)]

    @Parameter(title: "State")
    var state: OneLocationStateIntentValue

    static var parameterSummary: some ParameterSummary {
        Summary("Turn HUSSH location \(\.$state)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        if state == .on { try await requestConfirmation() }
        let summary = await OneAppIntentActionExecutor.run(
            OneAppIntentActionRequestFactory.setLocationState(state)
        )
        return .result(dialog: "\(summary)")
    }
}

@available(iOS 16.0, *)
struct CreateOneCircleIntent: AppIntent {
    static let title: LocalizedStringResource = "Create a Circle"
    static let description = IntentDescription("Create an empty HUSSH Circle.")
    static let authenticationPolicy: IntentAuthenticationPolicy =
        .requiresLocalDeviceAuthentication
    static let openAppWhenRun = true

    @available(iOS 26.0, *)
    static let supportedModes: IntentModes = [.foreground(.immediate)]

    @Parameter(title: "Name")
    var name: String

    static var parameterSummary: some ParameterSummary {
        Summary("Create a Circle named \(\.$name)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        try await requestConfirmation()
        let summary = await OneAppIntentActionExecutor.run(
            OneAppIntentActionRequestFactory.createCircle(name: name)
        )
        return .result(dialog: "\(summary)")
    }
}

@available(iOS 16.0, *)
struct RenameOneCircleIntent: AppIntent {
    static let title: LocalizedStringResource = "Rename a Circle"
    static let description = IntentDescription("Rename an existing HUSSH Circle.")
    static let authenticationPolicy: IntentAuthenticationPolicy =
        .requiresLocalDeviceAuthentication
    static let openAppWhenRun = true

    @available(iOS 26.0, *)
    static let supportedModes: IntentModes = [.foreground(.immediate)]

    @Parameter(title: "Circle")
    var circle: OneCircleEntity

    @Parameter(title: "New Name")
    var name: String

    static var parameterSummary: some ParameterSummary {
        Summary("Rename \(\.$circle) to \(\.$name)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        try await requestConfirmation()
        let summary = await OneAppIntentActionExecutor.run(
            OneAppIntentActionRequestFactory.renameCircle(
                circleID: circle.id,
                circleName: circle.name,
                newName: name
            )
        )
        return .result(dialog: "\(summary)")
    }
}

// MARK: - Existing UI destinations (UI is the canonical executor)

@available(iOS 16.0, *)
protocol OneLocationOpenIntent: AppIntent {}

@available(iOS 16.0, *)
extension OneLocationOpenIntent {
    static var authenticationPolicy: IntentAuthenticationPolicy {
        .requiresLocalDeviceAuthentication
    }
    static var openAppWhenRun: Bool { true }

    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { [.foreground(.immediate)] }
}

@available(iOS 16.0, *)
struct OpenOneLocationIntent: OneLocationOpenIntent {
    static let title: LocalizedStringResource = "Open Location Agent"
    static let description = IntentDescription("Open the existing HUSSH Location experience.")

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let summary = await OneAppIntentActionExecutor.run(
            OneAppIntentActionRequestFactory.open(.openLocation)
        )
        return .result(dialog: "\(summary)")
    }
}

@available(iOS 16.0, *)
struct OpenOneLocationMapIntent: OneLocationOpenIntent {
    static let title: LocalizedStringResource = "Open Location Map"
    static let description = IntentDescription("Open the existing HUSSH location map.")

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let summary = await OneAppIntentActionExecutor.run(
            OneAppIntentActionRequestFactory.open(.openLocationMap)
        )
        return .result(dialog: "\(summary)")
    }
}

@available(iOS 16.0, *)
struct ViewOneActiveSharesIntent: OneLocationOpenIntent {
    static let title: LocalizedStringResource = "View Active Location Shares"
    static let description = IntentDescription("Open the list of active HUSSH location shares.")

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let summary = await OneAppIntentActionExecutor.run(
            OneAppIntentActionRequestFactory.open(.openActiveShares)
        )
        return .result(dialog: "\(summary)")
    }
}

@available(iOS 16.0, *)
struct ViewOneSharedLocationsIntent: OneLocationOpenIntent {
    static let title: LocalizedStringResource = "View Locations Shared With Me"
    static let description = IntentDescription("Open locations currently shared with you.")

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let summary = await OneAppIntentActionExecutor.run(
            OneAppIntentActionRequestFactory.open(.openSharedWithMe)
        )
        return .result(dialog: "\(summary)")
    }
}

@available(iOS 16.0, *)
struct ReviewOneLocationRequestsIntent: OneLocationOpenIntent {
    static let title: LocalizedStringResource = "Review Location Requests"
    static let description = IntentDescription("Open HUSSH location requests awaiting review.")

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let summary = await OneAppIntentActionExecutor.run(
            OneAppIntentActionRequestFactory.open(.openRequestsToReview)
        )
        return .result(dialog: "\(summary)")
    }
}

@available(iOS 16.0, *)
struct OpenOneLocationSettingsIntent: OneLocationOpenIntent {
    static let title: LocalizedStringResource = "Open Location Privacy Settings"
    static let description = IntentDescription("Open HUSSH Location privacy settings.")

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let summary = await OneAppIntentActionExecutor.run(
            OneAppIntentActionRequestFactory.open(.openLocationSettings)
        )
        return .result(dialog: "\(summary)")
    }
}

@available(iOS 16.0, *)
struct CreateOneTemporaryLocationLinkIntent: OneLocationOpenIntent {
    static let title: LocalizedStringResource = "Create Temporary Location Link"
    static let description = IntentDescription("Open the existing temporary-link composer.")

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let summary = await OneAppIntentActionExecutor.run(
            OneAppIntentActionRequestFactory.open(.openTemporaryLink)
        )
        return .result(dialog: "\(summary)")
    }
}

@available(iOS 16.0, *)
struct CheckInWithOneIntent: OneLocationOpenIntent {
    static let title: LocalizedStringResource = "Check In"
    static let description = IntentDescription(
        "Open the existing HUSSH Check-In flow to choose recipients and review before sending."
    )

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let summary = await OneAppIntentActionExecutor.run(
            OneAppIntentActionRequestFactory.open(.openCheckIn)
        )
        return .result(dialog: "\(summary)")
    }
}

@available(iOS 16.0, *)
struct OpenOneEmergencySOSIntent: OneLocationOpenIntent {
    static let title: LocalizedStringResource = "Open Emergency SOS"
    static let description = IntentDescription(
        "Open the existing HUSSH SOS review screen without sending an alert."
    )

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let summary = await OneAppIntentActionExecutor.run(
            OneAppIntentActionRequestFactory.open(.openEmergencySOS)
        )
        return .result(dialog: "\(summary)")
    }
}

// MARK: - Zero-setup Siri phrases (Apple limits an app to ten App Shortcuts)

@available(iOS 16.0, *)
struct HusshOneAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: ShareLocationWithOneIntent(),
            phrases: [
                "Share my location with \(\.$recipient) using \(.applicationName)",
                "Let \(\.$recipient) see my location with \(.applicationName)"
            ],
            shortTitle: "Share Location",
            systemImageName: "location.fill"
        )
        AppShortcut(
            intent: AskForLocationWithOneIntent(),
            phrases: [
                "Ask \(\.$person) for location using \(.applicationName)",
                "Request \(\.$person)'s location with \(.applicationName)"
            ],
            shortTitle: "Ask for Location",
            systemImageName: "location.magnifyingglass"
        )
        AppShortcut(
            intent: StopLocationSharingWithOneIntent(),
            phrases: [
                "Stop sharing location with \(\.$person) using \(.applicationName)",
                "Stop my location in \(.applicationName)"
            ],
            shortTitle: "Stop Sharing",
            systemImageName: "location.slash.fill"
        )
        AppShortcut(
            intent: SetOneLocationStateIntent(),
            phrases: [
                "Turn my \(.applicationName) location \(\.$state)"
            ],
            shortTitle: "Location On or Off",
            systemImageName: "location.circle"
        )
        AppShortcut(
            intent: CreateOneCircleIntent(),
            phrases: [
                "Create a Circle in \(.applicationName)",
                "Make a new Circle with \(.applicationName)"
            ],
            shortTitle: "Create Circle",
            systemImageName: "person.3.fill"
        )
        AppShortcut(
            intent: CheckInWithOneIntent(),
            phrases: [
                "Check in with \(.applicationName)",
                "Open Check In in \(.applicationName)"
            ],
            shortTitle: "Check In",
            systemImageName: "checkmark.circle.fill"
        )
        AppShortcut(
            intent: OpenOneLocationIntent(),
            phrases: [
                "Open Location Agent in \(.applicationName)",
                "Open Location in \(.applicationName)"
            ],
            shortTitle: "Open Location",
            systemImageName: "location.circle.fill"
        )
        AppShortcut(
            intent: OpenOneLocationMapIntent(),
            phrases: [
                "Open my location map in \(.applicationName)",
                "Show the location map in \(.applicationName)"
            ],
            shortTitle: "Location Map",
            systemImageName: "map.fill"
        )
        AppShortcut(
            intent: ReviewOneLocationRequestsIntent(),
            phrases: [
                "Review location requests in \(.applicationName)",
                "Show pending location requests in \(.applicationName)"
            ],
            shortTitle: "Review Requests",
            systemImageName: "person.crop.circle.badge.questionmark"
        )
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
