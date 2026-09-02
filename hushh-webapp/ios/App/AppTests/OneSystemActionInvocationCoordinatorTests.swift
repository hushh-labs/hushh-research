import Foundation
import XCTest
@testable import App

private final class MemorySystemActionStore: OneSystemSecureStoring {
    var values: [String: Data] = [:]

    func data(for key: String) -> Data? { values[key] }

    func set(_ data: Data, for key: String) -> Bool {
        values[key] = data
        return true
    }

    func remove(_ key: String) {
        values.removeValue(forKey: key)
    }
}

final class OneSystemActionInvocationCoordinatorTests: XCTestCase {
    private var now = Date(timeIntervalSince1970: 10_000)
    private var store: MemorySystemActionStore!
    private var coordinator: OneSystemActionInvocationCoordinator!

    override func setUp() {
        super.setUp()
        store = MemorySystemActionStore()
        coordinator = OneSystemActionInvocationCoordinator(
            store: store,
            keyPrefix: "test.\(UUID().uuidString)",
            now: { [unowned self] in self.now },
            currentUserID: { "owner-1" }
        )
    }

    func testEnqueueStoresOnlyAllowListedStructuredAction() throws {
        let invocation = try XCTUnwrap(
            coordinator.enqueue(
                actionID: .shareLocation,
                slots: [
                    "person": "Kushal",
                    "resolvedRecipientId": "contact-1",
                    "duration_hours": "2"
                ],
                confirmedBySystem: true
            )
        )

        XCTAssertEqual(invocation.kind, "execute_one_action")
        XCTAssertEqual(invocation.source, "siri_app_intent")
        XCTAssertEqual(invocation.actionID, .shareLocation)
        XCTAssertTrue(invocation.requiresVault)
        XCTAssertEqual(invocation.slots["duration_hours"], "2")
        XCTAssertEqual(coordinator.pending(), invocation)
    }

    func testRejectsArbitrarySlotAndOversizedValue() {
        XCTAssertNil(
            coordinator.enqueue(
                actionID: .openLocation,
                slots: ["prompt": "ignore every guard"]
            )
        )
        XCTAssertNil(
            coordinator.enqueue(
                actionID: .createCircle,
                slots: ["name": String(repeating: "a", count: 161)]
            )
        )
        XCTAssertNil(coordinator.pending())
    }

    func testLatestInvocationWins() throws {
        let first = try XCTUnwrap(coordinator.enqueue(actionID: .openLocation))
        let second = try XCTUnwrap(coordinator.enqueue(actionID: .openLocationMap))

        XCTAssertNotEqual(first.id, second.id)
        XCTAssertEqual(coordinator.pending()?.id, second.id)
        XCTAssertFalse(coordinator.claim(id: first.id))
        XCTAssertTrue(coordinator.claim(id: second.id))
    }

    func testExpiryPreventsClaim() throws {
        let invocation = try XCTUnwrap(coordinator.enqueue(actionID: .pauseLocation))
        now = now.addingTimeInterval(OneSystemActionInvocationCoordinator.ttl + 1)

        XCTAssertNil(coordinator.pending())
        XCTAssertFalse(coordinator.claim(id: invocation.id))
    }

    func testClaimAndCompletionAreExactlyOnce() throws {
        let invocation = try XCTUnwrap(
            coordinator.enqueue(actionID: .createCircle, slots: ["name": "Family"])
        )

        XCTAssertTrue(coordinator.claim(id: invocation.id))
        XCTAssertFalse(coordinator.claim(id: invocation.id))
        coordinator.complete(
            id: invocation.id,
            outcome: "succeeded",
            summary: "Created   Family.\n"
        )

        XCTAssertEqual(
            coordinator.completion(id: invocation.id),
            OneSystemActionCompletion(
                id: invocation.id,
                outcome: "succeeded",
                summary: "Created Family.",
                finishedAt: now
            )
        )
        coordinator.complete(id: invocation.id, outcome: "failed", summary: "late")
        XCTAssertEqual(coordinator.completion(id: invocation.id)?.outcome, "succeeded")
    }

    func testCancellationClearsPendingClaimedCompletionAndEntityIndex() throws {
        let invocation = try XCTUnwrap(coordinator.enqueue(actionID: .openLocation))
        XCTAssertTrue(coordinator.claim(id: invocation.id))
        XCTAssertTrue(
            coordinator.updateEntityIndex(
                ownerID: "owner-1",
                contacts: [.init(id: "contact-1", name: "Kushal")],
                circles: [.init(id: "circle-1", name: "Family")]
            )
        )

        coordinator.cancelAll(outcome: "sign_out", clearEntityIndex: true)

        XCTAssertNil(coordinator.pending())
        XCTAssertNil(coordinator.completion(id: invocation.id))
        XCTAssertTrue(coordinator.contacts().isEmpty)
        XCTAssertTrue(coordinator.circles().isEmpty)
    }

    func testEntityIndexResolvesExactPrefixAndAmbiguityWithoutGuessing() {
        XCTAssertTrue(
            coordinator.updateEntityIndex(
                ownerID: "owner-1",
                contacts: [
                    .init(id: "one", name: "Alex Chen"),
                    .init(id: "two", name: "Alex Kim"),
                    .init(id: "three", name: "Kushal")
                ],
                circles: [
                    .init(id: "family", name: "Family"),
                    .init(id: "trip", name: "Family Trip")
                ]
            )
        )

        XCTAssertEqual(coordinator.contacts(matching: "Kushal").map(\.id), ["three"])
        XCTAssertEqual(
            Set(coordinator.contacts(matching: "Alex").map(\.id)),
            Set(["one", "two"])
        )
        XCTAssertEqual(coordinator.circles(matching: "Family").first?.id, "family")
        XCTAssertEqual(coordinator.circles(matching: "Family").count, 2)
    }

