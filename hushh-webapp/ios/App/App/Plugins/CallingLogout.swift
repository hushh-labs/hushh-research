import Foundation

extension CallingCoordinator {
    /// Stop local audio immediately, then bound authenticated registration
    /// cleanup BEFORE native Firebase sign-out removes request authority.
    func prepareSignOut(owner: String?) async {
        guard ownerSession.ownerId == nil || ownerSession.ownerId == owner else { return }
        shuttingDown = true
        defer { shuttingDown = false }
        end()
        system.unregisterPushes()
        guard let client = api else { ownerSession.reset(); return }
        #if DEBUG
        let environment = "sandbox"
        #else
        let environment = "production"
        #endif
        let cleanup = Task { @MainActor in
            _ = try? await client.command("register-voip", ["token": NSNull(), "environment": environment], timeout: 2)
        }
        // Firebase token refresh itself may wait for network. Do not let that
        // delay logout, and close the old client before any late request starts.
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            var pending: CheckedContinuation<Void, Never>? = continuation
            Task { @MainActor in
                await cleanup.value
                pending?.resume(); pending = nil
            }
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                cleanup.cancel(); client.close()
                pending?.resume(); pending = nil
            }
        }
        if api === client { end(); ownerSession.reset() }
    }
}
