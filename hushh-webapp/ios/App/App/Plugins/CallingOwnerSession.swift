import FirebaseAuth
import Foundation

/// Serialize cold restore and foreground enrollment under one native owner.
@MainActor
final class CallingOwnerSession {
    private(set) var client: CallingAPI?
    private var pending: CallingAPI?
    private var opening: Task<CallingAPI, Error>?
    private var generation = 0
    var ownerId: String? { client?.identity.owner ?? pending?.identity.owner }
    func reset() {
        generation += 1
        opening?.cancel(); opening = nil
        pending?.close(); pending = nil
        client?.close(); client = nil
    }
    func ready(owner: String, allowEnrollment: Bool) async throws -> CallingAPI {
        guard let user = Auth.auth().currentUser, user.uid == owner else { throw CallingError.cancelled }
        if let client { try client.check(); return client }
        if let opening { return try await opening.value }
        let epoch = generation
        let candidate = try CallingAPI(user: user, origin: CallingAPI.shippedOrigin())
        if !allowEnrollment && candidate.identity.deviceId.isEmpty { candidate.close(); throw CallingError.unavailable }
        pending = candidate
        let task = Task { @MainActor () throws -> CallingAPI in
            try await candidate.initialize()
            try candidate.check()
            guard epoch == self.generation, !Task.isCancelled else { throw CallingError.cancelled }
            self.client = candidate
            return candidate
        }
        opening = task
        do {
            let result = try await task.value
            if epoch == generation { opening = nil; pending = nil }
            return result
        } catch {
            candidate.close()
            if epoch == generation { opening = nil; pending = nil }
            throw error
        }
    }
}
