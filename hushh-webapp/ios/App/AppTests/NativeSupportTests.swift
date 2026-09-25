import XCTest
@testable import App

final class NativeSupportTests: XCTestCase {
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
    }

    func testNativeUiFlowConfigurationRequiresExplicitTestMode() {
        let ordinaryLaunch = NativeTestConfiguration(arguments: [
            "App",
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
        XCTAssertEqual(
            KaiStreamLifecycleErrorClassifier.bridgeCode(
                statusCode: 401,
                body: #"{"code":"AUTH_ACCOUNT_DELETION_IN_PROGRESS"}"#
            ),
            "AUTH_VAULT_OWNER_INVALID"
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
            "AUTH_VAULT_OWNER_INVALID"
        )
        XCTAssertEqual(
            KaiStreamLifecycleErrorClassifier.bridgeCode(
                statusCode: 500,
                body: ""
            ),
            "HUSHH_HTTP_500"
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
