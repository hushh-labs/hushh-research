package com.hussh.app

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import android.view.KeyEvent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.StaleObjectException
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
        // A pulled-down shade takes every tap; a gesture in an earlier run can
        // leave it open.
        device.executeShellCommand("cmd statusbar collapse")

        try {
            if (section == "all" || section == "feed") feedSection()
            if (section == "all" || section == "kai") kaiSection()
            if (section == "all" || section == "location") locationSection()
            if (section == "hold") holdSection()
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
            tapObject(openProfile)
            settle(1_500)
            val close = device.wait(Until.findObject(By.desc("Close Profile")), 3_000)
            if (close != null) tapObject(close) else device.pressBack()
            settle(1_500)
            group("profile-pane-open-dismiss") {
                device.wait(Until.findObject(By.desc("Open Profile")), 2_000)?.let { tapObject(it) }
                settle(1_500)
                val c = device.wait(Until.findObject(By.desc("Close Profile")), 2_000)
                if (c != null) tapObject(c) else device.pressBack()
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
                    tapObject(composer)
                    settle(500)
                    composer.text = "Summarize my week in three short bullet points."
                    settle(500)
                    val send = device.findObject(By.desc("Send message"))
                    if (send != null) tapObject(send) else device.pressEnter()
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

    /**
     * One launch, one unlock, then the app stays in front and unlocked for
     * `holdMinutes` (default 20) as a single continuous session: the way a
     * person uses it, walked by hand or by adb taps from the host with a
     * screenshot at every stop. No route is injected, so the app lands where
     * it normally would, and nothing here relaunches it or unlocks it again.
     */
    private fun holdSection() {
        if (!launchAttached(null)) return
        log("PERF_APP_READY route=session")
        val minutes = (args.getString("holdMinutes")?.toLongOrNull() ?: 20L).coerceIn(1L, 60L)
        log("PERF_HOLD minutes=$minutes")
        val until = System.currentTimeMillis() + minutes * 60_000
        while (System.currentTimeMillis() < until) settle(5_000)
        log("PERF_DONE route=session")
    }

    /** Threads and X on the same phone, same flick, HWUI numbers only. */
    private fun thirdPartyFeedFlick(name: String, otherPkg: String) {
        // Through the shell, not our own PackageManager: since Android 11 an
        // app sees only the packages its manifest declares in <queries>, and
        // ours declares an SMS intent only, so Threads and X read as "not
        // installed" to the app while sitting on the phone. The shell is not
        // subject to package visibility.
        val installed = device.executeShellCommand("pm path $otherPkg").contains("package:")
        if (!installed) {
            log("PERF_SKIPPED name=$name-feed-flick reason=not_installed")
            return
        }
        device.executeShellCommand("am force-stop $otherPkg")
        settle(800)
        device.executeShellCommand("monkey -p $otherPkg -c android.intent.category.LAUNCHER 1")
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
    private fun launchAttached(route: String?): Boolean {
        // The instrumentation runs inside the app's own process, so the app is
        // never force-stopped here; CLEAR_TASK destroys the previous activity
        // (and its WebView, and its probe run) and a fresh one boots. A null
        // route injects none: the app opens where it normally would.
        val prefs = target.getSharedPreferences(PerfProbeLaunchPolicy.PREFERENCES_GROUP, Context.MODE_PRIVATE)
            .edit()
            .putString(PerfProbeLaunchPolicy.PROBE_PREFERENCE_KEY, "1")
        if (route != null) prefs.putString(PerfProbeLaunchPolicy.ROUTE_PREFERENCE_KEY, route)
        else prefs.remove(PerfProbeLaunchPolicy.ROUTE_PREFERENCE_KEY)
        prefs.commit()
        val intent = Intent(Intent.ACTION_MAIN)
            .setClassName(pkg, "$pkg.MainActivity")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            .putExtra(PerfProbeLaunchPolicy.PROBE_EXTRA, true)
        if (route != null) intent.putExtra(PerfProbeLaunchPolicy.ROUTE_EXTRA, route)
        target.startActivity(intent)
        // The gate's passkey attempt can put Android's Credential Manager in
        // front before the app's own window is visible to UIAutomator.
        val windowDeadline = System.currentTimeMillis() + 30_000
        var appWindow = false
        while (System.currentTimeMillis() < windowDeadline && !appWindow) {
            dismissCredentialManager()
            appWindow = device.wait(Until.hasObject(By.pkg(pkg).depth(0)), 2_000)
        }
        assertTrue("app window", appWindow)
        // CLEAR_TASK finishes the previous activity, but its WebView can stay
        // on screen for a moment; the old window would then take the taps and
        // the swipes (and its accessibility tree would answer for the new
        // one). Wait until exactly one MainActivity record remains.
        var records = activityRecordCount()
        val recordDeadline = System.currentTimeMillis() + 15_000
        while (records != 1 && System.currentTimeMillis() < recordDeadline) {
            settle(500)
            records = activityRecordCount()
        }
        log("PERF_ACTIVITIES route=$route main_activity_records=$records front=${device.currentPackageName}")
        device.waitForIdle(5_000)
        return unlockVault(240_000)
    }

    private fun activityRecordCount(): Int =
        Regex("\\* Hist +#\\d+: ActivityRecord\\{[^}]*$pkg/\\.MainActivity")
            .findAll(device.executeShellCommand("dumpsys activity activities"))
            .count()

    /**
     * Passphrase method only: reveal the field if a quick method is the
     * default, type the passphrase, tap Unlock, then wait for positive proof:
     * the signed-in bottom bar on screen and the gate gone, held for three
     * seconds. With no passphrase configured (or a sign-in screen) it waits
     * for the person holding the phone. The passphrase is never logged.
     *
     * Every earlier "unlocked" on this phone was false (2026-09-22): the
     * gate's input exposes neither its label nor its hint to UIAutomator, so
     * "the labelled field has been gone four seconds" held from the first
     * poll, and UiObject2.setText filled the field without an input event,
     * so React kept Unlock disabled. The whole card then measured the lock
     * screen: every probe window was a tap on ~300 DOM nodes, where the
     * unlocked feed is scroll windows on ~700. Proof now has to be positive.
     */
    private fun unlockVault(timeoutMs: Long): Boolean {
        // The clock starts when the field is on screen (a cold boot can take a
        // while to reach the gate); a mismatch is retyped, up to three times.
        var deadline = System.currentTimeMillis() + timeoutMs
        var fieldSeen = false
        var attempts = 0
        var announced = false
        var snapshotLogged = false
        var typedAt = 0L
        var submits = 0
        var unlockedSince = 0L
        while (System.currentTimeMillis() < deadline) {
            // A cold boot can paint the shell for a moment before the gate
            // mounts over it, so one sighting of the bar is not an unlock.
            if (signedInBarPresent() && !gateUp()) {
                if (unlockedSince == 0L) unlockedSince = System.currentTimeMillis()
                if (System.currentTimeMillis() - unlockedSince >= 3_000) {
                    log("PERF_UNLOCK verified=shell attempts=$attempts")
                    return true
                }
                settle(300)
                continue
            }
            unlockedSince = 0L
            // The gate starts the passkey flow at launch; with no passkey on
            // this phone Android's Credential Manager covers the app with a
            // "No available sign-in" sheet. Cancel it and use the passphrase.
            if (dismissCredentialManager()) continue
            var field = if (gateUp()) findPassphraseField() else null
            if (field == null && attempts == 0 && passphrase.isNotEmpty()) {
                // "Passphrase" is the escape link on the biometric / passkey step.
                device.findObject(By.text("Passphrase").clazz("android.widget.Button"))?.let {
                    it.click()
                    settle(800)
                    field = findPassphraseField()
                }
            }
            val mismatch = device.findObject(By.textContains("did not match")) != null
            if (field != null && passphrase.isNotEmpty() && (attempts == 0 || (mismatch && attempts < 3))) {
                if (!fieldSeen) {
                    fieldSeen = true
                    deadline = System.currentTimeMillis() + timeoutMs
                }
                log("PERF_UNLOCK method=passphrase attempt=${attempts + 1}")
                try {
                    tapObject(field)
                } catch (_: StaleObjectException) {
                    continue
                }
                settle(400)
                if (attempts > 0) clearFocusedField()
                // Real key events, so the page's input handlers run. The
                // instrumentation shares the app's process, so this injects
                // into our own window without a shell command line.
                instrumentation.sendStringSync(passphrase)
                settle(300)
                val typedLength = try { field.text?.length ?: -1 } catch (_: StaleObjectException) { -2 }
                if (typedLength >= 0 && typedLength != passphrase.length) log("PERF_UNLOCK typed_mismatch expected=${passphrase.length} got=$typedLength")
                submitUnlock()
                attempts += 1
                typedAt = System.currentTimeMillis()
                submits = 1
                settle(2_000)
                continue
            }
            // Typed, gate still up, no mismatch banner: the submit did not
            // land (observed: the button enabled a beat after the check, and
            // the Enter fallback does not submit the form). Press it again.
            if (attempts > 0 && !mismatch && submits < 3 && gateUp() &&
                System.currentTimeMillis() - typedAt > 8_000 * submits
            ) {
                log("PERF_UNLOCK resubmit=${submits + 1}")
                submitUnlock()
                submits += 1
                settle(2_000)
                continue
            }
            if (attempts > 0 && !snapshotLogged && System.currentTimeMillis() - typedAt > 20_000) {
                // What UIAutomator can see while the unlock stays unproven:
                // counts and flags only. Never node texts: the page exposes
                // the passphrase field's value through accessibility.
                val radios = device.findObjects(By.clazz("android.widget.RadioButton")).size
                val webViews = device.findObjects(By.clazz("android.webkit.WebView")).size
                log("PERF_TREE pkg=${device.currentPackageName} webviews=$webViews radios=$radios gate=${gateUp()} records=${activityRecordCount()}")
                snapshotLogged = true
            }
            if (!announced) {
                log("PERF_WAITING_FOR_HUMAN step=sign-in-and-unlock timeout_s=${timeoutMs / 1000}")
                announced = true
            }
            settle(1_000)
        }
        log("PERF_SKIPPED name=launch reason=unlock_timeout gate=${gateUp()}")
        return false
    }

    /**
     * Presses Unlock once React has enabled it (it enables on the input
     * event, a beat after the last key). The tap goes through the shell like
     * every other tap in this lane; Enter is the fallback when the button
     * never enables, and it does not submit this form, so the caller
     * resubmits while the gate stays up.
     */
    private fun submitUnlock() {
        val unlock = device.wait(Until.findObject(By.text("Unlock").clazz("android.widget.Button").enabled(true)), 3_000)
        try {
            if (unlock != null) tapObject(unlock) else instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_ENTER)
        } catch (_: StaleObjectException) {
            instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_ENTER)
        }
        log("PERF_UNLOCK submitted=${if (unlock != null) "button" else "enter"}")
    }

    /** The vault gate is on screen: its heading, or its enabled-or-not Unlock button. */
    private fun gateUp(): Boolean =
        device.hasObject(By.text("Unlock One")) ||
            device.hasObject(By.text("Unlock").clazz("android.widget.Button"))

    /** Empties the focused field with key events (setText would skip the page's handlers). */
    private fun clearFocusedField() {
        instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_MOVE_END)
        repeat(passphrase.length + 8) { instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_DEL) }
    }

    /** Cancels the system passkey sheet when it is in front; true when it was. */
    private fun dismissCredentialManager(): Boolean {
        if (device.currentPackageName != "com.android.credentialmanager") return false
        val cancel = device.findObject(By.text("Cancel")) ?: return false
        cancel.click()
        log("PERF_UNLOCK dismissed=credential-manager")
        settle(800)
        return true
    }

    /**
     * The gate's passphrase input. Chromium exposes neither its aria-label
     * nor its placeholder to UIAutomator here (both read empty in a tree
     * dump), so the label lookups are kept for builds that do and the
     * app's own EditText is the answer on this one; callers only look while
     * gateUp() holds, so the agent bar's input is never mistaken for it.
     */
    private fun findPassphraseField(): UiObject2? =
        device.findObject(By.desc("Vault passphrase"))
            ?: device.findObject(By.hint("Enter passphrase"))
            ?: device.findObject(By.clazz("android.widget.EditText").pkg(pkg))

    private fun signedInBarPresent(): Boolean =
        device.wait(Until.hasObject(By.text("One").clazz("android.widget.RadioButton")), 500)

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

    // Gestures go through the shell's `input` tool, the same injection path
    // the attribution card uses from adb: events UiDevice.swipe/click inject
    // through UiAutomation never reached the page's pointer listeners on this
    // phone (the probe saw no window while the screen kept its idle 120 Hz).
    private fun shellInput(command: String) {
        device.executeShellCommand("input $command")
    }

    /** One thumb sweep at the card's speed (200 ms). */
    private fun flick(fromY: Float, toY: Float) {
        shellInput("swipe ${x(0.5f)} ${y(fromY)} ${x(0.5f)} ${y(toY)} 200")
    }

    private fun drag(x1: Float, y1: Float, x2: Float, y2: Float) {
        shellInput("swipe ${x(x1)} ${y(y1)} ${x(x2)} ${y(y2)} 300")
    }

    private fun tapAt(px: Int, py: Int) {
        shellInput("tap $px $py")
    }

    private fun tapObject(node: UiObject2) {
        val c = node.visibleCenter
        tapAt(c.x, c.y)
    }

    private val navCache = HashMap<String, Pair<Int, Int>>()

    /**
     * The signed-in bottom bar, left to right, as fractions of the screen:
     * five equal pills in a row that spans the width, centred 5.8 % above
     * the bottom. Used when the accessibility tree does not expose the bar
     * (it goes stale after the gate unmounts); the tree wins when it answers.
     */
    private val navFractions = mapOf(
        "Chat" to 0.15f, "One" to 0.325f, "Connect" to 0.5f, "Feed" to 0.675f, "Search" to 0.85f,
    )

    /** The bottom bar tab with this label: a RadioButton (segmented pill). */
    private fun tapNav(label: String): Boolean {
        val cached = navCache[label]
        if (cached != null) {
            tapAt(cached.first, cached.second)
            return true
        }
        val selector: BySelector = By.text(label).clazz("android.widget.RadioButton")
        val tab = device.wait(Until.findObject(selector), 2_000)
        if (tab != null) {
            val c = tab.visibleCenter
            navCache[label] = c.x to c.y
            tapAt(c.x, c.y)
            return true
        }
        val fraction = navFractions[label]
        if (fraction == null) {
            log("PERF_SKIPPED name=nav-tap reason=label_not_found label=$label")
            return false
        }
        val px = x(fraction)
        val py = y(0.942f)
        navCache[label] = px to py
        log("PERF_NAV label=$label source=position")
        tapAt(px, py)
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
