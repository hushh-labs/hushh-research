import XCTest
import SwiftUI
import WebKit
import Capacitor
@testable import App

final class NativeSupportTests: XCTestCase {
    @MainActor
    func testInstalledProfileBackCapabilityMatchesItsAdmittedFamily() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let host = try XCTUnwrap(scene.windows.compactMap { $0.rootViewController as? CAPBridgeViewController }.first)
        let plugin = try XCTUnwrap(host.bridge?.plugin(withName: "HushhNativeChrome") as? HushhNativeChromePlugin)
        let receipt = expectation(description: "Actual native capability, not a mocked JS flag")
        let call = CAPPluginCall(callbackId: "public-capability", methodName: "getCapabilities", options: [:], success: { result, _ in
            defer { receipt.fulfill() }
            guard case let .dictionary(value)? = result?.resultData,
                  let families = value["families"] as? [String], let replacement = value["profileBackReplacement"] as? Bool else {
                XCTFail("NATIVE_PROFILE_CAPABILITY_UNAVAILABLE"); return
            }
            XCTAssertEqual(replacement, families.contains("profile-back"),
                "Admitted Profile Back must advertise its retained binding replacement")
        }, error: { _ in XCTFail("NATIVE_PROFILE_CAPABILITY_REFUSED"); receipt.fulfill() })
        plugin.getCapabilities(try XCTUnwrap(call))
        await fulfillment(of: [receipt], timeout: 3)
    }

    @MainActor
    func testOrdinarySheetRetirementWaitsForOpeningAndOwnedPopupCompletion() async throws {
        let windowScene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previous = windowScene.windows.first(where: \.isKeyWindow)
        let parent = UIViewController()
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = parent; window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil; previous?.makeKeyAndVisible() }
        var cleared = false, finished = false
        var popupCompletion: (() -> Void)?
        let sheet = NativeProfileOwnedSheet(makeHost: { UIViewController() }, canPresent: { !cleared },
            canDismiss: { true }, hasPending: { false }, appearance: { nil }, cancel: {}, clear: { cleared = true },
            dismissPopups: { popupCompletion = $0 })
        let shown = expectation(description: "Opening finishes without admitting a retired form")
        XCTAssertTrue(sheet.present(from: parent) { accepted in XCTAssertFalse(accepted); shown.fulfill() })
        let first = expectation(description: "Actual sheet disappearance")
        let joined = expectation(description: "Joined retirement")
        sheet.retire { XCTAssertNil(parent.presentedViewController); finished = true; first.fulfill() }
        sheet.retire { XCTAssertNil(parent.presentedViewController); joined.fulfill() }
        XCTAssertTrue(cleared)
        XCTAssertTrue(sheet.coversPresentation)
        await fulfillment(of: [shown], timeout: 3)
        XCTAssertFalse(finished, "A disappearing trigger is not popup retirement proof")
        try XCTUnwrap(popupCompletion)()
        await fulfillment(of: [first, joined], timeout: 3)
        XCTAssertFalse(sheet.coversPresentation)
    }

    @MainActor
    func testWritingStyleRequiresAcknowledgedEditsAndScrubsBeforeMenuRetirement() async throws {
        let object: [String: Any] = ["documentId": "public-style-document", "ownerEpoch": "public-style-owner", "ownerGeneration": 1,
            "revision": 1, "family": "profile", "scene": "writing-style", "updateSequence": 1, "privacyGeneration": 0,
            "draftRevision": 0, "acknowledgedEditRevision": 0, "draft": ["tone": "warm"],
            "choices": ["tone": [["value": "warm", "label": "Warm"], ["value": "direct", "label": "Direct"]],
                        "length": [["value": "short", "label": "Short"]], "language": [["value": "en", "label": "English"]]],
            "canSave": true, "busy": false, "unavailable": false, "suggested": false, "error": NSNull(),
            "appearance": "light", "accentHex": "#007aff", "foregroundHex": "#808080"]
        let state = try JSONDecoder().decode(NativeProfileStyleProjection.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertTrue(state.valid)
        XCTAssertFalse(state.validValue(.text("invented"), field: "tone"))
        XCTAssertFalse(state.validValue(.flag(true), field: "vaultKey"))
        let model = NativeProfileStyleModel(state)
        var changes = 0
        model.edit = { field, value, _, _ in changes += 1; return field == "tone" && value == .text("direct") }
        model.change("tone", .text("direct"))
        XCTAssertEqual(changes, 1)
        XCTAssertFalse(model.canSave)
        var updated = object
        updated["updateSequence"] = 2; updated["draftRevision"] = 1; updated["acknowledgedEditRevision"] = 1
        updated["draft"] = ["tone": "direct"]
        let next = try JSONDecoder().decode(NativeProfileStyleProjection.self, from: JSONSerialization.data(withJSONObject: updated))
        XCTAssertTrue(model.update(next))
        XCTAssertTrue(model.canSave)
        var action: NativeProfileNameAction?
        model.choose = { action = $0; return true }
        model.action("save")
        let intent = try XCTUnwrap(action)
        XCTAssertTrue(model.confirm(intent)); XCTAssertFalse(model.confirm(intent))
        XCTAssertTrue(model.settle(intent, saved: true)); XCTAssertTrue(model.saved)
        XCTAssertTrue(model.canEdit, "Explicit Save stays in the existing Settings editor")
        let binding = NativeProfileStyleMenuBinding(next)
        updated["updateSequence"] = 3; updated["appearance"] = "dark"
        let themed = try JSONDecoder().decode(NativeProfileStyleProjection.self, from: JSONSerialization.data(withJSONObject: updated))
        XCTAssertTrue(model.update(themed))
        model.edit = { field, value, _, _ in field == "tone" && value == .text("warm") }
        model.chooseOption("tone", value: .text("warm"), from: binding)
        XCTAssertTrue(model.draft["tone"] == .text("warm"), "A compatible appearance update cannot invalidate an open menu")
        updated["updateSequence"] = 4; updated["draftRevision"] = 2; updated["acknowledgedEditRevision"] = 2
        updated["draft"] = ["tone": "warm"]
        XCTAssertTrue(model.update(try JSONDecoder().decode(NativeProfileStyleProjection.self, from: JSONSerialization.data(withJSONObject: updated))))
        let menu = NativeDrawerMenuControl(type: .system)
        model.register(menu)
        let interaction = UIContextMenuInteraction(delegate: menu)
        let config = UIContextMenuConfiguration(identifier: nil, previewProvider: nil, actionProvider: nil)
        menu.contextMenuInteraction(interaction, willDisplayMenuFor: config, animator: nil)
        XCTAssertFalse(model.canSave); XCTAssertFalse(model.canDismiss)
        model.withdraw(menu)
        XCTAssertFalse(model.canSave, "A removed trigger still owns its visible popup")
        XCTAssertFalse(model.canDismiss)
        if #available(iOS 26.0, *) {
            let field = UITextView()
            model.register(field)
            let delegate = NativeProfileStyleText.Coordinator(model, "preferred_name", false)
            XCTAssertTrue(delegate.textView(field, shouldChangeTextIn: NSRange(location: 0, length: 0), replacementText: "Ada\nLovelace"),
                          "A multiline paste is not a Return key and cannot dismiss the editor")
            model.edit = { _, _, _, _ in true }
            XCTAssertFalse(delegate.textView(field, shouldChangeTextIn: NSRange(location: 0, length: 0), replacementText: "\n"))
        }
        var disappeared = false
        let ended = expectation(description: "Owned menu completed disappearance")
        model.clear()
        model.dismissMenus { disappeared = true; ended.fulfill() }
        XCTAssertTrue(model.draft.isEmpty); XCTAssertTrue(model.projection.draft.isEmpty)
        XCTAssertFalse(disappeared)
        menu.contextMenuInteraction(interaction, willEndFor: config, animator: nil)
        await fulfillment(of: [ended], timeout: 3)
        XCTAssertTrue(disappeared)
        XCTAssertFalse(model.canEdit); XCTAssertNil(model.edit); XCTAssertNil(model.choose)
    }
    @MainActor
    func testOrdinaryNameSheetReleasesGestureLockAndWaitsForUIKitRetirement() async throws {
        guard #available(iOS 26.0, *) else { throw XCTSkip("Native ordinary scene requires iOS 26") }
        let windowScene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previous = windowScene.windows.first(where: \.isKeyWindow)
        let parent = UIViewController()
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = parent
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil; previous?.makeKeyAndVisible() }
        let scene = NativeProfileNameScene(publicNameScene())
        let shown = expectation(description: "Public ordinary scene presented")
        XCTAssertTrue(scene.present(from: parent) { admitted in XCTAssertTrue(admitted); shown.fulfill() })
        await fulfillment(of: [shown], timeout: 3)
        let presented = try XCTUnwrap(parent.presentedViewController)
        var action: NativeProfileNameAction?
        scene.model.choose = { action = $0; return true }
        scene.model.action("save")
        let pending = try XCTUnwrap(action)
        XCTAssertTrue(scene.update(publicNameScene(update: 2, appearance: "dark")))
        XCTAssertTrue(presented.isModalInPresentation)
        XCTAssertTrue(scene.settle(pending))
        XCTAssertFalse(presented.isModalInPresentation, "Rejected/refused Save must restore native drag dismissal")
        let first = expectation(description: "First actual dismissal observer")
        let second = expectation(description: "Joined actual dismissal observer")
        scene.retire { XCTAssertNil(parent.presentedViewController); first.fulfill() }
        XCTAssertTrue(scene.model.retired)
        XCTAssertTrue(scene.model.text.isEmpty, "Private replica must clear before dismissal completes")
        scene.retire { XCTAssertNil(parent.presentedViewController); second.fulfill() }
        await fulfillment(of: [first, second], timeout: 3)
        XCTAssertFalse(scene.coversPresentation)
    }

    private func publicNameScene(update: Int = 1, ack: Int = 0, draft: String = "Public Example",
                                 appearance: String = "light") -> NativeProfileNameProjection {
        NativeProfileNameProjection(documentId: "public-name-document", ownerEpoch: "public-name-owner", ownerGeneration: 1,
            revision: 1, family: "profile", scene: "account-name", updateSequence: update, privacyGeneration: 0,
            draftRevision: update, acknowledgedEditRevision: ack, draft: draft, canSave: true, busy: false,
            error: "Public validation sample", appearance: appearance, accentHex: "#007aff", foregroundHex: "#808080")
    }
    @MainActor
    func testOrdinaryNameSceneRequiresAnAcknowledgedEditAndOneConfirmedSave() throws {
        let model = NativeProfileNameModel(publicNameScene())
        let field = UITextField()
        model.editor = field
        var edits = 0
        model.edit = { _, _, revision in edits += 1; return revision == 1 }
        var choice: NativeProfileNameAction?
        model.choose = { choice = $0; return true }
        field.text = "Public New Name"
        model.capture(field)
        XCTAssertEqual(edits, 1)
        XCTAssertFalse(model.canSave)
        model.action("save")
        XCTAssertNil(choice, "An old Save projection cannot submit the native editor's newer text")
        XCTAssertTrue(model.update(publicNameScene(update: 2, ack: 0, appearance: "dark")))
        XCTAssertEqual(model.text, "Public New Name", "A theme echo cannot replace unacknowledged editing")
        XCTAssertTrue(model.update(publicNameScene(update: 3, ack: 1, draft: "Public New Name", appearance: "dark")))
        XCTAssertTrue(model.canSave)
        model.action("save")
        let action = try XCTUnwrap(choice)
        XCTAssertFalse(model.confirm(NativeProfileNameAction(updateSequence: 3, editRevision: 0, sequence: action.sequence, action: "save")))
        XCTAssertTrue(model.confirm(action))
        XCTAssertFalse(model.confirm(action), "A duplicate acknowledgement cannot authorize another write")
        XCTAssertFalse(model.canEdit)
        XCTAssertTrue(model.settle(action))
        XCTAssertTrue(model.canEdit)
        XCTAssertTrue(model.editor === field)
    }
    @MainActor
    func testNameSceneRetirementScrubsItsPrivateReplicaBeforeDismissing() {
        let model = NativeProfileNameModel(publicNameScene())
        let field = UITextField()
        model.editor = field
        field.text = "Public Unsaved Name"
        model.edit = { _, _, _ in true }
        model.capture(field)
        model.clear()
        XCTAssertEqual(model.text, "")
        XCTAssertEqual(model.projection.draft, "")
        XCTAssertNil(model.projection.error)
        XCTAssertEqual(field.text, "")
        XCTAssertNil(model.edit)
        XCTAssertNil(model.choose)
        XCTAssertFalse(model.canEdit)
        XCTAssertFalse(model.canSave)
        XCTAssertFalse(model.update(publicNameScene(update: 2)))
    }

    #if DEBUG
    func testControlHitEvidenceDetectsWindowInterceptionWithoutGrantingAdmission() throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 1194, height: 834))
        let web = WKWebView(frame: window.bounds)
        let container = NativePresentationContainer(webView: web, basePresentation: .coherentDrawers)
        window.addSubview(container)
        window.isHidden = false
        defer { window.isHidden = true }
        let control = UIButton(frame: CGRect(x: 24, y: 72, width: 44, height: 44))
        container.install(control, id: "chat-history-toggle", group: nil)
        container.setAdmission("chat-history-toggle", admitted: true)
        let initial = try XCTUnwrap(container.controlHitEvidence("chat-history-toggle"))
        XCTAssertEqual(initial.containerHits, Array(repeating: .target, count: 5))
        XCTAssertEqual(initial.windowHits, initial.containerHits)
        // Negative control: unchanged geometry/admission, but a sibling above
        // the container intercepts the actual window-level touch target.
        let interceptor = UIView(frame: control.frame)
        window.addSubview(interceptor)
        let covered = try XCTUnwrap(container.controlHitEvidence("chat-history-toggle"))
        XCTAssertEqual(covered.frame, initial.frame)
        XCTAssertEqual(covered.containerHits, initial.containerHits)
        XCTAssertEqual(covered.windowHits, Array(repeating: .other, count: 5))
        interceptor.removeFromSuperview()
        container.setAdmission("chat-history-toggle", admitted: false)
        let withdrawn = try XCTUnwrap(container.controlHitEvidence("chat-history-toggle"))
        XCTAssertFalse(withdrawn.admitted)
        XCTAssertTrue(withdrawn.touchBlocked)
        XCTAssertTrue(withdrawn.axHidden)
        XCTAssertFalse(withdrawn.windowHits.contains(.target))
        XCTAssertFalse(control.isUserInteractionEnabled, "Observing a withdrawn lease must not restore its actions")
    }
    #endif

    func testNativeProfileUsesTheBundledWebArtworkAndRejectsUnknownIds() throws {
        XCTAssertEqual(NativeProfileArtwork.ids.count, 15)
        for id in NativeProfileArtwork.ids {
            let artwork = try XCTUnwrap(NativeProfileArtwork.resolve(id), "Missing shared Profile artwork")
            XCTAssertEqual(artwork.base.size, CGSize(width: 28, height: 28))
            XCTAssertEqual(artwork.base.renderingMode, .alwaysTemplate)
            XCTAssertEqual(artwork.accent != nil, ["payouts", "request-pricing", "my-data", "world-model"].contains(id))
        }
        XCTAssertEqual(NativeProfileArtwork.resolve("account")?.colorHex, "#2563EB")
        XCTAssertNil(NativeProfileArtwork.resolve("privacy")?.colorHex, "Semantic foreground stays theme-aware")
        XCTAssertNil(NativeProfileArtwork.resolve("../../private"))
        XCTAssertNil(NativeProfileArtwork.resolve("unknown"))
    }
    func testCoherentDeviceAdmissionAndProfileGeometryPreservePlatformFallbacks() {
        XCTAssertFalse(NativeDrawerQualificationPolicy.admits(.pad, enabled: true, coherentShell: false))
        XCTAssertFalse(NativeDrawerQualificationPolicy.admits(.phone, enabled: false, coherentShell: false))
        XCTAssertTrue(NativeDrawerQualificationPolicy.admits(.pad, enabled: true, coherentShell: true))
        XCTAssertFalse(NativeDrawerQualificationPolicy.admits(.tv, enabled: true, coherentShell: true))
        for bounds in [CGRect(x: 0, y: 0, width: 390, height: 844), CGRect(x: 0, y: 0, width: 844, height: 390)] {
            XCTAssertEqual(NativeDrawerLayout.frame(family: "profile", in: bounds, phone: true), bounds)
            XCTAssertEqual(NativeDrawerLayout.frame(family: "history", in: bounds, phone: true), bounds)
        }
        let compact = CGRect(x: 0, y: 0, width: 639, height: 834)
        XCTAssertEqual(NativeDrawerLayout.frame(family: "profile", in: compact, phone: false), compact)
        let tablet = CGRect(x: 0, y: 0, width: 1194, height: 834)
        let frame = NativeDrawerLayout.frame(family: "profile", in: tablet, phone: false)
        XCTAssertEqual(frame.width, 430)
        XCTAssertEqual(frame.minY, tablet.minY)
        XCTAssertEqual(frame.maxY, tablet.maxY)
        XCTAssertEqual(tablet.maxX - frame.maxX, 18)
        XCTAssertTrue(tablet.contains(frame))
        let travel = NativeDrawerLayout.travel(family: "profile", frame: frame, in: tablet)
        XCTAssertEqual(travel, 448)
        XCTAssertGreaterThanOrEqual(frame.offsetBy(dx: travel, dy: 0).minX, tablet.maxX)
        XCTAssertLessThan(frame.offsetBy(dx: frame.width, dy: 0).minX, tablet.maxX,
            "Negative control: width-only travel leaves the inset tablet panel exposed")
    }
    @MainActor
    func testDrawerBootstrapUsesTheFinalCapacitorContentController() {
        let controller = MyViewController()
        let configuration = WKWebViewConfiguration()
        // Capacitor replaces the content controller after webViewConfiguration.
        // Renderer bootstrap must reach the final configuration used by WK.
        configuration.userContentController = WKUserContentController()
        let web = controller.webView(with: .zero, configuration: configuration)
        let scripts = web.configuration.userContentController.userScripts.filter {
            $0.source.contains("__HUSHH_NATIVE_DRAWER_BOOTSTRAP__")
        }
        XCTAssertEqual(scripts.count, 1, "Bootstrap was lost before the document could choose its renderer")
        XCTAssertEqual(scripts.first?.injectionTime, .atDocumentStart)
        XCTAssertEqual(scripts.first?.isForMainFrameOnly, true)
    }

    private func privateDrawerState(family: String = "profile", open: Bool = true,
                                   owner: String = "opaque-owner", revision: Int = 1, update: Int = 1,
                                   appearance: String = "light", privacy: Int = 0, enabled: Bool = true,
                                   sampleRow: NativeDrawerRow? = nil, backEnabled: Bool = false) -> NativeDrawerProjection {
        NativeDrawerProjection(documentId: "public-document", ownerEpoch: owner, ownerGeneration: revision, revision: revision, family: family,
            updateSequence: update, privacyGeneration: privacy, appearance: appearance, accentHex: "#007aff", foregroundHex: "#000000",
            title: "Public sample", sections: [NativeDrawerSection(id: "settings", title: "Settings",
                rows: [sampleRow ?? NativeDrawerRow(id: "row-handle", label: "Appearance", detail: nil, symbol: "circle.lefthalf.filled",
                    enabled: true, destructive: nil, selected: nil, pending: nil)])],
            open: open, enabled: enabled, backEnabled: backEnabled)
    }

    @MainActor
    func testRenderedHistoryTitleSharesAgeFlowAndStaysCenteredBesideA44PointMenu() async throws {
        // Actual shared SwiftUI content, not a lookalike or private transcript.
        func measure(_ title: String, age: String?, size: DynamicTypeSize = .large) async throws -> NativeHistoryRowLayout {
            let row = NativeDrawerRow(id: "public-row", label: title, detail: age, symbol: nil,
                enabled: true, destructive: nil, selected: nil, pending: nil, renameActionId: "public-rename")
            let model = NativeDrawerModel(privateDrawerState(family: "history", sampleRow: row))
            model.interactionEnabled = true
            var measured: [NativeHistoryLayoutPart: CGRect] = [:]
            let host = UIHostingController(rootView: NativeDrawerContent(model: model, historyLayoutObserver: { id, part, frame in
                if id == "public-row" { measured[part] = frame }
            }).environment(\.dynamicTypeSize, size))
            let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
            let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 343, height: 844))
            window.windowScene = scene
            window.rootViewController = host
            window.makeKeyAndVisible()
            defer {
                window.isHidden = true; window.rootViewController = nil
                previousKeyWindow?.makeKeyAndVisible()
            }
            host.view.layoutIfNeeded()
            let rendered = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                [NativeHistoryLayoutPart.title, .row, .more].allSatisfy {
                    guard let frame = measured[$0] else { return false }
                    return frame.width > 0 && frame.height > 0 && frame.minX.isFinite && frame.minY.isFinite
                }
            }, object: nil)
            await fulfillment(of: [rendered], timeout: 3)
            let layout = NativeHistoryRowLayout(title: try XCTUnwrap(measured[.title]),
                row: try XCTUnwrap(measured[.row]), more: try XCTUnwrap(measured[.more]))
            XCTAssertEqual(layout.title.midY, layout.row.midY, accuracy: 1)
            XCTAssertLessThanOrEqual(layout.title.maxX, layout.more.minX + 1)
            XCTAssertGreaterThanOrEqual(layout.row.height, 44 - 1e-6,
                "Ignore only floating-point roundoff, never an undersized hit region")
            XCTAssertEqual(layout.more.width, 44, accuracy: 1)
            XCTAssertEqual(layout.more.height, 44, accuracy: 1)
            return layout
        }
        let titleOnly = try await measure("Weekend", age: nil)
        let inlineAge = try await measure("Weekend", age: "2h")
        XCTAssertGreaterThan(inlineAge.title.width, titleOnly.title.width + 5,
            "Rendered age must extend the title's own text flow, not disappear or occupy another track")
        XCTAssertEqual(inlineAge.title.height, titleOnly.title.height, accuracy: 1,
            "Short title and age share one rendered line")
        let long = try await measure("A public conversation title that remains available without changing the More track", age: "2h")
        XCTAssertEqual(long.row.height, inlineAge.row.height, accuracy: 1,
            "Long titles and timestamps must not create uneven default row heights")
        let enlarged = try await measure("Weekend", age: "2h", size: .accessibility3)
        XCTAssertGreaterThan(enlarged.title.height, inlineAge.title.height + 5,
            "Dynamic Type must enlarge the rendered title while preserving centering and menu geometry")
    }

    func testPrivateDrawerRenameBindsTheExactEmittedTextAndRejectsUnboundedInput() throws {
        var state = privateDrawerState(family: "history")
        var row = state.sections[0].rows[0]
        row.renameActionId = "rename"; row.deleteActionId = "delete"
        let options = try JSONSerialization.jsonObject(with: JSONEncoder().encode(state)) as! [String: Any]
        var rewritten = options
        rewritten["sections"] = [["id": "history", "rows": [try JSONSerialization.jsonObject(with: JSONEncoder().encode(row))]]]
        state = try JSONDecoder().decode(NativeDrawerProjection.self, from: JSONSerialization.data(withJSONObject: rewritten))
        var lease = NativeDrawerLease()
        XCTAssertTrue(lease.apply(state))
        XCTAssertNil(lease.emit(action: "row", row: "rename", state: state, text: " "))
        XCTAssertNil(lease.emit(action: "row", row: "rename", state: state, text: String(repeating: "a", count: 161)))
        XCTAssertNil(lease.emit(action: "row", row: "delete", state: state, text: "not admitted"))
        let sequence = try XCTUnwrap(lease.emit(action: "row", row: "rename", state: state, text: "Public title"))
        XCTAssertFalse(lease.confirm(identity: state.identity, update: 1, privacy: 0, sequence: sequence, interaction: 1,
            action: "row", row: "rename", allowed: true, text: "Altered title"))
        XCTAssertTrue(lease.confirm(identity: state.identity, update: 1, privacy: 0, sequence: sequence, interaction: 1,
            action: "row", row: "rename", allowed: true, text: "Public title"))
        XCTAssertTrue(lease.acceptsSettlement(identity: state.identity, privacy: 0, sequence: sequence))
        XCTAssertFalse(lease.acceptsSettlement(identity: state.identity, privacy: 1, sequence: sequence))
        XCTAssertFalse(lease.acceptsSettlement(identity: state.identity, privacy: 0, sequence: sequence + 1))
        let cancelled = try XCTUnwrap(lease.emit(action: "row", row: "rename", state: state, text: "Public draft"))
        XCTAssertFalse(lease.settle(identity: state.identity, privacy: 0, sequence: cancelled, success: true),
            "An unconfirmed choice can only be cancelled, not declared successful")
        XCTAssertTrue(lease.settle(identity: state.identity, privacy: 0, sequence: cancelled, success: false))
        XCTAssertFalse(lease.confirm(identity: state.identity, update: 1, privacy: 0, sequence: cancelled, interaction: 1,
            action: "row", row: "rename", allowed: true, text: "Public draft"))
        _ = lease.retire(state.identity)
        XCTAssertFalse(lease.acceptsSettlement(identity: state.identity, privacy: 0, sequence: sequence))
    }

    @MainActor
    func testPrivateDrawerRefreshCannotInferOperationCompletionOrClearANewerDraft() {
        let state = privateDrawerState(family: "history")
        let model = NativeDrawerModel(state)
        model.detailRow = "row-handle"; model.detailMode = "rename"; model.renameDraft = "Public title"
        model.pendingSequence = 1; model.choicePending = true
        model.update(privateDrawerState(family: "history", update: 2, appearance: "dark"))
        XCTAssertTrue(model.choicePending)
        XCTAssertEqual(model.renameDraft, "Public title")
        model.settle(sequence: 2, success: true)
        XCTAssertTrue(model.choicePending, "An obsolete settlement cannot close another editor")
        model.settle(sequence: 1, success: false)
        XCTAssertFalse(model.choicePending)
        XCTAssertEqual(model.renameDraft, "Public title", "Confirmed failure preserves a retryable draft")
        model.pendingSequence = 3; model.choicePending = true
        model.settle(sequence: 1, success: true)
        XCTAssertTrue(model.choicePending)
        model.settle(sequence: 3, success: true)
        XCTAssertNil(model.detailRow, "An explicit success completes even a same-title rename")
    }

    func testProfileRowPresentationIsBoundedAndDoesNotAlterChoiceAuthority() throws {
        let state = privateDrawerState()
        let original = try JSONSerialization.jsonObject(with: JSONEncoder().encode(state)) as! [String: Any]
        func projected(_ fields: [String: Any]) throws -> NativeDrawerProjection {
            var options = original
            var sections = options["sections"] as! [[String: Any]]
            var rows = sections[0]["rows"] as! [[String: Any]]
            fields.forEach { rows[0][$0.key] = $0.value }
            sections[0]["rows"] = rows; options["sections"] = sections
            XCTAssertTrue(NativeDrawerProjection.hasClosedShape(options))
            return try JSONDecoder().decode(NativeDrawerProjection.self, from: JSONSerialization.data(withJSONObject: options))
        }
        let presentation = try projected(["iconHex": "#8B5CF6", "chevron": true, "trailing": "Local"])
        XCTAssertTrue(presentation.valid)
        XCTAssertTrue(presentation.allows(action: "row", row: "row-handle"))
        XCTAssertFalse(presentation.allows(action: "row", row: "not-authored"))
        XCTAssertFalse(try projected(["iconHex": "https://example.test"]).valid)
        XCTAssertFalse(try projected(["trailing": String(repeating: "x", count: 33)]).valid)
    }

    func testPrivateNativeDrawerRejectsStaleOwnersAndConsumesOnlyEmittedChoices() {
        var lease = NativeDrawerLease()
        let state = privateDrawerState()
        var options = try! JSONSerialization.jsonObject(with: JSONEncoder().encode(state)) as! [String: Any]
        XCTAssertTrue(NativeDrawerProjection.hasClosedShape(options))
        options["undeclaredPayload"] = "synthetic"
        XCTAssertFalse(NativeDrawerProjection.hasClosedShape(options), "Private projections must reject arbitrary bridge fields")
        options.removeValue(forKey: "undeclaredPayload")
        var sections = options["sections"] as! [[String: Any]]
        var rows = sections[0]["rows"] as! [[String: Any]]
        rows[0]["undeclaredPayload"] = "synthetic"
        sections[0]["rows"] = rows; options["sections"] = sections
        XCTAssertFalse(NativeDrawerProjection.hasClosedShape(options))
        XCTAssertTrue(lease.apply(state))
        XCTAssertNil(lease.emit(action: "row", row: "not-authored", state: state))
        let sequence = lease.emit(action: "row", row: "row-handle", state: state)!
        XCTAssertFalse(lease.confirm(identity: state.identity, update: 1, privacy: 0, sequence: sequence, interaction: 1,
            action: "row", row: "not-authored", allowed: true))
        XCTAssertTrue(lease.confirm(identity: state.identity, update: 1, privacy: 0, sequence: sequence, interaction: 1,
            action: "row", row: "row-handle", allowed: true))
        XCTAssertFalse(lease.confirm(identity: state.identity, update: 1, privacy: 0, sequence: sequence, interaction: 1,
            action: "row", row: "row-handle", allowed: true))
        let pending = lease.emit(action: "row", row: "row-handle", state: state)!
        let replacement = privateDrawerState(owner: "replacement", revision: 2)
        XCTAssertTrue(lease.apply(replacement))
        XCTAssertFalse(lease.retire(state.identity), "An old retirement cannot remove a replacement")
        XCTAssertFalse(lease.confirm(identity: state.identity, update: 1, privacy: 0, sequence: pending, interaction: 1,
            action: "row", row: "row-handle", allowed: true))
        XCTAssertFalse(lease.apply(state))
        XCTAssertTrue(lease.retire(replacement.identity))
        XCTAssertFalse(lease.apply(privateDrawerState(owner: "replacement", revision: 2, update: 2)),
            "Privacy retirement requires a newly bound presentation, not an old lease")
        var session = NativeDrawerSessionFence()
        XCTAssertTrue(session.admit(state.identity))
        XCTAssertTrue(session.admit(replacement.identity))
        XCTAssertFalse(session.contains(privateDrawerState(family: "history").identity))
        XCTAssertFalse(session.admit(privateDrawerState(family: "history", update: 9).identity),
            "Late projections cannot revive the other departing-owner family")
        var moving = NativeDrawerLease()
        XCTAssertTrue(moving.apply(state))
        let emitted = try! XCTUnwrap(moving.emit(action: "row", row: "row-handle", state: state))
        moving.invalidateInteractions()
        XCTAssertFalse(moving.confirm(identity: state.identity, update: 1, privacy: 0, sequence: emitted,
            interaction: 1, action: "row", row: "row-handle", allowed: true),
            "A closing drag invalidates a pending row action even before React updates")
        var cancelledPreparation = NativeDrawerLease()
        XCTAssertTrue(cancelledPreparation.retire(state.identity))
        XCTAssertFalse(cancelledPreparation.apply(state), "A lost apply cannot resurrect a cancelled private body")
        XCTAssertTrue(cancelledPreparation.retire(state.identity), "Exact absence proof is idempotent")
    }

    @MainActor
    func testHistoryMenuRetirementWaitsForDisappearanceAndRejectsItsOldChoice() throws {
        let controller = NativeDrawerPresentationController(privateDrawerState(family: "history"))
        controller.loadViewIfNeeded()
        let menu = NativeDrawerMenuControl(type: .system)
        controller.model.registerMenu(menu)
        let interaction = UIContextMenuInteraction(delegate: menu)
        let configuration = UIContextMenuConfiguration(identifier: nil, previewProvider: nil, actionProvider: nil)
        menu.contextMenuInteraction(interaction, willDisplayMenuFor: configuration, animator: nil)
        var acted = false
        menu.afterDismissal { acted = true }
        var retired = false
        controller.retire { retired = true }
        XCTAssertFalse(retired, "A removed menu trigger cannot acknowledge native popup absence")
        XCTAssertTrue(controller.coversUnderlyingPresentation,
            "Leaving the active registry cannot release touch isolation before popup disappearance")
        XCTAssertFalse(controller.children.isEmpty)
        let animator = OwnedMenuTestAnimator()
        menu.contextMenuInteraction(interaction, willEndFor: configuration, animator: animator)
        XCTAssertFalse(retired, "willEnd is not completed disappearance")
        animator.finish()
        XCTAssertTrue(retired)
        XCTAssertFalse(controller.coversUnderlyingPresentation)
        XCTAssertTrue(controller.children.isEmpty)
        XCTAssertFalse(acted, "Retirement cancels a pending action before its popup completes")
        let editable = NativeDrawerRow(id: "row-handle", label: "Public title", detail: nil, symbol: nil,
            enabled: true, destructive: nil, selected: nil, pending: nil, renameActionId: "rename", deleteActionId: "delete")
        let model = NativeDrawerModel(privateDrawerState(family: "history", sampleRow: editable))
        model.interactionEnabled = true
        let oldState = model.projection
        model.update(privateDrawerState(family: "history", update: 2, sampleRow: editable))
        model.showDetails(oldState.sections[0].rows[0], mode: "rename", from: oldState)
        XCTAssertNil(model.detailRow, "An old menu cannot open a replacement owner's editor")
        var confirmations = 0
        model.requestDelete = { _, _ in confirmations += 1 }
        model.showDetails(editable, mode: "delete", from: oldState)
        XCTAssertEqual(confirmations, 0, "An old menu cannot present a destructive confirmation")
        model.showDetails(editable, mode: "delete", from: model.projection)
        XCTAssertEqual(confirmations, 1)
        XCTAssertNil(model.detailRow, "Delete confirmation retains History rather than replacing it")
        XCTAssertFalse(model.choicePending, "Opening confirmation is not permission to delete")

        // List filtering/removal uses the real representable teardown, not
        // whole-drawer retirement. A vanished trigger still owns its popup.
        var removed: NativeDrawerMenuControl? = NativeDrawerMenuControl(type: .system)
        weak var retained = removed
        let rowInteraction = UIContextMenuInteraction(delegate: removed!)
        model.registerMenu(removed!)
        removed!.contextMenuInteraction(rowInteraction, willDisplayMenuFor: configuration, animator: nil)
        var rowActed = false
        removed!.afterDismissal { rowActed = true }
        NativeDrawerRowMenu.dismantleUIView(removed!, coordinator: model)
        removed = nil
        let retiring = try XCTUnwrap(retained, "Row teardown must retain its still-visible owned menu")
        XCTAssertFalse(retiring.isEnabled)
        XCTAssertNil(retiring.menu)
        var disappeared = false
        model.dismissMenus { disappeared = true }
        XCTAssertFalse(disappeared)
        let rowAnimator = OwnedMenuTestAnimator()
        retiring.contextMenuInteraction(rowInteraction, willEndFor: configuration, animator: rowAnimator)
        XCTAssertFalse(disappeared)
        rowAnimator.finish()
        XCTAssertTrue(disappeared)
        XCTAssertFalse(rowActed, "A removed row cannot deliver its queued menu action")
    }

    @MainActor
    func testProfileChoiceAcknowledgementKeepsRenderedMenuAppearanceWithoutReplayingTheAction() async throws {
        let model = NativeDrawerModel(privateDrawerState())
        model.interactionEnabled = true
        var choices = 0
        model.choose = { [weak model] _, _, _ in choices += 1; model?.pendingSequence = choices; return true }
        var rowFrame = CGRect.zero
        var enabled: Bool?
        let host = UIHostingController(rootView: NativeDrawerContent(model: model, profileRowObserver: { _, frame, available in
            rowFrame = frame; enabled = available
        }))
        host.overrideUserInterfaceStyle = .light
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true; window.rootViewController = nil
            previousKeyWindow?.makeKeyAndVisible()
        }
        host.view.layoutIfNeeded()
        await fulfillment(of: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            rowFrame.width > 0 && rowFrame.height >= 44 && enabled == true
        }, object: nil)], timeout: 3)
        func rowPixels() throws -> Data {
            // Actual attached shared menu, containing only public synthetic
            // labels. Crop its measured row rather than guessing offscreen bounds.
            host.view.layoutIfNeeded()
            var rendered = false
            let format = UIGraphicsImageRendererFormat(); format.scale = 1
            let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
                rendered = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            XCTAssertTrue(rendered)
            let row = try XCTUnwrap(image.cgImage?.cropping(to: rowFrame.integral))
            return try XCTUnwrap(row.dataProvider?.data) as Data
        }
        let baseline = try rowPixels()
        XCTAssertTrue(model.choice("row", row: "row-handle"))
        XCTAssertFalse(model.choice("row", row: "row-handle"), "The visual fix must preserve one-shot choice admission")
        XCTAssertEqual(choices, 1)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(enabled, true, "Pending acknowledgement must not disable the entire menu's visual environment")
        let pending = try rowPixels()
        XCTAssertTrue(baseline == pending, "Bridge acknowledgement cannot dim and restore the whole menu on every tap")
        model.settle(sequence: 1, success: true)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertTrue(baseline == (try rowPixels()), "Settlement must not repaint a different row appearance")
        XCTAssertTrue(model.choice("row", row: "row-handle"), "Settlement restores the next deliberate action")
        XCTAssertEqual(choices, 2)
        model.settle(sequence: 2, success: true)
        model.update(privateDrawerState(update: 2, enabled: false))
        await fulfillment(of: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in enabled == false }, object: nil)], timeout: 3)
        XCTAssertEqual(enabled, false, "Negative control: authored unavailable state still reaches the rendered row")
    }

    @MainActor
    func testDrawerMotionQuarantinesInteractionWithoutDisabledAppearance() {
        let model = NativeDrawerModel(privateDrawerState())
        let choose = expectation(description: "Only admitted row choice")
        model.choose = { _, _, _ in choose.fulfill(); return true }
        let row = model.projection.sections[0].rows[0]
        XCTAssertTrue(model.controlsEnabled)
        XCTAssertFalse(model.interactionEnabled)
        XCTAssertFalse(model.choice("row", row: row.id))
        model.interactionEnabled = true
        XCTAssertTrue(model.controlsEnabled)
        XCTAssertTrue(model.choice("row", row: row.id))
        model.interactionEnabled = false
        XCTAssertTrue(model.controlsEnabled, "A temporary motion quarantine must not dim material")
        model.update(privateDrawerState(update: 2, enabled: false))
        XCTAssertFalse(model.controlsEnabled, "Authored disabled state retains its visual semantics")
        wait(for: [choose], timeout: 1)
    }

    @MainActor
    func testWholeNativeDrawerKeepsBasePaintThroughCoverageAndClearsPrivateReplicaOnRetirement() throws {
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let container = NativePresentationContainer(webView: web, basePresentation: .coherentDrawers)
        container.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        XCTAssertTrue(container.containsStationaryControl(CGRect(x: 16, y: 60, width: 44, height: 44), document: "synthetic"),
            "Coherent admission must not depend on the rejected legacy-region protocol")
        XCTAssertFalse(container.containsStationaryControl(CGRect(x: 380, y: 60, width: 44, height: 44), document: "synthetic"))
        let glass = UIButton(frame: CGRect(x: 10, y: 10, width: 44, height: 44))
        container.install(glass, id: "base-control", group: nil)
        container.setAdmission("base-control", admitted: true)
        let base = try XCTUnwrap(glass.superview)
        let parent = UIViewController()
        parent.view = container
        let controller = NativeDrawerPresentationController(privateDrawerState())
        parent.addChild(controller)
        container.addSubview(controller.view)
        controller.view.frame = container.bounds
        controller.didMove(toParent: parent)
        controller.isolation = { container.isolateForOwnedDrawer($0) }
        controller.activateInitialPresentation()
        let host = try XCTUnwrap(controller.host)
        controller.update(privateDrawerState(update: 2, appearance: "dark"))
        XCTAssertTrue(controller.host === host, "Appearance/content updates retain the native host")
        XCTAssertEqual(controller.overrideUserInterfaceStyle, .dark)
        controller.settle(open: false, userIntent: false)
        XCTAssertFalse(web.isUserInteractionEnabled, "Closing target is not visible settlement")
        XCTAssertTrue(web.accessibilityElementsHidden)
        XCTAssertFalse(base.isHidden, "Drawer coverage must not hide the exposed material")
        XCTAssertFalse(glass.isHidden)
        XCTAssertTrue(glass.superview === base)
        XCTAssertFalse(glass.isUserInteractionEnabled)
        XCTAssertFalse(container.setRegions(document: "public-document", revision: 1,
            viewport: container.bounds.size, top: 100, bottom: 100, isolated: true, covered: true),
            "The new owner must not accept the historical asynchronous clipping protocol")
        controller.beginDrag()
        XCTAssertTrue(controller.host === host)
        controller.retire()
        XCTAssertTrue(controller.children.isEmpty)
        XCTAssertNil(host.view.superview)
        XCTAssertNil(controller.view.superview)
        XCTAssertTrue(controller.model.projection.sections.isEmpty)
        XCTAssertTrue(controller.model.projection.title.isEmpty)
        XCTAssertNil(controller.model.choose)
        XCTAssertTrue(web.superview === container)
        XCTAssertFalse(base.isHidden)
        XCTAssertFalse(glass.isUserInteractionEnabled, "Fresh bindings restore permissions, not a captured boolean")
    }

    func testCoherentStationaryViewportAcceptsOnlyTheActualKeyboardResizedWebView() {
        let host = CGSize(width: 390, height: 844)
        let web = CGSize(width: 390, height: 480)
        XCTAssertEqual(NativeChromeViewport.resolve(authored: host, host: host, web: web, coherent: true, keyboard: false), host)
        XCTAssertEqual(NativeChromeViewport.resolve(authored: web, host: host, web: web, coherent: true, keyboard: true), host)
        XCTAssertNil(NativeChromeViewport.resolve(authored: web, host: host, web: web, coherent: false, keyboard: true))
        XCTAssertNil(NativeChromeViewport.resolve(authored: web, host: host, web: web, coherent: true, keyboard: false))
        XCTAssertNil(NativeChromeViewport.resolve(authored: CGSize(width: 390, height: 500), host: host, web: web, coherent: true, keyboard: true))
        XCTAssertNil(NativeChromeViewport.resolve(authored: web, host: CGSize(width: 844, height: 390), web: web, coherent: true, keyboard: true))
    }

    @MainActor
    func testOwnedProfileContentPlaneRetainsBaseButRejectsCoveredAndStaleActions() throws {
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let container = NativePresentationContainer(webView: web, basePresentation: .coherentDrawers)
        container.frame = web.frame
        let base = UIButton(frame: CGRect(x: 16, y: 60, width: 44, height: 44))
        container.install(base, id: "base", group: nil)
        container.setAdmission("base", admitted: true)
        let retainedHost = try XCTUnwrap(base.superview)
        let identity = NativeContentPaneIdentity(document: "synthetic", ownerEpoch: "owner", generation: 1,
            privacyGeneration: HushhSessionPrivacyShield.shared.snapshot().generation)
        XCTAssertFalse(container.acquireContentPane(identity, viewport: CGSize(width: 400, height: 844)))
        XCTAssertTrue(container.acquireContentPane(identity, viewport: container.bounds.size))
        XCTAssertTrue(base.superview === retainedHost)
        XCTAssertFalse(base.isHidden)
        XCTAssertLessThan(retainedHost.layer.zPosition, web.layer.zPosition)
        container.setAdmission("base", admitted: true)
        XCTAssertFalse(base.isUserInteractionEnabled, "A fresh base update must not bypass the owned content plane")
        XCTAssertTrue(web.isUserInteractionEnabled)
        let back = UIButton(frame: base.frame)
        container.install(back, id: "profile-back", group: nil, pane: identity)
        container.setAdmission("profile-back", admitted: true)
        XCTAssertTrue(back.isUserInteractionEnabled)
        XCTAssertTrue(container.hitTest(CGPoint(x: 30, y: 75), with: nil) === back)
        XCTAssertTrue(container.acquireContentPane(identity, viewport: container.bounds.size))
        XCTAssertTrue(back.isUserInteractionEnabled, "An idempotent acquisition must not strand an already admitted header")
        XCTAssertFalse(container.releaseContentPane(identity), "Header removal must be confirmed before uncovering base chrome")
        container.remove("profile-back")
        XCTAssertTrue(container.releaseContentPane(identity))
        XCTAssertFalse(base.isUserInteractionEnabled, "Release never restores stale permissions")
        XCTAssertFalse(container.acquireContentPane(identity, viewport: container.bounds.size), "A delayed acquisition cannot follow retirement")
        let next = NativeContentPaneIdentity(document: "synthetic", ownerEpoch: "new-owner", generation: 2,
            privacyGeneration: identity.privacyGeneration)
        XCTAssertTrue(container.acquireContentPane(next, viewport: container.bounds.size))
        XCTAssertFalse(container.releaseContentPane(identity), "An old completion cannot release a reopened pane")
        XCTAssertEqual(container.contentPane, next)
        XCTAssertTrue(container.acquireContentPane(next, viewport: container.bounds.size), "Compatible viewport admission retains ownership")
        XCTAssertTrue(container.beginContentPaneRetirement(next))
        XCTAssertFalse(container.acquireContentPane(next, viewport: container.bounds.size), "Retirement fences late preparation before dismissal completion")
        XCTAssertFalse(container.contentPaneAdmits(next))
        container.conceal()
        container.setAdmission("base", admitted: true)
        XCTAssertFalse(base.isUserInteractionEnabled)
        XCTAssertTrue(container.releaseContentPane(next))
    }

    @MainActor
    func testPendingNativeCloseSurvivesContentRefreshAndUncoversTheSameWebViewOnlyAfterAcknowledgement() async throws {
        let state = privateDrawerState(family: "history")
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let container = NativePresentationContainer(webView: web, basePresentation: .coherentDrawers)
        let parent = UIViewController()
        parent.view = container
        let window = UIWindow(frame: web.frame)
        window.rootViewController = parent
        window.isHidden = false
        let opener = UIButton(frame: CGRect(x: 16, y: 72, width: 44, height: 44))
        container.install(opener, id: "chat-history-toggle", group: nil)
        let controller = NativeDrawerPresentationController(state)
        controller.leadingHeaderFrame = { container.installedFrame("chat-history-toggle") }
        parent.addChild(controller)
        container.addSubview(controller.view)
        controller.view.frame = container.bounds
        controller.didMove(toParent: parent)
        defer { controller.retire(); window.isHidden = true; window.rootViewController = nil }
        var lease = NativeDrawerLease()
        XCTAssertTrue(lease.apply(state))
        controller.invalidateInteractions = { lease.invalidateInteractions() }
        controller.isolation = { container.isolateForOwnedDrawer($0) }
        controller.activateInitialPresentation()
        XCTAssertEqual(controller.model.headerInsets.leading, 16)
        XCTAssertEqual(controller.model.headerInsets.top + controller.view.safeAreaInsets.top, 72,
            accuracy: 1, "Close uses its authored opener seat, not UIKit's different default inset")
        let admitted = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in controller.model.interactionEnabled }, object: nil)
        await fulfillment(of: [admitted], timeout: 3)
        let host = try XCTUnwrap(controller.host)
        let emitted = expectation(description: "Close emitted")
        var token: Int?, interaction = 0
        controller.model.choose = { action, row, text in
            token = lease.emit(action: action, row: row, state: controller.model.projection, text: text)
            interaction = lease.interactionGeneration
            if token != nil { emitted.fulfill() }
            return token != nil
        }
        controller.settle(open: false, userIntent: true)
        await fulfillment(of: [emitted], timeout: 3)
        let sequence = try XCTUnwrap(token)
        let refresh = privateDrawerState(family: "history", update: 2, appearance: "dark")
        XCTAssertTrue(lease.apply(refresh))
        controller.update(refresh)
        XCTAssertTrue(controller.host === host)
        XCTAssertEqual(controller.motion.progress, 0, "A content refresh must not reopen a locally closed drawer")
        XCTAssertFalse(web.isUserInteractionEnabled, "Unacknowledged Close does not release modal isolation")
        XCTAssertTrue(web.accessibilityElementsHidden)
        XCTAssertTrue(lease.confirm(identity: state.identity, update: 1, privacy: 0, sequence: sequence,
            interaction: interaction, action: "close", row: nil, allowed: controller.allowsInteraction("close", row: nil)))
        let closed = privateDrawerState(family: "history", open: false, update: 3, appearance: "dark")
        XCTAssertTrue(lease.apply(closed))
        controller.update(closed)
        XCTAssertTrue(web.isUserInteractionEnabled)
        XCTAssertFalse(web.accessibilityElementsHidden)
        XCTAssertTrue(web.superview === container)
        XCTAssertFalse(lease.confirm(identity: state.identity, update: 1, privacy: 0, sequence: sequence,
            interaction: interaction, action: "close", row: nil, allowed: true), "Close is never replayed")

        // Compatible refresh never bypasses interaction, privacy, authority,
        // withdrawal or a subsequent close/reopen boundary.
        for invalidation in 0..<5 {
            var stale = NativeDrawerLease()
            XCTAssertTrue(stale.apply(state))
            let old = try XCTUnwrap(stale.emit(action: "close", row: nil, state: state))
            switch invalidation {
            case 0: stale.invalidateInteractions()
            case 1: XCTAssertTrue(stale.apply(privateDrawerState(family: "history", update: 2, privacy: 1)))
            case 2: XCTAssertTrue(stale.apply(privateDrawerState(family: "history", owner: "replacement", revision: 2)))
            case 3: XCTAssertTrue(stale.apply(privateDrawerState(family: "history", update: 2, enabled: false)))
            default:
                XCTAssertTrue(stale.apply(privateDrawerState(family: "history", open: false, update: 2)))
                XCTAssertTrue(stale.apply(privateDrawerState(family: "history", update: 3)))
            }
            XCTAssertFalse(stale.confirm(identity: state.identity, update: 1, privacy: 0, sequence: old,
                interaction: 1, action: "close", row: nil, allowed: true))
        }
    }

    @MainActor
    func testPreparingClosedNativeDrawerDoesNotFlashOrBlockTheExistingPage() {
        let controller = NativeDrawerPresentationController(privateDrawerState(open: false))
        controller.view.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        var isolated = false
        controller.isolation = { isolated = $0 }
        controller.activateInitialPresentation()
        XCTAssertFalse(isolated)
        XCTAssertNil(controller.view.hitTest(CGPoint(x: 100, y: 100), with: nil))
        XCTAssertGreaterThanOrEqual(controller.host.view.frame.minX, controller.view.bounds.maxX,
            "A closed inset Profile must travel past its outer gutter, not leave a visible sliver")
        controller.retire()
    }

    @MainActor
    func testNativeProfileAccountStackRetainsItsHostAndRejectsStalePopBindings() async throws {
        var root = privateDrawerState(backEnabled: true)
        root.surfaceOpen = true; root.profileStack = []
        var account = privateDrawerState(update: 2, backEnabled: true)
        account.surfaceOpen = true; account.profileDestinationId = "account-first"
        account.profileStack = [NativeProfilePage(id: "account", title: "Your account", sections: [
            NativeDrawerSection(id: "identity-details", title: "Identity", rows: [
                NativeDrawerRow(id: "edit-name", label: "Display name", detail: "Public sample", symbol: "person",
                    enabled: true, destructive: nil, selected: nil, pending: nil),
                NativeDrawerRow(id: "read-only-mail", label: "Mail", detail: "Public sample", symbol: nil,
                    enabled: true, destructive: nil, selected: nil, pending: nil, readOnly: true),
            ]),
        ])]
        XCTAssertTrue(account.valid)
        XCTAssertTrue(account.allows(action: "row", row: "edit-name"))
        XCTAssertFalse(account.allows(action: "row", row: "row-handle"))
        XCTAssertFalse(account.allows(action: "row", row: "read-only-mail"))
        let controller = NativeDrawerPresentationController(root)
        controller.view.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer {
            controller.retire()
            window.isHidden = true; window.rootViewController = nil
            previousKeyWindow?.makeKeyAndVisible()
        }
        controller.activateInitialPresentation()
        let admitted = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in controller.model.interactionEnabled }, object: controller)
        await fulfillment(of: [admitted], timeout: 2)
        func navigation(in parent: UIViewController) -> UINavigationController? {
            if let navigation = parent as? UINavigationController { return navigation }
            return parent.children.lazy.compactMap { navigation(in: $0) }.first
        }
        func requireClose() async {
            // Mount the real SwiftUI stack. Model/host-presence assertions did
            // not catch a toolbar attached outside the navigation content.
            await fulfillment(of: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                navigation(in: controller)?.navigationBar.topItem?.rightBarButtonItems?.isEmpty == false
            }, object: nil)], timeout: 3)
        }
        await requireClose()
        let host = controller.host
        controller.update(account)
        await requireClose()
        XCTAssertTrue(controller.host === host)
        XCTAssertEqual(controller.motion.progress, 1, "An inner push must not move Profile offscreen")
        XCTAssertEqual(controller.model.navigationPath, ["account"])
        var backs = 0
        controller.model.choose = { [weak controller] action, _, _ in
            if action == "back" { backs += 1; controller?.model.pendingSequence = backs }
            return true
        }
        controller.model.requestPath([], from: account)
        controller.model.requestPath([], from: account)
        XCTAssertEqual(backs, 1)
        XCTAssertFalse(controller.model.choice("row", row: "edit-name"), "Pending Back quarantines competing operations")
        var refreshed = privateDrawerState(update: 3, backEnabled: true)
        refreshed.surfaceOpen = true; refreshed.profileStack = account.profileStack; refreshed.profileDestinationId = account.profileDestinationId
        controller.update(refreshed)
        controller.model.requestPath([], from: refreshed)
        XCTAssertEqual(backs, 1, "A compatible refresh must not release pending Back")
        XCTAssertEqual(controller.model.navigationPath, ["account"], "React still commits the authored parent")
        var returned = privateDrawerState(update: 4, backEnabled: true)
        returned.surfaceOpen = true; returned.profileStack = []
        controller.update(returned)
        await requireClose()
        XCTAssertTrue(controller.host === host)
        XCTAssertEqual(controller.motion.progress, 1)
        account = privateDrawerState(update: 5, backEnabled: true)
        account.surfaceOpen = true; account.profileDestinationId = "account-returned"
        account.profileStack = [controller.model.page("account")!]
        controller.update(account)
        controller.model.requestPath([], from: returned)
        XCTAssertEqual(backs, 1, "A retained old setter cannot dispatch a fresh Back")
        controller.model.requestPath([], from: account)
        XCTAssertEqual(backs, 2)
        controller.model.settle(sequence: 1, success: false)
        XCTAssertFalse(controller.model.choice("row", row: "edit-name"), "An old refusal cannot release a newer Back")
        controller.model.requestPath([], from: account)
        XCTAssertEqual(backs, 2)
        controller.model.settle(sequence: 2, success: false)
        XCTAssertTrue(controller.model.choice("row", row: "edit-name"))
        controller.setFormCoverage(true)
        XCTAssertFalse(controller.model.interactionEnabled)
        XCTAssertFalse(controller.allowsInteraction("back", row: nil))
        XCTAssertFalse(controller.allowsInteraction("close", row: nil))
        controller.setFormCoverage(false)
        XCTAssertTrue(controller.allowsInteraction("back", row: nil))
        controller.retire()
    }

    @MainActor
    func testProfileContentHandoffDoesNotReplayTheOuterDrawerSlide() {
        var detail = privateDrawerState(open: false)
        detail.surfaceOpen = true
        let controller = NativeDrawerPresentationController(detail)
        controller.view.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        controller.activateInitialPresentation()
        let host = controller.host
        var menu = privateDrawerState(update: 2)
        menu.surfaceOpen = true
        controller.update(menu)
        XCTAssertTrue(controller.motion.committedOpen, "Returning to menu content must not start another outer opening animation")
        XCTAssertEqual(controller.motion.progress, 1)
        XCTAssertTrue(controller.host === host)
        detail = privateDrawerState(open: false, update: 3)
        detail.surfaceOpen = true
        controller.update(detail)
        XCTAssertFalse(controller.motion.committedOpen)
        XCTAssertEqual(controller.motion.progress, 0)
        XCTAssertFalse(controller.allowsInteraction("row", row: "row-handle"))
        controller.retire()

        // Negative control: an actual closed-to-open drawer still settles
        // asynchronously; the content handoff must not disable its animation.
        var closed = privateDrawerState(open: false)
        closed.surfaceOpen = false
        let opening = NativeDrawerPresentationController(closed)
        opening.view.frame = controller.view.frame
        opening.activateInitialPresentation()
        opening.update(menu)
        XCTAssertFalse(opening.motion.committedOpen)
        opening.retire()

        // A changed privacy generation cannot take the content-only path.
        let changedPrivacy = NativeDrawerPresentationController(detail)
        changedPrivacy.view.frame = controller.view.frame
        changedPrivacy.activateInitialPresentation()
        var next = privateDrawerState(update: 4, privacy: 1)
        next.surfaceOpen = true
        changedPrivacy.update(next)
        XCTAssertFalse(changedPrivacy.motion.committedOpen)
        changedPrivacy.retire()
    }

    @MainActor
    func testUnacknowledgedDrawerCloseRequestsFreshPresentationWithoutReplayingClose() {
        let controller = NativeDrawerPresentationController(privateDrawerState())
        controller.view.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        controller.activateInitialPresentation()
        let host = controller.host
        var choices = 0, invalidations = 0
        controller.model.choose = { action, _, _ in
            XCTAssertEqual(action, "close")
            choices += 1
            return true // Deliberately do not acknowledge the authored Close.
        }
        controller.invalidateInteractions = { invalidations += 1 }
        let refresh = expectation(description: "Timed-out presentation requests readmission")
        controller.requestReadmission = {
            XCTAssertFalse(controller.model.interactionEnabled)
            XCTAssertGreaterThanOrEqual(invalidations, 2, "Timeout must invalidate the original action token")
            refresh.fulfill()
        }
        controller.settle(open: false, userIntent: true)
        wait(for: [refresh], timeout: 7)
        XCTAssertEqual(choices, 1, "A presentation refresh must not replay Close")
        controller.update(privateDrawerState(update: 2))
        let admitted = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            controller.model.interactionEnabled && controller.allowsInteraction("close", row: nil)
        }, object: controller)
        XCTAssertEqual(XCTWaiter.wait(for: [admitted], timeout: 2), .completed,
            "Fresh owner presentation must restore interaction after settlement")
        XCTAssertTrue(controller.host === host)
        XCTAssertEqual(choices, 1)
        controller.retire()
        XCTAssertNil(controller.requestReadmission)
    }

    #if DEBUG
    func testNativeHistoryQualificationNeverReactivatesExperimentalProductControls() {
        XCTAssertTrue(NativeHistoryQualification.admits(arguments: [NativeHistoryQualification.argument], phone: true, supported: true))
        for arguments in [[], ["-UITestMode"], ["--hushh-native-compositor", "--hushh-native-drawer-clip"]] {
            XCTAssertFalse(NativeHistoryQualification.admits(arguments: arguments, phone: true, supported: true))
        }
        XCTAssertFalse(NativeHistoryQualification.admits(arguments: [NativeHistoryQualification.argument], phone: false, supported: true))
        XCTAssertFalse(NativeHistoryQualification.admits(arguments: [NativeHistoryQualification.argument], phone: true, supported: false))
        XCTAssertFalse(HushhNativePresentationPolicy.customControlsEnabled)
    }

    func testNativeHistoryQualificationCancellationAndRegrabRejectOldSettlement() {
        var state = NativeHistoryQualificationMotion()
        let opening = state.begin(at: 0)
        state.move(to: 0.7)
        XCTAssertFalse(state.destination(velocity: 1000, cancelled: true), "Cancellation must not commit an opening drag")
        XCTAssertTrue(state.commit(open: true, generation: opening))
        let closing = state.begin(at: 0.6)
        state.move(to: 0.2)
        XCTAssertTrue(state.destination(velocity: -1000, cancelled: true), "Cancellation preserves the last committed open state")
        let regrab = state.begin(at: 0.3)
        XCTAssertFalse(state.commit(open: false, generation: closing), "An interrupted close cannot finish a new drag")
        state.move(to: 0.8)
        XCTAssertTrue(state.commit(open: true, generation: regrab))
        state.retire()
        XCTAssertFalse(state.commit(open: false, generation: regrab))
        state.move(to: 0)
        XCTAssertEqual(state.progress, 1, "Retired callbacks cannot mutate or re-admit the fixture")
    }

    @MainActor
    func testNativeHistoryQualificationRetainsHostsAndActuallyDetachesOnRetirement() throws {
        guard #available(iOS 26.0, *) else { throw XCTSkip("Glass composition requires iOS 26") }
        let fixture = NativeHistoryQualificationController()
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = fixture
        window.isHidden = false
        defer { window.isHidden = true; window.rootViewController = nil }
        fixture.loadViewIfNeeded()
        fixture.view.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        fixture.view.layoutIfNeeded()
        let base = try XCTUnwrap(fixture.baseHost)
        let drawer = try XCTUnwrap(fixture.drawerHost)
        let editor = try XCTUnwrap(fixture.dock.editor)
        XCTAssertEqual(fixture.children.count, 2)
        XCTAssertTrue(fixture.view.accessibilityViewIsModal)
        fixture.appearance.dark = true
        fixture.appearance.gold = true
        fixture.appearance.agentSurface = "puppy"
        fixture.beginDrag()
        XCTAssertTrue(fixture.baseHost === base)
        XCTAssertTrue(fixture.drawerHost === drawer)
        XCTAssertTrue(fixture.dock.editor === editor)
        XCTAssertEqual(fixture.overrideUserInterfaceStyle, .dark)
        XCTAssertTrue(fixture.modalPresentationCapturesStatusBarAppearance)
        XCTAssertEqual(fixture.preferredStatusBarStyle, .lightContent)
        fixture.settle(open: true)
        fixture.beginDrag()
        fixture.settle(open: false)
        XCTAssertFalse(base.view.isUserInteractionEnabled,
            "A closing target cannot enable the base before visible settlement")
        XCTAssertTrue(base.view.accessibilityElementsHidden,
            "Accessibility must remain isolated through the closing animation")
        fixture.beginDrag()
        XCTAssertTrue(fixture.baseHost === base)
        XCTAssertTrue(fixture.drawerHost === drawer)
        let shield = HushhSessionPrivacyShield.shared.snapshot()
        var detached = false
        fixture.onRetired = {
            detached = fixture.children.isEmpty && base.view.superview == nil && drawer.view.superview == nil
        }
        fixture.retire()
        XCTAssertTrue(detached, "A retirement receipt must follow actual owned-view removal")
        XCTAssertTrue(fixture.view.accessibilityElementsHidden)
        XCTAssertFalse(fixture.view.isUserInteractionEnabled)
        XCTAssertNil(fixture.appearance.changed)
        XCTAssertTrue(fixture.dock.text.isEmpty)
        XCTAssertNil(fixture.dock.emit)
        fixture.beginDrag()
        fixture.settle(open: true)
        XCTAssertTrue(fixture.children.isEmpty)
        XCTAssertEqual(HushhSessionPrivacyShield.shared.snapshot().generation, shield.generation)
        XCTAssertEqual(HushhSessionPrivacyShield.shared.snapshot().shielded, shield.shielded,
            "Fixture retirement must not release or invalidate the product's privacy authority")
    }
    #endif

    @MainActor
    func testContentBackedBaseHasNoCanvasBetweenGlassAndPageAndPreservesHitIsolation() {
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let container = NativePresentationContainer(webView: web, basePresentation: .contentBacked)
        let control = UIButton(frame: CGRect(x: 10, y: 10, width: 44, height: 44))
        container.setCanvas(.black, appearance: .light)
        container.install(control, id: "chat-history-toggle", group: nil)
        XCTAssertTrue(web.superview === container)
        XCTAssertTrue(container.contentBackedPresentation)
        XCTAssertGreaterThan(container.subviews.firstIndex(of: container.underlay)!, container.subviews.firstIndex(of: web)!)
        XCTAssertGreaterThanOrEqual(container.underlay.layer.zPosition, web.layer.zPosition)
        XCTAssertEqual(container.underlay.backgroundColor, .clear, "An opaque native plane would destroy the page-backed material")
        XCTAssertEqual(container.overrideUserInterfaceStyle, .light)
        let unsupportedPose = NativePanelPose(document: "synthetic", ownerEpoch: "epoch", generation: 1,
            sequence: 1, privacyGeneration: 0, frame: container.bounds, offset: 0, opacity: 0.5, settled: true)
        XCTAssertFalse(container.apply(unsupportedPose, group: "profile", privacy: 0),
            "The material-only pilot must not accidentally adopt an alpha-composited native drawer")
        container.setAdmission("chat-history-toggle", admitted: true)
        XCTAssertTrue(container.hitTest(CGPoint(x: 20, y: 20), with: nil) === control)
        XCTAssertFalse(container.hitTest(CGPoint(x: 100, y: 100), with: nil)?.isDescendant(of: control) == true)
        container.setAdmission("chat-history-toggle", admitted: false)
        XCTAssertFalse(container.hitTest(CGPoint(x: 20, y: 20), with: nil) === control)
        XCTAssertTrue(container.setRegions(document: "synthetic", revision: 1,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: true))
        XCTAssertEqual(HushhNativeChromePlugin.stationaryChatControlIds["agent-surface"], "chat-agent-surface",
            "The stationary Chat selector must not disappear from the content-backed capability contract")
        XCTAssertNil(HushhNativeChromePlugin.stationaryChatControlIds["profile-back"],
            "Admitting the stationary selector must not adopt moving Profile controls")
        XCTAssertFalse(container.containsStationaryControl(CGRect(x: 280, y: 60, width: 88, height: 44), document: "synthetic"),
            "A selector crossing the reserved header boundary cannot be admitted")
        XCTAssertTrue(container.containsStationaryControl(CGRect(x: 280, y: 50, width: 88, height: 44), document: "synthetic"))
        XCTAssertFalse(control.isHidden, "Overlay isolation must retain the visible material")
        XCTAssertTrue(control.accessibilityElementsHidden)
        XCTAssertTrue(container.hitTest(CGPoint(x: 20, y: 20), with: nil) === container,
            "A disabled native region must not forward touches to covered DOM controls")
        XCTAssertFalse(container.hitTest(CGPoint(x: 100, y: 200), with: nil) === container,
            "The React drawer keeps its central interaction region")
        XCTAssertFalse(container.setRegions(document: "synthetic", revision: 0,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: false))
        XCTAssertTrue(container.overlayIsolated, "A reordered acknowledgment cannot restore actions")
        XCTAssertTrue(container.setRegions(document: "synthetic", revision: 2,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: false))
        XCTAssertFalse(control.isUserInteractionEnabled, "Fresh bindings, not region dismissal, restore interaction")
        container.setAdmission("chat-history-toggle", admitted: true)
        XCTAssertTrue(container.hitTest(CGPoint(x: 20, y: 20), with: nil) === control)
        let retained = control.superview
        let privacy = HushhSessionPrivacyShield.shared.snapshot().generation
        XCTAssertTrue(container.setRegions(document: "synthetic", revision: 3,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: true, covered: true, privacyGeneration: privacy))
        container.revealUnderlay() // A delayed normal control update cannot uncover the drawer.
        XCTAssertTrue(container.underlay.isHidden)
        XCTAssertTrue(control.superview === retained)
        XCTAssertTrue(control.accessibilityElementsHidden)
        XCTAssertFalse(container.hitTest(CGPoint(x: 20, y: 20), with: nil) === container,
            "Full-height drawer edge controls must reach WK, not the old reserved-strip interceptor")
        XCTAssertFalse(container.setRegions(document: "synthetic", revision: 2,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: false))
        XCTAssertTrue(container.fullWindowCovered)
        XCTAssertTrue(container.setRegions(document: "synthetic", revision: 4,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: false, privacyGeneration: privacy))
        container.setAdmission("chat-history-toggle", admitted: true, presentationRegionRevision: 2, privacyGeneration: privacy)
        XCTAssertFalse(control.isUserInteractionEnabled, "A pre-cover admission must not revive after dismissal")
        container.setAdmission("chat-history-toggle", admitted: true, presentationRegionRevision: 4, privacyGeneration: privacy)
        XCTAssertTrue(control.isUserInteractionEnabled)
        container.conceal()
        XCTAssertTrue(container.setRegions(document: "synthetic", revision: 5,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: false, privacyGeneration: privacy))
        XCTAssertTrue(container.underlay.isHidden, "Ordinary coverage release is not privacy validation")
        XCTAssertTrue(control.superview === retained)
        XCTAssertTrue(control.accessibilityElementsHidden)
        XCTAssertFalse(container.hitTest(CGPoint(x: 20, y: 20), with: nil) === control)
    }

    @MainActor
    func testContentBackedDrawerClippingPreservesWindowCoordinatesWithoutGrantingActions() {
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let container = NativePresentationContainer(webView: web, basePresentation: .contentBacked, drawerClipping: true)
        let control = UIButton(frame: CGRect(x: 10, y: 10, width: 44, height: 44))
        container.install(control, id: "chat-history-toggle", group: nil)
        let retained = control.superview
        let original = control.convert(control.bounds, to: container)
        let privacy = HushhSessionPrivacyShield.shared.snapshot().generation
        func regions(_ revision: Int, drawer: String?) {
            XCTAssertTrue(container.setRegions(document: "synthetic", revision: revision,
                viewport: container.bounds.size, top: 100, bottom: 150, isolated: drawer != nil,
                covered: drawer != nil, privacyGeneration: privacy, drawer: drawer))
        }
        regions(1, drawer: "profile")
        XCTAssertEqual(container.baseVisibleFrame, .zero, "No native paint before the first current coverage receipt")
        let pose = NativePanelPose(document: "synthetic", ownerEpoch: "epoch", generation: 1,
            sequence: 1, privacyGeneration: privacy, frame: container.bounds, offset: 150, opacity: 1, settled: false)
        XCTAssertTrue(container.applyDrawerCoverage(pose, group: "profile", privacy: privacy, revision: 1))
        XCTAssertEqual(container.baseVisibleFrame, CGRect(x: 0, y: 0, width: 150, height: 844))
        XCTAssertFalse(container.underlay.isHidden, "Held partial drag must not hide the entire retained native plane")
        XCTAssertEqual(control.convert(control.bounds, to: container), original)
        XCTAssertTrue(control.superview === retained)
        XCTAssertTrue(control.accessibilityElementsHidden)
        XCTAssertFalse(container.hitTest(CGPoint(x: 20, y: 20), with: nil) === control)
        XCTAssertFalse(container.hitTest(CGPoint(x: 350, y: 20), with: nil) === container,
            "Drawer edge touches must reach the single WebView")
        // Same displayed drawer, new admission revision: no blank interval.
        regions(2, drawer: "profile")
        XCTAssertEqual(container.baseVisibleFrame.width, 150)
        XCTAssertFalse(container.applyDrawerCoverage(pose, group: "profile", privacy: privacy, revision: 1))
        regions(3, drawer: nil)
        XCTAssertEqual(container.baseVisibleFrame, container.bounds)
        XCTAssertFalse(container.applyDrawerCoverage(pose, group: "profile", privacy: privacy, revision: 1),
            "A delayed covered pose cannot cover the dismissed drawer")
        regions(4, drawer: "history")
        let history = NativePanelPose(document: "synthetic", ownerEpoch: "history-epoch", generation: 2,
            sequence: 1, privacyGeneration: privacy, frame: container.bounds, offset: -150, opacity: 1, settled: false)
        XCTAssertTrue(container.applyDrawerCoverage(history, group: "history", privacy: privacy, revision: 4))
        XCTAssertEqual(container.baseVisibleFrame, CGRect(x: 240, y: 0, width: 150, height: 844))
        XCTAssertEqual(control.convert(control.bounds, to: container), original,
            "Right-hand exposure must compensate the viewport origin, not move child controls")
        XCTAssertEqual(container.underlay.bounds.size, container.bounds.size)
        XCTAssertEqual(container.underlay.superview?.alpha, 1)
        XCTAssertNil(container.underlay.superview?.layer.mask)
        XCTAssertTrue(container.underlay.superview?.clipsToBounds == true)
        XCTAssertFalse(container.applyDrawerCoverage(history, group: "profile", privacy: privacy, revision: 4))
        XCTAssertFalse(container.applyDrawerCoverage(history, group: "history", privacy: privacy + 1, revision: 4))
        XCTAssertTrue(container.retire(group: "history", document: "synthetic", ownerEpoch: "history-epoch", generation: 2))
        XCTAssertEqual(container.baseVisibleFrame, .zero, "Uncertain/retired coverage must not paint over the drawer")
        regions(5, drawer: "profile")
        let terminal = NativePanelPose(document: "synthetic", ownerEpoch: "exit-epoch", generation: 3,
            sequence: 1, privacyGeneration: privacy, frame: container.bounds, offset: container.bounds.width,
            opacity: 1, settled: false)
        XCTAssertTrue(container.applyDrawerCoverage(terminal, group: "profile", privacy: privacy, revision: 5))
        XCTAssertEqual(container.baseVisibleFrame, container.bounds)
        regions(6, drawer: nil) // Apply release before clearing the captured pose.
        XCTAssertTrue(container.retire(group: "profile", document: "synthetic", ownerEpoch: "exit-epoch", generation: 3))
        XCTAssertEqual(container.baseVisibleFrame, container.bounds, "Normal release-then-retire must never blank exposed glass")
        let entering = NativePanelPose(document: "synthetic", ownerEpoch: "atomic-entry", generation: 4,
            sequence: 1, privacyGeneration: privacy, frame: container.bounds, offset: 200, opacity: 1, settled: false)
        XCTAssertTrue(container.setRegions(document: "synthetic", revision: 7,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: true,
            covered: true, privacyGeneration: privacy, drawer: "profile", initialPose: entering))
        XCTAssertEqual(container.baseVisibleFrame.width, 200,
            "Atomic first coverage must expose the retained plane without a zero-frame intermediate state")
        XCTAssertFalse(control.isUserInteractionEnabled)
        XCTAssertTrue(container.drawerCoverageIsSuperseded(entering, group: "profile", privacy: privacy, revision: 7),
            "An already committed atomic pose is a no-op, not a failed drawer lifetime")
        XCTAssertFalse(container.drawerCoverageIsSuperseded(entering, group: "profile", privacy: privacy + 1, revision: 7))
        XCTAssertFalse(container.drawerCoverageIsSuperseded(entering, group: "history", privacy: privacy, revision: 7))
        let foreignDuplicate = NativePanelPose(document: "synthetic", ownerEpoch: "different-owner", generation: 4,
            sequence: 1, privacyGeneration: privacy, frame: container.bounds, offset: 200, opacity: 1, settled: false)
        XCTAssertFalse(container.drawerCoverageIsSuperseded(foreignDuplicate, group: "profile", privacy: privacy, revision: 7),
            "Sequence coincidence must never admit another owner as a superseded delivery")
        let stale = NativePanelPose(document: "synthetic", ownerEpoch: "stale-entry", generation: 4,
            sequence: 2, privacyGeneration: privacy, frame: container.bounds, offset: 300, opacity: 1, settled: false)
        XCTAssertFalse(container.drawerCoverageIsSuperseded(stale, group: "profile", privacy: privacy, revision: 7),
            "A changed owner cannot be treated as an overtaken presentation")
        XCTAssertFalse(container.setRegions(document: "synthetic", revision: 8,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: true,
            covered: true, privacyGeneration: privacy, drawer: "profile", initialPose: stale))
        XCTAssertEqual(container.baseVisibleFrame.width, 200, "Rejected admission cannot partially commit a newer region")
        XCTAssertFalse(container.setRegions(document: "synthetic", revision: 8,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: true,
            covered: true, privacyGeneration: privacy + 1, drawer: "profile", initialPose: entering))
        XCTAssertTrue(container.setRegions(document: "synthetic", revision: 8,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: false,
            privacyGeneration: privacy))
        regions(9, drawer: "profile")
        let reopened = NativePanelPose(document: "synthetic", ownerEpoch: "reopened-epoch", generation: 5,
            sequence: 1, privacyGeneration: privacy, frame: container.bounds, offset: 80, opacity: 1, settled: false)
        XCTAssertTrue(container.applyDrawerCoverage(reopened, group: "profile", privacy: privacy, revision: 9))
        XCTAssertFalse(container.retire(group: "profile", document: "synthetic", ownerEpoch: "exit-epoch", generation: 3))
        XCTAssertEqual(container.baseVisibleFrame.width, 80, "Late cleanup cannot clear a reopened presentation")
        // Initial sampling and the ordinary pose writer have independent
        // bridge deliveries. A newest region must not fail or rewind pixels
        // when its same-owner initial pose loses that ordering race.
        let sampled = NativePanelPose(document: "synthetic", ownerEpoch: "reopened-epoch", generation: 5,
            sequence: 2, privacyGeneration: privacy, frame: container.bounds, offset: 100, opacity: 1, settled: false)
        let advanced = NativePanelPose(document: "synthetic", ownerEpoch: "reopened-epoch", generation: 5,
            sequence: 3, privacyGeneration: privacy, frame: container.bounds, offset: 120, opacity: 1, settled: false)
        XCTAssertTrue(container.applyDrawerCoverage(advanced, group: "profile", privacy: privacy, revision: 9))
        let foreignSample = NativePanelPose(document: "synthetic", ownerEpoch: "foreign-owner", generation: 5,
            sequence: 2, privacyGeneration: privacy, frame: container.bounds, offset: 100, opacity: 1, settled: false)
        XCTAssertFalse(container.setRegions(document: "synthetic", revision: 10,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: true,
            covered: true, privacyGeneration: privacy, drawer: "profile", initialPose: foreignSample))
        let malformedSample = NativePanelPose(document: "synthetic", ownerEpoch: "reopened-epoch", generation: 5,
            sequence: 2, privacyGeneration: privacy, frame: container.bounds,
            offset: container.bounds.width + 1, opacity: 1, settled: false)
        XCTAssertFalse(container.setRegions(document: "synthetic", revision: 10,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: true,
            covered: true, privacyGeneration: privacy, drawer: "profile", initialPose: malformedSample))
        XCTAssertTrue(container.acceptsPresentationRevision(9, privacyGeneration: privacy))
        XCTAssertEqual(container.groupPose("profile"), advanced)
        XCTAssertTrue(container.setRegions(document: "synthetic", revision: 10,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: true,
            covered: true, privacyGeneration: privacy, drawer: "profile", initialPose: sampled))
        XCTAssertEqual(container.groupPose("profile"), advanced)
        XCTAssertEqual(container.baseVisibleFrame.width, 120, "Region admission must preserve newer geometry")
        XCTAssertTrue(container.acceptsPresentationRevision(10, privacyGeneration: privacy))
        XCTAssertFalse(container.acceptsPresentationRevision(9, privacyGeneration: privacy))
        XCTAssertFalse(control.isUserInteractionEnabled, "Layout admission never grants covered actions")
        let ulp = CGFloat(Float(container.bounds.width).ulp)
        let noisy = NativePanelPose(document: "synthetic", ownerEpoch: "pixel-epoch", generation: 6,
            sequence: 1, privacyGeneration: privacy,
            frame: CGRect(x: -ulp, y: 0, width: container.bounds.width + ulp, height: container.bounds.height),
            offset: 150, opacity: 1, settled: false)
        XCTAssertTrue(container.setRegions(document: "synthetic", revision: 11,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: true,
            covered: true, privacyGeneration: privacy, drawer: "profile", initialPose: noisy),
            "Observed WebKit transform round-off cannot retire a full-height drawer/dock")
        let outside = NativePanelPose(document: "synthetic", ownerEpoch: "pixel-epoch", generation: 6,
            sequence: 2, privacyGeneration: privacy,
            frame: CGRect(x: -0.01, y: 0, width: container.bounds.width + 0.01, height: container.bounds.height),
            offset: 150, opacity: 1, settled: false)
        XCTAssertFalse(container.setRegions(document: "synthetic", revision: 12,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: true,
            covered: true, privacyGeneration: privacy, drawer: "profile", initialPose: outside),
            "Machine precision must not become a permissive CSS-pixel containment margin")
        XCTAssertEqual(container.groupPose("profile"), noisy)
        XCTAssertTrue(container.acceptsPresentationRevision(11, privacyGeneration: privacy))
        container.conceal()
        regions(12, drawer: nil)
        XCTAssertEqual(container.baseVisibleFrame, .zero)
        XCTAssertTrue(container.underlay.isHidden, "Region release must never clear privacy")
        XCTAssertTrue(web.superview === container)
    }

    @MainActor
    func testNativePanelPoseAndClippingDoNotGrantStaleOrOutsideHits() {
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let container = NativePresentationContainer(webView: web)
        let control = UIButton(frame: CGRect(x: 10, y: 10, width: 44, height: 44))
        let pose = NativePanelPose(document: "synthetic", ownerEpoch: "epoch", generation: 1,
            sequence: 1, privacyGeneration: 0, frame: CGRect(x: 100, y: 0, width: 100, height: 844),
            offset: 0, opacity: 1, settled: true)
        container.install(control, id: "profile-close", group: "profile")
        XCTAssertTrue(container.apply(pose, group: "profile", privacy: 0))
        container.setAdmission("profile-close", admitted: true)
        XCTAssertTrue(web.superview === container)
        XCTAssertTrue(container.subviews.first === web,
            "WK's rectangle must not sit in front of native controls in UIKit traversal")
        XCTAssertLessThan(container.underlay.layer.zPosition, web.layer.zPosition,
            "Native accessibility ordering must not move glass above product paint")
        let navigation = UITabBar(frame: CGRect(x: 0, y: 761, width: 390, height: 83))
        container.install(navigation, id: "bottom-navigation", group: nil)
        container.setAdmission("bottom-navigation", admitted: true)
        XCTAssertTrue(navigation.superview === container.underlay,
            "The retained bar must paint beneath the WebView's drawer scrim, not over product rows")
        container.setAdmission("bottom-navigation", admitted: false)
        XCTAssertFalse(navigation.isHidden)
        XCTAssertFalse(navigation.isUserInteractionEnabled)
        XCTAssertTrue(navigation.accessibilityElementsHidden)
        XCTAssertFalse(container.hitTest(CGPoint(x: 120, y: 800), with: nil)?.isDescendant(of: navigation) == true)
        XCTAssertTrue(container.hitTest(CGPoint(x: 120, y: 20), with: nil) === control)
        control.frame.origin.x = -30 // Its bounds extend outside the clipped group.
        XCTAssertFalse(container.hitTest(CGPoint(x: 85, y: 20), with: nil) === control)
        XCTAssertFalse(container.apply(pose, group: "profile", privacy: 0), "Reordered pose cannot regain interaction")
        control.frame.origin.x = 10
        let originalHost = control.superview
        let moving = NativePanelPose(document: "synthetic", ownerEpoch: "epoch", generation: 1,
            sequence: 2, privacyGeneration: 0, frame: pose.frame, offset: 30, opacity: 1, settled: false)
        XCTAssertTrue(container.apply(moving, group: "profile", privacy: 0))
        XCTAssertTrue(control.superview === originalHost, "Motion must preserve the native presentation")
        XCTAssertFalse(control.isHidden, "Interaction suspension must not hide a moving control")
        XCTAssertFalse(control.isUserInteractionEnabled)
        XCTAssertTrue(control.accessibilityElementsHidden)
        XCTAssertFalse(container.hitTest(CGPoint(x: 150, y: 20), with: nil) === control,
            "A moving native control cannot execute an action")
        let transparent = NativePanelPose(document: "synthetic", ownerEpoch: "epoch", generation: 1,
            sequence: 3, privacyGeneration: 0, frame: pose.frame, offset: 0, opacity: 0, settled: true)
        XCTAssertTrue(container.apply(transparent, group: "profile", privacy: 0))
        container.setAdmission("profile-close", admitted: true)
        XCTAssertFalse(container.hitTest(CGPoint(x: 120, y: 20), with: nil) === control,
            "Ancestor opacity must exclude a native hit even when its own view is visible")
        XCTAssertTrue(container.retire(group: "profile", document: "synthetic", ownerEpoch: "epoch", generation: 1))
        XCTAssertFalse(container.apply(pose, group: "profile", privacy: 0), "Retired presentation cannot resurrect")
        container.conceal()
        XCTAssertFalse(container.hitTest(CGPoint(x: 120, y: 20), with: nil) === control)
    }

    func testAppHapticMigrationUsesAnExplicitDisabledValueOnce() {
        let name = "hushh-haptic-test-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set(true, forKey: "hapticFeedback")
        defaults.set("{\"hapticFeedback\":false,\"theme\":\"dark\"}", forKey: "CapacitorStorage.hushh_settings")
        XCTAssertFalse(HushhAppHaptics.enabled(in: defaults))
        defaults.set(true, forKey: "hapticFeedback")
        XCTAssertTrue(HushhAppHaptics.enabled(in: defaults), "Legacy JSON cannot override the authoritative native value after migration")
        XCTAssertNil(defaults.object(forKey: "theme"), "No unrelated setting is migrated")
    }

    func testAppHapticFeedbackCannotReplayOrQueueExpiredChoices() {
        var state = HushhAppHapticFeedbackState()
        XCTAssertTrue(state.consume("choice-1", issuedAt: 1000, now: 1001))
        XCTAssertFalse(state.consume("choice-1", issuedAt: 1000, now: 1002), "One choice must not vibrate twice")
        XCTAssertFalse(state.consume("expired", issuedAt: 1000, now: 1251), "Late feedback is dropped, not queued")
        XCTAssertFalse(state.consume("future", issuedAt: 1100, now: 1000))
        XCTAssertTrue(state.consume("choice-2", issuedAt: 1002, now: 1003), "A distinct current choice remains admitted")
    }

    @MainActor
    func testDockFollowsKeyboardLayoutWithoutAnotherApplyAndVoiceReleasesTheLift() {
        let parent = UIView(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let window = UIWindow(frame: parent.bounds)
        let controller = UIViewController(); controller.view = parent
        window.rootViewController = controller; window.isHidden = false
        defer { window.isHidden = true }
        let dock = UIView(); parent.addSubview(dock)
        let keyboard = UILayoutGuide(); parent.addLayoutGuide(keyboard)
        let top = keyboard.topAnchor.constraint(equalTo: parent.topAnchor, constant: 844)
        NSLayoutConstraint.activate([top, keyboard.leadingAnchor.constraint(equalTo: parent.leadingAnchor),
            keyboard.widthAnchor.constraint(equalTo: parent.widthAnchor), keyboard.heightAnchor.constraint(equalToConstant: 0)])
        let placement = NativeDockPlacement(parent: parent, dock: dock, keyboard: keyboard)
        let frame = CGRect(x: 16, y: 700, width: 358, height: 52)
        XCTAssertTrue(placement.update(frame: frame, height: 52, editing: true))
        parent.layoutIfNeeded()
        XCTAssertEqual(dock.frame.maxY, 752, accuracy: 0.5)
        for _ in 0..<10 {
            XCTAssertFalse(placement.update(frame: frame, height: 52, editing: true),
                "A settled host layout must not schedule another dock layout")
            parent.layoutIfNeeded()
        }
        var receipts = NativeDockLayoutState()
        XCTAssertTrue(receipts.record(dock.frame, update: 1, privacy: 0))
        XCTAssertEqual(receipts.sequence, 1)
        top.constant = 500 // No bridge apply or web resize occurs here.
        parent.layoutIfNeeded()
        XCTAssertEqual(dock.frame.maxY, 492, accuracy: 0.5)
        XCTAssertEqual(dock.frame.height, 52, accuracy: 0.5)
        XCTAssertTrue(receipts.record(dock.frame, update: 1, privacy: 0))
        XCTAssertEqual(receipts.sequence, 2) // Equal height does not hide occlusion movement.
        XCTAssertFalse(receipts.record(dock.frame, update: 1, privacy: 0))
        XCTAssertFalse(placement.update(frame: frame, height: 52, editing: true),
            "Keyboard-guide movement is system-owned, not another bridge apply")
        XCTAssertTrue(placement.update(frame: frame, height: 52, editing: false))
        parent.layoutIfNeeded()
        XCTAssertEqual(dock.frame.maxY, 752, accuracy: 0.5)
        XCTAssertTrue(receipts.record(dock.frame, update: 1, privacy: 0))
    }

    @MainActor
    func testDockRetainsEditorAndSelectionAcrossVoiceAndThemeUpdates() throws {
        guard #available(iOS 26.0, *) else { throw XCTSkip("Native dock requires iOS 26") }
        let model = NativeDockModel()
        model.mode = "text"; model.visible = true; model.interactionEnabled = true; model.editable = true
        model.micEnabled = true; model.sendEnabled = true
        model.placeholder = "Message One"
        let host = UIHostingController(rootView: NativeAgentDockView(model: model))
        host.safeAreaRegions = []
        host.view.backgroundColor = .clear
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let parent = UIViewController()
        let container = NativePresentationContainer(
            webView: WKWebView(frame: window.bounds), basePresentation: .contentBacked)
        parent.view = container
        parent.view.backgroundColor = .systemBackground
        window.rootViewController = parent; window.isHidden = false
        parent.addChild(host); container.install(host.view, id: "agent-dock", group: nil); host.didMove(toParent: parent)
        host.view.frame = CGRect(x: 16, y: 700, width: 358, height: 100)
        defer { model.clear(); host.view.removeFromSuperview(); host.removeFromParent(); window.isHidden = true }
        host.view.layoutIfNeeded()
        XCTAssertEqual(host.sizeThatFits(in: CGSize(width: 358, height: 340)).height, 52, accuracy: 1,
            "Compact editor and two actions must fit the existing 52-point Agent Bar, without glass-button padding enlarging it")
        let editor = try XCTUnwrap(model.editor)
        XCTAssertFalse(editor.placeholderLabel.isHidden)
        XCTAssertEqual(editor.placeholderLabel.font, editor.font)
        XCTAssertEqual(editor.placeholderLabel.frame.minX, editor.textContainerInset.left, accuracy: 0.5)
        XCTAssertEqual(editor.placeholderLabel.frame.midY,
            editor.caretRect(for: editor.beginningOfDocument).midY, accuracy: 1)
        if ProcessInfo.processInfo.environment["HUSHH_DOCK_SYNTHETIC_VISUALS"] == "1" {
            // Only this opaque, synthetic window: never capture the app's
            // WebView, a reviewer session, or a private native dock.
            let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
            let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
            window.windowScene = scene
            let web = WKWebView(frame: window.bounds)
            let composition = NativePresentationContainer(webView: web, basePresentation: .contentBacked)
            parent.view = composition
            composition.install(host.view, id: "agent-dock", group: nil)
            let bar = UITabBar(frame: CGRect(x: 0, y: 761, width: 390, height: 83))
            bar.items = try XCTUnwrap(HushhNativeNavigationArtwork.items())
            bar.selectedItem = bar.items?.first
            composition.install(bar, id: "bottom-navigation", group: nil)
            let button = UIHostingController(rootView: NativeChromeButton(label: "Open chat history",
                controlId: "chat-history-toggle", symbol: "line.3.horizontal",
                theme: HushhNativeControlAppearance(appearance: "light", accentHex: "#007aff", foregroundHex: "#222222")!,
                action: {}, layout: { _ in }, focus: ChromeFocusRequest()))
            button.safeAreaRegions = []; button.view.backgroundColor = .clear
            parent.addChild(button)
            composition.install(button.view, id: "chat-history-toggle", group: nil)
            button.didMove(toParent: parent)
            button.view.frame = CGRect(x: 16, y: 64, width: 44, height: 44)
            window.makeKeyAndVisible()
            defer {
                button.willMove(toParent: nil); button.view.removeFromSuperview(); button.removeFromParent()
                window.isHidden = true; previousKeyWindow?.makeKeyAndVisible()
            }
            host.view.frame.size.height = 52
            for style in [UIUserInterfaceStyle.light, .dark] {
                parent.overrideUserInterfaceStyle = style
                host.overrideUserInterfaceStyle = style
                button.overrideUserInterfaceStyle = style; bar.overrideUserInterfaceStyle = style
                let dark = style == .dark
                composition.setCanvas(dark ? UIColor(red: 0.055, green: 0.055, blue: 0.063, alpha: 1) : .systemGroupedBackground, appearance: style)
                // Opaque, synthetic page content only. Capturing the entire
                // attached test window includes the effect's real backdrop.
                web.loadHTMLString("""
                    <meta name="viewport" content="width=device-width,initial-scale=1"><style>
                    body{margin:0;background:\(dark ? "#0e0e10" : "#f2f2f7");color:\(dark ? "#f5f5f7" : "#222");font:16px -apple-system}
                    main{padding:128px 16px 0}h1{font-size:28px}section{height:160px;border-radius:20px;padding:16px;background:linear-gradient(135deg,#64c7f0,#8f7aef);margin:16px 0}
                    </style><main><h1>Native material study</h1><p>Synthetic public content</p><section>Page-backed glass</section><section>Shared Hussh geometry</section><section>Content continues beneath the dock</section></main>
                    """, baseURL: nil)
                let loaded = expectation(for: NSPredicate { _, _ in !web.isLoading }, evaluatedWith: web)
                wait(for: [loaded], timeout: 5)
                for accent in ["#007aff", "#d4a574"] {
                    let theme = HushhNativeControlAppearance(appearance: dark ? "dark" : "light",
                        accentHex: accent, foregroundHex: dark ? "#f5f5f7" : "#222222")!
                    model.accent = theme.accent; bar.tintColor = theme.accent; bar.unselectedItemTintColor = .label
                    button.rootView = NativeChromeButton(label: "Open chat history", controlId: "chat-history-toggle",
                        symbol: "line.3.horizontal", theme: theme, action: {}, layout: { _ in }, focus: ChromeFocusRequest())
                    for mode in ["text", "voice"] {
                        model.mode = mode
                        model.placeholder = mode == "text" ? "Message One" : "Talk to One"
                        RunLoop.main.run(until: Date().addingTimeInterval(0.2))
                        host.view.layoutIfNeeded()
                        var rendered = false
                        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                            rendered = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
                        }
                        XCTAssertTrue(rendered, "Synthetic visual capture must reach an attached native presentation")
                        let attachment = XCTAttachment(image: image)
                        attachment.name = "synthetic-material-\(dark ? "dark" : "light")-\(accent == "#007aff" ? "blue" : "gold")-\(mode)"
                        attachment.lifetime = .keepAlways
                        add(attachment)
                    }
                }
            }
            model.mode = "text"; model.placeholder = "Message One"
        }
        model.text = "Hello 👋"
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        host.view.layoutIfNeeded()
        XCTAssertTrue(editor.placeholderLabel.isHidden)
        editor.selectedRange = NSRange(location: 2, length: 2)
        for mode in ["voice", "text", "voice", "text"] {
            model.mode = mode
            model.editorLabel = mode == "voice" ? "Message One" : "Message Puppy"
            model.accent = UIColor.label
            host.overrideUserInterfaceStyle = .dark
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
            host.view.layoutIfNeeded()
            XCTAssertTrue(model.editor === editor)
            XCTAssertEqual(editor.accessibilityLabel, model.editorLabel,
                "The retained editor must identify the applied authored port, not the earlier selector choice")
            XCTAssertEqual(editor.text, "Hello 👋")
            XCTAssertEqual(editor.selectedRange, NSRange(location: 2, length: 2))
        }
        // Return is ordinary editing, not Send. IME is owned by UITextView.
        XCTAssertTrue(editor.delegate?.textView?(editor, shouldChangeTextIn: NSRange(location: 0, length: 0), replacementText: "\n") == true)
        var sends = 0
        editor.submit = { sends += 1 }
        XCTAssertTrue(editor.becomeFirstResponder())
        model.interactionEnabled = false
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        host.view.layoutIfNeeded()
        XCTAssertTrue(editor.isFirstResponder, "Temporary admission revocation must not dismiss the system keyboard")
        XCTAssertTrue(model.editor === editor)
        XCTAssertFalse(editor.delegate?.textView?(editor, shouldChangeTextIn: NSRange(location: 0, length: 0), replacementText: "x") == true)
        var blockedEvents = 0
        model.emit = { _, _, _, _, _ in blockedEvents += 1 }
        XCTAssertFalse(editor.delegate?.textView?(editor, shouldChangeTextIn: NSRange(location: 0, length: 0), replacementText: String(repeating: "x", count: 1200)) == true)
        model.action("send")
        XCTAssertEqual(blockedEvents, 0)
        model.interactionEnabled = true
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        let selected = editor.selectedRange
        let escape = try XCTUnwrap(editor.keyCommands?.first { $0.input == UIKeyCommand.inputEscape })
        XCTAssertTrue(escape.wantsPriorityOverSystemBehavior, "Escape must reach the idle editor before UIKit focus consumes it")
        editor.perform(escape.action, with: escape)
        XCTAssertFalse(editor.isFirstResponder)
        XCTAssertEqual(editor.text, "Hello 👋")
        XCTAssertEqual(editor.selectedRange, selected)
        XCTAssertEqual(sends, 0)
        // Actual overlay admission must release native focus independently of
        // a queued React/plugin apply, without destroying the retained draft.
        XCTAssertTrue(editor.becomeFirstResponder())
        XCTAssertTrue(container.setRegions(document: "synthetic", revision: 1,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: false))
        XCTAssertTrue(editor.isFirstResponder, "Compatible geometry must retain editing")
        XCTAssertTrue(container.setRegions(document: "synthetic", revision: 2,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: true))
        XCTAssertFalse(editor.isFirstResponder, "Confirmed modal admission must release native editor focus")
        XCTAssertTrue(model.editor === editor)
        XCTAssertEqual(editor.text, "Hello 👋")
        XCTAssertEqual(editor.selectedRange, selected)
        XCTAssertTrue(container.setRegions(document: "synthetic", revision: 3,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: false))
        XCTAssertTrue(editor.becomeFirstResponder())
        XCTAssertFalse(container.setRegions(document: "synthetic", revision: 2,
            viewport: container.bounds.size, top: 100, bottom: 150, isolated: true))
        XCTAssertTrue(editor.isFirstResponder, "Rejected stale coverage cannot interrupt resumed editing")
        editor.resignFirstResponder()
        model.awaitingConsumption = true
        model.consumeText()
        XCTAssertFalse(editor.placeholderLabel.isHidden,
            "Committed consumption restores the empty-editor label synchronously, not after another React/native update")
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        host.view.layoutIfNeeded()
        XCTAssertFalse(editor.isEditable) // An uncertain Send cannot overwrite the unsent owner draft.
        model.awaitingConsumption = false; model.text = "Restored unsent draft"
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        host.view.layoutIfNeeded()
        XCTAssertTrue(editor.isEditable)
        XCTAssertTrue(model.editor === editor)
        XCTAssertEqual(editor.text, "Restored unsent draft")
        model.awaitingTransition = true
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        host.view.layoutIfNeeded()
        XCTAssertFalse(editor.isEditable)
        model.awaitingTransition = false
    }

    func testDockEditsSurviveAppearanceEchoButActionsRequireCurrentSnapshot() {
        var fence = HushhDockFence()
        let identity = HushhDockFence.Identity(document: "dock-doc", owner: "owner-a", revision: 1)
        XCTAssertTrue(fence.apply(identity, sequence: 1))
        fence.edited()
        let edit = fence.emitted(kind: "edit")
        let oldSend = fence.emitted(kind: "action")
        XCTAssertTrue(fence.apply(identity, sequence: 2))
        XCTAssertTrue(fence.confirm(identity, sequence: edit, applied: 1, editRevision: 1, kind: "edit", allowed: true))
        XCTAssertFalse(fence.confirm(identity, sequence: oldSend, applied: 1, editRevision: 1, kind: "action", allowed: true))
        let send = fence.emitted(kind: "action")
        XCTAssertFalse(fence.confirm(identity, sequence: send, applied: 2, editRevision: 1, kind: "edit", allowed: true))
        XCTAssertTrue(fence.confirm(identity, sequence: send, applied: 2, editRevision: 1, kind: "action", allowed: true))
        XCTAssertFalse(fence.confirm(identity, sequence: send, applied: 2, editRevision: 1, kind: "action", allowed: true))
    }

    func testDockOwnerRetirementAndPrivacyCannotAuthorizeAnEarlierChoice() {
        var fence = HushhDockFence()
        let old = HushhDockFence.Identity(document: "dock-doc", owner: "owner-a", revision: 1)
        let next = HushhDockFence.Identity(document: "dock-doc", owner: "owner-b", revision: 2)
        var pending = HushhDockFence()
        XCTAssertFalse(pending.retire(old), "Withdrawal before apply has no installed host to detach")
        XCTAssertFalse(pending.apply(old, sequence: 1), "A delayed first apply cannot resurrect a withdrawn editor")
        XCTAssertTrue(pending.apply(next, sequence: 1), "A newer owner revision is not the withdrawn lease")
        XCTAssertFalse(pending.retire(old))
        XCTAssertEqual(pending.identity, next, "Late withdrawal cannot remove the successor")
        XCTAssertTrue(fence.apply(old, sequence: 1))
        let choice = fence.emitted(kind: "action")
        XCTAssertFalse(fence.confirm(old, sequence: choice, applied: 1, editRevision: 0, kind: "action", allowed: false))
        XCTAssertTrue(fence.retire(old))
        XCTAssertFalse(fence.apply(old, sequence: 2))
        XCTAssertTrue(fence.apply(next, sequence: 1))
        let coveredChoice = fence.emitted(kind: "action", action: "send")
        fence.invalidateChoices()
        XCTAssertEqual(fence.identity, next)
        XCTAssertEqual(fence.edit, 0, "Coverage cannot discard or manufacture an editor revision")
        XCTAssertFalse(fence.confirm(next, sequence: coveredChoice, applied: 1, editRevision: 0, kind: "action", allowed: true),
            "Uncovering cannot revive a pre-drawer Send")
        XCTAssertFalse(fence.confirm(old, sequence: choice, applied: 1, editRevision: 0, kind: "action", allowed: true))
        XCTAssertFalse(fence.retire(old))
        XCTAssertEqual(fence.identity, next)
        XCTAssertTrue(fence.retire(next))
        let nextDocument = HushhDockFence.Identity(document: "next-doc", owner: "owner-b", revision: 1)
        XCTAssertTrue(fence.apply(nextDocument, sequence: 1), "A new document starts its own revision sequence after confirmed retirement")
        XCTAssertFalse(fence.apply(.init(document: "dock-doc", owner: "owner-a", revision: 3), sequence: 2),
            "The earlier document cannot regain its private editor")
    }

    func testDockConsumesConfirmedSendOnceButNeverDiscardsAnInterveningEdit() {
        var fence = HushhDockFence()
        let identity = HushhDockFence.Identity(document: "dock-doc", owner: "owner-a", revision: 1)
        XCTAssertTrue(fence.apply(identity, sequence: 1))
        fence.edited()
        let send = fence.emitted(kind: "action", action: "send")
        XCTAssertTrue(fence.confirm(identity, sequence: send, applied: 1, editRevision: 1, kind: "action", allowed: true))
        XCTAssertTrue(fence.consume(identity, sequence: send, editRevision: 1, allowed: true))
        XCTAssertEqual(fence.edit, 2)
        XCTAssertFalse(fence.consume(identity, sequence: send, editRevision: 1, allowed: true))
        fence.edited()
        let next = fence.emitted(kind: "action", action: "send")
        XCTAssertTrue(fence.confirm(identity, sequence: next, applied: 1, editRevision: 3, kind: "action", allowed: true))
        fence.edited() // A later keystroke before the acknowledgement.
        XCTAssertFalse(fence.consume(identity, sequence: next, editRevision: 3, allowed: true))
        let open = fence.emitted(kind: "action", action: "attachment-edit")
        XCTAssertTrue(fence.confirm(identity, sequence: open, applied: fence.update, editRevision: fence.edit, kind: "action", allowed: true))
        XCTAssertTrue(fence.admitsEditingTransition(identity, sequence: open, editRevision: fence.edit))
        let editAtOpen = fence.edit
        fence.edited()
        XCTAssertFalse(fence.admitsEditingTransition(identity, sequence: open, editRevision: editAtOpen))
        XCTAssertEqual(fence.edit, editAtOpen + 1, "Refusing a stale transition must preserve the intervening keystroke")
    }

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
        #if DEBUG
        let invalidations = plugin.presentationInvalidations
        #endif
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
        #if DEBUG
        XCTAssertEqual(plugin.presentationInvalidations, invalidations,
            "A keyboard cycle must not retire presentation or notify React to replace its native controls")
        notifications.post(name: UIApplication.willResignActiveNotification, object: nil)
        XCTAssertGreaterThan(plugin.presentationInvalidations, invalidations,
            "Privacy still retires the protected presentation immediately")
        #endif
    }

    @MainActor
    func testNativeNavigationDoesNotReadmitDuringAnInterruptedKeyboardDismissal() {
        let plugin = HushhNativeNavigationPlugin()
        plugin.load()
        let ready = expectation(description: "Navigation lifecycle registered")
        DispatchQueue.main.async { ready.fulfill() }
        wait(for: [ready], timeout: 1)
        let center = NotificationCenter.default
        center.post(name: UIResponder.keyboardWillShowNotification, object: nil)
        center.post(name: UIResponder.keyboardWillHideNotification, object: nil)
        XCTAssertTrue(plugin.keyboardVisible)
        center.post(name: UIResponder.keyboardWillShowNotification, object: nil)
        center.post(name: UIResponder.keyboardDidHideNotification, object: nil)
        XCTAssertTrue(plugin.keyboardVisible)
        center.post(name: UIResponder.keyboardWillHideNotification, object: nil)
        center.post(name: UIResponder.keyboardDidHideNotification, object: nil)
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
        state.invalidateChoices(through: 2)
        XCTAssertFalse(state.confirm(first, sequence: 2, latestSequence: 2, allowed: true),
            "A pre-drawer choice stays invalid after isolation ends")
        XCTAssertEqual(state.identity, first)
        XCTAssertEqual(state.phase, "active", "Ordinary coverage is not native retirement")
        let replacement = HushhNativeChromeState.Identity(document: "a", ownerEpoch: "owner-a", revision: 2)
        XCTAssertFalse(state.prepareBackReplacement(replacement, previousRevision: 0))
        XCTAssertFalse(state.prepareBackReplacement(.init(document: "a", ownerEpoch: "owner-b", revision: 2), previousRevision: 1))
        XCTAssertFalse(state.prepareBackReplacement(.init(document: "b", ownerEpoch: "owner-a", revision: 2), previousRevision: 1))
        XCTAssertEqual(state.identity, first) // Refusal must not overwrite the predecessor.
        XCTAssertTrue(state.prepareBackReplacement(replacement, previousRevision: 1))
        XCTAssertFalse(state.confirm(first, sequence: 2, latestSequence: 2, allowed: true))
        XCTAssertFalse(state.confirm(replacement, sequence: 2, latestSequence: 2, allowed: true))
        XCTAssertTrue(state.activate(replacement))
        XCTAssertTrue(state.suspend(replacement))
        XCTAssertEqual(state.identity, replacement) // Host identity survives; action authority does not.
        XCTAssertFalse(state.confirm(replacement, sequence: 2, latestSequence: 2, allowed: true))
        XCTAssertFalse(state.update(replacement, sequence: 1))
        XCTAssertFalse(state.activate(replacement)) // A new preparation is required after suspension.
        XCTAssertFalse(state.suspend(first))
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
        // Covered presentation is retained; neither direct taps nor VoiceOver
        // admission may navigate underneath the authored interaction layer.
        XCTAssertTrue(state.apply(document: "first", revision: 2, visible: true, selected: "chat", interactionEpoch: 1, interactionEnabled: false))
        XCTAssertTrue(state.isPresented(appIsActive: true, shielded: false, keyboardVisible: false))
        XCTAssertFalse(state.acceptsTap("dashboard", appIsActive: true, shielded: false, keyboardVisible: false))
        XCTAssertFalse(state.isPresented(appIsActive: true, shielded: true, keyboardVisible: false))
        XCTAssertFalse(state.isPresented(appIsActive: false, shielded: false, keyboardVisible: false))
        XCTAssertFalse(state.isPresented(appIsActive: true, shielded: false, keyboardVisible: true))
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
        XCTAssertTrue(config.resetAppState)

        // Preparation for attach-only reviewer tests must select the normal
        // passphrase surface without signing out, resetting or auto-unlocking.
        let retainedSession = NativeTestConfiguration(arguments: [
            "App", "-UITestMode",
            "-UITestResetAppState", "false",
            "-UITestAutoReviewerLogin", "false",
            "-UITestRunUiFlows", "false",
        ], environment: [:])
        XCTAssertTrue(retainedSession.enabled)
        XCTAssertFalse(retainedSession.resetAppState)
        XCTAssertFalse(retainedSession.autoReviewerLogin)
        XCTAssertFalse(retainedSession.runUiFlows)
        XCTAssertNil(retainedSession.vaultPassphrase)
        XCTAssertNil(retainedSession.expectedUserId)
        XCTAssertNil(retainedSession.initialRoute)
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

    @MainActor
    func testOwnedAlertsKeepUIKitDelegateAndCompleteDismissalBeforeChoice() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
        let parent = UIViewController()
        let window = UIWindow(windowScene: scene)
        window.rootViewController = parent
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
            previousKeyWindow?.makeKeyAndVisible()
        }
        for style in [UIAlertController.Style.alert, .actionSheet] {
            let alert = UIAlertController(title: "Public confirmation", message: nil, preferredStyle: style)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
            alert.popoverPresentationController?.sourceView = parent.view
            alert.popoverPresentationController?.sourceRect = CGRect(x: 44, y: 44, width: 44, height: 44)
            var choices = 0
            let presenter = HushhNativeChromePresenter(parent: parent, controller: alert, updateSequence: 7) { _, sequence in
                XCTAssertNil(alert.presentingViewController, "Choice cannot precede actual native dismissal")
                XCTAssertEqual(sequence, 7)
                choices += 1
            }
            presenter.present() // Old code aborts in UIKit's alert delegate setter here.
            let visible = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                alert.presentingViewController === parent && !alert.isBeingPresented
            }, object: nil)
            await fulfillment(of: [visible], timeout: 3)
            XCTAssertFalse(alert.presentationController?.delegate === presenter)
            if style == .alert {
                presenter.choose("delete")
                presenter.choose("delete") // Duplicate callbacks must not replay.
            }
            let dismissed = expectation(description: "Owned alert detached")
            presenter.retire { dismissed.fulfill() }
            await fulfillment(of: [dismissed], timeout: 3)
            XCTAssertNil(alert.presentingViewController)
            XCTAssertEqual(choices, style == .alert ? 1 : 0)
        }
        // The fix is alert-specific. Custom sheets retain adaptive dismissal.
        let sheet = UIViewController()
        sheet.modalPresentationStyle = .pageSheet
        let presenter = HushhNativeChromePresenter(parent: parent, controller: sheet, updateSequence: 1) { _, _ in
            XCTFail("Retirement alone must not execute a choice")
        }
        presenter.present()
        XCTAssertTrue(sheet.presentationController?.delegate === presenter)
        let dismissed = expectation(description: "Custom sheet detached")
        presenter.retire { dismissed.fulfill() }
        await fulfillment(of: [dismissed], timeout: 3)
        XCTAssertNil(sheet.presentingViewController)
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
        // A lifecycle code on the wrong status is not trusted, and on its own
        // is not an invalid-owner signal either.
        XCTAssertEqual(
            KaiStreamLifecycleErrorClassifier.bridgeCode(
                statusCode: 401,
                body: #"{"code":"AUTH_ACCOUNT_DELETION_IN_PROGRESS"}"#
            ),
            "HUSHH_HTTP_401"
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
            "HUSHH_HTTP_403"
        )
        XCTAssertEqual(
            KaiStreamLifecycleErrorClassifier.bridgeCode(
                statusCode: 500,
                body: ""
            ),
            "HUSHH_HTTP_500"
        )
    }

    func testKaiStreamLifecycleClassifierOnlyLocksOnAnExplicitInvalidOwnerSignal() {
        // An ordinary feature/permission refusal after a valid owner check
        // (e.g. a disabled connector) must not clear Vault custody.
        XCTAssertEqual(
            KaiStreamLifecycleErrorClassifier.bridgeCode(
                statusCode: 403,
                body: #"{"detail":"Drive chat reads are unavailable"}"#
            ),
            "HUSHH_HTTP_403"
        )
        // The backend's known invalid-token phrasing still clears the vault.
        XCTAssertEqual(
            KaiStreamLifecycleErrorClassifier.bridgeCode(
                statusCode: 401,
                body: #"{"detail":"Token validation failed."}"#
            ),
            "AUTH_VAULT_OWNER_INVALID"
        )
        // So does an explicit invalid-owner code, nested in `detail`.
        XCTAssertEqual(
            KaiStreamLifecycleErrorClassifier.bridgeCode(
                statusCode: 403,
                body: #"{"detail":{"code":"AUTH_VAULT_OWNER_INVALID","message":"Vault owner session was revoked. Unlock again to continue."}}"#
            ),
            "AUTH_VAULT_OWNER_INVALID"
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

@MainActor private final class OwnedMenuTestAnimator: NSObject, UIContextMenuInteractionAnimating {
    var previewViewController: UIViewController? { nil }
    private var completions = [() -> Void]()
    func addAnimations(_ animations: @escaping () -> Void) { animations() }
    func addCompletion(_ completion: @escaping () -> Void) { completions.append(completion) }
    func finish() { let work = completions; completions.removeAll(); work.forEach { $0() } }
}
