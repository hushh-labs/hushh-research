import XCTest
import SwiftUI
@testable import App

final class NativeSupportTests: XCTestCase {
    #if DEBUG
    @MainActor
    func testNativeContinuityStillObservesNewFramesAndGapsAfterALongWarmSession() {
        let probe = NativeBackContinuityProbe(host: UIView())
        for _ in 0..<100_000 { probe.recordFrame(isMissing: true) }
        let baseline = probe.sampledFrames
        let missingBaseline = probe.missingFrames
        probe.recordFrame(isMissing: true)
        XCTAssertEqual(probe.sampledFrames - baseline, 1, "A long warm session must still prove fresh sampling")
        XCTAssertEqual(probe.missingFrames - missingBaseline, 1, "A newly missing control must remain observable")
    }

    func testPublicLayoutObservationsRejectInactiveShieldedAndSupersededSamples() {
        typealias Snapshot = HushhSessionPrivacyShield.Snapshot
        let admitted = Snapshot(shielded: false, generation: 7, cause: "inactive", appIsActive: true)
        XCTAssertTrue(NativeVaultLayoutProbe.acceptsSample(captured: admitted, current: admitted))
        let refused = [
            Snapshot(shielded: true, generation: 7, cause: "inactive", appIsActive: true),
            Snapshot(shielded: false, generation: 7, cause: "inactive", appIsActive: false),
            Snapshot(shielded: false, generation: 8, cause: "inactive", appIsActive: true),
        ]
        for snapshot in refused {
            XCTAssertFalse(NativeVaultLayoutProbe.acceptsSample(captured: admitted, current: snapshot))
            XCTAssertFalse(NativeVaultLayoutProbe.acceptsSample(captured: snapshot, current: admitted))
        }
    }
    #endif

    @MainActor
    func testNativeChromeKeepsKeyboardFenceUntilCurrentDismissalCompletes() {
        let plugin = HushhNativeChromePlugin()
        plugin.load()
        let ready = expectation(description: "Native lifecycle observers registered")
        DispatchQueue.main.async { ready.fulfill() }
        wait(for: [ready], timeout: 1)
        let notifications = NotificationCenter.default
        notifications.post(name: UIResponder.keyboardWillShowNotification, object: nil)
        XCTAssertTrue(plugin.keyboardVisible)
        notifications.post(name: UIResponder.keyboardWillHideNotification, object: nil)
        XCTAssertTrue(plugin.keyboardVisible, "The closing keyboard still owns presentation until completion")
        notifications.post(name: UIResponder.keyboardDidHideNotification, object: nil)
        XCTAssertFalse(plugin.keyboardVisible)
        // Reopening interrupts an older dismissal. Its late completion cannot
        // admit controls beneath the newly visible keyboard.
        notifications.post(name: UIResponder.keyboardWillShowNotification, object: nil)
        notifications.post(name: UIResponder.keyboardWillHideNotification, object: nil)
        notifications.post(name: UIResponder.keyboardWillShowNotification, object: nil)
        notifications.post(name: UIResponder.keyboardDidHideNotification, object: nil)
        XCTAssertTrue(plugin.keyboardVisible)
        notifications.post(name: UIResponder.keyboardWillHideNotification, object: nil)
        notifications.post(name: UIResponder.keyboardDidHideNotification, object: nil)
        XCTAssertFalse(plugin.keyboardVisible)
    }

    @MainActor
    func testHiddenSegmentedPickerReportsItsReservedGeometryBeforeInteraction() throws {
        guard #available(iOS 26.0, *) else { throw XCTSkip("Liquid Glass family requires iOS 26") }
        let measured = expectation(description: "Actual SwiftUI geometry equals the reserved slot")
        measured.assertForOverFulfill = false
        let theme = HushhNativeControlAppearance(appearance: "light", accentHex: "#007aff", foregroundHex: "#222222")!
        let host = UIHostingController(rootView: NativeAgentSurfaceSelector(selected: "one", width: 88,
            theme: theme, action: { _ in XCTFail("Hidden preparation cannot choose a value") },
            layout: { size in if size == CGSize(width: 88, height: 44) { measured.fulfill() } }))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let parent = UIViewController()
        window.rootViewController = parent
        window.isHidden = false
        defer { window.isHidden = true }
        parent.addChild(host)
        host.view.isHidden = true
        host.view.isUserInteractionEnabled = false
        host.safeAreaRegions = []
        parent.view.addSubview(host.view)
        host.view.frame = CGRect(x: 280, y: 60, width: 88, height: 44)
        host.didMove(toParent: parent)
        host.view.setNeedsLayout()
        host.view.layoutIfNeeded()
        wait(for: [measured], timeout: 2)
        XCTAssertEqual(host.view.bounds.size, CGSize(width: 88, height: 44))
        XCTAssertFalse(host.view.isUserInteractionEnabled)
    }

