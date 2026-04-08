# MCP Host Operations


## Visual Context

Canonical visual owner: [Operations Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

This guide covers the MCP servers we expect local engineering hosts and coding agents to have available when working in this repo.

Use safe config patterns only:

1. Keep secrets in environment variables.
2. Do not commit machine-local config files with inline credentials.
3. Prefer official docs or internal MCP resources over guesswork when a server is available.

## Recommended MCP Servers

### 1. `shadcn`

Purpose:

1. Install registry-backed UI primitives correctly.
2. Inspect examples and registry items before hand-rolling components.

Recommended usage:

1. Add or inspect stock UI primitives before modifying `components/ui/*`.
2. Use it for `Switch`, `Sheet`, `Drawer`, `Dialog`, `Badge`, and other shadcn components.
3. Treat `components/ui/*` as registry-owned and overwrite-safe.

Codex stdio config:

```toml
[mcp_servers.shadcn]
command = "npx"
args = ["shadcn@latest", "mcp"]
enabled = true
```

### 2. `plaid`

Purpose:

1. Look up Plaid endpoint behavior, sandbox guidance, and webhook details.
2. Verify Link, OAuth, Investments, and sandbox behavior against official docs.

Use this for:

1. Sandbox credentials and institution behavior.
2. Investments product details.
3. Webhook codes and refresh behavior.
4. OAuth and Hosted Link documentation.

Safe config example:

```toml
[mcp_servers.plaid]
command = "/opt/homebrew/bin/uvx"
args = ["mcp-server-plaid", "--client-id", "${PLAID_CLIENT_ID}", "--secret", "${PLAID_SECRET}"]
enabled = true

[mcp_servers.plaid.env]
PLAID_ENV = "sandbox"
SSL_CERT_FILE = "/etc/ssl/cert.pem"
REQUESTS_CA_BUNDLE = "/etc/ssl/cert.pem"
CURL_CA_BUNDLE = "/etc/ssl/cert.pem"
```

Required env vars:

1. `PLAID_CLIENT_ID`
2. `PLAID_SECRET`

Do not inline these values in committed config.

### 3. Hushh Consent MCP

Purpose:

1. Access Hushh consent/data tools and internal self-documentation.
2. Verify the same dynamic scope discovery, consent, and encrypted scoped export contract shipped through `@hushh/mcp`.

Public onboarding source:

- npm package page: `https://www.npmjs.com/package/@hushh/mcp`

Repo references:

- `consent-protocol/docs/mcp-setup.md`
- `consent-protocol/docs/reference/developer-api.md`

Codex remote setup:

```bash
codex mcp add hushh_consent --url "https://<consent-api-origin>/mcp/?token=<developer-token>"
```

Codex stdio config:

```toml
[mcp_servers.hushh_consent]
command = "npx"
args = ["-y", "@hushh/mcp"]
enabled = true

[mcp_servers.hushh_consent.env]
HUSHH_MCP_ENV_FILE = "/absolute/path/to/consent-protocol/.env"
```

Repo-local fallback:

```toml
[mcp_servers.hushh_consent]
command = "python"
args = ["/absolute/path/to/consent-protocol/mcp_server.py"]
enabled = true

[mcp_servers.hushh_consent.env]
PYTHONPATH = "/absolute/path/to/consent-protocol"
CONSENT_API_URL = "http://localhost:8000"
FRONTEND_URL = "http://localhost:3000"
```

## Where to configure MCP servers

For Codex-style local configuration, use your machine-local Codex config file. Example locations vary by setup, but the common pattern is a user-local `config.toml`.
`mcp.json` / `mcpServers` examples are for hosts such as Cursor, VS Code, or Claude Desktop, not for Codex.

Rules:

1. Keep this config out of the repo.
2. Store credentials in shell env vars or a local secret store.
3. Treat the examples in this doc as templates, not committed project config.

## How to verify the servers are working

### `shadcn`

1. Confirm the agent can list or inspect shadcn registry components.
2. Try a simple lookup for `switch` or `sheet`.

### `plaid`

1. Confirm the agent can query Plaid docs.
2. Try a sandbox question like “What are the default sandbox credentials?”

### Hushh Consent MCP

1. Confirm the server starts locally with:

```bash
npx -y @hushh/mcp --help
```

2. Confirm the host can discover Hushh tools/resources after attaching it.
3. For hosted UAT, use the slash-safe mount URL: `/mcp/?token=<developer-token>`.
4. `@hushh/mcp` is the default stdio install surface.
5. If you are working contributor-local instead, use the repo-local fallback:

```bash
cd consent-protocol
python mcp_server.py
```

## Developer instructions

When working in this repo:

1. Use `shadcn` MCP before adding or modifying registry-backed UI components.
2. Use `plaid` MCP before guessing on Plaid flows, sandbox behavior, webhooks, or OAuth.
3. Use Hushh Consent MCP when you need internal consent/data-access guidance or machine-readable internal documentation.
4. Use the repo-owned skill `.codex/skills/devops-operations/` for CI/CD, branch protection, merge queue, deploy, env or secret parity, Cloud Run or Cloud Build operations, and operational verification.
   That skill also owns PR approval/admin handling. It must verify live GitHub identity and ruleset state, and it must not treat repo admin status as equivalent to independent PR approval.
5. Use the repo-owned skill `.codex/skills/github-board-operations/` when summarizing or updating `Hushh Engineering Core` board work.
6. Use the repo-owned skill `.codex/skills/documentation-governance/` when reorganizing docs, moving docs, deleting duplicates, or tightening docs verification.
7. Use the frontend skills only for frontend architecture or design-system work; they are not the right path for repository operations.

If a developer has not configured MCP yet:

1. Start with `shadcn` and Hushh Consent MCP first.
2. Add `plaid` only after setting local `PLAID_CLIENT_ID` and `PLAID_SECRET`.
3. Verify each server independently before relying on it inside coding-agent flows.
