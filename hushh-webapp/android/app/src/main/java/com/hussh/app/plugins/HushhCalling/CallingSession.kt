package com.hussh.app.plugins.HushhCalling

import android.content.Context
import android.os.Build
import android.telecom.DisconnectCause
import androidx.annotation.RequiresApi
import com.hussh.app.AndroidMicrophoneOwnership
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject

@RequiresApi(Build.VERSION_CODES.O)
internal class CallingSession(
    private val context: Context,
    private val scope: CoroutineScope,
    private val client: CallingClient,
    val id: String,
    private val label: String,
    private val canRecord: () -> Boolean,
    private val canStart: () -> Boolean,
    private val publish: (JSONObject) -> Unit,
    private val notification: (Boolean) -> Unit,
    private val closed: () -> Unit,
) : TelecomCall.Voice {
    private data class IncomingOffer(
        val snapshot: JSONObject,
        val roster: List<JSONObject>,
        val sender: JSONObject,
        val description: JSONObject,
    )

    val ownerId: String get() = client.identity.ownerId
    private var call: JSONObject? = null
    private var incomingOffer: IncomingOffer? = null
    private var ended = false
    private var accepting = false
    private var accepted = false
    private var appliedAnswer = false
    private var muted = false
    private var systemMute = false
    private var mediaConnected = false
    private var verification: Pair<String, CompletableDeferred<Boolean>>? = null
    private var telecom: TelecomCall? = null
    private val media = CallingMedia(context, scope, { canRecord() && client.current() },
        { scope.launch { reportConnected() } }, { scope.launch { finish(DisconnectCause.ERROR) } })

    private fun callPayload() = JSONObject().put("callId", id)
    private suspend fun read() = client.command("read", callPayload().put("after", 0))

    private fun current() { check(!ended && client.current()) }
    fun isCurrent() = !ended && client.current()

    suspend fun start(outgoing: JSONObject?, incoming: JSONObject?) {
        current()
        if (incoming != null) {
            val latest = read()
            require(latest.getString("state") == "ringing" && !latest.getBoolean("isCaller") &&
                latest.isNull("calleeDeviceId") && latest.getLong("expiresAt") > System.currentTimeMillis() / 1000)
            incomingOffer = openIncomingOffer(latest)
            current()
            call = latest
            addTelecom(incoming = true)
        } else {
            check(canRecord() && canStart())
            check(AndroidMicrophoneOwnership.claim(this))
            val prepared = client.command("create", checkNotNull(outgoing))
            if (ended || !client.current()) {
                runCatching { client.command("action", callPayload().put("action", "end").put("revision", prepared.getInt("revision"))) }
                current()
            }
            call = prepared
            addTelecom(incoming = false)
            val roster = client.directory(prepared.getString("conversationId"))
            val relay = client.command("credentials", callPayload())
            current()
            check(canRecord() && canStart())
            media.open(relay)
            val offer = media.description("offer")
            val offers = JSONArray()
            for (peer in roster.filter { it.getString("userId") != ownerId }) {
                val info = CallingWire.signalContext(prepared, client.identity.deviceId, peer.getString("deviceId"), "offer", 0)
                offers.put(CallingWire.seal(peer, info, offer))
            }
            current()
            check(canRecord() && canStart())
            val ringing = client.command("offer", callPayload().put("offers", offers))
            current()
            call = ringing
        }
        publishState()
        scope.launch { monitor() }
    }

    private suspend fun addTelecom(incoming: Boolean) {
        val adapter = TelecomCall(context, scope, this, label, notification)
        telecom = adapter
        scope.launch {
            try { adapter.add(id, incoming) }
            catch (_: Exception) { if (!ended) finish(DisconnectCause.ERROR) }
        }
        adapter.registered()
    }

    override suspend fun accept() {
        current()
        if (accepted) return
        check(!accepting && canRecord())
        check(AndroidMicrophoneOwnership.claim(this))
        accepting = true
        try {
            val offer = checkNotNull(incomingOffer)
            val incoming = read()
            require(incoming.getString("state") == "ringing" && !incoming.getBoolean("isCaller") &&
                incoming.getInt("revision") == offer.snapshot.getInt("revision"))
            val next = action(incoming, "accept")
            current()
            accepted = true
            call = next
            publishState()
            scope.launch {
                try { sendAnswer(offer) }
                catch (_: CancellationException) { if (!ended) finish(DisconnectCause.ERROR) }
                catch (_: Exception) { finish(DisconnectCause.ERROR) }
            }
        } finally {
            accepting = false
            if (!accepted) AndroidMicrophoneOwnership.release(this)
        }
    }

    suspend fun answerFromApp() { checkNotNull(telecom).answer() }

    private suspend fun openIncomingOffer(incoming: JSONObject): IncomingOffer {
        val roster = client.directory(incoming.getString("conversationId"))
        val sender = roster.single { it.getString("deviceId") == incoming.getString("callerDeviceId") &&
            it.getString("userId") != ownerId }
        val signed = incoming.getJSONObject("offerProof")
        val payload = signed.getJSONObject("payload")
        val offer = incoming.getJSONArray("offers").getJSONObject(0)
        val offers = payload.getJSONArray("offers")
        require(payload.getString("callId") == id && (0 until offers.length()).any { same(offers.getJSONObject(it), offer) })
        CallingWire.verify(sender, "offer", signed)
        val info = CallingWire.signalContext(incoming, sender.getString("deviceId"), client.identity.deviceId, "offer", 0)
        val description = client.identity.open(offer, info)
        CallingWire.validateDescription(description, "offer")
        return IncomingOffer(incoming, roster, sender, description)
    }

    private suspend fun sendAnswer(offer: IncomingOffer) {
        verifyPair(offer.roster, offer.sender)
        val relay = client.command("credentials", callPayload())
        current()
        media.open(relay)
        media.verified()
        media.remote(offer.description, "offer")
        val answer = media.description("answer")
        val answerInfo = CallingWire.signalContext(offer.snapshot, client.identity.deviceId, offer.sender.getString("deviceId"), "answer", 1)
        current()
        client.command("signal", callPayload().put("sequence", 1).put("envelope", CallingWire.seal(offer.sender, answerInfo, answer)))
    }

    private suspend fun applyAnswer(remote: JSONObject, signal: JSONObject) {
        val roster = client.directory(remote.getString("conversationId"))
        val peer = roster.single { it.getString("deviceId") == remote.getString("calleeDeviceId") && it.getString("userId") != ownerId }
        val envelope = signal.getJSONObject("envelope")
        val signed = signal.getJSONObject("proof")
        val payload = signed.getJSONObject("payload")
        require(signal.getString("senderDeviceId") == peer.getString("deviceId") &&
            payload.getString("callId") == id && payload.getInt("sequence") == 1 &&
            same(payload.getJSONObject("envelope"), envelope))
        CallingWire.verify(peer, "signal", signed)
        val info = CallingWire.signalContext(remote, peer.getString("deviceId"), client.identity.deviceId, "answer", 1)
        val description = client.identity.open(envelope, info)
        checkNotNull(telecom).activate()
        verifyPair(roster, peer)
        current()
        media.remote(description, "answer")
        media.verified()
        appliedAnswer = true
    }

    private suspend fun verifyPair(roster: List<JSONObject>, peer: JSONObject) {
        val local = roster.single { it.getString("deviceId") == client.identity.deviceId }
        val code = CallingWire.fingerprint(local, peer)
        if (client.identity.isVerified(code)) return
        val result = CompletableDeferred<Boolean>()
        verification = code to result
        publishState()
        try {
            check(withTimeout(30_000) { result.await() })
            current()
            client.identity.verify(code)
        } finally {
            verification = null
            publishState()
        }
    }

    fun confirm(fingerprint: String, accepted: Boolean) {
        current()
        val waiting = checkNotNull(verification)
        require(waiting.first == fingerprint)
        waiting.second.complete(accepted)
    }

    private suspend fun monitor() {
        var ticks = 0
        try {
            while (!ended) {
                delay(2000)
                current()
                val remote = read()
                current()
                if (remote.getString("state") in TERMINAL || remote.getLong("expiresAt") <= System.currentTimeMillis() / 1000) {
                    finish(DisconnectCause.REMOTE, notifyServer = false)
                    return
                }
                if (remote.getInt("revision") >= (call?.optInt("revision") ?: 0)) call = remote
                val signal = remote.optJSONArray("signals")?.optJSONObject(0)
                if (remote.getBoolean("isCaller") && !appliedAnswer && !remote.isNull("calleeDeviceId") && signal != null) {
                    applyAnswer(remote, signal)
                }
                if (++ticks % 5 == 0 && (remote.getBoolean("isCaller") || accepted)) client.command("heartbeat", callPayload())
                publishState()
            }
        } catch (_: CancellationException) {
            if (!ended) finish(DisconnectCause.ERROR)
        } catch (_: SmsCallSettled) {
            finish(DisconnectCause.CANCELED, notifyServer = false)
        } catch (_: Exception) {
            finish(DisconnectCause.ERROR)
        }
    }

    private suspend fun reportConnected() {
        if (ended || mediaConnected) return
        try {
            val latest = read()
            current()
            val next = runCatching { action(latest, "connected") }.getOrElse {
                current()
                action(read(), "connected")
            }
            current()
            call = next
            mediaConnected = true
            publishState()
        } catch (_: Exception) { finish(DisconnectCause.ERROR) }
    }

    private suspend fun action(snapshot: JSONObject, action: String) = client.command("action",
        callPayload().put("action", action).put("revision", snapshot.getInt("revision")))

    private fun same(a: JSONObject, b: JSONObject) = CallingWire.bytes(a).contentEquals(CallingWire.bytes(b))
    override fun active(active: Boolean) { media.active(active) }
    override fun systemMuted(muted: Boolean) { systemMute = muted; updateMute() }
    fun toggleMute() { muted = !muted; updateMute() }
    private fun updateMute() { media.mute(muted || systemMute); publishState() }

    override fun end(cause: DisconnectCause) { close(cause.code, notifyServer = true) }
    override fun telecomClosed() {
        close(DisconnectCause.ERROR, notifyServer = true)
        closed()
    }

    suspend fun finish(cause: Int, notifyServer: Boolean = true) {
        if (ended) return
        close(cause, notifyServer)
        try { withTimeout(4_000) { telecom?.disconnect(DisconnectCause(cause)) } }
        catch (_: Exception) { /* Local media and microphone ownership are already closed. */ }
        finally { closed() }
    }

    private fun close(cause: Int, notifyServer: Boolean) {
        if (ended) return
        ended = true
        val last = call
        call = null
        incomingOffer = null
        verification?.second?.cancel()
        verification = null
        media.close()
        AndroidMicrophoneOwnership.release(this)
        publishState()
        if (notifyServer && last != null) CallingRuntime.cleanup.launch {
            val verb = if (cause == DisconnectCause.REJECTED && !last.getBoolean("isCaller") &&
                last.getString("state") == "ringing") "decline" else "end"
            runCatching { action(last, verb) }
        }
    }

    private fun publishState() {
        publish(JSONObject().put("call", call?.let {
            JSONObject(it.toString()).apply { remove("offers"); remove("offerProof"); remove("signals") }
        } ?: JSONObject.NULL).put("muted", muted || systemMute).put("mediaConnected", !ended && mediaConnected)
            .put("verification", verification?.first ?: JSONObject.NULL).put("error", JSONObject.NULL))
    }

    companion object {
        private val TERMINAL = setOf("declined", "cancelled", "ended", "expired")
    }
}
