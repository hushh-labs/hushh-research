#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
const repoRuntimeRoot = path.resolve(packageDir, "..", "..", "consent-protocol");
const vendoredRuntimeRoot = path.join(packageDir, "vendor", "consent-protocol");
const runtimeRoot = fs.existsSync(path.join(repoRuntimeRoot, "mcp_server.py"))
  ? repoRuntimeRoot
  : vendoredRuntimeRoot;
const agentforceOutputPath = path.join(
  packageDir,
  "gateway",
  "hushh-agentforce-mcp-manifest.json",
);

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
  tools: contract.tools.map(({ name, description, inputSchema, outputSchema }) => ({
    name,
    description,
    inputSchema,
    outputSchema,
  })),
};

function loadAgentforceContract() {
  if (!fs.existsSync(path.join(runtimeRoot, "mcp_modules", "agentforce_contract.py"))) {
    throw new Error("Agentforce MCP contract is unavailable");
  }
  const python = process.env.HUSHH_MCP_PYTHON || "python3";
  const result = spawnSync(
    python,
    [
      "-c",
      [
        "import json",
        "from mcp_modules.agentforce_contract import agentforce_contract_errors, get_agentforce_contract, get_mulesoft_agentforce_handoff",
        "errors = agentforce_contract_errors()",
        "if errors:",
        "    raise SystemExit('; '.join(errors))",
        "print(json.dumps({'contract': get_agentforce_contract(), 'mulesoftAgentforceHandoff': get_mulesoft_agentforce_handoff()}, separators=(',', ':')))"
      ].join("\n"),
    ],
    {
      cwd: runtimeRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PYTHONPATH: [runtimeRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      },
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Could not generate Agentforce MCP contract: ${result.stderr || result.error?.message || "unknown error"}`,
    );
  }
  return JSON.parse(result.stdout);
}

const agentforceProjection = loadAgentforceContract();
const agentforceContract = agentforceProjection.contract;
const agentforceManifest = {
  profile: "agentforce-uat",
  supportStatus: "schema-compatible-uat-only",
  protocolVersion: manifest.protocolVersion,
  transport: manifest.transport,
  capabilities: {
    tools: true,
    resources: false,
    prompts: false,
    logging: false,
  },
  mulesoftAgentforceHandoff: agentforceProjection.mulesoftAgentforceHandoff,
  tools: agentforceContract.tools.map(
    ({ name, title, description, inputSchema, outputSchema, annotations }) => ({
      name,
      title,
      description,
      inputSchema,
      outputSchema,
      annotations,
    }),
  ),
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(agentforceOutputPath, `${JSON.stringify(agentforceManifest, null, 2)}\n`);

if (process.argv.includes("--print")) {
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv.includes("--print-agentforce")) {
  process.stdout.write(`${JSON.stringify(agentforceManifest, null, 2)}\n`);
}
