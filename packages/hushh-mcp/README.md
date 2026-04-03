# `@hushh/mcp`

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

The promoted public developer environment is **UAT** for now.

- app workspace: https://uat.kai.hushh.ai/developers
- consent API origin: https://api.uat.hushh.ai
- remote MCP endpoint: `https://api.uat.hushh.ai/mcp/?token=<developer-token>`
- npm package: `@hushh/mcp`
- canonical token env var: `HUSHH_DEVELOPER_TOKEN`

Use the trailing-slash mount form for remote MCP:

- `https://api.uat.hushh.ai/mcp/?token=<developer-token>`
- not `https://api.uat.hushh.ai/mcp?token=<developer-token>`

## Quick Start

### Remote MCP

Use remote MCP when the host supports HTTP MCP directly.

```text
https://api.uat.hushh.ai/mcp/?token=<developer-token>
```

### npm Bridge

Use the npm bridge when the host still expects a local stdio MCP process.

```bash
npx -y @hushh/mcp --help
```

Minimal env for stdio hosts:

```bash
export CONSENT_API_URL=https://api.uat.hushh.ai
export HUSHH_DEVELOPER_TOKEN=<developer-token>
```

Or point the launcher at an existing `consent-protocol/.env`:

```bash
export HUSHH_MCP_ENV_FILE=/absolute/path/to/consent-protocol/.env
npx -y @hushh/mcp
```

## Host Setup Examples

### Generic mcpServers JSON

**Use this when:** Use this when your host supports HTTP MCP directly.

**Keep local:** Keep the developer token machine-local and never commit host config with inline credentials.

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

**Use this when:** Use this when Codex should connect to the hosted UAT MCP endpoint directly.

**Keep local:** This writes a machine-local Codex config entry that contains the full query-token URL.

```bash
codex mcp add hushh_consent --url "https://api.uat.hushh.ai/mcp/?token=<developer-token>"
```

### Codex npm bridge

**Use this when:** Use this when Codex should launch a local stdio MCP bridge instead of remote HTTP MCP.

**Keep local:** Keep HUSHH_DEVELOPER_TOKEN local. The backend endpoint and token should not be committed.

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

**Use this when:** Use this when your host expects a local stdio process but supports generic mcpServers JSON.

**Keep local:** Keep HUSHH_DEVELOPER_TOKEN local. This should match the same endpoint and token you use for remote MCP.

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

**Use this when:** Use this when Claude Desktop is your MCP host and you need a local stdio bridge.

**Keep local:** Claude Desktop stores this config locally. Do not commit the token value.

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

**Use this when:** Use this for editor hosts that understand mcpServers JSON and can call remote MCP directly.

**Keep local:** The URL contains the token today, so keep the config file local.

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

**Use this when:** Use this for hosts that only ask for the MCP endpoint URL.

**Keep local:** Use the exact slash-safe mount shape.

```text
https://api.uat.hushh.ai/mcp/?token=<developer-token>
```

## Public Tools And Resources

Public tools:

- `discover_user_domains`
- `request_consent`
- `check_consent_status`
- `get_encrypted_scoped_export`
- `validate_token`
- `list_scopes`

Read-only MCP resources:

- `hushh://info/server`
- `hushh://info/protocol`
- `hushh://info/connector`

## End-To-End Consent Example

1. Discover the user’s current scopes with `discover_user_domains`.
2. Request one discovered scope with `request_consent`, including your X25519 connector public key bundle.
3. Let the user approve the request inside Kai.
4. Poll with `check_consent_status`, validate with `validate_token`, then read the ciphertext with `get_encrypted_scoped_export`.

The public flow is always:

- encrypted storage in Hushh
- explicit user approval in Kai
- encrypted export back to the external connector
- local decryption on the connector side

## Runtime Expectations

- Python 3 must be available locally.
- The first full stdio launch creates a local cache and installs the bundled Python requirements.
- The runtime still needs the same backend configuration as `consent-protocol` when you are running contributor-local flows.

Useful env vars:

- `HUSHH_MCP_ENV_FILE`: load runtime variables from an external `.env`
- `HUSHH_MCP_RUNTIME_DIR`: point at a local `consent-protocol` checkout
- `HUSHH_MCP_CACHE_DIR`: override the bootstrap cache directory
- `HUSHH_MCP_PYTHON`: choose a specific Python executable
- `HUSHH_MCP_SKIP_BOOTSTRAP=1`: skip venv creation and dependency install

## Contributor-Local Fallback

If you are working inside this repo and do not want the npm bootstrap path:

```bash
cd consent-protocol
python mcp_server.py
```

## More Docs

- API reference: `consent-protocol/docs/reference/developer-api.md`
- Technical companion: `consent-protocol/docs/mcp-setup.md`
- Internal host operations: `docs/reference/operations/coding-agent-mcp.md`
