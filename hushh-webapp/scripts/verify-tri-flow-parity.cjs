#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const { buildCapabilityMatrix, renderGapReport, stableStringify } = require("./tri-flow-audit-lib.cjs");

const webRoot = path.resolve(__dirname, "..");
const matrixPath = path.join(webRoot, "tri-flow-capability-matrix.json");
const reportPath = path.join(webRoot, "tri-flow-gap-report.md");

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exitCode = 1;
}

function readIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
}

const matrix = buildCapabilityMatrix();
const expectedMatrix = stableStringify(matrix);
const expectedReport = renderGapReport(matrix);
const actualMatrix = readIfExists(matrixPath);
const actualReport = readIfExists(reportPath);

if (actualMatrix !== expectedMatrix) {
  fail(
    "tri-flow-capability-matrix.json is out of date. Run `node scripts/generate-tri-flow-audit.cjs`."
  );
}

if (actualReport !== expectedReport) {
  fail(
    "tri-flow-gap-report.md is out of date. Run `node scripts/generate-tri-flow-audit.cjs`."
  );
}

if (matrix.blockingGaps.length > 0) {
  for (const gap of matrix.blockingGaps) {
    fail(`[${gap.category}] ${gap.capabilityId} (${gap.route}): ${gap.detail}`);
  }
}

if (!process.exitCode) {
  console.log(
    `Tri-flow parity verified: ${matrix.summary.pageRouteCount} routes, ${matrix.summary.apiRouteCount} API routes, ${matrix.summary.blockingGapCount} blocking gaps`
  );
}
