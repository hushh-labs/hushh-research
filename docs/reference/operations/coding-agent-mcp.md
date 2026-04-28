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

### 3. Hussh Consent MCP

Purpose:

1. Access Hussh consent/data tools and internal self-documentation.
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
APP_FRONTEND_ORIGIN = "http://localhost:3000"
```

## Where to configure MCP servers

For Codex-style local configuration, use your machine-local Codex config file. Example locations vary by setup, but the common pattern is a user-local `config.toml`.
`mcp.json` / `mcpServers` examples are for hosts such as Cursor, VS Code, or Claude Desktop, not for Codex.

Rules:

1. Keep this config out of the repo.
2. Store credentials in shell env vars or a local secret store.
3. Treat the examples in this doc as templates, not committed project config.

Repo-scoped exception:

1. Project-scoped custom-agent defaults may live in `.codex/config.toml` and `.codex/agents/`.
2. Keep that repo config non-secret. MCP credentials and user-local server config still belong in the machine-local Codex config, not the repo.

## Repo-scoped custom agents

Codex supports project-scoped custom agents under `.codex/agents/`. In this repo, that surface is intentionally bounded:

1. Subagent use is explicit only; do not add repo instructions that auto-fan-out by default.
2. Every non-trivial task should run the root `AGENTS.md` delegation checkpoint before choosing a local-only path.
3. Use subagents for independent evidence lanes, not for final authority, branch operations, approval, merge, deploy, or credential handling.
4. Most repo custom agents should stay `read-only`.
5. Repo custom agents inherit the parent-session model and reasoning by default; pinning is an exception for future specialized lanes.
6. The parent session or the built-in `worker` owns edits unless a narrower workflow says otherwise.
7. Repo-level fan-out stays capped in `.codex/config.toml`:
   - `max_threads = 6`
   - `max_depth = 1`
8. Govern repo-scoped agent files, limits, and handoff rules through `.codex/skills/agent-orchestration-governance/`.
9. The self-maintenance model is validation plus CI enforcement through the existing `Governance` job, not autonomous rewrite or scheduled mutation.

## How to verify the servers are working

### `shadcn`

1. Confirm the agent can list or inspect shadcn registry components.
2. Try a simple lookup for `switch` or `sheet`.

### `plaid`

1. Confirm the agent can query Plaid docs.
2. Try a sandbox question like “What are the default sandbox credentials?”

### Hussh Consent MCP

1. Confirm the server starts locally with:

```bash
npx -y @hushh/mcp --help
```

2. Confirm the host can discover Hussh tools/resources after attaching it.
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
3. Use Hussh Consent MCP when you need internal consent/data-access guidance or machine-readable internal documentation.
4. Start with `./bin/hushh codex onboard` for first-run contributor or agent orientation.
5. Use `./bin/hushh codex list-workflows`, `route-task <workflow-id>`, and `impact <workflow-id>` for recurring repo workflows before improvising a route.
6. Use `./bin/hushh codex ci-status --watch` when the task depends on live PR checks or GitHub Actions state.
7. Use `./bin/hushh codex rca --surface <uat|runtime|ci>` when the task starts from a core runtime, deploy, or semantic verification failure and needs a resume-safe RCA artifact.
8. Use the repo-owned skill `.codex/skills/repo-context/` when the task starts with "scan the repo", "establish context", "map the codebase", or is otherwise cross-domain.
9. Use owner skills for broad domain intake:
   - `.codex/skills/frontend/`
   - `.codex/skills/mobile-native/`
   - `.codex/skills/backend/`
   - `.codex/skills/security-audit/`
   - `.codex/skills/docs-governance/`
   - `.codex/skills/repo-operations/`
   - `.codex/skills/autonomous-rca-governance/`
   - `.codex/skills/oss-license-governance/`
   - `.codex/skills/contributor-onboarding/`
   - `.codex/skills/subtree-upstream-governance/`
10. Use spoke skills only after the domain is narrowed to a specific frontend, backend, mobile, security, or repo-operations workflow.
11. Use `.codex/skills/github-contribution-governance/` for GitHub contribution attribution, author-email checks, PR targeting, and green-dot eligibility.
12. Use `.codex/skills/codex-skill-authoring/` when creating or retrofitting repo-local Codex skills, adding skill tooling, or tightening the local taxonomy and coverage rules.
13. Use `.codex/skills/future-planner/` for future-state roadmap concepts, R&D architecture notes, and planning-only assessments that must stay separate from north-star vision and active implementation docs.
14. Use `.codex/skills/planning-board/` for `Hussh Engineering Core` board work and `.codex/skills/comms-community/` for public/community explanation workflows.
15. Use `.codex/skills/agent-orchestration-governance/` when changing repo-scoped custom agents, `.codex/config.toml` agent limits, or delegation authority and handoff rules.

If a developer has not configured MCP yet:

1. Start with `shadcn` and Hussh Consent MCP first.
2. Add `plaid` only after setting local `PLAID_CLIENT_ID` and `PLAID_SECRET`.
3. Verify each server independently before relying on it inside coding-agent flows.
