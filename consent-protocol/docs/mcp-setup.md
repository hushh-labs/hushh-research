# MCP Technical Companion

## Visual Context

Canonical visual owner: [consent-protocol](README.md). This page is the technical companion to the public npm package page.

## Public Onboarding Source

Start public MCP setup from the npm package page:

- npm package: [`@hushh/mcp`](https://www.npmjs.com/package/@hushh/mcp)

That page is the canonical public source for:

- what Hushh MCP is
- the promoted UAT endpoint
- remote vs npm bridge usage
- host setup examples
- public tools and resources

This doc covers runtime details, contributor-local fallback, and operational notes.

## Runtime Model

Hushh MCP supports three runtime shapes:

1. Hosted remote MCP for hosts that support HTTP MCP directly.
2. The npm bridge (`npx -y @hushh/mcp`) for hosts that still expect a local stdio process.
3. Repo-local Python fallback for contributors.

The public promoted environment is **UAT**:

- app workspace: `https://uat.kai.hushh.ai/developers`
- API origin: `https://api.uat.hushh.ai`
- MCP endpoint: `https://api.uat.hushh.ai/mcp/?token=<developer-token>`

Use the trailing-slash endpoint shape:

- `https://api.uat.hushh.ai/mcp/?token=<developer-token>`
- not `https://api.uat.hushh.ai/mcp?token=<developer-token>`

## Public Tool Surface

The hosted public developer lane exposes the consent core only:

- `discover_user_domains`
- `request_consent`
- `check_consent_status`
- `get_encrypted_scoped_export`
- `validate_token`
- `list_scopes`

Read-only self-documentation resources:

- `hushh://info/server`
- `hushh://info/protocol`
- `hushh://info/connector`

Use [`reference/developer-api.md`](./reference/developer-api.md) for the HTTP contract, example payloads, and consent/export semantics.

## Contributor-Local Fallback

Use repo-local Python only for contributor workflows:

```bash
cd consent-protocol
python mcp_server.py
```

Typical cases:

- you are changing the MCP server itself
- you want to bypass npm bootstrap during local development
- you need to test against a local backend revision before publishing or deploying

If you want the same install shape external developers use, prefer:

```bash
npx -y @hushh/mcp --help
```

## Environment Notes

Canonical env vars for stdio hosts:

- `CONSENT_API_URL`
- `HUSHH_DEVELOPER_TOKEN`

The npm bridge also supports:

- `HUSHH_MCP_ENV_FILE`
- `HUSHH_MCP_RUNTIME_DIR`
- `HUSHH_MCP_CACHE_DIR`
- `HUSHH_MCP_PYTHON`
- `HUSHH_MCP_SKIP_BOOTSTRAP`

Repo-local fallback still relies on the normal `consent-protocol` backend/runtime env.

## Operational Notes

- Public onboarding is UAT-first until production developer access is promoted.
- The npm package is the public install surface; this repo doc should not reintroduce a second public quickstart.
- Keep credentials machine-local. Do not commit host config files with inline developer tokens.
- The remote MCP contract is query-token based today, so treat the full URL as secret material.

## Verification

For public MCP verification, the source-of-truth regressions are:

- `python scripts/uat_kai_regression_smoke.py --scenario mcp_transport ...`
- `python scripts/uat_kai_regression_smoke.py --scenario mcp_consent ...`

For package verification:

```bash
npm view @hushh/mcp version dist-tags --json
npx -y @hushh/mcp --help
```
