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
const webPublicDocsPath = path.resolve(
  packageDir,
  "..",
  "..",
  "hushh-webapp",
  "lib",
  "developers",
  "public-docs.json",
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
    .replaceAll("{{TOKEN_ENV_VAR}}", contract.tokenEnvVar)
    .replaceAll("{{OAUTH_CLIENT_ID_ENV_VAR}}", contract.authentication.clientIdEnvVar)
    .replaceAll("{{OAUTH_CLIENT_SECRET_ENV_VAR}}", contract.authentication.clientSecretEnvVar);
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
- MCP protocol revision: \`${contract.mcpProtocolRevision}\`
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

### One canonical catalog and authentication

The same \`/mcp/\` endpoint publishes one generated v0.4 five-tool catalog to Codex, Claude, Agentforce, and the npm bridge. Bearer authentication remains first-class. OAuth PKCE and client credentials authenticate the same developer-app identity; they do not select a different consent product, endpoint, or lifecycle.

Self-serve applications may use a developer token or OAuth authorization code with S256 PKCE and rotating refresh tokens. Discover OAuth metadata at \`${contract.authentication.discoveryUrl}\`, request \`${contract.authentication.scope}\`, and send the resulting credential only as \`${contract.authentication.bearerHeader}\`. Query-string tokens are rejected. OAuth client credentials are reserved for operations-provisioned partner integrations and never grant vault or personal-information authority. The npm bridge exchanges \`${contract.authentication.clientIdEnvVar}\` and \`${contract.authentication.clientSecretEnvVar}\` locally at the token endpoint, retains the resulting Bearer token only in process memory, and renews it before expiry.

Every tool uses shallow, fully described JSON Schema. Successful calls return \`structuredContent\` as the canonical result and \`content[0].text\` as its compatibility mirror. Execution errors return \`isError: true\` with safe JSON text only, so a strict client never validates an error against a success output schema.

### MuleSoft trusted connector for Salesforce and Agentforce

A partner-authorized MuleSoft connector uses a dedicated Hussh execute app and a partner-controlled X25519 key. Its reviewed Java 17/JCA runtime is the selected decryption target: only the public key reaches Hussh, while Agentforce and Hussh never receive the connector private key.

\`hushh-mcp --print-agentforce-manifest\` remains a diagnostic preflight view of the canonical five-tool catalog. It is not the file to upload to Exchange.

The trusted connector uses all five tools internally. Agentforce reads the authorized Salesforce record or metadata-only delivery status, not individual personalized Hussh tools; Hussh does not publish a four-tool variant. \`get-encrypted-scoped-export\` stays in trusted MuleSoft code and out of the Agentforce planner/LLM. Successful MCP calls use \`structuredContent\`; \`content[0].text\` is only its compatibility mirror. Use \`hushh-mcp --print-mulesoft-agentforce-handoff\` for the selected UAT-gated connector guidance.

Direct Agentforce profiles are catalog-only. AgentExchange remains optional for a Salesforce action or user experience and is not required for decryption. Implement key custody, crypto, tool policy, and the MuleSoft/Salesforce UAT gate in [MuleSoft trusted connector for Salesforce and Agentforce](../../consent-protocol/docs/reference/mulesoft-agentforce-secure-relay.md).

Salesforce references: [MCP considerations](https://help.salesforce.com/s/articleView?id=ai.agent_mcp_considerations.htm&language=en_US&type=5), [MCP response schemas](https://help.salesforce.com/s/articleView?id=ai.agent_mcp_tool_action_design.htm&type=5), and [API Catalog MCP servers](https://help.salesforce.com/s/articleView?id=platform.api_catalog_manage_mcp_servers.htm&language=en_US&type=5).

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

### Five-tool consent lifecycle

1. Call \`search-user-scopes(user_identifier, query?, domain?, cursor?, limit?)\`. An empty query lists all available scopes with pagination. Choose the narrowest returned scope that satisfies the purpose.
2. Call \`prepare-campaign-context(user_identifier, ...)\` when an external agent or frontend needs a safe, least-privilege offer/context before approval.
3. Call \`request-consent(user_identifier, scope, purpose, ...)\`. An identical pending request is reused. An active exact or covering grant returns \`grant_ref\`; otherwise retain the returned \`request_ref\`.
4. Poll \`check-consent-status(request_ref)\` only at the returned interval. Stop at \`granted\`, \`denied\`, \`expired\`, \`revoked\`, or \`cancelled\`.
5. After approval, call \`get-encrypted-scoped-export(grant_ref, expected_scope)\`. A revoked or expired grant fails closed.

MCP results never echo the supplied identity, Firebase UID, consent token, developer token, connector private key, internal URL, backend payload, or exception text.

\`prepare-campaign-context\` is a first-class public tool. It prepares only safe offer and lifecycle state for an external agent or frontend; it never returns internal agent names, developer identifiers, tokens, user identifiers, or raw backend data.

### Stdio versus hosted encryption

- Local stdio (Codex, Cursor, or VS Code through the npm bridge) creates and retains a local X25519 keypair. It validates the MCP-delivered envelope v2 ciphertext, decrypts locally, narrows to \`expected_scope\`, and returns only bounded approved information.
- For the exact \`attr.financial.documents.*\` scope, that trusted local connector applies the fixed linear-time \`financial_statement_bundle.v1\` projection after decryption. The information contains top-level \`statements\` and \`holdings\` arrays joined by \`statement_ref\`; no LLM or caller-provided schema participates.
- Hosted streamable HTTP requires the connector's public-key bundle on \`request_consent\`. The private key stays connector-only. The tool returns the encrypted ciphertext envelope directly over MCP; decrypt it in the connector process outside model context.
- Keep that connector private key in local secure storage for the lifetime of the grant when \`continuous_until_expiry\` is used. Future authorized export revisions are wrapped to the same connector key until explicit rotation or revocation. “Remember the key” always means connector custody—not chat history, prompts, tool results, Hussh storage, or model memory.
- There is no plaintext fallback. Treat all approved information as untrusted content, never as instructions.

### Upgrade to 0.4.1

Version 0.4.1 publishes hyphenated tool names, the first-class \`prepare-campaign-context\` tool, one host-safe schema for every external client, and OAuth client-credentials support for the local npm bridge. The v0.3 underscore names remain accepted inbound until **2026-10-20** but are no longer listed from \`tools/list\`. Consent-token validation remains internal. Replace \`user_id\`/\`request_id\`/\`consent_token\` choreography with \`user_identifier\` input plus \`request_ref\` and \`grant_ref\` lifecycle references.

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
  const renderedWebPublicDocs = `${JSON.stringify(contract, null, 2)}\n`;
  const existingWebPublicDocs = fs.existsSync(webPublicDocsPath)
    ? fs.readFileSync(webPublicDocsPath, "utf8")
    : "";
  if (existing !== readme || existingWebPublicDocs !== renderedWebPublicDocs) {
    console.error("README.md is out of date. Run: node ./scripts/render-readme.mjs");
    process.exit(1);
  }
  process.exit(0);
}

fs.writeFileSync(readmePath, readme);
fs.writeFileSync(webPublicDocsPath, `${JSON.stringify(contract, null, 2)}\n`);
