#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, "..");
const readmePath = path.join(packageDir, "README.md");
const contractPath = path.join(packageDir, "public-docs.json");

const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));

function renderTemplate(template) {
  return template
    .replaceAll("{{PACKAGE_NAME}}", contract.packageName)
    .replaceAll("{{API_ORIGIN}}", contract.promotedEnvironment.apiOrigin)
    .replaceAll("{{REMOTE_URL}}", contract.promotedEnvironment.remoteUrlTemplate)
    .replaceAll("{{TOKEN_ENV_VAR}}", contract.tokenEnvVar);
}

function renderHostExample(example) {
  const code = renderTemplate(example.template);
  const language =
    example.id.includes("json") || example.id === "npm-bridge" || example.id === "claude-desktop"
      ? "json"
      : example.id.includes("codex")
        ? example.id === "codex-remote"
          ? "bash"
          : "toml"
        : example.id === "raw-remote-url"
          ? "text"
          : "json";

  return [
    `### ${example.title}`,
    "",
    `**Use this when:** ${example.whenToUse}`,
    "",
    `**Keep local:** ${renderTemplate(example.secretNote)}`,
    "",
    `\`\`\`${language}`,
    code,
    "```",
  ].join("\n");
}

const readme = `# \`${contract.packageName}\`

Launch-friendly npm wrapper for the Hushh Consent MCP server.

This package is the public onboarding surface for Hushh MCP. It supports any MCP-capable host:

- use hosted remote MCP when the host supports HTTP MCP directly
- use the npm bridge when the host expects a local stdio process
- use the repo-local Python fallback only for contributor workflows

## What Hushh MCP Is

Hushh MCP exposes the public consent tool surface used by external apps and agents:

- dynamic scope discovery
- explicit consent requests
- consent status polling
- encrypted scoped export retrieval

The npm package does not replace the Python implementation in this repo. It bootstraps the same MCP runtime and keeps the public install story simple for hosts that still expect stdio.

## Public UAT Contract

The promoted public developer environment is **${contract.promotedEnvironment.label}** for now.

- app workspace: ${contract.promotedEnvironment.appUrl}/developers
- consent API origin: ${contract.promotedEnvironment.apiOrigin}
- remote MCP endpoint: \`${contract.promotedEnvironment.remoteUrlTemplate}\`
- npm package: \`${contract.packageName}\`
- canonical token env var: \`${contract.tokenEnvVar}\`

Use the trailing-slash mount form for remote MCP:

- \`${contract.promotedEnvironment.remoteUrlTemplate}\`
- not \`${contract.promotedEnvironment.mcpUrl}?token=<developer-token>\`

## Quick Start

### Remote MCP

Use remote MCP when the host supports HTTP MCP directly.

\`\`\`text
${contract.promotedEnvironment.remoteUrlTemplate}
\`\`\`

### npm Bridge

Use the npm bridge when the host still expects a local stdio MCP process.

\`\`\`bash
npx -y ${contract.packageName} --help
\`\`\`

Minimal env for stdio hosts:

\`\`\`bash
export CONSENT_API_URL=${contract.promotedEnvironment.apiOrigin}
export ${contract.tokenEnvVar}=<developer-token>
\`\`\`

Or point the launcher at an existing \`consent-protocol/.env\`:

\`\`\`bash
export HUSHH_MCP_ENV_FILE=/absolute/path/to/consent-protocol/.env
npx -y ${contract.packageName}
\`\`\`

## Host Setup Examples

${contract.hostExamples.map(renderHostExample).join("\n\n")}

## Public Tools And Resources

Public tools:

${contract.publicTools.map((tool) => `- \`${tool}\``).join("\n")}

Read-only MCP resources:

${contract.publicResources.map((uri) => `- \`${uri}\``).join("\n")}

## End-To-End Consent Example

1. Discover the user’s current scopes with \`discover_user_domains\`.
2. Request one discovered scope with \`request_consent\`, including your X25519 connector public key bundle.
3. Let the user approve the request inside Kai.
4. Poll with \`check_consent_status\`, validate with \`validate_token\`, then read the ciphertext with \`get_encrypted_scoped_export\`.

The public flow is always:

- encrypted storage in Hushh
- explicit user approval in Kai
- encrypted export back to the external connector
- local decryption on the connector side

## Runtime Expectations

- Python 3 must be available locally.
- The first full stdio launch creates a local cache and installs the bundled Python requirements.
- The runtime still needs the same backend configuration as \`consent-protocol\` when you are running contributor-local flows.

Useful env vars:

- \`HUSHH_MCP_ENV_FILE\`: load runtime variables from an external \`.env\`
- \`HUSHH_MCP_RUNTIME_DIR\`: point at a local \`consent-protocol\` checkout
- \`HUSHH_MCP_CACHE_DIR\`: override the bootstrap cache directory
- \`HUSHH_MCP_PYTHON\`: choose a specific Python executable
- \`HUSHH_MCP_SKIP_BOOTSTRAP=1\`: skip venv creation and dependency install

## Contributor-Local Fallback

If you are working inside this repo and do not want the npm bootstrap path:

\`\`\`bash
cd consent-protocol
python mcp_server.py
\`\`\`

## More Docs

- API reference: \`consent-protocol/docs/reference/developer-api.md\`
- Technical companion: \`consent-protocol/docs/mcp-setup.md\`
- Internal host operations: \`docs/reference/operations/coding-agent-mcp.md\`
`;

if (process.argv.includes("--check")) {
  const existing = fs.readFileSync(readmePath, "utf8");
  if (existing !== readme) {
    console.error("README.md is out of date. Run: node ./scripts/render-readme.mjs");
    process.exit(1);
  }
  process.exit(0);
}

fs.writeFileSync(readmePath, readme);
