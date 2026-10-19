import AVFoundation
import Foundation

extension CallingCoordinator {
    func answer() async throws {
        guard !answering, let incoming = call, incoming["isCaller"] as? Bool == false,
              incoming["state"] as? String == "ringing", let api else { throw CallingError.invalid }
        answering = true; generation += 1
        let epoch = generation
        defer { answering = false }
        do {
            let id = try CallingWire.string(incoming, "id")
            devices = try await api.directory(CallingWire.string(incoming, "conversationId"))
            try current(epoch, api)
            let remote = try await api.command("read", ["callId": id, "after": 0])
            try current(epoch, api)
            let callerId = try CallingWire.string(remote, "callerDeviceId")
            guard let caller = devices.first(where: { $0["deviceId"] as? String == callerId }),
                  caller["userId"] as? String != api.identity.owner,
                  let signed = remote["offerProof"] as? [String: Any], let payload = signed["payload"] as? [String: Any],
                  let offers = remote["offers"] as? [[String: Any]], let offer = offers.first,
                  let signedOffers = payload["offers"] as? [[String: Any]], payload["callId"] as? String == id,
                  try signedOffers.contains(where: { try CallingWire.bytes($0) == CallingWire.bytes(offer) }) else { throw CallingError.invalid }
            try CallingWire.verify(caller, operation: "offer", signed: signed)
            let description = try api.identity.open(envelope: offer, context: CallingWire.context(call: remote,
                    from: callerId, to: api.identity.deviceId, kind: "offer", sequence: 0))
            _ = try CallingWire.validateDescription(description, kind: "offer")
            // Winning CAS identifies the endpoint pair to the caller. Audio is
            // still disabled until both people can compare that same pair.
            let accepted = try await api.command("action", ["callId": id, "action": "accept", "revision": remote["revision"] ?? 0])
            try current(epoch, api); call = accepted
            try await verifyPair(peer: caller, epoch: epoch, client: api)
            guard await microphonePermission() else { throw CallingError.unavailable }
            try current(epoch, api)
            let relay = try await api.command("credentials", ["callId": id])
            try current(epoch, api); try media.open(relay)
            media.allowVerifiedAudio()
            try await media.remote(description, kind: "offer")
            try current(epoch, api)
            let answer = try await media.description("answer")
            try current(epoch, api)
            let envelope = try CallingWire.seal(device: caller, context: CallingWire.context(call: accepted,
                    from: api.identity.deviceId, to: callerId, kind: "answer", sequence: 1), description: answer)
            _ = try await api.command("signal", ["callId": id, "sequence": 1, "envelope": envelope])
            try current(epoch, api); publish(); monitor()
        } catch { if epoch == generation { end(error: "The incoming call could not be verified.") }; throw error }
    }
    func monitor() {
        task?.cancel()
        guard !shuttingDown else { task = nil; return }
        task = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                guard !Task.isCancelled, let self, let api = self.api else { return }
                await self.poll(client: api)
            }
        }
    }
    private func poll(client: CallingAPI) async {
        let epoch = generation
        do {
            try current(epoch, client)
            guard verification == nil else { return }
            if let existing = call {
                let remote = try await client.command("read", ["callId": try CallingWire.string(existing, "id"), "after": after])
                try current(epoch, client)
                if Self.terminal.contains(remote["state"] as? String ?? "") ||
                    (remote["expiresAt"] as? Int ?? 0) <= Int(Date().timeIntervalSince1970) { end(); return }
                if (remote["revision"] as? Int ?? 0) >= (call?["revision"] as? Int ?? 0) { call = remote }
                if remote["isCaller"] as? Bool == true, !answerApplied, remote["calleeDeviceId"] as? String != nil {
                    try await applyAnswer(remote, epoch: epoch, client: client)
                }
                try current(epoch, client); publish()
            } else {
                let result = try await client.command("inbox")
                try current(epoch, client)
                guard let incoming = (result["items"] as? [[String: Any]])?.first,
                      incoming["isCaller"] as? Bool == false, incoming["state"] as? String == "ringing",
                      let id = incoming["id"] as? String, let uuid = UUID(uuidString: id) else { return }
                call = incoming; system.incoming(uuid, completion: {}); publish()
            }
        } catch { if epoch == generation, call != nil { end(error: "Call authorization or relay connectivity was lost.") } }
    }
    private func applyAnswer(_ remote: [String: Any], epoch: Int, client: CallingAPI) async throws {
        let id = try CallingWire.string(remote, "id")
        let peerId = try CallingWire.string(remote, "calleeDeviceId")
        // Re-read canonical active roster before applying the winning answer.
        devices = try await client.directory(CallingWire.string(remote, "conversationId"))
        try current(epoch, client)
        guard let peer = devices.first(where: { $0["deviceId"] as? String == peerId }),
              peer["userId"] as? String != client.identity.owner else { throw CallingError.invalid }
        try await verifyPair(peer: peer, epoch: epoch, client: client)
        guard let signal = (remote["signals"] as? [[String: Any]])?.first else { return }
        guard signal["senderDeviceId"] as? String == peerId, let signed = signal["proof"] as? [String: Any],
              let payload = signed["payload"] as? [String: Any], payload["callId"] as? String == id,
              payload["sequence"] as? Int == 1, let envelope = signal["envelope"] as? [String: Any],
              try CallingWire.bytes(payload["envelope"] ?? NSNull()) == CallingWire.bytes(envelope) else { throw CallingError.invalid }
        try CallingWire.verify(peer, operation: "signal", signed: signed)
        let description = try client.identity.open(envelope: envelope, context: CallingWire.context(call: remote,
                    from: peerId, to: client.identity.deviceId, kind: "answer", sequence: 1))
        try current(epoch, client)
        media.allowVerifiedAudio()
        try await media.remote(description, kind: "answer")
        try current(epoch, client)
        answerApplied = true; after = signal["sequence"] as? Int ?? 0
    }
    func connected() async {
        guard !connectedReported, let call, let api else { return }
        connectedReported = true
        let epoch = generation
        do {
            let id = try CallingWire.string(call, "id")
            for attempt in 0..<2 {
                let latest = try await api.command("read", ["callId": id, "after": after])
                try current(epoch, api)
                do {
                    let connected = try await api.command("action", ["callId": id, "action": "connected", "revision": latest["revision"] ?? 0])
                    try current(epoch, api)
                    if (connected["revision"] as? Int ?? 0) >= (self.call?["revision"] as? Int ?? 0) { self.call = connected }
                    mediaConnected = true
                    if connected["isCaller"] as? Bool == true, let uuid = UUID(uuidString: id) { system.connected(uuid) }
                    publish(); return
                } catch { if attempt == 1 { throw error }; try current(epoch, api) }
            }
        } catch { if epoch == generation { end(error: "The call could not be confirmed.") } }
    }
}
