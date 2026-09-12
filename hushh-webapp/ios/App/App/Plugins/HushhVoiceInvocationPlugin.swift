@preconcurrency import Capacitor
@preconcurrency import AVFoundation
import Foundation
import UIKit

@objc(HushhVoiceInvocationPlugin)
public final class HushhVoiceInvocationPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HushhVoiceInvocationPlugin"
    public let jsName = "HushhVoiceInvocation"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getCommandCapturePermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestCommandCapturePermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openCommandCaptureSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startCommandCapture", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finishCommandCapture", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelCommandCapture", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPendingInvocation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "claimInvocation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reportInvocationProgress", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "completeInvocation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPendingActionInvocation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "claimActionInvocation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "completeActionInvocation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reportActionInvocationProgress", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateActionEntityIndex", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearActionState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPendingRequestInvocation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "claimRequestInvocation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "completeRequestInvocation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reportRequestInvocationProgress", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelRequestInvocation", returnType: CAPPluginReturnPromise)
    ]

    private var availabilityObserver: NSObjectProtocol?
    private var actionAvailabilityObserver: NSObjectProtocol?
    private var requestAvailabilityObserver: NSObjectProtocol?
    private var commandRecording: OneCommandRecording?
    private var commandForegroundSince = Date().timeIntervalSince1970 * 1000
    private var commandLifecycleObservers: [NSObjectProtocol] = []

    public override func load() {
        for name in [UIApplication.willResignActiveNotification, AVAudioSession.interruptionNotification] {
            commandLifecycleObservers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                self?.commandRecording?.cancel()
                self?.commandRecording = nil
                self?.commandForegroundSince = Date().timeIntervalSince1970 * 1000
            })
        }
        commandLifecycleObservers.append(NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.commandForegroundSince = Date().timeIntervalSince1970 * 1000
        })
        availabilityObserver = NotificationCenter.default.addObserver(
            forName: .oneVoiceInvocationAvailable,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.emitAvailability()
        }
        actionAvailabilityObserver = NotificationCenter.default.addObserver(
            forName: .oneSystemActionInvocationAvailable,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.emitActionAvailability()
        }
        requestAvailabilityObserver = NotificationCenter.default.addObserver(
            forName: .oneSystemRequestInvocationAvailable,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.emitRequestAvailability()
        }
        OneVoiceInvocationCoordinator.shared.publishAvailability(state: "bridge_ready")
        OneSystemActionInvocationCoordinator.shared.publishAvailability(state: "bridge_ready")
        OneSystemRequestInvocationCoordinator.shared.publishAvailability(state: "bridge_ready")
    }

    deinit {
        commandRecording?.cancel()
        commandLifecycleObservers.forEach { NotificationCenter.default.removeObserver($0) }
        if let availabilityObserver {
            NotificationCenter.default.removeObserver(availabilityObserver)
        }
        if let actionAvailabilityObserver {
            NotificationCenter.default.removeObserver(actionAvailabilityObserver)
        }
        if let requestAvailabilityObserver {
            NotificationCenter.default.removeObserver(requestAvailabilityObserver)
        }
    }

    private func commandPermission() -> [String: Any] {
        let state: String
        switch AVAudioSession.sharedInstance().recordPermission {
        case .granted: state = "granted"
        case .denied: state = "denied"
        default: state = "prompt"
        }
        return ["state": state, "sourcePlatform": "ios"]
    }

    @objc func getCommandCapturePermission(_ call: CAPPluginCall) { call.resolve(commandPermission()) }

    @objc func requestCommandCapturePermission(_ call: CAPPluginCall) {
        AVAudioSession.sharedInstance().requestRecordPermission { [weak self] _ in
            DispatchQueue.main.async { guard let self else { call.reject("Capture unavailable."); return }; call.resolve(self.commandPermission()) }
        }
    }

    @objc func openCommandCaptureSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString) else { call.resolve(["opened": false]); return }
            UIApplication.shared.open(url) { call.resolve(["opened": $0]) }
        }
    }

    @objc func startCommandCapture(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let id = call.getString("sessionId"), !id.isEmpty, id.count <= 128 else { call.reject("Invalid recording session."); return }
            guard UIApplication.shared.applicationState == .active,
                  let requestedAt = call.getDouble("requestedAtMs"), requestedAt >= self.commandForegroundSince,
                  requestedAt <= Date().timeIntervalSince1970 * 1000 + 1000 else { call.reject("Recording gesture expired. Tap to record again."); return }
            guard self.commandRecording == nil else { call.reject("The microphone is already in use."); return }
            guard AVAudioSession.sharedInstance().recordPermission == .granted else { call.reject("Microphone permission is required."); return }
            let recording = OneCommandRecording(sessionID: id, maxDurationMs: call.getInt("maxDurationMs") ?? 60_000)
            do { try recording.start(); self.commandRecording = recording; call.resolve(["sessionId": id]) }
            catch { recording.cancel(); call.reject("The microphone could not start.") }
        }
    }

    @objc func finishCommandCapture(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let recording = self.commandRecording, recording.sessionID == call.getString("sessionId") else { call.reject("Recording expired or was cancelled."); return }
            self.commandRecording = nil
            do { call.resolve(try recording.finish()) } catch { recording.cancel(); call.reject("Recording could not be finalized.") }
        }
    }

    @objc func cancelCommandCapture(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let recording = self.commandRecording, recording.sessionID == call.getString("sessionId") else { call.resolve(["cancelled": false]); return }
            self.commandRecording = nil; recording.cancel(); call.resolve(["cancelled": true])
        }
    }

    @objc func getPendingInvocation(_ call: CAPPluginCall) {
        guard let invocation = OneVoiceInvocationCoordinator.shared.pending() else {
            // Capacitor promise payloads are objects. The typed adapter maps an
            // empty object to null so web and Android retain the same contract.
            call.resolve([:])
            return
        }
        call.resolve(invocation.bridgePayload)
    }

    @objc func claimInvocation(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("A non-empty invocation id is required.")
            return
        }
        call.resolve([
            "claimed": OneVoiceInvocationCoordinator.shared.claim(id: id)
        ])
    }

    @objc func completeInvocation(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("A non-empty invocation id is required.")
            return
        }
        guard let outcome = call.getString("outcome"), !outcome.isEmpty else {
            call.reject("A completion outcome is required.")
            return
        }
        OneVoiceInvocationCoordinator.shared.complete(id: id, outcome: outcome)
        call.resolve()
    }

    @objc func reportInvocationProgress(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("A non-empty invocation id is required.")
            return
        }
        guard let state = call.getString("state"), !state.isEmpty else {
            call.reject("A progress state is required.")
            return
        }
        call.resolve([
            "reported": OneVoiceInvocationCoordinator.shared.reportProgress(
                id: id,
                state: state
            )
        ])
    }

    @objc func getPendingActionInvocation(_ call: CAPPluginCall) {
        guard let invocation = OneSystemActionInvocationCoordinator.shared.pending() else {
            call.resolve([:])
            return
        }
        call.resolve(invocation.bridgePayload)
    }

    @objc func claimActionInvocation(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("A non-empty action invocation id is required.")
            return
        }
        call.resolve([
            "claimed": OneSystemActionInvocationCoordinator.shared.claim(id: id)
        ])
    }

    @objc func completeActionInvocation(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("A non-empty action invocation id is required.")
            return
        }
        guard let outcome = call.getString("outcome"), !outcome.isEmpty else {
            call.reject("An action completion outcome is required.")
            return
        }
        let summary = call.getString("summary") ?? "HUSSH could not finish that action."
        OneSystemActionInvocationCoordinator.shared.complete(
            id: id,
            outcome: outcome,
            summary: summary
        )
        call.resolve()
    }

    @objc func reportActionInvocationProgress(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("A non-empty action invocation id is required.")
            return
        }
        guard
            let rawState = call.getString("state"),
            let state = OneSystemActionProgressState(rawValue: rawState)
        else {
            call.reject("A supported action invocation progress state is required.")
            return
        }
        call.resolve([
            "reported": OneSystemActionInvocationCoordinator.shared.reportProgress(
                id: id,
                state: state
            )
        ])
    }

    @objc func updateActionEntityIndex(_ call: CAPPluginCall) {
        guard let ownerID = call.getString("ownerId"), !ownerID.isEmpty else {
            call.reject("A non-empty owner id is required.")
            return
        }
        let contacts = Self.parseEntities(call.getArray("contacts", JSObject.self) ?? [])
        let circles = Self.parseEntities(call.getArray("circles", JSObject.self) ?? [])
        guard OneSystemActionInvocationCoordinator.shared.updateEntityIndex(
            ownerID: ownerID,
            contacts: contacts,
            circles: circles
        ) else {
            call.reject("The HUSSH action entity index could not be updated.")
            return
        }
        call.resolve(["updated": true])
    }

    @objc func clearActionState(_ call: CAPPluginCall) {
        OneSystemActionInvocationCoordinator.shared.cancelAll(
            outcome: call.getString("outcome") ?? "cancelled",
            clearEntityIndex: call.getBool("clearEntityIndex") ?? false
        )
        call.resolve()
    }

    @objc func getPendingRequestInvocation(_ call: CAPPluginCall) {
        guard let invocation = OneSystemRequestInvocationCoordinator.shared.pending() else {
            call.resolve([:])
            return
        }
        call.resolve(invocation.bridgePayload)
    }

    @objc func claimRequestInvocation(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("A non-empty request invocation id is required.")
            return
        }
        guard let record = OneSystemRequestInvocationCoordinator.shared.claimRecord(id: id) else {
            call.resolve(["claimed": false])
            return
        }
        call.resolve([
            "claimed": true,
            "requestText": record.text
        ])
    }

    @objc func reportRequestInvocationProgress(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("A non-empty request invocation id is required.")
            return
        }
        let rawState = call.getString("state")
        guard rawState != nil else {
            call.reject("A progress state is required.")
            return
        }
        call.resolve([
            "reported": OneSystemRequestInvocationCoordinator.shared.reportProgress(
                id: id,
                state: rawState!
            )
        ])
    }

    @objc func completeRequestInvocation(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("A non-empty request invocation id is required.")
            return
        }
        let summary = call.getString("summary") ?? "HUSSH could not finish that request."
        OneSystemRequestInvocationCoordinator.shared.complete(
            id: id,
            outcome: call.getString("outcome") ?? "completed",
            summary: summary
        )
        call.resolve()
    }

    @objc func cancelRequestInvocation(_ call: CAPPluginCall) {
        OneSystemRequestInvocationCoordinator.shared.cancelRequest(id: call.getString("id"))
        call.resolve()
    }

    private func emitAvailability() {
        guard let invocation = OneVoiceInvocationCoordinator.shared.pending() else {
            return
        }
        notifyListeners(
            "voiceInvocationAvailable",
            data: invocation.bridgePayload,
            retainUntilConsumed: true
        )
    }

    private func emitActionAvailability() {
        guard let invocation = OneSystemActionInvocationCoordinator.shared.pending() else {
            return
        }
        notifyListeners(
            "systemActionInvocationAvailable",
            data: invocation.bridgePayload,
            retainUntilConsumed: true
        )
    }

    private func emitRequestAvailability() {
        guard let invocation = OneSystemRequestInvocationCoordinator.shared.pending() else {
            return
        }
        notifyListeners(
            "systemRequestInvocationAvailable",
            data: invocation.bridgePayload,
            retainUntilConsumed: true
        )
    }

    private static func parseEntities(_ values: [JSObject]) -> [OneSystemEntityIndexEntry] {
        values.compactMap { value in
            guard
                let id = value["id"] as? String,
                let name = value["name"] as? String
            else { return nil }
            return OneSystemEntityIndexEntry(id: id, name: name)
        }
    }
}
