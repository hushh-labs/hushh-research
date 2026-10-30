import XCTest
import SwiftUI
import Capacitor
import WebKit
import Security
import UserNotifications
@testable import App

private final class ZeroSafeAreaView: UIView {
    override var safeAreaInsets: UIEdgeInsets { .zero }
}

@available(iOS 16.0, *)
@MainActor private final class EditorMenuDismissalProbe: UIEditMenuInteraction {
    private(set) var dismissals = 0
    override func dismissMenu() { dismissals += 1 }
}

final class NativeSupportTests: XCTestCase {
    func testSmsAlarmOrderingAndAcknowledgementRejectLateAdmission() throws {
        let user = "sms-test-\(UUID().uuidString)"
        let ended = UUID().uuidString
        let admitted = UUID().uuidString
        let group = try XCTUnwrap(Bundle.main.object(forInfoDictionaryKey: "NotificationKeychainGroup") as? String)
        let probe: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "hussh.sms.entitlement-test", kSecAttrAccessGroup as String: group,
            kSecAttrAccount as String: UUID().uuidString]
        var insertion = probe
        insertion[kSecValueData as String] = Data([1])
        let writable = SecItemAdd(insertion as CFDictionary, nil)
        defer { SecItemDelete(probe as CFDictionary) }
        XCTAssertEqual(writable, errSecSuccess,
            "SMS shared Keychain requires an entitled simulator test host; OSStatus=\(writable)")
        guard writable == errSecSuccess else { return }
        defer {
            for grant in [ended, admitted] {
                for suffix in ["first", "pending", "ack"] {
                    SecItemDelete([kSecClass as String: kSecClassGenericPassword,
                        kSecAttrService as String: "hussh.sms.alarms.v1", kSecAttrAccessGroup as String: group,
                        kSecAttrAccount as String: SmsAlarmLedger.account(user: user, grant: grant, suffix: suffix)] as CFDictionary)
                }
            }
            let fence = SmsAlarmLedger.account(user: user, grant: admitted, suffix: "pending").prefix(65)
            SecItemDelete([kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: "hussh.sms.deleted.v1", kSecAttrAccessGroup as String: group,
                kSecAttrAccount as String: String(fence)] as CFDictionary)
        }
        try SmsAlarmLedger.markEnded(user: user, grant: ended)
        XCTAssertThrowsError(try SmsAlarmLedger.remember(user: user, grant: ended))
        XCTAssertTrue(SmsAlarmLedger.endedBeforeAdmission(user: user, grant: ended))
        try SmsAlarmLedger.remember(user: user, grant: admitted)
        try SmsAlarmLedger.markEnded(user: user, grant: admitted)
        XCTAssertFalse(SmsAlarmLedger.endedBeforeAdmission(user: user, grant: admitted))
        XCTAssertEqual(SmsAlarmLedger.pending(user: user), [admitted])
        try SmsAlarmLedger.acknowledge(user: user, grant: admitted)
        try SmsAlarmLedger.remember(user: user, grant: admitted)
        XCTAssertTrue(SmsAlarmLedger.acknowledged(user: user, grant: admitted))
        XCTAssertTrue(SmsAlarmLedger.pending(user: user).isEmpty)
        XCTAssertEqual(SmsAlarmLedger.pending(user: user, includeAcknowledged: true), [admitted])
        try SmsAlarmLedger.forget(user: user)
        XCTAssertTrue(SmsAlarmLedger.pending(user: user, includeAcknowledged: true).isEmpty)
        XCTAssertFalse(SmsAlarmLedger.acknowledged(user: user, grant: admitted))
        XCTAssertFalse(SmsAlarmLedger.endedBeforeAdmission(user: user, grant: ended))
        XCTAssertThrowsError(try SmsAlarmLedger.remember(user: user, grant: admitted))
        XCTAssertThrowsError(try SmsAlarmLedger.acknowledge(user: user, grant: admitted))
    }

    func testBackgroundAlarmHandoffIsOneBoundedSeriesThatOnlyOpensTheApp() throws {
        // No background audio mode: ringing in-app alarms continue as one series of local alerts.
        let requests = EmergencySmsCueHandoff.requests()
        XCTAssertEqual(requests.count, EmergencySmsCueHandoff.offsets.count)
        XCTAssertLessThanOrEqual(requests.count, 64) // iOS pending-request limit.
        XCTAssertEqual(Set(requests.map(\.identifier)).count, requests.count)
        XCTAssertLessThan(EmergencySmsCueHandoff.soundSeconds, 30) // iOS plays at most 30 s.
        for request in requests {
            XCTAssertTrue(EmergencySmsCueHandoff.isHandoff(request.identifier))
            XCTAssertNotNil(request.content.sound)
            // Capacitor routes local taps to no handler: no action or routing data
            // that would promise an acknowledgement. Tapping only opens the app.
            XCTAssertEqual(request.content.categoryIdentifier, "")
            XCTAssertTrue(request.content.userInfo.isEmpty)
            let trigger = try XCTUnwrap(request.trigger as? UNTimeIntervalNotificationTrigger)
            XCTAssertFalse(trigger.repeats)
            XCTAssertLessThanOrEqual(trigger.timeInterval, 600)
        }
        XCTAssertFalse(EmergencySmsCueHandoff.isHandoff("chat.message.1"))
    }

    @MainActor
    func testOwnedChoiceReadbackCannotRetireAnAttachedSheet() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let parent = UIViewController(), window = UIWindow(windowScene: scene)
        let shield = HushhSessionPrivacyShield()
        let web = WKWebView(frame: scene.coordinateSpace.bounds)
        let container = NativePresentationContainer(webView: web, basePresentation: .coherentDrawers, privacyShield: shield)
        parent.view = container
        window.rootViewController = parent; window.makeKeyAndVisible()
        parent.view.layoutIfNeeded()
        let navigation = UITabBar(frame: CGRect(x: 0, y: parent.view.bounds.height - 49, width: parent.view.bounds.width, height: 49))
        navigation.items = [UITabBarItem(title: "Public tab", image: nil, tag: 0)]
        let dock = UIButton(frame: CGRect(x: 20, y: navigation.frame.minY - 64, width: parent.view.bounds.width - 40, height: 44))
        dock.setTitle("Public dock", for: .normal)
        parent.view.addSubview(navigation); parent.view.addSubview(dock)
        shield.attach(to: parent.view)
        container.conceal()
        let document = "public-owned-choice-\(UUID().uuidString)"
        shield.observeDocument(document); shield.protectForAppInactive(); shield.markAppActive()
        let released = expectation(description: "Isolated public fixture privacy release")
        shield.completeSessionValidation(generation: shield.snapshot().generation, documentId: document, appIsActive: true) {
            XCTAssertTrue($0); released.fulfill()
        }
        await fulfillment(of: [released], timeout: 3)
        XCTAssertTrue(web.isUserInteractionEnabled)
        XCTAssertFalse(web.accessibilityElementsHidden)
        let choice = NativeOwnedChoiceCoordinator(privacyShield: shield)
        choice.changed = { [weak choice] in container.isolateForOwnedDrawer(choice?.coversPresentation == true) }
        choice.parent = { parent }; choice.available = { true }
        choice.admitOwner = { _ in true }; choice.currentOwner = { _ in true }
        var events = 0; choice.emit = { _ in events += 1 }
        defer {
            choice.retire(); window.isHidden = true; window.rootViewController = nil
            previous?.makeKeyAndVisible()
        }
        let identity: [String: Any] = ["documentId": document, "ownerEpoch": "public-owner", "ownerGeneration": 1,
            "revision": 1, "visitId": "public-visit"]
        var projection = identity
        projection.merge(["privacyGeneration": shield.snapshot().generation, "updateSequence": 1,
            "appearance": "light", "accentHex": "#007AFF", "foregroundHex": "#111111", "title": "Public choices",
            "options": [["handle": "public-handle", "label": "Public option", "selected": true, "disabled": false]]]) { _, next in next }
        let active = expectation(description: "Actual choice presentation completion")
        let prepare = try XCTUnwrap(CAPPluginCall(callbackId: "public-prepare", methodName: "prepareOwnedChoice", options: projection,
            success: { result, _ in
                guard case let .dictionary(value)? = result?.resultData else { XCTFail("CHOICE_RECEIPT_MISSING"); active.fulfill(); return }
                XCTAssertEqual(value["phase"] as? String, "active"); active.fulfill()
            }, error: { _ in XCTFail("CHOICE_PREPARE_REFUSED"); active.fulfill() }))
        choice.prepare(prepare)
        XCTAssertFalse(choice.coversPresentation, "Admission must not hide the WebView before the native sheet finishes presentation")
        await fulfillment(of: [active], timeout: 3)
        XCTAssertTrue(choice.coversPresentation)
        let controller = try XCTUnwrap(parent.presentedViewController)
        for chrome in [navigation as UIView, dock] {
            let point = chrome.convert(CGPoint(x: chrome.bounds.midX, y: chrome.bounds.midY), to: window)
            let hit = window.hitTest(point, with: nil)
            XCTAssertFalse(hit === chrome || hit?.isDescendant(of: chrome) == true,
                "Owned popup and scrim must cover both bottom navigation and Agent Dock")
        }
        var retirementCompleted = false, rejectedWhileAttached = false
        let detached = expectation(description: "Actual choice disappearance")
        let retire = try XCTUnwrap(CAPPluginCall(callbackId: "public-retire", methodName: "retireOwnedChoice", options: identity,
            success: { _, _ in retirementCompleted = true; detached.fulfill() },
            error: { _ in XCTFail("CHOICE_RETIRE_REFUSED"); detached.fulfill() }))
        let read = try XCTUnwrap(CAPPluginCall(callbackId: "public-pending", methodName: "getOwnedChoiceState", options: identity,
            success: { _, _ in XCTFail("Attached native sheet cannot report retirement") },
            error: { _ in rejectedWhileAttached = true }))
        choice.retire(retire)
        // No actor yield: the UIKit dismissal completion has not run.
        XCTAssertTrue(controller.presentingViewController === parent)
        XCTAssertFalse(retirementCompleted); choice.readState(read); XCTAssertTrue(rejectedWhileAttached)
        await fulfillment(of: [detached], timeout: 3)
        XCTAssertNil(controller.presentingViewController); XCTAssertFalse(choice.coversPresentation)
        XCTAssertTrue(web.isUserInteractionEnabled, "Popup retirement must preserve authorized WebView recovery even while native paint stays concealed")
        XCTAssertFalse(web.accessibilityElementsHidden)
        var confirmed = false
        let absent = try XCTUnwrap(CAPPluginCall(callbackId: "public-absent", methodName: "getOwnedChoiceState", options: identity,
            success: { result, _ in
                if case let .dictionary(value)? = result?.resultData { confirmed = value["phase"] as? String == "retired" }
            }, error: { _ in XCTFail("CHOICE_ABSENCE_REFUSED") }))
        choice.readState(absent); XCTAssertTrue(confirmed); XCTAssertEqual(events, 0)
        var larger = projection
        larger["revision"] = 2; larger["visitId"] = "public-large-visit"
        larger["options"] = (0..<251).map { ["handle": "public-option-\($0)", "label": "Public option \($0)", "selected": $0 == 0, "disabled": false] as [String: Any] }
        let largeActive = expectation(description: "Large native list presents after adjacent retirement")
        let prepareLarge = try XCTUnwrap(CAPPluginCall(callbackId: "public-large", methodName: "prepareOwnedChoice", options: larger,
            success: { _, _ in largeActive.fulfill() }, error: { _ in XCTFail("CHOICE_LARGE_PREPARE_REFUSED"); largeActive.fulfill() }))
        choice.prepare(prepareLarge)
        await fulfillment(of: [largeActive], timeout: 5)
        XCTAssertTrue(choice.coversPresentation)
        var largeIdentity = identity
        largeIdentity["revision"] = 2; largeIdentity["visitId"] = "public-large-visit"
        let largeDetached = expectation(description: "Large native list actually disappears")
        let retireLarge = try XCTUnwrap(CAPPluginCall(callbackId: "public-large-retire", methodName: "retireOwnedChoice", options: largeIdentity,
            success: { _, _ in largeDetached.fulfill() }, error: { _ in XCTFail("CHOICE_LARGE_RETIRE_REFUSED"); largeDetached.fulfill() }))
        choice.retire(retireLarge)
        await fulfillment(of: [largeDetached], timeout: 5)
        XCTAssertTrue(web.isUserInteractionEnabled); XCTAssertFalse(web.accessibilityElementsHidden)
        shield.protectForAppInactive()
        container.conceal()
        container.isolateForOwnedDrawer(true)
        container.isolateForOwnedDrawer(false)
        XCTAssertFalse(web.isUserInteractionEnabled, "Popup retirement must never release an active privacy cover")
        XCTAssertTrue(web.accessibilityElementsHidden)
    }

    @MainActor func testNativeFeedbackReplacementRetainsItsBoundedHostAndOutsideTouches() throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        let parent = UIViewController()
        parent.view.backgroundColor = .systemBackground
        window.rootViewController = parent
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil; previous?.makeKeyAndVisible() }
        let underlying = UIButton(frame: CGRect(x: 24, y: 400, width: 120, height: 44))
        parent.view.addSubview(underlying)
        func state(_ sequence: Int, revision: Int = 1) -> NativeFeedbackProjection {
            NativeFeedbackProjection(documentId: "public-document", ownerEpoch: "public-owner", ownerGeneration: 1,
                revision: 1, family: "profile", privacyGeneration: 0, feedbackId: "public-notice-\(sequence)",
                feedbackRevision: revision, feedbackSequence: sequence, destinationId: nil, supportDestinationId: nil,
                formScene: nil, formRevision: nil, message: "Public result \(sequence)", tone: "success", duration: 3600, dismissible: true)
        }
        let feedback = NativeFeedbackPresentation()
        XCTAssertTrue(feedback.apply(state(1), to: parent))
        let host = try XCTUnwrap(parent.children.first)
        XCTAssertTrue(feedback.apply(state(2), to: parent))
        var endedRevisions = [Int]()
        feedback.ended = { receipt in
            if let revision = receipt["feedbackRevision"] as? Int { endedRevisions.append(revision) }
        }
        let latest = state(2, revision: 2)
        XCTAssertTrue(feedback.apply(latest, to: parent))
        feedback.dismiss(state(2)) // A closure retained from the loading revision.
        XCTAssertTrue(parent.children.first === host, "NATIVE_FEEDBACK_STALE_DISMISS_REMOVED_NEW_RESULT")
        XCTAssertTrue(endedRevisions.isEmpty, "NATIVE_FEEDBACK_STALE_DISMISS_EMITTED_END")
        XCTAssertEqual(parent.children.count, 1)
        XCTAssertTrue(parent.children.first === host)
        XCTAssertTrue(host.view.superview === parent.view)
        parent.view.layoutIfNeeded()
        XCTAssertGreaterThan(host.view.bounds.height, 0)
        XCTAssertLessThan(host.view.bounds.height, 150)
        XCTAssertTrue(parent.view.hitTest(CGPoint(x: 40, y: 420), with: nil) === underlying)
        XCTAssertFalse(parent.view.accessibilityViewIsModal)
        var retirement = latest.receipt
        retirement["feedbackRevision"] = 3
        feedback.retire(id: latest.feedbackId, sequence: latest.feedbackSequence,
            revision: 3, owner: latest.identity, context: retirement)
        XCTAssertTrue(parent.children.isEmpty, "NATIVE_FEEDBACK_TARGETED_RETIREMENT_FAILED")
        XCTAssertEqual(endedRevisions, [2])
        XCTAssertTrue(feedback.apply(state(3), to: parent))
        feedback.clear()
        XCTAssertTrue(parent.children.isEmpty)
        XCTAssertTrue(parent.view.hitTest(CGPoint(x: 40, y: 420), with: nil) === underlying)
    }
    func testNativeFeedbackRejectsReorderedUpdatesAndRetiredLoadingResults() throws {
        func state(_ revision: Int, message: String = "Public result", sequence: Int = 1) throws -> NativeFeedbackProjection {
            let json: [String: Any] = ["documentId": "public-document", "ownerEpoch": "public-owner", "ownerGeneration": 1,
                "revision": 1, "family": "profile", "privacyGeneration": 0, "feedbackId": "public-notification-\(sequence)",
                "feedbackRevision": revision, "feedbackSequence": sequence, "destinationId": "preferences-visit", "supportDestinationId": NSNull(), "formScene": NSNull(), "formRevision": NSNull(),
                "message": message, "tone": "success", "duration": 3600, "dismissible": true]
            return try JSONDecoder().decode(NativeFeedbackProjection.self, from: JSONSerialization.data(withJSONObject: json))
        }
        var fence = NativeFeedbackFence()
        XCTAssertTrue(fence.apply(try state(1)))
        XCTAssertTrue(fence.apply(try state(2)))
        XCTAssertFalse(fence.apply(try state(1)))
        XCTAssertFalse(fence.apply(try state(3, message: String(repeating: "x", count: 2049))))
        XCTAssertFalse(fence.retire(id: "public-notification-1", sequence: 1, revision: 1, owner: try state(1).identity))
        _ = fence.retire(id: "public-notification-1", sequence: 1, revision: 2, owner: try state(1).identity)
        XCTAssertFalse(fence.apply(try state(3)))
        var retiredBeforeAdmission = NativeFeedbackFence()
        _ = retiredBeforeAdmission.retire(id: "public-notification-1", sequence: 1, revision: 1, owner: try state(1).identity)
        XCTAssertFalse(retiredBeforeAdmission.apply(try state(1)), "NATIVE_FEEDBACK_RETIRED_BEFORE_ADMISSION_REPLAY")
        var expired = NativeFeedbackFence()
        XCTAssertTrue(expired.apply(try state(1)))
        XCTAssertTrue(expired.retire(id: "public-notification-1", sequence: 1, revision: 1, owner: try state(1).identity, terminal: false))
        XCTAssertTrue(expired.apply(try state(2)), "An old expiry must not reject an already requested newer result")
        for sequence in 2...1030 { XCTAssertTrue(expired.apply(try state(1, sequence: sequence))) }
    }
    func testDeletionProofFencesOwnerSessionExpiryAndCancelledExchange() {
        let fence = DeletionPhoneProofFence(userID: "owner", attemptID: "attempt", now: 100)
        XCTAssertFalse(fence.codeSent(userID: "other", sameSession: true, now: 101))
        XCTAssertFalse(fence.codeSent(userID: "owner", sameSession: false, now: 101))
        XCTAssertFalse(fence.codeSent(userID: "owner", sameSession: true, now: 400))
        XCTAssertTrue(fence.codeSent(userID: "owner", sameSession: true, now: 101))
        XCTAssertTrue(fence.exchange(userID: "owner", sameSession: true, now: 102))
        XCTAssertFalse(fence.exchange(userID: "owner", sameSession: true, now: 103))
        fence.retryCode()
        XCTAssertTrue(fence.exchange(userID: "owner", sameSession: true, now: 104))
        XCTAssertTrue(fence.settle())
        XCTAssertFalse(fence.canRelease)
        fence.drainExchange()
        XCTAssertTrue(fence.canRelease)
        XCTAssertFalse(fence.current(userID: "owner", sameSession: true, now: 105))
    }

    @MainActor
    func testFullWindowWebViewPublishesStatusBarClearance() throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        let root = UIViewController()
        root.view = ZeroSafeAreaView()
        window.rootViewController = root
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
            previousKeyWindow?.makeKeyAndVisible()
        }

        root.view.layoutIfNeeded()
        let statusBarClearance = window.safeAreaInsets.top
        XCTAssertGreaterThan(statusBarClearance, 0)
        XCTAssertEqual(root.view.safeAreaInsets.top, 0)
        let webView = WKWebView(frame: root.view.bounds)
        root.view.addSubview(webView)
        XCTAssertEqual(NativeWebSafeArea.topInset(for: webView, in: window), statusBarClearance, accuracy: 1)

        webView.frame.origin.y = statusBarClearance
        XCTAssertEqual(NativeWebSafeArea.topInset(for: webView, in: window), 0, accuracy: 1,
            "A WebView already below the status bar must not receive a second inset")
    }

    func testSandboxConnectorReturnNeedsDebugIdentityAndExactBuildPin() {
        let pin = "https://scope-commerce-preview-123.us-central1.run.app"
        let callback = pin + "/one/profile/connectors/oauth/return?code=synthetic&state=synthetic"
        let policy = ScopeCommerceSandboxOAuthPolicy.self
        XCTAssertTrue(policy.admits(URL(string: callback)!, pin: pin, bundleID: policy.bundleID, isDebug: true))
        XCTAssertFalse(policy.admits(URL(string: callback)!, pin: pin, bundleID: policy.bundleID, isDebug: false))
        XCTAssertFalse(policy.admits(URL(string: callback)!, pin: pin, bundleID: "com.hushh.app", isDebug: true))
        for badPin: String? in [nil, "https://one.hushh.ai", "https://other.run.app", pin + "/", pin + ":443"] {
            XCTAssertFalse(policy.admits(URL(string: callback)!, pin: badPin, bundleID: policy.bundleID, isDebug: true))
        }
        for badReturn in ["https://other.run.app/one/profile/connectors/oauth/return", pin + "/one/profile/account", pin + "/one/profile/connectors/oauth/return#token", pin + "/%6fne/profile/connectors/oauth/return"] {
            XCTAssertFalse(policy.admits(URL(string: badReturn)!, pin: pin, bundleID: policy.bundleID, isDebug: true))
        }
    }

    func testReviewerCredentialsRequireExplicitTestModeAndEnvironment() {
        let environment = [
            "HUSHH_UI_TEST_REVIEWER_VAULT_PASSPHRASE": "synthetic-passphrase",
            "HUSHH_UI_TEST_REVIEWER_UID": "synthetic-reviewer",
        ]
        let ordinary = NativeTestConfiguration(arguments: ["App"], environment: environment)
        XCTAssertNil(ordinary.vaultPassphrase)
        XCTAssertNil(ordinary.expectedUserId)

        let legacy = NativeTestConfiguration(arguments: [
            "App", "-UITestMode",
            "-UITestVaultPassphrase", "legacy-secret",
            "-UITestExpectedUserId", "legacy-reviewer",
        ], environment: [:])
        XCTAssertNil(legacy.vaultPassphrase)
        XCTAssertNil(legacy.expectedUserId)

        let audit = NativeTestConfiguration(
            arguments: ["App", "-UITestMode"], environment: environment
        )
        XCTAssertEqual(audit.vaultPassphrase, "synthetic-passphrase")
        XCTAssertEqual(audit.expectedUserId, "synthetic-reviewer")
    }

    @MainActor
    func testWalletCardReplacementRejectsCallbacksFromThePreviousVisit() throws {
        func state(_ visit: String) throws -> NativeWorkspaceProjection {
            let object: [String: Any] = ["documentId": "public-document", "ownerEpoch": "public-owner", "ownerGeneration": 1, "revision": 1, "workspace": "wallet",
                "updateSequence": 1, "privacyGeneration": 0, "isolationGeneration": 0, "appearance": "light", "accentHex": "#007aff", "foregroundHex": "#111111",
                "frame": ["x": 0, "y": 100, "width": 390, "height": 500, "viewportWidth": 390, "viewportHeight": 844, "layoutRevision": 1],
                "page": "overview", "title": "Wallet", "enabled": true, "backEnabled": false, "sections": [],
                "wallet": ["cards": [["id": "public-card", "kind": "profile", "title": "Public fixture", "subtitle": "", "network": "", "last4": "", "holder": "", "expiry": ""]],
                    "addId": "add", "addEnabled": true, "selectedId": "public-card", "detailVisitId": visit, "closeId": "close", "detailTitle": "Public fixture", "detailBusy": false]]
            let decoded = try JSONDecoder().decode(NativeWorkspaceProjection.self, from: JSONSerialization.data(withJSONObject: object))
            XCTAssertTrue(decoded.valid); return decoded
        }
        let first = try state("visit-a"), second = try state("visit-b")
        let model = NativeWalletDetailModel(first, wallet: try XCTUnwrap(first.wallet), visit: "visit-a")
        var events = 0; model.enabled = true; model.action = { _, _ in events += 1 }
        let staleClose = { model.choose("close", from: "visit-a") }
        model.update(second, wallet: try XCTUnwrap(second.wallet))
        staleClose()
        XCTAssertEqual(events, 0, "A retained button must not inherit its replacement visit")
        model.choose("close", from: "visit-b")
        XCTAssertEqual(events, 1)
        model.clear(); model.choose("close", from: "visit-b")
        XCTAssertEqual(events, 1)
    }

    @MainActor
    func testRouteWorkspaceRetirementReleasesCoverageBeforeReceipt() throws {
        guard #available(iOS 26.0, *) else { throw XCTSkip("Native workspace requires iOS 26") }
        let object: [String: Any] = ["documentId": "public-document", "ownerEpoch": "public-owner", "ownerGeneration": 1, "revision": 1, "workspace": "referrals",
            "updateSequence": 1, "privacyGeneration": 0, "isolationGeneration": 0, "appearance": "light", "accentHex": "#007aff", "foregroundHex": "#111111",
            "frame": ["x": 0, "y": 100, "width": 390, "height": 500, "viewportWidth": 390, "viewportHeight": 844, "layoutRevision": 1],
            "page": "overview", "title": "Public workspace", "enabled": true, "backEnabled": false, "sections": []]
        let state = try JSONDecoder().decode(NativeWorkspaceProjection.self, from: JSONSerialization.data(withJSONObject: object))
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let container = NativePresentationContainer(webView: web, basePresentation: .coherentDrawers)
        let parent = UIViewController(); parent.view = container
        let presentation = try XCTUnwrap(NativeWorkspacePresentation(state, parent: parent, container: container))
        var released = false
        presentation.coverage = {
            released = !presentation.coversPresentation
            XCTAssertTrue(parent.children.isEmpty, "Coverage cannot release before the presenter detaches")
        }
        let retired = expectation(description: "Actual workspace retirement")
        presentation.retire {
            XCTAssertTrue(released, "Retirement must reconcile modal isolation before acknowledging absence")
            XCTAssertTrue(parent.children.isEmpty)
            retired.fulfill()
        }
        wait(for: [retired], timeout: 3)
        presentation.coverage = nil
    }

    @MainActor
    func testRouteBodyRetainsItsOwnerAndEditorWhileRejectingRetiredOrRepeatedActions() throws {
        func projection(sequence: Int = 1, ack: Int = 0, name: String = "Synthetic Circle") throws -> NativeWorkspaceProjection {
            let object: [String: Any] = ["documentId": "public-document", "ownerEpoch": "public-owner", "ownerGeneration": 1, "revision": 1, "workspace": "referrals",
                "updateSequence": sequence, "privacyGeneration": 0, "isolationGeneration": 0, "appearance": "light", "accentHex": "#007aff", "foregroundHex": "#111111",
                "frame": ["x": 0, "y": 100, "width": 390, "height": 500, "viewportWidth": 390, "viewportHeight": 844, "layoutRevision": 1],
                "page": "circle-create", "title": "Create a Circle", "enabled": true, "backEnabled": true, "sections": [],
                "circleEditor": ["destinationId": "public-circle-visit", "draft": ["name": name, "kind": "friends"], "draftRevision": sequence - 1, "acknowledgedEditRevision": ack, "canSave": true, "busy": false, "error": NSNull()]]
            XCTAssertTrue(NativeWorkspaceProjection.closed(object))
            let value = try JSONDecoder().decode(NativeWorkspaceProjection.self, from: JSONSerialization.data(withJSONObject: object))
            XCTAssertTrue(value.valid); return value
        }
        let state = try projection()
        var session = NativeDrawerSessionFence()
        XCTAssertTrue(session.admitOwner(documentId: state.documentId, ownerEpoch: state.ownerEpoch, ownerGeneration: state.ownerGeneration))
        let profile = NativeDrawerIdentity(documentId: state.documentId, ownerEpoch: state.ownerEpoch, ownerGeneration: state.ownerGeneration, revision: 2, family: "profile")
        XCTAssertTrue(session.contains(profile), "Preparing same-owner Profile must not retire the route body")
        XCTAssertTrue(session.admit(profile))
        var retired = NativeWorkspaceRetirementFence()
        retired.retire(state.identity) // Cancellation reaches native before apply.
        XCTAssertTrue(retired.retired(state.identity))
        let replacement = NativeWorkspaceIdentity(documentId: state.documentId, ownerEpoch: state.ownerEpoch, ownerGeneration: 1, revision: 2, workspace: "referrals")
        XCTAssertFalse(retired.retired(replacement))
        XCTAssertTrue(retired.retired(state.identity), "Readback of the departed visit remains terminal")
        let model = NativeWorkspaceModel(state)
        var eligible = true
        model.canInteract = { eligible }
        model.emit = { _ in }; model.emitEdit = { _, _ in }
        let editor = try XCTUnwrap(model.editor)
        let field = UITextField(); field.text = state.circleEditor!.draft.name; editor.register(field, name: "name")
        editor.change { $0.name = "Synthetic updated Circle" }
        editor.action("save")
        XCTAssertNil(model.pending, "Unacknowledged text cannot submit")
        XCTAssertTrue(model.update(try projection(sequence: 2, ack: 1, name: "Synthetic updated Circle")))
        XCTAssertTrue(model.editor === editor, "A compatible update retains the real editor")
        editor.action("save")
        let intent = try XCTUnwrap(model.pending)
        XCTAssertTrue(model.confirm(intent)); XCTAssertFalse(model.confirm(intent))
        XCTAssertTrue(model.settle(intent))
        editor.action("save")
        let blocked = try XCTUnwrap(model.pending)
        eligible = false
        XCTAssertFalse(model.confirm(blocked), "Coverage revocation wins over a pending action")
        model.clear()
        XCTAssertEqual(field.text, "")
        XCTAssertTrue(model.state.sections.isEmpty); XCTAssertNil(model.state.circleEditor)
        XCTAssertFalse(model.confirm(blocked))
    }

    func testNativeContentScrollMatchesDirectionalCommitAndIgnoresProgrammaticMovement() throws {
        var state = HushhNativeContentScrollState()
        XCTAssertEqual(state.apply(y: 0, fromPerson: false), 0)
        // The top-of-content rule explicitly pins chrome visible; only
        // displacement beyond that area enters the directional threshold.
        for y in stride(from: 2, through: 10, by: 2) { XCTAssertEqual(state.apply(y: CGFloat(y), fromPerson: true), 0) }
        for y in [12, 14] { XCTAssertNil(state.apply(y: CGFloat(y), fromPerson: true)) }
        XCTAssertNotNil(state.apply(y: 30, fromPerson: true))
        let progress = state.progress
        XCTAssertGreaterThan(progress, 0)
        XCTAssertNil(state.apply(y: 300, fromPerson: false))
        XCTAssertEqual(state.progress, progress, "A content update cannot slide the navigation away")
        XCTAssertNil(state.apply(y: 294, fromPerson: true))
        XCTAssertNil(state.apply(y: 288, fromPerson: true))
        XCTAssertLessThan(try XCTUnwrap(state.apply(y: 282, fromPerson: true)), progress)
        XCTAssertEqual(state.apply(y: 0, fromPerson: false), 0)
    }
    func testLegalReaderRejectsExecutableFieldsAndAdmitsOnlyCurrentDocumentLinks() throws {
        let object: [String: Any] = ["type": "privacy", "version": "1", "effectiveDate": "October 17, 2026", "summary": "Synthetic public document",
            "sections": [["id": "first", "title": "Section", "blocks": [
                ["kind": "h", "text": "Heading"], ["kind": "p", "text": [["text": "Contact", "actionId": "public-contact"]]],
                ["kind": "list", "items": [[["text": "List item"]]]],
            ]]], "related": ["label": "Terms", "actionId": "public-terms"]]
        XCTAssertTrue(NativeLegalDocument.hasClosedShape(object))
        let document = try JSONDecoder().decode(NativeLegalDocument.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertTrue(document.valid)
        var state = privateDrawerState(backEnabled: true)
        state.surfaceOpen = true; state.profileDestinationId = "public-legal-visit"
        state.profileStack = [NativeProfilePage(id: "legal", title: "Legal", sections: []),
            NativeProfilePage(id: "privacy", title: "Privacy", sections: [], legalDocument: document)]
        XCTAssertTrue(state.valid)
        XCTAssertTrue(state.allows(action: "row", row: "public-contact"))
        var direct = state; direct.profileStack?.removeFirst()
        XCTAssertTrue(direct.valid, "A document opened from Profile must not invent an intermediate Legal visit")
        XCTAssertFalse(state.allows(action: "row", row: "https://example.com"))
        XCTAssertFalse(state.allows(action: "row", row: "public-contact", text: "arbitrary"))
        state.profileStack?.removeLast()
        XCTAssertFalse(state.allows(action: "row", row: "public-contact"))
        var malformed = object; malformed["url"] = "https://example.com"
        XCTAssertFalse(NativeLegalDocument.hasClosedShape(malformed))
        malformed = object; malformed["related"] = ["label": "Terms", "actionId": "public-contact"]
        XCTAssertFalse(try JSONDecoder().decode(NativeLegalDocument.self, from: JSONSerialization.data(withJSONObject: malformed)).valid)
    }

    @MainActor
    func testSupportRequiresCommittedAcknowledgedTextAndScrubsOnRetirement() throws {
        func projection(update: Int = 1, ack: Int = 0, message: String = "Synthetic report only", sent: Bool = false) -> NativeSupportProjection {
            NativeSupportProjection(documentId: "public-support-document", ownerEpoch: "public-support-owner", family: "profile", scene: "support",
                destinationId: "public-support-visit", ownerGeneration: 1, revision: 1, updateSequence: update, privacyGeneration: 0,
                draftRevision: update, acknowledgedEditRevision: ack, draft: NativeSupportDraft(kind: "bug_report", message: message),
                canSave: !sent, busy: false, sent: sent, error: nil, replyLine: "Replies go to your verified account",
                placeholder: "What happened?", submitLabel: "Send report", successTitle: "Report sent", successDescription: "Thanks",
                appearance: "light", accentHex: "#007aff", foregroundHex: "#111111")
        }
        let model = NativeSupportModel(projection())
        let editor = UITextView(); model.editor = editor
        var choice: NativeProfileNameAction?
        model.edit = { _, _, _ in true }; model.choose = { choice = $0; return true }
        model.change(message: "Synthetic newer message", composing: true)
        XCTAssertTrue(model.update(projection(update: 2, ack: 1, message: "Synthetic newer message")))
        model.action("save")
        XCTAssertNil(choice, "Acknowledging text does not commit unfinished IME composition")
        model.change(composing: false)
        model.action("save")
        XCTAssertNil(choice, "Send must wait for the final committed edit's acknowledgement")
        XCTAssertTrue(model.update(projection(update: 3, ack: 2, message: "Synthetic newer message")))
        model.action("save")
        let intent = try XCTUnwrap(choice)
        XCTAssertTrue(model.confirm(intent))
        XCTAssertFalse(model.confirm(intent), "One Send cannot authorize two deliveries")
        XCTAssertTrue(model.settle(intent))
        XCTAssertTrue(model.update(projection(update: 4, ack: 2, message: "", sent: true)))
        XCTAssertFalse(model.canSend, "Provider acceptance cannot leave another Send active")
        XCTAssertTrue(model.canDismiss)
        editor.text = "Synthetic private replica"
        model.clear()
        XCTAssertEqual(editor.text, "")
        XCTAssertEqual(model.draft.message, "")
        XCTAssertEqual(model.projection.draft.message, "")
        XCTAssertEqual(model.projection.replyLine, "")
        XCTAssertFalse(model.canSend)
        XCTAssertFalse(model.update(projection(update: 5, ack: 2)))
    }

    @MainActor
    func testInstalledProfileBackCapabilityMatchesItsAdmittedFamily() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let host = try XCTUnwrap(scene.windows.compactMap { $0.rootViewController as? CAPBridgeViewController }.first)
        let plugin = try XCTUnwrap(host.bridge?.plugin(withName: "HushhNativeChrome") as? HushhNativeChromePlugin)
        let receipt = expectation(description: "Actual native capability, not a mocked JS flag")
        let call = CAPPluginCall(callbackId: "public-capability", methodName: "getCapabilities", options: [:], success: { result, _ in
            defer { receipt.fulfill() }
            guard case let .dictionary(value)? = result?.resultData,
                  let families = value["families"] as? [String], let replacement = value["profileBackReplacement"] as? Bool else {
                XCTFail("NATIVE_PROFILE_CAPABILITY_UNAVAILABLE"); return
            }
            XCTAssertEqual(replacement, families.contains("profile-back"),
                "Admitted Profile Back must advertise its retained binding replacement")
        }, error: { _ in XCTFail("NATIVE_PROFILE_CAPABILITY_REFUSED"); receipt.fulfill() })
        plugin.getCapabilities(try XCTUnwrap(call))
        await fulfillment(of: [receipt], timeout: 3)

        let dock = try XCTUnwrap(host.bridge?.plugin(withName: "HushhNativeDock") as? HushhNativeDockPlugin)
        let dockReceipt = expectation(description: "Bridge-queue discovery reads UIKit on main")
        let dockCall = try XCTUnwrap(CAPPluginCall(callbackId: "public-dock-capability", methodName: "getCapabilities", options: [:], success: { result, _ in
            defer { dockReceipt.fulfill() }
            XCTAssertTrue(Thread.isMainThread, "Capability discovery must not access UIViewController.view on the bridge queue")
            guard case let .dictionary(value)? = result?.resultData else {
                XCTFail("NATIVE_DOCK_CAPABILITY_UNAVAILABLE"); return
            }
            XCTAssertEqual(value["contractVersion"] as? Int, 1)
        }, error: { _ in XCTFail("NATIVE_DOCK_CAPABILITY_REFUSED"); dockReceipt.fulfill() }))
        DispatchQueue.global().async { dock.getCapabilities(dockCall) }
        await fulfillment(of: [dockReceipt], timeout: 3)
    }

    @MainActor
    func testOrdinarySheetRetirementWaitsForOpeningAndOwnedPopupCompletion() async throws {
        let windowScene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previous = windowScene.windows.first(where: \.isKeyWindow)
        let parent = UIViewController()
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = parent; window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil; previous?.makeKeyAndVisible() }
        var cleared = false, finished = false
        var popupCompletion: (() -> Void)?
        let sheet = NativeProfileOwnedSheet(makeHost: { UIViewController() }, canPresent: { !cleared },
            canDismiss: { true }, hasPending: { false }, appearance: { nil }, cancel: {}, clear: { cleared = true },
            dismissPopups: { popupCompletion = $0 })
        let shown = expectation(description: "Opening finishes without admitting a retired form")
        XCTAssertTrue(sheet.present(from: parent) { accepted in XCTAssertFalse(accepted); shown.fulfill() })
        let first = expectation(description: "Actual sheet disappearance")
        let joined = expectation(description: "Joined retirement")
        sheet.retire { XCTAssertNil(parent.presentedViewController); finished = true; first.fulfill() }
        sheet.retire { XCTAssertNil(parent.presentedViewController); joined.fulfill() }
        XCTAssertTrue(cleared)
        XCTAssertTrue(sheet.coversPresentation)
        await fulfillment(of: [shown], timeout: 3)
        XCTAssertFalse(finished, "A disappearing trigger is not popup retirement proof")
        try XCTUnwrap(popupCompletion)()
        await fulfillment(of: [first, joined], timeout: 3)
        XCTAssertFalse(sheet.coversPresentation)
    }

    @MainActor
    func testWritingStyleRequiresAcknowledgedEditsAndScrubsBeforeMenuRetirement() async throws {
        let object: [String: Any] = ["documentId": "public-style-document", "ownerEpoch": "public-style-owner", "ownerGeneration": 1,
            "revision": 1, "family": "profile", "scene": "writing-style", "updateSequence": 1, "privacyGeneration": 0,
            "draftRevision": 0, "acknowledgedEditRevision": 0, "draft": ["tone": "warm"],
            "choices": ["tone": [["value": "warm", "label": "Warm"], ["value": "direct", "label": "Direct"]],
                        "length": [["value": "short", "label": "Short"]], "language": [["value": "en", "label": "English"]]],
            "canSave": true, "busy": false, "unavailable": false, "suggested": false, "error": NSNull(),
            "appearance": "light", "accentHex": "#007aff", "foregroundHex": "#808080"]
        let state = try JSONDecoder().decode(NativeProfileStyleProjection.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertTrue(state.valid)
        XCTAssertFalse(state.validValue(.text("invented"), field: "tone"))
        XCTAssertFalse(state.validValue(.flag(true), field: "vaultKey"))
        let model = NativeProfileStyleModel(state)
        var changes = 0
        model.edit = { field, value, _, _ in changes += 1; return field == "tone" && value == .text("direct") }
        model.change("tone", .text("direct"))
        XCTAssertEqual(changes, 1)
        XCTAssertFalse(model.canSave)
        var updated = object
        updated["updateSequence"] = 2; updated["draftRevision"] = 1; updated["acknowledgedEditRevision"] = 1
        updated["draft"] = ["tone": "direct"]
        let next = try JSONDecoder().decode(NativeProfileStyleProjection.self, from: JSONSerialization.data(withJSONObject: updated))
        XCTAssertTrue(model.update(next))
        XCTAssertTrue(model.canSave)
        var action: NativeProfileNameAction?
        model.choose = { action = $0; return true }
        model.action("save")
        let intent = try XCTUnwrap(action)
        XCTAssertTrue(model.confirm(intent)); XCTAssertFalse(model.confirm(intent))
        XCTAssertTrue(model.settle(intent, saved: true)); XCTAssertTrue(model.saved)
        XCTAssertTrue(model.canEdit, "Explicit Save stays in the existing Settings editor")
        let binding = NativeProfileStyleMenuBinding(next)
        updated["updateSequence"] = 3; updated["appearance"] = "dark"
        let themed = try JSONDecoder().decode(NativeProfileStyleProjection.self, from: JSONSerialization.data(withJSONObject: updated))
        XCTAssertTrue(model.update(themed))
        model.edit = { field, value, _, _ in field == "tone" && value == .text("warm") }
        model.chooseOption("tone", value: .text("warm"), from: binding)
        XCTAssertTrue(model.draft["tone"] == .text("warm"), "A compatible appearance update cannot invalidate an open menu")
        updated["updateSequence"] = 4; updated["draftRevision"] = 2; updated["acknowledgedEditRevision"] = 2
        updated["draft"] = ["tone": "warm"]
        XCTAssertTrue(model.update(try JSONDecoder().decode(NativeProfileStyleProjection.self, from: JSONSerialization.data(withJSONObject: updated))))
        let menu = NativeDrawerMenuControl(type: .system)
        model.register(menu)
        let interaction = UIContextMenuInteraction(delegate: menu)
        let config = UIContextMenuConfiguration(identifier: nil, previewProvider: nil, actionProvider: nil)
        menu.contextMenuInteraction(interaction, willDisplayMenuFor: config, animator: nil)
        XCTAssertFalse(model.canSave); XCTAssertFalse(model.canDismiss)
        model.withdraw(menu)
        XCTAssertFalse(model.canSave, "A removed trigger still owns its visible popup")
        XCTAssertFalse(model.canDismiss)
        if #available(iOS 26.0, *) {
            let field = UITextView()
            model.register(field)
            let delegate = NativeProfileStyleText.Coordinator(model, "preferred_name", false)
            XCTAssertTrue(delegate.textView(field, shouldChangeTextIn: NSRange(location: 0, length: 0), replacementText: "Ada\nLovelace"),
                          "A multiline paste is not a Return key and cannot dismiss the editor")
            model.edit = { _, _, _, _ in true }
            XCTAssertFalse(delegate.textView(field, shouldChangeTextIn: NSRange(location: 0, length: 0), replacementText: "\n"))
        }
        var disappeared = false
        let ended = expectation(description: "Owned menu completed disappearance")
        model.clear()
        model.dismissMenus { disappeared = true; ended.fulfill() }
        XCTAssertTrue(model.draft.isEmpty); XCTAssertTrue(model.projection.draft.isEmpty)
        XCTAssertFalse(disappeared)
        menu.contextMenuInteraction(interaction, willEndFor: config, animator: nil)
        await fulfillment(of: [ended], timeout: 3)
        XCTAssertTrue(disappeared)
        XCTAssertFalse(model.canEdit); XCTAssertNil(model.edit); XCTAssertNil(model.choose)
    }
    @MainActor
    func testOrdinaryNameSheetReleasesGestureLockAndWaitsForUIKitRetirement() async throws {
        guard #available(iOS 26.0, *) else { throw XCTSkip("Native ordinary scene requires iOS 26") }
        let windowScene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previous = windowScene.windows.first(where: \.isKeyWindow)
        let parent = UIViewController()
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = parent
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil; previous?.makeKeyAndVisible() }
        let scene = NativeProfileNameScene(publicNameScene())
        let shown = expectation(description: "Public ordinary scene presented")
        XCTAssertTrue(scene.present(from: parent) { admitted in XCTAssertTrue(admitted); shown.fulfill() })
        await fulfillment(of: [shown], timeout: 3)
        let presented = try XCTUnwrap(parent.presentedViewController)
        var action: NativeProfileNameAction?
        scene.model.choose = { action = $0; return true }
        scene.model.action("save")
        let pending = try XCTUnwrap(action)
        XCTAssertTrue(scene.update(publicNameScene(update: 2, appearance: "dark")))
        XCTAssertTrue(presented.isModalInPresentation)
        XCTAssertTrue(scene.settle(pending))
        XCTAssertFalse(presented.isModalInPresentation, "Rejected/refused Save must restore native drag dismissal")
        let first = expectation(description: "First actual dismissal observer")
        let second = expectation(description: "Joined actual dismissal observer")
        scene.retire { XCTAssertNil(parent.presentedViewController); first.fulfill() }
        XCTAssertTrue(scene.model.retired)
        XCTAssertTrue(scene.model.text.isEmpty, "Private replica must clear before dismissal completes")
        scene.retire { XCTAssertNil(parent.presentedViewController); second.fulfill() }
        await fulfillment(of: [first, second], timeout: 3)
        XCTAssertFalse(scene.coversPresentation)
    }

    private func publicNameScene(update: Int = 1, ack: Int = 0, draft: String = "Public Example",
                                 appearance: String = "light", scene: String = "account-name", destination: String? = nil) -> NativeProfileNameProjection {
        NativeProfileNameProjection(documentId: "public-name-document", ownerEpoch: "public-name-owner", ownerGeneration: 1,
            revision: 1, family: "profile", scene: scene, updateSequence: update, privacyGeneration: 0,
            draftRevision: update, acknowledgedEditRevision: ack, draft: draft, canSave: true, busy: false,
            error: "Public validation sample", appearance: appearance, accentHex: "#007aff", foregroundHex: "#808080", destinationId: destination)
    }
    @MainActor
    func testNativeVaultPasswordWaitsForTheFinalPairAndScrubsBeforeRetirement() {
        func state(_ update: Int, _ edit: Int, _ draft: String, _ canSave: Bool) -> NativePasswordProjection {
            NativePasswordProjection(documentId: "synthetic-vault-document", ownerEpoch: "synthetic-owner", ownerGeneration: 1,
                revision: 1, family: "profile", scene: "vault-passphrase", destinationId: "synthetic-visit", updateSequence: update,
                privacyGeneration: 0, acknowledgedEditRevision: edit, password: draft, confirmation: draft,
                canSave: canSave, busy: false, appearance: "light", accentHex: "#007AFF", foregroundHex: "#111111")
        }
        let initial = state(1, 0, "", false)
        XCTAssertTrue(initial.valid)
        let model = NativePasswordModel(initial)
        let password = UITextField(), confirmation = UITextField()
        model.passwordField = password; model.confirmationField = confirmation
        model.edit = { _, _, _, _ in true }
        var chosen: NativeProfileNameAction?
        model.choose = { chosen = $0; return true }
        password.text = "Synthetic new password"; confirmation.text = "Synthetic new password"
        model.capture()
        model.action("save")
        XCTAssertNil(chosen, "Native edits cannot submit before React acknowledges its final pair")
        XCTAssertTrue(model.update(state(2, 1, "Synthetic new password", true)))
        model.action("save")
        XCTAssertNotNil(chosen)
        if let chosen { XCTAssertTrue(model.confirm(chosen)); XCTAssertFalse(model.confirm(chosen)) }
        model.clear()
        XCTAssertEqual(password.text, ""); XCTAssertEqual(confirmation.text, "")
        XCTAssertEqual(model.password, ""); XCTAssertEqual(model.confirmation, "")
        XCTAssertEqual(model.projection.password, ""); XCTAssertEqual(model.projection.confirmation, "")
        XCTAssertFalse(model.canEdit); XCTAssertNil(model.pending)
        XCTAssertEqual(NativeProfilePricingDecimal.canonical("0,50", separator: ","), "0.50")
        XCTAssertEqual(NativeProfilePricingDecimal.canonical("1.23,45", separator: ","), "1.23,45",
            "A keyboard adapter must not reinterpret mixed/thousands notation as a valid price")
    }

    @MainActor
    func testWorldModelFormRetainsTheEditorAndScrubsBeforeDismissal() {
        func state(_ update: Int, _ ack: Int, destination: String = "public-world-model-visit") -> NativeWorldModelProjection {
            NativeWorldModelProjection(documentId: "public-world-model-document", ownerEpoch: "public-owner", ownerGeneration: 1, revision: 1,
                family: "profile", scene: "world-model-fact-edit", destinationId: destination, updateSequence: update, privacyGeneration: 0,
                draftRevision: update, acknowledgedEditRevision: ack, draft: NativeWorldModelDraft(text: ack == 0 ? "Public example" : "Public corrected example"),
                canSave: true, busy: false, error: "Public validation example", appearance: update == 1 ? "light" : "dark", accentHex: "#007AFF", foregroundHex: "#111111")
        }
        let profile = NativeWorldModelDraft(urls: "https://public.example/profile", permitted: true)
        XCTAssertTrue(profile.valid("world-model-public-profiles"))
        XCTAssertFalse(NativeWorldModelDraft(text: "Wrong payload").valid("world-model-public-profiles"))
        let model = NativeWorldModelFormModel(state(1, 0)), editor = UITextView()
        model.register(editor); model.edit = { _, _, _ in true }; model.choose = { _ in true }
        editor.text = "Public corrected example"; model.capture(editor, field: "text")
        XCTAssertFalse(model.canSave, "No Save until the final edit is acknowledged")
        XCTAssertFalse(model.update(state(2, 1, destination: "another-visit")))
        XCTAssertTrue(model.update(state(2, 1)))
        XCTAssertTrue(model.canSave)
        model.action("save")
        let action = model.pending!
        XCTAssertTrue(model.confirm(action)); XCTAssertFalse(model.confirm(action))
        model.clear()
        XCTAssertEqual(editor.text, ""); XCTAssertNil(model.draft.text); XCTAssertNil(model.projection.draft.text)
        XCTAssertNil(model.projection.error); XCTAssertNil(model.pending); XCTAssertNil(model.edit); XCTAssertNil(model.choose)
        XCTAssertFalse(model.update(state(3, 1)))
    }

    @MainActor
    func testProviderFormRetainsFinalInputAndScrubsItsPrivateReplica() {
        func state(_ update: Int, _ ack: Int, destination: String = "public-runtime-visit") -> NativeRuntimeProjection {
            NativeRuntimeProjection(documentId: "public-runtime-document", ownerEpoch: "public-owner", ownerGeneration: 1, revision: 1,
                family: "profile", scene: "runtime-provider", destinationId: destination, updateSequence: update, privacyGeneration: 0,
                acknowledgedEditRevision: ack, draftRevision: ack, draft: NativeRuntimeDraft(credential: ack == 0 ? "" : "synthetic-provider-key", transport: "developer_api", project: "", location: "global"),
                canSave: true, busy: false, checking: false, primary: "validate", error: "Public validation example", appearance: "light", accentHex: "#007AFF", foregroundHex: "#111111")
        }
        let model = NativeRuntimeModel(state(1, 0)), field = UITextField()
        field.isSecureTextEntry = true; model.register(field, name: "credential")
        model.edit = { _, _, _ in true }; model.choose = { _ in true }
        field.text = "synthetic-provider-key"; model.capture()
        XCTAssertFalse(model.canSave)
        XCTAssertFalse(model.update(state(2, 1, destination: "retired-runtime-visit")))
        XCTAssertTrue(model.update(state(2, 1)))
        XCTAssertTrue(model.canSave)
        model.action("save"); let action = model.pending!
        XCTAssertTrue(model.confirm(action)); XCTAssertFalse(model.confirm(action))
        XCTAssertTrue(model.settle(action)); XCTAssertEqual(field.text, "synthetic-provider-key")
        var finalInput: NativeRuntimeDraft?
        model.finalEdit = { value, _ in finalInput = value }
        field.text = "synthetic-final-provider-key"
        model.clear()
        XCTAssertEqual(finalInput?.credential, "synthetic-final-provider-key", "Final committed text is reconciled before replica scrubbing")
        XCTAssertEqual(field.text, ""); XCTAssertEqual(model.draft, .empty); XCTAssertEqual(model.projection.draft, .empty)
        XCTAssertNil(model.projection.error); XCTAssertNil(model.pending); XCTAssertNil(model.edit); XCTAssertNil(model.choose); XCTAssertNil(model.finalEdit)
        XCTAssertFalse(model.update(state(3, 1)))
        if #available(iOS 16.0, *) {
            let retiring = NativeRuntimeModel(state(1, 0)), target = UITextField()
            let menu = EditorMenuDismissalProbe(delegate: nil)
            target.addInteraction(menu); target.text = "synthetic-private-text"
            retiring.register(target, name: "credential"); retiring.editMenuPresented(target)
            retiring.clear()
            var finished = false
            retiring.dismissEditorMenus { finished = true }
            XCTAssertEqual(target.text, "", "Scrub before requesting popup retirement")
            XCTAssertEqual(menu.dismissals, 1, "Cleared registries must not lose the active menu target")
            XCTAssertFalse(finished, "A dismissal request is not its completion")
            retiring.editMenuDismissed(target)
            XCTAssertTrue(finished)
        }
    }

    @MainActor
    func testConnectorEditorClearsConditionalSecretsAndRetainsFinalInputBeforeRetirement() throws {
        let initial = NativeConnectorProjection(documentId: "public-connector-document", ownerEpoch: "public-owner", ownerGeneration: 1, revision: 1,
            family: "profile", scene: "connector-custom-server", destinationId: "public-connector-visit", updateSequence: 1, privacyGeneration: 0,
            acknowledgedEditRevision: 0, draftRevision: 0,
            draft: NativeConnectorDraft(name: "Synthetic", endpoint: "https://example.com/mcp", credential: "", oauthIssuer: "https://accounts.example.com",
                                        oauthClientId: "synthetic-client", oauthClientSecret: "synthetic-client-secret", oauthAuthMethod: "client_secret_post"),
            canSave: true, busy: false, error: "Public setup example", appearance: "light", accentHex: "#007AFF", foregroundHex: "#111111")
        let model = NativeConnectorModel(initial), secret = UITextField(), endpoint = UITextField()
        secret.isSecureTextEntry = true; secret.text = initial.draft.oauthClientSecret; endpoint.text = initial.draft.endpoint
        model.register(secret, name: "oauthClientSecret"); model.register(endpoint, name: "endpoint"); model.edit = { _, _, _ in true }
        model.change { $0.oauthAuthMethod = "none"; $0.oauthClientSecret = "" }
        XCTAssertEqual(secret.text, ""); XCTAssertEqual(model.draft.oauthClientSecret, ""); XCTAssertFalse(model.canSave)
        let acknowledged = NativeConnectorProjection(documentId: initial.documentId, ownerEpoch: initial.ownerEpoch, ownerGeneration: 1, revision: 1,
            family: "profile", scene: initial.scene, destinationId: initial.destinationId, updateSequence: 2, privacyGeneration: 0,
            acknowledgedEditRevision: 1, draftRevision: 1, draft: model.draft, canSave: true, busy: false, error: nil,
            appearance: "dark", accentHex: "#CCA25C", foregroundHex: "#FFFFFF")
        XCTAssertTrue(model.update(acknowledged)); XCTAssertTrue(model.canSave)
        var final: NativeConnectorDraft?
        model.finalEdit = { value, _ in final = value }
        endpoint.text = "https://example.com/final-input"
        model.clear()
        XCTAssertEqual(final?.endpoint, "https://example.com/final-input"); XCTAssertEqual(final?.oauthClientSecret, "")
        XCTAssertEqual(secret.text, ""); XCTAssertEqual(endpoint.text, ""); XCTAssertEqual(model.draft, .empty); XCTAssertEqual(model.projection.draft, .empty)
        XCTAssertNil(model.finalEdit); XCTAssertNil(model.edit); XCTAssertNil(model.choose); XCTAssertNil(model.projection.error)
        XCTAssertFalse(model.update(acknowledged))
        // A bridge dispatch is not an edit acknowledgement. Rejected delivery
        // and accepted-but-unacknowledged delivery must both offer final input
        // without restoring a save/choice callback.
        for delivered in [false, true] {
            let pending = NativeConnectorModel(initial), field = UITextField()
            field.text = "synthetic-unacknowledged-input"; pending.register(field, name: "credential")
            var finalDraft: NativeConnectorDraft?
            pending.finalEdit = { value, _ in finalDraft = value }; pending.edit = { _, _, _ in delivered }
            pending.capture()
            if delivered { pending.clear() }
            XCTAssertEqual(finalDraft?.credential, "synthetic-unacknowledged-input")
            XCTAssertTrue(pending.retired); XCTAssertNil(pending.choose); XCTAssertEqual(field.text, "")
        }
        for (scene, data, fieldName, lastInput) in [
            ("connector-profile-link", #"{"network":"instagram","link":"https://www.instagram.com/example/"}"#, "link", "https://www.instagram.com/final-example/"),
            ("connector-packet-price", #"{"price":"12.34"}"#, "price", "19.95")
        ] {
            let draft = try JSONDecoder().decode(NativeConnectorDraft.self, from: Data(data.utf8))
            let projection = NativeConnectorProjection(documentId: initial.documentId, ownerEpoch: initial.ownerEpoch, ownerGeneration: 1, revision: 2,
                family: "profile", scene: scene, destinationId: "public-sibling-editor", updateSequence: 1, privacyGeneration: 0,
                acknowledgedEditRevision: 0, draftRevision: 0, draft: draft, canSave: true, busy: false, error: nil,
                appearance: "light", accentHex: "#007AFF", foregroundHex: "#111111")
            XCTAssertTrue(projection.valid)
            XCTAssertEqual(NativeConnectorProjection.draftKeys(scene), Set(draft.event.keys))
            let sibling = NativeConnectorModel(projection), field = UITextField()
            field.text = lastInput; sibling.register(field, name: fieldName)
            var final: NativeConnectorDraft?
            sibling.edit = { _, _, _ in true }; sibling.finalEdit = { value, _ in final = value }
            sibling.capture(); sibling.clear()
            XCTAssertEqual(final?[fieldName], lastInput)
            XCTAssertEqual(field.text, ""); XCTAssertEqual(sibling.draft, .empty); XCTAssertEqual(sibling.projection.draft, .empty)
            XCTAssertNil(sibling.finalEdit); XCTAssertNil(sibling.choose)
        }
    }

    @MainActor
    func testMemoryMultilineEditorReconcilesFinalInputAndScrubsItsReplica() throws {
        let state = NativeMemoryProjection(documentId: "public-memory-document", ownerEpoch: "public-owner", ownerGeneration: 1, revision: 1,
            family: "profile", scene: "memory-financial-context", destinationId: "public-memory-visit", updateSequence: 1, privacyGeneration: 0,
            acknowledgedEditRevision: 0, draftRevision: 0, draft: .init(category: "risk", text: "Synthetic"), canSave: true, busy: false, error: nil,
            appearance: "light", accentHex: "#007AFF", foregroundHex: "#111111")
        XCTAssertTrue(state.valid)
        let model = NativeMemoryEditorModel(state), editor = UITextView()
        editor.text = "Synthetic multiline\n漢字 😀"; model.register(editor, name: "text")
        var final: NativeMemoryDraft?
        model.edit = { _, _, _ in true }; model.finalEdit = { value, _ in final = value }
        model.capture(); XCTAssertFalse(model.canSave)
        model.clear()
        XCTAssertEqual(final?.text, "Synthetic multiline\n漢字 😀")
        XCTAssertEqual(editor.text, ""); XCTAssertEqual(model.draft, .empty); XCTAssertEqual(model.projection.draft, .empty)
        XCTAssertNil(model.finalEdit); XCTAssertNil(model.choose); XCTAssertTrue(model.retired)
        XCTAssertFalse(model.update(state))
    }

    @MainActor
    func testOrdinaryNameSceneRequiresAnAcknowledgedEditAndOneConfirmedSave() throws {
        let handle = publicNameScene(draft: "public-handle", scene: "referral-handle", destination: "public-referral-visit")
        XCTAssertTrue(handle.valid)
        XCTAssertFalse(publicNameScene(scene: "referral-handle").valid)
        XCTAssertFalse(publicNameScene(draft: String(repeating: "x", count: 33), scene: "referral-handle", destination: "public-referral-visit").valid)
        let handleModel = NativeProfileNameModel(handle)
        XCTAssertFalse(handleModel.update(publicNameScene(update: 2, destination: "public-referral-visit")), "A handle scene cannot become an Account writer")
        let model = NativeProfileNameModel(publicNameScene())
        let field = UITextField()
        model.editor = field
        var edits = 0
        model.edit = { _, _, revision in edits += 1; return revision == 1 }
        var choice: NativeProfileNameAction?
        model.choose = { choice = $0; return true }
        field.text = "Public New Name"
        model.capture(field)
        XCTAssertEqual(edits, 1)
        XCTAssertFalse(model.canSave)
        model.action("save")
        XCTAssertNil(choice, "An old Save projection cannot submit the native editor's newer text")
        XCTAssertTrue(model.update(publicNameScene(update: 2, ack: 0, appearance: "dark")))
        XCTAssertEqual(model.text, "Public New Name", "A theme echo cannot replace unacknowledged editing")
        XCTAssertTrue(model.update(publicNameScene(update: 3, ack: 1, draft: "Public New Name", appearance: "dark")))
        XCTAssertTrue(model.canSave)
        model.action("save")
        let action = try XCTUnwrap(choice)
        XCTAssertFalse(model.confirm(NativeProfileNameAction(updateSequence: 3, editRevision: 0, sequence: action.sequence, action: "save")))
        XCTAssertTrue(model.confirm(action))
        XCTAssertFalse(model.confirm(action), "A duplicate acknowledgement cannot authorize another write")
        XCTAssertFalse(model.canEdit)
        XCTAssertTrue(model.settle(action))
        XCTAssertTrue(model.canEdit)
        XCTAssertTrue(model.editor === field)
    }
    @MainActor
    func testNameSceneRetirementScrubsItsPrivateReplicaBeforeDismissing() {
        let model = NativeProfileNameModel(publicNameScene())
        let field = UITextField()
        model.editor = field
        field.text = "Public Unsaved Name"
        model.edit = { _, _, _ in true }
        model.capture(field)
        model.clear()
        XCTAssertEqual(model.text, "")
        XCTAssertEqual(model.projection.draft, "")
        XCTAssertNil(model.projection.error)
        XCTAssertEqual(field.text, "")
        XCTAssertNil(model.edit)
        XCTAssertNil(model.choose)
        XCTAssertFalse(model.canEdit)
        XCTAssertFalse(model.canSave)
        XCTAssertFalse(model.update(publicNameScene(update: 2)))
    }

    #if DEBUG
    func testControlHitEvidenceDetectsWindowInterceptionWithoutGrantingAdmission() throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 1194, height: 834))
        let web = WKWebView(frame: window.bounds)
        let container = NativePresentationContainer(webView: web, basePresentation: .coherentDrawers)
        window.addSubview(container)
        window.isHidden = false
        defer { window.isHidden = true }
        let control = UIButton(frame: CGRect(x: 24, y: 72, width: 44, height: 44))
        container.install(control, id: "chat-history-toggle", group: nil)
        container.setAdmission("chat-history-toggle", admitted: true)
        let initial = try XCTUnwrap(container.controlHitEvidence("chat-history-toggle"))
        XCTAssertEqual(initial.containerHits, Array(repeating: .target, count: 5))
        XCTAssertEqual(initial.windowHits, initial.containerHits)
        // Negative control: unchanged geometry/admission, but a sibling above
        // the container intercepts the actual window-level touch target.
        let interceptor = UIView(frame: control.frame)
        window.addSubview(interceptor)
        let covered = try XCTUnwrap(container.controlHitEvidence("chat-history-toggle"))
        XCTAssertEqual(covered.frame, initial.frame)
        XCTAssertEqual(covered.containerHits, initial.containerHits)
        XCTAssertEqual(covered.windowHits, Array(repeating: .other, count: 5))
        interceptor.removeFromSuperview()
        container.setAdmission("chat-history-toggle", admitted: false)
        let withdrawn = try XCTUnwrap(container.controlHitEvidence("chat-history-toggle"))
        XCTAssertFalse(withdrawn.admitted)
        XCTAssertTrue(withdrawn.touchBlocked)
        XCTAssertTrue(withdrawn.axHidden)
        XCTAssertFalse(withdrawn.windowHits.contains(.target))
        XCTAssertFalse(control.isUserInteractionEnabled, "Observing a withdrawn lease must not restore its actions")
    }
    #endif

    func testNativeProfileUsesTheBundledWebArtworkAndRejectsUnknownIds() throws {
        XCTAssertFalse(NativeProfileArtwork.ids.isEmpty)
        XCTAssertEqual(Set(NativeProfileArtwork.ids).count, NativeProfileArtwork.ids.count)
        let originalArtwork: Set<String> = ["gemini", "connector-gmail", "connector-google-drive",
            "connector-calendar", "connector-hubspot", "connector-instagram", "connector-linkedin"]
        let accentedArtwork: Set<String> = ["hosting", "software-updates", "account", "payouts", "request-pricing", "my-data", "world-model",
            "preferences", "security", "devices", "connectors", "invite", "support", "privacy", "terms", "sign-out",
            "account-name", "account-mail", "account-phone", "account-wallet", "account-reset", "vault-methods", "vault-password", "appearance", "accent", "voice",
            "payout-receipt", "payout-warning", "payout-progress", "payout-review",
            "style-name", "style-tone", "style-length", "style-language", "style-punctuation",
            "action-join", "action-manage-connections"]
        for id in NativeProfileArtwork.ids {
            let artwork = try XCTUnwrap(NativeProfileArtwork.resolve(id), "Missing shared Profile artwork")
            let glyphSize: CGFloat = id == "gemini" ? 32 : 28
            XCTAssertEqual(artwork.base.size, CGSize(width: glyphSize, height: glyphSize))
            XCTAssertEqual(artwork.base.renderingMode, originalArtwork.contains(id) ? .alwaysOriginal : .alwaysTemplate, id)
            XCTAssertEqual(artwork.accent != nil, accentedArtwork.contains(id), id)
        }
        for id in accentedArtwork {
            XCTAssertNil(NativeProfileArtwork.resolve(id)?.colorHex,
                "Shared Profile outlines use the same semantic foreground as the web, not capability colors: \(id)")
        }
        XCTAssertEqual(NativeProfileArtwork.resolve("vault-password")?.accentColorHex?.lowercased(), "#007aff")
        XCTAssertNil(NativeProfileArtwork.resolve("account")?.accentColorHex, "Ordinary accent details follow the selected app accent")
        XCTAssertNotNil(NativeProfileArtwork.resolve("gemini"))
        XCTAssertNil(NativeProfileArtwork.resolve("privacy")?.colorHex, "Semantic foreground stays theme-aware")
        XCTAssertNil(NativeProfileArtwork.resolve("../../private"))
        XCTAssertNil(NativeProfileArtwork.resolve("unknown"))
    }
    func testCoherentDeviceAdmissionAndProfileGeometryPreservePlatformFallbacks() {
        #if !DEBUG && !HUSHH_NATIVE_SHELL_QUALIFICATION
        XCTAssertFalse(NativeDrawerQualificationPolicy.coherentShell,
            "Ordinary distribution must not enable the unqualified custom native shell")
        XCTAssertFalse(NativeDrawerQualificationPolicy.enabled)
        #endif
        XCTAssertFalse(NativeDrawerQualificationPolicy.admits(.pad, enabled: true, coherentShell: false))
        XCTAssertFalse(NativeDrawerQualificationPolicy.admits(.phone, enabled: false, coherentShell: false))
        XCTAssertTrue(NativeDrawerQualificationPolicy.admits(.pad, enabled: true, coherentShell: true))
        XCTAssertFalse(NativeDrawerQualificationPolicy.admits(.tv, enabled: true, coherentShell: true))
        for bounds in [CGRect(x: 0, y: 0, width: 390, height: 844), CGRect(x: 0, y: 0, width: 844, height: 390)] {
            XCTAssertEqual(NativeDrawerLayout.frame(family: "profile", in: bounds, phone: true), bounds)
            XCTAssertEqual(NativeDrawerLayout.frame(family: "history", in: bounds, phone: true), bounds)
        }
        let compact = CGRect(x: 0, y: 0, width: 639, height: 834)
        XCTAssertEqual(NativeDrawerLayout.frame(family: "profile", in: compact, phone: false), compact)
        let tablet = CGRect(x: 0, y: 0, width: 1194, height: 834)
        let frame = NativeDrawerLayout.frame(family: "profile", in: tablet, phone: false)
        XCTAssertEqual(frame.width, 430)
        XCTAssertEqual(frame.minY, tablet.minY)
        XCTAssertEqual(frame.maxY, tablet.maxY)
        XCTAssertEqual(tablet.maxX - frame.maxX, 18)
        XCTAssertTrue(tablet.contains(frame))
        let travel = NativeDrawerLayout.travel(family: "profile", frame: frame, in: tablet)
        XCTAssertEqual(travel, 448)
        XCTAssertGreaterThanOrEqual(frame.offsetBy(dx: travel, dy: 0).minX, tablet.maxX)
        XCTAssertLessThan(frame.offsetBy(dx: frame.width, dy: 0).minX, tablet.maxX,
            "Negative control: width-only travel leaves the inset tablet panel exposed")
    }
    @MainActor
    func testDrawerBootstrapUsesTheFinalCapacitorContentController() {
        let controller = MyViewController()
        let configuration = WKWebViewConfiguration()
        // Capacitor replaces the content controller after webViewConfiguration.
        // Renderer bootstrap must reach the final configuration used by WK.
        configuration.userContentController = WKUserContentController()
        let web = controller.webView(with: .zero, configuration: configuration)
        let scripts = web.configuration.userContentController.userScripts.filter {
            $0.source.contains("__HUSHH_NATIVE_DRAWER_BOOTSTRAP__")
        }
        XCTAssertEqual(scripts.count, 1, "Bootstrap was lost before the document could choose its renderer")
        XCTAssertEqual(scripts.first?.injectionTime, .atDocumentStart)
        XCTAssertEqual(scripts.first?.isForMainFrameOnly, true)
    }

    private func privateDrawerState(family: String = "profile", open: Bool = true,
                                   owner: String = "opaque-owner", revision: Int = 1, update: Int = 1,
                                   appearance: String = "light", privacy: Int = 0, enabled: Bool = true,
                                   sampleRow: NativeDrawerRow? = nil, backEnabled: Bool = false, title: String = "Public sample") -> NativeDrawerProjection {
        NativeDrawerProjection(documentId: "public-document", ownerEpoch: owner, ownerGeneration: revision, revision: revision, family: family,
            updateSequence: update, privacyGeneration: privacy, appearance: appearance, accentHex: "#007aff", foregroundHex: "#000000",
            title: title, sections: [NativeDrawerSection(id: "settings", title: "Settings",
                rows: [sampleRow ?? NativeDrawerRow(id: "row-handle", label: "Appearance", detail: nil, symbol: "circle.lefthalf.filled",
                    enabled: true, destructive: nil, selected: nil, pending: nil)])],
            open: open, enabled: enabled, backEnabled: backEnabled)
    }

    @MainActor
    func testRenderedHistoryTitleSharesAgeFlowAndStaysCenteredBesideA44PointMenu() async throws {
        // Actual shared SwiftUI content, not a lookalike or private transcript.
        func measure(_ title: String, age: String?, size: DynamicTypeSize = .large) async throws -> NativeHistoryRowLayout {
            let row = NativeDrawerRow(id: "public-row", label: title, detail: age, symbol: nil,
                enabled: true, destructive: nil, selected: nil, pending: nil, renameActionId: "public-rename")
            let model = NativeDrawerModel(privateDrawerState(family: "history", sampleRow: row))
            model.interactionEnabled = true
            var measured: [NativeHistoryLayoutPart: CGRect] = [:]
            let host = UIHostingController(rootView: NativeDrawerContent(model: model, historyLayoutObserver: { id, part, frame in
                if id == "public-row" { measured[part] = frame }
            }).environment(\.dynamicTypeSize, size))
            let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
            let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 343, height: 844))
            window.windowScene = scene
            window.rootViewController = host
            window.makeKeyAndVisible()
            defer {
                window.isHidden = true; window.rootViewController = nil
                previousKeyWindow?.makeKeyAndVisible()
            }
            host.view.layoutIfNeeded()
            let rendered = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                [NativeHistoryLayoutPart.title, .row, .more].allSatisfy {
                    guard let frame = measured[$0] else { return false }
                    return frame.width > 0 && frame.height > 0 && frame.minX.isFinite && frame.minY.isFinite
                }
            }, object: nil)
            await fulfillment(of: [rendered], timeout: 3)
            let layout = NativeHistoryRowLayout(title: try XCTUnwrap(measured[.title]),
                row: try XCTUnwrap(measured[.row]), more: try XCTUnwrap(measured[.more]))
            XCTAssertEqual(layout.title.midY, layout.row.midY, accuracy: 1)
            XCTAssertLessThanOrEqual(layout.title.maxX, layout.more.minX + 1)
            XCTAssertGreaterThanOrEqual(layout.row.height, 44 - 1e-6,
                "Ignore only floating-point roundoff, never an undersized hit region")
            XCTAssertEqual(layout.more.width, 44, accuracy: 1)
            XCTAssertEqual(layout.more.height, 44, accuracy: 1)
            return layout
        }
        let titleOnly = try await measure("Weekend", age: nil)
        let inlineAge = try await measure("Weekend", age: "2h")
        XCTAssertGreaterThan(inlineAge.title.width, titleOnly.title.width + 5,
            "Rendered age must extend the title's own text flow, not disappear or occupy another track")
        XCTAssertEqual(inlineAge.title.height, titleOnly.title.height, accuracy: 1,
            "Short title and age share one rendered line")
        let long = try await measure("A public conversation title that remains available without changing the More track", age: "2h")
        XCTAssertEqual(long.row.height, inlineAge.row.height, accuracy: 1,
            "Long titles and timestamps must not create uneven default row heights")
        let enlarged = try await measure("Weekend", age: "2h", size: .accessibility3)
        XCTAssertGreaterThan(enlarged.title.height, inlineAge.title.height + 5,
            "Dynamic Type must enlarge the rendered title while preserving centering and menu geometry")
    }

    func testPrivateDrawerRenameBindsTheExactEmittedTextAndRejectsUnboundedInput() throws {
        var state = privateDrawerState(family: "history")
        var row = state.sections[0].rows[0]
        row.renameActionId = "rename"; row.deleteActionId = "delete"
        let options = try JSONSerialization.jsonObject(with: JSONEncoder().encode(state)) as! [String: Any]
        var rewritten = options
        rewritten["sections"] = [["id": "history", "rows": [try JSONSerialization.jsonObject(with: JSONEncoder().encode(row))]]]
        state = try JSONDecoder().decode(NativeDrawerProjection.self, from: JSONSerialization.data(withJSONObject: rewritten))
        var lease = NativeDrawerLease()
        XCTAssertTrue(lease.apply(state))
        XCTAssertNil(lease.emit(action: "row", row: "rename", state: state, text: " "))
        XCTAssertNil(lease.emit(action: "row", row: "rename", state: state, text: String(repeating: "a", count: 161)))
        XCTAssertNil(lease.emit(action: "row", row: "delete", state: state, text: "not admitted"))
        let sequence = try XCTUnwrap(lease.emit(action: "row", row: "rename", state: state, text: "Public title"))
        XCTAssertFalse(lease.confirm(identity: state.identity, update: 1, privacy: 0, sequence: sequence, interaction: 1,
            action: "row", row: "rename", allowed: true, text: "Altered title"))
        XCTAssertTrue(lease.confirm(identity: state.identity, update: 1, privacy: 0, sequence: sequence, interaction: 1,
            action: "row", row: "rename", allowed: true, text: "Public title"))
        XCTAssertTrue(lease.acceptsSettlement(identity: state.identity, privacy: 0, sequence: sequence))
        XCTAssertFalse(lease.acceptsSettlement(identity: state.identity, privacy: 1, sequence: sequence))
        XCTAssertFalse(lease.acceptsSettlement(identity: state.identity, privacy: 0, sequence: sequence + 1))
        let cancelled = try XCTUnwrap(lease.emit(action: "row", row: "rename", state: state, text: "Public draft"))
        XCTAssertFalse(lease.settle(identity: state.identity, privacy: 0, sequence: cancelled, success: true),
            "An unconfirmed choice can only be cancelled, not declared successful")
        XCTAssertTrue(lease.settle(identity: state.identity, privacy: 0, sequence: cancelled, success: false))
        XCTAssertFalse(lease.confirm(identity: state.identity, update: 1, privacy: 0, sequence: cancelled, interaction: 1,
            action: "row", row: "rename", allowed: true, text: "Public draft"))
        let close = try XCTUnwrap(lease.emit(action: "close", row: nil, state: state))
        XCTAssertTrue(lease.isCloseSettlement(sequence: close))
        XCTAssertFalse(lease.settle(identity: state.identity, privacy: 0, sequence: close, success: true))
        XCTAssertFalse(lease.settle(identity: state.identity, privacy: 1, sequence: close, success: false))
        XCTAssertTrue(lease.settle(identity: state.identity, privacy: 0, sequence: close, success: false))
        XCTAssertFalse(lease.settle(identity: state.identity, privacy: 0, sequence: close, success: false))
        XCTAssertFalse(lease.confirm(identity: state.identity, update: 1, privacy: 0, sequence: close, interaction: 1,
            action: "close", row: nil, allowed: true))
        _ = lease.retire(state.identity)
        XCTAssertFalse(lease.acceptsSettlement(identity: state.identity, privacy: 0, sequence: sequence))
    }

    @MainActor
    func testPrivateDrawerRefreshCannotInferOperationCompletionOrClearANewerDraft() {
        let state = privateDrawerState(family: "history")
        let model = NativeDrawerModel(state)
        model.detailRow = "row-handle"; model.detailMode = "rename"; model.renameDraft = "Public title"
        model.pendingSequence = 1; model.choicePending = true
        model.update(privateDrawerState(family: "history", update: 2, appearance: "dark"))
        XCTAssertTrue(model.choicePending)
        XCTAssertEqual(model.renameDraft, "Public title")
        model.settle(sequence: 2, success: true)
        XCTAssertTrue(model.choicePending, "An obsolete settlement cannot close another editor")
        model.settle(sequence: 1, success: false)
        XCTAssertFalse(model.choicePending)
        XCTAssertEqual(model.renameDraft, "Public title", "Confirmed failure preserves a retryable draft")
        model.pendingSequence = 3; model.choicePending = true
        model.settle(sequence: 1, success: true)
        XCTAssertTrue(model.choicePending)
        model.settle(sequence: 3, success: true)
        XCTAssertNil(model.detailRow, "An explicit success completes even a same-title rename")
    }

    func testProfileRowPresentationIsBoundedAndDoesNotAlterChoiceAuthority() throws {
        let state = privateDrawerState()
        let original = try JSONSerialization.jsonObject(with: JSONEncoder().encode(state)) as! [String: Any]
        func projected(_ fields: [String: Any]) throws -> NativeDrawerProjection {
            var options = original
            var sections = options["sections"] as! [[String: Any]]
            var rows = sections[0]["rows"] as! [[String: Any]]
            fields.forEach { rows[0][$0.key] = $0.value }
            sections[0]["rows"] = rows; options["sections"] = sections
            XCTAssertTrue(NativeDrawerProjection.hasClosedShape(options))
            return try JSONDecoder().decode(NativeDrawerProjection.self, from: JSONSerialization.data(withJSONObject: options))
        }
        let presentation = try projected(["iconHex": "#8B5CF6", "chevron": true, "trailing": "Local"])
        XCTAssertTrue(presentation.valid)
        XCTAssertTrue(presentation.allows(action: "row", row: "row-handle"))
        XCTAssertFalse(presentation.allows(action: "row", row: "not-authored"))
        XCTAssertFalse(try projected(["iconHex": "https://example.test"]).valid)
        XCTAssertFalse(try projected(["trailing": String(repeating: "x", count: 33)]).valid)
    }

    func testConfirmedReferralCopyIsOneShotAndCannotBorrowAnotherRowOrPrivacyGeneration() throws {
        let row = NativeDrawerRow(id: "referral-copy", label: "Copy", detail: nil, symbol: nil, enabled: true,
            destructive: nil, selected: nil, pending: nil)
        let state = privateDrawerState(sampleRow: row)
        var lease = NativeDrawerLease()
        XCTAssertTrue(lease.apply(state))
        let sequence = try XCTUnwrap(lease.emit(action: "row", row: row.id, state: state))
        XCTAssertFalse(lease.consumeConfirmedRowEffect(identity: state.identity, update: 1, privacy: 0, sequence: sequence, interaction: 1, row: row.id))
        XCTAssertTrue(lease.confirm(identity: state.identity, update: 1, privacy: 0, sequence: sequence, interaction: 1, action: "row", row: row.id, allowed: true))
        XCTAssertFalse(lease.consumeConfirmedRowEffect(identity: state.identity, update: 1, privacy: 1, sequence: sequence, interaction: 1, row: row.id))
        XCTAssertFalse(lease.consumeConfirmedRowEffect(identity: state.identity, update: 1, privacy: 0, sequence: sequence, interaction: 1, row: "another-row"))
        XCTAssertTrue(lease.consumeConfirmedRowEffect(identity: state.identity, update: 1, privacy: 0, sequence: sequence, interaction: 1, row: row.id))
        XCTAssertFalse(lease.consumeConfirmedRowEffect(identity: state.identity, update: 1, privacy: 0, sequence: sequence, interaction: 1, row: row.id))
        XCTAssertTrue(lease.settle(identity: state.identity, privacy: 0, sequence: sequence, success: true))
    }

    @MainActor
    func testPrivateNativeDrawerRejectsStaleOwnersAndConsumesOnlyEmittedChoices() {
        var lease = NativeDrawerLease()
        let state = privateDrawerState()
        var options = try! JSONSerialization.jsonObject(with: JSONEncoder().encode(state)) as! [String: Any]
        XCTAssertTrue(NativeDrawerProjection.hasClosedShape(options))
        options["undeclaredPayload"] = "synthetic"
        XCTAssertFalse(NativeDrawerProjection.hasClosedShape(options), "Private projections must reject arbitrary bridge fields")
        options.removeValue(forKey: "undeclaredPayload")
        var sections = options["sections"] as! [[String: Any]]
        var rows = sections[0]["rows"] as! [[String: Any]]
        rows[0]["undeclaredPayload"] = "synthetic"
        sections[0]["rows"] = rows; options["sections"] = sections
        XCTAssertFalse(NativeDrawerProjection.hasClosedShape(options))
        XCTAssertTrue(lease.apply(state))
        XCTAssertNil(lease.emit(action: "row", row: "not-authored", state: state))
        let sequence = lease.emit(action: "row", row: "row-handle", state: state)!
        XCTAssertFalse(lease.confirm(identity: state.identity, update: 1, privacy: 0, sequence: sequence, interaction: 1,
            action: "row", row: "not-authored", allowed: true))
        XCTAssertTrue(lease.confirm(identity: state.identity, update: 1, privacy: 0, sequence: sequence, interaction: 1,
            action: "row", row: "row-handle", allowed: true))
        XCTAssertFalse(lease.confirm(identity: state.identity, update: 1, privacy: 0, sequence: sequence, interaction: 1,
            action: "row", row: "row-handle", allowed: true))
        let pending = lease.emit(action: "row", row: "row-handle", state: state)!
        let replacement = privateDrawerState(owner: "replacement", revision: 2)
        XCTAssertTrue(lease.apply(replacement))
        XCTAssertFalse(lease.retire(state.identity), "An old retirement cannot remove a replacement")
        XCTAssertFalse(lease.confirm(identity: state.identity, update: 1, privacy: 0, sequence: pending, interaction: 1,
            action: "row", row: "row-handle", allowed: true))
        XCTAssertFalse(lease.apply(state))
        XCTAssertTrue(lease.retire(replacement.identity))
        XCTAssertFalse(lease.apply(privateDrawerState(owner: "replacement", revision: 2, update: 2)),
            "Privacy retirement requires a newly bound presentation, not an old lease")
        var session = NativeDrawerSessionFence()
        XCTAssertTrue(session.admit(state.identity))
        XCTAssertTrue(session.admit(replacement.identity))
        XCTAssertFalse(session.contains(privateDrawerState(family: "history").identity))
        XCTAssertFalse(session.admit(privateDrawerState(family: "history", update: 9).identity),
            "Late projections cannot revive the other departing-owner family")
        var moving = NativeDrawerLease()
        XCTAssertTrue(moving.apply(state))
        let emitted = try! XCTUnwrap(moving.emit(action: "row", row: "row-handle", state: state))
        var crossedPrivacy = moving
        moving.invalidateInteractions()
        XCTAssertFalse(moving.confirm(identity: state.identity, update: 1, privacy: 0, sequence: emitted,
            interaction: 1, action: "row", row: "row-handle", allowed: true),
            "A closing drag invalidates a pending row action even before React updates")
        XCTAssertFalse(moving.settle(identity: state.identity, privacy: 0, sequence: emitted, success: true),
            "Cancelling presentation never confirms or authorizes the operation")
        XCTAssertFalse(moving.settle(identity: state.identity, privacy: 1, sequence: emitted, success: false))
        let wrongOwner = NativeDrawerIdentity(documentId: state.documentId, ownerEpoch: "another-owner",
            ownerGeneration: state.ownerGeneration, revision: state.revision, family: state.family)
        XCTAssertFalse(moving.settle(identity: wrongOwner, privacy: 0, sequence: emitted, success: false))
        var nextPrivacy = moving
        let newPrivacy = privateDrawerState(update: 2, privacy: 1)
        XCTAssertTrue(nextPrivacy.apply(newPrivacy))
        XCTAssertFalse(nextPrivacy.settle(identity: state.identity, privacy: 1, sequence: emitted, success: false),
            "A cancellation from an older privacy generation is not current bookkeeping")
        XCTAssertTrue(crossedPrivacy.apply(newPrivacy))
        crossedPrivacy.invalidateInteractions()
        XCTAssertFalse(crossedPrivacy.settle(identity: state.identity, privacy: 1, sequence: emitted, success: false),
            "Invalidation cannot relabel an old emitted choice with a new privacy generation")
        XCTAssertTrue(moving.settle(identity: state.identity, privacy: 0, sequence: emitted, success: false),
            "An exact cancelled intent must acknowledge absence without quarantining the whole pane")
        XCTAssertFalse(moving.settle(identity: state.identity, privacy: 0, sequence: emitted, success: false),
            "Cancellation acknowledgement is consumed once")
        let nextSequence = try! XCTUnwrap(moving.emit(action: "row", row: "row-handle", state: state))
        let currentModel = NativeDrawerModel(state)
        currentModel.pendingSequence = nextSequence
        currentModel.choicePending = true
        currentModel.settle(sequence: emitted, success: false)
        XCTAssertEqual(currentModel.pendingSequence, nextSequence)
        XCTAssertTrue(currentModel.choicePending, "An old cancellation cannot clear a newer choice")
        var cancelledPreparation = NativeDrawerLease()
        XCTAssertTrue(cancelledPreparation.retire(state.identity))
        XCTAssertFalse(cancelledPreparation.apply(state), "A lost apply cannot resurrect a cancelled private body")
        XCTAssertTrue(cancelledPreparation.retire(state.identity), "Exact absence proof is idempotent")

        func navigation(_ update: Int, boundary: String? = nil) -> NativeDrawerProjection {
            var next = privateDrawerState(open: boundary != "close", update: update,
                appearance: update == 1 ? "light" : "dark", privacy: boundary == "privacy" ? 1 : 0,
                enabled: boundary != "disabled", backEnabled: true)
            next.surfaceOpen = true
            next.profileDestinationId = boundary == "visit" ? "memory-reopened" : "memory-first"
            next.navigationLocked = boundary == "lock"
            next.profileStack = [NativeProfilePage(id: "memory", title: "Memory", sections: []),
                                 NativeProfilePage(id: "memory-live", title: "Live memory", sections: [])]
            return next
        }
        let initial = navigation(1)
        var pop = NativeDrawerLease()
        XCTAssertTrue(pop.apply(initial))
        let back = pop.emit(action: "back", row: nil, state: initial)!
        XCTAssertTrue(pop.apply(navigation(2)))
        XCTAssertTrue(pop.confirm(identity: initial.identity, update: 1, privacy: 0, sequence: back,
            interaction: 1, action: "back", row: nil, allowed: true), "A compatible content refresh must not reverse UIKit's completed Back")
        var returned = navigation(3)
        returned.profileStack?.removeLast(); returned.profileDestinationId = "memory-returned"
        XCTAssertTrue(pop.apply(returned))
        XCTAssertTrue(pop.settle(identity: initial.identity, privacy: 0, sequence: back, success: true),
            "The committed destination change must not invalidate its confirmed settlement")
        XCTAssertFalse(pop.settle(identity: initial.identity, privacy: 0, sequence: back, success: true))
        XCTAssertFalse(pop.confirm(identity: initial.identity, update: 1, privacy: 0, sequence: back,
            interaction: 1, action: "back", row: nil, allowed: true))
        for boundary in ["visit", "lock", "close", "disabled", "privacy"] {
            var stale = NativeDrawerLease()
            XCTAssertTrue(stale.apply(initial))
            let emitted = stale.emit(action: "back", row: nil, state: initial)!
            XCTAssertTrue(stale.apply(navigation(2, boundary: boundary)))
            XCTAssertTrue(stale.apply(navigation(3)))
            XCTAssertFalse(stale.confirm(identity: initial.identity, update: 1, privacy: 0, sequence: emitted,
                interaction: 1, action: "back", row: nil, allowed: true), "Returning from \(boundary) cannot revive the old Back")
        }
    }

    @MainActor
    func testHistoryMenuRetirementWaitsForDisappearanceAndRejectsItsOldChoice() throws {
        let controller = NativeDrawerPresentationController(privateDrawerState(family: "history"))
        controller.loadViewIfNeeded()
        let menu = NativeDrawerMenuControl(type: .system)
        controller.model.registerMenu(menu)
        let interaction = UIContextMenuInteraction(delegate: menu)
        let configuration = UIContextMenuConfiguration(identifier: nil, previewProvider: nil, actionProvider: nil)
        menu.contextMenuInteraction(interaction, willDisplayMenuFor: configuration, animator: nil)
        var acted = false
        menu.afterDismissal { acted = true }
        var retired = false
        controller.retire { retired = true }
        XCTAssertFalse(retired, "A removed menu trigger cannot acknowledge native popup absence")
        XCTAssertTrue(controller.coversUnderlyingPresentation,
            "Leaving the active registry cannot release touch isolation before popup disappearance")
        XCTAssertFalse(controller.children.isEmpty)
        let animator = OwnedMenuTestAnimator()
        menu.contextMenuInteraction(interaction, willEndFor: configuration, animator: animator)
        XCTAssertFalse(retired, "willEnd is not completed disappearance")
        animator.finish()
        XCTAssertTrue(retired)
        XCTAssertFalse(controller.coversUnderlyingPresentation)
        XCTAssertTrue(controller.children.isEmpty)
        XCTAssertFalse(acted, "Retirement cancels a pending action before its popup completes")
        let editable = NativeDrawerRow(id: "row-handle", label: "Public title", detail: nil, symbol: nil,
            enabled: true, destructive: nil, selected: nil, pending: nil, renameActionId: "rename", deleteActionId: "delete")
        let model = NativeDrawerModel(privateDrawerState(family: "history", sampleRow: editable))
        model.interactionEnabled = true
        let oldState = model.projection
        model.update(privateDrawerState(family: "history", update: 2, sampleRow: editable))
        model.showDetails(oldState.sections[0].rows[0], mode: "rename", from: oldState)
        XCTAssertNil(model.detailRow, "An old menu cannot open a replacement owner's editor")
        var confirmations = 0
        model.requestDelete = { _, _ in confirmations += 1 }
        model.showDetails(editable, mode: "delete", from: oldState)
        XCTAssertEqual(confirmations, 0, "An old menu cannot present a destructive confirmation")
        model.showDetails(editable, mode: "delete", from: model.projection)
        XCTAssertEqual(confirmations, 1)
        XCTAssertNil(model.detailRow, "Delete confirmation retains History rather than replacing it")
        XCTAssertFalse(model.choicePending, "Opening confirmation is not permission to delete")

        // List filtering/removal uses the real representable teardown, not
        // whole-drawer retirement. A vanished trigger still owns its popup.
        var removed: NativeDrawerMenuControl? = NativeDrawerMenuControl(type: .system)
        weak var retained = removed
        let rowInteraction = UIContextMenuInteraction(delegate: removed!)
        model.registerMenu(removed!)
        removed!.contextMenuInteraction(rowInteraction, willDisplayMenuFor: configuration, animator: nil)
        var rowActed = false
        removed!.afterDismissal { rowActed = true }
        NativeDrawerRowMenu.dismantleUIView(removed!, coordinator: model)
        removed = nil
        let retiring = try XCTUnwrap(retained, "Row teardown must retain its still-visible owned menu")
        XCTAssertFalse(retiring.isEnabled)
        XCTAssertNil(retiring.menu)
        var disappeared = false
        model.dismissMenus { disappeared = true }
        XCTAssertFalse(disappeared)
        let rowAnimator = OwnedMenuTestAnimator()
        retiring.contextMenuInteraction(rowInteraction, willEndFor: configuration, animator: rowAnimator)
        XCTAssertFalse(disappeared)
        rowAnimator.finish()
        XCTAssertTrue(disappeared)
        XCTAssertFalse(rowActed, "A removed row cannot deliver its queued menu action")
    }

    @MainActor
    func testProfileChoiceAcknowledgementKeepsRenderedMenuAppearanceWithoutReplayingTheAction() async throws {
        let model = NativeDrawerModel(privateDrawerState())
        model.interactionEnabled = true
        var choices = 0
        model.choose = { [weak model] _, _, _ in choices += 1; model?.pendingSequence = choices; return true }
        var rowFrame = CGRect.zero
        var enabled: Bool?
        let host = UIHostingController(rootView: NativeDrawerContent(model: model, profileRowObserver: { _, frame, available in
            rowFrame = frame; enabled = available
        }))
        host.overrideUserInterfaceStyle = .light
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true; window.rootViewController = nil
            previousKeyWindow?.makeKeyAndVisible()
        }
        host.view.layoutIfNeeded()
        await fulfillment(of: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            rowFrame.width > 0 && rowFrame.height >= 44 && enabled == true
        }, object: nil)], timeout: 3)
        func rowPixels() throws -> Data {
            // Actual attached shared menu, containing only public synthetic
            // labels. Crop its measured row rather than guessing offscreen bounds.
            host.view.layoutIfNeeded()
            var rendered = false
            let format = UIGraphicsImageRendererFormat(); format.scale = 1
            let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
                rendered = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            XCTAssertTrue(rendered)
            let row = try XCTUnwrap(image.cgImage?.cropping(to: rowFrame.integral))
            return try XCTUnwrap(row.dataProvider?.data) as Data
        }
        let baseline = try rowPixels()
        XCTAssertTrue(model.choice("row", row: "row-handle"))
        XCTAssertFalse(model.choice("row", row: "row-handle"), "The visual fix must preserve one-shot choice admission")
        XCTAssertEqual(choices, 1)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(enabled, true, "Pending acknowledgement must not disable the entire menu's visual environment")
        let pending = try rowPixels()
        XCTAssertTrue(baseline == pending, "Bridge acknowledgement cannot dim and restore the whole menu on every tap")
        model.settle(sequence: 1, success: true)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertTrue(baseline == (try rowPixels()), "Settlement must not repaint a different row appearance")
        XCTAssertTrue(model.choice("row", row: "row-handle"), "Settlement restores the next deliberate action")
        XCTAssertEqual(choices, 2)
        model.settle(sequence: 2, success: true)
        model.update(privateDrawerState(update: 2, enabled: false))
        await fulfillment(of: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in enabled == false }, object: nil)], timeout: 3)
        XCTAssertEqual(enabled, false, "Negative control: authored unavailable state still reaches the rendered row")
    }

    @MainActor
    func testDrawerMotionQuarantinesInteractionWithoutDisabledAppearance() {
        let model = NativeDrawerModel(privateDrawerState())
        let choose = expectation(description: "Only admitted row choice")
        model.choose = { _, _, _ in choose.fulfill(); return true }
        let row = model.projection.sections[0].rows[0]
        XCTAssertTrue(model.controlsEnabled)
        XCTAssertFalse(model.interactionEnabled)
        XCTAssertFalse(model.choice("row", row: row.id))
        model.interactionEnabled = true
        XCTAssertTrue(model.controlsEnabled)
        XCTAssertTrue(model.choice("row", row: row.id))
        model.interactionEnabled = false
        XCTAssertTrue(model.controlsEnabled, "A temporary motion quarantine must not dim material")
        model.update(privateDrawerState(update: 2, enabled: false))
        XCTAssertFalse(model.controlsEnabled, "Authored disabled state retains its visual semantics")
        wait(for: [choose], timeout: 1)
    }

    @MainActor
    func testWholeNativeDrawerKeepsBasePaintThroughCoverageAndClearsPrivateReplicaOnRetirement() throws {
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let container = NativePresentationContainer(webView: web, basePresentation: .coherentDrawers)
        container.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        XCTAssertTrue(container.containsStationaryControl(CGRect(x: 16, y: 60, width: 44, height: 44), document: "synthetic"),
            "Coherent admission must not depend on the rejected legacy-region protocol")
        XCTAssertFalse(container.containsStationaryControl(CGRect(x: 380, y: 60, width: 44, height: 44), document: "synthetic"))
        let glass = UIButton(frame: CGRect(x: 10, y: 10, width: 44, height: 44))
        container.install(glass, id: "base-control", group: nil)
        container.setAdmission("base-control", admitted: true)
        let base = try XCTUnwrap(glass.superview)
        let parent = UIViewController()
        parent.view = container
        let controller = NativeDrawerPresentationController(privateDrawerState())
        parent.addChild(controller)
        container.addSubview(controller.view)
        controller.view.frame = container.bounds
        controller.didMove(toParent: parent)
        controller.isolation = { container.isolateForOwnedDrawer($0) }
        controller.activateInitialPresentation()
        let host = try XCTUnwrap(controller.host)
        controller.update(privateDrawerState(update: 2, appearance: "dark"))
        XCTAssertTrue(controller.host === host, "Appearance/content updates retain the native host")
        XCTAssertEqual(controller.overrideUserInterfaceStyle, .dark)
        controller.settle(open: false, userIntent: false)
        XCTAssertFalse(web.isUserInteractionEnabled, "Closing target is not visible settlement")
        XCTAssertTrue(web.accessibilityElementsHidden)
        XCTAssertFalse(base.isHidden, "Drawer coverage must not hide the exposed material")
        XCTAssertFalse(glass.isHidden)
        XCTAssertTrue(glass.superview === base)
        XCTAssertFalse(glass.isUserInteractionEnabled)
        XCTAssertFalse(container.setRegions(document: "public-document", revision: 1,
            viewport: container.bounds.size, top: 100, bottom: 100, isolated: true, covered: true),
            "The new owner must not accept the historical asynchronous clipping protocol")
        controller.beginDrag()
        XCTAssertTrue(controller.host === host)
        controller.retire()
        XCTAssertTrue(controller.children.isEmpty)
        XCTAssertNil(host.view.superview)
        XCTAssertNil(controller.view.superview)
        XCTAssertTrue(controller.model.projection.sections.isEmpty)
        XCTAssertTrue(controller.model.projection.title.isEmpty)
        XCTAssertNil(controller.model.choose)
        XCTAssertTrue(web.superview === container)
        XCTAssertFalse(base.isHidden)
        XCTAssertFalse(glass.isUserInteractionEnabled, "Fresh bindings restore permissions, not a captured boolean")
    }

    func testCoherentStationaryViewportAcceptsOnlyTheActualKeyboardResizedWebView() {
        let host = CGSize(width: 390, height: 844)
        let web = CGSize(width: 390, height: 480)
        XCTAssertEqual(NativeChromeViewport.resolve(authored: host, host: host, web: web, coherent: true, keyboard: false), host)
        XCTAssertEqual(NativeChromeViewport.resolve(authored: web, host: host, web: web, coherent: true, keyboard: true), host)
        XCTAssertNil(NativeChromeViewport.resolve(authored: web, host: host, web: web, coherent: false, keyboard: true))
        XCTAssertNil(NativeChromeViewport.resolve(authored: web, host: host, web: web, coherent: true, keyboard: false))
        XCTAssertNil(NativeChromeViewport.resolve(authored: CGSize(width: 390, height: 500), host: host, web: web, coherent: true, keyboard: true))
        XCTAssertNil(NativeChromeViewport.resolve(authored: web, host: CGSize(width: 844, height: 390), web: web, coherent: true, keyboard: true))
    }

    @MainActor
    func testOwnedProfileContentPlaneRetainsBaseButRejectsCoveredAndStaleActions() throws {
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let container = NativePresentationContainer(webView: web, basePresentation: .coherentDrawers)
        container.frame = web.frame
        let base = UIButton(frame: CGRect(x: 16, y: 60, width: 44, height: 44))
        container.install(base, id: "base", group: nil)
        container.setAdmission("base", admitted: true)
        let retainedHost = try XCTUnwrap(base.superview)
        let identity = NativeContentPaneIdentity(document: "synthetic", ownerEpoch: "owner", generation: 1,
            privacyGeneration: HushhSessionPrivacyShield.shared.snapshot().generation)
        XCTAssertFalse(container.acquireContentPane(identity, viewport: CGSize(width: 400, height: 844)))
        XCTAssertTrue(container.acquireContentPane(identity, viewport: container.bounds.size))
        XCTAssertTrue(base.superview === retainedHost)
        XCTAssertFalse(base.isHidden)
        XCTAssertLessThan(retainedHost.layer.zPosition, web.layer.zPosition)
        container.setAdmission("base", admitted: true)
        XCTAssertFalse(base.isUserInteractionEnabled, "A fresh base update must not bypass the owned content plane")
        XCTAssertTrue(web.isUserInteractionEnabled)
        let back = UIButton(frame: base.frame)
        container.install(back, id: "profile-back", group: nil, pane: identity)
        container.setAdmission("profile-back", admitted: true)
        XCTAssertTrue(back.isUserInteractionEnabled)
        XCTAssertTrue(container.hitTest(CGPoint(x: 30, y: 75), with: nil) === back)
        XCTAssertTrue(container.acquireContentPane(identity, viewport: container.bounds.size))
        XCTAssertTrue(back.isUserInteractionEnabled, "An idempotent acquisition must not strand an already admitted header")
        XCTAssertFalse(container.releaseContentPane(identity), "Header removal must be confirmed before uncovering base chrome")
        container.remove("profile-back")
        XCTAssertTrue(container.releaseContentPane(identity))
        XCTAssertFalse(base.isUserInteractionEnabled, "Release never restores stale permissions")
        XCTAssertFalse(container.acquireContentPane(identity, viewport: container.bounds.size), "A delayed acquisition cannot follow retirement")
        let next = NativeContentPaneIdentity(document: "synthetic", ownerEpoch: "new-owner", generation: 2,
            privacyGeneration: identity.privacyGeneration)
        XCTAssertTrue(container.acquireContentPane(next, viewport: container.bounds.size))
        XCTAssertFalse(container.releaseContentPane(identity), "An old completion cannot release a reopened pane")
        XCTAssertEqual(container.contentPane, next)
        XCTAssertTrue(container.acquireContentPane(next, viewport: container.bounds.size), "Compatible viewport admission retains ownership")
        XCTAssertTrue(container.beginContentPaneRetirement(next))
        XCTAssertFalse(container.acquireContentPane(next, viewport: container.bounds.size), "Retirement fences late preparation before dismissal completion")
        XCTAssertFalse(container.contentPaneAdmits(next))
        container.conceal()
        container.setAdmission("base", admitted: true)
        XCTAssertFalse(base.isUserInteractionEnabled)
        XCTAssertTrue(container.releaseContentPane(next))
    }

    @MainActor
    func testPendingNativeCloseSurvivesContentRefreshAndUncoversTheSameWebViewOnlyAfterAcknowledgement() async throws {
        let state = privateDrawerState(family: "history")
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        // The app's shared shield belongs to its live document, not this
        // synthetic controller. Exercise Close against an explicitly active gate.
        let shield = HushhSessionPrivacyShield()
        shield.markAppActive()
        XCTAssertTrue(shield.snapshot().appIsActive)
        XCTAssertFalse(shield.snapshot().shielded)
        let container = NativePresentationContainer(webView: web, basePresentation: .coherentDrawers, privacyShield: shield)
        let parent = UIViewController()
        parent.view = container
        let window = UIWindow(frame: web.frame)
        window.rootViewController = parent
        window.isHidden = false
        let opener = UIButton(frame: CGRect(x: 16, y: 72, width: 44, height: 44))
        container.install(opener, id: "chat-history-toggle", group: nil)
        let controller = NativeDrawerPresentationController(state)
        controller.leadingHeaderFrame = { container.installedFrame("chat-history-toggle") }
        parent.addChild(controller)
        container.addSubview(controller.view)
        controller.view.frame = container.bounds
        controller.didMove(toParent: parent)
        defer { controller.retire(); window.isHidden = true; window.rootViewController = nil }
        var lease = NativeDrawerLease()
        XCTAssertTrue(lease.apply(state))
        controller.invalidateInteractions = { lease.invalidateInteractions() }
        controller.isolation = { container.isolateForOwnedDrawer($0) }
        controller.activateInitialPresentation()
        XCTAssertEqual(controller.model.headerInsets.leading, 16)
        XCTAssertEqual(controller.model.headerInsets.top + controller.view.safeAreaInsets.top, 72,
            accuracy: 1, "Close uses its authored opener seat, not UIKit's different default inset")
        let admitted = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in controller.model.interactionEnabled }, object: nil)
        await fulfillment(of: [admitted], timeout: 3)
        let host = try XCTUnwrap(controller.host)
        var emitted = expectation(description: "Close emitted")
        var token: Int?, interaction = 0
        controller.model.choose = { action, row, text in
            token = lease.emit(action: action, row: row, state: controller.model.projection, text: text)
            interaction = lease.interactionGeneration
            if let token, action == "close" { controller.recordCloseIntent(sequence: token) }
            if token != nil { emitted.fulfill() }
            return token != nil
        }
        controller.settle(open: false, userIntent: true)
        await fulfillment(of: [emitted], timeout: 3)
        var sequence = try XCTUnwrap(token)
        let refresh = privateDrawerState(family: "history", update: 2, appearance: "dark")
        XCTAssertTrue(lease.apply(refresh))
        controller.update(refresh)
        XCTAssertTrue(controller.host === host)
        XCTAssertEqual(controller.motion.progress, 0, "A content refresh must not reopen a locally closed drawer")
        XCTAssertFalse(web.isUserInteractionEnabled, "Unacknowledged Close does not release modal isolation")
        XCTAssertTrue(web.accessibilityElementsHidden)
        XCTAssertTrue(lease.confirm(identity: state.identity, update: 1, privacy: 0, sequence: sequence,
            interaction: interaction, action: "close", row: nil, allowed: controller.allowsInteraction("close", row: nil)))
        XCTAssertTrue(lease.settle(identity: state.identity, privacy: 0, sequence: sequence, success: false))
        controller.settleClose(sequence: sequence, success: false)
        let restored = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            controller.model.interactionEnabled && controller.motion.committedOpen
        }, object: nil)
        await fulfillment(of: [restored], timeout: 3)
        XCTAssertTrue(controller.host === host)
        XCTAssertFalse(web.isUserInteractionEnabled, "Known rejection restores the authored drawer without uncovering Chat")
        XCTAssertFalse(lease.settle(identity: state.identity, privacy: 0, sequence: sequence, success: false))
        controller.settleClose(sequence: sequence, success: false)
        XCTAssertTrue(controller.model.interactionEnabled, "A duplicate cannot interrupt a restored visit")
        emitted = expectation(description: "New deliberate Close emitted")
        controller.settle(open: false, userIntent: true)
        await fulfillment(of: [emitted], timeout: 3)
        sequence = try XCTUnwrap(token)
        XCTAssertTrue(lease.confirm(identity: state.identity, update: 2, privacy: 0, sequence: sequence,
            interaction: interaction, action: "close", row: nil, allowed: controller.allowsInteraction("close", row: nil)))
        XCTAssertTrue(lease.settle(identity: state.identity, privacy: 0, sequence: sequence, success: true))
        controller.settleClose(sequence: sequence, success: true)
        XCTAssertFalse(web.isUserInteractionEnabled, "Acceptance alone does not manufacture a closed projection")
        let closed = privateDrawerState(family: "history", open: false, update: 3, appearance: "dark")
        XCTAssertTrue(lease.apply(closed))
        controller.update(closed)
        XCTAssertTrue(web.isUserInteractionEnabled)
        XCTAssertFalse(web.accessibilityElementsHidden)
        XCTAssertTrue(web.superview === container)
        XCTAssertFalse(lease.confirm(identity: state.identity, update: 1, privacy: 0, sequence: sequence,
            interaction: interaction, action: "close", row: nil, allowed: true), "Close is never replayed")

        // Compatible refresh never bypasses interaction, privacy, authority,
        // withdrawal or a subsequent close/reopen boundary.
        for invalidation in 0..<5 {
            var stale = NativeDrawerLease()
            XCTAssertTrue(stale.apply(state))
            let old = try XCTUnwrap(stale.emit(action: "close", row: nil, state: state))
            switch invalidation {
            case 0: stale.invalidateInteractions()
            case 1: XCTAssertTrue(stale.apply(privateDrawerState(family: "history", update: 2, privacy: 1)))
            case 2: XCTAssertTrue(stale.apply(privateDrawerState(family: "history", owner: "replacement", revision: 2)))
            case 3: XCTAssertTrue(stale.apply(privateDrawerState(family: "history", update: 2, enabled: false)))
            default:
                XCTAssertTrue(stale.apply(privateDrawerState(family: "history", open: false, update: 2)))
                XCTAssertTrue(stale.apply(privateDrawerState(family: "history", update: 3)))
            }
            XCTAssertFalse(stale.confirm(identity: state.identity, update: 1, privacy: 0, sequence: old,
                interaction: 1, action: "close", row: nil, allowed: true))
        }
    }

    @MainActor
    func testPreparingClosedNativeDrawerDoesNotFlashOrBlockTheExistingPage() {
        let controller = NativeDrawerPresentationController(privateDrawerState(open: false))
        controller.view.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        var isolated = false
        controller.isolation = { isolated = $0 }
        controller.activateInitialPresentation()
        XCTAssertFalse(isolated)
        XCTAssertNil(controller.view.hitTest(CGPoint(x: 100, y: 100), with: nil))
        XCTAssertGreaterThanOrEqual(controller.host.view.frame.minX, controller.view.bounds.maxX,
            "A closed inset Profile must travel past its outer gutter, not leave a visible sliver")
        controller.retire()
    }

    @MainActor
    func testNativeProfileAccountStackRetainsItsHostAndRejectsStalePopBindings() async throws {
        var root = privateDrawerState(backEnabled: true)
        root.surfaceOpen = true; root.profileStack = []
        var account = privateDrawerState(update: 2, backEnabled: true)
        account.surfaceOpen = true; account.profileDestinationId = "account-first"
        account.profileStack = [NativeProfilePage(id: "account", title: "Your account", sections: [
            NativeDrawerSection(id: "identity-details", title: "Identity", rows: [
                NativeDrawerRow(id: "edit-name", label: "Display name", detail: "Public sample", symbol: "person",
                    enabled: true, destructive: nil, selected: nil, pending: nil),
                NativeDrawerRow(id: "read-only-mail", label: "Mail", detail: "Public sample", symbol: nil,
                    enabled: true, destructive: nil, selected: nil, pending: nil, readOnly: true),
            ]),
        ])]
        XCTAssertTrue(account.valid)
        var payout = account
        payout.profileStack = ["payouts", "payout-activity", "payout-receipt-1", "payout-receipt-2"].map {
            NativeProfilePage(id: $0, title: "Synthetic payout navigation", sections: [])
        }
        XCTAssertTrue(payout.valid)
        XCTAssertTrue(payout.allows(action: "ancestor", row: "payouts"))
        XCTAssertFalse(payout.allows(action: "ancestor", row: "account"))
        let payoutNavigation = NativeDrawerModel(payout)
        payoutNavigation.interactionEnabled = true
        var payoutAncestor: String?
        payoutNavigation.choose = { action, row, _ in payoutAncestor = row; return action == "ancestor" }
        payoutNavigation.requestPath(["payouts"], from: payout)
        XCTAssertEqual(payoutAncestor, "payouts")
        XCTAssertEqual(payoutNavigation.navigationPath, ["payouts"])
        payout.profileStack![1] = NativeProfilePage(id: "account-delete", title: "Wrong parent", sections: [])
        XCTAssertFalse(payout.valid, "Financial pages cannot admit unrelated account operations")
        XCTAssertFalse(NativeDrawerProjection.validPayoutPath(["payouts", "payout-receipt-2"]))
        var memory = account
        memory.profileStack = ["memory", "memory-domain", "memory-section", "memory-entity", "memory-confirm"].map {
            NativeProfilePage(id: $0, title: "Synthetic Memory navigation", sections: [])
        }
        XCTAssertTrue(memory.valid)
        XCTAssertTrue(memory.allows(action: "ancestor", row: "memory-section"))
        XCTAssertFalse(memory.allows(action: "ancestor", row: "account"))
        XCTAssertFalse(NativeDrawerProjection.validMemoryPath(["memory", "memory-confirm"]))
        XCTAssertFalse(NativeDrawerProjection.validMemoryPath(["memory", "account-delete"]))
        XCTAssertTrue(NativeDrawerProjection.validMemoryPath(["memory", "memory-shared", "memory-shared-person"]))
        XCTAssertTrue(NativeDrawerProjection.validMemoryPath(["memory", "memory-received", "memory-received-files"]))
        XCTAssertFalse(NativeDrawerProjection.validMemoryPath(["memory", "memory-shared", "memory-confirm"]))
        XCTAssertTrue(NativeDrawerProjection.validMemoryPath(["memory", "memory-secrets", "memory-secret", "memory-secret-remove"]))
        XCTAssertTrue(NativeDrawerProjection.validMemoryPath(["memory", "memory-secrets", "memory-identity"]))
        XCTAssertFalse(NativeDrawerProjection.validMemoryPath(["memory", "memory-secret-remove"]))
        var worldModel = account
        worldModel.profileStack = ["world-model", "world-model-sources", "world-model-review", "world-model-review-fact"].map {
            NativeProfilePage(id: $0, title: "Synthetic World Model navigation", sections: [])
        }
        XCTAssertTrue(worldModel.valid)
        XCTAssertTrue(worldModel.allows(action: "ancestor", row: "world-model-sources"))
        let worldModelNavigation = NativeDrawerModel(worldModel)
        worldModelNavigation.interactionEnabled = true
        var worldModelAncestor: String?
        worldModelNavigation.choose = { action, row, _ in worldModelAncestor = row; return action == "ancestor" }
        worldModelNavigation.requestPath(["world-model"], from: worldModel)
        XCTAssertEqual(worldModelAncestor, "world-model")
        XCTAssertEqual(worldModelNavigation.navigationPath, ["world-model"])
        XCTAssertFalse(NativeDrawerProjection.validWorldModelPath(["world-model", "world-model-remove"]))
        XCTAssertFalse(NativeDrawerProjection.validWorldModelPath(["world-model", "account-delete"]))
        worldModel.navigationLocked = true
        worldModel.profileStack![3] = NativeProfilePage(id: "world-model-review-fact", title: "Recovery", sections: [NativeDrawerSection(id: "recovery", title: nil, rows: [
            NativeDrawerRow(id: "retry-save", label: "Retry save", detail: nil, symbol: nil, enabled: true, destructive: nil, selected: nil, pending: nil)
        ])])
        XCTAssertTrue(worldModel.valid)
        XCTAssertFalse(worldModel.allows(action: "close", row: nil))
        XCTAssertFalse(worldModel.allows(action: "back", row: nil))
        XCTAssertFalse(worldModel.allows(action: "ancestor", row: "world-model"))
        XCTAssertTrue(worldModel.allows(action: "row", row: "retry-save"), "Recovery remains interactive while navigation is fenced")
        var finance = account
        finance.profileStack = ["preferences", "finance-preferences", "finance-anchor"].map {
            NativeProfilePage(id: $0, title: "Synthetic Finance preference navigation", sections: [])
        }
        XCTAssertTrue(finance.valid)
        XCTAssertTrue(finance.allows(action: "ancestor", row: "preferences"))
        XCTAssertFalse(finance.allows(action: "ancestor", row: "account"))
        let financeNavigation = NativeDrawerModel(finance)
        financeNavigation.interactionEnabled = true
        var financeAncestor: String?
        financeNavigation.choose = { action, row, _ in financeAncestor = row; return action == "ancestor" }
        financeNavigation.requestPath(["preferences"], from: finance)
        XCTAssertEqual(financeAncestor, "preferences")
        XCTAssertEqual(financeNavigation.navigationPath, ["preferences"])
        XCTAssertFalse(NativeDrawerProjection.validFinancePath(["preferences", "finance-anchor"]))
        finance.profileStack![0] = NativeProfilePage(id: "security", title: "Wrong parent", sections: [])
        XCTAssertFalse(finance.valid)
        for kind in ["account-reset", "account-delete"] {
            var confirmation = account
            confirmation.profileStack = account.profileStack! + [NativeProfilePage(id: kind, title: "Confirm account action", sections: [])]
            XCTAssertTrue(confirmation.valid)
            confirmation.profileStack![0] = NativeProfilePage(id: "preferences", title: "Preferences", sections: [])
            XCTAssertFalse(confirmation.valid, "An account confirmation requires its actual Account parent")
        }
        XCTAssertTrue(account.allows(action: "row", row: "edit-name"))
        var deviceConfirmation = account
        deviceConfirmation.profileStack = ["security", "devices", "device-unlink"].map {
            NativeProfilePage(id: $0, title: "Synthetic device navigation", sections: [])
        }
        XCTAssertTrue(deviceConfirmation.valid)
        XCTAssertTrue(deviceConfirmation.allows(action: "ancestor", row: "security"))
        XCTAssertFalse(deviceConfirmation.allows(action: "ancestor", row: "account"))
        let deviceNavigation = NativeDrawerModel(deviceConfirmation)
        deviceNavigation.interactionEnabled = true
        var ancestorAction: String?
        deviceNavigation.choose = { action, row, _ in ancestorAction = action; return row == "security" }
        deviceNavigation.requestPath(["security"], from: deviceConfirmation)
        XCTAssertEqual(ancestorAction, "ancestor")
        XCTAssertEqual(deviceNavigation.navigationPath, ["security"])
        var directDeviceEntry = deviceConfirmation
        directDeviceEntry.profileStack = Array(deviceConfirmation.profileStack!.dropFirst())
        XCTAssertTrue(directDeviceEntry.valid, "Direct Devices entry must not invent Security ancestry")
        deviceConfirmation.profileStack![1] = NativeProfilePage(id: "session", title: "Session", sections: [])
        XCTAssertFalse(deviceConfirmation.valid, "Unlink confirmation requires its actual Devices parent")
        var vaultDetails = account
        vaultDetails.profileStack = ["security", "vault", "vault-method"].map {
            NativeProfilePage(id: $0, title: "Synthetic unlock navigation", sections: [])
        }
        XCTAssertTrue(vaultDetails.valid)
        XCTAssertTrue(vaultDetails.allows(action: "ancestor", row: "security"))
        vaultDetails.profileStack![2] = NativeProfilePage(id: "vault-remove", title: "Remove passkey", sections: [])
        XCTAssertTrue(vaultDetails.valid)
        vaultDetails.profileStack!.removeFirst()
        XCTAssertTrue(vaultDetails.valid, "Direct Vault entry retains its actual ancestry")
        XCTAssertFalse(vaultDetails.allows(action: "ancestor", row: "security"))
        vaultDetails.profileStack![0] = NativeProfilePage(id: "account", title: "Account", sections: [])
        XCTAssertFalse(vaultDetails.valid, "Method operations cannot be attached to an unrelated parent")
        var unrelatedThirdPage = account
        unrelatedThirdPage.profileStack! += [NativeProfilePage(id: "account-reset", title: "Reset", sections: []),
            NativeProfilePage(id: "account-delete", title: "Delete", sections: [])]
        XCTAssertFalse(unrelatedThirdPage.valid, "The bounded device depth must not broaden other feature paths")
        XCTAssertFalse(account.allows(action: "row", row: "row-handle"))
        XCTAssertFalse(account.allows(action: "row", row: "read-only-mail"))
        var closedRoot = privateDrawerState(open: false, backEnabled: true)
        closedRoot.profileStack = []; closedRoot.surfaceOpen = false
        let controller = NativeDrawerPresentationController(closedRoot)
        controller.view.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        var rowFrames = [String: CGRect]()
        controller.loadViewIfNeeded()
        controller.host.rootView = NativeDrawerContent(model: controller.model, profileRowObserver: { row, frame, _ in
            rowFrames[row] = frame
        })
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.backgroundColor = .systemGroupedBackground; window.isOpaque = true
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer {
            controller.retire()
            window.isHidden = true; window.rootViewController = nil
            previousKeyWindow?.makeKeyAndVisible()
        }
        controller.activateInitialPresentation()
        controller.update(root)
        let admitted = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in controller.model.interactionEnabled }, object: controller)
        await fulfillment(of: [admitted], timeout: 2)
        func requireClose(_ phase: String) async {
            // This is now an owned public UINavigationController, not
            // introspection of SwiftUI's undocumented controller hierarchy.
            await fulfillment(of: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                let close = controller.model.profileNavigationController?.visibleViewController?.navigationItem.rightBarButtonItem
                return close?.accessibilityIdentifier == "native-profile-drawer-close" && close?.isEnabled == true
            }, object: nil)], timeout: 3)
            let close = controller.model.profileNavigationController?.visibleViewController?.navigationItem.rightBarButtonItem
            XCTAssertEqual(close?.accessibilityIdentifier, "native-profile-drawer-close", "\(phase): UIKit must retain the authored Close item")
            XCTAssertEqual(close?.isEnabled, true, "\(phase): the current Close item remains enabled")
        }
        await requireClose("Profile root")
        func requireRow(_ id: String) async {
            await fulfillment(of: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                guard let frame = rowFrames[id] else { return false }
                return !controller.model.navigationTransitioning &&
                    controller.model.profileNavigationController?.hasCompletedProjectedDestination == true &&
                    controller.model.profileNavigationController?.viewControllers.count == controller.model.navigationPath.count + 1 &&
                    !frame.isEmpty && window.bounds.contains(frame)
            }, object: nil)], timeout: 3)
        }
        await requireRow("row-handle")
        let envelopeNavigation = try XCTUnwrap(controller.model.profileNavigationController)
        let rootController = try XCTUnwrap(envelopeNavigation.viewControllers.first)
        let rootNavigationItem = rootController.navigationItem
        XCTAssertEqual(rootNavigationItem.backButtonDisplayMode, .minimal,
            "Profile keeps a compact native Back indicator rather than a morphing title pill")
        var repeatedBackTitleWrites = 0, repeatedTitleWrites = 0, repeatedBarTintWrites = 0
        var repeatedTintWrites = 0, repeatedStyleWrites = 0
        let backTitleObservation = rootNavigationItem.observe(\.backButtonTitle, options: [.new]) { _, _ in repeatedBackTitleWrites += 1 }
        let titleObservation = rootController.observe(\.title, options: [.new]) { _, _ in repeatedTitleWrites += 1 }
        let barTintObservation = envelopeNavigation.navigationBar.observe(\.tintColor, options: [.new]) { _, _ in repeatedBarTintWrites += 1 }
        let tintObservation = controller.host.view.observe(\.tintColor, options: [.new]) { _, _ in repeatedTintWrites += 1 }
        let styleObservation = controller.host.observe(\.overrideUserInterfaceStyle, options: [.new]) { _, _ in repeatedStyleWrites += 1 }
        defer {
            backTitleObservation.invalidate(); titleObservation.invalidate(); barTintObservation.invalidate()
            tintObservation.invalidate(); styleObservation.invalidate()
        }
        func capturePublicHeader(_ phase: String) {
            guard ProcessInfo.processInfo.environment["HUSHH_PROFILE_SYNTHETIC_VISUALS"] == "1" else { return }
            // This owned window contains only the synthetic fixture. Its opaque
            // canvas prevents a material backdrop from sampling another window.
            let bar = envelopeNavigation.navigationBar
            let frame = bar.convert(bar.bounds, to: window).integral
            guard !frame.isEmpty, window.bounds.contains(frame) else { XCTFail("Public navigation header must be inside its owned window"); return }
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
            }
            guard let crop = image.cgImage?.cropping(to: frame.applying(CGAffineTransform(scaleX: image.scale, y: image.scale))) else {
                XCTFail("Public navigation header capture failed"); return
            }
            let attachment = XCTAttachment(image: UIImage(cgImage: crop))
            attachment.name = "synthetic-profile-\(phase)"; attachment.lifetime = .keepAlways; add(attachment)
        }
        let host = controller.host
        let requestBack = { controller.model.requestPath([], from: controller.model.projection) }
        controller.model.choose = { [weak controller] _, _, _ in controller?.model.pendingSequence = 10; return true }
        XCTAssertTrue(controller.model.choice("row", row: "row-handle"))
        controller.update(account)
        envelopeNavigation.reconcile()
        capturePublicHeader("first-push")
        var duringFirstPush = privateDrawerState(update: 3, backEnabled: true)
        duringFirstPush.surfaceOpen = true; duringFirstPush.profileStack = account.profileStack
        duringFirstPush.profileDestinationId = account.profileDestinationId
        try await Task.sleep(for: .milliseconds(34))
        controller.update(duringFirstPush); envelopeNavigation.reconcile()
        capturePublicHeader("first-push-refresh")
        if ProcessInfo.processInfo.environment["HUSHH_PROFILE_SYNTHETIC_VISUALS"] == "1" {
            for frame in 0..<6 {
                try await Task.sleep(for: .milliseconds(34))
                capturePublicHeader("push-frame-\(frame)")
            }
        }
        controller.model.settle(sequence: 10, success: true)
        await requireClose("Account")
        await requireRow("edit-name")
        try await Task.sleep(for: .milliseconds(34))
        capturePublicHeader("first-settled")
        print("PUBLIC_PROFILE_TRANSITION back_writes=\(repeatedBackTitleWrites) title_writes=\(repeatedTitleWrites) bar_tint_writes=\(repeatedBarTintWrites) ancestor_tint_writes=\(repeatedTintWrites) style_writes=\(repeatedStyleWrites)")
        let accountController = try XCTUnwrap(envelopeNavigation.visibleViewController)
        let accountChildren = accountController.children
        XCTAssertTrue(rootController.view.accessibilityElementsHidden,
            "A retained covered Profile page cannot remain an accessibility owner")
        XCTAssertFalse(rootController.view.isUserInteractionEnabled,
            "Only the visible Profile destination may receive body interaction")
        XCTAssertFalse(accountController.view.accessibilityElementsHidden)
        XCTAssertTrue(accountController.view.isUserInteractionEnabled)
        XCTAssertEqual(accountController.navigationItem.backButtonDisplayMode, .minimal,
            "Nested pages must keep the same Back geometry for their own children")
        repeatedBackTitleWrites = 0; repeatedTitleWrites = 0; repeatedBarTintWrites = 0
        repeatedTintWrites = 0; repeatedStyleWrites = 0
        var interactionWrites = 0, accessibilityWrites = 0
        let barInteraction = envelopeNavigation.navigationBar.observe(\.isUserInteractionEnabled, options: [.new]) { _, _ in interactionWrites += 1 }
        let pageInteraction = accountController.view.observe(\.isUserInteractionEnabled, options: [.new]) { _, _ in interactionWrites += 1 }
        let barAccessibility = envelopeNavigation.navigationBar.observe(\.accessibilityElementsHidden, options: [.new]) { _, _ in accessibilityWrites += 1 }
        let pageAccessibility = accountController.view.observe(\.accessibilityElementsHidden, options: [.new]) { _, _ in accessibilityWrites += 1 }
        defer {
            barInteraction.invalidate(); pageInteraction.invalidate()
            barAccessibility.invalidate(); pageAccessibility.invalidate()
        }
        for sequence in 4...6 {
            var content = privateDrawerState(update: sequence, backEnabled: true)
            content.surfaceOpen = true; content.profileStack = account.profileStack
            content.profileDestinationId = account.profileDestinationId
            controller.update(content); envelopeNavigation.reconcile()
            // Yield so deferred representable reconciliation/layout is included.
            try await Task.sleep(for: .milliseconds(34))
            controller.view.layoutIfNeeded()
            capturePublicHeader("refresh-\(sequence)")
            XCTAssertEqual(interactionWrites, 0, "Compatible refresh must not rewrite native interaction eligibility")
            XCTAssertEqual(accessibilityWrites, 0, "Compatible refresh must not rewrite native accessibility eligibility")
            XCTAssertTrue(controller.model.profileNavigationController === envelopeNavigation)
            XCTAssertTrue(envelopeNavigation.viewControllers.first === rootController)
            XCTAssertTrue(envelopeNavigation.visibleViewController === accountController)
            XCTAssertEqual(accountController.children.count, accountChildren.count)
            XCTAssertTrue(zip(accountController.children, accountChildren).allSatisfy { $0.0 === $0.1 })
        }
        XCTAssertEqual(repeatedBackTitleWrites, 0, "Compatible content refreshes must not rebuild the native Back label")
        XCTAssertEqual(repeatedTitleWrites, 0, "Compatible refreshes must not reset its owning page title")
        XCTAssertEqual(repeatedBarTintWrites, 0, "Compatible refreshes must not reapply navigation tint")
        XCTAssertEqual(repeatedTintWrites, 0, "Compatible content refreshes must not reapply the ancestor material tint")
        XCTAssertEqual(repeatedStyleWrites, 0, "Compatible content refreshes must not reapply the ancestor appearance")
        controller.model.interactionEnabled = false
        envelopeNavigation.reconcile()
        XCTAssertFalse(envelopeNavigation.navigationBar.isUserInteractionEnabled)
        XCTAssertTrue(envelopeNavigation.navigationBar.accessibilityElementsHidden)
        XCTAssertFalse(accountController.view.isUserInteractionEnabled)
        XCTAssertTrue(accountController.view.accessibilityElementsHidden)
        controller.model.interactionEnabled = true
        envelopeNavigation.reconcile()
        XCTAssertTrue(envelopeNavigation.navigationBar.isUserInteractionEnabled)
        XCTAssertFalse(envelopeNavigation.navigationBar.accessibilityElementsHidden)
        XCTAssertTrue(accountController.view.isUserInteractionEnabled)
        XCTAssertFalse(accountController.view.accessibilityElementsHidden)
        XCTAssertGreaterThanOrEqual(interactionWrites, 4, "Quarantine and readmission must still update both native owners")
        XCTAssertGreaterThanOrEqual(accessibilityWrites, 4, "The observations must detect real accessibility isolation changes")
        let originalBackTitle = rootNavigationItem.backButtonTitle
        repeatedBackTitleWrites = 0
        rootNavigationItem.backButtonTitle = originalBackTitle
        XCTAssertEqual(repeatedBackTitleWrites, 1, "Negative control must observe UIKit's redundant Back-label assignment")
        repeatedTintWrites = 0
        let originalTint = controller.host.view.tintColor
        controller.host.view.tintColor = originalTint
        XCTAssertEqual(repeatedTintWrites, 1, "Negative control must observe a redundant ancestor tint assignment")
        capturePublicHeader("negative-redundant-writes")
        backTitleObservation.invalidate(); titleObservation.invalidate(); barTintObservation.invalidate()
        tintObservation.invalidate(); styleObservation.invalidate()
        let navigationFrame = envelopeNavigation.view.convert(envelopeNavigation.view.bounds, to: window)
        let panelFrame = controller.host.view.convert(controller.host.view.bounds, to: window)
        XCTAssertEqual(navigationFrame.minY, panelFrame.minY, accuracy: 1, "Profile navigation must cover the panel's top safe area")
        XCTAssertEqual(navigationFrame.maxY, panelFrame.maxY, accuracy: 1,
            "Profile navigation must cover the panel's bottom safe area; keyboard inset=\(window.keyboardLayoutGuide.layoutFrame.height)")
        XCTAssertTrue(controller.host === host)
        XCTAssertEqual(controller.motion.progress, 1, "An inner push must not move Profile offscreen")
        XCTAssertEqual(controller.model.navigationPath, ["account"])
        var backs = 0
        controller.model.choose = { [weak controller] action, _, _ in
            if action == "back" || action == "root" { backs += 1; controller?.model.pendingSequence = backs }
            return true
        }
        requestBack()
        requestBack()
        XCTAssertEqual(backs, 1)
        XCTAssertFalse(controller.model.allowsPageInteraction)
        XCTAssertEqual(controller.model.navigationPath, [], "SwiftUI's Back binding must synchronously reflect the presented pop")
        XCTAssertEqual(controller.model.projection.profileStack?.map(\.id), ["account"], "Presentation does not commit the authored route")
        XCTAssertFalse(controller.model.choice("row", row: "edit-name"), "Pending Back quarantines competing operations")
        var refreshed = privateDrawerState(update: 7, backEnabled: true)
        refreshed.surfaceOpen = true; refreshed.profileStack = account.profileStack; refreshed.profileDestinationId = account.profileDestinationId
        controller.update(refreshed)
        controller.model.requestPath([], from: refreshed)
        XCTAssertEqual(backs, 1, "A compatible refresh must not release pending Back")
        XCTAssertEqual(controller.model.navigationPath, [], "A compatible old projection must not replay the pending pop")
        XCTAssertFalse(controller.model.allowsPageInteraction)
        var returned = privateDrawerState(update: 8, backEnabled: true)
        returned.surfaceOpen = true; returned.profileStack = []
        controller.update(returned)
        await requireClose("Returned Profile root")
        await requireRow("row-handle")
        XCTAssertTrue(envelopeNavigation.visibleViewController === rootController)
        XCTAssertFalse(rootController.view.accessibilityElementsHidden)
        XCTAssertTrue(rootController.view.isUserInteractionEnabled)
        XCTAssertTrue(accountController.view.accessibilityElementsHidden,
            "A popped cached destination must relinquish accessibility")
        XCTAssertFalse(accountController.view.isUserInteractionEnabled)
        XCTAssertTrue(controller.model.allowsPageInteraction)
        XCTAssertTrue(controller.host === host)
        XCTAssertEqual(controller.motion.progress, 1)
        account = privateDrawerState(update: 9, backEnabled: true)
        account.surfaceOpen = true; account.profileDestinationId = "account-returned"
        account.profileStack = [controller.model.page("account")!]
        controller.update(account)
        await requireRow("edit-name")
        controller.model.requestPath([], from: returned)
        XCTAssertEqual(backs, 1, "A retained old setter cannot dispatch a fresh Back")
        requestBack()
        XCTAssertEqual(backs, 2)
        controller.model.settle(sequence: 1, success: false)
        XCTAssertFalse(controller.model.choice("row", row: "edit-name"), "An old refusal cannot release a newer Back")
        controller.model.requestPath([], from: account)
        XCTAssertEqual(backs, 2)
        controller.model.settle(sequence: 2, success: false)
        XCTAssertEqual(controller.model.navigationPath, ["account"], "An explicit refusal restores the current authored page without replaying Back")
        await requireRow("edit-name")
        XCTAssertTrue(controller.model.allowsPageInteraction)
        XCTAssertTrue(controller.model.choice("row", row: "edit-name"))
        controller.model.clearDetails()
        XCTAssertFalse(controller.model.choicePending)
        controller.setFormCoverage(true)
        requestBack()
        XCTAssertEqual(backs, 2, "Covered presentation bindings cannot invoke Back")
        XCTAssertFalse(controller.model.interactionEnabled)
        XCTAssertFalse(controller.allowsInteraction("back", row: nil))
        XCTAssertFalse(controller.allowsInteraction("close", row: nil))
        controller.setFormCoverage(false)
        XCTAssertTrue(controller.allowsInteraction("back", row: nil))
        let navigation = try XCTUnwrap(controller.model.profileNavigationController)
        navigation.popViewController(animated: true)
        XCTAssertEqual(backs, 2, "A native pop cannot commit React Back before UIKit completes")
        var replacement = privateDrawerState(update: 10, backEnabled: true, title: "Updated Profile")
        replacement.surfaceOpen = true; replacement.profileDestinationId = "account-replacement"
        replacement.profileStack = account.profileStack
        let transitioningBackTitle = rootNavigationItem.backButtonTitle
        controller.update(replacement)
        navigation.reconcile()
        XCTAssertEqual(rootNavigationItem.backButtonTitle, transitioningBackTitle, "A refresh must not replace Back text during UIKit's active pop")
        await requireRow("edit-name")
        XCTAssertEqual(rootNavigationItem.backButtonTitle, replacement.title, "The latest title applies when navigation settles")
        XCTAssertEqual(backs, 2, "The old pop cannot commit Back against a newer Account incarnation")
        navigation.popViewController(animated: true)
        XCTAssertEqual(backs, 2)
        await fulfillment(of: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in backs == 3 }, object: nil)], timeout: 3)
        XCTAssertEqual(controller.model.navigationPath, [])
        XCTAssertEqual(controller.model.projection.profileStack?.map(\.id), ["account"])
        var preferences = privateDrawerState(update: 11, backEnabled: true)
        preferences.surfaceOpen = true; preferences.profileDestinationId = "preferences-first"
        preferences.profileStack = [NativeProfilePage(id: "preferences", title: "Appearance & preferences", sections: [
            NativeDrawerSection(id: "appearance-settings", title: nil, rows: [
                NativeDrawerRow(id: "theme-selector", label: "Appearance", detail: nil, symbol: "sun.max", enabled: true,
                    destructive: nil, selected: nil, pending: nil, options: [
                        NativeDrawerOption(id: "theme-light", label: "Light", selected: true),
                        NativeDrawerOption(id: "theme-dark", label: "Dark", selected: false),
                    ]),
            ]),
        ])]
        XCTAssertTrue(preferences.valid)
        XCTAssertTrue(preferences.allows(action: "row", row: "theme-dark"))
        XCTAssertFalse(preferences.allows(action: "root", row: nil), "A single page only admits its immediate Back")
        XCTAssertFalse(preferences.allows(action: "row", row: "theme-light"), "Reselecting does not perform another write")
        XCTAssertFalse(preferences.allows(action: "row", row: "theme-selector"), "The trigger is not operation authority")
        var voice = preferences
        voice.profileStack = preferences.profileStack! + [NativeProfilePage(id: "voice", title: "Voice", sections: [])]
        XCTAssertTrue(voice.valid)
        voice.profileStack![0] = NativeProfilePage(id: "security", title: "Security", sections: [])
        XCTAssertFalse(voice.valid, "An unrelated panel cannot become the Voice parent")
        voice.profileStack = Array(voice.profileStack!.suffix(1))
        XCTAssertTrue(voice.valid, "A direct owned Voice entry must not invent a Preferences parent")
        controller.update(preferences)
        await requireRow("theme-selector")
        let preferencesPage = try XCTUnwrap(navigation.topViewController)
        XCTAssertEqual(preferencesPage.view.backgroundColor, UIColor.systemGroupedBackground,
            "The first push frame must not expose the underlying web route while SwiftUI draws")
        XCTAssertEqual(navigation.view.backgroundColor, UIColor.systemGroupedBackground)
        XCTAssertTrue(controller.host === host)
        XCTAssertEqual(controller.motion.progress, 1)
        var nested = privateDrawerState(update: 12, backEnabled: true)
        nested.surfaceOpen = true; nested.profileDestinationId = "security-session"
        nested.profileStack = [NativeProfilePage(id: "security", title: "Security", sections: []),
            NativeProfilePage(id: "session", title: "Account access", sections: [])]
        XCTAssertTrue(nested.valid)
        XCTAssertTrue(nested.allows(action: "root", row: nil))
        controller.update(nested)
        await fulfillment(of: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            !controller.model.navigationTransitioning && navigation.viewControllers.count == 3
        }, object: nil)], timeout: 3)
        navigation.popViewController(animated: true)
        await fulfillment(of: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in backs == 4 }, object: nil)], timeout: 3)
        XCTAssertEqual(controller.model.navigationPath, ["security"], "A committed native Back pops one level, not the whole drawer")
        var parent = privateDrawerState(update: 13, backEnabled: true)
        parent.surfaceOpen = true; parent.profileDestinationId = "security-parent"
        parent.profileStack = [nested.profileStack![0]]
        controller.update(parent)
        nested = privateDrawerState(update: 14, backEnabled: true)
        nested.surfaceOpen = true; nested.profileDestinationId = "security-session-reopened"
        nested.profileStack = parent.profileStack! + [NativeProfilePage(id: "session", title: "Account access", sections: [])]
        controller.update(nested)
        await fulfillment(of: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            !controller.model.navigationTransitioning && navigation.viewControllers.count == 3
        }, object: nil)], timeout: 3)
        navigation.popToRootViewController(animated: true)
        await fulfillment(of: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in backs == 5 }, object: nil)], timeout: 3)
        XCTAssertEqual(controller.model.navigationPath, [], "Back history can return to Profile through one bounded root intent")
        var revisited = privateDrawerState(update: 15, backEnabled: true)
        revisited.surfaceOpen = true; revisited.profileDestinationId = "preferences-returned"
        revisited.profileStack = preferences.profileStack
        controller.update(revisited)
        await requireRow("theme-selector")
        XCTAssertTrue(navigation.topViewController === preferencesPage, "Reopening a sibling page retains its hosting controller")
        XCTAssertNil(navigation.popToViewController(preferencesPage, animated: true))
        XCTAssertTrue(navigation.hasCompletedProjectedDestination, "A no-op pop must not strand transition quarantine")
        XCTAssertTrue(controller.host === host)
        func choiceMenu(in view: UIView) -> NativeDrawerMenuControl? {
            if let menu = view as? NativeDrawerMenuControl,
               menu.accessibilityIdentifier == "native-profile-row-theme-selector" { return menu }
            return view.subviews.lazy.compactMap { choiceMenu(in: $0) }.first
        }
        let themeMenu = try XCTUnwrap(choiceMenu(in: preferencesPage.view))
        // Force a real representable update while UIKit quarantines its page.
        // didShow must restore touch without another settings projection.
        navigation.navigationController(navigation, willShow: preferencesPage, animated: true)
        var duringTransition = privateDrawerState(update: 16, backEnabled: true)
        duringTransition.surfaceOpen = true
        duringTransition.profileDestinationId = revisited.profileDestinationId
        var updatedRow = revisited.profileStack![0].sections[0].rows[0]
        updatedRow.options = [NativeDrawerOption(id: "theme-light", label: "Light", selected: false),
                              NativeDrawerOption(id: "theme-dark", label: "Dark", selected: true)]
        duringTransition.profileStack = [NativeProfilePage(id: "preferences", title: "Appearance & preferences", sections: [
            NativeDrawerSection(id: "appearance-settings", title: nil, rows: [updatedRow]),
        ])]
        controller.update(duringTransition)
        await fulfillment(of: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            themeMenu.accessibilityValue == "Dark"
        }, object: nil)], timeout: 3)
        XCTAssertFalse(preferencesPage.view.isUserInteractionEnabled)
        navigation.navigationController(navigation, didShow: preferencesPage, animated: true)
        XCTAssertTrue(preferencesPage.view.isUserInteractionEnabled)
        XCTAssertTrue(themeMenu.isUserInteractionEnabled, "A transition-time render must not strand the retained menu")
        XCTAssertFalse(themeMenu.accessibilityElementsHidden, "UIKit completion must restore menu accessibility too")

        navigation.popViewController(animated: true)
        XCTAssertEqual(backs, 5, "A compatible refresh cannot commit Back before UIKit finishes")
        func compatibleState(_ update: Int, privacy: Int = 0) -> NativeDrawerProjection {
            var next = privateDrawerState(update: update, appearance: "dark", privacy: privacy, backEnabled: true)
            next.surfaceOpen = true
            next.profileDestinationId = duringTransition.profileDestinationId
            next.profileStack = duringTransition.profileStack
            return next
        }
        let compatible = compatibleState(17)
        controller.update(compatible)
        await fulfillment(of: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in backs == 6 }, object: nil)], timeout: 3)
        XCTAssertEqual(controller.model.navigationPath, [])
        XCTAssertEqual(navigation.viewControllers.count, 1, "A compatible update must not push the popped page back")
        controller.update(compatibleState(18))
        navigation.reconcile()
        XCTAssertEqual(backs, 6, "Refresh while awaiting React Back cannot replay the operation")
        XCTAssertEqual(navigation.viewControllers.count, 1)
        returned = privateDrawerState(update: 19, backEnabled: true)
        returned.surfaceOpen = true; returned.profileStack = []
        controller.update(returned)
        await requireRow("row-handle")
        XCTAssertTrue(controller.model.allowsPageInteraction)

        controller.update(compatibleState(20))
        await requireRow("theme-selector")
        navigation.popViewController(animated: true)
        controller.update(compatibleState(21, privacy: 1))
        await requireRow("theme-selector")
        XCTAssertEqual(backs, 6, "A privacy change is not a compatible pop binding")
        var sibling = privateDrawerState(update: 22, privacy: 1, backEnabled: true)
        sibling.surfaceOpen = true; sibling.profileDestinationId = "account-after-preferences"
        sibling.profileStack = account.profileStack
        controller.model.update(sibling)
        XCTAssertEqual(navigation.viewControllers.count, 2)
        XCTAssertFalse(navigation.hasCompletedProjectedDestination,
            "An equal-depth Account projection is not proof that the visible Preferences controller changed")
        controller.view.setNeedsLayout(); controller.view.layoutIfNeeded()
        XCTAssertFalse(controller.presentationSettled)
        controller.update(sibling)
        await requireRow("edit-name")
        XCTAssertTrue(navigation.hasCompletedProjectedDestination)
        controller.retire()
        navigation.navigationController(navigation, didShow: navigation.viewControllers[0], animated: true)
        requestBack()
        XCTAssertEqual(backs, 6, "A retained retired callback cannot invoke a route operation")
    }

    @MainActor
    func testProfileContentHandoffDoesNotReplayTheOuterDrawerSlide() async throws {
        var detail = privateDrawerState(open: false)
        detail.surfaceOpen = true
        let controller = NativeDrawerPresentationController(detail)
        controller.view.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        controller.activateInitialPresentation()
        XCTAssertFalse(controller.presentationSettled, "An offscreen host cannot acknowledge visible presentation")
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.rootViewController = controller; window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil; previousKeyWindow?.makeKeyAndVisible() }
        let host = controller.host
        var completed = [Int]()
        controller.presentationDidSettle = { completed.append($0.updateSequence) }
        var menu = privateDrawerState(update: 2)
        menu.surfaceOpen = true
        controller.update(menu)
        XCTAssertTrue(controller.motion.committedOpen, "Returning to menu content must not start another outer opening animation")
        XCTAssertEqual(controller.motion.progress, 1)
        XCTAssertTrue(controller.host === host)
        XCTAssertTrue(controller.presentationSettled)
        XCTAssertEqual(completed, [2])
        detail = privateDrawerState(open: false, update: 3)
        detail.surfaceOpen = true
        controller.update(detail)
        XCTAssertFalse(controller.motion.committedOpen)
        XCTAssertEqual(controller.motion.progress, 0)
        XCTAssertEqual(completed, [2, 3])
        XCTAssertFalse(controller.allowsInteraction("row", row: "row-handle"))
        controller.retire()

        // Negative control: an actual closed-to-open drawer still settles
        // asynchronously; the content handoff must not disable its animation.
        var closed = privateDrawerState(open: false)
        closed.surfaceOpen = false
        let opening = NativeDrawerPresentationController(closed)
        opening.view.frame = controller.view.frame
        window.rootViewController = opening
        opening.activateInitialPresentation()
        var openingCompletions = 0
        opening.presentationDidSettle = { _ in openingCompletions += 1 }
        opening.update(menu)
        XCTAssertFalse(opening.motion.committedOpen)
        XCTAssertFalse(opening.presentationSettled)
        XCTAssertEqual(openingCompletions, 0, "Projection acceptance is not completed presentation")
        await fulfillment(of: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in opening.presentationSettled }, object: nil)], timeout: 2)
        XCTAssertEqual(openingCompletions, 1)
        opening.retire()
        XCTAssertFalse(opening.presentationSettled)

        // A changed privacy generation cannot take the content-only path.
        let changedPrivacy = NativeDrawerPresentationController(detail)
        changedPrivacy.view.frame = controller.view.frame
        window.rootViewController = changedPrivacy
        changedPrivacy.activateInitialPresentation()
        var next = privateDrawerState(update: 4, privacy: 1)
        next.surfaceOpen = true
        changedPrivacy.update(next)
        XCTAssertFalse(changedPrivacy.motion.committedOpen)
        changedPrivacy.retire()
    }

    @MainActor
    func testUnacknowledgedDrawerCloseRequestsFreshPresentationWithoutReplayingClose() {
        for outcome in ["refreshed", "retired", "stalled"] {
            let controller = NativeDrawerPresentationController(privateDrawerState())
            controller.view.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
            controller.activateInitialPresentation()
            let host = controller.host
            var choices = 0, invalidations = 0
            controller.model.choose = { action, _, _ in
                XCTAssertEqual(action, "close")
                choices += 1
                return true // Deliberately do not acknowledge the authored Close.
            }
            controller.invalidateInteractions = { invalidations += 1 }
            let refresh = expectation(description: "Timed-out presentation requests readmission")
            let recovery = expectation(description: "Only stalled readmission escalates native recovery")
            recovery.isInverted = outcome != "stalled"
            controller.requestRecovery = {
                XCTAssertFalse(controller.model.interactionEnabled)
                XCTAssertEqual(choices, 1)
                recovery.fulfill()
            }
            controller.requestReadmission = {
                XCTAssertFalse(controller.model.interactionEnabled)
                XCTAssertGreaterThanOrEqual(invalidations, 2, "Timeout must invalidate the original action token")
                // Let the recovery deadline arm first. A fresh projection or
                // retirement must then cancel it, not merely avoid arming it.
                if outcome != "stalled" {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                        if outcome == "retired" { controller.retire() }
                        else { controller.update(self.privateDrawerState(update: 2)) }
                    }
                }
                refresh.fulfill()
            }
            controller.settle(open: false, userIntent: true)
            wait(for: [refresh], timeout: 7)
            wait(for: [recovery], timeout: 3)
            XCTAssertEqual(choices, 1, "A presentation refresh must not replay Close")
            if outcome != "retired" {
                if outcome == "stalled" { controller.update(privateDrawerState(update: 2)) }
                let admitted = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                    controller.model.interactionEnabled && controller.allowsInteraction("close", row: nil)
                }, object: controller)
                XCTAssertEqual(XCTWaiter.wait(for: [admitted], timeout: 2), .completed,
                    "Fresh owner presentation must restore interaction after settlement")
            }
            XCTAssertTrue(controller.host === host)
            XCTAssertEqual(choices, 1)
            controller.retire()
            XCTAssertNil(controller.requestReadmission)
            XCTAssertNil(controller.requestRecovery)
        }
    }

    #if DEBUG
    func testNativeHistoryQualificationRequiresExplicitSupportedPhoneAdmission() {
        XCTAssertTrue(NativeHistoryQualification.admits(arguments: [NativeHistoryQualification.argument], phone: true, supported: true))
        for arguments in [[], ["-UITestMode"], ["--hushh-native-compositor", "--hushh-native-drawer-clip"]] {
            XCTAssertFalse(NativeHistoryQualification.admits(arguments: arguments, phone: true, supported: true))
        }
        XCTAssertFalse(NativeHistoryQualification.admits(arguments: [NativeHistoryQualification.argument], phone: false, supported: true))
        XCTAssertFalse(NativeHistoryQualification.admits(arguments: [NativeHistoryQualification.argument], phone: true, supported: false))
    }

    func testNativeHistoryQualificationCancellationAndRegrabRejectOldSettlement() {
        var state = NativeHistoryQualificationMotion()
        let opening = state.begin(at: 0)
        state.move(to: 0.7)
        XCTAssertFalse(state.destination(velocity: 1000, cancelled: true), "Cancellation must not commit an opening drag")
        XCTAssertTrue(state.commit(open: true, generation: opening))
        let closing = state.begin(at: 0.6)
        state.move(to: 0.2)
        XCTAssertTrue(state.destination(velocity: -1000, cancelled: true), "Cancellation preserves the last committed open state")
        let regrab = state.begin(at: 0.3)
        XCTAssertFalse(state.commit(open: false, generation: closing), "An interrupted close cannot finish a new drag")
        state.move(to: 0.8)
        XCTAssertTrue(state.commit(open: true, generation: regrab))
        state.retire()
        XCTAssertFalse(state.commit(open: false, generation: regrab))
        state.move(to: 0)
        XCTAssertEqual(state.progress, 1, "Retired callbacks cannot mutate or re-admit the fixture")
    }

    @MainActor
    func testNativeHistoryQualificationRetainsHostsAndActuallyDetachesOnRetirement() throws {
        guard #available(iOS 26.0, *) else { throw XCTSkip("Glass composition requires iOS 26") }
        let fixture = NativeHistoryQualificationController()
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = fixture
        window.isHidden = false
        defer { window.isHidden = true; window.rootViewController = nil }
        fixture.loadViewIfNeeded()
        fixture.view.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        fixture.view.layoutIfNeeded()
        let base = try XCTUnwrap(fixture.baseHost)
        let drawer = try XCTUnwrap(fixture.drawerHost)
        let editor = try XCTUnwrap(fixture.dock.editor)
        XCTAssertEqual(fixture.children.count, 2)
        XCTAssertTrue(fixture.view.accessibilityViewIsModal)
        fixture.appearance.dark = true
        fixture.appearance.gold = true
        fixture.appearance.agentSurface = "puppy"
        fixture.beginDrag()
        XCTAssertTrue(fixture.baseHost === base)
        XCTAssertTrue(fixture.drawerHost === drawer)
        XCTAssertTrue(fixture.dock.editor === editor)
        XCTAssertEqual(fixture.overrideUserInterfaceStyle, .dark)
        XCTAssertTrue(fixture.modalPresentationCapturesStatusBarAppearance)
        XCTAssertEqual(fixture.preferredStatusBarStyle, .lightContent)
        fixture.settle(open: true)
        fixture.beginDrag()
        fixture.settle(open: false)
        XCTAssertFalse(base.view.isUserInteractionEnabled,
            "A closing target cannot enable the base before visible settlement")
        XCTAssertTrue(base.view.accessibilityElementsHidden,
            "Accessibility must remain isolated through the closing animation")
        fixture.beginDrag()
        XCTAssertTrue(fixture.baseHost === base)
        XCTAssertTrue(fixture.drawerHost === drawer)
        let shield = HushhSessionPrivacyShield.shared.snapshot()
        var detached = false
        fixture.onRetired = {
            detached = fixture.children.isEmpty && base.view.superview == nil && drawer.view.superview == nil
        }
        fixture.retire()
        XCTAssertTrue(detached, "A retirement receipt must follow actual owned-view removal")
        XCTAssertTrue(fixture.view.accessibilityElementsHidden)
        XCTAssertFalse(fixture.view.isUserInteractionEnabled)
        XCTAssertNil(fixture.appearance.changed)
        XCTAssertTrue(fixture.dock.text.isEmpty)
        XCTAssertNil(fixture.dock.emit)
        fixture.beginDrag()
        fixture.settle(open: true)
        XCTAssertTrue(fixture.children.isEmpty)
        XCTAssertEqual(HushhSessionPrivacyShield.shared.snapshot().generation, shield.generation)
        XCTAssertEqual(HushhSessionPrivacyShield.shared.snapshot().shielded, shield.shielded,
            "Fixture retirement must not release or invalidate the product's privacy authority")
    }
    #endif

    @MainActor
    func testContentBackedBaseHasNoCanvasBetweenGlassAndPageAndPreservesHitIsolation() {
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let container = NativePresentationContainer(webView: web, basePresentation: .contentBacked)
        let control = UIButton(frame: CGRect(x: 10, y: 10, width: 44, height: 44))
        container.setCanvas(.black, appearance: .light)
        container.install(control, id: "chat-history-toggle", group: nil)
        XCTAssertTrue(web.superview === container)
        XCTAssertTrue(container.contentBackedPresentation)
        XCTAssertGreaterThan(container.subviews.firstIndex(of: container.underlay)!, container.subviews.firstIndex(of: web)!)
        XCTAssertGreaterThanOrEqual(container.underlay.layer.zPosition, web.layer.zPosition)
        XCTAssertEqual(container.underlay.backgroundColor, .clear, "An opaque native plane would destroy the page-backed material")
        XCTAssertEqual(container.overrideUserInterfaceStyle, .light)
        let unsupportedPose = NativePanelPose(document: "synthetic", ownerEpoch: "epoch", generation: 1,
            sequence: 1, privacyGeneration: 0, frame: container.bounds, offset: 0, opacity: 0.5, settled: true)
        XCTAssertFalse(container.apply(unsupportedPose, group: "profile", privacy: 0),
            "The material-only pilot must not accidentally adopt an alpha-composited native drawer")
        container.setAdmission("chat-history-toggle", admitted: true)
        XCTAssertTrue(container.hitTest(CGPoint(x: 20, y: 20), with: nil) === control)
        XCTAssertFalse(container.hitTest(CGPoint(x: 100, y: 100), with: nil)?.isDescendant(of: control) == true)
        container.setAdmission("chat-history-toggle", admitted: false)
        XCTAssertFalse(container.hitTest(CGPoint(x: 20, y: 20), with: nil) === control)
        XCTAssertTrue(container.setRegions(document: "synthetic", revision: 1,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: true))
        XCTAssertEqual(HushhNativeChromePlugin.stationaryChatControlIds["agent-surface"], "chat-agent-surface",
            "The stationary Chat selector must not disappear from the content-backed capability contract")
        XCTAssertNil(HushhNativeChromePlugin.stationaryChatControlIds["profile-back"],
            "Admitting the stationary selector must not adopt moving Profile controls")
        XCTAssertFalse(container.containsStationaryControl(CGRect(x: 280, y: 60, width: 88, height: 44), document: "synthetic"),
            "A selector crossing the reserved header boundary cannot be admitted")
        XCTAssertTrue(container.containsStationaryControl(CGRect(x: 280, y: 50, width: 88, height: 44), document: "synthetic"))
        XCTAssertFalse(control.isHidden, "Overlay isolation must retain the visible material")
        XCTAssertTrue(control.accessibilityElementsHidden)
        XCTAssertTrue(container.hitTest(CGPoint(x: 20, y: 20), with: nil) === container,
            "A disabled native region must not forward touches to covered DOM controls")
        XCTAssertFalse(container.hitTest(CGPoint(x: 100, y: 200), with: nil) === container,
            "The React drawer keeps its central interaction region")
        XCTAssertFalse(container.setRegions(document: "synthetic", revision: 0,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: false))
        XCTAssertTrue(container.overlayIsolated, "A reordered acknowledgment cannot restore actions")
        XCTAssertTrue(container.setRegions(document: "synthetic", revision: 2,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: false))
        XCTAssertFalse(control.isUserInteractionEnabled, "Fresh bindings, not region dismissal, restore interaction")
        container.setAdmission("chat-history-toggle", admitted: true)
        XCTAssertTrue(container.hitTest(CGPoint(x: 20, y: 20), with: nil) === control)
        let retained = control.superview
        let privacy = HushhSessionPrivacyShield.shared.snapshot().generation
        XCTAssertTrue(container.setRegions(document: "synthetic", revision: 3,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: true, covered: true, privacyGeneration: privacy))
        container.revealUnderlay() // A delayed normal control update cannot uncover the drawer.
        XCTAssertTrue(container.underlay.isHidden)
        XCTAssertTrue(control.superview === retained)
        XCTAssertTrue(control.accessibilityElementsHidden)
        XCTAssertFalse(container.hitTest(CGPoint(x: 20, y: 20), with: nil) === container,
            "Full-height drawer edge controls must reach WK, not the old reserved-strip interceptor")
        XCTAssertFalse(container.setRegions(document: "synthetic", revision: 2,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: false))
        XCTAssertTrue(container.fullWindowCovered)
        XCTAssertTrue(container.setRegions(document: "synthetic", revision: 4,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: false, privacyGeneration: privacy))
        container.setAdmission("chat-history-toggle", admitted: true, presentationRegionRevision: 2, privacyGeneration: privacy)
        XCTAssertFalse(control.isUserInteractionEnabled, "A pre-cover admission must not revive after dismissal")
        container.setAdmission("chat-history-toggle", admitted: true, presentationRegionRevision: 4, privacyGeneration: privacy)
        XCTAssertTrue(control.isUserInteractionEnabled)
        container.conceal()
        XCTAssertTrue(container.setRegions(document: "synthetic", revision: 5,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: false, privacyGeneration: privacy))
        XCTAssertTrue(container.underlay.isHidden, "Ordinary coverage release is not privacy validation")
        XCTAssertTrue(control.superview === retained)
        XCTAssertTrue(control.accessibilityElementsHidden)
        XCTAssertFalse(container.hitTest(CGPoint(x: 20, y: 20), with: nil) === control)
    }

    @MainActor
    func testContentBackedDrawerClippingPreservesWindowCoordinatesWithoutGrantingActions() {
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let container = NativePresentationContainer(webView: web, basePresentation: .contentBacked, drawerClipping: true)
        let control = UIButton(frame: CGRect(x: 10, y: 10, width: 44, height: 44))
        container.install(control, id: "chat-history-toggle", group: nil)
        let retained = control.superview
        let original = control.convert(control.bounds, to: container)
        let privacy = HushhSessionPrivacyShield.shared.snapshot().generation
        func regions(_ revision: Int, drawer: String?) {
            XCTAssertTrue(container.setRegions(document: "synthetic", revision: revision,
                viewport: container.bounds.size, top: 100, bottom: 150, isolated: drawer != nil,
                covered: drawer != nil, privacyGeneration: privacy, drawer: drawer))
        }
        regions(1, drawer: "profile")
        XCTAssertEqual(container.baseVisibleFrame, .zero, "No native paint before the first current coverage receipt")
        let pose = NativePanelPose(document: "synthetic", ownerEpoch: "epoch", generation: 1,
            sequence: 1, privacyGeneration: privacy, frame: container.bounds, offset: 150, opacity: 1, settled: false)
        XCTAssertTrue(container.applyDrawerCoverage(pose, group: "profile", privacy: privacy, revision: 1))
        XCTAssertEqual(container.baseVisibleFrame, CGRect(x: 0, y: 0, width: 150, height: 844))
        XCTAssertFalse(container.underlay.isHidden, "Held partial drag must not hide the entire retained native plane")
        XCTAssertEqual(control.convert(control.bounds, to: container), original)
        XCTAssertTrue(control.superview === retained)
        XCTAssertTrue(control.accessibilityElementsHidden)
        XCTAssertFalse(container.hitTest(CGPoint(x: 20, y: 20), with: nil) === control)
        XCTAssertFalse(container.hitTest(CGPoint(x: 350, y: 20), with: nil) === container,
            "Drawer edge touches must reach the single WebView")
        // Same displayed drawer, new admission revision: no blank interval.
        regions(2, drawer: "profile")
        XCTAssertEqual(container.baseVisibleFrame.width, 150)
        XCTAssertFalse(container.applyDrawerCoverage(pose, group: "profile", privacy: privacy, revision: 1))
        regions(3, drawer: nil)
        XCTAssertEqual(container.baseVisibleFrame, container.bounds)
        XCTAssertFalse(container.applyDrawerCoverage(pose, group: "profile", privacy: privacy, revision: 1),
            "A delayed covered pose cannot cover the dismissed drawer")
        regions(4, drawer: "history")
        let history = NativePanelPose(document: "synthetic", ownerEpoch: "history-epoch", generation: 2,
            sequence: 1, privacyGeneration: privacy, frame: container.bounds, offset: -150, opacity: 1, settled: false)
        XCTAssertTrue(container.applyDrawerCoverage(history, group: "history", privacy: privacy, revision: 4))
        XCTAssertEqual(container.baseVisibleFrame, CGRect(x: 240, y: 0, width: 150, height: 844))
        XCTAssertEqual(control.convert(control.bounds, to: container), original,
            "Right-hand exposure must compensate the viewport origin, not move child controls")
        XCTAssertEqual(container.underlay.bounds.size, container.bounds.size)
        XCTAssertEqual(container.underlay.superview?.alpha, 1)
        XCTAssertNil(container.underlay.superview?.layer.mask)
        XCTAssertTrue(container.underlay.superview?.clipsToBounds == true)
        XCTAssertFalse(container.applyDrawerCoverage(history, group: "profile", privacy: privacy, revision: 4))
        XCTAssertFalse(container.applyDrawerCoverage(history, group: "history", privacy: privacy + 1, revision: 4))
        XCTAssertTrue(container.retire(group: "history", document: "synthetic", ownerEpoch: "history-epoch", generation: 2))
        XCTAssertEqual(container.baseVisibleFrame, .zero, "Uncertain/retired coverage must not paint over the drawer")
        regions(5, drawer: "profile")
        let terminal = NativePanelPose(document: "synthetic", ownerEpoch: "exit-epoch", generation: 3,
            sequence: 1, privacyGeneration: privacy, frame: container.bounds, offset: container.bounds.width,
            opacity: 1, settled: false)
        XCTAssertTrue(container.applyDrawerCoverage(terminal, group: "profile", privacy: privacy, revision: 5))
        XCTAssertEqual(container.baseVisibleFrame, container.bounds)
        regions(6, drawer: nil) // Apply release before clearing the captured pose.
        XCTAssertTrue(container.retire(group: "profile", document: "synthetic", ownerEpoch: "exit-epoch", generation: 3))
        XCTAssertEqual(container.baseVisibleFrame, container.bounds, "Normal release-then-retire must never blank exposed glass")
        let entering = NativePanelPose(document: "synthetic", ownerEpoch: "atomic-entry", generation: 4,
            sequence: 1, privacyGeneration: privacy, frame: container.bounds, offset: 200, opacity: 1, settled: false)
        XCTAssertTrue(container.setRegions(document: "synthetic", revision: 7,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: true,
            covered: true, privacyGeneration: privacy, drawer: "profile", initialPose: entering))
        XCTAssertEqual(container.baseVisibleFrame.width, 200,
            "Atomic first coverage must expose the retained plane without a zero-frame intermediate state")
        XCTAssertFalse(control.isUserInteractionEnabled)
        XCTAssertTrue(container.drawerCoverageIsSuperseded(entering, group: "profile", privacy: privacy, revision: 7),
            "An already committed atomic pose is a no-op, not a failed drawer lifetime")
        XCTAssertFalse(container.drawerCoverageIsSuperseded(entering, group: "profile", privacy: privacy + 1, revision: 7))
        XCTAssertFalse(container.drawerCoverageIsSuperseded(entering, group: "history", privacy: privacy, revision: 7))
        let foreignDuplicate = NativePanelPose(document: "synthetic", ownerEpoch: "different-owner", generation: 4,
            sequence: 1, privacyGeneration: privacy, frame: container.bounds, offset: 200, opacity: 1, settled: false)
        XCTAssertFalse(container.drawerCoverageIsSuperseded(foreignDuplicate, group: "profile", privacy: privacy, revision: 7),
            "Sequence coincidence must never admit another owner as a superseded delivery")
        let stale = NativePanelPose(document: "synthetic", ownerEpoch: "stale-entry", generation: 4,
            sequence: 2, privacyGeneration: privacy, frame: container.bounds, offset: 300, opacity: 1, settled: false)
        XCTAssertFalse(container.drawerCoverageIsSuperseded(stale, group: "profile", privacy: privacy, revision: 7),
            "A changed owner cannot be treated as an overtaken presentation")
        XCTAssertFalse(container.setRegions(document: "synthetic", revision: 8,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: true,
            covered: true, privacyGeneration: privacy, drawer: "profile", initialPose: stale))
        XCTAssertEqual(container.baseVisibleFrame.width, 200, "Rejected admission cannot partially commit a newer region")
        XCTAssertFalse(container.setRegions(document: "synthetic", revision: 8,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: true,
            covered: true, privacyGeneration: privacy + 1, drawer: "profile", initialPose: entering))
        XCTAssertTrue(container.setRegions(document: "synthetic", revision: 8,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: false,
            privacyGeneration: privacy))
        regions(9, drawer: "profile")
        let reopened = NativePanelPose(document: "synthetic", ownerEpoch: "reopened-epoch", generation: 5,
            sequence: 1, privacyGeneration: privacy, frame: container.bounds, offset: 80, opacity: 1, settled: false)
        XCTAssertTrue(container.applyDrawerCoverage(reopened, group: "profile", privacy: privacy, revision: 9))
        XCTAssertFalse(container.retire(group: "profile", document: "synthetic", ownerEpoch: "exit-epoch", generation: 3))
        XCTAssertEqual(container.baseVisibleFrame.width, 80, "Late cleanup cannot clear a reopened presentation")
        // Initial sampling and the ordinary pose writer have independent
        // bridge deliveries. A newest region must not fail or rewind pixels
        // when its same-owner initial pose loses that ordering race.
        let sampled = NativePanelPose(document: "synthetic", ownerEpoch: "reopened-epoch", generation: 5,
            sequence: 2, privacyGeneration: privacy, frame: container.bounds, offset: 100, opacity: 1, settled: false)
        let advanced = NativePanelPose(document: "synthetic", ownerEpoch: "reopened-epoch", generation: 5,
            sequence: 3, privacyGeneration: privacy, frame: container.bounds, offset: 120, opacity: 1, settled: false)
        XCTAssertTrue(container.applyDrawerCoverage(advanced, group: "profile", privacy: privacy, revision: 9))
        let foreignSample = NativePanelPose(document: "synthetic", ownerEpoch: "foreign-owner", generation: 5,
            sequence: 2, privacyGeneration: privacy, frame: container.bounds, offset: 100, opacity: 1, settled: false)
        XCTAssertFalse(container.setRegions(document: "synthetic", revision: 10,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: true,
            covered: true, privacyGeneration: privacy, drawer: "profile", initialPose: foreignSample))
        let malformedSample = NativePanelPose(document: "synthetic", ownerEpoch: "reopened-epoch", generation: 5,
            sequence: 2, privacyGeneration: privacy, frame: container.bounds,
            offset: container.bounds.width + 1, opacity: 1, settled: false)
        XCTAssertFalse(container.setRegions(document: "synthetic", revision: 10,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: true,
            covered: true, privacyGeneration: privacy, drawer: "profile", initialPose: malformedSample))
        XCTAssertTrue(container.acceptsPresentationRevision(9, privacyGeneration: privacy))
        XCTAssertEqual(container.groupPose("profile"), advanced)
        XCTAssertTrue(container.setRegions(document: "synthetic", revision: 10,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: true,
            covered: true, privacyGeneration: privacy, drawer: "profile", initialPose: sampled))
        XCTAssertEqual(container.groupPose("profile"), advanced)
        XCTAssertEqual(container.baseVisibleFrame.width, 120, "Region admission must preserve newer geometry")
        XCTAssertTrue(container.acceptsPresentationRevision(10, privacyGeneration: privacy))
        XCTAssertFalse(container.acceptsPresentationRevision(9, privacyGeneration: privacy))
        XCTAssertFalse(control.isUserInteractionEnabled, "Layout admission never grants covered actions")
        let ulp = CGFloat(Float(container.bounds.width).ulp)
        let noisy = NativePanelPose(document: "synthetic", ownerEpoch: "pixel-epoch", generation: 6,
            sequence: 1, privacyGeneration: privacy,
            frame: CGRect(x: -ulp, y: 0, width: container.bounds.width + ulp, height: container.bounds.height),
            offset: 150, opacity: 1, settled: false)
        XCTAssertTrue(container.setRegions(document: "synthetic", revision: 11,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: true,
            covered: true, privacyGeneration: privacy, drawer: "profile", initialPose: noisy),
            "Observed WebKit transform round-off cannot retire a full-height drawer/dock")
        let outside = NativePanelPose(document: "synthetic", ownerEpoch: "pixel-epoch", generation: 6,
            sequence: 2, privacyGeneration: privacy,
            frame: CGRect(x: -0.01, y: 0, width: container.bounds.width + 0.01, height: container.bounds.height),
            offset: 150, opacity: 1, settled: false)
        XCTAssertFalse(container.setRegions(document: "synthetic", revision: 12,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: true,
            covered: true, privacyGeneration: privacy, drawer: "profile", initialPose: outside),
            "Machine precision must not become a permissive CSS-pixel containment margin")
        XCTAssertEqual(container.groupPose("profile"), noisy)
        XCTAssertTrue(container.acceptsPresentationRevision(11, privacyGeneration: privacy))
        container.conceal()
        regions(12, drawer: nil)
        XCTAssertEqual(container.baseVisibleFrame, .zero)
        XCTAssertTrue(container.underlay.isHidden, "Region release must never clear privacy")
        XCTAssertTrue(web.superview === container)
    }

    @MainActor
    func testNativePanelPoseAndClippingDoNotGrantStaleOrOutsideHits() {
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let container = NativePresentationContainer(webView: web)
        let control = UIButton(frame: CGRect(x: 10, y: 10, width: 44, height: 44))
        let pose = NativePanelPose(document: "synthetic", ownerEpoch: "epoch", generation: 1,
            sequence: 1, privacyGeneration: 0, frame: CGRect(x: 100, y: 0, width: 100, height: 844),
            offset: 0, opacity: 1, settled: true)
        container.install(control, id: "profile-close", group: "profile")
        XCTAssertTrue(container.apply(pose, group: "profile", privacy: 0))
        container.setAdmission("profile-close", admitted: true)
        XCTAssertTrue(web.superview === container)
        XCTAssertTrue(container.subviews.first === web,
            "WK's rectangle must not sit in front of native controls in UIKit traversal")
        XCTAssertLessThan(container.underlay.layer.zPosition, web.layer.zPosition,
            "Native accessibility ordering must not move glass above product paint")
        let navigation = UITabBar(frame: CGRect(x: 0, y: 761, width: 390, height: 83))
        container.install(navigation, id: "bottom-navigation", group: nil)
        container.setAdmission("bottom-navigation", admitted: true)
        XCTAssertTrue(navigation.superview === container.underlay,
            "The retained bar must paint beneath the WebView's drawer scrim, not over product rows")
        container.setAdmission("bottom-navigation", admitted: false)
        XCTAssertFalse(navigation.isHidden)
        XCTAssertFalse(navigation.isUserInteractionEnabled)
        XCTAssertTrue(navigation.accessibilityElementsHidden)
        XCTAssertFalse(container.hitTest(CGPoint(x: 120, y: 800), with: nil)?.isDescendant(of: navigation) == true)
        XCTAssertTrue(container.hitTest(CGPoint(x: 120, y: 20), with: nil) === control)
        control.frame.origin.x = -30 // Its bounds extend outside the clipped group.
        XCTAssertFalse(container.hitTest(CGPoint(x: 85, y: 20), with: nil) === control)
        XCTAssertFalse(container.apply(pose, group: "profile", privacy: 0), "Reordered pose cannot regain interaction")
        control.frame.origin.x = 10
        let originalHost = control.superview
        let moving = NativePanelPose(document: "synthetic", ownerEpoch: "epoch", generation: 1,
            sequence: 2, privacyGeneration: 0, frame: pose.frame, offset: 30, opacity: 1, settled: false)
        XCTAssertTrue(container.apply(moving, group: "profile", privacy: 0))
        XCTAssertTrue(control.superview === originalHost, "Motion must preserve the native presentation")
        XCTAssertFalse(control.isHidden, "Interaction suspension must not hide a moving control")
        XCTAssertFalse(control.isUserInteractionEnabled)
        XCTAssertTrue(control.accessibilityElementsHidden)
        XCTAssertFalse(container.hitTest(CGPoint(x: 150, y: 20), with: nil) === control,
            "A moving native control cannot execute an action")
        let transparent = NativePanelPose(document: "synthetic", ownerEpoch: "epoch", generation: 1,
            sequence: 3, privacyGeneration: 0, frame: pose.frame, offset: 0, opacity: 0, settled: true)
        XCTAssertTrue(container.apply(transparent, group: "profile", privacy: 0))
        container.setAdmission("profile-close", admitted: true)
        XCTAssertFalse(container.hitTest(CGPoint(x: 120, y: 20), with: nil) === control,
            "Ancestor opacity must exclude a native hit even when its own view is visible")
        XCTAssertTrue(container.retire(group: "profile", document: "synthetic", ownerEpoch: "epoch", generation: 1))
        XCTAssertFalse(container.apply(pose, group: "profile", privacy: 0), "Retired presentation cannot resurrect")
        container.conceal()
        XCTAssertFalse(container.hitTest(CGPoint(x: 120, y: 20), with: nil) === control)
    }

    func testAppHapticMigrationUsesAnExplicitDisabledValueOnce() {
        let name = "hushh-haptic-test-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set(true, forKey: "hapticFeedback")
        defaults.set("{\"hapticFeedback\":false,\"theme\":\"dark\"}", forKey: "CapacitorStorage.hushh_settings")
        XCTAssertFalse(HushhAppHaptics.enabled(in: defaults))
        defaults.set(true, forKey: "hapticFeedback")
        XCTAssertTrue(HushhAppHaptics.enabled(in: defaults), "Legacy JSON cannot override the authoritative native value after migration")
        XCTAssertNil(defaults.object(forKey: "theme"), "No unrelated setting is migrated")
    }

    func testAppHapticFeedbackCannotReplayOrQueueExpiredChoices() {
        var state = HushhAppHapticFeedbackState()
        XCTAssertTrue(state.consume("choice-1", issuedAt: 1000, now: 1001))
        XCTAssertFalse(state.consume("choice-1", issuedAt: 1000, now: 1002), "One choice must not vibrate twice")
        XCTAssertFalse(state.consume("expired", issuedAt: 1000, now: 1251), "Late feedback is dropped, not queued")
        XCTAssertFalse(state.consume("future", issuedAt: 1100, now: 1000))
        XCTAssertTrue(state.consume("choice-2", issuedAt: 1002, now: 1003), "A distinct current choice remains admitted")
    }

    @MainActor
    func testNativeBottomScrollMovesOnlyTheRetainedPairAndRejectsInvalidatedSamples() throws {
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let container = NativePresentationContainer(webView: web, basePresentation: .coherentDrawers)
        let navigationFrame = CGRect(x: 0, y: 761, width: 390, height: 83)
        let dockFrame = CGRect(x: 16, y: 700, width: 358, height: 52)
        let navigation = UIView(frame: navigationFrame), dock = UIView(frame: dockFrame)
        let header = UIView(frame: CGRect(x: 16, y: 64, width: 44, height: 44))
        container.install(navigation, id: "bottom-navigation", group: nil)
        container.install(dock, id: "agent-dock", group: nil)
        container.install(header, id: "chat-history-toggle", group: nil)
        var fence = HushhNativeNavigationScrollState()
        for (sequence, progress) in [(1, 0.5), (2, 1.0), (3, 0.25)] {
            let offset = try XCTUnwrap(fence.apply(generation: 0, sequence: sequence, progress: progress, travel: 55))
            let navigationOffset = offset + CGFloat(progress) * 34
            container.setBottomChromeScrollOffset(offset, navigationOffset: navigationOffset)
            XCTAssertEqual(navigation.transform.ty, navigationOffset, accuracy: 0.001)
            XCTAssertEqual(dock.transform.ty, offset, accuracy: 0.001, "The dock retains home-indicator clearance")
            if progress == 1 {
                XCTAssertGreaterThanOrEqual(navigation.frame.minY, web.bounds.maxY,
                    "A fully scrolled tab bar must leave the viewport, including its safe area")
                XCTAssertLessThanOrEqual(dock.frame.maxY, web.bounds.maxY - 34,
                    "Hiding navigation must not move the dock into the home-indicator area")
            }
            XCTAssertTrue(header.transform.isIdentity, "Bottom movement cannot move shell header controls")
            XCTAssertEqual(container.restingBottomChromeFrame("bottom-navigation"), navigationFrame)
            XCTAssertEqual(container.restingBottomChromeFrame("agent-dock"), dockFrame,
                "A later layout receipt must not include or accumulate scroll displacement")
        }
        XCTAssertNil(fence.apply(generation: 0, sequence: 2, progress: 0.5, travel: 55))
        XCTAssertNil(fence.apply(generation: 0, sequence: 4, progress: .nan, travel: 55))
        XCTAssertNil(fence.apply(generation: 0, sequence: 4, progress: 1, travel: 161))
        // A pre-keyboard/pre-overlay sample remains stale after that surface
        // has closed; a current document/state revision alone is insufficient.
        fence.invalidate()
        XCTAssertNil(fence.apply(generation: 0, sequence: 999, progress: 1, travel: 55))
        let offset = try XCTUnwrap(fence.apply(generation: 1, sequence: 1, progress: 0, travel: 55))
        container.setBottomChromeScrollOffset(offset)
        XCTAssertTrue(navigation.transform.isIdentity)
        XCTAssertTrue(dock.transform.isIdentity)
        container.setBottomChromeScrollOffset(30)
        container.remove("agent-dock")
        let replacement = UIView(frame: dockFrame)
        container.install(replacement, id: "agent-dock", group: nil)
        XCTAssertEqual(replacement.transform.ty, navigation.transform.ty, accuracy: 0.001)
        XCTAssertEqual(container.restingBottomChromeFrame("agent-dock"), dockFrame)
        XCTAssertFalse(container.hitTest(CGPoint(x: 30, y: 740), with: nil) === replacement,
            "Scroll presentation must not grant operation admission to a new host")
    }

    @MainActor
    func testDockFollowsKeyboardLayoutWithoutAnotherApplyAndVoiceReleasesTheLift() {
        let parent = UIView(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let window = UIWindow(frame: parent.bounds)
        let controller = UIViewController(); controller.view = parent
        window.rootViewController = controller; window.isHidden = false
        defer { window.isHidden = true }
        let dock = UIView(); parent.addSubview(dock)
        let keyboard = UILayoutGuide(); parent.addLayoutGuide(keyboard)
        let top = keyboard.topAnchor.constraint(equalTo: parent.topAnchor, constant: 844)
        NSLayoutConstraint.activate([top, keyboard.leadingAnchor.constraint(equalTo: parent.leadingAnchor),
            keyboard.widthAnchor.constraint(equalTo: parent.widthAnchor), keyboard.heightAnchor.constraint(equalToConstant: 0)])
        let placement = NativeDockPlacement(parent: parent, dock: dock, keyboard: keyboard)
        let frame = CGRect(x: 16, y: 700, width: 358, height: 52)
        XCTAssertTrue(placement.update(frame: frame, height: 52, editing: true))
        parent.layoutIfNeeded()
        XCTAssertEqual(dock.frame.maxY, 752, accuracy: 0.5)
        for _ in 0..<10 {
            XCTAssertFalse(placement.update(frame: frame, height: 52, editing: true),
                "A settled host layout must not schedule another dock layout")
            parent.layoutIfNeeded()
        }
        var receipts = NativeDockLayoutState()
        XCTAssertTrue(receipts.record(dock.frame, update: 1, privacy: 0))
        XCTAssertEqual(receipts.sequence, 1)
        top.constant = 500 // No bridge apply or web resize occurs here.
        parent.layoutIfNeeded()
        XCTAssertEqual(dock.frame.maxY, 492, accuracy: 0.5)
        XCTAssertEqual(dock.frame.height, 52, accuracy: 0.5)
        XCTAssertTrue(receipts.record(dock.frame, update: 1, privacy: 0))
        XCTAssertEqual(receipts.sequence, 2) // Equal height does not hide occlusion movement.
        XCTAssertFalse(receipts.record(dock.frame, update: 1, privacy: 0))
        XCTAssertFalse(placement.update(frame: frame, height: 52, editing: true),
            "Keyboard-guide movement is system-owned, not another bridge apply")
        XCTAssertTrue(placement.update(frame: frame, height: 52, editing: false))
        parent.layoutIfNeeded()
        XCTAssertEqual(dock.frame.maxY, 752, accuracy: 0.5)
        XCTAssertTrue(receipts.record(dock.frame, update: 1, privacy: 0))
    }

    @MainActor
    func testDockRetainsEditorAndSelectionAcrossVoiceAndThemeUpdates() throws {
        guard #available(iOS 26.0, *) else { throw XCTSkip("Native dock requires iOS 26") }
        let model = NativeDockModel()
        model.mode = "text"; model.visible = true; model.interactionEnabled = true; model.editable = true
        model.micEnabled = true; model.sendEnabled = true
        model.placeholder = "Message One"
        let host = UIHostingController(rootView: NativeAgentDockView(model: model))
        host.safeAreaRegions = []
        host.view.backgroundColor = .clear
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let parent = UIViewController()
        let container = NativePresentationContainer(
            webView: WKWebView(frame: window.bounds), basePresentation: .contentBacked)
        parent.view = container
        parent.view.backgroundColor = .systemBackground
        window.rootViewController = parent; window.isHidden = false
        parent.addChild(host); container.install(host.view, id: "agent-dock", group: nil); host.didMove(toParent: parent)
        host.view.frame = CGRect(x: 16, y: 700, width: 358, height: 100)
        defer { model.clear(); host.view.removeFromSuperview(); host.removeFromParent(); window.isHidden = true }
        host.view.layoutIfNeeded()
        XCTAssertEqual(host.sizeThatFits(in: CGSize(width: 358, height: 340)).height, 68, accuracy: 1,
            "The compact editor and trailing action share a 68-point Agent Bar without nested glass")
        let editor = try XCTUnwrap(model.editor)
        XCTAssertFalse(editor.placeholderLabel.isHidden)
        XCTAssertEqual(editor.placeholderLabel.font, editor.font)
        XCTAssertEqual(editor.placeholderLabel.frame.minX, editor.textContainerInset.left, accuracy: 0.5)
        XCTAssertEqual(editor.placeholderLabel.frame.midY,
            editor.caretRect(for: editor.beginningOfDocument).midY, accuracy: 1)
        if ProcessInfo.processInfo.environment["HUSHH_DOCK_SYNTHETIC_VISUALS"] == "1" {
            // Only this opaque, synthetic window: never capture the app's
            // WebView, a reviewer session, or a private native dock.
            let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
            let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
            window.windowScene = scene
            let web = WKWebView(frame: window.bounds)
            let composition = NativePresentationContainer(webView: web, basePresentation: .contentBacked)
            parent.view = composition
            composition.install(host.view, id: "agent-dock", group: nil)
            let column = try XCTUnwrap(HushhNativeNavigationColumn(projection: ["x": 16.0,
                "width": 358.0, "contentHeight": 52.0, "viewportWidth": 390.0]))
            let bar = UITabBar(frame: try XCTUnwrap(column.frame(in: composition, webView: web, bottomInset: 34)))
            bar.itemPositioning = .fill
            bar.items = try XCTUnwrap(HushhNativeNavigationArtwork.items())
            bar.selectedItem = bar.items?.first
            composition.install(bar, id: "bottom-navigation", group: nil)
            let button = UIHostingController(rootView: NativeChromeButton(label: "Open chat history",
                controlId: "chat-history-toggle", symbol: "line.3.horizontal",
                theme: HushhNativeControlAppearance(appearance: "light", accentHex: "#007aff", foregroundHex: "#222222")!,
                action: {}, layout: { _ in }, focus: ChromeFocusRequest()))
            button.safeAreaRegions = []; button.view.backgroundColor = .clear
            parent.addChild(button)
            composition.install(button.view, id: "chat-history-toggle", group: nil)
            button.didMove(toParent: parent)
            button.view.frame = CGRect(x: 16, y: 64, width: 44, height: 44)
            window.makeKeyAndVisible()
            defer {
                button.willMove(toParent: nil); button.view.removeFromSuperview(); button.removeFromParent()
                window.isHidden = true; previousKeyWindow?.makeKeyAndVisible()
            }
            host.view.frame = CGRect(x: 16, y: 682, width: 358, height: 68)
            for style in [UIUserInterfaceStyle.light, .dark] {
                parent.overrideUserInterfaceStyle = style
                host.overrideUserInterfaceStyle = style
                button.overrideUserInterfaceStyle = style; bar.overrideUserInterfaceStyle = style
                let dark = style == .dark
                composition.setCanvas(dark ? UIColor(red: 0.055, green: 0.055, blue: 0.063, alpha: 1) : .systemGroupedBackground, appearance: style)
                // Opaque, synthetic page content only. Capturing the entire
                // attached test window includes the effect's real backdrop.
                web.loadHTMLString("""
                    <meta name="viewport" content="width=device-width,initial-scale=1"><style>
                    body{margin:0;background:\(dark ? "#0e0e10" : "#f2f2f7");color:\(dark ? "#f5f5f7" : "#222");font:16px -apple-system}
                    main{padding:128px 16px 0}h1{font-size:28px}section{height:160px;border-radius:20px;padding:16px;background:linear-gradient(135deg,#64c7f0,#8f7aef);margin:16px 0}
                    </style><main><h1>Native material study</h1><p>Synthetic public content</p><section>Page-backed glass</section><section>Shared Hussh geometry</section><section>Content continues beneath the dock</section></main>
                    """, baseURL: nil)
                let loaded = expectation(for: NSPredicate { _, _ in !web.isLoading }, evaluatedWith: web)
                wait(for: [loaded], timeout: 5)
                for accent in ["#007aff", "#d4a574"] {
                    let theme = HushhNativeControlAppearance(appearance: dark ? "dark" : "light",
                        accentHex: accent, foregroundHex: dark ? "#f5f5f7" : "#222222")!
                    model.accent = theme.accent; bar.tintColor = theme.accent; bar.unselectedItemTintColor = .label
                    model.accentForeground = HushhNativeControlAppearance.color(dark && accent == "#d4a574" ? "#1d1d1f" : "#ffffff")!
                    button.rootView = NativeChromeButton(label: "Open chat history", controlId: "chat-history-toggle",
                        symbol: "line.3.horizontal", theme: theme, action: {}, layout: { _ in }, focus: ChromeFocusRequest())
                    for mode in ["text", "voice"] {
                        model.mode = mode
                        model.placeholder = mode == "text" ? "Message One" : "Talk to One"
                        RunLoop.main.run(until: Date().addingTimeInterval(0.2))
                        host.view.layoutIfNeeded()
                        var rendered = false
                        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                            rendered = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
                        }
                        XCTAssertTrue(rendered, "Synthetic visual capture must reach an attached native presentation")
                        let attachment = XCTAttachment(image: image)
                        attachment.name = "synthetic-material-\(dark ? "dark" : "light")-\(accent == "#007aff" ? "blue" : "gold")-\(mode)"
                        attachment.lifetime = .keepAlways
                        add(attachment)
                    }
                }
            }
            model.mode = "text"; model.placeholder = "Message One"
        }
        model.text = "Hello 👋"
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        host.view.layoutIfNeeded()
        XCTAssertTrue(editor.placeholderLabel.isHidden)
        editor.selectedRange = NSRange(location: 2, length: 2)
        for mode in ["voice", "text", "voice", "text"] {
            model.mode = mode
            model.editorLabel = mode == "voice" ? "Message One" : "Message Puppy"
            model.accent = UIColor.label
            host.overrideUserInterfaceStyle = .dark
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
            host.view.layoutIfNeeded()
            XCTAssertTrue(model.editor === editor)
            XCTAssertEqual(editor.accessibilityLabel, model.editorLabel,
                "The retained editor must identify the applied authored port, not the earlier selector choice")
            XCTAssertEqual(editor.text, "Hello 👋")
            XCTAssertEqual(editor.selectedRange, NSRange(location: 2, length: 2))
        }
        // Return is ordinary editing, not Send. IME is owned by UITextView.
        XCTAssertTrue(editor.delegate?.textView?(editor, shouldChangeTextIn: NSRange(location: 0, length: 0), replacementText: "\n") == true)
        var sends = 0
        editor.submit = { sends += 1 }
        XCTAssertTrue(editor.becomeFirstResponder())
        model.interactionEnabled = false
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        host.view.layoutIfNeeded()
        XCTAssertTrue(editor.isFirstResponder, "Temporary admission revocation must not dismiss the system keyboard")
        XCTAssertTrue(model.editor === editor)
        XCTAssertFalse(editor.delegate?.textView?(editor, shouldChangeTextIn: NSRange(location: 0, length: 0), replacementText: "x") == true)
        var blockedEvents = 0
        model.emit = { _, _, _, _, _ in blockedEvents += 1 }
        XCTAssertFalse(editor.delegate?.textView?(editor, shouldChangeTextIn: NSRange(location: 0, length: 0), replacementText: String(repeating: "x", count: 1200)) == true)
        model.action("send")
        XCTAssertEqual(blockedEvents, 0)
        model.interactionEnabled = true
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        let selected = editor.selectedRange
        let escape = try XCTUnwrap(editor.keyCommands?.first { $0.input == UIKeyCommand.inputEscape })
        XCTAssertTrue(escape.wantsPriorityOverSystemBehavior, "Escape must reach the idle editor before UIKit focus consumes it")
        editor.perform(escape.action, with: escape)
        XCTAssertFalse(editor.isFirstResponder)
        XCTAssertEqual(editor.text, "Hello 👋")
        XCTAssertEqual(editor.selectedRange, selected)
        XCTAssertEqual(sends, 0)
        // Actual overlay admission must release native focus independently of
        // a queued React/plugin apply, without destroying the retained draft.
        XCTAssertTrue(editor.becomeFirstResponder())
        XCTAssertTrue(container.setRegions(document: "synthetic", revision: 1,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: false))
        XCTAssertTrue(editor.isFirstResponder, "Compatible geometry must retain editing")
        XCTAssertTrue(container.setRegions(document: "synthetic", revision: 2,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: true))
        XCTAssertFalse(editor.isFirstResponder, "Confirmed modal admission must release native editor focus")
        XCTAssertTrue(model.editor === editor)
        XCTAssertEqual(editor.text, "Hello 👋")
        XCTAssertEqual(editor.selectedRange, selected)
        XCTAssertTrue(container.setRegions(document: "synthetic", revision: 3,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: false))
        XCTAssertTrue(editor.becomeFirstResponder())
        XCTAssertFalse(container.setRegions(document: "synthetic", revision: 2,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: true))
        XCTAssertTrue(editor.isFirstResponder, "Rejected stale coverage cannot interrupt resumed editing")
        editor.resignFirstResponder()
        model.awaitingConsumption = true
        model.consumeText()
        XCTAssertFalse(editor.placeholderLabel.isHidden,
            "Committed consumption restores the empty-editor label synchronously, not after another React/native update")
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        host.view.layoutIfNeeded()
        XCTAssertFalse(editor.isEditable) // An uncertain Send cannot overwrite the unsent owner draft.
        model.awaitingConsumption = false; model.text = "Restored unsent draft"
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        host.view.layoutIfNeeded()
        XCTAssertTrue(editor.isEditable)
        XCTAssertTrue(model.editor === editor)
        XCTAssertEqual(editor.text, "Restored unsent draft")
        model.awaitingTransition = true
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        host.view.layoutIfNeeded()
        XCTAssertFalse(editor.isEditable)
        model.awaitingTransition = false
    }

    func testDockEditsSurviveAppearanceEchoButActionsRequireCurrentSnapshot() {
        var fence = HushhDockFence()
        let identity = HushhDockFence.Identity(document: "dock-doc", owner: "owner-a", revision: 1)
        XCTAssertTrue(fence.apply(identity, sequence: 1))
        fence.edited()
        let edit = fence.emitted(kind: "edit")
        let oldSend = fence.emitted(kind: "action")
        XCTAssertTrue(fence.apply(identity, sequence: 2))
        XCTAssertTrue(fence.confirm(identity, sequence: edit, applied: 1, editRevision: 1, kind: "edit", allowed: true))
        XCTAssertFalse(fence.confirm(identity, sequence: oldSend, applied: 1, editRevision: 1, kind: "action", allowed: true))
        let send = fence.emitted(kind: "action")
        XCTAssertFalse(fence.confirm(identity, sequence: send, applied: 2, editRevision: 1, kind: "edit", allowed: true))
        XCTAssertTrue(fence.confirm(identity, sequence: send, applied: 2, editRevision: 1, kind: "action", allowed: true))
        XCTAssertFalse(fence.confirm(identity, sequence: send, applied: 2, editRevision: 1, kind: "action", allowed: true))
    }

    func testDockOwnerRetirementAndPrivacyCannotAuthorizeAnEarlierChoice() {
        var fence = HushhDockFence()
        let old = HushhDockFence.Identity(document: "dock-doc", owner: "owner-a", revision: 1)
        let next = HushhDockFence.Identity(document: "dock-doc", owner: "owner-b", revision: 2)
        var pending = HushhDockFence()
        XCTAssertFalse(pending.retire(old), "Withdrawal before apply has no installed host to detach")
        XCTAssertFalse(pending.apply(old, sequence: 1), "A delayed first apply cannot resurrect a withdrawn editor")
        XCTAssertTrue(pending.apply(next, sequence: 1), "A newer owner revision is not the withdrawn lease")
        XCTAssertFalse(pending.retire(old))
        XCTAssertEqual(pending.identity, next, "Late withdrawal cannot remove the successor")
        XCTAssertTrue(fence.apply(old, sequence: 1))
        let choice = fence.emitted(kind: "action")
        XCTAssertFalse(fence.confirm(old, sequence: choice, applied: 1, editRevision: 0, kind: "action", allowed: false))
        XCTAssertTrue(fence.retire(old))
        XCTAssertFalse(fence.apply(old, sequence: 2))
        XCTAssertTrue(fence.apply(next, sequence: 1))
        let coveredChoice = fence.emitted(kind: "action", action: "send")
        fence.invalidateChoices()
        XCTAssertEqual(fence.identity, next)
        XCTAssertEqual(fence.edit, 0, "Coverage cannot discard or manufacture an editor revision")
        XCTAssertFalse(fence.confirm(next, sequence: coveredChoice, applied: 1, editRevision: 0, kind: "action", allowed: true),
            "Uncovering cannot revive a pre-drawer Send")
        XCTAssertFalse(fence.confirm(old, sequence: choice, applied: 1, editRevision: 0, kind: "action", allowed: true))
        XCTAssertFalse(fence.retire(old))
        XCTAssertEqual(fence.identity, next)
        XCTAssertTrue(fence.retire(next))
        let nextDocument = HushhDockFence.Identity(document: "next-doc", owner: "owner-b", revision: 1)
        XCTAssertTrue(fence.apply(nextDocument, sequence: 1), "A new document starts its own revision sequence after confirmed retirement")
        XCTAssertFalse(fence.apply(.init(document: "dock-doc", owner: "owner-a", revision: 3), sequence: 2),
            "The earlier document cannot regain its private editor")
    }

    func testDockConsumesConfirmedSendOnceButNeverDiscardsAnInterveningEdit() {
        var fence = HushhDockFence()
        let identity = HushhDockFence.Identity(document: "dock-doc", owner: "owner-a", revision: 1)
        XCTAssertTrue(fence.apply(identity, sequence: 1))
        fence.edited()
        let send = fence.emitted(kind: "action", action: "send")
        XCTAssertTrue(fence.confirm(identity, sequence: send, applied: 1, editRevision: 1, kind: "action", allowed: true))
        XCTAssertTrue(fence.consume(identity, sequence: send, editRevision: 1, allowed: true))
        XCTAssertEqual(fence.edit, 2)
        XCTAssertFalse(fence.consume(identity, sequence: send, editRevision: 1, allowed: true))
        fence.edited()
        let next = fence.emitted(kind: "action", action: "send")
        XCTAssertTrue(fence.confirm(identity, sequence: next, applied: 1, editRevision: 3, kind: "action", allowed: true))
        fence.edited() // A later keystroke before the acknowledgement.
        XCTAssertFalse(fence.consume(identity, sequence: next, editRevision: 3, allowed: true))
        let open = fence.emitted(kind: "action", action: "attachment-edit")
        XCTAssertTrue(fence.confirm(identity, sequence: open, applied: fence.update, editRevision: fence.edit, kind: "action", allowed: true))
        XCTAssertTrue(fence.admitsEditingTransition(identity, sequence: open, editRevision: fence.edit))
        let editAtOpen = fence.edit
        fence.edited()
        XCTAssertFalse(fence.admitsEditingTransition(identity, sequence: open, editRevision: editAtOpen))
        XCTAssertEqual(fence.edit, editAtOpen + 1, "Refusing a stale transition must preserve the intervening keystroke")
    }

    #if DEBUG
    @MainActor
    func testNativeContinuityStillObservesNewFramesAndGapsAfterALongWarmSession() {
        let probe = NativeBackContinuityProbe(host: UIView())
        for _ in 0..<100_000 { probe.recordFrame(isMissing: true) }
        let baseline = probe.sampledFrames
        let missingBaseline = probe.missingFrames
        probe.recordFrame(isMissing: true)
        XCTAssertEqual(probe.sampledFrames - baseline, 1, "A long warm session must still prove fresh sampling")
        XCTAssertEqual(probe.missingFrames - missingBaseline, 1, "A newly missing control must remain observable")
    }

    func testPublicLayoutObservationsRejectInactiveShieldedAndSupersededSamples() {
        typealias Snapshot = HushhSessionPrivacyShield.Snapshot
        let admitted = Snapshot(shielded: false, generation: 7, cause: "inactive", appIsActive: true)
        XCTAssertTrue(NativeVaultLayoutProbe.acceptsSample(captured: admitted, current: admitted))
        let refused = [
            Snapshot(shielded: true, generation: 7, cause: "inactive", appIsActive: true),
            Snapshot(shielded: false, generation: 7, cause: "inactive", appIsActive: false),
            Snapshot(shielded: false, generation: 8, cause: "inactive", appIsActive: true),
        ]
        for snapshot in refused {
            XCTAssertFalse(NativeVaultLayoutProbe.acceptsSample(captured: admitted, current: snapshot))
            XCTAssertFalse(NativeVaultLayoutProbe.acceptsSample(captured: snapshot, current: admitted))
        }
    }
    #endif

    @MainActor
    func testNativeChromeKeepsKeyboardFenceUntilCurrentDismissalCompletes() async {
        let plugin = HushhNativeChromePlugin()
        plugin.load()
        let ready = expectation(description: "Native lifecycle observers registered")
        DispatchQueue.main.async { ready.fulfill() }
        // load() registers on the main queue. Yield the actor so registration
        // can complete before asserting the synchronous keyboard fence.
        await fulfillment(of: [ready], timeout: 1)
        #if DEBUG
        let invalidations = plugin.presentationInvalidations
        #endif
        let notifications = NotificationCenter.default
        notifications.post(name: UIResponder.keyboardWillShowNotification, object: nil)
        XCTAssertTrue(plugin.keyboardVisible)
        notifications.post(name: UIResponder.keyboardWillHideNotification, object: nil)
        XCTAssertTrue(plugin.keyboardVisible, "The closing keyboard still owns presentation until completion")
        notifications.post(name: UIResponder.keyboardDidHideNotification, object: nil)
        XCTAssertFalse(plugin.keyboardVisible)
        // Reopening interrupts an older dismissal. Its late completion cannot
        // admit controls beneath the newly visible keyboard.
        notifications.post(name: UIResponder.keyboardWillShowNotification, object: nil)
        notifications.post(name: UIResponder.keyboardWillHideNotification, object: nil)
        notifications.post(name: UIResponder.keyboardWillShowNotification, object: nil)
        notifications.post(name: UIResponder.keyboardDidHideNotification, object: nil)
        XCTAssertTrue(plugin.keyboardVisible)
        notifications.post(name: UIResponder.keyboardWillHideNotification, object: nil)
        notifications.post(name: UIResponder.keyboardDidHideNotification, object: nil)
        XCTAssertFalse(plugin.keyboardVisible)
        #if DEBUG
        XCTAssertEqual(plugin.presentationInvalidations, invalidations,
            "A keyboard cycle must not retire presentation or notify React to replace its native controls")
        notifications.post(name: UIApplication.willResignActiveNotification, object: nil)
        XCTAssertGreaterThan(plugin.presentationInvalidations, invalidations,
            "Privacy still retires the protected presentation immediately")
        #endif
    }

    @MainActor
    func testNativeNavigationDoesNotReadmitDuringAnInterruptedKeyboardDismissal() {
        let plugin = HushhNativeNavigationPlugin()
        plugin.load()
        let ready = expectation(description: "Navigation lifecycle registered")
        DispatchQueue.main.async { ready.fulfill() }
        wait(for: [ready], timeout: 1)
        let center = NotificationCenter.default
        center.post(name: UIResponder.keyboardWillShowNotification, object: nil)
        center.post(name: UIResponder.keyboardWillHideNotification, object: nil)
        XCTAssertTrue(plugin.keyboardVisible)
        center.post(name: UIResponder.keyboardWillShowNotification, object: nil)
        center.post(name: UIResponder.keyboardDidHideNotification, object: nil)
        XCTAssertTrue(plugin.keyboardVisible)
        center.post(name: UIResponder.keyboardWillHideNotification, object: nil)
        center.post(name: UIResponder.keyboardDidHideNotification, object: nil)
        XCTAssertFalse(plugin.keyboardVisible)
    }

    @MainActor
    func testHiddenSegmentedPickerReportsItsReservedGeometryBeforeInteraction() throws {
        guard #available(iOS 26.0, *) else { throw XCTSkip("Liquid Glass family requires iOS 26") }
        let measured = expectation(description: "Actual SwiftUI geometry equals the reserved slot")
        measured.assertForOverFulfill = false
        let theme = HushhNativeControlAppearance(appearance: "light", accentHex: "#007aff", foregroundHex: "#222222")!
        let host = UIHostingController(rootView: NativeAgentSurfaceSelector(selected: "one", width: 88,
            theme: theme, action: { _ in XCTFail("Hidden preparation cannot choose a value") },
            layout: { size in if size == CGSize(width: 88, height: 44) { measured.fulfill() } }))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let parent = UIViewController()
        window.rootViewController = parent
        window.isHidden = false
        defer { window.isHidden = true }
        parent.addChild(host)
        host.view.isHidden = true
        host.view.isUserInteractionEnabled = false
        host.safeAreaRegions = []
        parent.view.addSubview(host.view)
        host.view.frame = CGRect(x: 280, y: 60, width: 88, height: 44)
        host.didMove(toParent: parent)
        host.view.setNeedsLayout()
        host.view.layoutIfNeeded()
        wait(for: [measured], timeout: 2)
        XCTAssertEqual(host.view.bounds.size, CGSize(width: 88, height: 44))
        XCTAssertFalse(host.view.isUserInteractionEnabled)
    }

    func testNativeControlAppearanceRejectsMalformedProjectionAndDecodesCSSAlphaLast() {
        let theme = HushhNativeControlAppearance(appearance: "dark", accentHex: "#123", foregroundHex: "#44556680")
        XCTAssertEqual(theme?.style, .dark)
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        XCTAssertTrue(theme!.foreground.getRed(&r, green: &g, blue: &b, alpha: &a))
        XCTAssertEqual(r, 68.0 / 255, accuracy: 0.001)
        XCTAssertEqual(a, 128.0 / 255, accuracy: 0.001)
        XCTAssertTrue(theme!.accent.getRed(&r, green: &g, blue: &b, alpha: &a))
        XCTAssertEqual(b, 51.0 / 255, accuracy: 0.001)
        for bad in ["#123junk", "#123456\n", "#１２３", "red", "var(--app-accent)", "#12", "#123456789", "#gggggg"] {
            XCTAssertNil(HushhNativeControlAppearance(appearance: "dark", accentHex: bad, foregroundHex: "#445566"))
            XCTAssertNil(HushhNativeControlAppearance(appearance: "light", accentHex: "#123456", foregroundHex: bad))
        }
        XCTAssertNil(HushhNativeControlAppearance(appearance: "system", accentHex: "#123456", foregroundHex: "#445566"))
        XCTAssertNil(HushhNativeControlAppearance(appearance: "light", accentHex: nil, foregroundHex: "#445566"))
    }

    func testNativeChromeLeaseRejectsStaleOwnerDocumentAndDuplicateChoices() {
        var state = HushhNativeChromeState()
        let first = HushhNativeChromeState.Identity(document: "a", ownerEpoch: "owner-a", revision: 1)
        XCTAssertTrue(state.prepare(first))
        XCTAssertFalse(state.confirm(first, sequence: 1, latestSequence: 1, allowed: true)) // prepared is not interactive
        XCTAssertTrue(state.activate(first))
        let otherControl = HushhNativeChromeState.Identity(document: "a", ownerEpoch: "owner-a", revision: 1,
                                                          controlId: "chat-agent-surface")
        XCTAssertFalse(state.activate(otherControl))
        XCTAssertFalse(state.confirm(otherControl, sequence: 1, latestSequence: 1, allowed: true))
        XCTAssertFalse(state.confirm(first, sequence: 1, latestSequence: 1, allowed: false)) // privacy/overlay guard
        XCTAssertTrue(state.confirm(first, sequence: 1, latestSequence: 1, allowed: true))
        XCTAssertFalse(state.confirm(first, sequence: 1, latestSequence: 1, allowed: true))
        state.invalidateChoices(through: 2)
        XCTAssertFalse(state.confirm(first, sequence: 2, latestSequence: 2, allowed: true),
            "A pre-drawer choice stays invalid after isolation ends")
        XCTAssertEqual(state.identity, first)
        XCTAssertEqual(state.phase, "active", "Ordinary coverage is not native retirement")
        let replacement = HushhNativeChromeState.Identity(document: "a", ownerEpoch: "owner-a", revision: 2)
        XCTAssertFalse(state.prepareBackReplacement(replacement, previousRevision: 0))
        XCTAssertFalse(state.prepareBackReplacement(.init(document: "a", ownerEpoch: "owner-b", revision: 2), previousRevision: 1))
        XCTAssertFalse(state.prepareBackReplacement(.init(document: "b", ownerEpoch: "owner-a", revision: 2), previousRevision: 1))
        XCTAssertEqual(state.identity, first) // Refusal must not overwrite the predecessor.
        XCTAssertTrue(state.prepareBackReplacement(replacement, previousRevision: 1))
        XCTAssertFalse(state.confirm(first, sequence: 2, latestSequence: 2, allowed: true))
        XCTAssertFalse(state.confirm(replacement, sequence: 2, latestSequence: 2, allowed: true))
        XCTAssertTrue(state.activate(replacement))
        XCTAssertTrue(state.suspend(replacement))
        XCTAssertEqual(state.identity, replacement) // Host identity survives; action authority does not.
        XCTAssertFalse(state.confirm(replacement, sequence: 2, latestSequence: 2, allowed: true))
        XCTAssertFalse(state.update(replacement, sequence: 1))
        XCTAssertFalse(state.activate(replacement)) // A new preparation is required after suspension.
        XCTAssertFalse(state.suspend(first))
        let next = HushhNativeChromeState.Identity(document: "a", ownerEpoch: "owner-b", revision: 3)
        XCTAssertTrue(state.prepare(next))
        XCTAssertFalse(state.activate(first))
        XCTAssertTrue(state.activate(next))
        XCTAssertFalse(state.retire(.init(document: "a", ownerEpoch: "owner-a", revision: 100), targetRevision: 1))
        XCTAssertEqual(state.phase, "active") // old failure cannot remove a replacement
        XCTAssertFalse(state.confirm(first, sequence: 2, latestSequence: 2, allowed: true))
        XCTAssertTrue(state.retire(.init(document: "a", ownerEpoch: "owner-b", revision: 4)))
        XCTAssertFalse(state.prepare(next)) // late uncertain preparation cannot resurrect a retired view
        XCTAssertTrue(state.prepare(.init(document: "b", ownerEpoch: "owner-b", revision: 1)))
        XCTAssertFalse(state.prepare(.init(document: "a", ownerEpoch: "owner-a", revision: 99)))
        state.invalidate()
        XCTAssertFalse(state.activate(next))

        // History shares the state machine, not Back's presentation identity.
        let history = HushhNativeChromeState.Identity(document: "c", ownerEpoch: "owner-a", revision: 1,
                                                       controlId: "chat-history-toggle")
        let historyNext = HushhNativeChromeState.Identity(document: "c", ownerEpoch: "owner-a", revision: 2,
                                                           controlId: "chat-history-toggle")
        XCTAssertTrue(state.prepare(history))
        XCTAssertFalse(state.prepareHistoryReplacement(historyNext, previousRevision: 1)) // prepared only
        XCTAssertTrue(state.activate(history))
        XCTAssertFalse(state.prepareBackReplacement(historyNext, previousRevision: 1)) // wrong family
        XCTAssertFalse(state.prepareHistoryReplacement(.init(document: "c", ownerEpoch: "other", revision: 2,
            controlId: "chat-history-toggle"), previousRevision: 1))
        XCTAssertFalse(state.prepareHistoryReplacement(.init(document: "d", ownerEpoch: "owner-a", revision: 2,
            controlId: "chat-history-toggle"), previousRevision: 1))
        XCTAssertEqual(state.identity, history)
        XCTAssertTrue(state.prepareHistoryReplacement(historyNext, previousRevision: 1))
        XCTAssertFalse(state.confirm(history, sequence: 3, latestSequence: 3, allowed: true))
        XCTAssertFalse(state.confirm(historyNext, sequence: 3, latestSequence: 3, allowed: true))
        XCTAssertTrue(state.activate(historyNext))
        XCTAssertTrue(state.confirm(historyNext, sequence: 3, latestSequence: 3, allowed: true))
        XCTAssertFalse(state.confirm(historyNext, sequence: 3, latestSequence: 3, allowed: true))

        let profile = HushhNativeChromeState.Identity(document: "e", ownerEpoch: "owner-a", revision: 1,
                                                     controlId: "profile-back")
        let profileNext = HushhNativeChromeState.Identity(document: "e", ownerEpoch: "owner-a", revision: 2,
                                                         controlId: "profile-back")
        XCTAssertTrue(state.prepare(profile))
        XCTAssertFalse(state.prepareBackReplacement(profileNext, previousRevision: 1)) // not active
        XCTAssertTrue(state.activate(profile))
        XCTAssertFalse(state.prepareBackReplacement(.init(document: "e", ownerEpoch: "owner-a", revision: 2),
                                                    previousRevision: 1)) // shell cannot inherit Profile's slot
        XCTAssertFalse(state.prepareBackReplacement(.init(document: "e", ownerEpoch: "owner-b", revision: 2,
            controlId: "profile-back"), previousRevision: 1))
        XCTAssertFalse(state.prepareHistoryReplacement(profileNext, previousRevision: 1))
        XCTAssertEqual(state.identity, profile)
        XCTAssertTrue(state.prepareBackReplacement(profileNext, previousRevision: 1))
        XCTAssertFalse(state.confirm(profile, sequence: 4, latestSequence: 4, allowed: true))
        XCTAssertFalse(state.confirm(profileNext, sequence: 4, latestSequence: 4, allowed: true))
        XCTAssertTrue(state.activate(profileNext))
        XCTAssertTrue(state.confirm(profileNext, sequence: 4, latestSequence: 4, allowed: true))
    }

    func testNativeChromeUpdatesFenceOldChoicesWithoutReplacingTheInstallation() {
        var state = HushhNativeChromeState()
        let identity = HushhNativeChromeState.Identity(document: "a", ownerEpoch: "owner-a", revision: 1)
        XCTAssertTrue(state.prepare(identity))
        XCTAssertFalse(state.update(identity, sequence: 1))
        XCTAssertTrue(state.activate(identity))
        XCTAssertTrue(state.update(identity, sequence: 2))
        XCTAssertFalse(state.update(identity, sequence: 1))
        XCTAssertEqual(state.identity, identity)
        XCTAssertFalse(state.confirm(identity, sequence: 1, latestSequence: 1, allowed: true))
        XCTAssertFalse(state.confirm(identity, sequence: 1, latestSequence: 1, allowed: true, updateSequence: 1))
        XCTAssertTrue(state.confirm(identity, sequence: 1, latestSequence: 1, allowed: true, updateSequence: 2))
        XCTAssertFalse(state.confirm(identity, sequence: 1, latestSequence: 1, allowed: true, updateSequence: 2))
        state.invalidate()
        XCTAssertFalse(state.update(identity, sequence: 3))
    }

    func testPublicPreferenceConfigurationRejectsUnknownValuesAndAuthoredOptions() {
        for value in ["light", "dark", "system"] {
            XCTAssertNotNil(HushhChromeConfiguration.parse(kind: "appearance", value: value, options: nil, minimum: nil, maximum: nil))
        }
        let accent = HushhChromeConfiguration.parse(kind: "accent", value: "blue",
            options: [["value": "unknown", "label": "Untrusted label"]], minimum: nil, maximum: nil)
        XCTAssertEqual(accent?.options.map(\.value), ["blue", "gold"])
        for kind in ["appearance", "accent"] {
            for value: String? in [nil, "unknown"] {
                XCTAssertNil(HushhChromeConfiguration.parse(kind: kind, value: value, options: nil, minimum: nil, maximum: nil))
            }
        }
    }

    func testRejectedChromePreparationPreservesActiveOptionsAndDateBounds() {
        var state = HushhNativeChromeState()
        var configuration = HushhChromeConfiguration()
        let active = HushhNativeChromeState.Identity(document: "a", ownerEpoch: "owner-a", revision: 20)
        let admitted = HushhChromeConfiguration.parse(kind: "selection", value: "current",
            options: [["value": "current", "label": "Current"]], minimum: nil, maximum: nil)
        XCTAssertTrue(configuration.prepare(active, parsed: admitted, state: &state))
        XCTAssertTrue(state.activate(active))
        let stale = HushhNativeChromeState.Identity(document: "a", ownerEpoch: "owner-a", revision: 19)
        let replacement = HushhChromeConfiguration.parse(kind: "selection", value: "stale",
            options: [["value": "stale", "label": "Stale"]], minimum: nil, maximum: nil)
        XCTAssertFalse(configuration.prepare(stale, parsed: replacement, state: &state))
        XCTAssertEqual(configuration.options.map(\.value), ["current"])
        XCTAssertEqual(state.identity, active)
        XCTAssertEqual(state.phase, "active")

        let dateIdentity = HushhNativeChromeState.Identity(document: "a", ownerEpoch: "owner-a", revision: 21)
        let date = HushhChromeConfiguration.parse(kind: "date", value: "2026-10-05", options: nil,
            minimum: "2026-10-01", maximum: "2026-10-31")
        XCTAssertTrue(configuration.prepare(dateIdentity, parsed: date, state: &state))
        XCTAssertTrue(state.activate(dateIdentity))
        let bounds = configuration.dateBounds
        let invalid = HushhChromeConfiguration.parse(kind: "date", value: "2026-02-30", options: nil,
            minimum: "2026-10-01", maximum: "2026-10-31")
        let newer = HushhNativeChromeState.Identity(document: "a", ownerEpoch: "owner-a", revision: 22)
        XCTAssertNil(invalid)
        XCTAssertFalse(configuration.prepare(newer, parsed: invalid, state: &state))
        XCTAssertEqual(configuration.dateBounds, bounds)
        XCTAssertEqual(state.identity, dateIdentity)
        XCTAssertEqual(state.phase, "active")
    }

    func testNativeNavigationRequiresCompleteBundledTemplateArtwork() throws {
        let items = try XCTUnwrap(HushhNativeNavigationArtwork.items())
        XCTAssertEqual(items.map(\.accessibilityIdentifier), HushhNativeNavigationState.tabs.map { "one-native-tab-\($0)" })
        for item in items {
            for image in [item.image, item.selectedImage] {
                let image = try XCTUnwrap(image)
                XCTAssertEqual(image.renderingMode, .alwaysTemplate)
                XCTAssertEqual(image.size, CGSize(width: 24, height: 24))
            }
        }
        // Negative control: one missing state must prevent native admission,
        // not produce a blank tab or silently restore a different SF glyph.
        XCTAssertNil(HushhNativeNavigationArtwork.items { name in
            name == "HushhNav-connect-selected" ? nil : UIImage(named: name)
        })
    }

    func testNativeNavigationRejectsStaleUnknownAndRetiredDocumentStates() {
        var state = HushhNativeNavigationState()
        XCTAssertTrue(state.apply(document: "first", revision: 1, visible: true, selected: "chat"))
        XCTAssertTrue(state.acceptsTap("dashboard", appIsActive: true, shielded: false, keyboardVisible: false))
        // Covered presentation is retained; neither direct taps nor VoiceOver
        // admission may navigate underneath the authored interaction layer.
        XCTAssertTrue(state.apply(document: "first", revision: 2, visible: true, selected: "chat", interactionEpoch: 1, interactionEnabled: false))
        XCTAssertTrue(state.isPresented(appIsActive: true, shielded: false, keyboardVisible: false))
        XCTAssertFalse(state.acceptsTap("dashboard", appIsActive: true, shielded: false, keyboardVisible: false))
        XCTAssertFalse(state.isPresented(appIsActive: true, shielded: true, keyboardVisible: false))
        XCTAssertFalse(state.isPresented(appIsActive: false, shielded: false, keyboardVisible: false))
        XCTAssertFalse(state.isPresented(appIsActive: true, shielded: false, keyboardVisible: true))
        XCTAssertTrue(state.apply(document: "first", revision: 3, visible: false, selected: "feed"))
        XCTAssertFalse(state.apply(document: "first", revision: 2, visible: true, selected: "chat"))
        XCTAssertFalse(state.apply(document: "first", revision: 4, visible: true, selected: "arbitrary-route"))
        XCTAssertFalse(state.acceptsTap("chat", appIsActive: true, shielded: false, keyboardVisible: false))
        state.retireDocument()
        XCTAssertFalse(state.apply(document: "first", revision: 5, visible: true, selected: "chat"))
        XCTAssertTrue(state.apply(document: "second", revision: 1, visible: true, selected: "dashboard"))
        XCTAssertFalse(state.acceptsTap("chat", appIsActive: false, shielded: false, keyboardVisible: false))
        XCTAssertFalse(state.acceptsTap("chat", appIsActive: true, shielded: true, keyboardVisible: false))
        XCTAssertFalse(state.acceptsTap("chat", appIsActive: true, shielded: false, keyboardVisible: true))
    }
    @MainActor
    func testNativeNavigationConsumesTheShellColumnWithPaddingAndOneSafeArea() throws {
        for width: CGFloat in [320, 393, 430, 862] {
            let host = UIView(frame: CGRect(x: 0, y: 0, width: width, height: 844))
            let web = UIView(frame: host.bounds)
            host.addSubview(web)
            let bar = UITabBar()
            host.addSubview(bar)
            let columnWidth = min(width - 32, 760)
            let left = (width - columnWidth) / 2
            let column = try XCTUnwrap(HushhNativeNavigationColumn(projection: [
                "x": Double(left), "width": Double(columnWidth), "contentHeight": 52.0, "viewportWidth": Double(width),
            ]))
            for bottom: CGFloat in [0, 21, 34] {
                bar.frame = try XCTUnwrap(column.frame(in: host, webView: web, bottomInset: bottom))
                bar.layoutIfNeeded()
                XCTAssertEqual(bar.frame.minX + 22, left, accuracy: 0.5)
                XCTAssertEqual(bar.frame.width - 44, columnWidth, accuracy: 0.5)
                XCTAssertEqual(bar.frame.height - bottom, 52, accuracy: 0.5)
                XCTAssertGreaterThanOrEqual(bar.frame.height - bottom - 49, 3)
                XCTAssertEqual(bar.frame.maxY, host.bounds.maxY, accuracy: 0.5)
            }
            // Native layout/foreground/tap boundaries revalidate the same
            // projection while a resize is ahead of the WebView's next update.
            host.bounds.size.width = 200
            XCTAssertNil(column.frame(in: host, webView: web, bottomInset: 34))
        }
        for malformed: JSObject in [
            ["x": -1, "width": 361, "contentHeight": 64, "viewportWidth": 393],
            ["x": 16, "width": 393, "contentHeight": 64, "viewportWidth": 393],
            ["x": 16, "width": 361, "contentHeight": 200, "viewportWidth": 393],
            ["x": 16, "width": Double.nan, "contentHeight": 64, "viewportWidth": 393],
        ] { XCTAssertNil(HushhNativeNavigationColumn(projection: malformed)) }
    }

    @MainActor
    func testNativePublicPreferencePresentationKeepsTheValueInItsControl() throws {
        guard #available(iOS 17.0, *) else {
            XCTAssertTrue(HushhNativePreferencePresentation.families.isEmpty); return
        }
        XCTAssertEqual(HushhNativePreferencePresentation.families(for: .phone), ["appearance", "accent"])
        XCTAssertFalse(HushhNativePreferencePresentation.families.contains("agent-surface"))
        let theme = try XCTUnwrap(HushhNativeControlAppearance(appearance: "light", accentHex: "#007aff", foregroundHex: "#222222"))
        let focus = ChromeFocusRequest()
        for kind in ["appearance", "accent"] {
            XCTAssertTrue(HushhNativePreferencePresentation.admitsWidth(172, kind: kind))
            XCTAssertFalse(HushhNativePreferencePresentation.admitsWidth(120, kind: kind))
            XCTAssertFalse(HushhNativePreferencePresentation.admitsWidth(321, kind: kind))
            let control = try XCTUnwrap(HushhNativePreferencePresentation.control(kind: kind, value: kind == "accent" ? "gold" : "system", width: 172, theme: theme, focus: focus, select: { _ in }, open: {}, layout: { _ in }))
            let controller = UIHostingController(rootView: control)
            controller.loadViewIfNeeded()
            controller.view.frame = CGRect(x: 0, y: 0, width: 172, height: 44)
            controller.view.layoutIfNeeded()
            XCTAssertEqual(controller.sizeThatFits(in: CGSize(width: 172, height: 44)), CGSize(width: 172, height: 44))
        }
    }
    @MainActor
    func testNativePublicPreferenceHostAdmissionSupportsPhoneAndPadOnly() {
        guard #available(iOS 17.0, *) else {
            XCTAssertTrue(HushhNativePreferencePresentation.families.isEmpty); return
        }
        let phoneFamilies = ["appearance", "accent"]
        XCTAssertEqual(HushhNativePreferencePresentation.families(for: .phone), phoneFamilies)
        XCTAssertEqual(HushhNativePreferencePresentation.families(for: .pad), phoneFamilies)
        for idiom in [UIUserInterfaceIdiom.unspecified, .tv, .carPlay, .mac] {
            XCTAssertTrue(HushhNativePreferencePresentation.families(for: idiom).isEmpty)
        }
        XCTAssertFalse(phoneFamilies.contains("back"))
        XCTAssertFalse(phoneFamilies.contains("agent-surface"))
        let expected = [UIUserInterfaceIdiom.phone, .pad].contains(UIDevice.current.userInterfaceIdiom) ? phoneFamilies : []
        XCTAssertEqual(HushhNativePreferencePresentation.families, expected)
    }
    func testAppleReauthenticationQuarantinesFirebaseCallbacksAfterProviderDrains() {
        for stage in [AppleIdentityCallbackDrain.Stage.reauthentication, .token] {
            let fence = GoogleIdentityReauthenticationFence(expectedUserID: "owner", now: 100)
            let callbacks = AppleIdentityCallbackDrain()
            XCTAssertTrue(fence.drainProvider())
            XCTAssertTrue(callbacks.begin(stage))
            XCTAssertTrue(fence.settle()) // Timeout or owner change rejects JS now.
            XCTAssertTrue(fence.canRelease) // Provider alone no longer owns the slot.
            XCTAssertFalse(callbacks.canRelease(fence)) // Firebase still does.
            let otherStage: AppleIdentityCallbackDrain.Stage = stage == .token ? .reauthentication : .token
            XCTAssertFalse(callbacks.drain(otherStage))
            XCTAssertFalse(callbacks.canRelease(fence))
            XCTAssertTrue(callbacks.drain(stage))
            XCTAssertTrue(callbacks.canRelease(fence))
            XCTAssertFalse(callbacks.drain(stage)) // Duplicate callback cannot drain new work.
            XCTAssertEqual(fence.claim(phase: 0, userID: "owner", sameSession: true, now: 101), .ignored)
        }
    }

    func testGoogleReauthenticationAcceptsEachStageExactlyOnce() {
        let fence = GoogleIdentityReauthenticationFence(expectedUserID: "a", now: 100)
        XCTAssertEqual(fence.claim(phase: 1, userID: "a", sameSession: true, now: 101), .ignored)
        XCTAssertTrue(fence.drainProvider())
        XCTAssertFalse(fence.drainProvider())
        for phase in 0...2 {
            XCTAssertEqual(fence.claim(phase: phase, userID: "a", sameSession: true, now: 101), .accepted)
            XCTAssertEqual(fence.claim(phase: phase, userID: "a", sameSession: true, now: 101), .ignored)
        }
        XCTAssertTrue(fence.settle())
        XCTAssertFalse(fence.settle())
        XCTAssertTrue(fence.canRelease)
        XCTAssertEqual(fence.claim(phase: 3, userID: "a", sameSession: true, now: 101), .ignored)
    }

    func testGoogleReauthenticationRejectsWrongOwnerReplacementAndExpiry() {
        for phase in 0...2 {
            for scenario in 0...3 {
                let fence = GoogleIdentityReauthenticationFence(expectedUserID: "a", now: 100)
                for previous in 0..<phase {
                    XCTAssertEqual(fence.claim(phase: previous, userID: "a", sameSession: true, now: 101), .accepted)
                }
                XCTAssertEqual(fence.claim(
                    phase: phase, userID: scenario == 0 ? "b" : (scenario == 3 ? nil : "a"),
                    sameSession: scenario != 1, now: scenario == 2 ? 220 : 101
                ), .stale)
                XCTAssertTrue(fence.settle())
                XCTAssertEqual(fence.claim(phase: phase, userID: "a", sameSession: true, now: 101), .ignored)
            }
        }
    }

    func testGoogleReauthenticationQuarantinesTimedOutOrCancelledProvider() {
        let old = GoogleIdentityReauthenticationFence(expectedUserID: "a", now: 100)
        XCTAssertTrue(old.settle())
        XCTAssertFalse(old.canRelease) // A timeout cannot free the uncorrelated native slot.
        XCTAssertTrue(old.drainProvider())
        XCTAssertTrue(old.canRelease)
        let next = GoogleIdentityReauthenticationFence(expectedUserID: "a", now: 221)
        XCTAssertEqual(old.claim(phase: 0, userID: "a", sameSession: true, now: 222), .ignored)
        XCTAssertFalse(next.settled)
        XCTAssertEqual(next.phase, 0)
    }

    func testNativeDriveReturnFenceAcceptsOnlyItsCurrentOwnerAndAttempt() {
        let fence = NativeDriveAuthorizationFence(
            expectedUserID: "owner", expectedAttemptID: "attempt_123456789012", expiresAtMilliseconds: 120_000
        )
        XCTAssertEqual(
            fence.claim(attemptID: "other_123456789012", userID: "owner", sameSession: true, now: 101),
            .stale
        )
        XCTAssertFalse(fence.settled)
        XCTAssertEqual(
            fence.claim(attemptID: "attempt_123456789012", userID: "owner", sameSession: true, now: 101),
            .accepted
        )
        XCTAssertTrue(fence.settle())
        XCTAssertEqual(
            fence.claim(attemptID: "attempt_123456789012", userID: "owner", sameSession: true, now: 101),
            .ignored
        )
    }

    func testNativeDriveReturnFenceQuarantinesTimedOutProviderUntilItDrains() {
        let fence = NativeDriveAuthorizationFence(
            expectedUserID: "owner", expectedAttemptID: "attempt_123456789012", expiresAtMilliseconds: 120_000
        )
        XCTAssertTrue(fence.settle())
        XCTAssertFalse(fence.canRelease)
        XCTAssertTrue(fence.drainProvider())
        XCTAssertTrue(fence.canRelease)
    }

    func testNativeDrivePickerFenceDoesNotAcceptAnotherOwnersOrConnectionsReturn() {
        let picker = NativeDriveAuthorizationFence(
            expectedUserID: "owner-a", expectedAttemptID: "picker_1234567890123", expiresAtMilliseconds: 120_000
        )
        XCTAssertEqual(
            picker.claim(attemptID: "attempt_123456789012", userID: "owner-a", sameSession: true, now: 101),
            .stale
        )
        XCTAssertEqual(
            picker.claim(attemptID: "picker_1234567890123", userID: "owner-b", sameSession: false, now: 101),
            .stale
        )
        XCTAssertEqual(
            picker.claim(attemptID: "picker_1234567890123", userID: "owner-a", sameSession: true, now: 101),
            .accepted
        )
        XCTAssertTrue(picker.settle())
        XCTAssertTrue(picker.drainProvider())
        XCTAssertTrue(picker.canRelease)
    }

    func testNativeDriveReturnRejectsExpirySignOutAndReplacedSession() {
        let scenarios: [(String?, Bool, TimeInterval)] = [
            (nil, false, 101), // Signed out while the browser was open.
            ("other-owner", false, 101),
            ("owner", false, 101), // Same UID in a replacement Firebase session.
            ("owner", true, 120), // Callback at the exact deadline is expired.
        ]
        for (userID, sameSession, now) in scenarios {
            let fence = NativeDriveAuthorizationFence(
                expectedUserID: "owner", expectedAttemptID: "attempt_123456789012",
                expiresAtMilliseconds: 120_000
            )
            XCTAssertEqual(
                fence.claim(
                    attemptID: "attempt_123456789012", userID: userID,
                    sameSession: sameSession, now: now
                ),
                .stale
            )
            XCTAssertFalse(fence.settled)
            XCTAssertFalse(fence.canRelease)
        }
    }

    func testNativeDriveConnectionAndPickerReturnsCannotCrossSettle() {
        let connection = NativeDriveAuthorizationFence(
            expectedUserID: "owner", expectedAttemptID: "connect_123456789012",
            expiresAtMilliseconds: 120_000
        )
        let picker = NativeDriveAuthorizationFence(
            expectedUserID: "owner", expectedAttemptID: "picker_1234567890123",
            expiresAtMilliseconds: 120_000
        )
        XCTAssertEqual(
            connection.claim(attemptID: picker.expectedAttemptID, userID: "owner", sameSession: true, now: 101),
            .stale
        )
        XCTAssertEqual(
            picker.claim(attemptID: connection.expectedAttemptID, userID: "owner", sameSession: true, now: 101),
            .stale
        )
        XCTAssertEqual(
            connection.claim(attemptID: connection.expectedAttemptID, userID: "owner", sameSession: true, now: 101),
            .accepted
        )
        XCTAssertTrue(connection.drainProvider())
        XCTAssertFalse(connection.canRelease) // A provider return is not yet terminal settlement.
        XCTAssertTrue(connection.settle())
        XCTAssertFalse(connection.settle()) // Duplicate callback cannot complete twice.
        XCTAssertFalse(connection.drainProvider())
        XCTAssertTrue(connection.canRelease)
        XCTAssertFalse(picker.settled)
    }

    func testNativeDriveCancelledAttemptCannotAuthorizeAfterRestart() {
        let old = NativeDriveAuthorizationFence(
            expectedUserID: "owner", expectedAttemptID: "old_attempt_123456789012",
            expiresAtMilliseconds: 120_000
        )
        XCTAssertTrue(old.settle()) // Native cancellation or activity teardown.
        XCTAssertFalse(old.canRelease) // Keep the old presentation quarantined until it drains.

        let restarted = NativeDriveAuthorizationFence(
            expectedUserID: "owner", expectedAttemptID: "new_attempt_123456789012",
            expiresAtMilliseconds: 240_000
        )
        XCTAssertEqual(
            restarted.claim(attemptID: old.expectedAttemptID, userID: "owner", sameSession: true, now: 121),
            .stale
        )
        XCTAssertEqual(
            old.claim(attemptID: old.expectedAttemptID, userID: "owner", sameSession: true, now: 121),
            .ignored
        )
        XCTAssertTrue(old.drainProvider())
        XCTAssertTrue(old.canRelease)
        XCTAssertEqual(
            restarted.claim(attemptID: restarted.expectedAttemptID, userID: "owner", sameSession: true, now: 121),
            .accepted
        )
        XCTAssertFalse(restarted.settled)
    }

    func testNativeTestConfigurationParsesArguments() {
        let config = NativeTestConfiguration(arguments: [
            "App",
            "-UITestMode",
            "-UITestInitialRoute", "/login?redirect=%2Fconsents",
            "-UITestExpectedMarker", "consent-manager-primary",
            "-UITestAutoReviewerLogin", "true",
        ])

        XCTAssertTrue(config.enabled)
        XCTAssertEqual(config.initialRoute, "/login?redirect=%2Fconsents")
        XCTAssertEqual(config.expectedMarker, "consent-manager-primary")
        XCTAssertTrue(config.autoReviewerLogin)
        XCTAssertTrue(config.resetAppState)

        // Preparation for attach-only reviewer tests must select the normal
        // passphrase surface without signing out, resetting or auto-unlocking.
        let retainedSession = NativeTestConfiguration(arguments: [
            "App", "-UITestMode",
            "-UITestResetAppState", "false",
            "-UITestAutoReviewerLogin", "false",
            "-UITestRunUiFlows", "false",
        ], environment: [:])
        XCTAssertTrue(retainedSession.enabled)
        XCTAssertFalse(retainedSession.resetAppState)
        XCTAssertFalse(retainedSession.autoReviewerLogin)
        XCTAssertFalse(retainedSession.runUiFlows)
        XCTAssertNil(retainedSession.vaultPassphrase)
        XCTAssertNil(retainedSession.expectedUserId)
        XCTAssertNil(retainedSession.initialRoute)
    }

    func testNativeReviewerCredentialsNeverComeFromLaunchArguments() {
        let launch = NativeTestConfiguration(arguments: [
            "App", "-UITestMode", "-UITestVaultPassphrase", "synthetic-argument-value",
        ], environment: [:])
        XCTAssertNil(launch.vaultPassphrase)
        let environment = ["HUSHH_UI_TEST_REVIEWER_VAULT_PASSPHRASE": " synthetic memory value "]
        let admitted = NativeTestConfiguration(arguments: ["App", "-UITestMode"], environment: environment)
        XCTAssertEqual(admitted.vaultPassphrase, " synthetic memory value ")
        let ordinary = NativeTestConfiguration(arguments: ["App"], environment: environment)
        XCTAssertNil(ordinary.vaultPassphrase)
        XCTAssertFalse(ordinary.injectedScript.contains("synthetic memory value"))
    }

    func testNativeUiFlowConfigurationRequiresExplicitTestMode() {
        let ordinaryLaunch = NativeTestConfiguration(arguments: [
            "App",
            "--hushh-vault-layout-diagnostics",
            "-UITestRunUiFlows", "true",
            "-UITestUiFlowRunId", "ios-run-1",
        ])
        let testLaunch = NativeTestConfiguration(arguments: [
            "App",
            "-UITestMode",
            "-UITestRunUiFlows", "true",
            "-UITestUiFlowRunId", "ios-run-1",
        ])

        XCTAssertFalse(ordinaryLaunch.enabled)
        XCTAssertFalse(ordinaryLaunch.autoReviewerLogin)
        XCTAssertNil(ordinaryLaunch.vaultPassphrase)
        XCTAssertNil(ordinaryLaunch.expectedUserId)
        XCTAssertFalse(ordinaryLaunch.runUiFlows)
        XCTAssertNil(ordinaryLaunch.uiFlowRunId)
        XCTAssertTrue(testLaunch.enabled)
        XCTAssertTrue(testLaunch.runUiFlows)
        XCTAssertEqual(testLaunch.uiFlowRunId, "ios-run-1")
    }

    func testNativeUiFlowRoutingOwnershipSurvivesDocumentReload() {
        let config = NativeTestConfiguration(arguments: [
            "App",
            "-UITestMode",
            "-UITestRunUiFlows", "true",
            "-UITestUiFlowRunId", "ios-run-1",
        ])

        XCTAssertTrue(config.injectedScript.contains("hasIncompleteUiFlowSession"))
        XCTAssertTrue(config.injectedScript.contains("bridge._uiFlowsRoutingOwned = uiFlowsOwnRouting"))
        XCTAssertTrue(config.statusJavaScript.contains("bridge._uiFlowsRoutingOwned === true"))
    }

    func testNativeRouterServesPersonProfileShellForArbitraryPublicRefs() {
        var router = HushhNativeRouter()
        router.basePath = "/app/public"

        XCTAssertEqual(
            router.route(for: "/people/person-ref-scoped/"),
            "/app/public/people/00000000-0000-4000-8000-000000000001/index.html"
        )
        XCTAssertEqual(
            router.route(for: "/people/person-ref-scoped/index.txt"),
            "/app/public/people/00000000-0000-4000-8000-000000000001/index.txt"
        )
        XCTAssertEqual(
            router.route(for: "/people/person-ref-scoped.txt"),
            "/app/public/people/00000000-0000-4000-8000-000000000001/index.txt"
        )
        XCTAssertEqual(
            router.route(for: "/people/person-ref-scoped/__next.people.$d$personRef.txt"),
            "/app/public/people/00000000-0000-4000-8000-000000000001/__next.people.$d$personRef.txt"
        )
    }

    func testNativeRouterLeavesProfileAccessConnectionRouteUnchanged() {
        var router = HushhNativeRouter()
        router.basePath = "/app/public"

        XCTAssertEqual(
            router.route(for: "/one/profile/access/connection"),
            "/app/public/index.html"
        )
        XCTAssertEqual(
            router.route(for: "/one/profile/access/connection/index.txt"),
            "/app/public/one/profile/access/connection/index.txt"
        )
    }

    func testNormalizeBackendUrlRewritesLocalhost() {
        XCTAssertEqual(
            HushhProxyClient.normalizeBackendUrl("http://localhost:8000/"),
            "http://127.0.0.1:8000"
        )
    }

    func testMakeJsonRequestSetsMethodHeadersAndBody() throws {
        let request = try HushhProxyClient.makeJsonRequest(
            method: "POST",
            urlStr: "https://example.com/api/demo",
            bearerToken: "test-token",
            jsonBody: ["hello": "world"]
        )

        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-token")

        let body = try XCTUnwrap(request.httpBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(json["hello"], "world")
    }

    func testNativeArtifactSanitizerDerivesIdentityMatchWithoutPersistingIds() {
        XCTAssertEqual(
            NativeTestArtifactSanitizer.userMatchStatus(userId: "same", expectedUserId: "same"),
            "1"
        )
        XCTAssertEqual(
            NativeTestArtifactSanitizer.userMatchStatus(userId: "unexpected", expectedUserId: "expected"),
            "0"
        )
        XCTAssertEqual(
            NativeTestArtifactSanitizer.userMatchStatus(userId: "", expectedUserId: "expected"),
            ""
        )
    }

    func testNativeArtifactSanitizerRecursivelyRedactsSensitiveFields() throws {
        let raw: [String: Any] = [
            "route": "/one/pkm?token=private",
            "bootstrap_uid": "private-user-id",
            "nested": [
                "id_token": "private-token",
                "bodySnippet": "private profile text",
                "errorClass": "timeout",
                "email": "person@example.test",
            ],
        ]
        let sanitized = try XCTUnwrap(
            NativeTestArtifactSanitizer.sanitizeReport(raw) as? [String: Any]
        )
        XCTAssertEqual(sanitized["route"] as? String, "/one/pkm")
        XCTAssertEqual(sanitized["bootstrap_uid"] as? String, "<redacted>")
        let nested = try XCTUnwrap(sanitized["nested"] as? [String: Any])
        XCTAssertEqual(nested["id_token"] as? String, "<redacted>")
        XCTAssertEqual(nested["bodySnippet"] as? String, "<redacted>")
        XCTAssertEqual(nested["email"] as? String, "<redacted>")
        XCTAssertEqual(nested["errorClass"] as? String, "timeout")
    }

    func testSessionPrivacyStateKeepsOneGenerationPerInactiveCycle() {
        var state = HushhSessionPrivacyState()

        state.protectForAppInactive()
        let firstGeneration = state.generation
        state.protectForAppInactive()

        XCTAssertTrue(state.shielded)
        XCTAssertEqual(firstGeneration, 1)
        XCTAssertEqual(state.generation, firstGeneration)

        state.markAppActive()
        state.protectForAppInactive()

        XCTAssertEqual(state.generation, firstGeneration + 1)
    }

    func testSessionPrivacyStateRejectsInactiveStaleAndRepeatedCompletion() {
        var state = HushhSessionPrivacyState()

        state.protectForAppInactive()
        let staleGeneration = state.generation
        XCTAssertFalse(
            state.completeSessionValidation(
                generation: staleGeneration,
                appIsActive: false
            )
        )
        XCTAssertTrue(state.shielded)

        state.markAppActive()
        state.protectForAppInactive()
        let currentGeneration = state.generation
        state.markAppActive()

        XCTAssertFalse(
            state.completeSessionValidation(
                generation: staleGeneration,
                appIsActive: true
            )
        )
        XCTAssertTrue(
            state.completeSessionValidation(
                generation: currentGeneration,
                appIsActive: true
            )
        )
        XCTAssertFalse(state.shielded)
        XCTAssertFalse(
            state.completeSessionValidation(
                generation: currentGeneration,
                appIsActive: true
            )
        )
        state.protectForPresentationRecovery()
        XCTAssertTrue(state.shielded)
        XCTAssertEqual(state.generation, currentGeneration + 1)
        state.protectForPresentationRecovery()
        XCTAssertEqual(state.generation, currentGeneration + 1, "Recovery is idempotent while already covered")
        XCTAssertFalse(state.completeSessionValidation(generation: currentGeneration, appIsActive: true))
        let recovering = state.generation
        XCTAssertTrue(state.completeSessionValidation(generation: recovering, appIsActive: true))
        state.protectForAppInactive()
        XCTAssertEqual(state.generation, recovering + 1, "The next real inactive cycle must have its own authority")
    }

    @MainActor func testNativePhoneSceneRequiresAcknowledgedStageEditsAndScrubsBeforeRetirement() {
        func state(_ sequence: Int, _ acknowledged: Int, _ step: String = "phone", _ code: String = "") -> NativePhoneProjection {
            NativePhoneProjection(documentId: "public-phone-document", ownerEpoch: "public-phone-owner", family: "profile", scene: "phone",
                destinationId: "public-phone-first", ownerGeneration: 1, revision: 1, updateSequence: sequence, privacyGeneration: 0,
                draftRevision: sequence, acknowledgedEditRevision: acknowledged,
                draft: NativePhoneDraft(country: "US", number: "6505550101", code: code), step: step, mode: "replace",
                countries: [NativePhoneCountry(value: "US", label: "United States", dialCode: "+1")], maskedDestination: "••••••0101",
                error: nil, canSave: true, busy: false, appearance: "light", accentHex: "#007aff", foregroundHex: "#808080")
        }
        let model = NativePhoneModel(state(1, 0))
        var actions = [NativePhoneAction]()
        model.edit = { _, _, _, _ in true }
        model.choose = { actions.append($0); return true }
        model.change(field: "number", value: "6505550102")
        model.action("send")
        XCTAssertTrue(actions.isEmpty, "A final edit must be acknowledged before sending")
        XCTAssertTrue(model.update(state(2, 1)))
        model.action("send")
        XCTAssertEqual(actions.count, 1)
        let send = actions[0]
        XCTAssertTrue(model.confirm(send))
        XCTAssertFalse(model.confirm(send), "An uncertain confirmation cannot replay an operation")
        XCTAssertTrue(model.settle(send))
        XCTAssertTrue(model.update(state(3, 1, "code")))
        model.action("send")
        XCTAssertEqual(actions.count, 1, "Phone entry actions cannot act on the replacement OTP stage")
        model.change(field: "code", value: "123456")
        XCTAssertTrue(model.update(state(4, 2, "code", "123456")))
        model.action("verify")
        XCTAssertEqual(actions.count, 2)
        XCTAssertTrue(model.confirm(actions[1]))
        let editor = UITextField(); editor.text = "123456"; model.register(editor)
        model.clear()
        XCTAssertEqual(editor.text, "")
        XCTAssertEqual(model.draft.code, "")
        XCTAssertEqual(model.projection.draft.number, "")
        XCTAssertNil(model.choose)
        XCTAssertFalse(model.confirm(actions[1]))
    }

    @MainActor
    func testPrivacyReleasePublishesTheCurrentStateToAllConsumers() async throws {
        let shield = HushhSessionPrivacyShield()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previousWindow = scene.windows.first(where: \.isKeyWindow)
        let parent = UIViewController()
        let window = UIWindow(windowScene: scene)
        window.rootViewController = parent
        window.makeKeyAndVisible()
        shield.attach(to: parent.view)
        let document = "public-privacy-release-\(UUID().uuidString)"
        shield.observeDocument(document)
        let previous = shield.onStateChanged
        var releasedStates: [HushhSessionPrivacyShield.Snapshot] = []
        shield.onStateChanged = { state, action in
            previous?(state, action)
            if !state.shielded { releasedStates.append(state) }
        }
        var nativeReleases = 0
        let observer = NotificationCenter.default.addObserver(
            forName: HushhSessionPrivacyShield.presentationDidChange, object: shield, queue: .main
        ) { _ in if !shield.snapshot().shielded { nativeReleases += 1 } }
        defer {
            shield.onStateChanged = previous
            NotificationCenter.default.removeObserver(observer)
            window.isHidden = true
            window.rootViewController = nil
            if let host = previousWindow?.rootViewController?.view { shield.attach(to: host) }
            previousWindow?.makeKeyAndVisible()
        }
        func release(_ generation: Int, documentId: String? = nil, active: Bool = true,
                     sessionRevision: Int? = nil, compositionRevision: Int? = nil, preparationId: String? = nil) async -> Bool {
            let done = expectation(description: "Bounded release callback")
            var result = false
            shield.completeSessionValidation(generation: generation, documentId: documentId ?? document,
                appIsActive: active, sessionRevision: sessionRevision, compositionRevision: compositionRevision,
                preparationId: preparationId) {
                result = $0; done.fulfill()
            }
            await fulfillment(of: [done], timeout: 2)
            return result
        }
        shield.protectForAppInactive()
        shield.markAppActive()
        let generation = shield.snapshot().generation
        let retirement = shield.beginPresentationRetirement()
        let blockedByRetirement = await release(generation)
        XCTAssertFalse(blockedByRetirement)
        shield.completePresentationRetirement(retirement)
        let stale = await release(generation - 1)
        let inactive = await release(generation, active: false)
        let unobserved = await release(generation, documentId: "unobserved-document")
        XCTAssertFalse(stale)
        XCTAssertFalse(inactive)
        XCTAssertFalse(unobserved)
        XCTAssertTrue(releasedStates.isEmpty)
        XCTAssertEqual(nativeReleases, 0)
        let finished = expectation(description: "Actual privacy cover disappearance")
        var released: Bool?
        shield.completeSessionValidation(generation: generation, documentId: document, appIsActive: true) {
            released = $0; finished.fulfill()
        }
        XCTAssertTrue(shield.snapshot().shielded, "Animation admission is not disappearance")
        XCTAssertNil(released)
        XCTAssertEqual(nativeReleases, 0, "Actions must stay disabled throughout the fade")
        let cover = try XCTUnwrap(window.subviews.first { $0.accessibilityIdentifier == HushhSessionPrivacyShield.accessibilityIdentifier })
        XCTAssertEqual(cover.alpha, 1, "Only the visual child fades; the full-window touch blocker stays opaque to hit testing")
        for point in [CGPoint(x: 5, y: 5), CGPoint(x: window.bounds.midX, y: window.bounds.midY),
                      CGPoint(x: window.bounds.maxX - 5, y: window.bounds.maxY - 5)] {
            let hit = window.hitTest(point, with: nil)
            XCTAssertTrue(hit === cover || hit?.isDescendant(of: cover) == true,
                "The visual fade must never expose underlying touch targets")
        }
        await fulfillment(of: [finished], timeout: 2)
        XCTAssertEqual(released, true)
        XCTAssertFalse(window.subviews.contains { $0.accessibilityIdentifier == HushhSessionPrivacyShield.accessibilityIdentifier })
        XCTAssertEqual(releasedStates.count, 1, "A Promise receipt alone does not release subscribed presentation consumers")
        XCTAssertEqual(nativeReleases, 1)
        XCTAssertEqual(releasedStates.first?.generation, generation)
        XCTAssertEqual(releasedStates.first?.appIsActive, true)
        let duplicate = await release(generation)
        XCTAssertFalse(duplicate)
        XCTAssertEqual(releasedStates.count, 1, "Repeated acknowledgements must not publish another release")
        XCTAssertEqual(nativeReleases, 1)

        // Negative control: a fresh inactive cycle must cancel a release that
        // was admitted earlier, including its delayed animation completion.
        shield.protectForAppInactive(); shield.markAppActive()
        let interrupted = expectation(description: "Interrupted release is refused")
        var interruptedResult: Bool?
        shield.completeSessionValidation(generation: shield.snapshot().generation, documentId: document, appIsActive: true) {
            interruptedResult = $0; interrupted.fulfill()
        }
        shield.protectForAppInactive()
        await fulfillment(of: [interrupted], timeout: 2)
        XCTAssertEqual(interruptedResult, false)
        XCTAssertTrue(shield.snapshot().shielded)
        XCTAssertEqual(nativeReleases, 1)
        shield.markAppActive()
        let recovered = await release(shield.snapshot().generation)
        XCTAssertTrue(recovered)
        XCTAssertEqual(nativeReleases, 2)

        shield.protectForAppInactive(); shield.markAppActive()
        let cancelledByPopup = expectation(description: "Popup retirement cancels release once")
        var cancelledByPopupResult: Bool?
        shield.completeSessionValidation(generation: shield.snapshot().generation, documentId: document, appIsActive: true) {
            cancelledByPopupResult = $0; cancelledByPopup.fulfill()
        }
        let popup = shield.beginPresentationRetirement()
        await fulfillment(of: [cancelledByPopup], timeout: 2)
        XCTAssertEqual(cancelledByPopupResult, false)
        XCTAssertTrue(shield.snapshot().shielded)
        let recoveryVisible = expectation(description: "Interrupted release preserves the native escape path")
        DispatchQueue.main.asyncAfter(deadline: .now() + HushhSessionPrivacyShield.recoveryDelay + 0.1) {
            let recovery = window.subviews.flatMap(\.subviews).flatMap(\.subviews)
                .first { $0.accessibilityIdentifier == "session-privacy-recovery" }
            XCTAssertEqual(recovery?.isHidden, false)
            recoveryVisible.fulfill()
        }
        await fulfillment(of: [recoveryVisible], timeout: HushhSessionPrivacyShield.recoveryDelay + 2)
        shield.completePresentationRetirement(popup)
        let afterPopup = await release(shield.snapshot().generation)
        XCTAssertTrue(afterPopup)
        XCTAssertEqual(nativeReleases, 3)
        // Parent completion alone is not proof of its required editor. The
        // readiness closure here is the transaction port; Drawers supplies
        // actual controller/window/layout and form-completion checks.
        shield.protectForAppInactive(); shield.markAppActive()
        let preparedGeneration = shield.snapshot().generation
        shield.requireProfilePreparation()
        let generationOnly = await release(preparedGeneration)
        XCTAssertFalse(generationOnly, "A generation-only receipt cannot bypass a required Profile composition")
        XCTAssertTrue(shield.authorizePreparation(document: document, generation: preparedGeneration,
            sessionRevision: 1, profile: true, compositionRevision: 1, visitId: "public-account-visit", formScene: "account-name"))
        let target = NativeProfilePreparationTarget(documentId: document, ownerEpoch: "public-owner", ownerGeneration: 1,
            revision: 1, updateSequence: 1, privacyGeneration: preparedGeneration, visitId: "public-account-visit",
            destinationId: "public-account", supportDestinationId: nil, formScene: "account-name")
        var completeComposition = false
        let preparationId = try XCTUnwrap(shield.beginProfilePreparation(target) { completeComposition })
        let missingFormTarget = NativeProfilePreparationTarget(documentId: document, ownerEpoch: "public-owner", ownerGeneration: 1,
            revision: 1, updateSequence: 1, privacyGeneration: preparedGeneration, visitId: "public-account-visit",
            destinationId: "public-account", supportDestinationId: nil, formScene: nil)
        XCTAssertNil(shield.beginProfilePreparation(missingFormTarget) { true })
        XCTAssertEqual(shield.snapshot().profilePreparationId, preparationId, "A rejected target must leave the current ticket untouched")
        XCTAssertFalse(shield.authorizePreparation(document: document, generation: preparedGeneration,
            sessionRevision: 0, profile: false, compositionRevision: 2, visitId: nil, formScene: nil))
        XCTAssertFalse(shield.authorizePreparation(document: document, generation: preparedGeneration,
            sessionRevision: 1, profile: false, compositionRevision: 1, visitId: nil, formScene: nil))
        XCTAssertTrue(shield.snapshot().shielded, "Preparation grants layout, never interaction")
        XCTAssertFalse(shield.acceptsPreparedForm(target.identity, scene: "phone", destination: "public-account", privacy: preparedGeneration))
        let missingEditor = await release(preparedGeneration, sessionRevision: 1, compositionRevision: 1, preparationId: preparationId)
        XCTAssertFalse(missingEditor)
        completeComposition = true
        let staleComposition = await release(preparedGeneration, sessionRevision: 1, compositionRevision: 0, preparationId: preparationId)
        XCTAssertFalse(staleComposition)
        let interruptedPreparation = expectation(description: "A changed composition cancels its fade")
        shield.completeSessionValidation(generation: preparedGeneration, documentId: document, appIsActive: true,
            sessionRevision: 1, compositionRevision: 1, preparationId: preparationId) { released in
            XCTAssertFalse(released); interruptedPreparation.fulfill()
        }
        XCTAssertTrue(shield.authorizePreparation(document: document, generation: preparedGeneration,
            sessionRevision: 1, profile: false, compositionRevision: 2, visitId: nil, formScene: nil))
        await fulfillment(of: [interruptedPreparation], timeout: 2)
        XCTAssertTrue(shield.snapshot().shielded)
        let staleTicket = await release(preparedGeneration, sessionRevision: 1, compositionRevision: 2, preparationId: preparationId)
        XCTAssertFalse(staleTicket)
        let safeGate = await release(preparedGeneration, sessionRevision: 1, compositionRevision: 2)
        XCTAssertTrue(safeGate, "The committed safe gate supersedes private preparation without operation replay")

        // A rich exception is one complete React pane. Neither its acquired
        // paint plane nor a stale body receipt can release window privacy.
        shield.protectForAppInactive(); shield.markAppActive()
        let paneGeneration = shield.snapshot().generation
        let previousConcealment = shield.profilePresentationsConcealed
        var menuGone = false
        var paneLaidOut = false
        shield.profilePresentationsConcealed = { menuGone }
        defer { shield.profilePresentationsConcealed = previousConcealment }
        XCTAssertTrue(shield.authorizePreparation(document: document, generation: paneGeneration,
            sessionRevision: 1, profile: true, compositionRevision: 3, visitId: "public-rich-visit", formScene: nil, body: "pane"))
        let pane = NativeContentPaneIdentity(document: document, ownerEpoch: "public-pane-owner", generation: 1,
            privacyGeneration: paneGeneration)
        XCTAssertFalse(shield.canPrepareProfilePane(pane, visit: "public-stale-visit"))
        XCTAssertTrue(shield.beginProfilePanePreparation(pane, visit: "public-rich-visit", viewport: window.bounds.size) { paneLaidOut })
        let paneTicket = try XCTUnwrap(shield.snapshot().profilePreparationId)
        XCTAssertFalse(shield.confirmProfilePanePreparation(pane, visit: "public-rich-visit", id: paneTicket))
        paneLaidOut = true
        XCTAssertFalse(shield.confirmProfilePanePreparation(pane, visit: "public-rich-visit", id: paneTicket))
        menuGone = true
        let unpainted = await release(paneGeneration, sessionRevision: 1, compositionRevision: 3, preparationId: paneTicket)
        XCTAssertFalse(unpainted)
        XCTAssertFalse(shield.confirmProfilePanePreparation(pane, visit: "public-rich-visit", id: "public-stale-ticket"))
        XCTAssertTrue(shield.confirmProfilePanePreparation(pane, visit: "public-rich-visit", id: paneTicket))
        XCTAssertTrue(shield.snapshot().shielded)
        let withdrawn = expectation(description: "Pane withdrawal cancels its fade immediately")
        shield.completeSessionValidation(generation: paneGeneration, documentId: document, appIsActive: true,
            sessionRevision: 1, compositionRevision: 3, preparationId: paneTicket) {
            XCTAssertFalse($0); withdrawn.fulfill()
        }
        shield.retireProfilePanePreparation(pane)
        await fulfillment(of: [withdrawn], timeout: 2)
        XCTAssertTrue(shield.snapshot().shielded)
        XCTAssertTrue(shield.beginProfilePanePreparation(pane, visit: "public-rich-visit", viewport: window.bounds.size) { true })
        let beforeRotation = try XCTUnwrap(shield.snapshot().profilePreparationId)
        XCTAssertTrue(shield.confirmProfilePanePreparation(pane, visit: "public-rich-visit", id: beforeRotation))
        let rotated = CGSize(width: window.bounds.height, height: window.bounds.width)
        XCTAssertTrue(shield.beginProfilePanePreparation(pane, visit: "public-rich-visit", viewport: rotated) { true })
        let afterRotation = try XCTUnwrap(shield.snapshot().profilePreparationId)
        XCTAssertNotEqual(beforeRotation, afterRotation)
        XCTAssertFalse(shield.confirmProfilePanePreparation(pane, visit: "public-rich-visit", id: beforeRotation))
        XCTAssertTrue(shield.confirmProfilePanePreparation(pane, visit: "public-rich-visit", id: afterRotation))
        let painted = await release(paneGeneration, sessionRevision: 1, compositionRevision: 3, preparationId: afterRotation)
        XCTAssertTrue(painted)
    }

    func testPrivacyCannotUncoverBeforeEveryOwnedPresenterRetires() {
        var state = HushhSessionPrivacyState()
        let normal = state.beginPresentationRetirement()
        XCTAssertTrue(state.completePresentationRetirement(normal))
        XCTAssertFalse(state.shouldPublishRetirementCompletion,
                       "Normal popup dismissal must not invalidate its pending choice")
        let first = state.beginPresentationRetirement()
        let second = state.beginPresentationRetirement()
        state.protectForAppInactive()
        XCTAssertTrue(state.shouldPublishRetirementCompletion,
                      "Shielded retirement must republish validation after actual dismissal")
        state.markAppActive()
        let generation = state.generation
        XCTAssertFalse(state.completeSessionValidation(generation: generation, appIsActive: true))
        XCTAssertFalse(state.completePresentationRetirement(UUID()))
        XCTAssertTrue(state.completePresentationRetirement(first))
        XCTAssertFalse(state.completePresentationRetirement(first))
        XCTAssertFalse(state.completeSessionValidation(generation: generation, appIsActive: true))
        XCTAssertTrue(state.shielded)
        XCTAssertTrue(state.completePresentationRetirement(second))
        XCTAssertTrue(state.completeSessionValidation(generation: generation, appIsActive: true))
        XCTAssertFalse(state.shielded)
    }

    @MainActor
    func testOwnedAlertsKeepUIKitDelegateAndCompleteDismissalBeforeChoice() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
        let parent = UIViewController()
        let window = UIWindow(windowScene: scene)
        window.rootViewController = parent
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
            previousKeyWindow?.makeKeyAndVisible()
        }
        for style in [UIAlertController.Style.alert, .actionSheet] {
            let alert = UIAlertController(title: "Public confirmation", message: nil, preferredStyle: style)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
            alert.popoverPresentationController?.sourceView = parent.view
            alert.popoverPresentationController?.sourceRect = CGRect(x: 44, y: 44, width: 44, height: 44)
            var choices = 0
            let presenter = HushhNativeChromePresenter(parent: parent, controller: alert, updateSequence: 7) { _, sequence in
                XCTAssertNil(alert.presentingViewController, "Choice cannot precede actual native dismissal")
                XCTAssertEqual(sequence, 7)
                choices += 1
            }
            presenter.present() // Old code aborts in UIKit's alert delegate setter here.
            let visible = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                alert.presentingViewController === parent && !alert.isBeingPresented
            }, object: nil)
            await fulfillment(of: [visible], timeout: 3)
            XCTAssertFalse(alert.presentationController?.delegate === presenter)
            if style == .alert {
                presenter.choose("delete")
                presenter.choose("delete") // Duplicate callbacks must not replay.
            }
            let dismissed = expectation(description: "Owned alert detached")
            presenter.retire { dismissed.fulfill() }
            await fulfillment(of: [dismissed], timeout: 3)
            XCTAssertNil(alert.presentingViewController)
            XCTAssertEqual(choices, style == .alert ? 1 : 0)
        }
        // The fix is alert-specific. Custom sheets retain adaptive dismissal.
        let sheet = UIViewController()
        sheet.modalPresentationStyle = .pageSheet
        let presenter = HushhNativeChromePresenter(parent: parent, controller: sheet, updateSequence: 1) { _, _ in
            XCTFail("Retirement alone must not execute a choice")
        }
        presenter.present()
        XCTAssertTrue(sheet.presentationController?.delegate === presenter)
        let dismissed = expectation(description: "Custom sheet detached")
        presenter.retire { dismissed.fulfill() }
        await fulfillment(of: [dismissed], timeout: 3)
        XCTAssertNil(sheet.presentingViewController)
    }

    func testSessionPrivacyStatePreservesBackgroundDebtThroughTransientInactivity() {
        var state = HushhSessionPrivacyState()
        state.protectForAppInactive()
        XCTAssertEqual(state.cause, "inactive")
        state.markAppBackgrounded()
        state.markAppActive()
        let backgroundGeneration = state.generation
        state.protectForAppInactive()
        state.markAppActive()
        XCTAssertEqual(state.cause, "background")
        XCTAssertGreaterThan(state.generation, backgroundGeneration)
        XCTAssertFalse(state.completeSessionValidation(generation: backgroundGeneration, appIsActive: true))
        XCTAssertTrue(state.completeSessionValidation(generation: state.generation, appIsActive: true))
        state.protectForAppInactive()
        XCTAssertEqual(state.cause, "inactive")
    }

    func testSessionPrivacyRestartRejectsThePreviousDocumentGeneration() {
        var state = HushhSessionPrivacyState()
        state.protectForAppInactive()
        state.markAppActive()
        let oldGeneration = state.generation
        state.restartSession()
        XCTAssertEqual(state.cause, "restart")
        XCTAssertTrue(state.shielded)
        XCTAssertFalse(state.completeSessionValidation(generation: oldGeneration, appIsActive: true))
        XCTAssertTrue(state.completeSessionValidation(generation: state.generation, appIsActive: true))
    }

    func testIMessagePublicationRejectsSupersededAndUninitializedGenerations() {
        var state = HusshIMessagePublicationGeneration()
        XCTAssertFalse(state.accepts(0))
        XCTAssertFalse(state.accepts(-1))
        let first = state.invalidate()
        XCTAssertTrue(state.accepts(first))
        let second = state.invalidate()
        XCTAssertFalse(state.accepts(first))
        XCTAssertTrue(state.accepts(second))
    }

    func testPrivacyRestartRejectsOldDocumentEvenAfterItReadsTheNewGeneration() {
        var documents = HushhSessionPrivacyDocumentState()
        XCTAssertFalse(documents.accepts("old-document"))
        documents.observe("old-document")
        XCTAssertTrue(documents.accepts("old-document"))
        documents.restart()
        documents.observe("old-document")
        XCTAssertFalse(documents.accepts("old-document"))
        documents.observe("new-document")
        XCTAssertTrue(documents.accepts("new-document"))
        documents.restart()
        documents.observe("new-document")
        XCTAssertFalse(documents.accepts("new-document"))
    }

    func testKaiStreamLifecycleClassifierAcceptsOnlyMatchingTypedStatuses() {
        XCTAssertEqual(
            KaiStreamLifecycleErrorClassifier.bridgeCode(
                statusCode: 401,
                body: #"{"detail":{"code":"AUTH_ACCOUNT_NOT_FOUND"}}"#
            ),
            "AUTH_ACCOUNT_NOT_FOUND"
        )
        XCTAssertEqual(
            KaiStreamLifecycleErrorClassifier.bridgeCode(
                statusCode: 423,
                body: #"{"error":{"code":"AUTH_ACCOUNT_DELETION_IN_PROGRESS"}}"#
            ),
            "AUTH_ACCOUNT_DELETION_IN_PROGRESS"
        )
        XCTAssertEqual(
            KaiStreamLifecycleErrorClassifier.bridgeCode(
                statusCode: 503,
                body: #"{"code":"AUTH_ACCOUNT_STATUS_UNAVAILABLE"}"#
            ),
            "AUTH_ACCOUNT_STATUS_UNAVAILABLE"
        )
    }

    func testKaiStreamLifecycleClassifierFailsClosedForMismatchAndMalformedBodies() {
        // A lifecycle code on the wrong status is not trusted, and on its own
        // is not an invalid-owner signal either.
        XCTAssertEqual(
            KaiStreamLifecycleErrorClassifier.bridgeCode(
                statusCode: 401,
                body: #"{"code":"AUTH_ACCOUNT_DELETION_IN_PROGRESS"}"#
            ),
            "HUSHH_HTTP_401"
        )
        XCTAssertEqual(
            KaiStreamLifecycleErrorClassifier.bridgeCode(
                statusCode: 423,
                body: #"{"code":"AUTH_ACCOUNT_NOT_FOUND"}"#
            ),
            "HUSHH_HTTP_423"
        )
        XCTAssertEqual(
            KaiStreamLifecycleErrorClassifier.bridgeCode(
                statusCode: 403,
                body: "not-json"
            ),
            "HUSHH_HTTP_403"
        )
        XCTAssertEqual(
            KaiStreamLifecycleErrorClassifier.bridgeCode(
                statusCode: 500,
                body: ""
            ),
            "HUSHH_HTTP_500"
        )
    }

    func testKaiStreamLifecycleClassifierOnlyLocksOnAnExplicitInvalidOwnerSignal() {
        // An ordinary feature/permission refusal after a valid owner check
        // (e.g. a disabled connector) must not clear Vault custody.
        XCTAssertEqual(
            KaiStreamLifecycleErrorClassifier.bridgeCode(
                statusCode: 403,
                body: #"{"detail":"Drive chat reads are unavailable"}"#
            ),
            "HUSHH_HTTP_403"
        )
        // The backend's known invalid-token phrasing still clears the vault.
        XCTAssertEqual(
            KaiStreamLifecycleErrorClassifier.bridgeCode(
                statusCode: 401,
                body: #"{"detail":"Token validation failed."}"#
            ),
            "AUTH_VAULT_OWNER_INVALID"
        )
        // So does an explicit invalid-owner code, nested in `detail`.
        XCTAssertEqual(
            KaiStreamLifecycleErrorClassifier.bridgeCode(
                statusCode: 403,
                body: #"{"detail":{"code":"AUTH_VAULT_OWNER_INVALID","message":"Vault owner session was revoked. Unlock again to continue."}}"#
            ),
            "AUTH_VAULT_OWNER_INVALID"
        )
    }

    func testKaiStreamLifecycleClassifierBoundsUntrustedErrorBodies() throws {
        let oversizedBody = #"{"code":"AUTH_ACCOUNT_STATUS_UNAVAILABLE","padding":""#
            + String(
                repeating: "x",
                count: KaiStreamLifecycleErrorClassifier.maxStreamErrorBodyBytes
            )
            + #""}"#
        XCTAssertEqual(
            KaiStreamLifecycleErrorClassifier.bridgeCode(
                statusCode: 503,
                body: oversizedBody
            ),
            "HUSHH_HTTP_503"
        )

        var deeplyNested: Any = "AUTH_ACCOUNT_STATUS_UNAVAILABLE"
        for _ in 0..<8 {
            deeplyNested = ["nested": deeplyNested]
        }
        let nestedData = try JSONSerialization.data(withJSONObject: deeplyNested)
        let nestedBody = try XCTUnwrap(String(data: nestedData, encoding: .utf8))
        XCTAssertEqual(
            KaiStreamLifecycleErrorClassifier.bridgeCode(
                statusCode: 503,
                body: nestedBody
            ),
            "HUSHH_HTTP_503"
        )
    }
}

@MainActor private final class OwnedMenuTestAnimator: NSObject, UIContextMenuInteractionAnimating {
    var previewViewController: UIViewController? { nil }
    private var completions = [() -> Void]()
    func addAnimations(_ animations: @escaping () -> Void) { animations() }
    func addCompletion(_ completion: @escaping () -> Void) { completions.append(completion) }
    func finish() { let work = completions; completions.removeAll(); work.forEach { $0() } }
}
