import Foundation
import XCTest

final class AppUITests: XCTestCase {
    /// UIKit's compact Back style uses Back rather than its previous page title.
    /// Keep queries inside the native navigation bar, with compatibility for
    /// installed labelled-back wrappers. Each journey still asserts its body.
    private func nativeProfileBack(_ app: XCUIApplication, parent: String) -> XCUIElement {
        app.navigationBars.buttons.matching(NSPredicate(format: "label IN %@", [parent, "Back"])).firstMatch
    }
    /// One authored credential-field locator across current Password copy and
    /// older wrappers. Never substitute the first unrelated secure field.
    private var authoredVaultPassphraseField: NSPredicate {
        NSPredicate(format: "label IN %@ OR placeholderValue IN %@ OR identifier IN %@",
            ["Vault password", "Vault passphrase", "Enter vault key", "Enter your password", "Enter your passphrase"],
            ["Enter password", "Enter passphrase", "Enter vault key", "Enter your password", "Enter your passphrase"],
            ["unlock-passphrase", "vault-key"])
    }
    /// Use the authored software-keyboard interruption, not an unqualified
    /// hardware Escape injection. This does not reset or navigate the session.
    private func dismissDockKeyboardThroughProfile(_ app: XCUIApplication, requireInterruption: Bool = false) -> Bool {
        let layout = app.buttons["native-vault-layout"].firstMatch
        func fields() -> [String: NSNumber]? {
            guard layout.exists, let raw = layout.value as? String, let data = raw.data(using: .utf8) else { return nil }
            return try? JSONSerialization.jsonObject(with: data) as? [String: NSNumber]
        }
        var afterSequence: Double?
        func dismissed() -> Bool {
            guard !softwareKeyboardIsOnscreen(app.keyboards.firstMatch, in: app) else { return false }
            guard layout.exists else { return !requireInterruption } // Established non-instrumented fallback.
            guard let fields = fields(), let guide = fields["nativeGuideHeight"],
                  let safeArea = fields["nativeBottomSafeArea"], let open = fields["kbOpen"],
                  let sequence = fields["sequence"],
                  afterSequence.map({ sequence.doubleValue > $0 }) ?? true else { return false }
            // AX can briefly omit the keyboard during a responder handoff.
            // Require independent system geometry and CSS completion too.
            return !open.boolValue && guide.doubleValue.isFinite && safeArea.doubleValue.isFinite &&
                guide.doubleValue <= safeArea.doubleValue + 1
        }
        guard requireInterruption || !dismissed() else { return true }
        let profile = app.buttons["Open Profile"].firstMatch
        guard waitForAdmittedControl(profile) else { return false }
        // Profile opening resigns the editor. Capture before that action,
        // not after closing an already keyboard-free drawer; the latter waits
        // for an unrelated future sample and falsely rejects settled geometry.
        afterSequence = fields()?["sequence"]?.doubleValue
        if requireInterruption && afterSequence == nil { return false }
        profile.tap()
        let close = app.buttons["Close Profile"].firstMatch
        guard waitForAdmittedControl(close) else { return false }
        close.tap()
        let hidden = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            dismissed()
        }, object: app)
        return XCTWaiter.wait(for: [hidden], timeout: 5) == .completed
    }

    private static func softwareKeyboardIsOnscreen(exists: Bool, frame: CGRect, window: CGRect) -> Bool {
        let coordinates = [frame.minX, frame.minY, frame.width, frame.height,
                           window.minX, window.minY, window.width, window.height]
        guard exists, !frame.isNull, !frame.isInfinite, !window.isNull, !window.isInfinite,
              coordinates.allSatisfy({ $0.isFinite }),
              frame.width > 0, frame.height > 0, window.width > 0, window.height > 0 else { return false }
        let visible = frame.intersection(window)
        return !visible.isNull && visible.width > 0 && visible.height > 0
    }

    private func softwareKeyboardIsOnscreen(_ keyboard: XCUIElement, in app: XCUIApplication) -> Bool {
        guard keyboard.exists else { return false }
        return Self.softwareKeyboardIsOnscreen(exists: true, frame: keyboard.frame, window: app.frame)
    }

    private func waitForSoftwareKeyboard(_ app: XCUIApplication) -> Bool {
        let keyboard = app.keyboards.firstMatch
        let visible = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            self.softwareKeyboardIsOnscreen(keyboard, in: app)
        }, object: keyboard)
        if XCTWaiter.wait(for: [visible], timeout: 10) == .completed { return true }
        // Geometry only: no labels, key values, draft or accessibility tree.
        let window = app.frame
        let keyboardFrame = keyboard.exists ? keyboard.frame : .zero
        for (source, frame) in [("window", window), ("keyboard", keyboardFrame),
                                ("intersection", keyboardFrame.intersection(window))] {
            let values = [frame.minX, frame.minY, frame.width, frame.height]
            let finite = values.allSatisfy { $0.isFinite }
            let bounded = values.map { $0.isFinite ? Int(max(-100_000, min(100_000, $0))) : 0 }
            print("NATIVE_KEYBOARD_GEOMETRY source=\(source) finite=\(finite) x=\(bounded[0]) y=\(bounded[1]) width=\(bounded[2]) height=\(bounded[3])")
        }
        return false
    }

    func testSoftwareKeyboardAdmissionRejectsOffscreenAccessibilityElements() {
        let window = CGRect(x: 0, y: 0, width: 390, height: 844)
        let visible = CGRect(x: 0, y: 611, width: 390, height: 233)
        XCTAssertFalse(Self.softwareKeyboardIsOnscreen(exists: true,
            frame: CGRect(x: 0, y: 922, width: 390, height: 233), window: window),
            "An existing offscreen keyboard must not qualify software-keyboard isolation")
        XCTAssertTrue(Self.softwareKeyboardIsOnscreen(exists: true, frame: visible, window: window))
        XCTAssertFalse(Self.softwareKeyboardIsOnscreen(exists: false, frame: visible, window: window))
        XCTAssertFalse(Self.softwareKeyboardIsOnscreen(exists: true, frame: .null, window: window))
        XCTAssertFalse(Self.softwareKeyboardIsOnscreen(exists: true, frame: .infinite, window: window))
        XCTAssertFalse(Self.softwareKeyboardIsOnscreen(exists: true, frame: .zero, window: window))
    }

    private var vaultUnlockSubmitted = false
    /// The session walk captures the vault gate with its keyboard up, before
    /// anything is typed (a stop the host screenshots).
    private var perfGateStop = false
    private var activeUiFlowRunId = ""

    private func printNativeControlStatuses(_ web: XCUIElement) {
        for control in ["chat-history-toggle", "chat-history-close", "profile-close", "profile-back", "chat-agent-surface"] {
            let status = web.descendants(matching: .any).matching(identifier: control == "chat-agent-surface" ? "native-selector-rehearsal-status" : "native-control-status-\(control)").firstMatch
            guard status.exists, status.label.hasPrefix("NATIVE_SELECTOR_STATUS ") else { continue }
            let raw = String(status.label.dropFirst("NATIVE_SELECTOR_STATUS ".count))
            guard raw.utf8.count <= 1024, let data = raw.data(using: .utf8),
                  let fields = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            let stage = fields["stage"] as? String ?? "other", outcome = fields["outcome"] as? String ?? "other"
            guard ["skip", "retire", "prepare", "activate", "update"].contains(stage),
                  ["pending", "acknowledged", "rejected"].contains(outcome) else { continue }
            let knownCodes = ["none", "other", "not-admitted", "focused", "geometry",
                "NATIVE_CHROME_ACK_UNCERTAIN", "NATIVE_CHROME_PREPARE_REFUSED",
                "NATIVE_CHROME_DOCUMENT_OR_GEOMETRY_STALE", "NATIVE_CHROME_OVERLAPPING_CONTROLS",
                "NATIVE_CHROME_OPTIONS_INVALID", "NATIVE_CHROME_LAYOUT_UNCONFIRMED", "NATIVE_CHROME_LAYOUT_RETIRED",
                "NATIVE_CHROME_ACTIVATE_REFUSED", "NATIVE_CHROME_ACTIVATE_UNCONFIRMED", "NATIVE_CHROME_RETIRE_UNCONFIRMED", "NATIVE_CHROME_RETIRE_STALE",
                "NATIVE_CHROME_UPDATE_INVALID", "NATIVE_CHROME_UPDATE_UNCONFIRMED", "NATIVE_CHROME_SUSPEND_REFUSED", "NATIVE_CHROME_SUSPEND_UNCONFIRMED"]
            let code = fields["code"] as? String ?? "other"
            guard knownCodes.contains(code) else { continue }
            print("NATIVE_CONTROL_STAGE control=\(control.replacingOccurrences(of: "-", with: "_")) stage=\(stage) outcome=\(outcome) code=\(code) eligible=\(fields["eligible"] as? Bool ?? false) allowed=\(fields["allowed"] as? Bool ?? false) focused=\(fields["focusInside"] as? Bool ?? false) held=\(fields["heldFocus"] as? Bool ?? false) in_viewport=\(fields["inViewport"] as? Bool ?? false)")
            if let choice = fields["choice"] as? String,
               ["none", "applied", "inactive", "disabled", "not-allowed", "update-pending", "identity-stale", "sequence-stale", "value-refused", "confirmation-refused", "isolation-changed", "uncertain"].contains(choice) {
                print("NATIVE_CONTROL_CHOICE control=\(control.replacingOccurrences(of: "-", with: "_")) outcome=\(choice)")
            }
            let guardKeys = ["overlayBlocked", "inertBlocked", "moving", "suppressed", "voiceBlocked", "documentHidden"]
            if guardKeys.allSatisfy({ fields[$0] is Bool }) {
                let flags = guardKeys.map { fields[$0] as? Bool == true ? "1" : "0" }.joined(separator: ",")
                print("NATIVE_CONTROL_GUARDS control=\(control.replacingOccurrences(of: "-", with: "_")) flags=\(flags)")
            }
        }
    }

    private func printPrivacyAdmission(_ app: XCUIApplication) {
        let cover = app.otherElements["session-privacy-shield"].firstMatch
        // The cover can retire between queries. Read one fallible snapshot;
        // optional diagnostics must not fail an otherwise admitted session.
        guard let snapshot = try? cover.snapshot(), let value = snapshot.value as? String,
              value.range(of: #"^NATIVE_PRIVACY_STATE shielded=(true|false) lifecycle_active=(true|false) application_active=(true|false) recovery_visible=(true|false) recovery_scheduled=(true|false) retirement_pending=(true|false)$"#,
                options: .regularExpression) != nil else { return }
        print(value) // No identity, document, credential or private body.
    }

    private func printCoherentPresentationAdmission(_ app: XCUIApplication) {
        printPrivacyAdmission(app)
        // Fixed authored identifiers/labels only. Never serialize a hierarchy,
        // profile identity, row label, draft or private presentation payload.
        for (kind, label) in [("view", "View photo"), ("options", "Photo options"),
            ("picker", "Take photo or choose from library"), ("heading", "Profile photo")] {
            let matches = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label))
            let first = matches.firstMatch
            print("PROFILE_PHOTO_ENTRY kind=\(kind) count=\(matches.count) role=\(first.exists ? first.elementType.rawValue : 0) hittable=\(first.exists && first.isHittable)")
        }
        for (name, label) in [("profile_close", "Close Profile"), ("agent_profile_close", "Close One profile"), ("profile_back", "Back in Profile"),
            ("history_close", "Close chat history"), ("profile_open", "Open Profile")] {
            let control = app.buttons[label].firstMatch
            print("COHERENT_CONTROL_ADMISSION control=\(name) present=\(control.exists) hittable=\(control.exists && control.isHittable) enabled=\(control.exists && control.isEnabled)")
        }
        for family in ["history", "profile", "agent-profile"] {
            let body = app.otherElements["native-\(family)-drawer-body"].firstMatch
            print("COHERENT_DRAWER_ADMISSION family=\(family.replacingOccurrences(of: "-", with: "_")) present=\(body.exists) hittable=\(body.exists && body.isHittable)")
        }
        for (name, control) in [("editor", app.textViews["native-dock-editor"].firstMatch),
            ("history", app.buttons["chat-history-toggle"].firstMatch),
            ("selector", app.segmentedControls["chat-agent-surface"].firstMatch),
            ("chat_tab", app.buttons["one-native-tab-chat"].firstMatch)] {
            print("COHERENT_SHELL_ADMISSION control=\(name) present=\(control.exists) hittable=\(control.exists && control.isHittable) enabled=\(control.exists && control.isEnabled)")
            if control.exists {
                let frame = control.frame
                if [frame.minX, frame.minY, frame.width, frame.height].allSatisfy({ $0.isFinite }) {
                    print("COHERENT_SHELL_FRAME control=\(name) x=\(Int(frame.minX.rounded())) y=\(Int(frame.minY.rounded())) width=\(Int(frame.width.rounded())) height=\(Int(frame.height.rounded()))")
                }
            }
        }
        // Public authored identity only: distinguish a duplicate AX projection
        // from a single control with an unusable activation point. Do not dump
        // the tree, row titles, private identity or editor contents.
        let historyMatches = app.buttons.matching(identifier: "chat-history-toggle")
        print("COHERENT_HISTORY_AX count=\(historyMatches.count)")
        for (index, candidate) in historyMatches.allElementsBoundByIndex.prefix(4).enumerated() {
            let frame = candidate.frame
            print("COHERENT_HISTORY_AX_ELEMENT index=\(index) hittable=\(candidate.isHittable) x=\(Int(frame.minX.rounded())) y=\(Int(frame.minY.rounded())) width=\(Int(frame.width.rounded())) height=\(Int(frame.height.rounded()))")
        }
        print("COHERENT_SHELL_ISOLATION privacy_cover=\(app.otherElements["session-privacy-shield"].exists) software_keyboard=\(softwareKeyboardIsOnscreen(app.keyboards.firstMatch, in: app))")
        for (name, label) in [("blue", "Blue"), ("gold", "Molten Gold")] {
            let matches = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label))
            let option = matches.firstMatch
            print("NATIVE_ACCENT_OPTION name=\(name) count=\(matches.count) role=\(option.exists ? option.elementType.rawValue : 0) hittable=\(option.exists && option.isHittable)")
        }
        let layout = app.buttons["native-vault-layout"].firstMatch
        if layout.exists, let raw = layout.value as? String, let data = raw.data(using: .utf8),
           let packet = try? JSONSerialization.jsonObject(with: data) as? [String: NSNumber] {
            let keys = ["profileOverlayBlocked", "profileInertBlocked", "profileMoving", "profileSuppressed", "profileVoiceBlocked", "profileDocumentHidden"]
            if keys.allSatisfy({ packet[$0] != nil }) {
                let flags = keys.map { packet[$0]!.boolValue ? "1" : "0" }.joined(separator: ",")
                print("NATIVE_PROFILE_GUARDS flags=\(flags)")
            }
        }
        for (name, label, identifier) in [("one_profile", "Open One profile", "public-one-profile-opener"),
                                         ("connectors", "Connectors", "native-history-row-connectors")] {
            let byLabel = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label))
            let byId = app.descendants(matching: .any).matching(identifier: identifier)
            let candidate = byLabel.firstMatch
            let observed = candidate.exists ? candidate.frame : .zero
            let frame = [observed.minX, observed.minY, observed.width, observed.height].allSatisfy({ $0.isFinite && abs($0) <= 10_000 }) ? observed : .zero
            print("COHERENT_PUBLIC_CONTROL name=\(name) label_count=\(byLabel.count) id_count=\(byId.count) role=\(candidate.exists ? candidate.elementType.rawValue : 0) hittable=\(candidate.exists && candidate.isHittable) x=\(Int(frame.minX)) y=\(Int(frame.minY)) width=\(Int(frame.width)) height=\(Int(frame.height))")
        }
        let probe = app.buttons["native-profile-back-admission"].firstMatch
        if let raw = probe.exists ? probe.value as? String : nil, raw.utf8.count <= 1024 {
            let fields = Dictionary(raw.split(separator: ";").compactMap { item -> (String, String)? in
                let pair = item.split(separator: "=", maxSplits: 1)
                return pair.count == 2 ? (String(pair[0]), String(pair[1])) : nil
            }, uniquingKeysWith: { _, newest in newest })
            for (control, prefix) in [("back", "pb"), ("close", "pc")] {
                if let count = Int(fields["\(prefix)Tap"] ?? ""), (0...1_000_000).contains(count),
                   let stage = fields["\(prefix)Stage"], ["none", "tap", "refused", "emitted", "confirmed", "confirmation-refused"].contains(stage) {
                    print("COHERENT_PROFILE_TAP control=\(control) count=\(count) stage=\(stage)")
                }
                if fields["\(prefix)Available"] == "0" {
                    print("COHERENT_PANE_HIT control=\(control) available=false")
                } else {
                    let keys = ["Available", "Layout", "Enabled", "Privacy", "Pane", "Admitted", "Allowed", "Isolated", "Hidden", "TouchBlocked", "AXHidden"]
                    if keys.allSatisfy({ ["0", "1"].contains(fields["\(prefix)\($0)"] ?? "") }),
                       let hit = fields["\(prefix)Hit"], ["target", "web", "drawer", "privacy", "navigation", "other", "none"].contains(hit) {
                        let bits = keys.map { "\($0)=\(fields["\(prefix)\($0)"]!)" }.joined(separator: " ")
                        print("COHERENT_PANE_HIT control=\(control) \(bits) hit=\(hit)")
                    }
                }
            }
            if let stage = fields["drawerCloseStage"], ["none", "emitted", "confirmed", "rejected"].contains(stage),
               ["drawerOpen", "drawerInteractive", "drawerAwaiting", "profileQueryOpen"].allSatisfy({ ["true", "false"].contains(fields[$0] ?? "") }),
               let depth = Int(fields["profileHistoryDepth"] ?? ""), (0...10000).contains(depth) {
                print("PROFILE_CLOSE_BOUNDARY stage=\(stage) open=\(fields["drawerOpen"]!) interactive=\(fields["drawerInteractive"]!) awaiting=\(fields["drawerAwaiting"]!) query_open=\(fields["profileQueryOpen"]!) depth=\(depth)")
            }
            if let projected = Int(fields["drawerProjectedDepth"] ?? ""), (-1...1).contains(projected),
               let path = Int(fields["drawerPathDepth"] ?? ""), (0...1).contains(path),
               let pending = fields["drawerChoicePending"], ["true", "false"].contains(pending) {
                print("PROFILE_STACK_BOUNDARY projected=\(projected) path=\(path) pending=\(pending)")
                if let appeared = fields["drawerAccountAppeared"], ["true", "false"].contains(appeared) {
                    print("PROFILE_ACCOUNT_APPEARED value=\(appeared)")
                }
            }
            let bits = ["hLayout", "hPending", "hEnabled", "hDocument", "hPrivacy", "hViewport", "hAdmitted", "hAllowed", "hIsolated", "hPane", "hHidden", "hTouchBlocked", "hAXHidden"]
            if fields["hActive"] == "1", fields["hAvailable"] == "1",
               let sequence = Int(fields["hSeq"] ?? ""), (1...1_000_000).contains(sequence),
               let phase = fields["hPhase"], ["prepared", "active", "retiring", "retired", "idle", "unknown"].contains(phase),
               bits.allSatisfy({ ["0", "1"].contains(fields[$0] ?? "") }),
               let frame = fields["hFrame"], let hits = fields["hHits"] {
                let frameParts = frame.split(separator: ",", omittingEmptySubsequences: false)
                let dimensions = frameParts.compactMap { Int($0) }
                let pairs = hits.split(separator: ",", omittingEmptySubsequences: false)
                    .map { $0.split(separator: ">", omittingEmptySubsequences: false) }
                let roles = ["target", "web", "drawer", "privacy", "navigation", "other", "none"]
                if frameParts.count == 4, dimensions.count == 4, dimensions.allSatisfy({ abs($0) <= 10_000 }),
                   pairs.count == 5, pairs.allSatisfy({ $0.count == 2 && $0.allSatisfy({ roles.contains(String($0)) }) }) {
                    let flags = bits.map { "\($0)=\(fields[$0]!)" }.joined(separator: " ")
                    let publicFrame = dimensions.map(String.init).joined(separator: ",")
                    let publicHits = pairs.map { $0.map(String.init).joined(separator: ">") }.joined(separator: ",")
                    print("COHERENT_NATIVE_HIT seq=\(sequence) phase=\(phase) \(flags) frame=\(publicFrame) hits=\(publicHits)")
                }
            }
            if let level = Int(fields["profilePaneLevel"] ?? ""), (0...2).contains(level) {
                print("COHERENT_PROFILE_LOCATION level=\(level)")
            }
            let choiceOutcomes = ["none", "applied", "inactive", "disabled", "not-allowed", "update-pending", "identity-stale",
                "sequence-stale", "value-refused", "confirmation-refused", "isolation-changed", "uncertain"]
            let backPresent = fields["present"] ?? (fields["pbAvailable"] == "1" ? "true" : "false")
            for (control, prefix, present) in [("back", "profileBack", backPresent), ("close", "profileClose", fields["profileClosePresent"])] {
                if let choice = fields["\(prefix)Choice"], choiceOutcomes.contains(choice),
                   let allowed = fields["\(prefix)Allowed"], ["true", "false"].contains(allowed),
                   let present, ["true", "false"].contains(present) {
                    print("COHERENT_PROFILE_CHOICE control=\(control) outcome=\(choice) allowed=\(allowed) present=\(present)")
                }
            }
            let stage = fields["stage"] ?? "none", outcome = fields["outcome"] ?? "none", code = fields["code"] ?? "none"
            guard ["none", "skip", "retire", "prepare", "activate", "update"].contains(stage),
                  ["none", "pending", "acknowledged", "rejected"].contains(outcome),
                  ["none", "other", "not-admitted", "focused", "geometry"].contains(code) || code.hasPrefix("NATIVE_CHROME_") && code.allSatisfy({ $0.isUppercase || $0 == "_" }),
                  ["present", "focused", "inert"].allSatisfy({ ["true", "false"].contains(fields[$0] ?? "") }),
                  let width = Int(fields["width"] ?? ""), let height = Int(fields["height"] ?? ""), let top = Int(fields["top"] ?? ""),
                  [width, height, top].allSatisfy({ abs($0) <= 10_000 }) else { return }
            print("COHERENT_BACK_ADMISSION stage=\(stage) outcome=\(outcome) code=\(code) present=\(fields["present"]!) focused=\(fields["focused"]!) inert=\(fields["inert"]!) width=\(width) height=\(height) top=\(top)")
            let historyStage = fields["historyStage"] ?? "none", historyOutcome = fields["historyOutcome"] ?? "none"
            let historyCode = fields["historyCode"] ?? "none"
            let historyChoice = fields["historyChoice"] ?? "none", historyNative = fields["historyNative"] ?? "none"
            if ["none", "skip", "retire", "prepare", "activate", "update"].contains(historyStage),
               ["none", "pending", "acknowledged", "rejected"].contains(historyOutcome),
               ["none", "other", "NATIVE_CHROME_ACK_UNCERTAIN", "NATIVE_CHROME_RETIRE_STALE", "NATIVE_CHROME_RETIRE_UNCONFIRMED", "NATIVE_CHROME_SUSPEND_REFUSED", "NATIVE_CHROME_SUSPEND_UNCONFIRMED"].contains(historyCode),
               ["none", "applied", "inactive", "disabled", "not-allowed", "update-pending", "identity-stale", "sequence-stale", "value-refused", "confirmation-refused", "isolation-changed", "uncertain"].contains(historyChoice),
               ["none", "tap", "refused", "emitted", "confirmed", "confirmation-refused"].contains(historyNative),
               ["historyAllowed", "historyPresent", "historyInert"].allSatisfy({ ["true", "false"].contains(fields[$0] ?? "") }) {
                print("COHERENT_HISTORY_TRACE stage=\(historyStage) outcome=\(historyOutcome) code=\(historyCode) choice=\(historyChoice) native=\(historyNative) allowed=\(fields["historyAllowed"]!) present=\(fields["historyPresent"]!) inert=\(fields["historyInert"]!)")
            }
        }
    }

    private func historyTapCount(_ app: XCUIApplication) -> Int? {
        let probe = app.buttons["native-profile-back-admission"].firstMatch
        guard probe.exists, let raw = probe.value as? String, raw.utf8.count <= 1024,
              let field = raw.split(separator: ";").first(where: { $0.hasPrefix("historyTaps=") }),
              let count = Int(field.dropFirst("historyTaps=".count)), (0...1_000_000).contains(count) else { return nil }
        return count
    }

    private func waitForAdmittedControl(_ control: XCUIElement) -> Bool {
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            control.exists && control.isHittable && control.isEnabled
        }, object: control)
        return XCTWaiter.wait(for: [ready], timeout: 10) == .completed
    }

    private func printSupportControlAdmission(_ app: XCUIApplication) {
        for (name, id) in [("message", "native-support-message"), ("cancel", "native-support-cancel"),
                           ("send", "native-support-send"), ("kinds", "native-support-kind"), ("scene", "native-support-scene")] {
            let controls = app.descendants(matching: .any).matching(identifier: id)
            let control = controls.firstMatch
            print("PROFILE_SUPPORT_AX name=\(name) count=\(min(32, controls.count)) role=\(control.exists ? Int(control.elementType.rawValue) : 0) hittable=\(control.exists && control.isHittable) enabled=\(control.exists && control.isEnabled)")
        }
    }

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

    override func record(_ issue: XCTIssue) {
        if name.contains("testLocalSessionProfileBackAcrossTheSettingsStack") {
            // Framework exceptions need source/type diagnostics too. Never
            // print assertion operands, labels, drafts or an AX hierarchy.
            let location = issue.sourceCodeContext.location
            let line = location?.fileURL.lastPathComponent == "AppUITests.swift" ? location?.lineNumber ?? 0 : 0
            print("PROFILE_RUNNER_ISSUE type=\(issue.type.rawValue) line=\(min(100_000, max(0, line)))")
            let text = issue.compactDescription.lowercased()
            let reason = text.contains("scroll") ? "scroll" : text.contains("snapshot") ? "snapshot" :
                text.contains("matching") || text.contains("no matches") ? "matching" : text.contains("hittable") ? "hit" :
                text.contains("timed out") || text.contains("timeout") ? "timeout" : text.contains("assert") ? "assertion" : "other"
            print("PROFILE_RUNNER_REASON kind=\(reason)")
        }
        super.record(issue)
    }

    /// Public fixture only. Installation/launch is preparation; this journey
    /// attaches without resetting, authenticating or navigating the WebView.
    func testLocalNativeHistoryCompositionQualification() throws {
        guard let (app, fixture) = try attachPublicNativeHistoryQualification() else { return }
        let open = app.buttons["qualification-history-open"].firstMatch
        let close = app.buttons["qualification-history-close"].firstMatch
        let dock = app.descendants(matching: .any).matching(identifier: "qualification-dock").firstMatch
        let exit = app.buttons["qualification-exit"].firstMatch
        guard waitForAdmittedControl(open), waitForAdmittedControl(exit), dock.exists else {
            XCTFail("QUALIFICATION_BASE_INCOMPLETE"); return
        }
        app.buttons["qualification-reset"].tap()
        let initialOpen = open.frame, initialDock = dock.frame
        XCTAssertGreaterThanOrEqual(initialOpen.width, 44)
        XCTAssertGreaterThanOrEqual(initialOpen.height, 44)
        XCTAssertEqual(app.buttons.matching(identifier: "qualification-history-open").count, 1)
        XCTAssertEqual(app.textViews.matching(identifier: "native-dock-editor").count, 1,
            "The study reuses one retained editor, not another implementation")
        XCTAssertFalse(app.webViews.textFields["Message One"].firstMatch.isHittable,
            "The underlying product composer cannot be interactive in a public study")

        let system = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let exerciseDrawers = { [self] (cycles: Int) in
            for cycle in 0..<cycles {
                guard waitForAdmittedControl(open) else {
                    XCTFail("QUALIFICATION_OPEN_NOT_RESTORED"); return
                }
                // Alternate center and edges. A retained control must remain usable,
                // not merely exist after an earlier successful center tap.
                // A system banner can cover this header despite AX reporting it
                // hittable. Wait for retirement rather than replay an uncertain tap.
                guard system.otherElements["NotificationShortLookView"].firstMatch.waitForNonExistence(timeout: 10) else {
                    XCTFail("QUALIFICATION_INTERRUPTED_BY_SYSTEM_BANNER"); return
                }
                let x: CGFloat = cycle % 2 == 0 ? 0.5 : 0.15
                open.coordinate(withNormalizedOffset: CGVector(dx: x, dy: 0.5)).tap()
                guard waitForAdmittedControl(close) else {
                    XCTFail("QUALIFICATION_DRAWER_NOT_ADMITTED"); return
                }
                XCTAssertEqual(close.frame.minX, initialOpen.minX, accuracy: 1,
                    "History Close must occupy the opener's leading slot")
                XCTAssertEqual(close.frame.minY, initialOpen.minY, accuracy: 1)
                XCTAssertEqual(close.frame.width, initialOpen.width, accuracy: 1)
                XCTAssertEqual(close.frame.height, initialOpen.height, accuracy: 1)
                XCTAssertFalse(open.isHittable, "Covered base navigation must not receive touches")
                XCTAssertTrue(app.staticTexts["Synthetic conversations"].isHittable)
                if cycle % 2 == 0 {
                    // Hold a partial closing drag before releasing to spring back;
                    // this covers the reported failure, not only settled taps.
                    let start = fixture.coordinate(withNormalizedOffset: CGVector(dx: 0.65, dy: 0.55))
                    let middle = fixture.coordinate(withNormalizedOffset: CGVector(dx: 0.40, dy: 0.55))
                    start.press(forDuration: 0.05, thenDragTo: middle,
                        withVelocity: .slow, thenHoldForDuration: 0.3)
                    guard waitForAdmittedControl(close) else {
                        XCTFail("QUALIFICATION_SHORT_DRAG_LOST_DRAWER"); return
                    }
                }
                close.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: cycle % 2 == 0 ? 0.5 : 0.2)).tap()
                guard waitForAdmittedControl(open) else {
                    XCTFail("QUALIFICATION_CLOSE_LOST_BASE"); return
                }
                XCTAssertFalse(close.isHittable)
                XCTAssertEqual(open.frame.minX, initialOpen.minX, accuracy: 1)
                XCTAssertEqual(open.frame.minY, initialOpen.minY, accuracy: 1)
                XCTAssertEqual(dock.frame, initialDock)
                print("NATIVE_HISTORY_PUBLIC_CYCLE completed=\(cycle + 1)")
            }
        }
        // Functional repetition and rendered performance are separate evidence:
        // ten warm cycles, then three short measured gesture runs. AX queries
        // occur outside each signposted animation, never on its frame path.
        exerciseDrawers(10)
        if ProcessInfo.processInfo.environment["HUSHH_MEASURE_PUBLIC_QUALIFICATION"] == "true" {
            guard #available(iOS 26.0, *) else { throw XCTSkip("Native hitch measurement requires iOS 26") }
            let options = XCTMeasureOptions()
            options.iterationCount = 3
            measure(metrics: [XCTOSSignpostMetric(subsystem: "ai.hushh.native-study",
                category: "PointsOfInterest", name: "PublicDrawerMotion"), XCTHitchMetric(application: app)], options: options) {
                app.buttons["qualification-reset"].tap()
                exerciseDrawers(3)
            }
        }
        let editor = app.textViews["native-dock-editor"].firstMatch
        let emptySample = (editor.value as? String ?? "")
        guard waitForAdmittedControl(editor), emptySample.isEmpty || emptySample == "Message One" else {
            XCTFail("PUBLIC_EDITOR_REQUIRES_EMPTY_SAMPLE"); return
        }
        let sample = "Public sample 😀\nSecond line\nThird line\nFourth line\nFifth line\nSixth line\nSeventh line\nEighth line"
        editor.tap()
        editor.typeText(sample)
        XCTAssertTrue((editor.value as? String) == sample, "Unicode and newlines must survive one input operation")
        XCTAssertLessThanOrEqual(editor.frame.height, 144)
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.exists)
        XCTAssertLessThanOrEqual(editor.frame.maxY, keyboard.frame.minY,
            "The retained native editor must remain above the system keyboard")
        app.buttons["Talk"].firstMatch.tap()
        XCTAssertFalse(editor.isHittable)
        app.buttons["Message"].firstMatch.tap()
        guard waitForAdmittedControl(editor) else {
            XCTFail("PUBLIC_EDITOR_MODE_NOT_RESTORED"); return
        }
        XCTAssertTrue((editor.value as? String) == sample, "Mode changes must not erase the retained draft")
        open.tap()
        guard waitForAdmittedControl(close) else { XCTFail("PUBLIC_EDITING_DRAWER_NOT_ADMITTED"); return }
        XCTAssertFalse(editor.isHittable)
        close.tap()
        guard waitForAdmittedControl(editor) else { XCTFail("PUBLIC_EDITING_BASE_NOT_RESTORED"); return }
        XCTAssertTrue((editor.value as? String) == sample, "Drawer settlement must not replace the editor")
        XCTAssertFalse(app.buttons["Send message"].firstMatch.isEnabled,
            "A public study must not install product submission authority")
        guard let json = fixture.value as? String, let data = json.data(using: .utf8),
              let timings = try? JSONSerialization.jsonObject(with: data) as? [String: Double],
              let frames = timings["frames"], let over50 = timings["over50"],
              let maxFrame = timings["maxFrameMs"], let duration = timings["measuredMs"],
              frames > 0, duration > 0, [frames, over50, maxFrame, duration].allSatisfy({ $0.isFinite && $0 >= 0 }) else {
            XCTFail("PUBLIC_MOTION_MEASUREMENT_MISSING"); return
        }
        print("NATIVE_HISTORY_PUBLIC_FRAMES samples=\(Int(frames)) over50=\(Int(over50)) max_ms=\(maxFrame) measured_ms=\(duration)")
        XCTAssertEqual(over50, 0, "PUBLIC_MOTION_FRAME_OVER_50_MS")
        if ProcessInfo.processInfo.environment["HUSHH_CAPTURE_PUBLIC_QUALIFICATION"] == "true" {
            try auditPublicNativeHistoryAppearance(app, fixture: fixture)
        }
        // Keep the public fixture present for separate visual/performance review.
        // No automatic Exit can expose private Chat in a public recording.
    }

    /// A separate warm family journey keeps selector acceptance independent of
    /// drawer measurement. Neither ten-cycle gate is reduced or skipped.
    func testLocalNativeHistoryAgentSelectorQualification() throws {
        guard let (app, fixture) = try attachPublicNativeHistoryQualification() else { return }
        guard waitForAdmittedControl(fixture.buttons["qualification-reset"]) else {
            XCTFail("PUBLIC_AGENT_SELECTOR_RESET_UNAVAILABLE"); return
        }
        fixture.buttons["qualification-reset"].tap()
        let editor = fixture.textViews["native-dock-editor"].firstMatch
        guard waitForAdmittedControl(editor) else { XCTFail("PUBLIC_AGENT_EDITOR_NOT_ADMITTED"); return }
        let sample = "Public One/Puppy sample 😀"
        editor.tap()
        editor.typeText(sample)
        XCTAssertEqual(editor.value as? String, sample, "PUBLIC_AGENT_EDITOR_INPUT_NOT_RETAINED")
        let selector = fixture.segmentedControls["chat-agent-surface"].firstMatch
        let cloud = selector.buttons["One, your cloud agent"].firstMatch
        let puppy = selector.buttons["Puppy One"].firstMatch
        guard waitForAdmittedControl(cloud), waitForAdmittedControl(puppy) else {
            XCTFail("PUBLIC_AGENT_SELECTOR_NOT_ADMITTED"); return
        }
        for cycle in 0..<10 {
            puppy.tap()
            XCTAssertTrue(puppy.isSelected, "PUBLIC_AGENT_PUPPY_SELECTION_NOT_COMMITTED")
            cloud.tap()
            XCTAssertTrue(cloud.isSelected, "PUBLIC_AGENT_ONE_SELECTION_NOT_COMMITTED")
            XCTAssertEqual(app.textViews.matching(identifier: "native-dock-editor").count, 1,
                "PUBLIC_AGENT_DUPLICATE_EDITOR")
            XCTAssertEqual(editor.value as? String, sample, "PUBLIC_AGENT_SELECTOR_REPLACED_DRAFT")
            print("NATIVE_HISTORY_PUBLIC_SELECTOR_CYCLE completed=\(cycle + 1)")
        }
        XCTAssertFalse(fixture.buttons["Send message"].firstMatch.isEnabled,
            "PUBLIC_AGENT_STUDY_SUBMISSION_MUST_BE_DISABLED")
    }

    private func attachPublicNativeHistoryQualification() throws -> (XCUIApplication, XCUIElement)? {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_NATIVE_HISTORY_QUALIFICATION"] == "true" else {
            throw XCTSkip("Explicit public native composition qualification")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            XCTFail("QUALIFICATION_REQUIRES_PREPARED_RUNNING_APP"); return nil
        }
        // XCTest preparation can background the already installed application.
        // Activate that same process; never relaunch or reset its session here.
        app.activate()
        let fixture = app.otherElements["native-history-qualification"].firstMatch
        let launcher = app.buttons["native-history-qualification-launcher"].firstMatch
        // Runner preparation can interrupt the app and legitimately retire its
        // owned presentation. Re-entry is an explicit authored action, not a
        // privacy bypass, relaunch, or automatic resurrection.
        if !fixture.exists, waitForAdmittedControl(launcher) { launcher.tap() }
        guard fixture.waitForExistence(timeout: 10) else {
            XCTFail("QUALIFICATION_FIXTURE_NOT_ADMITTED"); return nil
        }
        return (app, fixture)
    }

    /// The actual contrast regression has its own bounded evidence path; a
    /// visual correction need not repeat already verified gesture/editor work.
    func testLocalNativeHistoryAppearanceAccessibilityQualification() throws {
        guard let (app, fixture) = try attachPublicNativeHistoryQualification() else { return }
        guard waitForAdmittedControl(fixture.buttons["qualification-reset"]) else {
            XCTFail("QUALIFICATION_PUBLIC_APPEARANCE_NOT_ADMITTED"); return
        }
        fixture.buttons["qualification-reset"].tap()
        let value = fixture.textViews["native-dock-editor"].firstMatch.value as? String ?? ""
        guard value.isEmpty || value == "Message One" else {
            XCTFail("PUBLIC_APPEARANCE_REQUIRES_EMPTY_SAMPLE"); return
        }
        try auditPublicNativeHistoryAppearance(app, fixture: fixture)
        print("NATIVE_HISTORY_PUBLIC_APPEARANCE states=4")
    }

    private func auditPublicNativeHistoryAppearance(_ app: XCUIApplication, fixture: XCUIElement) throws {
        // Collect the complete public matrix. Every audit issue still fails the
        // test; none is ignored or expected. This does not certify motion.
        continueAfterFailure = true
        defer { continueAfterFailure = false }
        for (theme, accent) in [("Light", "Blue"), ("Light", "Molten Gold"), ("Dark", "Blue"), ("Dark", "Molten Gold")] {
            fixture.buttons[theme].firstMatch.tap()
            fixture.buttons[accent].firstMatch.tap()
            guard fixture.exists, fixture.buttons["qualification-history-open"].isHittable,
                  fixture.descendants(matching: .any).matching(identifier: "qualification-dock").firstMatch.isHittable else {
                XCTFail("PUBLIC_CAPTURE_NOT_ISOLATED"); return
            }
            let attachment = XCTAttachment(screenshot: app.screenshot())
            attachment.name = "public-native-study-\(theme)-\(accent)"
            attachment.lifetime = .keepAlways
            add(attachment)
            if ProcessInfo.processInfo.environment["HUSHH_AUDIT_PUBLIC_QUALIFICATION"] == "true", #available(iOS 17.0, *) {
                try app.performAccessibilityAudit(for: [.contrast, .hitRegion,
                    .sufficientElementDescription, .trait, .textClipped, .dynamicType])
            }
        }
        fixture.buttons["Light"].firstMatch.tap()
        fixture.buttons["Blue"].firstMatch.tap()
    }

    func testLocalSessionAutomationAdmissionOnly() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_LOCAL_SESSION_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in credential-free attach-only runner admission")
        }
        print("NATIVE_AUTOMATION_TEST_BODY_ENTERED")
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            XCTFail("NATIVE_ADMISSION_REQUIRES_RUNNING_APP"); return
        }
        app.activate()
        // A valid native modal excludes the underlying WebView from AX.
        // Settle only authored recovery/dismissal layers before asking for
        // the host; its absence while covered is not a transport failure.
        print("NATIVE_ADMISSION_GATE privacy_cover=\(app.otherElements["session-privacy-shield"].exists) native_drawer=\(app.otherElements["native-private-drawer"].exists)")
        printPrivacyAdmission(app)
        if ProcessInfo.processInfo.environment["HUSHH_REHEARSAL_RETRY_PRIVACY"] == "true" {
            // An automatic authenticator prompt can keep the app inactive and
            // cover its fallback. Cancel only a recognized system prompt;
            // never select an unrelated alert or submit a device passcode.
            let system = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            let biometric = system.descendants(matching: .any).matching(NSPredicate(
                format: "label CONTAINS[c] %@ OR label == %@", "Face ID", "Unlock One"
            )).firstMatch.exists
            let passkey = system.descendants(matching: .any).matching(NSPredicate(
                format: "label CONTAINS[c] %@ OR label CONTAINS[c] %@", "Scan QR Code", "passkey"
            )).firstMatch.exists
            let cancel = system.buttons["Cancel"].firstMatch
            print("NATIVE_SYSTEM_METHOD biometric=\(biometric) passkey=\(passkey) cancel_hittable=\(cancel.exists && cancel.isHittable)")
            if (biometric || passkey) && cancel.exists && cancel.isHittable {
                cancel.tap()
                print("NATIVE_SYSTEM_METHOD_CANCELLED")
            }
            let cover = app.otherElements["session-privacy-shield"].firstMatch
            if cover.exists {
                let retry = app.buttons["session-privacy-retry"].firstMatch
                print("NATIVE_PRIVACY_RECOVERY_ENTRY cover_hittable=\(cover.isHittable) retry_present=\(retry.exists)")
                guard waitForAdmittedControl(retry) else {
                    printPrivacyAdmission(app)
                    XCTFail("PRIVACY_RECOVERY_UNAVAILABLE"); return
                }
                retry.tap()
                let released = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: cover)
                guard XCTWaiter.wait(for: [released], timeout: 20) == .completed else {
                    XCTFail("PRIVACY_RECOVERY_NOT_SETTLED"); return
                }
            }
            print("NATIVE_PRIVACY_RECOVERY_COMPLETED")
        }
        if ProcessInfo.processInfo.environment["HUSHH_REHEARSAL_RETURN_CHAT"] == "true" {
            returnToRehearsalChat(app)
        }
        let hosts = app.webViews.matching(identifier: "native-webview")
        if !hosts.firstMatch.waitForExistence(timeout: 15) {
            printCoherentPresentationAdmission(app)
            XCTFail("NATIVE_ADMISSION_HOST_UNAVAILABLE"); return
        }
        XCTAssertEqual(hosts.count, 1, "NATIVE_ADMISSION_HOST_COUNT_INVALID")
        let web = hosts.firstMatch
        if ProcessInfo.processInfo.environment["HUSHH_REHEARSAL_RETRY_VERIFICATION"] == "true" {
            let recovery = web.staticTexts["Reconnect to continue securely"].firstMatch
            if recovery.exists {
                // One bounded attempt through the security guard's authored
                // recovery. Never sign out or bypass account verification.
                let retries = web.buttons.matching(NSPredicate(format: "label == %@", "Try again"))
                guard retries.count == 1, waitForAdmittedControl(retries.firstMatch) else {
                    XCTFail("NATIVE_SESSION_VERIFICATION_RECOVERY_UNAVAILABLE"); return
                }
                retries.firstMatch.tap()
                let settled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: recovery)
                guard XCTWaiter.wait(for: [settled], timeout: 20) == .completed else {
                    XCTFail("NATIVE_SESSION_VERIFICATION_RECOVERY_NOT_SETTLED"); return
                }
                print("NATIVE_SESSION_VERIFICATION_RECOVERY requested=true settled=true")
            }
        }
        if ProcessInfo.processInfo.environment["HUSHH_REHEARSAL_EMPTY_DRAFT_PREPARATION"] == "true" {
            // Qualification changes launch configuration. Never discard an
            // owner's memory-only draft merely to prepare another renderer.
            // Inspect both authored editors in process; emit no contents.
            let nativeSelector = app.segmentedControls["chat-agent-surface"].firstMatch
            let nativeEditor = app.textViews["native-dock-editor"].firstMatch
            let native = nativeSelector.exists
            let cloud = native ? nativeSelector.buttons["One, your cloud agent"].firstMatch : web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "One, your cloud agent")).firstMatch
            let puppy = native ? nativeSelector.buttons["Puppy One"].firstMatch : web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Puppy One")).firstMatch
            let oneEditor = rehearsalChatComposer(app)
            func portReady(_ choice: XCUIElement, label: String) -> Bool {
                if !native { return true }
                let applied = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                    choice.exists && choice.isSelected && nativeEditor.exists && nativeEditor.isHittable && nativeEditor.label == label
                }, object: app)
                return XCTWaiter.wait(for: [applied], timeout: 10) == .completed
            }
            let editorReady = waitForAdmittedControl(oneEditor)
            let puppyReady = waitForAdmittedControl(puppy)
            print("NATIVE_PREPARATION_CONTROLS editor=\(editorReady) puppy=\(puppyReady)")
            guard editorReady && puppyReady && portReady(cloud, label: "Message One") else {
                XCTFail("NATIVE_PREPARATION_REQUIRES_ONE_CONTEXT"); return
            }
            func empty(_ field: XCUIElement) -> Bool {
                guard field.waitForExistence(timeout: 10), let value = field.value as? String else { return false }
                // A placeholder-like value is ambiguous; fail closed rather
                // than treating an owner's matching text as an empty draft.
                return value.isEmpty
            }
            let oneEmpty = empty(oneEditor)
            func attachmentPresent() -> Bool {
                ["Remove text attachment", "Remove selected Drive file", "Remove attachment"].contains {
                    app.buttons[$0].firstMatch.exists
                }
            }
            func actionPending() -> Bool {
                let cancel = app.descendants(matching: .any).matching(identifier: "native-agent-dock").firstMatch.buttons["Cancel"].firstMatch
                return (native && cancel.exists && cancel.isHittable) || ["Stop One", "Cancel recording", "Cancel voice command"].contains {
                    let control = app.buttons[$0].firstMatch
                    return control.exists && control.isHittable
                }
            }
            guard oneEmpty && !attachmentPresent() && !actionPending() else {
                XCTFail("NATIVE_PREPARATION_HAS_PENDING_ONE_DRAFT"); return
            }
            puppy.tap()
            defer {
                if cloud.exists && cloud.isHittable && (native ? !cloud.isSelected : !oneEditor.isHittable) {
                    cloud.tap()
                    XCTAssertTrue(portReady(cloud, label: "Message One"), "NATIVE_PREPARATION_ONE_RETURN_NOT_APPLIED")
                }
            }
            let puppyEditor = native ? nativeEditor : web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Message Puppy One")).firstMatch
            guard portReady(puppy, label: "Message Puppy"), empty(puppyEditor), !attachmentPresent(), !actionPending() else {
                XCTFail("NATIVE_PREPARATION_PUPPY_DRAFT_NOT_EMPTY_OR_UNAVAILABLE"); return
            }
            guard waitForAdmittedControl(cloud) else { XCTFail("NATIVE_PREPARATION_REQUIRES_ONE_CONTEXT"); return }
            cloud.tap()
            guard portReady(cloud, label: "Message One"), waitForAdmittedControl(oneEditor), empty(oneEditor) else {
                XCTFail("NATIVE_PREPARATION_HAS_PENDING_ONE_DRAFT"); return
            }
            print("NATIVE_PREPARATION_GATE empty_drafts=true attachments=false submitted=false")
        }
        printNativeControlStatuses(web)
        printCoherentPresentationAdmission(app)
        for identifier in ["native-dock-editor", "chat-history-toggle", "chat-history-close", "profile-close"] {
            let control = app.descendants(matching: .any).matching(identifier: identifier).firstMatch
            print("NATIVE_CONTROL_ADMISSION control=\(identifier.replacingOccurrences(of: "-", with: "_")) present=\(control.exists) hittable=\(control.exists && control.isHittable)")
            if ProcessInfo.processInfo.environment["HUSHH_RUN_RECOVERY_SMOKE"] == "true" {
                XCTAssertFalse(control.exists, "Recovery re-admitted an experimental native control")
            }
        }
        let continuity = app.buttons["native-panel-continuity"].firstMatch
        if let json = continuity.exists ? continuity.value as? String : nil,
           let data = json.data(using: .utf8),
           let packet = try? JSONSerialization.jsonObject(with: data) as? [String: Double],
           Set(packet.keys) == Set(["motionFrames", "staleFrames", "invalidSamples", "maxPoseAgeMs", "maxPoseAgeIntervals"]),
           packet.values.allSatisfy({ $0.isFinite && $0 >= 0 }) {
            print("NATIVE_PANEL_TIMING frames=\(Int(packet["motionFrames", default: 0])) stale=\(Int(packet["staleFrames", default: 0])) invalid=\(Int(packet["invalidSamples", default: 0])) max_age_ms=\(packet["maxPoseAgeMs", default: 0]) max_intervals=\(packet["maxPoseAgeIntervals", default: 0])")
        }
        let status = app.buttons["native-test-status"].firstMatch
        if let raw = status.exists ? status.value as? String : nil {
            let fields = Dictionary(raw.split(separator: ";").compactMap { item -> (String, String)? in
                let parts = item.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
                return parts.count == 2 ? (String(parts[0]), String(parts[1])) : nil
            }, uniquingKeysWith: { _, latest in latest })
            let route = fields["route"] ?? ""
            let routeKind = route == "/" || route == "/chat" || route.hasPrefix("/one/chat") ? "chat" : route == "/one" ? "one" : route.hasPrefix("/login") ? "login" : "other"
            let auth = fields["auth"] ?? ""
            let authKind = ["authenticated", "unauthenticated", "pending", "signed_in", "signed_out"].contains(auth) ? auth : "other"
            print("NATIVE_PUBLIC_SHELL_STATE route_kind=\(routeKind) auth_kind=\(authKind) editor_present=\(app.textViews["native-dock-editor"].exists) privacy_cover=\(app.otherElements["session-privacy-shield"].exists)")
        }
        // Optional owner admission is read-only: emit counts, never the account
        // label or hierarchy. This cannot authorize or submit an unlock.
        if let email = ProcessInfo.processInfo.environment["HUSHH_UI_TEST_REVIEWER_EMAIL"], !email.isEmpty {
            let ownerLabel = NSPredicate(format: "label == %@", email)
            print("NATIVE_REVIEWER_ADMISSION configured=true static_matches=\(web.staticTexts.matching(ownerLabel).count) exact_matches=\(web.descendants(matching: .any).matching(ownerLabel).count)")
        }
        let unlock = web.buttons["Unlock"].firstMatch
        let composer = web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Message One")).firstMatch
        let rejected = web.descendants(matching: .any).matching(NSPredicate(
            format: "label CONTAINS[c] %@", "That passphrase did not match"
        )).firstMatch
        let busy = web.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Unlocking")).firstMatch
        print("NATIVE_SESSION_STATE unlock=\(unlock.exists) unlock_hittable=\(unlock.exists && unlock.isHittable) composer=\(composer.exists) sign_in=\(web.buttons["Continue with Google"].exists)")
        // Runner admission alone is not reviewer admission. Classify authored
        // public entry states without dumping an accessibility tree or account
        // content when none of the protected-session markers is present.
        for (code, label) in [
            ("guest", "Create your One"),
            ("reconnect", "Reconnect to continue securely"),
            ("welcome_loading", "Preparing welcome…"),
            ("chat_loading", "Opening chat…"),
            ("passphrase_method", "Password"),
            ("passphrase_fallback", "Use password instead"),
        ] {
            let visible = web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch.exists
            print("NATIVE_ENTRY_STATE kind=\(code) present=\(visible)")
        }
        print("NATIVE_ENTRY_ALERTS count=\(app.alerts.count)")
        print("VAULT_GATE_STATE enabled=\(unlock.exists && unlock.isEnabled) rejected=\(rejected.exists) busy=\(busy.exists)")
        // Public gate shape only. A token/publication failure is not a wrong
        // passphrase; neither field values nor provider error text is read.
        let accessSetupFailure = web.descendants(matching: .any).matching(NSPredicate(
            format: "label CONTAINS %@", "Vault opened, but we could not complete access setup. Please try again."
        )).firstMatch.exists
        print("VAULT_GATE_NOTICE unlock_count=\(web.buttons.matching(NSPredicate(format: "label == %@", "Unlock")).count) access_setup_failure=\(accessSetupFailure)")
        // Public hit geometry separates a blocked fallback tap from credential
        // rejection. Never inspect field values or dump the private hierarchy.
        print("VAULT_GATE_ISOLATION privacy_cover=\(app.otherElements["session-privacy-shield"].exists)")
        for (name, control) in [("method", web.buttons["Passphrase"].firstMatch),
                                ("entry", web.secureTextFields.matching(authoredVaultPassphraseField).firstMatch)] {
            let bounds = control.exists ? control.frame : .zero
            print("VAULT_GATE_CONTROL name=\(name) present=\(control.exists) hittable=\(control.exists && control.isHittable) x=\(Int(bounds.minX.rounded())) y=\(Int(bounds.minY.rounded())) width=\(Int(bounds.width.rounded())) height=\(Int(bounds.height.rounded()))")
        }
        let publicReceipt = app.buttons["native-vault-layout"]
        if let raw = publicReceipt.exists ? publicReceipt.value as? String : nil,
           let data = raw.data(using: .utf8),
           let values = try? JSONSerialization.jsonObject(with: data) as? [String: NSNumber] {
            for key in ["dockOptIn", "chromeOptIn", "methodClicks", "methodPointerUps", "passphraseFields", "dockActive", "routeKind", "globalErrorKind", "phoneGate"] {
                if let value = values[key], value.doubleValue.isFinite, (0...100_000).contains(value.doubleValue) {
                    print("NATIVE_PUBLIC_ADMISSION key=\(key) value=\(value.intValue)")
                }
            }
        }
        if unlock.exists {
            // Credential-free clipping diagnosis: public geometry only, no
            // screenshots, field values, account text or accessibility dump.
            let entry = web.secureTextFields.matching(authoredVaultPassphraseField).firstMatch
            for (name, element) in [("window", app), ("web", web), ("keyboard", app.keyboards.firstMatch), ("entry", entry), ("unlock", unlock)] {
                let bounds = element.exists ? element.frame : .zero
                print("VAULT_GATE_GEOMETRY control=\(name) x=\(Int(bounds.minX.rounded())) y=\(Int(bounds.minY.rounded())) width=\(Int(bounds.width.rounded())) height=\(Int(bounds.height.rounded())) hittable=\(element.exists && element.isHittable)")
            }
        }
        reportNativeDockAdmission(app)
        print("NATIVE_AUTOMATION_ADMISSION_CONFIRMED")
    }

    func testLocalSessionVaultWholeValueEntryOnly() throws {
        let app = XCUIApplication()
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_LOCAL_SESSION_SMOKE"] == "true",
              [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state)
        else { throw XCTSkip("Requires the existing app session") }
        app.activate()
        returnToRehearsalChat(app)
        let field = app.webViews.secureTextFields.matching(authoredVaultPassphraseField).firstMatch
        let unlock = app.buttons.matching(NSPredicate(format: "label == %@", "Unlock"))
        guard waitForAdmittedControl(field), unlock.count == 1,
              !app.otherElements["session-privacy-shield"].exists else {
            XCTFail("SECURE_PUBLIC_PROBE_NOT_ADMITTED"); return
        }
        // Public synthetic input only; normal Unlock is never submitted. The
        // actual credential test reuses this same focus/clear acknowledgement.
        for fixture in ["fixture7", "probe#42"] {
            guard prepareEmptySecureEntry(field, app: app, unlockControls: unlock) else {
                XCTFail("SECURE_PUBLIC_PROBE_CLEAR_FAILED"); return
            }
            // Match the credential path: target the named secure field, not
            // the application-wide responder (which lost synthetic input).
            field.typeText(fixture)
            let inserted = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                (field.value as? String)?.utf16.count == fixture.utf16.count &&
                    unlock.count == 1 && unlock.firstMatch.isEnabled
            }, object: field)
            guard XCTWaiter.wait(for: [inserted], timeout: 3) == .completed else {
                print("SECURE_PUBLIC_PROBE complete=false keyboard=\(softwareKeyboardIsOnscreen(app.keyboards.firstMatch, in: app)) enabled=\(unlock.firstMatch.isEnabled)")
                // Counts are permitted only for this known public fixture,
                // never the reviewer credential or a previous entry.
                print("SECURE_PUBLIC_SAMPLE observed=\((field.value as? String)?.utf16.count ?? -1) expected=\(fixture.utf16.count)")
                let cleanup = prepareEmptySecureEntry(field, app: app, unlockControls: unlock)
                print("SECURE_PUBLIC_CLEANUP confirmed=\(cleanup)")
                XCTFail("SECURE_PUBLIC_PROBE_INSERTION_INCOMPLETE"); return
            }
        }
        guard prepareEmptySecureEntry(field, app: app, unlockControls: unlock) else {
            XCTFail("SECURE_PUBLIC_PROBE_CLEANUP_FAILED"); return
        }
        print("SECURE_PUBLIC_PROBE length_acknowledged=true samples=2 cleared=true submitted=false")
    }

    func testLocalSessionVaultUnlockOnly() throws {
        let app = XCUIApplication()
        let environment = ProcessInfo.processInfo.environment
        guard environment["HUSHH_RUN_LOCAL_SESSION_SMOKE"] == "true",
              [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state)
        else { throw XCTSkip("Requires the existing app session") }
        app.activate()
        // An existing unlocked session can be on One or a setup surface, not
        // Chat. Use only authored in-app navigation before deciding whether
        // the vault gate is present; no cold route or authentication bootstrap.
        returnToRehearsalChat(app)
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 15), "Vault WebView unavailable")
        let publicReceipt = app.buttons["native-vault-layout"]
        var receiptSequence = -1
        func reportReceipt(_ stage: String) {
            guard publicReceipt.exists else { return }
            guard let currentJSON = publicReceipt.value as? String,
                  let currentData = currentJSON.data(using: .utf8),
                  let current = try? JSONSerialization.jsonObject(with: currentData) as? [String: NSNumber],
                  let currentSequence = current["sequence"]?.intValue else {
                XCTFail("VAULT_PUBLIC_RECEIPT_UNAVAILABLE"); return
            }
            let stageSequence = max(receiptSequence, currentSequence)
            var observation: [String: NSNumber]?
            let fresh = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                guard let json = publicReceipt.value as? String, let data = json.data(using: .utf8),
                      let packet = try? JSONSerialization.jsonObject(with: data) as? [String: NSNumber],
                      let sequence = packet["sequence"]?.intValue, sequence > stageSequence,
                      packet["unlockClicks"] != nil, packet["unlockAccepted"] != nil else { return false }
                receiptSequence = sequence
                observation = packet
                return true
            }, object: publicReceipt)
            guard XCTWaiter.wait(for: [fresh], timeout: 5) == .completed, let packet = observation,
                  let clicks = packet["unlockClicks"]?.intValue,
                  let accepted = packet["unlockAccepted"]?.intValue,
                  (0...100000).contains(clicks), (0...100000).contains(accepted) else {
                XCTFail("VAULT_PUBLIC_RECEIPT_UNAVAILABLE"); return
            }
            let hit = packet["unlockHits"].map { $0.boolValue ? "hit" : "miss" } ?? "unknown"
            print("VAULT_PUBLIC_RECEIPT stage=\(stage) clicks=\(clicks) accepted=\(accepted) hit=\(hit)")
        }
        reportReceipt("before")
        defer { reportReceipt("after") }
        let unlock = web.buttons["Unlock"].firstMatch
        let composer = web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Message One")).firstMatch
        let nativeEditor = app.textViews["native-dock-editor"].firstMatch
        let signIn = web.buttons["Continue with Google"].firstMatch
        let passphraseMethod = web.buttons["Password"].firstMatch
        let passphraseFallback = web.buttons["Use password instead"].firstMatch
        // A newly installed iPad can expose WebKit before Firebase/vault
        // restoration settles. Absence of Unlock at that instant does not
        // prove admission; wait for an actual public gate or protected shell.
        let sessionReady = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            unlock.exists && unlock.isHittable || composer.exists && composer.isHittable || nativeEditor.exists && nativeEditor.isHittable || signIn.exists && signIn.isHittable ||
                passphraseMethod.exists && passphraseMethod.isHittable || passphraseFallback.exists && passphraseFallback.isHittable
        }, object: web)
        XCTAssertEqual(XCTWaiter.wait(for: [sessionReady], timeout: 30), .completed, "SESSION_ADMISSION_NOT_SETTLED")
        guard !signIn.exists else { XCTFail("SESSION_SIGN_IN_REQUIRED"); return }
        print("NATIVE_SESSION_STATE unlock=\(unlock.exists) unlock_hittable=\(unlock.exists && unlock.isHittable) composer=\(composer.exists) sign_in=\(signIn.exists)")
        if unlock.exists || (!composer.exists && (passphraseMethod.exists || passphraseFallback.exists)) {
            let email = environment["HUSHH_UI_TEST_REVIEWER_EMAIL"] ?? ""
            guard !email.isEmpty, web.staticTexts.matching(NSPredicate(format: "label == %@", email)).firstMatch.exists else {
                XCTFail("The visible vault account does not match the canonical reviewer; unlock was not submitted")
                return
            }
            guard attemptVaultPassphraseUnlock(app: app) else {
                XCTFail("Vault entry could not be completed; unlock was not submitted")
                return
            }
        }
        let rejected = web.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS[c] %@", "That passphrase did not match", "That password did not match")).firstMatch
        let settled = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            !unlock.exists || rejected.exists
        }, object: web)
        XCTAssertEqual(XCTWaiter.wait(for: [settled], timeout: 30), .completed, "Vault unlock did not settle")
        guard !rejected.exists, !unlock.exists else { XCTFail("Vault authentication rejected the complete entry"); return }
        let navigationReady = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            app.buttons["one-native-tab-chat"].exists || web.buttons["Chat"].exists
        }, object: app)
        XCTAssertEqual(XCTWaiter.wait(for: [navigationReady], timeout: 15), .completed, "SESSION_NAVIGATION_NOT_SETTLED")
        perfTapNav(app, label: "Chat")
        let protectedChat = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            composer.exists && composer.isHittable || nativeEditor.exists && nativeEditor.isHittable
        }, object: app)
        XCTAssertEqual(XCTWaiter.wait(for: [protectedChat], timeout: 15), .completed, "Protected Chat was not admitted")
        print("VAULT_UNLOCK_VERIFIED protected_chat=true")
    }

    func testLocalSessionVaultPublicLayoutWithKeyboard() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_LOCAL_SESSION_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in credential-free vault layout check")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            XCTFail("VAULT_LAYOUT_REQUIRES_RUNNING_APP"); return
        }
        app.activate()
        let web = app.webViews.matching(identifier: "native-webview").firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 15), "VAULT_LAYOUT_HOST_UNAVAILABLE")
        let entry = web.secureTextFields.matching(authoredVaultPassphraseField).firstMatch
        XCTAssertTrue(entry.waitForExistence(timeout: 30) && entry.isHittable, "VAULT_LAYOUT_ENTRY_CLIPPED")
        func assertFieldHitRegions() {
            XCTAssertGreaterThanOrEqual(entry.frame.height, 44, "VAULT_LAYOUT_ENTRY_TARGET_TOO_SMALL")
            let visibility = web.buttons.matching(NSPredicate(format: "label IN %@", ["Show password", "Show passphrase"])).firstMatch
            XCTAssertTrue(visibility.exists && visibility.isHittable, "VAULT_LAYOUT_VISIBILITY_CLIPPED")
            XCTAssertGreaterThanOrEqual(visibility.frame.width, 44, "VAULT_LAYOUT_VISIBILITY_TARGET_TOO_NARROW")
            XCTAssertGreaterThanOrEqual(visibility.frame.height, 44, "VAULT_LAYOUT_VISIBILITY_TARGET_TOO_SHORT")
        }
        assertFieldHitRegions()
        let probe = app.buttons["native-vault-layout"]
        func geometry() -> [String: NSNumber]? {
            guard probe.exists, let json = probe.value as? String,
                  let data = json.data(using: .utf8),
                  let packet = try? JSONSerialization.jsonObject(with: data) as? [String: NSNumber],
                  packet["presentCount"]?.intValue == 1 else { return nil }
            return packet
        }
        func settledGeometry(after sequence: Int, matchingHeight: Double? = nil) -> [String: NSNumber]? {
            var latestSequence = sequence
            var previous: [String: NSNumber]?
            var settled: [String: NSNumber]?
            let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                guard let packet = geometry(), let next = packet["sequence"]?.intValue, next > latestSequence,
                      ["innerHeight", "visualTop", "visualScale", "cssInset", "scrollTopEdge", "scrollBottomEdge", "scrollTop", "nativeGuideHeight", "nativeBottomSafeArea"].allSatisfy({ packet[$0] != nil }) else { return false }
                if let matchingHeight, abs((packet["innerHeight"]?.doubleValue ?? -1) - matchingHeight) > 1 { return false }
                latestSequence = next
                let comparable = packet.filter { $0.key != "sequence" }
                if let previous, NSDictionary(dictionary: comparable).isEqual(to: previous) {
                    settled = packet
                    return true
                }
                previous = comparable
                return false
            }, object: probe)
            XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 10), .completed, "VAULT_LAYOUT_PUBLIC_GEOMETRY_STALLED")
            return settled
        }
        func report(_ stage: String, packet: [String: NSNumber]?) {
            if let packet, let data = try? JSONSerialization.data(withJSONObject: packet, options: [.sortedKeys]),
               let json = String(data: data, encoding: .utf8) {
                print("VAULT_CSS_GEOMETRY stage=\(stage) packet=\(json)")
            }
            for (name, element) in [("entry", entry), ("unlock", web.buttons["Unlock"].firstMatch),
                                    ("recovery", web.buttons["Recovery key"].firstMatch),
                                    ("signout", web.buttons["Sign out"].firstMatch),
                                    ("keyboard", app.keyboards.firstMatch)] {
                let bounds = element.exists ? element.frame : .zero
                print("VAULT_LAYOUT stage=\(stage) control=\(name) x=\(Int(bounds.minX.rounded())) y=\(Int(bounds.minY.rounded())) width=\(Int(bounds.width.rounded())) height=\(Int(bounds.height.rounded())) hittable=\(element.exists && element.isHittable)")
            }
            for (name, label) in [("unlock", "Unlock"), ("recovery", "Recovery key"), ("signout", "Sign out")] {
                let matches = web.buttons.matching(NSPredicate(format: "label == %@", label)).allElementsBoundByIndex
                print("VAULT_LAYOUT_REACHABILITY stage=\(stage) control=\(name) count=\(matches.count) hittable=\(matches.contains { $0.isHittable })")
            }
        }
        let rest = settledGeometry(after: 0)
        guard let initialClicks = rest?["unlockClicks"]?.intValue,
              let initialAccepted = rest?["unlockAccepted"]?.intValue,
              let initialSequence = rest?["sequence"]?.intValue else {
            XCTFail("VAULT_LAYOUT_RECEIPT_UNAVAILABLE"); return
        }
        defer {
            if let latest = settledGeometry(after: initialSequence) {
                XCTAssertEqual(latest["unlockClicks"]?.intValue, initialClicks, "VAULT_LAYOUT_IDLE_PRODUCED_CLICK")
                XCTAssertEqual(latest["unlockAccepted"]?.intValue, initialAccepted, "VAULT_LAYOUT_IDLE_PRODUCED_ADMISSION")
            } else {
                XCTFail("VAULT_LAYOUT_RECEIPT_UNAVAILABLE")
            }
        }
        report("rest", packet: rest)
        entry.tap()
        // A connected hardware keyboard is a valid tablet state. Do not
        // confuse its absent software keyboard with a clipped vault form.
        _ = app.keyboards.firstMatch.waitForExistence(timeout: 3)
        let focused = settledGeometry(after: rest?["sequence"]?.intValue ?? 0)
        report("focused", packet: focused)
        let signOut = web.buttons.matching(NSPredicate(format: "label == %@", "Sign out"))
        func escapeReachable(_ packet: [String: NSNumber]?) -> Bool {
            guard let packet, packet["recoveryInside"]?.boolValue == true,
                  packet["recoveryHits"]?.boolValue == true,
                  let top = packet["scrollTopEdge"]?.doubleValue,
                  let bottom = packet["scrollBottomEdge"]?.doubleValue else { return false }
            return signOut.allElementsBoundByIndex.contains { element in
                element.isHittable && element.frame.minY >= web.frame.minY + top - 1 &&
                    element.frame.maxY <= web.frame.minY + bottom + 1
            }
        }
        func revealEscape(_ stage: String, after sequence: Int) -> [String: NSNumber]? {
            let beforeScroll = settledGeometry(after: sequence, matchingHeight: web.frame.height)
            if !escapeReachable(beforeScroll) {
                // Scroll inside the credential column, not the native host or a
                // background route. Do not invoke any recovery/account operation.
                guard let packet = beforeScroll, let top = packet["scrollTopEdge"]?.doubleValue,
                      let bottom = packet["scrollBottomEdge"]?.doubleValue,
                      let height = packet["innerHeight"]?.doubleValue,
                      bottom > top, height > 0 else { XCTFail("VAULT_LAYOUT_SCROLLPORT_UNKNOWN"); return nil }
                XCTAssertEqual(packet["visualScale"]?.doubleValue ?? -1, 1, accuracy: 0.01, "VAULT_LAYOUT_SCROLL_SCALE_UNKNOWN")
                XCTAssertEqual(packet["visualTop"]?.doubleValue ?? -1, 0, accuracy: 1, "VAULT_LAYOUT_SCROLL_OFFSET_UNKNOWN")
                XCTAssertEqual(height, web.frame.height, accuracy: 1, "VAULT_LAYOUT_SCROLL_COORDINATES_UNKNOWN")
                guard abs((packet["visualScale"]?.doubleValue ?? -1) - 1) <= 0.01,
                      abs(packet["visualTop"]?.doubleValue ?? -1) <= 1,
                      abs(height - web.frame.height) <= 1 else { return nil }
                let start = web.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: (top + (bottom - top) * 0.8) / height))
                let end = web.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: (top + (bottom - top) * 0.2) / height))
                start.press(forDuration: 0.05, thenDragTo: end)
            }
            let packet = settledGeometry(after: beforeScroll?["sequence"]?.intValue ?? sequence)
            report(stage, packet: packet)
            XCTAssertTrue(escapeReachable(packet), "VAULT_LAYOUT_RECOVERY_ESCAPE_UNREACHABLE")
            return packet
        }
        // Prove reachability while the observed keyboard is still present.
        // Accessibility can claim Sign out is tappable outside a DOM scroller.
        guard let revealed = revealEscape("scrolled", after: focused?["sequence"]?.intValue ?? 0) else { return }
        // Never submit Unlock or read/change the credential. Hide only the
        // system keyboard when available, after its avoidance has been checked.
        let hide = app.keyboards.buttons["Hide keyboard"].firstMatch
        if hide.exists && hide.isHittable { hide.tap() }
        let originalOrientation = XCUIDevice.shared.orientation
        defer { XCUIDevice.shared.orientation = originalOrientation }
        var sequence = revealed["sequence"]?.intValue ?? 0
        // The product's iPhone Info.plist admits portrait only; iPad admits both.
        let orientations: [(String, UIDeviceOrientation)] = UIDevice.current.userInterfaceIdiom == .pad
            ? [("portrait", .portrait), ("landscape", .landscapeLeft)] : [("portrait", .portrait)]
        for (stage, orientation) in orientations {
            XCUIDevice.shared.orientation = orientation
            let rotated = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                let frame = web.frame
                return frame.width > 0 && frame.height > 0 &&
                    (orientation.isLandscape ? frame.width > frame.height : frame.height > frame.width)
            }, object: web)
            guard XCTWaiter.wait(for: [rotated], timeout: 10) == .completed else {
                XCTFail("VAULT_LAYOUT_ROTATION_NOT_APPLIED"); return
            }
            guard let packet = revealEscape(stage, after: sequence) else { return }
            sequence = packet["sequence"]?.intValue ?? sequence
            XCTAssertTrue(entry.isHittable, "VAULT_LAYOUT_ROTATED_ENTRY_CLIPPED")
            assertFieldHitRegions()
        }
        // Resume the same installed document through the normal privacy path.
        // No relaunch, reset, credential input or account operation is allowed.
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(entry.waitForExistence(timeout: 10), "VAULT_LAYOUT_RESUME_ENTRY_MISSING")
        let resumed = revealEscape("resumed", after: sequence)
        XCTAssertTrue(entry.isHittable, "VAULT_LAYOUT_RESUME_ENTRY_CLIPPED")
        assertFieldHitRegions()
        XCTAssertNotNil(resumed)
    }

    func testLocalSessionNativeDrawersRecoverTouchAfterSystemInterruption() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_LOCAL_SESSION_SMOKE"] == "true" else {
            throw XCTSkip("Installed coherent qualification candidate only")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            throw XCTSkip("Attach only; installation and unlock are separate")
        }
        app.activate()
        dismissRehearsalChatKeyboard(app)
        returnToRehearsalChat(app)
        let web = app.webViews.matching(identifier: "native-webview").firstMatch
        let editor = app.textViews["native-dock-editor"].firstMatch
        let opener = app.buttons["Open Profile"].firstMatch
        guard waitForAdmittedControl(editor), waitForAdmittedControl(opener), !web.buttons["Unlock"].exists else {
            printCoherentPresentationAdmission(app)
            XCTFail("NATIVE_RESUME_REQUIRES_UNLOCKED_CHAT"); return
        }
        let draft = editor.value as? String // Process-only comparison; never emitted.
        let profileClose = app.buttons["Close Profile"].firstMatch
        func verifyTouchAndReturn() -> Bool {
            guard waitForAdmittedControl(opener) else { return false }
            opener.tap()
            guard waitForAdmittedControl(profileClose) else { return false }
            profileClose.tap()
            guard waitForAdmittedControl(editor), waitForAdmittedControl(opener) else { return false }
            guard waitForAdmittedControl(app.buttons["chat-history-toggle"].firstMatch),
                  waitForAdmittedControl(app.segmentedControls["chat-agent-surface"].firstMatch) else {
                printCoherentPresentationAdmission(app)
                return false
            }
            XCTAssertEqual(app.webViews.matching(identifier: "native-webview").count, 1)
            XCTAssertFalse(web.buttons["Unlock"].exists)
            XCTAssertTrue((editor.value as? String) == draft, "NATIVE_RESUME_DRAFT_CHANGED")
            return true
        }
        guard verifyTouchAndReturn() else { XCTFail("NATIVE_RESUME_BASELINE_TOUCH_FAILED"); return }
        let controlCenterOnly = ProcessInfo.processInfo.environment["HUSHH_CONTROL_CENTER_ONLY"] == "true"
        for cycle in 0..<(controlCenterOnly ? 0 : 10) {
            opener.tap()
            guard waitForAdmittedControl(profileClose) else { XCTFail("NATIVE_RESUME_DRAWER_NOT_OPEN"); return }
            XCUIDevice.shared.press(.home)
            guard app.wait(for: .runningBackground, timeout: 5) || app.state == .runningBackgroundSuspended else {
                XCTFail("NATIVE_RESUME_BACKGROUND_NOT_OBSERVED"); return
            }
            app.activate()
            guard waitForAdmittedControl(profileClose) else {
                printCoherentPresentationAdmission(app)
                XCTFail("NATIVE_RESUME_DRAWER_NOT_READMITTED"); return
            }
            profileClose.tap()
            guard verifyTouchAndReturn() else { XCTFail("NATIVE_RESUME_TOUCH_NOT_RECOVERED"); return }
            print("NATIVE_RESUME_TOUCH background_cycle=\(cycle + 1) passed=true")
        }
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let top = springboard.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: app.frame.width - 16, dy: 1))
        top.press(forDuration: 0.1, thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.6)),
            withVelocity: .slow, thenHoldForDuration: 0.2)
        // System panels need not expose their title as an Other element. Keep
        // this read-only: identify stock controls, never dump system/private AX.
        let controlCenter = springboard.descendants(matching: .any).matching(NSPredicate(
            format: "label IN %@ OR identifier IN %@", ["Control Center"], ["Control Center", "ControlCenter"])).firstMatch
        let brightness = springboard.sliders.matching(NSPredicate(format: "label BEGINSWITH[c] %@", "Brightness")).firstMatch
        let volume = springboard.sliders.matching(NSPredicate(format: "label BEGINSWITH[c] %@", "Volume")).firstMatch
        let airplane = springboard.buttons.matching(NSPredicate(format: "label BEGINSWITH[c] %@", "Airplane Mode")).firstMatch
        let bluetooth = springboard.buttons.matching(NSPredicate(format: "label BEGINSWITH[c] %@", "Bluetooth")).firstMatch
        let observed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            controlCenter.exists || brightness.exists && volume.exists || airplane.exists && bluetooth.exists
        }, object: springboard)
        let panelObserved = XCTWaiter.wait(for: [observed], timeout: 5) == .completed
        print("NATIVE_SYSTEM_INTERRUPT target=control_center observed=\(panelObserved) title=\(controlCenter.exists) brightness=\(brightness.exists) volume=\(volume.exists) airplane=\(airplane.exists) bluetooth=\(bluetooth.exists)")
        guard panelObserved else {
            app.activate()
            XCTFail("NATIVE_RESUME_CONTROL_CENTER_NOT_OBSERVED"); return
        }
        springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95))
            .press(forDuration: 0.05, thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)))
        app.activate()
        guard verifyTouchAndReturn() else { XCTFail("NATIVE_RESUME_CONTROL_CENTER_TOUCH_NOT_RECOVERED"); return }
        print("NATIVE_RESUME_TOUCH control_center=true passed=true")
    }

    /// Actual product port, not the synthetic study. Read-only, attach-only and
    /// credential-free after normal unlock; private labels never enter artifacts.
    func testLocalSessionCoherentNativeShellKeepsWarmChat() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_LOCAL_SESSION_SMOKE"] == "true" else {
            throw XCTSkip("Installed coherent qualification candidate only")
        }
        let app = XCUIApplication()
        let agentSwitchOnly = ProcessInfo.processInfo.environment["HUSHH_COHERENT_AGENT_SWITCH_ONLY"] == "true"
        let routeKeyboardOnly = ProcessInfo.processInfo.environment["HUSHH_COHERENT_ROUTE_KEYBOARD_ONLY"] == "true"
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            throw XCTSkip("Attach only; installation and unlock are separate")
        }
        app.activate()
        dismissRehearsalChatKeyboard(app)
        returnToRehearsalChat(app)
        let web = app.webViews.matching(identifier: "native-webview").firstMatch
        guard web.waitForExistence(timeout: 15), !web.buttons["Unlock"].exists else {
            printCoherentPresentationAdmission(app)
            XCTFail("COHERENT_SHELL_REQUIRES_UNLOCKED_CHAT"); return
        }
        for label in ["Close Profile", "Close chat history"] {
            let close = app.buttons[label].firstMatch
            if close.exists && close.isHittable { close.tap() }
        }
        let editor = app.textViews["native-dock-editor"].firstMatch
        let history = app.buttons["chat-history-toggle"].firstMatch
        let profile = app.buttons["Open Profile"].firstMatch
        let selector = app.segmentedControls["chat-agent-surface"].firstMatch
        guard waitForAdmittedControl(editor), waitForAdmittedControl(history), waitForAdmittedControl(profile), selector.exists else {
            printCoherentPresentationAdmission(app)
            printNativeControlStatuses(web)
            if ProcessInfo.processInfo.environment["HUSHH_CHARACTERIZE_HISTORY_HIT"] == "true",
               history.exists, history.isEnabled, !history.isHittable,
               let packet = app.buttons["native-profile-back-admission"].firstMatch.value as? String,
               packet.utf8.count <= 1024, packet.contains("hAdmitted=1"), packet.contains("hAllowed=1"),
               packet.contains("hIsolated=0"), packet.contains("hHidden=0"),
               packet.contains("hHits=target>target,target>target,target>target,target>target,target>target"),
               app.frame.contains(CGPoint(x: history.frame.midX, y: history.frame.midY)) {
                // Diagnosis only, never acceptance or an operation retry. One
                // touch of the admitted opener separates AX projection from
                // actual callback delivery; keep the original failure below.
                history.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
                let close = app.buttons["Close chat history"].firstMatch
                let opened = waitForAdmittedControl(close)
                print("COHERENT_HISTORY_TOUCH_DIAG opened=\(opened)")
                if opened { close.tap() }
            }
            XCTFail("COHERENT_SHELL_COMPOSITION_NOT_ADMITTED"); return
        }
        let initialDraft = editor.value as? String // Process-only; never an assertion operand or artifact.
        let cloud = selector.buttons["One, your cloud agent"].firstMatch
        let puppy = selector.buttons["Puppy One"].firstMatch
        guard cloud.isSelected else { XCTFail("COHERENT_SHELL_REQUIRES_ONE_CONTEXT"); return }
        var initialPuppyDraft: String?
        var puppyDraftObserved = false
        func waitForAppliedPort(_ choice: XCUIElement, label: String) -> Bool {
            let applied = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                choice.exists && choice.isSelected && editor.exists && editor.isHittable && editor.label == label
            }, object: app)
            return XCTWaiter.wait(for: [applied], timeout: 10) == .completed
        }
        func continuity() {
            XCTAssertEqual(app.webViews.matching(identifier: "native-webview").count, 1)
            XCTAssertEqual(app.textViews.matching(identifier: "native-dock-editor").count, 1)
            XCTAssertFalse(web.buttons["Unlock"].exists)
            XCTAssertTrue((editor.value as? String) == initialDraft, "COHERENT_SHELL_DRAFT_CHANGED")
            XCTAssertFalse(web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Message One")).firstMatch.isHittable)
        }
        if ProcessInfo.processInfo.environment["HUSHH_MEASURE_NATIVE_PRODUCT"] == "true" {
            // The real retained shell, not the isolated study. Keep this
            // opt-in Release measurement separate from the ten-cycle smoke.
            #if DEBUG
            XCTFail("NATIVE_PRODUCT_PERFORMANCE_REQUIRES_RELEASE"); return
            #else
            guard #available(iOS 26.0, *) else { throw XCTSkip("Native hitch measurement requires iOS 26") }
            let options = XCTMeasureOptions()
            options.iterationCount = 3
            func exerciseProfile(scroll: Bool = false) -> Bool {
                profile.tap()
                let preferences = app.buttons["native-profile-row-preferences"].firstMatch
                guard waitForAdmittedControl(preferences) else {
                    printCoherentPresentationAdmission(app)
                    XCTFail("NATIVE_PRODUCT_PERFORMANCE_PROFILE_MISSING"); return false
                }
                if scroll {
                    // Measure actual native scrolling as well as push/pop.
                    // A completed navigation test with zero rendered frames
                    // is not usable frame-pacing evidence.
                    let menu = app.scrollViews["native-profile-menu-scroll"].firstMatch
                    guard menu.exists && menu.isHittable else {
                        XCTFail("NATIVE_PRODUCT_PERFORMANCE_SCROLL_MISSING"); return false
                    }
                    menu.swipeUp(velocity: .slow)
                    menu.swipeDown(velocity: .slow)
                    guard waitForAdmittedControl(preferences) else {
                        XCTFail("NATIVE_PRODUCT_PERFORMANCE_SCROLL_RETURN_FAILED"); return false
                    }
                }
                preferences.tap()
                let back = nativeProfileBack(app, parent: "Profile")
                let theme = app.buttons["native-profile-row-preferences-theme"].firstMatch
                // A navigation bar is a container, not a tappable control.
                // Await the actual destination body and its admitted Back.
                guard theme.waitForExistence(timeout: 10), waitForAdmittedControl(back) else {
                    printCoherentPresentationAdmission(app)
                    XCTFail("NATIVE_PRODUCT_PERFORMANCE_NESTED_MISSING"); return false
                }
                back.tap()
                let close = app.buttons["Close Profile"].firstMatch
                guard waitForAdmittedControl(preferences), waitForAdmittedControl(close) else {
                    printCoherentPresentationAdmission(app)
                    XCTFail("NATIVE_PRODUCT_PERFORMANCE_BACK_FAILED"); return false
                }
                close.tap()
                guard waitForAdmittedControl(editor), waitForAdmittedControl(profile) else {
                    printCoherentPresentationAdmission(app)
                    XCTFail("NATIVE_PRODUCT_PERFORMANCE_CLOSE_FAILED"); return false
                }
                continuity()
                return true
            }
            for _ in 0..<10 {
                guard exerciseProfile() else { return }
            }
            print("NATIVE_PRODUCT_WARM_PROFILE cycles=10 single_composer=true mutated=false")
            var failed = false
            measure(metrics: [XCTOSSignpostMetric.navigationTransitionMetric,
                              XCTOSSignpostMetric.scrollingAndDecelerationMetric,
                              XCTHitchMetric(application: app)], options: options) {
                // Do not replay a failed or uncertain navigation operation in
                // a later measurement iteration.
                guard !failed else { return }
                failed = !exerciseProfile(scroll: true)
            }
            guard !failed else { return }
            print("NATIVE_PRODUCT_PERFORMANCE requested_iterations=3 configuration=release warm=true mutated=false")
            return
            #endif
        }
        for cycle in 0..<(routeKeyboardOnly ? 0 : 10) {
            if !agentSwitchOnly {
                guard waitForAdmittedControl(history) else { XCTFail("COHERENT_HISTORY_OPENER_NOT_READMITTED"); return }
                let openerFrame = history.frame
                let beforeTap = historyTapCount(app)
                history.coordinate(withNormalizedOffset: CGVector(dx: cycle % 2 == 0 ? 0.5 : 0.2, dy: 0.5)).tap()
                let close = app.buttons["Close chat history"].firstMatch
                guard waitForAdmittedControl(close), app.textFields["native-history-search"].firstMatch.exists else {
                    printCoherentPresentationAdmission(app)
                    printNativeControlStatuses(web)
                    if let beforeTap, let afterTap = historyTapCount(app), afterTap >= beforeTap {
                        print("COHERENT_HISTORY_ATTEMPT native_tap_delta=\(afterTap - beforeTap)")
                    }
                    let search = app.textFields["native-history-search"].firstMatch
                    print("COHERENT_HISTORY_ADMISSION search_present=\(search.exists) search_hittable=\(search.exists && search.isHittable) opener_hittable=\(history.exists && history.isHittable)")
                    XCTFail("COHERENT_HISTORY_NOT_ADMITTED"); return
                }
                print("NATIVE_HISTORY_LEADING_SLOT opener_x=\(Int(openerFrame.minX)) opener_y=\(Int(openerFrame.minY)) close_x=\(Int(close.frame.minX)) close_y=\(Int(close.frame.minY))")
                XCTAssertEqual(close.frame.minX, openerFrame.minX, accuracy: 1, "COHERENT_HISTORY_CLOSE_HORIZONTAL_ALIGNMENT")
                XCTAssertEqual(close.frame.minY, openerFrame.minY, accuracy: 1, "COHERENT_HISTORY_CLOSE_VERTICAL_ALIGNMENT")
                if cycle == 0 {
                    let scroll = app.scrollViews["native-history-chats-scroll"].firstMatch
                    guard scroll.waitForExistence(timeout: 5) else { XCTFail("COHERENT_HISTORY_SCROLL_OWNER_MISSING"); return }
                    let footer = app.descendants(matching: .any).matching(identifier: "native-history-footer").firstMatch
                    let footerFrame = footer.exists ? footer.frame : nil
                    let closeFrame = close.frame
                    scroll.swipeUp()
                    scroll.swipeDown()
                    XCTAssertEqual(close.frame.minY, closeFrame.minY, accuracy: 1,
                        "History scrolling must not move its header")
                    if let footerFrame {
                        XCTAssertEqual(footer.frame.minY, footerFrame.minY, accuracy: 1,
                            "History scrolling must not move its footer")
                    }
                    // A scrolling cell may be partly visible and hittable.
                    // Measure a complete row inside its scroll owner's bounds,
                    // not a clipped accessibility rectangle at either edge.
                    let menus = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "native-history-actions-"))
                    let actions = menus.allElementsBoundByIndex.first { control in
                        let bounds = control.frame
                        return control.isHittable && bounds.minY > scroll.frame.minY + 1 && bounds.maxY < scroll.frame.maxY - 1
                    } ?? menus.firstMatch
                    guard waitForAdmittedControl(actions) else { XCTFail("COHERENT_HISTORY_ACTION_FIXTURE_MISSING"); return }
                    let rowIdentifier = actions.identifier.replacingOccurrences(of: "native-history-actions-", with: "native-history-row-")
                    let row = app.buttons[rowIdentifier].firstMatch
                    guard waitForAdmittedControl(row) else { XCTFail("COHERENT_HISTORY_ROW_GEOMETRY_UNAVAILABLE"); return }
                    print("COHERENT_HISTORY_ROW_GEOMETRY row_height=\(row.frame.height) menu_height=\(actions.frame.height) fully_visible=\(row.frame.minY >= scroll.frame.minY && row.frame.maxY <= scroll.frame.maxY)")
                    // SwiftUI combines this label into the Button's AX node.
                    // Actual text centering and inline age are measured on the
                    // same shared renderer in NativeSupportTests, not inferred
                    // from inaccessible text descendants or the hit rectangle.
                    // The same rendered contract uses a floating-point epsilon
                    // in NativeSupportTests. Do not round an AX coordinate into
                    // a smaller integer, or accept a genuinely sub-44pt target.
                    XCTAssertGreaterThanOrEqual(row.frame.height, 44 - 1e-6)
                    XCTAssertEqual(row.frame.midY, actions.frame.midY, accuracy: 1)
                    XCTAssertLessThanOrEqual(row.frame.maxX, actions.frame.minX + 1, "History selection must not collide with More")
                    XCTAssertEqual(actions.frame.width, 44, accuracy: 1)
                    XCTAssertEqual(actions.frame.height, 44, accuracy: 1)
                    print("COHERENT_HISTORY_ROW_HIT_REGIONS independent=true aligned=true minimum=true")
                    actions.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5)).tap()
                    let rename = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Rename")).firstMatch
                    print("COHERENT_HISTORY_MENU rename=\(rename.exists) close_hittable=\(close.isHittable)")
                    // UIKit's compact menu owns interaction until dismissal. A
                    // covered Close is not required to be simultaneously tappable.
                    guard waitForAdmittedControl(rename) else { XCTFail("COHERENT_HISTORY_ACTIONS_NOT_DELIVERED"); return }
                    rename.tap()
                    guard app.textFields["native-history-rename"].firstMatch.waitForExistence(timeout: 10) else {
                        XCTFail("COHERENT_HISTORY_RENAME_NOT_OPENED"); return
                    }
                    XCTAssertTrue(app.textFields["native-history-search"].firstMatch.exists,
                        "COHERENT_HISTORY_RENAME_REPLACED_LIST")
                    XCTAssertTrue(footer.exists, "COHERENT_HISTORY_RENAME_REPLACED_FOOTER")
                    let renameCancel = app.buttons["Cancel"].firstMatch
                    guard waitForAdmittedControl(renameCancel) else { XCTFail("COHERENT_HISTORY_RENAME_CANCEL_UNAVAILABLE"); return }
                    renameCancel.tap() // No rename/delete mutation.
                    print("COHERENT_HISTORY_ACTION_STAGE stage=rename_cancelled")
                    guard app.textFields["native-history-search"].firstMatch.waitForExistence(timeout: 10) else {
                        XCTFail("COHERENT_HISTORY_ACTION_RETURN_FAILED"); return
                    }
                    guard waitForAdmittedControl(actions) else { XCTFail("COHERENT_HISTORY_MORE_NOT_RESTORED"); return }
                    actions.tap()
                    print("COHERENT_HISTORY_ACTION_STAGE stage=delete_menu_opened")
                    let delete = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Delete")).firstMatch
                    guard waitForAdmittedControl(delete) else { XCTFail("COHERENT_HISTORY_DELETE_MENU_UNAVAILABLE"); return }
                    print("COHERENT_HISTORY_ACTION_STAGE stage=delete_menu_admitted")
                    delete.tap()
                    print("COHERENT_HISTORY_ACTION_STAGE stage=delete_choice_delivered")
                    let confirmation = app.alerts["Delete chat?"].firstMatch
                    guard confirmation.waitForExistence(timeout: 10) else { XCTFail("COHERENT_HISTORY_DELETE_CONFIRMATION_UNAVAILABLE"); return }
                    print("COHERENT_HISTORY_ACTION_STAGE stage=delete_confirmation_present")
                    let deleteCancel = confirmation.buttons["Cancel"].firstMatch
                    guard waitForAdmittedControl(deleteCancel) else { XCTFail("COHERENT_HISTORY_DELETE_CANCEL_UNAVAILABLE"); return }
                    deleteCancel.tap() // Never delete a reviewer record.
                    print("COHERENT_HISTORY_ACTION_STAGE stage=delete_cancelled")
                    guard waitForAdmittedControl(close) else { XCTFail("COHERENT_HISTORY_CONFIRMATION_DID_NOT_RETIRE"); return }
                    let connectors = app.buttons["native-history-row-connectors"].firstMatch
                    guard waitForAdmittedControl(connectors) else { printCoherentPresentationAdmission(app); XCTFail("COHERENT_HISTORY_CONNECTORS_TRIGGER_UNAVAILABLE"); return }
                    connectors.tap()
                    print("COHERENT_HISTORY_ACTION_STAGE stage=connectors_opened")
                    let connectorsBack = app.buttons["Back to chats"].firstMatch
                    guard waitForAdmittedControl(connectorsBack) else { XCTFail("COHERENT_HISTORY_CONNECTORS_HANDOFF_FAILED"); return }
                    XCTAssertFalse(close.exists && close.isHittable, "COHERENT_HISTORY_ROSTER_OVERLAPS_CONNECTORS")
                    XCTAssertEqual(app.webViews.matching(identifier: "native-webview").count, 1)
                    connectorsBack.tap()
                    guard waitForAdmittedControl(close), app.textFields["native-history-search"].firstMatch.exists else {
                        XCTFail("COHERENT_HISTORY_CONNECTORS_RETURN_FAILED"); return
                    }
                }
                XCTAssertFalse(editor.isHittable)
                let drawer = app.otherElements["native-history-drawer-body"].firstMatch
                XCTAssertEqual(drawer.frame.minY, app.frame.minY, accuracy: 1)
                XCTAssertEqual(drawer.frame.maxY, app.frame.maxY, accuracy: 1)
                if cycle % 2 == 0 {
                    let start = drawer.coordinate(withNormalizedOffset: CGVector(dx: 0.55, dy: 0.85))
                    let held = drawer.coordinate(withNormalizedOffset: CGVector(dx: 0.45, dy: 0.85))
                    start.press(forDuration: 0.05, thenDragTo: held, withVelocity: .slow, thenHoldForDuration: 0.25)
                    guard waitForAdmittedControl(close) else { XCTFail("COHERENT_HISTORY_CANCEL_LOST_CLOSE"); return }
                }
                close.tap()
                guard waitForAdmittedControl(editor), waitForAdmittedControl(history) else {
                    printCoherentPresentationAdmission(app)
                    printNativeControlStatuses(web)
                    XCTFail("COHERENT_HISTORY_RETURN_FAILED"); return
                }
                continuity()
                profile.tap()
                let profileClose = app.buttons["Close Profile"].firstMatch
                let preferences = app.buttons["native-profile-row-preferences"].firstMatch
                // Profile intentionally resumes its prior query-owned position.
                // A previous failed rehearsal can leave a nested page; unwind it
                // through the real native Back, never reset/cold-navigate the app.
                let nativeStackBack = nativeProfileBack(app, parent: "Profile")
                var resumedBack: XCUIElement {
                    let native = app.navigationBars.buttons.matching(NSPredicate(
                        format: "label IN %@", ["Profile", "Security & privacy", "Back"])).firstMatch
                    return native.exists ? native : app.buttons["profile-back"].firstMatch
                }
                for _ in 0..<3 {
                    let entry = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                        profileClose.exists && profileClose.isHittable && profileClose.isEnabled ||
                            resumedBack.exists && resumedBack.isHittable && resumedBack.isEnabled
                    }, object: app)
                    guard XCTWaiter.wait(for: [entry], timeout: 10) == .completed else { break }
                    if profileClose.exists && profileClose.isHittable && profileClose.isEnabled && !resumedBack.exists { break }
                    guard waitForAdmittedControl(resumedBack) else { XCTFail("COHERENT_PROFILE_PARENT_BACK_NOT_ADMITTED"); return }
                    resumedBack.tap()
                }
                guard waitForAdmittedControl(profileClose) else {
                    printCoherentPresentationAdmission(app)
                    printNativeControlStatuses(web)
                    XCTFail("COHERENT_PROFILE_NOT_ADMITTED"); return
                }
                // Profile preserves the originating menu's scroll position.
                // Reveal the authored row instead of assuming a fresh menu
                // always starts at its top after another warm journey.
                let profileMenu = app.descendants(matching: .any).matching(identifier: "native-profile-menu-scroll").firstMatch
                for _ in 0..<5 {
                    if preferences.exists && preferences.isHittable { break }
                    guard profileMenu.exists else { break }
                    profileMenu.swipeDown()
                }
                guard waitForAdmittedControl(preferences) else { XCTFail("COHERENT_PROFILE_PREFERENCES_NOT_ADMITTED"); return }
                XCTAssertFalse(editor.isHittable)
                preferences.tap()
                guard nativeStackBack.waitForExistence(timeout: 5), waitForAdmittedControl(nativeStackBack),
                      app.buttons["native-profile-row-preferences-theme"].firstMatch.exists else {
                    printCoherentPresentationAdmission(app)
                    printNativeControlStatuses(web)
                    XCTFail("COHERENT_NATIVE_PREFERENCES_NOT_ADMITTED"); return
                }
                XCTAssertEqual(app.webViews.matching(identifier: "native-webview").count, 0,
                    "A complete native Preferences page excludes the covered WebView from accessibility")
                nativeStackBack.tap()
                guard waitForAdmittedControl(profileClose) else {
                    printCoherentPresentationAdmission(app)
                    XCTFail("COHERENT_DETAIL_MENU_RETURN_FAILED"); return
                }
                profileClose.tap()
                guard waitForAdmittedControl(editor), waitForAdmittedControl(history) else { XCTFail("COHERENT_PROFILE_RETURN_FAILED"); return }
                continuity()
            }
            guard waitForAdmittedControl(puppy) else { XCTFail("COHERENT_PUPPY_SELECTOR_UNAVAILABLE"); return }
            puppy.tap()
            let puppySelected = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                puppy.exists && puppy.isSelected
            }, object: app)
            guard XCTWaiter.wait(for: [puppySelected], timeout: 10) == .completed else {
                printCoherentPresentationAdmission(app)
                printNativeControlStatuses(web)
                print("COHERENT_AGENT_SELECTION one_selected=\(cloud.isSelected) puppy_selected=\(puppy.isSelected)")
                XCTFail("COHERENT_PUPPY_SELECTION_NOT_APPLIED"); return
            }
            // The actual product deliberately requires New chat when Puppy
            // has no conversation. Use that authored entry once; no provider
            // call or turn submission is involved, and existing chats remain.
            let startPuppy = web.buttons["Start a Puppy chat"].firstMatch
            if startPuppy.exists {
                guard waitForAdmittedControl(startPuppy) else { XCTFail("COHERENT_PUPPY_ENTRY_UNAVAILABLE"); return }
                startPuppy.tap()
            }
            guard waitForAppliedPort(puppy, label: "Message Puppy") else { XCTFail("COHERENT_PUPPY_PORT_NOT_ADMITTED"); return }
            if !puppyDraftObserved {
                initialPuppyDraft = editor.value as? String
                puppyDraftObserved = true
            }
            XCTAssertTrue((editor.value as? String) == initialPuppyDraft, "COHERENT_PUPPY_DRAFT_CHANGED")
            XCTAssertEqual(app.textViews.matching(identifier: "native-dock-editor").count, 1)
            cloud.tap()
            guard waitForAppliedPort(cloud, label: "Message One") else { XCTFail("COHERENT_ONE_PORT_RETURN_FAILED"); return }
            continuity()
            print("\(agentSwitchOnly ? "COHERENT_AGENT_SWITCH" : "COHERENT_NATIVE_SHELL")_CYCLE completed=\(cycle + 1) warm=true submitted=false")
        }
        if agentSwitchOnly {
            // Focused diagnosis is not the full drawer/route/keyboard receipt.
            print("COHERENT_AGENT_SWITCH_CONTINUITY cycles=10 warm=true submitted=false")
            return
        }
        let bar = app.descendants(matching: .any).matching(identifier: "one-native-navigation").firstMatch
        #if DEBUG
        let historyProbe = app.buttons["native-history-continuity"].firstMatch
        #endif
        for destination in ["One", "Connect", "Feed"] {
            let tab = bar.buttons[destination].firstMatch
            guard waitForAdmittedControl(tab) else { XCTFail("COHERENT_ROUTE_TAB_UNAVAILABLE"); return }
            tab.tap()
            // Release does not compile the private host ledger. Its observable
            // check proves control withdrawal and routing, not host retirement.
            // Keep the stronger Debug ledger assertion for that distinct proof.
            let retired = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                guard !history.exists && !selector.exists && tab.isSelected else { return false }
                #if DEBUG
                guard historyProbe.exists, let json = historyProbe.value as? String,
                      let data = json.data(using: .utf8),
                      let counters = try? JSONSerialization.jsonObject(with: data) as? [String: Int] else { return false }
                return counters["installs", default: 0] > 0 && counters["installs"] == counters["removals"]
                #else
                return true
                #endif
            }, object: app)
            guard XCTWaiter.wait(for: [retired], timeout: 15) == .completed else {
                XCTFail("COHERENT_CHAT_CHROME_LEAKED_ON_ROUTE"); return
            }
            XCTAssertEqual(app.webViews.matching(identifier: "native-webview").count, 1)
            XCTAssertFalse(web.buttons["Unlock"].exists)
            let chat = bar.buttons["Chat"].firstMatch
            guard waitForAdmittedControl(chat) else { XCTFail("COHERENT_CHAT_TAB_RETURN_UNAVAILABLE"); return }
            chat.tap()
            guard waitForAdmittedControl(history), waitForAppliedPort(cloud, label: "Message One") else {
                XCTFail("COHERENT_CHAT_CHROME_ROUTE_RETURN_FAILED"); return
            }
            continuity()
        }
        editor.tap()
        guard app.keyboards.firstMatch.waitForExistence(timeout: 10) else { XCTFail("COHERENT_EDITOR_KEYBOARD_MISSING"); return }
        XCTAssertTrue(history.isHittable, "COHERENT_HEADER_DISABLED_DURING_EDITING")
        history.tap()
        let close = app.buttons["Close chat history"].firstMatch
        guard waitForAdmittedControl(close) else { XCTFail("COHERENT_KEYBOARD_DRAWER_FAILED"); return }
        close.tap()
        guard waitForAdmittedControl(editor) else { XCTFail("COHERENT_KEYBOARD_RETURN_FAILED"); return }
        XCTAssertFalse(app.keyboards.firstMatch.exists, "Closing a menu must not summon editing")
        continuity()
        if routeKeyboardOnly {
            print("COHERENT_ROUTE_KEYBOARD_CONTINUITY destinations=3 keyboard=true single_composer=true warm=true")
        } else {
            print("COHERENT_NATIVE_SHELL_CONTINUITY cycles=10 keyboard=true single_composer=true warm=true")
        }
    }

    func testLocalSessionNativeProductHistoryKeepsOwnerAndSingleHost() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_NATIVE_PRODUCT_HISTORY"] == "true" else {
            throw XCTSkip("Explicit native product History qualification")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            XCTFail("PRODUCT_HISTORY_REQUIRES_RUNNING_APP"); return
        }
        app.activate()
        let web = app.webViews.matching(identifier: "native-webview").firstMatch
        let open = app.buttons["Open chat history"].firstMatch
        let close = app.buttons["Close chat history"].firstMatch
        let composer = web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Message One")).firstMatch
        guard waitForAdmittedControl(open), waitForAdmittedControl(composer), !web.buttons["Unlock"].exists else {
            XCTFail("PRODUCT_HISTORY_REQUIRES_UNLOCKED_CHAT"); return
        }
        let initialFrame = web.frame
        let initialDraft = composer.value as? String
        for cycle in 0..<10 {
            open.coordinate(withNormalizedOffset: CGVector(dx: cycle % 2 == 0 ? 0.5 : 0.2, dy: 0.5)).tap()
            guard waitForAdmittedControl(close) else { XCTFail("PRODUCT_HISTORY_CLOSE_NOT_ADMITTED"); return }
            let native = app.otherElements["native-private-drawer"].firstMatch
            let search = app.textFields["native-history-search"].firstMatch
            guard native.exists, search.exists, search.isHittable else {
                XCTFail("PRODUCT_HISTORY_NATIVE_RENDERER_MISSING"); return
            }
            XCTAssertFalse(web.buttons["Search chats"].firstMatch.isHittable)
            XCTAssertFalse(composer.isHittable, "The covered React editor must be isolated")
            let frame = native.frame
            XCTAssertEqual(frame.minY, app.frame.minY, accuracy: 1)
            XCTAssertEqual(frame.maxY, app.frame.maxY, accuracy: 1, "History must remain full-height")
            if cycle % 2 == 0 {
                let start = native.coordinate(withNormalizedOffset: CGVector(dx: 0.55, dy: 0.85))
                let hold = native.coordinate(withNormalizedOffset: CGVector(dx: 0.40, dy: 0.85))
                start.press(forDuration: 0.05, thenDragTo: hold, withVelocity: .slow, thenHoldForDuration: 0.25)
                guard waitForAdmittedControl(close) else { XCTFail("PRODUCT_HISTORY_HELD_DRAG_LOST_CONTROL"); return }
            }
            close.tap()
            let retired = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in !close.isHittable && !search.isHittable }, object: app)
            XCTAssertEqual(XCTWaiter.wait(for: [retired], timeout: 10), .completed)
            guard waitForAdmittedControl(open), waitForAdmittedControl(composer) else {
                XCTFail("PRODUCT_HISTORY_BASE_NOT_RESTORED"); return
            }
            XCTAssertEqual(app.webViews.matching(identifier: "native-webview").count, 1)
            XCTAssertEqual(web.frame, initialFrame)
            XCTAssertTrue((composer.value as? String) == initialDraft, "Draft continuity failed")
            XCTAssertFalse(web.buttons["Unlock"].exists)
            print("NATIVE_PRODUCT_HISTORY_CYCLE completed=\(cycle + 1)")
        }
    }

    func testLocalSessionSharedChatDockKeepsDraftThroughTabsProfileAndKeyboard() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_LOCAL_SESSION_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in installed shared Chat dock regression")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            XCTFail("SHARED_DOCK_REQUIRES_RUNNING_SESSION"); return
        }
        app.activate()
        dismissRehearsalChatKeyboard(app)
        perfTapNav(app, label: "Chat")
        let web = app.webViews.matching(identifier: "native-webview").firstMatch
        let editor = rehearsalChatComposer(app)
        guard waitForAdmittedControl(editor), !web.buttons["Unlock"].exists else {
            XCTFail("SHARED_DOCK_REQUIRES_UNLOCKED_CHAT"); return
        }
        let initialFrame = web.frame
        let initialValue = editor.value as? String
        let initialDraft = initialValue == "Message One..." || initialValue == "Message One…" ? "" : initialValue ?? ""
        // Long enough to wrap, without Return (the web editor owns Enter-to-send).
        let synthetic = String(repeating: "Unsent synthetic layout check. ", count: 4)
        let writesSynthetic = initialDraft.isEmpty
        editor.tap()
        guard app.keyboards.firstMatch.waitForExistence(timeout: 10) else {
            XCTFail("SHARED_DOCK_SOFTWARE_KEYBOARD_MISSING"); return
        }
        if writesSynthetic { editor.typeText(synthetic) }
        let expectedDraft = writesSynthetic ? synthetic : initialDraft
        let keyboard = app.keyboards.firstMatch
        let layout = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            self.softwareKeyboardIsOnscreen(keyboard, in: app) && editor.frame.maxY <= keyboard.frame.minY + 2
        }, object: app)
        XCTAssertEqual(XCTWaiter.wait(for: [layout], timeout: 10), .completed, "SHARED_DOCK_KEYBOARD_LAYOUT_UNSETTLED")
        XCTAssertLessThanOrEqual(editor.frame.maxY, keyboard.frame.minY + 2, "SHARED_DOCK_EDITOR_CLIPPED_BY_KEYBOARD")
        dismissRehearsalChatKeyboard(app)
        defer {
            // Never erase an independently updated draft; no send or account reset.
            if writesSynthetic, (editor.value as? String) == synthetic, editor.isHittable {
                editor.tap()
                editor.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: synthetic.count))
                dismissRehearsalChatKeyboard(app)
            }
        }
        let openProfile = app.buttons["Open Profile"].firstMatch
        let closeProfile = app.buttons["Close Profile"].firstMatch
        let puppy = web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Puppy One")).firstMatch
        let cloud = web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "One, your cloud agent")).firstMatch
        for cycle in 0..<10 {
            guard waitForAdmittedControl(puppy) else { XCTFail("SHARED_DOCK_AGENT_TAB_MISSING"); return }
            puppy.tap()
            let cloudCovered = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in !editor.exists || !editor.isHittable }, object: app)
            XCTAssertEqual(XCTWaiter.wait(for: [cloudCovered], timeout: 10), .completed, "SHARED_DOCK_CLOUD_EDITOR_STILL_INTERACTIVE")
            guard waitForAdmittedControl(cloud) else { XCTFail("SHARED_DOCK_CLOUD_TAB_MISSING"); return }
            cloud.tap()
            guard waitForAdmittedControl(editor) else { XCTFail("SHARED_DOCK_CLOUD_EDITOR_NOT_RESTORED"); return }
            XCTAssertTrue((editor.value as? String) == expectedDraft, "SHARED_DOCK_AGENT_TAB_CHANGED_DRAFT")
            guard waitForAdmittedControl(openProfile) else { XCTFail("SHARED_DOCK_PROFILE_ENTRY_MISSING"); return }
            openProfile.coordinate(withNormalizedOffset: CGVector(dx: cycle % 2 == 0 ? 0.2 : 0.8, dy: 0.5)).tap()
            guard waitForAdmittedControl(closeProfile) else { XCTFail("SHARED_DOCK_PROFILE_CLOSE_MISSING"); return }
            XCTAssertFalse(editor.isHittable, "SHARED_DOCK_COVERED_EDITOR_INTERACTIVE")
            closeProfile.tap()
            guard waitForAdmittedControl(editor) else { XCTFail("SHARED_DOCK_EDITOR_NOT_RESTORED"); return }
            XCTAssertTrue((editor.value as? String) == expectedDraft, "SHARED_DOCK_DRAFT_CHANGED")
            XCTAssertEqual(app.webViews.matching(identifier: "native-webview").count, 1)
            XCTAssertEqual(web.frame, initialFrame)
            print("SHARED_CHAT_DOCK_PROFILE_CYCLE completed=\(cycle + 1)")
        }
        perfTapNav(app, label: "One")
        XCTAssertTrue(waitForAdmittedControl(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Talk to One")).firstMatch), "SHARED_DOCK_VOICE_PRESENTATION_MISSING")
        perfTapNav(app, label: "Chat")
        XCTAssertTrue(waitForAdmittedControl(editor))
        XCTAssertTrue((editor.value as? String) == expectedDraft, "SHARED_DOCK_ROUTE_CHANGED_DRAFT")
        XCTAssertFalse(app.textViews["native-dock-editor"].exists, "UNQUALIFIED_NATIVE_DUPLICATE_EDITOR")
        print("SHARED_CHAT_DOCK_CONTINUITY cycles=10 keyboard=true warm=true submitted=false")
    }

    func testLocalSessionChatDrawerDoesNotReplaceThePage() throws {
        // Real device/session lane: no UITestMode, reviewer bootstrap, reset,
        // or account mutation. An optional process-only credential uses normal
        // unlock after the visible account is checked. Exercise the installed
        // build through the same controls a signed-in person sees.
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_LOCAL_SESSION_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in live-session check; requires an already-running app")
        }
        let app = XCUIApplication()
        // Attach to the owner's already-open local session. A cold launch
        // intentionally locks the vault and would turn this into a reviewer
        // credential test rather than a live-device interaction check.
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            throw XCTSkip("Continuity requires One to be running; automation must not cold-launch it")
        }
        app.activate()

        let webView = app.webViews.firstMatch
        print("CHAT_CHECK_ATTACHED")
        XCTAssertTrue(webView.waitForExistence(timeout: 60), "Local app WebView did not load")
        print("CHAT_CHECK_WEBVIEW_READY")
        let open = webView.buttons.matching(NSPredicate(
            format: "label BEGINSWITH %@", "Open chat history"
        )).firstMatch
        // Navigate through visible controls while retaining the live session.
        if !open.exists && !webView.buttons["Unlock"].exists {
            perfTapNav(app, label: "Chat")
        }
        // The existing XCUI vault helper types into a secure field. Its secret
        // arrives through the documented TEST_RUNNER_ process environment,
        // never a launch argument, source file, or test diagnostic.
        if !open.waitForExistence(timeout: 10), webView.buttons["Unlock"].exists {
            let environment = ProcessInfo.processInfo.environment
            let hasReviewerSecret = !(environment["HUSHH_UI_TEST_REVIEWER_VAULT_PASSPHRASE"]
                ?? environment["REVIEWER_VAULT_PASSPHRASE"] ?? "").isEmpty
            guard hasReviewerSecret else {
                throw XCTSkip("Live-session vault is locked and no process-only reviewer credential was supplied")
            }
            let reviewerUid = environment["HUSHH_UI_TEST_REVIEWER_UID"] ?? ""
            let reviewerEmail = environment["HUSHH_UI_TEST_REVIEWER_EMAIL"] ?? ""
            guard !reviewerUid.isEmpty, !reviewerEmail.isEmpty else {
                XCTFail("Canonical reviewer identity was not forwarded; unlock was not submitted")
                return
            }
            let account = webView.staticTexts.matching(NSPredicate(
                format: "label == %@", reviewerEmail
            )).firstMatch
            guard account.waitForExistence(timeout: 5) else {
                XCTFail("The visible vault account does not match the canonical reviewer; unlock was not submitted")
                return
            }
            let submitted = attemptVaultPassphraseUnlock(app: app)
            print("LOCAL_SESSION_UNLOCK submitted=\(submitted) lock_visible=\(webView.buttons["Unlock"].exists) secure_entry_visible=\(app.secureTextFields.firstMatch.exists)")
            if submitted, !open.waitForExistence(timeout: 2) {
                // Unlock is asynchronous. Do not look for navigation before
                // the admitted shell exists and silently skip the route change.
                let nativeChat = app.buttons["one-native-tab-chat"].firstMatch
                let webChat = webView.buttons["Chat"].firstMatch
                if nativeChat.waitForExistence(timeout: 30) || webChat.exists {
                    perfTapNav(app, label: "Chat")
                }
            }
        }
        if !open.waitForExistence(timeout: 120) {
            let vaultLockVisible = webView.buttons["Unlock"].exists
            let rejected = webView.staticTexts.matching(NSPredicate(
                format: "label CONTAINS[c] %@", "That password did not match"
            )).firstMatch.exists
            XCTFail("Signed-in Chat did not load from the local build. Vault lock visible: \(vaultLockVisible) auth_rejected=\(rejected)")
            return
        }
        XCTAssertFalse(webView.buttons["Unlock"].exists,
                       "Chat must not be accepted while the vault gate remains")
        print("CHAT_CHECK_ROUTE_READY")
        let composer = webView.descendants(matching: .any).matching(NSPredicate(
            format: "label == %@", "Message One"
        )).firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 30) && composer.isHittable,
                      "Protected Chat content must be interactive after normal unlock")
        print("CHAT_CHECK_COMPOSER_READY")
        open.tap()
        let close = app.buttons.matching(NSPredicate(
            format: "label == %@", "Close chat history"
        )).firstMatch
        XCTAssertTrue(close.waitForExistence(timeout: 10), "Chat drawer cannot be closed")
        close.tap()
        XCTAssertTrue(open.waitForExistence(timeout: 10), "Chat page did not resume after closing the drawer")
        print("CHAT_CHECK_TOGGLE_READY")
        // Physical WebKit can omit the empty transcript region from its AX
        // tree. Anchor a real pan in the transcript's bottom clearance using
        // the visible header/composer, not a synthetic AX-only body element.
        let hostFrame = webView.frame
        let composerFrame = composer.frame
        let gestureY = composerFrame.minY - 48
        XCTAssertGreaterThan(gestureY, open.frame.maxY + 44,
                             "The conversation has no unobstructed body clearance")
        XCTAssertGreaterThan(hostFrame.width, 150)
        print("CHAT_CHECK_BODY_READY")
        let origin = webView.coordinate(withNormalizedOffset: .zero)
        let start = origin.withOffset(CGVector(dx: hostFrame.width * 0.20, dy: gestureY - hostFrame.minY))
        let end = origin.withOffset(CGVector(dx: hostFrame.width * 0.83, dy: gestureY - hostFrame.minY))
        start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.05)
        XCTAssertTrue(close.waitForExistence(timeout: 10), "A body swipe did not open chat history")
        print("CHAT_CHECK_SWIPE_OPEN")
        XCTAssertEqual(webView.frame, hostFrame, "The drawer shifted the Capacitor host")
        // Mirror the opening pan through the real panel body; a row beneath
        // the finger must not be selected by the release click.
        let closingStart = origin.withOffset(CGVector(dx: hostFrame.width * 0.70, dy: hostFrame.height * 0.55))
        let closingEnd = origin.withOffset(CGVector(dx: hostFrame.width * 0.16, dy: hostFrame.height * 0.55))
        closingStart.press(forDuration: 0.05, thenDragTo: closingEnd, withVelocity: .slow, thenHoldForDuration: 0.05)
        let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: close)
        XCTAssertEqual(XCTWaiter.wait(for: [dismissed], timeout: 10), .completed,
                       "A reverse body swipe did not close chat history")
        XCTAssertTrue(composer.waitForExistence(timeout: 10) && composer.isHittable)
        XCTAssertEqual(composer.frame.minX, composerFrame.minX, accuracy: 1,
                       "The drawer shifted the conversation instead of overlaying it")
        XCTAssertFalse(webView.buttons["Unlock"].exists, "The gesture lost the unlocked session")
        print("CHAT_DRAWER_GESTURE_CONTINUITY body_swipe_fixed_host")
        print("CHAT_DRAWER_BIDIRECTIONAL_CONTINUITY open_close_warm_chat")
        if ProcessInfo.processInfo.environment["HUSHH_RUN_RECOVERY_SMOKE"] == "true" {
            let profileOpen = app.buttons["Open Profile"].firstMatch
            let profileClose = app.buttons["Close Profile"].firstMatch
            let bar = app.descendants(matching: .any).matching(identifier: "one-native-navigation").firstMatch
            XCTAssertTrue(waitForAdmittedControl(bar), "Recovery did not admit the standard native navigation")
            XCTAssertFalse(app.textViews["native-dock-editor"].exists,
                           "Recovery must never activate a second composer")
            for _ in 0..<10 {
                XCTAssertTrue(waitForAdmittedControl(open)); open.tap()
                XCTAssertTrue(waitForAdmittedControl(close))
                XCTAssertFalse(bar.exists && bar.isHittable, "Native navigation escaped full-height History")
                close.tap()
                // Native navigation readiness does not retire the React
                // scrim. Do not target base controls through a closing modal.
                let historyRetired = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: close)
                XCTAssertEqual(XCTWaiter.wait(for: [historyRetired], timeout: 10), .completed,
                               "History did not retire before opening Profile")
                XCTAssertTrue(waitForAdmittedControl(bar), "Native navigation did not return after History")
                XCTAssertTrue(waitForAdmittedControl(profileOpen)); profileOpen.tap()
                XCTAssertTrue(waitForAdmittedControl(profileClose))
                XCTAssertFalse(bar.exists && bar.isHittable, "Native navigation escaped full-height Profile")
                profileClose.tap()
                let profileRetired = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: profileClose)
                XCTAssertEqual(XCTWaiter.wait(for: [profileRetired], timeout: 10), .completed,
                               "Profile did not retire before returning to Chat")
                XCTAssertTrue(waitForAdmittedControl(bar), "Native navigation did not return after Profile")
                XCTAssertTrue(waitForAdmittedControl(composer))
                XCTAssertEqual(webView.frame, hostFrame, "Recovery replaced or shifted the WebView")
                XCTAssertEqual(composer.frame.minX, composerFrame.minX, accuracy: 1)
                XCTAssertFalse(webView.buttons["Unlock"].exists, "Recovery lost the unlocked session")
                XCTAssertFalse(app.textViews["native-dock-editor"].exists, "Recovery re-admitted a native replica")
            }
            composer.tap()
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10), "Recovery keyboard did not open")
            XCTAssertTrue(waitForAdmittedControl(profileOpen)); profileOpen.tap()
            XCTAssertTrue(waitForAdmittedControl(profileClose)); profileClose.tap()
            dismissRehearsalChatKeyboard(app)
            XCTAssertTrue(waitForAdmittedControl(composer))
            XCTAssertTrue(waitForAdmittedControl(bar), "Native navigation did not return after the keyboard")
            XCTAssertEqual(webView.frame, hostFrame)
            print("REACT_RECOVERY_CONTINUITY ten_profile_ten_history_keyboard_single_composer_warm_host")
        }
    }

    func testLocalSessionVoiceBarCancelsFromItsBodyAndReturnsToChat() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_LOCAL_SESSION_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in attach-only voice cancellation proof")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            throw XCTSkip("One must already be running; no cold launch or reset")
        }
        app.activate()
        let hosts = app.webViews.matching(identifier: "native-webview")
        let webView = hosts.firstMatch
        XCTAssertFalse(webView.buttons["Unlock"].exists, "Normal vault unlock is required before voice proof")
        cancelRehearsalVoiceCapture(app)
        for label in ["Close Profile", "Close chat history", "Close search"] {
            let dismiss = app.buttons[label].firstMatch
            if dismiss.exists && dismiss.isHittable { dismiss.tap() }
        }
        perfTapNav(app, label: "Chat")
        let composer = webView.descendants(matching: .any).matching(NSPredicate(
            format: "label == %@", "Message One"
        )).firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 15) && composer.isHittable)
        let previousDraft = composer.value as? String ?? ""
        let syntheticDraft = "Voice cancellation check. This unsent draft must remain available after stopping."
        let insertedDraft = previousDraft.isEmpty || previousDraft == "Message One..."
        let expectedDraft = insertedDraft ? syntheticDraft : previousDraft
        if insertedDraft {
            composer.tap()
            composer.typeText(syntheticDraft)
        }
        let start = webView.buttons["Start voice mode"].firstMatch
        XCTAssertTrue(start.waitForExistence(timeout: 15) && start.isHittable)
        let cancel = webView.buttons.matching(NSPredicate(
            format: "label ENDSWITH %@ OR label == %@", ". Stop voice", "Cancel voice command"
        )).firstMatch
        addTeardownBlock {
            if cancel.exists && cancel.isHittable { cancel.tap() }
            if insertedDraft && composer.exists && composer.isHittable {
                composer.tap()
                composer.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: syntheticDraft.count))
            }
        }
        // Exercise the real shared input adapter, never a test-only endpoint.
        start.tap()
        XCTAssertTrue(cancel.waitForExistence(timeout: 5) && cancel.isHittable,
                      "The primary bar must be cancellable even while connecting")
        XCTAssertEqual(webView.buttons.matching(NSPredicate(
            format: "label ENDSWITH %@ OR label == %@", ". Stop voice", "Cancel voice command"
        )).count, 1, "Chat exposed duplicate active voice bars")
        cancel.coordinate(withNormalizedOffset: CGVector(dx: 0.65, dy: 0.5)).tap()
        XCTAssertTrue(start.waitForExistence(timeout: 10) && start.isHittable,
                      "Cancelling the body did not return to the existing Chat composer")
        XCTAssertFalse(cancel.exists, "Stopped capture remained active")
        XCTAssertTrue(composer.exists && composer.isHittable && composer.frame.height > 20,
                      "Returning from voice left the text editor collapsed")
        XCTAssertTrue((composer.value as? String) == expectedDraft,
                      "Voice cancellation did not preserve the unsent draft")
        XCTAssertFalse(webView.buttons["Unlock"].exists, "Voice cancellation lost the unlocked vault")
        XCTAssertEqual(hosts.count, 1)
        print("VOICE_BAR_CONTINUITY body_cancel_single_dock_warm_chat")
    }

    func testLocalSessionLiveSpeechCompletesWithoutSpeakerEchoLoop() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_LOCAL_SESSION_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in physical speakerphone proof")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            throw XCTSkip("One must already be running; no cold launch or reset")
        }
        app.activate()
        let webView = app.webViews.matching(identifier: "native-webview").firstMatch
        XCTAssertFalse(webView.buttons["Unlock"].exists, "Normal vault unlock is required before speech proof")
        // Cleanup is registered before any fail-fast admission assertion. Live
        // may be unavailable and the command adapter may own the microphone;
        // neither may leave capture active after this rehearsal stops.
        addTeardownBlock {
            self.cancelRehearsalVoiceCapture(app)
            XCTAssertTrue(webView.buttons["Start voice mode"].firstMatch.waitForExistence(timeout: 10),
                          "VOICE_STOP_NOT_SETTLED")
        }
        cancelRehearsalVoiceCapture(app)
        perfTapNav(app, label: "Chat")
        let start = webView.buttons["Start voice mode"].firstMatch
        XCTAssertTrue(start.waitForExistence(timeout: 15) && start.isHittable)
        let stop = webView.buttons.matching(NSPredicate(format: "label ENDSWITH %@", ". Stop voice")).firstMatch
        start.tap()
        XCTAssertTrue(stop.waitForExistence(timeout: 10), "LIVE_ADAPTER_UNAVAILABLE")
        // Button descendants are not consistently separate AX nodes in WebKit.
        let listening = webView.buttons["Listening. Stop voice"].firstMatch
        XCTAssertTrue(listening.waitForExistence(timeout: 25), "VOICE_LISTENING_UNAVAILABLE")
        let inputMatches = webView.staticTexts.matching(NSPredicate(
            format: "label BEGINSWITH[c] %@ AND label CONTAINS[c] %@", "You", "ready for testing"
        ))
        let outputMatches = webView.staticTexts.matching(NSPredicate(
            format: "label BEGINSWITH[c] %@ AND label CONTAINS[c] %@ AND NOT (label CONTAINS[c] %@)",
            "One", "ready for testing", "still speaking"
        ))
        let inputCount = inputMatches.count
        let outputCount = outputMatches.count
        // The credential-free host harness speaks a fixed synthetic question
        // only after this marker. It records neither microphone nor transcript.
        print("VOICE_SPEECH_READY")
        let inputDeadline = Date().addingTimeInterval(25)
        while inputMatches.count <= inputCount && Date() < inputDeadline { Thread.sleep(forTimeInterval: 0.25) }
        // Diagnose AX projection without exporting a transcript or accepting
        // recognition that is not attributable to the synthetic question.
        let anyInputMatches = webView.descendants(matching: .any).matching(NSPredicate(
            format: "label BEGINSWITH[c] %@ AND label CONTAINS[c] %@", "You", "ready for testing"
        ))
        print("VOICE_TRANSCRIPT_PROBE static=\(min(inputMatches.count, 2)) any=\(min(anyInputMatches.count, 2)) listening=\(listening.exists)")
        XCTAssertGreaterThan(inputMatches.count, inputCount, "VOICE_NO_RECOGNIZED_INPUT")
        let outputDeadline = Date().addingTimeInterval(45)
        while outputMatches.count <= outputCount && Date() < outputDeadline { Thread.sleep(forTimeInterval: 0.25) }
        XCTAssertGreaterThan(outputMatches.count, outputCount, "VOICE_RESPONSE_NOT_COMPLETED")
        // Ordinary speech returns to Listening, not the tool-outcome Done state.
        // In iOS speakerphone-safe mode the label stays Speaking while the
        // playback scheduler is still audible, even after model_end arrives.
        XCTAssertTrue(listening.waitForExistence(timeout: 15), "VOICE_PLAYBACK_NOT_SETTLED")
        let busy = webView.buttons.matching(NSPredicate(
            format: "label IN %@", ["Speaking. Stop voice", "One is asking. Stop voice", "Understanding. Stop voice", "Working…. Stop voice"]
        )).firstMatch
        let quietUntil = Date().addingTimeInterval(5)
        while Date() < quietUntil {
            XCTAssertFalse(busy.exists, "VOICE_REENTERED_WITHOUT_NEW_INPUT")
            Thread.sleep(forTimeInterval: 0.25)
        }
        XCTAssertTrue(stop.exists, "Voice session ended instead of settling")
        XCTAssertFalse(webView.buttons["Unlock"].exists, "Speech lost the unlocked vault")
        print("VOICE_SPEECH_COMPLETED settled_without_echo_restart")
    }

    private func cancelRehearsalVoiceCapture(_ app: XCUIApplication) {
        // Only the public microphone prompt initiated by the authorized voice
        // rehearsal is admitted. Never approve unrelated alerts or settings.
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let microphonePrompt = springboard.alerts.firstMatch
        let microphoneText = microphonePrompt.staticTexts.matching(NSPredicate(
            format: "label CONTAINS[c] %@", "microphone"
        )).firstMatch
        if microphonePrompt.exists && microphoneText.exists {
            let allow = microphonePrompt.buttons["Allow"].firstMatch
            if allow.exists && allow.isHittable { allow.tap() }
        }
        let cancellations = app.webViews.buttons.matching(NSPredicate(
            format: "label ENDSWITH %@ OR label IN %@", ". Stop voice",
            ["Cancel voice command", "Cancel recording", "Cancel task"]
        ))
        let cancel = cancellations.firstMatch
        if cancellations.count == 1 && cancel.isHittable {
            cancel.tap()
            print("VOICE_OWNED_RECOVERY capture_cancel_requested")
        }
        // A completed command result still owns the shared dock. Dismiss only
        // the existing result/error UI; never approve, retry or send a task.
        let results = app.webViews.buttons.matching(NSPredicate(format: "label == %@", "Dismiss result"))
        if results.count == 1 && results.firstMatch.isHittable {
            results.firstMatch.tap()
            print("VOICE_OWNED_RECOVERY result_dismissed")
        }
        let conversations = app.webViews.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", "One conversation"))
        if conversations.count == 1 {
            let errors = conversations.firstMatch.buttons.matching(NSPredicate(format: "label == %@", "Dismiss"))
            if errors.count == 1 && errors.firstMatch.isHittable {
                errors.firstMatch.tap()
                print("VOICE_OWNED_RECOVERY error_dismissed")
            }
        }
    }

    private func dismissRehearsalChatKeyboard(_ app: XCUIApplication) {
        if app.textViews["native-dock-editor"].firstMatch.exists {
            XCTAssertTrue(dismissDockKeyboardThroughProfile(app), "REHEARSAL_NATIVE_KEYBOARD_NOT_SETTLED")
            return
        }
        guard app.keyboards.firstMatch.exists else { return }
        let web = app.webViews.matching(identifier: "native-webview").firstMatch
        guard web.exists else { return }
        // The public header title has no action owner. Do not tap transcript
        // coordinates, send/return keys or an inferred arbitrary control.
        let titles = web.staticTexts.matching(NSPredicate(format: "label == %@", "One"))
            .allElementsBoundByIndex.filter {
                $0.isHittable && $0.frame.minY >= web.frame.minY && $0.frame.maxY <= web.frame.minY + 160
            }
        guard titles.count == 1 else { return }
        titles[0].tap()
        let hidden = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            !self.softwareKeyboardIsOnscreen(app.keyboards.firstMatch, in: app)
        }, object: app.keyboards.firstMatch)
        XCTAssertEqual(XCTWaiter.wait(for: [hidden], timeout: 10), .completed,
                       "REHEARSAL_KEYBOARD_NOT_SETTLED")
    }

    /// Follow the admitted renderer; a retained, hidden web reservation is not
    /// the editor. Never type into or submit through a second composer.
    private func rehearsalChatComposer(_ app: XCUIApplication) -> XCUIElement {
        let native = app.textViews["native-dock-editor"].firstMatch
        if native.waitForExistence(timeout: 2) { return native }
        return app.webViews.matching(identifier: "native-webview").firstMatch
            .descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Message One")).firstMatch
    }

    func testLocalSessionNativeTabsKeepTheSessionAndRespectOverlays() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_LOCAL_SESSION_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in attach-only native navigation proof")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            throw XCTSkip("One must already be running and unlocked; no cold launch or credential typing")
        }
        app.activate()
        dismissRehearsalChatKeyboard(app)
        cancelRehearsalVoiceCapture(app)
        let bar = app.descendants(matching: .any).matching(identifier: "one-native-navigation").firstMatch
        // WebKit exposes nested AX WebView nodes on physical iOS. Count the
        // existing identified Capacitor host, not its accessibility descendants.
        let hosts = app.webViews.matching(identifier: "native-webview")
        let webView = hosts.firstMatch
        if !bar.exists {
            // Resume the existing presentation, not a cold route or fixture.
            // Report only control presence: never dump the protected hierarchy.
            for label in ["Close Profile", "Close chat history", "Close search"] {
                let dismiss = app.buttons[label].firstMatch
                if dismiss.exists && dismiss.isHittable { dismiss.tap() }
            }
            print("NATIVE_NAVIGATION_ADMISSION vault_unlock_visible=\(webView.buttons["Unlock"].exists) secure_entry_visible=\(app.secureTextFields.firstMatch.exists) google_signin_visible=\(app.buttons["Continue with Google"].exists) privacy_cover_visible=\(app.otherElements["session-privacy-shield"].exists) privacy_retry_visible=\(app.buttons["session-privacy-retry"].exists) native_chat_visible=\(app.buttons["one-native-tab-chat"].exists)")
        }
        XCTAssertTrue(bar.waitForExistence(timeout: 30), "The installed candidate did not expose native tabs")
        func tab(_ name: String) -> XCUIElement { bar.buttons[name] }
        func tap(_ name: String) {
            XCTAssertTrue(tab(name).waitForExistence(timeout: 15) && tab(name).isHittable,
                          "Native tab is missing or isolated")
            tab(name).tap()
        }
        tap("Chat")
        XCTAssertEqual(hosts.count, 1, "Tabs must use one identified Capacitor WebView")
        XCTAssertEqual(app.webViews.count, 1 + webView.webViews.count,
                       "Every WebView accessibility node must belong to the same Capacitor host")
        let history = webView.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Open chat history")).firstMatch
        XCTAssertTrue(history.waitForExistence(timeout: 30), "Chat did not settle without another vault unlock")
        history.tap()
        let close = app.buttons["Close chat history"]
        XCTAssertTrue(close.waitForExistence(timeout: 10))
        XCTAssertFalse(bar.exists && bar.isHittable, "Native tabs escaped the web overlay")
        close.tap()
        tap("One")
        XCTAssertFalse(webView.buttons["Unlock"].exists, "A tab switch lost the unlocked session")
        tap("Connect")
        tap("Feed")
        tap("Chat")
        XCTAssertTrue(history.waitForExistence(timeout: 30))
        XCTAssertEqual(hosts.count, 1)
        XCTAssertEqual(app.webViews.count, 1 + webView.webViews.count,
                       "Tab switching introduced another WebView host")
        XCTAssertTrue(tab("Chat").isSelected, "Final selection did not match the settled Chat destination")
        XCTAssertFalse(tab("Search").exists, "Archived Search remained in native navigation")
        print("NATIVE_NAVIGATION_CONTINUITY tabs_overlay_single_webview")
    }

    func testLocalSessionNativeBottomChromeFollowsTheSharedScrollOwner() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_LOCAL_SESSION_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in warm native scroll regression")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            XCTFail("NATIVE_BOTTOM_SCROLL_REQUIRES_RUNNING_SESSION"); return
        }
        app.activate(); dismissRehearsalChatKeyboard(app)
        for label in ["Close Profile", "Close chat history", "Close search"] {
            let close = app.buttons[label].firstMatch
            if close.exists && close.isHittable { close.tap() }
        }
        perfTapNav(app, label: "Chat")
        let editor = app.textViews["native-dock-editor"].firstMatch
        guard waitForAdmittedControl(editor) else { XCTFail("NATIVE_BOTTOM_SCROLL_CHAT_NOT_ADMITTED"); return }
        let initialDraft = editor.value as? String // Process-only, never an artifact.
        let web = app.webViews.matching(identifier: "native-webview").firstMatch
        let webFrame = web.frame
        // The compact launcher may correctly have no overflow. Qualify the
        // actual Feed page without changing roster preferences or adding rows.
        perfTapNav(app, label: "Feed")
        if app.buttons["native-test-status"].exists && !waitForNativeRoute(app, route: "/one/feed", timeout: 15) {
            XCTFail("NATIVE_BOTTOM_SCROLL_FEED_ROUTE_NOT_ADMITTED"); return
        }
        let bar = app.descendants(matching: .any).matching(identifier: "one-native-navigation").firstMatch
        // Observe the rendered dock child, not an optional AX container.
        let dock = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Talk to One")).firstMatch
        guard waitForAdmittedControl(bar), waitForAdmittedControl(dock) else {
            reportNativeDockAdmission(app)
            XCTFail("NATIVE_BOTTOM_SCROLL_FEED_NOT_ADMITTED"); return
        }
        var returnedToChat = false
        defer {
            if !returnedToChat { perfTapNav(app, label: "Chat") }
        }
        let layout = app.buttons["native-vault-layout"].firstMatch
        if layout.exists {
            let overflow = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                guard let raw = layout.value as? String, let data = raw.data(using: .utf8),
                      let packet = try? JSONSerialization.jsonObject(with: data) as? [String: NSNumber] else { return false }
                return (packet["appScrollRange"]?.doubleValue ?? 0) >= 100
            }, object: app)
            guard XCTWaiter.wait(for: [overflow], timeout: 10) == .completed else {
                reportNativeDockAdmission(app)
                XCTFail("NATIVE_BOTTOM_SCROLL_REQUIRES_ACTUAL_FEED_OVERFLOW"); return
            }
        }
        let baseline = bar.frame.minY, dockBaseline = dock.frame.minY
        print("NATIVE_BOTTOM_SCROLL_FRAME stage=baseline navigationY=\(baseline) dockY=\(dockBaseline)")
        // Anchor touch coordinates to the application, not WebKit's scrolling
        // accessibility node. A coordinate re-resolved from the latter can
        // move with the content between the two halves of a reverse gesture.
        let origin = app.coordinate(withNormalizedOffset: .zero)
        let start = origin.withOffset(CGVector(dx: webFrame.minX + webFrame.width * 0.97,
                                               dy: webFrame.minY + webFrame.height * 0.65))
        let end = origin.withOffset(CGVector(dx: webFrame.minX + webFrame.width * 0.97,
                                             dy: webFrame.minY + webFrame.height * 0.25))
        // Three cycles protect reversal/repetition; endurance and frame pacing
        // belong to the separate Release qualification, not this core smoke.
        for _ in 0..<3 {
            // Pan in the shared page gutter, never through an actionable tile.
            start.press(forDuration: 0.05, thenDragTo: end, withVelocity: XCUIGestureVelocity(rawValue: 400), thenHoldForDuration: 0)
            let moved = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                bar.frame.minY >= app.frame.maxY - 1
            }, object: app)
            guard XCTWaiter.wait(for: [moved], timeout: 5) == .completed else {
                print("NATIVE_BOTTOM_SCROLL_FRAME stage=maximum navigationY=\(bar.frame.minY) navigationHeight=\(bar.frame.height) viewportBottom=\(app.frame.maxY)")
                reportNativeDockAdmission(app)
                XCTFail("NATIVE_BOTTOM_SCROLL_DID_NOT_CLEAR_VIEWPORT"); return
            }
            XCTAssertGreaterThan(dock.frame.minY, dockBaseline + 6,
                "NATIVE_BOTTOM_SCROLL_DOCK_DID_NOT_FOLLOW")
            XCTAssertLessThan(dock.frame.maxY, app.frame.maxY - 1,
                "NATIVE_BOTTOM_SCROLL_DOCK_CLIPPED_BY_VIEWPORT")
            XCTAssertEqual(web.frame, webFrame, "NATIVE_BOTTOM_SCROLL_RESIZED_WEBVIEW")
            // Touch-tracking freeze has native unit coverage. Do not combine
            // a selection (which deliberately snaps the chrome) with reversal.
            web.swipeDown(velocity: XCUIGestureVelocity(rawValue: 400))
            let restored = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in abs(bar.frame.minY - baseline) <= 1 }, object: app)
            guard XCTWaiter.wait(for: [restored], timeout: 5) == .completed else {
                reportNativeDockAdmission(app)
                print("NATIVE_BOTTOM_SCROLL_FRAME stage=reverse navigationY=\(bar.frame.minY) dockY=\(dock.frame.minY)")
                XCTFail("NATIVE_BOTTOM_SCROLL_REVERSE_DID_NOT_RESTORE"); return
            }
            XCTAssertEqual(dock.frame.minY, dockBaseline, accuracy: 1)
        }
        perfTapNav(app, label: "Chat")
        guard waitForAdmittedControl(editor) else { XCTFail("NATIVE_BOTTOM_SCROLL_CHAT_NOT_RESTORED"); return }
        XCTAssertTrue((editor.value as? String) == initialDraft, "NATIVE_BOTTOM_SCROLL_CHANGED_DRAFT")
        editor.tap()
        guard app.keyboards.firstMatch.waitForExistence(timeout: 10) else { XCTFail("NATIVE_BOTTOM_SCROLL_KEYBOARD_UNAVAILABLE"); return }
        XCTAssertLessThanOrEqual(editor.frame.maxY, app.keyboards.firstMatch.frame.minY + 2)
        dismissRehearsalChatKeyboard(app)
        XCTAssertEqual(app.webViews.matching(identifier: "native-webview").count, 1)
        XCTAssertFalse(web.buttons["Unlock"].exists)
        returnedToChat = true
        print("NATIVE_BOTTOM_SCROLL_CONTINUITY cycles=3 pair=true keyboard=true draft=true single_host=true")
    }

    func testLocalSessionNativeBackRetiresUnderProfileAndReturnsToOne() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_NATIVE_CHROME_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in Back pilot acceptance; requires the current Debug candidate")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            throw XCTSkip("One must already be running and unlocked; no cold launch or credential typing")
        }
        app.activate()
        dismissRehearsalChatKeyboard(app)
        let hosts = app.webViews.matching(identifier: "native-webview")
        let webView = hosts.firstMatch
        XCTAssertTrue(webView.waitForExistence(timeout: 15), "The existing Capacitor host is unavailable")
        for label in ["Close Profile", "Close chat history", "Close search"] {
            let close = app.buttons[label].firstMatch
            if close.exists && close.isHittable { close.tap() }
        }
        XCTAssertFalse(webView.buttons["Unlock"].exists, "The candidate requires a normal vault unlock before warm-session proof")
        XCTAssertFalse(app.buttons["Continue with Google"].exists, "Warm-session proof cannot substitute a new sign-in")
        let bar = app.descendants(matching: .any).matching(identifier: "one-native-navigation").firstMatch
        let one = bar.buttons["One"]
        XCTAssertTrue(one.waitForExistence(timeout: 15) && one.isHittable,
                      "The existing session has not admitted native navigation")
        one.tap()
        let wallet = webView.links["Open Wallet"].firstMatch
        XCTAssertTrue(wallet.waitForExistence(timeout: 15), "One must expose the existing Wallet route")
        for _ in 0..<3 {
            if wallet.isHittable { break }
            webView.swipeUp()
        }
        XCTAssertTrue(wallet.isHittable)
        wallet.tap()
        let back = app.buttons["top-shell-back"].firstMatch
        XCTAssertTrue(back.waitForExistence(timeout: 10) && back.isHittable,
                      "The candidate did not admit the native Back pilot")
        XCTAssertEqual(back.frame.width, 44, accuracy: 1)
        XCTAssertEqual(back.frame.height, 44, accuracy: 1)
        // Physical WebKit's AX subtree includes the sibling hosting view. The
        // same native button may therefore match the WebView label query;
        // exclude only its explicit identifier, never an unnamed DOM duplicate.
        XCTAssertEqual(app.buttons.matching(identifier: "top-shell-back").count, 1)
        let domBack = webView.buttons.matching(NSPredicate(
            format: "label == %@ AND identifier != %@", "Go back", "top-shell-back"
        )).firstMatch
        XCTAssertFalse(domBack.exists, "DOM and native Back must not both be accessible")
        XCTAssertFalse(webView.buttons["Unlock"].exists, "Wallet lost the unlocked session")
        XCTAssertEqual(hosts.count, 1)

        let probe = app.buttons["native-back-continuity"].firstMatch
        func counters() -> [String: Int]? {
            guard probe.exists, let json = probe.value as? String, let data = json.data(using: .utf8),
                  let packet = try? JSONSerialization.jsonObject(with: data) as? [String: Int],
                  Set(packet.keys) == Set(["installs", "removals", "replacements", "rootUpdates", "sampledFrames", "missingFrames"])
            else { return nil }
            return packet
        }
        guard let beforeOverlay = counters() else { XCTFail("NATIVE_BACK_MEASUREMENTS_UNAVAILABLE"); return }

        let profile = app.buttons["Open Profile"].firstMatch
        XCTAssertTrue(profile.exists && profile.isHittable)
        XCTAssertGreaterThanOrEqual(profile.frame.width, 44)
        XCTAssertGreaterThanOrEqual(profile.frame.height, 44)
        profile.tap()
        let close = app.buttons["Close Profile"].firstMatch
        XCTAssertTrue(close.waitForExistence(timeout: 10) && close.isHittable)
        let overlayRetirement = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: back)
        XCTAssertEqual(XCTWaiter.wait(for: [overlayRetirement], timeout: 10), .completed,
                       "Native Back remained accessible under the Profile overlay")
        XCTAssertGreaterThan(counters()?["removals"] ?? -1, beforeOverlay["removals", default: 0],
                             "The measurement negative control did not observe physical removal")
        close.tap()
        XCTAssertTrue(back.waitForExistence(timeout: 10) && back.isHittable)

        XCUIDevice.shared.press(.home)
        XCTAssertTrue(app.wait(for: .runningBackground, timeout: 5) || app.state == .runningBackgroundSuspended,
                      "One did not enter the background")
        guard [.runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            XCTFail("One stopped while backgrounded; the test must not cold-launch it")
            return
        }
        app.activate()
        XCTAssertTrue(back.waitForExistence(timeout: 10) && back.isHittable,
                      "Back did not recover after normal background/resume")
        XCTAssertFalse(webView.buttons["Unlock"].exists, "Resume lost the unlocked session")
        // Exercise the edge of the admitted 44pt target, not only its glyph.
        back.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5)).tap()
        XCTAssertTrue(wallet.waitForExistence(timeout: 15), "Back did not invoke the existing return-to-One handler")
        let routeRetirement = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: back)
        XCTAssertEqual(XCTWaiter.wait(for: [routeRetirement], timeout: 10), .completed,
                       "Native Back remained accessible after returning to One")

        // Consent tabs change the authored route query while retaining the
        // same Back geometry. Unlike local Mail pager state, this exercises
        // the actual replacement contract, not merely same-route stability.
        let consent = webView.links["Open Consent"].firstMatch
        XCTAssertTrue(consent.waitForExistence(timeout: 15), "CONSENT_ENTRY_UNAVAILABLE")
        for _ in 0..<4 { if consent.isHittable { break }; webView.swipeDown() }
        for _ in 0..<4 { if consent.isHittable { break }; webView.swipeUp() }
        XCTAssertTrue(consent.isHittable)
        consent.tap()
        XCTAssertTrue(back.waitForExistence(timeout: 10) && back.isHittable)
        let measured = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            (counters()?["sampledFrames"] ?? 0) > 0
        }, object: probe)
        XCTAssertEqual(XCTWaiter.wait(for: [measured], timeout: 5), .completed, "NATIVE_BACK_MEASUREMENTS_UNAVAILABLE")
        let originalFrame = back.frame
        var completedHandoffs = 0
        for name in ["Active", "History", "Connections", "Requests"] {
            let tab = webView.buttons.matching(NSPredicate(format: "label == %@", name)).firstMatch
            XCTAssertTrue(tab.waitForExistence(timeout: 10) && tab.isHittable)
            if tab.isSelected { continue }
            guard let before = counters() else { XCTFail("NATIVE_BACK_MEASUREMENTS_UNAVAILABLE"); return }
            tab.tap()
            let replaced = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                guard let after = counters() else { return false }
                return tab.isSelected && back.exists && back.isHittable &&
                    after["replacements", default: 0] > before["replacements", default: 0] &&
                    after["sampledFrames", default: 0] > before["sampledFrames", default: 0]
            }, object: probe)
            XCTAssertEqual(XCTWaiter.wait(for: [replaced], timeout: 10), .completed, "NATIVE_BACK_REPLACEMENT_NOT_OBSERVED")
            guard let activated = counters() else { XCTFail("NATIVE_BACK_MEASUREMENTS_UNAVAILABLE"); return }
            // A frame before replacement can advance the global sample count.
            // Require another published frame after fresh native activation.
            let displayed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                (counters()?["sampledFrames"] ?? -1) > activated["sampledFrames", default: 0]
            }, object: probe)
            XCTAssertEqual(XCTWaiter.wait(for: [displayed], timeout: 5), .completed, "NATIVE_BACK_POST_ACTIVATION_FRAME_UNOBSERVED")
            guard let after = counters() else { XCTFail("NATIVE_BACK_MEASUREMENTS_UNAVAILABLE"); return }
            XCTAssertEqual(after["installs"], before["installs"], "Route transition rebuilt the native host")
            XCTAssertEqual(after["removals"], before["removals"], "Route transition removed the native host")
            XCTAssertEqual(after["rootUpdates"], before["rootUpdates"], "Unchanged Back presentation rebound its SwiftUI root")
            XCTAssertEqual(after["missingFrames"], before["missingFrames"], "Route transition hid or detached the native control")
            XCTAssertEqual(back.frame, originalFrame)
            XCTAssertFalse(domBack.exists, "Replacement exposed a duplicate DOM Back")
            completedHandoffs += 1
        }
        XCTAssertGreaterThan(completedHandoffs, 0, "No qualifying Back handoff was exercised")
        back.tap()
        XCTAssertTrue(wallet.waitForExistence(timeout: 15), "Fresh Back did not invoke the authored return handler")
        XCTAssertFalse(webView.buttons["Unlock"].exists)
        XCTAssertEqual(hosts.count, 1, "Back introduced another Capacitor host")
        XCTAssertEqual(app.webViews.count, 1 + webView.webViews.count)
        print("NATIVE_BACK_REPLACEMENT_CONTINUITY query_tabs_retained_host_observed_frames_current_handler")
        print("NATIVE_BACK_CONTINUITY layout_overlay_resume_existing_handler_single_host")
    }

    func testLocalSessionNativeDockKeepsDraftAndKeyboardAcrossRoutes() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_NATIVE_DOCK_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in native dock warm-session proof")
        }
        let app = XCUIApplication()
        print("NATIVE_DOCK_STAGE stage=entry")
        defer { reportNativeDockAdmission(app) }
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            XCTFail("NATIVE_DOCK_REQUIRES_RUNNING_APP"); return
        }
        app.activate()
        let hosts = app.webViews.matching(identifier: "native-webview"), web = hosts.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 15), "NATIVE_DOCK_HOST_UNAVAILABLE")
        XCTAssertFalse(web.buttons["Unlock"].exists, "Normal unlock must precede the warm dock proof")
        XCTAssertFalse(web.buttons["Continue with Google"].exists, "No reviewer bootstrap in continuity proof")
        returnToRehearsalChat(app)
        let editor = app.textViews["native-dock-editor"].firstMatch
        guard editor.waitForExistence(timeout: 10) && editor.isHittable else {
            let chatSelected = app.buttons["one-native-tab-chat"].firstMatch.isSelected
            let profileOpen = app.buttons["Close Profile"].firstMatch.exists
            let historyOpen = app.buttons["Close chat history"].firstMatch.exists
            print("NATIVE_DOCK_ROUTE_ADMISSION chat_selected=\(chatSelected) profile_open=\(profileOpen) history_open=\(historyOpen)")
            // Classify presentation versus accessibility admission before any
            // private input. Never inspect values, private labels, projections or the
            // accessibility tree, including when an existing draft is present.
            let exact = app.descendants(matching: .any).matching(identifier: "native-dock-editor")
            let nativeDock = app.descendants(matching: .any).matching(identifier: "native-agent-dock").firstMatch
            let namedEditors = app.textViews.matching(NSPredicate(format: "label == %@", "Message One"))
            let namedWebEditors = web.textViews.matching(NSPredicate(format: "label == %@", "Message One"))
            print("NATIVE_DOCK_ADMISSION editor_exists=\(editor.exists) editor_hittable=\(editor.exists && editor.isHittable) identifier_count=\(exact.count) named_editor_count=\(namedEditors.count) named_web_editor_count=\(namedWebEditors.count) dock_exists=\(nativeDock.exists) dock_hittable=\(nativeDock.exists && nativeDock.isHittable)")
            for (name, element) in [("window", app), ("dock", nativeDock), ("editor", editor)] {
                let frame = element.exists ? element.frame : .zero
                let bounds = [frame.minX, frame.minY, frame.width, frame.height]
                let finite = bounds.allSatisfy { $0.isFinite }
                let bounded = bounds.map { $0.isFinite ? Int(max(-100_000, min(100_000, $0))) : 0 }
                print("NATIVE_DOCK_ADMISSION_GEOMETRY control=\(name) finite=\(finite) x=\(bounded[0]) y=\(bounded[1]) width=\(bounded[2]) height=\(bounded[3])")
            }
            XCTFail("NATIVE_DOCK_EDITOR_UNAVAILABLE"); return
        }
        let draft = "Dock continuity 👋\nSecond line"
        // A prior interrupted run may leave only this exact synthetic draft.
        // Remove it through the editor, never clear any other reviewer input.
        if (editor.value as? String) == draft {
            editor.tap()
            editor.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: draft.utf16.count))
        }
        let existing = editor.value as? String ?? ""
        guard existing.isEmpty else {
            print("NATIVE_DOCK_DRAFT_ADMISSION exact_synthetic=\(existing == draft) placeholder_only=\(existing == "Message One")")
            XCTFail("NATIVE_DOCK_REQUIRES_EMPTY_REVIEWER_DRAFT"); return // Never overwrite an existing draft.
        }
        defer {
            returnToRehearsalChat(app)
            if editor.exists && (editor.value as? String) == draft {
                editor.tap(); editor.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: draft.utf16.count))
                XCTAssertTrue(dismissDockKeyboardThroughProfile(app, requireInterruption: true), "NATIVE_DOCK_CLEANUP_KEYBOARD_DISMISS_FAILED")
            }
        }
        let continuity = app.buttons["native-history-continuity"].firstMatch
        func counters() -> [String: Int]? {
            guard continuity.exists, let json = continuity.value as? String,
                  let data = json.data(using: .utf8),
                  let packet = try? JSONSerialization.jsonObject(with: data) as? [String: Int],
                  Set(packet.keys) == Set(["installs", "removals", "replacements", "rootUpdates", "sampledFrames", "missingFrames"]) else { return nil }
            return packet
        }
        let beforeKeyboard = try XCTUnwrap(counters(), "NATIVE_DOCK_KEYBOARD_CONTINUITY_PROBE_UNAVAILABLE")
        print("NATIVE_DOCK_STAGE stage=keyboard_open")
        editor.tap()
        XCTAssertTrue(waitForSoftwareKeyboard(app), "NATIVE_DOCK_SOFTWARE_KEYBOARD_UNAVAILABLE")
        print("NATIVE_DOCK_STAGE stage=typing")
        editor.typeText(draft)
        print("NATIVE_DOCK_STAGE stage=typed")
        XCTAssertTrue((editor.value as? String) == draft, "NATIVE_DOCK_UNICODE_OR_NEWLINE_LOST")
        XCTAssertLessThanOrEqual(editor.frame.maxY, app.keyboards.firstMatch.frame.minY - 4,
            "NATIVE_DOCK_KEYBOARD_OVERLAP")
        let duringKeyboard = try XCTUnwrap(counters(), "NATIVE_DOCK_KEYBOARD_CONTINUITY_PROBE_LOST")
        XCTAssertEqual(duringKeyboard["installs"], beforeKeyboard["installs"], "NATIVE_DOCK_KEYBOARD_REINSTALLED_CHROME")
        XCTAssertEqual(duringKeyboard["removals"], beforeKeyboard["removals"], "NATIVE_DOCK_KEYBOARD_RETIRED_CHROME")
        XCTAssertEqual(duringKeyboard["missingFrames"], beforeKeyboard["missingFrames"], "NATIVE_DOCK_KEYBOARD_MISSING_CHROME")
        // Exercise the normal software-keyboard interruption. Hardware Escape
        // delivery is a separate, currently unqualified device acceptance gate.
        // Public NativeChrome controls retain presentation while interaction
        // is fenced for the keyboard;
        // the existing React Profile opener remains the authored touch path.
        XCTAssertTrue(dismissDockKeyboardThroughProfile(app, requireInterruption: true), "NATIVE_DOCK_KEYBOARD_DISMISS_FAILED")
        print("NATIVE_DOCK_STAGE stage=keyboard_closed")
        reportNativeDockAdmission(app)
        for cycle in 0..<10 {
            let beforeRoute = try XCTUnwrap(counters(), "NATIVE_CHAT_ROUTE_CONTINUITY_PROBE_UNAVAILABLE")
            print("NATIVE_DOCK_STAGE stage=one_route cycle=\(cycle + 1)")
            perfTapNav(app, label: "One")
            let dock = app.descendants(matching: .any).matching(identifier: "native-agent-dock").firstMatch
            XCTAssertTrue(dock.waitForExistence(timeout: 10), "NATIVE_DOCK_VOICE_PRESENTATION_UNAVAILABLE")
            let history = app.buttons["chat-history-toggle"].firstMatch
            let selector = app.segmentedControls["chat-agent-surface"].firstMatch
            let retired = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                // Suspended hosts deliberately hide accessibility but retain
                // their pixels. Require actual removal, not AX absence alone.
                !history.exists && !selector.exists &&
                (counters()?["removals"] ?? 0) > (beforeRoute["removals"] ?? 0)
            }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [retired], timeout: 5), .completed,
                "NATIVE_CHAT_CONTROLS_LEAKED_TO_ONE")
            print("NATIVE_DOCK_STAGE stage=chat_route cycle=\(cycle + 1)")
            perfTapNav(app, label: "Chat")
            XCTAssertTrue(editor.waitForExistence(timeout: 10) && editor.isHittable, "NATIVE_DOCK_ROUTE_RETURN_UNAVAILABLE")
            XCTAssertTrue(history.waitForExistence(timeout: 5) && selector.waitForExistence(timeout: 5),
                "NATIVE_CHAT_CONTROLS_NOT_RESTORED")
            XCTAssertTrue((editor.value as? String) == draft, "NATIVE_DOCK_ROUTE_RETURN_LOST_DRAFT")
            XCTAssertFalse(web.textViews["Message One"].firstMatch.isHittable, "An interactive web duplicate must not appear")
            XCTAssertEqual(hosts.count, 1)
        }
        // Teardown clears only this exact synthetic draft through its owner.
        print("NATIVE_DOCK_CONTINUITY ten_warm_routes_unicode_newline_keyboard_no_web_duplicate")
    }

    func testLocalSessionNativeMaterialFoundationContainsReactOverlays() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_NATIVE_MATERIAL_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in retained native coverage and full-height drawer proof")
        }
        print("NATIVE_MATERIAL_TEST_BODY_ENTERED")
        let app = XCUIApplication()
        defer { reportNativeDockAdmission(app) }
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            XCTFail("NATIVE_MATERIAL_REQUIRES_RUNNING_SESSION"); return
        }
        app.activate()
        let hosts = app.webViews.matching(identifier: "native-webview"), web = hosts.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 15))
        XCTAssertFalse(web.buttons["Unlock"].exists, "NATIVE_MATERIAL_REQUIRES_NORMAL_UNLOCK")
        print("NATIVE_MATERIAL_PREFLIGHT keyboard_onscreen=\(softwareKeyboardIsOnscreen(app.keyboards.firstMatch, in: app))")
        guard dismissDockKeyboardThroughProfile(app) else {
            XCTFail("NATIVE_MATERIAL_KEYBOARD_DISMISS_FAILED"); return
        }
        let probe = app.buttons["native-navigation-presentation"].firstMatch
        XCTAssertTrue(probe.waitForExistence(timeout: 10))
        func packet() -> [String: Any]? {
            guard let raw = probe.value as? String, let data = raw.data(using: .utf8),
                  let fields = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  fields["contentBacked"] as? Bool == true,
                  fields["underlay"] as? Bool == false else { return nil }
            return fields
        }
        func admitted() -> Bool {
            let state = packet()
            return state?["visible"] as? Bool == true && state?["interactive"] as? Bool == true
        }
        let editor = app.textViews["native-dock-editor"].firstMatch
        guard waitForAdmittedControl(editor) else {
            reportNativeDockAdmission(app)
            XCTFail("NATIVE_MATERIAL_EDITOR_NOT_ADMITTED"); return
        }
        XCTAssertTrue(admitted(), "NATIVE_MATERIAL_NOT_CONTENT_BACKED")
        let profile = app.buttons["Open Profile"].firstMatch
        let history = app.buttons["chat-history-toggle"].firstMatch
        let profileClose = app.buttons["Close Profile"].firstMatch
        let historyClose = app.buttons["Close chat history"].firstMatch
        let selector = app.segmentedControls["chat-agent-surface"].firstMatch
        XCTAssertTrue(waitForAdmittedControl(selector), "NATIVE_MATERIAL_AGENT_SELECTOR_NOT_ADMITTED")
        let selectorFrame = selector.frame
        let layout = app.buttons["native-vault-layout"].firstMatch
        XCTAssertTrue(layout.waitForExistence(timeout: 10), "NATIVE_MATERIAL_DRAWER_PROBE_UNAVAILABLE")
        addTeardownBlock {
            if profileClose.exists && profileClose.isHittable { profileClose.tap() }
            if historyClose.exists && historyClose.isHittable { historyClose.tap() }
        }
        func heldMeasurements() -> [String: NSNumber]? {
            guard let raw = layout.value as? String, let data = raw.data(using: .utf8) else { return nil }
            return try? JSONSerialization.jsonObject(with: data) as? [String: NSNumber]
        }
        let beforeHold = heldMeasurements()
        let origin = web.coordinate(withNormalizedOffset: .zero)
        let bodyY = editor.frame.minY - web.frame.minY - 48
        XCTAssertGreaterThan(bodyY, history.frame.maxY - web.frame.minY + 44,
            "NATIVE_MATERIAL_HOLD_BODY_CLEARANCE_UNAVAILABLE")
        // Actual touch input in the empty transcript clearance. Keep the finger
        // down at a partial opening; numeric samples run during the held touch.
        let start = origin.withOffset(CGVector(dx: web.frame.width * 0.70, dy: bodyY))
        let end = origin.withOffset(CGVector(dx: web.frame.width * 0.52, dy: bodyY))
        start.press(forDuration: 0.05, thenDragTo: end,
            withVelocity: .slow, thenHoldForDuration: 2.0)
        let afterHold = heldMeasurements()
        let held = (afterHold?["heldDrawerSamples"]?.intValue ?? 0) - (beforeHold?["heldDrawerSamples"]?.intValue ?? 0)
        let missing = (afterHold?["heldDrawerMissingPlaneSamples"]?.intValue ?? 0) - (beforeHold?["heldDrawerMissingPlaneSamples"]?.intValue ?? 0)
        print("NATIVE_MATERIAL_HELD_DRAWER samples=\(held) missing_plane=\(missing)")
        XCTAssertGreaterThan(held, 0, "NATIVE_MATERIAL_PARTIAL_HOLD_NOT_OBSERVED")
        XCTAssertEqual(missing, 0, "NATIVE_MATERIAL_UNCOVERED_GLASS_HIDDEN_DURING_HOLD")
        // Release may either cancel the opening drag or commit the drawer.
        // Do not tap a transient Close while a cancelled preview is retiring.
        let released = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            if editor.exists && editor.isHittable { return true }
            guard profileClose.exists && profileClose.isHittable,
                  let values = heldMeasurements() else { return false }
            return values["drawerKind"]?.intValue == 1 && values["drawerSettled"]?.boolValue == true
        }, object: layout)
        guard XCTWaiter.wait(for: [released], timeout: 10) == .completed else {
            reportNativeDockAdmission(app)
            XCTFail("NATIVE_MATERIAL_HELD_RELEASE_NOT_SETTLED"); return
        }
        if !(editor.exists && editor.isHittable) { profileClose.tap() }
        XCTAssertTrue(waitForAdmittedControl(editor), "NATIVE_MATERIAL_HELD_DRAWER_WARM_RETURN_FAILED")
        for (opener, close, family) in [(profile, profileClose, "profile"), (history, historyClose, "history")] {
            for cycle in 0..<10 {
                XCTAssertTrue(waitForAdmittedControl(opener), "NATIVE_MATERIAL_OPENER_NOT_ADMITTED")
                opener.tap()
                XCTAssertTrue(waitForAdmittedControl(close), "NATIVE_MATERIAL_REACT_CLOSE_NOT_ADMITTED")
                let covered = packet()
                XCTAssertEqual(covered?["covered"] as? Bool, true, "NATIVE_MATERIAL_FULL_HEIGHT_COVER_MISSING")
                XCTAssertEqual(covered?["retained"] as? Bool, true, "NATIVE_MATERIAL_HOST_REMOVED_DURING_DRAWER")
                XCTAssertEqual(covered?["interactive"] as? Bool, false, "NATIVE_MATERIAL_COVERED_ACTION_ADMITTED")
                XCTAssertEqual(covered?["accessibilityHidden"] as? Bool, true)
                XCTAssertFalse(editor.exists && editor.isHittable, "NATIVE_MATERIAL_COVERED_EDITOR_ADMITTED")
                XCTAssertFalse(selector.exists && selector.isHittable, "NATIVE_MATERIAL_COVERED_SELECTOR_ADMITTED")
                // WebKit can project the Profile heading as an Other named
                // "Profile", without exposing the dialog's rectangle. Bind
                // layout to the authored pane and independently prove both
                // edge hit owners; do not waive a clipped or shortened pane.
                var bounds: [String: NSNumber]?
                let paneReady = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                    guard let raw = layout.value as? String, let data = raw.data(using: .utf8),
                          let values = try? JSONSerialization.jsonObject(with: data) as? [String: NSNumber],
                          values["drawerKind"]?.intValue == (family == "profile" ? 1 : 2),
                          values["drawerSettled"]?.boolValue == true else { return false }
                    bounds = values; return true
                }, object: layout)
                guard XCTWaiter.wait(for: [paneReady], timeout: 10) == .completed,
                      let bounds, let top = bounds["drawerTop"]?.doubleValue,
                      let bottom = bounds["drawerBottom"]?.doubleValue,
                      let height = bounds["drawerViewportHeight"]?.doubleValue,
                      [top, bottom, height].allSatisfy({ $0.isFinite }) else {
                    XCTFail("NATIVE_MATERIAL_DRAWER_FRAME_UNAVAILABLE"); return
                }
                print("NATIVE_DRAWER_GEOMETRY family=\(family) top=\(Int(top)) bottom=\(Int(bottom)) viewport_top=0 viewport_bottom=\(Int(height))")
                XCTAssertEqual(top, 0, accuracy: 1, "NATIVE_MATERIAL_DRAWER_TOP_NOT_EDGE_TO_EDGE")
                XCTAssertEqual(bottom, height, accuracy: 1, "NATIVE_MATERIAL_DRAWER_BOTTOM_NOT_EDGE_TO_EDGE")
                XCTAssertEqual(bounds["drawerOwnsTopEdge"]?.boolValue, true, "NATIVE_MATERIAL_DRAWER_TOP_EDGE_NOT_ADMITTED")
                XCTAssertEqual(bounds["drawerOwnsBottomEdge"]?.boolValue, true, "NATIVE_MATERIAL_DRAWER_BOTTOM_EDGE_NOT_ADMITTED")
                // The navigation admission packet is not a live per-pose paint
                // sample. A partly exposed or narrower drawer must not require
                // whole-plane concealment. Compare the independent current
                // native clip with settled authored geometry instead.
                guard let left = bounds["drawerLeft"]?.doubleValue,
                      let right = bounds["drawerRight"]?.doubleValue,
                      let exposureX = bounds["baseExposureX"]?.doubleValue,
                      let exposureWidth = bounds["baseExposureWidth"]?.doubleValue,
                      [left, right, exposureX, exposureWidth].allSatisfy({ $0.isFinite }) else {
                    XCTFail("NATIVE_MATERIAL_COVERAGE_FRAME_UNAVAILABLE"); return
                }
                let edge = min(web.frame.width, max(0, family == "profile" ? left : right))
                let expectedX = family == "profile" ? 0 : edge
                let expectedWidth = family == "profile" ? edge : web.frame.width - edge
                XCTAssertEqual(exposureX, expectedX, accuracy: 1, "NATIVE_MATERIAL_CLIP_ORIGIN_DETACHED")
                XCTAssertEqual(exposureWidth, expectedWidth, accuracy: 1, "NATIVE_MATERIAL_CLIP_PAINTS_OVER_OR_HIDES_EXPOSED_AREA")
                print("NATIVE_DRAWER_EXPOSURE family=\(family) measured=\(Int(exposureWidth)) expected=\(Int(expectedWidth))")
                close.tap()
                let returned = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                    admitted() && editor.exists && editor.isHittable && opener.exists && opener.isHittable &&
                      selector.exists && selector.isHittable && packet()?["planeVisible"] as? Bool == true
                }, object: probe)
                XCTAssertEqual(XCTWaiter.wait(for: [returned], timeout: 10), .completed, "NATIVE_MATERIAL_WARM_RETURN_FAILED")
                XCTAssertEqual(hosts.count, 1)
                XCTAssertEqual(selector.frame, selectorFrame, "NATIVE_MATERIAL_SELECTOR_SLOT_SHIFTED")
                XCTAssertFalse(web.textViews["Message One"].firstMatch.isHittable)
                XCTAssertFalse(web.buttons["One, your cloud agent"].firstMatch.isHittable,
                    "NATIVE_MATERIAL_INTERACTIVE_WEB_SELECTOR_DUPLICATE")
                print("NATIVE_MATERIAL_CYCLE family=\(family) completed=\(cycle + 1)")
            }
        }
        let cloud = selector.buttons["One, your cloud agent"].firstMatch
        let puppy = selector.buttons["Puppy One"].firstMatch
        for cycle in 0..<10 {
            guard waitForAdmittedControl(puppy) else { XCTFail("NATIVE_MATERIAL_PUPPY_SEGMENT_UNAVAILABLE"); return }
            puppy.tap()
            XCTAssertTrue(waitForAdmittedControl(cloud), "NATIVE_MATERIAL_CLOUD_SEGMENT_UNAVAILABLE")
            cloud.tap()
            XCTAssertTrue(waitForAdmittedControl(editor), "NATIVE_MATERIAL_SELECTOR_WARM_RETURN_FAILED")
            XCTAssertEqual(hosts.count, 1)
            print("NATIVE_MATERIAL_CYCLE family=agent_selector completed=\(cycle + 1)")
        }
        print("NATIVE_MATERIAL_RETAINED_COVER_CONFIRMED")
    }

    private func reportNativeDockAdmission(_ app: XCUIApplication) {
        let bar = app.descendants(matching: .any).matching(identifier: "one-native-navigation").firstMatch
        for title in ["Chat", "One"] {
            let key = title == "One" ? "dashboard" : title.lowercased()
            let authored = app.buttons["one-native-tab-\(key)"].firstMatch
            let scoped = bar.buttons[title].firstMatch
            for (kind, target) in [("identifier", authored), ("native_label", scoped)] {
                let present = target.exists
                print("NATIVE_TAB_ADMISSION target=\(title.lowercased()) kind=\(kind) present=\(present) hittable=\(present && target.isHittable) enabled=\(present && target.isEnabled)")
            }
        }
        let navigation = app.buttons["native-navigation-presentation"].firstMatch
        if navigation.exists, let raw = navigation.value as? String, let data = raw.data(using: .utf8),
           let packet = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            for key in ["visible", "interactive", "covered", "planeVisible", "retained", "accessibilityHidden", "scrollFollowing", "scrollActive", "scrollPressHeld", "keyboardVisible"] {
                if let value = packet[key] as? Bool { print("NATIVE_NAVIGATION_ADMISSION key=\(key) value=\(value)") }
            }
            for key in ["scrollOffset", "scrollSequence"] {
                if let value = packet[key] as? NSNumber, value.doubleValue.isFinite, abs(value.doubleValue) <= 100_000 {
                    print("NATIVE_PUBLIC_GEOMETRY key=\(key) value=\(value.doubleValue)")
                }
            }
        }
        let layout = app.buttons["native-vault-layout"].firstMatch
        if layout.exists, let raw = layout.value as? String, let data = raw.data(using: .utf8),
           let packet = try? JSONSerialization.jsonObject(with: data) as? [String: NSNumber] {
            for key in ["dockActive", "dockFailureStage", "dockFailureCode", "regionRefusal", "initialTopDelta", "initialBottomDelta", "initialWidthDelta", "drawerKind", "drawerSettled", "drawerLeft", "drawerRight", "baseExposureWidth", "kbOpen", "nativeGuideHeight", "baseEditorFocused", "bottomProgress", "appScrollTop", "appScrollRange", "appScrollHeight", "appScrollClientHeight", "appScrollRootCount", "windowScrollRange", "oneRosterPresent"] {
                if let value = packet[key], value.doubleValue.isFinite, abs(value.doubleValue) <= 100_000 {
                    // Keep finite subpixel evidence: rounding hid geometry
                    // rejected at the strict native containment boundary.
                    let bounded = value.doubleValue
                    print("NATIVE_PUBLIC_GEOMETRY key=\(key) value=\(bounded)")
                }
            }
        }
        let probe = app.buttons["native-dock-admission"].firstMatch
        guard probe.exists, let code = probe.value as? String,
              ["none", "NATIVE_DOCK_INVALID", "NATIVE_DOCK_DOCUMENT_RETIRED", "NATIVE_DOCK_STALE", "NATIVE_DOCK_HOST_MISSING"].contains(code) else { return }
        print("NATIVE_DOCK_REFUSAL code=\(code)")
    }

    func testLocalSessionNativeNavigationDrawerContinuity() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_NATIVE_NAVIGATION_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in bottom-navigation drawer regression")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            XCTFail("NATIVE_NAVIGATION_REQUIRES_RUNNING_SESSION"); return
        }
        app.activate()
        let probe = app.buttons["native-navigation-presentation"].firstMatch
        guard probe.waitForExistence(timeout: 15) else { XCTFail("NATIVE_NAVIGATION_PROBE_UNAVAILABLE"); return }
        func packet() -> [String: Any]? {
            guard let raw = probe.value as? String, let data = raw.data(using: .utf8),
                  let fields = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  Set(fields.keys) == Set(["visible", "interactive", "accessibilityHidden", "underlay", "x", "y", "width", "height"]) else { return nil }
            return fields
        }
        func matches(interactive: Bool) -> Bool {
            guard let fields = packet() else { return false }
            return fields["visible"] as? Bool == true && fields["interactive"] as? Bool == interactive &&
                fields["accessibilityHidden"] as? Bool == !interactive
        }
        let profile = app.buttons["Open Profile"].firstMatch
        // The regression is shared by ordinary wrappers and opt-in chrome.
        // Use authored accessibility names, never infer arbitrary DOM controls.
        let history = app.buttons.matching(NSPredicate(format: "identifier == %@ OR label == %@", "chat-history-toggle", "Open chat history")).firstMatch
        let profileClose = app.buttons.matching(NSPredicate(format: "identifier == %@ OR label == %@", "profile-close", "Close Profile")).firstMatch
        let historyClose = app.buttons.matching(NSPredicate(format: "identifier == %@ OR label == %@", "chat-history-close", "Close chat history")).firstMatch
        defer {
            if profileClose.exists && profileClose.isHittable { profileClose.tap() }
            if historyClose.exists && historyClose.isHittable { historyClose.tap() }
        }
        guard matches(interactive: true), let baseline = packet() else { XCTFail("NATIVE_NAVIGATION_BASE_NOT_ADMITTED"); return }
        let usesNativeEditor = app.textViews["native-dock-editor"].firstMatch.exists
        if usesNativeEditor { XCTAssertEqual(baseline["underlay"] as? Bool, true, "NATIVE_NAVIGATION_WRONG_PAINT_OWNER") }
        for (opener, close, family) in [(profile, profileClose, "profile"), (history, historyClose, "history")] {
            for cycle in 0..<10 {
                guard waitForAdmittedControl(opener) else { printNativeControlStatuses(app.webViews["native-webview"].firstMatch); XCTFail("NATIVE_PANEL_OPENER_UNAVAILABLE"); return }
                opener.tap()
                guard waitForAdmittedControl(close) else { printNativeControlStatuses(app.webViews["native-webview"].firstMatch); XCTFail("NATIVE_PANEL_CLOSE_NOT_ADMITTED"); return }
                XCTAssertTrue(matches(interactive: false), "NATIVE_NAVIGATION_COVERED_PRESENTATION_LOST")
                if let current = packet() {
                    XCTAssertEqual(current["underlay"] as? Bool, baseline["underlay"] as? Bool, "NATIVE_NAVIGATION_PAINT_OWNER_CHANGED")
                    for key in ["x", "y", "width", "height"] {
                        XCTAssertEqual((current[key] as? NSNumber)?.doubleValue ?? -.infinity,
                                       (baseline[key] as? NSNumber)?.doubleValue ?? .infinity, accuracy: 1,
                                       "NATIVE_NAVIGATION_FRAME_SHIFTED")
                    }
                }
                close.tap()
                let returned = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                    matches(interactive: true) && opener.exists && opener.isHittable
                }, object: probe)
                guard XCTWaiter.wait(for: [returned], timeout: 10) == .completed else {
                    XCTFail("NATIVE_NAVIGATION_WARM_RETURN_UNCONFIRMED"); return
                }
                print("NATIVE_NAVIGATION_CYCLE family=\(family) completed=\(cycle + 1)")
            }
        }
        print("NATIVE_NAVIGATION_WARM_CONTINUITY twenty_drawer_cycles_retained_frame_and_interaction_fence")
    }

    func testLocalSessionNativeCompositorDrawerTiming() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_NATIVE_COMPOSITOR_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in retained compositor architecture gate")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            XCTFail("NATIVE_COMPOSITOR_REQUIRES_RUNNING_SESSION"); return
        }
        app.activate()
        let hosts = app.webViews.matching(identifier: "native-webview"), web = hosts.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 15))
        // Restore only a drawer left open by an interrupted prior rehearsal.
        // No route injection, document restart, account reset or draft change.
        for identifier in ["profile-close", "chat-history-close"] {
            let close = app.buttons[identifier].firstMatch
            if close.exists && close.isHittable { close.tap() }
        }
        let editor = app.textViews["native-dock-editor"].firstMatch
        let editorReady = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            editor.exists && editor.isHittable
        }, object: editor)
        guard XCTWaiter.wait(for: [editorReady], timeout: 15) == .completed else {
            XCTFail("NATIVE_COMPOSITOR_REQUIRES_UNLOCKED_NATIVE_EDITOR"); return
        }
        let probe = app.buttons["native-panel-continuity"].firstMatch
        func measurements() -> [String: Double]? {
            guard probe.exists, let json = probe.value as? String, let data = json.data(using: .utf8),
                  let packet = try? JSONSerialization.jsonObject(with: data) as? [String: Double],
                  Set(packet.keys) == Set(["motionFrames", "staleFrames", "invalidSamples", "maxPoseAgeMs", "maxPoseAgeIntervals"]),
                  packet.values.allSatisfy({ $0.isFinite && $0 >= 0 }) else { return nil }
            return packet
        }
        guard let before = measurements() else { XCTFail("NATIVE_PANEL_TIMING_UNAVAILABLE"); return }
        let profile = app.buttons["Open Profile"].firstMatch
        let profileClose = app.buttons["profile-close"].firstMatch
        let history = app.buttons["chat-history-toggle"].firstMatch
        let historyClose = app.buttons["chat-history-close"].firstMatch
        defer {
            if profileClose.exists && profileClose.isHittable { profileClose.tap() }
            if historyClose.exists && historyClose.isHittable { historyClose.tap() }
        }
        for (opener, close, fallbackLabel) in [(profile, profileClose, "Close Profile"), (history, historyClose, "Close chat history")] {
            for cycle in 0..<10 {
                guard waitForAdmittedControl(opener) else {
                    printNativeControlStatuses(web)
                    XCTFail("NATIVE_PANEL_OPENER_UNAVAILABLE"); return
                }
                opener.tap()
                guard waitForAdmittedControl(close) else {
                    printNativeControlStatuses(web)
                    XCTFail("NATIVE_PANEL_CLOSE_NOT_ADMITTED"); return
                }
                XCTAssertFalse(editor.isHittable, "Covered dock must not acquire interaction")
                XCTAssertFalse(web.buttons[fallbackLabel].firstMatch.isHittable, "Interactive DOM duplicate")
                XCTAssertEqual(hosts.count, 1)
                XCTAssertEqual(app.webViews.count, 1 + web.webViews.count)
                XCTAssertGreaterThanOrEqual(close.frame.width, 44)
                XCTAssertGreaterThanOrEqual(close.frame.height, 44)
                let edge = cycle % 2 == 0 ? CGVector(dx: 0.1, dy: 0.5) : CGVector(dx: 0.9, dy: 0.5)
                close.coordinate(withNormalizedOffset: edge).tap()
                let returned = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                    editor.exists && editor.isHittable && opener.exists && opener.isHittable
                }, object: editor)
                guard XCTWaiter.wait(for: [returned], timeout: 10) == .completed else {
                    printNativeControlStatuses(web)
                    print("NATIVE_PANEL_RETURN editor_present=\(editor.exists) editor_hittable=\(editor.exists && editor.isHittable) opener_present=\(opener.exists) opener_hittable=\(opener.exists && opener.isHittable) close_present=\(close.exists) close_hittable=\(close.exists && close.isHittable)")
                    XCTFail("NATIVE_PANEL_WARM_RETURN_UNCONFIRMED"); return
                }
                let family = fallbackLabel == "Close Profile" ? "profile" : "history"
                print("NATIVE_PANEL_CYCLE family=\(family) completed=\(cycle + 1)")
            }
        }
        guard let after = measurements() else { XCTFail("NATIVE_PANEL_TIMING_UNAVAILABLE"); return }
        print("NATIVE_PANEL_TIMING frames=\(Int(after["motionFrames", default: 0])) stale=\(Int(after["staleFrames", default: 0])) invalid=\(Int(after["invalidSamples", default: 0])) max_age_ms=\(after["maxPoseAgeMs", default: 0]) max_intervals=\(after["maxPoseAgeIntervals", default: 0])")
        XCTAssertGreaterThan(after["motionFrames", default: 0], before["motionFrames", default: 0], "No transition frames observed")
        XCTAssertEqual(after["invalidSamples"], 0, "Uncertain clock samples cannot pass the timing gate")
        XCTAssertEqual(after["staleFrames"], 0, "Native pose exceeded one display interval")
        XCTAssertLessThanOrEqual(after["maxPoseAgeIntervals", default: .infinity], 1)
        print("NATIVE_PANEL_WARM_CONTINUITY ten_profile_ten_history_edge_taps_single_host_no_web_duplicate")
    }

    func testLocalSessionNativeChatControlsRespectOverlayKeyboardAndSingleHost() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_NATIVE_CHROME_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in native History/Close and selector proof; Debug candidate must admit these families")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            throw XCTSkip("Attach only: no cold launch, reviewer bootstrap or credential entry")
        }
        app.activate()
        let hosts = app.webViews.matching(identifier: "native-webview")
        let web = hosts.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 15), "NATIVE_CHAT_HOST_UNAVAILABLE")
        XCTAssertFalse(web.buttons["Unlock"].exists, "Normal vault unlock is required before chat-family proof")
        XCTAssertFalse(app.buttons["Continue with Google"].exists, "Chat-family proof must not manufacture sign-in")
        for label in ["Close Profile", "Close chat history", "Close search"] {
            let close = app.buttons[label].firstMatch
            if close.exists && close.isHittable { close.tap() }
        }
        perfTapNav(app, label: "Chat")
        dismissRehearsalChatKeyboard(app)
        // Drawer dismissal intentionally restores DOM focus even with no
        // keyboard. Leave that public fallback before requiring native chrome.
        let entryTitles = web.staticTexts.matching(NSPredicate(format: "label == %@", "One"))
            .allElementsBoundByIndex.filter {
                $0.isHittable && $0.frame.minY >= web.frame.minY && $0.frame.maxY <= web.frame.minY + 160
            }
        guard entryTitles.count == 1 else { XCTFail("NATIVE_CHAT_HEADER_TITLE_UNAVAILABLE"); return }
        entryTitles[0].tap()
        let composer = web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Message One")).firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 15) && composer.isHittable,
                      "Begin on idle Cloud Chat with the existing unlocked session")
        XCTAssertFalse(web.buttons["Stop One"].exists, "Do not change surfaces while an existing turn is active")
        let hostFrame = web.frame
        let nativeHistory = app.buttons["chat-history-toggle"].firstMatch
        let retainedHistory = web.buttons.matching(identifier: "one-chat-history-trigger")
        let history = app.buttons.matching(NSPredicate(
            format: "identifier == %@ AND label BEGINSWITH %@", "chat-history-toggle", "Open chat history")).firstMatch
        let selector = app.segmentedControls["chat-agent-surface"].firstMatch
        func segment(_ value: String) -> XCUIElement {
            let names = value == "one" ? ["Cloud", "One, your cloud agent"] :
                ["Puppy", "Puppy One"]
            return selector.buttons.matching(NSPredicate(format: "label IN %@", names)).firstMatch
        }
        func assertSameHost() {
            XCTAssertEqual(hosts.count, 1, "Chat controls must retain the identified Capacitor host")
            XCTAssertEqual(app.webViews.count, 1 + web.webViews.count, "Chat controls introduced another WebView host")
            XCTAssertEqual(web.frame, hostFrame, "The overlay or surface change replaced/moved the host")
            XCTAssertFalse(web.buttons["Unlock"].exists, "Chat controls lost the unlocked session")
        }
        func awaitAbsent(_ element: XCUIElement, _ message: String) {
            let removed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)
            XCTAssertEqual(XCTWaiter.wait(for: [removed], timeout: 10), .completed, message)
        }
        let historyProbe = app.buttons["native-history-continuity"].firstMatch
        func historyCounters() -> [String: Int]? {
            guard historyProbe.exists, let json = historyProbe.value as? String, let data = json.data(using: .utf8),
                  let packet = try? JSONSerialization.jsonObject(with: data) as? [String: Int],
                  Set(packet.keys) == Set(["installs", "removals", "replacements", "rootUpdates", "sampledFrames", "missingFrames"])
            else { return nil }
            return packet
        }
        func sampledHistoryAfterActivation() -> [String: Int]? {
            guard history.exists && history.isHittable, let activated = historyCounters() else {
                XCTFail("NATIVE_HISTORY_MEASUREMENTS_UNAVAILABLE"); return nil
            }
            print("NATIVE_HISTORY_SAMPLE frames=\(activated["sampledFrames", default: 0]) missing=\(activated["missingFrames", default: 0])")
            var sampled: [String: Int]?
            let fresh = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                guard history.exists && history.isHittable, let packet = historyCounters(),
                      packet["sampledFrames", default: 0] > activated["sampledFrames", default: 0] else { return false }
                sampled = packet; return true
            }, object: historyProbe)
            guard XCTWaiter.wait(for: [fresh], timeout: 10) == .completed else {
                XCTFail("NATIVE_HISTORY_POST_ACTIVATION_SAMPLE_MISSING"); return nil
            }
            return sampled
        }
        func tapNative(_ target: XCUIElement, at point: CGVector) {
            // Public native target only, never arbitrary transcript coordinates.
            // AX existence is not proof that an empty part of its label responds.
            let valid = target.exists && target.isHittable && target.isEnabled &&
                app.buttons.matching(identifier: target.identifier).count == 1 &&
                target.frame.width >= 44 && target.frame.height >= 44 && app.frame.contains(target.frame)
            XCTAssertTrue(valid, "NATIVE_CHROME_PRESS_TARGET_UNAVAILABLE")
            guard valid else { return }
            target.coordinate(withNormalizedOffset: point).tap()
        }
        print("NATIVE_CHAT_ENTRY keyboard=\(app.keyboards.firstMatch.exists) history_dom=\(web.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ AND identifier != %@", "Open chat history", "chat-history-toggle")).firstMatch.exists) picker_native=\(selector.exists)")
        let selectorRoots = app.descendants(matching: .any).matching(identifier: "chat-agent-surface")
        let fallbackNames = web.descendants(matching: .any).matching(NSPredicate(format: "label IN %@", [
            "One, your cloud agent", "Puppy One"
        ]))
        print("NATIVE_CHAT_SELECTOR_PROBE roots=\(selectorRoots.count) role=\(selectorRoots.firstMatch.exists ? selectorRoots.firstMatch.elementType.rawValue : 0) fallback_names=\(fallbackNames.count)")
        let status = web.staticTexts["native-selector-rehearsal-status"].firstMatch
        if status.exists {
            let fields = String(status.label.dropFirst("NATIVE_SELECTOR_STATUS ".count))
            if fields.utf8.count <= 1024,
               let data = fields.data(using: .utf8),
               let snapshot = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                let stages = ["skip", "retire", "prepare", "activate", "update"]
                let outcomes = ["pending", "acknowledged", "rejected"]
                let codes = ["none", "other", "not-admitted", "focused", "geometry",
                    "NATIVE_CHROME_ACK_UNCERTAIN", "NATIVE_CHROME_PREPARE_REFUSED",
                    "NATIVE_CHROME_DOCUMENT_OR_GEOMETRY_STALE", "NATIVE_CHROME_OVERLAPPING_CONTROLS",
                    "NATIVE_CHROME_OPTIONS_INVALID", "NATIVE_CHROME_LAYOUT_UNCONFIRMED",
                    "NATIVE_CHROME_LAYOUT_RETIRED", "NATIVE_CHROME_ACTIVATE_REFUSED",
                    "NATIVE_CHROME_ACTIVATE_UNCONFIRMED", "NATIVE_CHROME_RETIRE_UNCONFIRMED",
                    "NATIVE_CHROME_UPDATE_INVALID", "NATIVE_CHROME_UPDATE_UNCONFIRMED"]
                var safe: [String: Any] = [:]
                for (key, values) in [("stage", stages), ("outcome", outcomes), ("code", codes)] {
                    safe[key] = (snapshot[key] as? String).flatMap { values.contains($0) ? $0 : nil } ?? "other"
                }
                for key in ["eligible", "supported", "allowed", "focusInside", "heldFocus", "inViewport"] {
                    safe[key] = snapshot[key] as? Bool ?? false
                }
                for key in ["width", "height"] { safe[key] = max(0, min(10000, snapshot[key] as? Int ?? 0)) }
                if let encoded = try? JSONSerialization.data(withJSONObject: safe, options: [.sortedKeys]),
                   let literal = String(data: encoded, encoding: .utf8) { print("NATIVE_SELECTOR_REHEARSAL \(literal)") }
            }
        }
        XCTAssertTrue(history.waitForExistence(timeout: 15) && history.isHittable,
                      "NATIVE_CHAT_HISTORY_UNAVAILABLE")
        XCTAssertTrue(selector.waitForExistence(timeout: 15) && selector.isHittable, "NATIVE_CHAT_PICKER_UNAVAILABLE")
        let headerTop = min(history.frame.minY, selector.frame.minY)
        let headerBottom = max(history.frame.maxY, selector.frame.maxY)
        func blurThroughAuthoredTitle() {
            // This public static title has no action owner. Do not tap arbitrary
            // transcript coordinates or the keyboard's destructive Send key.
            let title = web.staticTexts.matching(NSPredicate(format: "label == %@", "One"))
                .allElementsBoundByIndex.first { $0.isHittable && $0.frame.minY >= headerTop - 1 && $0.frame.maxY <= headerBottom + 1 }
            guard let title else { XCTFail("NATIVE_CHAT_HEADER_TITLE_UNAVAILABLE"); return }
            title.tap()
        }
        func assertNativeTargets() {
            XCTAssertEqual(app.buttons.matching(identifier: "chat-history-toggle").count, 1,
                           "Admit exactly one native History control")
            XCTAssertEqual(retainedHistory.count, 0, "DOM History must retire before native activation")
            XCTAssertEqual(app.segmentedControls.matching(identifier: "chat-agent-surface").count, 1)
            XCTAssertGreaterThanOrEqual(history.frame.width, 44)
            XCTAssertGreaterThanOrEqual(history.frame.height, 44)
            XCTAssertFalse(history.frame.intersects(selector.frame), "Independent controls overlap")
            let cloud = segment("one"), puppy = segment("puppy")
            XCTAssertTrue(cloud.exists && cloud.isHittable && puppy.exists && puppy.isHittable,
                          "The system Picker must expose exactly the two authored selectable segments")
            XCTAssertEqual(selector.buttons.count, 2)
            // This measures accessible system segments, not the 44pt SwiftUI
            // hosting rectangle. A smaller large Picker is not admitted by fiat.
            for option in [cloud, puppy] {
                print("NATIVE_CHAT_PICKER_GEOMETRY width=\(Int(option.frame.width)) height=\(Int(option.frame.height))")
                XCTAssertGreaterThanOrEqual(option.frame.width, 44, "NATIVE_CHAT_PICKER_SEGMENT_WIDTH_UNADMITTED")
                XCTAssertGreaterThanOrEqual(option.frame.height, 44, "NATIVE_CHAT_PICKER_SEGMENT_HEIGHT_UNADMITTED")
            }
            // Exclude the known native segments explicitly. AX membership under
            // WebKit alone is not proof that an element is DOM-owned.
            let publicNames = NSPredicate(format: "label IN %@", [
                "One, your cloud agent", "Puppy One"
            ])
            let nestedNative = web.segmentedControls["chat-agent-surface"].firstMatch
            let permitted = nestedNative.exists ? nestedNative.descendants(matching: .any).matching(publicNames).count : 0
            XCTAssertEqual(web.descendants(matching: .any).matching(publicNames).count, permitted,
                           "Authored DOM and native selector both remained accessible")
            assertSameHost()
        }
        assertNativeTargets()
        let historyDialogLabel = web.descendants(matching: .any).matching(NSPredicate(
            format: "label == %@", "Agent chat history")).firstMatch
        // WebKit need not project a named DOM container as an AX element.
        // Opening is proved by the public heading and the owned native Close,
        // not by assuming that optional container label survives the bridge.
        let historyHeading = web.staticTexts["Chats"].firstMatch
        let close = app.buttons.matching(NSPredicate(
            format: "identifier == %@ AND label == %@", "chat-history-toggle", "Close chat history")).firstMatch
        var composerFocusAttempted = false
        addTeardownBlock {
            if close.exists && close.isHittable { close.tap() }
            if composerFocusAttempted || app.keyboards.firstMatch.exists { blurThroughAuthoredTitle() }
            // Restore only the permitted Cloud surface, never select/delete a
            // conversation, send a draft, alter an account, or dump its AX tree.
            let cloud = segment("one")
            if cloud.exists && cloud.isHittable && !cloud.isSelected { cloud.tap() }
        }
        XCTAssertFalse(historyHeading.exists, "History must be closed before its opener is tested")
        history.tap()
        let nativeCloseAppeared = close.waitForExistence(timeout: 10)
        let chatsHeadingVisible = web.staticTexts["Chats"].firstMatch.exists
        print("NATIVE_HISTORY_ACTION_RESULT native_close=\(nativeCloseAppeared) dialog_label=\(historyDialogLabel.exists) chats_heading=\(chatsHeadingVisible)")
        XCTAssertTrue(historyHeading.waitForExistence(timeout: 10) && historyHeading.isHittable, "The authored History drawer did not appear")
        XCTAssertTrue(nativeCloseAppeared && close.isHittable, "Native History did not hand off to its owned Close")
        let isolatedHistory = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            !history.exists || !history.isHittable
        }, object: history)
        XCTAssertEqual(XCTWaiter.wait(for: [isolatedHistory], timeout: 10), .completed,
                       "The underlying header History remained interactive beneath its drawer")
        XCTAssertEqual(app.buttons.matching(identifier: "chat-history-toggle").count, 1, "Close handoff duplicated the control")
        XCTAssertGreaterThanOrEqual(close.frame.width, 44)
        XCTAssertGreaterThanOrEqual(close.frame.height, 44)
        XCTAssertFalse(web.buttons.matching(NSPredicate(
            format: "label == %@ AND identifier != %@", "Close chat history", "chat-history-toggle")).firstMatch.exists,
            "DOM and native Close must not both be accessible")
        awaitAbsent(selector, "Native selector remained accessible under history")
        assertSameHost()
        close.tap()
        awaitAbsent(close, "History did not dismiss")
        // Native/gesture return must not pin a focused DOM hamburger. No
        // unrelated blur tap may be used to make the handoff pass.
        XCTAssertTrue(history.waitForExistence(timeout: 10) && history.isHittable,
                      "Native History did not return without a second blur")
        XCTAssertTrue(selector.waitForExistence(timeout: 10) && selector.isHittable,
                      "Native selector did not return after History dismissal")
        assertNativeTargets()
        let edgePoints = [CGVector(dx: 0.05, dy: 0.5), CGVector(dx: 0.95, dy: 0.5),
                          CGVector(dx: 0.5, dy: 0.05), CGVector(dx: 0.5, dy: 0.95)]
        for point in edgePoints {
            tapNative(history, at: point)
            XCTAssertTrue(historyHeading.waitForExistence(timeout: 10) && historyHeading.isHittable)
            XCTAssertTrue(close.waitForExistence(timeout: 10) && close.isHittable)
            XCTAssertEqual(app.buttons.matching(identifier: "chat-history-toggle").count, 1)
            tapNative(close, at: point)
            awaitAbsent(close, "Native History edge press did not dismiss")
            XCTAssertTrue(history.waitForExistence(timeout: 10) && history.isHittable,
                          "History edge press returned a web replacement")
            assertNativeTargets()
        }
        let profilePresses = [CGVector(dx: 0.5, dy: 0.5)] + edgePoints
        for point in profilePresses {
            let openProfile = web.buttons["Open Profile"].firstMatch
            XCTAssertTrue(openProfile.exists && openProfile.isHittable)
            openProfile.tap()
            let nativeClose = app.buttons.matching(NSPredicate(
                format: "identifier == %@ AND label == %@", "profile-close", "Close Profile")).firstMatch
            print("NATIVE_PROFILE_REOPEN_ADMISSION exists=\(nativeClose.exists) hittable=\(nativeClose.exists && nativeClose.isHittable)")
            let closeReady = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                nativeClose.exists && nativeClose.isHittable
            }, object: nativeClose)
            XCTAssertEqual(XCTWaiter.wait(for: [closeReady], timeout: 10), .completed,
                           "Profile Close must become interactive within the existing admission boundary")
            XCTAssertGreaterThanOrEqual(nativeClose.frame.width, 44)
            XCTAssertGreaterThanOrEqual(nativeClose.frame.height, 44)
            XCTAssertFalse(web.buttons.matching(NSPredicate(
                format: "label == %@ AND identifier != %@", "Close Profile", "profile-close")).firstMatch.exists,
                "Profile must not expose duplicate native and web Close controls")
            tapNative(nativeClose, at: point)
            awaitAbsent(nativeClose, "Native Profile Close did not retire after dismissal")
            XCTAssertTrue(history.waitForExistence(timeout: 10) && history.isHittable)
            XCTAssertTrue(selector.waitForExistence(timeout: 10) && selector.isHittable)
            assertSameHost()
        }
        print("NATIVE_CHROME_REOPEN history=true profile_cycles=5")
        print("NATIVE_CHROME_PRESS_REGIONS history=5 close=5 profile=5")
        guard let beforeSurface = historyCounters() else { XCTFail("NATIVE_HISTORY_MEASUREMENTS_UNAVAILABLE"); return }
        segment("puppy").tap()
        let puppyComposer = web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Message Puppy One")).firstMatch
        // A reviewer with no Puppy conversations has an authored empty state,
        // not a composer. Creating a conversation just to satisfy this chrome
        // check would mutate the account and substitute a different journey.
        let puppyStart = web.buttons["Start a Puppy chat"].firstMatch
        let puppySurface = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            puppyComposer.exists || puppyStart.exists
        }, object: app)
        XCTAssertEqual(XCTWaiter.wait(for: [puppySurface], timeout: 15), .completed,
                       "Native selector did not enter the authored Puppy surface")
        let puppySelected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "selected == true"), object: segment("puppy"))
        XCTAssertEqual(XCTWaiter.wait(for: [puppySelected], timeout: 10), .completed, "React selection was not projected back to Picker")
        XCTAssertTrue(history.waitForExistence(timeout: 10) && history.isHittable)
        guard let afterPuppy = sampledHistoryAfterActivation() else { return }
        XCTAssertEqual(afterPuppy["installs"], beforeSurface["installs"])
        XCTAssertEqual(afterPuppy["removals"], beforeSurface["removals"])
        XCTAssertGreaterThan(afterPuppy["replacements", default: 0], beforeSurface["replacements", default: 0])
        XCTAssertEqual(afterPuppy["missingFrames"], beforeSurface["missingFrames"])
        assertSameHost()
        segment("one").tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 15) && composer.isHittable, "Cloud did not return without sending or resetting")
        let cloudSelected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "selected == true"), object: segment("one"))
        XCTAssertEqual(XCTWaiter.wait(for: [cloudSelected], timeout: 10), .completed)
        XCTAssertTrue(history.waitForExistence(timeout: 10) && history.isHittable)
        guard let afterSurface = sampledHistoryAfterActivation() else { return }
        XCTAssertEqual(afterSurface["installs"], beforeSurface["installs"], "Agent switch recreated the History host")
        XCTAssertEqual(afterSurface["removals"], beforeSurface["removals"], "Agent switch removed the History host")
        XCTAssertGreaterThanOrEqual(afterSurface["replacements", default: 0] - beforeSurface["replacements", default: 0], 2)
        XCTAssertGreaterThan(afterSurface["replacements", default: 0], afterPuppy["replacements", default: 0])
        XCTAssertGreaterThan(afterSurface["sampledFrames", default: 0], beforeSurface["sampledFrames", default: 0],
                             "History transition was not sampled")
        XCTAssertEqual(afterSurface["missingFrames"], beforeSurface["missingFrames"], "History moved or vanished during an admitted handoff")
        print("NATIVE_HISTORY_CONTINUITY retained_switches=2 missing_delta=0")
        func reportComposerAdmission(_ stage: String, after previousSequence: Int? = nil) -> Int? {
            let probe = app.buttons["native-vault-layout"].firstMatch
            func readPacket() -> [String: Any]? {
                guard probe.exists, let json = probe.value as? String, let data = json.data(using: .utf8) else { return nil }
                return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            }
            if let previousSequence {
                let fresh = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                    (readPacket()?["sequence"] as? Int ?? 0) > previousSequence
                }, object: probe)
                guard XCTWaiter.wait(for: [fresh], timeout: 3) == .completed else {
                    print("NATIVE_CHAT_FOCUS_UNAVAILABLE stage=\(stage)"); return nil
                }
            }
            guard let packet = readPacket(), let sequence = packet["sequence"] as? Int else {
                print("NATIVE_CHAT_FOCUS_UNAVAILABLE stage=\(stage)"); return nil
            }
            let keys = Set(["chatCount", "chatFocused", "chatDisabled", "chatInert", "chatHit",
                            "chatWidth", "chatHeight", "nativeGuideHeight", "nativeBottomSafeArea", "cssInset", "kbOpen", "sequence"])
            let values = packet.filter { keys.contains($0.key) && $0.value is NSNumber }
            guard let encoded = try? JSONSerialization.data(withJSONObject: values, options: [.sortedKeys]),
                  let result = String(data: encoded, encoding: .utf8) else {
                print("NATIVE_CHAT_FOCUS_UNAVAILABLE stage=\(stage)"); return nil
            }
            print("NATIVE_CHAT_FOCUS stage=\(stage) packet=\(result)")
            return sequence
        }
        guard let focusSequence = reportComposerAdmission("before"),
              let beforeKeyboard = historyCounters() else {
            XCTFail("NATIVE_CHAT_KEYBOARD_MEASUREMENTS_UNAVAILABLE"); return
        }
        composerFocusAttempted = true
        composer.tap() // No typeText: preserve the complete existing draft.
        let keyboardAppeared = waitForSoftwareKeyboard(app)
        guard reportComposerAdmission("after", after: focusSequence) != nil else {
            XCTFail("NATIVE_CHAT_KEYBOARD_MEASUREMENTS_UNAVAILABLE"); return
        }
        guard keyboardAppeared else { XCTFail("SOFTWARE_KEYBOARD_NOT_ONSCREEN"); return }
        // Require one joint state within the existing ten-second boundary:
        // a present keyboard, retired hosts and absent accessibility controls.
        // A non-hittable control alone does not prove retirement.
        let keyboardIsolation = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            self.softwareKeyboardIsOnscreen(app.keyboards.firstMatch, in: app) && !nativeHistory.exists && !selector.exists &&
                (historyCounters()?["removals"] ?? -1) > beforeKeyboard["removals", default: 0]
        }, object: historyProbe)
        guard XCTWaiter.wait(for: [keyboardIsolation], timeout: 10) == .completed else {
            XCTFail("NATIVE_CHAT_KEYBOARD_ISOLATION_UNCONFIRMED"); return
        }
        assertSameHost()
        print("NATIVE_KEYBOARD_ISOLATION keyboard_present=true history_removed=true selector_removed=true")
        blurThroughAuthoredTitle()
        let keyboardDismissed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            !self.softwareKeyboardIsOnscreen(app.keyboards.firstMatch, in: app)
        }, object: app.keyboards.firstMatch)
        XCTAssertEqual(XCTWaiter.wait(for: [keyboardDismissed], timeout: 10), .completed,
                       "Keyboard did not dismiss through the public header")
        XCTAssertTrue(history.waitForExistence(timeout: 10) && history.isHittable)
        XCTAssertTrue(selector.waitForExistence(timeout: 10) && selector.isHittable)
        assertNativeTargets()
        print("NATIVE_CHAT_CHROME_CONTINUITY owned_history_close_native_picker_overlay_keyboard_cloud_return_single_host")
    }

    func testStockControlReference() throws {
        // Public interaction reference only; neither its look nor this test
        // establishes Apple's implementation framework or admits our controls.
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_NATIVE_CHROME_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in bounded Clock/Calculator observation with return to existing Cloud Chat")
        }
        let one = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(one.state) else {
            throw XCTSkip("One must already be running; no launch, reset or credential entry")
        }
        one.activate()
        let hosts = one.webViews.matching(identifier: "native-webview")
        let host = hosts.firstMatch
        XCTAssertTrue(host.waitForExistence(timeout: 15))
        XCTAssertFalse(host.buttons["Unlock"].exists, "Normal vault unlock is required before stock comparison")
        let composer = host.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Message One")).firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 10) && composer.isHittable,
                      "Begin stock reference on interactive Cloud Chat")
        XCTAssertFalse(host.buttons["Stop One"].exists, "Do not interrupt an existing active turn")
        defer {
            // Return even on a fail-fast assertion; never inspect a result,
            // history, note, alarm or timer, nor attach protected screenshots.
            one.activate()
            XCTAssertTrue(host.waitForExistence(timeout: 15))
            XCTAssertTrue(composer.waitForExistence(timeout: 15) && composer.isHittable,
                          "STOCK_REFERENCE_WARM_CHAT_NOT_RESTORED")
            XCTAssertFalse(host.buttons["Unlock"].exists, "Stock reference lost the unlocked session")
            XCTAssertEqual(hosts.count, 1)
            XCTAssertEqual(one.webViews.count, 1 + host.webViews.count)
        }

        let calculator = XCUIApplication(bundleIdentifier: "com.apple.calculator")
        calculator.activate()
        XCTAssertTrue(calculator.wait(for: .runningForeground, timeout: 10), "STOCK_CALCULATOR_UNAVAILABLE")
        // No onboarding dismissal, number entry, mode selection or menu action.
        // Only inspect the public toolbar affordance in an already-admitted app.
        let modeNames = ["Calculator Mode", "Calculator mode", "Calculator Modes", "Calculator modes", "Choose Calculator"]
        let mode = calculator.buttons.matching(NSPredicate(format: "label IN %@", modeNames)).firstMatch
        XCTAssertTrue(mode.waitForExistence(timeout: 10) && mode.isHittable,
                      "STOCK_CALCULATOR_MODE_UNAVAILABLE: public locator requires characterization, not a silent pass")
        print("STOCK_CALCULATOR_MODE available=\(mode.exists && mode.isHittable)")
        if mode.exists {
            print("STOCK_CALCULATOR_CONTROL name=Calculator Mode width=\(Int(mode.frame.width)) height=\(Int(mode.frame.height)) hittable=\(mode.isHittable)")
        }

        let clock = XCUIApplication(bundleIdentifier: "com.apple.mobiletimer")
        clock.activate()
        XCTAssertTrue(clock.wait(for: .runningForeground, timeout: 10), "STOCK_CLOCK_UNAVAILABLE")
        let tabs = clock.tabBars.firstMatch
        XCTAssertTrue(tabs.waitForExistence(timeout: 10), "STOCK_CLOCK_TABS_UNAVAILABLE")
        let publicTabNames = ["World Clock", "Alarm", "Alarms", "Stopwatch", "Timer", "Timers"]
        let observed = publicTabNames.compactMap { name -> XCUIElement? in
            let tab = tabs.buttons[name].firstMatch
            guard tab.exists else { return nil }
            print("STOCK_CLOCK_TAB name=\(name) width=\(Int(tab.frame.width)) height=\(Int(tab.frame.height)) selected=\(tab.isSelected) hittable=\(tab.isHittable)")
            return tab
        }
        XCTAssertEqual(observed.count, 4, "STOCK_CLOCK_PUBLIC_TAB_SET_INCOMPLETE")
        XCTAssertEqual(observed.filter { $0.isSelected }.count, 1, "STOCK_CLOCK_SELECTION_UNAVAILABLE")
        XCTAssertTrue(observed.allSatisfy { $0.isHittable && $0.frame.width > 0 && $0.frame.height > 0 })
        // Observation only: no selecting/start/stop/add/delete in Clock.
        one.activate()
        XCTAssertTrue(host.waitForExistence(timeout: 15))
        XCTAssertTrue(composer.waitForExistence(timeout: 15) && composer.isHittable)
        XCTAssertFalse(host.buttons["Unlock"].exists)
        print("STOCK_REFERENCE_RETURN warm_chat=true")
    }

    func testLocalSessionProfilePhotoPreviewDoesNotChangePhoto() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_LOCAL_SESSION_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in profile preview proof; no credentials or photo mutation")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            throw XCTSkip("One must already be running and unlocked")
        }
        app.activate()
        let hosts = app.webViews.matching(identifier: "native-webview")
        let webView = hosts.firstMatch
        let previousProfile = app.buttons["Close Profile"].firstMatch
        if previousProfile.exists && previousProfile.isHittable { previousProfile.tap() }
        let openProfile = app.buttons["Open Profile"].firstMatch
        XCTAssertTrue(openProfile.waitForExistence(timeout: 15) && openProfile.isHittable)
        XCTAssertGreaterThanOrEqual(openProfile.frame.width, 44, "Profile photo needs a full shell hit target")
        XCTAssertGreaterThanOrEqual(openProfile.frame.height, 44, "Profile photo needs a full shell hit target")
        openProfile.tap()
        let nativeClose = app.buttons["native-profile-drawer-close"].firstMatch
        if nativeClose.waitForExistence(timeout: 3) {
            // Qualify the actual Account portrait, not the old web-only avatar
            // selector. No camera, library, remove or save action is invoked.
            let menu = app.descendants(matching: .any).matching(identifier: "native-profile-menu-scroll").firstMatch
            let account = app.buttons["native-profile-row-account"].firstMatch
            let rootPhoto = app.buttons["native-profile-row-identity"].firstMatch
            for _ in 0..<3 {
                // Every nested native page has a scroll view. Its presence
                // cannot prove root admission after a warm close/reopen.
                let parent = nativeProfileBack(app, parent: "Profile")
                if !parent.waitForExistence(timeout: 1) { break }
                guard waitForAdmittedControl(parent) else { XCTFail("PROFILE_PHOTO_PARENT_UNAVAILABLE"); return }
                parent.tap()
            }
            for _ in 0..<4 {
                if rootPhoto.exists && rootPhoto.isHittable && account.exists && account.isHittable { break }
                menu.swipeDown()
            }
            let rootName = app.staticTexts["native-profile-identity-name"].firstMatch
            let rootEmail = app.staticTexts["native-profile-identity-email"].firstMatch
            guard waitForAdmittedControl(rootPhoto) else { XCTFail("PROFILE_PHOTO_TOP_PORTRAIT_UNAVAILABLE"); return }
            XCTAssertEqual(rootPhoto.frame.width, 44, accuracy: 1, "PROFILE_PHOTO_ROOT_DIFFERS_FROM_WEB_PANE")
            XCTAssertEqual(rootPhoto.frame.height, 44, accuracy: 1)
            guard rootName.exists, rootEmail.exists else { XCTFail("PROFILE_PHOTO_TOP_IDENTITY_HEADER_UNAVAILABLE"); return }
            XCTAssertEqual(rootName.frame.minX - rootPhoto.frame.maxX, 13, accuracy: 1)
            XCTAssertEqual(rootName.frame.minX, rootEmail.frame.minX, accuracy: 1)
            XCTAssertLessThan(rootPhoto.frame.maxY, account.frame.minY, "PROFILE_PHOTO_NOT_AT_TOP")
            guard waitForAdmittedControl(account) else { XCTFail("PROFILE_PHOTO_ACCOUNT_UNAVAILABLE"); return }
            account.tap()
            let options = app.buttons["native-profile-row-account-photo"].firstMatch
            let portrait = app.buttons["Profile photo options"].firstMatch
            guard waitForAdmittedControl(options), waitForAdmittedControl(portrait) else {
                XCTFail("PROFILE_PHOTO_HEADER_UNAVAILABLE"); return
            }
            let name = app.staticTexts["native-profile-account-photo-name"].firstMatch
            let email = app.staticTexts["native-profile-account-photo-email"].firstMatch
            XCTAssertTrue(name.exists && email.exists, "PROFILE_PHOTO_IDENTITY_COPY_MISSING")
            XCTAssertEqual(app.buttons.matching(identifier: "native-profile-row-account-photo").count, 1)
            XCTAssertEqual(portrait.frame, options.frame, "PROFILE_PHOTO_HAS_DUPLICATE_ACTIONS")
            XCTAssertEqual(portrait.frame.width, 44, accuracy: 1, "PROFILE_PHOTO_DIFFERS_FROM_WEB_PANE")
            XCTAssertEqual(portrait.frame.height, 44, accuracy: 1, "PROFILE_PHOTO_HIT_REGION_INCOMPLETE")
            XCTAssertEqual(name.frame.minX - portrait.frame.maxX, 13, accuracy: 1, "PROFILE_PHOTO_HEADER_COLUMN_GAP")
            XCTAssertEqual(name.frame.minX, email.frame.minX, accuracy: 1)
            XCTAssertLessThan(name.frame.minY, portrait.frame.maxY, "PROFILE_PHOTO_NAME_NOT_ALONGSIDE")
            options.tap()
            let preview = app.buttons["View photo"].firstMatch
            guard waitForAdmittedControl(preview) else {
                printCoherentPresentationAdmission(app)
                printNativeControlStatuses(webView)
                XCTFail("PROFILE_PHOTO_OPTIONS_UNAVAILABLE"); return
            }
            preview.tap()
            let previewOptions = app.buttons["Photo options"].firstMatch
            guard waitForAdmittedControl(previewOptions), waitForAdmittedControl(app.buttons["Close"].firstMatch) else {
                XCTFail("PROFILE_PHOTO_PREVIEW_UNAVAILABLE"); return
            }
            XCTAssertEqual(hosts.count, 1)
            app.buttons["Close"].firstMatch.tap()
            guard waitForAdmittedControl(options), waitForAdmittedControl(nativeClose) else {
                XCTFail("PROFILE_PHOTO_ACCOUNT_NOT_RESTORED"); return
            }
            nativeClose.tap()
            guard waitForAdmittedControl(openProfile) else { XCTFail("PROFILE_PHOTO_CHAT_NOT_RESTORED"); return }
            XCTAssertEqual(hosts.count, 1)
            XCTAssertFalse(webView.buttons["Unlock"].exists)
            print("PROFILE_PHOTO_PREVIEW_CONTINUITY native_header_options_preview_return_without_mutation web_aligned_hero")
            return
        }
        // The pane can resume a nested setting from the same session. Reach
        // its home through its actual Back controls, not a cold route/reset.
        for _ in 0..<3 {
            let backInProfile = app.buttons["Back in Profile"].firstMatch
            if !backInProfile.waitForExistence(timeout: 1) || !backInProfile.isHittable { break }
            backInProfile.tap()
        }
        let photo = app.buttons["View profile photo"].firstMatch
        if !photo.waitForExistence(timeout: 15) {
            XCTContext.runActivity(named: "PROFILE_PHOTO_ADMISSION fallback_visible=\(app.buttons["Profile photo options"].exists) root_visible=\(app.staticTexts["Your settings"].exists) nested_back_visible=\(app.buttons["Back in Profile"].exists)") { _ in }
        }
        XCTAssertTrue(photo.waitForExistence(timeout: 15) && photo.isHittable,
                      "The reviewer profile must have an existing photo for this proof")
        photo.tap()
        XCTAssertTrue(app.buttons["Photo options"].waitForExistence(timeout: 10),
                      "Photo preview did not open in place")
        let close = app.buttons["Close"].firstMatch
        XCTAssertTrue(close.exists && close.isHittable, "Photo preview lacks a close control")
        close.tap()
        XCTAssertTrue(photo.waitForExistence(timeout: 10), "Profile did not resume after closing preview")
        XCTAssertEqual(hosts.count, 1, "Preview must retain the identified Capacitor WebView")
        XCTAssertEqual(app.webViews.count, 1 + webView.webViews.count,
                       "Photo preview introduced another WebView host")
        XCTAssertFalse(webView.buttons["Unlock"].exists, "Preview lost the unlocked session")
        let profileClose = app.buttons["Close Profile"].firstMatch
        XCTAssertTrue(profileClose.exists && profileClose.isHittable)
        // Drag the unoccupied middle of the owned Profile header, not a row
        // action, field, photo, horizontal rail or an inferred DOM control.
        let pane = try admittedProfilePaneFrame(app, web: webView, close: profileClose)
        let origin = app.coordinate(withNormalizedOffset: .zero)
        let headerY = profileClose.frame.midY - app.frame.minY
        let pullStart = origin.withOffset(CGVector(dx: pane.minX + pane.width * 0.35 - app.frame.minX, dy: headerY))
        let pullEnd = origin.withOffset(CGVector(dx: pane.maxX - 8 - app.frame.minX, dy: headerY + 2))
        let hostFrame = webView.frame
        pullStart.press(forDuration: 0.05, thenDragTo: pullEnd)
        let retired = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: profileClose)
        XCTAssertEqual(XCTWaiter.wait(for: [retired], timeout: 10), .completed,
                       "Profile pull did not dismiss through its owning Sheet")
        XCTAssertEqual(webView.frame, hostFrame, "Profile pull moved the Capacitor host")
        XCTAssertFalse(webView.buttons["Unlock"].exists, "Profile pull lost the unlocked session")
        print("PROFILE_DRAG_CONTINUITY close_warm_single_host")
        print("PROFILE_PHOTO_PREVIEW_CONTINUITY open_close_without_mutation")
    }

    func testLocalSessionMailPagerAndSoftwareKeyboardKeepTheSession() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_LOCAL_SESSION_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in warm Mail pager and software-keyboard regression")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            throw XCTSkip("One must already be running; no cold launch or reset")
        }
        app.activate()
        cancelRehearsalVoiceCapture(app)
        let hosts = app.webViews.matching(identifier: "native-webview")
        let web = hosts.firstMatch
        XCTAssertFalse(web.buttons["Unlock"].exists, "Normal vault unlock is required")
        defer {
            self.dismissRehearsalChatKeyboard(app)
            self.perfTapNav(app, label: "Chat")
        }
        for label in ["Close Profile", "Close chat history", "Close search"] {
            let close = app.buttons[label].firstMatch
            if close.exists && close.isHittable { close.tap() }
        }
        perfTapNav(app, label: "Chat")
        let composer = rehearsalChatComposer(app)
        XCTAssertTrue(composer.waitForExistence(timeout: 15) && composer.isHittable)
        let draft = composer.value as? String
        // Open the actual software keyboard; do not overwrite or submit a draft.
        composer.tap()
        let keyboard = app.keyboards.firstMatch
        guard waitForSoftwareKeyboard(app) else { XCTFail("SOFTWARE_KEYBOARD_NOT_ONSCREEN"); return }
        let clearOfKeyboard = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            self.softwareKeyboardIsOnscreen(keyboard, in: app) && composer.frame.maxY <= keyboard.frame.minY + 2
        }, object: composer)
        XCTAssertEqual(XCTWaiter.wait(for: [clearOfKeyboard], timeout: 10), .completed,
                       "COMPOSER_DID_NOT_SETTLE_ABOVE_KEYBOARD")
        XCTAssertTrue(softwareKeyboardIsOnscreen(keyboard, in: app), "SOFTWARE_KEYBOARD_NOT_ONSCREEN")
        XCTAssertLessThanOrEqual(composer.frame.maxY, keyboard.frame.minY + 2,
                                 "COMPOSER_OBSCURED_BY_SOFTWARE_KEYBOARD")
        XCTAssertGreaterThanOrEqual(composer.frame.minX, web.frame.minX)
        XCTAssertLessThanOrEqual(composer.frame.maxX, web.frame.maxX)
        dismissRehearsalChatKeyboard(app)
        XCTAssertFalse(softwareKeyboardIsOnscreen(keyboard, in: app), "SOFTWARE_KEYBOARD_NOT_DISMISSED")
        XCTAssertTrue((composer.value as? String) == draft, "KEYBOARD_CHANGED_UNSENT_DRAFT")
        perfTapNav(app, label: "One")
        let mail = web.links.matching(NSPredicate(format: "label == %@", "Open Mail")).firstMatch
        XCTAssertTrue(mail.waitForExistence(timeout: 15) && mail.isHittable, "MAIL_ENTRY_UNAVAILABLE")
        mail.tap()
        func tab(_ name: String) -> XCUIElement {
            web.buttons.matching(NSPredicate(format: "label == %@", name)).firstMatch
        }
        func settled(_ name: String) {
            let selected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "selected == true"), object: tab(name))
            XCTAssertEqual(XCTWaiter.wait(for: [selected], timeout: 10), .completed, "MAIL_TAB_NOT_SETTLED")
        }
        XCTAssertTrue(tab("Overview").waitForExistence(timeout: 15), "MAIL_WORKSPACE_NOT_PRESENT")
        tab("Overview").tap()
        settled("Overview")
        func drag(_ left: Bool) {
            let start = web.coordinate(withNormalizedOffset: CGVector(dx: left ? 0.82 : 0.18, dy: 0.60))
            let end = web.coordinate(withNormalizedOffset: CGVector(dx: left ? 0.18 : 0.82, dy: 0.60))
            start.press(forDuration: 0.06, thenDragTo: end, withVelocity: XCUIGestureVelocity(rawValue: 400), thenHoldForDuration: 0)
        }
        drag(true); settled("KYC")
        drag(true); settled("Receipts")
        drag(false); settled("KYC")
        tab("Overview").tap(); settled("Overview")
        XCTAssertFalse(web.staticTexts["Connect Mail to set up receipts and KYC requests."].exists)
        perfTapNav(app, label: "Chat")
        XCTAssertTrue(composer.waitForExistence(timeout: 15) && composer.isHittable)
        XCTAssertTrue((composer.value as? String) == draft, "MAIL_RETURN_CHANGED_UNSENT_DRAFT")
        XCTAssertFalse(web.buttons["Unlock"].exists, "MAIL_RETURN_LOST_VAULT")
        XCTAssertEqual(hosts.count, 1)
        XCTAssertEqual(app.webViews.count, 1 + web.webViews.count)
        print("MAIL_KEYBOARD_CONTINUITY real_keyboard_bidirectional_pager_warm_chat")
    }

    func testLocalSessionStatusBarCanvasMatchesHeader() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_LOCAL_SESSION_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in status canvas proof; requires the running Chat session")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            throw XCTSkip("Status canvas proof must not cold-launch or change the session")
        }
        app.activate()
        XCTAssertFalse(app.webViews.buttons["Unlock"].exists)
        XCTAssertTrue(app.webViews.buttons.matching(NSPredicate(
            format: "label BEGINSWITH %@", "Open chat history"
        )).firstMatch.exists, "Status canvas proof requires the existing Chat page")
        assertStatusCanvasMatchesHeader()
    }

    func testLocalSessionNativePublicPreferencesRetireAndRestore() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_NATIVE_CHROME_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in native public preferences proof")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            throw XCTSkip("Preferences proof must attach to the existing session")
        }
        app.activate()
        dismissRehearsalChatKeyboard(app)
        returnToRehearsalChat(app)
        let nativeSettings = app.segmentedControls["chat-agent-surface"].firstMatch.exists
        func accentOption(_ name: String) -> XCUIElement {
            // Radix hides the underlying Profile accessibility subtree while
            // its portal is open. Query the owned popup, not that hidden body.
            app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", name)).firstMatch
        }
        func dismissAccentPopup() -> Bool {
            let blue = accentOption("Blue"), gold = accentOption("Molten Gold")
            guard blue.exists && blue.isHittable && gold.exists && gold.isHittable else {
                XCTFail("NATIVE_ACCENT_MENU_UNAVAILABLE"); return false
            }
            let bounds = app.frame, options = blue.frame.union(gold.frame)
            let point = CGPoint(x: bounds.minX + 4, y: options.midY)
            guard bounds.contains(point) && !options.contains(point) else {
                XCTFail("NATIVE_ACCENT_CANCEL_UNAVAILABLE"); return false
            }
            // The authored Select outside-press contract; no disabled header
            // action, route reset or preference mutation is used for recovery.
            app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(
                dx: point.x - bounds.minX, dy: point.y - bounds.minY)).tap()
            let retired = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                !(blue.exists && gold.exists)
            }, object: app)
            let completed = XCTWaiter.wait(for: [retired], timeout: 5) == .completed
            XCTAssertTrue(completed, "NATIVE_ACCENT_CANCEL_NOT_RETIRED")
            return completed
        }
        // A previous diagnostic may have failed with the real Accent popup
        // open. Dismiss only this positively identified popup before examining
        // its obscured origin; preserve the app, draft and current preference.
        if accentOption("Blue").exists && accentOption("Molten Gold").exists {
            guard dismissAccentPopup() else { return }
        }
        let hosts = app.webViews.matching(identifier: "native-webview"), web = hosts.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 15))
        XCTAssertFalse(web.buttons["Unlock"].exists, "Normal vault unlock is required")
        let hostFrame = web.frame
        addTeardownBlock {
            guard (self.testRun?.failureCount ?? 0) > 0 else { return }
            // Observe the failure before another runner activation/privacy
            // cycle. No Back, Close, retry or protected hierarchy serialization.
            self.printCoherentPresentationAdmission(app)
            self.printNativeControlStatuses(web)
        }
        // The product Profile pane deliberately retains shared body controls.
        // Its native Back/Close are qualified independently. Do not enable an
        // unqualified renderer just to satisfy a historical native-only test.
        let nativeTheme = app.buttons["native-profile-row-preferences-theme"].firstMatch
        let accent = nativeSettings ? app.buttons["native-profile-row-preferences-accent"].firstMatch :
            web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "App accent color")).firstMatch
        func themeOption(_ name: String) -> XCUIElement {
            web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", name)).firstMatch
        }
        func accentValue() -> String? {
            ["Blue", "Molten Gold"].first { (accent.value as? String) == $0 || accent.staticTexts[$0].exists }
        }
        func controlsReady() -> Bool {
            accent.exists && accent.isHittable &&
                (nativeSettings ? nativeTheme.exists && nativeTheme.isHittable :
                    ["Light", "Dark", "System"].allSatisfy { themeOption($0).exists && themeOption($0).isHittable })
        }
        func openPreferences() -> Bool {
            print("NATIVE_PREFERENCES_STAGE stage=enter")
            if !controlsReady() {
                let close = app.buttons["Close Profile"].firstMatch
                if !close.exists {
                    let opener = app.buttons["Open Profile"].firstMatch
                    guard waitForAdmittedControl(opener) else { XCTFail("NATIVE_PREFERENCES_OPENER_NOT_ADMITTED"); return false }
                    opener.tap()
                }
                guard waitForAdmittedControl(close) else { XCTFail("NATIVE_PREFERENCES_PROFILE_NOT_ADMITTED"); return false }
                print("NATIVE_PREFERENCES_STAGE stage=profile")
                let nativeRow = app.buttons["native-profile-row-preferences"].firstMatch
                let menu = app.descendants(matching: .any).matching(identifier: "native-profile-menu-scroll").firstMatch
                let row = nativeRow.exists || menu.exists ? nativeRow :
                    web.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Appearance & preferences")).firstMatch
                // Profile preserves its internal route while closed. Return
                // through authored Back controls, never a cold route/reset.
                for _ in 0..<4 {
                    if row.exists && row.isHittable { break }
                    let back = nativeSettings ? nativeProfileBack(app, parent: "Profile") : app.buttons["profile-back"].firstMatch
                    if !back.waitForExistence(timeout: 1) || !back.isHittable { break }
                    back.tap()
                }
                guard row.waitForExistence(timeout: 10) else { XCTFail("NATIVE_PREFERENCES_ROW_UNAVAILABLE"); return false }
                for _ in 0..<5 {
                    if row.isHittable { break }
                    if menu.exists { menu.swipeDown() } else { web.swipeUp() }
                }
                guard row.isHittable else { XCTFail("NATIVE_PREFERENCES_ROW_NOT_ADMITTED"); return false }
                print("NATIVE_PREFERENCES_STAGE stage=row")
                row.tap()
            }
            let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in controlsReady() }, object: app)
            guard XCTWaiter.wait(for: [ready], timeout: 10) == .completed else { XCTFail("NATIVE_PREFERENCES_UNAVAILABLE"); return false }
            print("NATIVE_PREFERENCES_STAGE stage=ready")
            XCTAssertFalse(app.segmentedControls["profile-appearance"].exists, "Profile exposed a native Appearance duplicate")
            XCTAssertFalse(app.buttons["profile-accent"].exists, "Profile exposed a native Accent duplicate")
            return true
        }
        func selectedTheme(_ name: String) -> Bool {
            if nativeSettings { return nativeTheme.exists && nativeTheme.value as? String == name }
            let option = themeOption(name)
            return option.exists && (option.isSelected || (option.value as? String) == "1")
        }
        func selectTheme(_ name: String) {
            print("NATIVE_PREFERENCES_STAGE stage=theme_select")
            if nativeSettings {
                guard waitForAdmittedControl(nativeTheme) else { XCTFail("NATIVE_APPEARANCE_TRIGGER_UNAVAILABLE"); return }
                if selectedTheme(name) { return }
                nativeTheme.tap()
                let option = app.buttons[name].firstMatch
                guard waitForAdmittedControl(option) else { XCTFail("NATIVE_APPEARANCE_MENU_UNAVAILABLE"); return }
                option.tap()
                let changed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in selectedTheme(name) }, object: app)
                XCTAssertEqual(XCTWaiter.wait(for: [changed], timeout: 5), .completed, "NATIVE_APPEARANCE_NOT_ACKNOWLEDGED")
                return
            }
            let segment = themeOption(name)
            XCTAssertTrue(segment.exists && segment.isHittable)
            if !selectedTheme(name) { segment.tap() }
            let changed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in selectedTheme(name) }, object: web)
            XCTAssertEqual(XCTWaiter.wait(for: [changed], timeout: 5), .completed, "NATIVE_APPEARANCE_NOT_ACKNOWLEDGED")
        }
        func selectAccent(_ name: String) {
            if accentValue() == name { return }
            print("NATIVE_PREFERENCES_STAGE stage=accent_open")
            accent.tap()
            let option = accentOption(name)
            guard option.waitForExistence(timeout: 10) && option.isHittable else {
                XCTFail("NATIVE_ACCENT_MENU_UNAVAILABLE"); return
            }
            option.tap()
            let changed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in accentValue() == name }, object: accent)
            XCTAssertEqual(XCTWaiter.wait(for: [changed], timeout: 5), .completed, "NATIVE_ACCENT_NOT_ACKNOWLEDGED")
        }
        func cancelAccentMenu() -> Bool {
            guard dismissAccentPopup() else { return false }
            let retired = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                controlsReady()
            }, object: app)
            let completed = XCTWaiter.wait(for: [retired], timeout: 5) == .completed
            XCTAssertTrue(completed, "NATIVE_ACCENT_CANCEL_NOT_RETIRED")
            return completed
        }
        guard openPreferences() else { return }
        guard let originalTheme = ["Light", "Dark", "System"].first(where: selectedTheme),
              let originalAccent = accentValue() else {
            XCTFail("NATIVE_PREFERENCE_ORIGINAL_UNKNOWN"); return
        }
        guard let initialFailureCount = testRun?.failureCount else {
            XCTFail("NATIVE_PREFERENCE_RUN_UNAVAILABLE"); return
        }
        addTeardownBlock {
            guard self.testRun?.failureCount == initialFailureCount else {
                print("NATIVE_PREFERENCES_TEARDOWN skipped_after_failure_no_navigation_replay"); return
            }
            if !controlsReady() && !openPreferences() { return }
            selectTheme(originalTheme); selectAccent(originalAccent)
            let close = app.buttons["Close Profile"].firstMatch
            guard self.waitForAdmittedControl(close) else {
                XCTFail("NATIVE_PROFILE_CLOSE_RESTORE_NOT_ADMITTED"); return
            }
            close.tap()
            let retired = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                !close.exists && !accent.exists
            }, object: app)
            guard XCTWaiter.wait(for: [retired], timeout: 10) == .completed else {
                XCTFail("NATIVE_PROFILE_RESTORE_CLOSE_NOT_CONFIRMED"); return
            }
            self.perfTapNav(app, label: "Chat")
            XCTAssertFalse(web.buttons["Unlock"].exists)
        }
        let reopenOnly = ProcessInfo.processInfo.environment["HUSHH_PREFERENCES_REOPEN_ONLY"] == "true"
        if !reopenOnly {
            for name in ["Light", "Dark", "System"] {
                let segment = nativeSettings ? nativeTheme : themeOption(name)
                XCTAssertGreaterThanOrEqual(segment.frame.width, 44, "NATIVE_APPEARANCE_SEGMENT_WIDTH_UNADMITTED")
                XCTAssertGreaterThanOrEqual(segment.frame.height, 44, "NATIVE_APPEARANCE_SEGMENT_HEIGHT_UNADMITTED")
                selectTheme(name)
                XCTAssertTrue(accent.isHittable)
            }
            for name in ["Blue", "Molten Gold"] { selectAccent(name) }
        }
        let value = accentValue()
        if !reopenOnly {
            for _ in 0..<2 {
                accent.tap()
                guard cancelAccentMenu() else { return }
                XCTAssertEqual(accentValue(), value, "Cancellation changed the preference")
            }
        }
        for cycle in 0..<10 {
            let close = nativeSettings ? app.buttons["native-profile-drawer-close"].firstMatch : app.buttons.matching(NSPredicate(
                format: "identifier == %@ AND label == %@", "profile-close", "Close Profile")).firstMatch
            XCTAssertTrue(close.exists && close.isHittable, "NATIVE_PROFILE_CLOSE_REOPEN_FELL_BACK")
            XCTAssertFalse(web.buttons.matching(NSPredicate(
                format: "label == %@ AND identifier != %@", "Close Profile", "profile-close")).firstMatch.exists,
                "Profile exposed a web Close beside its native control")
            print("NATIVE_PROFILE_CYCLE index=\(cycle) phase=before privacy_cover=\(app.otherElements["session-privacy-shield"].exists) app_state=\(app.state.rawValue)")
            // Exercise the whole hit region, not only the visible X glyph.
            let point = cycle.isMultiple(of: 2) ? CGVector(dx: 0.1, dy: 0.5) : CGVector(dx: 0.9, dy: 0.5)
            close.coordinate(withNormalizedOffset: point).tap()
            print("NATIVE_PROFILE_CYCLE index=\(cycle) phase=tapped privacy_cover=\(app.otherElements["session-privacy-shield"].exists) app_state=\(app.state.rawValue)")
            let openProfile = nativeSettings ? app.buttons["Open Profile"].firstMatch : web.buttons["Open Profile"].firstMatch
            let retired = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                !close.exists && !themeOption("System").exists && !accent.exists && openProfile.exists && openProfile.isHittable
            }, object: app)
            guard XCTWaiter.wait(for: [retired], timeout: 5) == .completed else {
                print("NATIVE_PROFILE_CYCLE index=\(cycle) phase=failed privacy_cover=\(app.otherElements["session-privacy-shield"].exists) app_state=\(app.state.rawValue)")
                XCTFail("NATIVE_PROFILE_CLOSE_NOT_CONFIRMED"); return
            }
            print("NATIVE_PROFILE_CYCLE index=\(cycle) phase=closed privacy_cover=\(app.otherElements["session-privacy-shield"].exists) app_state=\(app.state.rawValue)")
            XCTAssertEqual(hosts.count, 1, "Profile return replaced or duplicated Chat's host")
            XCTAssertEqual(web.frame, hostFrame, "Profile return moved the Chat host")
            openProfile.tap()
            let reopened = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                close.exists && close.isHittable
            }, object: close)
            guard XCTWaiter.wait(for: [reopened], timeout: 10) == .completed else {
                XCTFail("NATIVE_PROFILE_REOPEN_NOT_CONFIRMED"); return
            }
            guard openPreferences() else { return }
            XCTAssertEqual(accentValue(), value, "Profile reopen lost the applied Accent")
            if nativeSettings {
                // The complete native modal intentionally excludes Chat from
                // accessibility. Prove the same host at the exposed return.
                XCTAssertEqual(hosts.count, 0, "Profile leaked covered web accessibility")
            } else {
                XCTAssertEqual(hosts.count, 1)
                XCTAssertEqual(app.webViews.count, 1 + web.webViews.count)
                XCTAssertEqual(web.frame, hostFrame, "Profile reopen moved the Chat host")
            }
            XCTAssertFalse(web.buttons["Unlock"].exists)
        }
        print(reopenOnly
            ? "NATIVE_PUBLIC_PREFERENCES_CONTINUITY ten_edge_reopens_single_host"
            : "NATIVE_PUBLIC_PREFERENCES_CONTINUITY icons_theme_accent_cancel_ten_edge_reopens_single_host")
    }

    func testLocalSessionNativeChromeFollowsAppTheme() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_NATIVE_CHROME_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in appearance proof; temporarily changes and restores the existing app preference")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            throw XCTSkip("Appearance proof must not cold-launch or reset the session")
        }
        app.activate()
        let hosts = app.webViews.matching(identifier: "native-webview")
        let web = hosts.firstMatch
        let recovery = ProcessInfo.processInfo.environment["HUSHH_RUN_RECOVERY_SMOKE"] == "true"
        XCTAssertTrue(web.waitForExistence(timeout: 15))
        XCTAssertFalse(web.buttons["Unlock"].exists, "Normal vault unlock is required")

        func closeProfile() {
            let close = app.buttons["Close Profile"].firstMatch
            XCTAssertTrue(waitForAdmittedControl(close), "THEME_CLOSE_NOT_ADMITTED")
            close.tap()
            let retired = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: close)
            XCTAssertEqual(XCTWaiter.wait(for: [retired], timeout: 10), .completed, "THEME_PROFILE_NOT_RETIRED")
        }

        func openPreferences() {
            let close = app.buttons["Close Profile"].firstMatch
            if close.exists && themeOption("System").exists && themeOption("System").isHittable { return }
            if !close.exists {
                let profile = app.buttons["Open Profile"].firstMatch
                XCTAssertTrue(profile.waitForExistence(timeout: 10) && profile.isHittable, "THEME_PROFILE_UNAVAILABLE")
                profile.tap()
            }
            XCTAssertTrue(close.waitForExistence(timeout: 10) && close.isHittable, "THEME_PROFILE_NOT_SETTLED")
            for _ in 0..<4 {
                let back = app.buttons["Back in Profile"].firstMatch
                if !back.waitForExistence(timeout: 1) || !back.isHittable { break }
                back.tap()
            }
            let preferences = web.buttons.matching(NSPredicate(
                format: "label BEGINSWITH %@", "Appearance & preferences"
            )).firstMatch
            XCTAssertTrue(preferences.waitForExistence(timeout: 10), "THEME_PREFERENCES_UNAVAILABLE")
            for _ in 0..<3 {
                if preferences.isHittable { break }
                web.swipeUp()
            }
            XCTAssertTrue(preferences.isHittable, "THEME_PREFERENCES_NOT_HITTABLE")
            preferences.tap()
            XCTAssertTrue(themeOption("System").waitForExistence(timeout: 10), "THEME_OPTIONS_UNAVAILABLE")
        }
        func themeOption(_ label: String) -> XCUIElement {
            let native = app.segmentedControls["profile-appearance"].firstMatch
            if native.exists { return native.buttons[label].firstMatch }
            // WebKit maps authored role=radio differently across OS releases.
            // Match the explicit accessible name, not an assumed XCUI type.
            return web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
        }
        func selected(_ label: String) -> Bool {
            let radio = themeOption(label)
            return radio.exists && (radio.isSelected || (radio.value as? String) == "1")
        }
        func selectTheme(_ label: String) {
            let radio = themeOption(label)
            XCTAssertTrue(radio.exists && radio.isHittable, "THEME_OPTION_NOT_HITTABLE")
            if !selected(label) { radio.tap() }
            let acknowledged = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in selected(label) }, object: web)
            XCTAssertEqual(XCTWaiter.wait(for: [acknowledged], timeout: 5), .completed, "THEME_SELECTION_NOT_ACKNOWLEDGED")
            closeProfile()
        }

        let accent = web.descendants(matching: .any).matching(NSPredicate(
            format: "label == %@", "App accent color"
        )).firstMatch
        func selectedAccent() -> String? {
            ["Blue", "Molten Gold"].first {
                (accent.value as? String) == $0 || accent.staticTexts[$0].exists
            }
        }
        func selectAccent(_ name: String) {
            openPreferences()
            guard waitForAdmittedControl(accent), let current = selectedAccent() else {
                XCTFail("RECOVERY_ACCENT_NOT_ADMITTED"); return
            }
            if current != name {
                accent.tap()
                // The target differs from the current trigger value, so its
                // explicit name identifies the option rather than trigger text.
                let option = web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", name)).firstMatch
                guard waitForAdmittedControl(option) else { XCTFail("RECOVERY_ACCENT_OPTION_NOT_ADMITTED"); return }
                option.tap()
                let applied = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in selectedAccent() == name }, object: accent)
                XCTAssertEqual(XCTWaiter.wait(for: [applied], timeout: 5), .completed, "RECOVERY_ACCENT_NOT_APPLIED")
            }
            XCTAssertFalse(app.buttons["profile-accent"].exists, "Recovery exposed a native Accent duplicate")
            closeProfile()
        }

        openPreferences()
        guard let original = ["Light", "Dark", "System"].first(where: selected) else {
            XCTFail("THEME_ORIGINAL_SELECTION_UNKNOWN")
            return // Never change a preference whose restoration value is unknown.
        }
        let originalAccent = recovery ? selectedAccent() : nil
        if recovery && originalAccent == nil {
            closeProfile()
            XCTFail("RECOVERY_ORIGINAL_ACCENT_UNKNOWN"); return
        }
        addTeardownBlock {
            // XCTest teardown also runs after fail-fast assertions. No sign-out,
            // new app process, storage injection or OS appearance changes.
            if let originalAccent { selectAccent(originalAccent) }
            openPreferences()
            selectTheme(original)
            self.perfTapNav(app, label: "Chat")
            let chat = app.descendants(matching: .any).matching(identifier: "one-native-navigation").firstMatch.buttons["Chat"]
            let selectedChat = XCTNSPredicateExpectation(predicate: NSPredicate(format: "selected == true"), object: chat)
            XCTAssertEqual(XCTWaiter.wait(for: [selectedChat], timeout: 10), .completed, "THEME_RESTORE_CHAT_NOT_SELECTED")
            let composer = self.rehearsalChatComposer(app)
            XCTAssertTrue(composer.waitForExistence(timeout: 10) && composer.isHittable, "THEME_RESTORE_CHAT_NOT_READY")
            XCTAssertFalse(web.buttons["Unlock"].exists, "Theme restoration lost the session")
            print("NATIVE_THEME_RESTORED original_preference_unlocked_chat=true")
        }
        closeProfile()
        var hadBackAuditFailure = false
        for theme in ["Light", "Dark"] {
            openPreferences()
            selectTheme(theme)
            if recovery {
                for name in ["Blue", "Molten Gold"] {
                    selectAccent(name)
                    for destination in ["Chat", "One", "Connect", "Feed"] {
                        perfTapNav(app, label: destination)
                        let bar = app.descendants(matching: .any).matching(identifier: "one-native-navigation").firstMatch
                        let selectedTab = bar.buttons[destination]
                        let settled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "selected == true"), object: selectedTab)
                        XCTAssertEqual(XCTWaiter.wait(for: [settled], timeout: 10), .completed, "RECOVERY_THEME_ROUTE_NOT_SETTLED")
                        XCTAssertTrue(waitForAdmittedControl(bar), "Recovery lost native bottom navigation")
                        XCTAssertFalse(web.buttons["Unlock"].exists, "Recovery appearance changes lost the warm session")
                        XCTAssertFalse(app.buttons["chat-history-toggle"].exists, "Recovery exposed a custom native header")
                        XCTAssertFalse(app.segmentedControls["profile-appearance"].exists, "Recovery exposed a native Appearance duplicate")
                        XCTAssertEqual(hosts.count, 1)
                        assertStatusCanvasMatchesHeader(expectedDark: theme == "Dark")
                        print("RECOVERY_THEME_ROUTE theme=\(theme) accent=\(name == "Blue" ? "blue" : "gold") tab=\(destination) matching=true")
                    }
                }
                // Native Back/material audit below remains required for its
                // opted-in candidate, not this deliberately React recovery.
                continue
            }
            for destination in ["Chat", "One", "Connect", "Feed"] {
                perfTapNav(app, label: destination)
                let bar = app.descendants(matching: .any).matching(identifier: "one-native-navigation").firstMatch
                let selectedTab = bar.buttons[destination]
                let settled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "selected == true"), object: selectedTab)
                XCTAssertEqual(XCTWaiter.wait(for: [settled], timeout: 10), .completed, "THEME_ROUTE_NOT_SETTLED")
                XCTAssertFalse(web.buttons["Unlock"].exists, "Theme route lost the unlocked session")
                XCTAssertEqual(hosts.count, 1)
                assertStatusCanvasMatchesHeader(expectedDark: theme == "Dark")
                print("NATIVE_THEME_ROUTE theme=\(theme) tab=\(destination) matching=true")
            }
            perfTapNav(app, label: "One")
            let wallet = web.links["Open Wallet"].firstMatch
            XCTAssertTrue(wallet.waitForExistence(timeout: 10))
            for _ in 0..<3 {
                if wallet.isHittable { break }
                web.swipeUp()
            }
            XCTAssertTrue(wallet.isHittable)
            wallet.tap()
            let back = app.buttons["top-shell-back"].firstMatch
            XCTAssertTrue(back.waitForExistence(timeout: 10) && back.isHittable, "THEME_NATIVE_BACK_UNAVAILABLE")
            let status = app.buttons["native-test-status"].firstMatch
            let walletReady = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                guard status.exists else { return false }
                let state = self.parseStatus((status.value as? String) ?? status.label)
                return state["route"] == "/one/wallet" && state["auth"] == "authenticated" &&
                    ["loaded", "empty-valid"].contains(state["data"] ?? "")
            }, object: status)
            let ready = XCTWaiter.wait(for: [walletReady], timeout: 15) == .completed
            print("NATIVE_THEME_WALLET_READY ready=\(ready)")
            guard ready else { XCTFail("THEME_WALLET_NOT_READY"); return }
            XCTAssertEqual(back.frame.width, 44, accuracy: 1)
            XCTAssertEqual(back.frame.height, 44, accuracy: 1)
            assertStatusCanvasMatchesHeader(expectedDark: theme == "Dark")
            // Bounded native-control audit, not an app-wide accessibility pass.
            // Ignore only issues explicitly attributed to other controls;
            // unattributed issues remain failures rather than disappearing.
            // XCTest records audit failures independently of Swift's error.
            // Continue only this audit so Dark still runs; all issues remain
            // failures in the result, not caught-and-waived acceptance.
            continueAfterFailure = true
            var rejectedBackAuditIssue = false
            do {
                try app.performAccessibilityAudit(for: [.contrast, .hitRegion, .sufficientElementDescription, .trait]) { issue in
                    guard let element = issue.element else { rejectedBackAuditIssue = true; return false }
                    print("NATIVE_BACK_AUDIT_ISSUE identified=\(!element.identifier.isEmpty) overlaps_back=\(element.frame.intersects(back.frame)) type=\(issue.auditType.rawValue)")
                    let publicControls = ["Open Profile", "Add card", "Done", "Search cards", "Go back", "One.", "Chat", "One", "Connect", "Feed", "Search", "Top of screen", "Scroll to top", "Status bar", "Back", "Skip to main content", "Notifications alt+T", "Notifications", "Wallet", "Hussh One", "Breadcrumb", "Main"]
                    let publicIndex = publicControls.firstIndex(of: element.label) ?? -1
                    print("NATIVE_AUDIT_GEOMETRY public_control=\(publicIndex) x=\(Int(element.frame.minX)) y=\(Int(element.frame.minY)) width=\(Int(element.frame.width)) height=\(Int(element.frame.height))")
                    print("NATIVE_AUDIT_ELEMENT type=\(element.elementType.rawValue) label_empty=\(element.label.isEmpty)")
                    // Classify only public accessibility vocabulary; never emit
                    // the label itself or the protected page's hierarchy.
                    let vocabulary = element.label.lowercased()
                    print("NATIVE_AUDIT_ROLE scroll=\(vocabulary.contains("scroll")) top=\(vocabulary.contains("top")) status=\(vocabulary.contains("status")) web=\(vocabulary.contains("web"))")
                    print("NATIVE_AUDIT_DIAGNOSTIC status_format=\(element.label.hasPrefix("route=") && element.label.contains(";auth=")) continuity_format=\(element.label.hasPrefix("{"))")
                    // Repeated full-tree searches did not attribute the reported
                    // issue. Keep bounded metadata, not dozens of snapshot queries
                    // per failure; unknown labels still fail rather than waive.
                    let attributedElsewhere = !element.identifier.isEmpty && element.identifier != "top-shell-back" &&
                        !element.frame.intersects(back.frame)
                    if !attributedElsewhere { rejectedBackAuditIssue = true }
                    return attributedElsewhere
                }
                if rejectedBackAuditIssue {
                    hadBackAuditFailure = true
                    print("NATIVE_BACK_ACCESSIBILITY_FAILED theme=\(theme)")
                } else {
                    print("NATIVE_BACK_ACCESSIBILITY theme=\(theme) contrast_hit_description_traits=true")
                }
            } catch {
                hadBackAuditFailure = true
                print("NATIVE_BACK_ACCESSIBILITY_FAILED theme=\(theme)")
            }
            continueAfterFailure = false
            back.tap()
            XCTAssertTrue(wallet.waitForExistence(timeout: 10), "THEME_BACK_RETURN_FAILED")
            print("NATIVE_THEME_BACK theme=\(theme) warm_return=true")
        }
        XCTAssertFalse(hadBackAuditFailure, "NATIVE_BACK_ACCESSIBILITY_FAILED")
    }

    private func assertStatusCanvasMatchesHeader(expectedDark: Bool? = nil) {
        let status = XCUIApplication(bundleIdentifier: "com.apple.springboard").statusBars.firstMatch
        XCTAssertTrue(status.waitForExistence(timeout: 5), "System status region unavailable")
        // Keep pixels in memory only: no attachment, snapshot or protected
        // hierarchy. Sample quiet left-edge bands below the clock/notch, then
        // discard the full image. A dark host strip above a light header fails.
        let image = XCUIScreen.main.screenshot().image
        guard let pixels = image.cgImage else { XCTFail("Status canvas image unavailable"); return }
        let scale = image.scale
        let frame = status.frame
        guard frame.width > 0, frame.height > 12 else {
            XCTFail("Status canvas geometry unavailable"); return
        }
        func average(_ y: CGFloat) -> [Double]? {
            let rect = CGRect(x: (frame.minX + frame.width * 0.08) * scale,
                              y: y * scale, width: 12 * scale, height: 4 * scale)
            guard let crop = pixels.cropping(to: rect),
                  let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
            var rgba = [UInt8](repeating: 0, count: 4)
            let drawn = rgba.withUnsafeMutableBytes { bytes -> Bool in
                guard let context = CGContext(data: bytes.baseAddress, width: 1, height: 1,
                    bitsPerComponent: 8, bytesPerRow: 4, space: space,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
                context.draw(crop, in: CGRect(x: 0, y: 0, width: 1, height: 1))
                return true
            }
            return drawn ? rgba.prefix(3).map { Double($0) / 255 } : nil
        }
        guard let top = average(frame.maxY - 6), let header = average(frame.maxY + 6) else {
            XCTFail("Status canvas samples unavailable"); return
        }
        let matching = zip(top, header).allSatisfy { abs($0 - $1) < 0.18 }
        print("STATUS_CANVAS matching=\(matching)")
        XCTAssertTrue(matching, "System status canvas must blend with the adjacent app header")
        if let expectedDark {
            let brightness = header.reduce(0, +) / 3
            XCTAssertTrue(expectedDark ? brightness < 0.35 : brightness > 0.7, "STATUS_THEME_NOT_APPLIED")
        }
    }

    private func admittedProfilePaneFrame(_ app: XCUIApplication, web: XCUIElement, close: XCUIElement) throws -> CGRect {
        // A tablet sheet occupies only the right-hand portion of the WebView.
        // Its authored dialog, not the viewport, owns gestures and scrolling.
        let closeCenter = CGPoint(x: close.frame.midX, y: close.frame.midY)
        // WebKit exposes the Profile heading but can omit the dialog's name.
        // Locate its actual container by both authored root controls, then
        // require bounds containing Close. A heading, header-only container,
        // application/window or entire tablet WebView cannot substitute for it.
        let candidates = app.descendants(matching: .any).containing(.button, identifier: "Close Profile")
        _ = candidates.firstMatch.waitForExistence(timeout: 10)
        let excludedTypes: Set<XCUIElement.ElementType> = [.application, .window, .webView]
        let accountHeading = NSPredicate(format: "label BEGINSWITH %@", "Your account")
        let webFrame = web.frame
        let appFrame = app.frame
        var frames: [CGRect] = []
        for element in candidates.allElementsBoundByIndex {
            guard !excludedTypes.contains(element.elementType),
                  element.buttons.matching(accountHeading).firstMatch.exists else { continue }
            let frame = element.frame.intersection(webFrame).intersection(appFrame)
            guard !frame.isNull, frame.width >= 200, frame.height > 100,
                  frame.contains(closeCenter),
                  webFrame.width < 600 || frame.width < webFrame.width - 1 else { continue }
            frames.append(frame)
        }
        guard let frame = frames.min(by: { $0.width * $0.height < $1.width * $1.height }) else {
            print("PROFILE_PANE_PUBLIC_GEOMETRY candidates=\(candidates.count) admitted=\(frames.count) close_x=\(Int(close.frame.minX)) close_y=\(Int(close.frame.minY)) web_width=\(Int(web.frame.width)) web_height=\(Int(web.frame.height))")
            XCTFail("PROFILE_PANE_FRAME_UNAVAILABLE"); throw NSError(domain: "ProfilePaneFixture", code: 1)
        }
        return frame
    }

    func testLocalSessionNativeSupportFormKeepsDraftWithoutSending() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_LOCAL_SESSION_SMOKE"] == "true" else { throw XCTSkip("Opt-in ordinary support form") }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            XCTFail("PROFILE_SUPPORT_REQUIRES_RUNNING_SESSION"); return
        }
        app.activate()
        printSupportControlAdmission(app)
        dismissRehearsalChatKeyboard(app); returnToRehearsalChat(app)
        let chatEditor = app.textViews["native-dock-editor"].firstMatch
        guard waitForAdmittedControl(chatEditor) else {
            printSupportControlAdmission(app); printCoherentPresentationAdmission(app)
            XCTFail("PROFILE_SUPPORT_CHAT_UNAVAILABLE"); return
        }
        let chatDraft = chatEditor.value as? String
        let opener = app.buttons["Open Profile"].firstMatch
        let root = app.buttons["native-profile-row-support"].firstMatch
        let close = app.buttons["native-profile-drawer-close"].firstMatch
        let menu = app.descendants(matching: .any).matching(identifier: "native-profile-menu-scroll").firstMatch
        let cancel = app.buttons["native-support-cancel"].firstMatch
        let field = app.textViews["native-support-message"].firstMatch
        let send = app.buttons["native-support-send"].firstMatch
        defer {
            if cancel.exists && cancel.isHittable { cancel.tap() }
            if close.exists && close.isHittable { close.tap() }
        }
        guard waitForAdmittedControl(opener) else { XCTFail("PROFILE_SUPPORT_OPENER_UNAVAILABLE"); return }; opener.tap()
        for _ in 0..<4 {
            if root.exists && root.isHittable { break }
            if root.exists && menu.exists && menu.isHittable { menu.swipeUp(); continue }
            let back = nativeProfileBack(app, parent: "Profile")
            guard waitForAdmittedControl(back) else { XCTFail("PROFILE_SUPPORT_PARENT_UNAVAILABLE"); return }; back.tap()
        }
        guard waitForAdmittedControl(root) else { XCTFail("PROFILE_SUPPORT_ROW_UNAVAILABLE"); return }; root.tap()
        guard waitForAdmittedControl(field), waitForAdmittedControl(cancel) else {
            for (name, control) in [("message", field), ("cancel", cancel), ("send", send),
                                    ("kinds", app.segmentedControls["native-support-kind"].firstMatch)] {
                print("PROFILE_SUPPORT_CONTROL name=\(name) present=\(control.exists) hittable=\(control.exists && control.isHittable) enabled=\(control.exists && control.isEnabled)")
            }
            printSupportControlAdmission(app)
            printCoherentPresentationAdmission(app)
            XCTFail("PROFILE_SUPPORT_NATIVE_FORM_UNAVAILABLE"); return
        }
        let original = field.value as? String ?? ""
        let scene = app.otherElements["native-support-scene"].firstMatch
        func reveal(_ control: XCUIElement, upwards: Bool) -> Bool {
            for _ in 0..<3 {
                if control.exists && control.isHittable { return true }
                guard scene.exists else { return false }
                // A scene-wide swipe can land on the keyboard or scroll the
                // nested UITextView. Use the Form's visible trailing gutter.
                let collection = scene.collectionViews.firstMatch
                let scroll = scene.scrollViews.firstMatch
                let container = collection.exists ? collection : scroll.exists ? scroll : scene
                var visible = container.frame.intersection(app.frame)
                let keyboard = app.keyboards.firstMatch
                if softwareKeyboardIsOnscreen(keyboard, in: app) {
                    visible.size.height = max(0, min(visible.maxY, keyboard.frame.minY) - visible.minY)
                }
                guard !visible.isNull, visible.width >= 44, visible.height >= 88 else { return false }
                let top = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: visible.maxX - 12, dy: visible.minY + visible.height * 0.2))
                let bottom = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: visible.maxX - 12, dy: visible.minY + visible.height * 0.85))
                if upwards { bottom.press(forDuration: 0.05, thenDragTo: top) }
                else { top.press(forDuration: 0.05, thenDragTo: bottom) }
            }
            printSupportControlAdmission(app)
            return control.exists && control.isHittable
        }
        let kinds = app.segmentedControls["native-support-kind"].firstMatch
        guard kinds.exists else { XCTFail("PROFILE_SUPPORT_KINDS_UNAVAILABLE"); return }
        let labels = ["Problem", "Help", "Feedback"]
        guard let originalKind = labels.first(where: { kinds.buttons[$0].isSelected }) else {
            XCTFail("PROFILE_SUPPORT_SELECTED_KIND_UNAVAILABLE"); return
        }
        XCTAssertEqual(app.webViews.matching(identifier: "native-webview").count, 0,
            "The native form must isolate the covered WebView, not leave a DOM editor interactive")
        for label in labels {
            let kind = kinds.buttons[label]
            guard waitForAdmittedControl(kind) else { XCTFail("PROFILE_SUPPORT_KIND_NOT_ADMITTED"); return }; kind.tap()
            let selected = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in kind.isSelected }, object: app)
            guard XCTWaiter.wait(for: [selected], timeout: 5) == .completed else { XCTFail("PROFILE_SUPPORT_KIND_NOT_APPLIED"); return }
        }
        kinds.buttons[originalKind].tap()
        // Only synthetic keystrokes may enter XCTest's activity stream. Append
        // and remove our own suffix; never retype an owner's existing message.
        let suffix = "\nSynthetic support rehearsal\nNo delivery requested."
        field.tap()
        field.typeKey("a", modifierFlags: .command)
        field.typeKey(XCUIKeyboardKey.rightArrow.rawValue, modifierFlags: [])
        field.typeText(suffix)
        guard waitForSoftwareKeyboard(app) else { XCTFail("PROFILE_SUPPORT_KEYBOARD_UNAVAILABLE"); return }
        let edited = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            field.value as? String == original + suffix
        }, object: app)
        guard XCTWaiter.wait(for: [edited], timeout: 5) == .completed else { XCTFail("PROFILE_SUPPORT_EDIT_NOT_ACKNOWLEDGED"); return }
        // Form rows are lazily realized below the initial medium detent.
        // Reach the real primary action through normal native scrolling.
        guard reveal(send, upwards: true), send.isEnabled else { XCTFail("PROFILE_SUPPORT_SEND_UNAVAILABLE"); return }
        guard reveal(field, upwards: false), waitForAdmittedControl(field) else { XCTFail("PROFILE_SUPPORT_EDITOR_RETURN_UNAVAILABLE"); return }
        field.tap()
        field.typeKey("a", modifierFlags: .command)
        field.typeKey(XCUIKeyboardKey.rightArrow.rawValue, modifierFlags: [])
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: suffix.utf16.count))
        let restored = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in field.value as? String == original }, object: app)
        guard XCTWaiter.wait(for: [restored], timeout: 5) == .completed else { XCTFail("PROFILE_SUPPORT_DRAFT_RESTORE_FAILED"); return }
        cancel.tap()
        let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in !field.exists && close.isHittable }, object: app)
        guard XCTWaiter.wait(for: [dismissed], timeout: 10) == .completed else { XCTFail("PROFILE_SUPPORT_RETIREMENT_BLOCKED_TOUCH"); return }
        close.tap()
        guard waitForAdmittedControl(chatEditor) else { XCTFail("PROFILE_SUPPORT_CHAT_RETURN_UNAVAILABLE"); return }
        XCTAssertTrue((chatEditor.value as? String) == chatDraft, "Support must preserve the Chat draft")
        XCTAssertEqual(app.webViews.matching(identifier: "native-webview").count, 1)
        print("PROFILE_SUPPORT_FORM_CONTINUITY kinds=3 multiline=true submitted=false restored=true")
    }

    func testLocalSessionNativeWritingStyleSheetKeepsDraftAndOwnedMenus() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_LOCAL_SESSION_SMOKE"] == "true" else { throw XCTSkip("Opt-in ordinary preferences continuity") }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            XCTFail("PROFILE_STYLE_REQUIRES_RUNNING_SESSION"); return
        }
        app.activate(); dismissRehearsalChatKeyboard(app); returnToRehearsalChat(app)
        let hosts = app.webViews.matching(identifier: "native-webview"), web = hosts.firstMatch
        let editor = app.textViews["native-dock-editor"].firstMatch
        guard waitForAdmittedControl(editor) else { XCTFail("PROFILE_STYLE_CHAT_UNAVAILABLE"); return }
        let initialDraft = editor.value as? String
        let opener = app.buttons["Open Profile"].firstMatch
        let root = app.buttons["native-profile-row-preferences"].firstMatch
        let close = app.buttons["native-profile-drawer-close"].firstMatch
        let menu = app.descendants(matching: .any).matching(identifier: "native-profile-menu-scroll").firstMatch
        var back: XCUIElement {
            let native = nativeProfileBack(app, parent: "Profile")
            return native.exists ? native : app.buttons["Back in Profile"].firstMatch
        }
        let cancel = app.buttons["native-style-close"].firstMatch
        let field = app.textViews["native-style-preferred_name"].firstMatch
        let tone = app.buttons["native-style-tone"].firstMatch
        defer {
            if cancel.exists && cancel.isHittable { cancel.tap() }
            if back.exists && back.isHittable { back.tap() }
            if close.exists && close.isHittable { close.tap() }
        }
        guard waitForAdmittedControl(opener) else { XCTFail("PROFILE_STYLE_OPENER_UNAVAILABLE"); return }
        opener.tap()
        for _ in 0..<3 {
            if root.exists && root.isHittable { break }
            // The preceding warm journey may leave the root roster scrolled.
            // Restore its existing row before assuming a nested Back is owed.
            if root.exists && menu.exists && menu.isHittable { menu.swipeDown(); continue }
            guard waitForAdmittedControl(back) else { XCTFail("PROFILE_STYLE_PARENT_UNAVAILABLE"); return }; back.tap()
        }
        guard waitForAdmittedControl(root) else { XCTFail("PROFILE_STYLE_PREFERENCES_UNAVAILABLE"); return }; root.tap()
        let nativeStyle = app.buttons["native-profile-row-preferences-style"].firstMatch
        var row: XCUIElement { nativeStyle.exists ? nativeStyle : web.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Writing style")).firstMatch }
        for _ in 0..<4 { if row.exists && row.isHittable { break }; (menu.exists ? menu : web).swipeUp() }
        var originalName: String?
        for cycle in 0..<10 {
            guard waitForAdmittedControl(row) else { XCTFail("PROFILE_STYLE_ROW_UNAVAILABLE"); return }; row.tap()
            guard waitForAdmittedControl(field), waitForAdmittedControl(cancel), waitForAdmittedControl(tone) else {
                XCTFail("PROFILE_STYLE_NATIVE_SCENE_UNAVAILABLE"); return
            }
            if cycle == 0 { originalName = field.value as? String }
            XCTAssertTrue((field.value as? String) == originalName, "The transient preference replica must preserve its authoritative draft")
            XCTAssertFalse(back.isHittable, "The complete native sheet must isolate the Profile header")
            if cycle == 0 || cycle == 9 {
                let originalTone = try XCTUnwrap(tone.value as? String)
                tone.tap()
                let direct = app.buttons["Direct"].firstMatch
                guard waitForAdmittedControl(direct) else { XCTFail("PROFILE_STYLE_MENU_UNAVAILABLE"); return }; direct.tap()
                let applied = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in tone.value as? String == "Direct" }, object: app)
                guard XCTWaiter.wait(for: [applied], timeout: 10) == .completed else { XCTFail("PROFILE_STYLE_CHOICE_NOT_APPLIED"); return }
                tone.tap()
                let restore = app.buttons[originalTone].firstMatch
                guard waitForAdmittedControl(restore) else { XCTFail("PROFILE_STYLE_RESTORE_UNAVAILABLE"); return }; restore.tap()
                let restored = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in tone.value as? String == originalTone }, object: app)
                guard XCTWaiter.wait(for: [restored], timeout: 10) == .completed else { XCTFail("PROFILE_STYLE_RESTORE_NOT_APPLIED"); return }
                field.tap(); field.typeText(" A")
                XCTAssertTrue((field.value as? String) != originalName, "The native preference editor accepts keyboard input")
                field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 2))
                let nameRestored = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in field.value as? String == originalName }, object: app)
                guard XCTWaiter.wait(for: [nameRestored], timeout: 10) == .completed else { XCTFail("PROFILE_STYLE_TEXT_RESTORE_NOT_APPLIED"); return }
            }
            cancel.tap()
            let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in !field.exists && row.isHittable }, object: app)
            guard XCTWaiter.wait(for: [dismissed], timeout: 10) == .completed else { XCTFail("PROFILE_STYLE_DISMISSAL_BLOCKED_TOUCH"); return }
            XCTAssertEqual(hosts.count, nativeStyle.exists ? 0 : 1, "Native Preferences isolates the covered WebView")
            XCTAssertFalse(web.textViews["Style note"].exists, "The complete native scene cannot expose a DOM editor duplicate")
        }
        guard waitForAdmittedControl(back) else { XCTFail("PROFILE_STYLE_BACK_UNAVAILABLE"); return }; back.tap()
        guard waitForAdmittedControl(close) else { XCTFail("PROFILE_STYLE_CLOSE_UNAVAILABLE"); return }; close.tap()
        guard waitForAdmittedControl(editor) else { XCTFail("PROFILE_STYLE_CHAT_RETURN_UNAVAILABLE"); return }
        XCTAssertTrue((editor.value as? String) == initialDraft, "Preference editing must preserve the Chat draft")
        print("PROFILE_STYLE_SCENE_CONTINUITY cycles=10 restored=true single_host=true")
    }

    func testLocalSessionNativeProfileNameSheetKeepsTheAccountAndDraft() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_LOCAL_SESSION_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in private ordinary Profile scene continuity")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            XCTFail("PROFILE_NAME_REQUIRES_RUNNING_SESSION"); return
        }
        app.activate()
        dismissRehearsalChatKeyboard(app)
        returnToRehearsalChat(app)
        let hosts = app.webViews.matching(identifier: "native-webview")
        let web = hosts.firstMatch
        let editor = app.textViews["native-dock-editor"].firstMatch
        guard waitForAdmittedControl(editor) else { XCTFail("PROFILE_NAME_CHAT_UNAVAILABLE"); return }
        let initialDraft = editor.value as? String // Memory only; never emitted or attached.
        let opener = app.buttons["Open Profile"].firstMatch
        let root = app.buttons["native-profile-row-account"].firstMatch
        let close = app.buttons["native-profile-drawer-close"].firstMatch
        var back: XCUIElement {
            let native = app.navigationBars["Your account"].buttons["Profile"].firstMatch
            return native.exists ? native : app.buttons["Back in Profile"].firstMatch
        }
        let cancel = app.buttons["native-profile-name-cancel"].firstMatch
        let field = app.textFields["native-profile-name-editor"].firstMatch
        defer {
            if cancel.exists && cancel.isHittable { cancel.tap() }
            if back.exists && back.isHittable { back.tap() }
            if close.exists && close.isHittable { close.tap() }
        }
        guard waitForAdmittedControl(opener) else { XCTFail("PROFILE_NAME_OPENER_UNAVAILABLE"); return }
        opener.tap()
        for _ in 0..<3 {
            if root.exists && root.isHittable && close.exists && close.isHittable { break }
            guard waitForAdmittedControl(back) else { XCTFail("PROFILE_NAME_PARENT_UNAVAILABLE"); return }
            back.tap()
        }
        guard waitForAdmittedControl(root) else { XCTFail("PROFILE_NAME_ACCOUNT_UNAVAILABLE"); return }
        root.tap()
        let row = app.buttons["native-profile-row-account-name"].firstMatch
        guard waitForAdmittedControl(row) else {
            printCoherentPresentationAdmission(app)
            XCTFail("PROFILE_NAME_EDIT_UNAVAILABLE"); return
        }
        var originalName: String? // Private equality only; no screenshots or value diagnostics.
        for cycle in 0..<10 {
            if cycle > 0 { root.tap() }
            guard waitForAdmittedControl(row) else {
                print("PROFILE_NAME_STAGE cycle=\(cycle) name_row=false")
                printCoherentPresentationAdmission(app)
                XCTFail("PROFILE_NAME_RETURN_UNAVAILABLE"); return
            }
            row.tap()
            guard waitForAdmittedControl(field), waitForAdmittedControl(cancel) else {
                XCTFail("PROFILE_NAME_NATIVE_SCENE_UNAVAILABLE"); return
            }
            let value = field.value as? String
            if cycle == 0 { originalName = value }
            XCTAssertTrue(value == originalName, "Cancelling must not save the transient name")
            XCTAssertFalse(app.buttons["native-profile-name-save"].firstMatch.isEnabled,
                           "Unchanged ordinary form cannot save")
            XCTAssertFalse(back.isHittable, "The owned sheet must isolate the underlying Profile header")
            if cycle == 0 || cycle == 9 {
                field.tap()
                field.typeText(" A") // Synthetic unsaved edit; never submit a reviewer fixture change.
                XCTAssertTrue((field.value as? String) != value, "The retained native field must accept keyboard editing")
            }
            cancel.tap()
            let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in !field.exists && row.isHittable }, object: app)
            guard XCTWaiter.wait(for: [dismissed], timeout: 10) == .completed else {
                XCTFail("PROFILE_NAME_DISMISSAL_DID_NOT_RESTORE_TOUCH"); return
            }
            // Native Profile intentionally AX-hides its covered WebView. A
            // zero accessible count here is isolation, not host destruction.
            XCTAssertEqual(hosts.count, 0, "Native Profile must isolate covered web content")
            XCTAssertFalse(web.textFields.matching(NSPredicate(format: "label == %@", "Display name")).firstMatch.exists,
                           "The native form cannot reveal an interactive DOM duplicate")
            guard waitForAdmittedControl(back) else { XCTFail("PROFILE_NAME_BACK_UNAVAILABLE"); return }
            back.tap()
            guard waitForAdmittedControl(root), waitForAdmittedControl(close) else {
                XCTFail("PROFILE_NAME_NATIVE_STACK_RETURN_UNAVAILABLE"); return
            }
            XCTAssertTrue(app.otherElements["native-profile-drawer-body"].firstMatch.exists,
                          "A nested pop must retain the encompassing native drawer")
        }
        guard waitForAdmittedControl(close) else { XCTFail("PROFILE_NAME_CLOSE_UNAVAILABLE"); return }
        close.tap()
        guard waitForAdmittedControl(editor) else { XCTFail("PROFILE_NAME_CHAT_RETURN_UNAVAILABLE"); return }
        XCTAssertEqual(hosts.count, 1, "The same single web workspace returns after native Profile closes")
        XCTAssertTrue((editor.value as? String) == initialDraft, "Profile editing must preserve the Chat draft")
        print("PROFILE_NAME_SCENE_CONTINUITY cycles=10 cancelled=true single_host=true")
    }

    func testLocalSessionProfileBackAcrossTheSettingsStack() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_LOCAL_SESSION_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in shared Profile Back and fallback regression")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            XCTFail("PROFILE_STACK_REQUIRES_RUNNING_SESSION"); return
        }
        addTeardownBlock {
            guard (self.testRun?.failureCount ?? 0) > 0 else { return }
            self.printCoherentPresentationAdmission(app)
        }
        app.activate()
        print("PROFILE_BATCH_ENTRY phase=activated")
        dismissRehearsalChatKeyboard(app)
        print("PROFILE_BATCH_ENTRY phase=keyboard_settled")
        returnToRehearsalChat(app)
        print("PROFILE_BATCH_ENTRY phase=chat_returned")
        let selector = app.segmentedControls["chat-agent-surface"].firstMatch
        let coherentExpected = ProcessInfo.processInfo.environment["HUSHH_EXPECT_COHERENT_PROFILE"] == "true"
        if coherentExpected || selector.exists {
            // Renderer expectation comes from candidate preparation. A native
            // drawer can temporarily hide this selector from accessibility;
            // that is not authority to enter the web-only test branch.
            guard waitForAdmittedControl(selector) else {
                XCTFail("PROFILE_BATCH_NATIVE_ENTRY_NOT_ADMITTED"); return
            }
            print("PROFILE_BATCH_ENTRY phase=renderer_native")
            try verifyCoherentProfileDestinations(app)
            return
        }
        print("PROFILE_BATCH_ENTRY phase=renderer_web")
        let hosts = app.webViews.matching(identifier: "native-webview"), web = hosts.firstMatch
        XCTAssertFalse(web.buttons["Unlock"].exists, "Normal vault unlock is required")
        let close = app.buttons["Close Profile"].firstMatch
        let nativeExpected = ProcessInfo.processInfo.environment["HUSHH_EXPECT_PROFILE_BACK_NATIVE"] == "true"
        let profileProbe = app.buttons["native-profile-back-continuity"].firstMatch
        func profileCounters() -> [String: Int]? {
            guard profileProbe.exists, let json = profileProbe.value as? String, let data = json.data(using: .utf8),
                  let packet = try? JSONSerialization.jsonObject(with: data) as? [String: Int],
                  Set(packet.keys) == Set(["installs", "removals", "replacements", "rootUpdates", "sampledFrames", "missingFrames"])
            else { return nil }
            return packet
        }
        defer {
            if close.exists && close.isHittable { close.tap() }
            self.perfTapNav(app, label: "Chat")
        }
        if !close.exists {
            let open = app.buttons["Open Profile"].firstMatch
            guard waitForAdmittedControl(open) else { XCTFail("PROFILE_OPENER_NOT_ADMITTED"); return }
            open.tap()
        }
        XCTAssertTrue(close.waitForExistence(timeout: 10), "PROFILE_CLOSE_NOT_ADMITTED")
        let paneFrame = try admittedProfilePaneFrame(app, web: web, close: close)
        func row(_ label: String) -> XCUIElement {
            web.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", label)).firstMatch
        }
        func scrollProfile(up: Bool) {
            // A full-WebView swipe begins near its bottom, which is an
            // intentionally isolated native seat in the compositor. Keep the
            // whole gesture in the Profile reading region below its header.
            let origin = app.coordinate(withNormalizedOffset: .zero)
            let x = paneFrame.midX - app.frame.minX
            let lower = origin.withOffset(CGVector(dx: x, dy: app.frame.midY - app.frame.minY))
            let upper = origin.withOffset(CGVector(dx: x, dy: close.frame.maxY + 44 - app.frame.minY))
            (up ? lower : upper).press(forDuration: 0.01, thenDragTo: up ? upper : lower)
        }
        func rowCenterIsVisible(_ entry: XCUIElement) -> Bool {
            guard entry.exists, entry.isHittable else { return false }
            // WebKit's AX hit admission does not account for native reserved
            // seats above it. Scroll the tap target into the central reading
            // region rather than tapping a partly exposed row at the dock.
            let frame = entry.frame
            return frame.minY >= close.frame.maxY && frame.maxY <= app.frame.minY + app.frame.height * 2 / 3
        }
        func returnToRoot() {
            for _ in 0..<4 {
                if row("Your account").exists && row("Your account").isHittable { break }
                let back = app.buttons["Back in Profile"].firstMatch
                if back.exists { XCTAssertTrue(waitForAdmittedControl(back)); back.tap() }
                else { scrollProfile(up: false) }
            }
            XCTAssertTrue(waitForAdmittedControl(row("Your account")), "PROFILE_STACK_ROOT_NOT_RESTORED")
        }
        func assertBack() {
            let back = app.buttons["Back in Profile"].firstMatch
            let admitted = waitForAdmittedControl(back)
            if !admitted {
                let unlocked = !web.buttons["Unlock"].exists
                print("PROFILE_BACK_ADMISSION exists=\(back.exists) hittable=\(back.isHittable) close=\(close.exists) unlocked=\(unlocked)")
            }
            guard admitted else { XCTFail("PROFILE_BACK_UNAVAILABLE"); return }
            XCTAssertEqual(back.frame.width, 44, accuracy: 1)
            XCTAssertEqual(back.frame.height, 44, accuracy: 1)
            let native = app.buttons["profile-back"].firstMatch
            if nativeExpected {
                XCTAssertTrue(native.waitForExistence(timeout: 10) && native.isHittable, "PROFILE_BACK_NATIVE_NOT_ADMITTED")
                XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label == %@", "Back in Profile")).count, 1,
                               "Profile Back exposed duplicate native and web controls")
            } else {
                XCTAssertFalse(native.exists, "Unqualified wrappers must retain the authored Profile Back")
            }
        }
        returnToRoot()
        let remainingOnly = ProcessInfo.processInfo.environment["HUSHH_PROFILE_REMAINING_FAMILIES"] == "true"
        let families = remainingOnly
            ? ["Trusted devices", "Connectors", "Invite friends", "Help & feedback"]
            : ["Your account", "Appearance & preferences", "Security & privacy", "Trusted devices", "Connectors", "Invite friends", "Help & feedback"]
        for label in families {
            let entry = row(label)
            let family = ["Your account": "account", "Appearance & preferences": "preferences",
                          "Security & privacy": "security", "Trusted devices": "trusted_devices",
                          "Connectors": "connectors", "Invite friends": "referrals", "Help & feedback": "support"][label]!
            print("PROFILE_NAV_REQUEST target=\(family)")
            for _ in 0..<4 {
                if rowCenterIsVisible(entry) { break }
                if entry.exists && entry.frame.minY < close.frame.maxY { scrollProfile(up: false) }
                else { scrollProfile(up: true) }
            }
            guard rowCenterIsVisible(entry) else {
                if entry.exists { print("PROFILE_ENTRY_REJECTED target=\(family) y=\(Int(entry.frame.minY)) height=\(Int(entry.frame.height)) hittable=\(entry.isHittable)") }
                XCTFail("PROFILE_STACK_ENTRY_UNAVAILABLE"); return
            }
            let entryFrame = entry.frame
            // Covered navigation is correctly absent from accessibility. Its
            // frame must not be queried through AX during a modal journey.
            print("PROFILE_ENTRY_GEOMETRY target=\(family) y=\(Int(entryFrame.minY)) height=\(Int(entryFrame.height)) center_in_window=\(app.frame.contains(CGPoint(x: entryFrame.midX, y: entryFrame.midY)))")
            entry.tap()
            assertBack()
            print("PROFILE_SCREEN_ADMISSION family=\(family) back=true")
            if label == "Security & privacy" {
                let vault = row("Vault methods")
                XCTAssertTrue(vault.waitForExistence(timeout: 10) && vault.isHittable)
                let originalFrame = nativeExpected ? app.buttons["profile-back"].firstMatch.frame : nil
                let before = profileCounters()
                if nativeExpected { XCTAssertNotNil(before, "PROFILE_BACK_MEASUREMENTS_UNAVAILABLE") }
                vault.tap() // View only: no enrollment or authentication change.
                let vaultTitle = web.staticTexts["Vault methods"].firstMatch.exists
                let profileRoot = row("Your account").exists
                print("PROFILE_VAULT_STACK title=\(vaultTitle) root=\(profileRoot) security=\(vault.exists)")
                assertBack()
                app.buttons["Back in Profile"].firstMatch.tap()
                XCTAssertTrue(vault.waitForExistence(timeout: 10))
                assertBack()
                if nativeExpected, let before {
                    let retained = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                        guard let after = profileCounters() else { return false }
                        return after["replacements", default: 0] >= before["replacements", default: 0] + 2 &&
                            after["sampledFrames", default: 0] > before["sampledFrames", default: 0]
                    }, object: profileProbe)
                    XCTAssertEqual(XCTWaiter.wait(for: [retained], timeout: 10), .completed,
                                   "PROFILE_BACK_REPLACEMENT_NOT_OBSERVED")
                    let after = profileCounters()
                    XCTAssertEqual(after?["installs"], before["installs"], "Inner Profile navigation rebuilt the native host")
                    XCTAssertEqual(after?["removals"], before["removals"], "Inner Profile navigation removed the native host")
                    XCTAssertEqual(after?["rootUpdates"], before["rootUpdates"], "Unchanged Profile Back rebound its SwiftUI root")
                    XCTAssertEqual(after?["missingFrames"], before["missingFrames"], "Inner Profile navigation hid or displaced Back")
                    XCTAssertEqual(app.buttons["profile-back"].firstMatch.frame, originalFrame!)
                    print("PROFILE_BACK_REPLACEMENT_CONTINUITY inner_stack_retained_host_observed_frames")
                }
            }
            if label == "Help & feedback" {
                let names = ["Problem, report something that is not working", "Help, get help using One",
                             "Feedback, share an idea or improvement"]
                func choice(_ name: String) -> XCUIElement {
                    web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", name)).firstMatch
                }
                func chosen(_ name: String) -> Bool {
                    let item = choice(name)
                    return item.exists && (item.isSelected || (item.value as? String) == "1")
                }
                guard let original = names.first(where: chosen) else { XCTFail("PROFILE_SUPPORT_SELECTION_UNAVAILABLE"); return }
                for name in names + [original] {
                    let item = choice(name)
                    XCTAssertTrue(waitForAdmittedControl(item), "PROFILE_SUPPORT_CHOICE_NOT_ADMITTED")
                    if !chosen(name) { item.tap() }
                    let selected = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in chosen(name) }, object: web)
                    XCTAssertEqual(XCTWaiter.wait(for: [selected], timeout: 5), .completed,
                                   "PROFILE_SUPPORT_SELECTION_NOT_ACKNOWLEDGED")
                }
                print("PROFILE_SUPPORT_CHOICES choices=3 original_restored=true submitted=false")
            }
            app.buttons["Back in Profile"].firstMatch.tap()
            returnToRoot()
            XCTAssertFalse(web.buttons["Unlock"].exists, "Profile stack navigation lost vault admission")
            XCTAssertEqual(hosts.count, 1)
        }
        print("PROFILE_STACK_CONTINUITY screens=\(families.count) warm=true single_host=true")
    }

    /// Batch the actual authored menu and nested query parents. No account,
    /// connector, vault or support operation is submitted by this read journey.
    private func verifyCoherentProfileDestinations(_ app: XCUIApplication) throws {
        let web = app.webViews.matching(identifier: "native-webview").firstMatch
        let editor = app.textViews["native-dock-editor"].firstMatch
        guard waitForAdmittedControl(editor) else {
            XCTFail("PROFILE_BATCH_CHAT_EDITOR_NOT_ADMITTED"); return
        }
        let initialDraft = editor.value as? String // Process memory only.
        let opener = app.buttons["Open Profile"].firstMatch
        let close = app.buttons["native-profile-drawer-close"].firstMatch
        let nativeAccountBack = nativeProfileBack(app, parent: "Profile")
        var back: XCUIElement {
            nativeAccountBack.exists && nativeAccountBack.isHittable
                ? nativeAccountBack : app.buttons["Back in Profile"].firstMatch
        }
        let destinations = ["hosting", "software-updates", "account", "payouts", "request-pricing", "my-data", "world-model", "preferences", "security", "devices", "connectors", "invite", "support", "privacy", "terms"]
        let requestedStart = ProcessInfo.processInfo.environment["HUSHH_PROFILE_BATCH_START"]
        if let requestedStart, !destinations.contains(requestedStart) {
            XCTFail("PROFILE_BATCH_START_UNADMITTED"); return
        }
        let startIndex = requestedStart.flatMap { destinations.firstIndex(of: $0) } ?? 0
        let requestedEnd = ProcessInfo.processInfo.environment["HUSHH_PROFILE_BATCH_END"]
        if let requestedEnd, !destinations.contains(requestedEnd) {
            XCTFail("PROFILE_BATCH_END_UNADMITTED"); return
        }
        let endIndex = requestedEnd.flatMap { destinations.firstIndex(of: $0) } ?? destinations.count - 1
        guard startIndex <= endIndex else { XCTFail("PROFILE_BATCH_RANGE_UNADMITTED"); return }
        let agentOnly = ProcessInfo.processInfo.environment["HUSHH_PROFILE_AGENT_ONLY"] == "true"
        let admittedDestinations = agentOnly ? [] : Array(destinations[startIndex...endIndex])
        if agentOnly { print("PROFILE_AGENT_ONLY selected=true") }
        let legalReturnOnly = ProcessInfo.processInfo.environment["HUSHH_PROFILE_LEGAL_RETURN_ONLY"] == "true"
        let phoneOnly = ProcessInfo.processInfo.environment["HUSHH_PROFILE_PHONE_ONLY"] == "true"
        guard !phoneOnly || admittedDestinations == ["account"] else { XCTFail("PROFILE_PHONE_RANGE_UNADMITTED"); return }
        func root(_ id: String) -> XCUIElement { app.buttons["native-profile-row-\(id)"].firstMatch }
        func publicPaneLevel() -> Int? {
            let probe = app.buttons["native-profile-back-admission"].firstMatch
            guard probe.exists, let raw = probe.value as? String, raw.utf8.count <= 1024 else { return nil }
            let field = raw.split(separator: ";").first(where: { $0.hasPrefix("profilePaneLevel=") })
            guard let field, let level = Int(field.dropFirst("profilePaneLevel=".count)), (0...2).contains(level) else { return nil }
            return level
        }
        func publicPaneGeometry() -> (sample: Int, frame: CGRect)? {
            let probe = app.buttons["native-profile-back-admission"].firstMatch
            guard probe.exists, let raw = probe.value as? String, raw.utf8.count <= 1024 else { return nil }
            let fields = Dictionary(raw.split(separator: ";").compactMap { item -> (String, String)? in
                let pair = item.split(separator: "=", maxSplits: 1)
                return pair.count == 2 ? (String(pair[0]), String(pair[1])) : nil
            }, uniquingKeysWith: { _, latest in latest })
            guard fields["paneReady"] == "true", let sample = Int(fields["paneSample"] ?? ""),
                  sample > 0, sample <= 1_000_000,
                  let x = Double(fields["paneX"] ?? ""), let y = Double(fields["paneY"] ?? ""),
                  let width = Double(fields["paneWidth"] ?? ""), let height = Double(fields["paneHeight"] ?? ""),
                  [x, y, width, height].allSatisfy({ $0.isFinite && abs($0) <= 10_000 }), width >= 200, height > 100 else { return nil }
            return (sample, CGRect(x: x, y: y, width: width, height: height))
        }
        func row(_ title: String) -> XCUIElement {
            web.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
        }
        func admittedBack() -> Bool {
            guard waitForAdmittedControl(back) else { return false }
            XCTAssertEqual(back.frame.width, 44, accuracy: 1)
            XCTAssertEqual(back.frame.height, 44, accuracy: 1)
            XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label == %@", "Back in Profile")).count, 1)
            return true
        }
        defer {
            for _ in 0..<4 {
                if root("account").exists && root("account").isHittable { break }
                if back.exists && back.isHittable { back.tap() }
            }
            if close.exists && close.isHittable { close.tap() }
        }
        // A retained, covered roster can still exist in an AX snapshot. Its
        // presence does not prove the menu is open; use the admitted Close.
        if !close.exists || !close.isHittable {
            guard waitForAdmittedControl(opener) else { XCTFail("PROFILE_BATCH_OPENER_UNAVAILABLE"); return }
            opener.tap()
        }
        let menu = app.descendants(matching: .any).matching(identifier: "native-profile-menu-scroll").firstMatch
        func rootIsAdmitted() -> Bool {
            // Returning preserves the roster's scroll position. Its first row
            // need not be on screen (or in the accessibility snapshot).
            close.exists && close.isHittable && menu.exists && menu.isHittable && publicPaneLevel() == 0
        }
        // Profile deliberately resumes its query-owned detail. Its admitted
        // Back must restore the roster; opening Profile is not a root reset.
        for _ in 0..<3 {
            if rootIsAdmitted() { break }
            guard waitForAdmittedControl(back) else { break }
            let sourceBar = app.navigationBars.firstMatch.identifier
            back.tap()
            let returned = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                rootIsAdmitted() || back.exists && back.isHittable &&
                    app.navigationBars.firstMatch.identifier != sourceBar
            }, object: app)
            guard XCTWaiter.wait(for: [returned], timeout: 10) == .completed else {
                XCTFail("PROFILE_BATCH_RESUMED_PARENT_NOT_RESTORED"); return
            }
        }
        guard menu.waitForExistence(timeout: 10) else {
            printCoherentPresentationAdmission(app)
            printNativeControlStatuses(web)
            print("PROFILE_MENU_ENTRY_PROBE close=\(close.exists && close.isHittable) opener=\(opener.exists && opener.isHittable) back=\(back.exists && back.isHittable) row=\(root("account").exists)")
            XCTFail("PROFILE_SHARED_MENU_UNAVAILABLE"); return
        }
        let panel = app.otherElements["native-profile-drawer-body"].firstMatch
        guard panel.waitForExistence(timeout: 5) else { XCTFail("PROFILE_OUTER_FRAME_UNAVAILABLE"); return }
        // Safe areas belong to content, not the full-height mobile panel.
        XCTAssertEqual(panel.frame.minY, app.frame.minY, accuracy: 1, "PROFILE_TOP_FRAME_GAP")
        XCTAssertEqual(panel.frame.maxY, app.frame.maxY, accuracy: 1, "PROFILE_BOTTOM_FRAME_GAP")
        if UIDevice.current.userInterfaceIdiom == .phone {
            XCTAssertEqual(panel.frame.width, app.frame.width, accuracy: 1, "PROFILE_PHONE_FRAME_INSET")
        }
        print("PROFILE_OUTER_FRAME full_height=true phone=\(UIDevice.current.userInterfaceIdiom == .phone)")
        print("PROFILE_BATCH_STEP stage=groups")
        for group in ["settings", "legal", "account-access"] {
            XCTAssertTrue(app.staticTexts["native-profile-group-\(group)"].firstMatch.exists,
                "PROFILE_SHARED_GROUP_MISSING")
        }
        for _ in 0..<5 {
            let account = root("account")
            if account.exists && account.isHittable { break }
            if account.exists && account.frame.midY < menu.frame.minY { menu.swipeDown() }
            else { menu.swipeUp() }
        }
        guard waitForAdmittedControl(root("account")) else { XCTFail("PROFILE_SHARED_ROW_UNAVAILABLE"); return }
        XCTAssertGreaterThanOrEqual(root("account").frame.height, 56)
        XCTAssertEqual(root("account").frame.minX - menu.frame.minX, 16, accuracy: 1)
        XCTAssertEqual(menu.frame.maxX - root("account").frame.maxX, 16, accuracy: 1)
        print("PROFILE_BATCH_STEP stage=root_ready")
        for id in admittedDestinations {
            let destination = root(id)
            for _ in 0..<5 {
                if destination.exists && destination.isHittable { break }
                menu.swipeUp()
            }
            guard waitForAdmittedControl(destination) else { XCTFail("PROFILE_BATCH_DESTINATION_UNAVAILABLE"); return }
            let previousPaneSample = publicPaneGeometry()?.sample ?? 0
            print("PROFILE_BATCH_STEP stage=destination_tap")
            destination.tap()
            if ["hosting", "software-updates"].contains(id), ProcessInfo.processInfo.environment["HUSHH_EXPECT_COHERENT_PROFILE"] == "true" {
                let check = app.buttons[id == "hosting" ? "native-profile-row-hosting-check" : "native-profile-row-updates-check"].firstMatch
                guard waitForAdmittedControl(nativeAccountBack), waitForAdmittedControl(check), waitForAdmittedControl(close) else {
                    XCTFail("PROFILE_NATIVE_AGENT_SETTINGS_NOT_ADMITTED"); return
                }
                XCTAssertEqual(app.webViews.matching(identifier: "native-webview").count, 0, "PROFILE_NATIVE_AGENT_SETTINGS_DUPLICATE_WEB_BODY")
                nativeAccountBack.tap()
                guard waitForAdmittedControl(destination), waitForAdmittedControl(close) else {
                    XCTFail("PROFILE_NATIVE_AGENT_SETTINGS_RETURN_FAILED"); return
                }
                print("PROFILE_NATIVE_DESTINATION family=\(id) native=true returned=true mutated=false")
                continue
            }
            if ["privacy", "terms"].contains(id), app.scrollViews["native-legal-reader-\(id)"].firstMatch.waitForExistence(timeout: 5) {
                print("PROFILE_LEGAL_STEP phase=reader_admitted")
                let reader = app.scrollViews["native-legal-reader-\(id)"].firstMatch
                // This journey enters each document through an authored
                // Profile root row. Require that exact parent, without a
                // DEBUG-only history probe or accepting whichever Back exists.
                let documentBack = nativeAccountBack
                guard waitForAdmittedControl(documentBack), waitForAdmittedControl(close) else {
                    XCTFail("PROFILE_NATIVE_LEGAL_HEADER_UNAVAILABLE"); return
                }
                XCTAssertFalse(app.buttons["Back in Profile"].firstMatch.exists, "PROFILE_LEGAL_DUPLICATE_WEB_HEADER")
                // A remainder run can prove the unverified entry/return states
                // without repeating already recorded contents/switch checks.
                // Its receipt deliberately does not claim those checks.
                if !legalReturnOnly {
                    let contact = app.buttons["native-legal-contents-contact"].firstMatch
                    for _ in 0..<6 {
                        if contact.exists && contact.isHittable { break }
                        // Retained readers may resume below their contents. Do
                        // not reset product scroll or keep pushing further down.
                        if contact.exists && contact.frame.midY < reader.frame.minY {
                            reader.swipeDown()
                        } else {
                            reader.swipeUp()
                        }
                    }
                    guard waitForAdmittedControl(contact) else {
                        let frame = contact.exists ? contact.frame : .zero
                        let viewport = reader.frame
                        if [frame.minY, frame.height, viewport.minY, viewport.height].allSatisfy({ $0.isFinite && abs($0) < 100_000 }) {
                            print("PROFILE_LEGAL_SCROLL target=contents present=\(contact.exists) y=\(Int(frame.minY)) height=\(Int(frame.height)) viewport_y=\(Int(viewport.minY)) viewport_height=\(Int(viewport.height))")
                        }
                        XCTFail("PROFILE_LEGAL_CONTENTS_UNAVAILABLE"); return
                    }
                    print("PROFILE_LEGAL_STEP phase=contents_admitted")
                    contact.tap()
                    print("PROFILE_LEGAL_STEP phase=contents_tapped")
                    let related = app.buttons["native-legal-related"].firstMatch
                    for _ in 0..<3 {
                        if related.exists && related.isHittable { break }
                        reader.swipeUp()
                    }
                    guard waitForAdmittedControl(related) else { XCTFail("PROFILE_LEGAL_RELATED_UNAVAILABLE"); return }
                    related.tap()
                    print("PROFILE_LEGAL_STEP phase=related_tapped")
                    let other = id == "privacy" ? "terms" : "privacy"
                    guard app.scrollViews["native-legal-reader-\(other)"].firstMatch.waitForExistence(timeout: 5),
                          waitForAdmittedControl(documentBack) else { XCTFail("PROFILE_LEGAL_REPLACEMENT_CHANGED_BACK_DEPTH"); return }
                }
                documentBack.tap()
                guard waitForAdmittedControl(destination), waitForAdmittedControl(close) else {
                    XCTFail("PROFILE_LEGAL_ROOT_NOT_RESTORED"); return
                }
                if legalReturnOnly {
                    print("PROFILE_NATIVE_LEGAL_RETURN family=\(id) returned=true")
                } else {
                    print("PROFILE_NATIVE_LEGAL family=\(id) contents=true replaced=true returned=true")
                }
                print("PROFILE_NATIVE_LEGAL_ORIGIN family=\(id) parent=profile")
                continue
            }
            if legalReturnOnly && ["privacy", "terms"].contains(id) {
                XCTFail("PROFILE_NATIVE_LEGAL_READER_NOT_ADMITTED"); return
            }
            if id == "support", app.buttons["native-support-cancel"].firstMatch.waitForExistence(timeout: 5) {
                let cancel = app.buttons["native-support-cancel"].firstMatch
                guard waitForAdmittedControl(cancel), waitForAdmittedControl(app.textViews["native-support-message"].firstMatch) else {
                    XCTFail("PROFILE_BATCH_NATIVE_SUPPORT_UNAVAILABLE"); return
                }
                XCTAssertEqual(app.webViews.matching(identifier: "native-webview").count, 0)
                cancel.tap()
                let returned = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                    !cancel.exists && close.isHittable && destination.isHittable
                }, object: app)
                guard XCTWaiter.wait(for: [returned], timeout: 10) == .completed else { XCTFail("PROFILE_BATCH_NATIVE_SUPPORT_PARENT_NOT_RESTORED"); return }
                print("PROFILE_NATIVE_FORM family=support warm=true submitted=false")
                continue
            }
            if id == "connectors", ProcessInfo.processInfo.environment["HUSHH_EXPECT_COHERENT_PROFILE"] == "true" {
                let search = app.textFields["native-connectors-search"].firstMatch
                let scroll = app.scrollViews["native-profile-menu-scroll"].firstMatch
                func row(_ label: String) -> XCUIElement { app.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch }
                func find(_ label: String) -> Bool {
                    for _ in 0..<12 {
                        if row(label).exists && row(label).isHittable { return true }
                        if scroll.exists { scroll.swipeUp() }
                    }
                    return false
                }
                func filter(_ value: String) -> Bool {
                    for _ in 0..<12 { if search.exists && search.isHittable { break }; if scroll.exists { scroll.swipeDown() } }
                    guard waitForAdmittedControl(search) else { return false }
                    let clear = app.buttons["Clear connectors search"].firstMatch
                    if clear.exists && clear.isHittable { clear.tap() }
                    if !value.isEmpty {
                        guard waitForAdmittedControl(search) else { return false }; search.tap()
                        guard waitForSoftwareKeyboard(app) else { return false }
                        search.typeText(value + "\n")
                    }
                    return true
                }
                guard waitForAdmittedControl(nativeAccountBack), waitForAdmittedControl(search) else { XCTFail("PROFILE_NATIVE_CONNECTORS_NOT_ADMITTED"); return }
                XCTAssertEqual(app.webViews.matching(identifier: "native-webview").count, 0, "PROFILE_NATIVE_CONNECTORS_DUPLICATE_BODY")
                guard filter("Gmail"), find("Gmail") else { XCTFail("PROFILE_NATIVE_CONNECTORS_FILTER_UNAVAILABLE"); return }
                row("Gmail").tap()
                let catalogBack = nativeProfileBack(app, parent: "Connectors")
                guard waitForAdmittedControl(catalogBack) else { XCTFail("PROFILE_NATIVE_CONNECTOR_DETAIL_UNAVAILABLE"); return }
                catalogBack.tap()
                guard filter("Instagram"), find("Instagram") else { XCTFail("PROFILE_NATIVE_CONNECTOR_LINK_UNAVAILABLE"); return }
                row("Instagram").tap()
                guard find("Edit profile link") else { XCTFail("PROFILE_NATIVE_CONNECTOR_LINK_EDITOR_MISSING"); return }
                row("Edit profile link").tap()
                let link = app.textFields["native-connector-link"].firstMatch
                let cancel = app.buttons["native-connector-cancel"].firstMatch
                guard waitForAdmittedControl(link), waitForAdmittedControl(cancel) else { XCTFail("PROFILE_NATIVE_CONNECTOR_LINK_FORM_UNAVAILABLE"); return }
                link.tap()
                guard waitForSoftwareKeyboard(app) else { XCTFail("PROFILE_NATIVE_CONNECTOR_LINK_KEYBOARD_UNAVAILABLE"); return }
                cancel.tap()
                guard waitForAdmittedControl(catalogBack) else { XCTFail("PROFILE_NATIVE_CONNECTOR_LINK_RETURN_FAILED"); return }
                catalogBack.tap()
                guard filter(""), find("Add connector") else { XCTFail("PROFILE_NATIVE_CONNECTOR_SETUP_UNAVAILABLE"); return }
                row("Add connector").tap()
                guard waitForAdmittedControl(app.textFields["native-connector-name"].firstMatch),
                      waitForAdmittedControl(app.textFields["native-connector-endpoint"].firstMatch),
                      app.secureTextFields["native-connector-credential"].firstMatch.exists, waitForAdmittedControl(cancel) else {
                    XCTFail("PROFILE_NATIVE_CONNECTOR_SETUP_FORM_UNAVAILABLE"); return
                }
                cancel.tap()
                guard filter("Google Drive"), find("Google Drive") else { XCTFail("PROFILE_NATIVE_DRIVE_UNAVAILABLE"); return }
                row("Google Drive").tap()
                guard find("Trusted documents") else { XCTFail("PROFILE_NATIVE_DRIVE_TRUST_UNAVAILABLE"); return }
                row("Trusted documents").tap()
                let driveBack = nativeProfileBack(app, parent: "Google Drive")
                guard waitForAdmittedControl(driveBack) else { XCTFail("PROFILE_NATIVE_DRIVE_TRUST_RETURN_UNAVAILABLE"); return }
                driveBack.tap()
                // Compact UIKit Back has the same accessibility label on
                // both pages. Prove the destination body before another Back.
                guard find("Trusted documents"), waitForAdmittedControl(catalogBack) else { XCTFail("PROFILE_NATIVE_DRIVE_RETURN_FAILED"); return }
                catalogBack.tap()
                guard filter(""), waitForAdmittedControl(nativeAccountBack) else { XCTFail("PROFILE_NATIVE_CONNECTOR_CATALOG_RETURN_FAILED"); return }
                nativeAccountBack.tap()
                guard waitForAdmittedControl(destination), waitForAdmittedControl(close) else { XCTFail("PROFILE_NATIVE_CONNECTORS_PROFILE_RETURN_FAILED"); return }
                print("PROFILE_NATIVE_DESTINATION family=connectors warm=true single_host=true")
                print("PROFILE_NATIVE_CONNECTORS catalog=true providers=true link_editor=true custom_editor=true trust=true returned=true mutated=false")
                continue
            }
            if id == "world-model", ProcessInfo.processInfo.environment["HUSHH_EXPECT_COHERENT_PROFILE"] == "true" {
                guard waitForAdmittedControl(nativeAccountBack) else { XCTFail("PROFILE_NATIVE_WORLD_MODEL_NOT_ADMITTED"); return }
                XCTAssertEqual(app.webViews.matching(identifier: "native-webview").count, 0, "PROFILE_NATIVE_WORLD_MODEL_DUPLICATE_WEB_BODY")
                let scroll = app.scrollViews["native-profile-menu-scroll"].firstMatch
                func row(_ label: String) -> XCUIElement {
                    app.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
                }
                func find(_ label: String) -> Bool {
                    for _ in 0..<16 {
                        if row(label).exists && row(label).isHittable { return true }
                        if row("More details").exists && row("More details").isHittable { row("More details").tap() }
                        else if scroll.exists { scroll.swipeUp() }
                    }
                    return false
                }
                guard find("Research and email") else { XCTFail("PROFILE_NATIVE_WORLD_MODEL_RESEARCH_UNAVAILABLE"); return }
                row("Research and email").tap()
                let worldBack = nativeProfileBack(app, parent: "Personal World Model")
                guard waitForAdmittedControl(worldBack), app.switches.count >= 2 else { XCTFail("PROFILE_NATIVE_WORLD_MODEL_RESEARCH_NOT_NATIVE"); return }
                worldBack.tap()
                guard find("Add a public source") else { XCTFail("PROFILE_NATIVE_WORLD_MODEL_SOURCES_UNAVAILABLE"); return }
                row("Add a public source").tap()
                guard waitForAdmittedControl(row("Add public pages")) else { XCTFail("PROFILE_NATIVE_WORLD_MODEL_SOURCE_PARENT_UNAVAILABLE"); return }
                row("Add public pages").tap()
                let urls = app.textViews["native-world-model-urls"].firstMatch
                let cancel = app.buttons["native-world-model-form-cancel"].firstMatch
                guard waitForAdmittedControl(urls), waitForAdmittedControl(cancel) else { XCTFail("PROFILE_NATIVE_WORLD_MODEL_EDITOR_UNAVAILABLE"); return }
                urls.tap()
                guard waitForSoftwareKeyboard(app) else { XCTFail("PROFILE_NATIVE_WORLD_MODEL_KEYBOARD_UNAVAILABLE"); return }
                cancel.tap()
                guard waitForAdmittedControl(worldBack), waitForAdmittedControl(row("Add public pages")) else { XCTFail("PROFILE_NATIVE_WORLD_MODEL_EDITOR_RETURN_FAILED"); return }
                worldBack.tap()
                guard waitForAdmittedControl(nativeAccountBack) else { XCTFail("PROFILE_NATIVE_WORLD_MODEL_PARENT_NOT_RESTORED"); return }
                nativeAccountBack.tap()
                guard waitForAdmittedControl(destination), waitForAdmittedControl(close) else { XCTFail("PROFILE_NATIVE_WORLD_MODEL_ROOT_RETURN_FAILED"); return }
                print("PROFILE_NATIVE_WORLD_MODEL research=true sources=true editor=true returned=true mutated=false")
                continue
            }
            if id == "my-data", ProcessInfo.processInfo.environment["HUSHH_EXPECT_COHERENT_PROFILE"] == "true" {
                let live = app.buttons.matching(NSPredicate(format: "label == %@", "Live memory")).firstMatch
                let sharing = app.buttons.matching(NSPredicate(format: "label == %@", "Manage sharing")).firstMatch
                guard waitForAdmittedControl(nativeAccountBack), waitForAdmittedControl(live), waitForAdmittedControl(sharing) else {
                    XCTFail("PROFILE_NATIVE_MEMORY_NOT_ADMITTED"); return
                }
                XCTAssertEqual(app.webViews.matching(identifier: "native-webview").count, 0,
                    "PROFILE_NATIVE_MEMORY_DUPLICATE_WEB_BODY")
                let search = app.textFields["native-memory-search"].firstMatch
                if search.exists {
                    search.tap()
                    guard waitForSoftwareKeyboard(app) else { XCTFail("PROFILE_NATIVE_MEMORY_KEYBOARD_UNAVAILABLE"); return }
                    search.typeText("Synthetic native query\n")
                    let clear = app.buttons["Clear saved details search"].firstMatch
                    guard waitForAdmittedControl(clear) else { XCTFail("PROFILE_NATIVE_MEMORY_SEARCH_NOT_SUBMITTED"); return }
                    clear.tap()
                }
                guard waitForAdmittedControl(live) else { XCTFail("PROFILE_NATIVE_MEMORY_SEARCH_NOT_SETTLED"); return }
                live.tap()
                let memoryBack = nativeProfileBack(app, parent: "Memory")
                guard waitForAdmittedControl(memoryBack) else { XCTFail("PROFILE_NATIVE_MEMORY_SOURCE_RETURN_UNAVAILABLE"); return }
                memoryBack.tap()
                guard waitForAdmittedControl(sharing) else { XCTFail("PROFILE_NATIVE_MEMORY_ROOT_NOT_RESTORED"); return }
                sharing.tap()
                guard waitForAdmittedControl(memoryBack) else { XCTFail("PROFILE_NATIVE_MEMORY_SHARING_NOT_ADMITTED"); return }
                memoryBack.tap()
                guard waitForAdmittedControl(live), waitForAdmittedControl(nativeAccountBack) else {
                    XCTFail("PROFILE_NATIVE_MEMORY_SHARING_RETURN_FAILED"); return
                }
                // Cover new private sub-pages through their authored entry,
                // without disclosing, copying or mutating reviewer records.
                for label in ["Shared with you", "Drive files shared with you", "Secrets & identity documents"] {
                    let entry = app.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
                    guard waitForAdmittedControl(entry) else { XCTFail("PROFILE_NATIVE_MEMORY_PRIVATE_ENTRY_UNAVAILABLE"); return }
                    entry.tap()
                    guard waitForAdmittedControl(memoryBack) else { XCTFail("PROFILE_NATIVE_MEMORY_PRIVATE_BACK_UNAVAILABLE"); return }
                    XCTAssertEqual(app.webViews.matching(identifier: "native-webview").count, 0, "PROFILE_NATIVE_MEMORY_PRIVATE_BODY_NOT_NATIVE")
                    memoryBack.tap()
                    guard waitForAdmittedControl(live) else { XCTFail("PROFILE_NATIVE_MEMORY_PRIVATE_RETURN_FAILED"); return }
                }
                print("PROFILE_NATIVE_MEMORY_PRIVATE shared=true drive=true secrets=true returned=true mutated=false")
                // A disposable financial record is not invented on the shared
                // reviewer. Exercise the real editor only when its category
                // exists, and record absence separately from editor acceptance.
                let financial = app.buttons.matching(NSPredicate(format: "label IN %@", ["Finance", "Financial"])).firstMatch
                if financial.exists && financial.isHittable {
                    financial.tap()
                    let add = app.buttons.matching(NSPredicate(format: "label == %@", "Add financial context")).firstMatch
                    guard waitForAdmittedControl(add) else { XCTFail("PROFILE_NATIVE_MEMORY_CONTEXT_ENTRY_UNAVAILABLE"); return }
                    add.tap()
                    let text = app.textViews["native-memory-text"].firstMatch
                    let cancel = app.buttons["native-memory-cancel"].firstMatch
                    guard waitForAdmittedControl(text), waitForAdmittedControl(cancel) else { XCTFail("PROFILE_NATIVE_MEMORY_CONTEXT_EDITOR_UNAVAILABLE"); return }
                    text.tap()
                    guard waitForSoftwareKeyboard(app) else { XCTFail("PROFILE_NATIVE_MEMORY_CONTEXT_KEYBOARD_UNAVAILABLE"); return }
                    text.typeText("Synthetic context\nNo record is saved.")
                    cancel.tap()
                    guard waitForAdmittedControl(add), waitForAdmittedControl(memoryBack) else { XCTFail("PROFILE_NATIVE_MEMORY_CONTEXT_RETURN_FAILED"); return }
                    memoryBack.tap()
                    guard waitForAdmittedControl(live), waitForAdmittedControl(nativeAccountBack) else { XCTFail("PROFILE_NATIVE_MEMORY_CONTEXT_ROOT_RETURN_FAILED"); return }
                    print("PROFILE_NATIVE_MEMORY_EDITOR available=true keyboard=true cancelled=true mutated=false")
                } else { print("PROFILE_NATIVE_MEMORY_EDITOR available=false keyboard=false cancelled=false mutated=false") }
                nativeAccountBack.tap()
                guard waitForAdmittedControl(destination), waitForAdmittedControl(close) else {
                    XCTFail("PROFILE_NATIVE_MEMORY_PROFILE_RETURN_FAILED"); return
                }
                print("PROFILE_NATIVE_MEMORY sources=true sharing=true returned=true mutated=false")
                continue
            }
            if id == "payouts", ProcessInfo.processInfo.environment["HUSHH_EXPECT_COHERENT_PROFILE"] == "true" {
                let coins = app.buttons["native-profile-row-payout-coins"].firstMatch
                guard waitForAdmittedControl(nativeAccountBack), waitForAdmittedControl(coins) else {
                    XCTFail("PROFILE_NATIVE_PAYOUTS_NOT_ADMITTED"); return
                }
                XCTAssertEqual(app.webViews.matching(identifier: "native-webview").count, 0,
                    "PROFILE_NATIVE_PAYOUTS_DUPLICATE_WEB_BODY")
                coins.tap()
                let filter = app.buttons["native-profile-row-payout-filter"].firstMatch
                let activityBack = nativeProfileBack(app, parent: "Payouts")
                guard waitForAdmittedControl(filter), waitForAdmittedControl(activityBack),
                      waitForAdmittedControl(app.buttons["native-profile-row-payout-mode"].firstMatch) else {
                    XCTFail("PROFILE_NATIVE_PAYOUT_ACTIVITY_NOT_ADMITTED"); return
                }
                filter.tap()
                let all = app.buttons["All"].firstMatch
                guard waitForAdmittedControl(all) else { XCTFail("PROFILE_NATIVE_PAYOUT_FILTER_MENU_UNAVAILABLE"); return }
                all.tap()
                let filterSelected = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                    (filter.value as? String) == "All"
                }, object: app)
                guard XCTWaiter.wait(for: [filterSelected], timeout: 5) == .completed else {
                    XCTFail("PROFILE_NATIVE_PAYOUT_FILTER_NOT_COMMITTED"); return
                }
                guard waitForAdmittedControl(activityBack) else { XCTFail("PROFILE_NATIVE_PAYOUT_FILTER_NOT_SETTLED"); return }
                activityBack.tap()
                guard waitForAdmittedControl(coins), waitForAdmittedControl(nativeAccountBack) else {
                    XCTFail("PROFILE_NATIVE_PAYOUT_ACTIVITY_RETURN_FAILED"); return
                }
                nativeAccountBack.tap()
                guard waitForAdmittedControl(destination), waitForAdmittedControl(close) else {
                    XCTFail("PROFILE_NATIVE_PAYOUT_ROOT_NOT_RESTORED"); return
                }
                print("PROFILE_NATIVE_PAYOUTS activity=true native_filter=true returned=true mutated=false")
                continue
            }
            if id == "request-pricing", ProcessInfo.processInfo.environment["HUSHH_EXPECT_COHERENT_PROFILE"] == "true" {
                let edit = app.buttons["native-profile-row-request-pricing-edit"].firstMatch
                guard waitForAdmittedControl(nativeAccountBack), waitForAdmittedControl(edit) else {
                    XCTFail("PROFILE_NATIVE_PRICING_NOT_ADMITTED"); return
                }
                XCTAssertEqual(app.webViews.matching(identifier: "native-webview").count, 0,
                    "PROFILE_NATIVE_PRICING_DUPLICATE_WEB_BODY")
                edit.tap()
                let field = app.textFields["native-profile-pricing-editor"].firstMatch
                let cancel = app.buttons["native-profile-pricing-cancel"].firstMatch
                guard waitForAdmittedControl(field), waitForAdmittedControl(cancel) else {
                    XCTFail("PROFILE_NATIVE_PRICING_EDITOR_UNAVAILABLE"); return
                }
                field.tap()
                guard waitForSoftwareKeyboard(app) else { XCTFail("PROFILE_NATIVE_PRICING_KEYBOARD_UNAVAILABLE"); return }
                let existingLength = (field.value as? String)?.utf16.count ?? 0
                guard existingLength <= 32 else { XCTFail("PROFILE_NATIVE_PRICING_VALUE_UNBOUNDED"); return }
                field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existingLength) + "25.50")
                XCTAssertTrue((field.value as? String) == "25.50", "PROFILE_NATIVE_PRICING_EDIT_NOT_RETAINED")
                cancel.tap()
                guard waitForAdmittedControl(nativeAccountBack), waitForAdmittedControl(edit) else {
                    XCTFail("PROFILE_NATIVE_PRICING_EDITOR_NOT_RETIRED"); return
                }
                nativeAccountBack.tap()
                guard waitForAdmittedControl(destination), waitForAdmittedControl(close) else {
                    XCTFail("PROFILE_NATIVE_PRICING_ROOT_NOT_RESTORED"); return
                }
                print("PROFILE_NATIVE_PRICING editor=true keyboard=true returned=true mutated=false")
                continue
            }
            if id == "devices", ProcessInfo.processInfo.environment["HUSHH_EXPECT_COHERENT_PROFILE"] == "true" {
                let refresh = app.buttons["native-profile-row-devices-refresh"].firstMatch
                guard waitForAdmittedControl(nativeAccountBack), waitForAdmittedControl(refresh) else {
                    XCTFail("PROFILE_NATIVE_DEVICES_NOT_ADMITTED"); return
                }
                XCTAssertEqual(app.webViews.matching(identifier: "native-webview").count, 0,
                    "PROFILE_NATIVE_DEVICES_DUPLICATE_WEB_BODY")
                // Read-only reviewer journey. Real unlink outcomes are covered
                // only by explicitly disposable UAT fixture qualification.
                // This roster entry goes directly from Profile to Devices.
                // Do not insert an unvisited Security page on native Back.
                nativeAccountBack.tap()
                guard waitForAdmittedControl(destination), waitForAdmittedControl(close) else {
                    XCTFail("PROFILE_NATIVE_DEVICES_ROOT_NOT_RESTORED"); return
                }
                print("PROFILE_NATIVE_DEVICES list=true returned=true mutated=false")
                continue
            }
            if ["account", "preferences", "security"].contains(id), nativeAccountBack.waitForExistence(timeout: 5) {
                // Account has an owned UIKit destination, not the React
                // content plane used by the remaining rich detail families.
                // Require the actual body and return, not a path receipt.
                let bodyID = ["account": "account-name", "preferences": "preferences-theme", "security": "security-vault"][id]!
                let name = app.buttons["native-profile-row-\(bodyID)"].firstMatch
                guard waitForAdmittedControl(nativeAccountBack), waitForAdmittedControl(name) else {
                    XCTFail("PROFILE_BATCH_NATIVE_ACCOUNT_UNAVAILABLE"); return
                }
                XCTAssertTrue(close.exists && close.isHittable)
                if id == "preferences", ProcessInfo.processInfo.environment["HUSHH_PROFILE_HAPTICS_PROBE"] == "true" {
                    let haptics = app.switches["native-profile-row-preferences-haptics"].firstMatch
                    guard waitForAdmittedControl(haptics), let original = haptics.value as? String,
                          original == "0" || original == "1" else {
                        printCoherentPresentationAdmission(app)
                        XCTFail("PROFILE_HAPTICS_SWITCH_NOT_ADMITTED"); return
                    }
                    // Device-local preference only; restore the initial value.
                    // Exercise the actual pending/result toast rather than a
                    // synthetic overlay or another copy of the Profile scene.
                    for expected in [original == "1" ? "0" : "1", original] {
                        haptics.tap()
                        let settled = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                            haptics.exists && haptics.isHittable && haptics.value as? String == expected &&
                                nativeAccountBack.exists && nativeAccountBack.isHittable && close.exists && close.isHittable
                        }, object: app)
                        guard XCTWaiter.wait(for: [settled], timeout: 12) == .completed else {
                            printCoherentPresentationAdmission(app)
                            print("PROFILE_HAPTICS_STATE switch_present=\(haptics.exists) switch_hittable=\(haptics.exists && haptics.isHittable) back_present=\(nativeAccountBack.exists) close_present=\(close.exists)")
                            XCTFail("PROFILE_HAPTICS_COMPLETION_BROKE_PRESENTATION"); return
                        }
                    }
                    print("PROFILE_HAPTICS_PROBE toggles=2 preference_restored=true")
                }
                if id == "account", !phoneOnly, ProcessInfo.processInfo.environment["HUSHH_EXPECT_COHERENT_PROFILE"] == "true" {
                    for actionID in ["account-reset", "account-delete"] {
                        let action = app.buttons["native-profile-row-\(actionID)"].firstMatch
                        guard waitForAdmittedControl(action) else { XCTFail("PROFILE_NATIVE_ACCOUNT_ACTION_UNAVAILABLE"); return }
                        action.tap()
                        let cancel = app.buttons["native-profile-row-account-confirmation-cancel"].firstMatch
                        let warning = app.descendants(matching: .any).matching(identifier: "native-profile-row-account-confirmation-description").firstMatch
                        guard waitForAdmittedControl(cancel), warning.waitForExistence(timeout: 10) else {
                            XCTFail("PROFILE_NATIVE_ACCOUNT_CONFIRMATION_NOT_ADMITTED"); return
                        }
                        XCTAssertEqual(app.webViews.matching(identifier: "native-webview").count, 0,
                            "PROFILE_NATIVE_ACCOUNT_CONFIRMATION_DUPLICATE_WEB_BODY")
                        // Shared reviewer: exercise only explicit cancellation.
                        // Real reset/deletion belongs to disposable UAT fixtures.
                        if actionID == "account-delete" {
                            close.tap()
                            guard waitForAdmittedControl(opener) else { XCTFail("PROFILE_CONFIRMATION_CLOSE_DID_NOT_RETURN_CHAT"); return }
                            opener.tap()
                            if rootIsAdmitted() {
                                guard waitForAdmittedControl(root("account")) else { XCTFail("PROFILE_CONFIRMATION_REOPEN_ACCOUNT_UNAVAILABLE"); return }
                                root("account").tap()
                            }
                            XCTAssertFalse(cancel.exists && cancel.isHittable,
                                "PROFILE_CLOSE_RESTORED_STALE_ACCOUNT_CONFIRMATION")
                        } else {
                            let accountBack = nativeProfileBack(app, parent: "Your account")
                            guard waitForAdmittedControl(accountBack) else { XCTFail("PROFILE_CONFIRMATION_LOCAL_BACK_UNAVAILABLE"); return }
                            accountBack.tap()
                        }
                        guard waitForAdmittedControl(nativeAccountBack), waitForAdmittedControl(action) else {
                            XCTFail("PROFILE_NATIVE_ACCOUNT_CONFIRMATION_PARENT_NOT_RESTORED"); return
                        }
                    }
                    print("PROFILE_NATIVE_ACCOUNT_CONFIRMATIONS reset_cancelled=true delete_cancelled=true returned=true")
                }
                // A native parent passing Back is not proof of its nested
                // bodies. Exercise the real handoff and return in this batch;
                // the old early-continue skipped precisely these transitions.
                let children: [String] = id == "account" ? ["account-phone"] :
                    id == "preferences" ? (ProcessInfo.processInfo.environment["HUSHH_PROFILE_PROVIDER_ONLY"] == "true" ? ["preferences-gemini"] : ["preferences-gemini", "preferences-voice"]) : ["security-vault"]
                for childID in children {
                    let child = app.buttons["native-profile-row-\(childID)"].firstMatch
                    guard waitForAdmittedControl(child) else { XCTFail("PROFILE_NATIVE_CHILD_UNAVAILABLE"); return }
                    print("PROFILE_BATCH_STEP stage=child_tap")
                    child.tap()
                    if childID == "preferences-gemini", ProcessInfo.processInfo.environment["HUSHH_EXPECT_COHERENT_PROFILE"] == "true" {
                        let ownKey = app.buttons["native-profile-row-runtime-byok"].firstMatch
                        let configure = app.buttons["native-profile-row-runtime-configure"].firstMatch
                        let providerBack = nativeProfileBack(app, parent: "Preferences")
                        guard waitForAdmittedControl(ownKey), waitForAdmittedControl(providerBack) else { XCTFail("PROFILE_NATIVE_PROVIDER_NOT_ADMITTED"); return }
                        XCTAssertEqual(app.webViews.matching(identifier: "native-webview").count, 0, "PROFILE_NATIVE_PROVIDER_DUPLICATE_WEB_BODY")
                        // Choosing an editor changes no saved configuration.
                        // Never validate, save or remove the reviewer's key.
                        if configure.exists { configure.tap() } else { ownKey.tap() }
                        let key = app.secureTextFields["native-runtime-credential"].firstMatch
                        let endpoint = app.segmentedControls["native-runtime-transport"].firstMatch
                        let cancel = app.buttons["native-runtime-cancel"].firstMatch
                        guard waitForAdmittedControl(key), waitForAdmittedControl(endpoint), waitForAdmittedControl(cancel) else { XCTFail("PROFILE_NATIVE_PROVIDER_EDITOR_UNAVAILABLE"); return }
                        key.tap()
                        guard waitForSoftwareKeyboard(app) else { XCTFail("PROFILE_NATIVE_PROVIDER_KEYBOARD_UNAVAILABLE"); return }
                        let vertex = endpoint.buttons["Vertex"].firstMatch
                        guard waitForAdmittedControl(vertex) else { XCTFail("PROFILE_NATIVE_PROVIDER_ENDPOINT_UNAVAILABLE"); return }
                        vertex.tap()
                        let project = app.textFields["native-runtime-project"].firstMatch
                        guard waitForAdmittedControl(project) else { XCTFail("PROFILE_NATIVE_PROVIDER_VERTEX_FIELDS_UNAVAILABLE"); return }
                        cancel.tap()
                        guard waitForAdmittedControl(providerBack), waitForAdmittedControl(ownKey) else { XCTFail("PROFILE_NATIVE_PROVIDER_EDITOR_RETURN_FAILED"); return }
                        providerBack.tap()
                        guard waitForAdmittedControl(nativeAccountBack), waitForAdmittedControl(child) else { XCTFail("PROFILE_NATIVE_PROVIDER_PARENT_NOT_RESTORED"); return }
                        print("PROFILE_NATIVE_PROVIDER editor=true endpoint=true keyboard=true returned=true mutated=false")
                        continue
                    }
                    if childID == "account-phone", ProcessInfo.processInfo.environment["HUSHH_EXPECT_COHERENT_PROFILE"] == "true" {
                        let number = app.textFields["native-phone-number"].firstMatch
                        let country = app.buttons["native-phone-country"].firstMatch
                        let cancel = app.buttons["native-phone-back"].firstMatch
                        guard waitForAdmittedControl(number), waitForAdmittedControl(country), waitForAdmittedControl(cancel) else {
                            XCTFail("PROFILE_NATIVE_PHONE_NOT_ADMITTED"); return
                        }
                        XCTAssertEqual(app.webViews.matching(identifier: "native-webview").count, 0,
                            "PROFILE_NATIVE_PHONE_DUPLICATE_WEB_BODY")
                        country.tap()
                        let countryBack = app.navigationBars.buttons.matching(NSPredicate(format: "label IN %@", ["Change phone number", "Add phone number", "Back"]))
                        guard countryBack.count == 1, waitForAdmittedControl(countryBack.firstMatch) else {
                            XCTFail("PROFILE_NATIVE_PHONE_COUNTRY_RETURN_UNAVAILABLE"); return
                        }
                        countryBack.firstMatch.tap()
                        guard waitForAdmittedControl(number) else { XCTFail("PROFILE_NATIVE_PHONE_ENTRY_NOT_RESTORED"); return }
                        number.tap()
                        guard waitForSoftwareKeyboard(app), waitForAdmittedControl(cancel) else {
                            XCTFail("PROFILE_NATIVE_PHONE_KEYBOARD_UNAVAILABLE"); return
                        }
                        // Shared reviewer: exercise presentation and cancellation
                        // only. Never send SMS or change its verified number.
                        cancel.tap()
                        guard waitForAdmittedControl(nativeAccountBack), waitForAdmittedControl(child) else {
                            XCTFail("PROFILE_NATIVE_PHONE_PARENT_NOT_RESTORED"); return
                        }
                        print("PROFILE_NATIVE_PHONE_CONTINUITY keyboard=true returned=true sent=false")
                        continue
                    }
                    if childID == "security-vault", ProcessInfo.processInfo.environment["HUSHH_EXPECT_COHERENT_PROFILE"] == "true" {
                        let change = app.buttons["native-profile-row-vault-password"].firstMatch
                        let vaultBack = nativeProfileBack(app, parent: "Security & privacy")
                        for _ in 0..<4 {
                            if change.exists && change.isHittable { break }
                            menu.swipeUp()
                        }
                        guard waitForAdmittedControl(change), waitForAdmittedControl(vaultBack) else {
                            XCTFail("PROFILE_NATIVE_VAULT_NOT_ADMITTED"); return
                        }
                        XCTAssertEqual(app.webViews.matching(identifier: "native-webview").count, 0,
                            "PROFILE_NATIVE_VAULT_DUPLICATE_WEB_BODY")
                        change.tap()
                        let password = app.secureTextFields["native-profile-password-editor"].firstMatch
                        let confirmation = app.secureTextFields["native-profile-password-confirmation"].firstMatch
                        let cancel = app.buttons["native-profile-password-cancel"].firstMatch
                        guard waitForAdmittedControl(password), waitForAdmittedControl(confirmation), waitForAdmittedControl(cancel) else {
                            XCTFail("PROFILE_NATIVE_PASSWORD_EDITOR_UNAVAILABLE"); return
                        }
                        XCTAssertFalse(app.buttons["native-profile-password-save"].firstMatch.isEnabled)
                        password.tap()
                        guard waitForSoftwareKeyboard(app) else { XCTFail("PROFILE_NATIVE_PASSWORD_KEYBOARD_UNAVAILABLE"); return }
                        cancel.tap()
                        guard waitForAdmittedControl(change), waitForAdmittedControl(vaultBack) else {
                            XCTFail("PROFILE_NATIVE_PASSWORD_EDITOR_NOT_RETIRED"); return
                        }
                        vaultBack.tap()
                        guard waitForAdmittedControl(nativeAccountBack), waitForAdmittedControl(child) else {
                            XCTFail("PROFILE_NATIVE_VAULT_PARENT_NOT_RESTORED"); return
                        }
                        print("PROFILE_NATIVE_VAULT methods=true protected_editor=true returned=true mutated=false")
                        continue
                    }
                    let nativeMicrophone = app.buttons["native-profile-row-voice-microphone-test"].firstMatch
                    if childID == "preferences-voice", ProcessInfo.processInfo.environment["HUSHH_EXPECT_COHERENT_PROFILE"] == "true" {
                        let voiceBack = nativeProfileBack(app, parent: "Preferences")
                        let speaker = app.switches["native-profile-row-voice-speaker-safe"].firstMatch
                        guard waitForAdmittedControl(voiceBack), waitForAdmittedControl(nativeMicrophone),
                              waitForAdmittedControl(speaker) else { XCTFail("PROFILE_NATIVE_VOICE_NOT_ADMITTED"); return }
                        XCTAssertEqual(app.webViews.matching(identifier: "native-webview").count, 0,
                            "PROFILE_NATIVE_VOICE_DUPLICATE_WEB_BODY")
                        // The microphone check records/sends nothing and changes
                        // no preference on the shared reviewer account.
                        nativeMicrophone.tap()
                        let result = app.descendants(matching: .any).matching(identifier: "native-profile-row-voice-microphone-result").firstMatch
                        let started = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                            !nativeMicrophone.isEnabled || result.exists
                        }, object: app)
                        guard XCTWaiter.wait(for: [started], timeout: 5) == .completed else {
                            XCTFail("PROFILE_NATIVE_MICROPHONE_DID_NOT_START"); return
                        }
                        guard waitForAdmittedControl(nativeMicrophone) else {
                            XCTFail("PROFILE_NATIVE_MICROPHONE_DID_NOT_COMPLETE"); return
                        }
                        // The report follows the settings groups and can be
                        // below the viewport. Inspect it through real scrolling,
                        // not an offscreen AX-existence assumption.
                        for _ in 0..<5 {
                            if result.exists && result.isHittable { break }
                            menu.swipeUp()
                        }
                        guard result.exists && result.isHittable else { XCTFail("PROFILE_NATIVE_MICROPHONE_REPORT_UNAVAILABLE"); return }
                        XCTAssertFalse(result.label.contains("Microphone check couldn’t finish"), "PROFILE_NATIVE_MICROPHONE_FAILED")
                        voiceBack.tap()
                        guard waitForAdmittedControl(nativeAccountBack), waitForAdmittedControl(child) else {
                            XCTFail("PROFILE_NATIVE_VOICE_PARENT_NOT_RESTORED"); return
                        }
                        print("PROFILE_NATIVE_VOICE_CONTINUITY microphone=true switches=true returned=true")
                        continue
                    }
                    let childBack = app.buttons["Back in Profile"].firstMatch
                    guard waitForAdmittedControl(childBack), publicPaneLevel() == 2,
                          waitForAdmittedControl(app.buttons["profile-close"].firstMatch) else {
                        XCTFail("PROFILE_NATIVE_CHILD_HANDOFF_UNAVAILABLE"); return
                    }
                    XCTAssertEqual(app.webViews.matching(identifier: "native-webview").count, 1)
                    XCTAssertFalse(close.exists && close.isHittable, "PROFILE_CHILD_EXPOSED_PARENT_ACTION")
                    childBack.tap()
                    guard waitForAdmittedControl(nativeAccountBack), waitForAdmittedControl(child) else {
                        XCTFail("PROFILE_NATIVE_CHILD_PARENT_NOT_RESTORED"); return
                    }
                    print("PROFILE_NESTED_CONTINUITY family=\(id) child=\(childID) returned=true")
                }
                nativeAccountBack.tap()
                let returned = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                    close.exists && close.isHittable && destination.exists && destination.isHittable
                }, object: app)
                guard XCTWaiter.wait(for: [returned], timeout: 10) == .completed else {
                    XCTFail("PROFILE_BATCH_NATIVE_ACCOUNT_PARENT_NOT_RESTORED"); return
                }
                print("PROFILE_NATIVE_DESTINATION family=\(id) warm=true single_host=true")
                continue
            }
            if id == "invite" {
                // Require the actual native destination. React Copy/Share
                // previously let this test pass the wrong renderer.
                let copy = app.buttons["native-profile-row-referral-copy"].firstMatch
                let share = app.buttons["native-profile-row-referral-share"].firstMatch
                guard waitForAdmittedControl(copy), waitForAdmittedControl(share) else {
                    XCTFail("PROFILE_INVITE_PANE_CONTENT_UNAVAILABLE"); return
                }
                XCTAssertFalse(web.buttons["Copy"].firstMatch.isHittable, "PROFILE_INVITE_WEB_DUPLICATE")
                copy.tap()
                let copied = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in copy.exists && copy.label == "Copied" }, object: app)
                guard XCTWaiter.wait(for: [copied], timeout: 8) == .completed else {
                    XCTFail("PROFILE_INVITE_NATIVE_COPY_NOT_ACKNOWLEDGED"); return
                }
                XCTAssertFalse(app.otherElements["native-route-workspace"].firstMatch.exists,
                               "PROFILE_INVITE_ESCAPED_TO_WORKSPACE")
                guard waitForAdmittedControl(nativeAccountBack), waitForAdmittedControl(close) else {
                    XCTFail("PROFILE_INVITE_PANE_CHROME_UNAVAILABLE"); return
                }
                XCTAssertFalse(app.buttons["Back in Profile"].firstMatch.exists, "PROFILE_INVITE_DUPLICATE_WEB_BACK")
                // Measure this native owner. Modal AX isolation correctly
                // excludes the covered WebView while the native page is open.
                let nativePane = app.otherElements["native-private-drawer"].firstMatch
                let fullPane = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                    guard nativePane.exists else { return false }
                    let frame = nativePane.frame
                    return abs(frame.minY - app.frame.minY) <= 1 && abs(frame.maxY - app.frame.maxY) <= 1 &&
                        (UIDevice.current.userInterfaceIdiom != .phone || abs(frame.width - app.frame.width) <= 1)
                }, object: app)
                guard XCTWaiter.wait(for: [fullPane], timeout: 10) == .completed else {
                    XCTFail("PROFILE_INVITE_PANE_FRAME_UNAVAILABLE"); return
                }
                nativeAccountBack.tap()
                let parent = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                    close.exists && close.isHittable && destination.exists && destination.isHittable && !copy.isHittable
                }, object: app)
                guard XCTWaiter.wait(for: [parent], timeout: 15) == .completed else {
                    XCTFail("PROFILE_INVITE_PANE_PARENT_NOT_RESTORED"); return
                }
                print("PROFILE_NATIVE_DESTINATION family=invite pane=true returned=true warm=true single_host=true")
                continue
            }
                guard admittedBack() else { printCoherentPresentationAdmission(app); XCTFail("PROFILE_BATCH_BACK_UNAVAILABLE"); return }
            let detailClose = app.buttons["profile-close"].firstMatch
            XCTAssertTrue(waitForAdmittedControl(detailClose), "PROFILE_DETAIL_CLOSE_UNAVAILABLE")
            XCTAssertEqual(detailClose.frame.width, 44, accuracy: 1)
            XCTAssertEqual(detailClose.frame.height, 44, accuracy: 1)
            // The real dialog is named by its current title. Do not infer
            // full-pane bounds from a clipped descendant's AX rectangle.
            let detailTitles = ["account": "Account", "preferences": "Appearance & preferences",
                "payouts": "Payouts", "request-pricing": "Request pricing", "my-data": "Memory", "world-model": "Personal World Model",
                "security": "Security & privacy", "devices": "Trusted devices", "connectors": "Connectors",
                "invite": "Invite friends", "support": "Help & feedback", "privacy": "Privacy Policy", "terms": "Terms of Use"]
            let containers = web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", detailTitles[id] ?? "Profile"))
            _ = containers.firstMatch.waitForExistence(timeout: 5)
            var detailFrame: CGRect?
            let fresh = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                guard containers.firstMatch.exists, let pane = publicPaneGeometry(), pane.sample > previousPaneSample,
                      pane.frame.contains(CGPoint(x: detailClose.frame.midX, y: detailClose.frame.midY)),
                      (web.frame.width < 600 || pane.frame.width < web.frame.width - 1) else { return false }
                detailFrame = pane.frame
                return true
            }, object: app)
            guard XCTWaiter.wait(for: [fresh], timeout: 10) == .completed, let detailFrame else {
                print("PROFILE_DETAIL_FRAME_PROBE candidates=\(containers.count) admitted=0")
                printCoherentPresentationAdmission(app)
                XCTFail("PROFILE_DETAIL_FRAME_UNAVAILABLE"); return
            }
            print("PROFILE_DETAIL_PUBLIC_FRAME top=\(Int(detailFrame.minY)) bottom=\(Int(detailFrame.maxY)) expected_top=\(Int(app.frame.minY)) expected_bottom=\(Int(app.frame.maxY))")
            XCTAssertEqual(detailFrame.minY, app.frame.minY, accuracy: 1, "PROFILE_DETAIL_TOP_GAP")
            XCTAssertEqual(detailFrame.maxY, app.frame.maxY, accuracy: 1, "PROFILE_DETAIL_BOTTOM_GAP")
            // Touch isolation is proven by the root's absence below; Back and
            // Close have their own foreground plane, not the covered Chat host.
            XCTAssertFalse(app.buttons["chat-history-toggle"].firstMatch.isHittable)
            // Native menu isolation deliberately removes the covered WebView
            // from AX. Count it while its authored content layer is active,
            // not while the menu owns accessibility.
            XCTAssertEqual(app.webViews.matching(identifier: "native-webview").count, 1)
            // A complex detail is the only active layer. The native root must
            // be withdrawn, not left hit-testable through its content.
            XCTAssertFalse(close.exists && close.isHittable, "PROFILE_BATCH_ROOT_OVERLAPS_DETAIL")
            if id == "security" || id == "preferences" {
                let nestedTitles = id == "security" ? ["Vault methods"] : ["Gemini", "Voice"]
                for title in nestedTitles {
                    let nested = row(title)
                    print("PROFILE_NESTED_ROW kind=\(title == "Vault methods" ? "vault" : title == "Gemini" ? "gemini" : "voice") exists=\(nested.exists) hittable=\(nested.isHittable)")
                    guard waitForAdmittedControl(nested) else { XCTFail("PROFILE_BATCH_SECURITY_ROW_UNAVAILABLE"); return }
                    nested.tap()
                    guard admittedBack() else { XCTFail("PROFILE_BATCH_NESTED_BACK_UNAVAILABLE"); return }
                    back.tap()
                    let parentRestored = waitForAdmittedControl(row(title))
                    if !parentRestored {
                        let kind = title == "Vault methods" ? "vault" : title == "Gemini" ? "gemini" : "voice"
                        let parent = row(title)
                        print("PROFILE_NESTED_RETURN kind=\(kind) level=\(publicPaneLevel() ?? -1) row_present=\(parent.exists) row_hittable=\(parent.exists && parent.isHittable)")
                        printCoherentPresentationAdmission(app)
                    }
                    XCTAssertTrue(parentRestored, "PROFILE_BATCH_QUERY_PARENT_NOT_RESTORED")
                }
            }
            // A returned/direct query entry climbs its authored parents in
            // place (Terms -> Legal -> Profile, Devices -> Security -> Profile).
            // Do not mistake a still-visible staging menu for committed root.
            for _ in 0..<3 {
                guard let previousLevel = publicPaneLevel(), previousLevel > 0,
                      waitForAdmittedControl(back) else { XCTFail("PROFILE_BATCH_PARENT_BOUNDARY_UNAVAILABLE"); return }
                back.tap()
                let returned = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                    guard let level = publicPaneLevel(), level < previousLevel else { return false }
                    return level == 0 ? destination.exists && destination.isHittable && destination.isEnabled :
                        back.exists && back.isHittable && back.isEnabled
                }, object: app)
                guard XCTWaiter.wait(for: [returned], timeout: 10) == .completed else {
                    printCoherentPresentationAdmission(app); XCTFail("PROFILE_BATCH_QUERY_PARENT_NOT_RESTORED"); return
                }
                if publicPaneLevel() == 0 { break }
            }
            XCTAssertEqual(publicPaneLevel(), 0, "PROFILE_BATCH_ROOT_NOT_COMMITTED")
            // Back must restore the originating row and menu scroll position,
            // not force Your account into view after a lower Legal destination.
            XCTAssertTrue(waitForAdmittedControl(destination), "PROFILE_BATCH_MENU_NOT_RESTORED")
            XCTAssertFalse(web.buttons["Unlock"].exists)
            print("PROFILE_RETAINED_DESTINATION family=\(id) warm=true single_host=true")
        }
        XCTAssertTrue(waitForAdmittedControl(close))
        printCoherentPresentationAdmission(app)
        close.tap()
        guard waitForAdmittedControl(editor) else {
            printCoherentPresentationAdmission(app)
            XCTFail("PROFILE_BATCH_CLOSE_DID_NOT_RESTORE_CHAT"); return
        }
        XCTAssertEqual(app.webViews.matching(identifier: "native-webview").count, 1)
        XCTAssertTrue((editor.value as? String) == initialDraft, "PROFILE_BATCH_DRAFT_CHANGED")
        print("PROFILE_STACK_CONTINUITY screens=\(admittedDestinations.count) warm=true single_host=true")
        // A changed-family batch must not rerun already-proven One Profile.
        if requestedStart != nil || requestedEnd != nil { return }
        // WebKit exposes this authored SVG button as an Other AX element on
        // devices. Match its explicit label within the same WebView, not a
        // UIKit-only button role or a coordinate fallback.
        let oneProfiles = web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Open One profile"))
        let oneProfile = oneProfiles.firstMatch
        XCTAssertEqual(oneProfiles.count, 1, "ONE_PROFILE_OPENER_DUPLICATE")
        guard waitForAdmittedControl(oneProfile) else {
            let selector = app.segmentedControls["chat-agent-surface"].firstMatch
            let one = selector.buttons["One, your cloud agent"].firstMatch
            print("PROFILE_ONE_OPENER exists=\(oneProfile.exists) hittable=\(oneProfile.exists && oneProfile.isHittable) one_selected=\(one.exists && one.isSelected) web=\(web.exists) web_hittable=\(web.exists && web.isHittable)")
            printCoherentPresentationAdmission(app)
            XCTFail("ONE_PROFILE_OPENER_UNAVAILABLE"); return
        }
        oneProfile.tap()
        let oneClose = app.buttons["Close One profile"].firstMatch
        guard waitForAdmittedControl(oneClose) else { XCTFail("ONE_NATIVE_PROFILE_UNAVAILABLE"); return }
        let oneTab = web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Profile")).firstMatch
        let feedTab = web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Feed")).firstMatch
        guard waitForAdmittedControl(oneTab), waitForAdmittedControl(feedTab) else { XCTFail("ONE_PROFILE_TABS_UNAVAILABLE"); return }
        oneTab.tap()
        let memory = web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Open Memory")).firstMatch
        // The shared Live Mirror may contain enough source/conflict rows to
        // place its footer below the fold. Exercise the owned content scroll;
        // never replace the person's information with an empty fixture.
        for _ in 0..<8 {
            if memory.exists && memory.isHittable { break }
            let top = max(oneTab.frame.maxY, feedTab.frame.maxY) + 20
            let bottom = web.frame.maxY - 24
            guard bottom > top + 32 else { break }
            let origin = web.coordinate(withNormalizedOffset: .zero)
            origin.withOffset(CGVector(dx: web.frame.width / 2, dy: bottom - web.frame.minY))
                .press(forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: web.frame.width / 2, dy: top - web.frame.minY)))
        }
        print("ONE_PROFILE_MEMORY present=\(memory.exists) hittable=\(memory.exists && memory.isHittable)")
        XCTAssertTrue(waitForAdmittedControl(memory), "ONE_PROFILE_SHARED_CONTENT_UNAVAILABLE")
        XCTAssertTrue(waitForAdmittedControl(app.buttons["Back to Chat"].firstMatch))
        feedTab.tap()
        XCTAssertTrue(waitForAdmittedControl(oneClose))
        oneClose.tap()
        XCTAssertTrue(waitForAdmittedControl(editor))
        XCTAssertEqual(app.webViews.matching(identifier: "native-webview").count, 1)
        XCTAssertTrue((editor.value as? String) == initialDraft, "ONE_PROFILE_DRAFT_CHANGED")
    }

    func testLocalSessionWorkspaceFamiliesKeepDraftAndAuthoritativeSelection() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_LOCAL_SESSION_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in multi-workspace warm navigation regression")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            XCTFail("WORKSPACE_REQUIRES_RUNNING_SESSION"); return
        }
        app.activate()
        dismissRehearsalChatKeyboard(app)
        let hosts = app.webViews.matching(identifier: "native-webview"), web = hosts.firstMatch
        XCTAssertFalse(web.buttons["Unlock"].exists, "Normal vault unlock is required")
        defer { self.returnToRehearsalChat(app) }
        for label in ["Close Profile", "Close chat history", "Close search"] {
            let close = app.buttons[label].firstMatch
            if close.exists && close.isHittable { close.tap() }
        }
        perfTapNav(app, label: "Chat")
        let composer = rehearsalChatComposer(app)
        XCTAssertTrue(composer.waitForExistence(timeout: 15) && composer.isHittable)
        let draft = composer.value as? String
        let hostFrame = web.frame
        func tab(_ name: String) -> XCUIElement { web.buttons.matching(NSPredicate(format: "label == %@", name)).firstMatch }
        func select(_ name: String) {
            let target = tab(name)
            print("WORKSPACE_TAB_ADMISSION target=\(name) exists=\(target.exists) hittable=\(target.exists && target.isHittable)")
            XCTAssertTrue(target.waitForExistence(timeout: 15) && target.isHittable, "WORKSPACE_TAB_UNAVAILABLE")
            target.tap()
            let settled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "selected == true"), object: target)
            XCTAssertEqual(XCTWaiter.wait(for: [settled], timeout: 10), .completed, "WORKSPACE_SELECTION_NOT_SETTLED")
        }
        func openAgent(_ name: String) {
            self.perfTapNav(app, label: "One")
            let entry = web.links["Open \(name)"].firstMatch
            XCTAssertTrue(entry.waitForExistence(timeout: 15), "WORKSPACE_ENTRY_UNAVAILABLE")
            for _ in 0..<4 { if entry.isHittable { break }; web.swipeDown() }
            for _ in 0..<6 { if entry.isHittable { break }; web.swipeUp() }
            XCTAssertTrue(entry.isHittable, "WORKSPACE_ENTRY_NOT_HITTABLE")
            entry.tap()
        }
        func continuity(_ family: String) {
            XCTAssertFalse(web.buttons["Unlock"].exists, "Workspace navigation lost vault admission")
            XCTAssertEqual(hosts.count, 1)
            XCTAssertEqual(web.frame, hostFrame, "Workspace selection moved the Capacitor host")
            self.perfTapNav(app, label: "Chat")
            XCTAssertTrue(composer.waitForExistence(timeout: 15) && composer.isHittable)
            XCTAssertTrue((composer.value as? String) == draft, "Workspace navigation changed the unsent draft")
            print("WORKSPACE_CONTINUITY family=\(family) warm_draft_single_host=true")
        }
        let requestedFamily = ProcessInfo.processInfo.environment["HUSHH_WORKSPACE_FAMILY"]
        let families = ["connect", "finance", "consent", "wallet"]
        if let requestedFamily, !families.contains(requestedFamily) {
            XCTFail("WORKSPACE_FAMILY_UNADMITTED"); return
        }
        for family in families where requestedFamily == nil || requestedFamily == family {
            switch family {
            case "connect":
                perfTapNav(app, label: "Connect")
                select("Circles"); select("Connections")
            case "finance":
                openAgent("Finance")
                let setupQuestion = web.staticTexts["How long will this stay invested?"].firstMatch
                let setupContinue = web.buttons["Continue finance setup"].firstMatch
                let setupIntro = web.staticTexts["Access your finances in one place."].firstMatch
                let destination = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                    tab("Portfolio").exists || setupQuestion.exists || setupContinue.exists || setupIntro.exists
                }, object: web)
                XCTAssertEqual(XCTWaiter.wait(for: [destination], timeout: 15), .completed, "WORKSPACE_FINANCE_DESTINATION_UNOBSERVED")
                let setup = setupQuestion.exists || setupContinue.exists || setupIntro.exists
                print("WORKSPACE_FINANCE_INTRO visible=\(setupIntro.exists)")
                print("WORKSPACE_FINANCE_ADMISSION setup=\(setup) workspace=\(tab("Portfolio").exists)")
                XCTAssertFalse(setup, "WORKSPACE_FINANCE_SETUP_REQUIRED")
                select("Portfolio"); select("Analysis"); select("Market")
            case "consent":
                openAgent("Consent")
                select("Active"); select("History"); select("Connections"); select("Requests")
            default:
                openAgent("Wallet")
                func walletPaneReady(_ isVisible: @escaping () -> Bool, failure: String,
                                     diagnoseFailure: (() -> Void)? = nil) -> Bool {
                    let visible = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                        isVisible()
                    }, object: web)
                    guard XCTWaiter.wait(for: [visible], timeout: 10) == .completed else {
                        diagnoseFailure?()
                        XCTFail(failure); return false
                    }
                    return true
                }
                let introduction = web.buttons["Continue"].firstMatch
                func diagnoseWalletTabs() {
                    let cards = tab("Cards"), frame = cards.exists ? cards.frame : .zero
                    print("WALLET_TAB_DIAG exists=\(cards.exists) enabled=\(cards.exists && cards.isEnabled) hittable=\(cards.exists && cards.isHittable) x=\(Int(frame.minX)) y=\(Int(frame.minY)) width=\(Int(frame.width)) height=\(Int(frame.height))")
                }
                let admission = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                    (tab("Cards").exists && tab("Cards").isEnabled && tab("Cards").isHittable) ||
                    (introduction.exists && introduction.isEnabled && introduction.isHittable)
                }, object: web)
                guard XCTWaiter.wait(for: [admission], timeout: 15) == .completed else {
                    diagnoseWalletTabs()
                    XCTFail("WORKSPACE_WALLET_ADMISSION_UNOBSERVED"); return
                }
                if !tab("Cards").exists {
                    // Cosmetic owner-local introduction only; no card or grant operation.
                    introduction.tap()
                }
                let cardsReady = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                    tab("Cards").exists && tab("Cards").isEnabled && tab("Cards").isHittable
                }, object: web)
                guard XCTWaiter.wait(for: [cardsReady], timeout: 15) == .completed else {
                    diagnoseWalletTabs()
                    XCTFail("WORKSPACE_WALLET_NOT_READY"); return
                }
                guard tab("Cards").isSelected else {
                    // Do not erase or route around an owner's staged add/reveal handoff.
                    XCTFail("WORKSPACE_WALLET_UNEXPECTED_HANDOFF"); return
                }
                select("Cards"); select("Add")
                let addHeading = web.staticTexts["Add your card"].firstMatch
                guard walletPaneReady({ addHeading.exists && addHeading.isHittable },
                                      failure: "WORKSPACE_WALLET_ADD_BODY_UNOBSERVED") else { return }
                select("Sharing")
                let sharingHeading = web.staticTexts.matching(NSPredicate(format:
                    "label CONTAINS %@ AND label CONTAINS %@", "Your cards.", "Your control.")).firstMatch
                // WKWebView may expose a <br>-separated heading as two static texts.
                // Either representation must prove the complete, hittable public body.
                let sharingFirst = web.staticTexts["Your cards."].firstMatch
                let sharingSecond = web.staticTexts["Your control."].firstMatch
                let sharingExplanation = web.staticTexts["You choose who can access your Wallet information."].firstMatch
                let sharingAnchors: [(String, XCUIElement)] = [
                    ("combined", sharingHeading), ("first", sharingFirst),
                    ("second", sharingSecond), ("explanation", sharingExplanation),
                ]
                guard walletPaneReady({
                    let completeHeading = (sharingHeading.exists && sharingHeading.isHittable) ||
                        (sharingFirst.exists && sharingFirst.isHittable && sharingSecond.exists && sharingSecond.isHittable)
                    return completeHeading && sharingExplanation.exists && sharingExplanation.isHittable
                }, failure: "WORKSPACE_WALLET_SHARING_BODY_UNOBSERVED", diagnoseFailure: {
                    // Only authored public anchors; never enumerate card or recipient content.
                    for (name, anchor) in sharingAnchors {
                        print("WORKSPACE_WALLET_PUBLIC_ANCHOR anchor=\(name) exists=\(anchor.exists) hittable=\(anchor.exists && anchor.isHittable)")
                    }
                }) else { return }
                select("Cards")
                let cardsActions = ["All cards", "Add a payment card", "Add another card"].map { web.buttons[$0].firstMatch }
                for _ in 0..<4 {
                    if cardsActions.contains(where: { $0.exists && $0.isHittable }) { break }
                    web.swipeUp()
                }
                guard walletPaneReady({ cardsActions.contains(where: { $0.exists && $0.isHittable }) },
                                      failure: "WORKSPACE_WALLET_CARDS_BODY_UNOBSERVED") else { return }
                XCTAssertFalse(addHeading.exists && addHeading.isHittable,
                               "WORKSPACE_WALLET_INACTIVE_ADD_HITTABLE")
                let back = app.buttons.matching(NSPredicate(format: "label == %@", "Go back")).firstMatch
                XCTAssertTrue(back.waitForExistence(timeout: 10) && back.isHittable, "WORKSPACE_BACK_UNAVAILABLE")
                back.tap()
                XCTAssertTrue(web.links["Open Wallet"].waitForExistence(timeout: 15), "WORKSPACE_BACK_DID_NOT_RETURN_TO_ONE")
            }
            continuity(family)
        }
    }

    func testLocalSessionMemorySwipeStopsOnAdd() throws {
        guard ProcessInfo.processInfo.environment["HUSHH_RUN_LOCAL_SESSION_SMOKE"] == "true" else {
            throw XCTSkip("Opt-in live-session check; requires an existing signed-in account")
        }
        let app = XCUIApplication()
        guard [.runningForeground, .runningBackground, .runningBackgroundSuspended].contains(app.state) else {
            XCTFail("MEMORY_REQUIRES_RUNNING_SESSION"); return
        }
        app.activate()
        dismissRehearsalChatKeyboard(app)
        let hosts = app.webViews.matching(identifier: "native-webview"), webView = hosts.firstMatch
        XCTAssertTrue(webView.waitForExistence(timeout: 15), "Local app WebView did not load")
        XCTAssertFalse(webView.buttons["Unlock"].exists, "Normal vault unlock is required")
        defer { self.returnToRehearsalChat(app) }
        for label in ["Close Profile", "Close chat history", "Close search"] {
            let close = app.buttons[label].firstMatch
            if close.exists && close.isHittable { close.tap() }
        }
        perfTapNav(app, label: "One")
        let memory = webView.links["Open Memory"].firstMatch
        XCTAssertTrue(memory.waitForExistence(timeout: 15), "MEMORY_ENTRY_UNAVAILABLE")
        for _ in 0..<5 {
            if memory.isHittable { break }
            webView.swipeUp()
        }
        XCTAssertTrue(memory.isHittable, "MEMORY_ENTRY_NOT_HITTABLE")
        memory.tap()
        let saved = webView.buttons["Saved"]
        let add = webView.buttons["Add"]
        let sharing = webView.buttons["Sharing"]
        XCTAssertTrue(saved.waitForExistence(timeout: 15), "MEMORY_WORKSPACE_UNAVAILABLE")
        saved.tap()
        XCTAssertTrue(add.exists && sharing.exists, "Memory tabs are incomplete")

        func swipeLeft() -> Bool {
            // Start in the authored gap following the active pane's field,
            // not over an arbitrary viewport fraction that can land on a
            // saved-memory row or the Add textarea as content changes.
            let label = add.isSelected ? "Memory note" : "Search Memory"
            let anchor = webView.descendants(matching: .any).matching(NSPredicate(
                format: "label == %@", label)).firstMatch
            guard anchor.waitForExistence(timeout: 10) && anchor.isHittable else {
                XCTFail("MEMORY_SWIPE_ANCHOR_UNAVAILABLE"); return false
            }
            // The shared pager deliberately yields to fields and row actions.
            // Diagnose the actual start point without exposing Memory labels,
            // values or its accessibility tree. Viewport fractions alone are
            // not admission evidence for a changing, owner-specific list.
            let point = CGPoint(x: webView.frame.minX + webView.frame.width * 0.82,
                                y: anchor.frame.maxY + 8)
            let guardedTypes: [XCUIElement.ElementType] = [.button, .textField, .secureTextField,
                .textView, .searchField, .link, .slider, .switch]
            let blocked = guardedTypes.contains { type in
                webView.descendants(matching: type).allElementsBoundByIndex.contains { element in
                    element.exists && element.isHittable && element.frame.contains(point)
                }
            }
            print("MEMORY_SWIPE_ADMISSION guarded_start=\(blocked) saved=\(saved.isSelected) add=\(add.isSelected) sharing=\(sharing.isSelected)")
            guard webView.frame.contains(point) && !blocked else {
                XCTFail("MEMORY_SWIPE_START_NOT_ADMITTED"); return false
            }
            let origin = app.coordinate(withNormalizedOffset: .zero)
            let start = origin.withOffset(CGVector(dx: point.x - app.frame.minX, dy: point.y - app.frame.minY))
            let end = origin.withOffset(CGVector(dx: webView.frame.minX + webView.frame.width * 0.18 - app.frame.minX,
                                                dy: point.y - app.frame.minY))
            start.press(forDuration: 0.06, thenDragTo: end, withVelocity: XCUIGestureVelocity(rawValue: 400), thenHoldForDuration: 0)
            return true
        }
        func waitForSelected(_ tab: XCUIElement) -> Bool {
            let deadline = Date().addingTimeInterval(12)
            while Date() < deadline {
                if tab.isSelected { return true }
                RunLoop.current.run(until: Date().addingTimeInterval(0.25))
            }
            return tab.isSelected
        }

        guard swipeLeft() else { return }
        let added = waitForSelected(add)
        print("MEMORY_SWIPE_SELECTION saved=\(saved.isSelected) add=\(add.isSelected) sharing=\(sharing.isSelected)")
        XCTAssertTrue(added, "One Memory swipe must land on Add")
        XCTAssertFalse(sharing.isSelected, "The first swipe must not skip Add")
        guard swipeLeft() else { return }
        XCTAssertTrue(waitForSelected(sharing), "The next Memory swipe must land on Sharing")
        // Keep the interruption test immediate. Selected state is not proof
        // that the compositor has settled or the original tab is reachable.
        print("MEMORY_RETURN_ADMISSION hittable=\(saved.exists && saved.isHittable)")
        XCTAssertTrue(saved.exists && saved.isHittable, "MEMORY_RETURN_TAB_NOT_HITTABLE")
        saved.tap()
        let returned = waitForSelected(saved)
        print("MEMORY_RETURN_SELECTION saved=\(saved.isSelected) add=\(add.isSelected) sharing=\(sharing.isSelected)")
        XCTAssertTrue(returned, "Memory tap must settle on the same pane as its swipe")
        XCTAssertFalse(webView.buttons["Unlock"].exists, "Memory paging lost the unlocked session")
        XCTAssertEqual(hosts.count, 1)
        print("MEMORY_PAGER_CONTINUITY saved_add_sharing_warm_single_host")
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
        XCTAssertFalse(app.secureTextFields["Enter your password"].exists)
        XCUIDevice.shared.press(.home)
        let resumeDeadline = Date().addingTimeInterval(30)
        app.activate()
        _ = try waitForSatisfiedStatus(
            app, route: route, timeout: max(0, resumeDeadline.timeIntervalSinceNow)
        )
        // The route marker can survive while the native privacy cover and
        // asynchronous auth restoration are still settling after activation.
        // Require the actual login control to become usable within a bound.
        let loginButton = app.buttons["Continue with Apple"]
        // The title changes on recovery failure; require the actual shield to
        // disappear and login to be usable together within the same warm budget.
        let privacyCover = app.descendants(matching: .any)
            .matching(identifier: "session-privacy-shield").firstMatch
        while Date() < resumeDeadline,
              privacyCover.exists || !(loginButton.exists && loginButton.isHittable) {
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        XCTAssertTrue(
            !privacyCover.exists && loginButton.exists && loginButton.isHittable
                && Date() <= resumeDeadline,
            "Login must become usable after the native privacy cover releases"
        )
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
            app.launchEnvironment["HUSHH_UI_TEST_REVIEWER_UID"] = reviewerUid
        }
        if let vaultPassphrase = environment["HUSHH_UI_TEST_REVIEWER_VAULT_PASSPHRASE"] ?? environment["REVIEWER_VAULT_PASSPHRASE"],
           !vaultPassphrase.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            app.launchEnvironment["HUSHH_UI_TEST_REVIEWER_VAULT_PASSPHRASE"] = vaultPassphrase
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
            "Not now, continue with password",
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
        // XCTest equality failures print both operands. Compare in memory and
        // expose only the Boolean result, never the reviewer credential.
        XCTAssertTrue(primary == canonical, "Forwarded reviewer vault passphrase differs from canonical reviewer configuration")
        if !primary.isEmpty, primary == canonical {
            print("native-ui-reviewer-passphrase-match true")
        }
    }

    private func replaceText(in field: XCUIElement, with value: String) {
        field.tap()
        field.typeKey("a", modifierFlags: .command)
        field.typeText(value)
    }

    /// A hittable WebKit field does not establish keyboard admission. On the
    /// phone wait for the real onscreen keyboard; a tablet hardware keyboard
    /// remains valid. Clear in one normal editing operation, then acknowledge
    /// both the empty field and React's disabled Unlock before whole-value entry.
    private func prepareEmptySecureEntry(_ field: XCUIElement, app: XCUIApplication,
                                         unlockControls: XCUIElementQuery) -> Bool {
        guard field.exists, field.isHittable,
              !app.otherElements["session-privacy-shield"].exists else {
            print("VAULT_ENTRY_ADMISSION stage=authored_field_unavailable"); return false
        }
        field.tap()
        guard UIDevice.current.userInterfaceIdiom != .phone || waitForSoftwareKeyboard(app) else {
            print("VAULT_ENTRY_ADMISSION stage=keyboard_unavailable"); return false
        }
        let existing = field.value as? String ?? ""
        if !existing.isEmpty && existing != field.placeholderValue {
            // Secure fields do not reliably expose Select All, especially
            // after XCTest switches to the symbols keyboard. Use normal
            // deletion instead, never a value setter or authentication hook.
            let deletes = [app.keyboards.keys["delete"], app.keyboards.keys["Delete"],
                           app.keyboards.buttons["delete"], app.keyboards.buttons["Delete"]]
            if let delete = deletes.first(where: { $0.exists && $0.isHittable }) {
                field.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
                delete.press(forDuration: 2)
            } else {
                field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.utf16.count))
            }
        }
        let cleared = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            guard let value = field.value as? String else { return false }
            return (value.isEmpty || value == field.placeholderValue) &&
                unlockControls.count == 1 && !unlockControls.firstMatch.isEnabled
        }, object: field)
        guard XCTWaiter.wait(for: [cleared], timeout: 3) == .completed else {
            print("VAULT_ENTRY_ADMISSION stage=empty_acknowledgement_timeout"); return false
        }
        return true
    }

    /// Explicit physical-run alternative to typeText, characterized with public
    /// mixed input. Stay on the named secure field and visible reviewer; never
    /// reveal entry, bootstrap authentication, or retry an unacknowledged key.
    private func enterSecureValueWithSoftwareKeyboard(_ value: String, field: XCUIElement, app: XCUIApplication) -> Bool {
        let email = ProcessInfo.processInfo.environment["HUSHH_UI_TEST_REVIEWER_EMAIL"] ?? ""
        guard !email.isEmpty else { return false }
        var expectedLength = 0
        for character in value {
            guard field.exists, field.isHittable, field.elementType == .secureTextField,
                  app.webViews.staticTexts.matching(NSPredicate(format: "label == %@", email)).firstMatch.exists else { return false }
            let literal = String(character)
            let keyNames = literal == "#" ? ["#", "number sign", "Number sign", "hash", "Hash", "pound", "Pound", "pound sign"] : [literal]
            let aliases = character.isLetter ? ["letters", "ABC", "shift", "Shift"] :
                character.isNumber ? ["numbers", "123", "more"] : ["symbols", "#+=", "numbers", "123", "more"]
            var inserted = false
            for _ in 0..<3 {
                let key = app.keyboards.keys.matching(NSPredicate(format: "label IN %@ OR identifier IN %@", keyNames, keyNames)).firstMatch
                if key.exists && key.isHittable { key.tap(); inserted = true; break }
                let choices = aliases.flatMap { [app.keyboards.keys[$0].firstMatch, app.keyboards.buttons[$0].firstMatch] }
                guard let change = choices.first(where: { $0.exists && $0.isHittable }) else { break }
                change.tap()
            }
            guard inserted else { return false }
            expectedLength += literal.utf16.count
            let count = expectedLength
            let receipt = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                (field.value as? String)?.utf16.count == count
            }, object: field)
            guard XCTWaiter.wait(for: [receipt], timeout: 3) == .completed else { return false }
        }
        return true
    }

    @discardableResult
    private func attemptVaultPassphraseUnlock(app: XCUIApplication) -> Bool {
        guard !vaultUnlockSubmitted else {
            return false
        }
        // UIKit's modal privacy cover can leave underlying WebKit elements
        // reported as hittable. Never target a credential through that cover.
        let privacyCover = app.otherElements["session-privacy-shield"].firstMatch
        let uncovered = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: privacyCover)
        guard XCTWaiter.wait(for: [uncovered], timeout: 15) == .completed else {
            print("VAULT_METHOD_ADMISSION stage=privacy_covered"); return false
        }
        let vaultCreationControls = [
            app.buttons["Create Vault"],
            app.buttons["I've Saved My Recovery Key"],
        ]
        if vaultCreationControls.contains(where: { $0.exists }) {
            return false
        }

        let unlockControls = app.buttons.matching(NSPredicate(
            format: "label IN %@", ["Unlock", "Unlock with passphrase", "Unlock with password"]
        ))
        let hosts = app.webViews.matching(identifier: "native-webview")
        guard hosts.count == 1 else {
            print("VAULT_ENTRY_ADMISSION stage=authored_field_unavailable"); return false
        }
        let owningWebView = hosts.firstMatch
        let fieldQueries: [XCUIElementQuery] = [
            owningWebView.secureTextFields,
            owningWebView.textFields,
        ]
        let authoredField = authoredVaultPassphraseField
        let hasAuthoredField = {
            fieldQueries.contains { $0.matching(authoredField).firstMatch.exists }
        }
        // A device-first vault has no text field until its authored fallback
        // is chosen. Existing passphrase entry must not trigger another choice.
        if !hasAuthoredField() {
            let methods = hosts.firstMatch.buttons.matching(NSPredicate(
                format: "label IN %@", ["Password", "Use password instead", "Passphrase", "Use passphrase instead", "Vault Key"]
            ))
            guard hosts.count == 1, methods.count == 1, methods.firstMatch.isEnabled,
                  methods.firstMatch.isHittable else {
                print("VAULT_METHOD_ADMISSION stage=method_unavailable"); return false
            }
            methods.firstMatch.tap()
            print("VAULT_METHOD_ADMISSION stage=tap_dispatched")
        }
        let fieldExists = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in hasAuthoredField() }, object: app)
        guard XCTWaiter.wait(for: [fieldExists], timeout: 5) == .completed else {
            print("VAULT_METHOD_ADMISSION stage=field_absent"); return false
        }
        // Keep WebKit's text/secure-role compatibility, but distinguish a
        // missing field from an existing field obstructed by presentation.
        let fieldReady = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            fieldQueries.contains { query in
                let field = query.matching(authoredField).firstMatch
                return field.exists && field.isHittable
            }
        }, object: app)
        guard XCTWaiter.wait(for: [fieldReady], timeout: 5) == .completed else {
            print("VAULT_METHOD_ADMISSION stage=field_obstructed")
            print("VAULT_ENTRY_ADMISSION stage=authored_field_unavailable")
            return false
        }
        let passphrase = reviewerVaultPassphrase()
        let reviewerEmail = ProcessInfo.processInfo.environment["HUSHH_UI_TEST_REVIEWER_EMAIL"] ?? ""
        let reviewerLabel = NSPredicate(format: "label == %@", reviewerEmail)
        let privateEntryAdmitted = { (field: XCUIElement) -> Bool in
            let account = owningWebView.staticTexts.matching(reviewerLabel).firstMatch
            print("VAULT_ENTRY_FENCE owner_present=\(account.exists) owner_hittable=\(account.exists && account.isHittable) single_host=\(hosts.count == 1) field_hittable=\(field.exists && field.isHittable) privacy_cover=\(privacyCover.exists)")
            return !reviewerEmail.isEmpty && hosts.count == 1 &&
                field.exists && field.isHittable && !privacyCover.exists && account.exists && account.isHittable
        }
        let softwareKeyEntry = ProcessInfo.processInfo.environment["HUSHH_UI_TEST_SOFTWARE_KEY_ENTRY"] == "true"

        for query in fieldQueries {
            // Resolve the authored field, not an index that can change as
            // WebKit exposes keyboard and text-editing descendants. A lone,
            // unrelated text field is never a credential target.
            let field = query.matching(authoredField).firstMatch
            guard field.exists, field.isHittable else { continue }
            print("VAULT_ENTRY_ADMISSION stage=authored_field_ready")
            guard prepareEmptySecureEntry(field, app: app, unlockControls: unlockControls) else {
                XCTFail("Vault secure entry preparation was not acknowledged; unlock was not submitted")
                return false
            }
            // iPad can retain a hardware keyboard. Only the explicit visible-
            // key rehearsal also requires individual software keys there.
            guard !softwareKeyEntry || app.keyboards.firstMatch.waitForExistence(timeout: 5) else {
                print("VAULT_ENTRY_ADMISSION stage=keyboard_unavailable")
                return false
            }
            let entryLength = { () -> Int? in
                guard let value = field.value as? String else { return nil }
                return value == field.placeholderValue ? 0 : value.utf16.count
            }
            // Whole-value entry is the default. An explicit physical run can
            // use the publicly characterized software-key path instead; never
            // switch modes after failure or replay a partial credential.
            guard privateEntryAdmitted(field) else {
                print("VAULT_ENTRY_ADMISSION stage=reviewer_unavailable"); return false
            }
            print("VAULT_ENTRY_MODE mode=\(softwareKeyEntry ? "software_keys" : "whole_value")")
            if softwareKeyEntry {
                guard enterSecureValueWithSoftwareKeyboard(passphrase, field: field, app: app) else {
                    XCTFail("Vault software-key entry was not acknowledged; unlock was not submitted")
                    return false
                }
            } else {
                field.typeText(passphrase)
            }
            let inserted = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                entryLength() == passphrase.utf16.count
            }, object: field)
            guard XCTWaiter.wait(for: [inserted], timeout: 3) == .completed else {
                XCTFail("Vault secure entry insertion was not acknowledged; unlock was not submitted")
                return false
            }
            // Submit once through the normal cryptographic unlock, then
            // require protected content and absence of the gate in the caller.
            // Never bootstrap or retry a rejected credential to pass a test.
            print("VAULT_ENTRY_MASK length_matched=true")
            let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                unlockControls.count == 1 && unlockControls.firstMatch.isEnabled && unlockControls.firstMatch.isHittable
            }, object: app)
            guard XCTWaiter.wait(for: [ready], timeout: 5) == .completed,
                  unlockControls.count == 1,
                  unlockControls.firstMatch.isEnabled,
                  unlockControls.firstMatch.isHittable, privateEntryAdmitted(field) else {
                print("VAULT_SUBMISSION_RECEIPT stage=readiness_timeout_no_tap")
                XCTFail("Vault Unlock readiness was not acknowledged; unlock was not submitted")
                return false
            }
            print("VAULT_SUBMISSION_RECEIPT stage=ready")
            vaultUnlockSubmitted = true
            unlockControls.firstMatch.tap()
            print("VAULT_SUBMISSION_RECEIPT stage=tap_dispatched")
            return true
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
            app.launchEnvironment["HUSHH_UI_TEST_REVIEWER_UID"] = reviewerUid
        }
        if let vaultPassphrase = environment["HUSHH_UI_TEST_REVIEWER_VAULT_PASSPHRASE"] ?? environment["REVIEWER_VAULT_PASSPHRASE"],
           !vaultPassphrase.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            app.launchEnvironment["HUSHH_UI_TEST_REVIEWER_VAULT_PASSPHRASE"] = vaultPassphrase
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

        perfTapNav(app, label: "Chat")
        perfSettle(2.5)
        if !perfChatExchange(app, streamSeconds: 30) {
            NSLog("PERF_SKIPPED name=chat-stream-30s reason=composer_not_found")
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

    /// The truth lane: the same gesture card with test mode off. Each surface
    /// is its own launch with only the probe argument and a route argument the
    /// probe honours (`-CapacitorStorage.hushh_perf_route`), so there is no
    /// reviewer bridge and no native status poll. The vault is unlocked with
    /// the passphrase from the process environment (never Face ID); if none
    /// is configured the test waits for the person holding the phone. On a
    /// Release build this is the certifying run the charter names.
    /// Opt-in: HUSHH_ENABLE_PERF_ATTACHED=true. HUSHH_PERF_ATTACHED_SECTION
    /// = feed | chat | kai | location | all (default all).
    /// Signs the reviewer into the app's data container and leaves the
    /// session there (-UITestResetAppState false). The Release truth lane
    /// cannot sign anyone in, by design, so after a sign-out (a /logout
    /// route, an expired session) this Debug-only step restores it and the
    /// Release app installed over it keeps the session.
    /// Driver: scripts/perf/ios-reviewer-signin.sh.
    func testReviewerSignInForTruthLane() throws {
        let route = RouteCase(
            name: "truth-lane-sign-in",
            initialRoute: "/login?redirect=%2Fone%2Ffeed",
            expectedMarker: "native-route-feed",
            expectedRoute: "/one/feed",
            expectedRoutePrefix: nil,
            autoReviewerLogin: true,
            expectedAuth: "authenticated",
            allowedDataStates: ["loaded"]
        )
        let app = launchApp(route)
        defer { app.terminate() }
        _ = try waitForSatisfiedStatus(app, route: route, timeout: 150)
        NSLog("PERF_REVIEWER_SIGNED_IN route=/one/feed")
    }

    func testRenderPerformanceCardAttached() throws {
        let environment = ProcessInfo.processInfo.environment
        let section = environment["HUSHH_PERF_ATTACHED_SECTION"] ?? "all"
        let plaidSandboxProof = section == "plaid" || section == "plaid-vault"
        guard environment["HUSHH_ENABLE_PERF_ATTACHED"] == "true" else {
            if plaidSandboxProof {
                XCTFail("Plaid proof requires HUSHH_ENABLE_PERF_ATTACHED=true.")
                throw NSError(domain: "AppUITests", code: 1)
            }
            throw XCTSkip("Attached render performance card runs only with HUSHH_ENABLE_PERF_ATTACHED=true.")
        }
        let repetitions = max(1, Int(environment["HUSHH_PERF_REPS"] ?? "") ?? 3)
        if plaidSandboxProof {
            guard environment["HUSHH_PLAID_SANDBOX_PROOF"] == "true" else {
                XCTFail("Plaid proof requires the explicit local sandbox guard.")
                throw NSError(domain: "AppUITests", code: 2)
            }
            #if targetEnvironment(simulator)
            #else
            XCTFail("Plaid proof is restricted to the local iOS Simulator.")
            throw NSError(domain: "AppUITests", code: 3)
            #endif
        }
        let passphrase = (environment["HUSHH_UI_TEST_REVIEWER_VAULT_PASSPHRASE"] ?? environment["REVIEWER_VAULT_PASSPHRASE"] ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
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

        func launchAttached(route: String?, shellOptional: Bool = false, failHard: Bool = true, unlockTimeout: TimeInterval = 240) throws -> (XCUIApplication, XCUIElement) {
            let app = XCUIApplication()
            var arguments = ["-CapacitorStorage.hushh_perf_probe", "1"]
            if plaidSandboxProof {
                // NSArgumentDomain supplies this to Capacitor Preferences for
                // this launch only. The WebView also requires its compiled
                // local-proof marker before it will request a Link token.
                arguments += ["-CapacitorStorage.hushh_plaid_sandbox_proof", "1"]
            }
            if let route {
                arguments += ["-CapacitorStorage.hushh_perf_route", route]
            }
            // An attribution experiment for this launch (the probe applies
            // it and names it in the export; such a run never certifies).
            if let experiment = ProcessInfo.processInfo.environment["HUSHH_PERF_EXPERIMENT"],
               !experiment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                arguments += ["-CapacitorStorage.hushh_perf_experiment", experiment]
                NSLog("PERF_EXPERIMENT \(experiment)")
            }
            app.launchArguments = arguments
            app.launch()
            let webView = app.webViews.firstMatch
            XCTAssertTrue(webView.waitForExistence(timeout: 30), "WebView unavailable")
            try perfUnlockVault(app, passphrase: passphrase, timeout: unlockTimeout, shellOptional: shellOptional, failHard: failHard)
            return (app, webView)
        }

        if section == "all" || section == "feed" {
            let (app, webView) = try launchAttached(route: "/one/feed")
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
            app.terminate()
        }

        if section == "all" || section == "chat" {
            let (app, _) = try launchAttached(route: "/")
            perfSettle(3)
            NSLog("PERF_APP_READY route=/")
            if !perfChatExchange(app, streamSeconds: 30) {
                NSLog("PERF_SKIPPED name=chat-stream-30s reason=composer_not_found")
            }
            perfSettle(12)
            NSLog("PERF_DONE route=/")
            app.terminate()
        }

        // The MCP connections panel (a right-side sheet off the chat history
        // drawer): open it, hold it for a capture, and read where its title
        // and close control sit against the top of the window.
        if section == "connectors" {
            let (app, _) = try launchAttached(route: "/")
            perfSettle(3)
            NSLog("PERF_APP_READY route=/")
            let openHistory = app.webViews.descendants(matching: .any)
                .matching(NSPredicate(format: "label == %@", "Open chat history")).firstMatch
            if openHistory.waitForExistence(timeout: 10) {
                perfGesture("history-drawer-open", rep: 0) {
                    openHistory.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
                    perfSettle(1.2)
                }
                let openConnectors = app.webViews.descendants(matching: .any)
                    .matching(NSPredicate(format: "label == %@", "Open MCP connections")).firstMatch
                if openConnectors.waitForExistence(timeout: 5) {
                    perfGesture("connectors-open", rep: 0) {
                        openConnectors.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
                        perfSettle(1.5)
                    }
                    let title = app.webViews.staticTexts.matching(NSPredicate(format: "label == %@", "MCP connections")).firstMatch
                    let close = app.webViews.buttons.matching(NSPredicate(format: "label == %@", "Close")).firstMatch
                    NSLog("PERF_CONNECTORS_GEOMETRY title_top=\(title.exists ? Int(title.frame.minY) : -1) close_top=\(close.exists ? Int(close.frame.minY) : -1) window_safe_top=\(Int(app.windows.firstMatch.frame.minY))")
                    NSLog("PERF_CONNECTORS_OPEN 1")
                    perfSettle(8)
                } else {
                    NSLog("PERF_SKIPPED name=connectors-open reason=button_not_found")
                }
            } else {
                NSLog("PERF_SKIPPED name=history-drawer-open reason=button_not_found")
            }
            NSLog("PERF_DONE route=/")
            app.terminate()
        }

        // The person's own information on the Memory route: the scope
        // catalogue as the person sees it. Logs the visible labels (never
        // values) at the root and inside the financial branch.
        if section == "memory" {
            let (app, _) = try launchAttached(route: "/one/pkm")
            let readyAt = perfEpochMs()
            NSLog("PERF_APP_READY route=/one/pkm")
            func logLabels(_ tag: String) {
                let texts = app.webViews.staticTexts.allElementsBoundByIndex
                let labels = texts.prefix(120).map { $0.label }.filter { !$0.isEmpty }
                NSLog("PERF_MEMORY_LABELS \(tag) count=\(labels.count) :: \(labels.joined(separator: " | "))")
            }
            func find(_ text: String) -> XCUIElement {
                app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH[c] %@", text)).firstMatch
            }
            // The categories arrive after the memories load; note how long that takes.
            let financial = find("Financial")
            let listed = financial.waitForExistence(timeout: 25)
            NSLog("PERF_MEMORY_CATEGORIES listed=\(listed ? 1 : 0) after_ms=\(perfEpochMs() - readyAt)")
            logLabels("saved-root")
            if listed {
                financial.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
                perfSettle(3)
                logLabels("saved-financial")
                let firstBranch = app.webViews.descendants(matching: .any)
                    .matching(NSPredicate(format: "label CONTAINS[c] %@", "Portfolio")).firstMatch
                if firstBranch.waitForExistence(timeout: 5) {
                    firstBranch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
                    perfSettle(3)
                    logLabels("saved-financial-portfolio")
                }
                // Back to the root, then the Sharing tab: what a person can share.
                app.terminate()
                let (again, _) = try launchAttached(route: "/one/pkm")
                let sharing = again.webViews.descendants(matching: .any)
                    .matching(NSPredicate(format: "label ==[c] %@", "Sharing")).firstMatch
                if sharing.waitForExistence(timeout: 20) {
                    sharing.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
                    perfSettle(4)
                    let texts = again.webViews.staticTexts.allElementsBoundByIndex.prefix(120).map { $0.label }.filter { !$0.isEmpty }
                    NSLog("PERF_MEMORY_LABELS sharing count=\(texts.count) :: \(texts.joined(separator: " | "))")
                    let fin = again.webViews.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH[c] %@", "Financial")).firstMatch
                    if fin.waitForExistence(timeout: 8) {
                        fin.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
                        perfSettle(3)
                        let inner = again.webViews.staticTexts.allElementsBoundByIndex.prefix(120).map { $0.label }.filter { !$0.isEmpty }
                        NSLog("PERF_MEMORY_LABELS sharing-financial count=\(inner.count) :: \(inner.joined(separator: " | "))")
                    }
                }
                perfSettle(3)
                NSLog("PERF_DONE route=/one/pkm")
                again.terminate()
            } else {
                NSLog("PERF_SKIPPED name=memory-financial reason=categories_never_listed")
                NSLog("PERF_DONE route=/one/pkm")
                app.terminate()
            }
        }

        // Every route the inventory says the phone must serve, one launch each.
        //
        // The other sections above drive gestures on a handful of surfaces
        // that were chosen by hand, which is how coverage rots: a route added
        // later is invisible here by default. This section takes its list from
        // the shell (which reads native-route-inventory.json), so the set can
        // only ever be as stale as the inventory itself.
        //
        // One launch per route, settle, then an idle window. That is enough to
        // find the route that costs 300 ms to paint or never settles at all;
        // gesture work on a named surface still belongs in its own section.
        // One launch, one unlock, then the app walked the way a person uses
        // it: every stop is reached by a tap from the one before, never by a
        // launch into a route, so the session, its caches and its vault key
        // carry through. Each stop logs PERF_STOP and holds still while the
        // card captures the phone's screen from the Mac, for the pixel review
        // (layout under the keyboard, clipping, alignment, copy). Read-only:
        // nothing is sent, approved or removed.
        // Plaid vault proof (sandbox only, local backend): connect six sandbox
        // banks through Plaid's native screens, each sealed into the person's
        // financial memory. Needs a build pointed at a backend holding the
        // Plaid SANDBOX key. Sandbox logins only (user_good / pass_good); the
        // connections are kept on purpose (founder decision 2026-09-23).
        if section == "plaid-vault" {
            perfGateStop = true
            let (app, _) = try launchAttached(route: nil)
            perfGateStop = false
            perfSettle(3)
            NSLog("PERF_APP_READY route=plaid-vault")
            // This build talks to a backend on the local network, so iOS asks
            // once for Local Network access; the prompt belongs to SpringBoard.
            func allowLocalNetworkIfAsked() {
                let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
                let allow = springboard.buttons["Allow"]
                if allow.waitForExistence(timeout: 3) {
                    allow.tap()
                    NSLog("PLAID_STEP local_network_allowed")
                    perfSettle(3)
                }
            }
            allowLocalNetworkIfAsked()
            // The launch helper treats any "One" label as unlocked, which can
            // be true for a moment before the vault gate settles (or while a
            // system prompt covers it). Unlock here if the gate is up.
            func unlockIfGated() {
                let field = app.secureTextFields.firstMatch
                guard field.waitForExistence(timeout: 8), !passphrase.isEmpty else { return }
                NSLog("PLAID_STEP gate_visible_unlocking")
                field.tap()
                perfSettle(0.5)
                field.typeText(passphrase)
                perfSettle(0.6)
                let unlock = app.buttons["Unlock"]
                if unlock.waitForExistence(timeout: 4) && unlock.isEnabled { unlock.tap() }
                for _ in 0..<90 {
                    if !app.secureTextFields.firstMatch.exists { break }
                    perfSettle(1)
                }
                perfSettle(4)
                NSLog("PLAID_STEP gate_cleared=\(!app.secureTextFields.firstMatch.exists)")
            }
            unlockIfGated()
            func element(_ label: String, contains: Bool = false) -> XCUIElement {
                let format = contains ? "label CONTAINS[c] %@" : "label == %@"
                return app.descendants(matching: .any)
                    .matching(NSPredicate(format: format, label)).firstMatch
            }
            func tapFirst(_ label: String, contains: Bool = false, timeout: TimeInterval = 6) -> Bool {
                let found = element(label, contains: contains)
                guard found.waitForExistence(timeout: timeout) else { return false }
                if found.isHittable {
                    found.tap()
                } else {
                    found.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
                }
                return true
            }
            func checkpoint(_ name: String) {
                perfSettle(1.0)
                NSLog("PLAID_STEP \(name)")
            }
            // XCUITest can drop keystrokes while the keyboard is still coming
            // up (First Gingham got a 7-character "pass_good" and Plaid said
            // "Incorrect credentials"). A secure field reports one bullet per
            // character, so check the length and retype until it matches.
            func typeVerified(_ field: XCUIElement, _ text: String, secure: Bool) -> Bool {
                for _ in 0..<3 {
                    // Once revealed, the secure field is gone; the check above
                    // already had its chance on the plain one.
                    guard field.exists else { return false }
                    field.tap()
                    perfSettle(0.6)
                    let current = (field.value as? String) ?? ""
                    let placeholder = field.placeholderValue ?? ""
                    if !current.isEmpty && current != placeholder && current != field.label {
                        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count + 2))
                    }
                    field.typeText(text)
                    // Reveal a secure field so the check reads the real text;
                    // deleting inside a secure field is not reliable on iOS.
                    if secure {
                        let reveal = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS[c] %@", "show", "reveal")).firstMatch
                        if reveal.exists && reveal.isHittable { reveal.tap(); perfSettle(0.5) }
                        let plain = app.textFields["Password"]
                        if plain.exists {
                            if ((plain.value as? String) ?? "") == text { return true }
                            plain.tap()
                            plain.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 24))
                            plain.typeText(text)
                            if ((plain.value as? String) ?? "") == text { return true }
                        }
                    }
                    let typed = (field.value as? String) ?? ""
                    if secure ? typed.count == text.count : typed == text { return true }
                    NSLog("PLAID_STEP retype length=\(typed.count)")
                }
                return false
            }
            // Leave Link without connecting, so the next bank starts clean.
            func closeLink() {
                for _ in 0..<3 {
                    let close = app.buttons.matching(NSPredicate(format: "label ==[c] %@ OR label ==[c] %@", "Close", "Exit")).firstMatch
                    if close.exists { close.tap(); perfSettle(1.5) }
                    for label in ["Yes, exit", "Exit", "Leave"] where element(label).exists { element(label).tap(); perfSettle(1.5) }
                    if element("Portfolio source", contains: true).exists { return }
                }
            }
            func dismissKeyboardIfShown() {
                for key in ["Done", "done", "Return", "return", "Go", "go"] {
                    let button = app.keyboards.buttons[key]
                    if button.exists && button.isHittable { button.tap(); return }
                }
            }

            allowLocalNetworkIfAsked()
            // The app can reopen on Chat while it is still settling, and a
            // single tap on the One tab then lands nowhere; retry until the
            // Finance entry is on screen.
            for _ in 0..<4 {
                perfTapNav(app, label: "One")
                perfSettle(2)
                if element("Finance").exists || element("Finance,", contains: true).exists { break }
            }
            if !tapFirst("Finance") { _ = tapFirst("Finance,", contains: true) }
            perfSettle(2.5)
            _ = tapFirst("Portfolio")
            perfSettle(2.5)
            checkpoint("portfolio")

            let banks = [
                "First Platypus Bank", "First Platypus Bank", "First Gingham Credit Union",
                "Tattersall Federal Credit Union", "Tartan Bank", "Houndstooth Bank",
            ]
            // Resume after banks already sealed on this account, so a rerun
            // adds the missing ones instead of duplicating kept connections.
            let rawStartIndex = ProcessInfo.processInfo.environment["HUSHH_PLAID_START_INDEX"] ?? "0"
            guard let startIndex = Int(rawStartIndex), (0..<banks.count).contains(startIndex) else {
                XCTFail("HUSHH_PLAID_START_INDEX must be an integer from 0 through \(banks.count - 1).")
                throw NSError(domain: "AppUITests", code: 3)
            }
            let expectedConnections = banks.count - startIndex
            var connected = 0
            bankLoop: for (index, bank) in banks.enumerated() where index >= startIndex {
                guard tapFirst("Portfolio source", contains: true, timeout: 12) else {
                    NSLog("PLAID_MISSING index=\(index) step=portfolio_source"); checkpoint("\(index)-no-source"); break
                }
                perfSettle(1.5)
                // The row exposes its title and description as one label. It is
                // disabled while the previous connection finishes, so tap until
                // Plaid actually opens.
                let skipPhone = element("Continue without phone number")
                var plaidOpened = false
                for _ in 0..<6 {
                    if !tapFirst("Connect a bank or brokerage", contains: true, timeout: 4)
                        && !tapFirst("Manage connections", contains: true, timeout: 4) {
                        perfSettle(3); continue
                    }
                    if skipPhone.waitForExistence(timeout: 20) || app.searchFields.firstMatch.exists {
                        plaidOpened = true; break
                    }
                    perfSettle(3)
                }
                guard plaidOpened else {
                    NSLog("PLAID_MISSING index=\(index) step=connect_row"); checkpoint("\(index)-no-connect"); break
                }
                if skipPhone.exists { skipPhone.tap() }
                perfSettle(2)
                let search = app.searchFields.firstMatch.waitForExistence(timeout: 8)
                    ? app.searchFields.firstMatch : app.textFields.firstMatch
                guard search.waitForExistence(timeout: 10) else {
                    NSLog("PLAID_MISSING index=\(index) step=search"); checkpoint("\(index)-no-search"); break
                }
                search.tap()
                search.typeText(bank)
                perfSettle(3)
                checkpoint("\(index)-results")
                let result = app.descendants(matching: .any)
                    .matching(NSPredicate(format: "label BEGINSWITH %@", bank)).allElementsBoundByIndex
                    .first { $0.elementType != .searchField && $0.elementType != .textField && $0.isHittable && $0.frame.minY > search.frame.maxY }
                guard let result else {
                    NSLog("PLAID_MISSING index=\(index) step=result"); break
                }
                result.tap()
                perfSettle(3)
                // Some banks list associated institutions first; take the plain one.
                let username = app.textFields["Username"]
                if !username.waitForExistence(timeout: 4) {
                    let plain = app.descendants(matching: .any)
                        .matching(NSPredicate(format: "label == %@", bank)).allElementsBoundByIndex
                        .first { $0.isHittable && $0.frame.minY > 180 }
                    plain?.tap()
                    perfSettle(3)
                }
                guard username.waitForExistence(timeout: 15) else {
                    NSLog("PLAID_MISSING index=\(index) step=username"); checkpoint("\(index)-no-username"); break
                }
                let password = app.secureTextFields["Password"]
                guard typeVerified(username, "user_good", secure: false),
                      password.waitForExistence(timeout: 5),
                      typeVerified(password, "pass_good", secure: true) else {
                    NSLog("PLAID_MISSING index=\(index) step=credentials"); checkpoint("\(index)-no-credentials")
                    closeLink(); continue bankLoop
                }
                dismissKeyboardIfShown()
                perfSettle(0.8)
                // The keyboard's return key often submits the login itself, in
                // which case Plaid is already on the accounts screen.
                if !element("Your accounts").waitForExistence(timeout: 3) && !tapFirst("Submit", timeout: 5)
                    && !element("Continue").exists {
                    NSLog("PLAID_MISSING index=\(index) step=submit"); checkpoint("\(index)-no-submit"); break
                }
                // Account selection (all selected by default), then Continue.
                // No accounts screen means Link did not log in: that bank is
                // not connected, whatever happens next.
                let continueButton = element("Continue")
                guard continueButton.waitForExistence(timeout: 45), !element("Incorrect credentials").exists else {
                    NSLog("PLAID_MISSING index=\(index) step=login"); checkpoint("\(index)-no-login")
                    closeLink(); continue bankLoop
                }
                checkpoint("\(index)-accounts")
                continueButton.tap()
                let finish = element("Finish without saving")
                if finish.waitForExistence(timeout: 30) { finish.tap() }
                // Back in the app: the connection is exchanged and sealed.
                var backInApp = false
                for _ in 0..<30 {
                    if app.webViews.firstMatch.exists && element("Portfolio source", contains: true).exists {
                        backInApp = true; break
                    }
                    perfSettle(1)
                }
                perfSettle(6)
                checkpoint("\(index)-after")
                guard backInApp else {
                    NSLog("PLAID_MISSING index=\(index) step=return_to_app"); break bankLoop
                }
                // The exchange, the transaction pages and the sealed write run
                // after Link closes. Ending the test inside that window kills
                // the app mid-seal (Houndstooth, run 16), so give it time.
                perfSettle(20)
                connected += 1
                NSLog("PLAID_CONNECTED index=\(index) bank=\(bank)")
            }
            NSLog("PLAID_DONE connected=\(connected) expected=\(expectedConnections)")
            XCTAssertEqual(
                connected,
                expectedConnections,
                "Plaid proof did not complete every requested sandbox connection."
            )
            checkpoint("final")
            return
        }

        if section == "session" {
            perfGateStop = true
            let (app, webView) = try launchAttached(route: nil)
            perfGateStop = false
            perfSettle(3)
            NSLog("PERF_APP_READY route=session")
            func stop(_ name: String, settle: TimeInterval = 2.5) {
                perfSettle(settle)
                NSLog("PERF_STOP name=\(name)")
                perfSettle(2.5)
            }
            func tapLabel(_ label: String, contains: Bool = false) -> Bool {
                let format = contains ? "label CONTAINS[c] %@" : "label == %@"
                let element = app.webViews.descendants(matching: .any)
                    .matching(NSPredicate(format: format, label)).firstMatch
                guard element.waitForExistence(timeout: 4) else {
                    NSLog("PERF_SKIPPED name=session-tap reason=label_not_found label=\(label)")
                    return false
                }
                if element.isHittable {
                    element.tap()
                } else {
                    element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
                }
                return true
            }
            // The header's back arrow, found by where it sits (top left)
            // rather than by its label, which is a breadcrumb that changes
            // per screen ("Go back", "Back to Location", ...).
            func tapHeaderBack() -> Bool {
                let buttons = app.webViews.buttons.allElementsBoundByIndex
                for button in buttons where button.exists {
                    let frame = button.frame
                    if frame.minX < 80 && frame.midY < 170 && frame.width < 90 && button.isHittable {
                        button.tap()
                        return true
                    }
                }
                NSLog("PERF_SKIPPED name=session-back reason=header_back_not_found")
                return false
            }
            // Back to the tab bar from wherever the last tap landed (a
            // full-screen page such as Advisor's setup has none).
            func returnToTab(_ label: String) {
                for _ in 0..<3 {
                    let bar = app.webViews.descendants(matching: .any)
                        .matching(NSPredicate(format: "label == %@", label))
                    if bar.count > 0 && bar.allElementsBoundByIndex.contains(where: { $0.frame.midY > 700 }) { break }
                    if !tapHeaderBack() { break }
                    perfSettle(1.2)
                }
                perfTapNav(app, label: label)
            }
            // Rapid in-test screenshots right after a tap, kept as attachments
            // the card exports (the Mac cannot screen-record this iPhone). Each
            // carries its capture time so the sequence can be timed.
            func burst(_ name: String, count: Int = 10) {
                for index in 0..<count {
                    let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
                    attachment.name = String(
                        format: "burst-%@-%02d-%lld", name, index,
                        Int64(Date().timeIntervalSince1970 * 1000)
                    )
                    attachment.lifetime = .keepAlways
                    add(attachment)
                }
            }
            func dismissKeyboard() {
                // A tap on the content above the keyboard, as a person does.
                webView.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.22)).tap()
                perfSettle(1.0)
            }

            stop("landing", settle: 1)

            perfTapNav(app, label: "Chat")
            burst("to-chat")
            stop("chat")
            if tapLabel("Message One") {
                stop("chat-keyboard", settle: 1.5)
                // A long draft must move into the expanded editor on its own,
                // with every character kept. Typed, never sent, then deleted.
                let composer = app.webViews.descendants(matching: .any)
                    .matching(NSPredicate(format: "label == %@", "Message One")).firstMatch
                let draft = (1...6).map { "draft line number \($0) for the expand check only. " }.joined()
                composer.typeText(draft)
                stop("composer-long-draft", settle: 1.0)
                let expanded = app.webViews.descendants(matching: .any)
                    .matching(NSPredicate(format: "label == %@", "Expanded message One")).firstMatch
                NSLog("PERF_COMPOSER expanded=\(expanded.exists ? 1 : 0)")
                let editor = expanded.exists ? expanded : composer
                editor.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: draft.count + 10))
                stop("composer-cleared", settle: 0.8)
                dismissKeyboard()
            }
            // One rating round trip: like, then unlike, so nothing is left.
            if tapLabel("Like response") {
                stop("rated-like", settle: 3.0)
                _ = tapLabel("Like response")
                stop("rated-cleared", settle: 2.0)
            }

            perfTapNav(app, label: "One")
            stop("one")
            for (agent, tabs) in [
                ("Finance", ["Portfolio", "Analysis"]),
                ("Wallet", []), ("Location", []), ("Advisor", []), ("Mail", []),
                ("Calendar", []), ("KYC", []), ("Memory", []), ("Consent", []),
            ] {
                guard tapLabel(agent) || tapLabel("\(agent),", contains: true) else { continue }
                stop("agent-\(agent.lowercased())")
                for tab in tabs where tapLabel(tab) {
                    stop("agent-\(agent.lowercased())-\(tab.lowercased())")
                }
                returnToTab("One")
                perfSettle(1.5)
            }

            returnToTab("Connect")
            burst("to-connect")
            stop("connect")
            if tapLabel("Circles") { stop("connect-circles") }

            returnToTab("Feed")
            burst("to-feed")
            stop("feed")

            returnToTab("One")
            perfSettle(1.5)
            if tapLabel("Open Profile") {
                stop("profile-pane")
                for row in ["Your account", "Appearance & preferences", "Security & privacy", "Trusted devices", "Help & feedback"] {
                    guard tapLabel(row) else { continue }
                    stop("profile-\(row.lowercased().replacingOccurrences(of: " & ", with: "-").replacingOccurrences(of: " ", with: "-"))")
                    // Back to the pane the way a person would: the header arrow.
                    if !tapHeaderBack() { _ = tapLabel("Open Profile") }
                    perfSettle(1.5)
                }
            }
            NSLog("PERF_DONE route=session")
            app.terminate()
        }

        // PERF_SECTION=profile: scrolling the Profile page itself (the pane's
        // open and dismiss are measured in the feed section).
        if section == "profile" {
            let (app, webView) = try launchAttached(route: nil)
            perfSettle(3)
            perfTapNav(app, label: "One")
            perfSettle(1.5)
            let open = app.webViews.descendants(matching: .any)
                .matching(NSPredicate(format: "label == %@", "Open Profile")).firstMatch
            if open.waitForExistence(timeout: 8) {
                open.tap()
                perfSettle(3)
                NSLog("PERF_APP_READY route=profile")
                for rep in 0..<repetitions {
                    perfGesture("profile-flick", rep: rep) {
                        for _ in 0..<4 {
                            perfFlick(webView, fromY: 0.75, toY: 0.3)
                            perfSettle(0.35)
                        }
                        perfSettle(1.5)
                        for _ in 0..<4 {
                            perfFlick(webView, fromY: 0.3, toY: 0.75)
                            perfSettle(0.35)
                        }
                        perfSettle(1.5)
                    }
                }
            } else {
                NSLog("PERF_SKIPPED name=profile-flick reason=open_profile_not_found")
            }
            perfSettle(12)
            NSLog("PERF_DONE route=profile")
            app.terminate()
        }

        // PERF_SECTION=journeys: the release device gate. Seven journeys a
        // person takes, in one install, on the reviewer session the Debug
        // bootstrap left behind (Release has no automated sign-in). Each
        // journey is framed by JOURNEY_BEGIN/END for the card's Mac-side frame
        // capture; JOURNEY_PAUSE holds that capture off the passphrase entry
        // and the home screen, and waits out any frame already in flight.
        // Checks log JOURNEY_CHECK / JOURNEY_METRIC / JOURNEY_GEOMETRY; the
        // test itself fails only when the app cannot be reached at all, so a
        // missing surface is reported next to its screenshot, not hidden.
        // It never taps Allow: a decline is always undone inside its window.
        if section == "journeys" {
            let app = XCUIApplication()
            app.launchArguments = ["-CapacitorStorage.hushh_perf_probe", "1"]
            let webView = app.webViews.firstMatch
            func mark(_ kind: String, _ name: String) {
                NSLog("JOURNEY_\(kind) name=\(name) epoch_ms=\(perfEpochMs())")
            }
            func pauseCapture(_ name: String) { mark("PAUSE", name); perfSettle(2.0) }
            func stop(_ name: String, settle: TimeInterval = 1.5) {
                perfSettle(settle)
                NSLog("PERF_STOP name=\(name)")
                perfSettle(2.0)
            }
            func check(_ journey: String, _ name: String, _ ok: Bool, _ detail: String = "") {
                NSLog("JOURNEY_CHECK journey=\(journey) check=\(name) ok=\(ok ? 1 : 0) \(detail)")
            }
            func metric(_ name: String, _ value: Int64) { NSLog("JOURNEY_METRIC name=\(name) value=\(value)") }
            func quickShot(_ name: String) {
                let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
                attachment.name = "\(name)-\(perfEpochMs())"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
            func burst(_ name: String, count: Int) {
                for index in 0..<count { quickShot(String(format: "burst-%@-%02d", name, index)) }
            }
            func web(_ predicate: NSPredicate) -> XCUIElementQuery {
                app.webViews.descendants(matching: .any).matching(predicate)
            }
            func labelled(_ label: String) -> NSPredicate { NSPredicate(format: "label == %@", label) }
            func tapElement(_ element: XCUIElement) {
                if element.isHittable { element.tap() } else { element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
            }
            func tapFirst(_ predicate: NSPredicate, timeout: TimeInterval = 4) -> Bool {
                let element = web(predicate).firstMatch
                guard element.waitForExistence(timeout: timeout) else { return false }
                tapElement(element)
                return true
            }
            func geometry(_ name: String, _ element: XCUIElement) {
                guard element.exists else { return }
                let frame = element.frame
                let window = app.windows.firstMatch.frame
                NSLog("JOURNEY_GEOMETRY name=\(name) x=\(Int(frame.minX)) y=\(Int(frame.minY)) w=\(Int(frame.width)) h=\(Int(frame.height)) right_gap=\(Int(window.maxX - frame.maxX)) window_w=\(Int(window.width)) window_h=\(Int(window.height))")
            }
            // Scroll the page until an element sits clear of the top bar and the tab bar.
            func scrollTo(_ predicate: NSPredicate, maxFlicks: Int = 8) -> XCUIElement? {
                let height = app.windows.firstMatch.frame.height
                for _ in 0...maxFlicks {
                    let element = web(predicate).firstMatch
                    if element.exists && element.frame.minY > 100 && element.frame.maxY < height - 120 { return element }
                    perfFlick(webView, fromY: 0.72, toY: 0.45)
                    perfSettle(0.9)
                }
                let element = web(predicate).firstMatch
                return element.exists ? element : nil
            }
            func headerBack() {
                for button in app.webViews.buttons.allElementsBoundByIndex where button.exists {
                    let frame = button.frame
                    if frame.minX < 80 && frame.midY < 170 && frame.width < 90 && button.isHittable {
                        button.tap()
                        return
                    }
                }
            }
            func openProfile() -> Bool {
                perfTapNav(app, label: "One")
                perfSettle(1.5)
                return tapFirst(labelled("Open Profile"))
            }
            let gateField = NSPredicate(format: "label == %@ OR placeholderValue == %@ OR label == %@", "Vault password", "Enter password", "Password")
            func unlockOffCamera() throws {
                pauseCapture("passphrase")
                try perfUnlockVault(app, passphrase: passphrase, timeout: 240)
                perfSettle(1.0)
                mark("RESUME", "passphrase")
            }

            // 1. Cold launch, the restored session, the passphrase unlock.
            let launchStart = perfEpochMs()
            app.launch()
            mark("BEGIN", "01-cold-launch-unlock")
            XCTAssertTrue(webView.waitForExistence(timeout: 30), "WebView unavailable")
            metric("cold_launch_webview_ms", perfEpochMs() - launchStart)
            var interactive: Int64 = -1
            let interactiveDeadline = Date().addingTimeInterval(90)
            while Date() < interactiveDeadline {
                if web(gateField).count > 0 || perfLabelExists(app, "One") {
                    interactive = perfEpochMs() - launchStart
                    break
                }
                perfSettle(0.25)
            }
            metric("cold_launch_interactive_ms", interactive)
            let gateShown = web(gateField).count > 0
            check("01", "vault_gate_on_cold_launch", gateShown)
            stop("01-cold-launch--gate", settle: 0.5)
            try unlockOffCamera()
            check("01", "unlocked_shell", perfLabelExists(app, "One"))
            stop("01-cold-launch--unlocked")
            mark("END", "01-cold-launch-unlock")

            // 2. Chat: send, the reply streams in, the composer stays put,
            // and the person's own bubble can be selected.
            mark("BEGIN", "02-chat")
            let chatTap = perfEpochMs()
            perfTapNav(app, label: "Chat")
            let composer = web(labelled("Message One")).firstMatch
            let composerSeen = composer.waitForExistence(timeout: 20)
            metric("chat_first_render_ms", composerSeen ? perfEpochMs() - chatTap : -1)
            stop("02-chat--open")
            if composerSeen {
                let restTop = composer.frame.minY
                geometry("chat-composer-rest", composer)
                composer.tap()
                perfSettle(1.2)
                let keyboard = app.keyboards.firstMatch
                if keyboard.exists {
                    NSLog("JOURNEY_GEOMETRY name=chat-keyboard composer_bottom=\(Int(composer.frame.maxY)) keyboard_top=\(Int(keyboard.frame.minY)) gap=\(Int(keyboard.frame.minY - composer.frame.maxY))")
                }
                check("02", "keyboard_shown", keyboard.exists)
                stop("02-chat--keyboard", settle: 0.3)
                let prompt = "Reply in one short sentence: what can you help me with today?"
                composer.typeText(prompt)
                stop("02-chat--typed", settle: 0.5)
                let send = app.webViews.buttons.matching(labelled("Send message")).firstMatch
                let sentAt = perfEpochMs()
                if send.exists {
                    send.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
                } else {
                    composer.typeText("\n")
                }
                burst("02-send-ripple", count: 6)
                stop("02-chat--streaming", settle: 1.5)
                let rated = app.webViews.buttons.matching(labelled("Like response")).firstMatch
                let replied = rated.waitForExistence(timeout: 90)
                metric("chat_reply_complete_ms", replied ? perfEpochMs() - sentAt : -1)
                check("02", "reply_complete", replied)
                webView.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.22)).tap()
                perfSettle(1.2)
                stop("02-chat--reply")
                let settledTop = composer.exists ? composer.frame.minY : -1
                check("02", "composer_back_at_rest", abs(settledTop - restTop) <= 2, "rest_top=\(Int(restTop)) settled_top=\(Int(settledTop))")
                let mine = app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "what can you help me with today")).firstMatch
                if mine.exists {
                    geometry("chat-own-bubble", mine)
                    mine.press(forDuration: 1.2)
                    perfSettle(0.8)
                    let editMenu = app.menuItems.count > 0 || app.buttons.matching(labelled("Copy")).count > 0
                    check("02", "own_bubble_selectable", editMenu, "menu_items=\(app.menuItems.count)")
                    quickShot("02-selection")
                    stop("02-chat--selection", settle: 0.2)
                    webView.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.22)).tap()
                    perfSettle(0.8)
                } else {
                    check("02", "own_bubble_selectable", false, "reason=bubble_not_found")
                }
            }
            mark("END", "02-chat")

            // 3. Profile > Shared with you: the secure card, hide and copy.
            mark("BEGIN", "03-shared-with-you")
            if openProfile() {
                stop("03-profile")
                if let group = scrollTo(labelled("Shared with you")) {
                    geometry("shared-with-you-title", group)
                    perfSettle(2.0)
                    stop("03-shared-with-you--group")
                    let card = web(NSPredicate(format: "label ENDSWITH %@", " shared with you")).firstMatch
                    check("03", "card_present", card.exists)
                    let decrypted = web(NSPredicate(format: "label == %@", "Decrypted on this device")).firstMatch
                    check("03", "decrypted_on_device", decrypted.waitForExistence(timeout: 10))
                    let hide = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Hide ")).firstMatch
                    if hide.exists {
                        tapElement(hide)
                        perfSettle(0.8)
                        let hiddenShown = web(labelled("Hidden")).count > 0
                        check("03", "hide_masks_values", hiddenShown)
                        stop("03-shared-with-you--hidden", settle: 0.2)
                        _ = tapFirst(NSPredicate(format: "label BEGINSWITH %@", "Show "))
                        perfSettle(0.8)
                    } else {
                        check("03", "hide_masks_values", false, "reason=no_hide_control")
                    }
                    let copy = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Copy ")).firstMatch
                    if copy.exists {
                        tapElement(copy)
                        let copied = web(labelled("Copied")).firstMatch.waitForExistence(timeout: 2)
                        quickShot("03-copied")
                        check("03", "copy_confirms", copied)
                        // Shared values never stay on the phone's clipboard.
                        UIPasteboard.general.items = []
                    } else {
                        check("03", "copy_confirms", false, "reason=no_copy_control")
                    }
                    stop("03-shared-with-you--card", settle: 0.8)
                } else {
                    check("03", "card_present", false, "reason=group_not_found")
                    stop("03-shared-with-you--missing")
                }
            } else {
                check("03", "profile_opened", false)
            }
            mark("END", "03-shared-with-you")

            // 4. Consent Center: the decision row, its sheet, a decline undone.
            mark("BEGIN", "04-consent-center")
            perfTapNav(app, label: "One")
            perfSettle(1.5)
            if tapFirst(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", "Consent", "Consent,")) {
                stop("04-consent", settle: 2.5)
                let declines = app.webViews.buttons.matching(labelled("Don't allow"))
                let allows = app.webViews.buttons.matching(labelled("Allow"))
                NSLog("JOURNEY_COUNT name=consent_pending_rows decline=\(declines.count) allow=\(allows.count)")
                for index in 0..<min(3, declines.count) {
                    geometry("consent-decline-\(index)", declines.element(boundBy: index))
                }
                for index in 0..<min(3, allows.count) {
                    geometry("consent-allow-\(index)", allows.element(boundBy: index))
                }
                if declines.count > 0 {
                    let firstDecline = declines.element(boundBy: 0)
                    let window = app.windows.firstMatch.frame
                    check("04", "decision_buttons_unclipped", allows.element(boundBy: 0).frame.maxX <= window.maxX - 8)
                    // The row body, left of its two buttons, opens the sheet.
                    let buttonsBefore = app.webViews.buttons.count
                    app.coordinate(withNormalizedOffset: .zero)
                        .withOffset(CGVector(dx: 90, dy: firstDecline.frame.midY)).tap()
                    perfSettle(1.5)
                    let sheetOpen = app.webViews.buttons.count != buttonsBefore
                        || web(NSPredicate(format: "label IN %@", ["Close", "Done", "Cancel"])).count > 0
                    check("04", "row_opens_sheet", sheetOpen, "buttons_before=\(buttonsBefore) after=\(app.webViews.buttons.count)")
                    stop("04-consent--sheet", settle: 0.3)
                    if !tapFirst(NSPredicate(format: "label IN %@", ["Close", "Done", "Cancel"]), timeout: 1) {
                        let top = webView.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35))
                        top.press(forDuration: 0.05, thenDragTo: webView.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)))
                    }
                    perfSettle(1.5)
                    let rowsBefore = declines.count
                    let decline = app.webViews.buttons.matching(labelled("Don't allow")).firstMatch
                    if decline.exists {
                        tapElement(decline)
                        let undo = app.webViews.buttons.matching(labelled("Undo")).firstMatch
                        if undo.waitForExistence(timeout: 2) {
                            quickShot("04-undo-toast")
                            undo.tap()
                            check("04", "undo_toast", true)
                        } else {
                            check("04", "undo_toast", false, "reason=undo_not_found")
                        }
                        perfSettle(2.0)
                        let rowsAfter = app.webViews.buttons.matching(labelled("Don't allow")).count
                        check("04", "undo_restores_row", rowsAfter == rowsBefore, "before=\(rowsBefore) after=\(rowsAfter)")
                        stop("04-consent--after-undo", settle: 0.3)
                    }
                } else {
                    check("04", "pending_rows_present", false, "reason=no_pending_requests")
                }
            } else {
                check("04", "consent_center_opened", false)
            }
            mark("END", "04-consent-center")

            // 5. Feed: the "Needs you" group.
            mark("BEGIN", "05-feed-needs-you")
            perfTapNav(app, label: "Feed")
            stop("05-feed", settle: 2.5)
            let needsYou = web(NSPredicate(format: "label CONTAINS[c] %@", "Needs you")).firstMatch
            check("05", "needs_you_present", needsYou.exists)
            geometry("feed-needs-you", needsYou)
            let feedDecisions = app.webViews.buttons.matching(labelled("Allow"))
            for index in 0..<min(3, feedDecisions.count) {
                geometry("feed-allow-\(index)", feedDecisions.element(boundBy: index))
            }
            perfFlick(webView, fromY: 0.75, toY: 0.3)
            stop("05-feed--scrolled", settle: 1.2)
            perfFlick(webView, fromY: 0.3, toY: 0.8)
            perfSettle(1.0)
            mark("END", "05-feed-needs-you")

            // 6. Settings rows (one full-width surface each, ripple on tap),
            // and the same screens in the other theme.
            mark("BEGIN", "06-settings-rows")
            if openProfile() {
                stop("06-profile-pane")
                for row in ["Your account", "Appearance & preferences", "Security & privacy", "Trusted devices", "Help & feedback"] {
                    let slug = row.lowercased().replacingOccurrences(of: " & ", with: "-").replacingOccurrences(of: " ", with: "-")
                    guard let element = scrollTo(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", row, "\(row),"), maxFlicks: 3) else {
                        check("06", "row_\(slug)", false, "reason=not_found")
                        continue
                    }
                    let button = app.webViews.buttons.matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", row, "\(row),")).firstMatch
                    geometry("settings-row-\(slug)", button.exists ? button : element)
                    tapElement(button.exists ? button : element)
                    burst("06-ripple-\(slug)", count: 3)
                    stop("06-\(slug)")
                    check("06", "row_\(slug)", true)
                    if row == "Appearance & preferences" {
                        let options = ["Light", "Dark", "System"]
                        let selected = options.first { option in
                            let radio = app.webViews.radioButtons.matching(labelled(option)).firstMatch
                            return radio.exists && ((radio.value as? String) == "1" || radio.isSelected)
                        }
                        NSLog("JOURNEY_THEME original=\(selected ?? "unknown")")
                        let other = selected == "Light" ? "Dark" : "Light"
                        if tapFirst(labelled(other), timeout: 2) {
                            stop("06-appearance--\(other.lowercased())")
                            perfTapNav(app, label: "Feed")
                            stop("06-feed--\(other.lowercased())")
                            perfTapNav(app, label: "Chat")
                            stop("06-chat--\(other.lowercased())")
                            if openProfile(), tapFirst(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", row, "\(row),")) {
                                perfSettle(1.0)
                                _ = tapFirst(labelled(selected ?? "System"), timeout: 2)
                                perfSettle(1.0)
                                NSLog("JOURNEY_THEME restored=\(selected ?? "System")")
                            }
                        }
                    }
                    headerBack()
                    perfSettle(1.5)
                    if !perfLabelExists(app, "Your account") { _ = openProfile(); perfSettle(1.0) }
                }
            } else {
                check("06", "profile_opened", false)
            }
            mark("END", "06-settings-rows")

            // 7. Background and foreground keep the unlock (the key is
            // memory-only for the runtime); a relaunch must lock again.
            mark("BEGIN", "07-background-relock")
            perfTapNav(app, label: "Feed")
            stop("07-before-background")
            pauseCapture("home-screen")
            XCUIDevice.shared.press(.home)
            perfSettle(5.0)
            app.activate()
            _ = app.wait(for: .runningForeground, timeout: 10)
            perfSettle(2.0)
            mark("RESUME", "home-screen")
            let resumedUnlocked = perfLabelExists(app, "One") && web(gateField).count == 0
            check("07", "unlocked_after_resume", resumedUnlocked)
            stop("07-after-foreground", settle: 0.5)
            pauseCapture("relaunch")
            app.terminate()
            let relaunchStart = perfEpochMs()
            app.launch()
            XCTAssertTrue(webView.waitForExistence(timeout: 30), "WebView unavailable after relaunch")
            perfSettle(1.0)
            mark("RESUME", "relaunch")
            var relocked = false
            let relockDeadline = Date().addingTimeInterval(60)
            while Date() < relockDeadline {
                if web(gateField).count > 0 { relocked = true; break }
                if perfLabelExists(app, "One") { break }
                perfSettle(0.25)
            }
            metric("warm_relaunch_interactive_ms", perfEpochMs() - relaunchStart)
            check("07", "locked_after_relaunch", relocked)
            stop("07-relaunch--gate", settle: 0.3)
            try unlockOffCamera()
            check("07", "unlocked_after_relaunch", perfLabelExists(app, "One"))
            stop("07-relaunch--unlocked")
            mark("END", "07-background-relock")

            NSLog("PERF_DONE route=journeys")
            app.terminate()
        }

        if section == "routes" {
            let list = (environment["HUSHH_PERF_ROUTES"] ?? "")
                .split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
            if list.isEmpty {
                NSLog("PERF_SKIPPED name=routes reason=no_route_list")
            }
            for (index, route) in list.enumerated() {
                let app: XCUIApplication
                do {
                    (app, _) = try launchAttached(route: route, shellOptional: true, failHard: false, unlockTimeout: 90)
                } catch is PerfSignedOut {
                    // Every later launch would land on the same screen: stop
                    // here rather than record the whole list as unreachable.
                    NSLog("PERF_SWEEP_ABORTED reason=signed-out route=\(route) remaining=\(list.count - index)")
                    XCUIApplication().terminate()
                    XCTFail("The app is signed out, so no route can be measured. Restore the reviewer session with scripts/perf/ios-reviewer-signin.sh, then rerun.")
                    break
                } catch let unreachable as PerfRouteUnreachable {
                    NSLog("PERF_ROUTE_UNREACHABLE route=\(route) reason=\(unreachable.reason)")
                    XCUIApplication().terminate()
                    continue
                }
                NSLog("PERF_APP_READY route=\(route)")
                // The probe keys its idle bucket on the route it settled on,
                // so a redirect (locked vault, missing prerequisite) is
                // recorded under where it actually landed, not where we aimed.
                let settled = app.webViews.firstMatch.waitForExistence(timeout: 20)
                if !settled {
                    NSLog("PERF_ROUTE_UNREACHABLE route=\(route)")
                    app.terminate()
                    continue
                }
                Thread.sleep(forTimeInterval: 6)
                NSLog("PERF_DONE route=\(route)")
                app.terminate()
            }
        }

        // Connecting a bank through Plaid Link on the phone, step by step,
        // with a marker per screen for captures. It only proceeds past the
        // institution list when Link is plainly in sandbox (the test bank is
        // listed); against anything else it stops there and never types.
        if section == "plaid" {
            let (app, _) = try launchAttached(route: "/one/kai?tab=portfolio")
            perfSettle(5)
            NSLog("PERF_APP_READY route=/one/kai?tab=portfolio")
            func element(_ label: String, exact: Bool = true) -> XCUIElement {
                let format = exact ? "label == %@" : "label CONTAINS[c] %@"
                return app.webViews.descendants(matching: .any).matching(NSPredicate(format: format, label)).firstMatch
            }
            func tap(_ e: XCUIElement) { e.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
            func step(_ name: String, settle: TimeInterval = 1.5) {
                perfSettle(settle)
                NSLog("PERF_PLAID_STEP \(name)")
            }
            func labels(_ tag: String) {
                let texts = app.webViews.staticTexts.allElementsBoundByIndex.prefix(60).map { $0.label }.filter { !$0.isEmpty }
                NSLog("PERF_PLAID_LABELS \(tag) :: \(texts.joined(separator: " | "))")
            }
            step("kai-dashboard", settle: 1)
            let settings = element("Portfolio source settings")
            if settings.waitForExistence(timeout: 8) {
                tap(settings)
                step("source-settings")
                let add = element("Add a statement", exact: false)
                if add.waitForExistence(timeout: 5) { tap(add); step("import-view") }
            } else {
                NSLog("PERF_PLAID_NOTE no source settings control; expecting the import view directly")
            }
            let bank = element("Bank account (via Plaid)", exact: false)
            if bank.waitForExistence(timeout: 8) {
                tap(bank)
                step("link-opening", settle: 6)
                labels("link-first")
                let cont = app.webViews.buttons.matching(NSPredicate(format: "label ==[c] %@", "Continue")).firstMatch
                if cont.waitForExistence(timeout: 10) {
                    tap(cont)
                    step("link-institutions", settle: 3)
                    labels("institutions")
                    let sandboxBank = element("Platypus", exact: false)
                    if sandboxBank.waitForExistence(timeout: 4) {
                        tap(sandboxBank)
                        step("link-credentials", settle: 3)
                        let user = app.webViews.textFields.firstMatch
                        let pass = app.webViews.secureTextFields.firstMatch
                        if user.waitForExistence(timeout: 6), pass.exists {
                            tap(user); user.typeText("user_good")
                            tap(pass); pass.typeText("pass_good")
                            let submit = app.webViews.buttons.matching(NSPredicate(format: "label ==[c] %@ OR label ==[c] %@", "Submit", "Continue")).firstMatch
                            if submit.exists { tap(submit) }
                            step("link-accounts", settle: 6)
                            labels("accounts")
                            let next = app.webViews.buttons.matching(NSPredicate(format: "label ==[c] %@", "Continue")).firstMatch
                            if next.waitForExistence(timeout: 8) { tap(next); step("link-finish", settle: 6); labels("finish") }
                            let done = app.webViews.buttons.matching(NSPredicate(format: "label ==[c] %@ OR label ==[c] %@", "Continue", "Done")).firstMatch
                            if done.waitForExistence(timeout: 8) { tap(done) }
                            step("exchange", settle: 12)
                            labels("after-exchange")
                        } else {
                            NSLog("PERF_PLAID_NOTE credential fields not reachable")
                        }
                    } else {
                        NSLog("PERF_PLAID_STOP reason=not_sandbox")
                    }
                } else {
                    NSLog("PERF_PLAID_NOTE Link's first screen did not expose a Continue control")
                }
            } else {
                NSLog("PERF_SKIPPED name=plaid reason=bank_row_not_found")
                labels("import-missing")
            }
            perfSettle(4)
            NSLog("PERF_DONE route=/one/kai")
            app.terminate()
        }

        if section == "all" || section == "kai" {
            let (app, webView) = try launchAttached(route: "/one/kai")
            guard perfWaitForLabel(app, label: "Portfolio", timeout: 60) else {
                NSLog("PERF_SKIPPED name=kai reason=finance_not_reached")
                app.terminate()
                throw XCTSkip("Finance did not open")
            }
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
            app.terminate()
        }

        if section == "all" || section == "location" {
            let (app, webView) = try launchAttached(route: "/one/location")
            perfSettle(4)
            NSLog("PERF_APP_READY route=/one/location")
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
    }

    /// Unlocks the vault with the passphrase method: reveal the field if Face ID
    /// is the default, type the passphrase, tap Unlock, wait for the signed-in
    /// bottom bar. With no passphrase configured (or a sign-in screen) it waits
    /// for the person holding the phone. The passphrase is never logged.
    /// Thrown instead of an XCTFail when a caller sweeping many routes wants
    /// to record one unreachable route and carry on.
    struct PerfRouteUnreachable: Error { let reason: String }

    /// Thrown to a sweeping caller when the launch sits on the sign-in
    /// screen: the Release truth lane has no automated sign-in (test mode is
    /// Debug-only by design), so nothing after it can be measured either.
    struct PerfSignedOut: Error {}

    /// `shellOptional`: the bottom bar's "One" tab is the usual sign that the
    /// app is signed in and unlocked, but a route that hides the shell (an
    /// import flow, a full-screen setup step) never shows it, and waiting for
    /// it there only burns the timeout. With this set, a submitted passphrase
    /// whose field has stayed gone for four seconds, with no mismatch banner,
    /// also counts, which is the signal the Android lane uses for the same
    /// reason. `failHard: false` throws PerfRouteUnreachable instead of
    /// failing the whole test.
    private func perfUnlockVault(
        _ app: XCUIApplication,
        passphrase: String,
        timeout: TimeInterval,
        shellOptional: Bool = false,
        failHard: Bool = true
    ) throws {
        // The clock starts when the passphrase field is on screen: a cold
        // launch can spend two minutes behind the system passkey sheet first.
        var deadline = Date().addingTimeInterval(timeout)
        var fieldSeen = false
        var attempts = 0
        var announced = false
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        var fieldGoneSince: Date?
        var signInScreenSince: Date?
        while Date() < deadline {
            if perfLabelExists(app, "One") {
                return
            }
            if !failHard {
                let signIn = app.webViews.buttons.matching(NSPredicate(
                    format: "label CONTAINS[c] %@ OR label CONTAINS[c] %@", "Continue with Apple", "Continue with Google"
                )).firstMatch
                if signIn.exists {
                    let since = signInScreenSince ?? Date()
                    signInScreenSince = since
                    if Date().timeIntervalSince(since) >= 5 {
                        NSLog("PERF_UNLOCK signed_out=true")
                        throw PerfSignedOut()
                    }
                } else {
                    signInScreenSince = nil
                }
            }
            if shellOptional && attempts > 0 {
                let gateField = app.webViews.secureTextFields.matching(NSPredicate(format: "label == %@ OR placeholderValue == %@", "Vault password", "Enter password")).firstMatch
                let rejected = app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "did not match")).firstMatch.exists
                if !gateField.exists && !rejected {
                    if let since = fieldGoneSince {
                        if Date().timeIntervalSince(since) >= 4 {
                            NSLog("PERF_UNLOCK ready=field-gone")
                            return
                        }
                    } else {
                        fieldGoneSince = Date()
                    }
                } else {
                    fieldGoneSince = nil
                }
            }
            // The vault gate opens the passkey flow at launch; with no passkey
            // on this phone iOS shows its "Scan QR Code" sheet over the app and
            // every tap below lands on it. Close it (X) and use the passphrase.
            let passkeySheet = springboard.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "Scan QR Code")).firstMatch
            if passkeySheet.exists {
                let close = springboard.buttons.matching(NSPredicate(format: "label IN %@", ["Close", "Cancel"])).firstMatch
                if close.exists {
                    close.tap()
                    NSLog("PERF_UNLOCK dismissed=passkey-sheet")
                    perfSettle(0.8)
                    continue
                }
            }
            let field = app.webViews.secureTextFields.matching(NSPredicate(format: "label == %@ OR placeholderValue == %@", "Vault password", "Enter password")).firstMatch
            if !field.exists && attempts == 0 && !passphrase.isEmpty {
                let reveal = app.webViews.buttons.matching(NSPredicate(format: "label == %@", "Password")).firstMatch
                if reveal.exists {
                    reveal.tap()
                    perfSettle(0.8)
                    continue
                }
            }
            let mismatch = app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "did not match")).firstMatch.exists
            // Type once, and again after a mismatch (a partial typeText was
            // observed when the sheet above stole focus mid-string), up to 3 times.
            if field.exists && !passphrase.isEmpty && (attempts == 0 || (mismatch && attempts < 3)) {
                if !fieldSeen {
                    fieldSeen = true
                    deadline = Date().addingTimeInterval(timeout)
                }
                NSLog("PERF_UNLOCK method=passphrase attempt=\(attempts + 1)")
                field.tap()
                perfSettle(0.4)
                if perfGateStop && attempts == 0 {
                    // Empty field, keyboard up: what a person sees first.
                    perfSettle(1.2)
                    NSLog("PERF_STOP name=gate-keyboard")
                    perfSettle(2.5)
                }
                if attempts > 0 {
                    field.press(forDuration: 1.0)
                    let selectAll = app.menuItems.matching(NSPredicate(format: "label == %@", "Select All")).firstMatch
                    if selectAll.waitForExistence(timeout: 1.5) {
                        selectAll.tap()
                        perfSettle(0.2)
                    }
                    field.typeText(XCUIKeyboardKey.delete.rawValue)
                    perfSettle(0.2)
                }
                field.typeText(passphrase)
                perfSettle(0.3)
                // A secure field reports one mask character per typed character.
                let typedCount = (field.value as? String)?.count ?? -1
                if typedCount != passphrase.count {
                    NSLog("PERF_UNLOCK typed_mismatch expected=\(passphrase.count) got=\(typedCount)")
                }
                let unlock = app.webViews.buttons.matching(NSPredicate(format: "label == %@", "Unlock")).firstMatch
                if unlock.exists && unlock.isHittable {
                    unlock.tap()
                } else {
                    field.typeText("\n")
                }
                attempts += 1
                perfSettle(2)
                continue
            }
            if !announced {
                NSLog("PERF_WAITING_FOR_HUMAN step=sign-in-and-unlock timeout_s=\(Int(timeout))")
                announced = true
            }
            perfSettle(1.0)
        }
        if !failHard {
            throw PerfRouteUnreachable(reason: "not signed in and unlocked within \(Int(timeout)) s")
        }
        XCTFail("The app was not signed in and unlocked within \(Int(timeout)) s.")
        throw XCTSkip("unlock timeout")
    }

    private func perfLabelExists(_ app: XCUIApplication, _ label: String) -> Bool {
        app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).count > 0
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

    // The same non-scroll gestures our card measures on its own shell, on the
    // reference app, so the comparison is not only a feed flick (founder ask,
    // 2026-09-20). Each gets its own method because XCTest keeps one metric
    // set per method. Tab switches in a UIKit tab bar are not animated, so
    // there is no hitch signpost for them: the clock metric records how long
    // the round of switches takes and the CPU metric what it cost. The pager
    // is a paging UIScrollView (dragging + deceleration signposts) and a post
    // open/close is a navigation push/pop (navigation transition signpost).
    func testThirdPartyBottomNavBenchmarkThreads() throws {
        try thirdPartyGestureBenchmark(name: "threads", bundleId: "com.burbn.barcelona", gesture: "bottom-nav-switch")
    }

    func testThirdPartyPagerSwipeBenchmarkThreads() throws {
        try thirdPartyGestureBenchmark(name: "threads", bundleId: "com.burbn.barcelona", gesture: "top-shell-pager-swipe")
    }

    func testThirdPartyOpenDismissBenchmarkThreads() throws {
        try thirdPartyGestureBenchmark(name: "threads", bundleId: "com.burbn.barcelona", gesture: "open-dismiss")
    }

    private func thirdPartyGestureBenchmark(name: String, bundleId: String, gesture: String) throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["HUSHH_ENABLE_THIRD_PARTY_SCROLL_BENCHMARK"] == "true" else {
            throw XCTSkip("Third-party benchmarks run only with HUSHH_ENABLE_THIRD_PARTY_SCROLL_BENCHMARK=true.")
        }
        let app = XCUIApplication(bundleIdentifier: bundleId)
        app.launch()
        guard app.wait(for: .runningForeground, timeout: 30) else {
            NSLog("PERF_SKIPPED name=\(name)-\(gesture) reason=did_not_launch")
            throw XCTSkip("\(name) is not installed or did not launch.")
        }
        perfSettle(5)
        NSLog("PERF_APP_READY app=\(name)")
        let options = XCTMeasureOptions()
        options.iterationCount = 3
        let start = perfEpochMs()
        switch gesture {
        case "bottom-nav-switch":
            let tabs = thirdPartyBottomTabs(app)
            guard tabs.count >= 2 else {
                NSLog("PERF_SKIPPED name=\(name)-\(gesture) reason=tab_bar_not_found tabs=\(tabs.count)")
                app.terminate()
                throw XCTSkip("no tab bar found in \(name)")
            }
            NSLog("PERF_NAV app=\(name) tabs=\(tabs.map { $0.label }.joined(separator: ","))")
            let home = tabs[0]
            let others = Array(tabs.dropFirst().prefix(4))
            measure(metrics: [XCTClockMetric(), XCTCPUMetric(application: app)], options: options) {
                for tab in others {
                    tab.tap()
                    perfSettle(0.7)
                    home.tap()
                    perfSettle(0.7)
                }
            }
            home.tap()
        case "top-shell-pager-swipe":
            measure(metrics: [XCTOSSignpostMetric.scrollDraggingMetric, XCTOSSignpostMetric.scrollDecelerationMetric, XCTCPUMetric(application: app)], options: options) {
                perfHorizontalSwipe(app, fromX: 0.85, toX: 0.15, y: 0.4)
                perfSettle(0.9)
                perfHorizontalSwipe(app, fromX: 0.15, toX: 0.85, y: 0.4)
                perfSettle(0.9)
            }
        default:
            measure(metrics: [XCTOSSignpostMetric.navigationTransitionMetric, XCTCPUMetric(application: app)], options: options) {
                for _ in 0..<3 {
                    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45)).tap()
                    perfSettle(1.2)
                    // The leading-edge back swipe is the dismiss every iOS app shares.
                    perfHorizontalSwipe(app, fromX: 0.02, toX: 0.9, y: 0.5)
                    perfSettle(0.9)
                }
            }
        }
        NSLog("PERF_GESTURE name=\(name)-\(gesture) rep=0 start_epoch_ms=\(start) end_epoch_ms=\(perfEpochMs())")
        app.terminate()
    }

    /// The reference app's bottom bar: a UIKit tab bar when it has one, else
    /// the hittable buttons in the bottom 12% of the screen, left to right,
    /// without the compose/create control (it opens an editor).
    private func thirdPartyBottomTabs(_ app: XCUIApplication) -> [XCUIElement] {
        let screen = app.frame
        let bottomBand = screen.height * 0.88
        let skip = NSPredicate(format: "NOT (label CONTAINS[c] 'create' OR label CONTAINS[c] 'compose' OR label CONTAINS[c] 'new thread' OR label CONTAINS[c] 'new post' OR label CONTAINS[c] 'write')")
        var candidates = app.tabBars.buttons.matching(skip).allElementsBoundByIndex
        if candidates.count < 2 {
            candidates = app.buttons.matching(skip).allElementsBoundByIndex.filter { element in
                let frame = element.frame
                return frame.minY >= bottomBand && frame.height < screen.height * 0.12 && element.isHittable
            }
        }
        return candidates.sorted { $0.frame.minX < $1.frame.minX }
    }

    private func perfHorizontalSwipe(_ app: XCUIApplication, fromX: CGFloat, toX: CGFloat, y: CGFloat) {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: fromX, dy: y))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: toX, dy: y))
        start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .fast, thenHoldForDuration: 0.0)
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
        // UITabBarItem labels are system-owned and need not be bare titles.
        // Prefer the authored item identifier already used for admission;
        // finding an item must not then tap a different DOM/label match.
        let tabKey = label == "One" ? "dashboard" : label.lowercased()
        let authoredTab = app.buttons["one-native-tab-\(tabKey)"].firstMatch
        let nativeTab = app.descendants(matching: .any)
            .matching(identifier: "one-native-navigation").firstMatch.buttons[label]
        func admittedNativeTarget() -> XCUIElement? {
            if authoredTab.exists && authoredTab.isHittable && authoredTab.isEnabled { return authoredTab }
            // UIKit can omit a UITabBarItem identifier while exposing its
            // title. The owned native bar bounds this fallback, never the DOM.
            if nativeTab.exists && nativeTab.isHittable && nativeTab.isEnabled { return nativeTab }
            return nil
        }
        // Keyboard and drawer dismissal complete independently. A hidden
        // keyboard is not proof that the navigation owner has re-admitted taps.
        // Never route through an inactive DOM duplicate during that handoff.
        let admission = app.buttons["native-navigation-presentation"].firstMatch
        if admission.exists {
            let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                admittedNativeTarget() != nil
            }, object: authoredTab)
            guard XCTWaiter.wait(for: [ready], timeout: 10) == .completed,
                  let target = admittedNativeTarget() else {
                reportNativeDockAdmission(app)
                XCTFail("NATIVE_NAVIGATION_TAP_NOT_ADMITTED"); return
            }
            target.tap()
            return
        }
        if authoredTab.exists && authoredTab.isHittable {
            authoredTab.tap()
            return
        }
        if nativeTab.exists && nativeTab.isHittable {
            nativeTab.tap()
            return
        }
        let candidates = app.webViews.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", label))
        let count = candidates.count
        guard count > 0 else {
            NSLog("PERF_SKIPPED name=nav-tap reason=label_not_found label=\(label)")
            return
        }
        // The bottom bar is the lowest match on screen. "Last in the tree"
        // picked the header's One/Puppy toggle on Chat, where "One" is also
        // the title, so a walk that tapped the One tab stayed on Chat.
        var element = candidates.element(boundBy: count - 1)
        var lowest = -CGFloat.greatestFiniteMagnitude
        for index in 0..<count {
            let candidate = candidates.element(boundBy: index)
            let frame = candidate.frame
            if !frame.isEmpty && frame.midY > lowest {
                lowest = frame.midY
                element = candidate
            }
        }
        if element.isHittable {
            element.tap()
        } else {
            element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        }
    }

    private func returnToRehearsalChat(_ app: XCUIApplication) {
        // Recover only authored dismissals left by this rehearsal. A failed
        // XCTest assertion can interrupt Swift defer, so do not assume a prior
        // drawer test restored its warm entry state. No account/fixture reset.
        let supportCancel = app.buttons["native-support-cancel"].firstMatch
        if supportCancel.exists {
            guard waitForAdmittedControl(supportCancel) else { return }
            supportCancel.tap()
            let retired = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: supportCancel)
            guard XCTWaiter.wait(for: [retired], timeout: 10) == .completed else { return }
        }
        let deleteConfirmation = app.alerts["Delete chat?"].firstMatch
        if deleteConfirmation.exists {
            let cancel = deleteConfirmation.buttons["Cancel"].firstMatch
            if waitForAdmittedControl(cancel) {
                cancel.tap()
                let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: deleteConfirmation)
                guard XCTWaiter.wait(for: [dismissed], timeout: 10) == .completed else { return }
            } else { return }
        }
        for label in ["Close One profile", "Close Profile", "Close chat history", "Close search"] {
            let close = app.buttons[label].firstMatch
            if close.exists && close.isHittable {
                close.tap()
                // A delivered tap is not completed retirement. Do not let
                // subsequent Back/Chat actions race the old interaction layer.
                let retired = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                    !close.exists || !close.isHittable
                }, object: close)
                guard XCTWaiter.wait(for: [retired], timeout: 10) == .completed else { return }
            }
        }
        // A roster entry can legitimately open unfinished capability setup,
        // where the dock is absent. Use the authored Back, not a cold route or
        // a test bootstrap, before returning through the normal Chat tab.
        for _ in 0..<3 {
            let profileBack = app.buttons["profile-back"].firstMatch
            if profileBack.exists && profileBack.isHittable {
                profileBack.tap()
                let profileClose = app.buttons["Close Profile"].firstMatch
                if waitForAdmittedControl(profileClose) { profileClose.tap() }
                continue
            }
            let chat = app.buttons["one-native-tab-chat"].firstMatch
            let webChat = app.webViews.buttons["Chat"].firstMatch
            if chat.exists && chat.isHittable || webChat.exists && webChat.isHittable {
                perfTapNav(app, label: "Chat")
                return
            }
            let back = app.buttons.matching(NSPredicate(format: "identifier == %@ OR label == %@", "top-shell-back", "Go back")).firstMatch
            guard back.exists && back.isHittable else { return }
            back.tap()
        }
    }

    /// Types a fixed prompt into the chat composer and sends it. Best effort:
    /// returns false when the composer cannot be found, so the card records a
    /// skip instead of failing.
    /// The composer lives on the canonical Chat route ("/"), not on /one:
    /// `<textarea aria-label="Message One">` with a `Send message` button.
    /// The caller puts the app on that route first.
    /// The chat exchange as a person does it, with the native keyboard in
    /// the loop (founder ask, 2026-09-21): tap the composer and let the
    /// keyboard rise, type the prompt through it, send, let the reply
    /// stream, then dismiss the keyboard. Each step is its own gesture so
    /// the frames the keyboard's rise, the typing and its dismissal cost are
    /// read apart from the reply itself.
    private func perfChatExchange(_ app: XCUIApplication, streamSeconds: TimeInterval) -> Bool {
        let composer = app.webViews.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", "Message One")).firstMatch
        guard composer.waitForExistence(timeout: 20) else { return false }

        var keyboardShown = false
        perfGesture("chat-keyboard-show", rep: 0) {
            composer.tap()
            // No accessibility polling while the keyboard rises (a WebView
            // snapshot blocks the page's main thread); one check after the
            // rise has settled.
            perfSettle(1.2)
            keyboardShown = app.keyboards.firstMatch.exists
            NSLog("PERF_KEYBOARD shown=\(keyboardShown ? 1 : 0)")
        }

        // Settled geometry, read outside the measured window: an accessibility
        // snapshot of the WebView runs on the app's main thread and would show
        // up as a long frame of its own. The composer belongs just above the
        // keyboard's edge; the gap is the number the summary carries.
        if keyboardShown {
            let window = app.windows.firstMatch.frame
            let keyRowsTop = app.keyboards.firstMatch.frame.minY
            // The QuickType strip sits above the key rows and outside the
            // keyboard element's frame; the keyboard's visible edge is the
            // strip's top when the strip is there.
            var keyboardTop = keyRowsTop
            let predictions = app.descendants(matching: .any)
                .matching(NSPredicate(format: "label CONTAINS[c] %@ OR identifier CONTAINS[c] %@", "predict", "predict")).firstMatch
            if predictions.exists {
                keyboardTop = min(keyboardTop, predictions.frame.minY)
            }
            let composerBottom = composer.frame.maxY
            NSLog("PERF_KEYBOARD_GEOMETRY window_h=\(Int(window.height)) keyboard_top=\(Int(keyboardTop)) key_rows_top=\(Int(keyRowsTop)) composer_bottom=\(Int(composerBottom)) gap=\(Int(keyboardTop - composerBottom))")
        }

        perfGesture("chat-keyboard-type", rep: 0) {
            composer.typeText("Summarize my week in three short bullet points.")
            perfSettle(0.8)
        }

        perfGesture("chat-stream-30s", rep: 0) {
            let send = app.webViews.buttons.matching(NSPredicate(format: "label == %@", "Send message")).firstMatch
            if send.exists {
                // A finger lands on the button's centre; XCTest's own hit
                // test can return no point for a lifted composer while the
                // button is plainly on screen, so the tap goes by coordinate.
                send.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            } else {
                composer.typeText("\n")
            }
            perfSettle(streamSeconds)
        }

        perfGesture("chat-keyboard-dismiss", rep: 0) {
            // A tap on the transcript, above the composer, is how a person
            // puts the keyboard away here; fall back to the keyboard's own
            // dismiss control when the tap does not take it down.
            let keyboard = app.keyboards.firstMatch
            if keyboard.exists {
                app.webViews.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).tap()
                perfSettle(0.8)
                if keyboard.exists {
                    let dismiss = app.keyboards.buttons.matching(NSPredicate(format: "label IN %@", ["Hide keyboard", "Dismiss", "Done"])).firstMatch
                    if dismiss.exists { dismiss.tap() }
                }
            }
            perfSettle(1.2)
            NSLog("PERF_KEYBOARD dismissed=\(app.keyboards.firstMatch.exists ? 0 : 1)")
        }

        // A second rise in the same session: the system keyboard's first
        // presentation has a cost of its own, and only a repeat separates
        // that from what the page does when the keyboard comes up.
        perfGesture("chat-keyboard-show-2", rep: 0) {
            composer.tap()
            perfSettle(1.2)
            NSLog("PERF_KEYBOARD shown_again=\(app.keyboards.firstMatch.exists ? 1 : 0)")
        }
        perfGesture("chat-keyboard-dismiss-2", rep: 0) {
            if app.keyboards.firstMatch.exists {
                app.webViews.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).tap()
            }
            perfSettle(1.2)
        }

        // The transcript ride: a flick up hides the bottom chrome and the
        // composer rides down with it, a flick down brings both back. The
        // probe reads the two bars' transforms per frame during these.
        let webView = app.webViews.firstMatch
        for rep in 0..<2 {
            perfGesture("chat-transcript-flick", rep: rep) {
                perfFlick(webView, fromY: 0.55, toY: 0.25)
                perfSettle(0.9)
                perfFlick(webView, fromY: 0.25, toY: 0.55)
                perfSettle(0.9)
            }
        }
        return true
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
            app.launchEnvironment["HUSHH_UI_TEST_REVIEWER_UID"] = reviewerUid
        }
        if let vaultPassphrase = environment["HUSHH_UI_TEST_REVIEWER_VAULT_PASSPHRASE"] ?? environment["REVIEWER_VAULT_PASSPHRASE"],
           !vaultPassphrase.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            app.launchEnvironment["HUSHH_UI_TEST_REVIEWER_VAULT_PASSPHRASE"] = vaultPassphrase
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
