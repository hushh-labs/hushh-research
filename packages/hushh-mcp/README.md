# `@hushh/mcp`

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

The promoted public developer environment is **UAT**.

- app workspace: https://uat.kai.hushh.ai/developers
- consent API origin: https://api.uat.hushh.ai
- remote MCP endpoint: `https://api.uat.hushh.ai/mcp/?token=<developer-token>`
- npm package: `@hushh/mcp`
- canonical token env var: `HUSHH_DEVELOPER_TOKEN`

Use the trailing-slash form for remote MCP:

- `https://api.uat.hushh.ai/mcp/?token=<developer-token>`
- not `https://api.uat.hushh.ai/mcp?token=<developer-token>`

### Quick start

#### Remote MCP

Use this when the host supports HTTP MCP directly.

```text
https://api.uat.hushh.ai/mcp/?token=<developer-token>
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

Keep local: Keep the developer token machine-local and never commit host config with inline credentials.

```json
{
  "mcpServers": {
    "hushh-consent": {
      "url": "https://api.uat.hushh.ai/mcp/?token=<developer-token>"
    }
  }
}
```

### Codex remote setup

Use when: Codex should connect to the hosted UAT MCP endpoint directly.

Keep local: This writes a machine-local Codex config entry that contains the full query-token URL.

```bash
codex mcp add hushh_consent --url "https://api.uat.hushh.ai/mcp/?token=<developer-token>"
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

### Claude Desktop stdio

Use when: Claude Desktop is your MCP host and you need a local stdio bridge.

Keep local: Claude Desktop stores this config locally. Do not commit the token value.

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

### Cursor / VS Code remote JSON

Use when: your editor host understands mcpServers JSON and can call remote MCP directly.

Keep local: The URL contains the token today, so keep the config file local.

```json
{
  "mcpServers": {
    "hushh-consent-remote": {
      "url": "https://api.uat.hushh.ai/mcp/?token=<developer-token>"
    }
  }
}
```

### Raw remote MCP URL

Use when: your host only asks for the MCP endpoint URL.

Keep local: Use the exact slash-safe mount shape.

```text
https://api.uat.hushh.ai/mcp/?token=<developer-token>
```

### Public tools

- `discover_user_domains`
- `request_consent`
- `check_consent_status`
- `get_encrypted_scoped_export`
- `validate_token`
- `list_scopes`

### Read-only resources

- `hushh://info/server`
- `hushh://info/protocol`
- `hushh://info/connector`

### Consent flow

1. Call `discover_user_domains`.
2. Request one returned scope with `request_consent`.
3. Wait for user approval in Kai.
4. Call `check_consent_status` and then `get_encrypted_scoped_export`.

The data flow is:

- encrypted storage in Hushh
- explicit user approval in Kai
- encrypted export back to the external connector
- local decryption on the connector side

## Self-hosted and contributor development

This package can also bootstrap a generic `consent-protocol` runtime for local development or self-hosted use.

Use this path when:

- you are developing against localhost
- you want to override the packaged runtime with a local checkout
- you are contributing to `consent-protocol`

### Runtime expectations

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
