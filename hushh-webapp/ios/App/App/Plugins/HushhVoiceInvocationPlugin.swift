@preconcurrency import Capacitor
@preconcurrency import AVFoundation
import Foundation
import Speech

@objc(HushhVoiceInvocationPlugin)
public final class HushhVoiceInvocationPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HushhVoiceInvocationPlugin"
    public let jsName = "HushhVoiceInvocation"
    public let pluginMethods: [CAPPluginMethod] = [
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
        CAPPluginMethod(name: "cancelRequestInvocation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepareFluidAudioModelPack", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getFluidAudioAvailability", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "rollbackFluidAudioModelPack", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startSpeechRecognition", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopSpeechRecognition", returnType: CAPPluginReturnPromise)
    ]

    private var availabilityObserver: NSObjectProtocol?
    private var actionAvailabilityObserver: NSObjectProtocol?
    private var requestAvailabilityObserver: NSObjectProtocol?
    private var speechRecognizer: SFSpeechRecognizer?
    private var speechRequest: SFSpeechAudioBufferRecognitionRequest?
    private var speechTask: SFSpeechRecognitionTask?
    private var speechMicrophoneCapture: OneVoiceMicrophoneCapture?
    private var speechFluidAudioSession: OneVoiceFluidAudioSession?
    private var speechSessionID: String?
    private var speechSequence = 0
    private var speechOnDevice = false
    private var speechProvider = "apple_speech"

    public override func load() {
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
        stopSpeechRecognitionInternal(emitEnd: false)
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

    @objc func startSpeechRecognition(_ call: CAPPluginCall) {
        let requestedSessionID = call.getString("sessionId")?.trimmingCharacters(in: .whitespacesAndNewlines)
        let localeIdentifier = call.getString("locale") ?? Locale.current.identifier
        let wantsOnDevice = call.getBool("onDevice") ?? true
        let allowNetwork = call.getBool("allowNetwork") ?? false
        let preferredProvider = call.getString("provider")?.trimmingCharacters(in: .whitespacesAndNewlines)
        let contextualStrings = (call.getArray("contextualStrings", String.self) ?? [])
            .map { String($0.trimmingCharacters(in: .whitespacesAndNewlines).prefix(64)) }
            .filter { !$0.isEmpty }
            .prefix(100)

        if preferredProvider == "fluid_audio",
           OneVoiceFluidAudioPolicy.runtimeIsEnabled(),
           let modelsDirectory = OneVoiceFluidAudioPackStore.shared.activeModelsDirectory()
        {
            startFluidAudioSpeechRecognition(
                call: call,
                modelsDirectory: modelsDirectory,
                sessionID: requestedSessionID
            )
            return
        }

        startAppleSpeechRecognition(
            call: call,
            localeIdentifier: localeIdentifier,
            wantsOnDevice: wantsOnDevice,
            allowNetwork: allowNetwork,
            sessionID: requestedSessionID,
            contextualStrings: Array(contextualStrings)
        )
    }

    private func startAppleSpeechRecognition(
        call: CAPPluginCall,
        localeIdentifier: String,
        wantsOnDevice: Bool,
        allowNetwork: Bool,
        sessionID: String?,
        contextualStrings: [String]
    ) {
        if speechFluidAudioSession != nil {
            Task { @MainActor [weak self] in
                guard let self else {
                    call.reject("speech_unavailable")
                    return
                }
                await self.stopFluidAudioSpeechRecognition(emitEnd: false)
                self.startAppleSpeechRecognition(
                    call: call,
                    localeIdentifier: localeIdentifier,
                    wantsOnDevice: wantsOnDevice,
                    allowNetwork: allowNetwork,
                    sessionID: sessionID,
                    contextualStrings: contextualStrings
                )
            }
            return
        }

        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            DispatchQueue.main.async {
                guard let self else {
                    call.reject("speech_unavailable")
                    return
                }
                guard status == .authorized else {
                    call.reject("speech_authorization_denied")
                    return
                }
                guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier)) else {
                    call.reject("speech_locale_unavailable")
                    return
                }
                let supportsOnDevice = recognizer.supportsOnDeviceRecognition
                guard !wantsOnDevice || supportsOnDevice || allowNetwork else {
                    call.reject("speech_on_device_unavailable")
                    return
                }
                do {
                    try self.startSpeechRecognitionInternal(
                        recognizer: recognizer,
                        sessionID: sessionID,
                        onDevice: wantsOnDevice && supportsOnDevice,
                        contextualStrings: contextualStrings
                    )
                    call.resolve([
                        "sessionId": self.speechSessionID ?? "",
                        "provider": "apple_speech",
                        "onDevice": self.speechOnDevice
                    ])
                } catch {
                    call.reject("speech_start_failed")
                }
            }
        }
    }

    @objc func stopSpeechRecognition(_ call: CAPPluginCall) {
        let requestedSessionID = call.getString("sessionId")
        if let requestedSessionID, requestedSessionID != speechSessionID {
            call.resolve()
            return
        }
        if speechFluidAudioSession != nil {
            Task { @MainActor [weak self] in
                await self?.stopFluidAudioSpeechRecognition(emitEnd: true)
                call.resolve()
            }
            return
        }
        stopSpeechRecognitionInternal(emitEnd: true)
        call.resolve()
    }

    private func startFluidAudioSpeechRecognition(
        call: CAPPluginCall,
        modelsDirectory: URL,
        sessionID: String?
    ) {
        Task { @MainActor [weak self] in
            guard let self else {
                call.reject("speech_unavailable")
                return
            }
            do {
                try await self.startFluidAudioSpeechRecognitionInternal(
                    modelsDirectory: modelsDirectory,
                    sessionID: sessionID
                )
                call.resolve([
                    "sessionId": self.speechSessionID ?? "",
                    "provider": "fluid_audio",
                    "onDevice": true,
                ])
            } catch {
                // The returned provider tells the web adapter which path was
                // used. Apple Speech is an explicit, truthful fallback rather
                // than a hidden substitution.
                self.startAppleSpeechRecognition(
                    call: call,
                    localeIdentifier: Locale.current.identifier,
                    wantsOnDevice: true,
                    allowNetwork: false,
                    sessionID: sessionID,
                    contextualStrings: []
                )
            }
        }
    }

    @MainActor
    private func startFluidAudioSpeechRecognitionInternal(
        modelsDirectory: URL,
        sessionID: String?
    ) async throws {
        if speechFluidAudioSession != nil {
            await stopFluidAudioSpeechRecognition(emitEnd: false)
        } else {
            stopSpeechRecognitionInternal(emitEnd: false)
        }

        let resolvedSessionID = sessionID?.isEmpty == false ? sessionID! : UUID().uuidString
        let fluidSession = OneVoiceFluidAudioSession(
            sessionID: resolvedSessionID,
            modelsDirectory: modelsDirectory
        ) { [weak self] event in
            self?.emitFluidTranscript(event)
        }
        try await fluidSession.start()

        let microphoneCapture = OneVoiceMicrophoneCapture()
        speechRecognizer = nil
        speechRequest = nil
        speechTask = nil
        speechMicrophoneCapture = microphoneCapture
        speechFluidAudioSession = fluidSession
        speechSessionID = resolvedSessionID
        speechSequence = 0
        speechOnDevice = true
        speechProvider = "fluid_audio"
        do {
            try microphoneCapture.start { [weak fluidSession] buffer, _, _ in
                Task { @MainActor in
                    fluidSession?.append(buffer)
                }
            }
        } catch {
            await fluidSession.stop(emitEnd: false)
            clearSpeechState()
            throw error
        }
    }

    /// Installs a model archive only after native policy, checksum, and model
    /// notice checks agree. The API intentionally returns no signed URL,
    /// filesystem path, model bytes, transcript, or protected app context.
    @objc func prepareFluidAudioModelPack(_ call: CAPPluginCall) {
        guard let request = OneVoiceFluidAudioPackRequest(
            packID: call.getString("packId") ?? "",
            version: call.getString("version") ?? "",
            sizeBytes: call.getInt("sizeBytes") ?? 0,
            checksum: call.getString("checksum") ?? "",
            artifactURL: call.getString("artifactUrl") ?? "",
            entrypoint: call.getString("entrypoint") ?? "",
            licenseNoticeID: call.getString("licenseNoticeId") ?? "",
            licenseApproved: call.getBool("licenseApproved") ?? false
        ) else {
            call.reject("fluid_audio_pack_invalid")
            return
        }

        Task {
            do {
                _ = try await OneVoiceFluidAudioPackStore.shared.installAndActivate(request)
                DispatchQueue.main.async {
                    call.resolve([
                        "ready": true,
                        "packId": request.packID,
                        "version": request.version,
                    ])
                }
            } catch {
                DispatchQueue.main.async {
                    call.resolve(["ready": false, "reason": "fluid_audio_pack_unavailable"])
                }
            }
        }
    }

    @objc func getFluidAudioAvailability(_ call: CAPPluginCall) {
        let available = OneVoiceFluidAudioPolicy.runtimeIsEnabled()
            && OneVoiceFluidAudioPackStore.shared.activeModelsDirectory() != nil
        call.resolve(["available": available])
    }

    @objc func rollbackFluidAudioModelPack(_ call: CAPPluginCall) {
        do {
            let rolledBack = try OneVoiceFluidAudioPackStore.shared.rollback() != nil
            call.resolve(["rolledBack": rolledBack])
        } catch {
            call.resolve(["rolledBack": false])
        }
    }

    private func startSpeechRecognitionInternal(
        recognizer: SFSpeechRecognizer,
        sessionID: String?,
        onDevice: Bool,
        contextualStrings: [String]
    ) throws {
        stopSpeechRecognitionInternal(emitEnd: false)
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = onDevice
        request.contextualStrings = contextualStrings
        let microphoneCapture = OneVoiceMicrophoneCapture()

        speechRecognizer = recognizer
        speechRequest = request
        speechMicrophoneCapture = microphoneCapture
        speechSessionID = sessionID?.isEmpty == false ? sessionID : UUID().uuidString
        speechSequence = 0
        speechOnDevice = onDevice
        speechProvider = "apple_speech"
        speechTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self else { return }
                if let result {
                    let text = result.bestTranscription.formattedString
                    self.emitTranscript(
                        kind: result.isFinal ? "final" : "partial",
                        text: text,
                        confidence: result.bestTranscription.segments.last?.confidence
                    )
                }
                if let error {
                    self.emitTranscript(kind: "error", text: "", errorCode: "speech_provider_error")
                    self.stopSpeechRecognitionInternal(emitEnd: false)
                    _ = error
                }
            }
        }
        do {
            try microphoneCapture.start { [weak self] buffer, _, _ in
                self?.speechRequest?.append(buffer)
            }
        } catch {
            stopSpeechRecognitionInternal(emitEnd: false)
            throw error
        }
    }

    private func stopSpeechRecognitionInternal(emitEnd: Bool) {
        if speechFluidAudioSession != nil {
            speechMicrophoneCapture?.stop()
            Task { @MainActor [weak self] in
                await self?.stopFluidAudioSpeechRecognition(emitEnd: emitEnd)
            }
            return
        }
        guard speechSessionID != nil || speechMicrophoneCapture != nil else { return }
        let sessionID = speechSessionID
        speechMicrophoneCapture?.stop()
        speechTask?.cancel()
        speechRequest?.endAudio()
        if emitEnd, sessionID != nil {
            emitTranscript(kind: "end", text: "")
        }
        clearSpeechState()
    }

    private func emitTranscript(
        kind: String,
        text: String,
        confidence: Float? = nil,
        errorCode: String? = nil
    ) {
        guard let sessionID = speechSessionID else { return }
        speechSequence += 1
        var payload: [String: Any] = [
            "sessionId": sessionID,
            "sequence": speechSequence,
            "kind": kind,
            "text": String(text.prefix(8_000)),
            "provider": speechProvider,
            "onDevice": speechOnDevice
        ]
        if let confidence { payload["confidence"] = max(0, min(1, confidence)) }
        if let errorCode { payload["errorCode"] = errorCode }
        notifyListeners("oneTranscript", data: payload)
    }

    @MainActor
    private func stopFluidAudioSpeechRecognition(emitEnd: Bool) async {
        guard let fluidSession = speechFluidAudioSession else { return }
        speechMicrophoneCapture?.stop()
        speechMicrophoneCapture = nil
        await fluidSession.stop(emitEnd: emitEnd)
        clearSpeechState()
    }

    @MainActor
    private func emitFluidTranscript(_ event: OneVoiceFluidAudioSession.Transcript) {
        var payload: [String: Any] = [
            "sessionId": event.sessionID,
            "sequence": event.sequence,
            "kind": event.kind,
            "text": event.text,
            "provider": "fluid_audio",
            "onDevice": true,
        ]
        if let errorCode = event.errorCode {
            payload["errorCode"] = errorCode
        }
        notifyListeners("oneTranscript", data: payload)
    }

    private func clearSpeechState() {
        speechRecognizer = nil
        speechRequest = nil
        speechTask = nil
        speechMicrophoneCapture = nil
        speechFluidAudioSession = nil
        speechSessionID = nil
        speechSequence = 0
        speechOnDevice = false
        speechProvider = "apple_speech"
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
