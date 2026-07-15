import Foundation
import XCTest

final class AppUITests: XCTestCase {
    private enum VaultBootstrapAction {
        case none
        case progressed
        case relaunch
    }

    private var vaultCreationSubmitted = false
    private var vaultCreationRelaunched = false
    private var vaultUnlockSubmitted = false

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
        vaultCreationSubmitted = false
        vaultCreationRelaunched = false
        vaultUnlockSubmitted = false
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
            reviewerRoute(name: "consents", redirect: "/consents", marker: "native-route-consents"),
            reviewerRoute(
                name: "agent",
                redirect: "/agent",
                marker: "native-route-agent",
                allowedDataStates: ["loaded", "empty-valid", "unavailable-valid"]
            ),
            reviewerRoute(name: "one-kyc", redirect: "/one/kyc", marker: "native-route-one-kyc"),
            reviewerRoute(
                name: "one-location",
                redirect: "/one/location",
                marker: "native-route-one-location",
                allowedDataStates: ["loaded", "empty-valid", "unavailable-valid"]
            ),
            reviewerRoute(name: "profile", redirect: "/profile", marker: "native-route-profile"),
            RouteCase(
                name: "profile-pkm",
                initialRoute: "/login?redirect=%2Fprofile%2Fpkm",
                expectedMarker: "native-route-profile",
                expectedRoute: "/profile?panel=my-data",
                expectedRoutePrefix: nil,
                autoReviewerLogin: true,
                expectedAuth: "authenticated",
                allowedDataStates: ["loaded", "redirect-valid"]
            ),
            reviewerRoute(
                name: "profile-receipts",
                redirect: "/profile/receipts",
                marker: "native-route-profile-receipts",
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
                expectedRoutePrefix: "/consents",
                autoReviewerLogin: true,
                expectedAuth: "authenticated",
                allowedDataStates: ["loaded"]
            ),
            RouteCase(
                name: "ria-settings",
                initialRoute: "/login?redirect=%2Fria%2Fsettings",
                expectedMarker: "native-route-profile",
                expectedRoute: "/profile",
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
                expectedRoute: "/consents?tab=pending",
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
                redirect: "/profile/gmail/oauth/return",
                marker: "native-route-profile-gmail-return",
                allowedDataStates: ["unavailable-valid", "redirect-valid"]
            ),
        ])
    }

    func testReviewerUiInteractionFlows() throws {
        assertReviewerPassphraseAliasesMatch()
        let app = launchUiInteractionAuditApp()
        let status = try waitForUiFlowsComplete(app, timeout: uiInteractionFlowTimeout())
        XCTAssertEqual(status["bootstrap"], "vault_unlocked", "Native reviewer vault bootstrap did not complete")
        XCTAssertEqual(status["ui_complete"], "1", "UI interaction flows did not complete. Last status: \(status)")
        XCTAssertEqual(status["ui_ok"], "1", "UI interaction flows failed. Last status: \(status)")
        app.terminate()
    }

    func testPhysicalMicrophoneCaptureSmoke() throws {
        let app = XCUIApplication()
        app.terminate()
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
        app.terminate()
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

    private func attemptFreshVaultBootstrap(app: XCUIApplication) -> VaultBootstrapAction {
        guard !vaultCreationRelaunched else {
            return .none
        }

        let continueButton = app.buttons["Continue to Vault Setup"]
        if continueButton.exists, continueButton.isHittable {
            continueButton.tap()
            return .progressed
        }

        if !vaultCreationSubmitted {
            let passphraseField = app.secureTextFields["Enter your passphrase"]
            let confirmationField = app.secureTextFields["Confirm your passphrase"]
            if passphraseField.waitForExistence(timeout: 0.25),
               confirmationField.waitForExistence(timeout: 0.25),
               passphraseField.isHittable,
               confirmationField.isHittable {
                let passphrase = reviewerVaultPassphrase()
                replaceText(in: passphraseField, with: passphrase)
                replaceText(in: confirmationField, with: passphrase)

                let createButton = app.buttons["Create Vault"]
                let deadline = Date().addingTimeInterval(3)
                while Date() < deadline, !(createButton.exists && createButton.isHittable) {
                    RunLoop.current.run(until: Date().addingTimeInterval(0.1))
                }
                if createButton.exists, createButton.isHittable {
                    createButton.tap()
                    vaultCreationSubmitted = true
                    return .progressed
                }
            }
        }

        if vaultCreationSubmitted {
            let recoveryContinueButton = app.buttons["I've Saved My Recovery Key"]
            if recoveryContinueButton.waitForExistence(timeout: 0.25),
               recoveryContinueButton.isHittable {
                recoveryContinueButton.tap()
                _ = recoveryContinueButton.waitForNonExistence(timeout: 15)
                vaultCreationRelaunched = true
                return .relaunch
            }
        }

        return .none
    }

    @discardableResult
    private func attemptVaultPassphraseUnlock(app: XCUIApplication) -> Bool {
        guard !vaultUnlockSubmitted else {
            return false
        }
        let vaultCreationControls = [
            app.buttons["Continue to Vault Setup"],
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
            "-UITestResetAppState", "true",
            "-UITestRunUiFlows", "true",
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
        var lastVaultBootstrapAttemptAt = Date.distantPast
        var lastBootstrapState = ""
        var authenticatedBootstrapObservedAt: Date?

        while Date() < deadline {
            if Date().timeIntervalSince(lastVaultBootstrapAttemptAt) >= 1 {
                switch attemptFreshVaultBootstrap(app: app) {
                case .none:
                    break
                case .progressed:
                    lastProgressAt = Date()
                case .relaunch:
                    lastProgressAt = Date()
                    lastStatus = [:]
                    lastFlowLabel = ""
                    lastProgressKey = ""
                    app.terminate()
                    app.launch()
                    RunLoop.current.run(until: Date().addingTimeInterval(1))
                }
                lastVaultBootstrapAttemptAt = Date()
            }

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
                    let bootstrapUid = lastStatus["bootstrap_uid"] ?? ""
                    if let expectedUid = ProcessInfo.processInfo.environment["HUSHH_UI_TEST_REVIEWER_UID"]
                        ?? ProcessInfo.processInfo.environment["REVIEWER_UID"],
                       !expectedUid.isEmpty,
                       !bootstrapUid.isEmpty,
                       bootstrapUid != expectedUid,
                       Date().timeIntervalSince(lastProgressAt) >= 20 {
                        XCTFail(
                            "Signed in as unexpected uid \(bootstrapUid), expected \(expectedUid). Uninstall the app or reset device session before UITest."
                        )
                        return lastStatus
                    }
                    let flowLabel = lastStatus["ui_flow"] ?? ""
                    let progressKey = [
                        flowLabel,
                        lastStatus["ui_step"] ?? "",
                        lastStatus["ui_step_type"] ?? "",
                        lastStatus["route"] ?? "",
                        lastStatus["ui_error"] ?? "",
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
                let visible = visibleButtonLabels(app: app).joined(separator: ", ")
                XCTFail(
                    "UI interaction flows stalled for \(Int(stallTimeout))s. ui_flow=\(lastFlowLabel) visible_buttons=[\(visible)] last_status=\(lastStatus)"
                )
                return lastStatus
            }

            let idleInterval: TimeInterval = isLongImportWaitStatus(lastStatus) ? 1 : 0.5
            RunLoop.current.run(until: Date().addingTimeInterval(idleInterval))
        }

        let visible = visibleButtonLabels(app: app).joined(separator: ", ")
        XCTFail(
            "UI interaction flows timed out after \(Int(timeout))s. visible_buttons=[\(visible)] last_status=\(lastStatus)"
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
        let body = (status["body"] ?? "").lowercased()
        if isLongImportWaitStatus(
            flow: flow,
            route: route,
            stepType: stepType,
            body: body
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
            body: (status["body"] ?? "").lowercased()
        )
    }

    private func isLongImportWaitStatus(
        flow: String,
        route: String,
        stepType: String,
        body: String
    ) -> Bool {
        let isImportFlow = flow == "native-investor-kai-import-e2e"
        let isImportRoute = normalizeRoute(route).hasPrefix("/kai/import")
        let isLongImportStep =
            stepType == "wait_button" ||
            stepType == "assert_text" ||
            body.contains("importing portfolio")

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
            "vault_crypto_error",
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
            "ui_error",
            "portfolio_start_state",
            "portfolio_start_status",
            "portfolio_start_run",
            "portfolio_start_error",
            "portfolio_stream_state",
            "portfolio_stream_run",
            "portfolio_events",
            "portfolio_last_event",
            "portfolio_last_seq",
            "portfolio_stream_error",
        ]

        var summary: [String] = keys.compactMap { key -> String? in
            guard let value = status[key], !value.isEmpty else {
                return nil
            }
            return "\(key)=\(value)"
        }
        if let errorClass = bootstrapErrorClass(status["bootstrap_error"] ?? "") {
            summary.append("bootstrap_error_class=\(errorClass)")
        }
        return summary.joined(separator: " ")
    }

    private func bootstrapErrorClass(_ rawValue: String) -> String? {
        let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !value.isEmpty else {
            return nil
        }
        if value.contains("unexpected uid") || value.contains("uid mismatch") {
            return "uid_mismatch"
        }
        if value.contains("custom token") {
            return "custom_token"
        }
        if value.contains("reviewer") && value.contains("session") {
            return "reviewer_session"
        }
        if value.contains("401") || value.contains("403") || value.contains("sign in") {
            return "authentication"
        }
        if value.contains("404") || value.contains("not found") {
            return "not_found"
        }
        if value.contains("timed out") || value.contains("network") || value.contains("connection") {
            return "network"
        }
        if value.contains("vault") {
            return "vault"
        }
        return "other"
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
            let app = launchApp(route)
            let status = try waitForSatisfiedStatus(app, route: route, timeout: 90)
            XCTAssertTrue(
                route.allowedDataStates.contains(status["data"] ?? ""),
                "Unexpected data state for \(route.name): \(status)"
            )
            app.terminate()
        }
    }

    @discardableResult
    private func launchApp(_ route: RouteCase) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-UITestMode",
            "-UITestInitialRoute", route.initialRoute,
            "-UITestExpectedMarker", route.expectedMarker,
            "-UITestAutoReviewerLogin", route.autoReviewerLogin ? "true" : "false",
            "-UITestResetAppState", "false",
        ]
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
                _ = attemptVaultPassphraseUnlock(app: app)
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

        XCTFail("Route \(route.name) never satisfied native status checks. Last status: \(lastStatus)")
        return parseStatus(lastStatus)
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
