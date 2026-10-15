package com.hussh.app.plugins.HushhCardCapture

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Base64
import androidx.activity.result.ActivityResult
import androidx.core.content.FileProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.ByteArrayOutputStream
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/** Owns exactly one private transient file, never writes Gallery or logs images. */
@CapacitorPlugin(name = "HushhCardCapture")
class HushhCardCapturePlugin : Plugin() {
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    @Volatile private var captureFile: File? = null
    private var captureUri: Uri? = null
    @Volatile private var requestId: String? = null
    @Volatile private var cancelled = false
    private var pendingCall: PluginCall? = null
    private val timer = Handler(Looper.getMainLooper())
    private var watchdog: Runnable? = null
    private val ownedDirectory: File get() = File(context.cacheDir, "wallet-card-capture")

    override fun load() {
        // Only this plugin's orphan directory, never shared Camera/Pictures caches.
        ownedDirectory.mkdirs()
        ownedDirectory.listFiles()?.filter { it.isFile && it.name.matches(Regex("card-[A-Za-z0-9-]+\\.jpg")) }?.forEach { it.delete() }
    }

    @Synchronized private fun releaseCapture() {
        captureUri?.let { context.revokeUriPermission(it, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION) }
        captureFile?.delete()
        captureFile = null; captureUri = null
    }

    @PluginMethod
    fun takePhoto(call: PluginCall) {
        // A cancelled ActivityResult is quarantined until its callback returns;
        // it must never be allowed to read or delete a newer capture's file.
        if (requestId != null) { call.reject("Capture busy", "capture_busy"); return }
        val id = call.getString("requestId")
        if (id == null || !id.matches(Regex("[a-fA-F0-9-]{36}"))) { call.reject("Invalid capture", "invalid_capture"); return }
        requestId = id; cancelled = false; pendingCall = call
        try {
            ownedDirectory.mkdirs()
            val file = File.createTempFile("card-", ".jpg", ownedDirectory)
            captureFile = file
            val uri = FileProvider.getUriForFile(context, context.packageName + ".fileprovider", file)
            captureUri = uri
            val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
                putExtra(MediaStore.EXTRA_OUTPUT, uri)
                putExtra("android.intent.extras.CAMERA_FACING", 0)
                putExtra("android.intent.extra.USE_FRONT_CAMERA", false)
                clipData = ClipData.newRawUri("Card capture", uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            }
            startActivityForResult(call, intent, "captured")
            watchdog = Runnable { cancelRequest(id) }.also { timer.postDelayed(it, 180_000) }
        } catch (_: Exception) { releaseCapture(); requestId = null; pendingCall = null; call.reject("Camera unavailable", "camera_unavailable") }
    }

    @Synchronized private fun cancelRequest(id: String) {
        if (requestId != id || cancelled) return
        cancelled = true; releaseCapture()
        watchdog?.let { timer.removeCallbacks(it) }; watchdog = null
        pendingCall?.reject("Capture cancelled", "capture_cancelled"); pendingCall = null
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        call.getString("requestId")?.let { cancelRequest(it) }; call.resolve()
    }

    @ActivityCallback
    private fun captured(call: PluginCall?, result: ActivityResult) {
      val id = call?.getString("requestId") ?: requestId
      if (id == null || id != requestId) return
      watchdog?.let { timer.removeCallbacks(it) }; watchdog = null
      scope.launch {
        try {
            if (call == null || cancelled) return@launch
            if (result.resultCode != Activity.RESULT_OK) { releaseCapture(); call.resolve(JSObject().put("cancelled", true)); return@launch }
            val file = captureFile ?: throw IllegalStateException("No capture")
            if (file.length() > 15 * 1024 * 1024) throw IllegalArgumentException("Image too large")
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(file.absolutePath, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0 || bounds.outWidth > 16000 || bounds.outHeight > 16000) throw IllegalArgumentException("Invalid image")
            var sample = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 2400) sample *= 2
            val bitmap = BitmapFactory.decodeFile(file.absolutePath, BitmapFactory.Options().apply { inSampleSize = sample }) ?: throw IllegalArgumentException("Invalid image")
            var oriented: Bitmap? = null
            try {
                val matrix = Matrix()
                when (ExifInterface(file.absolutePath).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
                    ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.setScale(-1f, 1f)
                    ExifInterface.ORIENTATION_ROTATE_180 -> matrix.setRotate(180f)
                    ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.setScale(1f, -1f)
                    ExifInterface.ORIENTATION_TRANSPOSE -> { matrix.setRotate(90f); matrix.postScale(-1f, 1f) }
                    ExifInterface.ORIENTATION_ROTATE_90 -> matrix.setRotate(90f)
                    ExifInterface.ORIENTATION_TRANSVERSE -> { matrix.setRotate(270f); matrix.postScale(-1f, 1f) }
                    ExifInterface.ORIENTATION_ROTATE_270 -> matrix.setRotate(270f)
                }
                val output = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
                oriented = output
                val bytes = ByteArrayOutputStream().use { stream -> output.compress(Bitmap.CompressFormat.JPEG, 90, stream); stream.toByteArray() }
                if (cancelled || requestId != id || captureFile !== file) return@launch
                releaseCapture() // Raw file is erased BEFORE successful JS settlement.
                call.resolve(JSObject().put("dataUrl", "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)))
            } finally { if (oriented !== bitmap) oriented?.recycle(); bitmap.recycle() }
        } catch (_: Exception) { if (!cancelled && requestId == id) call?.reject("Photo unavailable", "photo_unavailable") }
        finally { if (requestId == id) { releaseCapture(); pendingCall = null; requestId = null } }
      }
    }

    override fun handleOnDestroy() { requestId?.let { cancelRequest(it) }; scope.cancel(); releaseCapture(); super.handleOnDestroy() }
}