    func testNativeControlAppearanceRejectsMalformedProjectionAndDecodesCSSAlphaLast() {
        let theme = HushhNativeControlAppearance(appearance: "dark", accentHex: "#123", foregroundHex: "#44556680")
        XCTAssertEqual(theme?.style, .dark)
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        XCTAssertTrue(theme!.foreground.getRed(&r, green: &g, blue: &b, alpha: &a))
        XCTAssertEqual(r, 68.0 / 255, accuracy: 0.001)
        XCTAssertEqual(a, 128.0 / 255, accuracy: 0.001)
        XCTAssertTrue(theme!.accent.getRed(&r, green: &g, blue: &b, alpha: &a))
        XCTAssertEqual(b, 51.0 / 255, accuracy: 0.001)
        for bad in ["#123junk", "#123456\n", "#１２３", "red", "var(--app-accent)", "#12", "#123456789", "#gggggg"] {
            XCTAssertNil(HushhNativeControlAppearance(appearance: "dark", accentHex: bad, foregroundHex: "#445566"))
            XCTAssertNil(HushhNativeControlAppearance(appearance: "light", accentHex: "#123456", foregroundHex: bad))
        }
        XCTAssertNil(HushhNativeControlAppearance(appearance: "system", accentHex: "#123456", foregroundHex: "#445566"))
        XCTAssertNil(HushhNativeControlAppearance(appearance: "light", accentHex: nil, foregroundHex: "#445566"))
    }
    func testNativeChromeLeaseRejectsStaleOwnerDocumentAndDuplicateChoices() {
        var state = HushhNativeChromeState()
        let first = HushhNativeChromeState.Identity(document: "a", ownerEpoch: "owner-a", revision: 1)
        XCTAssertTrue(state.prepare(first))
        XCTAssertFalse(state.confirm(first, sequence: 1, latestSequence: 1, allowed: true)) // prepared is not interactive
        XCTAssertTrue(state.activate(first))
        let otherControl = HushhNativeChromeState.Identity(document: "a", ownerEpoch: "owner-a", revision: 1,
                                                          controlId: "chat-agent-surface")
        XCTAssertFalse(state.activate(otherControl))
        XCTAssertFalse(state.confirm(otherControl, sequence: 1, latestSequence: 1, allowed: true))
        XCTAssertFalse(state.confirm(first, sequence: 1, latestSequence: 1, allowed: false)) // privacy/overlay guard
        XCTAssertTrue(state.confirm(first, sequence: 1, latestSequence: 1, allowed: true))
        XCTAssertFalse(state.confirm(first, sequence: 1, latestSequence: 1, allowed: true))
        let replacement = HushhNativeChromeState.Identity(document: "a", ownerEpoch: "owner-a", revision: 2)
        XCTAssertFalse(state.prepareBackReplacement(replacement, previousRevision: 0))
        XCTAssertFalse(state.prepareBackReplacement(.init(document: "a", ownerEpoch: "owner-b", revision: 2), previousRevision: 1))
        XCTAssertFalse(state.prepareBackReplacement(.init(document: "b", ownerEpoch: "owner-a", revision: 2), previousRevision: 1))
        XCTAssertEqual(state.identity, first) // Refusal must not overwrite the predecessor.
        XCTAssertTrue(state.prepareBackReplacement(replacement, previousRevision: 1))
        XCTAssertFalse(state.confirm(first, sequence: 2, latestSequence: 2, allowed: true))
        XCTAssertFalse(state.confirm(replacement, sequence: 2, latestSequence: 2, allowed: true))
        XCTAssertTrue(state.activate(replacement))
        let next = HushhNativeChromeState.Identity(document: "a", ownerEpoch: "owner-b", revision: 3)
        XCTAssertTrue(state.prepare(next))
        XCTAssertFalse(state.activate(first))
        XCTAssertTrue(state.activate(next))
        XCTAssertFalse(state.retire(.init(document: "a", ownerEpoch: "owner-a", revision: 100), targetRevision: 1))
        XCTAssertEqual(state.phase, "active") // old failure cannot remove a replacement
        XCTAssertFalse(state.confirm(first, sequence: 2, latestSequence: 2, allowed: true))
        XCTAssertTrue(state.retire(.init(document: "a", ownerEpoch: "owner-b", revision: 4)))
        XCTAssertFalse(state.prepare(next)) // late uncertain preparation cannot resurrect a retired view
        XCTAssertTrue(state.prepare(.init(document: "b", ownerEpoch: "owner-b", revision: 1)))
        XCTAssertFalse(state.prepare(.init(document: "a", ownerEpoch: "owner-a", revision: 99)))
        state.invalidate()
        XCTAssertFalse(state.activate(next))

        // History shares the state machine, not Back's presentation identity.
        let history = HushhNativeChromeState.Identity(document: "c", ownerEpoch: "owner-a", revision: 1,
                                                       controlId: "chat-history-toggle")
        let historyNext = HushhNativeChromeState.Identity(document: "c", ownerEpoch: "owner-a", revision: 2,
                                                           controlId: "chat-history-toggle")
        XCTAssertTrue(state.prepare(history))
        XCTAssertFalse(state.prepareHistoryReplacement(historyNext, previousRevision: 1)) // prepared only
        XCTAssertTrue(state.activate(history))
        XCTAssertFalse(state.prepareBackReplacement(historyNext, previousRevision: 1)) // wrong family
        XCTAssertFalse(state.prepareHistoryReplacement(.init(document: "c", ownerEpoch: "other", revision: 2,
            controlId: "chat-history-toggle"), previousRevision: 1))
        XCTAssertFalse(state.prepareHistoryReplacement(.init(document: "d", ownerEpoch: "owner-a", revision: 2,
            controlId: "chat-history-toggle"), previousRevision: 1))
        XCTAssertEqual(state.identity, history)
        XCTAssertTrue(state.prepareHistoryReplacement(historyNext, previousRevision: 1))
        XCTAssertFalse(state.confirm(history, sequence: 3, latestSequence: 3, allowed: true))
        XCTAssertFalse(state.confirm(historyNext, sequence: 3, latestSequence: 3, allowed: true))
        XCTAssertTrue(state.activate(historyNext))
        XCTAssertTrue(state.confirm(historyNext, sequence: 3, latestSequence: 3, allowed: true))
        XCTAssertFalse(state.confirm(historyNext, sequence: 3, latestSequence: 3, allowed: true))

        let profile = HushhNativeChromeState.Identity(document: "e", ownerEpoch: "owner-a", revision: 1,
                                                     controlId: "profile-back")
        let profileNext = HushhNativeChromeState.Identity(document: "e", ownerEpoch: "owner-a", revision: 2,
                                                         controlId: "profile-back")
        XCTAssertTrue(state.prepare(profile))
        XCTAssertFalse(state.prepareBackReplacement(profileNext, previousRevision: 1)) // not active
        XCTAssertTrue(state.activate(profile))
        XCTAssertFalse(state.prepareBackReplacement(.init(document: "e", ownerEpoch: "owner-a", revision: 2),
                                                    previousRevision: 1)) // shell cannot inherit Profile's slot
        XCTAssertFalse(state.prepareBackReplacement(.init(document: "e", ownerEpoch: "owner-b", revision: 2,
            controlId: "profile-back"), previousRevision: 1))
        XCTAssertFalse(state.prepareHistoryReplacement(profileNext, previousRevision: 1))
        XCTAssertEqual(state.identity, profile)
        XCTAssertTrue(state.prepareBackReplacement(profileNext, previousRevision: 1))
        XCTAssertFalse(state.confirm(profile, sequence: 4, latestSequence: 4, allowed: true))
        XCTAssertFalse(state.confirm(profileNext, sequence: 4, latestSequence: 4, allowed: true))
        XCTAssertTrue(state.activate(profileNext))
        XCTAssertTrue(state.confirm(profileNext, sequence: 4, latestSequence: 4, allowed: true))
    }

