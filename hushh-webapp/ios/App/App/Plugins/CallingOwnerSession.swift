import FirebaseAuth
import Foundation

/// Serialize cold restore and foreground enrollment under one native owner.
@MainActor
final class CallingOwnerSession {
    private(set) var client: CallingAPI?
    private var pending: CallingAPI?
    private var opening: Task<CallingAPI, Error>?
    private var openingUser: User?
    private var generation = 0
    var ownerId: String? { client?.identity.owner ?? pending?.identity.owner }
    var firebaseUid: String? { client?.firebaseUid ?? pending?.firebaseUid ?? openingUser?.uid }
    func matches(_ user: User?) -> Bool {
        if let client { return client.matchesFirebaseSession(user) }
        if let pending { return pending.matchesFirebaseSession(user) }
        return openingUser === user
    }
    func reset() {
        generation += 1
        opening?.cancel(); opening = nil
        openingUser = nil
        pending?.close(); pending = nil
        client?.close(); client = nil
    }
    func ready(expectedOwner: String? = nil, allowEnrollment: Bool) async throws -> CallingAPI {
        guard let user = HushhFirebaseIdentity.auth.currentUser else { throw CallingError.cancelled }
        func validate(_ candidate: CallingAPI) throws {
            try candidate.check()
            guard expectedOwner == nil || expectedOwner == candidate.identity.owner else { throw CallingError.cancelled }
        }
        if let client { try validate(client); return client }
        if let opening {
            let epoch = generation
            do {
                let result = try await opening.value
                try validate(result)
                return result
            } catch CallingError.enrollmentRequired where allowEnrollment {
                guard epoch == generation, HushhFirebaseIdentity.auth.currentUser === user else { throw CallingError.cancelled }
                // A foreground request may enroll after cold restoration refused.
                // Advance the epoch so the old task cannot clear this new open.
                reset()
                return try await ready(expectedOwner: expectedOwner, allowEnrollment: true)
            }
        }
        let epoch = generation
        openingUser = user
        let task = Task { @MainActor () throws -> CallingAPI in
            let candidate = try await CallingAPI.admitted(user: user, origin: CallingAPI.shippedOrigin())
            do {
                try validate(candidate)
                guard epoch == self.generation, !Task.isCancelled else { throw CallingError.cancelled }
                if !allowEnrollment && candidate.identity.deviceId.isEmpty { throw CallingError.enrollmentRequired }
                self.pending = candidate
                try await candidate.initialize()
                try validate(candidate)
                guard epoch == self.generation, !Task.isCancelled else { throw CallingError.cancelled }
                self.client = candidate
                return candidate
            } catch {
                candidate.close()
                throw error
            }
        }
        opening = task
        do {
            let result = try await task.value
            if epoch == generation { opening = nil; pending = nil; openingUser = nil }
            return result
        } catch {
            if epoch == generation { opening = nil; pending = nil; openingUser = nil }
            throw error
        }
    }
}
