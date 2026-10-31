package com.hussh.app.plugins.HushhContacts

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HushhContactsPluginTest {
    @Test
    fun canonicalE164ReplacesRawNationalRendering() {
        assertEquals(
            "+16502530000",
            HushhContactsPlugin.preferredProviderPhone(
                "+16502530000",
                "650 253 0000"
            )
        )
    }

    @Test
    fun malformedCanonicalFallsBackToRawNumber() {
        assertEquals(
            "98765 43210",
            HushhContactsPlugin.preferredProviderPhone("+0123", "98765 43210")
        )
    }

    @Test
    fun emptyProviderRowIsIgnored() {
        assertNull(HushhContactsPlugin.preferredProviderPhone("", "  "))
    }
}
