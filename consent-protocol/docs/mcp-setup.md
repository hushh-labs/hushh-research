# MCP Server Setup Guide


## Visual Context

Canonical visual owner: [consent-protocol](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

This guide explains how to connect the Hushh Consent MCP Server to Claude Desktop or other MCP hosts. The server uses the `mcp` Python SDK with stdio transport (JSON-RPC 2.0 over stdin/stdout).

For repo-wide coding-agent setup guidance, including `shadcn` and `plaid` MCP examples for Codex-style agents, see:

- `docs/reference/operations/coding-agent-mcp.md`

## Prerequisites

- Node.js 18.18+ for the npm wrapper
- Python 3.13+ for the underlying MCP runtime
- Claude Desktop app installed (or another MCP host such as Cursor)
- Hushh runtime configuration available through environment variables or a `consent-protocol`-style `.env` file

## Quick Start

### Option A: npm Wrapper (preferred public install surface)

Use the npm launcher when preparing external developer docs, Product Hunt assets, or machine-local MCP host config that should match the launch story:

```bash
export HUSHH_MCP_ENV_FILE=/absolute/path/to/consent-protocol/.env
npx -y @hushh/mcp@beta --help
```

That command validates that the launcher can find Python and bootstrap the packaged runtime. The first full run installs the bundled Python dependencies into a local cache directory.

Manual host configuration for generic JSON hosts (`mcpServers`):

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

Notes:

1. `HUSHH_MCP_ENV_FILE` is the simplest way to reuse an existing `consent-protocol/.env`.
2. You can also export the required env vars directly instead of using an env file.
3. If `@hushh/mcp` has not been published yet, treat that as a launch blocker for the public developer lane and use the repo-local fallback below until publish is complete.

### Option A2: Hosted Remote MCP (UAT beta)

For hosts that support direct remote MCP over HTTP, point them at the backend MCP endpoint and append the self-serve developer token to the URL:

Use the trailing-slash form of the mount path:

- `https://<consent-api-origin>/mcp/?token=<developer-token>`
- not `https://<consent-api-origin>/mcp?token=<developer-token>`

Codex does not use `mcp.json`. For Codex, use the CLI or `~/.codex/config.toml`:

```bash
codex mcp add hushh_consent --url "https://<consent-api-origin>/mcp/?token=<developer-token>"
```

```toml
[mcp_servers.hushh_consent]
url = "https://<consent-api-origin>/mcp/?token=<developer-token>"
enabled = true
```

Because the current remote beta contract is query-token based, treat the resulting Codex config as machine-local secret material and never commit it.

Cursor / VS Code / generic JSON host config remains:

```json
{
  "mcpServers": {
    "hushh-consent-remote": {
      "url": "https://<consent-api-origin>/mcp/?token=<developer-token>"
    }
  }
}
```

For public developer setup, do not add `FRONTEND_URL` to the MCP host config. The backend already owns the app/approval surface for its environment.

### Option B: Repo-Local Python Fallback

Use this path when working inside the repo or before the npm package is published.

#### 1. Install Dependencies

```bash
cd consent-protocol
pip install -r requirements.txt
```

#### 2. Test the MCP Server

```bash
python mcp_server.py
```

You should see output on stderr:

```
[HUSHH-MCP] INFO: ============================================================
[HUSHH-MCP] INFO: HUSHH MCP SERVER STARTING
[HUSHH-MCP] INFO: ============================================================
```

Press `Ctrl+C` to stop.

#### 3. Configure Claude Desktop

You have two repo-local options: **automatic** or **manual**.

##### Automatic Setup

Run the setup script to auto-generate and install the local Python config:

```bash
python setup_mcp.py
```

The script will:

1. Detect the `consent-protocol` directory path
2. Generate `claude_desktop_config.generated.json` with correct absolute paths
3. Prompt you to install it directly into the Claude Desktop config location
4. Merge the `hushh-consent` server entry into any existing config

##### Manual Configuration

**Config file location:**

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

Create or edit the file (replace paths with your actual directory locations):

**macOS / Linux:**

```json
{
  "mcpServers": {
    "hushh-consent": {
      "command": "python",
      "args": [
        "/path/to/consent-protocol/mcp_server.py"
      ],
      "env": {
        "PYTHONPATH": "/path/to/consent-protocol"
      }
    }
  }
}
```

**Windows:** (escape backslashes as `\\`)

```json
{
  "mcpServers": {
    "hushh-consent": {
      "command": "python",
      "args": [
        "C:\\path\\to\\consent-protocol\\mcp_server.py"
      ],
      "env": {
        "PYTHONPATH": "C:\\path\\to\\consent-protocol"
      }
    }
  }
}
```

> **Important:** Replace the placeholder paths with your actual directory location. The `PYTHONPATH` must point to the `consent-protocol` directory so that module imports resolve correctly.

### 4. Restart Claude Desktop

1. **Fully quit** Claude Desktop (check the system tray / menu bar)
2. **Reopen** Claude Desktop
3. Look for the **tool icon** in the input area -- this indicates connected MCP servers

## Available Tools

The public UAT developer contract exposes a single scalable tool group: `core_consent`.

| Tool                       | Description                                                                     |
| -------------------------- | ------------------------------------------------------------------------------- |
| `request_consent`          | Request user consent for a discovered scope (for example `pkm.read` or `attr.{domain}.*`) |
| `validate_token`           | Validate a consent token's signature, expiration, and scope before use          |
| `get_encrypted_scoped_export` | Return ciphertext plus wrapped-key metadata for any approved dynamic scope |
| `list_scopes`              | List dynamic consent scope categories from backend metadata                     |
| `discover_user_domains`    | Discover which domains a user has and the scope strings to request             |
| `check_consent_status`     | Check current status of a pending consent request                              |

## MCP Resources (4 resources)

The server also exposes four read-only MCP resources that agents can query for self-documentation:

| URI                        | Name                                | Description                                                           |
| -------------------------- | ----------------------------------- | --------------------------------------------------------------------- |
| `hushh://info/server`      | Server Information                  | Server version, transport, tool count, and compliance checklist       |
| `hushh://info/protocol`    | Protocol Information                | HushhMCP protocol principles, token format, scope model, ZK details  |
| `hushh://info/connector`   | Connector usage and capabilities    | Full tool list, recommended flow, supported scopes, backend details   |
| `hushh://info/developer-api` | Developer API Contract            | Versioned `/api/v1` contract for discovery and consent requests       |

Agents can read `hushh://info/connector` for a machine-readable summary of the recommended MCP flow, and `hushh://info/developer-api` for the publishable developer API contract.

## Recommended Flow

Scopes are **dynamic** -- they are derived from the PKM registry (`pkm_index.available_domains`) and vary per user. There is no fixed list. Always discover domains first.

1. **Discover domains** -- Call `discover_user_domains(user_id)` to get the user's available domains and corresponding scope strings. Under the hood this calls `/api/v1/user-scopes/{user_id}?token=...` with the self-serve developer token.
2. **Request consent** -- Call `request_consent(user_id, scope, connector_public_key, connector_key_id, connector_wrapping_alg)` for each scope you need. In production mode, this sends an FCM push notification to the user's Hushh app.
3. **Wait for approval** -- If the response status is `pending`, return control to the caller and wait for user action in the Hushh app. Re-check later using `check_consent_status(user_id, scope)`.
4. **Use data** -- Pass the returned consent token (`HCT:...`) to `get_encrypted_scoped_export`, and pass the original requested scope as `expected_scope`.

### Coverage semantics

- If an app already has a broader active grant and asks for a narrower scope, Hushh reuses the existing broader token immediately.
- Reused-token responses include `requested_scope`, `granted_scope`, `coverage_kind`, and `covered_by_existing_grant`.
- When a broader token is reused for a narrower ask, `get_encrypted_scoped_export(expected_scope=...)` still returns the canonical broader encrypted export and echoes the narrower `expected_scope`. The connector narrows the payload after local decryption.
- If an app already has a narrower active grant and asks for a broader parent scope, that broader request still requires fresh approval.
- After approval of a broader parent scope, the broader token becomes canonical and the older narrower token is superseded in the audit trail.

### Scope model

- `pkm.read` -- Full PKM read access (all discovered domains for the user)
- `pkm.write` -- Write to the PKM
- `attr.{domain}.*` -- Domain-level scope where `{domain}` comes from runtime discovery
- `attr.{domain}.{subintent}.*` -- Optional subintent scope when metadata/registry exposes subintents
- `attr.{domain}.{path}` -- Specific nested path scope (narrow access)

Scopes are resolved dynamically from user metadata + domain registry. There is no fixed domain whitelist in MCP.

## Zero-Knowledge Export

Data returned by `get_encrypted_scoped_export` is an encrypted vault export:

- the unlocked first-party app prepares the approved slice locally
- the app encrypts that slice with a fresh export key locally
- the app wraps the export key to the connector's X25519 public key locally
- the backend stores ciphertext plus wrapped-key metadata only
- the external connector unwraps and decrypts locally

Hosted Hushh MCP does not decrypt developer data. Hushh infrastructure stores ciphertext only.

## Developer API

The publishable developer API surface is versioned under `/api/v1`:

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| `GET` | `/api/v1/list-scopes` | Developer API enabled | Generic dynamic scope catalog |
| `GET` | `/api/v1/tool-catalog` | Optional `?token=...` | App-filtered tool groups and recommended flow |
| `GET` | `/api/v1/user-scopes/{user_id}` | `?token=<developer-token>` | Per-user discovered scopes and domains |
| `GET` | `/api/v1/consent-status` | `?token=<developer-token>` | Check app-scoped consent status by scope or request id |
| `POST` | `/api/v1/request-consent` | `?token=<developer-token>` | Create or reuse consent for one discovered scope |
| `POST` | `/api/v1/scoped-export` | `?token=<developer-token>` | Return ciphertext and wrapped key metadata for one approved grant |

Scale rules:

- Always discover scopes per user instead of hardcoding domain keys.
- Prefer `get_encrypted_scoped_export` for all new integrations.
- App identity comes from the self-serve developer workspace and registry-backed developer token.
- Always pass `expected_scope` when fetching an encrypted scoped export, especially when `request_consent` or `check_consent_status` reports a reused broader grant.
- Raw HTTP and MCP callers must include `connector_public_key`, `connector_key_id`, and `connector_wrapping_alg` in `request_consent`. Hushh does not manage the connector private key.
- Generate the X25519 connector keypair on your own client/runtime, keep the private key there, and unwrap/decrypt the export locally. See [`reference/developer-api.md`](./reference/developer-api.md) for a complete example.

## Production Mode

When `PRODUCTION_MODE=true` (the default), consent requests require real user approval:

- The user must have the Hushh app installed.
- `request_consent` sends an FCM push notification to the user's device.
- The user reviews and approves (or denies) the request in the Hushh app consent dashboard.
- Consent delivery is FCM-first in production; consent SSE/poll endpoints are disabled for this flow.

Set `PRODUCTION_MODE=false` only for local development without a real user device.

## Environment Variables

| Variable                       | Default                  | Description                                          |
| ------------------------------ | ------------------------ | ---------------------------------------------------- |
| `CONSENT_API_URL`              | `http://localhost:8000`  | FastAPI backend URL for consent API calls             |
| `CONSENT_API_URL`              | `http://localhost:8000`  | Backend origin for `/api/v1` calls and stdio MCP      |
| `PRODUCTION_MODE`              | `true`                   | Require real user approval via Hushh app              |
| `DEVELOPER_API_ENABLED`        | `true` (dev), `false` (prod) | Controls `/api/v1/*` developer API availability |
| `HUSHH_DEVELOPER_TOKEN`       | _(none)_                 | Self-serve developer token for stdio MCP and `/api/user/lookup` |
| `CONSENT_TIMEOUT_SECONDS`      | `120`                    | Max wait time for user to approve consent             |

## Demo Script

### Step 1: Check Available Tools

```
You: "What Hushh tools do you have access to?"
```

The agent should list the 6 public consent tools and 4 self-documenting resources.

### Step 2: Discover User Domains

```
You: "Discover what data domains are available for user@example.com"
-> Calls discover_user_domains("user@example.com")
-> Returns domains that actually exist for that user
-> Returns scope strings like: attr.{domain}.*, attr.{domain}.{subintent}.*, etc.
```

### Step 3: Request Consent

```
You: "Request consent to access financial data for user@example.com"
-> Calls request_consent("user@example.com", "attr.financial.*")
-> In production: sends push notification to user's Hushh app
-> Returns status: "pending" (or "granted" if auto-approved in dev mode)
```

### Step 4: Re-check Status Later (production mode)

```
-> Agent checks check_consent_status("user@example.com", "attr.financial.*")
-> User approves in Hushh app dashboard
-> Returns consent token (HCT:...)
```

### Step 5: Access Data with Consent

```
You: "Get the approved encrypted export for user@example.com using that token"
-> Calls get_encrypted_scoped_export with the consent token and expected_scope
-> SUCCESS: returns ciphertext plus wrapped-key metadata
-> The external connector unwraps the export key and decrypts locally
```

### Step 6: Test Scope Isolation

```
You: "Use a token granted for one discovered branch against a different branch"
-> DENIED: the token remains scope-isolated
-> Agent must request separate consent for the different discovered scope
```

## Troubleshooting

| Issue                          | Solution                                                                 |
| ------------------------------ | ------------------------------------------------------------------------ |
| Server not found               | Check `PYTHONPATH` in config points to `consent-protocol` directory      |
| Import errors                  | Run `pip install -r requirements.txt`                                    |
| Claude doesn't see tools       | Fully restart Claude Desktop (check system tray / menu bar)              |
| Tools count mismatch           | Ensure you have the latest `mcp_server.py`; the public contract exposes 6 consent tools |
| Consent request never appears  | User must have the Hushh app installed; FCM push notifications deliver consent requests |
| Consent times out              | Default timeout is 120s; check `CONSENT_TIMEOUT_SECONDS` env var        |
| Scopes for a user              | Call `discover_user_domains(user_id)` first; scopes come from the PKM registry, not a fixed list |
| Token errors                   | Ensure `.env` has `SECRET_KEY`; check token expiration (24h default)     |
| Auto-setup fails               | Run `python setup_mcp.py` and copy the generated config manually        |

## Protocol Compliance

This MCP server enforces the HushhMCP protocol:

- **Consent First**: No data access without a valid consent token
- **Scoped Access**: Each data category requires separate consent; tokens are scope-isolated
- **Dynamic Scopes**: Scope strings derived from the PKM registry, not a hard-coded list
- **Cryptographic Signatures**: Tokens signed with HMAC-SHA256
- **Time-Limited**: Tokens expire after 24 hours by default
- **Zero Knowledge**: Data is encrypted with an export key; MCP server decrypts client-side via AES-GCM
- **TrustLinks**: Agent-to-agent delegation with cryptographic proof of authorization
- **Production Approval**: Real user approval via Hushh app dashboard with FCM push delivery

---

_Hushh -- Your data, your consent, your control._
