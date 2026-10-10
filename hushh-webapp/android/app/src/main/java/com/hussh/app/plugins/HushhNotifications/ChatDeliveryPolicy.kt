package com.hussh.app.plugins.HushhNotifications

/** FCM is at-least-once and can deliver alerts after a read or a newer alert. */
internal object ChatDeliveryPolicy {
    fun shouldAlert(boundary: Double, read: Double, delivered: Double, message: String, previous: Set<String>): Boolean =
        boundary > read && boundary >= delivered && (message.isEmpty() || message !in previous)
}
