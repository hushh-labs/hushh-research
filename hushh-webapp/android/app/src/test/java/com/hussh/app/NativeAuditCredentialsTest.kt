package com.hussh.app

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import org.junit.Assert.*
import org.junit.Test

class NativeAuditCredentialsTest {
    private val runId = "ce2a360b-8dac-4ab0-8f84-e3e7f17d3d88"
    private fun frame(id: String = runId, user: String = "synthetic-reviewer", passphrase: String = " secret\n🔐 "): ByteArray {
        val bytes = ByteArrayOutputStream()
        val stream = DataOutputStream(bytes)
        stream.write("HUSHHN1\n".toByteArray(Charsets.US_ASCII))
        for (value in listOf(id, user, passphrase)) {
            val encoded = value.toByteArray(Charsets.UTF_8)
            stream.writeInt(encoded.size)
            stream.write(encoded)
        }
        return bytes.toByteArray()
    }
    private fun refused(bytes: ByteArray, expected: String = runId) {
        try {
            NativeAuditCredentials.read(ByteArrayInputStream(bytes), expected)
            fail("Invalid credential frame was accepted")
        } catch (_: Exception) { }
    }
    @Test fun validFramePreservesWhitespaceAndUnicode() {
        val value = NativeAuditCredentials.read(ByteArrayInputStream(frame()), runId)
        assertEquals("synthetic-reviewer", value.userId)
        assertEquals(" secret\n🔐 ", value.passphrase)
        assertFalse(value.toString().contains("synthetic-reviewer"))
    }
    @Test fun wrongOrInvalidLaunchIsRefused() {
        refused(frame(), "ce2a360b-8dac-4ab0-8f84-e3e7f17d3d89")
        refused(frame(), "../../foreign")
        assertFalse(NativeAuditCredentials.validRunId(""))
        assertFalse(NativeAuditCredentials.validRunId("1-1-1-1-1"))
    }
    @Test fun oversizedAndEmptyFieldsAreRefused() {
        refused(frame(user = "x".repeat(513)))
        refused(frame(user = ""))
        refused(frame(user = "   "))
        refused(frame(passphrase = "x".repeat(4097)))
        refused(frame(passphrase = ""))
    }
    @Test fun malformedMagicLengthUtf8AndTruncationAreRefused() {
        val valid = frame()
        refused(valid.copyOf().also { it[0] = 0 })
        refused(valid.copyOf().also { it[8] = 0x7f })
        refused(valid.copyOf().also { it[12] = 0xff.toByte() })
        for (length in valid.indices) refused(valid.copyOf(length))
    }
}
