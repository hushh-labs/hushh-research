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

    func testAppIntentAvailabilityContractsCompileFromAnIOS15Target() {
#if canImport(AppIntents)
        if #available(iOS 16.0, *) {
            XCTAssertTrue(TalkToHusshOneIntent.openAppWhenRun)
            XCTAssertEqual(
                TalkToHusshOneIntent.authenticationPolicy,
                .requiresLocalDeviceAuthentication
            )
            XCTAssertEqual(
                HusshOneAppShortcuts.appShortcuts.count,
                8,
                "The focused shortcuts use one destination entity instead of mirroring screens."
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
}
