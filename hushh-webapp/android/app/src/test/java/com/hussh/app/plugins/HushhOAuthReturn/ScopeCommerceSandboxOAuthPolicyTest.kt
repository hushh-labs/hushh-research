package com.hussh.app.plugins.HushhOAuthReturn

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ScopeCommerceSandboxOAuthPolicyTest {
    @Test
    fun requiresDebugSandboxIdentityAndExactBuildPin() {
        val pin = "https://scope-commerce-preview-123.us-central1.run.app"
        val callback = "$pin/one/profile/connectors/oauth/return?code=synthetic&state=synthetic"
        val policy = ScopeCommerceSandboxOAuthPolicy
        assertTrue(policy.admits(callback, pin, policy.packageName, true))
        assertFalse(policy.admits(callback, pin, policy.packageName, false))
        assertFalse(policy.admits(callback, pin, "com.hussh.app", true))
        for (badPin in listOf(null, "https://one.hushh.ai", "https://other.run.app", "$pin/", "$pin:443")) {
            assertFalse(policy.admits(callback, badPin, policy.packageName, true))
        }
        for (badReturn in listOf("https://other.run.app/one/profile/connectors/oauth/return", "$pin/one/profile/account", "$pin/one/profile/connectors/oauth/return#token", "$pin/%6fne/profile/connectors/oauth/return")) {
            assertFalse(policy.admits(badReturn, pin, policy.packageName, true))
        }
    }
}
