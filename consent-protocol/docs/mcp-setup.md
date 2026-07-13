# MCP Technical Companion

## Visual Context

Canonical visual owner: [consent-protocol](README.md). This page is the technical companion to the public npm package page.

Founder-language mapping:

- `PCHP` is implemented today through the hosted MCP and `/api/v1` approval/export flow documented here and in the package README
- `Developer API / MCP` is the public developer lane
- `Capability Tokens` remain explicit in setup examples as `developer token`

## Public Onboarding Source

Start public MCP setup from the npm package page:

- npm package: [`@hushh/mcp`](https://www.npmjs.com/package/@hushh/mcp)

That page is the canonical public source for:

- what Hussh MCP is
- the promoted UAT endpoint
- remote vs npm bridge usage
- host setup examples
- public tools and resources

This doc covers runtime details, contributor-local fallback, and operational notes.

## Runtime Model

Hussh MCP supports three runtime shapes:

1. Hosted remote MCP for hosts that support HTTP MCP directly.
2. The npm bridge (`npx -y @hushh/mcp`) for hosts that still expect a local stdio process.
3. Repo-local Python fallback for contributors.

The public promoted environment is **UAT**:

- app workspace: `https://uat.one.hushh.ai/developers`
- API origin: `https://api.uat.hushh.ai`
- MCP endpoint: `https://api.uat.hushh.ai/mcp/`

Use the trailing-slash endpoint shape:

- `https://api.uat.hushh.ai/mcp/`
- authenticate with `Authorization: Bearer <developer-token>`
- query-string tokens are rejected

## Public Tool Surface

The hosted public developer lane exposes the consent core only:

- `prepare_campaign_context`
- `discover_user_domains`
- `request_consent`
- `check_consent_status`
- `get_encrypted_scoped_export`
- `validate_token`
- `list_scopes`

When an MCP tool asks for `user_id`, callers may provide the canonical Firebase UID, the user's registered email, or the user's phone number. The hosted MCP resolves email and phone identifiers to the Firebase UID before hitting the `/api/v1` backend contract.

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

Use [`reference/developer-api.md`](./reference/developer-api.md) for the HTTP contract, example payloads, and consent/export semantics.

Expected coding-agent lifecycle:

Campaign/customer-experience agents should call `prepare_campaign_context` first. It performs discovery, least-privilege scope selection, grant reuse, consent request/reuse, bounded polling, and encrypted-export metadata lookup. Use the lower-level tools below only when implementing the lifecycle manually.

1. Call `discover_user_domains` for the specific user identifier.
2. Choose the least-privilege returned scope for the stated purpose.
3. Call `check_consent_status` with `user_id` and `scope` before creating a request.
4. Call `request_consent` only when no active grant exists. Include connector public-key fields plus optional `expiry_hours` and `approval_timeout_minutes`.
5. If pending, bounded-poll `check_consent_status`; SSE waiting is disabled for this consent flow today.
6. After approval, fetch `get_encrypted_scoped_export` and decrypt locally with the connector private key.

## Local Stdio Auto-Decrypt (npm bridge / repo-local Python)

The local stdio MCP process (spawned by `npx -y @hushh/mcp` or a direct
`python mcp_server.py` invocation) runs as the developer's own trusted
software on their own machine, with loopback network access the LLM host's
own sandbox typically does not have. On this transport only:

- `get_encrypted_scoped_export` decrypts and narrows the export locally,
  returning only a bounded `data` object. Ciphertext, wrapped-key metadata,
  and resource fetches never enter the LLM host's context. Results that exceed
  the model-result limit require a narrower semantic scope.
- `request_consent` no longer requires `connector_public_key`,
  `connector_key_id`, or `connector_wrapping_alg`: the local server generates
  and persists its own X25519 keypair on first use (default
  `~/.hushh/mcp/connector_keypair.json`, override the directory with
  `HUSHH_MCP_STATE_DIR`; file permissions `0600`). Explicit args still win if
  you pass your own key.
- Consent grants created before this key auto-fill self-heal on the next
  `request_consent` call. A grant bound to a discarded connector key requires
  a new consent request with a retained key.

The remote/hosted MCP endpoint (`/mcp`, see below) has no local trusted
process to hold a private key. It requires explicit connector arguments and
returns envelope metadata plus an authenticated ciphertext resource link; the
connector fetches and decrypts the resource outside model context.

## Partner / CRM Connectors (Salesforce Agentforce, Mulesoft-Fronted Systems)

Hosted CRM platforms (for example Salesforce Agentforce/FSC via a Named
Credential, or a Mulesoft-fronted integration) connect directly over HTTPS to
the remote `/mcp` endpoint, without spawning any local process.

- **Auth**: use `Authorization: Bearer <developer-token>`. Query-string
  credentials are rejected so tokens cannot leak through Referer headers,
  access logs, browser history, or CDN/proxy logs. Bearer headers are directly
  compatible with Salesforce Named Credentials.
- **Provisioning**: issue a dedicated `partner_crm` developer app + token per
  CRM system with `consent-protocol/scripts/ops/provision_partner_developer_app.py`:

  ```bash
  cd consent-protocol
  python scripts/ops/provision_partner_developer_app.py \
    --display-name "Salesforce FSC" \
    --contact-email partners@hushh.ai \
    [--crm-id salesforce-fsc-hushh]
  ```

  Every CRM system gets its own token so revocation, audit, and last-used
  telemetry stay per-system. The raw token prints once on issuance; store it
  in the partner's secret manager (Salesforce Named Credential, Mulesoft
  connected-app config, etc.) immediately.
