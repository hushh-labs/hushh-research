import XCTest

/// Attach to an existing phone-onboarding session. No login, reset, or SMS.
final class CountryPickerTests: XCTestCase {
    func testCountryPickerSelectionAndLeaveOpen() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "com.hushh.app")
        app.activate()
        let trigger = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Country code:")).firstMatch
        guard trigger.waitForExistence(timeout: 30) else {
            throw XCTSkip("An existing phone-entry session is required; no account is reset by this test.")
        }
        let countries = [("United States", "+1"), ("United Kingdom", "+44"), ("India", "+91"), ("Angola", "+244"), ("Brazil", "+55"), ("India", "+91")]
        for (name, code) in countries {
            trigger.tap()
            let searchField = app.searchFields["Search countries"]
            let textField = app.textFields["Search countries"]
            let search = searchField.waitForExistence(timeout: 3) ? searchField : textField
            XCTAssertTrue(search.waitForExistence(timeout: 5))
            search.tap()
            search.typeText(name)
            let row = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "\(name) (\(code))")).firstMatch
            XCTAssertTrue(row.waitForExistence(timeout: 5))
            row.tap()
            XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Country code: \(name) (\(code))")).firstMatch.waitForExistence(timeout: 5))
        }
        trigger.tap()
        app.buttons["Cancel"].tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Country code: India (+91)")).firstMatch.waitForExistence(timeout: 5))
        trigger.tap()
        XCTAssertTrue(app.buttons["Cancel"].waitForExistence(timeout: 5))
        // Intentionally leave the app and picker open for manual inspection.
    }
}
