import Foundation
import Capacitor
import FirebaseCore
import FirebaseAuth

/// Metadata only; an outstanding SDK exchange stays quarantined after cancellation.
final class DeletionPhoneProofFence {
    enum Phase { case waiting, codeSent, exchanging, settled }
    let userID: String
    let attemptID: String
    let deadline: TimeInterval
    private(set) var phase: Phase = .waiting
    private(set) var exchangeOutstanding = false
    var canRelease: Bool { phase == .settled && !exchangeOutstanding }
    init(userID: String, attemptID: String, now: TimeInterval) {
        self.userID = userID
        self.attemptID = attemptID
        deadline = now + 300
    }
    func current(userID: String?, sameSession: Bool, now: TimeInterval) -> Bool {
        phase != .settled && userID == self.userID && sameSession && now < deadline
    }
    func codeSent(userID: String?, sameSession: Bool, now: TimeInterval) -> Bool {
        guard phase == .waiting, current(userID: userID, sameSession: sameSession, now: now) else { return false }
        phase = .codeSent
        return true
    }
    func exchange(userID: String?, sameSession: Bool, now: TimeInterval) -> Bool {
        guard phase == .codeSent, current(userID: userID, sameSession: sameSession, now: now) else { return false }
        phase = .exchanging
        exchangeOutstanding = true
        return true
    }
    @discardableResult func settle() -> Bool {
        guard phase != .settled else { return false }
        phase = .settled
        return true
    }
    func retryCode() { if phase == .exchanging { phase = .codeSent }; exchangeOutstanding = false }
    func drainExchange() { exchangeOutstanding = false }
}

/// A deletion-only adapter. The primary Firebase identity is never replaced or linked.
final class DeletionPhoneProof {
    private final class Operation {
        let user: FirebaseAuth.User
        let phone: String
        let fence: DeletionPhoneProofFence
        var call: CAPPluginCall?
        var verificationID: String?
        var timeout: DispatchWorkItem?
        var cleaned = true
        init(user: FirebaseAuth.User, phone: String, attemptID: String, call: CAPPluginCall) {
            self.user = user
            self.phone = phone
            self.call = call
            fence = DeletionPhoneProofFence(userID: user.uid, attemptID: attemptID, now: ProcessInfo.processInfo.systemUptime)
        }
    }
    private let primary: Auth
    private let proof: Auth
    private var operation: Operation?
    // A named SDK Auth survives bridge recreation. Its old task must drain before another can use it.
    private static var exchangeOwner: Operation?

    init(primary: Auth) throws {
        dispatchPrecondition(condition: .onQueue(.main))
        self.primary = primary
        let name = "hushh-deletion-phone-proof"
        guard let main = FirebaseApp.app() else { throw NSError(domain: "DeletionPhoneProof", code: 1) }
        if FirebaseApp.app(name: name) == nil { FirebaseApp.configure(name: name, options: main.options) }
        guard let app = FirebaseApp.app(name: name) else { throw NSError(domain: "DeletionPhoneProof", code: 1) }
        proof = Auth.auth(app: app)
        // Recreate the SDK namespace, then remove crash residue before any proof can be used.
        if Self.exchangeOwner == nil { try proof.signOut() }
    }

