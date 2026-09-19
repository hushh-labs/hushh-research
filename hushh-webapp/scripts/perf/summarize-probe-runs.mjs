#!/usr/bin/env node
/**
 * Turn the in-app probe's exports into a baseline table.
 *
 *   node scripts/perf/summarize-probe-runs.mjs --runs <dir-or-file>... [--gestures <log>] [--tier ios-sim] [--sha <sha>] [--json <out.json>] [--md <out.md>]
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

const runs = runInputs.flatMap(collect).map((file) => ({ file, data: JSON.parse(fs.readFileSync(file, "utf8")) }));
const windows = runs.flatMap((r) => r.data.windows.map((w) => ({ ...w, run_id: r.data.run_id })));
const idle = runs.flatMap((r) => r.data.idle_by_route.map((w) => ({ ...w, run_id: r.data.run_id })));

const gestures = [];
if (gestureLog && fs.existsSync(gestureLog)) {
  const text = fs.readFileSync(gestureLog, "utf8");
  for (const m of text.matchAll(/PERF_GESTURE name=(\S+) rep=(\d+) start_epoch_ms=(\d+) end_epoch_ms=(\d+)/g)) {
    gestures.push({ name: m[1], rep: Number(m[2]), start: Number(m[3]), end: Number(m[4]) });
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
const verdict = (r) => (r.over_50_count > 0 || (r.hitch_ms_per_s_median ?? 0) >= 10 ? "critical" : (r.hitch_ms_per_s_median ?? 0) >= 5 || (hz && r.p95_ms_median > hz.budget_ms) ? "warning" : "good");

const summary = {
  schema_version: "hushh-render-perf-baseline-v1",
  label,
  source_sha: sha,
  captured_at: new Date().toISOString(),
  device: { tier, certifies: !tier.includes("sim"), raf_hz: hz, platform: runs[0]?.data.platform ?? null, ua_family: runs[0]?.data.ua_family ?? null, supported_entry_types: runs[0]?.data.supported_entry_types ?? [] },
  runs: runs.map((r) => ({ run_id: r.data.run_id, windows: r.data.windows.length, hud: r.data.hud })),
  gestures: rows.map((r) => ({ ...r, verdict: verdict(r) })),
  idle_by_route: idleRows,
};

const md = [
  `# Render performance baseline (${tier})${label ? ` — ${label}` : ""}`,
  "",
  `Captured ${summary.captured_at}${sha ? ` at ${sha}` : ""}. ${summary.device.certifies ? "Device run." : "**Simulator run: attribution only, certifies nothing.**"} rAF ${hz ? `${hz.raw} Hz (nominal ${hz.nominal}, budget ${hz.budget_ms} ms)` : "n/a"}; engine ${summary.device.ua_family ?? "n/a"}.`,
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
].join("\n");

if (jsonOut) fs.writeFileSync(jsonOut, `${JSON.stringify(summary, null, 2)}\n`);
if (mdOut) fs.writeFileSync(mdOut, `${md}\n`);
console.log(md);
