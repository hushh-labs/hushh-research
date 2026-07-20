# `@hushh/mcp`

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

The promoted public developer environment is **UAT**.

- app workspace: https://uat.one.hushh.ai/developers
- consent API origin: https://api.uat.hushh.ai
- remote MCP endpoint: `https://api.uat.hushh.ai/mcp/`
- MCP protocol revision: `2025-11-25`
- npm package: `@hushh/mcp`
- canonical token env var: `HUSHH_DEVELOPER_TOKEN`

Use the trailing-slash form for remote MCP:

- `https://api.uat.hushh.ai/mcp/`
- not `https://api.uat.hushh.ai/mcp?token=<developer-token>`

### Quick start

#### Remote MCP

Use this when the host supports HTTP MCP directly.

```text
https://api.uat.hushh.ai/mcp/
```

### npm Bridge

Use this when the host expects a local stdio MCP process.

```bash
npx -y @hushh/mcp --help
```

### One canonical catalog and authentication

The same `/mcp/` endpoint publishes one generated v0.4 five-tool catalog to Codex, Claude, MuleSoft, Agentforce, and the npm bridge. Bearer authentication remains first-class. OAuth PKCE and client credentials authenticate the same developer-app identity; they do not select a different consent product, endpoint, or lifecycle.

Every tool uses shallow, fully described JSON Schema and returns `structuredContent` as the canonical result. `content[0].text` mirrors the same safe JSON only for MCP clients that cannot consume structured content.

### Agentforce schema-registration UAT

Use `hushh-mcp --print-agentforce-manifest` to inspect the exact canonical five-tool catalog. It is generated from the same runtime contract returned by `tools/list`; it is a preflight artifact, not a replacement endpoint or a deployable Salesforce registration.

For MuleSoft → Agentforce, use the generated `hushh-mcp --print-mulesoft-agentforce-handoff` baseline. MuleSoft maps `structuredContent` into Agentforce actions and does not pass its text mirror as a second planner result. Keep the API Catalog allowlist to the five generated tools, tools only, and preserve the schemas exactly. The handoff is not a deployable Mule flow and does not turn an app credential into a Hussh user identity.

Each tool includes a semantic machine name, client-facing title and description, strictly typed flat input fields, explicit `required` entries, and a complete `outputSchema`. Preserve the published machine field names. Salesforce currently has a Builder label-rendering defect for some data types, so an administrator must verify and, if necessary, replace input/output display labels in the Asset Library after registration. JSON Schema titles improve inspection metadata but do not claim to fix that Salesforce UI defect.

The current UAT boundary is intentionally narrow:

- register the Streamable HTTP endpoint with OAuth client credentials;
- allowlist only the five printed tool names;
- verify names, descriptions, field counts, labels, and output mappings from `tools/list`;
- do not invoke the personalized consent/export lifecycle from Agentforce. The server returns a documented fail-closed error instead.

