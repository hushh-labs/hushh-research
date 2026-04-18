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
    `Use when: ${example.whenToUse}`,
    "",
    `Keep local: ${renderTemplate(example.secretNote)}`,
    "",
    `\`\`\`${language}`,
    code,
    "```",
  ].join("\n");
}

const readme = `# \`${contract.packageName}\`

npm launcher for the Hushh Consent MCP server

Use this package when your MCP host needs a local stdio process. If your host supports remote HTTP MCP, use the hosted endpoint directly.

## Hosted Hushh MCP

Hushh MCP exposes the public consent tool surface for external apps and agents:

- dynamic scope discovery
- explicit consent requests
- consent status polling
- encrypted scoped export retrieval

This package bootstraps the same Python runtime that lives in this repo.

### Hosted UAT endpoint

The promoted public developer environment is **${contract.promotedEnvironment.label}**.

- app workspace: ${contract.promotedEnvironment.appUrl}/developers
- consent API origin: ${contract.promotedEnvironment.apiOrigin}
- remote MCP endpoint: \`${contract.promotedEnvironment.remoteUrlTemplate}\`
- npm package: \`${contract.packageName}\`
- canonical token env var: \`${contract.tokenEnvVar}\`

Use the trailing-slash form for remote MCP:

- \`${contract.promotedEnvironment.remoteUrlTemplate}\`
- not \`${contract.promotedEnvironment.mcpUrl}?token=<developer-token>\`

### Quick start

#### Remote MCP

Use this when the host supports HTTP MCP directly.

\`\`\`text
${contract.promotedEnvironment.remoteUrlTemplate}
\`\`\`

### npm Bridge

Use this when the host expects a local stdio MCP process.

\`\`\`bash
npx -y ${contract.packageName} --help
\`\`\`

Minimal env for stdio hosts:

\`\`\`bash
export CONSENT_API_URL=${contract.promotedEnvironment.apiOrigin}
export ${contract.tokenEnvVar}=<developer-token>
\`\`\`

To use an existing local runtime:

\`\`\`bash
export HUSHH_MCP_ENV_FILE=/absolute/path/to/consent-protocol/.env
npx -y ${contract.packageName}
\`\`\`

### Host setup examples

${contract.hostExamples.map(renderHostExample).join("\n\n")}

### Public tools

${contract.publicTools.map((tool) => `- \`${tool}\``).join("\n")}

### Read-only resources

${contract.publicResources.map((uri) => `- \`${uri}\``).join("\n")}

### Consent flow

1. Call \`discover_user_domains\`.
2. Request one returned scope with \`request_consent\`.
3. Wait for user approval in Kai.
4. Call \`check_consent_status\` and then \`get_encrypted_scoped_export\`.

The data flow is:

- encrypted storage in Hushh
- explicit user approval in Kai
- encrypted export back to the external connector
- local decryption on the connector side

## License

This package is licensed under \`${contract.license}\`.

The published npm tarball includes package-local \`LICENSE\` and \`NOTICE\` files for Apache redistribution.

## Self-hosted and contributor development

This package can also bootstrap a generic \`consent-protocol\` runtime for local development or self-hosted use.

Use this path when:

- you are developing against localhost
- you want to override the packaged runtime with a local checkout
- you are contributing to \`consent-protocol\`

### Runtime expectations

- Python 3 must be available locally.
- The first full stdio launch creates a local cache and installs the bundled Python requirements.
- Contributor-local flows still need the same backend configuration as \`consent-protocol\`.

Useful env vars:

- \`HUSHH_MCP_ENV_FILE\`: load runtime variables from an external \`.env\`
- \`HUSHH_MCP_RUNTIME_DIR\`: point at a local \`consent-protocol\` checkout
- \`HUSHH_MCP_CACHE_DIR\`: override the bootstrap cache directory
- \`HUSHH_MCP_PYTHON\`: choose a specific Python executable
- \`HUSHH_MCP_SKIP_BOOTSTRAP=1\`: skip venv creation and dependency install

### Repo-local fallback

Use repo-local Python only for contributor workflows:

\`\`\`bash
cd consent-protocol
python mcp_server.py
\`\`\`
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
