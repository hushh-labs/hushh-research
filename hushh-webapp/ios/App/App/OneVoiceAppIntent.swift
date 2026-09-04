#if canImport(AppIntents)
import AppIntents
import Foundation

// MARK: - Thin entities backed by the current One Location index

@available(iOS 16.0, *)
struct OneContactEntity: AppEntity, Identifiable, Hashable {
    let id: String
    let name: String

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Agent One Contact"
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

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Agent One Circle"
    static let defaultQuery = OneCircleEntityQuery()

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }
}

/// A bounded, non-sensitive description of a destination inside One Location.
/// The entity teaches Siri that "Location Agent" is content owned by One,
/// rather than the name of another installed app.
@available(iOS 16.0, *)
struct OneLocationDestinationEntity: AppEntity, Identifiable, Hashable {
    let id: String

    static let typeDisplayRepresentation: TypeDisplayRepresentation =
        "Agent One Location Destination"
    static let defaultQuery = OneLocationDestinationEntityQuery()

    static let supportedActionIDs: [OneSystemActionID] = [
        .openLocation,
        .openLocationMap,
        .openActiveShares,
        .openSharedWithMe,
        .openRequestsToReview,
        .openLocationSettings,
        .openTemporaryLink,
        .openCheckIn,
        .openEmergencySOS,
        .openSMSContacts
    ]

    static let all: [Self] = supportedActionIDs.map {
        Self(id: $0.rawValue)
    }

    var actionID: OneSystemActionID? {
        guard
            let candidate = OneSystemActionID(rawValue: id),
            Self.supportedActionIDs.contains(candidate)
        else { return nil }
        return candidate
    }

    var displayRepresentation: DisplayRepresentation {
        switch actionID {
        case .openLocation:
            return makeDisplay(
                title: "Location Agent",
                synonyms: ["Agent One Location Agent", "One Location Agent", "Location Overview"]
            )
        case .openLocationMap:
            return makeDisplay(
                title: "Location Map",
                synonyms: ["Agent One Location Map", "One Location Map", "Map"]
            )
        case .openActiveShares:
            return makeDisplay(
                title: "Active Location Shares",
                synonyms: ["Active Shares", "Who Can See Me"]
            )
        case .openSharedWithMe:
            return makeDisplay(
                title: "Locations Shared With Me",
                synonyms: ["Shared With Me", "People Sharing With Me"]
            )
        case .openRequestsToReview:
            return makeDisplay(
                title: "Location Requests",
                synonyms: ["Pending Location Requests", "Requests to Review"]
            )
        case .openLocationSettings:
            return makeDisplay(
                title: "Location Settings",
                synonyms: ["Location Privacy", "Location Privacy Settings"]
            )
        case .openTemporaryLink:
            return makeDisplay(
                title: "Temporary Location Link",
                synonyms: ["Location Link", "Temporary Link"]
            )
        case .openCheckIn:
            return makeDisplay(
                title: "Location Check In",
                synonyms: ["Check In", "Agent One Check In", "One Check In"]
            )
        case .openEmergencySOS:
            return makeDisplay(
                title: "Emergency SOS Review",
                synonyms: ["SOS Review", "Emergency Screen"]
            )
        case .openSMSContacts:
            return makeDisplay(
                title: "Emergency SMS Contacts",
                synonyms: ["SMS Contacts", "Emergency Contacts"]
            )
        default:
            return "Agent One Location"
        }
    }

    private func makeDisplay(
        title: LocalizedStringResource,
        synonyms: [LocalizedStringResource]
    ) -> DisplayRepresentation {
        if #available(iOS 17.0, *) {
            return .init(title: title, synonyms: synonyms)
        }
        return .init(title: title)
    }

    var searchableNames: [String] {
        switch actionID {
        case .openLocation:
            return ["location agent", "one location agent", "location overview"]
        case .openLocationMap:
            return ["location map", "one location map", "map"]
        case .openActiveShares:
            return ["active location shares", "active shares", "who can see me"]
        case .openSharedWithMe:
            return ["locations shared with me", "shared with me", "people sharing with me"]
        case .openRequestsToReview:
            return ["location requests", "pending location requests", "requests to review"]
        case .openLocationSettings:
            return ["location settings", "location privacy", "privacy settings"]
        case .openTemporaryLink:
            return ["temporary location link", "location link", "temporary link"]
        case .openCheckIn:
            return ["location check in", "check in", "check-in"]
        case .openEmergencySOS:
            return ["emergency sos review", "sos review", "emergency screen"]
        case .openSMSContacts:
            return ["emergency sms contacts", "sms contacts", "emergency contacts"]
        default:
            return []
        }
    }
}

@available(iOS 16.0, *)
struct OneLocationDestinationEntityQuery: EntityStringQuery {
    func entities(
        for identifiers: [OneLocationDestinationEntity.ID]
    ) async throws -> [OneLocationDestinationEntity] {
        let requested = Set(identifiers)
        return OneLocationDestinationEntity.all.filter {
            requested.contains($0.id)
        }
    }

