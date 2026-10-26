// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Hushh
package com.hussh.app.plugins.HushhAuth

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseAuthException
import com.google.firebase.auth.FirebaseUser
import com.google.firebase.auth.OAuthProvider
import java.lang.ref.WeakReference

/** The Firebase SDK owns Apple OAuth state; only this captured user can reauthenticate. */
internal class AppleIdentityReauthentication(activity: Activity, private val auth: FirebaseAuth) {
    private class Operation(val call: PluginCall, val user: FirebaseUser) {
        val fence = GoogleIdentityReauthenticationFence(user.uid, SystemClock.elapsedRealtime())
        var timeout: Runnable? = null
    }
    private val screen = WeakReference(activity)
    private val handler = Handler(Looper.getMainLooper())
    private var operation: Operation? = null
    val busy get() = operation != null
    private val observation = FirebaseAuth.AuthStateListener { source ->
        handler.post { operation?.takeIf { source.currentUser !== it.user }?.let { finish(it, "session_changed") } }
    }
    init { auth.addAuthStateListener(observation) }

    fun start(call: PluginCall) {
        check(Looper.myLooper() == Looper.getMainLooper())
        if (busy || auth.pendingAuthResult != null) {
            call.reject("Identity verification is already in progress.", "identity_busy"); return
        }
        val user = auth.currentUser
        val activity = screen.get()
        if (user == null || user.uid != call.getString("expectedUserId") ||
            user.providerData.none { it.providerId == "apple.com" } || activity == null) {
            call.reject("Verify the current Apple identity.", "apple_identity_required"); return
        }
        val op = Operation(call, user)
        operation = op
        op.timeout = Runnable { finish(op, "identity_timeout") }
        handler.postDelayed(op.timeout!!, 120_000L)
        try {
            user.startActivityForReauthenticateWithProvider(activity, OAuthProvider.newBuilder("apple.com").build())
                .addOnCompleteListener { task -> handler.post {
                    if (!op.fence.drainProvider()) return@post
                    if (op.fence.settled) { release(op); return@post }
                    if (!claim(op, 0)) return@post
                    if (!task.isSuccessful || task.result?.user?.uid != op.user.uid) {
                        val code = (task.exception as? FirebaseAuthException)?.errorCode
                        finish(op, when (code) {
                            "ERROR_WEB_CONTEXT_CANCELED" -> "identity_cancelled"
                            "ERROR_USER_MISMATCH" -> "identity_mismatch"
                            else -> "identity_verification_failed"
                        }); return@post
                    }
                    readFreshToken(op)
                } }
        } catch (_: Exception) {
            op.fence.drainProvider(); finish(op, "identity_verification_failed")
        }
    }

    private fun readFreshToken(op: Operation) {
        op.user.getIdToken(true).addOnCompleteListener { task -> handler.post {
            if (!claim(op, 1)) return@post
            val token = task.takeIf { it.isSuccessful }?.result?.token
            if (token.isNullOrBlank()) { finish(op, "identity_verification_failed"); return@post }
            if (!op.fence.settle()) return@post
            op.timeout?.let(handler::removeCallbacks); release(op)
            op.call.resolve(JSObject().put("userId", op.user.uid).put("idToken", token))
        } }
    }

    fun invalidate() { operation?.let { finish(it, "session_changed") } }
    fun close() { invalidate(); auth.removeAuthStateListener(observation) }

    private fun claim(op: Operation, phase: Int): Boolean {
        if (operation !== op) return false
        return when (op.fence.claim(phase, auth.currentUser?.uid, auth.currentUser === op.user, SystemClock.elapsedRealtime())) {
            GoogleIdentityReauthenticationFence.Claim.ACCEPTED -> true
            GoogleIdentityReauthenticationFence.Claim.IGNORED -> false
            GoogleIdentityReauthenticationFence.Claim.STALE -> { finish(op, "session_changed"); false }
        }
    }
    private fun finish(op: Operation, code: String) {
        if (!op.fence.settle()) return
        op.timeout?.let(handler::removeCallbacks); release(op)
        op.call.reject("Apple identity verification did not complete.", code)
    }
    private fun release(op: Operation) { if (operation === op && op.fence.canRelease) operation = null }
}
