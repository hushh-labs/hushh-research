import XCTest
@testable import App

final class NativeSupportTests: XCTestCase {
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
