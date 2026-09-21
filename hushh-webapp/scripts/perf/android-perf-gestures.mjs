#!/usr/bin/env node
/**
 * Drive the render-performance gesture card on a connected Android phone over
 * adb, for the attribution lane (Debug build, native test bridge on).
 *
 * Mirrors ios/App/AppUITests/AppUITests.swift testRenderPerformanceCard: three
 * launches (feed / Finance / Location), the same gestures, the same dwell
 * times, one `PERF_GESTURE name=<g> rep=<n> start_epoch_ms=<ms> end_epoch_ms=<ms>`
 * line per gesture in the phone's clock (the probe's windows are stamped on
 * the phone), and around every gesture group a `dumpsys gfxinfo <pkg> reset`
 * before and `framestats` after, parsed into gfx/<gesture>.json.
 *
 * Invoked by scripts/perf/android-perf-card.sh; reads its inputs from the
 * environment only:
 *   ANDROID_SERIAL, ADB, PERF_OUT_DIR, HUSHH_PERF_REPS, PERF_SECTION
 *   (feed|kai|location|all|reference), REVIEWER_VAULT_PASSPHRASE, REVIEWER_UID,
 *   PERF_THIRD_PARTY=1 (also drive Threads and X: feed flick, bottom-bar
 *   tab switches, top-tab pager swipe, open/dismiss; gfxinfo only).
 *
 * The passphrase is handed to the app the way the native audit does it: as
 * an intent extra on a command line built here, single-quoted for the
 * device shell. It is never written to any file or printed. Every file this
 * driver keeps is checked for it by the card before it is kept.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { parseGfxinfo } from "./parse-gfxinfo.mjs";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const adb =
  process.env.ADB ||
  path.join(process.env.HOME || "", "Library/Android/sdk/platform-tools/adb");
const serial = (process.env.ANDROID_SERIAL || "").trim();
const outDir = process.env.PERF_OUT_DIR || path.join(webDir, "tmp/perf/android-manual");
const reps = Math.max(1, Number(process.env.HUSHH_PERF_REPS || "3") || 3);
const section = (process.env.PERF_SECTION || "all").trim();
const thirdParty = process.env.PERF_THIRD_PARTY === "1";
const passphrase = process.env.REVIEWER_VAULT_PASSPHRASE || "";
const reviewerUid = process.env.REVIEWER_UID || "";
const bundleId = "com.hussh.app";
const activityName = "com.hussh.app/.MainActivity";
const gestureLog = path.join(outDir, "gestures.log");
const gfxDir = path.join(outDir, "gfx");
const probeDir = path.join(outDir, "probe");
const STATUS_TIMEOUT_MS = 240_000;

if (!serial) {
  console.error("android-perf-gestures: ANDROID_SERIAL is required.");
  process.exit(2);
}
if (!passphrase || !reviewerUid) {
  console.error("android-perf-gestures: REVIEWER_VAULT_PASSPHRASE and REVIEWER_UID must be in the environment.");
  process.exit(2);
}
fs.mkdirSync(gfxDir, { recursive: true });
fs.mkdirSync(probeDir, { recursive: true });
fs.writeFileSync(gestureLog, "");

function sh(args, options = {}) {
  return execFileSync(adb, ["-s", serial, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}
function shell(command) {
  return sh(["shell", command]).trim();
}
function tryShell(command) {
  try {
    return shell(command);
  } catch {
    return "";
  }
}
/** Single-quote a value for the device shell (adb does not escape arguments). */
function q(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, Math.round(ms)));
}
function log(line) {
  fs.appendFileSync(gestureLog, `${line}\n`);
  console.log(line);
}

// The probe stamps its windows with the phone's Date.now(); gesture lines
// must be in the same clock. Measure the offset once, round trip halved.
function phoneClockOffsetMs() {
  const samples = [];
  for (let i = 0; i < 3; i += 1) {
    const before = Date.now();
    const raw = shell("echo $EPOCHREALTIME");
    const after = Date.now();
    const phone = Math.round(Number(raw) * 1000);
    if (Number.isFinite(phone)) samples.push(phone - (before + after) / 2);
  }
  if (!samples.length) return 0;
  samples.sort((a, b) => a - b);
  return Math.round(samples[Math.floor(samples.length / 2)]);
}
const clockOffset = phoneClockOffsetMs();
const phoneNow = () => Date.now() + clockOffset;
log(`PERF_CLOCK phone_minus_host_ms=${clockOffset}`);

