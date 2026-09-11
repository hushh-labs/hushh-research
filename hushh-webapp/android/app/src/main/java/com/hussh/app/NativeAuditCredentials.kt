package com.hussh.app

import android.content.Context
import android.content.pm.ApplicationInfo
import android.net.LocalServerSocket
import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.os.Process
import android.os.SystemClock
import java.io.Closeable
import java.io.DataInputStream
import java.io.File
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.UUID
import java.util.Timer
import java.util.TimerTask
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/** Test-only memory transport; no credential is written to the socket inode. */
internal class NativeAuditCredentials(val userId: String, val passphrase: String) {
    companion object {
        fun validRunId(value: String): Boolean = try {
            UUID.fromString(value).toString() == value
        } catch (_: IllegalArgumentException) { false }

        fun read(input: InputStream, expectedRunId: String): NativeAuditCredentials {
            val stream = DataInputStream(input)
            val magic = ByteArray(8)
            stream.readFully(magic)
            require(magic.contentEquals("HUSHHN1\n".toByteArray(Charsets.US_ASCII)))
            fun field(limit: Int): String {
                val length = stream.readInt()
                require(length in 1..limit)
                val bytes = ByteArray(length)
                stream.readFully(bytes)
                return Charsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes)).toString()
            }
            require(validRunId(expectedRunId) && field(36) == expectedRunId)
            val userId = field(512)
            val passphrase = field(4096)
            require(userId.isNotBlank() && passphrase.isNotEmpty())
            // Exactly one typed frame is consumed; the connection is then closed.
            return NativeAuditCredentials(userId, passphrase)
        }
    }
}

internal class NativeAuditCredentialReceiver(
    context: Context,
    requested: Boolean,
    runId: String,
    private val received: (NativeAuditCredentials) -> Unit,
    private val refused: () -> Unit,
    timeoutMs: Long = 30_000,
) : Closeable {
    private val closed = AtomicBoolean(false)
    private val listenerReleased = AtomicBoolean(false)
    private val timer: Timer
    private val deadline = SystemClock.elapsedRealtime() + timeoutMs
    private val socketFile: File
    private val bound = LocalSocket()
    private val server: LocalServerSocket
    @Volatile private var client: LocalSocket? = null
    private val expiry = object : TimerTask() {
        override fun run() {
            if (closed.compareAndSet(false, true)) {
                timer.cancel()
                release()
                refused()
            }
        }
    }

    init {
        require(requested && (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0)
        require(NativeAuditCredentials.validRunId(runId))
        require(timeoutMs in 1..30_000)
        socketFile = File(context.cacheDir, "native-audit-$runId.sock")
        require(!socketFile.exists())
        var ownsSocket = false
        try {
            bound.bind(LocalSocketAddress(socketFile.absolutePath, LocalSocketAddress.Namespace.FILESYSTEM))
            ownsSocket = true
            bound.soTimeout = timeoutMs.toInt()
            server = LocalServerSocket(bound.fileDescriptor)
        } catch (failure: Exception) {
            bound.close()
            if (ownsSocket) socketFile.delete()
            throw IllegalStateException("Native audit transport unavailable")
        }
        // One absolute deadline covers accept and every byte, including slow senders.
        timer = Timer("native-audit-deadline", true)
        timer.schedule(expiry, timeoutMs)
        thread(name = "native-audit-credentials", isDaemon = true) {
            var delivery: NativeAuditCredentials? = null
            var failed = false
            try {
                server.accept().use { accepted ->
                client = accepted
                if (closed.get()) return@thread
                require(accepted.peerCredentials.uid == Process.myUid())
                val remaining = deadline - SystemClock.elapsedRealtime()
                require(remaining > 0)
                accepted.soTimeout = remaining.toInt()
                val credentials = NativeAuditCredentials.read(accepted.inputStream, runId)
                require(SystemClock.elapsedRealtime() < deadline)
                if (closed.compareAndSet(false, true)) {
                    timer.cancel()
                    accepted.outputStream.write("accepted\n".toByteArray(Charsets.US_ASCII))
                    delivery = credentials
                }
                }
            } catch (_: Exception) {
                if (closed.compareAndSet(false, true)) {
                    timer.cancel()
                    failed = true
                }
            } finally {
                release()
            }
            delivery?.let(received)
            if (failed) refused()
        }
    }

    private fun release() {
        try { client?.shutdownInput() } catch (_: Exception) { }
        try { client?.shutdownOutput() } catch (_: Exception) { }
        try { client?.close() } catch (_: Exception) { }
        client = null
        // Unlink only once: an old worker must never remove a replacement's
        // socket after activity recreation reused the same launch metadata.
        if (listenerReleased.compareAndSet(false, true)) {
            try { bound.close() } catch (_: Exception) { }
            socketFile.delete()
        }
    }

    override fun close() {
        closed.set(true)
        timer.cancel()
        release()
    }
}
