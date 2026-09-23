package com.hussh.app.plugins.HushhAuth

/** Single-use metadata fence; contains no credentials or persisted state. */
internal class GoogleIdentityReauthenticationFence(
    val expectedUserId: String,
    now: Long
) {
    enum class Claim { ACCEPTED, IGNORED, STALE }
    val deadline = now + 120_000L
    var phase = 0
        private set
    var settled = false
        private set
    var providerOutstanding = true
        private set
    val canRelease: Boolean get() = settled && !providerOutstanding

    fun claim(expectedPhase: Int, userId: String?, sameSession: Boolean, now: Long): Claim {
        if (settled || phase != expectedPhase) return Claim.IGNORED
        if (!sameSession || userId != expectedUserId || now >= deadline) return Claim.STALE
        phase += 1
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
