package com.hussh.app.plugins.HushhVoiceInvocation

import android.Manifest
import android.content.Intent
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.net.Uri
import android.provider.Settings
import android.os.SystemClock
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@CapacitorPlugin(name = "HushhVoiceInvocation", permissions = [Permission(alias = "microphone", strings = [Manifest.permission.RECORD_AUDIO])])
class HushhVoiceInvocationPlugin : Plugin() {
    private var recording: CommandRecording? = null
    private var foreground = true
    private var foregroundSince = System.currentTimeMillis()

    private fun permissionPayload(): JSObject = JSObject().apply {
        put("state", when (getPermissionState("microphone")) {
            PermissionState.GRANTED -> "granted"
            PermissionState.DENIED -> "denied"
            else -> "prompt"
        })
        put("sourcePlatform", "android")
    }

    @PluginMethod
    fun getCommandCapturePermission(call: PluginCall) { call.resolve(permissionPayload()) }

    @PluginMethod
    fun requestCommandCapturePermission(call: PluginCall) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) call.resolve(permissionPayload())
        else requestPermissionForAlias("microphone", call, "commandPermissionCallback")
    }

    @PermissionCallback
    private fun commandPermissionCallback(call: PluginCall) { call.resolve(permissionPayload()) }

    @PluginMethod
    fun openCommandCaptureSettings(call: PluginCall) {
        try {
            activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))
            call.resolve(JSObject().put("opened", true))
        } catch (_: Exception) { call.resolve(JSObject().put("opened", false)) }
    }

    @PluginMethod
    @Synchronized
    fun startCommandCapture(call: PluginCall) {
        val id = call.getString("sessionId")
        if (id.isNullOrBlank() || id.length > 128) { call.reject("Invalid recording session."); return }
        val requestedAt = call.getDouble("requestedAtMs") ?: 0.0
        if (!foreground || requestedAt < foregroundSince || requestedAt > System.currentTimeMillis() + 1000) { call.reject("Recording gesture expired. Tap to record again."); return }
        if (recording?.released == true) recording = null
        if (recording != null) { call.reject("The microphone is already in use."); return }
        if (getPermissionState("microphone") != PermissionState.GRANTED) { call.reject("Microphone permission is required."); return }
        try {
            recording = CommandRecording(id, (call.getInt("maxDurationMs") ?: 60000).coerceIn(1, 60000)).also { it.start() }
            call.resolve(JSObject().put("sessionId", id))
        } catch (_: Exception) { recording?.cancel(); recording = null; call.reject("The microphone could not start.") }
    }

    @PluginMethod
    @Synchronized
    fun finishCommandCapture(call: PluginCall) {
        val active = recording
        if (active == null || active.id != call.getString("sessionId")) { call.reject("Recording expired or was cancelled."); return }
        recording = null
        try { call.resolve(active.finish()) }
        catch (_: Exception) { active.cancel(); call.reject("Recording could not be finalized.") }
    }

    @PluginMethod
    @Synchronized
    fun cancelCommandCapture(call: PluginCall) {
        val active = recording
        if (active == null || active.id != call.getString("sessionId")) { call.resolve(JSObject().put("cancelled", false)); return }
        active.cancel(); call.resolve(JSObject().put("cancelled", true))
    }

    @Synchronized
    private fun cancelActive() { foreground = false; recording?.cancel() }
    @Synchronized
    override fun handleOnResume() { foreground = true; foregroundSince = System.currentTimeMillis(); super.handleOnResume() }
    override fun handleOnPause() { cancelActive(); super.handleOnPause() }
    override fun handleOnDestroy() { cancelActive(); super.handleOnDestroy() }
}

/** Mono PCM16, bounded in memory. Stop unblocks read; finish drains before encoding. */
private class CommandRecording(val id: String, private val durationMs: Int) {
    private val limit = durationMs * 32
    private val pcm = ByteArrayOutputStream()
    private val done = CountDownLatch(1)
    private var recorder: AudioRecord? = null
    @Volatile private var running = false
    @Volatile private var cancelled = false
    @Volatile private var failed = false
    @Volatile private var finishing = false
    val released: Boolean get() = done.count == 0L && cancelled

    @Suppress("MissingPermission")
    fun start() {
        val minimum = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        check(minimum > 0) { "Audio format unavailable" }
        val size = maxOf(4096, minimum)
        val input = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, 16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, size)
        if (input.state != AudioRecord.STATE_INITIALIZED) { input.release(); error("Audio unavailable") }
        recorder = input
        try { input.startRecording(); check(input.recordingState == AudioRecord.RECORDSTATE_RECORDING) } catch (error: Exception) { input.release(); recorder = null; throw error }
        running = true
        val deadline = SystemClock.elapsedRealtime() + durationMs
        Thread({
            try {
                val buffer = ShortArray(size / 2)
                while (running && pcm.size() < limit && SystemClock.elapsedRealtime() < deadline) {
                    val count = input.read(buffer, 0, minOf(buffer.size, (limit - pcm.size()) / 2), AudioRecord.READ_NON_BLOCKING)
                    if (count > 0) for (index in 0 until count) { val sample = buffer[index].toInt(); pcm.write(sample and 255); pcm.write((sample shr 8) and 255) }
                    else if (count < 0 && running) { failed = true; break }
                    else if (finishing) break
                    else Thread.sleep(5)
                }
            } catch (_: Exception) { failed = true }
            finally {
                running = false
                try { input.stop() } catch (_: Exception) { }
                input.release()
                if (cancelled) pcm.reset()
                done.countDown()
            }
        }, "OneCommandCapture").start()
    }

    private fun stop() {
        finishing = true // Drain available final samples; cancellation alone discards.
        if (!done.await(2, TimeUnit.SECONDS)) error("Audio finalization timed out")
        recorder = null
    }

    fun finish(): JSObject {
        stop()
        if (cancelled || failed || pcm.size() == 0) error("Invalid recording")
        val audio = pcm.toByteArray()
        pcm.reset()
        val wav = ByteBuffer.allocate(44 + audio.size).order(ByteOrder.LITTLE_ENDIAN)
        wav.put("RIFF".toByteArray()).putInt(36 + audio.size).put("WAVEfmt ".toByteArray())
        wav.putInt(16).putShort(1).putShort(1).putInt(16000).putInt(32000).putShort(2).putShort(16)
        wav.put("data".toByteArray()).putInt(audio.size).put(audio)
        return JSObject().apply {
            put("sessionId", id); put("audioBase64", Base64.encodeToString(wav.array(), Base64.NO_WRAP))
            put("mimeType", "audio/wav"); put("sampleRate", 16000); put("channels", 1); put("durationMs", audio.size / 32.0)
        }
    }

    fun cancel() {
        cancelled = true
        running = false // Nonblocking reader owns release. Lifecycle never waits on the UI thread.
        if (done.count == 0L) pcm.reset()
    }
}
