import Foundation
import XCTest

final class AppUITests: XCTestCase {
    private var vaultUnlockSubmitted = false
    /// The session walk captures the vault gate with its keyboard up, before
    /// anything is typed (a stop the host screenshots).
    private var perfGateStop = false
    private var activeUiFlowRunId = ""

    struct RouteCase {
        let name: String
        let initialRoute: String
        let expectedMarker: String
        let expectedRoute: String?
        let expectedRoutePrefix: String?
        let autoReviewerLogin: Bool
        let expectedAuth: String
        let allowedDataStates: Set<String>
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
        vaultUnlockSubmitted = false
    }

    func testLocalSessionAutomationAdmissionOnly() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_LOCAL_SESSION_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in credential-free attach-only runner admission")
        }
        print("NATIVE_AUTOMATION_TEST_BODY_ENTERED")
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            XCTFail("NATIVE_ADMISSION_REQUIRES_RUNNING_APP"); return
        }
        app.activate()
        let hosts = app.webViews.matching(identifier: "native-webview")
        XCTAssertTrue(hosts.firstMatch.waitForExistence(timeout: 15), "NATIVE_ADMISSION_HOST_UNAVAILABLE")
        XCTAssertEqual(hosts.count, 1, "NATIVE_ADMISSION_HOST_COUNT_INVALID")
        let web = hosts.firstMatch
        if ProcessInfo.processInfo.environment["HUSHH_REHEARSAL_RETURN_CHAT"] == "true" {
            returnToRehearsalChat(app)
        }
        let unlock = web.buttons["Unlock"].firstMatch
        let composer = web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Message One")).firstMatch
        let rejected = web.descendants(matching: .any).matching(NSPredicate(
            format: "label CONTAINS[c] %@", "That passphrase did not match"
        )).firstMatch
        let busy = web.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Unlocking")).firstMatch
        print("NATIVE_SESSION_STATE unlock=\(unlock.exists) unlock_hittable=\(unlock.exists && unlock.isHittable) composer=\(composer.exists) sign_in=\(web.buttons["Continue with Google"].exists)")
        print("VAULT_GATE_STATE enabled=\(unlock.exists && unlock.isEnabled) rejected=\(rejected.exists) busy=\(busy.exists)")
        // Public gate shape only. A token/publication failure is not a wrong
        // passphrase; neither field values nor provider error text is read.
        let accessSetupFailure = web.descendants(matching: .any).matching(NSPredicate(
            format: "label CONTAINS %@", "Vault opened, but we could not complete access setup. Please try again."
        )).firstMatch.exists
        print("VAULT_GATE_NOTICE unlock_count=\(web.buttons.matching(NSPredicate(format: "label == %@", "Unlock")).count) access_setup_failure=\(accessSetupFailure)")
        if unlock.exists {
            // Credential-free clipping diagnosis: public geometry only, no
            // screenshots, field values, account text or accessibility dump.
            let entry = web.secureTextFields.matching(NSPredicate(
                format: "label == %@ OR placeholderValue == %@", "Vault passphrase", "Enter passphrase"
            )).firstMatch
            for (name, element) in [("window", app), ("web", web), ("keyboard", app.keyboards.firstMatch), ("entry", entry), ("unlock", unlock)] {
                let bounds = element.exists ? element.frame : .zero
                print("VAULT_GATE_GEOMETRY control=\(name) x=\(Int(bounds.minX.rounded())) y=\(Int(bounds.minY.rounded())) width=\(Int(bounds.width.rounded())) height=\(Int(bounds.height.rounded())) hittable=\(element.exists && element.isHittable)")
            }
        }
        print("NATIVE_AUTOMATION_ADMISSION_CONFIRMED")
    }

    func testLocalSessionVaultUnlockOnly() throws {
        let app = XCUIApplication()
        let environment = ProcessInfo.processInfo.environment
        guard environment["HUSHH_RUN_LOCAL_SESSION_SMOKE"] == "true",
              [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state)
        else { throw XCTSkip("Requires the existing app session") }
        app.activate()
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 15), "Vault WebView unavailable")
        let publicReceipt = app.buttons["native-vault-layout"]
        var receiptSequence = -1
        func reportReceipt(_ stage: String) {
            guard publicReceipt.exists else { return }
            guard let currentJSON = publicReceipt.value as? String,
                  let currentData = currentJSON.data(using: .utf8),
                  let current = try? JSONSerialization.jsonObject(with: currentData) as? [String: NSNumber],
                  let currentSequence = current["sequence"]?.intValue else {
                XCTFail("VAULT_PUBLIC_RECEIPT_UNAVAILABLE"); return
            }
            let stageSequence = max(receiptSequence, currentSequence)
            var observation: [String: NSNumber]?
            let fresh = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                guard let json = publicReceipt.value as? String, let data = json.data(using: .utf8),
                      let packet = try? JSONSerialization.jsonObject(with: data) as? [String: NSNumber],
                      let sequence = packet["sequence"]?.intValue, sequence > stageSequence,
                      packet["unlockClicks"] != nil, packet["unlockAccepted"] != nil else { return false }
                receiptSequence = sequence
                observation = packet
                return true
            }, object: publicReceipt)
            guard XCTWaiter.wait(for: [fresh], timeout: 5) == .completed, let packet = observation,
                  let clicks = packet["unlockClicks"]?.intValue,
                  let accepted = packet["unlockAccepted"]?.intValue,
                  (0...100000).contains(clicks), (0...100000).contains(accepted) else {
                XCTFail("VAULT_PUBLIC_RECEIPT_UNAVAILABLE"); return
            }
            let hit = packet["unlockHits"].map { $0.boolValue ? "hit" : "miss" } ?? "unknown"
            print("VAULT_PUBLIC_RECEIPT stage=\(stage) clicks=\(clicks) accepted=\(accepted) hit=\(hit)")
        }
        reportReceipt("before")
        defer { reportReceipt("after") }
        let unlock = web.buttons["Unlock"].firstMatch
        let composer = web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Message One")).firstMatch
        let signIn = web.buttons["Continue with Google"].firstMatch
        // A newly installed iPad can expose WebKit before Firebase/vault
        // restoration settles. Absence of Unlock at that instant does not
        // prove admission; wait for an actual public gate or protected shell.
        let sessionReady = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            unlock.exists && unlock.isHittable || composer.exists && composer.isHittable || signIn.exists && signIn.isHittable
        }, object: web)
        XCTAssertEqual(XCTWaiter.wait(for: [sessionReady], timeout: 30), .completed, "SESSION_ADMISSION_NOT_SETTLED")
        guard !signIn.exists else { XCTFail("SESSION_SIGN_IN_REQUIRED"); return }
        print("NATIVE_SESSION_STATE unlock=\(unlock.exists) unlock_hittable=\(unlock.exists && unlock.isHittable) composer=\(composer.exists) sign_in=\(signIn.exists)")
        if unlock.exists {
            let email = environment["HUSHH_UI_TEST_REVIEWER_EMAIL"] ?? ""
            guard !email.isEmpty, web.staticTexts.matching(NSPredicate(format: "label == %@", email)).firstMatch.exists else {
                XCTFail("The visible vault account does not match the canonical reviewer; unlock was not submitted")
                return
            }
            guard attemptVaultPassphraseUnlock(app: app) else {
                XCTFail("Vault entry could not be completed; unlock was not submitted")
                return
            }
        }
        let rejected = web.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] %@", "That passphrase did not match")).firstMatch
        let settled = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            !unlock.exists || rejected.exists
        }, object: web)
        XCTAssertEqual(XCTWaiter.wait(for: [settled], timeout: 30), .completed, "Vault unlock did not settle")
        guard !rejected.exists, !unlock.exists else { XCTFail("Vault authentication rejected the complete entry"); return }
        let navigationReady = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            app.buttons["one-native-tab-chat"].exists || web.buttons["Chat"].exists
        }, object: app)
        XCTAssertEqual(XCTWaiter.wait(for: [navigationReady], timeout: 15), .completed, "SESSION_NAVIGATION_NOT_SETTLED")
        perfTapNav(app, label: "Chat")
        XCTAssertTrue(composer.waitForExistence(timeout: 15) && composer.isHittable, "Protected Chat was not admitted")
        print("VAULT_UNLOCK_VERIFIED protected_chat=true")
    }

    func testLocalSessionVaultPublicLayoutWithKeyboard() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_LOCAL_SESSION_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in credential-free vault layout check")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            XCTFail("VAULT_LAYOUT_REQUIRES_RUNNING_APP"); return
        }
        app.activate()
        let web = app.webViews.matching(identifier: "native-webview").firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 15), "VAULT_LAYOUT_HOST_UNAVAILABLE")
        let entry = web.secureTextFields.matching(NSPredicate(
            format: "label == %@ OR placeholderValue == %@", "Vault passphrase", "Enter passphrase"
        )).firstMatch
        XCTAssertTrue(entry.waitForExistence(timeout: 30) && entry.isHittable, "VAULT_LAYOUT_ENTRY_CLIPPED")
        func assertFieldHitRegions() {
            XCTAssertGreaterThanOrEqual(entry.frame.height, 44, "VAULT_LAYOUT_ENTRY_TARGET_TOO_SMALL")
            let visibility = web.buttons["Show passphrase"].firstMatch
            XCTAssertTrue(visibility.exists && visibility.isHittable, "VAULT_LAYOUT_VISIBILITY_CLIPPED")
            XCTAssertGreaterThanOrEqual(visibility.frame.width, 44, "VAULT_LAYOUT_VISIBILITY_TARGET_TOO_NARROW")
            XCTAssertGreaterThanOrEqual(visibility.frame.height, 44, "VAULT_LAYOUT_VISIBILITY_TARGET_TOO_SHORT")
        }
        assertFieldHitRegions()
        let probe = app.buttons["native-vault-layout"]
        func geometry() -> [String: NSNumber]? {
            guard probe.exists, let json = probe.value as? String,
                  let data = json.data(using: .utf8),
                  let packet = try? JSONSerialization.jsonObject(with: data) as? [String: NSNumber],
                  packet["presentCount"]?.intValue == 1 else { return nil }
            return packet
        }
        func settledGeometry(after sequence: Int, matchingHeight: Double? = nil) -> [String: NSNumber]? {
            var latestSequence = sequence
            var previous: [String: NSNumber]?
            var settled: [String: NSNumber]?
            let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                guard let packet = geometry(), let next = packet["sequence"]?.intValue, next > latestSequence,
                      ["innerHeight", "visualTop", "visualScale", "cssInset", "scrollTopEdge", "scrollBottomEdge", "scrollTop", "nativeGuideHeight", "nativeBottomSafeArea"].allSatisfy({ packet[$0] != nil }) else { return false }
                if let matchingHeight, abs((packet["innerHeight"]?.doubleValue ?? -1) - matchingHeight) > 1 { return false }
                latestSequence = next
                let comparable = packet.filter { $0.key != "sequence" }
                if let previous, NSDictionary(dictionary: comparable).isEqual(to: previous) {
                    settled = packet
                    return true
                }
                previous = comparable
                return false
            }, object: probe)
            XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 10), .completed, "VAULT_LAYOUT_PUBLIC_GEOMETRY_STALLED")
            return settled
        }
        func report(_ stage: String, packet: [String: NSNumber]?) {
            if let packet, let data = try? JSONSerialization.data(withJSONObject: packet, options: [.sortedKeys]),
               let json = String(data: data, encoding: .utf8) {
                print("VAULT_CSS_GEOMETRY stage=\(stage) packet=\(json)")
            }
            for (name, element) in [("entry", entry), ("unlock", web.buttons["Unlock"].firstMatch),
                                    ("recovery", web.buttons["Recovery key"].firstMatch),
                                    ("signout", web.buttons["Sign out"].firstMatch),
                                    ("keyboard", app.keyboards.firstMatch)] {
                let bounds = element.exists ? element.frame : .zero
                print("VAULT_LAYOUT stage=\(stage) control=\(name) x=\(Int(bounds.minX.rounded())) y=\(Int(bounds.minY.rounded())) width=\(Int(bounds.width.rounded())) height=\(Int(bounds.height.rounded())) hittable=\(element.exists && element.isHittable)")
            }
            for (name, label) in [("unlock", "Unlock"), ("recovery", "Recovery key"), ("signout", "Sign out")] {
                let matches = web.buttons.matching(NSPredicate(format: "label == %@", label)).allElementsBoundByIndex
                print("VAULT_LAYOUT_REACHABILITY stage=\(stage) control=\(name) count=\(matches.count) hittable=\(matches.contains { $0.isHittable })")
            }
        }
        let rest = settledGeometry(after: 0)
        guard let initialClicks = rest?["unlockClicks"]?.intValue,
              let initialAccepted = rest?["unlockAccepted"]?.intValue,
              let initialSequence = rest?["sequence"]?.intValue else {
            XCTFail("VAULT_LAYOUT_RECEIPT_UNAVAILABLE"); return
        }
        defer {
            if let latest = settledGeometry(after: initialSequence) {
                XCTAssertEqual(latest["unlockClicks"]?.intValue, initialClicks, "VAULT_LAYOUT_IDLE_PRODUCED_CLICK")
                XCTAssertEqual(latest["unlockAccepted"]?.intValue, initialAccepted, "VAULT_LAYOUT_IDLE_PRODUCED_ADMISSION")
            } else {
                XCTFail("VAULT_LAYOUT_RECEIPT_UNAVAILABLE")
            }
        }
        report("rest", packet: rest)
        entry.tap()
        // A connected hardware keyboard is a valid tablet state. Do not
        // confuse its absent software keyboard with a clipped vault form.
        _ = app.keyboards.firstMatch.waitForExistence(timeout: 3)
        let focused = settledGeometry(after: rest?["sequence"]?.intValue ?? 0)
        report("focused", packet: focused)
        let signOut = web.buttons.matching(NSPredicate(format: "label == %@", "Sign out"))
        func escapeReachable(_ packet: [String: NSNumber]?) -> Bool {
            guard let packet, packet["recoveryInside"]?.boolValue == true,
                  packet["recoveryHits"]?.boolValue == true,
                  let top = packet["scrollTopEdge"]?.doubleValue,
                  let bottom = packet["scrollBottomEdge"]?.doubleValue else { return false }
            return signOut.allElementsBoundByIndex.contains { element in
                element.isHittable && element.frame.minY >= web.frame.minY + top - 1 &&
                    element.frame.maxY <= web.frame.minY + bottom + 1
            }
        }
        func revealEscape(_ stage: String, after sequence: Int) -> [String: NSNumber]? {
            let beforeScroll = settledGeometry(after: sequence, matchingHeight: web.frame.height)
            if !escapeReachable(beforeScroll) {
                // Scroll inside the credential column, not the native host or a
                // background route. Do not invoke any recovery/account operation.
                guard let packet = beforeScroll, let top = packet["scrollTopEdge"]?.doubleValue,
                      let bottom = packet["scrollBottomEdge"]?.doubleValue,
                      let height = packet["innerHeight"]?.doubleValue,
                      bottom > top, height > 0 else { XCTFail("VAULT_LAYOUT_SCROLLPORT_UNKNOWN"); return nil }
                XCTAssertEqual(packet["visualScale"]?.doubleValue ?? -1, 1, accuracy: 0.01, "VAULT_LAYOUT_SCROLL_SCALE_UNKNOWN")
                XCTAssertEqual(packet["visualTop"]?.doubleValue ?? -1, 0, accuracy: 1, "VAULT_LAYOUT_SCROLL_OFFSET_UNKNOWN")
                XCTAssertEqual(height, web.frame.height, accuracy: 1, "VAULT_LAYOUT_SCROLL_COORDINATES_UNKNOWN")
                guard abs((packet["visualScale"]?.doubleValue ?? -1) - 1) <= 0.01,
                      abs(packet["visualTop"]?.doubleValue ?? -1) <= 1,
                      abs(height - web.frame.height) <= 1 else { return nil }
                let start = web.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: (top + (bottom - top) * 0.8) / height))
                let end = web.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: (top + (bottom - top) * 0.2) / height))
                start.press(forDuration: 0.05, thenDragTo: end)
            }
            let packet = settledGeometry(after: beforeScroll?["sequence"]?.intValue ?? sequence)
            report(stage, packet: packet)
            XCTAssertTrue(escapeReachable(packet), "VAULT_LAYOUT_RECOVERY_ESCAPE_UNREACHABLE")
            return packet
        }
        // Prove reachability while the observed keyboard is still present.
        // Accessibility can claim Sign out is tappable outside a DOM scroller.
        guard let revealed = revealEscape("scrolled", after: focused?["sequence"]?.intValue ?? 0) else { return }
        // Never submit Unlock or read/change the credential. Hide only the
        // system keyboard when available, after its avoidance has been checked.
        let hide = app.keyboards.buttons["Hide keyboard"].firstMatch
        if hide.exists && hide.isHittable { hide.tap() }
        let originalOrientation = XCUIDevice.shared.orientation
        defer { XCUIDevice.shared.orientation = originalOrientation }
        var sequence = revealed["sequence"]?.intValue ?? 0
        // The product's iPhone Info.plist admits portrait only; iPad admits both.
        let orientations: [(String, UIDeviceOrientation)] = UIDevice.current.userInterfaceIdiom == .pad
            ? [("portrait", .portrait), ("landscape", .landscapeLeft)] : [("portrait", .portrait)]
        for (stage, orientation) in orientations {
            XCUIDevice.shared.orientation = orientation
            let rotated = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                let frame = web.frame
                return frame.width > 0 && frame.height > 0 &&
                    (orientation.isLandscape ? frame.width > frame.height : frame.height > frame.width)
            }, object: web)
            guard XCTWaiter.wait(for: [rotated], timeout: 10) == .completed else {
                XCTFail("VAULT_LAYOUT_ROTATION_NOT_APPLIED"); return
            }
            guard let packet = revealEscape(stage, after: sequence) else { return }
            sequence = packet["sequence"]?.intValue ?? sequence
            XCTAssertTrue(entry.isHittable, "VAULT_LAYOUT_ROTATED_ENTRY_CLIPPED")
            assertFieldHitRegions()
        }
        // Resume the same installed document through the normal privacy path.
        // No relaunch, reset, credential input or account operation is allowed.
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(entry.waitForExistence(timeout: 10), "VAULT_LAYOUT_RESUME_ENTRY_MISSING")
        let resumed = revealEscape("resumed", after: sequence)
        XCTAssertTrue(entry.isHittable, "VAULT_LAYOUT_RESUME_ENTRY_CLIPPED")
        assertFieldHitRegions()
        XCTAssertNotNil(resumed)
    }

    func testLocalSessionChatDrawerDoesNotReplaceThePage() throws {
        // Real device/session lane: no UITestMode, reviewer bootstrap, reset,
        // or account mutation. An optional process-only credential uses normal
        // unlock after the visible account is checked. Exercise the installed
        // build through the same controls a signed-in person sees.
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_LOCAL_SESSION_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in live-session check; requires an already-running app")
        }
        let app = XCUIApplication()
        // Attach to the owner's already-open local session. A cold launch
        // intentionally locks the vault and would turn this into a reviewer
        // credential test rather than a live-device interaction check.
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            throw XCTSkip("Continuity requires One to be running; automation must not cold-launch it")
        }
        app.activate()

        let webView = app.webViews.firstMatch
        print("CHAT_CHECK_ATTACHED")
        XCTAssertTrue(webView.waitForExistence(timeout: 60), "Local app WebView did not load")
        print("CHAT_CHECK_WEBVIEW_READY")
        let open = webView.buttons.matching(NSPredicate(
            format: "label BEGINSWITH %@", "Open chat history"
        )).firstMatch
        // Navigate through visible controls while retaining the live session.
        if !open.exists && !webView.buttons["Unlock"].exists {
            perfTapNav(app, label: "Chat")
        }
        // The existing XCUI vault helper types into a secure field. Its secret
        // arrives through the documented TEST_RUNNER_ process environment,
        // never a launch argument, source file, or test diagnostic.
        if !open.waitForExistence(timeout: 10), webView.buttons["Unlock"].exists {
            let environment = ProcessInfo.processInfo.environment
            let hasReviewerSecret = !(environment["HUSHH_UI_TEST_REVIEWER_VAULT_PASSPHRASE"]
                ?? environment["REVIEWER_VAULT_PASSPHRASE"] ?? "").isEmpty
            guard hasReviewerSecret else {
                throw XCTSkip("Live-session vault is locked and no process-only reviewer credential was supplied")
            }
            let reviewerUid = environment["HUSHH_UI_TEST_REVIEWER_UID"] ?? ""
            let reviewerEmail = environment["HUSHH_UI_TEST_REVIEWER_EMAIL"] ?? ""
            guard !reviewerUid.isEmpty, !reviewerEmail.isEmpty else {
                XCTFail("Canonical reviewer identity was not forwarded; unlock was not submitted")
                return
            }
            let account = webView.staticTexts.matching(NSPredicate(
                format: "label == %@", reviewerEmail
            )).firstMatch
            guard account.waitForExistence(timeout: 5) else {
                XCTFail("The visible vault account does not match the canonical reviewer; unlock was not submitted")
                return
            }
            let submitted = attemptVaultPassphraseUnlock(app: app)
            print("LOCAL_SESSION_UNLOCK submitted=\(submitted) lock_visible=\(webView.buttons["Unlock"].exists) secure_entry_visible=\(app.secureTextFields.firstMatch.exists)")
            if submitted, !open.waitForExistence(timeout: 2) {
                // Unlock is asynchronous. Do not look for navigation before
                // the admitted shell exists and silently skip the route change.
                let nativeChat = app.buttons["one-native-tab-chat"].firstMatch
                let webChat = webView.buttons["Chat"].firstMatch
                if nativeChat.waitForExistence(timeout: 30) || webChat.exists {
                    perfTapNav(app, label: "Chat")
                }
            }
        }
        if !open.waitForExistence(timeout: 120) {
            let vaultLockVisible = webView.buttons["Unlock"].exists
            let rejected = webView.staticTexts.matching(NSPredicate(
                format: "label CONTAINS[c] %@", "That passphrase did not match"
            )).firstMatch.exists
            XCTFail("Signed-in Chat did not load from the local build. Vault lock visible: \(vaultLockVisible) auth_rejected=\(rejected)")
            return
        }
        XCTAssertFalse(webView.buttons["Unlock"].exists,
                       "Chat must not be accepted while the vault gate remains")
        print("CHAT_CHECK_ROUTE_READY")
        let composer = webView.descendants(matching: .any).matching(NSPredicate(
            format: "label == %@", "Message One"
        )).firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 30) && composer.isHittable,
                      "Protected Chat content must be interactive after normal unlock")
        print("CHAT_CHECK_COMPOSER_READY")
        open.tap()
        let close = app.buttons.matching(NSPredicate(
            format: "label == %@", "Close chat history"
        )).firstMatch
        XCTAssertTrue(close.waitForExistence(timeout: 10), "Chat drawer cannot be closed")
        close.tap()
        XCTAssertTrue(open.waitForExistence(timeout: 10), "Chat page did not resume after closing the drawer")
        print("CHAT_CHECK_TOGGLE_READY")
        // Physical WebKit can omit the empty transcript region from its AX
        // tree. Anchor a real pan in the transcript's bottom clearance using
        // the visible header/composer, not a synthetic AX-only body element.
        let hostFrame = webView.frame
        let composerFrame = composer.frame
        let gestureY = composerFrame.minY - 48
        XCTAssertGreaterThan(gestureY, open.frame.maxY + 44,
                             "The conversation has no unobstructed body clearance")
        XCTAssertGreaterThan(hostFrame.width, 150)
        print("CHAT_CHECK_BODY_READY")
        let origin = webView.coordinate(withNormalizedOffset: .zero)
        let start = origin.withOffset(CGVector(dx: hostFrame.width * 0.20, dy: gestureY - hostFrame.minY))
        let end = origin.withOffset(CGVector(dx: hostFrame.width * 0.83, dy: gestureY - hostFrame.minY))
        start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.05)
        XCTAssertTrue(close.waitForExistence(timeout: 10), "A body swipe did not open chat history")
        print("CHAT_CHECK_SWIPE_OPEN")
        XCTAssertEqual(webView.frame, hostFrame, "The drawer shifted the Capacitor host")
        // Mirror the opening pan through the real panel body; a row beneath
        // the finger must not be selected by the release click.
        let closingStart = origin.withOffset(CGVector(dx: hostFrame.width * 0.70, dy: hostFrame.height * 0.55))
        let closingEnd = origin.withOffset(CGVector(dx: hostFrame.width * 0.16, dy: hostFrame.height * 0.55))
        closingStart.press(forDuration: 0.05, thenDragTo: closingEnd, withVelocity: .slow, thenHoldForDuration: 0.05)
        let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: close)
        XCTAssertEqual(XCTWaiter.wait(for: [dismissed], timeout: 10), .completed,
                       "A reverse body swipe did not close chat history")
        XCTAssertTrue(composer.waitForExistence(timeout: 10) && composer.isHittable)
        XCTAssertEqual(composer.frame.minX, composerFrame.minX, accuracy: 1,
                       "The drawer shifted the conversation instead of overlaying it")
        XCTAssertFalse(webView.buttons["Unlock"].exists, "The gesture lost the unlocked session")
        print("CHAT_DRAWER_GESTURE_CONTINUITY body_swipe_fixed_host")
        print("CHAT_DRAWER_BIDIRECTIONAL_CONTINUITY open_close_warm_chat")
    }

    func testLocalSessionVoiceBarCancelsFromItsBodyAndReturnsToChat() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_LOCAL_SESSION_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in attach-only voice cancellation proof")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            throw XCTSkip("One must already be running; no cold launch or reset")
        }
        app.activate()
        let hosts = app.webViews.matching(identifier: "native-webview")
        let webView = hosts.firstMatch
        XCTAssertFalse(webView.buttons["Unlock"].exists, "Normal vault unlock is required before voice proof")
        cancelRehearsalVoiceCapture(app)
        for label in ["Close Profile", "Close chat history", "Close search"] {
            let dismiss = app.buttons[label].firstMatch
            if dismiss.exists && dismiss.isHittable { dismiss.tap() }
        }
        perfTapNav(app, label: "Chat")
        let composer = webView.descendants(matching: .any).matching(NSPredicate(
            format: "label == %@", "Message One"
        )).firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 15) && composer.isHittable)
        let previousDraft = composer.value as? String ?? ""
        let syntheticDraft = "Voice cancellation check. This unsent draft must remain available after stopping."
        let insertedDraft = previousDraft.isEmpty || previousDraft == "Message One..."
        let expectedDraft = insertedDraft ? syntheticDraft : previousDraft
        if insertedDraft {
            composer.tap()
            composer.typeText(syntheticDraft)
        }
        let start = webView.buttons["Start voice mode"].firstMatch
        XCTAssertTrue(start.waitForExistence(timeout: 15) && start.isHittable)
        let cancel = webView.buttons.matching(NSPredicate(
            format: "label ENDSWITH %@ OR label == %@", ". Stop voice", "Cancel voice command"
        )).firstMatch
        addTeardownBlock {
            if cancel.exists && cancel.isHittable { cancel.tap() }
            if insertedDraft && composer.exists && composer.isHittable {
                composer.tap()
                composer.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: syntheticDraft.count))
            }
        }
        // Exercise the real shared input adapter, never a test-only endpoint.
        start.tap()
        XCTAssertTrue(cancel.waitForExistence(timeout: 5) && cancel.isHittable,
                      "The primary bar must be cancellable even while connecting")
        XCTAssertEqual(webView.buttons.matching(NSPredicate(
            format: "label ENDSWITH %@ OR label == %@", ". Stop voice", "Cancel voice command"
        )).count, 1, "Chat exposed duplicate active voice bars")
        cancel.coordinate(withNormalizedOffset: CGVector(dx: 0.65, dy: 0.5)).tap()
        XCTAssertTrue(start.waitForExistence(timeout: 10) && start.isHittable,
                      "Cancelling the body did not return to the existing Chat composer")
        XCTAssertFalse(cancel.exists, "Stopped capture remained active")
        XCTAssertTrue(composer.exists && composer.isHittable && composer.frame.height > 20,
                      "Returning from voice left the text editor collapsed")
        XCTAssertTrue((composer.value as? String) == expectedDraft,
                      "Voice cancellation did not preserve the unsent draft")
        XCTAssertFalse(webView.buttons["Unlock"].exists, "Voice cancellation lost the unlocked vault")
        XCTAssertEqual(hosts.count, 1)
        print("VOICE_BAR_CONTINUITY body_cancel_single_dock_warm_chat")
    }

    func testLocalSessionLiveSpeechCompletesWithoutSpeakerEchoLoop() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_LOCAL_SESSION_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in physical speakerphone proof")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            throw XCTSkip("One must already be running; no cold launch or reset")
        }
        app.activate()
        let webView = app.webViews.matching(identifier: "native-webview").firstMatch
        XCTAssertFalse(webView.buttons["Unlock"].exists, "Normal vault unlock is required before speech proof")
        // Cleanup is registered before any fail-fast admission assertion. Live
        // may be unavailable and the command adapter may own the microphone;
        // neither may leave capture active after this rehearsal stops.
        addTeardownBlock {
            self.cancelRehearsalVoiceCapture(app)
            XCTAssertTrue(webView.buttons["Start voice mode"].firstMatch.waitForExistence(timeout: 10),
                          "VOICE_STOP_NOT_SETTLED")
        }
        cancelRehearsalVoiceCapture(app)
        perfTapNav(app, label: "Chat")
        let start = webView.buttons["Start voice mode"].firstMatch
        XCTAssertTrue(start.waitForExistence(timeout: 15) && start.isHittable)
        let stop = webView.buttons.matching(NSPredicate(format: "label ENDSWITH %@", ". Stop voice")).firstMatch
        start.tap()
        XCTAssertTrue(stop.waitForExistence(timeout: 10), "LIVE_ADAPTER_UNAVAILABLE")
        // Button descendants are not consistently separate AX nodes in WebKit.
        let listening = webView.buttons["Listening. Stop voice"].firstMatch
        XCTAssertTrue(listening.waitForExistence(timeout: 25), "VOICE_LISTENING_UNAVAILABLE")
        let inputMatches = webView.staticTexts.matching(NSPredicate(
            format: "label BEGINSWITH[c] %@ AND label CONTAINS[c] %@", "You", "ready for testing"
        ))
        let outputMatches = webView.staticTexts.matching(NSPredicate(
            format: "label BEGINSWITH[c] %@ AND label CONTAINS[c] %@ AND NOT (label CONTAINS[c] %@)",
            "One", "ready for testing", "still speaking"
        ))
        let inputCount = inputMatches.count
        let outputCount = outputMatches.count
        // The credential-free host harness speaks a fixed synthetic question
        // only after this marker. It records neither microphone nor transcript.
        print("VOICE_SPEECH_READY")
        let inputDeadline = Date().addingTimeInterval(25)
        while inputMatches.count <= inputCount && Date() < inputDeadline { Thread.sleep(forTimeInterval: 0.25) }
        XCTAssertGreaterThan(inputMatches.count, inputCount, "VOICE_NO_RECOGNIZED_INPUT")
        let outputDeadline = Date().addingTimeInterval(45)
        while outputMatches.count <= outputCount && Date() < outputDeadline { Thread.sleep(forTimeInterval: 0.25) }
        XCTAssertGreaterThan(outputMatches.count, outputCount, "VOICE_RESPONSE_NOT_COMPLETED")
        // Ordinary speech returns to Listening, not the tool-outcome Done state.
        // In iOS speakerphone-safe mode the label stays Speaking while the
        // playback scheduler is still audible, even after model_end arrives.
        XCTAssertTrue(listening.waitForExistence(timeout: 15), "VOICE_PLAYBACK_NOT_SETTLED")
        let busy = webView.buttons.matching(NSPredicate(
            format: "label IN %@", ["Speaking. Stop voice", "One is asking. Stop voice", "Understanding. Stop voice", "Working…. Stop voice"]
        )).firstMatch
        let quietUntil = Date().addingTimeInterval(5)
        while Date() < quietUntil {
            XCTAssertFalse(busy.exists, "VOICE_REENTERED_WITHOUT_NEW_INPUT")
            Thread.sleep(forTimeInterval: 0.25)
        }
        XCTAssertTrue(stop.exists, "Voice session ended instead of settling")
        XCTAssertFalse(webView.buttons["Unlock"].exists, "Speech lost the unlocked vault")
        print("VOICE_SPEECH_COMPLETED settled_without_echo_restart")
    }

    private func cancelRehearsalVoiceCapture(_ app: XCUIApplication) {
        // Only the public microphone prompt initiated by the authorized voice
        // rehearsal is admitted. Never approve unrelated alerts or settings.
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let microphonePrompt = springboard.alerts.firstMatch
        let microphoneText = microphonePrompt.staticTexts.matching(NSPredicate(
            format: "label CONTAINS[c] %@", "microphone"
        )).firstMatch
        if microphonePrompt.exists && microphoneText.exists {
            let allow = microphonePrompt.buttons["Allow"].firstMatch
            if allow.exists && allow.isHittable { allow.tap() }
        }
        let cancellations = app.webViews.buttons.matching(NSPredicate(
            format: "label ENDSWITH %@ OR label IN %@", ". Stop voice",
            ["Cancel voice command", "Cancel recording", "Cancel task"]
        ))
        let cancel = cancellations.firstMatch
        if cancellations.count == 1 && cancel.isHittable {
            cancel.tap()
            print("VOICE_OWNED_RECOVERY capture_cancel_requested")
        }
        // A completed command result still owns the shared dock. Dismiss only
        // the existing result/error UI; never approve, retry or send a task.
        let results = app.webViews.buttons.matching(NSPredicate(format: "label == %@", "Dismiss result"))
        if results.count == 1 && results.firstMatch.isHittable {
            results.firstMatch.tap()
            print("VOICE_OWNED_RECOVERY result_dismissed")
        }
        let conversations = app.webViews.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", "One conversation"))
        if conversations.count == 1 {
            let errors = conversations.firstMatch.buttons.matching(NSPredicate(format: "label == %@", "Dismiss"))
            if errors.count == 1 && errors.firstMatch.isHittable {
                errors.firstMatch.tap()
                print("VOICE_OWNED_RECOVERY error_dismissed")
            }
        }
    }

    private func dismissRehearsalChatKeyboard(_ app: XCUIApplication) {
        guard app.keyboards.firstMatch.exists else { return }
        let web = app.webViews.matching(identifier: "native-webview").firstMatch
        guard web.exists else { return }
        // The public header title has no action owner. Do not tap transcript
        // coordinates, send/return keys or an inferred arbitrary control.
        let titles = web.staticTexts.matching(NSPredicate(format: "label == %@", "One"))
            .allElementsBoundByIndex.filter {
                $0.isHittable && $0.frame.minY >= web.frame.minY && $0.frame.maxY <= web.frame.minY + 160
            }
        guard titles.count == 1 else { return }
        titles[0].tap()
        let hidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch)
        XCTAssertEqual(XCTWaiter.wait(for: [hidden], timeout: 10), .completed,
                       "REHEARSAL_KEYBOARD_NOT_SETTLED")
    }

    func testLocalSessionNativeTabsKeepTheSessionAndRespectOverlays() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_LOCAL_SESSION_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in attach-only native navigation proof")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            throw XCTSkip("One must already be running and unlocked; no cold launch or credential typing")
        }
        app.activate()
        dismissRehearsalChatKeyboard(app)
        cancelRehearsalVoiceCapture(app)
        let bar = app.descendants(matching: .any).matching(identifier: "one-native-navigation").firstMatch
        // WebKit exposes nested AX WebView nodes on physical iOS. Count the
        // existing identified Capacitor host, not its accessibility descendants.
        let hosts = app.webViews.matching(identifier: "native-webview")
        let webView = hosts.firstMatch
        if !bar.exists {
            // Resume the existing presentation, not a cold route or fixture.
            // Report only control presence: never dump the protected hierarchy.
            for label in ["Close Profile", "Close chat history", "Close search"] {
                let dismiss = app.buttons[label].firstMatch
                if dismiss.exists && dismiss.isHittable { dismiss.tap() }
            }
            print("NATIVE_NAVIGATION_ADMISSION vault_unlock_visible=\(webView.buttons["Unlock"].exists) secure_entry_visible=\(app.secureTextFields.firstMatch.exists) google_signin_visible=\(app.buttons["Continue with Google"].exists) privacy_cover_visible=\(app.otherElements["session-privacy-shield"].exists) privacy_retry_visible=\(app.buttons["session-privacy-retry"].exists) native_chat_visible=\(app.buttons["one-native-tab-chat"].exists)")
        }
        XCTAssertTrue(bar.waitForExistence(timeout: 30), "The installed candidate did not expose native tabs")
        func tab(_ name: String) -> XCUIElement { bar.buttons[name] }
        func tap(_ name: String) {
            XCTAssertTrue(tab(name).waitForExistence(timeout: 15) && tab(name).isHittable,
                          "Native tab is missing or isolated")
            tab(name).tap()
        }
        tap("Chat")
        XCTAssertEqual(hosts.count, 1, "Tabs must use one identified Capacitor WebView")
        XCTAssertEqual(app.webViews.count, 1 + webView.webViews.count,
                       "Every WebView accessibility node must belong to the same Capacitor host")
        let history = webView.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Open chat history")).firstMatch
        XCTAssertTrue(history.waitForExistence(timeout: 30), "Chat did not settle without another vault unlock")
        history.tap()
        let close = app.buttons["Close chat history"]
        XCTAssertTrue(close.waitForExistence(timeout: 10))
        XCTAssertFalse(bar.exists && bar.isHittable, "Native tabs escaped the web overlay")
        close.tap()
        tap("One")
        XCTAssertFalse(webView.buttons["Unlock"].exists, "A tab switch lost the unlocked session")
        tap("Connect")
        tap("Feed")
        tap("Chat")
        XCTAssertTrue(history.waitForExistence(timeout: 30))
        XCTAssertEqual(hosts.count, 1)
        XCTAssertEqual(app.webViews.count, 1 + webView.webViews.count,
                       "Tab switching introduced another WebView host")
        XCTAssertTrue(tab("Chat").isSelected, "Final selection did not match the settled Chat destination")
        tap("Search")
        // Search is the existing command palette, never a new native route.
        let dismiss = app.buttons["Close search"].firstMatch
        XCTAssertTrue(dismiss.waitForExistence(timeout: 10),
                      "Native Search did not open the existing command palette")
        XCTAssertFalse(bar.exists && bar.isHittable, "Native tabs remained accessible under Search")
        dismiss.tap()
        XCTAssertTrue(bar.waitForExistence(timeout: 10) && bar.isHittable)
        print("NATIVE_NAVIGATION_CONTINUITY tabs_overlay_single_webview")
    }

    func testLocalSessionNativeBackRetiresUnderProfileAndReturnsToOne() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_NATIVE_CHROME_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in Back pilot acceptance; requires the current Debug candidate")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            throw XCTSkip("One must already be running and unlocked; no cold launch or credential typing")
        }
        app.activate()
        dismissRehearsalChatKeyboard(app)
        let hosts = app.webViews.matching(identifier: "native-webview")
        let webView = hosts.firstMatch
        XCTAssertTrue(webView.waitForExistence(timeout: 15), "The existing Capacitor host is unavailable")
        for label in ["Close Profile", "Close chat history", "Close search"] {
            let close = app.buttons[label].firstMatch
            if close.exists && close.isHittable { close.tap() }
        }
        XCTAssertFalse(webView.buttons["Unlock"].exists, "The candidate requires a normal vault unlock before warm-session proof")
        XCTAssertFalse(app.buttons["Continue with Google"].exists, "Warm-session proof cannot substitute a new sign-in")
        let bar = app.descendants(matching: .any).matching(identifier: "one-native-navigation").firstMatch
        let one = bar.buttons["One"]
        XCTAssertTrue(one.waitForExistence(timeout: 15) && one.isHittable,
                      "The existing session has not admitted native navigation")
        one.tap()
        let wallet = webView.links["Open Wallet"].firstMatch
        XCTAssertTrue(wallet.waitForExistence(timeout: 15), "One must expose the existing Wallet route")
        for _ in 0..<3 {
            if wallet.isHittable { break }
            webView.swipeUp()
        }
        XCTAssertTrue(wallet.isHittable)
        wallet.tap()
        let back = app.buttons["top-shell-back"].firstMatch
        XCTAssertTrue(back.waitForExistence(timeout: 10) && back.isHittable,
                      "The candidate did not admit the native Back pilot")
        XCTAssertEqual(back.frame.width, 44, accuracy: 1)
        XCTAssertEqual(back.frame.height, 44, accuracy: 1)
        // Physical WebKit's AX subtree includes the sibling hosting view. The
        // same native button may therefore match the WebView label query;
        // exclude only its explicit identifier, never an unnamed DOM duplicate.
        XCTAssertEqual(app.buttons.matching(identifier: "top-shell-back").count, 1)
        let domBack = webView.buttons.matching(NSPredicate(
            format: "label == %@ AND identifier != %@", "Go back", "top-shell-back"
        )).firstMatch
        XCTAssertFalse(domBack.exists, "DOM and native Back must not both be accessible")
        XCTAssertFalse(webView.buttons["Unlock"].exists, "Wallet lost the unlocked session")
        XCTAssertEqual(hosts.count, 1)

        let probe = app.buttons["native-back-continuity"].firstMatch
        func counters() -> [String: Int]? {
            guard probe.exists, let json = probe.value as? String, let data = json.data(using: .utf8),
                  let packet = try? JSONSerialization.jsonObject(with: data) as? [String: Int],
                  Set(packet.keys) == Set(["installs", "removals", "replacements", "sampledFrames", "missingFrames"])
            else { return nil }
            return packet
        }
        guard let beforeOverlay = counters() else { XCTFail("NATIVE_BACK_MEASUREMENTS_UNAVAILABLE"); return }

        let profile = app.buttons["Open Profile"].firstMatch
        XCTAssertTrue(profile.exists && profile.isHittable)
        XCTAssertGreaterThanOrEqual(profile.frame.width, 44)
        XCTAssertGreaterThanOrEqual(profile.frame.height, 44)
        profile.tap()
        let close = app.buttons["Close Profile"].firstMatch
        XCTAssertTrue(close.waitForExistence(timeout: 10) && close.isHittable)
        let overlayRetirement = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: back)
        XCTAssertEqual(XCTWaiter.wait(for: [overlayRetirement], timeout: 10), .completed,
                       "Native Back remained accessible under the Profile overlay")
        XCTAssertGreaterThan(counters()?["removals"] ?? -1, beforeOverlay["removals", default: 0],
                             "The measurement negative control did not observe physical removal")
        close.tap()
        XCTAssertTrue(back.waitForExistence(timeout: 10) && back.isHittable)

        XCUIDevice.shared.press(.home)
        XCTAssertTrue(app.wait(for: .runningBackground, timeout: 5) || app.state == .runningBackgroundSuspended,
                      "One did not enter the background")
        guard [.runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            XCTFail("One stopped while backgrounded; the test must not cold-launch it")
            return
        }
        app.activate()
        XCTAssertTrue(back.waitForExistence(timeout: 10) && back.isHittable,
                      "Back did not recover after normal background/resume")
        XCTAssertFalse(webView.buttons["Unlock"].exists, "Resume lost the unlocked session")
        // Exercise the edge of the admitted 44pt target, not only its glyph.
        back.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5)).tap()
        XCTAssertTrue(wallet.waitForExistence(timeout: 15), "Back did not invoke the existing return-to-One handler")
        let routeRetirement = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: back)
        XCTAssertEqual(XCTWaiter.wait(for: [routeRetirement], timeout: 10), .completed,
                       "Native Back remained accessible after returning to One")

        // Consent tabs change the authored route query while retaining the
        // same Back geometry. Unlike local Mail pager state, this exercises
        // the actual replacement contract, not merely same-route stability.
        let consent = webView.links["Open Consent"].firstMatch
        XCTAssertTrue(consent.waitForExistence(timeout: 15), "CONSENT_ENTRY_UNAVAILABLE")
        for _ in 0..<4 { if consent.isHittable { break }; webView.swipeDown() }
        for _ in 0..<4 { if consent.isHittable { break }; webView.swipeUp() }
        XCTAssertTrue(consent.isHittable)
        consent.tap()
        XCTAssertTrue(back.waitForExistence(timeout: 10) && back.isHittable)
        let measured = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            (counters()?["sampledFrames"] ?? 0) > 0
        }, object: probe)
        XCTAssertEqual(XCTWaiter.wait(for: [measured], timeout: 5), .completed, "NATIVE_BACK_MEASUREMENTS_UNAVAILABLE")
        let originalFrame = back.frame
        var completedHandoffs = 0
        for name in ["Active", "History", "Connections", "Requests"] {
            let tab = webView.buttons.matching(NSPredicate(format: "label == %@", name)).firstMatch
            XCTAssertTrue(tab.waitForExistence(timeout: 10) && tab.isHittable)
            if tab.isSelected { continue }
            guard let before = counters() else { XCTFail("NATIVE_BACK_MEASUREMENTS_UNAVAILABLE"); return }
            tab.tap()
            let replaced = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                guard let after = counters() else { return false }
                return tab.isSelected && back.exists && back.isHittable &&
                    after["replacements", default: 0] > before["replacements", default: 0] &&
                    after["sampledFrames", default: 0] > before["sampledFrames", default: 0]
            }, object: probe)
            XCTAssertEqual(XCTWaiter.wait(for: [replaced], timeout: 10), .completed, "NATIVE_BACK_REPLACEMENT_NOT_OBSERVED")
            guard let activated = counters() else { XCTFail("NATIVE_BACK_MEASUREMENTS_UNAVAILABLE"); return }
            // A frame before replacement can advance the global sample count.
            // Require another published frame after fresh native activation.
            let displayed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                (counters()?["sampledFrames"] ?? -1) > activated["sampledFrames", default: 0]
            }, object: probe)
            XCTAssertEqual(XCTWaiter.wait(for: [displayed], timeout: 5), .completed, "NATIVE_BACK_POST_ACTIVATION_FRAME_UNOBSERVED")
            guard let after = counters() else { XCTFail("NATIVE_BACK_MEASUREMENTS_UNAVAILABLE"); return }
            XCTAssertEqual(after["installs"], before["installs"], "Route transition rebuilt the native host")
            XCTAssertEqual(after["removals"], before["removals"], "Route transition removed the native host")
            XCTAssertEqual(after["missingFrames"], before["missingFrames"], "Route transition hid or detached the native control")
            XCTAssertEqual(back.frame, originalFrame)
            XCTAssertFalse(domBack.exists, "Replacement exposed a duplicate DOM Back")
            completedHandoffs += 1
        }
        XCTAssertGreaterThan(completedHandoffs, 0, "No qualifying Back handoff was exercised")
        back.tap()
        XCTAssertTrue(wallet.waitForExistence(timeout: 15), "Fresh Back did not invoke the authored return handler")
        XCTAssertFalse(webView.buttons["Unlock"].exists)
        XCTAssertEqual(hosts.count, 1, "Back introduced another Capacitor host")
        XCTAssertEqual(app.webViews.count, 1 + webView.webViews.count)
        print("NATIVE_BACK_REPLACEMENT_CONTINUITY query_tabs_retained_host_observed_frames_current_handler")
        print("NATIVE_BACK_CONTINUITY layout_overlay_resume_existing_handler_single_host")
    }

    func testLocalSessionNativeChatControlsRespectOverlayKeyboardAndSingleHost() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_NATIVE_CHROME_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in native History/Close and selector proof; Debug candidate must admit these families")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            throw XCTSkip("Attach only: no cold launch, reviewer bootstrap or credential entry")
        }
        app.activate()
        let hosts = app.webViews.matching(identifier: "native-webview")
        let web = hosts.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 15), "NATIVE_CHAT_HOST_UNAVAILABLE")
        XCTAssertFalse(web.buttons["Unlock"].exists, "Normal vault unlock is required before chat-family proof")
        XCTAssertFalse(app.buttons["Continue with Google"].exists, "Chat-family proof must not manufacture sign-in")
        for label in ["Close Profile", "Close chat history", "Close search"] {
            let close = app.buttons[label].firstMatch
            if close.exists && close.isHittable { close.tap() }
        }
        perfTapNav(app, label: "Chat")
        dismissRehearsalChatKeyboard(app)
        // Drawer dismissal intentionally restores DOM focus even with no
        // keyboard. Leave that public fallback before requiring native chrome.
        let entryTitles = web.staticTexts.matching(NSPredicate(format: "label == %@", "One"))
            .allElementsBoundByIndex.filter {
                $0.isHittable && $0.frame.minY >= web.frame.minY && $0.frame.maxY <= web.frame.minY + 160
            }
        guard entryTitles.count == 1 else { XCTFail("NATIVE_CHAT_HEADER_TITLE_UNAVAILABLE"); return }
        entryTitles[0].tap()
        let composer = web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Message One")).firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 15) && composer.isHittable,
                      "Begin on idle Cloud Chat with the existing unlocked session")
        XCTAssertFalse(web.buttons["Stop One"].exists, "Do not change surfaces while an existing turn is active")
        let hostFrame = web.frame
        let nativeHistory = app.buttons["chat-history-toggle"].firstMatch
        let retainedHistory = web.buttons.matching(identifier: "one-chat-history-trigger")
        let history = app.buttons.matching(NSPredicate(
            format: "identifier == %@ AND label BEGINSWITH %@", "chat-history-toggle", "Open chat history")).firstMatch
        let selector = app.segmentedControls["chat-agent-surface"].firstMatch
        func segment(_ value: String) -> XCUIElement {
            let names = value == "one" ? ["Cloud", "One, your cloud agent"] :
                ["Puppy", "Puppy One, on your machine, with its own conversation"]
            return selector.buttons.matching(NSPredicate(format: "label IN %@", names)).firstMatch
        }
        func assertSameHost() {
            XCTAssertEqual(hosts.count, 1, "Chat controls must retain the identified Capacitor host")
            XCTAssertEqual(app.webViews.count, 1 + web.webViews.count, "Chat controls introduced another WebView host")
            XCTAssertEqual(web.frame, hostFrame, "The overlay or surface change replaced/moved the host")
            XCTAssertFalse(web.buttons["Unlock"].exists, "Chat controls lost the unlocked session")
        }
        func awaitAbsent(_ element: XCUIElement, _ message: String) {
            let removed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)
            XCTAssertEqual(XCTWaiter.wait(for: [removed], timeout: 10), .completed, message)
        }
        print("NATIVE_CHAT_ENTRY keyboard=\(app.keyboards.firstMatch.exists) history_dom=\(web.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ AND identifier != %@", "Open chat history", "chat-history-toggle")).firstMatch.exists) picker_native=\(selector.exists)")
        let selectorRoots = app.descendants(matching: .any).matching(identifier: "chat-agent-surface")
        let fallbackNames = web.descendants(matching: .any).matching(NSPredicate(format: "label IN %@", [
            "One, your cloud agent", "Puppy One, on your machine, with its own conversation"
        ]))
        print("NATIVE_CHAT_SELECTOR_PROBE roots=\(selectorRoots.count) role=\(selectorRoots.firstMatch.exists ? selectorRoots.firstMatch.elementType.rawValue : 0) fallback_names=\(fallbackNames.count)")
        let status = web.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "NATIVE_SELECTOR_STATUS ")).firstMatch
        if status.exists {
            let fields = String(status.label.dropFirst("NATIVE_SELECTOR_STATUS ".count))
            if fields.utf8.count <= 1024,
               let data = fields.data(using: .utf8),
               let snapshot = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                let stages = ["skip", "retire", "prepare", "activate", "update"]
                let outcomes = ["pending", "acknowledged", "rejected"]
                let codes = ["none", "other", "not-admitted", "focused", "geometry",
                    "NATIVE_CHROME_ACK_UNCERTAIN", "NATIVE_CHROME_PREPARE_REFUSED",
                    "NATIVE_CHROME_DOCUMENT_OR_GEOMETRY_STALE", "NATIVE_CHROME_OVERLAPPING_CONTROLS",
                    "NATIVE_CHROME_OPTIONS_INVALID", "NATIVE_CHROME_LAYOUT_UNCONFIRMED",
                    "NATIVE_CHROME_LAYOUT_RETIRED", "NATIVE_CHROME_ACTIVATE_REFUSED",
                    "NATIVE_CHROME_ACTIVATE_UNCONFIRMED", "NATIVE_CHROME_RETIRE_UNCONFIRMED",
                    "NATIVE_CHROME_UPDATE_INVALID", "NATIVE_CHROME_UPDATE_UNCONFIRMED"]
                var safe: [String: Any] = [:]
                for (key, values) in [("stage", stages), ("outcome", outcomes), ("code", codes)] {
                    safe[key] = (snapshot[key] as? String).flatMap { values.contains($0) ? $0 : nil } ?? "other"
                }
                for key in ["eligible", "supported", "allowed", "focusInside", "heldFocus", "inViewport"] {
                    safe[key] = snapshot[key] as? Bool ?? false
                }
                for key in ["width", "height"] { safe[key] = max(0, min(10000, snapshot[key] as? Int ?? 0)) }
                if let encoded = try? JSONSerialization.data(withJSONObject: safe, options: [.sortedKeys]),
                   let literal = String(data: encoded, encoding: .utf8) { print("NATIVE_SELECTOR_REHEARSAL \(literal)") }
            }
        }
        XCTAssertTrue(history.waitForExistence(timeout: 15) && history.isHittable,
                      "NATIVE_CHAT_HISTORY_UNAVAILABLE")
        XCTAssertTrue(selector.waitForExistence(timeout: 15) && selector.isHittable, "NATIVE_CHAT_PICKER_UNAVAILABLE")
        let headerTop = min(history.frame.minY, selector.frame.minY)
        let headerBottom = max(history.frame.maxY, selector.frame.maxY)
        func blurThroughAuthoredTitle() {
            // This public static title has no action owner. Do not tap arbitrary
            // transcript coordinates or the keyboard's destructive Send key.
            let title = web.staticTexts.matching(NSPredicate(format: "label == %@", "One"))
                .allElementsBoundByIndex.first { $0.isHittable && $0.frame.minY >= headerTop - 1 && $0.frame.maxY <= headerBottom + 1 }
            guard let title else { XCTFail("NATIVE_CHAT_HEADER_TITLE_UNAVAILABLE"); return }
            title.tap()
        }
        func assertNativeTargets() {
            XCTAssertEqual(app.buttons.matching(identifier: "chat-history-toggle").count, 1,
                           "Admit exactly one native History control")
            XCTAssertEqual(retainedHistory.count, 0, "DOM History must retire before native activation")
            XCTAssertEqual(app.segmentedControls.matching(identifier: "chat-agent-surface").count, 1)
            XCTAssertGreaterThanOrEqual(history.frame.width, 44)
            XCTAssertGreaterThanOrEqual(history.frame.height, 44)
            XCTAssertFalse(history.frame.intersects(selector.frame), "Independent controls overlap")
            let cloud = segment("one"), puppy = segment("puppy")
            XCTAssertTrue(cloud.exists && cloud.isHittable && puppy.exists && puppy.isHittable,
                          "The system Picker must expose exactly the two authored selectable segments")
            XCTAssertEqual(selector.buttons.count, 2)
            // This measures accessible system segments, not the 44pt SwiftUI
            // hosting rectangle. A smaller large Picker is not admitted by fiat.
            for option in [cloud, puppy] {
                print("NATIVE_CHAT_PICKER_GEOMETRY width=\(Int(option.frame.width)) height=\(Int(option.frame.height))")
                XCTAssertGreaterThanOrEqual(option.frame.width, 44, "NATIVE_CHAT_PICKER_SEGMENT_WIDTH_UNADMITTED")
                XCTAssertGreaterThanOrEqual(option.frame.height, 44, "NATIVE_CHAT_PICKER_SEGMENT_HEIGHT_UNADMITTED")
            }
            // Exclude the known native segments explicitly. AX membership under
            // WebKit alone is not proof that an element is DOM-owned.
            let publicNames = NSPredicate(format: "label IN %@", [
                "One, your cloud agent", "Puppy One, on your machine, with its own conversation"
            ])
            let nestedNative = web.segmentedControls["chat-agent-surface"].firstMatch
            let permitted = nestedNative.exists ? nestedNative.descendants(matching: .any).matching(publicNames).count : 0
            XCTAssertEqual(web.descendants(matching: .any).matching(publicNames).count, permitted,
                           "Authored DOM and native selector both remained accessible")
            assertSameHost()
        }
        assertNativeTargets()
        let historyDialogLabel = web.descendants(matching: .any).matching(NSPredicate(
            format: "label == %@", "Agent chat history")).firstMatch
        // WebKit need not project a named DOM container as an AX element.
        // Opening is proved by the public heading and the owned native Close,
        // not by assuming that optional container label survives the bridge.
        let historyHeading = web.staticTexts["Chats"].firstMatch
        let close = app.buttons.matching(NSPredicate(
            format: "identifier == %@ AND label == %@", "chat-history-toggle", "Close chat history")).firstMatch
        addTeardownBlock {
            if close.exists && close.isHittable { close.tap() }
            if app.keyboards.firstMatch.exists { blurThroughAuthoredTitle() }
            // Restore only the permitted Cloud surface, never select/delete a
            // conversation, send a draft, alter an account, or dump its AX tree.
            let cloud = segment("one")
            if cloud.exists && cloud.isHittable && !cloud.isSelected { cloud.tap() }
        }
        XCTAssertFalse(historyHeading.exists, "History must be closed before its opener is tested")
        history.tap()
        let nativeCloseAppeared = close.waitForExistence(timeout: 10)
        let chatsHeadingVisible = web.staticTexts["Chats"].firstMatch.exists
        print("NATIVE_HISTORY_ACTION_RESULT native_close=\(nativeCloseAppeared) dialog_label=\(historyDialogLabel.exists) chats_heading=\(chatsHeadingVisible)")
        XCTAssertTrue(historyHeading.waitForExistence(timeout: 10) && historyHeading.isHittable, "The authored History drawer did not appear")
        XCTAssertTrue(nativeCloseAppeared && close.isHittable, "Native History did not hand off to its owned Close")
        let isolatedHistory = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            !history.exists || !history.isHittable
        }, object: history)
        XCTAssertEqual(XCTWaiter.wait(for: [isolatedHistory], timeout: 10), .completed,
                       "The underlying header History remained interactive beneath its drawer")
        XCTAssertEqual(app.buttons.matching(identifier: "chat-history-toggle").count, 1, "Close handoff duplicated the control")
        XCTAssertGreaterThanOrEqual(close.frame.width, 44)
        XCTAssertGreaterThanOrEqual(close.frame.height, 44)
        XCTAssertFalse(web.buttons.matching(NSPredicate(
            format: "label == %@ AND identifier != %@", "Close chat history", "chat-history-toggle")).firstMatch.exists,
            "DOM and native Close must not both be accessible")
        awaitAbsent(selector, "Native selector remained accessible under history")
        assertSameHost()
        close.tap()
        awaitAbsent(close, "History did not dismiss")
        // Native/gesture return must not pin a focused DOM hamburger. No
        // unrelated blur tap may be used to make the handoff pass.
        XCTAssertTrue(history.waitForExistence(timeout: 10) && history.isHittable,
                      "Native History did not return without a second blur")
        XCTAssertTrue(selector.waitForExistence(timeout: 10) && selector.isHittable,
                      "Native selector did not return after History dismissal")
        assertNativeTargets()
        for _ in 0..<2 {
            let openProfile = web.buttons["Open Profile"].firstMatch
            XCTAssertTrue(openProfile.exists && openProfile.isHittable)
            openProfile.tap()
            let nativeClose = app.buttons.matching(NSPredicate(
                format: "identifier == %@ AND label == %@", "profile-close", "Close Profile")).firstMatch
            XCTAssertTrue(nativeClose.waitForExistence(timeout: 10) && nativeClose.isHittable,
                          "Profile Close must remain native across repeated opens")
            XCTAssertGreaterThanOrEqual(nativeClose.frame.width, 44)
            XCTAssertGreaterThanOrEqual(nativeClose.frame.height, 44)
            XCTAssertFalse(web.buttons.matching(NSPredicate(
                format: "label == %@ AND identifier != %@", "Close Profile", "profile-close")).firstMatch.exists,
                "Profile must not expose duplicate native and web Close controls")
            nativeClose.tap()
            awaitAbsent(nativeClose, "Native Profile Close did not retire after dismissal")
            XCTAssertTrue(history.waitForExistence(timeout: 10) && history.isHittable)
            XCTAssertTrue(selector.waitForExistence(timeout: 10) && selector.isHittable)
            assertSameHost()
        }
        print("NATIVE_CHROME_REOPEN history=true profile_cycles=2")
        segment("puppy").tap()
        let puppyComposer = web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Message Puppy One")).firstMatch
        // A reviewer with no Puppy conversations has an authored empty state,
        // not a composer. Creating a conversation just to satisfy this chrome
        // check would mutate the account and substitute a different journey.
        let puppyStart = web.buttons["Start a Puppy chat"].firstMatch
        let puppySurface = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            puppyComposer.exists || puppyStart.exists
        }, object: app)
        XCTAssertEqual(XCTWaiter.wait(for: [puppySurface], timeout: 15), .completed,
                       "Native selector did not enter the authored Puppy surface")
        let puppySelected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "selected == true"), object: segment("puppy"))
        XCTAssertEqual(XCTWaiter.wait(for: [puppySelected], timeout: 10), .completed, "React selection was not projected back to Picker")
        assertSameHost()
        segment("one").tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 15) && composer.isHittable, "Cloud did not return without sending or resetting")
        let cloudSelected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "selected == true"), object: segment("one"))
        XCTAssertEqual(XCTWaiter.wait(for: [cloudSelected], timeout: 10), .completed)
        composer.tap() // No typeText: preserve the complete existing draft.
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10), "Keyboard did not open")
        XCTAssertFalse(nativeHistory.exists, "Native History appeared over the keyboard")
        awaitAbsent(selector, "Native selector remained accessible over the keyboard")
        blurThroughAuthoredTitle()
        awaitAbsent(app.keyboards.firstMatch, "Keyboard did not dismiss through the public header")
        XCTAssertTrue(history.waitForExistence(timeout: 10) && history.isHittable)
        XCTAssertTrue(selector.waitForExistence(timeout: 10) && selector.isHittable)
        assertNativeTargets()
        print("NATIVE_CHAT_CHROME_CONTINUITY owned_history_close_native_picker_overlay_keyboard_cloud_return_single_host")
    }

    func testStockControlReference() throws {
        // Public interaction reference only; neither its look nor this test
        // establishes Apple's implementation framework or admits our controls.
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_NATIVE_CHROME_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in bounded Clock/Calculator observation with return to existing Cloud Chat")
        }
        let one = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(one.state) else {
            throw XCTSkip("One must already be running; no launch, reset or credential entry")
        }
        one.activate()
        let hosts = one.webViews.matching(identifier: "native-webview")
        let host = hosts.firstMatch
        XCTAssertTrue(host.waitForExistence(timeout: 15))
        XCTAssertFalse(host.buttons["Unlock"].exists, "Normal vault unlock is required before stock comparison")
        let composer = host.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Message One")).firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 10) && composer.isHittable,
                      "Begin stock reference on interactive Cloud Chat")
        XCTAssertFalse(host.buttons["Stop One"].exists, "Do not interrupt an existing active turn")
        defer {
            // Return even on a fail-fast assertion; never inspect a result,
            // history, note, alarm or timer, nor attach protected screenshots.
            one.activate()
            XCTAssertTrue(host.waitForExistence(timeout: 15))
            XCTAssertTrue(composer.waitForExistence(timeout: 15) && composer.isHittable,
                          "STOCK_REFERENCE_WARM_CHAT_NOT_RESTORED")
            XCTAssertFalse(host.buttons["Unlock"].exists, "Stock reference lost the unlocked session")
            XCTAssertEqual(hosts.count, 1)
            XCTAssertEqual(one.webViews.count, 1 + host.webViews.count)
        }

        let calculator = XCUIApplication(bundleIdentifier: "com.apple.calculator")
        calculator.activate()
        XCTAssertTrue(calculator.wait(for: .runningForeground, timeout: 10), "STOCK_CALCULATOR_UNAVAILABLE")
        // No onboarding dismissal, number entry, mode selection or menu action.
        // Only inspect the public toolbar affordance in an already-admitted app.
        let modeNames = ["Calculator Mode", "Calculator mode", "Calculator Modes", "Calculator modes", "Choose Calculator"]
        let mode = calculator.buttons.matching(NSPredicate(format: "label IN %@", modeNames)).firstMatch
        XCTAssertTrue(mode.waitForExistence(timeout: 10) && mode.isHittable,
                      "STOCK_CALCULATOR_MODE_UNAVAILABLE: public locator requires characterization, not a silent pass")
        print("STOCK_CALCULATOR_MODE available=\(mode.exists && mode.isHittable)")
        if mode.exists {
            print("STOCK_CALCULATOR_CONTROL name=Calculator Mode width=\(Int(mode.frame.width)) height=\(Int(mode.frame.height)) hittable=\(mode.isHittable)")
        }

        let clock = XCUIApplication(bundleIdentifier: "com.apple.mobiletimer")
        clock.activate()
        XCTAssertTrue(clock.wait(for: .runningForeground, timeout: 10), "STOCK_CLOCK_UNAVAILABLE")
        let tabs = clock.tabBars.firstMatch
        XCTAssertTrue(tabs.waitForExistence(timeout: 10), "STOCK_CLOCK_TABS_UNAVAILABLE")
        let publicTabNames = ["World Clock", "Alarm", "Alarms", "Stopwatch", "Timer", "Timers"]
        let observed = publicTabNames.compactMap { name -> XCUIElement? in
            let tab = tabs.buttons[name].firstMatch
            guard tab.exists else { return nil }
            print("STOCK_CLOCK_TAB name=\(name) width=\(Int(tab.frame.width)) height=\(Int(tab.frame.height)) selected=\(tab.isSelected) hittable=\(tab.isHittable)")
            return tab
        }
        XCTAssertEqual(observed.count, 4, "STOCK_CLOCK_PUBLIC_TAB_SET_INCOMPLETE")
        XCTAssertEqual(observed.filter { $0.isSelected }.count, 1, "STOCK_CLOCK_SELECTION_UNAVAILABLE")
        XCTAssertTrue(observed.allSatisfy { $0.isHittable && $0.frame.width > 0 && $0.frame.height > 0 })
        // Observation only: no selecting/start/stop/add/delete in Clock.
        one.activate()
        XCTAssertTrue(host.waitForExistence(timeout: 15))
        XCTAssertTrue(composer.waitForExistence(timeout: 15) && composer.isHittable)
        XCTAssertFalse(host.buttons["Unlock"].exists)
        print("STOCK_REFERENCE_RETURN warm_chat=true")
    }

    func testLocalSessionProfilePhotoPreviewDoesNotChangePhoto() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_LOCAL_SESSION_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in profile preview proof; no credentials or photo mutation")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            throw XCTSkip("One must already be running and unlocked")
        }
        app.activate()
        let hosts = app.webViews.matching(identifier: "native-webview")
        let webView = hosts.firstMatch
        let previousProfile = app.buttons["Close Profile"].firstMatch
        if previousProfile.exists && previousProfile.isHittable { previousProfile.tap() }
        let openProfile = app.buttons["Open Profile"].firstMatch
        XCTAssertTrue(openProfile.waitForExistence(timeout: 15) && openProfile.isHittable)
        XCTAssertGreaterThanOrEqual(openProfile.frame.width, 44, "Profile photo needs a full shell hit target")
        XCTAssertGreaterThanOrEqual(openProfile.frame.height, 44, "Profile photo needs a full shell hit target")
        openProfile.tap()
        // The pane can resume a nested setting from the same session. Reach
        // its home through its actual Back controls, not a cold route/reset.
        for _ in 0..<3 {
            let backInProfile = app.buttons["Back in Profile"].firstMatch
            if !backInProfile.waitForExistence(timeout: 1) || !backInProfile.isHittable { break }
            backInProfile.tap()
        }
        let photo = app.buttons["View profile photo"].firstMatch
        if !photo.waitForExistence(timeout: 15) {
            XCTContext.runActivity(named: "PROFILE_PHOTO_ADMISSION fallback_visible=\(app.buttons["Profile photo options"].exists) root_visible=\(app.staticTexts["Your settings"].exists) nested_back_visible=\(app.buttons["Back in Profile"].exists)") { _ in }
        }
        XCTAssertTrue(photo.waitForExistence(timeout: 15) && photo.isHittable,
                      "The reviewer profile must have an existing photo for this proof")
        photo.tap()
        XCTAssertTrue(app.buttons["Photo options"].waitForExistence(timeout: 10),
                      "Photo preview did not open in place")
        let close = app.buttons["Close"].firstMatch
        XCTAssertTrue(close.exists && close.isHittable, "Photo preview lacks a close control")
        close.tap()
        XCTAssertTrue(photo.waitForExistence(timeout: 10), "Profile did not resume after closing preview")
        XCTAssertEqual(hosts.count, 1, "Preview must retain the identified Capacitor WebView")
        XCTAssertEqual(app.webViews.count, 1 + webView.webViews.count,
                       "Photo preview introduced another WebView host")
        XCTAssertFalse(webView.buttons["Unlock"].exists, "Preview lost the unlocked session")
        let profileClose = app.buttons["Close Profile"].firstMatch
        XCTAssertTrue(profileClose.exists && profileClose.isHittable)
        // Drag the unoccupied middle of the owned Profile header, not a row
        // action, field, photo, horizontal rail or an inferred DOM control.
        let origin = webView.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
        let headerY = profileClose.frame.midY - webView.frame.minY
        let pullStart = origin.withOffset(CGVector(dx: webView.frame.width * 0.40, dy: headerY))
        let pullEnd = origin.withOffset(CGVector(dx: webView.frame.width * 0.86, dy: headerY + 2))
        let hostFrame = webView.frame
        pullStart.press(forDuration: 0.05, thenDragTo: pullEnd)
        let retired = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: profileClose)
        XCTAssertEqual(XCTWaiter.wait(for: [retired], timeout: 10), .completed,
                       "Profile pull did not dismiss through its owning Sheet")
        XCTAssertEqual(webView.frame, hostFrame, "Profile pull moved the Capacitor host")
        XCTAssertFalse(webView.buttons["Unlock"].exists, "Profile pull lost the unlocked session")
        print("PROFILE_DRAG_CONTINUITY close_warm_single_host")
        print("PROFILE_PHOTO_PREVIEW_CONTINUITY open_close_without_mutation")
    }

    func testLocalSessionMailPagerAndSoftwareKeyboardKeepTheSession() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_LOCAL_SESSION_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in warm Mail pager and software-keyboard regression")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            throw XCTSkip("One must already be running; no cold launch or reset")
        }
        app.activate()
        cancelRehearsalVoiceCapture(app)
        let hosts = app.webViews.matching(identifier: "native-webview")
        let web = hosts.firstMatch
        XCTAssertFalse(web.buttons["Unlock"].exists, "Normal vault unlock is required")
        defer {
            self.dismissRehearsalChatKeyboard(app)
            self.perfTapNav(app, label: "Chat")
        }
        for label in ["Close Profile", "Close chat history", "Close search"] {
            let close = app.buttons[label].firstMatch
            if close.exists && close.isHittable { close.tap() }
        }
        perfTapNav(app, label: "Chat")
        let composer = web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Message One")).firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 15) && composer.isHittable)
        let draft = composer.value as? String
        // Open the actual software keyboard; do not overwrite or submit a draft.
        composer.tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 10), "SOFTWARE_KEYBOARD_NOT_PRESENT")
        let clearOfKeyboard = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            composer.frame.maxY <= keyboard.frame.minY + 2
        }, object: composer)
        XCTAssertEqual(XCTWaiter.wait(for: [clearOfKeyboard], timeout: 10), .completed,
                       "COMPOSER_DID_NOT_SETTLE_ABOVE_KEYBOARD")
        XCTAssertLessThanOrEqual(composer.frame.maxY, keyboard.frame.minY + 2,
                                 "COMPOSER_OBSCURED_BY_SOFTWARE_KEYBOARD")
        XCTAssertGreaterThanOrEqual(composer.frame.minX, web.frame.minX)
        XCTAssertLessThanOrEqual(composer.frame.maxX, web.frame.maxX)
        dismissRehearsalChatKeyboard(app)
        XCTAssertFalse(keyboard.exists, "SOFTWARE_KEYBOARD_NOT_DISMISSED")
        XCTAssertTrue((composer.value as? String) == draft, "KEYBOARD_CHANGED_UNSENT_DRAFT")
        perfTapNav(app, label: "One")
        let mail = web.links.matching(NSPredicate(format: "label == %@", "Open Mail")).firstMatch
        XCTAssertTrue(mail.waitForExistence(timeout: 15) && mail.isHittable, "MAIL_ENTRY_UNAVAILABLE")
        mail.tap()
        func tab(_ name: String) -> XCUIElement {
            web.buttons.matching(NSPredicate(format: "label == %@", name)).firstMatch
        }
        func settled(_ name: String) {
            let selected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "selected == true"), object: tab(name))
            XCTAssertEqual(XCTWaiter.wait(for: [selected], timeout: 10), .completed, "MAIL_TAB_NOT_SETTLED")
        }
        XCTAssertTrue(tab("Overview").waitForExistence(timeout: 15), "MAIL_WORKSPACE_NOT_PRESENT")
        tab("Overview").tap()
        settled("Overview")
        func drag(_ left: Bool) {
            let start = web.coordinate(withNormalizedOffset: CGVector(dx: left ? 0.82 : 0.18, dy: 0.60))
            let end = web.coordinate(withNormalizedOffset: CGVector(dx: left ? 0.18 : 0.82, dy: 0.60))
            start.press(forDuration: 0.06, thenDragTo: end, withVelocity: XCUIGestureVelocity(rawValue: 400), thenHoldForDuration: 0)
        }
        drag(true); settled("KYC")
        drag(true); settled("Receipts")
        drag(false); settled("KYC")
        tab("Overview").tap(); settled("Overview")
        XCTAssertFalse(web.staticTexts["Connect Mail to set up receipts and KYC requests."].exists)
        perfTapNav(app, label: "Chat")
        XCTAssertTrue(composer.waitForExistence(timeout: 15) && composer.isHittable)
        XCTAssertTrue((composer.value as? String) == draft, "MAIL_RETURN_CHANGED_UNSENT_DRAFT")
        XCTAssertFalse(web.buttons["Unlock"].exists, "MAIL_RETURN_LOST_VAULT")
        XCTAssertEqual(hosts.count, 1)
        XCTAssertEqual(app.webViews.count, 1 + web.webViews.count)
        print("MAIL_KEYBOARD_CONTINUITY real_keyboard_bidirectional_pager_warm_chat")
    }

    func testLocalSessionStatusBarCanvasMatchesHeader() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_LOCAL_SESSION_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in status canvas proof; requires the running Chat session")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            throw XCTSkip("Status canvas proof must not cold-launch or change the session")
        }
        app.activate()
        XCTAssertFalse(app.webViews.buttons["Unlock"].exists)
        XCTAssertTrue(app.webViews.buttons.matching(NSPredicate(
            format: "label BEGINSWITH %@", "Open chat history"
        )).firstMatch.exists, "Status canvas proof requires the existing Chat page")
        assertStatusCanvasMatchesHeader()
    }

    func testLocalSessionNativePublicPreferencesRetireAndRestore() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_NATIVE_CHROME_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in native public preferences proof")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            throw XCTSkip("Preferences proof must attach to the existing session")
        }
        app.activate()
        let hosts = app.webViews.matching(identifier: "native-webview"), web = hosts.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 15))
        XCTAssertFalse(web.buttons["Unlock"].exists, "Normal vault unlock is required")
        let picker = app.segmentedControls["profile-appearance"].firstMatch
        let accent = app.buttons["profile-accent"].firstMatch
        let accentSheet = app.sheets.containing(.button, identifier: "iOS Blue")
            .containing(.button, identifier: "Molten Gold").firstMatch
        func controlsReady() -> Bool {
            picker.exists && accent.exists && accent.isHittable &&
                ["Light", "Dark", "System"].allSatisfy { picker.buttons[$0].exists && picker.buttons[$0].isHittable }
        }
        func openPreferences() {
            if !picker.exists || !accent.exists {
                let close = app.buttons["Close Profile"].firstMatch
                if !close.exists { app.buttons["Open Profile"].firstMatch.tap() }
                XCTAssertTrue(close.waitForExistence(timeout: 10))
                let row = web.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Appearance & preferences")).firstMatch
                // Profile preserves its internal route while closed. Return
                // through authored Back controls, never a cold route/reset.
                for _ in 0..<4 {
                    if row.exists { break }
                    let back = app.buttons["Back in Profile"].firstMatch
                    if !back.waitForExistence(timeout: 1) || !back.isHittable { break }
                    back.tap()
                }
                XCTAssertTrue(row.waitForExistence(timeout: 10))
                if !row.isHittable { web.swipeUp() }
                XCTAssertTrue(row.isHittable)
                row.tap()
            }
            // XCTest need not make the segmented container itself hittable;
            // every actual segment and the Accent trigger must be interactive.
            let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in controlsReady() }, object: app)
            XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 10), .completed, "NATIVE_PREFERENCES_UNAVAILABLE")
        }
        func selectedTheme(_ name: String) -> Bool { picker.buttons[name].exists && picker.buttons[name].isSelected }
        func selectTheme(_ name: String) {
            let segment = picker.buttons[name]
            XCTAssertTrue(segment.exists && segment.isHittable)
            if !selectedTheme(name) { segment.tap() }
            let changed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in selectedTheme(name) }, object: picker)
            XCTAssertEqual(XCTWaiter.wait(for: [changed], timeout: 5), .completed, "NATIVE_APPEARANCE_NOT_ACKNOWLEDGED")
        }
        func selectAccent(_ name: String) {
            if (accent.value as? String) == name { return }
            accent.tap()
            let option = app.buttons[name].firstMatch
            XCTAssertTrue(option.waitForExistence(timeout: 10) && option.isHittable, "NATIVE_ACCENT_MENU_UNAVAILABLE")
            option.tap()
            let changed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", name), object: accent)
            XCTAssertEqual(XCTWaiter.wait(for: [changed], timeout: 5), .completed, "NATIVE_ACCENT_NOT_ACKNOWLEDGED")
        }
        func cancelAccentMenu() -> Bool {
            let sheet = accentSheet
            guard sheet.waitForExistence(timeout: 5),
                  sheet.buttons["iOS Blue"].firstMatch.isHittable,
                  sheet.buttons["Molten Gold"].firstMatch.isHittable else {
                XCTFail("NATIVE_ACCENT_MENU_UNAVAILABLE"); return false
            }
            // iOS 26 anchors action sheets at their source and removes the
            // Cancel button. An outside tap invokes the same cancel handler.
            // Prove dismissal, not a legacy button or an arbitrary delay.
            let bounds = app.frame, menu = sheet.frame.insetBy(dx: -8, dy: -8)
            let points = [CGPoint(x: bounds.midX, y: bounds.maxY - 90),
                          CGPoint(x: bounds.minX + 24, y: bounds.midY),
                          CGPoint(x: bounds.maxX - 24, y: bounds.midY)]
            guard let point = points.first(where: { bounds.contains($0) && !menu.contains($0) }) else {
                XCTFail("NATIVE_ACCENT_OUTSIDE_TARGET_UNAVAILABLE"); return false
            }
            app.coordinate(withNormalizedOffset: .zero).withOffset(
                CGVector(dx: point.x - bounds.minX, dy: point.y - bounds.minY)).tap()
            let retired = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                !sheet.exists && controlsReady()
            }, object: app)
            let completed = XCTWaiter.wait(for: [retired], timeout: 5) == .completed
            XCTAssertTrue(completed, "NATIVE_ACCENT_CANCEL_NOT_RETIRED")
            return completed
        }
        if accentSheet.exists {
            guard cancelAccentMenu() else { return }
        }
        openPreferences()
        guard let originalTheme = ["Light", "Dark", "System"].first(where: selectedTheme),
              let originalAccent = accent.value as? String, ["iOS Blue", "Molten Gold"].contains(originalAccent) else {
            XCTFail("NATIVE_PREFERENCE_ORIGINAL_UNKNOWN"); return
        }
        addTeardownBlock {
            if accentSheet.exists { _ = cancelAccentMenu() }
            if !picker.exists { openPreferences() }
            selectTheme(originalTheme); selectAccent(originalAccent)
            app.buttons["Close Profile"].firstMatch.tap()
            self.perfTapNav(app, label: "Chat")
            XCTAssertFalse(web.buttons["Unlock"].exists)
        }
        for name in ["Light", "Dark", "System"] {
            let segment = picker.buttons[name]
            XCTAssertGreaterThanOrEqual(segment.frame.width, 44, "NATIVE_APPEARANCE_SEGMENT_WIDTH_UNADMITTED")
            XCTAssertGreaterThanOrEqual(segment.frame.height, 44, "NATIVE_APPEARANCE_SEGMENT_HEIGHT_UNADMITTED")
            selectTheme(name)
            XCTAssertTrue(accent.isHittable)
        }
        for name in ["iOS Blue", "Molten Gold"] { selectAccent(name) }
        let value = accent.value as? String
        for _ in 0..<2 {
            accent.tap()
            guard cancelAccentMenu() else { return }
            XCTAssertEqual(accent.value as? String, value, "Native cancellation changed the preference")
        }
        app.buttons["Close Profile"].firstMatch.tap()
        let retired = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: picker)
        XCTAssertEqual(XCTWaiter.wait(for: [retired], timeout: 5), .completed, "NATIVE_PREFERENCES_NOT_RETIRED")
        openPreferences()
        XCTAssertEqual(hosts.count, 1)
        XCTAssertEqual(app.webViews.count, 1 + web.webViews.count)
        XCTAssertFalse(web.buttons["Unlock"].exists)
        print("NATIVE_PUBLIC_PREFERENCES_CONTINUITY icons_theme_accent_cancel_reopen_single_host")
    }

    func testLocalSessionNativeChromeFollowsAppTheme() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_NATIVE_CHROME_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in appearance proof; temporarily changes and restores the existing app preference")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            throw XCTSkip("Appearance proof must not cold-launch or reset the session")
        }
        app.activate()
        let hosts = app.webViews.matching(identifier: "native-webview")
        let web = hosts.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 15))
        XCTAssertFalse(web.buttons["Unlock"].exists, "Normal vault unlock is required")

        func openPreferences() {
            let close = app.buttons["Close Profile"].firstMatch
            if close.exists && themeOption("System").exists && themeOption("System").isHittable { return }
            if !close.exists {
                let profile = app.buttons["Open Profile"].firstMatch
                XCTAssertTrue(profile.waitForExistence(timeout: 10) && profile.isHittable, "THEME_PROFILE_UNAVAILABLE")
                profile.tap()
            }
            XCTAssertTrue(close.waitForExistence(timeout: 10) && close.isHittable, "THEME_PROFILE_NOT_SETTLED")
            for _ in 0..<4 {
                let back = app.buttons["Back in Profile"].firstMatch
                if !back.waitForExistence(timeout: 1) || !back.isHittable { break }
                back.tap()
            }
            let preferences = web.buttons.matching(NSPredicate(
                format: "label BEGINSWITH %@", "Appearance & preferences"
            )).firstMatch
            XCTAssertTrue(preferences.waitForExistence(timeout: 10), "THEME_PREFERENCES_UNAVAILABLE")
            for _ in 0..<3 {
                if preferences.isHittable { break }
                web.swipeUp()
            }
            XCTAssertTrue(preferences.isHittable, "THEME_PREFERENCES_NOT_HITTABLE")
            preferences.tap()
            XCTAssertTrue(themeOption("System").waitForExistence(timeout: 10), "THEME_OPTIONS_UNAVAILABLE")
        }
        func themeOption(_ label: String) -> XCUIElement {
            let native = app.segmentedControls["profile-appearance"].firstMatch
            if native.exists { return native.buttons[label].firstMatch }
            // WebKit maps authored role=radio differently across OS releases.
            // Match the explicit accessible name, not an assumed XCUI type.
            return web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
        }
        func selected(_ label: String) -> Bool {
            let radio = themeOption(label)
            return radio.exists && (radio.isSelected || (radio.value as? String) == "1")
        }
        func selectTheme(_ label: String) {
            let radio = themeOption(label)
            XCTAssertTrue(radio.exists && radio.isHittable, "THEME_OPTION_NOT_HITTABLE")
            if !selected(label) { radio.tap() }
            let acknowledged = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in selected(label) }, object: web)
            XCTAssertEqual(XCTWaiter.wait(for: [acknowledged], timeout: 5), .completed, "THEME_SELECTION_NOT_ACKNOWLEDGED")
            app.buttons["Close Profile"].firstMatch.tap()
        }

        openPreferences()
        guard let original = ["Light", "Dark", "System"].first(where: selected) else {
            XCTFail("THEME_ORIGINAL_SELECTION_UNKNOWN")
            return // Never change a preference whose restoration value is unknown.
        }
        addTeardownBlock {
            // XCTest teardown also runs after fail-fast assertions. No sign-out,
            // new app process, storage injection or OS appearance changes.
            openPreferences()
            selectTheme(original)
            self.perfTapNav(app, label: "Chat")
            let chat = app.descendants(matching: .any).matching(identifier: "one-native-navigation").firstMatch.buttons["Chat"]
            let selectedChat = XCTNSPredicateExpectation(predicate: NSPredicate(format: "selected == true"), object: chat)
            XCTAssertEqual(XCTWaiter.wait(for: [selectedChat], timeout: 10), .completed, "THEME_RESTORE_CHAT_NOT_SELECTED")
            let composer = web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Message One")).firstMatch
            XCTAssertTrue(composer.waitForExistence(timeout: 10) && composer.isHittable, "THEME_RESTORE_CHAT_NOT_READY")
            XCTAssertFalse(web.buttons["Unlock"].exists, "Theme restoration lost the session")
            print("NATIVE_THEME_RESTORED original_preference_unlocked_chat=true")
        }
        app.buttons["Close Profile"].firstMatch.tap()
        for theme in ["Light", "Dark"] {
            openPreferences()
            selectTheme(theme)
            for destination in ["Chat", "One", "Connect", "Feed"] {
                perfTapNav(app, label: destination)
                let bar = app.descendants(matching: .any).matching(identifier: "one-native-navigation").firstMatch
                let selectedTab = bar.buttons[destination]
                let settled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "selected == true"), object: selectedTab)
                XCTAssertEqual(XCTWaiter.wait(for: [settled], timeout: 10), .completed, "THEME_ROUTE_NOT_SETTLED")
                XCTAssertFalse(web.buttons["Unlock"].exists, "Theme route lost the unlocked session")
                XCTAssertEqual(hosts.count, 1)
                assertStatusCanvasMatchesHeader(expectedDark: theme == "Dark")
                print("NATIVE_THEME_ROUTE theme=\(theme) tab=\(destination) matching=true")
            }
            perfTapNav(app, label: "One")
            let wallet = web.links["Open Wallet"].firstMatch
            XCTAssertTrue(wallet.waitForExistence(timeout: 10))
            for _ in 0..<3 {
                if wallet.isHittable { break }
                web.swipeUp()
            }
            XCTAssertTrue(wallet.isHittable)
            wallet.tap()
            let back = app.buttons["top-shell-back"].firstMatch
            XCTAssertTrue(back.waitForExistence(timeout: 10) && back.isHittable, "THEME_NATIVE_BACK_UNAVAILABLE")
            XCTAssertEqual(back.frame.width, 44, accuracy: 1)
            XCTAssertEqual(back.frame.height, 44, accuracy: 1)
            assertStatusCanvasMatchesHeader(expectedDark: theme == "Dark")
            // Bounded native-control audit, not an app-wide accessibility pass.
            // Ignore only issues explicitly attributed to other controls;
            // unattributed issues remain failures rather than disappearing.
            try app.performAccessibilityAudit(for: [.contrast, .hitRegion, .sufficientElementDescription, .trait]) { issue in
                guard let element = issue.element else { return false }
                print("NATIVE_BACK_AUDIT_ISSUE identified=\(!element.identifier.isEmpty) overlaps_back=\(element.frame.intersects(back.frame)) type=\(issue.auditType.rawValue)")
                let publicControls = ["Open Profile", "Add card", "Done", "Search cards", "Go back", "One.", "Chat", "One", "Connect", "Feed", "Search", "Top of screen", "Scroll to top", "Status bar", "Back", "Skip to main content", "Notifications alt+T", "Notifications", "Wallet", "Hussh One", "Breadcrumb", "Main"]
                let publicIndex = publicControls.firstIndex(of: element.label) ?? -1
                print("NATIVE_AUDIT_GEOMETRY public_control=\(publicIndex) x=\(Int(element.frame.minX)) y=\(Int(element.frame.minY)) width=\(Int(element.frame.width)) height=\(Int(element.frame.height))")
                print("NATIVE_AUDIT_ELEMENT type=\(element.elementType.rawValue) label_empty=\(element.label.isEmpty)")
                // Classify only public accessibility vocabulary; never emit
                // the label itself or the protected page's hierarchy.
                let vocabulary = element.label.lowercased()
                print("NATIVE_AUDIT_ROLE scroll=\(vocabulary.contains("scroll")) top=\(vocabulary.contains("top")) status=\(vocabulary.contains("status")) web=\(vocabulary.contains("web"))")
                return !element.identifier.isEmpty && element.identifier != "top-shell-back" &&
                    !element.frame.intersects(back.frame)
            }
            print("NATIVE_BACK_ACCESSIBILITY theme=\(theme) contrast_hit_description_traits=true")
            back.tap()
            XCTAssertTrue(wallet.waitForExistence(timeout: 10), "THEME_BACK_RETURN_FAILED")
            print("NATIVE_THEME_BACK theme=\(theme) warm_return=true")
        }
    }

    private func assertStatusCanvasMatchesHeader(expectedDark: Bool? = nil) {
        let status = XCUIApplication(bundleIdentifier: "com.apple.springboard").statusBars.firstMatch
        XCTAssertTrue(status.waitForExistence(timeout: 5), "System status region unavailable")
        // Keep pixels in memory only: no attachment, snapshot or protected
        // hierarchy. Sample quiet left-edge bands below the clock/notch, then
        // discard the full image. A dark host strip above a light header fails.
        let image = XCUIScreen.main.screenshot().image
        guard let pixels = image.cgImage else { XCTFail("Status canvas image unavailable"); return }
        let scale = image.scale
        let frame = status.frame
        guard frame.width > 0, frame.height > 12 else {
            XCTFail("Status canvas geometry unavailable"); return
        }
        func average(_ y: CGFloat) -> [Double]? {
            let rect = CGRect(x: (frame.minX + frame.width * 0.08) * scale,
                              y: y * scale, width: 12 * scale, height: 4 * scale)
            guard let crop = pixels.cropping(to: rect),
                  let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
            var rgba = [UInt8](repeating: 0, count: 4)
            let drawn = rgba.withUnsafeMutableBytes { bytes -> Bool in
                guard let context = CGContext(data: bytes.baseAddress, width: 1, height: 1,
                    bitsPerComponent: 8, bytesPerRow: 4, space: space,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
                context.draw(crop, in: CGRect(x: 0, y: 0, width: 1, height: 1))
                return true
            }
            return drawn ? rgba.prefix(3).map { Double($0) / 255 } : nil
        }
        guard let top = average(frame.maxY - 6), let header = average(frame.maxY + 6) else {
            XCTFail("Status canvas samples unavailable"); return
        }
        let matching = zip(top, header).allSatisfy { abs($0 - $1) < 0.18 }
        print("STATUS_CANVAS matching=\(matching)")
        XCTAssertTrue(matching, "System status canvas must blend with the adjacent app header")
        if let expectedDark {
            let brightness = header.reduce(0, +) / 3
            XCTAssertTrue(expectedDark ? brightness < 0.35 : brightness > 0.7, "STATUS_THEME_NOT_APPLIED")
        }
    }

    func testLocalSessionProfileBackAcrossTheSettingsStack() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_LOCAL_SESSION_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in shared Profile Back and fallback regression")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            XCTFail("PROFILE_STACK_REQUIRES_RUNNING_SESSION"); return
        }
        app.activate()
        dismissRehearsalChatKeyboard(app)
        let hosts = app.webViews.matching(identifier: "native-webview"), web = hosts.firstMatch
        XCTAssertFalse(web.buttons["Unlock"].exists, "Normal vault unlock is required")
        let close = app.buttons["Close Profile"].firstMatch
        defer {
            if close.exists && close.isHittable { close.tap() }
            self.perfTapNav(app, label: "Chat")
        }
        if !close.exists { app.buttons["Open Profile"].firstMatch.tap() }
        XCTAssertTrue(close.waitForExistence(timeout: 10))
        func row(_ label: String) -> XCUIElement {
            web.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", label)).firstMatch
        }
        func returnToRoot() {
            for _ in 0..<4 {
                if row("Your account").exists { break }
                let back = app.buttons["Back in Profile"].firstMatch
                XCTAssertTrue(back.waitForExistence(timeout: 10) && back.isHittable)
                back.tap()
            }
            XCTAssertTrue(row("Your account").waitForExistence(timeout: 10), "PROFILE_STACK_ROOT_NOT_RESTORED")
        }
        func assertBack() {
            let back = app.buttons["Back in Profile"].firstMatch
            XCTAssertTrue(back.waitForExistence(timeout: 10) && back.isHittable, "PROFILE_BACK_UNAVAILABLE")
            XCTAssertEqual(back.frame.width, 44, accuracy: 1)
            XCTAssertEqual(back.frame.height, 44, accuracy: 1)
            let nativeExpected = ProcessInfo.processInfo.environment["HUSHH_EXPECT_PROFILE_BACK_NATIVE"] == "true"
            let native = app.buttons["profile-back"].firstMatch
            if nativeExpected {
                XCTAssertTrue(native.waitForExistence(timeout: 10) && native.isHittable, "PROFILE_BACK_NATIVE_NOT_ADMITTED")
                XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label == %@", "Back in Profile")).count, 1,
                               "Profile Back exposed duplicate native and web controls")
            } else {
                XCTAssertFalse(native.exists, "Unqualified wrappers must retain the authored Profile Back")
            }
        }
        returnToRoot()
        for label in ["Your account", "Appearance & preferences", "Security & privacy", "Help & feedback"] {
            let entry = row(label)
            for _ in 0..<3 { if entry.isHittable { break }; web.swipeUp() }
            XCTAssertTrue(entry.isHittable, "PROFILE_STACK_ENTRY_UNAVAILABLE")
            entry.tap()
            assertBack()
            if label == "Security & privacy" {
                let vault = row("Vault methods")
                XCTAssertTrue(vault.waitForExistence(timeout: 10) && vault.isHittable)
                vault.tap() // View only: no enrollment or authentication change.
                assertBack()
                app.buttons["Back in Profile"].firstMatch.tap()
                XCTAssertTrue(vault.waitForExistence(timeout: 10))
                assertBack()
            }
            app.buttons["Back in Profile"].firstMatch.tap()
            returnToRoot()
            XCTAssertFalse(web.buttons["Unlock"].exists, "Profile stack navigation lost vault admission")
            XCTAssertEqual(hosts.count, 1)
        }
        print("PROFILE_STACK_CONTINUITY account_preferences_security_vault_support_warm_single_host")
    }

    func testLocalSessionWorkspaceFamiliesKeepDraftAndAuthoritativeSelection() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_LOCAL_SESSION_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in multi-workspace warm navigation regression")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            XCTFail("WORKSPACE_REQUIRES_RUNNING_SESSION"); return
        }
        app.activate()
        dismissRehearsalChatKeyboard(app)
        let hosts = app.webViews.matching(identifier: "native-webview"), web = hosts.firstMatch
        XCTAssertFalse(web.buttons["Unlock"].exists, "Normal vault unlock is required")
        defer { self.returnToRehearsalChat(app) }
        for label in ["Close Profile", "Close chat history", "Close search"] {
            let close = app.buttons[label].firstMatch
            if close.exists && close.isHittable { close.tap() }
        }
        perfTapNav(app, label: "Chat")
        let composer = web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Message One")).firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 15) && composer.isHittable)
        let draft = composer.value as? String
        let hostFrame = web.frame
        func tab(_ name: String) -> XCUIElement { web.buttons.matching(NSPredicate(format: "label == %@", name)).firstMatch }
        func select(_ name: String) {
            let target = tab(name)
            print("WORKSPACE_TAB_ADMISSION target=\(name) exists=\(target.exists) hittable=\(target.exists && target.isHittable)")
            XCTAssertTrue(target.waitForExistence(timeout: 15) && target.isHittable, "WORKSPACE_TAB_UNAVAILABLE")
            target.tap()
            let settled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "selected == true"), object: target)
            XCTAssertEqual(XCTWaiter.wait(for: [settled], timeout: 10), .completed, "WORKSPACE_SELECTION_NOT_SETTLED")
        }
        func openAgent(_ name: String) {
            self.perfTapNav(app, label: "One")
            let entry = web.links["Open \(name)"].firstMatch
            XCTAssertTrue(entry.waitForExistence(timeout: 15), "WORKSPACE_ENTRY_UNAVAILABLE")
            for _ in 0..<4 { if entry.isHittable { break }; web.swipeDown() }
            for _ in 0..<6 { if entry.isHittable { break }; web.swipeUp() }
            XCTAssertTrue(entry.isHittable, "WORKSPACE_ENTRY_NOT_HITTABLE")
            entry.tap()
        }
        func continuity(_ family: String) {
            XCTAssertFalse(web.buttons["Unlock"].exists, "Workspace navigation lost vault admission")
            XCTAssertEqual(hosts.count, 1)
            XCTAssertEqual(web.frame, hostFrame, "Workspace selection moved the Capacitor host")
            self.perfTapNav(app, label: "Chat")
            XCTAssertTrue(composer.waitForExistence(timeout: 15) && composer.isHittable)
            XCTAssertTrue((composer.value as? String) == draft, "Workspace navigation changed the unsent draft")
            print("WORKSPACE_CONTINUITY family=\(family) warm_draft_single_host=true")
        }
        let requestedFamily = ProcessInfo.processInfo.environment["HUSHH_WORKSPACE_FAMILY"]
        let families = ["connect", "finance", "consent", "wallet"]
        if let requestedFamily, !families.contains(requestedFamily) {
            XCTFail("WORKSPACE_FAMILY_UNADMITTED"); return
        }
        for family in families where requestedFamily == nil || requestedFamily == family {
            switch family {
            case "connect":
                perfTapNav(app, label: "Connect")
                select("Circles"); select("Connections")
            case "finance":
                openAgent("Finance")
                let setupQuestion = web.staticTexts["How long will this stay invested?"].firstMatch
                let setupContinue = web.buttons["Continue finance setup"].firstMatch
                let setupIntro = web.staticTexts["Access your finances in one place."].firstMatch
                let destination = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                    tab("Portfolio").exists || setupQuestion.exists || setupContinue.exists || setupIntro.exists
                }, object: web)
                XCTAssertEqual(XCTWaiter.wait(for: [destination], timeout: 15), .completed, "WORKSPACE_FINANCE_DESTINATION_UNOBSERVED")
                let setup = setupQuestion.exists || setupContinue.exists || setupIntro.exists
                print("WORKSPACE_FINANCE_INTRO visible=\(setupIntro.exists)")
                print("WORKSPACE_FINANCE_ADMISSION setup=\(setup) workspace=\(tab("Portfolio").exists)")
                XCTAssertFalse(setup, "WORKSPACE_FINANCE_SETUP_REQUIRED")
                select("Portfolio"); select("Analysis"); select("Market")
            case "consent":
                openAgent("Consent")
                select("Active"); select("History"); select("Connections"); select("Requests")
            default:
                openAgent("Wallet")
                let back = app.buttons.matching(NSPredicate(format: "label == %@", "Go back")).firstMatch
                XCTAssertTrue(back.waitForExistence(timeout: 10) && back.isHittable, "WORKSPACE_BACK_UNAVAILABLE")
                back.tap()
                XCTAssertTrue(web.links["Open Wallet"].waitForExistence(timeout: 15), "WORKSPACE_BACK_DID_NOT_RETURN_TO_ONE")
            }
            continuity(family)
        }
    }

    func testLocalSessionMemorySwipeStopsOnAdd() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_LOCAL_SESSION_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in live-session check; requires an existing signed-in account")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            XCTFail("MEMORY_REQUIRES_RUNNING_SESSION"); return
        }
        app.activate()
        dismissRehearsalChatKeyboard(app)
        let hosts = app.webViews.matching(identifier: "native-webview"), webView = hosts.firstMatch
        XCTAssertTrue(webView.waitForExistence(timeout: 15), "Local app WebView did not load")
        XCTAssertFalse(webView.buttons["Unlock"].exists, "Normal vault unlock is required")
        defer { self.returnToRehearsalChat(app) }
        for label in ["Close Profile", "Close chat history", "Close search"] {
            let close = app.buttons[label].firstMatch
            if close.exists && close.isHittable { close.tap() }
        }
        perfTapNav(app, label: "One")
        let memory = webView.links["Open Memory"].firstMatch
        XCTAssertTrue(memory.waitForExistence(timeout: 15), "MEMORY_ENTRY_UNAVAILABLE")
        for _ in 0..<5 {
            if memory.isHittable { break }
            webView.swipeUp()
        }
        XCTAssertTrue(memory.isHittable, "MEMORY_ENTRY_NOT_HITTABLE")
        memory.tap()
        let saved = webView.buttons["Saved"]
        let add = webView.buttons["Add"]
        let sharing = webView.buttons["Sharing"]
        XCTAssertTrue(saved.waitForExistence(timeout: 15), "MEMORY_WORKSPACE_UNAVAILABLE")
        saved.tap()
        XCTAssertTrue(add.exists && sharing.exists, "Memory tabs are incomplete")

        func swipeLeft() {
            let start = webView.coordinate(withNormalizedOffset: CGVector(dx: 0.82, dy: 0.56))
            let end = webView.coordinate(withNormalizedOffset: CGVector(dx: 0.18, dy: 0.56))
            start.press(forDuration: 0.06, thenDragTo: end, withVelocity: XCUIGestureVelocity(rawValue: 400), thenHoldForDuration: 0)
        }
        func waitForSelected(_ tab: XCUIElement) -> Bool {
            let deadline = Date().addingTimeInterval(12)
            while Date() < deadline {
                if tab.isSelected { return true }
                RunLoop.current.run(until: Date().addingTimeInterval(0.25))
            }
            return tab.isSelected
        }

        swipeLeft()
        XCTAssertTrue(waitForSelected(add), "One Memory swipe must land on Add")
        XCTAssertFalse(sharing.isSelected, "The first swipe must not skip Add")
        swipeLeft()
        XCTAssertTrue(waitForSelected(sharing), "The next Memory swipe must land on Sharing")
        // Keep the interruption test immediate. Selected state is not proof
        // that the compositor has settled or the original tab is reachable.
        print("MEMORY_RETURN_ADMISSION hittable=\(saved.exists && saved.isHittable)")
        XCTAssertTrue(saved.exists && saved.isHittable, "MEMORY_RETURN_TAB_NOT_HITTABLE")
        saved.tap()
        let returned = waitForSelected(saved)
        print("MEMORY_RETURN_SELECTION saved=\(saved.isSelected) add=\(add.isSelected) sharing=\(sharing.isSelected)")
        XCTAssertTrue(returned, "Memory tap must settle on the same pane as its swipe")
        XCTAssertFalse(webView.buttons["Unlock"].exists, "Memory paging lost the unlocked session")
        XCTAssertEqual(hosts.count, 1)
        print("MEMORY_PAGER_CONTINUITY saved_add_sharing_warm_single_host")
    }

    func testAccountNotFoundRecoveryReturnsToLogin() throws {
        // Public recovery smoke: no reviewer fixture, credentials, or account
        // mutation. Unit/integration tests own the trusted deletion signal.
        let route = RouteCase(
            name: "account-not-found-recovery",
            initialRoute: "/login?auth_notice=account_not_found",
            expectedMarker: "native-route-login",
            expectedRoute: "/login",
            expectedRoutePrefix: nil,
            autoReviewerLogin: false,
            expectedAuth: "anonymous",
            allowedDataStates: ["loaded"]
        )
        let app = launchApp(route)
        defer { app.terminate() }
        // Login's component contract verifies notice emission and query cleanup.
        // Its 3.6-second toast can expire while XCTest waits for launch idleness;
        // this rehearsal proves the persistent recovery state and usable controls.
        // Fresh CI simulators can spend over 50 seconds launching WebKit.
        // Bound cold startup separately; warm recovery below keeps its 30s limit.
        _ = try waitForSatisfiedStatus(app, route: route, timeout: 90)
        XCTAssertTrue(app.buttons["Continue with Apple"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.staticTexts["Unable to verify setup progress. Please retry."].exists)
        XCTAssertFalse(app.secureTextFields["Enter vault key"].exists)
        XCTAssertFalse(app.secureTextFields["Enter your passphrase"].exists)
        XCUIDevice.shared.press(.home)
        let resumeDeadline = Date().addingTimeInterval(30)
        app.activate()
        _ = try waitForSatisfiedStatus(
            app, route: route, timeout: max(0, resumeDeadline.timeIntervalSinceNow)
        )
        // The route marker can survive while the native privacy cover and
        // asynchronous auth restoration are still settling after activation.
        // Require the actual login control to become usable within a bound.
        let loginButton = app.buttons["Continue with Apple"]
        // The title changes on recovery failure; require the actual shield to
        // disappear and login to be usable together within the same warm budget.
        let privacyCover = app.descendants(matching: .any)
            .matching(identifier: "session-privacy-shield").firstMatch
        while Date() < resumeDeadline,
              privacyCover.exists || !(loginButton.exists && loginButton.isHittable) {
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        XCTAssertTrue(
            !privacyCover.exists && loginButton.exists && loginButton.isHittable
                && Date() <= resumeDeadline,
            "Login must become usable after the native privacy cover releases"
        )
    }

    func testPublicAndAuthRoutes() throws {
        try assertRoutes([
            RouteCase(
                name: "home",
                initialRoute: "/",
                expectedMarker: "native-route-home",
                expectedRoute: "/",
                expectedRoutePrefix: nil,
                autoReviewerLogin: false,
                expectedAuth: "anonymous",
                allowedDataStates: ["loaded"]
            ),
            RouteCase(
                name: "login",
                initialRoute: "/login",
                expectedMarker: "native-route-login",
                expectedRoute: "/login",
                expectedRoutePrefix: nil,
                autoReviewerLogin: false,
                expectedAuth: "anonymous",
                allowedDataStates: ["loaded"]
            ),
            RouteCase(
                name: "logout",
                initialRoute: "/login?redirect=%2Flogout",
                expectedMarker: "native-route-home",
                expectedRoute: "/",
                expectedRoutePrefix: nil,
                autoReviewerLogin: true,
                expectedAuth: "anonymous",
                allowedDataStates: ["loaded"]
            ),
        ])
    }

    func testAuthenticatedSetupBootstrapRoute() throws {
        try assertRoutes([
            RouteCase(
                name: "one-setup",
                initialRoute: "/login?redirect=%2Fone%2Fsetup",
                expectedMarker: "native-route-one-setup",
                expectedRoute: "/one/setup",
                expectedRoutePrefix: nil,
                autoReviewerLogin: true,
                expectedAuth: "authenticated",
                allowedDataStates: ["loaded"]
            ),
        ])
    }

    func testReviewerFinanceSwipe() throws {
        let rootRoute = RouteCase(
            name: "portfolio-workspace",
            initialRoute: "/login?redirect=%2Fone%2Fkai%3Ftab%3Dportfolio",
            expectedMarker: "native-route-kai-home",
            expectedRoute: "/one/kai?tab=portfolio",
            expectedRoutePrefix: nil,
            autoReviewerLogin: true,
            expectedAuth: "authenticated",
            allowedDataStates: ["loaded"]
        )
        let app = launchApp(rootRoute)
        defer { app.terminate() }
        _ = try waitForSatisfiedStatus(app, route: rootRoute, timeout: 90)

        let webView = app.webViews.firstMatch
        XCTAssertTrue(webView.waitForExistence(timeout: 10), "Portfolio WebView is unavailable")

        let swipeStart = webView.coordinate(withNormalizedOffset: CGVector(dx: 0.82, dy: 0.48))
        let swipeEnd = webView.coordinate(withNormalizedOffset: CGVector(dx: 0.18, dy: 0.48))
        swipeStart.press(forDuration: 0.08, thenDragTo: swipeEnd)
        XCTAssertTrue(
            waitForNativeRoute(app, route: "/one/kai?tab=analysis", timeout: 12),
            "Finance swipe did not settle on Analysis"
        )

        swipeEnd.press(forDuration: 0.08, thenDragTo: swipeStart)
        XCTAssertTrue(
            waitForNativeRoute(app, route: "/one/kai?tab=portfolio", timeout: 12),
            "Finance reverse swipe did not settle on Portfolio"
        )
    }

    func testLocationMapCloseReleasesImmersiveRoute() throws {
        let app = XCUIApplication()
        let environment = ProcessInfo.processInfo.environment
        app.launchArguments = [
            "-UITestMode",
            "-UITestInitialRoute", "/one/location/map?demo=people",
            "-UITestExpectedRoute", "/one/location/map?demo=people",
            "-UITestAutoReviewerLogin", "true",
            "-UITestResetAppState", "false",
        ]
        if let reviewerUid = environment["HUSHH_UI_TEST_REVIEWER_UID"] ?? environment["REVIEWER_UID"],
           !reviewerUid.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            app.launchArguments += ["-UITestExpectedUserId", reviewerUid]
        }
        if let vaultPassphrase = environment["HUSHH_UI_TEST_REVIEWER_VAULT_PASSPHRASE"] ?? environment["REVIEWER_VAULT_PASSPHRASE"],
           !vaultPassphrase.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            app.launchArguments += ["-UITestVaultPassphrase", vaultPassphrase]
        }
        app.launch()
        defer { app.terminate() }

        let statusQuery = app.buttons.matching(identifier: "native-test-status")
        XCTAssertTrue(
            statusQuery.element(boundBy: 0).waitForExistence(timeout: 30),
            "native-test-status never appeared for Your Map"
        )
        let statusElement = statusQuery.element(boundBy: 0)
        let mapDeadline = Date().addingTimeInterval(45)
        var status: [String: String] = [:]
        while Date() < mapDeadline {
            status = parseStatus(
                ((statusElement.value as? String) ?? statusElement.label)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
            )
            if status["route"] == "/one/location/map?demo=people",
               status["bootstrap"] == "vault_unlocked" {
                break
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        XCTAssertEqual(
            status["route"],
            "/one/location/map?demo=people",
            "Your Map did not settle before the close interaction"
        )

        // The native Google Maps view does not expose the WebView overlay
        // controls to XCUI reliably. Tap the visible close affordance by its
        // stable safe-area position so this test exercises real hit testing.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.07)).tap()

        let closeDeadline = Date().addingTimeInterval(15)
        while Date() < closeDeadline {
            status = parseStatus(
                ((statusElement.value as? String) ?? statusElement.label)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
            )
            if status["route"] == "/one/location" {
                break
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        XCTAssertEqual(status["route"], "/one/location", "Close did not exit Your Map")

        // The previous harness defect reclaimed the expected route every 500ms.
        // Hold beyond that window and prove the route remains exited.
        RunLoop.current.run(until: Date().addingTimeInterval(2))
        status = parseStatus(
            ((statusElement.value as? String) ?? statusElement.label)
                .trimmingCharacters(in: .whitespacesAndNewlines)
        )
        XCTAssertEqual(
            status["route"],
            "/one/location",
            "The native test router reclaimed Your Map after close"
        )
    }

    func testInvestorRoutes() throws {
        try assertRoutes([
            reviewerRoute(name: "kai-home", redirect: "/kai", marker: "native-route-kai-home"),
            reviewerRoute(name: "kai-analysis", redirect: "/kai/analysis?ticker=AAPL", marker: "native-route-kai-analysis"),
            RouteCase(
                name: "kai-dashboard",
                initialRoute: "/login?redirect=%2Fkai%2Fdashboard",
                expectedMarker: "native-route-kai-portfolio",
                expectedRoute: "/kai/portfolio",
                expectedRoutePrefix: nil,
                autoReviewerLogin: true,
                expectedAuth: "authenticated",
                allowedDataStates: ["loaded"]
            ),
            RouteCase(
                name: "kai-dashboard-analysis",
                initialRoute: "/login?redirect=%2Fkai%2Fdashboard%2Fanalysis%3Fticker%3DAAPL",
                expectedMarker: "native-route-kai-analysis",
                expectedRoute: "/kai/analysis",
                expectedRoutePrefix: nil,
                autoReviewerLogin: true,
                expectedAuth: "authenticated",
                allowedDataStates: ["loaded"]
            ),
            reviewerRoute(name: "kai-import", redirect: "/kai/import", marker: "native-route-kai-import"),
            reviewerRoute(name: "kai-investments", redirect: "/kai/investments", marker: "native-route-kai-investments"),
            reviewerRoute(name: "kai-onboarding", redirect: "/kai/onboarding", marker: "native-route-kai-onboarding"),
            reviewerRoute(name: "kai-optimize", redirect: "/kai/optimize", marker: "native-route-kai-optimize", allowedDataStates: ["loaded", "empty-valid", "unavailable-valid"]),
            reviewerRoute(name: "kai-portfolio", redirect: "/kai/portfolio", marker: "native-route-kai-portfolio", allowedDataStates: ["loaded"]),
            RouteCase(
                name: "portfolio-shared",
                initialRoute: "/portfolio/shared",
                expectedMarker: "native-route-portfolio-shared",
                expectedRoute: "/portfolio/shared",
                expectedRoutePrefix: nil,
                autoReviewerLogin: false,
                expectedAuth: "public",
                allowedDataStates: ["loaded", "empty-valid"]
            ),
        ])
    }

    func testConsentAndProfileRoutes() throws {
        try assertRoutes([
            reviewerRoute(name: "consents", redirect: "/one/consent", marker: "native-route-consents"),
            reviewerRoute(
                name: "chat",
                redirect: "/",
                marker: "native-route-home",
                allowedDataStates: ["loaded", "empty-valid", "unavailable-valid"]
            ),
            reviewerRoute(name: "one-kyc", redirect: "/one/kyc", marker: "native-route-one-kyc"),
            reviewerRoute(
                name: "one-location",
                redirect: "/one/location",
                marker: "native-route-one-location",
                allowedDataStates: ["loaded", "empty-valid", "unavailable-valid"]
            ),
            reviewerRoute(name: "profile", redirect: "/one/profile", marker: "native-route-profile"),
            RouteCase(
                name: "profile-pkm",
                initialRoute: "/login?redirect=%2Fone%2Fprofile%2Fpkm",
                expectedMarker: "native-route-pkm",
                expectedRoute: "/one/pkm",
                expectedRoutePrefix: nil,
                autoReviewerLogin: true,
                expectedAuth: "authenticated",
                allowedDataStates: ["loaded", "redirect-valid"]
            ),
            reviewerRoute(
                name: "profile-receipts",
                redirect: "/one/profile/receipts",
                marker: "native-route-gmail",
                allowedDataStates: ["loaded", "empty-valid", "unavailable-valid"]
            ),
        ])
    }

    func testRiaRoutes() throws {
        try assertRoutes([
            reviewerRoute(name: "ria-home", redirect: "/ria", marker: "native-route-ria-home", allowedDataStates: ["loaded", "unavailable-valid"]),
            reviewerRoute(name: "ria-clients", redirect: "/ria/clients", marker: "native-route-ria-clients", allowedDataStates: ["loaded", "empty-valid", "unavailable-valid"]),
            reviewerRoute(name: "ria-onboarding", redirect: "/ria/onboarding", marker: "native-route-ria-onboarding", allowedDataStates: ["loaded", "unavailable-valid"]),
            reviewerRoute(name: "ria-picks", redirect: "/ria/picks", marker: "native-route-ria-picks", allowedDataStates: ["loaded", "unavailable-valid"]),
            RouteCase(
                name: "ria-requests",
                initialRoute: "/login?redirect=%2Fria%2Frequests",
                expectedMarker: "native-route-consents",
                expectedRoute: nil,
                expectedRoutePrefix: "/one/consent",
                autoReviewerLogin: true,
                expectedAuth: "authenticated",
                allowedDataStates: ["loaded"]
            ),
            RouteCase(
                name: "ria-settings",
                initialRoute: "/login?redirect=%2Fria%2Fsettings",
                expectedMarker: "native-route-profile",
                expectedRoute: "/one/profile",
                expectedRoutePrefix: nil,
                autoReviewerLogin: true,
                expectedAuth: "authenticated",
                allowedDataStates: ["loaded"]
            ),
            RouteCase(
                name: "ria-workspace",
                initialRoute: "/login?redirect=%2Fria%2Fworkspace",
                expectedMarker: "native-route-ria-clients",
                expectedRoute: "/ria/clients",
                expectedRoutePrefix: nil,
                autoReviewerLogin: true,
                expectedAuth: "authenticated",
                allowedDataStates: ["loaded", "empty-valid", "unavailable-valid"]
            ),
        ])
    }

    func testMarketplaceRoutes() throws {
        try assertRoutes([
            reviewerRoute(name: "marketplace", redirect: "/marketplace", marker: "native-route-marketplace", allowedDataStates: ["loaded", "empty-valid", "unavailable-valid"]),
            RouteCase(
                name: "marketplace-connections",
                initialRoute: "/login?redirect=%2Fmarketplace%2Fconnections",
                expectedMarker: "native-route-consents",
                expectedRoute: "/one/consent?tab=pending",
                expectedRoutePrefix: nil,
                autoReviewerLogin: true,
                expectedAuth: "authenticated",
                allowedDataStates: ["loaded", "empty-valid"]
            ),
            RouteCase(
                name: "marketplace-connections-portfolio",
                initialRoute: "/login?redirect=%2Fmarketplace%2Fconnections%2Fportfolio",
                expectedMarker: "native-route-ria-clients",
                expectedRoute: "/ria/clients",
                expectedRoutePrefix: nil,
                autoReviewerLogin: true,
                expectedAuth: "authenticated",
                allowedDataStates: ["loaded", "empty-valid", "unavailable-valid"]
            ),
            reviewerRoute(
                name: "marketplace-ria",
                redirect: "/marketplace/ria?riaId=missing-demo-ria",
                marker: "native-route-marketplace-ria",
                allowedDataStates: ["loaded", "empty-valid"]
            ),
        ])
    }

    func testCallbackRoutes() throws {
        try assertRoutes([
            reviewerRoute(
                name: "kai-plaid-return",
                redirect: "/kai/plaid/oauth/return",
                marker: "native-route-kai-plaid-return",
                allowedDataStates: ["unavailable-valid", "redirect-valid"]
            ),
            reviewerRoute(
                name: "profile-gmail-return",
                redirect: "/one/profile/gmail/oauth/return",
                marker: "native-route-profile-gmail-return",
                allowedDataStates: ["unavailable-valid", "redirect-valid"]
            ),
        ])
    }

    func testReviewerUiInteractionFlows() throws {
        assertReviewerPassphraseAliasesMatch()
        let app = launchUiInteractionAuditApp()
        defer { app.terminate() }
        let status = try waitForUiFlowsComplete(app, timeout: uiInteractionFlowTimeout())
        XCTAssertEqual(status["bootstrap"], "vault_unlocked", "Native reviewer vault bootstrap did not complete")
        XCTAssertEqual(status["ui_complete"], "1", "UI interaction flows did not complete. \(statusSummaryForLog(status))")
        XCTAssertEqual(status["ui_ok"], "1", "UI interaction flows failed. \(statusSummaryForLog(status))")
        XCTAssertEqual(status["ui_run"], activeUiFlowRunId, "UI interaction report belongs to another run")
        XCTAssertTrue(
            (status["ui_plan"] ?? "").range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
            "UI interaction report does not identify the bundled audit plan"
        )
    }

    func testPhysicalMicrophoneCaptureSmoke() throws {
        let app = XCUIApplication()
        app.terminate()
        defer { app.terminate() }
        app.launchArguments = [
            "-UITestMode",
            "-UITestInitialRoute", "/",
            "-UITestExpectedMarker", "native-route-home",
            "-UITestExpectedRoute", "/",
            "-UITestAutoReviewerLogin", "false",
            "-UITestResetAppState", "true",
        ]
        app.launch()

        let endButton = app.buttons["End conversation"]
        if endButton.waitForExistence(timeout: 8), endButton.isHittable {
            endButton.tap()
        }

        let startButtons = [
            app.buttons["Start conversation with One"],
            app.buttons["Start conversation"],
        ]
        guard let startButton = startButtons.first(where: {
            $0.waitForExistence(timeout: 10) && $0.isHittable
        }) else {
            XCTFail("One Voice start control did not appear")
            return
        }
        startButton.tap()

        let listening = app.descendants(matching: .any).matching(
            NSPredicate(
                format: "label ==[c] %@ OR value ==[c] %@ OR label BEGINSWITH[c] %@",
                "Listening",
                "Listening",
                "Audio detected"
            )
        ).firstMatch
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline, !listening.exists {
            _ = dismissKnownModals(app: app)
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }

        XCTAssertTrue(listening.exists, "Physical microphone capture never reached listening state")
        XCTAssertFalse(
            app.staticTexts.containing(
                NSPredicate(format: "label CONTAINS[c] %@", "Microphone access is blocked")
            ).firstMatch.exists,
            "WebView reported microphone access blocked"
        )
    }

    private func uiInteractionFlowTimeout() -> TimeInterval {
        let environment = ProcessInfo.processInfo.environment
        let rawValue = environment["HUSHH_UI_TEST_FLOW_TIMEOUT_SECONDS"]
            ?? environment["IOS_UI_FLOWS_TIMEOUT_SECONDS"]
        guard let rawValue,
              let timeout = TimeInterval(rawValue),
              timeout > 0
        else {
            return 900
        }
        return timeout
    }

    @discardableResult
    private func dismissKnownModals(app: XCUIApplication, scanAllButtons: Bool = false) -> Bool {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if springboard.alerts.count > 0 {
            let alert = springboard.alerts.element(boundBy: 0)
            let alertText = ([alert.label, alert.identifier]
                + alert.staticTexts.allElementsBoundByIndex.map(\.label))
                .joined(separator: " ")
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased()
            if alertText.contains("local network") ||
                alertText.contains("find and connect") ||
                alertText.contains("microphone") {
                let allowButton = springboard.buttons["Allow"]
                if allowButton.exists, allowButton.isHittable {
                    allowButton.tap()
                    return true
                }
            }
        }

        let exactLabels = [
            "Don\u{2019}t Allow",
            "Don't Allow",
            "Not now, continue with passphrase",
            "Not now",
            "Skip",
            "Skip tour",
            "Got it",
            "Maybe later",
            "Dismiss",
        ]

        for label in exactLabels {
            let button = app.buttons[label]
            if button.exists, button.isHittable {
                button.tap()
                return true
            }
        }

        if scanAllButtons {
            let exactLabelSet = Set(
                exactLabels.map {
                    $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                }
            )

            let buttonCount = app.buttons.count
            for index in 0..<min(buttonCount, 32) {
                let button = app.buttons.element(boundBy: index)
                guard button.exists else { continue }
                let lower = button.label.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                if exactLabelSet.contains(lower)
                    || lower.contains("not now")
                    || lower.contains("skip tour") {
                    guard button.isHittable else { continue }
                    button.tap()
                    return true
                }
            }
        }

        if springboard.alerts.count > 0 {
            for label in exactLabels {
                let springboardButton = springboard.buttons[label]
                if springboardButton.exists, springboardButton.isHittable {
                    springboardButton.tap()
                    return true
                }
            }
        }

        return false
    }

    private func visibleButtonLabels(app: XCUIApplication, limit: Int = 8) -> [String] {
        var labels: [String] = []
        let buttonCount = app.buttons.count
        for index in 0..<min(buttonCount, 40) {
            let button = app.buttons.element(boundBy: index)
            guard button.exists else { continue }
            let label = button.label.trimmingCharacters(in: .whitespacesAndNewlines)
            if !label.isEmpty, label != "native-test-status" {
                labels.append(label)
            }
            if labels.count >= limit {
                break
            }
        }
        return labels
    }

    private func reviewerVaultPassphrase() -> String {
        let environment = ProcessInfo.processInfo.environment
        let candidates = [
            environment["HUSHH_UI_TEST_REVIEWER_VAULT_PASSPHRASE"],
            environment["REVIEWER_VAULT_PASSPHRASE"],
        ]
        for candidate in candidates {
            let trimmed = candidate?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !trimmed.isEmpty {
                return trimmed
            }
        }
        XCTFail("Missing reviewer vault passphrase in the UI test environment")
        return ""
    }

    private func assertReviewerPassphraseAliasesMatch() {
        let environment = ProcessInfo.processInfo.environment
        let primary = environment["HUSHH_UI_TEST_REVIEWER_VAULT_PASSPHRASE"] ?? ""
        let canonical = environment["REVIEWER_VAULT_PASSPHRASE"] ?? ""
        XCTAssertFalse(primary.isEmpty, "Forwarded reviewer vault passphrase is missing")
        XCTAssertFalse(canonical.isEmpty, "Canonical reviewer vault passphrase is missing")
        XCTAssertEqual(primary, canonical, "Forwarded reviewer vault passphrase differs from canonical reviewer configuration")
        if !primary.isEmpty, primary == canonical {
            print("native-ui-reviewer-passphrase-match true")
        }
    }

    private func replaceText(in field: XCUIElement, with value: String) {
        field.tap()
        field.typeKey("a", modifierFlags: .command)
        field.typeText(value)
    }

    /// Explicit physical-run alternative to typeText, characterized with public
    /// mixed input. Stay on the named secure field and visible reviewer; never
    /// reveal entry, bootstrap authentication, or retry an unacknowledged key.
    private func enterSecureValueWithSoftwareKeyboard(_ value: String, field: XCUIElement, app: XCUIApplication) -> Bool {
        let email = ProcessInfo.processInfo.environment["HUSHH_UI_TEST_REVIEWER_EMAIL"] ?? ""
        guard !email.isEmpty else { return false }
        var expectedLength = 0
        for character in value {
            guard field.exists, field.isHittable, field.elementType == .secureTextField,
                  app.webViews.staticTexts.matching(NSPredicate(format: "label == %@", email)).firstMatch.exists else { return false }
            let literal = String(character)
            let keyNames = literal == "#" ? ["#", "number sign", "Number sign", "hash", "Hash", "pound", "Pound", "pound sign"] : [literal]
            let aliases = character.isLetter ? ["letters", "ABC", "shift", "Shift"] :
                character.isNumber ? ["numbers", "123", "more"] : ["symbols", "#+=", "numbers", "123", "more"]
            var inserted = false
            for _ in 0..<3 {
                let key = app.keyboards.keys.matching(NSPredicate(format: "label IN %@ OR identifier IN %@", keyNames, keyNames)).firstMatch
                if key.exists && key.isHittable { key.tap(); inserted = true; break }
                let choices = aliases.flatMap { [app.keyboards.keys[$0].firstMatch, app.keyboards.buttons[$0].firstMatch] }
                guard let change = choices.first(where: { $0.exists && $0.isHittable }) else { break }
                change.tap()
            }
            guard inserted else { return false }
            expectedLength += literal.utf16.count
            let count = expectedLength
            let receipt = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                (field.value as? String)?.utf16.count == count
            }, object: field)
            guard XCTWaiter.wait(for: [receipt], timeout: 3) == .completed else { return false }
        }
        return true
    }

    @discardableResult
    private func attemptVaultPassphraseUnlock(app: XCUIApplication) -> Bool {
        guard !vaultUnlockSubmitted else {
            return false
        }
        let vaultCreationControls = [
            app.buttons["Create Vault"],
            app.buttons["I've Saved My Recovery Key"],
        ]
        if vaultCreationControls.contains(where: { $0.exists }) {
            return false
        }

        // Select the authored fallback before requiring its field. A device-
        // first vault may have no text entry until this choice is made.
        for methodButton in [app.buttons["Passphrase"], app.buttons["Use passphrase instead"], app.buttons["Vault Key"]] {
            if methodButton.waitForExistence(timeout: 0.25), methodButton.isHittable {
                methodButton.tap()
                break
            }
        }

        let unlockControls = app.buttons.matching(NSPredicate(
            format: "label IN %@", ["Unlock", "Unlock with passphrase"]
        ))
        let fieldQueries: [XCUIElementQuery] = [
            app.webViews.secureTextFields,
            app.secureTextFields,
            app.webViews.textFields,
            app.textFields,
        ]
        let authoredField = NSPredicate(
            format: "label IN %@ OR placeholderValue IN %@ OR identifier IN %@",
            ["Vault passphrase", "Enter vault key", "Enter your passphrase"],
            ["Enter passphrase", "Enter vault key", "Enter your passphrase"],
            ["unlock-passphrase", "vault-key"]
        )
        // WebKit may initially project the password input as a text field on
        // iPad. Admit only its authored identity, never an unrelated lone field
        // or the mere presence of a secure field elsewhere in the app.
        let fieldReady = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            fieldQueries.contains { query in
                let field = query.matching(authoredField).firstMatch
                return field.exists && field.isHittable
            }
        }, object: app)
        guard XCTWaiter.wait(for: [fieldReady], timeout: 5) == .completed else {
            print("VAULT_ENTRY_ADMISSION stage=authored_field_unavailable")
            return false
        }
        let passphrase = reviewerVaultPassphrase()
        let softwareKeyEntry = ProcessInfo.processInfo.environment["HUSHH_UI_TEST_SOFTWARE_KEY_ENTRY"] == "true"

        for query in fieldQueries {
            // Resolve the authored field, not an index that can change as
            // WebKit exposes keyboard and text-editing descendants. A lone,
            // unrelated text field is never a credential target.
            let field = query.matching(authoredField).firstMatch
            guard field.exists, field.isHittable else { continue }
            print("VAULT_ENTRY_ADMISSION stage=authored_field_ready")
            field.tap()
            // Whole-value XCTest entry requires focus, not a visible software
            // keyboard. iPad can use a hardware keyboard; only the explicit
            // visible-key rehearsal requires its keys to be accessible.
            guard !softwareKeyEntry || app.keyboards.firstMatch.waitForExistence(timeout: 5) else {
                print("VAULT_ENTRY_ADMISSION stage=keyboard_unavailable")
                return false
            }
            let existing = field.value as? String ?? ""
            if existing != field.placeholderValue && !existing.isEmpty {
                field.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
                let keys = [app.keyboards.keys["delete"], app.keyboards.keys["Delete"], app.keyboards.buttons["delete"], app.keyboards.buttons["Delete"]]
                guard let delete = keys.first(where: { $0.exists && $0.isHittable }) else { return false }
                delete.press(forDuration: 2)
            }
            let entryLength = { () -> Int? in
                guard let value = field.value as? String else { return nil }
                return value == field.placeholderValue ? 0 : value.utf16.count
            }
            let cleared = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                entryLength() == 0 && unlockControls.count == 1 && !unlockControls.firstMatch.isEnabled
            }, object: field)
            guard XCTWaiter.wait(for: [cleared], timeout: 3) == .completed else {
                XCTFail("Vault secure entry could not be cleared; unlock was not submitted")
                return false
            }
            // Whole-value entry is the default. An explicit physical run can
            // use the publicly characterized software-key path instead; never
            // switch modes after failure or replay a partial credential.
            if softwareKeyEntry {
                guard enterSecureValueWithSoftwareKeyboard(passphrase, field: field, app: app) else {
                    XCTFail("Vault software-key entry was not acknowledged; unlock was not submitted")
                    return false
                }
            } else {
                field.typeText(passphrase)
            }
            let inserted = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                entryLength() == passphrase.utf16.count
            }, object: field)
            guard XCTWaiter.wait(for: [inserted], timeout: 3) == .completed else {
                XCTFail("Vault secure entry insertion was not acknowledged; unlock was not submitted")
                return false
            }
            // Submit once through the normal cryptographic unlock, then
            // require protected content and absence of the gate in the caller.
            // Never bootstrap or retry a rejected credential to pass a test.
            print("VAULT_ENTRY_MASK length_matched=true")
            let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                unlockControls.count == 1 && unlockControls.firstMatch.isEnabled && unlockControls.firstMatch.isHittable
            }, object: app)
            guard XCTWaiter.wait(for: [ready], timeout: 5) == .completed,
                  unlockControls.count == 1,
                  unlockControls.firstMatch.isEnabled,
                  unlockControls.firstMatch.isHittable else {
                print("VAULT_SUBMISSION_RECEIPT stage=readiness_timeout_no_tap")
                XCTFail("Vault Unlock readiness was not acknowledged; unlock was not submitted")
                return false
            }
            print("VAULT_SUBMISSION_RECEIPT stage=ready")
            vaultUnlockSubmitted = true
            unlockControls.firstMatch.tap()
            print("VAULT_SUBMISSION_RECEIPT stage=tap_dispatched")
            return true
        }

        return false
    }

    private func launchUiInteractionAuditApp() -> XCUIApplication {
        vaultUnlockSubmitted = false
        activeUiFlowRunId = UUID().uuidString
        let app = XCUIApplication()
        app.terminate()
        let environment = ProcessInfo.processInfo.environment
        let initialRoute =
            environment["HUSHH_UI_TEST_INITIAL_ROUTE"] ?? "/login?redirect=%2Fria"
        let expectedMarker =
            environment["HUSHH_UI_TEST_EXPECTED_MARKER"] ?? "native-route-ria-home"
        let expectedRoute =
            environment["HUSHH_UI_TEST_EXPECTED_ROUTE"] ?? "/ria"
        app.launchArguments = [
            "-UITestMode",
            "-UITestInitialRoute", initialRoute,
            "-UITestExpectedMarker", expectedMarker,
            "-UITestExpectedRoute", expectedRoute,
            "-UITestAutoReviewerLogin", "true",
            // This is a continuous, vault-unlocked journey. It must not clear
            // the WebView/Firebase session or manufacture a new vault between
            // actions. Cold-entry behavior has its own route tests.
            "-UITestResetAppState", "false",
            "-UITestRunUiFlows", "true",
            "-UITestUiFlowRunId", activeUiFlowRunId,
        ]
        if let reviewerUid = environment["HUSHH_UI_TEST_REVIEWER_UID"] ?? environment["REVIEWER_UID"],
           !reviewerUid.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            app.launchArguments += ["-UITestExpectedUserId", reviewerUid]
        }
        if let vaultPassphrase = environment["HUSHH_UI_TEST_REVIEWER_VAULT_PASSPHRASE"] ?? environment["REVIEWER_VAULT_PASSPHRASE"],
           !vaultPassphrase.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            app.launchArguments += ["-UITestVaultPassphrase", vaultPassphrase]
        }
        app.launch()
        return app
    }

    private func waitForUiFlowsComplete(
        _ app: XCUIApplication,
        timeout: TimeInterval
    ) throws -> [String: String] {
        let statusQuery = app.buttons.matching(identifier: "native-test-status")
        let appearDeadline = Date().addingTimeInterval(30)
        while Date() < appearDeadline {
            _ = dismissKnownModals(app: app)
            if statusQuery.count > 0 {
                break
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        XCTAssertGreaterThan(statusQuery.count, 0, "native-test-status never appeared for UI interaction audit")
        let statusElement = statusQuery.element(boundBy: 0)

        let deadline = Date().addingTimeInterval(timeout)
        var lastStatus: [String: String] = [:]
        var lastUnlockAttemptAt = Date.distantPast
        var lastModalAttemptAt = Date.distantPast
        var lastFullModalScanAt = Date.distantPast
        var lastProgressAt = Date()
        var lastFlowLabel = ""
        var lastProgressKey = ""
        var lastStatusPollAt = Date.distantPast
        var lastStatusLogAt = Date.distantPast
        var lastBootstrapState = ""
        var authenticatedBootstrapObservedAt: Date?

        while Date() < deadline {
            let inLongImportWait = isLongImportWaitStatus(lastStatus)
            if !inLongImportWait && Date().timeIntervalSince(lastModalAttemptAt) >= 2 {
                let scanAllButtons = Date().timeIntervalSince(lastFullModalScanAt) >= 10
                if dismissKnownModals(app: app, scanAllButtons: scanAllButtons) {
                    lastProgressAt = Date()
                }
                lastModalAttemptAt = Date()
                if scanAllButtons {
                    lastFullModalScanAt = Date()
                }
            }

            let statusPollInterval: TimeInterval = inLongImportWait ? 2 : 0.5
            if Date().timeIntervalSince(lastStatusPollAt) >= statusPollInterval {
                lastStatusPollAt = Date()
                let current = ((statusElement.value as? String) ?? statusElement.label)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if !current.isEmpty {
                    lastStatus = parseStatus(current)
                    let bootstrapState = lastStatus["bootstrap"] ?? ""
                    if !bootstrapState.isEmpty, bootstrapState != lastBootstrapState {
                        print("native-ui-bootstrap \(bootstrapState)")
                        lastBootstrapState = bootstrapState
                        authenticatedBootstrapObservedAt = bootstrapState == "authenticated" ? Date() : nil
                    }
                    if Date().timeIntervalSince(lastStatusLogAt) >= 15 {
                        print("native-ui-status \(statusSummaryForLog(lastStatus))")
                        lastStatusLogAt = Date()
                    }
                    if lastStatus["ui_complete"] == "1" {
                        return lastStatus
                    }
                    if lastStatus["bootstrap_uid_ok"] == "0",
                       Date().timeIntervalSince(lastProgressAt) >= 20 {
                        XCTFail("Reviewer identity mismatch. Reset the simulator session and verify reviewer configuration.")
                        return lastStatus
                    }
                    let flowLabel = lastStatus["ui_flow"] ?? ""
                    let progressKey = [
                        flowLabel,
                        lastStatus["ui_step"] ?? "",
                        lastStatus["ui_step_type"] ?? "",
                        lastStatus["route"] ?? "",
                        lastStatus["ui_error_class"] ?? "",
                    ].joined(separator: "|")
                    if !flowLabel.isEmpty, flowLabel != lastFlowLabel {
                        lastFlowLabel = flowLabel
                        lastProgressAt = Date()
                    }
                    if !progressKey.isEmpty, progressKey != lastProgressKey {
                        lastProgressKey = progressKey
                        lastProgressAt = Date()
                    }
                }
            }

            let bootstrapState = lastStatus["bootstrap"] ?? ""
            let authenticatedFallbackReady =
                bootstrapState == "authenticated" &&
                authenticatedBootstrapObservedAt.map {
                    Date().timeIntervalSince($0) >= 5
                } == true
            let shouldTryVaultUnlock =
                !isLongImportWaitStatus(lastStatus) &&
                (bootstrapState.isEmpty || bootstrapState == "vault_error" || authenticatedFallbackReady) &&
                !(lastStatus["auth"] == "authenticated" && lastStatus["data"] == "loaded")
            if shouldTryVaultUnlock && Date().timeIntervalSince(lastUnlockAttemptAt) >= 3 {
                if attemptVaultPassphraseUnlock(app: app) {
                    lastProgressAt = Date()
                }
                lastUnlockAttemptAt = Date()
            }

            let stallTimeout = uiInteractionStallTimeout(lastStatus, totalTimeout: timeout)
            if Date().timeIntervalSince(lastProgressAt) >= stallTimeout {
                XCTFail(
                    "UI interaction flows stalled for \(Int(stallTimeout))s. \(statusSummaryForLog(lastStatus))"
                )
                return lastStatus
            }

            let idleInterval: TimeInterval = isLongImportWaitStatus(lastStatus) ? 1 : 0.5
            RunLoop.current.run(until: Date().addingTimeInterval(idleInterval))
        }

        XCTFail(
            "UI interaction flows timed out after \(Int(timeout))s. \(statusSummaryForLog(lastStatus))"
        )
        return lastStatus
    }

    private func uiInteractionStallTimeout(
        _ status: [String: String],
        totalTimeout: TimeInterval
    ) -> TimeInterval {
        let flow = status["ui_flow"] ?? ""
        let route = status["route"] ?? ""
        let stepType = status["ui_step_type"] ?? ""
        if isLongImportWaitStatus(
            flow: flow,
            route: route,
            stepType: stepType,
            longWait: status["long_wait"] == "1"
        ) {
            return min(totalTimeout, 660)
        }

        return 45
    }

    private func isLongImportWaitStatus(_ status: [String: String]) -> Bool {
        isLongImportWaitStatus(
            flow: status["ui_flow"] ?? "",
            route: status["route"] ?? "",
            stepType: status["ui_step_type"] ?? "",
            longWait: status["long_wait"] == "1"
        )
    }

    private func isLongImportWaitStatus(
        flow: String,
        route: String,
        stepType: String,
        longWait: Bool
    ) -> Bool {
        let isImportFlow = flow == "native-investor-kai-import-e2e"
        let isImportRoute = normalizeRoute(route).hasPrefix("/kai/import")
        let isLongImportStep =
            stepType == "wait_button" ||
            stepType == "assert_text" ||
            longWait

        return isImportFlow && isImportRoute && isLongImportStep
    }

    private func statusSummaryForLog(_ status: [String: String]) -> String {
        let keys = [
            "bootstrap",
            "vaultcfg",
            "uidcfg",
            "vault_trigger",
            "vault_struct_available",
            "vault_struct",
            "vault_struct_wrappers",
            "vault_struct_encrypted",
            "vault_struct_salt",
            "vault_struct_iv",
            "vault_crypto_stage",
            "vault_crypto_error_class",
            "vault_crypto_subtle",
            "vault_crypto_passphrase_match",
            "vault_crypto_passphrase_bytes",
            "vault_crypto_salt_bytes",
            "vault_crypto_iv_bytes",
            "vault_crypto_ciphertext_bytes",
            "ui_flow",
            "ui_step",
            "ui_step_type",
            "route",
            "persona",
            "marker",
            "auth",
            "data",
            "ui_complete",
            "ui_ok",
            "ui_error_class",
            "portfolio_start_state",
            "portfolio_start_status",
            "portfolio_start_run_present",
            "portfolio_start_error_class",
            "portfolio_stream_state",
            "portfolio_stream_run_present",
            "portfolio_events",
            "portfolio_last_event",
            "portfolio_last_seq",
            "portfolio_stream_error_class",
            "bootstrap_uid_ok",
            "bootstrap_error_class",
            "bootstrap_detail",
            "jserr_class",
            "jsrej_class",
            "long_wait",
        ]

        var summary: [String] = keys.compactMap { key -> String? in
            guard let value = status[key], !value.isEmpty else {
                return nil
            }
            return "\(key)=\(value)"
        }
        return summary.joined(separator: " ")
    }

    private func reviewerRoute(
        name: String,
        redirect: String,
        marker: String,
        allowedDataStates: Set<String> = ["loaded"]
    ) -> RouteCase {
        RouteCase(
            name: name,
            initialRoute: "/login?redirect=\(redirect.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? redirect)",
            expectedMarker: marker,
            expectedRoute: redirect,
            expectedRoutePrefix: nil,
            autoReviewerLogin: true,
            expectedAuth: "authenticated",
            allowedDataStates: allowedDataStates
        )
    }

    private func assertRoutes(_ routes: [RouteCase]) throws {
        for route in routes {
            do {
                let app = launchApp(route)
                defer { app.terminate() }
                let status = try waitForSatisfiedStatus(app, route: route, timeout: 90)
                XCTAssertTrue(
                    route.allowedDataStates.contains(status["data"] ?? ""),
                    "Unexpected data state for \(route.name): \(statusSummaryForLog(status))"
                )
            }
        }
    }

    @discardableResult
    // MARK: - Render performance card

    /// Drives the fixed gesture card from docs/reference/mobile/render-performance-charter.md
    /// with the in-app frame-pacing probe switched on, and prints one
    /// `PERF_GESTURE name=<n> rep=<i> start_epoch_ms=<ms> end_epoch_ms=<ms>` line
    /// per gesture so the probe's windows can be joined to what the finger did.
    ///
    /// Opt-in only: `HUSHH_ENABLE_PERF_BENCHMARK=true` in the test runner
    /// environment (`TEST_RUNNER_` prefix through xcodebuild). It signs in as
    /// the reviewer through the same `-UITestMode` bootstrap as the route
    /// audits, which means the 350ms native status poll is running; that is a
    /// recorded contaminant of the attribution lane, never of a sign-off run.
    /// On a simulator the numbers attribute causes and certify nothing.
    func testRenderPerformanceCard() throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["HUSHH_ENABLE_PERF_BENCHMARK"] == "true" else {
            throw XCTSkip("Render performance card runs only with HUSHH_ENABLE_PERF_BENCHMARK=true.")
        }
        let repetitions = max(1, Int(environment["HUSHH_PERF_REPS"] ?? "") ?? 3)
        let probeArguments = ["-CapacitorStorage.hushh_perf_probe", "1"]
        // This card drives the app through the -UITestMode bridge (reviewer
        // login), so it is attribution on any hardware. Sign-off numbers come
        // from a phone, Release, test mode off (the charter's truth lane).
        #if targetEnvironment(simulator)
        NSLog("PERF_LANE certifies=false simulator=true test_mode=true")
        #else
        NSLog("PERF_LANE certifies=false simulator=false test_mode=true")
        #endif

        // Launch 1: feed flicks, bottom-nav switches, profile pane, chat stream.
        let feedRoute = RouteCase(
            name: "perf-feed",
            initialRoute: "/login?redirect=%2Fone%2Ffeed",
            expectedMarker: "native-route-feed",
            expectedRoute: "/one/feed",
            expectedRoutePrefix: nil,
            autoReviewerLogin: true,
            expectedAuth: "authenticated",
            allowedDataStates: ["loaded"]
        )
        var app = launchApp(feedRoute, extraArguments: probeArguments)
        _ = try waitForSatisfiedStatus(app, route: feedRoute, timeout: 150)
        var webView = app.webViews.firstMatch
        XCTAssertTrue(webView.waitForExistence(timeout: 10), "WebView unavailable for the feed card")
        NSLog("PERF_APP_READY route=/one/feed")
        perfSettle(2.5)

        for rep in 0..<repetitions {
            perfGesture("feed-flick", rep: rep) {
                for _ in 0..<5 {
                    perfFlick(webView, fromY: 0.75, toY: 0.25)
                    perfSettle(0.35)
                }
                perfSettle(1.5)
                for _ in 0..<5 {
                    perfFlick(webView, fromY: 0.25, toY: 0.75)
                    perfSettle(0.35)
                }
                perfSettle(1.5)
            }
        }

        for rep in 0..<repetitions {
            perfGesture("bottom-nav-switch", rep: rep) {
                for label in ["One", "Connect", "Feed"] {
                    perfTapNav(app, label: label)
                    perfSettle(1.5)
                }
            }
        }

        perfTapNav(app, label: "One")
        perfSettle(1.5)
        for rep in 0..<repetitions {
            perfGesture("profile-pane-open-dismiss", rep: rep) {
                // AppProfileEdgeGesture: a broad leftward body swipe on /one.
                let start = webView.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5))
                let end = webView.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.5))
                start.press(forDuration: 0.05, thenDragTo: end)
                perfSettle(1.5)
                // The pane is a right-side sheet without content drag-dismiss;
                // a tap on the scrim closes it.
                webView.coordinate(withNormalizedOffset: CGVector(dx: 0.04, dy: 0.5)).tap()
                perfSettle(1.2)
            }
        }

        perfTapNav(app, label: "Chat")
        perfSettle(2.5)
        if !perfChatExchange(app, streamSeconds: 30) {
            NSLog("PERF_SKIPPED name=chat-stream-30s reason=composer_not_found")
        }

        perfSettle(12) // let the probe write its idle export
        NSLog("PERF_DONE route=/one/feed")
        app.terminate()

        // Launch 2: top-shell pager swipes on Finance.
        let kaiRoute = RouteCase(
            name: "perf-kai",
            initialRoute: "/login?redirect=%2Fone%2Fkai",
            expectedMarker: "native-route-kai-home",
            expectedRoute: "/one/kai",
            expectedRoutePrefix: nil,
            autoReviewerLogin: true,
            expectedAuth: "authenticated",
            allowedDataStates: ["loaded"]
        )
        app = launchApp(kaiRoute, extraArguments: probeArguments)
        _ = try waitForSatisfiedStatus(app, route: kaiRoute, timeout: 150)
        webView = app.webViews.firstMatch
        XCTAssertTrue(webView.waitForExistence(timeout: 10), "WebView unavailable for the Finance card")
        NSLog("PERF_APP_READY route=/one/kai")
        perfSettle(2.5)
        for rep in 0..<repetitions {
            perfGesture("top-shell-pager-swipe", rep: rep) {
                let left = webView.coordinate(withNormalizedOffset: CGVector(dx: 0.82, dy: 0.48))
                let right = webView.coordinate(withNormalizedOffset: CGVector(dx: 0.18, dy: 0.48))
                left.press(forDuration: 0.08, thenDragTo: right)
                perfSettle(1.2)
                right.press(forDuration: 0.08, thenDragTo: left)
                perfSettle(1.2)
            }
        }
        for rep in 0..<repetitions {
            perfGesture("kai-chart-flick", rep: rep) {
                for _ in 0..<3 {
                    perfFlick(webView, fromY: 0.7, toY: 0.3)
                    perfSettle(0.4)
                }
                perfSettle(1.5)
            }
        }
        perfSettle(12)
        NSLog("PERF_DONE route=/one/kai")
        app.terminate()

        // Launch 3: Location map pan (native map: the hitches instrument scores it).
        let locationRoute = RouteCase(
            name: "perf-location",
            initialRoute: "/login?redirect=%2Fone%2Flocation",
            expectedMarker: "native-route-one-location",
            expectedRoute: "/one/location",
            expectedRoutePrefix: nil,
            autoReviewerLogin: true,
            expectedAuth: "authenticated",
            allowedDataStates: ["loaded"]
        )
        app = launchApp(locationRoute, extraArguments: probeArguments)
        _ = try waitForSatisfiedStatus(app, route: locationRoute, timeout: 150)
        webView = app.webViews.firstMatch
        XCTAssertTrue(webView.waitForExistence(timeout: 10), "WebView unavailable for the Location card")
        NSLog("PERF_APP_READY route=/one/location")
        perfSettle(2.5)
        for rep in 0..<repetitions {
            perfGesture("location-map-pan", rep: rep) {
                for _ in 0..<3 {
                    let start = webView.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.4))
                    let end = webView.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.55))
                    start.press(forDuration: 0.05, thenDragTo: end)
                    perfSettle(0.6)
                }
                perfSettle(1.5)
            }
        }
        perfSettle(12)
        NSLog("PERF_DONE route=/one/location")
        app.terminate()
    }

    /// The truth lane: the same gesture card with test mode off. Each surface
    /// is its own launch with only the probe argument and a route argument the
    /// probe honours (`-CapacitorStorage.hushh_perf_route`), so there is no
    /// reviewer bridge and no native status poll. The vault is unlocked with
    /// the passphrase from the process environment (never Face ID); if none
    /// is configured the test waits for the person holding the phone. On a
    /// Release build this is the certifying run the charter names.
    /// Opt-in: HUSHH_ENABLE_PERF_ATTACHED=true. HUSHH_PERF_ATTACHED_SECTION
    /// = feed | chat | kai | location | all (default all).
    /// Signs the reviewer into the app's data container and leaves the
    /// session there (-UITestResetAppState false). The Release truth lane
    /// cannot sign anyone in, by design, so after a sign-out (a /logout
    /// route, an expired session) this Debug-only step restores it and the
    /// Release app installed over it keeps the session.
    /// Driver: scripts/perf/ios-reviewer-signin.sh.
    func testReviewerSignInForTruthLane() throws {
        let route = RouteCase(
            name: "truth-lane-sign-in",
            initialRoute: "/login?redirect=%2Fone%2Ffeed",
            expectedMarker: "native-route-feed",
            expectedRoute: "/one/feed",
            expectedRoutePrefix: nil,
            autoReviewerLogin: true,
            expectedAuth: "authenticated",
            allowedDataStates: ["loaded"]
        )
        let app = launchApp(route)
        defer { app.terminate() }
        _ = try waitForSatisfiedStatus(app, route: route, timeout: 150)
        NSLog("PERF_REVIEWER_SIGNED_IN route=/one/feed")
    }

    func testRenderPerformanceCardAttached() throws {
        let environment = ProcessInfo.processInfo.environment
        let section = environment["HUSHH_PERF_ATTACHED_SECTION"] ?? "all"
        let plaidSandboxProof = section == "plaid" || section == "plaid-vault"
        guard environment["HUSHH_ENABLE_PERF_ATTACHED"] == "true" else {
            if plaidSandboxProof {
                XCTFail("Plaid proof requires HUSHH_ENABLE_PERF_ATTACHED=true.")
                throw NSError(domain: "AppUITests", code: 1)
            }
            throw XCTSkip("Attached render performance card runs only with HUSHH_ENABLE_PERF_ATTACHED=true.")
        }
        let repetitions = max(1, Int(environment["HUSHH_PERF_REPS"] ?? "") ?? 3)
        if plaidSandboxProof {
            guard environment["HUSHH_PLAID_SANDBOX_PROOF"] == "true" else {
                XCTFail("Plaid proof requires the explicit local sandbox guard.")
                throw NSError(domain: "AppUITests", code: 2)
            }
            #if targetEnvironment(simulator)
            #else
            XCTFail("Plaid proof is restricted to the local iOS Simulator.")
            throw NSError(domain: "AppUITests", code: 3)
            #endif
        }
        let passphrase = (environment["HUSHH_UI_TEST_REVIEWER_VAULT_PASSPHRASE"] ?? environment["REVIEWER_VAULT_PASSPHRASE"] ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        #if DEBUG
        let release = false
        #else
        let release = true
        #endif
        #if targetEnvironment(simulator)
        NSLog("PERF_LANE certifies=false simulator=true test_mode=false")
        #else
        NSLog("PERF_LANE certifies=\(release) simulator=false test_mode=false")
        #endif

        func launchAttached(route: String?, shellOptional: Bool = false, failHard: Bool = true, unlockTimeout: TimeInterval = 240) throws -> (XCUIApplication, XCUIElement) {
            let app = XCUIApplication()
            var arguments = ["-CapacitorStorage.hushh_perf_probe", "1"]
            if plaidSandboxProof {
                // NSArgumentDomain supplies this to Capacitor Preferences for
                // this launch only. The WebView also requires its compiled
                // local-proof marker before it will request a Link token.
                arguments += ["-CapacitorStorage.hushh_plaid_sandbox_proof", "1"]
            }
            if let route {
                arguments += ["-CapacitorStorage.hushh_perf_route", route]
            }
            // An attribution experiment for this launch (the probe applies
            // it and names it in the export; such a run never certifies).
            if let experiment = ProcessInfo.processInfo.environment["HUSHH_PERF_EXPERIMENT"],
               !experiment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                arguments += ["-CapacitorStorage.hushh_perf_experiment", experiment]
                NSLog("PERF_EXPERIMENT \(experiment)")
            }
            app.launchArguments = arguments
            app.launch()
            let webView = app.webViews.firstMatch
            XCTAssertTrue(webView.waitForExistence(timeout: 30), "WebView unavailable")
            try perfUnlockVault(app, passphrase: passphrase, timeout: unlockTimeout, shellOptional: shellOptional, failHard: failHard)
            return (app, webView)
        }

        if section == "all" || section == "feed" {
            let (app, webView) = try launchAttached(route: "/one/feed")
            perfSettle(3)
            NSLog("PERF_APP_READY route=/one/feed")
            for rep in 0..<repetitions {
                perfGesture("feed-flick", rep: rep) {
                    for _ in 0..<5 {
                        perfFlick(webView, fromY: 0.75, toY: 0.25)
                        perfSettle(0.35)
                    }
                    perfSettle(1.5)
                    for _ in 0..<5 {
                        perfFlick(webView, fromY: 0.25, toY: 0.75)
                        perfSettle(0.35)
                    }
                    perfSettle(1.5)
                }
            }
            for rep in 0..<repetitions {
                perfGesture("bottom-nav-switch", rep: rep) {
                    for label in ["One", "Connect", "Feed"] {
                        perfTapNav(app, label: label)
                        perfSettle(1.5)
                    }
                }
            }
            perfTapNav(app, label: "One")
            perfSettle(1.5)
            for rep in 0..<repetitions {
                perfGesture("profile-pane-open-dismiss", rep: rep) {
                    let start = webView.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5))
                    let end = webView.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.5))
                    start.press(forDuration: 0.05, thenDragTo: end)
                    perfSettle(1.5)
                    webView.coordinate(withNormalizedOffset: CGVector(dx: 0.04, dy: 0.5)).tap()
                    perfSettle(1.2)
                }
            }
            perfSettle(12)
            NSLog("PERF_DONE route=/one/feed")
            app.terminate()
        }

        if section == "all" || section == "chat" {
            let (app, _) = try launchAttached(route: "/")
            perfSettle(3)
            NSLog("PERF_APP_READY route=/")
            if !perfChatExchange(app, streamSeconds: 30) {
                NSLog("PERF_SKIPPED name=chat-stream-30s reason=composer_not_found")
            }
            perfSettle(12)
            NSLog("PERF_DONE route=/")
            app.terminate()
        }

        // The MCP connections panel (a right-side sheet off the chat history
        // drawer): open it, hold it for a capture, and read where its title
        // and close control sit against the top of the window.
        if section == "connectors" {
            let (app, _) = try launchAttached(route: "/")
            perfSettle(3)
            NSLog("PERF_APP_READY route=/")
            let openHistory = app.webViews.descendants(matching: .any)
                .matching(NSPredicate(format: "label == %@", "Open chat history")).firstMatch
            if openHistory.waitForExistence(timeout: 10) {
                perfGesture("history-drawer-open", rep: 0) {
                    openHistory.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
                    perfSettle(1.2)
                }
                let openConnectors = app.webViews.descendants(matching: .any)
                    .matching(NSPredicate(format: "label == %@", "Open MCP connections")).firstMatch
                if openConnectors.waitForExistence(timeout: 5) {
                    perfGesture("connectors-open", rep: 0) {
                        openConnectors.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
                        perfSettle(1.5)
                    }
                    let title = app.webViews.staticTexts.matching(NSPredicate(format: "label == %@", "MCP connections")).firstMatch
                    let close = app.webViews.buttons.matching(NSPredicate(format: "label == %@", "Close")).firstMatch
                    NSLog("PERF_CONNECTORS_GEOMETRY title_top=\(title.exists ? Int(title.frame.minY) : -1) close_top=\(close.exists ? Int(close.frame.minY) : -1) window_safe_top=\(Int(app.windows.firstMatch.frame.minY))")
                    NSLog("PERF_CONNECTORS_OPEN 1")
                    perfSettle(8)
                } else {
                    NSLog("PERF_SKIPPED name=connectors-open reason=button_not_found")
                }
            } else {
                NSLog("PERF_SKIPPED name=history-drawer-open reason=button_not_found")
            }
            NSLog("PERF_DONE route=/")
            app.terminate()
        }

        // The person's own information on the Memory route: the scope
        // catalogue as the person sees it. Logs the visible labels (never
        // values) at the root and inside the financial branch.
        if section == "memory" {
            let (app, _) = try launchAttached(route: "/one/pkm")
            let readyAt = perfEpochMs()
            NSLog("PERF_APP_READY route=/one/pkm")
            func logLabels(_ tag: String) {
                let texts = app.webViews.staticTexts.allElementsBoundByIndex
                let labels = texts.prefix(120).map { $0.label }.filter { !$0.isEmpty }
                NSLog("PERF_MEMORY_LABELS \(tag) count=\(labels.count) :: \(labels.joined(separator: " | "))")
            }
            func find(_ text: String) -> XCUIElement {
                app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH[c] %@", text)).firstMatch
            }
            // The categories arrive after the memories load; note how long that takes.
            let financial = find("Financial")
            let listed = financial.waitForExistence(timeout: 25)
            NSLog("PERF_MEMORY_CATEGORIES listed=\(listed ? 1 : 0) after_ms=\(perfEpochMs() - readyAt)")
            logLabels("saved-root")
            if listed {
                financial.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
                perfSettle(3)
                logLabels("saved-financial")
                let firstBranch = app.webViews.descendants(matching: .any)
                    .matching(NSPredicate(format: "label CONTAINS[c] %@", "Portfolio")).firstMatch
                if firstBranch.waitForExistence(timeout: 5) {
                    firstBranch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
                    perfSettle(3)
                    logLabels("saved-financial-portfolio")
                }
                // Back to the root, then the Sharing tab: what a person can share.
                app.terminate()
                let (again, _) = try launchAttached(route: "/one/pkm")
                let sharing = again.webViews.descendants(matching: .any)
                    .matching(NSPredicate(format: "label ==[c] %@", "Sharing")).firstMatch
                if sharing.waitForExistence(timeout: 20) {
                    sharing.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
                    perfSettle(4)
                    let texts = again.webViews.staticTexts.allElementsBoundByIndex.prefix(120).map { $0.label }.filter { !$0.isEmpty }
                    NSLog("PERF_MEMORY_LABELS sharing count=\(texts.count) :: \(texts.joined(separator: " | "))")
                    let fin = again.webViews.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH[c] %@", "Financial")).firstMatch
                    if fin.waitForExistence(timeout: 8) {
                        fin.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
                        perfSettle(3)
                        let inner = again.webViews.staticTexts.allElementsBoundByIndex.prefix(120).map { $0.label }.filter { !$0.isEmpty }
                        NSLog("PERF_MEMORY_LABELS sharing-financial count=\(inner.count) :: \(inner.joined(separator: " | "))")
                    }
                }
                perfSettle(3)
                NSLog("PERF_DONE route=/one/pkm")
                again.terminate()
            } else {
                NSLog("PERF_SKIPPED name=memory-financial reason=categories_never_listed")
                NSLog("PERF_DONE route=/one/pkm")
                app.terminate()
            }
        }

        // Every route the inventory says the phone must serve, one launch each.
        //
        // The other sections above drive gestures on a handful of surfaces
        // that were chosen by hand, which is how coverage rots: a route added
        // later is invisible here by default. This section takes its list from
        // the shell (which reads native-route-inventory.json), so the set can
        // only ever be as stale as the inventory itself.
        //
        // One launch per route, settle, then an idle window. That is enough to
        // find the route that costs 300 ms to paint or never settles at all;
        // gesture work on a named surface still belongs in its own section.
        // One launch, one unlock, then the app walked the way a person uses
        // it: every stop is reached by a tap from the one before, never by a
        // launch into a route, so the session, its caches and its vault key
        // carry through. Each stop logs PERF_STOP and holds still while the
        // card captures the phone's screen from the Mac, for the pixel review
        // (layout under the keyboard, clipping, alignment, copy). Read-only:
        // nothing is sent, approved or removed.
        // Plaid vault proof (sandbox only, local backend): connect six sandbox
        // banks through Plaid's native screens, each sealed into the person's
        // financial memory. Needs a build pointed at a backend holding the
        // Plaid SANDBOX key. Sandbox logins only (user_good / pass_good); the
        // connections are kept on purpose (founder decision 2026-09-23).
        if section == "plaid-vault" {
            perfGateStop = true
            let (app, _) = try launchAttached(route: nil)
            perfGateStop = false
            perfSettle(3)
            NSLog("PERF_APP_READY route=plaid-vault")
            // This build talks to a backend on the local network, so iOS asks
            // once for Local Network access; the prompt belongs to SpringBoard.
            func allowLocalNetworkIfAsked() {
                let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
                let allow = springboard.buttons["Allow"]
                if allow.waitForExistence(timeout: 3) {
                    allow.tap()
                    NSLog("PLAID_STEP local_network_allowed")
                    perfSettle(3)
                }
            }
            allowLocalNetworkIfAsked()
            // The launch helper treats any "One" label as unlocked, which can
            // be true for a moment before the vault gate settles (or while a
            // system prompt covers it). Unlock here if the gate is up.
            func unlockIfGated() {
                let field = app.secureTextFields.firstMatch
                guard field.waitForExistence(timeout: 8), !passphrase.isEmpty else { return }
                NSLog("PLAID_STEP gate_visible_unlocking")
                field.tap()
                perfSettle(0.5)
                field.typeText(passphrase)
                perfSettle(0.6)
                let unlock = app.buttons["Unlock"]
                if unlock.waitForExistence(timeout: 4) && unlock.isEnabled { unlock.tap() }
                for _ in 0..<90 {
                    if !app.secureTextFields.firstMatch.exists { break }
                    perfSettle(1)
                }
                perfSettle(4)
                NSLog("PLAID_STEP gate_cleared=\(!app.secureTextFields.firstMatch.exists)")
            }
            unlockIfGated()
            func element(_ label: String, contains: Bool = false) -> XCUIElement {
                let format = contains ? "label CONTAINS[c] %@" : "label == %@"
                return app.descendants(matching: .any)
                    .matching(NSPredicate(format: format, label)).firstMatch
            }
            func tapFirst(_ label: String, contains: Bool = false, timeout: TimeInterval = 6) -> Bool {
                let found = element(label, contains: contains)
                guard found.waitForExistence(timeout: timeout) else { return false }
                if found.isHittable {
                    found.tap()
                } else {
                    found.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
                }
                return true
            }
            func checkpoint(_ name: String) {
                perfSettle(1.0)
                NSLog("PLAID_STEP \(name)")
            }
            // XCUITest can drop keystrokes while the keyboard is still coming
            // up (First Gingham got a 7-character "pass_good" and Plaid said
            // "Incorrect credentials"). A secure field reports one bullet per
            // character, so check the length and retype until it matches.
            func typeVerified(_ field: XCUIElement, _ text: String, secure: Bool) -> Bool {
                for _ in 0..<3 {
                    // Once revealed, the secure field is gone; the check above
                    // already had its chance on the plain one.
                    guard field.exists else { return false }
                    field.tap()
                    perfSettle(0.6)
                    let current = (field.value as? String) ?? ""
                    let placeholder = field.placeholderValue ?? ""
                    if !current.isEmpty && current != placeholder && current != field.label {
                        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count + 2))
                    }
                    field.typeText(text)
                    // Reveal a secure field so the check reads the real text;
                    // deleting inside a secure field is not reliable on iOS.
                    if secure {
                        let reveal = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS[c] %@", "show", "reveal")).firstMatch
                        if reveal.exists && reveal.isHittable { reveal.tap(); perfSettle(0.5) }
                        let plain = app.textFields["Password"]
                        if plain.exists {
                            if ((plain.value as? String) ?? "") == text { return true }
                            plain.tap()
                            plain.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 24))
                            plain.typeText(text)
                            if ((plain.value as? String) ?? "") == text { return true }
                        }
                    }
                    let typed = (field.value as? String) ?? ""
                    if secure ? typed.count == text.count : typed == text { return true }
                    NSLog("PLAID_STEP retype length=\(typed.count)")
                }
                return false
            }
            // Leave Link without connecting, so the next bank starts clean.
            func closeLink() {
                for _ in 0..<3 {
                    let close = app.buttons.matching(NSPredicate(format: "label ==[c] %@ OR label ==[c] %@", "Close", "Exit")).firstMatch
                    if close.exists { close.tap(); perfSettle(1.5) }
                    for label in ["Yes, exit", "Exit", "Leave"] where element(label).exists { element(label).tap(); perfSettle(1.5) }
                    if element("Portfolio source", contains: true).exists { return }
                }
            }
            func dismissKeyboardIfShown() {
                for key in ["Done", "done", "Return", "return", "Go", "go"] {
                    let button = app.keyboards.buttons[key]
                    if button.exists && button.isHittable { button.tap(); return }
                }
            }

            allowLocalNetworkIfAsked()
            // The app can reopen on Chat while it is still settling, and a
            // single tap on the One tab then lands nowhere; retry until the
            // Finance entry is on screen.
            for _ in 0..<4 {
                perfTapNav(app, label: "One")
                perfSettle(2)
                if element("Finance").exists || element("Finance,", contains: true).exists { break }
            }
            if !tapFirst("Finance") { _ = tapFirst("Finance,", contains: true) }
            perfSettle(2.5)
            _ = tapFirst("Portfolio")
            perfSettle(2.5)
            checkpoint("portfolio")

            let banks = [
                "First Platypus Bank", "First Platypus Bank", "First Gingham Credit Union",
                "Tattersall Federal Credit Union", "Tartan Bank", "Houndstooth Bank",
            ]
            // Resume after banks already sealed on this account, so a rerun
            // adds the missing ones instead of duplicating kept connections.
            let rawStartIndex = ProcessInfo.processInfo.environment["HUSHH_PLAID_START_INDEX"] ?? "0"
            guard let startIndex = Int(rawStartIndex), (0..<banks.count).contains(startIndex) else {
                XCTFail("HUSHH_PLAID_START_INDEX must be an integer from 0 through \(banks.count - 1).")
                throw NSError(domain: "AppUITests", code: 3)
            }
            let expectedConnections = banks.count - startIndex
            var connected = 0
            bankLoop: for (index, bank) in banks.enumerated() where index >= startIndex {
                guard tapFirst("Portfolio source", contains: true, timeout: 12) else {
                    NSLog("PLAID_MISSING index=\(index) step=portfolio_source"); checkpoint("\(index)-no-source"); break
                }
                perfSettle(1.5)
                // The row exposes its title and description as one label. It is
                // disabled while the previous connection finishes, so tap until
                // Plaid actually opens.
                let skipPhone = element("Continue without phone number")
                var plaidOpened = false
                for _ in 0..<6 {
                    if !tapFirst("Connect a bank or brokerage", contains: true, timeout: 4)
                        && !tapFirst("Manage connections", contains: true, timeout: 4) {
                        perfSettle(3); continue
                    }
                    if skipPhone.waitForExistence(timeout: 20) || app.searchFields.firstMatch.exists {
                        plaidOpened = true; break
                    }
                    perfSettle(3)
                }
                guard plaidOpened else {
                    NSLog("PLAID_MISSING index=\(index) step=connect_row"); checkpoint("\(index)-no-connect"); break
                }
                if skipPhone.exists { skipPhone.tap() }
                perfSettle(2)
                let search = app.searchFields.firstMatch.waitForExistence(timeout: 8)
                    ? app.searchFields.firstMatch : app.textFields.firstMatch
                guard search.waitForExistence(timeout: 10) else {
                    NSLog("PLAID_MISSING index=\(index) step=search"); checkpoint("\(index)-no-search"); break
                }
                search.tap()
                search.typeText(bank)
                perfSettle(3)
                checkpoint("\(index)-results")
                let result = app.descendants(matching: .any)
                    .matching(NSPredicate(format: "label BEGINSWITH %@", bank)).allElementsBoundByIndex
                    .first { $0.elementType != .searchField && $0.elementType != .textField && $0.isHittable && $0.frame.minY > search.frame.maxY }
                guard let result else {
                    NSLog("PLAID_MISSING index=\(index) step=result"); break
                }
                result.tap()
                perfSettle(3)
                // Some banks list associated institutions first; take the plain one.
                let username = app.textFields["Username"]
                if !username.waitForExistence(timeout: 4) {
                    let plain = app.descendants(matching: .any)
                        .matching(NSPredicate(format: "label == %@", bank)).allElementsBoundByIndex
                        .first { $0.isHittable && $0.frame.minY > 180 }
                    plain?.tap()
                    perfSettle(3)
                }
                guard username.waitForExistence(timeout: 15) else {
                    NSLog("PLAID_MISSING index=\(index) step=username"); checkpoint("\(index)-no-username"); break
                }
                let password = app.secureTextFields["Password"]
                guard typeVerified(username, "user_good", secure: false),
                      password.waitForExistence(timeout: 5),
                      typeVerified(password, "pass_good", secure: true) else {
                    NSLog("PLAID_MISSING index=\(index) step=credentials"); checkpoint("\(index)-no-credentials")
                    closeLink(); continue bankLoop
                }
                dismissKeyboardIfShown()
                perfSettle(0.8)
                // The keyboard's return key often submits the login itself, in
                // which case Plaid is already on the accounts screen.
                if !element("Your accounts").waitForExistence(timeout: 3) && !tapFirst("Submit", timeout: 5)
                    && !element("Continue").exists {
                    NSLog("PLAID_MISSING index=\(index) step=submit"); checkpoint("\(index)-no-submit"); break
                }
                // Account selection (all selected by default), then Continue.
                // No accounts screen means Link did not log in: that bank is
                // not connected, whatever happens next.
                let continueButton = element("Continue")
                guard continueButton.waitForExistence(timeout: 45), !element("Incorrect credentials").exists else {
                    NSLog("PLAID_MISSING index=\(index) step=login"); checkpoint("\(index)-no-login")
                    closeLink(); continue bankLoop
                }
                checkpoint("\(index)-accounts")
                continueButton.tap()
                let finish = element("Finish without saving")
                if finish.waitForExistence(timeout: 30) { finish.tap() }
                // Back in the app: the connection is exchanged and sealed.
                var backInApp = false
                for _ in 0..<30 {
                    if app.webViews.firstMatch.exists && element("Portfolio source", contains: true).exists {
                        backInApp = true; break
                    }
                    perfSettle(1)
                }
                perfSettle(6)
                checkpoint("\(index)-after")
                guard backInApp else {
                    NSLog("PLAID_MISSING index=\(index) step=return_to_app"); break bankLoop
                }
                // The exchange, the transaction pages and the sealed write run
                // after Link closes. Ending the test inside that window kills
                // the app mid-seal (Houndstooth, run 16), so give it time.
                perfSettle(20)
                connected += 1
                NSLog("PLAID_CONNECTED index=\(index) bank=\(bank)")
            }
            NSLog("PLAID_DONE connected=\(connected) expected=\(expectedConnections)")
            XCTAssertEqual(
                connected,
                expectedConnections,
                "Plaid proof did not complete every requested sandbox connection."
            )
            checkpoint("final")
            return
        }

        if section == "session" {
            perfGateStop = true
            let (app, webView) = try launchAttached(route: nil)
            perfGateStop = false
            perfSettle(3)
            NSLog("PERF_APP_READY route=session")
            func stop(_ name: String, settle: TimeInterval = 2.5) {
                perfSettle(settle)
                NSLog("PERF_STOP name=\(name)")
                perfSettle(2.5)
            }
            func tapLabel(_ label: String, contains: Bool = false) -> Bool {
                let format = contains ? "label CONTAINS[c] %@" : "label == %@"
                let element = app.webViews.descendants(matching: .any)
                    .matching(NSPredicate(format: format, label)).firstMatch
                guard element.waitForExistence(timeout: 4) else {
                    NSLog("PERF_SKIPPED name=session-tap reason=label_not_found label=\(label)")
                    return false
                }
                if element.isHittable {
                    element.tap()
                } else {
                    element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
                }
                return true
            }
            // The header's back arrow, found by where it sits (top left)
            // rather than by its label, which is a breadcrumb that changes
            // per screen ("Go back", "Back to Location", ...).
            func tapHeaderBack() -> Bool {
                let buttons = app.webViews.buttons.allElementsBoundByIndex
                for button in buttons where button.exists {
                    let frame = button.frame
                    if frame.minX < 80 && frame.midY < 170 && frame.width < 90 && button.isHittable {
                        button.tap()
                        return true
                    }
                }
                NSLog("PERF_SKIPPED name=session-back reason=header_back_not_found")
                return false
            }
            // Back to the tab bar from wherever the last tap landed (a
            // full-screen page such as Advisor's setup has none).
            func returnToTab(_ label: String) {
                for _ in 0..<3 {
                    let bar = app.webViews.descendants(matching: .any)
                        .matching(NSPredicate(format: "label == %@", label))
                    if bar.count > 0 && bar.allElementsBoundByIndex.contains(where: { $0.frame.midY > 700 }) { break }
                    if !tapHeaderBack() { break }
                    perfSettle(1.2)
                }
                perfTapNav(app, label: label)
            }
            // Rapid in-test screenshots right after a tap, kept as attachments
            // the card exports (the Mac cannot screen-record this iPhone). Each
            // carries its capture time so the sequence can be timed.
            func burst(_ name: String, count: Int = 10) {
                for index in 0..<count {
                    let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
                    attachment.name = String(
                        format: "burst-%@-%02d-%lld", name, index,
                        Int64(Date().timeIntervalSince1970 * 1000)
                    )
                    attachment.lifetime = .keepAlways
                    add(attachment)
                }
            }
            func dismissKeyboard() {
                // A tap on the content above the keyboard, as a person does.
                webView.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.22)).tap()
                perfSettle(1.0)
            }

            stop("landing", settle: 1)

            perfTapNav(app, label: "Chat")
            burst("to-chat")
            stop("chat")
            if tapLabel("Message One") {
                stop("chat-keyboard", settle: 1.5)
                // A long draft must move into the expanded editor on its own,
                // with every character kept. Typed, never sent, then deleted.
                let composer = app.webViews.descendants(matching: .any)
                    .matching(NSPredicate(format: "label == %@", "Message One")).firstMatch
                let draft = (1...6).map { "draft line number \($0) for the expand check only. " }.joined()
                composer.typeText(draft)
                stop("composer-long-draft", settle: 1.0)
                let expanded = app.webViews.descendants(matching: .any)
                    .matching(NSPredicate(format: "label == %@", "Expanded message One")).firstMatch
                NSLog("PERF_COMPOSER expanded=\(expanded.exists ? 1 : 0)")
                let editor = expanded.exists ? expanded : composer
                editor.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: draft.count + 10))
                stop("composer-cleared", settle: 0.8)
                dismissKeyboard()
            }
            // One rating round trip: like, then unlike, so nothing is left.
            if tapLabel("Like response") {
                stop("rated-like", settle: 3.0)
                _ = tapLabel("Like response")
                stop("rated-cleared", settle: 2.0)
            }

            perfTapNav(app, label: "One")
            stop("one")
            for (agent, tabs) in [
                ("Finance", ["Portfolio", "Analysis"]),
                ("Wallet", []), ("Location", []), ("Advisor", []), ("Mail", []),
                ("Calendar", []), ("KYC", []), ("Memory", []), ("Consent", []),
            ] {
                guard tapLabel(agent) || tapLabel("\(agent),", contains: true) else { continue }
                stop("agent-\(agent.lowercased())")
                for tab in tabs where tapLabel(tab) {
                    stop("agent-\(agent.lowercased())-\(tab.lowercased())")
                }
                returnToTab("One")
                perfSettle(1.5)
            }

            returnToTab("Connect")
            burst("to-connect")
            stop("connect")
            if tapLabel("Circles") { stop("connect-circles") }

            returnToTab("Feed")
            burst("to-feed")
            stop("feed")

            returnToTab("Search")
            stop("search-keyboard", settle: 1.5)
            dismissKeyboard()

            returnToTab("One")
            perfSettle(1.5)
            if tapLabel("Open Profile") {
                stop("profile-pane")
                for row in ["Your account", "Appearance & preferences", "Security & privacy", "Trusted devices", "Help & feedback"] {
                    guard tapLabel(row) else { continue }
                    stop("profile-\(row.lowercased().replacingOccurrences(of: " & ", with: "-").replacingOccurrences(of: " ", with: "-"))")
                    // Back to the pane the way a person would: the header arrow.
                    if !tapHeaderBack() { _ = tapLabel("Open Profile") }
                    perfSettle(1.5)
                }
            }
            NSLog("PERF_DONE route=session")
            app.terminate()
        }

        // PERF_SECTION=profile: scrolling the Profile page itself (the pane's
        // open and dismiss are measured in the feed section).
        if section == "profile" {
            let (app, webView) = try launchAttached(route: nil)
            perfSettle(3)
            perfTapNav(app, label: "One")
            perfSettle(1.5)
            let open = app.webViews.descendants(matching: .any)
                .matching(NSPredicate(format: "label == %@", "Open Profile")).firstMatch
            if open.waitForExistence(timeout: 8) {
                open.tap()
                perfSettle(3)
                NSLog("PERF_APP_READY route=profile")
                for rep in 0..<repetitions {
                    perfGesture("profile-flick", rep: rep) {
                        for _ in 0..<4 {
                            perfFlick(webView, fromY: 0.75, toY: 0.3)
                            perfSettle(0.35)
                        }
                        perfSettle(1.5)
                        for _ in 0..<4 {
                            perfFlick(webView, fromY: 0.3, toY: 0.75)
                            perfSettle(0.35)
                        }
                        perfSettle(1.5)
                    }
                }
            } else {
                NSLog("PERF_SKIPPED name=profile-flick reason=open_profile_not_found")
            }
            perfSettle(12)
            NSLog("PERF_DONE route=profile")
            app.terminate()
        }

        // PERF_SECTION=journeys: the release device gate. Seven journeys a
        // person takes, in one install, on the reviewer session the Debug
        // bootstrap left behind (Release has no automated sign-in). Each
        // journey is framed by JOURNEY_BEGIN/END for the card's Mac-side frame
        // capture; JOURNEY_PAUSE holds that capture off the passphrase entry
        // and the home screen, and waits out any frame already in flight.
        // Checks log JOURNEY_CHECK / JOURNEY_METRIC / JOURNEY_GEOMETRY; the
        // test itself fails only when the app cannot be reached at all, so a
        // missing surface is reported next to its screenshot, not hidden.
        // It never taps Allow: a decline is always undone inside its window.
        if section == "journeys" {
            let app = XCUIApplication()
            app.launchArguments = ["-CapacitorStorage.hushh_perf_probe", "1"]
            let webView = app.webViews.firstMatch
            func mark(_ kind: String, _ name: String) {
                NSLog("JOURNEY_\(kind) name=\(name) epoch_ms=\(perfEpochMs())")
            }
            func pauseCapture(_ name: String) { mark("PAUSE", name); perfSettle(2.0) }
            func stop(_ name: String, settle: TimeInterval = 1.5) {
                perfSettle(settle)
                NSLog("PERF_STOP name=\(name)")
                perfSettle(2.0)
            }
            func check(_ journey: String, _ name: String, _ ok: Bool, _ detail: String = "") {
                NSLog("JOURNEY_CHECK journey=\(journey) check=\(name) ok=\(ok ? 1 : 0) \(detail)")
            }
            func metric(_ name: String, _ value: Int64) { NSLog("JOURNEY_METRIC name=\(name) value=\(value)") }
            func quickShot(_ name: String) {
                let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
                attachment.name = "\(name)-\(perfEpochMs())"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
            func burst(_ name: String, count: Int) {
                for index in 0..<count { quickShot(String(format: "burst-%@-%02d", name, index)) }
            }
            func web(_ predicate: NSPredicate) -> XCUIElementQuery {
                app.webViews.descendants(matching: .any).matching(predicate)
            }
            func labelled(_ label: String) -> NSPredicate { NSPredicate(format: "label == %@", label) }
            func tapElement(_ element: XCUIElement) {
                if element.isHittable { element.tap() } else { element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
            }
            func tapFirst(_ predicate: NSPredicate, timeout: TimeInterval = 4) -> Bool {
                let element = web(predicate).firstMatch
                guard element.waitForExistence(timeout: timeout) else { return false }
                tapElement(element)
                return true
            }
            func geometry(_ name: String, _ element: XCUIElement) {
                guard element.exists else { return }
                let frame = element.frame
                let window = app.windows.firstMatch.frame
                NSLog("JOURNEY_GEOMETRY name=\(name) x=\(Int(frame.minX)) y=\(Int(frame.minY)) w=\(Int(frame.width)) h=\(Int(frame.height)) right_gap=\(Int(window.maxX - frame.maxX)) window_w=\(Int(window.width)) window_h=\(Int(window.height))")
            }
            // Scroll the page until an element sits clear of the top bar and the tab bar.
            func scrollTo(_ predicate: NSPredicate, maxFlicks: Int = 8) -> XCUIElement? {
                let height = app.windows.firstMatch.frame.height
                for _ in 0...maxFlicks {
                    let element = web(predicate).firstMatch
                    if element.exists && element.frame.minY > 100 && element.frame.maxY < height - 120 { return element }
                    perfFlick(webView, fromY: 0.72, toY: 0.45)
                    perfSettle(0.9)
                }
                let element = web(predicate).firstMatch
                return element.exists ? element : nil
            }
            func headerBack() {
                for button in app.webViews.buttons.allElementsBoundByIndex where button.exists {
                    let frame = button.frame
                    if frame.minX < 80 && frame.midY < 170 && frame.width < 90 && button.isHittable {
                        button.tap()
                        return
                    }
                }
            }
            func openProfile() -> Bool {
                perfTapNav(app, label: "One")
                perfSettle(1.5)
                return tapFirst(labelled("Open Profile"))
            }
            let gateField = NSPredicate(format: "label == %@ OR placeholderValue == %@ OR label == %@", "Vault passphrase", "Enter passphrase", "Passphrase")
            func unlockOffCamera() throws {
                pauseCapture("passphrase")
                try perfUnlockVault(app, passphrase: passphrase, timeout: 240)
                perfSettle(1.0)
                mark("RESUME", "passphrase")
            }

            // 1. Cold launch, the restored session, the passphrase unlock.
            let launchStart = perfEpochMs()
            app.launch()
            mark("BEGIN", "01-cold-launch-unlock")
            XCTAssertTrue(webView.waitForExistence(timeout: 30), "WebView unavailable")
            metric("cold_launch_webview_ms", perfEpochMs() - launchStart)
            var interactive: Int64 = -1
            let interactiveDeadline = Date().addingTimeInterval(90)
            while Date() < interactiveDeadline {
                if web(gateField).count > 0 || perfLabelExists(app, "One") {
                    interactive = perfEpochMs() - launchStart
                    break
                }
                perfSettle(0.25)
            }
            metric("cold_launch_interactive_ms", interactive)
            let gateShown = web(gateField).count > 0
            check("01", "vault_gate_on_cold_launch", gateShown)
            stop("01-cold-launch--gate", settle: 0.5)
            try unlockOffCamera()
            check("01", "unlocked_shell", perfLabelExists(app, "One"))
            stop("01-cold-launch--unlocked")
            mark("END", "01-cold-launch-unlock")

            // 2. Chat: send, the reply streams in, the composer stays put,
            // and the person's own bubble can be selected.
            mark("BEGIN", "02-chat")
            let chatTap = perfEpochMs()
            perfTapNav(app, label: "Chat")
            let composer = web(labelled("Message One")).firstMatch
            let composerSeen = composer.waitForExistence(timeout: 20)
            metric("chat_first_render_ms", composerSeen ? perfEpochMs() - chatTap : -1)
            stop("02-chat--open")
            if composerSeen {
                let restTop = composer.frame.minY
                geometry("chat-composer-rest", composer)
                composer.tap()
                perfSettle(1.2)
                let keyboard = app.keyboards.firstMatch
                if keyboard.exists {
                    NSLog("JOURNEY_GEOMETRY name=chat-keyboard composer_bottom=\(Int(composer.frame.maxY)) keyboard_top=\(Int(keyboard.frame.minY)) gap=\(Int(keyboard.frame.minY - composer.frame.maxY))")
                }
                check("02", "keyboard_shown", keyboard.exists)
                stop("02-chat--keyboard", settle: 0.3)
                let prompt = "Reply in one short sentence: what can you help me with today?"
                composer.typeText(prompt)
                stop("02-chat--typed", settle: 0.5)
                let send = app.webViews.buttons.matching(labelled("Send message")).firstMatch
                let sentAt = perfEpochMs()
                if send.exists {
                    send.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
                } else {
                    composer.typeText("\n")
                }
                burst("02-send-ripple", count: 6)
                stop("02-chat--streaming", settle: 1.5)
                let rated = app.webViews.buttons.matching(labelled("Like response")).firstMatch
                let replied = rated.waitForExistence(timeout: 90)
                metric("chat_reply_complete_ms", replied ? perfEpochMs() - sentAt : -1)
                check("02", "reply_complete", replied)
                webView.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.22)).tap()
                perfSettle(1.2)
                stop("02-chat--reply")
                let settledTop = composer.exists ? composer.frame.minY : -1
                check("02", "composer_back_at_rest", abs(settledTop - restTop) <= 2, "rest_top=\(Int(restTop)) settled_top=\(Int(settledTop))")
                let mine = app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "what can you help me with today")).firstMatch
                if mine.exists {
                    geometry("chat-own-bubble", mine)
                    mine.press(forDuration: 1.2)
                    perfSettle(0.8)
                    let editMenu = app.menuItems.count > 0 || app.buttons.matching(labelled("Copy")).count > 0
                    check("02", "own_bubble_selectable", editMenu, "menu_items=\(app.menuItems.count)")
                    quickShot("02-selection")
                    stop("02-chat--selection", settle: 0.2)
                    webView.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.22)).tap()
                    perfSettle(0.8)
                } else {
                    check("02", "own_bubble_selectable", false, "reason=bubble_not_found")
                }
            }
            mark("END", "02-chat")

            // 3. Profile > Shared with you: the secure card, hide and copy.
            mark("BEGIN", "03-shared-with-you")
            if openProfile() {
                stop("03-profile")
                if let group = scrollTo(labelled("Shared with you")) {
                    geometry("shared-with-you-title", group)
                    perfSettle(2.0)
                    stop("03-shared-with-you--group")
                    let card = web(NSPredicate(format: "label ENDSWITH %@", " shared with you")).firstMatch
                    check("03", "card_present", card.exists)
                    let decrypted = web(NSPredicate(format: "label == %@", "Decrypted on this device")).firstMatch
                    check("03", "decrypted_on_device", decrypted.waitForExistence(timeout: 10))
                    let hide = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Hide ")).firstMatch
                    if hide.exists {
                        tapElement(hide)
                        perfSettle(0.8)
                        let hiddenShown = web(labelled("Hidden")).count > 0
                        check("03", "hide_masks_values", hiddenShown)
                        stop("03-shared-with-you--hidden", settle: 0.2)
                        _ = tapFirst(NSPredicate(format: "label BEGINSWITH %@", "Show "))
                        perfSettle(0.8)
                    } else {
                        check("03", "hide_masks_values", false, "reason=no_hide_control")
                    }
                    let copy = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Copy ")).firstMatch
                    if copy.exists {
                        tapElement(copy)
                        let copied = web(labelled("Copied")).firstMatch.waitForExistence(timeout: 2)
                        quickShot("03-copied")
                        check("03", "copy_confirms", copied)
                        // Shared values never stay on the phone's clipboard.
                        UIPasteboard.general.items = []
                    } else {
                        check("03", "copy_confirms", false, "reason=no_copy_control")
                    }
                    stop("03-shared-with-you--card", settle: 0.8)
                } else {
                    check("03", "card_present", false, "reason=group_not_found")
                    stop("03-shared-with-you--missing")
                }
            } else {
                check("03", "profile_opened", false)
            }
            mark("END", "03-shared-with-you")

            // 4. Consent Center: the decision row, its sheet, a decline undone.
            mark("BEGIN", "04-consent-center")
            perfTapNav(app, label: "One")
            perfSettle(1.5)
            if tapFirst(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", "Consent", "Consent,")) {
                stop("04-consent", settle: 2.5)
                let declines = app.webViews.buttons.matching(labelled("Don't allow"))
                let allows = app.webViews.buttons.matching(labelled("Allow"))
                NSLog("JOURNEY_COUNT name=consent_pending_rows decline=\(declines.count) allow=\(allows.count)")
                for index in 0..<min(3, declines.count) {
                    geometry("consent-decline-\(index)", declines.element(boundBy: index))
                }
                for index in 0..<min(3, allows.count) {
                    geometry("consent-allow-\(index)", allows.element(boundBy: index))
                }
                if declines.count > 0 {
                    let firstDecline = declines.element(boundBy: 0)
                    let window = app.windows.firstMatch.frame
                    check("04", "decision_buttons_unclipped", allows.element(boundBy: 0).frame.maxX <= window.maxX - 8)
                    // The row body, left of its two buttons, opens the sheet.
                    let buttonsBefore = app.webViews.buttons.count
                    app.coordinate(withNormalizedOffset: .zero)
                        .withOffset(CGVector(dx: 90, dy: firstDecline.frame.midY)).tap()
                    perfSettle(1.5)
                    let sheetOpen = app.webViews.buttons.count != buttonsBefore
                        || web(NSPredicate(format: "label IN %@", ["Close", "Done", "Cancel"])).count > 0
                    check("04", "row_opens_sheet", sheetOpen, "buttons_before=\(buttonsBefore) after=\(app.webViews.buttons.count)")
                    stop("04-consent--sheet", settle: 0.3)
                    if !tapFirst(NSPredicate(format: "label IN %@", ["Close", "Done", "Cancel"]), timeout: 1) {
                        let top = webView.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35))
                        top.press(forDuration: 0.05, thenDragTo: webView.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)))
                    }
                    perfSettle(1.5)
                    let rowsBefore = declines.count
                    let decline = app.webViews.buttons.matching(labelled("Don't allow")).firstMatch
                    if decline.exists {
                        tapElement(decline)
                        let undo = app.webViews.buttons.matching(labelled("Undo")).firstMatch
                        if undo.waitForExistence(timeout: 2) {
                            quickShot("04-undo-toast")
                            undo.tap()
                            check("04", "undo_toast", true)
                        } else {
                            check("04", "undo_toast", false, "reason=undo_not_found")
                        }
                        perfSettle(2.0)
                        let rowsAfter = app.webViews.buttons.matching(labelled("Don't allow")).count
                        check("04", "undo_restores_row", rowsAfter == rowsBefore, "before=\(rowsBefore) after=\(rowsAfter)")
                        stop("04-consent--after-undo", settle: 0.3)
                    }
                } else {
                    check("04", "pending_rows_present", false, "reason=no_pending_requests")
                }
            } else {
                check("04", "consent_center_opened", false)
            }
            mark("END", "04-consent-center")

            // 5. Feed: the "Needs you" group.
            mark("BEGIN", "05-feed-needs-you")
            perfTapNav(app, label: "Feed")
            stop("05-feed", settle: 2.5)
            let needsYou = web(NSPredicate(format: "label CONTAINS[c] %@", "Needs you")).firstMatch
            check("05", "needs_you_present", needsYou.exists)
            geometry("feed-needs-you", needsYou)
            let feedDecisions = app.webViews.buttons.matching(labelled("Allow"))
            for index in 0..<min(3, feedDecisions.count) {
                geometry("feed-allow-\(index)", feedDecisions.element(boundBy: index))
            }
            perfFlick(webView, fromY: 0.75, toY: 0.3)
            stop("05-feed--scrolled", settle: 1.2)
            perfFlick(webView, fromY: 0.3, toY: 0.8)
            perfSettle(1.0)
            mark("END", "05-feed-needs-you")

            // 6. Settings rows (one full-width surface each, ripple on tap),
            // and the same screens in the other theme.
            mark("BEGIN", "06-settings-rows")
            if openProfile() {
                stop("06-profile-pane")
                for row in ["Your account", "Appearance & preferences", "Security & privacy", "Trusted devices", "Help & feedback"] {
                    let slug = row.lowercased().replacingOccurrences(of: " & ", with: "-").replacingOccurrences(of: " ", with: "-")
                    guard let element = scrollTo(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", row, "\(row),"), maxFlicks: 3) else {
                        check("06", "row_\(slug)", false, "reason=not_found")
                        continue
                    }
                    let button = app.webViews.buttons.matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", row, "\(row),")).firstMatch
                    geometry("settings-row-\(slug)", button.exists ? button : element)
                    tapElement(button.exists ? button : element)
                    burst("06-ripple-\(slug)", count: 3)
                    stop("06-\(slug)")
                    check("06", "row_\(slug)", true)
                    if row == "Appearance & preferences" {
                        let options = ["Light", "Dark", "System"]
                        let selected = options.first { option in
                            let radio = app.webViews.radioButtons.matching(labelled(option)).firstMatch
                            return radio.exists && ((radio.value as? String) == "1" || radio.isSelected)
                        }
                        NSLog("JOURNEY_THEME original=\(selected ?? "unknown")")
                        let other = selected == "Light" ? "Dark" : "Light"
                        if tapFirst(labelled(other), timeout: 2) {
                            stop("06-appearance--\(other.lowercased())")
                            perfTapNav(app, label: "Feed")
                            stop("06-feed--\(other.lowercased())")
                            perfTapNav(app, label: "Chat")
                            stop("06-chat--\(other.lowercased())")
                            if openProfile(), tapFirst(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", row, "\(row),")) {
                                perfSettle(1.0)
                                _ = tapFirst(labelled(selected ?? "System"), timeout: 2)
                                perfSettle(1.0)
                                NSLog("JOURNEY_THEME restored=\(selected ?? "System")")
                            }
                        }
                    }
                    headerBack()
                    perfSettle(1.5)
                    if !perfLabelExists(app, "Your account") { _ = openProfile(); perfSettle(1.0) }
                }
            } else {
                check("06", "profile_opened", false)
            }
            mark("END", "06-settings-rows")

            // 7. Background and foreground keep the unlock (the key is
            // memory-only for the runtime); a relaunch must lock again.
            mark("BEGIN", "07-background-relock")
            perfTapNav(app, label: "Feed")
            stop("07-before-background")
            pauseCapture("home-screen")
            XCUIDevice.shared.press(.home)
            perfSettle(5.0)
            app.activate()
            _ = app.wait(for: .runningForeground, timeout: 10)
            perfSettle(2.0)
            mark("RESUME", "home-screen")
            let resumedUnlocked = perfLabelExists(app, "One") && web(gateField).count == 0
            check("07", "unlocked_after_resume", resumedUnlocked)
            stop("07-after-foreground", settle: 0.5)
            pauseCapture("relaunch")
            app.terminate()
            let relaunchStart = perfEpochMs()
            app.launch()
            XCTAssertTrue(webView.waitForExistence(timeout: 30), "WebView unavailable after relaunch")
            perfSettle(1.0)
            mark("RESUME", "relaunch")
            var relocked = false
            let relockDeadline = Date().addingTimeInterval(60)
            while Date() < relockDeadline {
                if web(gateField).count > 0 { relocked = true; break }
                if perfLabelExists(app, "One") { break }
                perfSettle(0.25)
            }
            metric("warm_relaunch_interactive_ms", perfEpochMs() - relaunchStart)
            check("07", "locked_after_relaunch", relocked)
            stop("07-relaunch--gate", settle: 0.3)
            try unlockOffCamera()
            check("07", "unlocked_after_relaunch", perfLabelExists(app, "One"))
            stop("07-relaunch--unlocked")
            mark("END", "07-background-relock")

            NSLog("PERF_DONE route=journeys")
            app.terminate()
        }

        if section == "routes" {
            let list = (environment["HUSHH_PERF_ROUTES"] ?? "")
                .split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
            if list.isEmpty {
                NSLog("PERF_SKIPPED name=routes reason=no_route_list")
            }
            for (index, route) in list.enumerated() {
                let app: XCUIApplication
                do {
                    (app, _) = try launchAttached(route: route, shellOptional: true, failHard: false, unlockTimeout: 90)
                } catch is PerfSignedOut {
                    // Every later launch would land on the same screen: stop
                    // here rather than record the whole list as unreachable.
                    NSLog("PERF_SWEEP_ABORTED reason=signed-out route=\(route) remaining=\(list.count - index)")
                    XCUIApplication().terminate()
                    XCTFail("The app is signed out, so no route can be measured. Restore the reviewer session with scripts/perf/ios-reviewer-signin.sh, then rerun.")
                    break
                } catch let unreachable as PerfRouteUnreachable {
                    NSLog("PERF_ROUTE_UNREACHABLE route=\(route) reason=\(unreachable.reason)")
                    XCUIApplication().terminate()
                    continue
                }
                NSLog("PERF_APP_READY route=\(route)")
                // The probe keys its idle bucket on the route it settled on,
                // so a redirect (locked vault, missing prerequisite) is
                // recorded under where it actually landed, not where we aimed.
                let settled = app.webViews.firstMatch.waitForExistence(timeout: 20)
                if !settled {
                    NSLog("PERF_ROUTE_UNREACHABLE route=\(route)")
                    app.terminate()
                    continue
                }
                Thread.sleep(forTimeInterval: 6)
                NSLog("PERF_DONE route=\(route)")
                app.terminate()
            }
        }

        // Connecting a bank through Plaid Link on the phone, step by step,
        // with a marker per screen for captures. It only proceeds past the
        // institution list when Link is plainly in sandbox (the test bank is
        // listed); against anything else it stops there and never types.
        if section == "plaid" {
            let (app, _) = try launchAttached(route: "/one/kai?tab=portfolio")
            perfSettle(5)
            NSLog("PERF_APP_READY route=/one/kai?tab=portfolio")
            func element(_ label: String, exact: Bool = true) -> XCUIElement {
                let format = exact ? "label == %@" : "label CONTAINS[c] %@"
                return app.webViews.descendants(matching: .any).matching(NSPredicate(format: format, label)).firstMatch
            }
            func tap(_ e: XCUIElement) { e.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
            func step(_ name: String, settle: TimeInterval = 1.5) {
                perfSettle(settle)
                NSLog("PERF_PLAID_STEP \(name)")
            }
            func labels(_ tag: String) {
                let texts = app.webViews.staticTexts.allElementsBoundByIndex.prefix(60).map { $0.label }.filter { !$0.isEmpty }
                NSLog("PERF_PLAID_LABELS \(tag) :: \(texts.joined(separator: " | "))")
            }
            step("kai-dashboard", settle: 1)
            let settings = element("Portfolio source settings")
            if settings.waitForExistence(timeout: 8) {
                tap(settings)
                step("source-settings")
                let add = element("Add a statement", exact: false)
                if add.waitForExistence(timeout: 5) { tap(add); step("import-view") }
            } else {
                NSLog("PERF_PLAID_NOTE no source settings control; expecting the import view directly")
            }
            let bank = element("Bank account (via Plaid)", exact: false)
            if bank.waitForExistence(timeout: 8) {
                tap(bank)
                step("link-opening", settle: 6)
                labels("link-first")
                let cont = app.webViews.buttons.matching(NSPredicate(format: "label ==[c] %@", "Continue")).firstMatch
                if cont.waitForExistence(timeout: 10) {
                    tap(cont)
                    step("link-institutions", settle: 3)
                    labels("institutions")
                    let sandboxBank = element("Platypus", exact: false)
                    if sandboxBank.waitForExistence(timeout: 4) {
                        tap(sandboxBank)
                        step("link-credentials", settle: 3)
                        let user = app.webViews.textFields.firstMatch
                        let pass = app.webViews.secureTextFields.firstMatch
                        if user.waitForExistence(timeout: 6), pass.exists {
                            tap(user); user.typeText("user_good")
                            tap(pass); pass.typeText("pass_good")
                            let submit = app.webViews.buttons.matching(NSPredicate(format: "label ==[c] %@ OR label ==[c] %@", "Submit", "Continue")).firstMatch
                            if submit.exists { tap(submit) }
                            step("link-accounts", settle: 6)
                            labels("accounts")
                            let next = app.webViews.buttons.matching(NSPredicate(format: "label ==[c] %@", "Continue")).firstMatch
                            if next.waitForExistence(timeout: 8) { tap(next); step("link-finish", settle: 6); labels("finish") }
                            let done = app.webViews.buttons.matching(NSPredicate(format: "label ==[c] %@ OR label ==[c] %@", "Continue", "Done")).firstMatch
                            if done.waitForExistence(timeout: 8) { tap(done) }
                            step("exchange", settle: 12)
                            labels("after-exchange")
                        } else {
                            NSLog("PERF_PLAID_NOTE credential fields not reachable")
                        }
                    } else {
                        NSLog("PERF_PLAID_STOP reason=not_sandbox")
                    }
                } else {
                    NSLog("PERF_PLAID_NOTE Link's first screen did not expose a Continue control")
                }
            } else {
                NSLog("PERF_SKIPPED name=plaid reason=bank_row_not_found")
                labels("import-missing")
            }
            perfSettle(4)
            NSLog("PERF_DONE route=/one/kai")
            app.terminate()
        }

        if section == "all" || section == "kai" {
            let (app, webView) = try launchAttached(route: "/one/kai")
            guard perfWaitForLabel(app, label: "Portfolio", timeout: 60) else {
                NSLog("PERF_SKIPPED name=kai reason=finance_not_reached")
                app.terminate()
                throw XCTSkip("Finance did not open")
            }
            perfSettle(2.5)
            NSLog("PERF_APP_READY route=/one/kai")
            for rep in 0..<repetitions {
                perfGesture("top-shell-pager-swipe", rep: rep) {
                    let left = webView.coordinate(withNormalizedOffset: CGVector(dx: 0.82, dy: 0.48))
                    let right = webView.coordinate(withNormalizedOffset: CGVector(dx: 0.18, dy: 0.48))
                    left.press(forDuration: 0.08, thenDragTo: right)
                    perfSettle(1.2)
                    right.press(forDuration: 0.08, thenDragTo: left)
                    perfSettle(1.2)
                }
            }
            for rep in 0..<repetitions {
                perfGesture("kai-chart-flick", rep: rep) {
                    for _ in 0..<3 {
                        perfFlick(webView, fromY: 0.7, toY: 0.3)
                        perfSettle(0.4)
                    }
                    perfSettle(1.5)
                }
            }
            perfSettle(12)
            NSLog("PERF_DONE route=/one/kai")
            app.terminate()
        }

        if section == "all" || section == "location" {
            let (app, webView) = try launchAttached(route: "/one/location")
            perfSettle(4)
            NSLog("PERF_APP_READY route=/one/location")
            for rep in 0..<repetitions {
                perfGesture("location-map-pan", rep: rep) {
                    for _ in 0..<3 {
                        let start = webView.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.4))
                        let end = webView.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.55))
                        start.press(forDuration: 0.05, thenDragTo: end)
                        perfSettle(0.6)
                    }
                    perfSettle(1.5)
                }
            }
            perfSettle(12)
            NSLog("PERF_DONE route=/one/location")
            app.terminate()
        }
    }

    /// Unlocks the vault with the passphrase method: reveal the field if Face ID
    /// is the default, type the passphrase, tap Unlock, wait for the signed-in
    /// bottom bar. With no passphrase configured (or a sign-in screen) it waits
    /// for the person holding the phone. The passphrase is never logged.
    /// Thrown instead of an XCTFail when a caller sweeping many routes wants
    /// to record one unreachable route and carry on.
    struct PerfRouteUnreachable: Error { let reason: String }

    /// Thrown to a sweeping caller when the launch sits on the sign-in
    /// screen: the Release truth lane has no automated sign-in (test mode is
    /// Debug-only by design), so nothing after it can be measured either.
    struct PerfSignedOut: Error {}

    /// `shellOptional`: the bottom bar's "One" tab is the usual sign that the
    /// app is signed in and unlocked, but a route that hides the shell (an
    /// import flow, a full-screen setup step) never shows it, and waiting for
    /// it there only burns the timeout. With this set, a submitted passphrase
    /// whose field has stayed gone for four seconds, with no mismatch banner,
    /// also counts, which is the signal the Android lane uses for the same
    /// reason. `failHard: false` throws PerfRouteUnreachable instead of
    /// failing the whole test.
    private func perfUnlockVault(
        _ app: XCUIApplication,
        passphrase: String,
        timeout: TimeInterval,
        shellOptional: Bool = false,
        failHard: Bool = true
    ) throws {
        // The clock starts when the passphrase field is on screen: a cold
        // launch can spend two minutes behind the system passkey sheet first.
        var deadline = Date().addingTimeInterval(timeout)
        var fieldSeen = false
        var attempts = 0
        var announced = false
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        var fieldGoneSince: Date?
        var signInScreenSince: Date?
        while Date() < deadline {
            if perfLabelExists(app, "One") {
                return
            }
            if !failHard {
                let signIn = app.webViews.buttons.matching(NSPredicate(
                    format: "label CONTAINS[c] %@ OR label CONTAINS[c] %@", "Continue with Apple", "Continue with Google"
                )).firstMatch
                if signIn.exists {
                    let since = signInScreenSince ?? Date()
                    signInScreenSince = since
                    if Date().timeIntervalSince(since) >= 5 {
                        NSLog("PERF_UNLOCK signed_out=true")
                        throw PerfSignedOut()
                    }
                } else {
                    signInScreenSince = nil
                }
            }
            if shellOptional && attempts > 0 {
                let gateField = app.webViews.secureTextFields.matching(NSPredicate(format: "label == %@ OR placeholderValue == %@", "Vault passphrase", "Enter passphrase")).firstMatch
                let rejected = app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "did not match")).firstMatch.exists
                if !gateField.exists && !rejected {
                    if let since = fieldGoneSince {
                        if Date().timeIntervalSince(since) >= 4 {
                            NSLog("PERF_UNLOCK ready=field-gone")
                            return
                        }
                    } else {
                        fieldGoneSince = Date()
                    }
                } else {
                    fieldGoneSince = nil
                }
            }
            // The vault gate opens the passkey flow at launch; with no passkey
            // on this phone iOS shows its "Scan QR Code" sheet over the app and
            // every tap below lands on it. Close it (X) and use the passphrase.
            let passkeySheet = springboard.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "Scan QR Code")).firstMatch
            if passkeySheet.exists {
                let close = springboard.buttons.matching(NSPredicate(format: "label IN %@", ["Close", "Cancel"])).firstMatch
                if close.exists {
                    close.tap()
                    NSLog("PERF_UNLOCK dismissed=passkey-sheet")
                    perfSettle(0.8)
                    continue
                }
            }
            let field = app.webViews.secureTextFields.matching(NSPredicate(format: "label == %@ OR placeholderValue == %@", "Vault passphrase", "Enter passphrase")).firstMatch
            if !field.exists && attempts == 0 && !passphrase.isEmpty {
                let reveal = app.webViews.buttons.matching(NSPredicate(format: "label == %@", "Passphrase")).firstMatch
                if reveal.exists {
                    reveal.tap()
                    perfSettle(0.8)
                    continue
                }
            }
            let mismatch = app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "did not match")).firstMatch.exists
            // Type once, and again after a mismatch (a partial typeText was
            // observed when the sheet above stole focus mid-string), up to 3 times.
            if field.exists && !passphrase.isEmpty && (attempts == 0 || (mismatch && attempts < 3)) {
                if !fieldSeen {
                    fieldSeen = true
                    deadline = Date().addingTimeInterval(timeout)
                }
                NSLog("PERF_UNLOCK method=passphrase attempt=\(attempts + 1)")
                field.tap()
                perfSettle(0.4)
                if perfGateStop && attempts == 0 {
                    // Empty field, keyboard up: what a person sees first.
                    perfSettle(1.2)
                    NSLog("PERF_STOP name=gate-keyboard")
                    perfSettle(2.5)
                }
                if attempts > 0 {
                    field.press(forDuration: 1.0)
                    let selectAll = app.menuItems.matching(NSPredicate(format: "label == %@", "Select All")).firstMatch
                    if selectAll.waitForExistence(timeout: 1.5) {
                        selectAll.tap()
                        perfSettle(0.2)
                    }
                    field.typeText(XCUIKeyboardKey.delete.rawValue)
                    perfSettle(0.2)
                }
                field.typeText(passphrase)
                perfSettle(0.3)
                // A secure field reports one mask character per typed character.
                let typedCount = (field.value as? String)?.count ?? -1
                if typedCount != passphrase.count {
                    NSLog("PERF_UNLOCK typed_mismatch expected=\(passphrase.count) got=\(typedCount)")
                }
                let unlock = app.webViews.buttons.matching(NSPredicate(format: "label == %@", "Unlock")).firstMatch
                if unlock.exists && unlock.isHittable {
                    unlock.tap()
                } else {
                    field.typeText("\n")
                }
                attempts += 1
                perfSettle(2)
                continue
            }
            if !announced {
                NSLog("PERF_WAITING_FOR_HUMAN step=sign-in-and-unlock timeout_s=\(Int(timeout))")
                announced = true
            }
            perfSettle(1.0)
        }
        if !failHard {
            throw PerfRouteUnreachable(reason: "not signed in and unlocked within \(Int(timeout)) s")
        }
        XCTFail("The app was not signed in and unlocked within \(Int(timeout)) s.")
        throw XCTSkip("unlock timeout")
    }

    private func perfLabelExists(_ app: XCUIApplication, _ label: String) -> Bool {
        app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).count > 0
    }

    /// Waits for any web element with the exact accessibility label.
    private func perfWaitForLabel(_ app: XCUIApplication, label: String, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let matches = app.webViews.descendants(matching: .any)
                .matching(NSPredicate(format: "label == %@", label))
            if matches.count > 0 {
                return true
            }
            perfSettle(1.0)
        }
        return false
    }

    // MARK: - Third-party scroll benchmark (Threads, X)

    /// Apple's own scroll-hitch number for the apps the founder holds up as the
    /// bar, on the same phone, with the same flick. Instruments cannot attach to
    /// an App Store binary, but XCUITest can drive one, and
    /// XCTOSSignpostMetric.scrollDecelerationMetric measures the UIScrollView
    /// deceleration hitches those native feeds produce. Our own feed is a DOM
    /// scroller without a UIScrollView, so it is measured by the in-app probe
    /// instead; the unit (hitch ms per second) is the same.
    ///
    /// Opt-in only: HUSHH_ENABLE_THIRD_PARTY_SCROLL_BENCHMARK=true. Records
    /// timings only; nothing from either app's content is read or stored.
    /// XCTest records one set of metrics per test method, so each app gets
    /// its own method around one shared helper.
    func testThirdPartyFeedScrollBenchmarkThreads() throws {
        try thirdPartyFeedScrollBenchmark(name: "threads", bundleId: "com.burbn.barcelona")
    }

    func testThirdPartyFeedScrollBenchmarkX() throws {
        try thirdPartyFeedScrollBenchmark(name: "x", bundleId: "com.atebits.Tweetie2")
    }

    private func thirdPartyFeedScrollBenchmark(name: String, bundleId: String) throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["HUSHH_ENABLE_THIRD_PARTY_SCROLL_BENCHMARK"] == "true" else {
            throw XCTSkip("Third-party scroll benchmark runs only with HUSHH_ENABLE_THIRD_PARTY_SCROLL_BENCHMARK=true.")
        }
        let app = XCUIApplication(bundleIdentifier: bundleId)
        app.launch()
        guard app.wait(for: .runningForeground, timeout: 30) else {
            NSLog("PERF_SKIPPED name=\(name)-feed-flick reason=did_not_launch")
            throw XCTSkip("\(name) is not installed or did not launch.")
        }
        perfSettle(5)
        NSLog("PERF_APP_READY app=\(name)")
        let options = XCTMeasureOptions()
        options.iterationCount = 3
        let start = perfEpochMs()
        measure(metrics: [XCTOSSignpostMetric.scrollDecelerationMetric, XCTCPUMetric(application: app)], options: options) {
            for _ in 0..<5 {
                perfFlick(app, fromY: 0.75, toY: 0.25)
                perfSettle(0.6)
            }
            perfSettle(1.2)
        }
        NSLog("PERF_GESTURE name=\(name)-feed-flick rep=0 start_epoch_ms=\(start) end_epoch_ms=\(perfEpochMs())")
        app.terminate()
    }

    // The same non-scroll gestures our card measures on its own shell, on the
    // reference app, so the comparison is not only a feed flick (founder ask,
    // 2026-09-20). Each gets its own method because XCTest keeps one metric
    // set per method. Tab switches in a UIKit tab bar are not animated, so
    // there is no hitch signpost for them: the clock metric records how long
    // the round of switches takes and the CPU metric what it cost. The pager
    // is a paging UIScrollView (dragging + deceleration signposts) and a post
    // open/close is a navigation push/pop (navigation transition signpost).
    func testThirdPartyBottomNavBenchmarkThreads() throws {
        try thirdPartyGestureBenchmark(name: "threads", bundleId: "com.burbn.barcelona", gesture: "bottom-nav-switch")
    }

    func testThirdPartyPagerSwipeBenchmarkThreads() throws {
        try thirdPartyGestureBenchmark(name: "threads", bundleId: "com.burbn.barcelona", gesture: "top-shell-pager-swipe")
    }

    func testThirdPartyOpenDismissBenchmarkThreads() throws {
        try thirdPartyGestureBenchmark(name: "threads", bundleId: "com.burbn.barcelona", gesture: "open-dismiss")
    }

    private func thirdPartyGestureBenchmark(name: String, bundleId: String, gesture: String) throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["HUSHH_ENABLE_THIRD_PARTY_SCROLL_BENCHMARK"] == "true" else {
            throw XCTSkip("Third-party benchmarks run only with HUSHH_ENABLE_THIRD_PARTY_SCROLL_BENCHMARK=true.")
        }
        let app = XCUIApplication(bundleIdentifier: bundleId)
        app.launch()
        guard app.wait(for: .runningForeground, timeout: 30) else {
            NSLog("PERF_SKIPPED name=\(name)-\(gesture) reason=did_not_launch")
            throw XCTSkip("\(name) is not installed or did not launch.")
        }
        perfSettle(5)
        NSLog("PERF_APP_READY app=\(name)")
        let options = XCTMeasureOptions()
        options.iterationCount = 3
        let start = perfEpochMs()
        switch gesture {
        case "bottom-nav-switch":
            let tabs = thirdPartyBottomTabs(app)
            guard tabs.count >= 2 else {
                NSLog("PERF_SKIPPED name=\(name)-\(gesture) reason=tab_bar_not_found tabs=\(tabs.count)")
                app.terminate()
                throw XCTSkip("no tab bar found in \(name)")
            }
            NSLog("PERF_NAV app=\(name) tabs=\(tabs.map { $0.label }.joined(separator: ","))")
            let home = tabs[0]
            let others = Array(tabs.dropFirst().prefix(4))
            measure(metrics: [XCTClockMetric(), XCTCPUMetric(application: app)], options: options) {
                for tab in others {
                    tab.tap()
                    perfSettle(0.7)
                    home.tap()
                    perfSettle(0.7)
                }
            }
            home.tap()
        case "top-shell-pager-swipe":
            measure(metrics: [XCTOSSignpostMetric.scrollDraggingMetric, XCTOSSignpostMetric.scrollDecelerationMetric, XCTCPUMetric(application: app)], options: options) {
                perfHorizontalSwipe(app, fromX: 0.85, toX: 0.15, y: 0.4)
                perfSettle(0.9)
                perfHorizontalSwipe(app, fromX: 0.15, toX: 0.85, y: 0.4)
                perfSettle(0.9)
            }
        default:
            measure(metrics: [XCTOSSignpostMetric.navigationTransitionMetric, XCTCPUMetric(application: app)], options: options) {
                for _ in 0..<3 {
                    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45)).tap()
                    perfSettle(1.2)
                    // The leading-edge back swipe is the dismiss every iOS app shares.
                    perfHorizontalSwipe(app, fromX: 0.02, toX: 0.9, y: 0.5)
                    perfSettle(0.9)
                }
            }
        }
        NSLog("PERF_GESTURE name=\(name)-\(gesture) rep=0 start_epoch_ms=\(start) end_epoch_ms=\(perfEpochMs())")
        app.terminate()
    }

    /// The reference app's bottom bar: a UIKit tab bar when it has one, else
    /// the hittable buttons in the bottom 12% of the screen, left to right,
    /// without the compose/create control (it opens an editor).
    private func thirdPartyBottomTabs(_ app: XCUIApplication) -> [XCUIElement] {
        let screen = app.frame
        let bottomBand = screen.height * 0.88
        let skip = NSPredicate(format: "NOT (label CONTAINS[c] 'create' OR label CONTAINS[c] 'compose' OR label CONTAINS[c] 'new thread' OR label CONTAINS[c] 'new post' OR label CONTAINS[c] 'write')")
        var candidates = app.tabBars.buttons.matching(skip).allElementsBoundByIndex
        if candidates.count < 2 {
            candidates = app.buttons.matching(skip).allElementsBoundByIndex.filter { element in
                let frame = element.frame
                return frame.minY >= bottomBand && frame.height < screen.height * 0.12 && element.isHittable
            }
        }
        return candidates.sorted { $0.frame.minX < $1.frame.minX }
    }

    private func perfHorizontalSwipe(_ app: XCUIApplication, fromX: CGFloat, toX: CGFloat, y: CGFloat) {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: fromX, dy: y))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: toX, dy: y))
        start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .fast, thenHoldForDuration: 0.0)
    }

    private func perfEpochMs() -> Int64 {
        Int64((Date().timeIntervalSince1970 * 1000).rounded())
    }

    private func perfSettle(_ seconds: TimeInterval) {
        RunLoop.current.run(until: Date().addingTimeInterval(seconds))
    }

    private func perfGesture(_ name: String, rep: Int, _ body: () -> Void) {
        let start = perfEpochMs()
        body()
        let end = perfEpochMs()
        NSLog("PERF_GESTURE name=\(name) rep=\(rep) start_epoch_ms=\(start) end_epoch_ms=\(end)")
    }

    /// One thumb sweep at a fixed speed, in the WebView's normalised space.
    private func perfFlick(_ webView: XCUIElement, fromY: CGFloat, toY: CGFloat) {
        let start = webView.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: fromY))
        let end = webView.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: toY))
        start.press(forDuration: 0.04, thenDragTo: end, withVelocity: XCUIGestureVelocity(rawValue: 2000), thenHoldForDuration: 0)
    }

    private func perfTapNav(_ app: XCUIApplication, label: String) {
        let nativeTab = app.descendants(matching: .any)
            .matching(identifier: "one-native-navigation").firstMatch.buttons[label]
        if nativeTab.exists && nativeTab.isHittable {
            nativeTab.tap()
            return
        }
        let candidates = app.webViews.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", label))
        let count = candidates.count
        guard count > 0 else {
            NSLog("PERF_SKIPPED name=nav-tap reason=label_not_found label=\(label)")
            return
        }
        // The bottom bar is the lowest match on screen. "Last in the tree"
        // picked the header's One/Puppy toggle on Chat, where "One" is also
        // the title, so a walk that tapped the One tab stayed on Chat.
        var element = candidates.element(boundBy: count - 1)
        var lowest = -CGFloat.greatestFiniteMagnitude
        for index in 0..<count {
            let candidate = candidates.element(boundBy: index)
            let frame = candidate.frame
            if !frame.isEmpty && frame.midY > lowest {
                lowest = frame.midY
                element = candidate
            }
        }
        if element.isHittable {
            element.tap()
        } else {
            element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        }
    }

    private func returnToRehearsalChat(_ app: XCUIApplication) {
        // A roster entry can legitimately open unfinished capability setup,
        // where the dock is absent. Use the authored Back, not a cold route or
        // a test bootstrap, before returning through the normal Chat tab.
        for _ in 0..<3 {
            let chat = app.buttons["one-native-tab-chat"].firstMatch
            let webChat = app.webViews.buttons["Chat"].firstMatch
            if chat.exists && chat.isHittable || webChat.exists && webChat.isHittable {
                perfTapNav(app, label: "Chat")
                return
            }
            let back = app.buttons.matching(NSPredicate(format: "identifier == %@ OR label == %@", "top-shell-back", "Go back")).firstMatch
            guard back.exists && back.isHittable else { return }
            back.tap()
        }
    }

    /// Types a fixed prompt into the chat composer and sends it. Best effort:
    /// returns false when the composer cannot be found, so the card records a
    /// skip instead of failing.
    /// The composer lives on the canonical Chat route ("/"), not on /one:
    /// `<textarea aria-label="Message One">` with a `Send message` button.
    /// The caller puts the app on that route first.
    /// The chat exchange as a person does it, with the native keyboard in
    /// the loop (founder ask, 2026-09-21): tap the composer and let the
    /// keyboard rise, type the prompt through it, send, let the reply
    /// stream, then dismiss the keyboard. Each step is its own gesture so
    /// the frames the keyboard's rise, the typing and its dismissal cost are
    /// read apart from the reply itself.
    private func perfChatExchange(_ app: XCUIApplication, streamSeconds: TimeInterval) -> Bool {
        let composer = app.webViews.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", "Message One")).firstMatch
        guard composer.waitForExistence(timeout: 20) else { return false }

        var keyboardShown = false
        perfGesture("chat-keyboard-show", rep: 0) {
            composer.tap()
            // No accessibility polling while the keyboard rises (a WebView
            // snapshot blocks the page's main thread); one check after the
            // rise has settled.
            perfSettle(1.2)
            keyboardShown = app.keyboards.firstMatch.exists
            NSLog("PERF_KEYBOARD shown=\(keyboardShown ? 1 : 0)")
        }

        // Settled geometry, read outside the measured window: an accessibility
        // snapshot of the WebView runs on the app's main thread and would show
        // up as a long frame of its own. The composer belongs just above the
        // keyboard's edge; the gap is the number the summary carries.
        if keyboardShown {
            let window = app.windows.firstMatch.frame
            let keyRowsTop = app.keyboards.firstMatch.frame.minY
            // The QuickType strip sits above the key rows and outside the
            // keyboard element's frame; the keyboard's visible edge is the
            // strip's top when the strip is there.
            var keyboardTop = keyRowsTop
            let predictions = app.descendants(matching: .any)
                .matching(NSPredicate(format: "label CONTAINS[c] %@ OR identifier CONTAINS[c] %@", "predict", "predict")).firstMatch
            if predictions.exists {
                keyboardTop = min(keyboardTop, predictions.frame.minY)
            }
            let composerBottom = composer.frame.maxY
            NSLog("PERF_KEYBOARD_GEOMETRY window_h=\(Int(window.height)) keyboard_top=\(Int(keyboardTop)) key_rows_top=\(Int(keyRowsTop)) composer_bottom=\(Int(composerBottom)) gap=\(Int(keyboardTop - composerBottom))")
        }

        perfGesture("chat-keyboard-type", rep: 0) {
            composer.typeText("Summarize my week in three short bullet points.")
            perfSettle(0.8)
        }

        perfGesture("chat-stream-30s", rep: 0) {
            let send = app.webViews.buttons.matching(NSPredicate(format: "label == %@", "Send message")).firstMatch
            if send.exists {
                // A finger lands on the button's centre; XCTest's own hit
                // test can return no point for a lifted composer while the
                // button is plainly on screen, so the tap goes by coordinate.
                send.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            } else {
                composer.typeText("\n")
            }
            perfSettle(streamSeconds)
        }

        perfGesture("chat-keyboard-dismiss", rep: 0) {
            // A tap on the transcript, above the composer, is how a person
            // puts the keyboard away here; fall back to the keyboard's own
            // dismiss control when the tap does not take it down.
            let keyboard = app.keyboards.firstMatch
            if keyboard.exists {
                app.webViews.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).tap()
                perfSettle(0.8)
                if keyboard.exists {
                    let dismiss = app.keyboards.buttons.matching(NSPredicate(format: "label IN %@", ["Hide keyboard", "Dismiss", "Done"])).firstMatch
                    if dismiss.exists { dismiss.tap() }
                }
            }
            perfSettle(1.2)
            NSLog("PERF_KEYBOARD dismissed=\(app.keyboards.firstMatch.exists ? 0 : 1)")
        }

        // A second rise in the same session: the system keyboard's first
        // presentation has a cost of its own, and only a repeat separates
        // that from what the page does when the keyboard comes up.
        perfGesture("chat-keyboard-show-2", rep: 0) {
            composer.tap()
            perfSettle(1.2)
            NSLog("PERF_KEYBOARD shown_again=\(app.keyboards.firstMatch.exists ? 1 : 0)")
        }
        perfGesture("chat-keyboard-dismiss-2", rep: 0) {
            if app.keyboards.firstMatch.exists {
                app.webViews.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).tap()
            }
            perfSettle(1.2)
        }

        // The transcript ride: a flick up hides the bottom chrome and the
        // composer rides down with it, a flick down brings both back. The
        // probe reads the two bars' transforms per frame during these.
        let webView = app.webViews.firstMatch
        for rep in 0..<2 {
            perfGesture("chat-transcript-flick", rep: rep) {
                perfFlick(webView, fromY: 0.55, toY: 0.25)
                perfSettle(0.9)
                perfFlick(webView, fromY: 0.25, toY: 0.55)
                perfSettle(0.9)
            }
        }
        return true
    }

    private func launchApp(_ route: RouteCase, extraArguments: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-UITestMode",
            "-UITestInitialRoute", route.initialRoute,
            "-UITestExpectedMarker", route.expectedMarker,
            "-UITestAutoReviewerLogin", route.autoReviewerLogin ? "true" : "false",
            "-UITestResetAppState", "false",
        ] + extraArguments
        if let expectedRoute = route.expectedRoute {
            app.launchArguments += ["-UITestExpectedRoute", expectedRoute]
        }
        let environment = ProcessInfo.processInfo.environment
        if let reviewerUid = environment["HUSHH_UI_TEST_REVIEWER_UID"] ?? environment["REVIEWER_UID"],
           !reviewerUid.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            app.launchArguments += ["-UITestExpectedUserId", reviewerUid]
        }
        if let vaultPassphrase = environment["HUSHH_UI_TEST_REVIEWER_VAULT_PASSPHRASE"] ?? environment["REVIEWER_VAULT_PASSPHRASE"],
           !vaultPassphrase.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            app.launchArguments += ["-UITestVaultPassphrase", vaultPassphrase]
        }
        app.launch()
        return app
    }

    private func waitForSatisfiedStatus(
        _ app: XCUIApplication,
        route: RouteCase,
        timeout: TimeInterval
    ) throws -> [String: String] {
        let statusQuery = app.buttons.matching(identifier: "native-test-status")
        let appearDeadline = Date().addingTimeInterval(20)
        while Date() < appearDeadline {
            _ = dismissKnownModals(app: app)
            if statusQuery.count > 0 {
                break
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        XCTAssertGreaterThan(statusQuery.count, 0, "native-test-status never appeared for \(route.name)")
        let statusElement = statusQuery.element(boundBy: 0)

        let deadline = Date().addingTimeInterval(timeout)
        var lastStatus = ""
        var lastUnlockAttemptAt = Date.distantPast

        while Date() < deadline {
            if Date().timeIntervalSince(lastUnlockAttemptAt) >= 3 {
                _ = dismissKnownModals(app: app)
                // Anonymous route checks must not read reviewer credentials or
                // attempt a Vault unlock, even if an unexpected gate appears.
                if route.autoReviewerLogin {
                    _ = attemptVaultPassphraseUnlock(app: app)
                }
                lastUnlockAttemptAt = Date()
            }

            let current = ((statusElement.value as? String) ?? statusElement.label)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !current.isEmpty {
                lastStatus = current
                let parsed = parseStatus(current)
                let ready = parsed["ready"] == "1"
                let authMatches = parsed["auth"] == route.expectedAuth
                let markerMatches = parsed["marker"] == route.expectedMarker
                let routeMatches: Bool
                let observedRoute = normalizeRoute(parsed["route"] ?? "")
                if let expectedRoute = route.expectedRoute {
                    routeMatches = observedRoute == normalizeRoute(expectedRoute)
                } else if let expectedPrefix = route.expectedRoutePrefix {
                    routeMatches = observedRoute.hasPrefix(normalizeRoute(expectedPrefix))
                } else {
                    routeMatches = true
                }
                let dataMatches = route.allowedDataStates.contains(parsed["data"] ?? "")
                if ready && authMatches && markerMatches && routeMatches && dataMatches {
                    return parsed
                }
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.35))
        }

        XCTFail(
            "Route \(route.name) never satisfied native status checks. "
                + statusSummaryForLog(parseStatus(lastStatus))
        )
        return parseStatus(lastStatus)
    }

    private func waitForNativeRoute(
        _ app: XCUIApplication,
        route: String,
        timeout: TimeInterval
    ) -> Bool {
        let status = app.buttons.matching(identifier: "native-test-status").element(boundBy: 0)
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let raw = ((status.value as? String) ?? status.label)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if normalizeRoute(parseStatus(raw)["route"] ?? "") == normalizeRoute(route) {
                return true
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        }
        return false
    }

    private func parseStatus(_ raw: String) -> [String: String] {
        var result: [String: String] = [:]
        for segment in raw.split(separator: ";") {
            let pair = segment.split(separator: "=", maxSplits: 1).map(String.init)
            if pair.count == 2 {
                result[pair[0]] = pair[1]
            }
        }
        return result
    }

    private func normalizeRoute(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != "/" else { return trimmed.isEmpty ? "/" : trimmed }
        guard var components = URLComponents(string: "https://native-test.local\(trimmed)") else {
            return trimmed.hasSuffix("/") ? String(trimmed.dropLast()) : trimmed
        }
        if components.path.count > 1 && components.path.hasSuffix("/") {
            components.path = String(components.path.dropLast())
        }
        return "\(components.path)\(components.percentEncodedQuery.map { "?\($0)" } ?? "")"
    }
}
