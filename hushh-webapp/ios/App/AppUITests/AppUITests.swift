import Foundation
import XCTest

final class AppUITests: XCTestCase {
    private var vaultUnlockSubmitted = false
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
        app.activate()
        _ = try waitForSatisfiedStatus(app, route: route, timeout: 30)
        // The route marker can survive while the native privacy cover and
        // asynchronous auth restoration are still settling after activation.
        // Require the actual login control to become usable within a bound.
        let loginButton = app.buttons["Continue with Apple"]
        let resumeDeadline = Date().addingTimeInterval(15)
        while Date() < resumeDeadline, !(loginButton.exists && loginButton.isHittable) {
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        XCTAssertTrue(
            loginButton.exists && loginButton.isHittable,
            "Login must become usable after the native privacy cover releases"
        )
        let privacyCover = app.staticTexts["Protecting private information\u{2026}"]
        let coverDeadline = Date().addingTimeInterval(5)
        while Date() < coverDeadline, privacyCover.exists {
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        XCTAssertFalse(privacyCover.exists, "Privacy cover must release after login becomes usable")
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
                name: "kai-alpaca-return",
                redirect: "/kai/alpaca/oauth/return",
                marker: "native-route-kai-alpaca-return",
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

        let passphrase = reviewerVaultPassphrase()
        let vaultKeyField = app.secureTextFields["Enter vault key"]
        let passphraseField = app.secureTextFields["Enter your passphrase"]
        let hasPassphraseField =
            vaultKeyField.waitForExistence(timeout: 0.25)
            || passphraseField.waitForExistence(timeout: 0.25)
            || app.secureTextFields.count > 0
        guard hasPassphraseField else {
            return false
        }

        for methodButton in [app.buttons["Vault Key"], app.buttons["Use passphrase instead"]] {
            if methodButton.waitForExistence(timeout: 0.25), methodButton.isHittable {
                methodButton.tap()
                break
            }
        }

        let unlockButtons = [app.buttons["Unlock"], app.buttons["Unlock with passphrase"]]
        let fieldQueries: [XCUIElementQuery] = [
            app.secureTextFields,
            app.textFields,
            app.webViews.secureTextFields,
            app.webViews.textFields,
        ]

        for query in fieldQueries {
            let count = query.count
            guard count > 0 else { continue }
            for index in 0..<count {
                let field = query.element(boundBy: index)
                guard field.exists, field.isHittable else { continue }
                let label = field.label.lowercased()
                let placeholder = (field.placeholderValue ?? "").lowercased()
                let identifier = field.identifier.lowercased()
                let looksLikePassphrase =
                    label.contains("passphrase") ||
                    label.contains("vault key") ||
                    placeholder.contains("passphrase") ||
                    placeholder.contains("vault key") ||
                    identifier.contains("vault-key") ||
                    identifier.contains("unlock-passphrase")
                guard looksLikePassphrase || count == 1 else { continue }
                replaceText(in: field, with: passphrase)
                for unlockButton in unlockButtons {
                    if unlockButton.waitForExistence(timeout: 2), unlockButton.isHittable {
                        vaultUnlockSubmitted = true
                        unlockButton.tap()
                        return true
                    }
                }
            }
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

        perfGesture("chat-stream-30s", rep: 0) {
            if perfSendChatPrompt(app, webView: webView) {
                perfSettle(30)
            } else {
                NSLog("PERF_SKIPPED name=chat-stream-30s reason=composer_not_found")
            }
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

    /// The truth lane: the same gesture card with test mode off. The app is
    /// launched with only the probe argument, so there is no reviewer bridge
    /// and no native status poll; the person holding the phone signs in and
    /// unlocks, then opens Finance when asked. On a Release build this is the
    /// certifying run the charter names. Opt-in: HUSHH_ENABLE_PERF_ATTACHED=true.
    func testRenderPerformanceCardAttached() throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["HUSHH_ENABLE_PERF_ATTACHED"] == "true" else {
            throw XCTSkip("Attached render performance card runs only with HUSHH_ENABLE_PERF_ATTACHED=true.")
        }
        let repetitions = max(1, Int(environment["HUSHH_PERF_REPS"] ?? "") ?? 3)
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

        let app = XCUIApplication()
        app.launchArguments = ["-CapacitorStorage.hushh_perf_probe", "1"]
        app.launch()
        let webView = app.webViews.firstMatch
        XCTAssertTrue(webView.waitForExistence(timeout: 30), "WebView unavailable")
        NSLog("PERF_WAITING_FOR_HUMAN step=sign-in-and-unlock timeout_s=240")
        guard perfWaitForLabel(app, label: "One", timeout: 240) else {
            XCTFail("The app was not signed in and unlocked within 240 s.")
            return
        }
        perfSettle(2)
        perfTapNav(app, label: "Feed")
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

        // Finance is not on the signed-in bottom bar; the person opens it.
        NSLog("PERF_WAITING_FOR_HUMAN step=open-finance timeout_s=120")
        if perfWaitForLabel(app, label: "Portfolio", timeout: 120) {
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
        } else {
            NSLog("PERF_SKIPPED name=kai reason=finance_not_opened")
        }
        // The session belongs to the person holding the phone; leave it running.
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
        let candidates = app.webViews.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", label))
        let count = candidates.count
        guard count > 0 else {
            NSLog("PERF_SKIPPED name=nav-tap reason=label_not_found label=\(label)")
            return
        }
        // The bottom bar is the last match on screen.
        let element = candidates.element(boundBy: count - 1)
        if element.isHittable {
            element.tap()
        } else {
            element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        }
    }

    /// Types a fixed prompt into the chat composer and sends it. Best effort:
    /// returns false when the composer cannot be found, so the card records a
    /// skip instead of failing.
    private func perfSendChatPrompt(_ app: XCUIApplication, webView: XCUIElement) -> Bool {
        let queries: [XCUIElementQuery] = [app.webViews.textViews, app.webViews.textFields, app.textViews]
        for query in queries {
            let count = query.count
            guard count > 0 else { continue }
            let field = query.element(boundBy: count - 1)
            guard field.exists, field.isHittable else { continue }
            field.tap()
            perfSettle(0.5)
            field.typeText("Summarize my week in three short bullet points.")
            perfSettle(0.5)
            let send = app.webViews.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'send'")).firstMatch
            if send.exists, send.isHittable {
                send.tap()
            } else {
                field.typeText("\n")
            }
            return true
        }
        return false
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
