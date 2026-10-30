package com.hussh.app.plugins.HushhAuth

internal object NativeDriveOAuthPolicy {
    // Custom Tabs can report cancellation before the custom-scheme intent is
    // dispatched back to the singleTask activity. Keep the attempt pending
    // long enough for that verified return instead of cancelling a valid grant.
    const val FALLBACK_RETURN_GRACE_MS = 5_000L
}

/** Single-use, in-memory fence for an opaque Drive OAuth browser return. */
internal class NativeDriveAuthorizationFence(
    val expectedUserId: String,
    val expectedAttemptId: String,
    private val expiresAtMillis: Long
) {
    enum class Claim { ACCEPTED, IGNORED, STALE }

    var settled = false
        private set
    var providerOutstanding = true
        private set
    val canRelease: Boolean get() = settled && !providerOutstanding

    fun claim(attemptId: String?, userId: String?, sameSession: Boolean, now: Long): Claim {
        if (settled) return Claim.IGNORED
        if (!sameSession || userId != expectedUserId || attemptId != expectedAttemptId || now >= expiresAtMillis) {
            return Claim.STALE
        }
        return Claim.ACCEPTED
    }

    fun settle(): Boolean {
        if (settled) return false
        settled = true
        return true
    }

    fun drainProvider(): Boolean {
        if (!providerOutstanding) return false
        providerOutstanding = false
        return true
    }
}
