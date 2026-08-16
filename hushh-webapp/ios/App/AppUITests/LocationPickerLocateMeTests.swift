import Foundation
import XCTest

/**
 Tapping "Use my current location" on the entrance picker terminated the app.

 An app that dies under a tap is the worst failure this flow has: the person
 loses the sheet, the pin, and any reason to trust the next attempt. A native
 crash cannot be caught in JavaScript, so the web layer's try/catch around
 `onLocateMe` proves nothing -- only running the real binary does.

 This drives the real app in the simulator, so it needs no macOS Accessibility
 permission and can run in CI on a mac runner.
 */
final class LocationPickerLocateMeTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func launchAtSavedPlaces() -> XCUIApplication {
        let app = XCUIApplication()
        let environment = ProcessInfo.processInfo.environment
        app.launchArguments = [
            "-UITestMode",
            // Saved places is where the entrance picker opens from.
            "-UITestInitialRoute", "/one/location?action=settings",
            "-UITestAutoReviewerLogin", "true",
            "-UITestResetAppState", "false",
        ]
        if let reviewerUid = environment["HUSHH_UI_TEST_REVIEWER_UID"]
            ?? environment["REVIEWER_UID"],
           !reviewerUid.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            app.launchArguments += ["-UITestExpectedUserId", reviewerUid]
        }
        if let vaultPassphrase = environment["HUSHH_UI_TEST_REVIEWER_VAULT_PASSPHRASE"]
            ?? environment["REVIEWER_VAULT_PASSPHRASE"],
           !vaultPassphrase.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            app.launchArguments += ["-UITestVaultPassphrase", vaultPassphrase]
        }
        app.launch()
        return app
    }

    /**
     The regression itself: the app must still be running after the tap.

     `XCTSkip` rather than a failure when the control never appears, so a
     harness or fixture problem is never reported as "the crash is fixed".
     */
    func testLocateMeDoesNotTerminateTheApp() throws {
        let app = launchAtSavedPlaces()
        defer { if app.state == .runningForeground { app.terminate() } }

        // The WebView exposes the control by its aria-label.
        let locateMe = app.buttons["Use my current location"]
        guard locateMe.waitForExistence(timeout: 60) else {
            throw XCTSkip(
                "Entrance picker was not reachable from /one/location?action=settings; "
                    + "reached state does not exercise the crash."
            )
        }

        XCTAssertTrue(locateMe.isHittable, "Locate-me control is present but not tappable.")
        locateMe.tap()

        // A native crash shows up as the app leaving the foreground. Give the
        // camera move and the reverse-geocode time to settle first.
        let stayedAlive = NSPredicate(format: "state == %d", XCUIApplication.State.runningForeground.rawValue)
        let stillRunning = XCTNSPredicateExpectation(predicate: stayedAlive, object: app)
        let outcome = XCTWaiter().wait(for: [stillRunning], timeout: 15)

        XCTAssertEqual(
            outcome,
            .completed,
            "App left the foreground after tapping locate-me — it crashed."
        )

        // Still interactive, not merely alive: a frozen WebView is its own bug.
        XCTAssertTrue(
            locateMe.waitForExistence(timeout: 10),
            "Picker no longer responds after locate-me."
        )
    }

    /**
     Repeated taps are the likelier trigger: each one can move the camera while
     the previous move is still in flight, and the picker tears its native map
     down and rebuilds it on theme resolution.
     */
    func testRepeatedLocateMeTapsDoNotTerminateTheApp() throws {
        let app = launchAtSavedPlaces()
        defer { if app.state == .runningForeground { app.terminate() } }

        let locateMe = app.buttons["Use my current location"]
        guard locateMe.waitForExistence(timeout: 60) else {
            throw XCTSkip("Entrance picker was not reachable; crash path not exercised.")
        }

        for attempt in 1...5 {
            guard locateMe.exists, locateMe.isHittable else {
                XCTFail("Locate-me control vanished after \(attempt - 1) taps — the app died or the picker broke.")
                return
            }
            locateMe.tap()
            usleep(400_000)
            XCTAssertEqual(
                app.state,
                .runningForeground,
                "App terminated on locate-me tap \(attempt)."
            )
        }
    }
}
