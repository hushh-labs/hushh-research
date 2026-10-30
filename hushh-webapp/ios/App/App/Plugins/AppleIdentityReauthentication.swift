// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Hushh
import AuthenticationServices
import Capacitor
import CryptoKit
import FirebaseAuth
import Security

/// SDK completion ownership only; the shared fence retains owner/phase authority.
final class AppleIdentityCallbackDrain {
    enum Stage { case reauthentication, token }
    private var outstanding: Stage?

    func begin(_ stage: Stage) -> Bool {
        guard outstanding == nil else { return false }
        outstanding = stage
        return true
    }
    func drain(_ stage: Stage) -> Bool {
        guard outstanding == stage else { return false }
        outstanding = nil
        return true
    }
    func canRelease(_ fence: GoogleIdentityReauthenticationFence) -> Bool {
        fence.canRelease && outstanding == nil
    }
}

/// Fresh Apple credentials reauthenticate one captured Firebase user, never sign in another.
final class AppleIdentityReauthentication: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private final class Operation {
        let call: CAPPluginCall
        let user: FirebaseAuth.User
        let subject: String
        let window: ASPresentationAnchor
        let fence: GoogleIdentityReauthenticationFence
        let callbacks = AppleIdentityCallbackDrain()
        var nonce: String?
        var controller: ASAuthorizationController?
        var timeout: DispatchWorkItem?
        init(call: CAPPluginCall, user: FirebaseAuth.User, subject: String, window: ASPresentationAnchor, nonce: String) {
            self.call = call; self.user = user; self.subject = subject; self.window = window; self.nonce = nonce
            fence = GoogleIdentityReauthenticationFence(expectedUserID: user.uid, now: ProcessInfo.processInfo.systemUptime)
        }
    }
    private let auth: Auth
    private var operation: Operation?
    private var observation: AuthStateDidChangeListenerHandle?
    private var presentationWindow: ASPresentationAnchor?
    var busy: Bool { operation != nil }

    init(auth: Auth) {
        self.auth = auth
        super.init()
        observation = auth.addStateDidChangeListener { [weak self] source, _ in
            DispatchQueue.main.async {
                guard let self, let op = self.operation, source.currentUser !== op.user else { return }
                self.finish(op, code: "session_changed")
            }
        }
    }
    deinit { if let observation { auth.removeStateDidChangeListener(observation) } }

    func start(_ call: CAPPluginCall, window: ASPresentationAnchor) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !busy else { call.reject("Identity verification is already in progress.", "identity_busy"); return }
        guard let expected = call.getString("expectedUserId"), !expected.isEmpty,
              let user = auth.currentUser, user.uid == expected,
              let apple = user.providerData.first(where: { $0.providerID == "apple.com" }) else {
            call.reject("Verify the current Apple identity.", "apple_identity_required"); return
        }
        var random = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, random.count, &random) == errSecSuccess else {
            call.reject("Identity verification is unavailable.", "identity_verification_failed"); return
        }
        let nonce = random.map { String(format: "%02x", $0) }.joined()
        let op = Operation(call: call, user: user, subject: apple.uid, window: window, nonce: nonce)
        operation = op
        presentationWindow = window
        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.nonce = SHA256.hash(data: Data(nonce.utf8)).map { String(format: "%02x", $0) }.joined()
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self; controller.presentationContextProvider = self; op.controller = controller
        let timeout = DispatchWorkItem { [weak self, weak op] in
            guard let self, let op else { return }; self.finish(op, code: "identity_timeout")
        }
        op.timeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 120, execute: timeout)
        controller.performRequests()
    }

    func invalidate() { if let operation { finish(operation, code: "session_changed") } }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        // Only the controller belonging to this retained operation is ever presented.
        operation?.window ?? presentationWindow ?? ASPresentationAnchor()
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let op = operation, op.controller === controller, op.fence.drainProvider() else { return }
        if op.fence.settled { release(op); return }
        guard claim(op, phase: 0), let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              credential.user == op.subject else { finish(op, code: "identity_mismatch"); return }
        guard let nonce = op.nonce, let bytes = credential.identityToken,
              let token = String(data: bytes, encoding: .utf8), !token.isEmpty else {
            finish(op, code: "identity_verification_failed"); return
        }
        op.nonce = nil // A replayed delegate result cannot reuse this credential.
        let proof = OAuthProvider.appleCredential(withIDToken: token, rawNonce: nonce, fullName: nil)
        guard op.callbacks.begin(.reauthentication) else { finish(op, code: "identity_verification_failed"); return }
        op.user.reauthenticate(with: proof) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self, op.callbacks.drain(.reauthentication) else { return }
                if op.fence.settled { self.release(op); return }
                guard self.claim(op, phase: 1) else { return }
                guard error == nil, result?.user.uid == op.user.uid else {
                    self.finish(op, code: "identity_verification_failed"); return
                }
                self.readFreshToken(op)
            }
        }
    }

    private func readFreshToken(_ op: Operation) {
        guard op.callbacks.begin(.token) else { finish(op, code: "identity_verification_failed"); return }
        op.user.getIDTokenForcingRefresh(true) { [weak self] token, error in
            DispatchQueue.main.async {
                guard let self, op.callbacks.drain(.token) else { return }
                if op.fence.settled { self.release(op); return }
                guard self.claim(op, phase: 2) else { return }
                guard error == nil, let token, !token.isEmpty else {
                    self.finish(op, code: "identity_verification_failed"); return
                }
                guard op.fence.settle() else { return }
                op.timeout?.cancel(); self.release(op)
                op.call.resolve(["userId": op.user.uid, "idToken": token])
            }
        }
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        guard let op = operation, op.controller === controller, op.fence.drainProvider() else { return }
        if op.fence.settled { release(op); return }
        finish(op, code: (error as? ASAuthorizationError)?.code == .canceled ? "identity_cancelled" : "identity_verification_failed")
    }

    private func claim(_ op: Operation, phase: Int) -> Bool {
        guard operation === op else { return false }
        switch op.fence.claim(phase: phase, userID: auth.currentUser?.uid,
                              sameSession: auth.currentUser === op.user, now: ProcessInfo.processInfo.systemUptime) {
        case .accepted: return true
        case .ignored: return false
        case .stale: finish(op, code: "session_changed"); return false
        }
    }
    private func finish(_ op: Operation, code: String) {
        guard op.fence.settle() else { return }
        op.timeout?.cancel(); op.nonce = nil
        release(op)
        op.call.reject("Apple identity verification did not complete.", code)
    }
    private func release(_ op: Operation) {
        if operation === op, op.callbacks.canRelease(op.fence) { operation = nil }
    }
}
