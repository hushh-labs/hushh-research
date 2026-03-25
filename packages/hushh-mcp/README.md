# `@hushh/mcp`

Launch-friendly npm wrapper for the Hushh Consent MCP server.

This package does not replace the Python MCP implementation. It bootstraps the existing `consent-protocol` runtime, installs the bundled Python dependencies on first run, and then launches the same stdio MCP server used inside the repo.

## Preferred Host Config

Generic JSON host config (`mcpServers`) is appropriate for hosts such as Cursor and VS Code.
Codex uses `codex mcp add ...` or `~/.codex/config.toml` instead of `mcp.json`.

```json
{
  "mcpServers": {
    "hushh-consent": {
      "command": "npx",
      "args": ["-y", "@hushh/mcp@beta"],
      "env": {
        "CONSENT_API_URL": "https://<consent-api-origin>",
        "HUSHH_DEVELOPER_TOKEN": "<developer-token>"
      }
    }
  }
}
```

Codex remote setup:

```bash
codex mcp add hushh_consent --url "https://<consent-api-origin>/mcp/?token=<developer-token>"
```

This stores the current beta query-token URL in machine-local Codex config. Do not commit or share that file.

Codex stdio config:

```toml
[mcp_servers.hushh_consent]
command = "npx"
args = ["-y", "@hushh/mcp@beta"]
enabled = true

[mcp_servers.hushh_consent.env]
CONSENT_API_URL = "https://<consent-api-origin>"
HUSHH_DEVELOPER_TOKEN = "<developer-token>"
```

Remote MCP hosts that support direct HTTP transport can point at the UAT beta endpoint:

```json
{
  "mcpServers": {
    "hushh-consent-remote": {
      "url": "https://<consent-api-origin>/mcp/?token=<developer-token>"
    }
  }
}
```

The public UAT contract is the scalable consent core only:

- `discover_user_domains`
- `request_consent`
- `check_consent_status`
- `get_encrypted_scoped_export`
- `validate_token`
- `list_scopes`

Strict zero-knowledge mode is wrapped-key only. `request_consent` callers must provide
`connector_public_key`, `connector_key_id`, and `connector_wrapping_alg`, and the external
connector keeps the private key. The MCP runtime does not generate or manage that private key.

## Runtime Expectations

- Python 3 must be available locally.
- On first launch the wrapper creates a local virtual environment cache and installs the bundled `requirements.txt`.
- The runtime still needs the same backend configuration as `consent-protocol`, including secrets and database connectivity.

Provide configuration in one of two ways:

1. Export the required environment variables before launching the host.
2. Point `HUSHH_MCP_ENV_FILE` at a `consent-protocol` style `.env` file.

For stdio hosts, the minimal public setup is:

```bash
export CONSENT_API_URL=https://<consent-api-origin>
export HUSHH_DEVELOPER_TOKEN=<developer-token>
```

Example:

```bash
export HUSHH_MCP_ENV_FILE=/absolute/path/to/consent-protocol/.env
npx -y @hushh/mcp@beta
```

## Useful Environment Variables

- `HUSHH_MCP_ENV_FILE`: load runtime variables from an external `.env` file
- `HUSHH_MCP_RUNTIME_DIR`: bypass the bundled runtime and point at a local `consent-protocol` checkout
- `HUSHH_MCP_CACHE_DIR`: override the bootstrap cache directory
- `HUSHH_MCP_PYTHON`: choose a specific base Python executable
- `HUSHH_MCP_SKIP_BOOTSTRAP=1`: skip venv creation and dependency install

## Repo-Local Fallback

If you are working inside this monorepo and do not want npm bootstrap yet, the direct Python path is still supported:

```bash
cd consent-protocol
python mcp_server.py
```

See `consent-protocol/docs/mcp-setup.md` for the npm-first guide and direct-Python fallback.

## Launch Note

Product Hunt and developer-facing launch materials should treat the npm package as the preferred public install surface. UAT/public beta materials should reference `@hushh/mcp@beta`, the exact backend MCP URL shown in `/developers`, and the self-serve `/developers` workspace until production developer access is explicitly promoted.
