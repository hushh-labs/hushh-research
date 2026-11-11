package com.hussh.app.plugins.HushhCalling

import android.content.Context
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import java.util.UUID

/** Owned by one call on the main dispatcher. ICE never opens the audio gate. */
internal class CallingMedia(
    private val context: Context,
    private val scope: CoroutineScope,
    private val canRecord: () -> Boolean,
    private val onConnected: () -> Unit,
    private val onFailed: () -> Unit,
) {
    private var factory: PeerConnectionFactory? = null
    private var peer: PeerConnection? = null
    private var source: AudioSource? = null
    private var track: AudioTrack? = null
    private var gather: CompletableDeferred<Unit>? = null
    private var disconnect: Job? = null
    private var generation = 0
    private var connected = false
    private var verified = false
    private var active = false
    private var muted = false

    fun open(relay: JSONObject) {
        check(peer == null && relay.getString("iceTransportPolicy") == "relay")
        val servers = relay.getJSONArray("iceServers")
        require(servers.length() in 1..4)
        val ice = (0 until servers.length()).map { index ->
            val entry = servers.getJSONObject(index)
            val urls = entry.getJSONArray("urls")
            val values = (0 until urls.length()).map { urls.getString(it) }
            require(values.isNotEmpty() && values.all { it.startsWith("turn:") || it.startsWith("turns:") })
            PeerConnection.IceServer.builder(values).setUsername(entry.getString("username"))
                .setPassword(entry.getString("credential")).createIceServer()
        }
        initializeFactory(context)
        val owner = PeerConnectionFactory.builder().createPeerConnectionFactory()
        factory = owner
        val epoch = ++generation
        val config = PeerConnection.RTCConfiguration(ice).apply {
            iceTransportsType = PeerConnection.IceTransportsType.RELAY
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }
        val connection = checkNotNull(owner.createPeerConnection(config, observer(epoch)))
        peer = connection
        connection.setAudioRecording(false)
        connection.setAudioPlayout(false)
        source = owner.createAudioSource(MediaConstraints())
        track = owner.createAudioTrack(UUID.randomUUID().toString(), checkNotNull(source)).also {
            it.setEnabled(false)
            check(connection.addTrack(it, listOf(UUID.randomUUID().toString())) != null)
        }
    }

    suspend fun description(kind: String): JSONObject {
        val connection = checkNotNull(peer)
        require(kind == "offer" || kind == "answer")
        val pending = CompletableDeferred<SessionDescription>()
        val observer = SdpResult(created = pending)
        if (kind == "offer") connection.createOffer(observer, MediaConstraints())
        else connection.createAnswer(observer, MediaConstraints())
        val description = withTimeout(10_000) { pending.await() }
        check(peer === connection)
        val gathering = CompletableDeferred<Unit>()
        gather = gathering
        try {
            val set = CompletableDeferred<Unit>()
            connection.setLocalDescription(SdpResult(set = set), description)
            withTimeout(10_000) { set.await() }
            if (connection.iceGatheringState() != PeerConnection.IceGatheringState.COMPLETE) {
                withTimeoutOrNull(10_000) { gathering.await() }
            }
            check(peer === connection)
            return JSONObject().put("type", kind).put("sdp", checkNotNull(connection.localDescription).description)
                .also { CallingWire.validateDescription(it, kind) }
        } finally {
            if (gather === gathering) gather = null
        }
    }

    suspend fun remote(description: JSONObject, kind: String) {
        val connection = checkNotNull(peer)
        val type = if (kind == "offer") SessionDescription.Type.OFFER else SessionDescription.Type.ANSWER
        val set = CompletableDeferred<Unit>()
        connection.setRemoteDescription(SdpResult(set = set), SessionDescription(type, CallingWire.validateDescription(description, kind)))
        withTimeout(10_000) { set.await() }
        check(peer === connection)
    }

    fun verified() { verified = true; updateAudio() }
    fun active(value: Boolean) { active = value; updateAudio() }
    fun mute(value: Boolean) { muted = value; updateAudio() }

    private fun updateAudio() {
        val ready = connected && active && verified
        val microphone = ready && !muted && canRecord()
        track?.setEnabled(microphone)
        peer?.setAudioRecording(microphone)
        peer?.setAudioPlayout(ready)
    }

    fun close() {
        generation++
        disconnect?.cancel()
        gather?.cancel()
        gather = null
        active = false
        verified = false
        connected = false
        updateAudio()
        peer?.dispose()
        peer = null
        track?.dispose()
        track = null
        source?.dispose()
        source = null
        factory?.dispose()
        factory = null
    }

    private fun observer(epoch: Int) = object : PeerConnection.Observer {
        override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
            scope.launch {
                if (generation != epoch) return@launch
                val wasConnected = connected
                connected = state == PeerConnection.PeerConnectionState.CONNECTED
                updateAudio()
                disconnect?.cancel()
                when (state) {
                    PeerConnection.PeerConnectionState.CONNECTED -> if (!wasConnected) onConnected()
                    PeerConnection.PeerConnectionState.DISCONNECTED -> disconnect = scope.launch {
                        delay(10_000)
                        if (generation == epoch && !connected) onFailed()
                    }
                    PeerConnection.PeerConnectionState.FAILED, PeerConnection.PeerConnectionState.CLOSED -> onFailed()
                    else -> Unit
                }
            }
        }
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {
            if (state == PeerConnection.IceGatheringState.COMPLETE) scope.launch {
                if (generation == epoch) gather?.complete(Unit)
            }
        }
        override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) = Unit
        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
        override fun onIceCandidate(candidate: IceCandidate) = Unit
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit
        override fun onAddStream(stream: MediaStream) = Unit
        override fun onRemoveStream(stream: MediaStream) = Unit
        override fun onDataChannel(channel: DataChannel) = Unit
        override fun onRenegotiationNeeded() = Unit
    }

    private class SdpResult(
        private val created: CompletableDeferred<SessionDescription>? = null,
        private val set: CompletableDeferred<Unit>? = null,
    ) : SdpObserver {
        override fun onCreateSuccess(description: SessionDescription) { created?.complete(description) }
        override fun onSetSuccess() { set?.complete(Unit) }
        override fun onCreateFailure(error: String) { created?.completeExceptionally(IllegalStateException("Could not create call description")) }
        override fun onSetFailure(error: String) { set?.completeExceptionally(IllegalStateException("Could not set call description")) }
    }

    companion object {
        private var initialized = false
        @Synchronized
        private fun initializeFactory(context: Context) {
            if (!initialized) {
                PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context.applicationContext).createInitializationOptions())
                initialized = true
            }
        }
    }
}
