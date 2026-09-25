package com.hussh.app.plugins.HushhOAuthReturn

import android.content.Intent
import android.net.Uri
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.firebase.auth.FirebaseAuth

/**
 * Android counterpart of the iOS plugin: a provider OAuth flow that ends by
 * navigating the WebView to the app's https return route must come back into
 * the running app instead of leaving for the browser. Capacitor asks plugins
 * before it decides; this one answers for the app's own hosts and the
 * `/oauth/return` paths only, and delivers the URL as an `appUrlOpen`.
 */
@CapacitorPlugin(name = "HushhOAuthReturn")
class HushhOAuthReturnPlugin : Plugin() {
    private val hosts = setOf("one.hushh.ai", "uat.one.hushh.ai", "dev.one.hushh.ai")
    private val customReturnPath = "/one/profile/connectors/oauth/return"

    @PluginMethod
    fun openAuthorization(call: PluginCall) {
        val rawUrl = call.getString("authorizeUrl")
        val rawReturn = call.getString("redirectUri")
        val attemptId = call.getString("attemptId")
        val expectedUserId = call.getString("expectedUserId")
        val authorize = rawUrl?.let(Uri::parse)
        val callback = rawReturn?.let(Uri::parse)
        if (rawUrl == null || rawUrl.length > 16000 || authorize?.scheme != "https" ||
            authorize.host.isNullOrBlank() || authorize.userInfo != null || authorize.fragment != null ||
            rawReturn == null || rawReturn.length > 2048 || callback?.scheme != "https" ||
            callback.host?.lowercase() !in hosts || callback.path != customReturnPath ||
            callback.userInfo != null || callback.port != -1 || callback.query != null || callback.fragment != null ||
            attemptId?.matches(Regex("[A-Za-z0-9_-]{43}")) != true ||
            expectedUserId.isNullOrBlank() || FirebaseAuth.getInstance().currentUser?.uid != expectedUserId
        ) {
            call.reject("Connector sign-in is unavailable in this session.", "connector_oauth_unavailable")
            return
        }
        try {
            activity.startActivity(Intent(Intent.ACTION_VIEW, authorize).addCategory(Intent.CATEGORY_BROWSABLE))
            call.resolve()
        } catch (_: Exception) {
            call.reject("Could not open connector sign-in.", "connector_oauth_open_failed")
        }
    }

    override fun shouldOverrideLoad(url: Uri?): Boolean? {
        val target = url ?: return null
        if (target.scheme?.lowercase() != "https") return null
        if (target.host?.lowercase() !in hosts) return null
        if (target.path?.endsWith("/oauth/return") != true) return null
        val intent = Intent(Intent.ACTION_VIEW, target)
        bridge.onNewIntent(intent)
        return true
    }
}