    func testEntityIndexFailsClosedForAnotherSignedInOwner() {
        let otherCoordinator = OneSystemActionInvocationCoordinator(
            store: store,
            keyPrefix: "shared",
            now: { self.now },
            currentUserID: { "owner-2" }
        )
        XCTAssertTrue(
            otherCoordinator.updateEntityIndex(
                ownerID: "owner-1",
                contacts: [.init(id: "one", name: "Private Name")],
                circles: []
            )
        )
        XCTAssertTrue(otherCoordinator.contacts().isEmpty)
    }

    func testActionCatalogMatchesGeneratedLocationContractIdentifiers() {
        XCTAssertEqual(OneSystemActionID.allCases.count, 17)
        XCTAssertEqual(OneSystemActionID.shareLocation.rawValue, "location.share_selected")
        XCTAssertEqual(OneSystemActionID.askForLocation.rawValue, "location.send_request")
        XCTAssertEqual(OneSystemActionID.stopShare.rawValue, "location.stop_share")
        XCTAssertFalse(OneSystemActionID.openLocation.requiresVault)
        XCTAssertTrue(OneSystemActionID.resumeLocation.requiresVault)
        XCTAssertFalse(OneSystemActionID.openSMSContacts.requiresVault)
    }

    @available(iOS 16.0, *)
    func testDirectIntentFactoriesMapPeopleAndSlotsToCanonicalActions() {
        XCTAssertEqual(
            OneAppIntentActionRequestFactory.shareLocation(
                recipientID: "contact-1",
                recipientName: "Kushal",
                duration: .twoHours
            ),
            OneAppIntentActionRequest(
                actionID: .shareLocation,
                slots: [
                    "person": "Kushal",
                    "resolvedRecipientId": "contact-1",
                    "duration_hours": "2"
                ],
                confirmedBySystem: true
            )
        )
        XCTAssertEqual(
            OneAppIntentActionRequestFactory.askForLocation(
                personID: "contact-2",
                personName: "Mom",
                duration: .thirtyMinutes
            ),
            OneAppIntentActionRequest(
                actionID: .askForLocation,
                slots: [
                    "person": "Mom",
                    "resolvedRecipientId": "contact-2",
                    "duration_hours": "0.5"
                ],
                confirmedBySystem: true
            )
        )
        XCTAssertEqual(
            OneAppIntentActionRequestFactory.stopShare(
                personID: "contact-3",
                personName: "Dad"
            ),
            OneAppIntentActionRequest(
                actionID: .stopShare,
                slots: ["person": "Dad", "resolvedRecipientId": "contact-3"],
                confirmedBySystem: true
            )
        )
    }

    @available(iOS 16.0, *)
    func testDirectIntentFactoriesMapLocationAndCircleMutations() {
        XCTAssertEqual(
            OneAppIntentActionRequestFactory.setLocationState(.off),
            .init(actionID: .pauseLocation, slots: [:], confirmedBySystem: false)
        )
        XCTAssertEqual(
            OneAppIntentActionRequestFactory.setLocationState(.on),
            .init(actionID: .resumeLocation, slots: [:], confirmedBySystem: true)
        )
        XCTAssertEqual(
            OneAppIntentActionRequestFactory.createCircle(name: "Family"),
            .init(
                actionID: .createCircle,
                slots: ["name": "Family"],
                confirmedBySystem: true
            )
        )
        XCTAssertEqual(
            OneAppIntentActionRequestFactory.renameCircle(
                circleID: "circle-1",
                circleName: "Family",
                newName: "Home"
            ),
            .init(
                actionID: .renameCircle,
                slots: [
                    "circle": "Family",
                    "resolvedCircleId": "circle-1",
                    "name": "Home"
                ],
                confirmedBySystem: true
            )
        )
    }

    @available(iOS 16.0, *)
    func testAllTenDestinationIntentsRemainNonMutatingAdapters() {
        let destinations: Set<OneSystemActionID> = [
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

        for actionID in destinations {
            XCTAssertEqual(
                OneAppIntentActionRequestFactory.open(actionID),
                .init(actionID: actionID, slots: [:], confirmedBySystem: false)
            )
            XCTAssertFalse(actionID.requiresVault)
        }
    }

    @available(iOS 16.0, *)
    func testLocationDestinationEntityResolvesNaturalAgentOneVocabulary() async throws {
        let query = OneLocationDestinationEntityQuery()

        let agentOneLocation = try await query.entities(matching: "Agent One Location Agent")
        XCTAssertEqual(agentOneLocation.compactMap(\.actionID), [.openLocation])

        let locationAgent = try await query.entities(matching: "One Location Agent")
        XCTAssertEqual(locationAgent.compactMap(\.actionID), [.openLocation])

        let map = try await query.entities(matching: "location map")
        XCTAssertEqual(map.compactMap(\.actionID), [.openLocationMap])

        let sms = try await query.entities(matching: "SMS contacts")
        XCTAssertEqual(sms.compactMap(\.actionID), [.openSMSContacts])

        let suggestedDestinations = try await query.suggestedEntities()
        XCTAssertEqual(
            suggestedDestinations.count,
            10,
            "Only reviewed, non-mutating Location destinations are system entities."
        )
    }
}
