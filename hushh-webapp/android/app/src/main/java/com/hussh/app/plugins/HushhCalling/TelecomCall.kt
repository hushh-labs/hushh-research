package com.hussh.app.plugins.HushhCalling

import android.content.Context
import android.net.Uri
import android.telecom.DisconnectCause
import androidx.annotation.RequiresApi
import androidx.core.telecom.CallAttributesCompat
import androidx.core.telecom.CallControlResult
import androidx.core.telecom.CallControlScope
import androidx.core.telecom.CallsManager
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

@RequiresApi(26)
internal class TelecomCall(
    context: Context,
    private val scope: CoroutineScope,
    private val voice: Voice,
    private val label: String,
    private val notification: (Boolean) -> Unit,
) {
    interface Voice {
        suspend fun accept()
        fun active(active: Boolean)
        fun systemMuted(muted: Boolean)
        fun end(cause: DisconnectCause)
        fun telecomClosed()
    }

    private val calls = CallsManager(context.applicationContext)
    private val ready = CompletableDeferred<CallControlScope>()

    suspend fun add(id: String, incoming: Boolean) = withContext(Dispatchers.Main.immediate) {
        var observer: Job? = null
        try {
            calls.registerAppWithTelecom(CallsManager.CAPABILITY_BASELINE)
            val attributes = CallAttributesCompat(
                label, Uri.fromParts("hussh-call", id, null),
                if (incoming) CallAttributesCompat.DIRECTION_INCOMING else CallAttributesCompat.DIRECTION_OUTGOING,
                CallAttributesCompat.CALL_TYPE_AUDIO_CALL, 0,
            )
            calls.addCall(attributes,
                onAnswer = { type -> withTimeout(4_000) { withContext(Dispatchers.Main.immediate) {
                    check(incoming && type == CallAttributesCompat.CALL_TYPE_AUDIO_CALL)
                    voice.accept()
                    voice.active(true)
                    notification(false)
                } } },
                onDisconnect = { cause -> withContext(Dispatchers.Main.immediate) { voice.end(cause) } },
                onSetActive = { withContext(Dispatchers.Main.immediate) { voice.active(true) } },
                onSetInactive = { withContext(Dispatchers.Main.immediate) { voice.active(false) } },
            ) {
                notification(incoming)
                ready.complete(this)
                observer = scope.launch { isMuted.collect { voice.systemMuted(it) } }
            }
        } finally {
            ready.cancel()
            observer?.cancel()
            voice.telecomClosed()
        }
    }

    suspend fun registered() { withTimeout(5_000) { ready.await() } }

    suspend fun answer() {
        val control = withTimeout(4_000) { ready.await() }
        withTimeout(4_000) { voice.accept() }
        check(control.answer(CallAttributesCompat.CALL_TYPE_AUDIO_CALL) is CallControlResult.Success)
        voice.active(true)
        notification(false)
    }

    suspend fun activate() {
        check(withTimeout(4_000) { ready.await() }.setActive() is CallControlResult.Success)
        voice.active(true)
    }

    suspend fun disconnect(cause: DisconnectCause) {
        voice.end(cause)
        if (ready.isCompleted && !ready.isCancelled) ready.await().disconnect(cause)
    }
}
