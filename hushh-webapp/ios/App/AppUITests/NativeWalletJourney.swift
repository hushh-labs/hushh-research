import XCTest

/// Read-only warm-session qualification of the collection/owned-sheet family.
/// No saved card, share grant, profile or pass operation is submitted.
enum NativeWalletJourney {
    static func captureWarmCheckpoint(_ checkpoint: String) {
        XCTContext.runActivity(named: "wallet-warm-\(checkpoint)") { activity in
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = "wallet-warm-\(checkpoint)"
            attachment.lifetime = .keepAlways
            activity.add(attachment)
        }
    }

    private static func softwareKeyboardIsOnscreen(_ app: XCUIApplication) -> Bool {
        let keyboard = app.keyboards.firstMatch
        guard keyboard.exists else { return false }
        let frame = keyboard.frame
        let visible = frame.intersection(app.frame)
        return !frame.isNull && !frame.isInfinite && !visible.isNull &&
            [frame.minX, frame.minY, frame.width, frame.height,
             visible.minX, visible.minY, visible.width, visible.height].allSatisfy(\.isFinite) &&
            visible.width > 0 && visible.height > 0
    }
    private static func keyboardReceipt(_ app: XCUIApplication) -> (onscreen: Bool, visibleKeyCount: Int) {
        let window = app.frame
        let keyboard = app.keyboards.firstMatch
        let keyboardFrame = keyboard.exists ? keyboard.frame : .zero
        let intersection = keyboardFrame.intersection(window)
        for (source, frame) in [("window", window), ("keyboard", keyboardFrame), ("intersection", intersection)] {
            let coordinates = [frame.minX, frame.minY, frame.width, frame.height]
            let finite = coordinates.allSatisfy(\.isFinite)
            let bounded = coordinates.map { value -> Int in
                guard value.isFinite else { return 0 }
                return Int(max(-100_000, min(100_000, value)))
            }
            print("WALLET_PROFILE_KEYBOARD_GEOMETRY source=\(source) finite=\(finite) x=\(bounded[0]) y=\(bounded[1]) width=\(bounded[2]) height=\(bounded[3])")
        }
        let probe = app.buttons["native-vault-layout"].firstMatch
        let bottomInset: Int? = {
            guard probe.exists, let raw = probe.value as? String, raw.utf8.count <= 4096,
                  let data = raw.data(using: .utf8),
                  let values = try? JSONSerialization.jsonObject(with: data) as? [String: NSNumber],
                  let value = values["nativeBottomSafeArea"]?.doubleValue,
                  value.isFinite, value >= 0, value <= 100_000 else { return nil }
            return Int(value.rounded())
        }()
        let insetValue = bottomInset.map { String($0) } ?? "unavailable"
        print("WALLET_PROFILE_KEYBOARD_GEOMETRY source=bottom_safe_area available=\(bottomInset != nil) points=\(insetValue)")
        return (softwareKeyboardIsOnscreen(app), keyboard.exists ? keyboard.keys.count : 0)
    }
    private static func waitForSoftwareKeyboard(_ app: XCUIApplication, timeout: TimeInterval = 5) -> Bool {
        let visible = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            softwareKeyboardIsOnscreen(app)
        }, object: app)
        return XCTWaiter.wait(for: [visible], timeout: timeout) == .completed
    }
    private static func admitted(_ element: XCUIElement, timeout: TimeInterval = 15) -> Bool {
        XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in element.exists && element.isHittable && element.isEnabled }, object: element)], timeout: timeout) == .completed
    }
    static func run(_ app: XCUIApplication) -> Bool {
        return runJourney(
            app,
            repeatAddCancel: true,
            includeCardDetails: ProcessInfo.processInfo.environment["HUSHH_WALLET_ONLY_ACCESS"] != "true"
        )
    }

    /// Reuse the accepted picker matrix. One Add/Cancel continuity check guards
    /// the shared parent lifetime before collection/detail navigation.
    static func runWarmContinuity(
        _ app: XCUIApplication,
        recordProfileEvidence: @escaping (Bool, Bool, Bool) -> Void
    ) -> Bool {
        let add = app.buttons["native-wallet-add"].firstMatch
        guard admitted(add) else { XCTFail("WALLET_CONTINUITY_ADD_UNAVAILABLE"); return false }
        add.tap()
        let cancel = app.buttons["native-wallet-card-cancel"].firstMatch
        guard admitted(cancel) else { XCTFail("WALLET_CONTINUITY_CANCEL_UNAVAILABLE"); return false }
        captureWarmCheckpoint("add-continuity")
        cancel.tap()
        guard cancel.waitForNonExistence(timeout: 10), admitted(add) else {
            XCTFail("WALLET_CONTINUITY_PARENT_NOT_RESTORED"); return false
        }
        captureWarmCheckpoint("add-continuity-return")
        return runJourney(
            app,
            repeatAddCancel: false,
            includeCardDetails: true,
            onWarmProfileEvidence: recordProfileEvidence
        )
    }

    private static func runJourney(
        _ app: XCUIApplication,
        repeatAddCancel: Bool,
        includeCardDetails: Bool,
        onWarmProfileEvidence: ((Bool, Bool, Bool) -> Void)? = nil
    ) -> Bool {
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
        let webAdds = app.webViews.buttons.matching(NSPredicate(format: "label == %@", "Add a card"))
        let tabsQuery = app.segmentedControls.matching(identifier: "segmented-tabs:wallet")
        let tabs = tabsQuery.firstMatch
        let myCards = tabs.buttons["My cards"].firstMatch
        let shared = tabs.buttons["Shared with me"].firstMatch
        let sharedBody = app.scrollViews["native-wallet-shared-history-scroll"].firstMatch
        guard tabsQuery.count == 1, admitted(tabs), admitted(myCards), admitted(shared) else {
            XCTFail("WALLET_NATIVE_TABS_UNAVAILABLE"); return false
        }
        if !repeatAddCancel && !myCards.isSelected {
            XCTFail("WALLET_WARM_REQUIRES_MY_CARDS_ENTRY"); return false
        }
        XCTAssertEqual(webAdds.count, 0, "WALLET_REACT_ACTION_VISIBLE_WHILE_NATIVE_OWNS_COLLECTION")
        shared.tap()
        guard admitted(sharedBody), admitted(add) else { XCTFail("WALLET_SHARED_NATIVE_BODY_UNAVAILABLE"); return false }
        XCTAssertTrue(shared.isSelected, "WALLET_SHARED_TAB_DID_NOT_SETTLE")
        XCTAssertTrue(sharedBody.exists)
        if !repeatAddCancel { captureWarmCheckpoint("shared") }
        if !repeatAddCancel {
            shared.tap()
            guard admitted(sharedBody), admitted(add), shared.isSelected else {
                XCTFail("WALLET_SHARED_TAB_RESELECTION_DID_NOT_SETTLE"); return false
            }
            XCTAssertEqual(tabsQuery.count, 1, "WALLET_NATIVE_TAB_OWNER_DUPLICATED_ON_SHARED_RESELECTION")
            XCTAssertEqual(webAdds.count, 0, "WALLET_REACT_ACTION_RETURNED_ON_SHARED_RESELECTION")
            captureWarmCheckpoint("shared-reselected")
        }
        XCTAssertEqual(tabsQuery.count, 1, "WALLET_NATIVE_TAB_OWNER_DUPLICATED_ON_SHARED_TAB")
        XCTAssertEqual(webAdds.count, 0, "WALLET_REACT_ACTION_RETURNED_ON_SHARED_TAB")
        XCTAssertTrue(collection.waitForNonExistence(timeout: 5), "WALLET_COLLECTION_RETAINED_OVER_SHARED_BODY")
        if repeatAddCancel {
            add.tap()
            let sharedName = app.textFields["native-wallet-card-cardholderName"].firstMatch
            let sharedCancel = app.buttons["native-wallet-card-cancel"].firstMatch
            guard admitted(sharedName), admitted(sharedCancel) else { XCTFail("WALLET_SHARED_ADD_FORM_UNAVAILABLE"); return false }
            sharedName.tap()
            XCTAssertTrue(Self.waitForSoftwareKeyboard(app), "WALLET_SHARED_ADD_KEYBOARD_OFFSCREEN")
            sharedCancel.tap()
            guard sharedCancel.waitForNonExistence(timeout: 10), admitted(sharedBody), admitted(add) else {
                XCTFail("WALLET_SHARED_ADD_CANCEL_DID_NOT_RESTORE_SHARED_TAB"); return false
            }
            XCTAssertTrue(shared.isSelected, "WALLET_SHARED_ADD_CANCEL_LOST_TAB_SELECTION")
        }
        let access = app.buttons["native-wallet-access"].firstMatch
        guard admitted(access) else { XCTFail("WALLET_ACCESS_ENTRY_MISSING_ON_SHARED_TAB"); return false }
        access.tap()
        let accessClose = app.buttons["native-wallet-detail-close"].firstMatch
        guard admitted(accessClose) else { XCTFail("WALLET_ACCESS_NATIVE_PANEL_MISSING_ON_SHARED_TAB"); return false }
        if !repeatAddCancel { captureWarmCheckpoint("access") }
        accessClose.tap()
        guard accessClose.waitForNonExistence(timeout: 10), admitted(sharedBody), admitted(add) else {
            XCTFail("WALLET_ACCESS_DID_NOT_RETURN_TO_SHARED_TAB"); return false
        }
        XCTAssertTrue(shared.isSelected, "WALLET_ACCESS_LOST_ORIGINATING_TAB")
        myCards.tap()
        guard admitted(collection), admitted(add) else { XCTFail("WALLET_MY_CARDS_NATIVE_BODY_NOT_RESTORED"); return false }
        XCTAssertTrue(myCards.isSelected, "WALLET_MY_CARDS_TAB_DID_NOT_SETTLE")
        XCTAssertTrue(sharedBody.waitForNonExistence(timeout: 5), "WALLET_SHARED_BODY_RETAINED_OVER_COLLECTION")
        XCTAssertEqual(tabsQuery.count, 1, "WALLET_NATIVE_TAB_OWNER_DUPLICATED_ON_MY_CARDS_TAB")
        XCTAssertEqual(webAdds.count, 0, "WALLET_REACT_ACTION_RETURNED_ON_MY_CARDS_TAB")
        if !repeatAddCancel { captureWarmCheckpoint("collection-return") }
        if !repeatAddCancel {
            myCards.tap()
            guard admitted(collection), admitted(add), myCards.isSelected else {
                XCTFail("WALLET_MY_CARDS_RESELECTION_DID_NOT_SETTLE"); return false
            }
            XCTAssertTrue(sharedBody.waitForNonExistence(timeout: 5), "WALLET_SHARED_BODY_REAPPEARED_ON_MY_CARDS_RESELECTION")
            XCTAssertEqual(tabsQuery.count, 1, "WALLET_NATIVE_TAB_OWNER_DUPLICATED_ON_MY_CARDS_RESELECTION")
            captureWarmCheckpoint("collection-reselected")
        }
        if includeCardDetails {
            for cycle in 0..<3 {
                let title = ["Agent One Profile", "Agent One Referral", "Agent One NWS"][cycle % 3]
                let card = app.buttons[title].firstMatch
                for _ in 0..<7 { if card.isHittable { break }; collection.swipeUp() }
                for _ in 0..<7 { if card.isHittable { break }; collection.swipeDown() }
                guard admitted(card) else { XCTFail("WALLET_NATIVE_SYSTEM_CARD_UNAVAILABLE"); return false }
                card.tap()
                let close = app.buttons["native-wallet-detail-close"].firstMatch
                guard admitted(close) else { XCTFail("WALLET_SELECTED_NATIVE_PANEL_UNAVAILABLE"); return false }
                if !repeatAddCancel {
                    captureWarmCheckpoint(["profile-detail", "referral-detail", "nws-detail"][cycle])
                }
                XCTAssertFalse(app.tabBars.firstMatch.buttons["Chat"].firstMatch.isHittable, "WALLET_DETAIL_LEAKED_NAVIGATION")
                XCTAssertFalse(add.isHittable, "WALLET_DETAIL_LEAKED_BODY_ACTION")
                if cycle == 0 {
                    var edit: XCUIElement { app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Edit shared information")).firstMatch }
                    var setup: XCUIElement { app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Set up Wallet Profile")).firstMatch }
                    var body: XCUIElement { app.descendants(matching: .any)["native-wallet-detail-content"].firstMatch }
                    if !repeatAddCancel {
                        let copy = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Copy link")).firstMatch
                        for _ in 0..<6 {
                            if copy.isHittable || setup.isHittable { break }
                            if body.exists && body.isHittable { body.swipeUp() }
                        }
                        if copy.exists && copy.isEnabled && copy.isHittable {
                            copy.tap()
                            let banner = app.descendants(matching: .any).matching(identifier: "native-feedback-banner").firstMatch
                            guard banner.waitForExistence(timeout: 3), close.exists, body.exists else {
                                XCTFail("WALLET_COPY_FEEDBACK_REPLACED_NATIVE_DETAIL"); return false
                            }
                            captureWarmCheckpoint("profile-native-feedback")
                            let dismiss = banner.buttons["Dismiss notification"].firstMatch
                            if dismiss.exists && dismiss.isHittable { dismiss.tap() }
                        } else {
                            print("WALLET_COPY_FEEDBACK fixture=active_profile_link_unavailable")
                        }
                    }
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
                    let keyboardVisible = Self.waitForSoftwareKeyboard(app)
                    let keyboard = Self.keyboardReceipt(app)
                    let visibleKeyCount = keyboard.visibleKeyCount
                    let keyboardVisualQualified = keyboardVisible && keyboard.onscreen && visibleKeyCount > 0
                    if !repeatAddCancel { captureWarmCheckpoint("profile-editor") }
                    let sentinel = "WalletWarmSentinel"
                    var sentinelObserved = false
                    var originalName: String?
                    if keyboardVisualQualified {
                        originalName = field.value as? String
                        field.typeText(sentinel)
                        let sentinelApplied = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                            guard let editedName = field.value as? String else { return false }
                            return editedName != originalName && editedName.contains(sentinel)
                        }, object: field)
                        sentinelObserved = XCTWaiter.wait(for: [sentinelApplied], timeout: 3) == .completed
                        print("WALLET_PROFILE_EDIT keyboard_visible=true visible_keys=\(visibleKeyCount) visual_qualified=true sentinel_type_attempted=true sentinel_observed=\(sentinelObserved)")
                    } else {
                        print("WALLET_PROFILE_KEYBOARD_BLOCKER keyboard_visible=\(keyboardVisible) visible_keys=\(visibleKeyCount) visual_qualified=false sentinel_type_attempted=false route_continuation=cancel")
                    }

                    func cancelProfileEditor(_ editedField: XCUIElement) -> Bool {
                        let cancels = app.buttons.matching(identifier: "native-wallet-profile-cancel")
                        let cancel = cancels.firstMatch
                        let located = cancels.count == 1 && admitted(cancel)
                        print("WALLET_PROFILE_CANCEL_LOCATOR owner=native-toolbar cancel_count=\(cancels.count) hittable=\(cancel.exists && cancel.isHittable) enabled=\(cancel.exists && cancel.isEnabled)")
                        guard located else {
                            captureWarmCheckpoint("profile-cancel-locator-failed")
                            XCTFail("WALLET_PROFILE_CANCEL_LOCATOR_FAILED")
                            return false
                        }
                        cancel.tap()
                        let editorRetired = editedField.waitForNonExistence(timeout: 10)
                        let detailReturned = editorRetired && admitted(close)
                        print("WALLET_PROFILE_CANCEL_RESULT editor_retired=\(editorRetired) detail_returned=\(detailReturned)")
                        guard editorRetired && detailReturned else {
                            XCTFail("WALLET_PROFILE_CANCEL_ACTION_FAILED")
                            return false
                        }
                        return true
                    }

                    guard cancelProfileEditor(field) else {
                        return false
                    }
                    if keyboardVisualQualified {
                        captureWarmCheckpoint("profile-cancel-return")
                        for _ in 0..<6 {
                            if edit.exists && edit.isHittable || setup.exists && setup.isHittable { break }
                            guard body.exists && body.isHittable else { break }
                            body.swipeUp()
                        }
                        let profileReady = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                            edit.exists && edit.isHittable || setup.exists && setup.isHittable
                        }, object: app)
                        guard XCTWaiter.wait(for: [profileReady], timeout: 15) == .completed else {
                            captureWarmCheckpoint("profile-reopen-failed")
                            print("WALLET_PROFILE_REOPEN_GUARD edit_exists=\(edit.exists) edit_hittable=\(edit.exists && edit.isHittable) edit_enabled=\(edit.exists && edit.isEnabled) body_exists=\(body.exists)")
                            XCTFail("WALLET_PROFILE_REOPEN_UNAVAILABLE")
                            return false
                        }
                        (edit.isHittable ? edit : setup).tap()
                        let restoredField = app.textFields["native-wallet-profile-fullName"].firstMatch
                        guard admitted(restoredField) else {
                            XCTFail("WALLET_PROFILE_REOPEN_EDITOR_UNAVAILABLE")
                            return false
                        }
                        let restoredName = restoredField.value as? String
                        let cancelledWithoutSubmit = originalName != nil && restoredName == originalName
                        print("WALLET_PROFILE_DRAFT_RESULT input_retained=\(sentinelObserved) cancel_discarded=\(cancelledWithoutSubmit)")
                        XCTAssertTrue(sentinelObserved, "WALLET_PROFILE_SENTINEL_INPUT_NOT_OBSERVED")
                        XCTAssertTrue(cancelledWithoutSubmit, "WALLET_PROFILE_CANCEL_RETAINED_SENTINEL")
                        onWarmProfileEvidence?(keyboardVisualQualified, sentinelObserved, cancelledWithoutSubmit)
                        guard cancelProfileEditor(restoredField) else { return false }
                    } else {
                        onWarmProfileEvidence?(false, false, false)
                    }
                    if !repeatAddCancel && !setup.exists {
                        let preview = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Preview as visitor")).firstMatch
                        for _ in 0..<6 { if preview.isHittable { break }; body.swipeUp() }
                        guard admitted(preview) else { XCTFail("WALLET_PREVIEW_ENTRY_UNAVAILABLE"); return false }
                        preview.tap()
                        guard app.navigationBars["Preview as visitor"].waitForExistence(timeout: 15), admitted(close) else {
                            XCTFail("WALLET_PREVIEW_PRESENTATION_UNAVAILABLE"); return false
                        }
                        let previewName = app.staticTexts["Name"].firstMatch
                        let previewLoaded = previewName.waitForExistence(timeout: 15)
                        print("WALLET_PREVIEW loaded=\(previewLoaded) native_detail=true")
                        captureWarmCheckpoint("profile-visitor-preview")
                        close.tap()
                        guard app.navigationBars["Wallet Profile"].waitForExistence(timeout: 10), admitted(close) else { XCTFail("WALLET_PREVIEW_RETURN_FAILED"); return false }
                        // Exercise authored confirmation return paths without
                        // performing any sharing or account mutation.
                        for label in ["Pause sharing", "Revoke access", "Remove Wallet profile"] {
                            let predicate = label == "Pause sharing"
                                ? NSPredicate(format: "label BEGINSWITH %@ OR label BEGINSWITH %@", "Pause sharing", "Resume sharing")
                                : NSPredicate(format: "label BEGINSWITH %@", label)
                            var action: XCUIElement { app.buttons.matching(predicate).firstMatch }
                            for _ in 0..<6 {
                                if action.exists && action.isHittable { break }
                                body.swipeUp()
                            }
                            for _ in 0..<6 {
                                if action.exists && action.isHittable { break }
                                body.swipeDown()
                            }
                            guard admitted(action) else {
                                captureWarmCheckpoint("confirmation-entry-failed")
                                print("WALLET_CONFIRMATION_GUARD label=\(label) count=\(app.buttons.matching(predicate).count) exists=\(action.exists) hittable=\(action.exists && action.isHittable) enabled=\(action.exists && action.isEnabled)")
                                XCTFail("WALLET_CONFIRMATION_ENTRY_UNAVAILABLE"); return false
                            }
                            action.tap()
                            let cancel = app.buttons.matching(NSPredicate(format: "label == %@", "Cancel")).firstMatch
                            guard admitted(cancel), close.exists else { XCTFail("WALLET_CONFIRMATION_CANCEL_UNAVAILABLE"); return false }
                            captureWarmCheckpoint("profile-confirmation-\(label)")
                            cancel.tap()
                            guard app.navigationBars["Wallet Profile"].waitForExistence(timeout: 10), admitted(close) else { XCTFail("WALLET_CONFIRMATION_RETURN_FAILED"); return false }
                        }
                    }
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
                    if !repeatAddCancel { captureWarmCheckpoint("referral") }
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
        }
        if repeatAddCancel {
            print("WORKSPACE_NATIVE_WALLET_ACCESS origin=shared restored=true")
        } else {
            print("WORKSPACE_NATIVE_WALLET_WARM_RESTORED origin=shared add_cancel_replayed=false")
        }
        return true
    }
}
