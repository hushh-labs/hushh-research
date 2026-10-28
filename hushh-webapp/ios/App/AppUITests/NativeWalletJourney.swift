import XCTest

/// Read-only warm-session qualification of the collection/owned-sheet family.
/// No saved card, share grant, profile or pass operation is submitted.
enum NativeWalletJourney {
    private static func admitted(_ element: XCUIElement, timeout: TimeInterval = 15) -> Bool {
        XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in element.exists && element.isHittable && element.isEnabled }, object: element)], timeout: timeout) == .completed
    }
    static func run(_ app: XCUIApplication) -> Bool {
        let collection = app.scrollViews["native-wallet-collection"].firstMatch
        let add = app.buttons["native-wallet-add"].firstMatch
        guard admitted(add) else {
            let probe = app.buttons["native-vault-layout"].firstMatch
            if let raw = probe.value as? String, let bytes = raw.data(using: .utf8), let values = try? JSONSerialization.jsonObject(with: bytes) as? [String: NSNumber] {
                for key in ["workspaceAdmissionStage", "walletNativeMode", "walletWeb", "walletIntro", "nativeIsolation"] {
                    if let value = values[key] { print("WALLET_ADMISSION key=\(key) value=\(value.intValue)") }
                }
            }
            XCTFail("WALLET_NATIVE_COLLECTION_UNAVAILABLE"); return false
        }
        XCTAssertEqual(add.label, "Add card", "WALLET_ADD_LOST_AUTHORED_TEXT")
        XCTAssertTrue(collection.buttons["native-wallet-add"].exists, "WALLET_ADD_NOT_IN_BODY")
        XCTAssertFalse(app.buttons["stationary-add"].exists, "WALLET_RETIRED_TOOLBAR_ADD_PRESENT")
        if ProcessInfo.processInfo.environment["HUSHH_WALLET_ONLY_ACCESS"] != "true" {
        for cycle in 0..<10 {
            let title = ["Agent One Profile", "Agent One Referral", "Agent One NWS"][cycle % 3]
            let card = app.buttons[title].firstMatch
            for _ in 0..<7 { if card.isHittable { break }; collection.swipeUp() }
            for _ in 0..<7 { if card.isHittable { break }; collection.swipeDown() }
            guard admitted(card) else { XCTFail("WALLET_NATIVE_SYSTEM_CARD_UNAVAILABLE"); return false }
            card.tap()
            let close = app.buttons["native-wallet-detail-close"].firstMatch
            guard admitted(close) else { XCTFail("WALLET_SELECTED_NATIVE_PANEL_UNAVAILABLE"); return false }
            XCTAssertFalse(app.tabBars.firstMatch.buttons["Chat"].firstMatch.isHittable, "WALLET_DETAIL_LEAKED_NAVIGATION")
            XCTAssertFalse(add.isHittable, "WALLET_DETAIL_LEAKED_BODY_ACTION")
            if cycle == 0 {
                let edit = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Edit shared information")).firstMatch
                let setup = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Set up Wallet Profile")).firstMatch
                let body = app.descendants(matching: .any)["native-wallet-detail-content"].firstMatch
                for _ in 0..<6 {
                    if edit.isHittable || setup.isHittable { break }
                    if body.exists && body.isHittable { body.swipeUp() }
                }
                let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in edit.isHittable || setup.isHittable }, object: app)
                guard XCTWaiter.wait(for: [ready], timeout: 20) == .completed else {
                    print("WALLET_PROFILE_ADMISSION edit=\(edit.exists) setup=\(setup.exists) body=\(body.exists)")
                    XCTFail("WALLET_PROFILE_OWNER_UNAVAILABLE"); return false
                }
                (edit.isHittable ? edit : setup).tap()
                let field = app.textFields["native-wallet-profile-fullName"].firstMatch
                guard admitted(field) else { XCTFail("WALLET_NATIVE_PROFILE_EDITOR_UNAVAILABLE"); return false }
                field.tap()
                XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "WALLET_PROFILE_KEYBOARD_UNAVAILABLE")
                close.tap() // Existing local Cancel/Back; never submit Save.
                XCTAssertTrue(field.waitForNonExistence(timeout: 10), "WALLET_PROFILE_NESTED_BACK_FAILED")
                guard admitted(close) else { XCTFail("WALLET_PROFILE_RETURN_FAILED"); return false }
                let next = app.buttons["Next card"].firstMatch
                for _ in 0..<6 { if next.isHittable { break }; body.swipeUp() }
                guard admitted(next) else { XCTFail("WALLET_NEXT_CARD_UNAVAILABLE"); return false }
                func presentations() -> Int? {
                    let probe = app.buttons["native-vault-layout"].firstMatch
                    guard let raw = probe.value as? String, let data = raw.data(using: .utf8), let values = try? JSONSerialization.jsonObject(with: data) as? [String: NSNumber] else { return nil }
                    return values["walletPresentationCount"]?.intValue
                }
                let previousCount = presentations()
                next.tap()
                guard app.navigationBars["Referral"].firstMatch.waitForExistence(timeout: 15), admitted(close) else { XCTFail("WALLET_NEXT_CARD_DID_NOT_SETTLE"); return false }
                XCTAssertNotNil(previousCount)
                XCTAssertEqual(presentations(), previousCount, "WALLET_NEXT_CARD_REPRESENTED_SHEET")
            }
            if cycle == 1 {
                let bar = app.navigationBars.firstMatch
                bar.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1,
                    thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)))
            } else { close.tap() }
            guard close.waitForNonExistence(timeout: 10) else { XCTFail("WALLET_DETAIL_DISMISSAL_FAILED"); return false }
            print("WORKSPACE_NATIVE_CARD_PANEL cycle=\(cycle) native_body=true isolated=true returned=true")
        }
        for _ in 0..<8 { if add.isHittable { break }; collection.swipeDown() }
        guard admitted(add) else { XCTFail("WALLET_BODY_ADD_NOT_RESTORED"); return false }
        for cycle in 0..<3 {
            add.tap()
            let name = app.textFields["native-wallet-card-cardholderName"].firstMatch
            let cancel = app.buttons["native-wallet-card-cancel"].firstMatch
            guard admitted(name), admitted(cancel) else { XCTFail("WALLET_NATIVE_ADD_FORM_UNAVAILABLE"); return false }
            XCTAssertFalse(app.tabBars.firstMatch.buttons["Chat"].firstMatch.isHittable, "WALLET_ADD_LEAKED_NAVIGATION")
            if cycle == 0 { name.tap(); XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5)) }
            cancel.tap()
            guard cancel.waitForNonExistence(timeout: 10) else { XCTFail("WALLET_ADD_DISMISSAL_FAILED"); return false }
            // My cards keeps the same native collection behind the owned form.
            guard admitted(add) else { XCTFail("WALLET_ADD_RETURN_LOST_NATIVE_COLLECTION"); return false }
        }
        }
        for _ in 0..<8 { if app.buttons["native-wallet-access"].firstMatch.isHittable { break }; collection.swipeDown() }
        let access = app.buttons["native-wallet-access"].firstMatch
        guard admitted(access) else { XCTFail("WALLET_ACCESS_ENTRY_MISSING"); return false }
        for horizontal in [0.25, 0.5, 0.92] {
        access.coordinate(withNormalizedOffset: CGVector(dx: horizontal, dy: 0.5)).tap()
        let accessClose = app.buttons["native-wallet-detail-close"].firstMatch
        guard admitted(accessClose) else {
            let probe = app.buttons["native-vault-layout"].firstMatch
            if let raw = probe.value as? String, let bytes = raw.data(using: .utf8), let values = try? JSONSerialization.jsonObject(with: bytes) as? [String: NSNumber] {
                for key in ["workspaceAdmissionStage", "walletNativeMode", "walletWeb", "nativeIsolation"] { if let value = values[key] { print("WALLET_ADMISSION key=\(key) value=\(value.intValue)") } }
            }
            print("WALLET_ACCESS_STATE close_exists=\(accessClose.exists) close_enabled=\(accessClose.exists && accessClose.isEnabled)")
            XCTFail("WALLET_ACCESS_NATIVE_PANEL_MISSING"); return false
        }
        XCTAssertFalse(app.tabBars.firstMatch.buttons["Chat"].firstMatch.isHittable, "WALLET_ACCESS_LEAKED_NAVIGATION")
        accessClose.tap()
        guard accessClose.waitForNonExistence(timeout: 10), admitted(add) else { XCTFail("WALLET_ACCESS_RETURN_FAILED"); return false }
        }
        print("WORKSPACE_NATIVE_WALLET_ACCESS native_body=true isolated=true returned=true")
        return true
    }
}
