#!/usr/bin/env node
/**
 * Fold HWUI's gfxinfo readings and the display mode into an Android baseline
 * summary written by summarize-probe-runs.mjs.
 *
 *   node scripts/perf/merge-android-gfxinfo.mjs --summary <summary.json> --gfx <dir> \
 *     [--gestures <gestures.log>] [--display <display.txt>] [--md <summary.md>]
 *
 * The probe measures rAF intervals inside the WebView; gfxinfo counts the
 * frames HWUI presented for the whole app window since the last reset. Both
 * are kept, side by side, under the same gesture names. Nothing personal is
 * read or written.
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const take = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
};
const summaryPath = take("--summary");
const gfxDir = take("--gfx");
const gesturesPath = take("--gestures");
const displayPath = take("--display");
const mdPath = take("--md");
if (!summaryPath || !fs.existsSync(summaryPath)) {
  console.error("usage: merge-android-gfxinfo.mjs --summary <summary.json> --gfx <dir> [--gestures log] [--display txt] [--md out]");
  process.exit(2);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
const gfx = new Map();
if (gfxDir && fs.existsSync(gfxDir)) {
  for (const file of fs.readdirSync(gfxDir).filter((f) => f.endsWith(".json")).sort()) {
    const parsed = JSON.parse(fs.readFileSync(path.join(gfxDir, file), "utf8"));
    gfx.set(parsed.name ?? path.basename(file, ".json"), parsed);
  }
}
for (const row of summary.gestures) {
  const g = gfx.get(row.name);
  if (g) {
    row.gfxinfo = {
      total_frames: g.total_frames,
      janky_frames: g.janky_frames,
      janky_pct: g.janky_pct,
      p50_ms: g.p50_ms,
      p90_ms: g.p90_ms,
      p95_ms: g.p95_ms,
      p99_ms: g.p99_ms,
      frames_over_50_ms: g.frames_over_50_ms,
      missed_vsync: g.missed_vsync,
      slow_ui_thread: g.slow_ui_thread,
    };
  }
}
// Third-party feeds (Threads, X) have gfxinfo only: no probe inside them.
summary.reference_gfxinfo = [...gfx.values()]
  .filter((g) => g.package && g.package !== "com.hussh.app")
  .map((g) => ({ name: g.name, package: g.package, total_frames: g.total_frames, janky_pct: g.janky_pct, p50_ms: g.p50_ms, p90_ms: g.p90_ms, p99_ms: g.p99_ms, frames_over_50_ms: g.frames_over_50_ms }));

const gesturesText = gesturesPath && fs.existsSync(gesturesPath) ? fs.readFileSync(gesturesPath, "utf8") : "";
const displayLine = gesturesText.match(/PERF_DISPLAY active_mode=(\S+) render_frame_rate=(\S+)/);
const laneLine = gesturesText.match(/PERF_LANE (.*)/)?.[1] ?? "";
const skipped = [...gesturesText.matchAll(/PERF_SKIPPED (.*)/g)].map((m) => m[1]);
summary.device.display = {
  active_mode_id: displayLine ? displayLine[1] : null,
  render_frame_rate: displayLine ? Number(displayLine[2]) : null,
  source: "dumpsys display while the app was in the foreground",
};
summary.device.web_engine = summary.device.ua_family;
summary.device.pipeline = [...gfx.values()][0]?.pipeline ?? null;
summary.lane_line = laneLine;
summary.skipped = skipped;
const reasons = [];
if (summary.device.configuration !== "Release") reasons.push(`${summary.device.configuration} build`);
if (summary.device.test_mode) reasons.push("native test bridge on (350 ms status poll, reviewer bootstrap)");
summary.device.certifies_reason = summary.device.certifies ? "phone, Release, test mode off" : reasons.join("; ");

fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

if (mdPath) {
  const hz = summary.device.raf_hz;
  const lines = [
    "",
    `Display: active mode ${summary.device.display.active_mode_id ?? "n/a"} at ${summary.device.display.render_frame_rate ?? "n/a"} Hz while the app was in front; the probe measured rAF ${hz ? `${hz.raw} Hz (nominal ${hz.nominal})` : "n/a"}. Certifies: ${summary.device.certifies} (${summary.device.certifies_reason}).`,
    "",
    "HWUI (`dumpsys gfxinfo` reset before, framestats after each gesture group):",
    "",
    "| Gesture | Frames | Janky % | p50 ms | p90 ms | p95 ms | p99 ms | Frames >= 50 ms | Missed vsync | Slow UI thread |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...summary.gestures
      .filter((r) => r.gfxinfo)
      .map((r) => `| ${r.name} | ${r.gfxinfo.total_frames} | ${r.gfxinfo.janky_pct} | ${r.gfxinfo.p50_ms} | ${r.gfxinfo.p90_ms} | ${r.gfxinfo.p95_ms} | ${r.gfxinfo.p99_ms} | ${r.gfxinfo.frames_over_50_ms} | ${r.gfxinfo.missed_vsync} | ${r.gfxinfo.slow_ui_thread} |`),
  ];
  if (summary.reference_gfxinfo.length) {
    lines.push("", "Reference apps on the same phone, same flick (HWUI only):", "", "| App gesture | Frames | Janky % | p50 ms | p90 ms | p99 ms | Frames >= 50 ms |", "|---|---|---|---|---|---|---|");
    for (const r of summary.reference_gfxinfo) lines.push(`| ${r.name} | ${r.total_frames} | ${r.janky_pct} | ${r.p50_ms} | ${r.p90_ms} | ${r.p99_ms} | ${r.frames_over_50_ms} |`);
  }
  if (skipped.length) lines.push("", "Skipped:", "", ...skipped.map((s) => `- ${s}`));
  lines.push("");
  fs.appendFileSync(mdPath, lines.join("\n"));
}
console.log(`merged gfxinfo for ${[...gfx.keys()].length} gesture(s) into ${summaryPath}`);
