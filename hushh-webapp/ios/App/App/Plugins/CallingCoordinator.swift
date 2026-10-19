import AVFoundation
import CallKit
import FirebaseAuth
import Foundation
import UIKit

/// The sole iOS call owner. React is an optional observer, never the transport.
@MainActor
final class CallingCoordinator {
    static let shared = CallingCoordinator()
    let system = CallingSystem()
    let media = CallingMedia()
    let ownerSession = CallingOwnerSession()
    var api: CallingAPI? { ownerSession.client }
    private var incomingAdmission: Task<Void, Never>?
    var call: [String: Any]?
    var devices: [[String: Any]] = []
    var generation = 0
    var answerApplied = false
    var after = 0
    var muted = false
    var mediaConnected = false
    var verification: String?
    var verificationContinuation: CheckedContinuation<Void, Error>?
    var observer: (([String: Any]) -> Void)?
    var task: Task<Void, Never>?
    private var authListener: AuthStateDidChangeListenerHandle?
    private var pushToken: String?
    private var starting = false
    var answering = false
    var connectedReported = false
    var shuttingDown = false
    private var ignoredIncoming: [UUID] = []
    static let terminal: Set<String> = ["declined", "cancelled", "ended", "expired"]

    func launch() {
        guard authListener == nil else { return }
        system.activate = { [weak self] in self?.media.audioActivated($0) }
        system.deactivate = { [weak self] in self?.media.audioDeactivated($0) }
        system.mute = { [weak self] id, value in
            guard let self, self.call?["id"] as? String == id.uuidString.lowercased(), !self.shuttingDown else { return }
            self.setMuted(value)
        }
        system.end = { [weak self] id in
            guard let self else { return }
            guard self.call?["id"] as? String == id.uuidString.lowercased() else {
                self.ignoredIncoming = Array((self.ignoredIncoming + [id]).suffix(20))
                self.system.finish(id)
                return
            }
            self.end(userInitiated: true, decline: true)
        }
        system.answer = { [weak self] id, action in
            guard let self else { action.fail(); return }
            Task { @MainActor in
                await self.incomingAdmission?.value
                guard self.call?["id"] as? String == id.uuidString.lowercased() else { action.fail(); return }
                do {
                    try self.system.prepareAnswer(id)
                    try await self.answer(); action.fulfill()
                } catch {
                    action.fail()
                    if self.call?["id"] as? String == id.uuidString.lowercased() {
                        self.end(error: "Open Messages to verify the device before calling.")
                    }
                }
            }
        }
        system.push = { [weak self] body in
            self?.incomingAdmission = Task { @MainActor [weak self] in await self?.receive(body) }
        }
        system.prepareAudio = { [weak self] id in
            guard let self, self.call?["id"] as? String == id.uuidString.lowercased() else { throw CallingError.cancelled }
            try self.media.reserve()
        }
        system.token = { [weak self] token in
            self?.pushToken = token
            Task { @MainActor in try? await self?.registerPushToken() }
        }
        media.connected = { [weak self] in
            guard let self else { return }
            let epoch = self.generation
            let id = self.call?["id"] as? String
            Task { @MainActor in
                guard epoch == self.generation, self.call?["id"] as? String == id else { return }
                await self.connected()
            }
        }
        media.failed = { [weak self] in self?.end(error: "The private relay connection ended.") }
        authListener = Auth.auth().addStateDidChangeListener { [weak self] _, user in
            Task { @MainActor in
                guard let self else { return }
                guard Auth.auth().currentUser === user else { return }
                let changed = self.ownerSession.ownerId != user?.uid || (self.api != nil && (try? self.api?.check()) == nil)
                if changed { self.end(); self.ownerSession.reset(); self.system.unregisterPushes() }
                // Cold launch restores ONLY a previously enrolled calling installation.
                if let user, self.api == nil {
                    do {
                        let api = try await self.ownerSession.ready(owner: user.uid, allowEnrollment: false)
                        guard self.api === api else { return }
                        try await self.registerPushToken()
                        try self.current(self.generation, api)
                        self.system.registerPushes()
                        self.monitor()
                    } catch { /* Unenrolled/locked owners stay unavailable. */ }
                }
            }
        }
        if Auth.auth().currentUser != nil { system.registerPushes() }
    }
    func enable(owner: String) async throws {
        launch()
        guard !shuttingDown else { throw CallingError.cancelled }
        guard let user = Auth.auth().currentUser, user.uid == owner else { throw CallingError.cancelled }
        let api = try await ownerSession.ready(owner: user.uid, allowEnrollment: true)
        guard self.api === api else { throw CallingError.cancelled }
        try await registerPushToken()
        try current(generation, api)
        system.registerPushes()
        monitor()
    }
    func current(_ epoch: Int, _ client: CallingAPI) throws {
        try client.check()
        guard !shuttingDown, epoch == generation, api === client else { throw CallingError.cancelled }
    }
    func publish(error: String? = nil) {
        observer?(["call": call as Any? ?? NSNull(), "error": error as Any? ?? NSNull(), "muted": muted,
                   "mediaConnected": mediaConnected, "verification": verification as Any? ?? NSNull()])
    }
    func registerPushToken() async throws {
        guard !shuttingDown else { throw CallingError.cancelled }
        guard let api else { return }
        #if DEBUG
        let environment = "sandbox"
        #else
        let environment = "production"
        #endif
        _ = try await api.command("register-voip", ["token": pushToken as Any? ?? NSNull(), "environment": environment])
    }
    func receive(_ payload: [AnyHashable: Any]) async {
        guard let id = payload["callId"] as? String, let uuid = UUID(uuidString: id) else { return }
        if call?["id"] as? String == id { return } // Already admitted by push or foreground inbox.
        let epoch = generation
        do {
            guard !shuttingDown else { throw CallingError.cancelled }
            if api == nil, let user = Auth.auth().currentUser {
                let restored = try await ownerSession.ready(owner: user.uid, allowEnrollment: false)
                try current(epoch, restored)
            }
            guard let api, payload["deviceId"] as? String == api.identity.deviceId,
                  payload["keyId"] as? String == api.identity.keyId,
                  let expiry = payload["expiresAt"] as? Int, expiry > Int(Date().timeIntervalSince1970),
                  call == nil || call?["id"] as? String == id else { throw CallingError.invalid }
            let remote = try await api.command("read", ["callId": id, "after": 0])
            if ignoredIncoming.contains(uuid) {
                if remote["isCaller"] as? Bool == false, remote["state"] as? String == "ringing" {
                    _ = try? await api.command("action", ["callId": id, "action": "decline", "revision": remote["revision"] ?? 0])
                }
                throw CallingError.cancelled
            }
            try current(epoch, api)
            guard remote["state"] as? String == "ringing", remote["isCaller"] as? Bool == false,
                  remote["calleeDeviceId"] is NSNull, (remote["expiresAt"] as? Int ?? 0) == expiry else { throw CallingError.invalid }
            call = remote; publish(); monitor()
        } catch {
            if epoch == generation || call?["id"] as? String != id { system.finish(uuid, reason: .failed) }
        }
    }
    func start(conversation: String?, person: String?) async throws {
        guard !shuttingDown, !starting, call == nil, let api else { throw CallingError.unavailable }
        starting = true; generation += 1
        let epoch = generation
        defer { starting = false }
        do {
            guard await microphonePermission() else { throw CallingError.unavailable }
            try current(epoch, api)
            let id = UUID().uuidString.lowercased()
            var payload: [String: Any] = ["callId": id]
            if let conversation { payload["conversationId"] = conversation } else if let person { payload["recipientPersonRef"] = person }
            let created = try await api.command("create", payload)
            do { try current(epoch, api) } catch {
                _ = try? await api.command("action", ["callId": id, "action": "end", "revision": created["revision"] ?? 0]); throw error
            }
            call = created; publish()
            devices = try await api.directory(CallingWire.string(created, "conversationId"))
            try current(epoch, api)
            let relay = try await api.command("credentials", ["callId": id])
            try current(epoch, api); try media.open(relay)
            try await system.outgoing(UUID(uuidString: id)!)
            try current(epoch, api)
            let description = try await media.description("offer")
            try current(epoch, api)
            let offers = try devices.filter { $0["userId"] as? String != api.identity.owner }.map { peer in
                try CallingWire.seal(device: peer, context: CallingWire.context(call: created, from: api.identity.deviceId,
                            to: CallingWire.string(peer, "deviceId"), kind: "offer", sequence: 0), description: description)
            }
            call = try await api.command("offer", ["callId": id, "offers": offers])
            try current(epoch, api); publish(); monitor()
        } catch { if epoch == generation { end(error: "The call could not connect.") }; throw error }
    }
    func setMuted(_ value: Bool) { muted = value; media.mute(value); publish() }
    func confirm(fingerprint: String, accepted: Bool) throws {
        guard fingerprint == verification, let api, UIApplication.shared.applicationState == .active else { throw CallingError.invalid }
        try api.check()
        if accepted { try api.identity.verify(fingerprint) }
        let pending = verificationContinuation
        verificationContinuation = nil; verification = nil; publish()
        if accepted { pending?.resume() } else { pending?.resume(throwing: CallingError.verificationRequired) }
    }
    func end(error: String? = nil, userInitiated: Bool = false, decline: Bool = false) {
        let previous = call
        let client = api
        generation += 1
        task?.cancel(); task = nil
        verificationContinuation?.resume(throwing: CallingError.cancelled)
        verificationContinuation = nil; verification = nil
        media.stop(); call = nil; devices = []; after = 0; answerApplied = false
        muted = false; mediaConnected = false; connectedReported = false
        if let id = previous?["id"] as? String, let uuid = UUID(uuidString: id) { system.finish(uuid) }
        publish(error: error)
        if let previous, let id = previous["id"] as? String, !Self.terminal.contains(previous["state"] as? String ?? "") {
            let caller = previous["isCaller"] as? Bool == true
            let state = previous["state"] as? String ?? ""
            let intent = userInitiated && caller && ["preparing", "ringing"].contains(state) ? "cancel"
                : userInitiated && decline && !caller && state == "ringing" ? "decline" : "end"
            Task { @MainActor in
                let payload: [String: Any] = ["callId": id, "action": intent, "revision": previous["revision"] ?? 0]
                do { _ = try await client?.command("action", payload) }
                catch { _ = try? await client?.command("action", ["callId": id, "action": "end", "revision": previous["revision"] ?? 0]) }
            }
        }
        if api != nil { monitor() }
    }
    func microphonePermission() async -> Bool {
        let session = AVAudioSession.sharedInstance()
        if session.recordPermission == .granted { return true }
        guard UIApplication.shared.applicationState == .active else { return false }
        return await withCheckedContinuation { continuation in session.requestRecordPermission { continuation.resume(returning: $0) } }
    }
    func verifyPair(peer: [String: Any], epoch: Int, client: CallingAPI) async throws {
        guard let local = devices.first(where: { $0["deviceId"] as? String == client.identity.deviceId }),
              peer["userId"] as? String != client.identity.owner else { throw CallingError.invalid }
        let fingerprint = try CallingWire.pairFingerprint(local, peer)
        try current(epoch, client)
        if client.identity.isVerified(fingerprint) { return }
        guard UIApplication.shared.applicationState == .active else { throw CallingError.verificationRequired }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            verification = fingerprint; verificationContinuation = continuation; publish()
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 25_000_000_000)
                guard let self, epoch == self.generation, self.verification == fingerprint else { return }
                self.end(error: "The security code was not verified in time.")
            }
        }
        try current(epoch, client)
    }
}
