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

/// A fixed set of destinations inside Agent One Location, exposed to Siri
/// as an AppEnum so one intent handles all navigation. Apple limits apps to
/// ten App Shortcuts — using an enum means one slot covers all ten screens.
@available(iOS 16.0, *)
enum AgentOneDestination: String, AppEnum {
    case location = "location"
    case map = "map"
    case activeShares = "active_shares"
    case sharedWithMe = "shared_with_me"
    case requestsToReview = "requests_to_review"
    case settings = "settings"
    case temporaryLink = "temporary_link"
    case checkIn = "check_in"
    case emergencySOS = "emergency_sos"
    case emergencySMSContacts = "emergency_sms"

    static let typeDisplayRepresentation: TypeDisplayRepresentation =
        "Agent One Location Destination"
    static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .location: "Location Agent",
        .map: "Location Map",
        .activeShares: "Active Location Shares",
        .sharedWithMe: "Locations Shared With Me",
        .requestsToReview: "Location Requests",
        .settings: "Location Settings",
        .temporaryLink: "Temporary Location Link",
        .checkIn: "Location Check In",
        .emergencySOS: "Emergency SOS Review",
        .emergencySMSContacts: "Emergency SMS Contacts",
    ]

    var actionID: OneSystemActionID {
        switch self {
        case .location: return .openLocation
        case .map: return .openLocationMap
        case .activeShares: return .openActiveShares
        case .sharedWithMe: return .openSharedWithMe
        case .requestsToReview: return .openRequestsToReview
        case .settings: return .openLocationSettings
        case .temporaryLink: return .openTemporaryLink
        case .checkIn: return .openCheckIn
        case .emergencySOS: return .openEmergencySOS
        case .emergencySMSContacts: return .openSMSContacts
        }
    }
}

/// Thin query target backed by AgentOneDestination. The entity teaches Siri
/// that "Location Agent" is content owned by One, rather than the name of
/// another installed app. Display names come from the enum; this struct
/// exists solely for EntityStringQuery resolution.
@available(iOS 16.0, *)
struct OneLocationDestinationEntity: AppEntity, Identifiable, Hashable {
    let id: String

    static let typeDisplayRepresentation: TypeDisplayRepresentation =
        "Agent One Location Destination"
    static let defaultQuery = OneLocationDestinationEntityQuery()

    static let all: [Self] = AgentOneDestination.allCases.map {
        Self(id: $0.rawValue)
    }

    var actionID: OneSystemActionID? {
        guard let destination = AgentOneDestination(rawValue: id) else { return nil }
        return destination.actionID
    }

    var displayRepresentation: DisplayRepresentation {
        guard let destination = AgentOneDestination(rawValue: id) else {
            return "Agent One Location"
        }
        return DisplayRepresentation(title: destination.caseDisplayRepresentations[destination]?.title ?? "Agent One Location")
    }

    var searchableNames: [String] {
        guard let destination = AgentOneDestination(rawValue: id) else { return [] }
        // Derive searchable tokens from the display title.
        let title = destination.caseDisplayRepresentations[destination]?.title ?? ""
        let normalized = title
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            .split(whereSeparator: { !$0.isLetter && !$0.isNumber })
            .joined(separator: " ")
        return [normalized]
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

@available(iOS 16.0, *)
struct OpenOneDestinationIntent: OneLocationOpenIntent {
    static let title: LocalizedStringResource = "Open Agent One Location"
    static let description = IntentDescription(
        "Open a specific screen inside Agent One Location — for example, the map, active shares, settings, or emergency SOS."
    )

    @Parameter(title: "Destination")
    var destination: AgentOneDestination

    static var parameterSummary: some ParameterSummary {
        Summary("Open \(\.$destination) in Agent One Location")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let summary = await OneAppIntentActionExecutor.run(
            OneAppIntentActionRequestFactory.open(destination.actionID)
        )
        return .result(dialog: "\(summary)")
    }
}

// MARK: - Free-text request capture intent

@available(iOS 16.0, *)
struct AskOneRequestIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask Agent One"
    static let description = IntentDescription(
        "Send a free-form request to Agent One for semantic interpretation and action execution."
    )
    static let authenticationPolicy: IntentAuthenticationPolicy =
        .requiresLocalDeviceAuthentication
    static let openAppWhenRun = true

    @available(iOS 26.0, *)
    static let supportedModes: IntentModes = [.foreground(.immediate)]

    @Parameter(title: "Request", optionsProvider: OneRequestTextOptionsProvider())
    var requestText: String

    static var parameterSummary: some ParameterSummary {
        Summary("Ask Agent One to \(\.$requestText)")
    }

    func perform() async throws -> some IntentResult & ShowsSnippetView {
        guard !requestText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return .result(
                snippet: .init(string: "What would you like Agent One to do?")
            )
        }

        let result = OneSystemRequestInvocationCoordinator.shared.captureRequest(requestText)
        switch result {
        case .captured:
            return .result(
                snippet: .init(string: "Your request is with Agent One. Continue in the app to complete it.")
            )
        case .ownerRequired:
            return .result(
                snippet: .init(string: "Sign in to Agent One to send a request from here.")
            )
        case .tooLarge:
            return .result(
                snippet: .init(string: "That request is too long. Try a shorter phrase.")
            )
        case .alreadyPending:
            return .result(
                snippet: .init(string: "Agent One is already handling a request. Complete or cancel it first.")
            )
        case .failure:
            return .result(
                snippet: .init(string: "I couldn't capture that request right now. Try again in the app.")
            )
        @unknown default:
            return .result(
                snippet: .init(string: "Continue in Agent One to complete your request.")
            )
        }
    }
}

