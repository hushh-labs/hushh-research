#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const sourcePath = path.join(repoRoot, "scripts/native/native-ui-test-runner-source.js");
const outputPath = path.join(repoRoot, "ios/App/App/NativeUiTestRunnerScript.swift");

const source = fs.readFileSync(sourcePath, "utf8");

const swift = `import Foundation

enum NativeUiTestRunnerScript {
    static let source: String = #"""
${source}
"""#
}
`;

fs.writeFileSync(outputPath, swift);
console.log(`==> synced ${path.relative(repoRoot, outputPath)}`);
