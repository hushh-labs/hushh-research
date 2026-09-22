#!/usr/bin/env node
/**
 * Turn one `dumpsys gfxinfo <package> framestats` capture into a small JSON.
 *
 *   node scripts/perf/parse-gfxinfo.mjs --in <dump.txt> --name <gesture> [--out <json>]
 *
 * gfxinfo is HWUI's own account of the app's frames (the WebView draws into
 * the app's surface through HWUI, so a DOM scroll is counted here too). The
 * process-wide block after `dumpsys gfxinfo <pkg> reset` covers exactly the
 * frames rendered since the reset. Reported: total frames, janky frames and
 * their share, the 50th/90th/95th/99th percentile frame times, the missed
 * vsync / slow UI thread / deadline counters, and frames at or over 50 ms
 * summed from the histogram buckets. Nothing in the dump is personal.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function parseGfxinfo(text) {
  // Only the process-wide block: it ends at the first per-window "Window:" line.
  const head = text.split(/\nWindow: /)[0];
  const num = (re) => {
    const m = head.match(re);
    return m ? Number(m[1]) : null;
  };
  const janky = head.match(/Janky frames: (\d+) \(([\d.]+)%\)/);
  const histogram = head.match(/^HISTOGRAM: (.*)$/m)?.[1] ?? "";
  let over50 = 0;
  let over33 = 0;
  for (const m of histogram.matchAll(/(\d+)ms=(\d+)/g)) {
    const bucket = Number(m[1]);
    const count = Number(m[2]);
    if (bucket >= 50) over50 += count;
    if (bucket >= 33) over33 += count;
  }
  return {
    total_frames: num(/Total frames rendered: (\d+)/),
    janky_frames: janky ? Number(janky[1]) : null,
    janky_pct: janky ? Number(janky[2]) : null,
    p50_ms: num(/50th percentile: (\d+)ms/),
    p90_ms: num(/90th percentile: (\d+)ms/),
    p95_ms: num(/95th percentile: (\d+)ms/),
    p99_ms: num(/99th percentile: (\d+)ms/),
    missed_vsync: num(/Number Missed Vsync: (\d+)/),
    slow_ui_thread: num(/Number Slow UI thread: (\d+)/),
    slow_draw_commands: num(/Number Slow issue draw commands: (\d+)/),
    frame_deadline_missed: num(/Number Frame deadline missed: (\d+)/),
    frames_over_33_ms: over33,
    frames_over_50_ms: over50,
    pipeline: head.match(/Pipeline=(.+)/)?.[1]?.trim() ?? null,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const take = (flag) => {
    const i = args.indexOf(flag);
    return i === -1 ? null : args[i + 1];
  };
  const input = take("--in");
  const name = take("--name") ?? "gesture";
  const out = take("--out");
  if (!input || !fs.existsSync(input)) {
    console.error("usage: parse-gfxinfo.mjs --in <framestats dump> --name <gesture> [--out <json>]");
    process.exit(2);
  }
  const parsed = { name, ...parseGfxinfo(fs.readFileSync(input, "utf8")) };
  const json = `${JSON.stringify(parsed, null, 2)}\n`;
  if (out) fs.writeFileSync(out, json);
  else process.stdout.write(json);
}