@available(iOS 16.0, *)
struct OneRequestTextOptionsProvider: DynamicOptionsProvider {
    typealias Intent = AskOneRequestIntent

    func results() async throws -> [IntentStringOption] {
        []
    }
}

// MARK: - Zero-setup Siri phrases (Apple limits an app to ten App Shortcuts)

@available(iOS 16.0, *)
struct HusshOneAppShortcuts: AppShortcutsProvider {
    private static let agentOne = ".applicationName"

    // MARK: - Share Location phrase family
    //
    // Eight semantically distinct anchors teach Siri that every reasonable
    // way of asking to share one's location resolves to the same intent.
    // Apple's semantic similarity index generalises beyond these exact strings,
    // but diversity here is what seeds that index.
    // No phrase hardcodes a person name — the recipient is always the
    // `\.$recipient` slot so Siri resolves against Agent One's contact entities.

    private static let shareLocationPhrases: [String] = [
        "Share my location with \(\.$recipient) in \(agentOne) Location Agent",
        "Let \(\.$recipient) see my location with \(agentOne)",
        "Agent One, share my location with \(\.$recipient)",
        "Ask \(agentOne) to share my location with \(\.$recipient)",
        "Tell \(agentOne) to share my location with \(\.$recipient)",
        "Use \(agentOne) to share my location with \(\.$recipient)",
        "Share my location to \(\.$recipient) using \(agentOne)",
        "Start sharing my location in \(agentOne) with \(\.$recipient)",
        "Turn on location sharing with \(\.$recipient) in \(agentOne)",
        "Give \(\.$recipient) access to my location through \(agentOne)",
    ]

    // MARK: - Ask for Location phrase family

    private static let askForLocationPhrases: [String] = [
        "Ask \(\.$person) for location in \(agentOne) Location Agent",
        "Request \(\.$person)'s location with \(agentOne)",
        "Ask \(agentOne) to ask \(\.$person) for location",
        "Tell \(agentOne) to request \(\.$person)'s location",
        "Talk to \(agentOne) and ask \(\.$person) for location",
        "Can you ask \(\.$person) for their location in \(agentOne)",
        "Use \(agentOne) to request \(\.$person)'s location",
        "Have \(agentOne) ask \(\.$person) where they are",
    ]

    // MARK: - Stop Sharing phrase family

    private static let stopSharingPhrases: [String] = [
        "Stop sharing location with \(\.$person) in \(agentOne) Location Agent",
        "Stop my location in \(agentOne) Location Agent",
        "Ask \(agentOne) to stop sharing location with \(\.$person)",
        "Tell \(agentOne) to stop sharing location with \(\.$person)",
        "Talk to \(agentOne) and stop sharing location with \(\.$person)",
        "Turn off location sharing with \(\.$person) in \(agentOne)",
        "Stop sharing my location to \(\.$person) using \(agentOne)",
        "Cancel my location share with \(\.$person) in \(agentOne)",
        "Ask \(agentOne) to pause my location",
        "Tell \(agentOne) to pause my location",
        "Talk to \(agentOne) and pause my location",
        "Disable my location sharing in \(agentOne)",
    ]

    // MARK: - Location On / Off phrase family