    func start(_ call: CAPPluginCall) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard operation == nil, Self.exchangeOwner == nil else { call.reject("Phone verification is already in progress.", "phone_verification_busy"); return }
        guard let expected = call.getString("expectedUserId"), let user = primary.currentUser, user.uid == expected,
              let attempt = call.getString("attemptId"), !attempt.isEmpty, attempt.count <= 128,
              let phone = call.getString("phoneNumber"), phone.range(of: "^\\+[1-9][0-9]{6,14}$", options: .regularExpression) != nil else {
            call.reject("Verify the current account and phone.", "session_changed"); return
        }
        do { try proof.signOut() } catch { call.reject("Phone verification is unavailable.", "phone_verification_failed"); return }
        let op = Operation(user: user, phone: phone, attemptID: attempt, call: call)
        operation = op
        expire(op, after: 120)
        // App verification remains with the configured primary Firebase app; no sign-in occurs here.
        PhoneAuthProvider.provider(auth: primary).verifyPhoneNumber(phone, uiDelegate: nil) { id, error in
            DispatchQueue.main.async {
                guard self.active(op) else { return }
                guard error == nil, let id, !id.isEmpty,
                      op.fence.codeSent(userID: self.primary.currentUser?.uid, sameSession: self.primary.currentUser === op.user,
                                        now: ProcessInfo.processInfo.systemUptime) else {
                    self.finish(op, error: Self.safeErrorCode(error)); return
                }
                op.verificationID = id
                op.call?.resolve(["attemptId": attempt, "verificationId": attempt])
                op.call = nil
                self.expire(op, after: max(0.001, op.fence.deadline - ProcessInfo.processInfo.systemUptime))
            }
        }
    }

    func confirm(_ call: CAPPluginCall) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let op = operation, call.getString("attemptId") == op.fence.attemptID,
              call.getString("expectedUserId") == op.fence.userID, active(op) else {
            call.reject("Request a new verification code.", "phone-verification-required"); return
        }
        guard Self.exchangeOwner == nil else { call.reject("Phone verification is already in progress.", "phone_verification_busy"); return }
        guard let code = call.getString("verificationCode"), code.range(of: "^[0-9]{6}$", options: .regularExpression) != nil,
              let id = op.verificationID,
              op.fence.exchange(userID: primary.currentUser?.uid, sameSession: primary.currentUser === op.user,
                                now: ProcessInfo.processInfo.systemUptime) else {
            call.reject("Enter the six-digit verification code.", "auth/invalid-verification-code"); return
        }
        op.call = call
        Self.exchangeOwner = op
        expire(op, after: 30)
        let credential = PhoneAuthProvider.provider(auth: primary).credential(withVerificationID: id, verificationCode: code)
        proof.signIn(with: credential) { result, error in
            DispatchQueue.main.async {
                guard self.active(op) else { self.drain(op); return }
                guard error == nil, let user = result?.user, user.phoneNumber == op.phone else {
                    if (error as NSError?)?.code == AuthErrorCode.invalidVerificationCode.rawValue {
                        let reply = op.call
                        op.call = nil
                        do { try self.proof.signOut() } catch {
                            self.finish(op, error: "phone_verification_failed"); self.drain(op)
                            reply?.reject("Phone verification did not complete.", "phone_verification_failed"); return
                        }
                        Self.exchangeOwner = nil
                        op.fence.retryCode()
                        self.expire(op, after: max(0.001, op.fence.deadline - ProcessInfo.processInfo.systemUptime))
                        reply?.reject("That code is incorrect.", "auth/invalid-verification-code")
                    } else { self.finish(op, error: Self.safeErrorCode(error)); self.drain(op) }
                    return
                }
                // This exchange just minted the token; never refresh or restore a prior proof session.
                user.getIDTokenForcingRefresh(false) { token, error in
                    DispatchQueue.main.async {
                        if self.active(op), error == nil, let token, !token.isEmpty {
                            let reply = op.call
                            let cleaned = self.finish(op)
                            self.drain(op)
                            if cleaned { reply?.resolve(["attemptId": op.fence.attemptID, "phoneIdToken": token]) }
                            else { reply?.reject("Phone verification did not complete.", "phone_verification_failed") }
                        } else { self.finish(op, error: Self.safeErrorCode(error)); self.drain(op) }
                    }
                }
            }
        }
    }

    func cancel(_ call: CAPPluginCall) {
        dispatchPrecondition(condition: .onQueue(.main))
        if let op = operation, call.getString("attemptId") == op.fence.attemptID { finish(op, error: "phone_verification_cancelled") }
        call.resolve()
    }
    func invalidate() {
        dispatchPrecondition(condition: .onQueue(.main))
        if let op = operation { finish(op, error: "session_changed") }
        if Self.exchangeOwner == nil { try? proof.signOut() }
    }
    private func active(_ op: Operation) -> Bool {
        guard operation === op else { return false }
        guard op.fence.current(userID: primary.currentUser?.uid, sameSession: primary.currentUser === op.user,
                               now: ProcessInfo.processInfo.systemUptime) else { finish(op, error: "session_changed"); return false }
        return true
    }
    private func expire(_ op: Operation, after seconds: TimeInterval) {
        op.timeout?.cancel()
        let work = DispatchWorkItem { [weak self, weak op] in
            guard let self, let op, self.operation === op else { return }
            self.finish(op, error: "phone-verification-required")
        }
        op.timeout = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }
    private static func safeErrorCode(_ error: Error?) -> String {
        switch (error as NSError?)?.code {
        case AuthErrorCode.sessionExpired.rawValue: return "auth/code-expired"
        case AuthErrorCode.networkError.rawValue: return "auth/network-request-failed"
        case AuthErrorCode.tooManyRequests.rawValue: return "auth/too-many-requests"
        case AuthErrorCode.invalidAppCredential.rawValue: return "auth/invalid-app-credential"
        case AuthErrorCode.captchaCheckFailed.rawValue: return "auth/captcha-check-failed"
        default: return "phone_verification_failed"
        }
    }

    @discardableResult private func finish(_ op: Operation, error: String? = nil) -> Bool {
        guard op.fence.settle() else { return false }
        op.timeout?.cancel()
        op.timeout = nil
        op.verificationID = nil
        var cleaned = true
        if Self.exchangeOwner == nil || Self.exchangeOwner === op {
            do { try proof.signOut() } catch { cleaned = false }
        }
        op.cleaned = cleaned
        if let error { op.call?.reject("Phone verification did not complete.", error) }
        op.call = nil
        release(op)
        return cleaned
    }
    private func drain(_ op: Operation) {
        // A cancelled SDK task may sign in later. Clear again only after that task drains.
        do { try proof.signOut() } catch { return } // Keep the slot quarantined on cleanup failure.
        op.cleaned = true
        if Self.exchangeOwner === op { Self.exchangeOwner = nil }
        op.fence.drainExchange()
        release(op)
    }
    private func release(_ op: Operation) { if operation === op, op.cleaned, op.fence.canRelease { operation = nil } }
}
