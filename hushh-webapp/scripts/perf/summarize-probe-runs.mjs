#!/usr/bin/env node
/**
 * Turn the in-app probe's exports into a baseline table.
 *
 *   node scripts/perf/summarize-probe-runs.mjs --runs <dir-or-file>... [--gestures <log>] [--tier ios-sim] [--sha <sha>] [--configuration Debug|Release] [--test-mode 1|0] [--since <epoch-ms>] [--json <out.json>] [--md <out.md>]
 *
 * `--runs` takes probe JSON files (or directories of them, as pulled from the
 * app container's Documents/hushh-perf). `--gestures` is the xcodebuild log
 * (or any file) containing `PERF_GESTURE name=… rep=… start_epoch_ms=…
 * end_epoch_ms=…` lines; each gesture is matched to the probe windows that
 * overlap it in time, so the table reads by what the finger did rather than by
 * what the probe guessed. Without a gesture log the table is by window kind.
 *
 * Nothing in the inputs carries personal information (the probe never records
 * text, element content, full URLs or identifiers), and the summary adds none.
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const take = (flag) => {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag) {
      while (args[i + 1] && !args[i + 1].startsWith("--")) out.push(args[++i]);
    }
  }
  return out;
};
const runInputs = take("--runs");
const gestureLog = take("--gestures")[0];
const tier = take("--tier")[0] ?? "unknown";
const sha = take("--sha")[0] ?? "";
const jsonOut = take("--json")[0];
const mdOut = take("--md")[0];
const label = take("--label")[0] ?? "";
const configuration = take("--configuration")[0] ?? "Debug";
const testMode = (take("--test-mode")[0] ?? "1") !== "0";

if (!runInputs.length) {
  console.error("usage: summarize-probe-runs.mjs --runs <file|dir>... [--gestures <log>] [--tier t] [--sha s] [--json out] [--md out]");
  process.exit(2);
}

function collect(input) {
  const stat = fs.statSync(input);
  if (stat.isDirectory()) {
    return fs.readdirSync(input).filter((f) => f.endsWith(".json")).map((f) => path.join(input, f));
  }
  return [input];
}

// The app container keeps every export it ever wrote; --since <epoch ms>
// keeps only the runs this session started.
const since = Number(take("--since")[0] ?? 0) || 0;
const runs = runInputs
  .flatMap(collect)
  .map((file) => ({ file, data: JSON.parse(fs.readFileSync(file, "utf8")) }))
  .filter((run) => !since || Number(run.data.started_at_epoch_ms ?? 0) >= since);
const windows = runs.flatMap((r) => r.data.windows.map((w) => ({ ...w, run_id: r.data.run_id })));
const idle = runs.flatMap((r) => r.data.idle_by_route.map((w) => ({ ...w, run_id: r.data.run_id })));

const gestures = [];
// The keyboard's settled geometry, in points, from the lane that opened it: the
// composer must sit right above the keyboard's edge, so the gap is a number
// the summary carries, not a log line.
const keyboardGeometry = [];
if (gestureLog && fs.existsSync(gestureLog)) {
  const text = fs.readFileSync(gestureLog, "utf8");
  for (const m of text.matchAll(/PERF_GESTURE name=(\S+) rep=(\d+) start_epoch_ms=(\d+) end_epoch_ms=(\d+)/g)) {
    gestures.push({ name: m[1], rep: Number(m[2]), start: Number(m[3]), end: Number(m[4]) });
  }
  for (const m of text.matchAll(/PERF_KEYBOARD_GEOMETRY ([^\n]*)/g)) {
    const fields = Object.fromEntries([...m[1].matchAll(/(\w+)=(-?\d+)/g)].map((f) => [f[1], Number(f[2])]));
    keyboardGeometry.push({
      window_h: fields.window_h ?? null,
      keyboard_top: fields.keyboard_top ?? null,
      key_rows_top: fields.key_rows_top ?? null,
      composer_bottom: fields.composer_bottom ?? null,
      gap_pt: fields.gap ?? null,
    });
  }
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10;
}

function aggregate(groupWindows) {
  const frames = groupWindows.reduce((s, w) => s + w.frames, 0);
  const over50 = groupWindows.reduce((s, w) => s + w.over_50_count, 0);
  return {
    windows: groupWindows.length,
    frames,
    p95_ms_median: median(groupWindows.map((w) => w.p95_ms)),
    p99_ms_median: median(groupWindows.map((w) => w.p99_ms)),
    max_ms: Math.max(0, ...groupWindows.map((w) => w.max_ms)),
    over_50_count: over50,
    hitch_ms_per_s_median: median(groupWindows.map((w) => w.raf_hitch_ms_per_s)),
    longtask_count: groupWindows.reduce((s, w) => s + (w.longtask?.count ?? 0), 0) || null,
  };
}

const byGesture = new Map();
if (gestures.length) {
  for (const g of gestures) {
    const overlapping = windows.filter((w) => w.start_epoch_ms <= g.end && w.end_epoch_ms >= g.start);
    const key = g.name;
    byGesture.set(key, [...(byGesture.get(key) ?? []), ...overlapping]);
  }
} else {
  for (const w of windows) byGesture.set(w.kind, [...(byGesture.get(w.kind) ?? []), w]);
}

const rows = [...byGesture.entries()].map(([name, ws]) => ({ name, ...aggregate(ws) }));
const idleRows = idle.map((w) => ({ route: w.route, frames: w.frames, p95_ms: w.p95_ms, max_ms: w.max_ms, over_50_count: w.over_50_count }));
const hz = runs[0]?.data.raf_hz ?? null;
// A run certifies only when all three hold: real hardware, a Release build,
// and the test-mode bridge off. The XCUITest card always has the bridge on.
const simulator = tier.includes("sim");
// A `next build --profile` bundle reports React commits; it attributes and
// never certifies (the profiling build adds work of its own).
const reactProfiling = runs.some((r) => r.data.react_profiling === true);
// An attribution experiment changes the page's behaviour for the launch, so
// its numbers isolate a cost and certify nothing.
const experiments = [...new Set(runs.flatMap((r) => r.data.experiments ?? []))];
const certifies = !simulator && configuration === "Release" && !testMode && !reactProfiling && experiments.length === 0;
const laneSentence = certifies
  ? "Device run, Release, test mode off: certifying."
  : simulator
    ? "**Simulator run: attribution only, certifies nothing.**"
    : experiments.length
      ? `**Device run, ${configuration}, experiment ${experiments.join("+")} on: attribution only, certifies nothing.**`
      : reactProfiling
        ? `**Device run, ${configuration}, React profiling build: attribution only, certifies nothing.**`
        : `**Device run, ${configuration}${testMode ? " + test mode" : ""}: attribution only, certifies nothing.**`;

// Route-enter attribution: every window that carried a route change, with the
// destination's first commit and first frame, and the commits inside the
// window (profiling build) or just the frame numbers (any build).
const routeEnterRows = [];
for (const [name, ws] of byGesture.entries()) {
  for (const w of ws) {
    if (!w.route_enter) continue;
    const commits = w.commits ?? { count: 0, total_ms: 0, max_ms: 0, top: [] };
    routeEnterRows.push({
      gesture: name,
      route: w.route_enter.route,
      first_commit_ms: w.route_enter.first_commit_ms,
      first_frame_ms: w.route_enter.first_frame_ms,
      window_max_ms: w.max_ms,
      commits: commits.count,
      commits_total_ms: commits.total_ms,
      top_commits: (commits.top ?? []).map((c) => `${c.actual_ms} (${c.phase})`).join(", "),
    });
  }
}
routeEnterRows.sort((a, b) => (b.first_frame_ms ?? 0) - (a.first_frame_ms ?? 0));

// One row per stalled window: the worst frames with their offsets, the
// longest event-timing entries by name, the element count. This is what
// tells a React commit from a style pass from an event handler.
const stallRows = [];
for (const w of windows) {
  if (!(w.over_50_count > 0) || !Array.isArray(w.worst_frames) || w.worst_frames.length === 0) continue;
  const gesture = gestures.find((g) => w.start_epoch_ms >= g.start - 300 && w.start_epoch_ms <= g.end + 300);
  const worst = w.worst_frames.map((f) => `${f.gap_ms} ms @ ${f.at_ms} ms`).join(", ");
  const top = w.event_timing?.top ?? [];
  const event = top.length
    ? top.map((e) => `${e.name} ${e.duration_ms} ms (handler ${e.processing_ms}) @ ${e.at_ms} ms`).join(", ")
    : "-";
  const commits = w.commits?.count ? `${w.commits.count} / ${w.commits.total_ms} ms (max ${w.commits.max_ms})` : "0";
  stallRows.push({ gesture: gesture?.name ?? "(none)", kind: w.kind, worst, event, dom_nodes: w.dom_nodes ?? null, commits });
}
const verdict = (r) => (r.over_50_count > 0 || (r.hitch_ms_per_s_median ?? 0) >= 10 ? "critical" : (r.hitch_ms_per_s_median ?? 0) >= 5 || (hz && r.p95_ms_median > hz.budget_ms) ? "warning" : "good");

const summary = {
  schema_version: "hushh-render-perf-baseline-v1",
  label,
  source_sha: sha,
  captured_at: new Date().toISOString(),
  device: { tier, certifies, configuration, test_mode: testMode, raf_hz: hz, platform: runs[0]?.data.platform ?? null, ua_family: runs[0]?.data.ua_family ?? null, supported_entry_types: runs[0]?.data.supported_entry_types ?? [] },
  runs: runs.map((r) => ({ run_id: r.data.run_id, windows: r.data.windows.length, hud: r.data.hud })),
  gestures: rows.map((r) => ({ ...r, verdict: verdict(r) })),
  idle_by_route: idleRows,
  react_profiling: reactProfiling,
  experiments,
  route_enter: routeEnterRows,
  keyboard_geometry: keyboardGeometry,
  stalls: stallRows,
};

const md = [
  `# Render performance baseline (${tier})${label ? ` — ${label}` : ""}`,
  "",
  `Captured ${summary.captured_at}${sha ? ` at ${sha}` : ""}. ${laneSentence} rAF ${hz ? `${hz.raw} Hz (nominal ${hz.nominal}, budget ${hz.budget_ms} ms)` : "n/a"}; engine ${summary.device.ua_family ?? "n/a"}.`,
  "",
  "| Gesture | Windows | Frames | p95 ms (median) | p99 ms (median) | Worst ms | Frames > 50 ms | Hitch ms/s (median) | Verdict |",
  "|---|---|---|---|---|---|---|---|---|",
  ...summary.gestures.map((r) => `| ${r.name} | ${r.windows} | ${r.frames} | ${r.p95_ms_median ?? "-"} | ${r.p99_ms_median ?? "-"} | ${r.max_ms} | ${r.over_50_count} | ${r.hitch_ms_per_s_median ?? "-"} | ${r.verdict} |`),
  "",
  "Idle (no gesture in flight), by route:",
  "",
  "| Route | Frames | p95 ms | Worst ms | Frames > 50 ms |",
  "|---|---|---|---|---|",
  ...idleRows.map((r) => `| ${r.route} | ${r.frames} | ${r.p95_ms} | ${r.max_ms} | ${r.over_50_count} |`),
  "",
  ...(stallRows.length
    ? [
        "Stalls (windows with a frame over 50 ms): where the worst frame sits, the longest event handler, the document's size.",
        "",
        "| Gesture | Kind | Worst frame | Longest event | Elements | Commits |",
        "|---|---|---|---|---|---|",
        ...stallRows.map(
          (r) =>
            `| ${r.gesture} | ${r.kind} | ${r.worst} | ${r.event} | ${r.dom_nodes ?? "-"} | ${r.commits} |`,
        ),
        "",
      ]
    : []),
  ...(keyboardGeometry.length
    ? [
        "Keyboard (settled, points): composer field bottom to keyboard top.",
        "",
        "| Window h | Keyboard top | Key rows top | Composer bottom | Gap |",
        "|---|---|---|---|---|",
        ...keyboardGeometry.map((k) => `| ${k.window_h} | ${k.keyboard_top} | ${k.key_rows_top ?? "-"} | ${k.composer_bottom} | ${k.gap_pt} |`),
        "",
      ]
    : []),
  ...(routeEnterRows.length
    ? [
        `Route enter attribution (${reactProfiling ? "React profiling build: commits are real" : "no profiling build: commit columns empty"}):`,
        "",
        "| Gesture | Route | First commit ms | First frame ms | Worst frame ms | Commits | Commits total ms | Top commits |",
        "|---|---|---|---|---|---|---|---|",
        ...routeEnterRows.map(
          (r) =>
            `| ${r.gesture} | ${r.route} | ${r.first_commit_ms ?? "-"} | ${r.first_frame_ms ?? "-"} | ${r.window_max_ms} | ${r.commits} | ${r.commits_total_ms} | ${r.top_commits || "-"} |`,
        ),
        "",
      ]
    : []),
].join("\n");

if (jsonOut) fs.writeFileSync(jsonOut, `${JSON.stringify(summary, null, 2)}\n`);
if (mdOut) fs.writeFileSync(mdOut, `${md}\n`);
console.log(md);
