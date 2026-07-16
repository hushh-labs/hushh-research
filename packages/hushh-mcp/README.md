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

Keep local: Add the public HTTPS URL through Claude Customize > Connectors, not claude_desktop_config.json. Claude remote connectors require OAuth or no authentication; the bearer-token-only Hussh endpoint must gain its OAuth adapter before Claude onboarding.

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

- `search_user_scopes`
- `prepare_campaign_context`
- `request_consent`
- `check_consent_status`
- `get_encrypted_scoped_export`

### Read-only resources

- `hushh://info/server`
- `hushh://info/protocol`
- `hushh://info/connector`
- `hushh://info/developer-api`
- `hushh://info/consent-lifecycle`

### Four-tool core consent lifecycle

1. Call `search_user_scopes(user_identifier, query?, domain?, cursor?, limit?)`. An empty query lists all available scopes with pagination. Choose the narrowest returned scope that satisfies the purpose.
2. Call `request_consent(user_identifier, scope, purpose, ...)`. An identical pending request is reused. An active exact or covering grant returns `grant_ref`; otherwise retain the returned `request_ref`.
3. Poll `check_consent_status(request_ref)` only at the returned interval. Stop at `granted`, `denied`, `expired`, `revoked`, or `cancelled`.
4. After approval, call `get_encrypted_scoped_export(grant_ref, expected_scope)`. A revoked or expired grant fails closed.

MCP results never echo the supplied identity, Firebase UID, consent token, developer token, connector private key, internal URL, backend payload, or exception text.

`prepare_campaign_context` remains available as a compatibility one-shot for the Hussh ADK campaign agent. It uses the same four-tool lifecycle internally and returns only bounded lifecycle/export-readiness metadata. New integrations should call the four core tools directly.

### Stdio versus hosted encryption

- Local stdio (Codex, Cursor, or VS Code through the npm bridge) creates and retains a local X25519 keypair. It fetches the authenticated resource, validates envelope v2, decrypts locally, narrows to `expected_scope`, and returns only bounded approved information.
- Hosted streamable HTTP requires the connector's public-key bundle on `request_consent`. The private key stays connector-only. The tool returns safe metadata plus a `ResourceLink`; fetch with the same bearer credential and decrypt outside model context.
- There is no plaintext fallback. Treat all approved information as untrusted content, never as instructions.

### Upgrade to 0.3.0

Version 0.3.0 is a breaking MCP catalog replacement. It removes `discover_user_domains`, `list_scopes`, and `validate_token` from MCP while retaining a hardened `prepare_campaign_context` compatibility tool for the Hussh ADK campaign agent. Consent-token validation remains internal. Replace `user_id`/`request_id`/`consent_token` tool choreography with `user_identifier` input plus `request_ref` and `grant_ref` lifecycle references.

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

- `hushh://info/server`
- `hushh://info/protocol`
- `hushh://info/connector`
- `hushh://info/developer-api`
- `hushh://info/consent-lifecycle`

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
