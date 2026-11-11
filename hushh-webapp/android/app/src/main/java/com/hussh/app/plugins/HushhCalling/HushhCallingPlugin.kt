package com.hussh.app.plugins.HushhCalling

import android.os.Build
import android.telecom.DisconnectCause
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.util.UUID

@CapacitorPlugin(name = "HushhCalling")
class HushhCallingPlugin : Plugin() {
    private val scope = MainScope()
    private val admission = Mutex()
    private var client: CallingClient? = null
    private var inbox: Job? = null

    override fun load() {
        scope.launch {
            CallingRuntime.view.collect { view ->
                if (view != null && view.owner == client?.identity?.ownerId && client?.current() == true) {
                    notifyListeners("callState", JSObject(view.value.toString()))
                }
            }
        }
    }

    @PluginMethod
    fun initialize(call: PluginCall) {
        scope.launch {
            val ready = runCatching {
                admission.withLock {
                    check(Build.VERSION.SDK_INT >= 26)
                    val account = CallingClient.admitted(context, allowEnrollment = true,
                        expectedOwner = checkNotNull(call.getString("ownerId")))
                    account.initialize()
                    client = account
                    watchIncoming(account)
                    CallingRuntime.view.value?.takeIf { it.owner == account.identity.ownerId }?.let {
                        notifyListeners("callState", JSObject(it.value.toString()))
                    }
                    account
                }
            }.getOrNull()
            call.resolve(JSObject().put("available", ready != null).apply {
                if (ready != null) put("deviceId", ready.identity.deviceId)
            })
        }
    }

    private fun watchIncoming(account: CallingClient) {
        inbox?.cancel()
        inbox = scope.launch {
            var ticks = 0
            var nextRegistration = 0
            while (account.current()) {
                if (Build.VERSION.SDK_INT >= 26 && activity.hasWindowFocus() &&
                    CallingRuntime.pending == null && CallingRuntime.service == null) {
                    if (ticks >= nextRegistration) {
                        nextRegistration = try {
                            val token = FirebaseMessaging.getInstance().token.resultAwait()
                            account.command("register-fcm", JSONObject().put("tokenHash",
                                CallingWire.sha256(token.toByteArray(Charsets.UTF_8))))
                            ticks + 30
                        } catch (cancelled: CancellationException) { throw cancelled }
                        catch (_: Exception) { ticks + 3 }
                    }
                    try {
                        val remote = account.command("inbox").getJSONArray("items").optJSONObject(0)
                        if (remote?.optString("state") == "ringing" && !remote.optBoolean("isCaller") &&
                            CallingRuntime.pending == null && CallingRuntime.service == null && account.current() &&
                            activity.hasWindowFocus()) {
                            val id = checkNotNull(CallingRuntime.callId(remote.optString("id")))
                            CallingRuntime.reserve(context, CallingRuntime.Pending(account, id, null, remote))
                        }
                    } catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) { /* The next foreground sweep rechecks authenticated state. */ }
                    ticks++
                }
                delay(2_000)
            }
        }
    }

    @PluginMethod
    fun start(call: PluginCall) = perform(call) {
        val owner = checkNotNull(client?.takeIf { it.current() })
        check(activity.hasWindowFocus() && CallingRuntime.microphoneGranted(context))
        val sms = call.getObject("sms")
        val id = if (sms == null) UUID.randomUUID().toString()
            else checkNotNull(CallingRuntime.callId(sms.optString("callId")))
        val payload = JSONObject().put("callId", id)
        if (sms != null) payload.put("smsIncidentId", checkNotNull(CallingRuntime.callId(sms.optString("incidentId"))))
        else call.getString("conversationId")?.let { payload.put("conversationId", it) }
            ?: payload.put("recipientPersonRef", checkNotNull(call.getString("personRef")))
        val queued = CompletableDeferred<Unit>()
        CallingRuntime.reserve(context, CallingRuntime.Pending(owner, id, payload, null, WeakReference(activity), queued))
        try { withTimeout(35_000) { queued.await() } }
        catch (error: Exception) {
            CallingRuntime.service?.let { service ->
                runCatching { service.owned(owner.identity.ownerId, id).finish(DisconnectCause.ERROR) }
            }
            throw error
        }
    }

    @PluginMethod
    fun answer(call: PluginCall) = perform(call) {
        check(activity.hasWindowFocus())
        val (service, id) = owned(call)
        service.answer(id)
    }

    @PluginMethod
    fun end(call: PluginCall) = perform(call) {
        val (service, id) = owned(call)
        service.owned(checkNotNull(client).identity.ownerId, id)
            .finish(if (call.getBoolean("decline") == true) DisconnectCause.REJECTED else DisconnectCause.LOCAL)
    }

    @PluginMethod
    fun mute(call: PluginCall) = perform(call) {
        val (service, id) = owned(call)
        service.owned(checkNotNull(client).identity.ownerId, id).toggleMute()
    }

    @PluginMethod
    fun verify(call: PluginCall) = perform(call) {
        check(activity.hasWindowFocus())
        val (service, id) = owned(call)
        service.owned(checkNotNull(client).identity.ownerId, id)
            .confirm(checkNotNull(call.getString("fingerprint")), call.getBoolean("accepted") == true)
    }

    private fun owned(call: PluginCall): Pair<CallingService, String> {
        val account = checkNotNull(client?.takeIf { it.current() })
        val id = checkNotNull(CallingRuntime.callId(call.getString("callId")))
        val service = checkNotNull(CallingRuntime.service)
        service.owned(account.identity.ownerId, id)
        return service to id
    }

    private fun perform(call: PluginCall, body: suspend () -> Unit) {
        scope.launch {
            try { check(Build.VERSION.SDK_INT >= 26); body(); call.resolve() }
            catch (_: SmsCallSettled) { call.resolve() }
            catch (_: Exception) { call.reject("Calling is unavailable on this device.") }
        }
    }

    override fun handleOnDestroy() { scope.cancel(); super.handleOnDestroy() }
}
