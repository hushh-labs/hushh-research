import AVFoundation
import Foundation
import WebRTC

struct CallingAudioGate {
    var activated = false
    var verified = false
    var muted = false
    var enabled: Bool { activated && verified }
    var microphoneEnabled: Bool { enabled && !muted }
}

/// Native relay-only transport. CallKit activation and verified peer identity
/// are independent prerequisites for enabling the microphone or remote audio.
@MainActor
final class CallingMedia: NSObject, RTCPeerConnectionDelegate {
    private let factory: RTCPeerConnectionFactory? = {
        guard RTCInitializeSSL() else { return nil }
        return RTCPeerConnectionFactory()
    }()
    private var connection: RTCPeerConnection?
    private var track: RTCAudioTrack?
    private var gathering: CheckedContinuation<Void, Error>?
    private var audioGate = CallingAudioGate()
    private var ownsAudio = false
    var connected: (() -> Void)?
    var failed: (() -> Void)?

    func reserve() throws {
        guard NativeAudioOwnership.claim(self) else { throw CallingError.microphoneBusy }
        ownsAudio = true
        RTCAudioSession.sharedInstance().useManualAudio = true
        RTCAudioSession.sharedInstance().isAudioEnabled = false
    }

    func open(_ relay: [String: Any]) throws {
        guard let factory, connection == nil, relay["iceTransportPolicy"] as? String == "relay",
              let servers = relay["iceServers"] as? [[String: Any]], !servers.isEmpty else { throw CallingError.invalid }
        try reserve()
        let audio = RTCAudioSession.sharedInstance()
        audio.useManualAudio = true
        audio.isAudioEnabled = false
        let config = RTCConfiguration()
        config.iceTransportPolicy = .relay
        config.sdpSemantics = .unifiedPlan
        config.iceServers = servers.compactMap { server in
            guard let urls = server["urls"] as? [String], !urls.isEmpty,
                  urls.allSatisfy({ $0.hasPrefix("turn:") || $0.hasPrefix("turns:") }),
                  let username = server["username"] as? String, let password = server["credential"] as? String else { return nil }
            return RTCIceServer(urlStrings: urls, username: username, credential: password)
        }
        guard config.iceServers.count == servers.count,
              let peer = factory.peerConnection(with: config, constraints: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil), delegate: self)
        else { NativeAudioOwnership.release(self); ownsAudio = false; throw CallingError.invalid }
        connection = peer
        Task { @MainActor [weak self, weak peer] in
            try? await Task.sleep(nanoseconds: 90_000_000_000)
            guard let self, let peer, peer === self.connection, peer.connectionState != .connected else { return }
            self.failed?()
        }
        let source = factory.audioSource(with: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil))
        let track = factory.audioTrack(with: source, trackId: UUID().uuidString)
        track.isEnabled = false
        self.track = track
        _ = peer.add(track, streamIds: [UUID().uuidString])
    }
    func description(_ kind: String) async throws -> [String: Any] {
        guard let peer = connection else { throw CallingError.cancelled }
        let offer = kind == "offer"
        let constraints = RTCMediaConstraints(mandatoryConstraints: ["OfferToReceiveAudio": "true"], optionalConstraints: nil)
        let description: RTCSessionDescription = try await withCheckedThrowingContinuation { continuation in
            let callback: (RTCSessionDescription?, Error?) -> Void = { description, error in
                if let error { continuation.resume(throwing: error) }
                else if let description { continuation.resume(returning: description) }
                else { continuation.resume(throwing: CallingError.invalid) }
            }
            if offer { peer.offer(for: constraints, completionHandler: callback) }
            else { peer.answer(for: constraints, completionHandler: callback) }
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peer.setLocalDescription(description) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
        guard peer === connection else { throw CallingError.cancelled }
        if peer.iceGatheringState != .complete {
            try await withCheckedThrowingContinuation { continuation in
                gathering = continuation
                Task { @MainActor [weak self, weak peer] in
                    try? await Task.sleep(nanoseconds: 10_000_000_000)
                    guard let self, peer === self.connection, let pending = self.gathering else { return }
                    // An unavailable alternate transport must not discard a
                    // working relay. The description is validated below.
                    self.gathering = nil; pending.resume()
                }
            }
        }
        guard peer === connection, let sdp = peer.localDescription?.sdp,
              sdp.range(of: "(?im)^a=candidate:.* typ relay(?: |\\r?$)", options: .regularExpression) != nil else { throw CallingError.unavailable }
        let result: [String: Any] = ["type": kind, "sdp": sdp]
        _ = try CallingWire.validateDescription(result, kind: kind)
        return result
    }
    func remote(_ description: [String: Any], kind: String) async throws {
        guard let peer = connection else { throw CallingError.cancelled }
        let sdp = try CallingWire.validateDescription(description, kind: kind)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peer.setRemoteDescription(RTCSessionDescription(type: kind == "offer" ? .offer : .answer, sdp: sdp)) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
        guard peer === connection else { throw CallingError.cancelled }
    }
    func audioActivated(_ session: AVAudioSession) {
        RTCAudioSession.sharedInstance().audioSessionDidActivate(session)
        audioGate.activated = true; updateAudio()
    }
    func audioDeactivated(_ session: AVAudioSession) {
        audioGate.activated = false; updateAudio()
        RTCAudioSession.sharedInstance().audioSessionDidDeactivate(session)
    }
    func allowVerifiedAudio() { audioGate.verified = true; updateAudio() }
    func mute(_ value: Bool) { audioGate.muted = value; updateAudio() }
    private func updateAudio() {
        RTCAudioSession.sharedInstance().isAudioEnabled = audioGate.enabled && connection != nil
        track?.isEnabled = audioGate.microphoneEnabled
    }
    func stop() {
        audioGate = CallingAudioGate()
        if ownsAudio { updateAudio() }
        gathering?.resume(throwing: CallingError.cancelled); gathering = nil
        track?.isEnabled = false; track = nil
        connection?.close(); connection = nil
        NativeAudioOwnership.release(self)
        ownsAudio = false
    }
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    nonisolated func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        // ICE alone does not establish the DTLS fingerprint-authenticated session.
    }
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        Task { @MainActor [weak self] in
            guard let self, peerConnection === self.connection else { return }
            if newState == .connected { self.connected?() }
            if newState == .failed || newState == .closed { self.failed?() }
            if newState == .disconnected {
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                if peerConnection === self.connection, peerConnection.connectionState == .disconnected { self.failed?() }
            }
        }
    }
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        Task { @MainActor [weak self] in
            guard let self, peerConnection === self.connection, newState == .complete else { return }
            self.gathering?.resume(); self.gathering = nil
        }
    }
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}
