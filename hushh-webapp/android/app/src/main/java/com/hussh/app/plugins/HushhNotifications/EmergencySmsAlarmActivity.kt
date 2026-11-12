package com.hussh.app.plugins.HushhNotifications

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.google.firebase.auth.FirebaseAuth
import com.hussh.app.MainActivity

/** A lock-screen surface with no account, sender or location details. */
class EmergencySmsAlarmActivity : Activity() {
    private val receipts by lazy { getSharedPreferences(EmergencySmsAlarmService.ACK_STORE, Context.MODE_PRIVATE) }
    private val receiptListener = SharedPreferences.OnSharedPreferenceChangeListener { _, _ ->
        if (!hasPendingAlert()) finish()
    }

    private fun hasPendingAlert(): Boolean {
        val user = intent.getStringExtra("userId") ?: return false
        val grant = intent.getStringExtra("grantId") ?: return false
        return FirebaseAuth.getInstance().currentUser != null &&
            !ChatPreviewKeys.legacyKey(this, user).isNullOrBlank() &&
            grant in EmergencySmsAlarmService.pending(this, user)
    }

    override fun onStart() {
        super.onStart()
        receipts.registerOnSharedPreferenceChangeListener(receiptListener)
        if (!hasPendingAlert()) finish()
    }

    override fun onStop() {
        receipts.unregisterOnSharedPreferenceChangeListener(receiptListener)
        super.onStop()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val user = intent.getStringExtra("userId")
        val grant = intent.getStringExtra("grantId")
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE ||
            user.isNullOrBlank() || grant.isNullOrBlank() ||
            !EmergencySmsAlarmService.fullScreenAllowed(this) ||
            !hasPendingAlert()) {
            finish()
            return
        }
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        val inset = (24 * resources.displayMetrics.density).toInt()
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(inset, inset, inset, inset)
        }
        content.addView(TextView(this).apply {
            text = "SMS – Save my Soul"
            textSize = 28f
            gravity = Gravity.CENTER
            isAccessibilityHeading = true
        })
        content.addView(TextView(this).apply {
            text = "An emergency alert needs your attention."
            textSize = 16f
            gravity = Gravity.CENTER
            setPadding(0, inset, 0, inset)
        })
        content.addView(Button(this).apply {
            text = "Open Hussh"
            setOnClickListener {
                startActivity(Intent(this@EmergencySmsAlarmActivity, MainActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
                    putExtra("google.message_id", "sms-alarm:$grant")
                    putExtra("type", "location_share_created")
                    putExtra("share_kind", "sos")
                    putExtra("user_id", user)
                    putExtra("grant_id", grant)
                })
                finish()
            }
        })
        content.addView(Button(this).apply {
            text = "Acknowledge"
            setOnClickListener {
                val keyguard = getSystemService(KeyguardManager::class.java)
                if (keyguard.isDeviceLocked) {
                    keyguard.requestDismissKeyguard(this@EmergencySmsAlarmActivity, object : KeyguardManager.KeyguardDismissCallback() {
                        override fun onDismissSucceeded() { acknowledge(user, grant) }
                    })
                } else acknowledge(user, grant)
            }
        })
        setContentView(ScrollView(this).apply {
            isFillViewport = true
            addView(content)
        })
    }

    private fun acknowledge(user: String, grant: String) {
        if (!isFinishing && hasPendingAlert()) EmergencySmsAlarmService.acknowledgeFromDevice(this, user, grant)
        finish()
    }
}
