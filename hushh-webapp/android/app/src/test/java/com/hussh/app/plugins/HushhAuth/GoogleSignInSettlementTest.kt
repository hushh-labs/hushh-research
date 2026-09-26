package com.hussh.app.plugins.HushhAuth

import java.io.File
import org.junit.Assert.*
import org.junit.Test

class GoogleSignInSettlementTest {
    @Test fun answersJsExactlyOnce() {
        val settlement = GoogleSignInSettlement()
        assertFalse(settlement.isSettled)
        assertTrue(settlement.settle())
        assertTrue(settlement.isSettled)
        // A late Firebase callback or the exchange deadline cannot answer again.
        assertFalse(settlement.settle())
    }

    @Test fun mapsProviderStatusesToStableBridgeCodes() {
        assertEquals("USER_CANCELLED", GoogleSignInSettlement.codeForGoogleStatus(12501))
        assertEquals("auth/network-request-failed", GoogleSignInSettlement.codeForGoogleStatus(7))
        assertEquals("auth/google-sign-in-failed", GoogleSignInSettlement.codeForGoogleStatus(10))
        assertEquals("auth/google-sign-in-failed", GoogleSignInSettlement.codeForGoogleStatus(8))
    }

    @Test fun boundsTheFirebaseExchangeButNotTheAccountPicker() {
        assertTrue(GoogleSignInSettlement.FIREBASE_EXCHANGE_TIMEOUT_MS in 15_000L..60_000L)
    }

    /**
     * Regression for the Play build hang: on a network that drops IPv6 the
     * Firebase exchange took minutes and nothing bounded it. Every exit must
     * go through the single settlement, which the exchange deadline also
     * uses, and no listener may be dropped at Activity onStop.
     */
    @Test fun firebaseExchangeAlwaysSettlesThroughTheBoundedPath() {
        val source = File(
            "src/main/java/com/hussh/app/plugins/HushhAuth/HushhAuthPlugin.kt"
        ).readText()
        assertFalse(source.contains("addOnCompleteListener(activity)"))
        assertFalse(source.contains("addOnSuccessListener(activity)"))
        assertFalse(source.contains("addOnFailureListener(activity)"))
        assertTrue(source.contains("finishGoogleSignIn(call, settlement) { call.resolve(response) }"))
        assertTrue(source.contains(
            "googleSignInHandler.postDelayed(timeout, GoogleSignInSettlement.FIREBASE_EXCHANGE_TIMEOUT_MS)"
        ))
        assertFalse(source.contains("call.reject(\"Firebase sign-in failed: \${task.exception?.message}\")"))
    }
}
