import XCTest

/// Grants the ordinary microphone permission through the real iOS prompt on
/// the dedicated device runner. The benchmark itself remains the authority:
/// if permission is denied, unavailable, or not inherited by the unit-test
/// host, the strict hardware test fails rather than being skipped.
final class OneVoiceMicrophonePermissionBootstrapTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testAutomatedVoiceGateBootstrapsMicrophonePermission() {
        guard ProcessInfo.processInfo.environment["HUSHH_ENABLE_IOS_VOICE_DEVICE_BENCHMARK"] == "true" else {
            XCTFail("The microphone bootstrap must run only with the strict hardware gate enabled.")
            return
        }

        let app = XCUIApplication()
        app.launchArguments = [
            "-UITestMode",
            "-HUSSHVoiceDevicePermissionBootstrap",
            "-UITestResetAppState", "false",
        ]
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let interruption = addUIInterruptionMonitor(withDescription: "Microphone permission") { alert in
            for label in ["Allow", "Allow While Using App", "OK"] {
                let button = alert.buttons[label]
                if button.exists {
                    button.tap()
                    return true
                }
            }
            return false
        }
        defer { removeUIInterruptionMonitor(interruption) }

        app.launch()
        let permissionPrompt = springboard.alerts.firstMatch
        if permissionPrompt.waitForExistence(timeout: 15) {
            let allowButton = ["Allow", "Allow While Using App", "OK"]
                .map { permissionPrompt.buttons[$0] }
                .first(where: { $0.exists })
            XCTAssertNotNil(allowButton, "Microphone prompt did not expose an allow action.")
            allowButton?.tap()
        }
        app.terminate()
    }
}
