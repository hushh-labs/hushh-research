package com.hussh.app.plugins.HushhAuth

import org.junit.Assert.*
import org.junit.Test
import com.hussh.app.plugins.HushhAuth.GoogleIdentityReauthenticationFence.Claim

class GoogleIdentityReauthenticationFenceTest {
    @Test fun acceptsEachStageExactlyOnce() {
        val fence = GoogleIdentityReauthenticationFence("a", 100)
        assertEquals(Claim.IGNORED, fence.claim(1, "a", true, 101))
        assertTrue(fence.drainProvider())
        assertFalse(fence.drainProvider())
        for (phase in 0..2) {
            assertEquals(Claim.ACCEPTED, fence.claim(phase, "a", true, 101))
            assertEquals(Claim.IGNORED, fence.claim(phase, "a", true, 101))
        }
        assertTrue(fence.settle())
        assertFalse(fence.settle())
        assertTrue(fence.canRelease)
        assertEquals(Claim.IGNORED, fence.claim(3, "a", true, 101))
    }

    @Test fun rejectsWrongOwnerReplacementExpiryAndSignedOutAtEveryStage() {
        for (phase in 0..2) {
            for (scenario in 0..3) {
                val fence = GoogleIdentityReauthenticationFence("a", 100)
                for (previous in 0 until phase) {
                    assertEquals(Claim.ACCEPTED, fence.claim(previous, "a", true, 101))
                }
                assertEquals(Claim.STALE, fence.claim(
                    phase, when (scenario) { 0 -> "b"; 3 -> null; else -> "a" },
                    scenario != 1, if (scenario == 2) 120_100 else 101
                ))
                assertTrue(fence.settle())
                assertEquals(Claim.IGNORED, fence.claim(phase, "a", true, 101))
            }
        }
    }

    @Test fun quarantinesTimedOutOrCancelledProviderUntilItsResultDrains() {
        val old = GoogleIdentityReauthenticationFence("a", 100)
        assertTrue(old.settle())
        assertFalse(old.canRelease)
        assertTrue(old.drainProvider())
        assertTrue(old.canRelease)
        val next = GoogleIdentityReauthenticationFence("a", 120_101)
        assertEquals(Claim.IGNORED, old.claim(0, "a", true, 120_102))
        assertFalse(next.settled)
        assertEquals(0, next.phase)
    }

    @Test fun driveReturnAcceptsOnlyTheOriginalOwnerAndAttempt() {
        val fence = NativeDriveAuthorizationFence("owner", "attempt_123456789012", 120_000)
        assertEquals(
            NativeDriveAuthorizationFence.Claim.STALE,
            fence.claim("other_123456789012", "owner", true, 101)
        )
        assertFalse(fence.settled)
        assertEquals(
            NativeDriveAuthorizationFence.Claim.ACCEPTED,
            fence.claim("attempt_123456789012", "owner", true, 101)
        )
        assertTrue(fence.settle())
        assertEquals(
            NativeDriveAuthorizationFence.Claim.IGNORED,
            fence.claim("attempt_123456789012", "owner", true, 101)
        )
    }

    @Test fun driveReturnQuarantinesATimedOutProviderUntilItDrains() {
        val fence = NativeDriveAuthorizationFence("owner", "attempt_123456789012", 120_000)
        assertTrue(fence.settle())
        assertFalse(fence.canRelease)
        assertTrue(fence.drainProvider())
        assertTrue(fence.canRelease)
    }

    @Test fun pickerReturnHasItsOwnOpaqueAttemptAndCannotSettleAConnection() {
        val picker = NativeDriveAuthorizationFence("owner", "picker_1234567890123", 120_000)
        assertEquals(
            NativeDriveAuthorizationFence.Claim.STALE,
            picker.claim("attempt_123456789012", "owner", true, 101)
        )
        assertEquals(
            NativeDriveAuthorizationFence.Claim.STALE,
            picker.claim("picker_1234567890123", "other-owner", false, 101)
        )
        assertEquals(
            NativeDriveAuthorizationFence.Claim.ACCEPTED,
            picker.claim("picker_1234567890123", "owner", true, 101)
        )
        assertTrue(picker.settle())
        assertTrue(picker.drainProvider())
        assertTrue(picker.canRelease)
    }
}
