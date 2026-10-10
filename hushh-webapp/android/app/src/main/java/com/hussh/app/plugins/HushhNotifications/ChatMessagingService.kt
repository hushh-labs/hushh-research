package com.hussh.app.plugins.HushhNotifications

import android.app.ActivityManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.content.Context
import android.util.Base64
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.graphics.drawable.IconCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.hussh.app.MainActivity
import com.hussh.app.R
import io.capawesome.capacitorjs.plugins.firebase.messaging.FirebaseMessagingPlugin

/** Single FCM service: bridge events and render background chat locally. */
class ChatMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) { FirebaseMessagingPlugin.onNewToken(token) }
    override fun onMessageReceived(message: RemoteMessage) {
        FirebaseMessagingPlugin.onMessageReceived(message)
        val data = message.data.toMutableMap()
        if (data["recipient_key_id"] == null) data["user_id"]?.let { user -> ChatPreviewKeys.legacyKey(this, user)?.let { data["recipient_key_id"] = it } }
        if (data["recipient_key_id"] == null) data["chat_owner"]?.let { owner -> ChatPreviewKeys.legacyHashKey(this, owner)?.let { data["recipient_key_id"] = it } }
        val kind = data["type"]
        if (kind == "direct_message_read" || kind == "location_circle_chat_read") {
            val key = data["recipient_key_id"] ?: return
            val thread = data["conversation_id"] ?: data["circle_id"] ?: return
            clearRead(this, thread, key, data["chat_sequence"]?.toLongOrNull(), data["chat_read_before"]?.toLongOrNull(), data["chat_read_message_id"])
            return
        }
        if (kind != "direct_message" && kind != "location_circle_message") return
        if (!ChatPreviewKeys.active(this)) return
        data["recipient_key_id"]?.let { if (!ChatPreviewKeys.matches(this, it)) return }
        val info = ActivityManager.RunningAppProcessInfo()
        ActivityManager.getMyMemoryState(info)
        val activeTag = if (kind == "location_circle_message") "circle-chat:${data["circle_id"]}" else "direct-chat:${data["conversation_id"]}"
        if (info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND && HushhNotificationsPlugin.activityActive && HushhNotificationsPlugin.activeChatKey == data["recipient_key_id"] && HushhNotificationsPlugin.activeChatTag == activeTag) return
        if ((data["chat_expires_at"]?.toLongOrNull() ?: 0) < System.currentTimeMillis() / 1000) return
        val event = data["message_id"] ?: return
        if (event.length > 160 || ChatPreviewKeys.seen(this, event)) return
        val preview = data["chat_preview"]?.let { ChatPreviewKeys.open(this, it, data["preview_context"] ?: "") }
        val identity = data["chat_identity"]?.let { ChatPreviewKeys.open(this, it, data["preview_context"] ?: "") }
        val trusted = identity ?: if (kind == "direct_message") preview else null
        val sender = trusted?.optString("sender")?.let { truncate(it, 80) }?.ifBlank { null } ?: "New message"
        val group = trusted?.optString("group")?.let { truncate(it, 80) }?.ifBlank { null }
        val count = data["chat_unread_count"]?.toIntOrNull()?.coerceIn(0, 9999) ?: 1
        val body = preview?.optString("text")?.let { truncate(it, 160) }?.ifBlank { "Photo" } ?: if (count > 1) "$count unread messages" else "You have a new message"
        val avatar = avatar(trusted?.optString("avatar"), sender)
        val conversation = data["conversation_id"] ?: data["circle_id"] ?: event
        val person = Person.Builder().setName(sender).setKey(trusted?.optString("senderRef")?.ifBlank { null } ?: sender).setIcon(IconCompat.createWithBitmap(avatar)).build()
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) manager.createNotificationChannel(
            NotificationChannel(CHANNEL, "Messages", NotificationManager.IMPORTANCE_HIGH).apply { description = "Direct and Circle chat messages" })
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            this.data = Uri.parse("hussh-chat://notification/${Uri.encode(event)}")
            putExtra("google.message_id", message.messageId ?: event)
            data.forEach { (key, value) -> if (key != "chat_preview" && key != "chat_identity") putExtra(key, value) }
        }
        val tap = PendingIntent.getActivity(this, event.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val style = NotificationCompat.MessagingStyle(Person.Builder().setName("You").build())
            .setGroupConversation(kind == "location_circle_message")
            .addMessage(body, System.currentTimeMillis(), person)
        if (group != null) style.setConversationTitle(group)
        val notification = NotificationCompat.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_stat_message)
            .setLargeIcon(avatar).setContentTitle(group ?: sender).setContentText(body).setStyle(style)
            .setContentIntent(tap).setAutoCancel(true).setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH).setGroup("chat:$conversation")
            .setNumber(count)
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
            .addExtras(Bundle().apply {
                putString("chat_thread", conversation); putString("chat_key", data["recipient_key_id"])
                putLong("chat_sequence", data["chat_sequence"]?.toLongOrNull() ?: 0)
                putLong("chat_sent_at", data["chat_sent_at"]?.toLongOrNull() ?: 0)
            })
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(NotificationCompat.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_stat_message)
                .setContentTitle("New message").setContentText("Open Hussh to read your message").build()).build()
        try {
            ChatPreviewKeys.withKey(this, data["recipient_key_id"] ?: return) {
                if (ChatPreviewKeys.seen(this, event)) return@withKey
                val boundary = (data["chat_sequence"] ?: data["chat_sent_at"])?.toDoubleOrNull() ?: return@withKey
                if (!ChatDeliveryState.alert(this, data["recipient_key_id"]!!, conversation, boundary, event)) return@withKey
                // NotificationManager queues posts/cancels; build from this snapshot
                // plus the current message instead of assuming a post is visible yet.
                val previous = manager.activeNotifications.filter { it.notification.group == "chat:$conversation" && it.notification.extras.getString("chat_key") == data["recipient_key_id"] && it.tag != "chat-summary:$conversation" && it.tag != event }
                val inbox = NotificationCompat.InboxStyle()
                for (item in previous.sortedBy { it.postTime }.takeLast(4)) inbox.addLine(item.notification.extras.getCharSequence(android.app.Notification.EXTRA_TEXT))
                inbox.addLine(if (group == null) body else "$sender: $body")
                val summary = NotificationCompat.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_stat_message).setLargeIcon(avatar)
                    .setContentTitle(group ?: sender).setContentText("${maxOf(count, previous.size + 1)} new messages").setNumber(count).setContentIntent(tap).setAutoCancel(true)
                    .setStyle(inbox).setGroup("chat:$conversation").setGroupSummary(true).setSilent(true).setOnlyAlertOnce(true)
                    .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                    .setPublicVersion(NotificationCompat.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_stat_message)
                        .setContentTitle("New messages").setContentText("Open Hussh to read your messages").build())
                    .addExtras(Bundle().apply { putString("chat_thread", conversation); putString("chat_key", data["recipient_key_id"]) }).build()
                NotificationManagerCompat.from(this).notify(event, 0, notification)
                manager.notify("chat-summary:$conversation", 1, summary)
                ChatPreviewKeys.remember(this, event)
            }
        }
        catch (_: SecurityException) { /* Permission may be revoked between receipt and display. */ }
    }
    private fun truncate(value: String, count: Int): String = value.substring(0, value.offsetByCodePoints(0, minOf(count, value.codePointCount(0, value.length))))
    private fun avatar(raw: String?, name: String): Bitmap {
        if (raw != null && raw.startsWith("data:image/jpeg;base64,") && raw.length <= 1023) {
            runCatching {
                val bytes = Base64.decode(raw.substringAfter(','), Base64.DEFAULT)
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                require(bounds.outWidth in 1..64 && bounds.outHeight in 1..64)
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.let { return it }
            }
        }
        val bitmap = Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawColor(Color.rgb(65, 83, 104))
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; textSize = 30f; textAlign = Paint.Align.CENTER }
        canvas.drawText(truncate(name, 1).uppercase(), 32f, 42f, paint)
        return bitmap
    }
    companion object {
        const val CHANNEL = "hussh_chat_messages_v1"
        fun clearRead(context: Context, thread: String, key: String, sequence: Long?, before: Long?, messageId: String?) {
            ChatPreviewKeys.withKey(context, key) {
                ChatDeliveryState.read(context, key, thread, (sequence ?: before ?: 0).toDouble(), messageId)
                val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                val children = manager.activeNotifications.filter {
                    it.tag != "chat-summary:$thread" && it.notification.extras.getString("chat_thread") == thread && it.notification.extras.getString("chat_key") == key
                }
                val remaining = children.filter { item ->
                    val extras = item.notification.extras
                    val exactMessage = messageId != null && item.tag == messageId
                    val withinBoundary = if (sequence != null) extras.getLong("chat_sequence") in 1..sequence
                        else before != null && extras.getLong("chat_sent_at") in 1..before
                    val read = exactMessage || withinBoundary
                    if (read) manager.cancel(item.tag, item.id)
                    !read
                }.sortedBy { it.postTime }
                if (remaining.isEmpty()) manager.cancel("chat-summary:$thread", 1)
                else {
                    val latest = remaining.last().notification
                    val style = NotificationCompat.InboxStyle()
                    for (item in remaining.takeLast(5)) style.addLine(item.notification.extras.getCharSequence(android.app.Notification.EXTRA_TEXT))
                    val summary = NotificationCompat.Builder(context, latest).setStyle(style).setContentText("${remaining.size} new messages").setNumber(remaining.size)
                        .setGroupSummary(true).setSilent(true).setOnlyAlertOnce(true).setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN).build()
                    manager.notify("chat-summary:$thread", 1, summary)
                }
            }
        }
    }
}
