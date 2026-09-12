@preconcurrency import Capacitor
@preconcurrency import AVFoundation
import Foundation
import Speech
import UIKit

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
        CAPPluginMethod(name: "startRealtimeAudioCapture", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopRealtimeAudioCapture", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "beginRealtimeAudioInputTurn", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "endRealtimeAudioInputTurn", returnType: CAPPluginReturnPromise),
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
    // The online Gemini path owns this independently from the optional local
    // Apple/Fluid transcript path. Both still share OneVoiceMicrophoneCapture's
    // process-wide ownership fence, so two microphone engines cannot run.
    private var realtimeMicrophoneCapture: OneVoiceMicrophoneCapture?
    private var realtimeAudioSessionID: String?
    private var realtimeAudioInterruptionObserver: NSObjectProtocol?
    private var realtimeAudioRouteChangeObserver: NSObjectProtocol?
    private var realtimeAudioConfigurationChangeObserver: NSObjectProtocol?
    private var realtimeAudioMediaServicesResetObserver: NSObjectProtocol?
    private var realtimeAudioMediaServicesLostObserver: NSObjectProtocol?
    private var realtimeAudioBackgroundObserver: NSObjectProtocol?
    private let realtimeAudioLock = NSLock()
    private let realtimeAudioDeliveryQueue = DispatchQueue(
        label: "com.hushh.onevoice.realtime-pcm-delivery",
        qos: .userInitiated
    )
    private var realtimeAudioStartUptime: TimeInterval?
    private var realtimeAudioReportedFirstFrame = false
    private var realtimeAudioMeasurementGeneration = 0
    private var realtimeAudioDelivery = RealtimeAudioDeliveryState()
    // Five ~20 ms source frames form one ~100 ms Capacitor payload. The
    // serial queue is bounded to four pending deliveries; overload fails the
    // entire input turn rather than silently removing speech from the middle.
    private static let realtimeAudioTargetPacketFrames = 1_600
    private static let realtimeAudioMaximumPendingPackets = 4

    private struct RealtimeAudioPacket {
        let sequence: Int
        let sourceSequenceStart: Int
        let sourceSequenceEnd: Int
        let data: Data
        let frameCount: Int
        let level: Double
        let turnID: String?
    }

    private struct RealtimeAudioTurnEndResult {
        let turnID: String
        let finalSequence: Int
        let cancelled: Bool
    }

    private typealias RealtimeAudioTurnEndCompletion = (
        _ result: RealtimeAudioTurnEndResult?,
        _ errorCode: String?
    ) -> Void

    /// All fields in this value are accessed only on
    /// `realtimeAudioDeliveryQueue`. It deliberately contains no transcript
    /// or retained audio outside the in-flight ~100 ms packet.
    private struct RealtimeAudioDeliveryState {
        var sessionID: String?
        var captureGeneration: Int?
        var explicitTurnMode = false
        var activeTurnID: String?
        var endingTurnID: String?
        var endingCancelled = false
        var expectedSourceSequence: Int?
        var nextPacketSequence = 0
        var turnFinalSequence = 0
        var pendingPacketDeliveries = 0
        var packetData = Data()
        var packetFrameCount = 0
        var packetSourceSequenceStart: Int?
        var packetSourceSequenceEnd: Int?
        var packetLevelSquared = 0.0
        var packetTurnID: String?
        var failed = false
        var endCompletions: [RealtimeAudioTurnEndCompletion] = []
    }

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
        realtimeAudioInterruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] notification in
            self?.handleRealtimeAudioInterruption(notification)
        }
        realtimeAudioRouteChangeObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] notification in
            self?.handleRealtimeAudioRouteChange(notification)
        }
        realtimeAudioConfigurationChangeObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            self?.handleRealtimeAudioConfigurationChange(notification)
        }
        realtimeAudioMediaServicesResetObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] notification in
            self?.handleRealtimeAudioMediaServicesReset(notification)
        }
        realtimeAudioMediaServicesLostObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.mediaServicesWereLostNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] notification in
            self?.handleRealtimeAudioMediaServicesLost(notification)
        }
        realtimeAudioBackgroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            self?.handleRealtimeAudioBackground(notification)
        }
    }

    deinit {
        stopRealtimeAudioCaptureInternal(state: "stopped")
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
        if let realtimeAudioInterruptionObserver {
            NotificationCenter.default.removeObserver(realtimeAudioInterruptionObserver)
        }
        if let realtimeAudioRouteChangeObserver {
            NotificationCenter.default.removeObserver(realtimeAudioRouteChangeObserver)
        }
        if let realtimeAudioConfigurationChangeObserver {
            NotificationCenter.default.removeObserver(realtimeAudioConfigurationChangeObserver)
        }
        if let realtimeAudioMediaServicesResetObserver {
            NotificationCenter.default.removeObserver(realtimeAudioMediaServicesResetObserver)
        }
        if let realtimeAudioMediaServicesLostObserver {
            NotificationCenter.default.removeObserver(realtimeAudioMediaServicesLostObserver)
        }
        if let realtimeAudioBackgroundObserver {
            NotificationCenter.default.removeObserver(realtimeAudioBackgroundObserver)
        }
    }

    /// Opens the production online-audio path. Apple Speech and FluidAudio
    /// remain available only as local/offline transcript adapters; neither is
    /// started here and neither decides when a command becomes executable.
    @objc func startRealtimeAudioCapture(_ call: CAPPluginCall) {
        let requestedSessionID = call.getString("sessionId")?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let requestedSessionID, requestedSessionID.count > 128 {
            call.reject("realtime_audio_session_invalid")
            return
        }
        let sessionID = requestedSessionID?.isEmpty == false
            ? requestedSessionID!
            : UUID().uuidString
        let requiresExplicitTurn = call.getBool("requiresExplicitTurn") ?? false

        if let activeSessionID = realtimeAudioSessionID,
           realtimeMicrophoneCapture != nil
        {
            if requestedSessionID == nil || activeSessionID == sessionID {
                call.resolve(realtimeAudioStartPayload(
                    sessionID: activeSessionID,
                    alreadyActive: true
                ))
                return
            }
            call.reject("realtime_audio_already_active")
            return
        }

        guard speechMicrophoneCapture == nil else {
            emitRealtimeAudioState(
                sessionID: sessionID,
                state: "error",
                errorCode: "offline_capture_active"
            )
            call.reject("offline_capture_active")
            return
        }

        let microphoneCapture = OneVoiceMicrophoneCapture()
        let captureID = ObjectIdentifier(microphoneCapture)
        let captureGeneration = beginRealtimeAudioMeasurements()
        configureRealtimeAudioDelivery(
            sessionID: sessionID,
            captureGeneration: captureGeneration,
            explicitTurnMode: requiresExplicitTurn
        )

        do {
            try microphoneCapture.startPCM16(
                onFrame: { [weak self] frame in
                    self?.enqueueRealtimeAudioFrame(
                        frame,
                        sessionID: sessionID,
                        captureID: captureID,
                        captureGeneration: captureGeneration
                    )
                },
                onError: { [weak self] error in
                    self?.handleRealtimeAudioCaptureError(
                        error,
                        sessionID: sessionID,
                        captureID: captureID
                    )
                }
            )
            // `startPCM16` configures and activates the shared AVAudioSession.
            // That setup is allowed to synchronously publish route/engine
            // notifications. Do not expose this capture as active until setup
            // has completed, otherwise our own notification observer tears it
            // down before the first PCM frame reaches the WebView.
            realtimeMicrophoneCapture = microphoneCapture
            realtimeAudioSessionID = sessionID
            emitRealtimeAudioState(sessionID: sessionID, state: "started")
            call.resolve(realtimeAudioStartPayload(sessionID: sessionID))
        } catch {
            microphoneCapture.stop()
            if realtimeAudioSessionID == sessionID {
                realtimeMicrophoneCapture = nil
                realtimeAudioSessionID = nil
            }
            invalidateRealtimeAudioMeasurements()
            cancelRealtimeAudioDelivery(errorCode: "capture_start_failed")
            // Do not expose AVAudioSession, hardware, or framework error text
            // to the WebView. The category is enough to drive recovery.
            emitRealtimeAudioState(
                sessionID: sessionID,
                state: "error",
                errorCode: "capture_start_failed"
            )
            call.reject("realtime_audio_start_failed")
        }
    }

    @objc func stopRealtimeAudioCapture(_ call: CAPPluginCall) {
        let requestedSessionID = call.getString("sessionId")?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let activeSessionID = realtimeAudioSessionID else {
            call.resolve()
            return
        }
        guard requestedSessionID == nil || requestedSessionID == activeSessionID else {
            // A stale client session must not be able to stop a newer one.
            call.resolve()
            return
        }
        stopRealtimeAudioCaptureInternal(state: "stopped")
        call.resolve()
    }

    /// Starts a held command. Existing start/stop callers remain compatible:
    /// only a caller that invokes this method opts into explicit PTT gating.
    @objc func beginRealtimeAudioInputTurn(_ call: CAPPluginCall) {
        guard let sessionID = matchingRealtimeAudioSessionID(call) else {
            call.reject("realtime_audio_session_invalid")
            return
        }
        guard let turnID = normalizedRealtimeAudioTurnID(call.getString("turnId")) else {
            call.reject("realtime_audio_turn_invalid")
            return
        }

        realtimeAudioDeliveryQueue.async { [weak self] in
            guard let self else { return }
            guard self.realtimeAudioDelivery.sessionID == sessionID,
                  self.realtimeAudioDelivery.captureGeneration != nil,
                  !self.realtimeAudioDelivery.failed
            else {
                self.resolveRealtimeAudioTurnStart(call, result: nil, errorCode: "realtime_audio_not_active")
                return
            }
            guard self.realtimeAudioDelivery.activeTurnID == nil,
                  self.realtimeAudioDelivery.endingTurnID == nil
            else {
                self.resolveRealtimeAudioTurnStart(call, result: nil, errorCode: "realtime_audio_turn_active")
                return
            }

            // Any legacy frames captured before PTT are intentionally outside
            // this command. They are never re-labeled as command audio.
            self.resetRealtimeAudioPacket()
            self.realtimeAudioDelivery.explicitTurnMode = true
            self.realtimeAudioDelivery.activeTurnID = turnID
            self.realtimeAudioDelivery.expectedSourceSequence = nil
            // The relay's command protocol numbers packets within one held
            // turn, beginning at 1.  Reset this bridge-local packet counter
            // with the same boundary so the native tail proof can be compared
            // directly with the command's final sequence on every hold, not
            // only the first one in a warm capture session.
            self.realtimeAudioDelivery.nextPacketSequence = 0
            self.realtimeAudioDelivery.turnFinalSequence = 0

            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                guard self.realtimeAudioSessionID == sessionID else {
                    call.reject("realtime_audio_not_active")
                    return
                }
                self.emitRealtimeAudioState(
                    sessionID: sessionID,
                    state: "turn_started",
                    turnID: turnID
                )
                call.resolve(["sessionId": sessionID, "turnId": turnID])
            }
        }
    }

    /// Ends a held command. The result is resolved only after every packet
    /// queued before release has reached JavaScript and `tail_drained` has
    /// been emitted. Cancellation is explicit so the relay cannot mistake a
    /// background/interruption path for a completed spoken command.
    @objc func endRealtimeAudioInputTurn(_ call: CAPPluginCall) {
        guard let sessionID = matchingRealtimeAudioSessionID(call) else {
            call.reject("realtime_audio_session_invalid")
            return
        }
        guard let turnID = normalizedRealtimeAudioTurnID(call.getString("turnId")) else {
            call.reject("realtime_audio_turn_invalid")
            return
        }
        let cancelled = call.getBool("cancelled") ?? false
        let completion: RealtimeAudioTurnEndCompletion = { result, errorCode in
            DispatchQueue.main.async {
                if let result {
                    call.resolve([
                        "sessionId": sessionID,
                        "turnId": result.turnID,
                        "finalSequence": result.finalSequence,
                        "cancelled": result.cancelled,
                    ])
                } else {
                    call.reject(errorCode ?? "realtime_audio_turn_end_failed")
                }
            }
        }

        realtimeAudioDeliveryQueue.async { [weak self] in
            guard let self else { return }
            guard self.realtimeAudioDelivery.sessionID == sessionID,
                  !self.realtimeAudioDelivery.failed
            else {
                completion(nil, "realtime_audio_not_active")
                return
            }
            if self.realtimeAudioDelivery.endingTurnID == turnID {
                self.realtimeAudioDelivery.endCompletions.append(completion)
                return
            }
            guard self.realtimeAudioDelivery.activeTurnID == turnID else {
                completion(nil, "realtime_audio_turn_not_active")
                return
            }

            self.realtimeAudioDelivery.activeTurnID = nil
            self.realtimeAudioDelivery.endingTurnID = turnID
            self.realtimeAudioDelivery.endingCancelled = cancelled
            self.realtimeAudioDelivery.endCompletions.append(completion)
            DispatchQueue.main.async { [weak self] in
                self?.emitRealtimeAudioState(
                    sessionID: sessionID,
                    state: "turn_ended",
                    turnID: turnID,
                    cancelled: cancelled
                )
            }
            self.flushRealtimeAudioPacket(force: true)
            self.finishRealtimeAudioTurnIfDrained()
        }
    }

    private func realtimeAudioStartPayload(
        sessionID: String,
        alreadyActive: Bool = false
    ) -> [String: Any] {
        [
            "sessionId": sessionID,
            "sampleRate": 16_000,
            "channels": 1,
            "encoding": "pcm_s16le",
            "alreadyActive": alreadyActive,
        ]
    }

    private func matchingRealtimeAudioSessionID(_ call: CAPPluginCall) -> String? {
        guard let activeSessionID = realtimeAudioSessionID else { return nil }
        let requestedSessionID = call.getString("sessionId")?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard requestedSessionID == nil || requestedSessionID == activeSessionID else {
            return nil
        }
        return activeSessionID
    }

    private func normalizedRealtimeAudioTurnID(_ value: String?) -> String? {
        guard let value else { return nil }
        let turnID = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !turnID.isEmpty, turnID.count <= 128 else { return nil }
        return turnID
    }

    private func resolveRealtimeAudioTurnStart(
        _ call: CAPPluginCall,
        result: [String: Any]?,
        errorCode: String?
    ) {
        DispatchQueue.main.async {
            if let result {
                call.resolve(result)
            } else {
                call.reject(errorCode ?? "realtime_audio_turn_start_failed")
            }
        }
    }

    private func configureRealtimeAudioDelivery(
        sessionID: String,
        captureGeneration: Int,
        explicitTurnMode: Bool
    ) {
        realtimeAudioDeliveryQueue.sync {
            realtimeAudioDelivery = RealtimeAudioDeliveryState(
                sessionID: sessionID,
                captureGeneration: captureGeneration,
                explicitTurnMode: explicitTurnMode
            )
        }
    }

    private func enqueueRealtimeAudioFrame(
        _ frame: OneVoiceMicrophoneCapture.PCM16Frame,
        sessionID: String,
        captureID: ObjectIdentifier,
        captureGeneration: Int
    ) {
        realtimeAudioDeliveryQueue.async { [weak self] in
            guard let self else { return }
            guard self.realtimeAudioDelivery.sessionID == sessionID,
                  self.realtimeAudioDelivery.captureGeneration == captureGeneration,
                  !self.realtimeAudioDelivery.failed
            else { return }
            // A PTT session intentionally ignores idle frames. Legacy callers
            // that do not call beginRealtimeAudioInputTurn keep pass-through
            // behavior until they migrate.
            if self.realtimeAudioDelivery.explicitTurnMode,
               self.realtimeAudioDelivery.activeTurnID == nil
            {
                return
            }

            if let expected = self.realtimeAudioDelivery.expectedSourceSequence,
               frame.sequence != expected
            {
                self.failRealtimeAudioDelivery(
                    sessionID: sessionID,
                    captureID: captureID,
                    captureGeneration: captureGeneration,
                    state: "sequence_gap",
                    errorCode: "audio_sequence_gap"
                )
                return
            }
            self.realtimeAudioDelivery.expectedSourceSequence = frame.sequence + 1
            self.realtimeAudioDelivery.packetData.append(frame.data)
            self.realtimeAudioDelivery.packetFrameCount += frame.frameCount
            self.realtimeAudioDelivery.packetSourceSequenceStart =
                self.realtimeAudioDelivery.packetSourceSequenceStart ?? frame.sequence
            self.realtimeAudioDelivery.packetSourceSequenceEnd = frame.sequence
            self.realtimeAudioDelivery.packetLevelSquared +=
                frame.level * frame.level * Double(frame.frameCount)
            self.realtimeAudioDelivery.packetTurnID =
                self.realtimeAudioDelivery.packetTurnID ?? self.realtimeAudioDelivery.activeTurnID

            self.flushRealtimeAudioPacket(force: false)
        }
    }

    /// Must be called only on `realtimeAudioDeliveryQueue`.
    private func flushRealtimeAudioPacket(force: Bool) {
        guard realtimeAudioDelivery.packetFrameCount > 0,
              force || realtimeAudioDelivery.packetFrameCount >= Self.realtimeAudioTargetPacketFrames,
              let sourceSequenceStart = realtimeAudioDelivery.packetSourceSequenceStart,
              let sourceSequenceEnd = realtimeAudioDelivery.packetSourceSequenceEnd
        else { return }

        guard realtimeAudioDelivery.pendingPacketDeliveries < Self.realtimeAudioMaximumPendingPackets else {
            let sessionID = realtimeAudioDelivery.sessionID ?? ""
            let captureGeneration = realtimeAudioDelivery.captureGeneration ?? 0
            failRealtimeAudioDelivery(
                sessionID: sessionID,
                captureID: nil,
                captureGeneration: captureGeneration,
                state: "delivery_backpressure",
                errorCode: "audio_delivery_backpressure"
            )
            return
        }

        realtimeAudioDelivery.nextPacketSequence += 1
        let packet = RealtimeAudioPacket(
            sequence: realtimeAudioDelivery.nextPacketSequence,
            sourceSequenceStart: sourceSequenceStart,
            sourceSequenceEnd: sourceSequenceEnd,
            data: realtimeAudioDelivery.packetData,
            frameCount: realtimeAudioDelivery.packetFrameCount,
            level: sqrt(
                max(0, realtimeAudioDelivery.packetLevelSquared) /
                    Double(realtimeAudioDelivery.packetFrameCount)
            ),
            turnID: realtimeAudioDelivery.packetTurnID
        )
        if packet.turnID != nil {
            realtimeAudioDelivery.turnFinalSequence = packet.sequence
        }
        realtimeAudioDelivery.pendingPacketDeliveries += 1
        let sessionID = realtimeAudioDelivery.sessionID ?? ""
        let captureGeneration = realtimeAudioDelivery.captureGeneration ?? 0
        resetRealtimeAudioPacket()

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let isCurrentCapture = self.isCurrentRealtimeAudioCapture(
                sessionID: sessionID,
                captureID: nil
            )
            if isCurrentCapture {
                if let timeToFirstFrameMs = self.takeRealtimeAudioFirstFrameLatency(
                    generation: captureGeneration
                ) {
                    self.emitRealtimeAudioState(
                        sessionID: sessionID,
                        state: "first_frame",
                        timeToFirstFrameMs: timeToFirstFrameMs
                    )
                }
                self.notifyListeners(
                    "oneVoiceAudioFrame",
                    data: [
                        "sessionId": sessionID,
                        "sequence": packet.sequence,
                        "sourceSequenceStart": packet.sourceSequenceStart,
                        "sourceSequenceEnd": packet.sourceSequenceEnd,
                        "sampleRate": 16_000,
                        "channels": 1,
                        "encoding": "pcm_s16le",
                        "frameCount": packet.frameCount,
                        "level": max(0, min(1, packet.level)),
                        // This is the only payload containing raw sound. It is
                        // delivered directly to JavaScript for immediate relay
                        // streaming and is never printed, retained, or persisted.
                        "data": packet.data.base64EncodedString(),
                    ]
                )
            }
            self.realtimeAudioDeliveryQueue.async { [weak self] in
                self?.completeRealtimeAudioPacketDelivery(
                    sessionID: sessionID,
                    captureGeneration: captureGeneration
                )
            }
        }
    }

    /// Must be called only on `realtimeAudioDeliveryQueue`.
    private func completeRealtimeAudioPacketDelivery(
        sessionID: String,
        captureGeneration: Int
    ) {
        guard realtimeAudioDelivery.sessionID == sessionID,
              realtimeAudioDelivery.captureGeneration == captureGeneration,
              !realtimeAudioDelivery.failed
        else { return }
        realtimeAudioDelivery.pendingPacketDeliveries = max(
            0,
            realtimeAudioDelivery.pendingPacketDeliveries - 1
        )
        finishRealtimeAudioTurnIfDrained()
    }

    /// Must be called only on `realtimeAudioDeliveryQueue`.
    private func finishRealtimeAudioTurnIfDrained() {
        guard let turnID = realtimeAudioDelivery.endingTurnID,
              realtimeAudioDelivery.packetFrameCount == 0,
              realtimeAudioDelivery.pendingPacketDeliveries == 0
        else { return }
        let result = RealtimeAudioTurnEndResult(
            turnID: turnID,
            finalSequence: realtimeAudioDelivery.turnFinalSequence,
            cancelled: realtimeAudioDelivery.endingCancelled
        )
        let completions = realtimeAudioDelivery.endCompletions
        realtimeAudioDelivery.endingTurnID = nil
        realtimeAudioDelivery.endingCancelled = false
        realtimeAudioDelivery.expectedSourceSequence = nil
        realtimeAudioDelivery.turnFinalSequence = 0
        realtimeAudioDelivery.endCompletions = []
        let sessionID = realtimeAudioDelivery.sessionID ?? ""

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard self.realtimeAudioSessionID == sessionID else {
                completions.forEach { $0(nil, "realtime_audio_not_active") }
                return
            }
            self.emitRealtimeAudioState(
                sessionID: sessionID,
                state: "tail_drained",
                turnID: result.turnID,
                finalSequence: result.finalSequence,
                cancelled: result.cancelled
            )
            completions.forEach { $0(result, nil) }
        }
    }

    /// Must be called only on `realtimeAudioDeliveryQueue`.
    private func resetRealtimeAudioPacket() {
        realtimeAudioDelivery.packetData.removeAll(keepingCapacity: false)
        realtimeAudioDelivery.packetFrameCount = 0
        realtimeAudioDelivery.packetSourceSequenceStart = nil
        realtimeAudioDelivery.packetSourceSequenceEnd = nil
        realtimeAudioDelivery.packetLevelSquared = 0
        realtimeAudioDelivery.packetTurnID = nil
    }

    /// Must be called only on `realtimeAudioDeliveryQueue`.
    private func failRealtimeAudioDelivery(
        sessionID: String,
        captureID: ObjectIdentifier?,
        captureGeneration: Int,
        state: String,
        errorCode: String
    ) {
        guard !realtimeAudioDelivery.failed else { return }
        realtimeAudioDelivery.failed = true
        let completions = realtimeAudioDelivery.endCompletions
        realtimeAudioDelivery.endCompletions = []
        resetRealtimeAudioPacket()

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let isCurrentCapture = self.isCurrentRealtimeAudioCapture(
                sessionID: sessionID,
                captureID: captureID
            )
            if isCurrentCapture {
                self.emitRealtimeAudioState(
                    sessionID: sessionID,
                    state: state,
                    errorCode: errorCode
                )
                self.stopRealtimeAudioCaptureInternal(
                    state: "error",
                    errorCode: errorCode
                )
            }
            completions.forEach { $0(nil, errorCode) }
        }
    }

    private func handleRealtimeAudioCaptureError(
        _ error: OneVoiceMicrophoneCapture.CaptureError,
        sessionID: String,
        captureID: ObjectIdentifier
    ) {
        DispatchQueue.main.async { [weak self] in
            guard let self,
                  self.isCurrentRealtimeAudioCapture(
                      sessionID: sessionID,
                      captureID: captureID
                  )
            else { return }
            self.stopRealtimeAudioCaptureInternal(
                state: "error",
                errorCode: error.safeCode
            )
        }
    }

    private func stopRealtimeAudioCaptureInternal(
        state: String,
        errorCode: String? = nil
    ) {
        guard let sessionID = realtimeAudioSessionID else { return }
        realtimeMicrophoneCapture?.stop()
        realtimeMicrophoneCapture = nil
        realtimeAudioSessionID = nil
        invalidateRealtimeAudioMeasurements()
        cancelRealtimeAudioDelivery(errorCode: errorCode ?? "realtime_audio_stopped")
        emitRealtimeAudioState(
            sessionID: sessionID,
            state: state,
            errorCode: errorCode
        )
    }

    private func cancelRealtimeAudioDelivery(errorCode: String) {
        realtimeAudioDeliveryQueue.sync {
            let completions = realtimeAudioDelivery.endCompletions
            realtimeAudioDelivery = RealtimeAudioDeliveryState()
            guard !completions.isEmpty else { return }
            DispatchQueue.main.async {
                completions.forEach { $0(nil, errorCode) }
            }
        }
    }

    private func handleRealtimeAudioInterruption(_ notification: Notification) {
        guard realtimeMicrophoneCapture != nil,
              let rawType = (notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? NSNumber)?.uintValue,
              AVAudioSession.InterruptionType(rawValue: rawType) == .began
        else { return }
        stopRealtimeAudioCaptureInternal(
            state: "error",
            errorCode: "audio_session_interrupted"
        )
    }

    private func handleRealtimeAudioRouteChange(_ notification: Notification) {
        guard realtimeMicrophoneCapture != nil else { return }
        // AVAudioSession emits `.categoryChange` when this capture moves the
        // session into `.playAndRecord`. It is our own expected duplex setup,
        // not a lost microphone route. Stopping here raced startup and made
        // every tap fail before a PCM frame could be delivered. Hardware route
        // changes remain fail-closed below so the caller can retry on a stable
        // route.
        if let rawReason = (notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? NSNumber)?.uintValue,
           AVAudioSession.RouteChangeReason(rawValue: rawReason) == .categoryChange
        {
            return
        }
        stopRealtimeAudioCaptureInternal(
            state: "error",
            errorCode: "audio_route_changed"
        )
    }

    private func handleRealtimeAudioConfigurationChange(_ notification: Notification) {
        guard realtimeMicrophoneCapture != nil else { return }
        stopRealtimeAudioCaptureInternal(
            state: "error",
            errorCode: "audio_engine_reconfigured"
        )
    }

    private func handleRealtimeAudioMediaServicesReset(_ notification: Notification) {
        guard realtimeMicrophoneCapture != nil else { return }
        stopRealtimeAudioCaptureInternal(
            state: "error",
            errorCode: "audio_media_services_reset"
        )
    }

    private func handleRealtimeAudioMediaServicesLost(_ notification: Notification) {
        guard realtimeMicrophoneCapture != nil else { return }
        stopRealtimeAudioCaptureInternal(
            state: "error",
            errorCode: "audio_media_services_lost"
        )
    }

    private func handleRealtimeAudioBackground(_ notification: Notification) {
        guard realtimeMicrophoneCapture != nil else { return }
        stopRealtimeAudioCaptureInternal(
            state: "error",
            errorCode: "app_backgrounded"
        )
    }

    private func isCurrentRealtimeAudioCapture(
        sessionID: String,
        captureID: ObjectIdentifier?
    ) -> Bool {
        guard realtimeAudioSessionID == sessionID,
              let microphoneCapture = realtimeMicrophoneCapture
        else { return false }
        guard let captureID else { return true }
        return ObjectIdentifier(microphoneCapture) == captureID
    }

    private func beginRealtimeAudioMeasurements() -> Int {
        realtimeAudioLock.lock()
        realtimeAudioMeasurementGeneration &+= 1
        realtimeAudioStartUptime = ProcessInfo.processInfo.systemUptime
        realtimeAudioReportedFirstFrame = false
        let generation = realtimeAudioMeasurementGeneration
        realtimeAudioLock.unlock()
        return generation
    }

    private func invalidateRealtimeAudioMeasurements() {
        realtimeAudioLock.lock()
        realtimeAudioMeasurementGeneration &+= 1
        realtimeAudioStartUptime = nil
        realtimeAudioReportedFirstFrame = false
        realtimeAudioLock.unlock()
    }

    private func takeRealtimeAudioFirstFrameLatency(generation: Int) -> Int? {
        realtimeAudioLock.lock()
        defer { realtimeAudioLock.unlock() }
        guard generation == realtimeAudioMeasurementGeneration,
              !realtimeAudioReportedFirstFrame,
              let startedAt = realtimeAudioStartUptime
        else { return nil }
        realtimeAudioReportedFirstFrame = true
        return max(0, Int((ProcessInfo.processInfo.systemUptime - startedAt) * 1_000))
    }

    private func emitRealtimeAudioState(
        sessionID: String,
        state: String,
        errorCode: String? = nil,
        timeToFirstFrameMs: Int? = nil,
        droppedFrames: Int? = nil,
        level: Double? = nil,
        turnID: String? = nil,
        finalSequence: Int? = nil,
        cancelled: Bool? = nil
    ) {
        var payload: [String: Any] = [
            "sessionId": sessionID,
            "state": state,
        ]
        if let errorCode { payload["errorCode"] = errorCode }
        if let timeToFirstFrameMs { payload["timeToFirstFrameMs"] = timeToFirstFrameMs }
        if let droppedFrames { payload["droppedFrames"] = droppedFrames }
        if let level { payload["level"] = max(0, min(1, level)) }
        if let turnID { payload["turnId"] = turnID }
        if let finalSequence { payload["finalSequence"] = finalSequence }
        if let cancelled { payload["cancelled"] = cancelled }
        // Device-console evidence must stay diagnostic but non-sensitive: no
        // session id, PCM, transcript, route, identity, or framework error
        // detail is written. These bounded categories are enough to separate
        // capture failure from relay/provider failure in a physical-device run.
        if ["started", "first_frame", "stopped", "error", "delivery_backpressure", "sequence_gap"].contains(state) {
            var details = "[ONE_VOICE_PCM] state=\(state)"
            if let errorCode { details += " code=\(errorCode)" }
            if let timeToFirstFrameMs { details += " first_frame_ms=\(timeToFirstFrameMs)" }
            if let droppedFrames { details += " dropped_frames=\(droppedFrames)" }
            print(details)
        }
        notifyListeners("oneVoiceAudioState", data: payload)
    }

    @objc func startSpeechRecognition(_ call: CAPPluginCall) {
        if realtimeMicrophoneCapture != nil {
            // Offline recognition is an explicit fallback. It cannot take the
            // microphone away from an active online Gemini session.
            call.reject("realtime_audio_active")
            return
        }
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