    func testNativeChromeUpdatesFenceOldChoicesWithoutReplacingTheInstallation() {
        var state = HushhNativeChromeState()
        let identity = HushhNativeChromeState.Identity(document: "a", ownerEpoch: "owner-a", revision: 1)
        XCTAssertTrue(state.prepare(identity))
        XCTAssertFalse(state.update(identity, sequence: 1))
        XCTAssertTrue(state.activate(identity))
        XCTAssertTrue(state.update(identity, sequence: 2))
        XCTAssertFalse(state.update(identity, sequence: 1))
        XCTAssertEqual(state.identity, identity)
        XCTAssertFalse(state.confirm(identity, sequence: 1, latestSequence: 1, allowed: true))
        XCTAssertFalse(state.confirm(identity, sequence: 1, latestSequence: 1, allowed: true, updateSequence: 1))
        XCTAssertTrue(state.confirm(identity, sequence: 1, latestSequence: 1, allowed: true, updateSequence: 2))
        XCTAssertFalse(state.confirm(identity, sequence: 1, latestSequence: 1, allowed: true, updateSequence: 2))
        state.invalidate()
        XCTAssertFalse(state.update(identity, sequence: 3))
    }

    func testPublicPreferenceConfigurationRejectsUnknownValuesAndAuthoredOptions() {
        for value in ["light", "dark", "system"] {
            XCTAssertNotNil(HushhChromeConfiguration.parse(kind: "appearance", value: value, options: nil, minimum: nil, maximum: nil))
        }
        let accent = HushhChromeConfiguration.parse(kind: "accent", value: "blue",
            options: [["value": "unknown", "label": "Untrusted label"]], minimum: nil, maximum: nil)
        XCTAssertEqual(accent?.options.map(\.value), ["blue", "gold"])
        for kind in ["appearance", "accent"] {
            for value: String? in [nil, "unknown"] {
                XCTAssertNil(HushhChromeConfiguration.parse(kind: kind, value: value, options: nil, minimum: nil, maximum: nil))
            }
        }
    }

