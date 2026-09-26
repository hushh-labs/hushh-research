package com.hussh.app.plugins.HushhAuth

/**
 * Settles one native Google sign-in exactly once.
 *
 * The provider result, the Firebase exchange, and the bounded exchange
 * deadline can all try to answer the same JS call. Only the first one wins,
 * so the WebView always gets exactly one resolve or reject and never waits
 * forever on a callback that was dropped.
 */
internal class GoogleSignInSettlement {
    private var settled = false

    val isSettled: Boolean
        get() = settled

    fun settle(): Boolean {
        if (settled) return false
        settled = true
        return true
    }

    companion object {
        /** Bounds only the Firebase exchange; the account picker is user-paced. */
        const val FIREBASE_EXCHANGE_TIMEOUT_MS = 45_000L

        const val CANCELLED = "USER_CANCELLED"
        const val NETWORK = "auth/network-request-failed"
        const val TIMEOUT = "auth/timeout"
        const val FAILED = "auth/google-sign-in-failed"

        private const val SIGN_IN_CANCELLED = 12501
        private const val NETWORK_ERROR = 7

        fun codeForGoogleStatus(statusCode: Int): String = when (statusCode) {
            SIGN_IN_CANCELLED -> CANCELLED
            NETWORK_ERROR -> NETWORK
            else -> FAILED
        }
    }
}