    private static let locationStatePhrases: [String] = [
        "Turn \(agentOne) Location \(\.$state)",
        "Ask \(agentOne) to turn Location \(\.$state)",
        "Tell \(agentOne) to turn Location \(\.$state)",
        "Talk to \(agentOne) and turn Location \(\.$state)",
        "Turn location updates \(\.$state) in \(agentOne)",
        "Start location sharing in \(agentOne)",
        "Stop location updates in \(agentOne)",
        "Turn on Agent One location",
        "Turn off my Agent One location",
    ]

    // MARK: - Open Destination phrase family

    private static let openDestinationPhrases: [String] = [
        "Open \(\.$destination) in \(agentOne) Location Agent",
        "Show \(\.$destination) in \(agentOne) Location",
        "View \(\.$destination) in \(agentOne) Location Agent",
        "Take me to \(\.$destination) in \(agentOne)",
        "Open my \(\.$destination) on \(agentOne)",
        "Show me \(\.$destination) in Agent One Location",
    ]

    // MARK: - Talk to Agent One phrase family

    private static let talkToAgentOnePhrases: [String] = [
        "Talk to \(agentOne)",
        "Start a conversation with \(agentOne)",
        "Open \(agentOne) and chat",
        "Speak to \(agentOne)",
        "Launch \(agentOne) voice",
    ]

    // MARK: - Check In phrase family

    private static let checkInPhrases: [String] = [
        "Check in with \(agentOne)",
        "Do a Check In in \(agentOne)",
        "Open Check In in \(agentOne) Location",
        "Start a Check In with \(agentOne)",
        "Use \(agentOne) to check in",
        "Open my Agent One Check In",
    ]

    // MARK: - Create Circle phrase family

    private static let createCirclePhrases: [String] = [
        "Create a Circle in \(agentOne)",
        "Make a new Circle in \(agentOne)",
        "Start a Circle in \(agentOne)",
        "Create a Circle named \(\.$name) in \(agentOne)",
        "Make a new \(\.$name) Circle in \(agentOne)",
        "Add a Circle in \(agentOne)",
    ]

    // MARK: - Open Map phrase family

    private static let openMapPhrases: [String] = [
        "Open the map in \(agentOne) Location",
        "Show my location map in \(agentOne)",
        "Open \(agentOne) Location Map",
        "Show the map for \(agentOne) Location",
        "View my location map in \(agentOne)",
    ]

    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskOneRequestIntent(),
            phrases: [
                "Ask Agent One with \(\.$requestText)",
                "Ask \(agentOne) to \(\.$requestText)",
                "Use \(agentOne) to \(\.$requestText)",
                "Tell \(agentOne) to \(\.$requestText)",
            ],
            shortTitle: "Ask Agent One",
            systemImageName: "bubble.left.and.bubble.right"
        )
        AppShortcut(
            intent: ShareLocationWithOneIntent(),
            phrases: shareLocationPhrases,
            shortTitle: "Share Location",
            systemImageName: "location.fill"
        )
        AppShortcut(
            intent: AskForLocationWithOneIntent(),
            phrases: askForLocationPhrases,
            shortTitle: "Ask for Location",
            systemImageName: "location.magnifyingglass"
        )
        AppShortcut(
            intent: StopLocationSharingWithOneIntent(),
            phrases: stopSharingPhrases,
            shortTitle: "Stop Sharing",
            systemImageName: "location.slash.fill"
        )
        AppShortcut(
            intent: SetOneLocationStateIntent(),
            phrases: locationStatePhrases,
            shortTitle: "Location On or Off",
            systemImageName: "location.circle"
        )
        AppShortcut(
            intent: OpenOneDestinationIntent(),
            phrases: openDestinationPhrases,
            shortTitle: "Open Destination",
            systemImageName: "arrow.forward"
        )
        AppShortcut(
            intent: TalkToHusshOneIntent(),
            phrases: talkToAgentOnePhrases,
            shortTitle: "Talk to Agent One",
            systemImageName: "waveform.circle.fill"
        )
        AppShortcut(
            intent: CheckInWithOneIntent(),
            phrases: checkInPhrases,
            shortTitle: "Check In",
            systemImageName: "checkmark.circle"
        )
        AppShortcut(
            intent: CreateOneCircleIntent(),
            phrases: createCirclePhrases,
            shortTitle: "Create Circle",
            systemImageName: "person.2.circle"
        )
        AppShortcut(
            intent: OpenOneLocationMapIntent(),
            phrases: openMapPhrases,
            shortTitle: "Open Map",
            systemImageName: "map"
        )
    }

    static let shortcutTileColor: ShortcutTileColor = .navy
}
#endif