Salesforce references: [MCP considerations](https://help.salesforce.com/s/articleView?id=ai.agent_mcp_considerations.htm&language=en_US&type=5), [MCP response schemas](https://help.salesforce.com/s/articleView?id=ai.agent_mcp_tool_action_design.htm&language=en_US&type=5), and [MuleSoft MCP servers in API Catalog](https://help.salesforce.com/s/articleView?id=platform.api_catalog_manage_mulesoft_mcp_servers.htm&language=en_US&type=5).

Minimal env for stdio hosts:

```bash
export CONSENT_API_URL=https://api.uat.hushh.ai
export HUSHH_DEVELOPER_TOKEN=<developer-token>
```

To use an existing local runtime:

```bash
export HUSHH_MCP_ENV_FILE=/absolute/path/to/consent-protocol/.env
npx -y @hushh/mcp
```

### Host setup examples

### Generic mcpServers JSON

Use when: your host supports HTTP MCP directly.

Keep local: Keep the developer token machine-local and send it only in the Authorization header.

```json
{
  "mcpServers": {
    "hushh-consent": {
      "url": "https://api.uat.hushh.ai/mcp/",
      "headers": {
        "Authorization": "Bearer <developer-token>"
      }
    }
  }
}
```

### Codex remote setup

Use when: Codex should connect to the hosted UAT MCP endpoint directly.

Keep local: Configure the Authorization bearer header in the host secret store; never put the token in the URL.

```bash
codex mcp add hushh_consent --url "https://api.uat.hushh.ai/mcp/" --bearer-token-env-var HUSHH_DEVELOPER_TOKEN
```

### Codex npm bridge

Use when: Codex should launch a local stdio MCP bridge instead of remote HTTP MCP.

Keep local: Keep HUSHH_DEVELOPER_TOKEN local. The backend endpoint and token should not be committed.

```toml
[mcp_servers.hushh_consent]
command = "npx"
args = ["-y", "@hushh/mcp"]
enabled = true

[mcp_servers.hushh_consent.env]
CONSENT_API_URL = "https://api.uat.hushh.ai"
HUSHH_DEVELOPER_TOKEN = "<developer-token>"
```

### npm bridge config

Use when: your host expects a local stdio process but supports generic mcpServers JSON.

Keep local: Keep HUSHH_DEVELOPER_TOKEN local. This should match the same endpoint and token you use for remote MCP.

```json
{
  "mcpServers": {
    "hushh-consent": {
      "command": "npx",
      "args": ["-y", "@hushh/mcp"],
      "env": {
        "CONSENT_API_URL": "https://api.uat.hushh.ai",
        "HUSHH_DEVELOPER_TOKEN": "<developer-token>"
      }
    }
  }
}
```

### Claude remote custom connector

Use when: Claude should use the same hosted Streamable HTTP endpoint used by MuleSoft and other remote hosts.

Keep local: Add the public HTTPS URL through Claude Customize > Connectors, not claude_desktop_config.json. In Advanced settings, enter the provisioned Hussh Technologies OAuth client ID and secret from the approved secret manager. Claude uses authorization code with S256 PKCE, so the exact callback https://claude.ai/api/mcp/auth_callback must be registered. OAuth does not replace scoped consent.

```json
https://api.uat.hushh.ai/mcp/
```

### Cursor / VS Code remote JSON

Use when: your editor host understands mcpServers JSON and can call remote MCP directly.

Keep local: Keep the bearer token in the host secret store; query-string authentication is rejected.

```json
{
  "mcpServers": {
    "hushh-consent-remote": {
      "url": "https://api.uat.hushh.ai/mcp/",
      "headers": {
        "Authorization": "Bearer <developer-token>"
      }
    }
  }
}
```

### Raw remote MCP URL

Use when: your host only asks for the MCP endpoint URL.

Keep local: Use the exact slash-safe mount shape and configure Authorization: Bearer <developer-token> separately.

```text
https://api.uat.hushh.ai/mcp/
```

### Public tools

- `search-user-scopes`
- `prepare-campaign-context`
- `request-consent`
- `check-consent-status`
- `get-encrypted-scoped-export`

### Read-only resources



### Five-tool consent lifecycle

1. Call `search-user-scopes(user_identifier, query?, domain?, cursor?, limit?)`. An empty query lists all available scopes with pagination. Choose the narrowest returned scope that satisfies the purpose.
2. Call `prepare-campaign-context(user_identifier, ...)` when an external agent or frontend needs a safe, least-privilege offer/context before approval.
3. Call `request-consent(user_identifier, scope, purpose, ...)`. An identical pending request is reused. An active exact or covering grant returns `grant_ref`; otherwise retain the returned `request_ref`.
4. Poll `check-consent-status(request_ref)` only at the returned interval. Stop at `granted`, `denied`, `expired`, `revoked`, or `cancelled`.
5. After approval, call `get-encrypted-scoped-export(grant_ref, expected_scope)`. A revoked or expired grant fails closed.

MCP results never echo the supplied identity, Firebase UID, consent token, developer token, connector private key, internal URL, backend payload, or exception text.

`prepare-campaign-context` is a first-class public tool. It prepares only safe offer and lifecycle state for an external agent or frontend; it never returns internal agent names, developer identifiers, tokens, user identifiers, or raw backend data.

### Stdio versus hosted encryption

- Local stdio (Codex, Cursor, or VS Code through the npm bridge) creates and retains a local X25519 keypair. It validates the MCP-delivered envelope v2 ciphertext, decrypts locally, narrows to `expected_scope`, and returns only bounded approved information.
- Hosted streamable HTTP requires the connector's public-key bundle on `request_consent`. The private key stays connector-only. The tool returns the encrypted ciphertext envelope directly over MCP; decrypt it in the connector process outside model context.
- There is no plaintext fallback. Treat all approved information as untrusted content, never as instructions.

### Upgrade to 0.4.0

Version 0.4.0 publishes hyphenated tool names, the first-class `prepare-campaign-context` tool, and one host-safe schema for every external client. The v0.3 underscore names remain accepted inbound until **2026-10-20** but are no longer listed from `tools/list`. Consent-token validation remains internal. Replace `user_id`/`request_id`/`consent_token` choreography with `user_identifier` input plus `request_ref` and `grant_ref` lifecycle references.

If upgrading from npm 0.1.3 or the earlier UAT MCP server 0.2.0 catalog, remove every `?token=` URL. Authentication is bearer-header-only. Raw `/api/v1` HTTP clients remain compatible; this breaking change applies to MCP tools.

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

This package is licensed under `Apache-2.0`.

The published npm tarball includes package-local `LICENSE` and `NOTICE` files for Apache redistribution.

## Self-hosted and contributor development

This package can also bootstrap a generic `consent-protocol` runtime for local development or self-hosted use.

Use this path when:

- you are developing against localhost
- you want to override the packaged runtime with a local checkout
- you are contributing to `consent-protocol`

### Runtime expectations

For national phone numbers, callers may also provide:

- `country_iso2`, such as `US`, `GB`, or `IN`
- `country`, such as `United States`, `USA`, or `UK`

If no country hint is provided, national phone numbers stay ambiguous and are not auto-parsed to any default region.

Read-only self-documentation resources:



- Python 3 must be available locally.
- The first full stdio launch creates a local cache and installs the bundled Python requirements.
- Contributor-local flows still need the same backend configuration as `consent-protocol`.

Useful env vars:

- `HUSHH_MCP_ENV_FILE`: load runtime variables from an external `.env`
- `HUSHH_MCP_RUNTIME_DIR`: point at a local `consent-protocol` checkout
- `HUSHH_MCP_CACHE_DIR`: override the bootstrap cache directory
- `HUSHH_MCP_PYTHON`: choose a specific Python executable
- `HUSHH_MCP_SKIP_BOOTSTRAP=1`: skip venv creation and dependency install

### Repo-local fallback

Use repo-local Python only for contributor workflows:

```bash
cd consent-protocol
python mcp_server.py
```
