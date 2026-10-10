package com.hussh.app.plugins.HushhNotifications

import android.content.Context

internal object ChatDeliveryState {
    val lock = Any()
    private fun preferences(context: Context) = context.getSharedPreferences("chat_delivery", Context.MODE_PRIVATE)
    private fun key(keyId: String, tag: String) = "$keyId:$tag"
    fun read(context: Context, keyId: String, tag: String, boundary: Double, message: String?) {
        if (!boundary.isFinite() || boundary < 0) return
        val prefs = preferences(context); val key = key(keyId, tag) + ":read"
        val old = prefs.getString(key, "0")?.toDoubleOrNull() ?: 0.0
        prefs.edit().putString(key, maxOf(old, boundary).toString()).apply()
        if (message != null) ChatPreviewKeys.remember(context, message)
    }
    fun alert(context: Context, keyId: String, tag: String, boundary: Double, message: String): Boolean {
        if (!boundary.isFinite() || boundary <= 0) return false
        val prefs = preferences(context); val key = key(keyId, tag)
        val read = prefs.getString("$key:read", "0")?.toDoubleOrNull() ?: 0.0
        val delivered = prefs.getString("$key:delivered", "0")?.toDoubleOrNull() ?: 0.0
        val previous = prefs.getString("$key:seen", "").orEmpty().split("|").filter { it.isNotEmpty() }.toSet()
        if (!ChatDeliveryPolicy.shouldAlert(boundary, read, delivered, message, previous)) return false
        prefs.edit().putString("$key:delivered", boundary.toString()).putString("$key:seen", ((if (boundary > delivered) emptySet() else previous) + message).joinToString("|")).apply()
        return true
    }
}
