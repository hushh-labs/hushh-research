import AVFoundation
import CallKit
import Foundation
import PushKit

/// OS integration lives for the application lifetime, independently of React.
@MainActor
final class CallingSystem: NSObject, CXProviderDelegate, PKPushRegistryDelegate {
    private let provider: CXProvider
    private let controller = CXCallController()
    private var registry: PKPushRegistry?
    private var reported = Set<UUID>()
    var push: (([AnyHashable: Any]) -> Void)?
    var token: ((String?) -> Void)?
    var answer: ((UUID, CXAnswerCallAction) -> Void)?
    var end: ((UUID) -> Void)?
    var mute: ((Bool) -> Void)?
    var activate: ((AVAudioSession) -> Void)?
    var deactivate: ((AVAudioSession) -> Void)?
    var prepareAudio: ((UUID) throws -> Void)?

    override init() {
        let config = CXProviderConfiguration()
        config.supportsVideo = false
        config.maximumCallsPerCallGroup = 1
        config.maximumCallGroups = 1
        config.supportedHandleTypes = [.generic]
        config.includesCallsInRecents = false
        provider = CXProvider(configuration: config)
        super.init()
        provider.setDelegate(self, queue: .main)
    }
    func registerPushes() {
        guard registry == nil else { return }
        let registry = PKPushRegistry(queue: .main)
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
        self.registry = registry
    }
    func unregisterPushes() { registry?.desiredPushTypes = []; registry = nil }
    func outgoing(_ id: UUID) async throws {
        try await controller.request(CXTransaction(action: CXStartCallAction(call: id, handle: CXHandle(type: .generic, value: "Encrypted voice call"))))
        reported.insert(id)
        provider.reportOutgoingCall(with: id, startedConnectingAt: Date())
    }
    func requestAnswer(_ id: UUID) async throws {
        try await controller.request(CXTransaction(action: CXAnswerCallAction(call: id)))
    }
    func prepareAnswer(_ id: UUID) throws {
        try prepareAudio?(id)
        try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth])
    }
    func incoming(_ id: UUID, completion: @escaping () -> Void) {
        guard !reported.contains(id) else { completion(); return }
        reported.insert(id)
        let update = CXCallUpdate()
        update.localizedCallerName = "Encrypted voice call"
        update.hasVideo = false
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        provider.reportNewIncomingCall(with: id, update: update) { error in
            Task { @MainActor in
                if error != nil { self.reported.remove(id); self.end?(id) }
                completion()
            }
        }
    }
    func connected(_ id: UUID) { provider.reportOutgoingCall(with: id, connectedAt: Date()) }
    func finish(_ id: UUID, reason: CXCallEndedReason = .remoteEnded) {
        guard reported.remove(id) != nil else { return }
        provider.reportCall(with: id, endedAt: Date(), reason: reason)
    }
    func providerDidReset(_ provider: CXProvider) {
        for id in reported { end?(id) }
        reported.removeAll()
    }
    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        let session = AVAudioSession.sharedInstance()
        do {
            try prepareAudio?(action.callUUID)
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth])
            action.fulfill()
        } catch { action.fail(); end?(action.callUUID) }
    }
    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        answer?(action.callUUID, action)
    }
    func provider(_ provider: CXProvider, perform action: CXEndCallAction) { end?(action.callUUID); action.fulfill() }
    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) { mute?(action.isMuted); action.fulfill() }
    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) { activate?(audioSession) }
    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) { deactivate?(audioSession) }
    func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        guard type == .voIP else { return }
        token?(pushCredentials.token.map { String(format: "%02x", $0) }.joined())
    }
    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) { if type == .voIP { token?(nil) } }
    func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType,
                      completion: @escaping () -> Void) {
        guard type == .voIP else { completion(); return }
        let body = payload.dictionaryPayload
        // Report immediately; never wait for JS, decryption or network admission.
        let validId = (body["callId"] as? String).flatMap(UUID.init(uuidString:))
        let id = validId ?? UUID()
        incoming(id, completion: completion)
        if validId != nil { push?(body) } else { finish(id, reason: .failed) }
    }
}
