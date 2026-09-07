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
        return DisplayRepresentation(title: AgentOneDestination.caseDisplayRepresentations[destination]?.title ?? "Agent One Location")
    }

    var searchableNames: [String] {
        guard let destination = AgentOneDestination(rawValue: id) else { return [] }
        // Derive searchable tokens from the display title. `title` is a
        // LocalizedStringResource, not a String, so it has to be resolved
        // before any string work -- .folding() on it does not compile.
        guard let resource = AgentOneDestination.caseDisplayRepresentations[destination]?.title
        else { return [] }
        let normalized = String(localized: resource)
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

/// A person or a Circle -- whichever "share my location with Family" or
/// "share my location with Sarah" turns out to name. Share/ask intents used
/// to accept only `OneContactEntity`, so a Circle name had nowhere to
/// resolve: Siri's own entity matching failed before the app ever ran,
/// independent of anything the backend already knows how to do with a
/// Circle name in the `person` slot. One merged query over both pools is
/// what lets Siri's picker (and free-speech matching) offer either.
@available(iOS 16.0, *)
struct OneShareRecipientEntity: AppEntity, Identifiable, Hashable {
    enum Kind: String, Hashable {
        case contact
        case circle
    }

    let id: String
    let name: String
    let kind: Kind

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Agent One Recipient"
    static let defaultQuery = OneShareRecipientEntityQuery()

    var displayRepresentation: DisplayRepresentation {
        switch kind {
        case .contact:
            return DisplayRepresentation(title: "\(name)")
        case .circle:
            return DisplayRepresentation(title: "\(name)", subtitle: "Circle")
        }
    }
}

@available(iOS 16.0, *)
struct OneShareRecipientEntityQuery: EntityStringQuery {
    func entities(for identifiers: [OneShareRecipientEntity.ID]) async throws -> [OneShareRecipientEntity] {
        let requested = Set(identifiers)
        let coordinator = OneSystemActionInvocationCoordinator.shared
        let contacts = coordinator.contacts()
            .filter { requested.contains($0.id) }
            .map { OneShareRecipientEntity(id: $0.id, name: $0.name, kind: .contact) }
        let circles = coordinator.circles()
            .filter { requested.contains($0.id) }
            .map { OneShareRecipientEntity(id: $0.id, name: $0.name, kind: .circle) }
        return contacts + circles
    }

    func entities(matching string: String) async throws -> [OneShareRecipientEntity] {
        let coordinator = OneSystemActionInvocationCoordinator.shared
        let contacts = coordinator.contacts(matching: string)
            .map { OneShareRecipientEntity(id: $0.id, name: $0.name, kind: .contact) }
        let circles = coordinator.circles(matching: string)
            .map { OneShareRecipientEntity(id: $0.id, name: $0.name, kind: .circle) }
        return contacts + circles
    }

    func suggestedEntities() async throws -> [OneShareRecipientEntity] {
        let coordinator = OneSystemActionInvocationCoordinator.shared
        let contacts = coordinator.contacts()
            .map { OneShareRecipientEntity(id: $0.id, name: $0.name, kind: .contact) }
        let circles = coordinator.circles()
            .map { OneShareRecipientEntity(id: $0.id, name: $0.name, kind: .circle) }
        return contacts + circles
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

    /// `confirmedBySystem` is true here and nowhere else for this action.
    /// It does not claim Siri showed a confirmation sheet; it records that the
    /// gesture which reached this factory -- a press-and-hold on the Action
    /// button, or a spoken phrase that explicitly says "send ... alert" -- is
    /// itself the confirmation. The web side turns this flag into the
    /// `confirmed` slot that `resolveTriggerSos` requires, so an invocation
    /// arriving any other way still gets the tappable confirm card.
    static func sendSaveMySoulAlert(note: String) -> OneAppIntentActionRequest {
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        return .init(
            actionID: .triggerSaveMySoul,
            slots: trimmed.isEmpty ? [:] : ["note": trimmed],
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
            return "Agent One could not prepare that action."
        }
        guard let result = await OneSystemActionInvocationCoordinator.shared.waitForCompletionOrProgress(
            id: invocation.id,
            generation: invocation.generation
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
        "Share your live location with an existing Agent One connection or Circle."
    )
    static let authenticationPolicy: IntentAuthenticationPolicy =
        .requiresLocalDeviceAuthentication
    static let openAppWhenRun = true

    @available(iOS 26.0, *)
    static let supportedModes: IntentModes = [.foreground(.immediate)]

    @Parameter(title: "Person or Circle")
    var recipient: OneShareRecipientEntity

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
        "Ask an existing Agent One connection or Circle to share their location."
    )
    static let authenticationPolicy: IntentAuthenticationPolicy =
        .requiresLocalDeviceAuthentication
    static let openAppWhenRun = true

    @available(iOS 26.0, *)
    static let supportedModes: IntentModes = [.foreground(.immediate)]

    @Parameter(title: "Person or Circle")
    var person: OneShareRecipientEntity

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

    // OpenIntent requires `target`. It had been removed while the conformance
    // was left in place, which is a compile error, and it also meant every
    // destination resolved to the Location home instead of the one asked for.
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

/// Save My Soul, sent for real.
///
/// This is deliberately a separate intent from `OpenOneEmergencySOSIntent`
/// rather than a branch inside it. App Intents expose no API for the
/// invocation source -- there is no way to ask "was this the Action button, or
/// a phrase someone said across the room" -- so an intent that sends, sends
/// from every entry point it is reachable from. Splitting sending into its own
/// intent is therefore the only place the distinction can live: the short,
/// panicky, easily-misheard phrases ("SMS", "SOS") stay on the open intent
/// where the worst case is a screen appearing, and only the long deliberate
/// "send ... alert" phrases reach this one.
///
/// Being a registered App Shortcut is what makes it assignable to the Action
/// button, where the press-and-hold is the confirming gesture.
@available(iOS 16.0, *)
struct SendSaveMySoulAlertIntent: AppIntent {
    static let title: LocalizedStringResource = "Send Save My Soul Alert"
    static let description = IntentDescription(
        "Alert your Agent One emergency contacts right now and share your live location with them."
    )
    static let authenticationPolicy: IntentAuthenticationPolicy =
        .requiresLocalDeviceAuthentication
    static let openAppWhenRun = true

    @available(iOS 26.0, *)
    static let supportedModes: IntentModes = [.foreground(.immediate)]

    /// Optional on purpose. A required parameter would make the Action button
    /// stop and ask a question, which is the one thing this path must not do.
    @Parameter(title: "Note for your contacts")
    var note: String?

    static var parameterSummary: some ParameterSummary {
        Summary("Send my Save My Soul alert") {
            \.$note
        }
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        // No requestConfirmation() here, and that is the decision, not an
        // omission: reaching this intent at all is already the deliberate act.
        // The app-side guards still refuse and say why -- locked vault, an SOS
        // already running, location permission off, or no contact ready to be
        // alerted.
        let summary = await OneAppIntentActionExecutor.run(
            OneAppIntentActionRequestFactory.sendSaveMySoulAlert(note: note ?? "")
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

    @Parameter(title: "Request")
    var requestText: String

    static var parameterSummary: some ParameterSummary {
        Summary("Ask Agent One to \(\.$requestText)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let text = requestText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            return .result(dialog: "What would you like Agent One to do?")
        }

        let result = OneSystemRequestInvocationCoordinator.shared.captureRequest(text)
        switch result {
        case .captured:
            return .result(dialog: "Your request is with Agent One. Continue in the app to complete it.")
        case .ownerRequired:
            return .result(dialog: "Sign in to Agent One to send a request from here.")
        case .tooLarge:
            return .result(dialog: "That request is too long. Try a shorter phrase.")
        case .alreadyPending:
            return .result(dialog: "Agent One is already handling a request. Complete or cancel it first.")
        case .failure:
            return .result(dialog: "I couldn't capture that request right now. Try again in the app.")
        @unknown default:
            return .result(dialog: "Continue in Agent One to complete your request.")
        }
    }
}

// MARK: - Zero-setup Siri phrases (Apple limits an app to ten App Shortcuts)

@available(iOS 16.0, *)
struct HusshOneAppShortcuts: AppShortcutsProvider {
    // The app-name token, not the words "Agent One".
    //
    // This must be `AppShortcutPhraseToken`, never a String. AppShortcutPhrase's
    // StringInterpolation declares exactly two overloads -- one for this token
    // and one for a parameter KeyPath -- so interpolating a String does not
    // compile at all. It was `= ".applicationName"` (a String literal) until
    // this merge, which is why nothing on this branch had ever built.
    //
    // The token is also what wins Siri's domain arbitration and what survives
    // localisation, so a literal "Agent One" in a phrase is a bug even where it
    // would compile.
    private static let agentOne: AppShortcutPhraseToken = .applicationName

    // MARK: - Share Location phrase family
    //
    // Nine semantically distinct anchors teach Siri that every reasonable way
    // of asking to share one's location resolves to the same intent. Apple's
    // similarity index generalises beyond these exact strings; diversity here
    // is what seeds it. No phrase hardcodes a person name -- the recipient is
    // always the `\.$recipient` slot, which resolves against contacts *and*
    // Circles via OneShareRecipientEntity.

    private static let shareLocationPhrases: [AppShortcutPhrase<ShareLocationWithOneIntent>] = [
        "Share my location with \(\.$recipient) in \(agentOne) Location Agent",
        "Let \(\.$recipient) see my location with \(agentOne)",
        "Ask \(agentOne) to share my location with \(\.$recipient)",
        "Tell \(agentOne) to share my location with \(\.$recipient)",
        "Talk to \(agentOne) and share my location with \(\.$recipient)",
        "Use \(agentOne) to share my location with \(\.$recipient)",
        "Share my location to \(\.$recipient) using \(agentOne)",
        "Start sharing my location in \(agentOne) with \(\.$recipient)",
        "Give \(\.$recipient) access to my location through \(agentOne)",
    ]

    // MARK: - Ask for Location phrase family

    private static let askForLocationPhrases: [AppShortcutPhrase<AskForLocationWithOneIntent>] = [
        "Ask \(\.$person) for location in \(agentOne) Location Agent",
        "Request \(\.$person)'s location with \(agentOne)",
        "Ask \(agentOne) to ask \(\.$person) for location",
        "Tell \(agentOne) to request \(\.$person)'s location",
        "Talk to \(agentOne) and ask \(\.$person) for location",
        "Use \(agentOne) to request \(\.$person)'s location",
        "Have \(agentOne) ask \(\.$person) where they are",
    ]

    // MARK: - Location On / Off phrase family
    //
    // Every phrase here binds `\.$state`. `state` is a non-optional parameter
    // with no default, so an unbound phrase makes Siri stop and ask "On or
    // Off?" instead of acting -- which defeats the point of a one-shot phrase.

    private static let locationStatePhrases: [AppShortcutPhrase<SetOneLocationStateIntent>] = [
        "Turn \(agentOne) Location \(\.$state)",
        "Ask \(agentOne) to turn Location \(\.$state)",
        "Tell \(agentOne) to turn Location \(\.$state)",
        "Talk to \(agentOne) and turn Location \(\.$state)",
        "Turn location updates \(\.$state) in \(agentOne)",
        "Set \(agentOne) Location to \(\.$state)",
    ]

    // MARK: - Talk to Agent One phrase family

    private static let talkToAgentOnePhrases: [AppShortcutPhrase<TalkToHusshOneIntent>] = [
        "Talk to \(agentOne)",
        "Speak to \(agentOne)",
        "Start a conversation with \(agentOne)",
    ]

    // MARK: - Check In phrase family

    private static let checkInPhrases: [AppShortcutPhrase<CheckInWithOneIntent>] = [
        "Check in with \(agentOne) Location Agent",
        "Open \(agentOne) Location Check In",
        "Ask \(agentOne) to check in",
        "Tell \(agentOne) to open Check In",
        "Talk to \(agentOne) and check in",
        "Do an \(agentOne) Check In",
        "Start an \(agentOne) Check In",
    ]

    // MARK: - Create Circle phrase family
    //
    // No `\.$name` slot. `name` is a plain String, and an open string slot in a
    // phrase has no compile-time-known value set for Siri to match against, so
    // it degrades the whole family. Naming a Circle out loud goes through the
    // free-text handshake instead, which is what semantic routing is for.

    private static let createCirclePhrases: [AppShortcutPhrase<CreateOneCircleIntent>] = [
        "Create a Circle in \(agentOne) Location Agent",
        "Make a new Circle in \(agentOne) Location Agent",
        "Ask \(agentOne) to create a Circle",
        "Tell \(agentOne) to create a Circle",
        "Talk to \(agentOne) and create a Circle",
        "Start a Circle in \(agentOne)",
        "Add a Circle in \(agentOne)",
    ]

    // MARK: - The free-text handshake

    private static let askOneRequestPhrases: [AppShortcutPhrase<AskOneRequestIntent>] = [
        "Ask \(agentOne) with \(\.$requestText)",
        "Ask \(agentOne) to \(\.$requestText)",
        "Use \(agentOne) to \(\.$requestText)",
        "Tell \(agentOne) to \(\.$requestText)",
    ]

    /// Save My Soul, the screen. Deliberately the widest phrase set here: this
    /// is the one a person may need while panicking, in the dark, or in a
    /// second language. "SMS" is the in-product abbreviation of Save My Soul --
    /// no text message is involved -- so both forms are taught.
    ///
    /// Every phrase in this family OPENS the screen and sends nothing. That is
    /// what makes it safe to keep them short and easily misheard. "Help me" and
    /// "I need help" are not here: they are real aliases of
    /// `location.sos_default`, which honours the person's own Voice Settings
    /// choice between opening and sending, and this intent always just opens.
    /// Putting them here would have silently overridden that preference.
    static let emergencySOSPhrases: [AppShortcutPhrase<OpenOneEmergencySOSIntent>] = [
        "SMS in \(agentOne)",
        "Save my soul in \(agentOne)",
        "Open SMS in \(agentOne)",
        "Emergency in \(agentOne)",
        "Emergency SOS in \(agentOne)",
        "SOS in \(agentOne)",
        "Open emergency SOS in \(agentOne)",
    ]

    /// The sending counterpart. Every phrase carries an explicit "send", and
    /// none is short enough to arrive by accident from a television or an
    /// overheard conversation. This is the shortcut meant for the Action
    /// button.
    static let sendSaveMySoulPhrases: [AppShortcutPhrase<SendSaveMySoulAlertIntent>] = [
        "Send my Save My Soul alert in \(agentOne)",
        "Send the Save My Soul alert in \(agentOne)",
        "Send my SMS alert in \(agentOne)",
        "Send my emergency alert in \(agentOne)",
        "Send an emergency alert in \(agentOne)",
    ]

    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskOneRequestIntent(),
            phrases: askOneRequestPhrases,
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
            intent: SetOneLocationStateIntent(),
            phrases: locationStatePhrases,
            shortTitle: "Location On or Off",
            systemImageName: "location.circle"
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
        // Save My Soul takes two of Apple's ten slots, and that is the point.
        //
        // The list above is the Location feature set a person actually asks for
        // out loud. Stop Sharing, Rename Circle and Open Destination were
        // dropped to make room: stopping is still reachable through Location On
        // or Off, and renaming and every open* destination through the
        // free-text handshake. All three intents remain defined and usable in
        // the Shortcuts app.
        //
        // The two SOS entries are split rather than merged because App Intents
        // expose no invocation source. One opens and can never alert anyone;
        // the other sends and is worded so it cannot be reached by accident.
        // Registration is also what puts them in the Action button picker,
        // which only offers registered App Shortcuts -- assign "Send Save My
        // Soul" there and the press-and-hold sends, with no second step.
        AppShortcut(
            intent: OpenOneEmergencySOSIntent(),
            phrases: emergencySOSPhrases,
            shortTitle: "Save My Soul",
            systemImageName: "sos"
        )
        AppShortcut(
            intent: SendSaveMySoulAlertIntent(),
            phrases: sendSaveMySoulPhrases,
            shortTitle: "Send Save My Soul",
            systemImageName: "exclamationmark.bubble.fill"
        )
    }

    static let shortcutTileColor: ShortcutTileColor = .navy
}
#endif
