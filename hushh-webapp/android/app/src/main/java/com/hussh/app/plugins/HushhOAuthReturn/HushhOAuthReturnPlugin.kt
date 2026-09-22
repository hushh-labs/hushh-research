package com.hussh.app.plugins.HushhOAuthReturn

import android.content.Intent
import android.net.Uri
import com.getcapacitor.Plugin
import com.getcapacitor.annotation.CapacitorPlugin

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
