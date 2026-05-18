import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(process.cwd(), "..");
const tmpDir = path.join(repoRoot, "tmp");
const jsonPath = path.join(tmpDir, "observability-sandbox-audit.latest.json");
const markdownPath = path.join(tmpDir, "observability-sandbox-audit.latest.md");

mkdirSync(tmpDir, { recursive: true });

const vitest = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["vitest", "run", "__tests__/services/observability-sandbox-audit.test.ts"],
  {
    cwd: process.cwd(),
    stdio: "inherit",
    env: {
      ...process.env,
      OBSERVABILITY_SANDBOX_REPORT_JSON: jsonPath,
    },
  }
);

if (vitest.status !== 0) {
  process.exit(vitest.status ?? 1);
}

const report = JSON.parse(readFileSync(jsonPath, "utf-8"));

const renderLatency = (label, summary) =>
  `- ${label}: min \`${summary.min} ms\`, p50 \`${summary.p50} ms\`, p95 \`${summary.p95} ms\`, max \`${summary.max} ms\``;

const eventRows = Object.entries(report.eventsByName)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([name, count]) => `- \`${name}\`: \`${count}\``)
  .join("\n");

const scenarioRows = report.scenariosValidated.map((scenario) => `- \`${scenario}\``).join("\n");

const markdown = `# Observability Sandbox Audit

Generated: \`${report.generatedAt}\`

## Scope

- mode: \`${report.sandboxMode}\`
- measurement ID resolved: \`${report.measurementId}\`
- GTM container resolved: \`${report.gtmContainerId || "none"}\`
- transport owner: \`${report.transportOwner}\`
- external analytics requests sent: \`${report.networkRequestsSent}\`

This audit validates local web observability transport only. It does not send events to GA4, does not affect reporting numbers, and does not prove live property ingestion.

## Result

- status: \`${report.status}\`
- scenarios validated: \`${report.scenariosValidated.length}\`
- emitted events captured: \`${report.dispatchLatencyMs.count}\`

## Validated Scenarios

${scenarioRows}

## Event Coverage

${eventRows}

## Client Dispatch Latency

${renderLatency("dataLayer handoff", report.dispatchLatencyMs.dataLayer)}
${"\n"}${renderLatency("gtag handoff", report.dispatchLatencyMs.gtag)}
${"\n"}${renderLatency("track call return", report.dispatchLatencyMs.callReturn)}

## Interpretation

- dataLayer and direct gtag were both exercised for the representative investor and RIA journeys.
- GTM stayed out of the path because the configured GTM ID was intentionally placeholder-only.
- The measured latencies are client-side dispatch overhead, not GA ingestion latency.
- This is the correct pre-release proof when the current build has not yet been deployed and reporting numbers must stay untouched.
`;

writeFileSync(markdownPath, markdown, "utf-8");

console.log(`Sandbox audit report written to ${jsonPath}`);
console.log(`Sandbox audit summary written to ${markdownPath}`);