    func testRejectedChromePreparationPreservesActiveOptionsAndDateBounds() {
        var state = HushhNativeChromeState()
        var configuration = HushhChromeConfiguration()
        let active = HushhNativeChromeState.Identity(document: "a", ownerEpoch: "owner-a", revision: 20)
        let admitted = HushhChromeConfiguration.parse(kind: "selection", value: "current",
            options: [["value": "current", "label": "Current"]], minimum: nil, maximum: nil)
        XCTAssertTrue(configuration.prepare(active, parsed: admitted, state: &state))
        XCTAssertTrue(state.activate(active))
        let stale = HushhNativeChromeState.Identity(document: "a", ownerEpoch: "owner-a", revision: 19)
        let replacement = HushhChromeConfiguration.parse(kind: "selection", value: "stale",
            options: [["value": "stale", "label": "Stale"]], minimum: nil, maximum: nil)
        XCTAssertFalse(configuration.prepare(stale, parsed: replacement, state: &state))
        XCTAssertEqual(configuration.options.map(\.value), ["current"])
        XCTAssertEqual(state.identity, active)
        XCTAssertEqual(state.phase, "active")

        let dateIdentity = HushhNativeChromeState.Identity(document: "a", ownerEpoch: "owner-a", revision: 21)
        let date = HushhChromeConfiguration.parse(kind: "date", value: "2026-10-05", options: nil,
            minimum: "2026-10-01", maximum: "2026-10-31")
        XCTAssertTrue(configuration.prepare(dateIdentity, parsed: date, state: &state))
        XCTAssertTrue(state.activate(dateIdentity))
        let bounds = configuration.dateBounds
        let invalid = HushhChromeConfiguration.parse(kind: "date", value: "2026-02-30", options: nil,
            minimum: "2026-10-01", maximum: "2026-10-31")
        let newer = HushhNativeChromeState.Identity(document: "a", ownerEpoch: "owner-a", revision: 22)
        XCTAssertNil(invalid)
        XCTAssertFalse(configuration.prepare(newer, parsed: invalid, state: &state))
        XCTAssertEqual(configuration.dateBounds, bounds)
        XCTAssertEqual(state.identity, dateIdentity)
        XCTAssertEqual(state.phase, "active")
    }

    func testNativeNavigationRequiresCompleteBundledTemplateArtwork() throws {
        let items = try XCTUnwrap(HushhNativeNavigationArtwork.items())
        XCTAssertEqual(items.map(\.accessibilityIdentifier), HushhNativeNavigationState.tabs.map { "one-native-tab-\($0)" })
        for item in items {
            for image in [item.image, item.selectedImage] {
                let image = try XCTUnwrap(image)
                XCTAssertEqual(image.renderingMode, .alwaysTemplate)
                XCTAssertEqual(image.size, CGSize(width: 24, height: 24))
            }
        }
        // Negative control: one missing state must prevent native admission,
        // not produce a blank tab or silently restore a different SF glyph.
        XCTAssertNil(HushhNativeNavigationArtwork.items { name in
            name == "HushhNav-connect-selected" ? nil : UIImage(named: name)
        })
    }

