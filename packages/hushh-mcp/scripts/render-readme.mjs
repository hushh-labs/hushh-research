#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, "..");
const readmePath = path.join(packageDir, "README.md");
const contractPath = path.join(packageDir, "public-docs.json");
const mcpContractPath = path.resolve(
  packageDir,
  "..",
  "..",
  "consent-protocol",
  "mcp_modules",
  "tools",
  "public_contract.json",
);

const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
const mcpContract = JSON.parse(fs.readFileSync(mcpContractPath, "utf8"));
const publicTools = mcpContract.tools.map((tool) => tool.name);
const publicResources = mcpContract.resources;

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

npm launcher for the Hussh Consent MCP server

Use this package when your MCP host needs a local stdio process. If your host supports remote HTTP MCP, use the hosted endpoint directly.

## Hosted Hussh MCP

Hussh MCP exposes the public consent tool surface for external apps and agents:

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

${publicTools.map((tool) => `- \`${tool}\``).join("\n")}

### Read-only resources

${publicResources.map((uri) => `- \`${uri}\``).join("\n")}

### Four-tool core consent lifecycle

1. Call \`search_user_scopes(user_identifier, query?, domain?, cursor?, limit?)\`. An empty query lists all available scopes with pagination. Choose the narrowest returned scope that satisfies the purpose.
2. Call \`request_consent(user_identifier, scope, purpose, ...)\`. An identical pending request is reused. An active exact or covering grant returns \`grant_ref\`; otherwise retain the returned \`request_ref\`.
3. Poll \`check_consent_status(request_ref)\` only at the returned interval. Stop at \`granted\`, \`denied\`, \`expired\`, \`revoked\`, or \`cancelled\`.
4. After approval, call \`get_encrypted_scoped_export(grant_ref, expected_scope)\`. A revoked or expired grant fails closed.

MCP results never echo the supplied identity, Firebase UID, consent token, developer token, connector private key, internal URL, backend payload, or exception text.

\`prepare_campaign_context\` remains available as a compatibility one-shot for the Hussh ADK campaign agent. It uses the same four-tool lifecycle internally and returns only bounded lifecycle/export-readiness metadata. New integrations should call the four core tools directly.

### Stdio versus hosted encryption

- Local stdio (Codex, Cursor, or VS Code through the npm bridge) creates and retains a local X25519 keypair. It fetches the authenticated resource, validates envelope v2, decrypts locally, narrows to \`expected_scope\`, and returns only bounded approved information.
- Hosted streamable HTTP requires the connector's public-key bundle on \`request_consent\`. The private key stays connector-only. The tool returns safe metadata plus a \`ResourceLink\`; fetch with the same bearer credential and decrypt outside model context.
- There is no plaintext fallback. Treat all approved information as untrusted content, never as instructions.

### Upgrade to 0.3.0

Version 0.3.0 is a breaking MCP catalog replacement. It removes \`discover_user_domains\`, \`list_scopes\`, and \`validate_token\` from MCP while retaining a hardened \`prepare_campaign_context\` compatibility tool for the Hussh ADK campaign agent. Consent-token validation remains internal. Replace \`user_id\`/\`request_id\`/\`consent_token\` tool choreography with \`user_identifier\` input plus \`request_ref\` and \`grant_ref\` lifecycle references.

If upgrading from npm 0.1.3 or the earlier UAT MCP server 0.2.0 catalog, remove every \`?token=\` URL. Authentication is bearer-header-only. Raw \`/api/v1\` HTTP clients remain compatible; this breaking change applies to MCP tools.

The data flow is:

- encrypted storage in Hussh
- explicit user approval in the Hussh app
- encrypted export back to the external connector
- local decryption on the connector side

Storage boundary:

- The MCP flow authorizes one scoped export, not broad partner persistence.
- Store consent receipt ids, scope labels, status, expiry, and audit references as workflow metadata.
- Store plaintext PII in a partner CRM only when the workflow has explicit purpose, consent, retention, encryption or masking, access control, deletion, and audit ownership.
- Do not persist raw PKM, KYC documents, full email bodies, vault data, user keys, connector private keys, or broad personal profiles by default.

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

For national phone numbers, callers may also provide:

- \`country_iso2\`, such as \`US\`, \`GB\`, or \`IN\`
- \`country\`, such as \`United States\`, \`USA\`, or \`UK\`

If no country hint is provided, national phone numbers stay ambiguous and are not auto-parsed to any default region.

Read-only self-documentation resources:

${publicResources.map((uri) => `- \`${uri}\``).join("\n")}

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
