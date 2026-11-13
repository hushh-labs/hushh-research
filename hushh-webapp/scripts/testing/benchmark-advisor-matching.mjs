/** Reproducible synthetic scale probe of the production, import-safe matcher. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = await fs.readFile(path.join(root, "lib/advisor-review/matching.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { matchAdvisorServices } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const results = [];
for (const size of [100, 1000, 10000]) {
  const rows = Array.from({ length: size }, (_, index) => ({ userId: `sample-${index}`, personRef: `sample-${index}`, verified: true,
    servicesOffered: index >= size - 5 ? ["Retirement Planning"] : ["Tax Planning"] }));
  const timings = [];
  for (let repeat = 0; repeat < 101; repeat++) {
    const start = performance.now();
    const matches = matchAdvisorServices(rows, "retirement_planning", "owner");
    const elapsed = performance.now() - start;
    if (matches.length !== 5 || matches[0].advisor.userId !== `sample-${size - 5}`) throw new Error("Late-corpus matching regression");
    if (repeat) timings.push(elapsed);
  }
  timings.sort((a, b) => a - b);
  results.push({ advisors: size, p50_ms: +timings[49].toFixed(3), p95_ms: +timings[94].toFixed(3), p99_ms: +timings[98].toFixed(3), matches: 5 });
}
console.log(JSON.stringify({ kind: "synthetic in-process matching only; excludes network/database latency and suitability validation", results }, null, 2));