    func entities(matching string: String) async throws -> [OneLocationDestinationEntity] {
        let query = Self.normalize(string)
        guard !query.isEmpty else { return OneLocationDestinationEntity.all }
        return OneLocationDestinationEntity.all.filter { destination in
            destination.searchableNames.contains { candidate in
                let normalized = Self.normalize(candidate)
                return normalized == query || normalized.contains(query) || query.contains(normalized)
            }
        }
    }

    func suggestedEntities() async throws -> [OneLocationDestinationEntity] {
        OneLocationDestinationEntity.all
    }

    private static func normalize(_ value: String) -> String {
        value
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            .split(whereSeparator: { !$0.isLetter && !$0.isNumber })
            .joined(separator: " ")
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
        .on: DisplayRepresentation(
            title: "On",
            synonyms: ["Enable", "Enabled", "Resume", "Resumed", "Start"]
        ),
        .off: DisplayRepresentation(
            title: "Off",
            synonyms: ["Disable", "Disabled", "Pause", "Paused", "Stop"]
        )
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
            confirmedBySystem: OneSystemActionID.shareLocation.requiresSystemConfirmation
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
            confirmedBySystem: OneSystemActionID.askForLocation.requiresSystemConfirmation
        )
    }

    static func stopShare(personID: String, personName: String) -> OneAppIntentActionRequest {
        .init(
            actionID: .stopShare,
            slots: ["person": personName, "resolvedRecipientId": personID],
            confirmedBySystem: OneSystemActionID.stopShare.requiresSystemConfirmation
        )
    }

    static func setLocationState(_ state: OneLocationStateIntentValue) -> OneAppIntentActionRequest {
        .init(
            actionID: state == .on ? .resumeLocation : .pauseLocation,
            slots: [:],
            confirmedBySystem: (state == .on ? OneSystemActionID.resumeLocation : .pauseLocation)
                .requiresSystemConfirmation
        )
    }

    static func createCircle(name: String) -> OneAppIntentActionRequest {
        .init(
            actionID: .createCircle,
            slots: ["name": name],
            confirmedBySystem: OneSystemActionID.createCircle.requiresSystemConfirmation
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
            confirmedBySystem: OneSystemActionID.renameCircle.requiresSystemConfirmation
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
            return "Agent One could not prepare that action."
        }
        guard let result = await OneSystemActionInvocationCoordinator.shared.waitForCompletionOrProgress(
            id: invocation.id
        ) else {
            return "Continue in Agent One to finish. Your request is waiting."
        }
        switch result {
        case .completion(let completion):
            return completion.summary
        case .progress(let progress):
            switch progress.state {
            case .waitingForVault:
                return "Agent One's Vault is locked. I've opened the app for you. Unlock your Vault, and I'll continue your request."
            }
        }
    }
}

// MARK: - Conversational fallback

@available(iOS 16.0, *)
struct TalkToHusshOneIntent: AppIntent {
    static let title: LocalizedStringResource = "Talk to Agent One"
    static let description = IntentDescription(
        "Open Agent One and begin a conversation with your private agent."
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
        "Share your live location with an existing Agent One connection."
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
        "Ask an existing Agent One connection to share their location."
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
        "Turn Agent One Location updates on or off."
    )
    static let authenticationPolicy: IntentAuthenticationPolicy =
        .requiresLocalDeviceAuthentication
    static let openAppWhenRun = true

    @available(iOS 26.0, *)
    static let supportedModes: IntentModes = [.foreground(.immediate)]

    @Parameter(title: "State")
    var state: OneLocationStateIntentValue

    static var parameterSummary: some ParameterSummary {
        Summary("Turn Agent One Location \(\.$state)")
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
    static let description = IntentDescription("Create an empty Agent One Circle.")
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
    static let description = IntentDescription("Rename an existing Agent One Circle.")
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

/// The canonical system-level opening action. `OpenIntent` tells Siri this is
/// app-owned content, while the destination entity resolves phrases such as
/// "Open Agent One Location Agent" without creating a parallel route executor.
@available(iOS 16.0, *)
struct OpenOneLocationDestinationIntent: OpenIntent {
    static let title: LocalizedStringResource = "Open Agent One Location"
    static let description = IntentDescription(
        "Open a destination in the existing Agent One Location experience."
    )
    static let authenticationPolicy: IntentAuthenticationPolicy =
        .requiresLocalDeviceAuthentication
    static let openAppWhenRun = true

    @available(iOS 26.0, *)
    static let supportedModes: IntentModes = [.foreground(.immediate)]

    @Parameter(
        title: "Destination",
        requestValueDialog: "Which Agent One Location destination?"
    )
    var target: OneLocationDestinationEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Open \(\.$target) in Agent One")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let actionID = target.actionID else {
            return .result(dialog: "That Agent One Location destination is unavailable.")
        }
        let summary = await OneAppIntentActionExecutor.run(
            OneAppIntentActionRequestFactory.open(actionID)
        )
        return .result(dialog: "\(summary)")
    }
}

