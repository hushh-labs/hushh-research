package com.hussh.app.plugins.HushhAuth

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseException
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseAuthInvalidCredentialsException
import com.google.firebase.auth.FirebaseUser
import com.google.firebase.auth.PhoneAuthCredential
import com.google.firebase.auth.PhoneAuthOptions
import com.google.firebase.auth.PhoneAuthProvider
import java.util.concurrent.TimeUnit

/** Metadata only. A cancelled exchange retains its slot until SDK completion cleans it. */
internal class DeletionPhoneProofFence(val userId: String, val attemptId: String, now: Long) {
    enum class Phase { WAITING, CODE_SENT, EXCHANGING, SETTLED }
    var phase = Phase.WAITING
        private set
    var exchangeOutstanding = false
        private set
    val deadline = now + 300_000L
    val canRelease get() = phase == Phase.SETTLED && !exchangeOutstanding
    fun current(userId: String?, sameSession: Boolean, now: Long) =
        phase != Phase.SETTLED && userId == this.userId && sameSession && now < deadline
    fun codeSent(userId: String?, sameSession: Boolean, now: Long): Boolean {
        if (phase != Phase.WAITING || !current(userId, sameSession, now)) return false
        phase = Phase.CODE_SENT
        return true
    }
    fun exchange(expected: Phase, userId: String?, sameSession: Boolean, now: Long): Boolean {
        if (phase != expected || !current(userId, sameSession, now)) return false
        phase = Phase.EXCHANGING
        exchangeOutstanding = true
        return true
    }
    fun settle(): Boolean {
        if (phase == Phase.SETTLED) return false
        phase = Phase.SETTLED
        return true
    }
    fun drainExchange() { exchangeOutstanding = false }
    fun retryCode() {
        if (phase == Phase.EXCHANGING) phase = Phase.CODE_SENT
        exchangeOutstanding = false
    }
}

/** Deletion-only phone proof. Never signs in, links, or replaces the primary user. */
internal class DeletionPhoneProof(private val activity: Activity, private val primary: FirebaseAuth) {
    companion object {
        // The SDK namespace outlives an Activity. A recreated bridge must wait for the old task's cleanup.
        private var exchangeOwner: Any? = null
    }
    private class Operation(val user: FirebaseUser, val phone: String, val fence: DeletionPhoneProofFence, call: PluginCall) {
        var call: PluginCall? = call
        var verificationId: String? = null
        var timeout: Runnable? = null
    }
    private val handler = Handler(Looper.getMainLooper())
    private val proof: FirebaseAuth
    private var operation: Operation? = null

    init {
        val name = "hushh-deletion-phone-proof"
        val app = FirebaseApp.getApps(activity).firstOrNull { it.name == name }
            ?: FirebaseApp.initializeApp(activity.applicationContext, primary.app.options, name)
        proof = FirebaseAuth.getInstance(app)
        // Recreate the stable SDK namespace, then clear residue even after process death.
        if (exchangeOwner == null) proof.signOut()
    }

    fun start(call: PluginCall) = handler.post {
        val expected = call.getString("expectedUserId")
        val attempt = call.getString("attemptId")
        val phone = call.getString("phoneNumber")
        val user = primary.currentUser
        if (operation != null || exchangeOwner != null) {
            call.reject("Phone verification is already in progress.", "phone_verification_busy")
            return@post
        }
        if (user == null || user.uid != expected || attempt.isNullOrBlank() || attempt.length > 128 ||
            phone == null || !Regex("\\+[1-9][0-9]{6,14}").matches(phone)) {
            call.reject("Verify the current account and phone.", "session_changed")
            return@post
        }
        proof.signOut()
        val op = Operation(user, phone, DeletionPhoneProofFence(user.uid, attempt, SystemClock.elapsedRealtime()), call)
        operation = op
        expire(op, 120_000L)
        try {
            PhoneAuthProvider.verifyPhoneNumber(PhoneAuthOptions.newBuilder(primary)
                .setPhoneNumber(phone)
                .setTimeout(0L, TimeUnit.SECONDS)
                .setActivity(activity)
                .setCallbacks(object : PhoneAuthProvider.OnVerificationStateChangedCallbacks() {
                    override fun onCodeSent(id: String, token: PhoneAuthProvider.ForceResendingToken) {
                        if (!active(op) || !op.fence.codeSent(primary.currentUser?.uid, primary.currentUser === op.user, SystemClock.elapsedRealtime())) return
                        op.verificationId = id
                        op.call?.resolve(JSObject().put("attemptId", attempt).put("verificationId", attempt))
                        op.call = null
                        expire(op, (op.fence.deadline - SystemClock.elapsedRealtime()).coerceAtLeast(1))
                    }
                    override fun onVerificationCompleted(credential: PhoneAuthCredential) {
                        // An instant result precedes codeSent. Later auto-retrieval leaves manual entry intact.
                        exchange(op, credential, DeletionPhoneProofFence.Phase.WAITING)
                    }
                    override fun onVerificationFailed(error: FirebaseException) {
                        if (active(op) && op.fence.phase == DeletionPhoneProofFence.Phase.WAITING)
                            finish(op, "phone_verification_failed")
                    }
                }).build())
        } catch (_: Exception) { finish(op, "phone_verification_failed") }
    }

