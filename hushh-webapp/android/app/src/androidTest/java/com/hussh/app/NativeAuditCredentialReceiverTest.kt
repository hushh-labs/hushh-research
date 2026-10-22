package com.hussh.app

import android.content.Context
import android.content.ContextWrapper
import android.content.pm.ApplicationInfo
import android.net.LocalSocket
import android.net.LocalSocketAddress
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.*
import org.junit.Test
import org.junit.Assume.assumeTrue
import org.junit.runner.RunWith

/** Synthetic in-memory frames only. No activity, login, vault or provider runs. */
@RunWith(AndroidJUnit4::class)
class NativeAuditCredentialReceiverTest {
    private val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
    private fun socketFile(id: String) = File(context.cacheDir, "native-audit-$id.sock")
    private fun connect(id: String) = LocalSocket().apply {
        connect(LocalSocketAddress(socketFile(id).absolutePath, LocalSocketAddress.Namespace.FILESYSTEM))
        soTimeout = 2_000
    }
    private fun frame(id: String): ByteArray {
        val buffer = ByteArrayOutputStream()
        DataOutputStream(buffer).apply {
            write("HUSHHN1\n".toByteArray(Charsets.US_ASCII))
            for (value in listOf(id, "synthetic-reviewer", "synthetic-passphrase")) {
                val encoded = value.toByteArray(Charsets.UTF_8)
                writeInt(encoded.size)
                write(encoded)
            }
        }
        return buffer.toByteArray()
    }
    @Test fun hostRunAsStdinDeliversSyntheticCredentials() {
        val id = InstrumentationRegistry.getArguments().getString("nativeAuditHostRunId").orEmpty()
        assumeTrue("Requires the host stdin transport driver", id.isNotEmpty())
        val delivered = CountDownLatch(1)
        NativeAuditCredentialReceiver(context, true, id, {
            assertEquals("synthetic-reviewer", it.userId)
            assertEquals("synthetic-passphrase", it.passphrase)
            delivered.countDown()
        }, { }).use {
            assertTrue("Host transport did not deliver", delivered.await(10, TimeUnit.SECONDS))
        }
        assertFalse(socketFile(id).exists())
    }

    @Test fun explicitDebugModeIsRequiredBeforeBinding() {
        val id = UUID.randomUUID().toString()
        for ((target, requested) in listOf(context to false, object : ContextWrapper(context) {
            override fun getApplicationInfo() = ApplicationInfo(super.getApplicationInfo()).apply {
                flags = flags and ApplicationInfo.FLAG_DEBUGGABLE.inv()
            }
        } to true)) {
            try {
                NativeAuditCredentialReceiver(target, requested, id, { fail("Unexpected delivery") }, { })
                fail("Transport accepted an unauthorized mode")
            } catch (_: IllegalArgumentException) { }
            assertFalse(socketFile(id).exists())
        }
    }
    @Test fun sameUidFrameIsDeliveredOnceAfterSocketCleanup() {
        val id = UUID.randomUUID().toString()
        val received = CountDownLatch(1)
        val count = AtomicInteger()
        NativeAuditCredentialReceiver(context, true, id, {
            assertEquals("synthetic-reviewer", it.userId)
            assertEquals("synthetic-passphrase", it.passphrase)
            assertFalse(socketFile(id).exists())
            count.incrementAndGet()
            received.countDown()
        }, { fail("Synthetic frame refused") }).use {
            connect(id).use { client ->
                client.outputStream.write(frame(id))
                assertEquals("accepted", client.inputStream.bufferedReader().readLine())
            }
            assertTrue(received.await(3, TimeUnit.SECONDS))
            assertEquals(1, count.get())
            assertFalse(socketFile(id).exists())
        }
    }
    @Test fun wrongLaunchNeverDeliversAndCleansSocket() {
        val id = UUID.randomUUID().toString()
        val refused = CountDownLatch(1)
        val count = AtomicInteger()
        NativeAuditCredentialReceiver(context, true, id, { count.incrementAndGet() }, { refused.countDown() }).use {
            connect(id).use { client -> client.outputStream.write(frame(UUID.randomUUID().toString())) }
            assertTrue(refused.await(3, TimeUnit.SECONDS))
            assertEquals(0, count.get())
            assertFalse(socketFile(id).exists())
        }
    }
    @Test fun cancellationCannotDeliverOrUnlinkReplacement() {
        repeat(10) {
            val id = UUID.randomUUID().toString()
            val count = AtomicInteger()
            val old = NativeAuditCredentialReceiver(context, true, id, { count.incrementAndGet() }, { })
            connect(id).use { client ->
                client.outputStream.write("HUS".toByteArray())
                old.close()
                val delivered = CountDownLatch(1)
                NativeAuditCredentialReceiver(context, true, id, { delivered.countDown() }, { }).use {
                    old.close()
                    connect(id).use { replacement ->
                        replacement.outputStream.write(frame(id))
                        assertEquals("accepted", replacement.inputStream.bufferedReader().readLine())
                    }
                    assertTrue(delivered.await(3, TimeUnit.SECONDS))
                }
            }
            assertEquals(0, count.get())
            assertFalse(socketFile(id).exists())
        }
    }
    @Test fun absoluteExpiryStopsSlowSenderWithoutMainThreadScheduling() {
        val id = UUID.randomUUID().toString()
        val refused = CountDownLatch(1)
        val count = AtomicInteger()
        NativeAuditCredentialReceiver(context, true, id, { count.incrementAndGet() }, { refused.countDown() }, timeoutMs = 250).use {
            connect(id).use { client ->
                for (byte in "HUSHHN1\n".toByteArray()) {
                    try { client.outputStream.write(byte.toInt()) } catch (_: Exception) { break }
                    Thread.sleep(60)
                }
                assertTrue(refused.await(2, TimeUnit.SECONDS))
            }
            assertEquals(0, count.get())
            assertFalse(socketFile(id).exists())
        }
    }
}
