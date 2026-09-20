package com.hussh.app

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The render-performance truth lane: the gesture card from
 * docs/reference/mobile/render-performance-charter.md driven by UIAutomator
 * with the native test bridge OFF. Each surface is its own launch carrying
 * only the probe preferences (the Android equivalent of iOS's
 * `-CapacitorStorage.hushh_perf_probe 1` launch argument); the vault is
 * unlocked with the passphrase method (never biometrics) from the
 * instrumentation argument `passphrase`, which is never logged. On the `perf`
 * build type (release settings, debuggable false) this is the certifying run;
 * on debug it attributes only, and says so.
 *
 * Output: `PERF_GESTURE name=<g> rep=<n> start_epoch_ms=<ms> end_epoch_ms=<ms>`
 * lines on the HUSHH_PERF logcat tag (same clock as the probe), gfxinfo
 * dumps around each gesture group, and the probe's exports copied into
 * Download/hushh-perf so adb can pull them from a non-debuggable build.
 *
 * Driver: scripts/perf/android-perf-card.sh with PERF_ATTACHED=1.
 */
@RunWith(AndroidJUnit4::class)
class AttachedRenderPerfTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device: UiDevice = UiDevice.getInstance(instrumentation)
    private val target: Context = instrumentation.targetContext
    private val args = InstrumentationRegistry.getArguments()
    private val reps = (args.getString("reps")?.toIntOrNull() ?: 3).coerceAtLeast(1)
    private val section = args.getString("section") ?: "all"
    private val passphrase = args.getString("passphrase").orEmpty().trim()
    private val thirdParty = args.getString("thirdParty") == "1"
    private val pkg = "com.hussh.app"
    private val exportDir = File(target.filesDir, "hushh-perf")

    @Test
    fun renderPerformanceCardAttached() {
        val debuggable = (target.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        log("PERF_LANE certifies=${!debuggable} simulator=false test_mode=false configuration=${if (debuggable) "Debug" else "Release"}")
        log("PERF_SCREEN width=${device.displayWidth} height=${device.displayHeight}")
        exportDir.deleteRecursively()
        device.wakeUp()
        device.executeShellCommand("wm dismiss-keyguard")

        try {
            if (section == "all" || section == "feed") feedSection()
            if (section == "all" || section == "kai") kaiSection()
            if (section == "all" || section == "location") locationSection()
        } finally {
            clearProbePreferences()
            publishExports()
        }
        if (thirdParty) {
            thirdPartyFeedFlick("threads", "com.instagram.barcelona")
            thirdPartyFeedFlick("x", "com.twitter.android")
        }
        log("PERF_CARD_COMPLETE")
    }

    // ---- sections (same gestures and dwell times as the iOS card) ----

    private fun feedSection() {
        if (!launchAttached("/one/feed")) return
        settle(3_000)
        log("PERF_APP_READY route=/one/feed")
        logDisplayState()

        group("feed-flick") {
            repeat(5) { flick(0.75f, 0.25f); settle(350) }
            settle(1_500)
            repeat(5) { flick(0.25f, 0.75f); settle(350) }
            settle(1_500)
        }

        for (label in listOf("One", "Connect", "Feed")) { tapNav(label); settle(1_200) }
        group("bottom-nav-switch") {
            for (label in listOf("One", "Connect", "Feed")) { tapNav(label); settle(1_500) }
        }

        tapNav("One")
        settle(1_500)
        // The pane is a full-width sheet here and the body swipe yields to the
        // agent rows, so the pane's own controls carry the open and dismiss.
        val openProfile = device.wait(Until.findObject(By.desc("Open Profile")), 5_000)
        if (openProfile != null) {
            openProfile.click()
            settle(1_500)
            val close = device.wait(Until.findObject(By.desc("Close Profile")), 3_000)
            if (close != null) close.click() else device.pressBack()
            settle(1_500)
            group("profile-pane-open-dismiss") {
                device.findObject(By.desc("Open Profile"))?.click()
                settle(1_500)
                val c = device.findObject(By.desc("Close Profile"))
                if (c != null) c.click() else device.pressBack()
                settle(1_200)
            }
        } else {
            log("PERF_SKIPPED name=profile-pane-open-dismiss reason=open_profile_not_found")
        }

        if (tapNav("Chat")) {
            settle(2_500)
            gfxReset()
            gesture("chat-stream-30s", 0) {
                val composer = device.wait(Until.findObject(By.clazz("android.widget.EditText")), 10_000)
                if (composer == null) {
                    log("PERF_SKIPPED name=chat-stream-30s reason=composer_not_found")
                } else {
                    composer.click()
                    settle(500)
                    composer.text = "Summarize my week in three short bullet points."
                    settle(500)
                    val send = device.findObject(By.desc("Send message"))
                    if (send != null) send.click() else device.pressEnter()
                    settle(30_000)
                }
            }
            gfxCapture("chat-stream-30s")
        }
        finishLaunch("/one/feed")
    }

    private fun kaiSection() {
        if (!launchAttached("/one/kai")) return
        settle(3_000)
        log("PERF_APP_READY route=/one/kai")
        group("top-shell-pager-swipe") {
            drag(0.82f, 0.48f, 0.18f, 0.48f)
            settle(1_200)
            drag(0.18f, 0.48f, 0.82f, 0.48f)
            settle(1_200)
        }
        group("kai-chart-flick") {
            repeat(3) { flick(0.7f, 0.3f); settle(400) }
            settle(1_500)
        }
        finishLaunch("/one/kai")
    }

    private fun locationSection() {
        if (!launchAttached("/one/location")) return
        settle(3_000)
        log("PERF_APP_READY route=/one/location")
        group("location-map-pan") {
            repeat(3) { drag(0.3f, 0.4f, 0.7f, 0.55f); settle(600) }
            settle(1_500)
        }
        finishLaunch("/one/location")
    }

    /** Threads and X on the same phone, same flick, HWUI numbers only. */
    private fun thirdPartyFeedFlick(name: String, otherPkg: String) {
        val intent = target.packageManager.getLaunchIntentForPackage(otherPkg)
        if (intent == null) {
            log("PERF_SKIPPED name=$name-feed-flick reason=not_installed")
            return
        }
        device.executeShellCommand("am force-stop $otherPkg")
        settle(800)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        target.startActivity(intent)
        if (!device.wait(Until.hasObject(By.pkg(otherPkg).depth(0)), 30_000)) {
            log("PERF_SKIPPED name=$name-feed-flick reason=did_not_launch")
            return
        }
        settle(6_000)
        log("PERF_APP_READY app=$name")
        gfxReset(otherPkg)
        repeat(reps) { rep ->
            gesture("$name-feed-flick", rep) {
                repeat(5) { flick(0.75f, 0.25f); settle(350) }
                settle(1_500)
                repeat(5) { flick(0.25f, 0.75f); settle(350) }
                settle(1_500)
            }
        }
        gfxCapture("$name-feed-flick", otherPkg)
        device.pressHome()
        settle(1_000)
        device.executeShellCommand("am force-stop $otherPkg")
    }

    // ---- launch, unlock, finish ----

    /**
     * Seeds the probe preferences the way the iOS launch argument does, starts
     * MainActivity with only the probe extras (a debug build re-seeds from
     * them; a non-debuggable build leaves the seeded keys alone, see
     * PerfProbeLaunchPolicy), then unlocks the vault with the passphrase.
     */
    private fun launchAttached(route: String): Boolean {
        // The instrumentation runs inside the app's own process, so the app is
        // never force-stopped here; CLEAR_TASK destroys the previous activity
        // (and its WebView, and its probe run) and a fresh one boots.
        target.getSharedPreferences(PerfProbeLaunchPolicy.PREFERENCES_GROUP, Context.MODE_PRIVATE)
            .edit()
            .putString(PerfProbeLaunchPolicy.PROBE_PREFERENCE_KEY, "1")
            .putString(PerfProbeLaunchPolicy.ROUTE_PREFERENCE_KEY, route)
            .commit()
        val intent = Intent(Intent.ACTION_MAIN)
            .setClassName(pkg, "$pkg.MainActivity")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            .putExtra(PerfProbeLaunchPolicy.PROBE_EXTRA, true)
            .putExtra(PerfProbeLaunchPolicy.ROUTE_EXTRA, route)
        target.startActivity(intent)
        assertTrue("app window", device.wait(Until.hasObject(By.pkg(pkg).depth(0)), 30_000))
        return unlockVault(240_000)
    }

    /**
     * Passphrase method only: reveal the field if a quick method is the
     * default, type the passphrase, tap Unlock, wait for the signed-in bottom
     * bar. With no passphrase configured (or a sign-in screen) it waits for
     * the person holding the phone. The passphrase is never logged.
     */
    private fun unlockVault(timeoutMs: Long): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        var typed = false
        var announced = false
        while (System.currentTimeMillis() < deadline) {
            if (signedInBarPresent()) return true
            var field = findPassphraseField()
            if (!typed && passphrase.isNotEmpty()) {
                if (field == null) {
                    // "Passphrase" is the escape link on the biometric / passkey step.
                    device.findObject(By.text("Passphrase").clazz("android.widget.Button"))?.let {
                        it.click()
                        settle(800)
                        field = findPassphraseField()
                    }
                }
                if (field != null) {
                    log("PERF_UNLOCK method=passphrase")
                    field.click()
                    settle(400)
                    field.text = passphrase
                    settle(300)
                    val unlock = device.findObject(By.text("Unlock"))
                    if (unlock != null) unlock.click() else device.pressEnter()
                    typed = true
                    settle(2_000)
                    continue
                }
            }
            if (!announced) {
                log("PERF_WAITING_FOR_HUMAN step=sign-in-and-unlock timeout_s=${timeoutMs / 1000}")
                announced = true
            }
            settle(1_000)
        }
        log("PERF_SKIPPED name=launch reason=unlock_timeout")
        return false
    }

    private fun findPassphraseField(): UiObject2? =
        device.findObject(By.desc("Vault passphrase"))
            ?: device.findObject(By.hint("Enter passphrase"))
            ?: device.findObject(By.clazz("android.widget.EditText").pkg(pkg))

    private fun signedInBarPresent(): Boolean =
        device.findObject(By.text("One").clazz("android.widget.RadioButton")) != null

    private fun finishLaunch(route: String) {
        // 12 s idle lets the probe write its export; HOME fires one more
        // (visibilitychange), then the process is stopped.
        settle(12_000)
        device.pressHome()
        settle(2_500)
        log("PERF_DONE route=$route")
    }

    private fun clearProbePreferences() {
        target.getSharedPreferences(PerfProbeLaunchPolicy.PREFERENCES_GROUP, Context.MODE_PRIVATE)
            .edit()
            .remove(PerfProbeLaunchPolicy.PROBE_PREFERENCE_KEY)
            .remove(PerfProbeLaunchPolicy.ROUTE_PREFERENCE_KEY)
            .commit()
    }

    // ---- gestures ----

    private fun x(f: Float) = (device.displayWidth * f).toInt()
    private fun y(f: Float) = (device.displayHeight * f).toInt()

    /** One thumb sweep; the step count sets the speed (about 5 ms per step). */
    private fun flick(fromY: Float, toY: Float) {
        device.swipe(x(0.5f), y(fromY), x(0.5f), y(toY), 30)
    }

    private fun drag(x1: Float, y1: Float, x2: Float, y2: Float) {
        device.swipe(x(x1), y(y1), x(x2), y(y2), 40)
    }

    private val navCache = HashMap<String, Pair<Int, Int>>()

    /** The bottom bar tab with this label: a RadioButton (segmented pill). */
    private fun tapNav(label: String): Boolean {
        val cached = navCache[label]
        if (cached != null) {
            device.click(cached.first, cached.second)
            return true
        }
        val selector: BySelector = By.text(label).clazz("android.widget.RadioButton")
        val tab = device.wait(Until.findObject(selector), 5_000)
        if (tab == null) {
            log("PERF_SKIPPED name=nav-tap reason=label_not_found label=$label")
            return false
        }
        val c = tab.visibleCenter
        navCache[label] = c.x to c.y
        device.click(c.x, c.y)
        return true
    }

    private fun settle(ms: Long) {
        Thread.sleep(ms)
    }

    private fun gesture(name: String, rep: Int, body: () -> Unit) {
        val start = System.currentTimeMillis()
        body()
        val end = System.currentTimeMillis()
        log("PERF_GESTURE name=$name rep=$rep start_epoch_ms=$start end_epoch_ms=$end")
    }

    private fun group(name: String, body: () -> Unit) {
        gfxReset()
        repeat(reps) { rep -> gesture(name, rep, body) }
        gfxCapture(name)
    }

    // ---- HWUI ----

    private fun gfxReset(p: String = pkg) {
        device.executeShellCommand("dumpsys gfxinfo $p reset")
    }

    private fun gfxCapture(name: String, p: String = pkg) {
        val raw = device.executeShellCommand("dumpsys gfxinfo $p framestats")
        File(exportDir.also { it.mkdirs() }, "gfx-$name.txt").writeText(raw)
        val frames = Regex("Total frames rendered: (\\d+)").find(raw)?.groupValues?.get(1) ?: "?"
        val janky = Regex("Janky frames: \\d+ \\(([\\d.]+)%\\)").find(raw)?.groupValues?.get(1) ?: "?"
        log("PERF_GFXINFO name=$name frames=$frames janky_pct=$janky")
    }

    private fun logDisplayState() {
        val display = device.executeShellCommand("dumpsys display")
        val mode = Regex("mActiveModeId=(\\d+)").find(display)?.groupValues?.get(1) ?: "?"
        val rate = Regex("renderFrameRate ([\\d.]+)").find(display)?.groupValues?.get(1) ?: "?"
        log("PERF_DISPLAY active_mode=$mode render_frame_rate=$rate")
    }

    // ---- exports (readable by adb on any build type) ----

    /**
     * Copies the probe exports and gfxinfo dumps into Download/hushh-perf via
     * MediaStore: run-as needs a debuggable build, MediaStore does not. The
     * card pulls and deletes the folder. Nothing in the files is personal.
     */
    private fun publishExports() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            log("PERF_EXPORTS published=0 reason=mediastore_downloads_needs_api_29")
            return
        }
        val files = exportDir.listFiles()?.filter { it.isFile } ?: emptyList()
        val resolver = target.contentResolver
        var published = 0
        for (file in files) {
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, file.name)
                put(MediaStore.MediaColumns.MIME_TYPE, if (file.name.endsWith(".json")) "application/json" else "text/plain")
                put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/hushh-perf")
            }
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: continue
            resolver.openOutputStream(uri)?.use { out -> file.inputStream().use { it.copyTo(out) } }
            published += 1
        }
        log("PERF_EXPORTS published=$published of=${files.size}")
    }

    private fun log(line: String) {
        Log.i("HUSHH_PERF", line)
    }
}
