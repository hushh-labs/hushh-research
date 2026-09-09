import XCTest
@testable import App
#if canImport(AppIntents)
import AppIntents
#endif

final class OneVoiceInvocationCoordinatorTests: XCTestCase {
    private var defaults: UserDefaults!
    private var now: Date!
    private let storageKey = "test.one.voice.pending"

    override func setUp() {
        super.setUp()
        defaults = UserDefaults(suiteName: "OneVoiceInvocationCoordinatorTests")!
        defaults.removePersistentDomain(forName: "OneVoiceInvocationCoordinatorTests")
        now = Date(timeIntervalSince1970: 1_800_000_000)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: "OneVoiceInvocationCoordinatorTests")
        defaults = nil
        now = nil
        super.tearDown()
    }

    private func makeCoordinator() -> OneVoiceInvocationCoordinator {
        OneVoiceInvocationCoordinator(
            defaults: defaults,
            storageKey: storageKey,
            now: { [unowned self] in self.now }
        )
    }

    func testEnqueuePersistsOnlyTheClosedMetadataEnvelope() throws {
        let coordinator = makeCoordinator()
        let invocation = coordinator.enqueue()

        XCTAssertEqual(invocation.kind, "start_one_voice")
        XCTAssertEqual(invocation.source, "siri_app_shortcut")
        XCTAssertEqual(
            invocation.expiresAt.timeIntervalSince(invocation.createdAt),
            300,
            accuracy: 0.001
        )
        XCTAssertEqual(
            invocation.handoffDeadlineAt.timeIntervalSince(invocation.createdAt),
            25,
            accuracy: 0.001
        )

        let data = try XCTUnwrap(defaults.data(forKey: storageKey))
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        XCTAssertEqual(
            Set(object.keys),
            Set(["id", "kind", "source", "createdAt", "expiresAt"])
        )
        XCTAssertNil(object["prompt"])
        XCTAssertNil(object["credential"])
        XCTAssertNil(object["route"])
        XCTAssertNil(object["userId"])
        XCTAssertNil(object["token"])

        XCTAssertEqual(
            invocation.bridgePayload["handoffDeadlineAt"] as? Int64,
            Int64(invocation.handoffDeadlineAt.timeIntervalSince1970 * 1_000)
        )
        XCTAssertTrue(invocation.bridgePayload["claimedAt"] is NSNull)
        XCTAssertTrue(invocation.bridgePayload["appOwnedAt"] is NSNull)
        XCTAssertEqual(invocation.bridgePayload["detached"] as? Bool, false)
        XCTAssertTrue(invocation.bridgePayload["outcome"] is NSNull)
    }

    func testTamperedKindOrSourceIsRejected() throws {
        let coordinator = makeCoordinator()
        coordinator.enqueue()
        let data = try XCTUnwrap(defaults.data(forKey: storageKey))
        var object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        object["kind"] = "arbitrary_text"
        defaults.set(try JSONSerialization.data(withJSONObject: object), forKey: storageKey)

        XCTAssertNil(coordinator.pending())
        XCTAssertNil(defaults.data(forKey: storageKey))
    }

    func testLatestInvocationReplacesPreviousInvocation() {
        let coordinator = makeCoordinator()
        let first = coordinator.enqueue()
        let second = coordinator.enqueue()

        XCTAssertNotEqual(first.id, second.id)
        XCTAssertEqual(coordinator.pending()?.id, second.id)
        XCTAssertFalse(coordinator.claim(id: first.id))
    }

    func testExpiredInvocationIsRemovedAndCannotBeClaimed() {
        let coordinator = makeCoordinator()
        let invocation = coordinator.enqueue()
        now = now.addingTimeInterval(301)

        XCTAssertNil(coordinator.pending())
        XCTAssertFalse(coordinator.claim(id: invocation.id))
        XCTAssertNil(defaults.data(forKey: storageKey))
    }

    func testClaimConsumesExactlyOnce() {
        let coordinator = makeCoordinator()
        let invocation = coordinator.enqueue()

        XCTAssertTrue(coordinator.claim(id: invocation.id))
        XCTAssertFalse(coordinator.claim(id: invocation.id))
        XCTAssertNil(coordinator.pending())
    }

    func testClaimCannotStartAfterTheUnifiedHandoffDeadline() {
        let coordinator = makeCoordinator()
        let invocation = coordinator.enqueue()
        now = now.addingTimeInterval(26)

        XCTAssertFalse(coordinator.claim(id: invocation.id))
        XCTAssertNil(coordinator.pending())
    }

    func testDetachmentBeforeAppOwnershipRemovesClaim() {
        let coordinator = makeCoordinator()
        let invocation = coordinator.enqueue()

        XCTAssertTrue(coordinator.claim(id: invocation.id))
        XCTAssertTrue(coordinator.reportProgress(id: invocation.id, state: "detached"))
        coordinator.complete(id: invocation.id, outcome: "accepted")
        XCTAssertNil(coordinator.pending())
    }

    func testAppOwnershipSurvivesDetachmentUntilCompletion() {
        let coordinator = makeCoordinator()
        let invocation = coordinator.enqueue()

        XCTAssertTrue(coordinator.claim(id: invocation.id))
        XCTAssertTrue(coordinator.reportProgress(id: invocation.id, state: "app_owned"))
        XCTAssertTrue(coordinator.reportProgress(id: invocation.id, state: "detached"))
        coordinator.complete(id: invocation.id, outcome: "accepted")
        XCTAssertNil(coordinator.pending())
    }

    func testCompletionAndCancellationClearPendingInvocation() {
        let coordinator = makeCoordinator()
        let completed = coordinator.enqueue()
        coordinator.complete(id: completed.id, outcome: "failed")
        XCTAssertNil(coordinator.pending())

        coordinator.enqueue()
        coordinator.cancelPending()
        XCTAssertNil(coordinator.pending())
    }

    func testColdLaunchReadsIntentCreatedBeforePluginOrAppDelegateReadiness() {
        let intentProcessCoordinator = makeCoordinator()
        let invocation = intentProcessCoordinator.enqueue()

        let launchedAppCoordinator = makeCoordinator()
        XCTAssertEqual(launchedAppCoordinator.pending(), invocation)
        XCTAssertTrue(launchedAppCoordinator.claim(id: invocation.id))
        XCTAssertNil(intentProcessCoordinator.pending())
    }

    func testAppAlreadyOpenAndForegroundNotificationDoNotConsumeTheRequest() {
        let coordinator = makeCoordinator()
        let invocation = coordinator.enqueue()

        coordinator.publishAvailability(state: "foregrounded")

        XCTAssertEqual(coordinator.pending(), invocation)
        XCTAssertTrue(coordinator.claim(id: invocation.id))
    }

    func testAppIntentPerformEnqueuesTheExistingVoiceEntryRequest() async throws {
#if canImport(AppIntents)
        guard #available(iOS 16.0, *) else { return }
        OneVoiceInvocationCoordinator.shared.cancelPending(outcome: "test_reset")
        defer {
            OneVoiceInvocationCoordinator.shared.cancelPending(outcome: "test_cleanup")
        }

        _ = try await TalkToHusshOneIntent().perform()

        let invocation = try XCTUnwrap(
            OneVoiceInvocationCoordinator.shared.pending()
        )
        XCTAssertEqual(invocation.kind, "start_one_voice")
        XCTAssertEqual(invocation.source, "siri_app_shortcut")
#endif
    }

    func testAppIntentAvailabilityContractsCompileFromTheIOS17DeploymentTarget() {
#if canImport(AppIntents)
        if #available(iOS 16.0, *) {
            XCTAssertTrue(TalkToHusshOneIntent.openAppWhenRun)
            XCTAssertEqual(
                TalkToHusshOneIntent.authenticationPolicy,
                .requiresLocalDeviceAuthentication
            )
            XCTAssertEqual(
                HusshOneAppShortcuts.appShortcuts.count,
                10,
                "All ten of Apple's App Shortcut slots are deliberately spoken for."
            )
        }
        if #available(iOS 26.0, *) {
            XCTAssertEqual(
                TalkToHusshOneIntent.supportedModes,
                [.foreground(.immediate)]
            )
        }
