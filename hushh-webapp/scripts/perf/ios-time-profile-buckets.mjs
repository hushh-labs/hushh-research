#!/usr/bin/env node
/**
 * Bucket an Instruments Time Profiler trace of the phone into what the web
 * engine was doing: JavaScript (JavaScriptCore), style, layout, paint and
 * compositing, per gesture window. Attribution for the JS-vs-render split
 * that neither the rAF probe nor Web Inspector gives without a person at a
 * Mac; function-level JS names are not available (JIT frames), the split is.
 *
 *   xcrun xctrace record --template 'Time Profiler' --device <udid> --all-processes \
 *     --time-limit 160s --output tmp/perf/<run>.trace
 *   node scripts/perf/ios-time-profile-buckets.mjs tmp/perf/<run>.trace \
 *     [--gestures tmp/perf/<run>/gestures.log] [--process WebContent] [--json out.json]
 *
 * Gesture windows come from the PERF_GESTURE lines (epoch ms); the trace's
 * own start date aligns them.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
const trace = args.find((a) => a.endsWith(".trace"));
if (!trace || !fs.existsSync(trace)) {
  console.error("usage: ios-time-profile-buckets.mjs <run.trace> [--gestures gestures.log] [--process WebContent] [--json out]");
  process.exit(1);
}
const take = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
};
const processFilter = take("--process") ?? "WebContent";

const BUCKETS = [
  ["javascript", /JSC::|JavaScriptCore|llint_|jsc_|\bJSObject|\bJSFunction|Interpreter::|DFG::|FTL::|Baseline/],
  ["style", /StyleResolver|Style::|resolveStyle|RenderTreeUpdater|StyleScope|computedStyle|matchAuthorRules|ElementRuleCollector/],
  ["layout", /::layout\(|LayoutIntegration|RenderBlock|RenderFlexibleBox|RenderGrid|LayoutUnit|FrameView::layout|LocalFrameView::layout|RenderLayer::update|updateLayout/],
  ["paint", /::paint|GraphicsContext|TextPainter|CGContext|drawGlyph|FillRect|drawImage|PaintPhase|RenderLayerBacking::paint/],
  ["compositing", /GraphicsLayerCA|TileController|TileGrid|RenderLayerCompositor|PlatformCALayer|CA::Layer|CALayer|flushCompositingState/],
  ["dom-events", /EventDispatcher|dispatchEvent|EventTarget::fire|scrollTo|ScrollingTree|EventHandler::/],
];

function xctrace(arguments_) {
  return execFileSync("xcrun", ["xctrace", ...arguments_], { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
}

const toc = xctrace(["export", "--input", trace, "--toc"]);
const startMatch = toc.match(/start-date="([^"]+)"/) ?? toc.match(/<start-date>([^<]+)</);
const traceStartMs = startMatch ? Date.parse(startMatch[1]) : NaN;
const runMatch = toc.match(/<run number="(\d+)"/);
const runNumber = runMatch ? runMatch[1] : "1";
const tableMatch = toc.match(/<table[^>]*schema="time-profile"[^>]*>/);
if (!tableMatch) {
  console.error("No time-profile table in this trace (was the Time Profiler template used?).");
  process.exit(1);
}

const xml = xctrace([
  "export", "--input", trace, "--xpath", `/trace-toc/run[@number="${runNumber}"]/data/table[@schema="time-profile"]`,
]);

// The export uses id/ref for repeated values; resolve symbols, process names
// and timestamps through a small id table.
const byId = new Map();
const register = (m) => { const id = m[1]; if (id) byId.set(id, m[2]); };
for (const m of xml.matchAll(/<(?:sample-time|start-time) id="(\d+)"[^>]*>([^<]+)</g)) register(m);
for (const m of xml.matchAll(/<process id="(\d+)"[^>]*fmt="([^"]*)"/g)) register(m);
for (const m of xml.matchAll(/<frame id="(\d+)"[^>]*name="([^"]*)"/g)) register(m);

const gestures = [];
const gesturesPath = take("--gestures");
if (gesturesPath && fs.existsSync(gesturesPath) && Number.isFinite(traceStartMs)) {
  for (const line of fs.readFileSync(gesturesPath, "utf8").split("\n")) {
    const m = line.match(/PERF_GESTURE name=([a-z0-9-]+) rep=(\d+) start_epoch_ms=(\d+) end_epoch_ms=(\d+)/);
    if (m) gestures.push({ name: m[1], rep: Number(m[2]), startNs: (Number(m[3]) - traceStartMs) * 1e6, endNs: (Number(m[4]) - traceStartMs) * 1e6 });
  }
}

const rows = xml.split("<row>").slice(1);
const totals = new Map();
const add = (key, bucket) => {
  const t = totals.get(key) ?? { samples: 0, buckets: Object.fromEntries(BUCKETS.map(([b]) => [b, 0])), other: 0 };
  t.samples += 1;
  if (bucket) t.buckets[bucket] += 1; else t.other += 1;
  totals.set(key, t);
};
let considered = 0;
for (const row of rows) {
  const timeRaw = row.match(/<sample-time(?: id="\d+")?[^>]*>([^<]+)</)?.[1] ?? byId.get(row.match(/<sample-time ref="(\d+)"/)?.[1] ?? "");
  const timeNs = Number(timeRaw);
  const processName = row.match(/<process id="\d+"[^>]*fmt="([^"]*)"/)?.[1] ?? byId.get(row.match(/<process ref="(\d+)"/)?.[1] ?? "") ?? "";
  if (!processName.includes(processFilter)) continue;
  considered += 1;
  const frames = [];
  for (const m of row.matchAll(/<frame id="\d+"[^>]*name="([^"]*)"/g)) frames.push(m[1]);
  for (const m of row.matchAll(/<frame ref="(\d+)"/g)) { const n = byId.get(m[1]); if (n) frames.push(n); }
  const stack = frames.join("\n");
  let bucket = null;
  for (const [name, re] of BUCKETS) { if (re.test(stack)) { bucket = name; break; } }
  add("all", bucket);
  for (const g of gestures) {
    if (timeNs >= g.startNs && timeNs <= g.endNs) add(g.name, bucket);
  }
}

const pct = (n, d) => (d ? `${Math.round((n / d) * 1000) / 10}%` : "-");
const out = [];
out.push(`| Window | Samples | JavaScript | Style | Layout | Paint | Compositing | Events | Other |`);
out.push(`|---|---|---|---|---|---|---|---|---|`);
for (const [key, t] of totals) {
  const b = t.buckets;
  out.push(`| ${key} | ${t.samples} | ${pct(b.javascript, t.samples)} | ${pct(b.style, t.samples)} | ${pct(b.layout, t.samples)} | ${pct(b.paint, t.samples)} | ${pct(b.compositing, t.samples)} | ${pct(b["dom-events"], t.samples)} | ${pct(t.other, t.samples)} |`);
}
console.log(`trace start ${Number.isFinite(traceStartMs) ? new Date(traceStartMs).toISOString() : "unknown"}; ${considered} samples in processes matching "${processFilter}"; ${gestures.length} gesture windows aligned.`);
console.log(out.join("\n"));
const jsonOut = take("--json");
if (jsonOut) fs.writeFileSync(jsonOut, `${JSON.stringify({ trace, process: processFilter, totals: Object.fromEntries(totals) }, null, 2)}\n`);