    fun confirm(call: PluginCall) = handler.post {
        val op = operation
        if (op == null || call.getString("attemptId") != op.fence.attemptId ||
            call.getString("expectedUserId") != op.fence.userId || !active(op)) {
            call.reject("Request a new verification code.", "auth/session-expired")
            return@post
        }
        val code = call.getString("verificationCode") ?: ""
        val id = op.verificationId
        if (op.fence.phase != DeletionPhoneProofFence.Phase.CODE_SENT || id == null || !Regex("[0-9]{6}").matches(code)) {
            call.reject("Enter the six-digit verification code.", "auth/invalid-verification-code")
            return@post
        }
        op.call = call
        exchange(op, PhoneAuthProvider.getCredential(id, code), DeletionPhoneProofFence.Phase.CODE_SENT)
    }

    fun cancel(call: PluginCall) = handler.post {
        operation?.takeIf { it.fence.attemptId == call.getString("attemptId") }?.let { finish(it, "phone_verification_cancelled") }
        call.resolve()
    }

    fun invalidate() = handler.post {
        operation?.let { finish(it, "session_changed") }
        if (exchangeOwner == null) proof.signOut()
    }

    private fun active(op: Operation): Boolean {
        if (operation !== op) return false
        if (!op.fence.current(primary.currentUser?.uid, primary.currentUser === op.user, SystemClock.elapsedRealtime())) {
            finish(op, "session_changed")
            return false
        }
        return true
    }

    private fun expire(op: Operation, delay: Long) {
        op.timeout?.let(handler::removeCallbacks)
        op.timeout = Runnable { if (operation === op) finish(op, "auth/session-expired") }
        handler.postDelayed(op.timeout!!, delay)
    }

    private fun exchange(op: Operation, credential: PhoneAuthCredential, phase: DeletionPhoneProofFence.Phase) {
        if (!active(op) || op.fence.phase != phase) return
        if (exchangeOwner != null) {
            if (active(op)) finish(op, "phone_verification_busy")
            return
        }
        if (!active(op) || !op.fence.exchange(phase, primary.currentUser?.uid, primary.currentUser === op.user, SystemClock.elapsedRealtime())) return
        exchangeOwner = op
        expire(op, 30_000L)
        try { proof.signInWithCredential(credential).addOnCompleteListener { result ->
            handler.post {
                if (!active(op) || !result.isSuccessful || result.result?.user?.phoneNumber != op.phone) {
                    val code = (result.exception as? FirebaseAuthInvalidCredentialsException)?.errorCode
                    if (active(op) && phase == DeletionPhoneProofFence.Phase.CODE_SENT && code == "ERROR_INVALID_VERIFICATION_CODE") {
                        proof.signOut()
                        exchangeOwner = null
                        op.fence.retryCode()
                        val reply = op.call
                        op.call = null
                        expire(op, (op.fence.deadline - SystemClock.elapsedRealtime()).coerceAtLeast(1))
                        reply?.reject("That code is incorrect.", "auth/invalid-verification-code")
                    } else { finish(op, "phone_verification_failed"); drain(op) }
                } else {
                    // A fresh exchange already issued this token; never restore or refresh a cached proof identity.
                    result.result!!.user!!.getIdToken(false).addOnCompleteListener { tokenResult ->
                        handler.post {
                            val token = tokenResult.takeIf { it.isSuccessful }?.result?.token
                            if (active(op) && tokenResult.isSuccessful && !token.isNullOrEmpty()) {
                                val reply = op.call
                                finish(op)
                                drain(op)
                                reply?.resolve(JSObject().put("attemptId", op.fence.attemptId).put("phoneIdToken", token))
                            } else {
                                finish(op, "phone_verification_failed")
                                drain(op)
                            }
                        }
                    }
                }
            }
        } } catch (_: Exception) { finish(op, "phone_verification_failed"); drain(op) }
    }

    private fun finish(op: Operation, error: String? = null) {
        if (!op.fence.settle()) return
        op.timeout?.let(handler::removeCallbacks)
        op.verificationId = null
        if (error != null) op.call?.reject("Phone verification did not complete.", error)
        op.call = null
        if (exchangeOwner == null || exchangeOwner === op) proof.signOut()
        release(op)
    }

    private fun drain(op: Operation) {
        // Cancellation can race SDK sign-in; clear again after its completion before admitting another attempt.
        proof.signOut()
        if (exchangeOwner === op) exchangeOwner = null
        op.fence.drainExchange()
        release(op)
    }
    private fun release(op: Operation) { if (operation === op && op.fence.canRelease) operation = null }
}