@available(iOS 16.0, *)
struct OpenOneLocationIntent: OneLocationOpenIntent {
    static let title: LocalizedStringResource = "Open Location Agent"
    static let description = IntentDescription("Open the existing Agent One Location experience.")

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
    static let description = IntentDescription("Open the existing Agent One Location map.")

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
    static let description = IntentDescription("Open the list of active Agent One Location shares.")

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
    static let description = IntentDescription("Open Agent One Location requests awaiting review.")

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
    static let description = IntentDescription("Open Agent One Location privacy settings.")

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
        "Open the existing Agent One Check-In flow to choose recipients and review before sending."
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
        "Open the existing Agent One SOS review screen without sending an alert."
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
                "Share my location with \(\.$recipient) in \(.applicationName) Location Agent",
                "Let \(\.$recipient) see my location with \(.applicationName)",
                "Ask \(.applicationName) to share my location with \(\.$recipient)",
                "Tell \(.applicationName) to share my location with \(\.$recipient)",
                "Talk to \(.applicationName) and share my location with \(\.$recipient)"
            ],
            shortTitle: "Share Location",
            systemImageName: "location.fill"
        )
        AppShortcut(
            intent: AskForLocationWithOneIntent(),
            phrases: [
                "Ask \(\.$person) for location in \(.applicationName) Location Agent",
                "Request \(\.$person)'s location with \(.applicationName)",
                "Ask \(.applicationName) to ask \(\.$person) for location",
                "Tell \(.applicationName) to request \(\.$person)'s location",
                "Talk to \(.applicationName) and ask \(\.$person) for location"
            ],
            shortTitle: "Ask for Location",
            systemImageName: "location.magnifyingglass"
        )
        AppShortcut(
            intent: StopLocationSharingWithOneIntent(),
            phrases: [
                "Stop sharing location with \(\.$person) in \(.applicationName) Location Agent",
                "Stop my location in \(.applicationName) Location Agent",
                "Ask \(.applicationName) to stop sharing location with \(\.$person)",
                "Tell \(.applicationName) to stop sharing location with \(\.$person)",
                "Talk to \(.applicationName) and stop sharing location with \(\.$person)",
                "Ask \(.applicationName) to pause my location",
                "Tell \(.applicationName) to pause my location",
                "Talk to \(.applicationName) and pause my location"
            ],
            shortTitle: "Stop Sharing",
            systemImageName: "location.slash.fill"
        )
        AppShortcut(
            intent: SetOneLocationStateIntent(),
            phrases: [
                "Turn \(.applicationName) Location \(\.$state)",
                "Ask \(.applicationName) to turn Location \(\.$state)",
                "Tell \(.applicationName) to turn Location \(\.$state)",
                "Talk to \(.applicationName) and turn Location \(\.$state)"
            ],
            shortTitle: "Location On or Off",
            systemImageName: "location.circle"
        )
        AppShortcut(
            intent: CreateOneCircleIntent(),
            phrases: [
                "Create a Circle in \(.applicationName) Location Agent",
                "Make a new Circle in \(.applicationName) Location Agent",
                "Ask \(.applicationName) to create a Circle",
                "Tell \(.applicationName) to create a Circle",
                "Talk to \(.applicationName) and create a Circle"
            ],
            shortTitle: "Create Circle",
            systemImageName: "person.3.fill"
        )
        AppShortcut(
            intent: RenameOneCircleIntent(),
            phrases: [
                "Rename \(\.$circle) in \(.applicationName) Location Agent",
                "Ask \(.applicationName) to rename \(\.$circle)",
                "Tell \(.applicationName) to rename \(\.$circle)",
                "Talk to \(.applicationName) and rename \(\.$circle)"
            ],
            shortTitle: "Rename Circle",
            systemImageName: "pencil.circle.fill"
        )
        AppShortcut(
            intent: CheckInWithOneIntent(),
            phrases: [
                "Check in with \(.applicationName) Location Agent",
                "Open \(.applicationName) Location Check In",
                "Ask \(.applicationName) to check in",
                "Tell \(.applicationName) to open Check In",
                "Talk to \(.applicationName) and check in"
            ],
            shortTitle: "Check In",
            systemImageName: "checkmark.circle.fill"
        )
        AppShortcut(
            intent: OpenOneLocationDestinationIntent(),
            phrases: [
                "Open \(.applicationName) \(\.$target)",
                "Show \(\.$target) in \(.applicationName)",
                "Ask \(.applicationName) to open \(\.$target)",
                "Tell \(.applicationName) to show \(\.$target)",
                "Talk to \(.applicationName) and open \(\.$target)"
            ],
            shortTitle: "Open Agent One Location",
            systemImageName: "location.circle.fill"
        )
        AppShortcut(
            intent: TalkToHusshOneIntent(),
            phrases: [
                "Talk to \(.applicationName)",
                "Start a conversation with \(.applicationName)"
            ],
            shortTitle: "Talk to Agent One",
            systemImageName: "waveform.circle.fill"
        )
    }

    static let shortcutTileColor: ShortcutTileColor = .navy
}
#endif
