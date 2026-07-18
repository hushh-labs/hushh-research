#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoContract = path.resolve(
  packageDir,
  "..",
  "..",
  "consent-protocol",
  "mcp_modules",
  "tools",
  "public_contract.json",
);
const vendoredContract = path.join(
  packageDir,
  "vendor",
  "consent-protocol",
  "mcp_modules",
  "tools",
  "public_contract.json",
);
const contractPath = fs.existsSync(repoContract) ? repoContract : vendoredContract;
const outputPath = path.join(packageDir, "gateway", "hushh-mcp-gateway.json");

if (!fs.existsSync(contractPath)) {
  throw new Error("Canonical MCP contract is unavailable");
}

const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
const manifest = {
  protocolVersion: "2025-11-25",
  transport: {
    kind: "streamableHttp",
    path: "/mcp/",
  },
  capabilities: {
    tools: true,
    resources: true,
    prompts: false,
    logging: false,
  },
  tools: contract.tools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  })),
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);

if (process.argv.includes("--print")) {
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}
