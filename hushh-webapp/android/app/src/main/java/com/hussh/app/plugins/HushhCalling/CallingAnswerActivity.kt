package com.hussh.app.plugins.HushhCalling

import android.Manifest
import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.annotation.RequiresApi
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/** Explicit Answer tap supplies the while-in-use microphone permission context. */
@RequiresApi(26)
internal class CallingAnswerActivity : Activity() {
    private val scope = MainScope()
    private var started = false

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        if (Build.VERSION.SDK_INT >= 27) setShowWhenLocked(true)
        else {
            @Suppress("DEPRECATION")
            window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED)
        }
    }

    override fun onWindowFocusChanged(focused: Boolean) {
        super.onWindowFocusChanged(focused)
        if (!focused || started) return
        started = true
        if (CallingRuntime.microphoneGranted(this)) answer()
        else requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 1)
    }

    override fun onRequestPermissionsResult(code: Int, permissions: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(code, permissions, results)
        if (code == 1 && CallingRuntime.microphoneGranted(this)) answer() else finish()
    }

    private fun answer() {
        val id = CallingRuntime.callId(intent.getStringExtra("callId")) ?: run { finish(); return }
        scope.launch {
            try { CallingRuntime.service?.answer(id) }
            catch (_: Exception) { /* The service removes an unavailable call. */ }
            finally { finish() }
        }
    }

    override fun onDestroy() { scope.cancel(); super.onDestroy() }
}
