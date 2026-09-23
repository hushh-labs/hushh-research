package com.hussh.app.plugins.HushhPlaidLink

import android.os.Build
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.plaid.link.OpenPlaidLink
import com.plaid.link.Plaid
import com.plaid.link.configuration.LinkTokenConfiguration
import com.plaid.link.event.LinkEvent
import com.plaid.link.result.LinkExit
import com.plaid.link.result.LinkSuccess

/**
 * Plaid Link through Plaid's own Android SDK. The web Link SDK inside the
 * WebView cannot finish an OAuth bank: its OAuth leg leaves the app for the
 * external browser and the redirect chain ends on the https frontend origin,
 * not in the app, and App Links cannot catch a redirect chain. The native SDK
 * owns that leg and the return into the app. The link token must be minted
 * with `android_package_name` (and no `redirect_uri`) for this to work.
 *
 * Same contract as the iOS plugin: `open({ token })` resolves once with
 * `{ publicToken, metadata }` on success, or `{ exit: true, error?, metadata }`
 * when the person leaves Link; events stream as `plaidLinkEvent`. The public
 * token goes straight back to the page, which exchanges it with the backend
 * as it does on the web. Nothing is stored here and no token is logged.
 *
 * The launch goes through Capacitor's `startActivityForResult` with an
 * `@ActivityCallback`, which registers the activity-result launcher when the
 * bridge starts, so a result is still delivered if the activity is recreated
 * during the bank's OAuth leg (Plaid's documented requirement).
 */
@CapacitorPlugin(name = "HushhPlaidLink")
class HushhPlaidLinkPlugin : Plugin() {
    private val contract = OpenPlaidLink()

    @Volatile
    private var linkOpen = false

    override fun load() {
        // Plaid keeps a single process-wide listener; forward every event to
        // the page. The page detaches its own listener once Link settles.
        Plaid.setLinkEventListener { event -> forwardEvent(event) }
    }

    override fun handleOnDestroy() {
        Plaid.clearLinkEventListener()
    }

    @PluginMethod
    fun isAvailable(call: PluginCall) {
        call.resolve(JSObject().put("available", isSupportedDevice()))
    }

    @PluginMethod
    fun open(call: PluginCall) {
        val token = call.getString("token")?.trim().orEmpty()
        if (token.isEmpty()) {
            call.reject("A Plaid link token is required.", "MISSING_TOKEN")
            return
        }
        if (!isSupportedDevice()) {
            call.reject("Plaid Link needs Android 8.0 or later.", "UNSUPPORTED")
            return
        }
        if (linkOpen) {
            call.reject("Plaid Link is already open.", "ALREADY_OPEN")
            return
        }
        linkOpen = true

        bridge.executeOnMainThread {
            try {
                val configuration = LinkTokenConfiguration.Builder().token(token).build()
                val session = Plaid.createPlaidLinkSession(activity, configuration)
                val intent = contract.createIntent(activity, session)
                startActivityForResult(call, intent, "handleLinkResult")
            } catch (error: Exception) {
                linkOpen = false
                call.reject(error.message ?: "Plaid Link could not be created.", "CREATE_FAILED")
            }
        }
    }

    @ActivityCallback
    private fun handleLinkResult(call: PluginCall?, result: ActivityResult) {
        linkOpen = false
        // After process death the page that asked is gone; there is no one to
        // resolve, and the page restarts the connection flow itself.
        if (call == null) return

        when (val linkResult = contract.parseResult(result.resultCode, result.data)) {
            is LinkSuccess -> {
                call.resolve(
                    JSObject()
                        .put("publicToken", linkResult.publicToken)
                        .put("metadata", jsonObject(linkResult.metadata.metadataJson)),
                )
            }
            is LinkExit -> {
                val payload = JSObject()
                    .put("exit", true)
                    .put("metadata", jsonObject(linkResult.metadata.metadataJson))
                linkResult.error?.let { error ->
                    payload.put(
                        "error",
                        JSObject()
                            .put("code", error.errorCode.json)
                            .put("message", error.errorMessage)
                            .put("displayMessage", error.displayMessage ?: ""),
                    )
                }
                call.resolve(payload)
            }
        }
        bridge.releaseCall(call)
    }

    private fun forwardEvent(event: LinkEvent) {
        notifyListeners(
            "plaidLinkEvent",
            JSObject()
                .put("eventName", event.eventName.json)
                .put("metadata", jsonObject(event.metadata.metadataJson)),
        )
    }

    private fun isSupportedDevice(): Boolean = Build.VERSION.SDK_INT >= MIN_SUPPORTED_SDK

    /** The SDK hands metadata as a JSON string; the page wants the object. */
    private fun jsonObject(raw: String?): JSObject {
        if (raw.isNullOrBlank()) return JSObject()
        return try {
            JSObject(raw)
        } catch (_: Exception) {
            JSObject()
        }
    }

    private companion object {
        /**
         * Plaid documents Android 8.0 (API 26) as the SDK minimum while the app
         * still installs on API 24; below this the page falls back to web Link.
         */
        const val MIN_SUPPORTED_SDK = Build.VERSION_CODES.O
    }
}
