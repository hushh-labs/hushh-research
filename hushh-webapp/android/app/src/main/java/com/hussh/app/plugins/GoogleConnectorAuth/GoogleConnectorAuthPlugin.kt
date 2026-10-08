package com.hussh.app.plugins.GoogleConnectorAuth

import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.browser.auth.AuthTabIntent
import androidx.activity.result.ActivityResultLauncher
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.JSObject
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.firebase.auth.FirebaseAuth

/** Installed-client PKCE is an explicit debug opt-in, never a release fallback. */
@CapacitorPlugin(name = "GoogleConnectorAuth")
class GoogleConnectorAuthPlugin : Plugin() {
    private var pending: PluginCall? = null
    private var providerInFlight = false
    private var owner = ""
    private var state = ""
    private val redirect = "com.hussh.app:/oauth2redirect"
    private val handler = Handler(Looper.getMainLooper())
    private val deadline = Runnable { finish(null, "SIGN_IN_CANCELLED") }
    private lateinit var launcher: ActivityResultLauncher<Intent>

    override fun load() {
        launcher = AuthTabIntent.registerActivityResultLauncher(activity) { result ->
            providerInFlight = false
            val receivedCall = pending
            if (result.resultCode == AuthTabIntent.RESULT_OK) consume(result.resultUri)
            else handler.postDelayed({ if (receivedCall != null && pending === receivedCall) finish(null, "SIGN_IN_CANCELLED") }, 500)
        }
    }

    @PluginMethod
    fun open(call: PluginCall) {
        val debugBuild = (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        if (!debugBuild || call.getBoolean("devEnabled", false) != true) {
            call.reject("Android connector sign-in requires a development build.", "ANDROID_CONNECTOR_DEV_REQUIRED"); return
        }
        if (pending != null || providerInFlight) { call.reject("Sign-in is already open.", "SIGN_IN_BUSY"); return }
        val expectedOwner = call.getString("expectedUserId").orEmpty()
        val raw = call.getString("authorizationUrl").orEmpty()
        val uri = Uri.parse(raw)
        val client = uri.getQueryParameter("client_id").orEmpty()
        val expectedState = uri.getQueryParameter("state").orEmpty()
        if (expectedOwner.isBlank() || FirebaseAuth.getInstance().currentUser?.uid != expectedOwner ||
            raw.length > 16000 || uri.scheme != "https" || uri.host != "accounts.google.com" ||
            uri.path != "/o/oauth2/v2/auth" || uri.port != -1 || uri.userInfo != null || uri.fragment != null ||
            call.getString("redirectUri") != redirect || uri.getQueryParameter("redirect_uri") != redirect ||
            !client.matches(Regex("[0-9]{4,32}-[a-z0-9]{8,64}\\.apps\\.googleusercontent\\.com")) ||
            uri.getQueryParameter("response_type") != "code" || uri.getQueryParameter("code_challenge_method") != "S256" ||
            uri.getQueryParameter("code_challenge")?.matches(Regex("[A-Za-z0-9_-]{43}")) != true ||
            !expectedState.matches(Regex("[A-Za-z0-9_-]{22,128}")) ||
            uri.queryParameterNames.any { uri.getQueryParameters(it).size != 1 } ||
            uri.getQueryParameter("client_secret") != null) {
            call.reject("Sign-in could not be opened.", "SIGN_IN_INCOMPLETE"); return
        }
        providerInFlight = true
        pending = call; owner = expectedOwner; state = expectedState
        handler.postDelayed(deadline, 300000)
        activity.runOnUiThread {
            try { AuthTabIntent.Builder().build().launch(launcher, uri, "com.hussh.app") }
            catch (_: Exception) { providerInFlight = false; finish(null, "SIGN_IN_INCOMPLETE") }
        }
    }

    override fun handleOnNewIntent(intent: Intent) {
        super.handleOnNewIntent(intent)
        val uri = intent.data ?: return
        if (uri.scheme == "com.hussh.app" && uri.path == "/oauth2redirect") consume(uri)
    }

    private fun consume(uri: Uri?) {
        if (pending == null) return
        if (FirebaseAuth.getInstance().currentUser?.uid != owner) { finish(null, "POD_OWNER_CHANGED"); return }
        if (uri == null || uri.buildUpon().clearQuery().build().toString() != redirect || uri.fragment != null ||
            uri.getQueryParameters("state") != listOf(state)) { finish(null, "SIGN_IN_INCOMPLETE"); return }
        finish(uri.toString(), null)
    }

    private fun finish(value: String?, code: String?) {
        val call = pending ?: return
        pending = null; owner = ""; state = ""; handler.removeCallbacks(deadline)
        if (value != null) call.resolve(JSObject().put("redirectUrl", value))
        else call.reject("Google sign-in did not finish.", code ?: "SIGN_IN_INCOMPLETE")
    }

    override fun handleOnDestroy() { finish(null, "SIGN_IN_CANCELLED"); super.handleOnDestroy() }
}
