#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const { buildCapabilityMatrix, renderGapReport, stableStringify } = require("./tri-flow-audit-lib.cjs");

const webRoot = path.resolve(__dirname, "..");
const matrixPath = path.join(webRoot, "tri-flow-capability-matrix.json");
const reportPath = path.join(webRoot, "tri-flow-gap-report.md");

const matrix = buildCapabilityMatrix();
const matrixText = stableStringify(matrix);
const reportText = renderGapReport(matrix);

fs.writeFileSync(matrixPath, matrixText);
fs.writeFileSync(reportPath, reportText);

console.log(`Wrote ${path.relative(process.cwd(), matrixPath)}`);
console.log(`Wrote ${path.relative(process.cwd(), reportPath)}`);
