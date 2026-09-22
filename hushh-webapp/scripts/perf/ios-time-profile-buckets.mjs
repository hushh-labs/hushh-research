#!/usr/bin/env node
/**
 * Bucket an Instruments Time Profiler trace of the phone into what the web
 * engine's main thread was doing, per gesture window: JavaScript
 * (JavaScriptCore), WebCore (style, layout, paint, DOM), text and image
 * rasterisation (CoreGraphics, CoreText, ImageIO), compositing (QuartzCore),
 * WebKit process/IPC, and system waits. Frames from the shared cache come out
 * of xctrace unsymbolicated on a Mac without that iOS version's symbols, so
 * attribution is by binary load address (nearest lower load address; the
 * web frameworks are large and contiguous, so this is reliable at the
 * binary level). Self time uses the leaf frame; "JS on stack" counts samples
 * with any JavaScriptCore frame, which is JS-driven style/layout work too.
 *
 *   xcrun xctrace record --template 'Time Profiler' --device <udid> --all-processes \
 *     --time-limit 120s --no-prompt --output tmp/perf/<run>.trace
 *   node scripts/perf/ios-time-profile-buckets.mjs tmp/perf/<run>.trace \
 *     [--gestures tmp/perf/<run>/gestures.log] [--json out.json]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
const trace = args.find((a) => a.endsWith(".trace"));
if (!trace || !fs.existsSync(trace)) {
  console.error("usage: ios-time-profile-buckets.mjs <run.trace> [--gestures gestures.log] [--json out]");
  process.exit(1);
}
const take = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
};

const BUCKET_OF_BINARY = [
  ["javascript", /^JavaScriptCore$/],
  ["webcore", /^WebCore$/],
  ["raster", /^(CoreGraphics|CoreText|ImageIO|libFontParser|FontServices|CoreImage|Metal|libRIP)/],
  ["compositing", /^QuartzCore$/],
  ["webkit-ipc", /^WebKit$/],
  ["system-wait", /^(libsystem_kernel|libsystem_pthread|libdispatch)/],
  ["runtime", /^(libobjc|libswift|CoreFoundation|Foundation|libsystem_malloc|libsystem_c|libc\+\+)/],
];

function xctrace(arguments_) {
  return execFileSync("xcrun", ["xctrace", ...arguments_], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 * 1024 });
}

const toc = xctrace(["export", "--input", trace, "--toc"]);
const traceStartMs = Date.parse(toc.match(/<start-date>([^<]+)</)?.[1] ?? "");
const runNumber = toc.match(/<run number="(\d+)"/)?.[1] ?? "1";
const xml = xctrace(["export", "--input", trace, "--xpath", `/trace-toc/run[@number="${runNumber}"]/data/table[@schema="time-profile"]`]);

// Binaries with load addresses, sorted, for address-range attribution.
const binaries = [];
for (const m of xml.matchAll(/<binary id="\d+" name="([^"]*)"[^>]*load-addr="0x([0-9a-f]+)"/g)) {
  binaries.push({ name: m[1], load: BigInt(`0x${m[2]}`) });
}
binaries.sort((a, b) => (a.load < b.load ? -1 : a.load > b.load ? 1 : 0));
const loads = binaries.map((b) => b.load);
function binaryAt(addr) {
  let lo = 0;
  let hi = loads.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (loads[mid] <= addr) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return best === -1 ? "" : binaries[best].name;
}
function bucketOf(binary) {
  for (const [bucket, re] of BUCKET_OF_BINARY) if (re.test(binary)) return bucket;
  return "other";
}

// Frames are defined once with an id and reused by ref; keep a table.
const frameAddrById = new Map();
for (const m of xml.matchAll(/<frame id="(\d+)" name="[^"]*" addr="0x([0-9a-f]+)"/g)) {
  frameAddrById.set(m[1], BigInt(`0x${m[2]}`));
}
const backtraceById = new Map();

const gestures = [];
const gesturesPath = take("--gestures");
if (gesturesPath && fs.existsSync(gesturesPath) && Number.isFinite(traceStartMs)) {
  for (const line of fs.readFileSync(gesturesPath, "utf8").split("\n")) {
    const m = line.match(/PERF_GESTURE name=([a-z0-9-]+) rep=(\d+) start_epoch_ms=(\d+) end_epoch_ms=(\d+)/);
    if (m) gestures.push({ name: m[1], startNs: (Number(m[3]) - traceStartMs) * 1e6, endNs: (Number(m[4]) - traceStartMs) * 1e6 });
  }
}

const sampleTimeById = new Map();
const threadById = new Map();
const totals = new Map();
const bump = (key, bucket, jsOnStack) => {
  const t = totals.get(key) ?? { samples: 0, js_on_stack: 0, buckets: {} };
  t.samples += 1;
  t.buckets[bucket] = (t.buckets[bucket] ?? 0) + 1;
  if (jsOnStack) t.js_on_stack += 1;
  totals.set(key, t);
};

let mainThreadSamples = 0;
for (const row of xml.split("<row>").slice(1)) {
  const timeDef = row.match(/<sample-time id="(\d+)"[^>]*>(\d+)</);
  if (timeDef) sampleTimeById.set(timeDef[1], Number(timeDef[2]));
  const timeNs = timeDef ? Number(timeDef[2]) : sampleTimeById.get(row.match(/<sample-time ref="(\d+)"/)?.[1] ?? "");
  const threadDef = row.match(/<thread id="(\d+)" fmt="([^"]*)"/);
  if (threadDef) threadById.set(threadDef[1], threadDef[2]);
  const thread = threadDef ? threadDef[2] : threadById.get(row.match(/<thread ref="(\d+)"/)?.[1] ?? "") ?? "";
  if (!/Main Thread .*WebContent/.test(thread)) continue;
  mainThreadSamples += 1;

  let frames;
  const btDef = row.match(/<tagged-backtrace id="(\d+)">([\s\S]*?)<\/tagged-backtrace>/);
  if (btDef) {
    frames = [];
    for (const f of btDef[2].matchAll(/<frame (?:id="\d+" name="[^"]*" addr="0x([0-9a-f]+)"|ref="(\d+)")/g)) {
      frames.push(f[1] ? BigInt(`0x${f[1]}`) : frameAddrById.get(f[2]));
    }
    backtraceById.set(btDef[1], frames);
  } else {
    frames = backtraceById.get(row.match(/<tagged-backtrace ref="(\d+)"/)?.[1] ?? "") ?? [];
  }
  const leaf = frames.find((a) => a !== undefined);
  const leafBinary = leaf === undefined ? "" : binaryAt(leaf);
  const bucket = bucketOf(leafBinary);
  const jsOnStack = frames.some((a) => a !== undefined && binaryAt(a) === "JavaScriptCore");
  bump("all", bucket, jsOnStack);
  for (const g of gestures) if (timeNs >= g.startNs && timeNs <= g.endNs) bump(g.name, bucket, jsOnStack);
}

const pct = (n, d) => (d ? `${Math.round((n / d) * 1000) / 10}%` : "-");
const cols = ["javascript", "webcore", "raster", "compositing", "webkit-ipc", "runtime", "system-wait", "other"];
console.log(`trace start ${Number.isFinite(traceStartMs) ? new Date(traceStartMs).toISOString() : "unknown"}; ${mainThreadSamples} main-thread samples in WebContent; ${binaries.length} binaries; ${gestures.length} gesture windows aligned.`);
console.log(`| Window | Samples | ${cols.join(" | ")} | JS on stack |`);
console.log(`|---|---|${cols.map(() => "---").join("|")}|---|`);
for (const [key, t] of totals) {
  console.log(`| ${key} | ${t.samples} | ${cols.map((c) => pct(t.buckets[c] ?? 0, t.samples)).join(" | ")} | ${pct(t.js_on_stack, t.samples)} |`);
}
const jsonOut = take("--json");
if (jsonOut) fs.writeFileSync(jsonOut, `${JSON.stringify({ trace, totals: Object.fromEntries(totals) }, null, 2)}\n`);
