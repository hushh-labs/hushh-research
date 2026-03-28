const fs = require("node:fs");
const path = require("node:path");

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function average(values) {
  if (!values.length) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function formatMs(value) {
  return value == null ? "n/a" : `${value}ms`;
}

function summarizeReport(report) {
  if (!report) return null;
  const coldRoutes = (report.routes || []).filter((route) => !route.skipped && !route.error);
  const hotRoutes = (report.hotRoutes || []).filter((route) => !route.skipped && !route.error);
  const coldAverage = average(coldRoutes.map((route) => route.durationMs || 0));
  const hotAverage = average(hotRoutes.map((route) => route.durationMs || 0));
  const slowest = [...coldRoutes]
    .sort((left, right) => (right.durationMs || 0) - (left.durationMs || 0))
    .slice(0, 8);

  return {
    variant: report.variant,
    baseUrl: report.runtime?.baseUrl || "n/a",
    coldAverage,
    hotAverage,
    failures: report.failures?.length || 0,
    mismatches: report.runtime?.mismatches?.length || 0,
    slowest,
    hotRoutes,
  };
}

function buildComparisonTable(devSummary, prodSummary) {
  const lines = [
    "| Metric | Dev | Prod |",
    "| --- | ---: | ---: |",
    `| Cold-route average | ${formatMs(devSummary?.coldAverage)} | ${formatMs(prodSummary?.coldAverage)} |`,
    `| Hot-route average | ${formatMs(devSummary?.hotAverage)} | ${formatMs(prodSummary?.hotAverage)} |`,
    `| Runtime token mismatches | ${devSummary?.mismatches ?? "n/a"} | ${prodSummary?.mismatches ?? "n/a"} |`,
    `| Audit failures | ${devSummary?.failures ?? "n/a"} | ${prodSummary?.failures ?? "n/a"} |`,
  ];
  return lines.join("\n");
}

function buildHotRouteTable(devSummary, prodSummary) {
  const byKey = new Map();
  for (const entry of devSummary?.hotRoutes || []) {
    byKey.set(`${entry.slug}:${entry.phase}`, { dev: entry, prod: null });
  }
  for (const entry of prodSummary?.hotRoutes || []) {
    const key = `${entry.slug}:${entry.phase}`;
    const current = byKey.get(key) || { dev: null, prod: null };
    current.prod = entry;
    byKey.set(key, current);
  }

  const rows = [...byKey.entries()].sort(([left], [right]) => left.localeCompare(right));
  const lines = [
    "| Hot route | Dev | Prod | Dev dup paths | Prod dup paths | Dev dup resource fetches | Prod dup resource fetches |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const [key, pair] of rows) {
    lines.push(
      `| ${key} | ${formatMs(pair.dev?.durationMs)} | ${formatMs(pair.prod?.durationMs)} | ${
        pair.dev?.requestAudit?.duplicates?.length ?? "n/a"
      } | ${pair.prod?.requestAudit?.duplicates?.length ?? "n/a"} | ${
        pair.dev?.resourceAudit?.duplicateNetworkFetches?.length ?? "n/a"
      } | ${pair.prod?.resourceAudit?.duplicateNetworkFetches?.length ?? "n/a"} |`
    );
  }
  return lines.join("\n");
}

function buildSlowestSection(label, summary) {
  const lines = [`## ${label} slowest cold routes`];
  if (!summary) {
    lines.push(`- Report missing`);
    return lines.join("\n");
  }
  if (!summary.slowest.length) {
    lines.push(`- None`);
    return lines.join("\n");
  }
  for (const route of summary.slowest) {
    lines.push(
      `- ${route.finalPath || route.route}: ${route.durationMs}ms | requests=${route.requestAudit?.total || 0} | duplicate paths=${route.requestAudit?.duplicates?.length || 0} | duplicate resource fetches=${route.resourceAudit?.duplicateNetworkFetches?.length || 0}`
    );
  }
  return lines.join("\n");
}

function main() {
  const outPath =
    process.argv[2] || "/tmp/hushh-audit/runtime-compare.md";
  const devReportPath =
    process.argv[3] || "/tmp/hushh-audit/runtime-audit/desktop-report.json";
  const prodReportPath =
    process.argv[4] || "/tmp/hushh-audit/runtime-audit-prod/desktop-report.json";

  const devSummary = summarizeReport(readJson(devReportPath));
  const prodSummary = summarizeReport(readJson(prodReportPath));

  const lines = [
    "# Dev vs Prod Runtime Comparison",
    "",
    `- Generated at: ${new Date().toISOString()}`,
    `- Dev report: ${devReportPath}`,
    `- Prod report: ${prodReportPath}`,
    "",
    "## KPI snapshot",
    buildComparisonTable(devSummary, prodSummary),
    "",
    "## Hot-route comparison",
    buildHotRouteTable(devSummary, prodSummary),
    "",
    buildSlowestSection("Dev", devSummary),
    "",
    buildSlowestSection("Prod", prodSummary),
  ];

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${lines.join("\n")}\n`);
  process.stdout.write(`${outPath}\n`);
}

main();
