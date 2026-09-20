#!/usr/bin/env node
/**
 * Print the performance metrics an XCTest `measure` block recorded, as a
 * table per test run: one row per metric with each iteration's value and the
 * median. Used for the third-party feed benchmark (Threads, X), whose numbers
 * come from XCTOSSignpostMetric.scrollDecelerationMetric and XCTCPUMetric and
 * live only in the .xcresult bundle.
 *
 *   node scripts/perf/summarize-xcresult-metrics.mjs <bundle.xcresult> [--md out.md] [--json out.json]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
const bundle = args.find((a) => a.endsWith(".xcresult"));
if (!bundle || !fs.existsSync(bundle)) {
  console.error("usage: summarize-xcresult-metrics.mjs <bundle.xcresult> [--md out.md] [--json out.json]");
  process.exit(1);
}
const take = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
};

const raw = execFileSync("xcrun", ["xcresulttool", "get", "test-results", "metrics", "--path", bundle, "--compact"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const parsed = JSON.parse(raw);
const tests = Array.isArray(parsed) ? parsed : (parsed.tests ?? parsed.testsWithMetrics ?? []);

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const round = (n) => (Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100);

const rows = [];
for (const test of tests) {
  for (const run of test.testRuns ?? []) {
    for (const metric of run.metrics ?? []) {
      const values = metric.measurements ?? [];
      if (!values.length) continue;
      rows.push({
        test: test.testIdentifier,
        device: run.device?.deviceName ?? "",
        metric: metric.displayName,
        unit: metric.unitOfMeasurement,
        iterations: values.map(round),
        median: round(median(values)),
      });
    }
  }
}

const md = [
  "| Test | Metric | Unit | Iterations | Median |",
  "|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.test} | ${r.metric} | ${r.unit} | ${r.iterations.join(", ")} | ${r.median} |`),
].join("\n");
console.log(md);
const mdOut = take("--md");
if (mdOut) fs.writeFileSync(mdOut, `${md}\n`);
const jsonOut = take("--json");
if (jsonOut) fs.writeFileSync(jsonOut, `${JSON.stringify({ bundle, rows }, null, 2)}\n`);