const [screenW, screenH] = (() => {
  const raw = shell("wm size");
  const m = raw.match(/Override size: (\d+)x(\d+)/) || raw.match(/Physical size: (\d+)x(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : [1080, 2340];
})();
const X = (f) => Math.round(screenW * f);
const Y = (f) => Math.round(screenH * f);
log(`PERF_SCREEN width=${screenW} height=${screenH}`);

function keyguardShowing() {
  const win = tryShell('dumpsys window | grep -E "mDreamingLockscreen|mCurrentFocus"');
  return /mDreamingLockscreen=true/.test(win) || /Bouncer|Keyguard/.test(win);
}
/** Wake the screen; a secure keyguard (PIN) cannot be passed from here. */
function wake() {
  tryShell("input keyevent KEYCODE_WAKEUP");
  tryShell("wm dismiss-keyguard");
  tryShell("cmd statusbar collapse");
  sleep(600);
  if (keyguardShowing()) {
    log("PERF_BLOCKED reason=keyguard detail=the phone is locked; unlock it and run again");
    process.exit(3);
  }
}

// ---- gestures (adb input; the WebView is edge to edge) ----
function flick(fromY, toY, durationMs = 200) {
  shell(`input swipe ${X(0.5)} ${Y(fromY)} ${X(0.5)} ${Y(toY)} ${durationMs}`);
}
function drag(x1, y1, x2, y2, durationMs = 300) {
  shell(`input swipe ${X(x1)} ${Y(y1)} ${X(x2)} ${Y(y2)} ${durationMs}`);
}
function tapAt(x, y) {
  shell(`input tap ${Math.round(x)} ${Math.round(y)}`);
}

// ---- accessibility dump (WebView exposes its tree on the second request) ----
function dumpNodes() {
  const parse = (xml) =>
    [...xml.matchAll(/<node [^>]*>/g)].map((m) => {
      const attr = (name) => m[0].match(new RegExp(` ${name}="([^"]*)"`))?.[1] ?? "";
      const b = attr("bounds").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
      return {
        text: attr("text"),
        desc: attr("content-desc"),
        hint: attr("hint"),
        cls: attr("class"),
        clickable: attr("clickable") === "true",
        bounds: b ? b.slice(1, 5).map(Number) : [0, 0, 0, 0],
      };
    });
  let nodes = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let xml = "";
    try {
      xml = sh(["exec-out", "uiautomator", "dump", "/dev/tty"]);
    } catch {
      xml = "";
    }
    nodes = parse(xml);
    if (nodes.some((n) => n.text || n.desc)) return nodes;
    sleep(800);
  }
  return nodes;
}
const center = (n) => [(n.bounds[0] + n.bounds[2]) / 2, (n.bounds[1] + n.bounds[3]) / 2];

/** The bottom bar tab with this label: the lowest match on screen. */
function findNavTab(nodes, label) {
  const matches = nodes.filter((n) => n.text === label || n.desc === label);
  if (!matches.length) return null;
  return matches.sort((a, b) => b.bounds[1] - a.bounds[1])[0];
}
function findByLabel(nodes, predicate) {
  return nodes.find(predicate) ?? null;
}

const navCache = new Map();
function tapNav(label) {
  if (!navCache.has(label)) {
    const tab = findNavTab(dumpNodes(), label);
    if (!tab) {
      log(`PERF_SKIPPED name=nav-tap reason=label_not_found label=${label}`);
      return false;
    }
    navCache.set(label, center(tab));
  }
  const [x, y] = navCache.get(label);
  tapAt(x, y);
  return true;
}

function gesture(name, rep, body) {
  const start = phoneNow();
  body();
  const end = phoneNow();
  log(`PERF_GESTURE name=${name} rep=${rep} start_epoch_ms=${start} end_epoch_ms=${end}`);
}

function gfxReset(pkg = bundleId) {
  tryShell(`dumpsys gfxinfo ${pkg} reset`);
}
function gfxCapture(name, pkg = bundleId) {
  const raw = tryShell(`dumpsys gfxinfo ${pkg} framestats`);
  fs.writeFileSync(path.join(gfxDir, `${name}.txt`), `${raw}\n`);
  const parsed = { name, package: pkg, ...parseGfxinfo(raw) };
  fs.writeFileSync(path.join(gfxDir, `${name}.json`), `${JSON.stringify(parsed, null, 2)}\n`);
  log(
    `PERF_GFXINFO name=${name} frames=${parsed.total_frames} janky_pct=${parsed.janky_pct} p50=${parsed.p50_ms} p90=${parsed.p90_ms} p99=${parsed.p99_ms} over50=${parsed.frames_over_50_ms}`,
  );
  return parsed;
}
/** A gesture group: gfxinfo reset, `reps` gestures, gfxinfo capture. */
function group(name, body) {
  gfxReset();
  for (let rep = 0; rep < reps; rep += 1) gesture(name, rep, () => body(rep));
  gfxCapture(name);
}

// ---- app launch through the native test bridge (attribution lane) ----
function parseStatus(raw) {
  return Object.fromEntries(
    raw
      .trim()
      .split(";")
      .filter(Boolean)
      .map((part) => {
        const [key, ...rest] = part.split("=");
        return [key, rest.join("=")];
      }),
  );
}
function readStatus() {
  try {
    return parseStatus(sh(["exec-out", "run-as", bundleId, "cat", "files/native-test-status.txt"]));
  } catch {
    return {};
  }
}

function launchThroughBridge({ route, marker }) {
  wake();
  tryShell(`am force-stop ${bundleId}`);
  sleep(800);
  const redirect = encodeURIComponent(route);
  const extras = [
    "--ez HUSHH_NATIVE_TEST_MODE true",
    `--es HUSHH_NATIVE_TEST_INITIAL_ROUTE ${q(`/login?redirect=${redirect}`)}`,
    `--es HUSHH_NATIVE_TEST_EXPECTED_MARKER ${q(marker)}`,
    `--es HUSHH_NATIVE_TEST_EXPECTED_ROUTE ${q(route)}`,
    "--ez HUSHH_NATIVE_TEST_AUTO_REVIEWER_LOGIN true",
    `--es HUSHH_NATIVE_TEST_VAULT_PASSPHRASE ${q(passphrase)}`,
    `--es HUSHH_NATIVE_TEST_EXPECTED_USER_ID ${q(reviewerUid)}`,
    "--ez HUSHH_PERF_PROBE true",
    `--es HUSHH_PERF_ROUTE ${q(route)}`,
  ].join(" ");
  // Output discarded: `am start -W` echoes the intent line, never extra values,
  // but nothing from this command is kept.
  sh(["shell", `am start -W -n ${activityName} ${extras}`], { stdio: ["ignore", "ignore", "ignore"] });
  const deadline = Date.now() + STATUS_TIMEOUT_MS;
  let last = {};
  let lastKey = "";
  while (Date.now() < deadline) {
    last = readStatus();
    const key = `${last.route}|${last.auth}|${last.data}|${last.bootstrap}|${last.ready}`;
    if (key !== lastKey) {
      log(`PERF_STATUS route=${last.route ?? ""} ready=${last.ready ?? ""} auth=${last.auth ?? ""} data=${last.data ?? ""} bootstrap=${last.bootstrap ?? ""} error=${last.error ?? ""}`);
      lastKey = key;
    }
    if (last.ready === "1" && last.auth === "authenticated" && last.marker === marker && last.data === "loaded") {
      log(`PERF_APP_READY route=${route}`);
      return true;
    }
    sleep(1000);
  }
  log(`PERF_SKIPPED name=launch reason=status_timeout route=${route} last_error=${last.error ?? ""}`);
  return false;
}

function finishLaunch(route) {
  // 12 s idle lets the probe write its export; HOME fires visibilitychange
  // (one more export), then the process is stopped.
  sleep(12_000);
  tryShell("input keyevent KEYCODE_HOME");
  sleep(2_500);
  log(`PERF_DONE route=${route}`);
  tryShell(`am force-stop ${bundleId}`);
  sleep(1_000);
}

function captureDisplayState() {
  const display = tryShell('dumpsys display | grep -iE "mActiveModeId|renderFrameRate|mDisplayModeSpecs|frameRateOverride"');
  const flinger = tryShell('dumpsys SurfaceFlinger | grep -iE "refresh-rate|refresh rate|fps|VsyncPeriod" | head -20');
  fs.writeFileSync(path.join(outDir, "display.txt"), `# dumpsys display (app foreground)\n${display}\n\n# dumpsys SurfaceFlinger\n${flinger}\n`);
  const active = display.match(/mActiveModeId=(\d+)/)?.[1];
  const render = display.match(/renderFrameRate ([\d.]+)/)?.[1];
  log(`PERF_DISPLAY active_mode=${active ?? "?"} render_frame_rate=${render ?? "?"}`);
}

// ---- sections ----
function runFeedSection() {
  if (!launchThroughBridge({ route: "/one/feed", marker: "native-route-feed" })) return;
  sleep(2_500);
  captureDisplayState();

  group("feed-flick", () => {
    for (let i = 0; i < 5; i += 1) {
      flick(0.75, 0.25);
      sleep(350);
    }
    sleep(1_500);
    for (let i = 0; i < 5; i += 1) {
      flick(0.25, 0.75);
      sleep(350);
    }
    sleep(1_500);
  });

  // Label lookup once, outside any gesture window.
  for (const label of ["One", "Connect", "Feed"]) tapNav(label) && sleep(1_200);
  group("bottom-nav-switch", () => {
    for (const label of ["One", "Connect", "Feed"]) {
      tapNav(label);
      sleep(1_500);
    }
  });

  tapNav("One");
  sleep(1_500);
  // On this phone the pane is a full-width sheet (no scrim to tap) and the
  // body swipe yields to the agent rows under the finger, so the pane is
  // opened from the top bar's Open Profile control and closed with its own
  // Close Profile control: the same open and dismiss transitions, no drag.
  const paneNodes = dumpNodes();
  const openProfile = findByLabel(paneNodes, (n) => n.desc === "Open Profile");
  if (openProfile) {
    const [ox, oy] = center(openProfile);
    // One rehearsal outside any gesture window to locate the close control.
    tapAt(ox, oy);
    sleep(1_500);
    const close = findByLabel(dumpNodes(), (n) => n.desc === "Close Profile");
    const closePane = () => (close ? tapAt(...center(close)) : shell("input keyevent KEYCODE_BACK"));
    closePane();
    sleep(1_500);
    group("profile-pane-open-dismiss", () => {
      tapAt(ox, oy);
      sleep(1_500);
      closePane();
      sleep(1_200);
    });
  } else {
    log("PERF_SKIPPED name=profile-pane-open-dismiss reason=open_profile_not_found");
  }

  if (tapNav("Chat")) {
    sleep(2_500);
    gfxReset();
    gesture("chat-stream-30s", 0, () => {
      const nodes = dumpNodes();
      // The composer is `<textarea aria-label="Message One">`; this WebView
      // exposes it as a bare EditText (no label), the only one on the route.
      const composer = findByLabel(
        nodes,
        (n) => /Message One/i.test(n.desc) || (/EditText$/.test(n.cls) && n.bounds[3] > n.bounds[1]),
      );
      if (!composer) {
        log("PERF_SKIPPED name=chat-stream-30s reason=composer_not_found");
        return;
      }
      const [cx, cy] = center(composer);
      tapAt(cx, cy);
      sleep(500);
      shell("input text 'Summarize%smy%sweek%sin%sthree%sshort%sbullet%spoints.'");
      sleep(500);
      const send = findByLabel(dumpNodes(), (n) => n.desc === "Send message" || n.text === "Send message");
      if (send) tapAt(...center(send));
      else shell("input keyevent KEYCODE_ENTER");
      sleep(30_000);
    });
    gfxCapture("chat-stream-30s");
  }
  finishLaunch("/one/feed");
}

function runKaiSection() {
  if (!launchThroughBridge({ route: "/one/kai", marker: "native-route-kai-home" })) return;
  sleep(2_500);
  group("top-shell-pager-swipe", () => {
    drag(0.82, 0.48, 0.18, 0.48, 300);
    sleep(1_200);
    drag(0.18, 0.48, 0.82, 0.48, 300);
    sleep(1_200);
  });
  group("kai-chart-flick", () => {
    for (let i = 0; i < 3; i += 1) {
      flick(0.7, 0.3);
      sleep(400);
    }
    sleep(1_500);
  });
  finishLaunch("/one/kai");
}

function runLocationSection() {
  if (!launchThroughBridge({ route: "/one/location", marker: "native-route-one-location" })) return;
  sleep(2_500);
  group("location-map-pan", () => {
    for (let i = 0; i < 3; i += 1) {
      drag(0.3, 0.4, 0.7, 0.55, 300);
      sleep(600);
    }
    sleep(1_500);
  });
  finishLaunch("/one/location");
}

/** Threads and X on the same phone, same flick, HWUI numbers only. */
/** Cold launch of a reference app at its home tab; false when it is not in front. */
function launchReference(name, pkg) {
  wake();
  tryShell(`am force-stop ${pkg}`);
  sleep(800);
  tryShell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
  sleep(6_000);
  const focus = tryShell('dumpsys window | grep -E "mCurrentFocus"');
  return focus.includes(pkg);
}

/**
 * The reference app's bottom tab bar from the accessibility tree: the row of
 * clickable nodes in the bottom 12% of the screen that spans the width (a
 * compose bar or an attachment strip sits in the same band but never reaches
 * both edges). Labels are often absent, so position is the contract.
 */
function referenceTabRow(nodes) {
  // Threads marks its tab icons with a description and no clickable flag;
  // X marks them clickable with no description. Either counts.
  const band = nodes.filter(
    (n) =>
      (n.clickable || n.desc || n.text) &&
      n.bounds[1] >= Y(0.86) &&
      n.bounds[3] - n.bounds[1] < Y(0.12) &&
      n.bounds[2] - n.bounds[0] < X(0.4),
  );
  const rows = new Map();
  for (const n of band) {
    const key = Math.round((n.bounds[1] + n.bounds[3]) / 2 / 40);
    rows.set(key, [...(rows.get(key) ?? []), n]);
  }
  const spanning = [...rows.values()]
    .map((row) => row.sort((a, b) => a.bounds[0] - b.bounds[0]))
    .filter((row) => row.length >= 3 && row[0].bounds[0] <= X(0.2) && row[row.length - 1].bounds[2] >= X(0.8));
  if (!spanning.length) return [];
  const row = spanning
    .sort((a, b) => b.length - a.length)[0]
    .filter((n) => !/create|compose|new thread|new post|write|gallery|gif|attach|camera/i.test(`${n.desc} ${n.text}`));
  // X lists each tab twice (the icon and its container at the same x);
  // keep one per position, the labelled one when there is a choice.
  const merged = [];
  for (const n of row) {
    const last = merged[merged.length - 1];
    const cx = (n.bounds[0] + n.bounds[2]) / 2;
    if (last && Math.abs((last.bounds[0] + last.bounds[2]) / 2 - cx) < X(0.06)) {
      if (!(last.desc || last.text) && (n.desc || n.text)) merged[merged.length - 1] = n;
      continue;
    }
    merged.push(n);
  }
  return merged;
}

function runThirdParty(name, pkg) {
  const installed = tryShell(`pm list packages ${pkg}`).includes(`package:${pkg}`);
  if (!installed) {
    log(`PERF_SKIPPED name=${name}-feed-flick reason=not_installed`);
    return;
  }
  if (!launchReference(name, pkg)) {
    log(`PERF_SKIPPED name=${name}-feed-flick reason=did_not_launch`);
    return;
  }
  log(`PERF_APP_READY app=${name}`);
  gfxReset(pkg);
  for (let rep = 0; rep < reps; rep += 1) {
    gesture(`${name}-feed-flick`, rep, () => {
      for (let i = 0; i < 5; i += 1) {
        flick(0.75, 0.25);
        sleep(350);
      }
      sleep(1_500);
      for (let i = 0; i < 5; i += 1) {
        flick(0.25, 0.75);
        sleep(350);
      }
      sleep(1_500);
    });
  }
  gfxCapture(`${name}-feed-flick`, pkg);

  // The same gestures our card measures on its own shell, so the comparison
  // is not only a scroll: bottom-bar tab switches, the home pager's top-tab
  // swipe, and open/dismiss of a post. The tab bar is read from the
  // accessibility tree (clickable nodes in the bottom 12% of the screen);
  // a compose/create tab is skipped because it opens an editor.
  // Every group starts from a cold launch at the home tab, so a tap that
  // landed somewhere unexpected in one group cannot bend the next.
  if (!launchReference(name, pkg)) {
    log(`PERF_SKIPPED name=${name}-bottom-nav-switch reason=did_not_relaunch`);
    return;
  }
  const tabs = referenceTabRow(dumpNodes());
  const home = tabs[0] ?? null;
  const others = tabs.slice(1, 5);
  if (home && others.length) {
    log(`PERF_NAV app=${name} tabs=${tabs.map((n) => JSON.stringify(n.desc || n.text || `x${Math.round((n.bounds[0] + n.bounds[2]) / 2)}`)).join(",")}`);
    gfxReset(pkg);
    for (let rep = 0; rep < reps; rep += 1) {
      gesture(`${name}-bottom-nav-switch`, rep, () => {
        for (const tab of others) {
          tapAt(...center(tab));
          sleep(700);
          tapAt(...center(home));
          sleep(700);
        }
      });
    }
    gfxCapture(`${name}-bottom-nav-switch`, pkg);
    tapAt(...center(home));
    sleep(800);
  } else {
    log(`PERF_SKIPPED name=${name}-bottom-nav-switch reason=tab_bar_not_found tabs=${tabs.length}`);
  }

  if (!launchReference(name, pkg)) {
    log(`PERF_SKIPPED name=${name}-top-shell-pager-swipe reason=did_not_relaunch`);
    return;
  }
  gfxReset(pkg);
  for (let rep = 0; rep < reps; rep += 1) {
    gesture(`${name}-top-shell-pager-swipe`, rep, () => {
      // A drag, not a fling: the home pager pages on release, the way our
      // card's pager swipe does.
      drag(0.9, 0.35, 0.1, 0.35, 450);
      sleep(1_000);
      drag(0.1, 0.35, 0.9, 0.35, 450);
      sleep(1_000);
    });
  }
  gfxCapture(`${name}-top-shell-pager-swipe`, pkg);

  if (!launchReference(name, pkg)) {
    log(`PERF_SKIPPED name=${name}-open-dismiss reason=did_not_relaunch`);
    return;
  }
  gfxReset(pkg);
  for (let rep = 0; rep < reps; rep += 1) {
    gesture(`${name}-open-dismiss`, rep, () => {
      for (let i = 0; i < 3; i += 1) {
        tapAt(X(0.5), Y(0.45));
        sleep(1_200);
        tryShell("input keyevent KEYCODE_BACK");
        sleep(900);
      }
    });
  }
  gfxCapture(`${name}-open-dismiss`, pkg);
  // A back press too many would leave the app; make sure we are still in it.
  const focusAfter = tryShell('dumpsys window | grep -E "mCurrentFocus"');
  if (!focusAfter.includes(pkg)) log(`PERF_NOTE app=${name} detail=left the app during open-dismiss`);

  tryShell("input keyevent KEYCODE_HOME");
  sleep(1_000);
  tryShell(`am force-stop ${pkg}`);
}

function pullProbeExports() {
  let names = [];
  try {
    // toybox ls prints columns even to a pipe on some builds: split on any whitespace.
    names = sh(["exec-out", "run-as", bundleId, "ls", "files/hushh-perf"]).split(/\s+/).map((s) => s.trim()).filter((s) => s.endsWith(".json"));
  } catch {
    names = [];
  }
  for (const name of names) {
    const json = sh(["exec-out", "run-as", bundleId, "cat", `files/hushh-perf/${name}`]);
    fs.writeFileSync(path.join(probeDir, name), json);
  }
  // Leave the app container clean; the pulled copies are the record.
  if (names.length) tryShell(`run-as ${bundleId} rm -rf files/hushh-perf`);
  log(`PERF_EXPORTS pulled=${names.length}`);
}

/** Maintenance aid: print the labelled accessibility nodes of a route. */
function runDumpSection() {
  const route = process.env.PERF_DUMP_ROUTE || "/one/feed";
  const marker = process.env.PERF_DUMP_MARKER || "native-route-feed";
  if (!launchThroughBridge({ route, marker })) return;
  sleep(2_500);
  for (const n of dumpNodes()) {
    if (n.text || n.desc || n.hint || /EditText/.test(n.cls)) {
      console.log(`${n.cls} | text=${JSON.stringify(n.text)} | desc=${JSON.stringify(n.desc)} | hint=${JSON.stringify(n.hint)} | [${n.bounds.join(",")}]`);
    }
  }
  if (process.env.PERF_DUMP_HOLD === "1") {
    log("PERF_HOLD app left running for manual inspection");
    return;
  }
  finishLaunch(route);
}

log("PERF_LANE certifies=false simulator=false test_mode=true configuration=Debug");
if (section === "dump") runDumpSection();
if (section === "all" || section === "feed") runFeedSection();
if (section === "all" || section === "kai") runKaiSection();
if (section === "all" || section === "location") runLocationSection();
if (section !== "reference") pullProbeExports();
// PERF_SECTION=reference drives only the reference apps (HWUI only).
if (thirdParty || section === "reference") {
  runThirdParty("threads", "com.instagram.barcelona");
  runThirdParty("x", "com.twitter.android");
}
log("PERF_CARD_COMPLETE");