- **Rate limits**: the remote endpoint enforces a per-developer-app rate
  limit (default `120/minute`, configurable via `MCP_REMOTE_RATE_LIMIT`) and
  a per-request timeout (default 120s, configurable via
  `MCP_REMOTE_REQUEST_TIMEOUT_SECONDS`). Exceeding the limit returns
  `429 RATE_LIMIT_EXCEEDED`; design integrator retries with standard
  exponential backoff. A hung request returns `504 REQUEST_TIMEOUT`.
- **Session model**: the remote endpoint runs in stateless streamable-HTTP
  mode: no `Mcp-Session-Id` header is issued and there is no session
  resumability. This is transparent for standard one-shot tool-call patterns
  (`initialize` → `tools/call` → response per request), which is how the
  reference test coverage (`tests/test_mcp_remote_endpoint.py`) and the
  manual UAT smoke script (`scripts/uat_kai_regression_smoke.py --scenario
  mcp_transport` / `mcp_consent`) exercise it. Do not design an integration
  that depends on cross-request session state surviving between separate
  streamable-HTTP connections.
- The remote endpoint returns authenticated resource links, never plaintext or
  inline megabyte ciphertext. CRM connectors fetch, decrypt, and narrow
  client-side with their own registered connector key.

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

Local stdio auto-decrypt (this server, not the npm bridge):

- `HUSHH_MCP_STATE_DIR` — overrides where the persisted connector keypair is stored (default `~/.hushh/mcp`).

Remote MCP production hardening (server-side, not client-facing):

- `MCP_REMOTE_RATE_LIMIT` — per-developer-app rate limit for `/mcp` (default `120/minute`).
- `MCP_REMOTE_REQUEST_TIMEOUT_SECONDS` — per-request timeout for `/mcp` (default `120`).

Repo-local fallback still relies on the normal `consent-protocol` backend/runtime env.

## Operational Notes

- Public onboarding is UAT-first until production developer access is promoted.
- The npm package is the public install surface; this repo doc should not reintroduce a second public quickstart.
- Keep credentials machine-local. Do not commit host config files with inline developer tokens.
- The remote MCP contract accepts only `Authorization: Bearer <token>`; never put a developer token in a URL.
- The published npm tarball should include package-local `LICENSE` and `NOTICE` files for Apache redistribution.

## Verification

For public MCP verification, the source-of-truth regressions are:

- `python scripts/uat_kai_regression_smoke.py --scenario mcp_transport ...`
- `python scripts/uat_kai_regression_smoke.py --scenario mcp_consent ...`
- `pytest tests/test_mcp_remote_endpoint.py` — CI-gated coverage for the live `/mcp` ASGI mount (auth, rate limiting, timeout), independent of environment reachability.

For package verification:

```bash
npm view @hushh/mcp version dist-tags --json
(
  cd packages/hushh-mcp
  npm pack --dry-run
)
npx -y @hushh/mcp --help
```