#endif
    }

    func testInstalledAppSeparatesBundleIdentityFromSpeakableSystemName() {
        XCTAssertEqual(
            Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String,
            "Agent One"
        )
        XCTAssertEqual(
            Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String,
            "Hussh One"
        )
        XCTAssertEqual(
            Bundle.main.object(forInfoDictionaryKey: "CFBundleSpokenName") as? String,
            "Agent One"
        )
    }

    func testRequestClaimReturnsTextOnlyAfterMetadataOnlyDiscovery() throws {
        let store = TestOneSystemRequestStore()
        let coordinator = OneSystemRequestInvocationCoordinator(
            store: store,
            keyPrefix: "test.one.request",
            now: { [unowned self] in self.now },
            currentUserID: { "owner-a" }
        )

        XCTAssertEqual(coordinator.captureRequest("enable location"), .captured)
        let pending = try XCTUnwrap(coordinator.pending())
        XCTAssertNil(pending.bridgePayload["text"] as? String)
        XCTAssertEqual(pending.bridgePayload["detached"] as? Bool, false)
        XCTAssertEqual(
            (pending.bridgePayload["handoffDeadlineAt"] as? Int64 ?? 0)
                - (pending.bridgePayload["createdAt"] as? Int64 ?? 0),
            25_000
        )

        let claimed = try XCTUnwrap(coordinator.claimRecord(id: pending.id))
        XCTAssertEqual(claimed.text, "enable location")
        XCTAssertNil(coordinator.claimRecord(id: pending.id))
    }

    func testRequestOwnerChangeClearsStalePendingState() throws {
        let store = TestOneSystemRequestStore()
        var owner = "owner-a"
        let coordinator = OneSystemRequestInvocationCoordinator(
            store: store,
            keyPrefix: "test.one.request.owner",
            now: { [unowned self] in self.now },
            currentUserID: { owner }
        )

        XCTAssertEqual(coordinator.captureRequest("old request"), .captured)
        owner = "owner-b"
        XCTAssertNil(coordinator.pending())
        XCTAssertEqual(coordinator.captureRequest("new request"), .captured)
        XCTAssertEqual(coordinator.pending()?.text, "new request")
    }

    func testRequestDetachmentBeforeAppOwnershipRemovesClaim() throws {
        let store = TestOneSystemRequestStore()
        let coordinator = OneSystemRequestInvocationCoordinator(
            store: store,
            keyPrefix: "test.one.request.detach",
            now: { [unowned self] in self.now },
            currentUserID: { "owner-a" }
        )

        XCTAssertEqual(coordinator.captureRequest("do this"), .captured)
        let pending = try XCTUnwrap(coordinator.pending())
        XCTAssertNotNil(coordinator.claimRecord(id: pending.id))
        XCTAssertTrue(coordinator.reportProgress(id: pending.id, state: "detached"))
        coordinator.complete(id: pending.id, outcome: "completed", summary: "ignored")
        XCTAssertEqual(coordinator.captureRequest("do another thing"), .captured)
    }

    func testRequestCannotBeClaimedAfterTheUnifiedHandoffDeadline() throws {
        let store = TestOneSystemRequestStore()
        let coordinator = OneSystemRequestInvocationCoordinator(
            store: store,
            keyPrefix: "test.one.request.deadline",
            now: { [unowned self] in self.now },
            currentUserID: { "owner-a" }
        )

        XCTAssertEqual(coordinator.captureRequest("enable location"), .captured)
        let pending = try XCTUnwrap(coordinator.pending())
        now = now.addingTimeInterval(26)

        XCTAssertNil(coordinator.claimRecord(id: pending.id))
        XCTAssertNil(coordinator.pending())
    }

    func testRequestCancellationIsScopedToTheRequestedInvocation() throws {
        let store = TestOneSystemRequestStore()
        let coordinator = OneSystemRequestInvocationCoordinator(
            store: store,
            keyPrefix: "test.one.request.cancel",
            now: { [unowned self] in self.now },
            currentUserID: { "owner-a" }
        )

        XCTAssertEqual(coordinator.captureRequest("first"), .captured)
        let pending = try XCTUnwrap(coordinator.pending())
        coordinator.cancelRequest(id: UUID().uuidString)
        XCTAssertEqual(coordinator.pending()?.id, pending.id)

        coordinator.cancelRequest(id: pending.id)
        XCTAssertNil(coordinator.pending())
    }
}

private final class TestOneSystemRequestStore: OneSystemRequestStoring {
    private var values: [String: Data] = [:]

    func data(for key: String) -> Data? {
        values[key]
    }

    @discardableResult
    func set(_ data: Data, for key: String) -> Bool {
        values[key] = data
        return true
    }

    func remove(_ key: String) {
        values.removeValue(forKey: key)
    }
}