    func testNativeNavigationRejectsStaleUnknownAndRetiredDocumentStates() {
        var state = HushhNativeNavigationState()
        XCTAssertTrue(state.apply(document: "first", revision: 1, visible: true, selected: "chat"))
        XCTAssertTrue(state.acceptsTap("dashboard", appIsActive: true, shielded: false, keyboardVisible: false))
        XCTAssertTrue(state.apply(document: "first", revision: 3, visible: false, selected: "feed"))
        XCTAssertFalse(state.apply(document: "first", revision: 2, visible: true, selected: "chat"))
        XCTAssertFalse(state.apply(document: "first", revision: 4, visible: true, selected: "arbitrary-route"))
        XCTAssertFalse(state.acceptsTap("chat", appIsActive: true, shielded: false, keyboardVisible: false))
        state.retireDocument()
        XCTAssertFalse(state.apply(document: "first", revision: 5, visible: true, selected: "chat"))
        XCTAssertTrue(state.apply(document: "second", revision: 1, visible: true, selected: "dashboard"))
        XCTAssertFalse(state.acceptsTap("chat", appIsActive: false, shielded: false, keyboardVisible: false))
        XCTAssertFalse(state.acceptsTap("chat", appIsActive: true, shielded: true, keyboardVisible: false))
        XCTAssertFalse(state.acceptsTap("chat", appIsActive: true, shielded: false, keyboardVisible: true))
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

    func testNativeReviewerCredentialsNeverComeFromLaunchArguments() {
        let launch = NativeTestConfiguration(arguments: [
            "App", "-UITestMode", "-UITestVaultPassphrase", "synthetic-argument-value",
        ], environment: [:])
        XCTAssertNil(launch.vaultPassphrase)
        let environment = ["HUSHH_UI_TEST_REVIEWER_VAULT_PASSPHRASE": " synthetic memory value "]
        let admitted = NativeTestConfiguration(arguments: ["App", "-UITestMode"], environment: environment)
        XCTAssertEqual(admitted.vaultPassphrase, " synthetic memory value ")
        let ordinary = NativeTestConfiguration(arguments: ["App"], environment: environment)
        XCTAssertNil(ordinary.vaultPassphrase)
        XCTAssertFalse(ordinary.injectedScript.contains("synthetic memory value"))
    }

    func testNativeUiFlowConfigurationRequiresExplicitTestMode() {
        let ordinaryLaunch = NativeTestConfiguration(arguments: [
            "App",
            "--hushh-vault-layout-diagnostics",
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
        XCTAssertFalse(ordinaryLaunch.autoReviewerLogin)
        XCTAssertNil(ordinaryLaunch.vaultPassphrase)
        XCTAssertNil(ordinaryLaunch.expectedUserId)
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

    func testPrivacyCannotUncoverBeforeEveryOwnedPresenterRetires() {
        var state = HushhSessionPrivacyState()
        let normal = state.beginPresentationRetirement()
        XCTAssertTrue(state.completePresentationRetirement(normal))
        XCTAssertFalse(state.shouldPublishRetirementCompletion,
                       "Normal popup dismissal must not invalidate its pending choice")
        let first = state.beginPresentationRetirement()
        let second = state.beginPresentationRetirement()
        state.protectForAppInactive()
        XCTAssertTrue(state.shouldPublishRetirementCompletion,
                      "Shielded retirement must republish validation after actual dismissal")
        state.markAppActive()
        let generation = state.generation
        XCTAssertFalse(state.completeSessionValidation(generation: generation, appIsActive: true))
        XCTAssertFalse(state.completePresentationRetirement(UUID()))
        XCTAssertTrue(state.completePresentationRetirement(first))
        XCTAssertFalse(state.completePresentationRetirement(first))
        XCTAssertFalse(state.completeSessionValidation(generation: generation, appIsActive: true))
        XCTAssertTrue(state.shielded)
        XCTAssertTrue(state.completePresentationRetirement(second))
        XCTAssertTrue(state.completeSessionValidation(generation: generation, appIsActive: true))
        XCTAssertFalse(state.shielded)
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
