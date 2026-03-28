const fs = require("node:fs");
const path = require("node:path");

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function formatMs(value) {
  return value == null ? "n/a" : `${value}ms`;
}

function toMap(entries = []) {
  const map = new Map();
  for (const entry of entries) {
    map.set(`${entry.slug}:${entry.phase}`, entry);
  }
  return map;
}

function buildCompare(devReport, prodReport) {
  const lines = [
    "# Dev vs Prod Hot Route Comparison",
    "",
    `- Generated at: ${new Date().toISOString()}`,
    `- Dev base URL: ${devReport?.baseUrl || "n/a"}`,
    `- Prod base URL: ${prodReport?.baseUrl || "n/a"}`,
    "",
    "## Cold-route comparison",
    "| Route | Persona | Dev | Prod | Dev cache | Prod cache | Dev dup paths | Prod dup paths | Dev dup resource fetches | Prod dup resource fetches |",
    "| --- | --- | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: |",
  ];

  const devCold = toMap(devReport?.routes || []);
  const prodCold = toMap(prodReport?.routes || []);
  const coldKeys = new Set([...devCold.keys(), ...prodCold.keys()]);
  for (const key of [...coldKeys].sort()) {
    const dev = devCold.get(key);
    const prod = prodCold.get(key);
    lines.push(
      `| ${dev?.finalPath || prod?.finalPath || dev?.route || prod?.route || key} | ${dev?.persona || prod?.persona || "n/a"} | ${formatMs(dev?.durationMs)} | ${formatMs(prod?.durationMs)} | ${dev?.cacheSource || "n/a"} | ${prod?.cacheSource || "n/a"} | ${dev?.requestAudit?.duplicates?.length ?? "n/a"} | ${prod?.requestAudit?.duplicates?.length ?? "n/a"} | ${dev?.resourceAudit?.duplicateNetworkFetches?.length ?? "n/a"} | ${prod?.resourceAudit?.duplicateNetworkFetches?.length ?? "n/a"} |`
    );
  }

  lines.push(
    "",
    "## Hot revisits",
    "| Route phase | Dev | Prod | Dev cache | Prod cache | Dev dup paths | Prod dup paths | Dev dup resource fetches | Prod dup resource fetches |",
    "| --- | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: |"
  );

  const devHot = toMap(devReport?.hotRoutes || []);
  const prodHot = toMap(prodReport?.hotRoutes || []);
  const hotKeys = new Set([...devHot.keys(), ...prodHot.keys()]);
  for (const key of [...hotKeys].sort()) {
    const dev = devHot.get(key);
    const prod = prodHot.get(key);
    lines.push(
      `| ${key} | ${formatMs(dev?.durationMs)} | ${formatMs(prod?.durationMs)} | ${dev?.cacheSource || "n/a"} | ${prod?.cacheSource || "n/a"} | ${dev?.requestAudit?.duplicates?.length ?? "n/a"} | ${prod?.requestAudit?.duplicates?.length ?? "n/a"} | ${dev?.resourceAudit?.duplicateNetworkFetches?.length ?? "n/a"} | ${prod?.resourceAudit?.duplicateNetworkFetches?.length ?? "n/a"} |`
    );
  }

  return `${lines.join("\n")}\n`;
}

function main() {
  const outPath = "/tmp/hushh-audit/runtime-hot/compare.md";
  const devReport = readJson("/tmp/hushh-audit/runtime-hot/devlocal-report.json");
  const prodReport = readJson("/tmp/hushh-audit/runtime-hot/prodlocal-report.json");
  const content = buildCompare(devReport, prodReport);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, content);
  process.stdout.write(`${outPath}\n`);
}

main();
