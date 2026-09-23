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

    @Test fun driveReturnRejectsExpirySignOutAndReplacedSession() {
        val scenarios = listOf(
            Triple(null, false, 101L), // Signed out while the browser was open.
            Triple("other-owner", false, 101L),
            Triple("owner", false, 101L), // Same UID in a replacement Firebase session.
            Triple("owner", true, 120_000L), // Callback at the deadline is expired.
        )
        for ((userId, sameSession, now) in scenarios) {
            val fence = NativeDriveAuthorizationFence("owner", "attempt_123456789012", 120_000)
            assertEquals(
                NativeDriveAuthorizationFence.Claim.STALE,
                fence.claim("attempt_123456789012", userId, sameSession, now)
            )
            assertFalse(fence.settled)
            assertFalse(fence.canRelease)
        }
    }

    @Test fun driveConnectionAndPickerReturnsCannotCrossSettle() {
        val connection = NativeDriveAuthorizationFence("owner", "connect_123456789012", 120_000)
        val picker = NativeDriveAuthorizationFence("owner", "picker_1234567890123", 120_000)
        assertEquals(
            NativeDriveAuthorizationFence.Claim.STALE,
            connection.claim(picker.expectedAttemptId, "owner", true, 101)
        )
        assertEquals(
            NativeDriveAuthorizationFence.Claim.STALE,
            picker.claim(connection.expectedAttemptId, "owner", true, 101)
        )
        assertEquals(
            NativeDriveAuthorizationFence.Claim.ACCEPTED,
            connection.claim(connection.expectedAttemptId, "owner", true, 101)
        )
        assertTrue(connection.drainProvider())
        assertFalse(connection.canRelease) // A provider return is not terminal settlement.
        assertTrue(connection.settle())
        assertFalse(connection.settle()) // Duplicate callback cannot complete twice.
        assertFalse(connection.drainProvider())
        assertTrue(connection.canRelease)
        assertFalse(picker.settled)
    }

    @Test fun cancelledDriveAttemptCannotAuthorizeAfterActivityRecreation() {
        val old = NativeDriveAuthorizationFence("owner", "old_attempt_123456789012", 120_000)
        assertTrue(old.settle()) // Native cancellation or activity teardown.
        assertFalse(old.canRelease) // Quarantine until the old browser returns.

        val recreated = NativeDriveAuthorizationFence("owner", "new_attempt_123456789012", 240_000)
        assertEquals(
            NativeDriveAuthorizationFence.Claim.STALE,
            recreated.claim(old.expectedAttemptId, "owner", true, 121_000)
        )
        assertEquals(
            NativeDriveAuthorizationFence.Claim.IGNORED,
            old.claim(old.expectedAttemptId, "owner", true, 121_000)
        )
        assertTrue(old.drainProvider())
        assertTrue(old.canRelease)
        assertEquals(
            NativeDriveAuthorizationFence.Claim.ACCEPTED,
            recreated.claim(recreated.expectedAttemptId, "owner", true, 121_000)
        )
        assertFalse(recreated.settled)
    }
}
