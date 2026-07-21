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

The hosted Streamable HTTP transport returns the authenticated app's catalog
from `tools/list`; no ResourceLink download, second MCP endpoint, or extra
catalog endpoint is involved. Configure the bearer header or OAuth token, call
`initialize`, then call `tools/list`.

Every authenticated host receives one canonical v0.4 five-tool catalog from
this endpoint. Bearer remains a first-class credential; OAuth PKCE and OAuth
client credentials are alternate authentication methods for the same developer
app identity. They do not select a different endpoint, tool list, or consent
lifecycle.

## Public Tool Surface

The hosted public developer lane exposes five consent tools:

- `search-user-scopes`
- `prepare-campaign-context`
- `request-consent`
- `check-consent-status`
- `get-encrypted-scoped-export`

`prepare-campaign-context` is a first-class external tool. It returns only
safe, least-privilege offer and lifecycle state for an external agent or
frontend. It never returns an internal agent name, developer reference, token,
user identifier, raw backend payload, or connector private-key material.

`search-user-scopes` and `request-consent` accept `user_identifier`. The hosted MCP resolves it internally but never echoes or logs the supplied value or the resolved Firebase UID. Later lifecycle calls use only `request_ref` and `grant_ref`; consent tokens remain internal.

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

1. Call `search-user-scopes(user_identifier, query?, domain?, cursor?, limit?)`; an empty query lists scopes with pagination. Choose the narrowest useful scope.
2. Call `prepare-campaign-context(user_identifier, ...)` when a safe offer/context is needed for a frontend or external agent.
3. Call `request-consent(user_identifier, scope, purpose, ...)`. Retain `request_ref` while pending or `grant_ref` when granted.
4. Bounded-poll `check-consent-status(request_ref)` at the returned interval. Stop on a terminal state or timeout.
5. Call `get-encrypted-scoped-export(grant_ref, expected_scope)` only after approval. Revoked and expired grants fail closed.

Successful results are structured and bounded. Execution errors use `isError: true`
and one safe JSON text item containing only `error_code`, a safe message,
recoverability, next action, and a correlation reference; they intentionally
omit `structuredContent` because error fields do not satisfy a strict success
schema. Approved information is untrusted content and must never be treated as
instructions.

## Local Stdio Auto-Decrypt (npm bridge / repo-local Python)

The local stdio MCP process (spawned by `npx -y @hushh/mcp` or a direct
`python mcp_server.py` invocation) runs as the developer's own trusted
software on their own machine, with loopback network access the LLM host's
own sandbox typically does not have. On this transport only:

- `get_encrypted_scoped_export` decrypts and narrows the export locally,
  returning only a bounded `information` object. Ciphertext and wrapped-key metadata
  never enter the LLM host's context. Results that exceed
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
process to hold a private key. Standard apps provide the connector bundle per
request. An app with a registered connector key may omit it; any legacy bundle
provided must exactly match the active registration. The endpoint returns the
encrypted envelope directly in the MCP tool result; the connector decrypts it
outside model context. No plaintext is returned.

## Claude Remote Connector

Claude must use the same public Streamable HTTP MCP endpoint as hosted partner
connectors. Configure the endpoint through **Customize > Connectors**. Claude
Desktop does not load remote MCP servers from `claude_desktop_config.json`.

For the provisioned **Hussh Technologies** integration, use the existing OAuth
client rather than creating a second app identity:

- endpoint: `https://api.uat.hushh.ai/mcp/`
- Advanced settings: the Hussh Technologies OAuth client ID and secret from the
  approved secret manager
- OAuth redirect URI: `https://claude.ai/api/mcp/auth_callback`
- grants: `authorization_code` and `refresh_token`

The client secret belongs only in Claude's encrypted connector settings. Do
not place it in `claude_desktop_config.json`, a URL, source control, or a
MuleSoft or Salesforce configuration export.

The transport is already compatible:

- endpoint: `https://api.uat.hushh.ai/mcp/`
- transport: Streamable HTTP
- no SSE downgrade
- no query-string credential

Authentication is the remaining host-compatibility boundary. Hussh supports
the existing developer token in `Authorization: Bearer <token>` and OAuth
authorization code with S256 PKCE. Claude custom connectors should use
the OAuth discovery document at `/.well-known/oauth-authorization-server`;
create the confidential client and register its exact callback URI in
`/developers` first. MuleSoft and generic remote hosts may continue injecting
the bearer header. Do not work around either path with stdio, `?token=`, or an
unauthenticated endpoint. OAuth authenticates the connector only; each read
still follows the scoped consent lifecycle and encryption rules above.

### MuleSoft and Agentforce handoff

> **Important current boundary.** The Exchange registration preserves the
> canonical five-tool Hussh catalog. Direct Agentforce identities are
> catalog-only in Hussh because Salesforce does not support user-level
> authentication or personalized MCP responses. MuleSoft uses a separate,
> operations-provisioned Hussh execute application upstream; that does not
> remove Salesforce's host-product limitation. The canonical implementation
> guide is [MuleSoft and Agentforce secure relay](./reference/mulesoft-agentforce-secure-relay.md).

MuleSoft Exchange cannot attach Hussh OAuth credentials while it fetches an
MCP URL for publication. Use **Upload MCP file**, not Fetch MCP URL, and upload
the generated registration projection:

`packages/hushh-mcp/gateway/hushh-mulesoft-exchange-mcp-schema.json`

It contains only the Exchange-supported MCP fields and the canonical five
tools. It intentionally has no endpoint, authentication, client ID, client
secret, host-registration metadata, annotations, or Hussh-specific manifest
metadata. Its open output schemas let MuleSoft pass through both successful
lifecycle state and safe terminal errors without validating an error as a
success response.

Generate or print the exact upload file with:

```bash
cd packages/hushh-mcp
npm run gateway:generate
npm run print-mulesoft-exchange-manifest
```

Configure a dedicated Hussh execute application's OAuth client ID and secret
**separately** in MuleSoft's authenticated upstream connection to
`https://api.uat.hushh.ai/mcp/`. MuleSoft publishes its own endpoint to
Agentforce. Agentforce does not receive or store the Hussh secret; it
authenticates to MuleSoft.

The generated `hushh-agentforce-mcp-manifest.json` remains a diagnostic
handoff/reference artifact, not the file to upload to Exchange. Give the
MuleSoft team its `mulesoftAgentforceHandoff` object unchanged only when they
need relay configuration guidance.

- MuleSoft calls Hussh at `https://api.uat.hushh.ai/mcp/` over Streamable HTTP,
  using either a provisioned **bearer credential** or OAuth client credentials
  for its Hussh execute application. Bearer is first-class and is not a legacy
  path. Direct Agentforce profiles do not execute personalized tools.
- Agentforce authenticates to MuleSoft with MuleSoft-owned OAuth client
  credentials. Do not give the Hussh Technologies client secret to Agentforce.
- API Catalog registration is tools-only and uses the exact five generated
  hyphenated definitions. At the Agentforce-facing MuleSoft edge, use MCP
  Global Access to hide and block `get-encrypted-scoped-export`; that tool is
  a secure Mule connector subflow, not an LLM action. Map
  `structuredContent` as the canonical successful result. `content[0].text`
  is a compatibility mirror and must not be passed to the Agentforce planner
  as a second result.
- Client credentials do not represent a Hussh user. The supplied identifier
  selects the consent subject; explicit approval and the scoped grant remain
  mandatory before encrypted information is returned.

## Partner / CRM Connectors

Compatible hosted CRM connectors (for example MuleSoft-fronted integrations)
connect directly over HTTPS to the remote `/mcp` endpoint, without spawning a
local process. There is one endpoint and one consent lifecycle.

- **Auth**: existing integrations may use `Authorization: Bearer <developer-token>`.
  Explicitly provisioned partner apps may instead use OAuth
  `client_credentials` at `/oauth/token`; they receive an app-bound short-lived
  access token and no refresh token. Query-string
  credentials are rejected so tokens cannot leak through Referer headers,
  access logs, browser history, or CDN/proxy logs. Bearer headers are directly
  compatible with Salesforce Named Credentials.
- **Provisioning**: issue a dedicated `partner_crm` developer app + token per
  CRM system with `consent-protocol/scripts/ops/provision_partner_developer_app.py`:

  ```bash
  cd consent-protocol
  python scripts/ops/provision_partner_developer_app.py \
    --display-name "Partner CRM" \
    --contact-email partners@hushh.ai \
    --crm-id partner-crm-hushh \
    --enable-client-credentials \
    --connector-key-id salesforce-fsc-key-2026-07 \
    --connector-public-key "$PARTNER_X25519_PUBLIC_KEY"
  ```

  Every CRM system gets its own app so revocation, audit, and last-used
  telemetry stay per-system. The operator stores the one-time raw bearer token
  or OAuth client secret only in the partner's secret manager. Hussh stores the
  public X25519 key and fingerprint only, never the partner private key.
### Salesforce Agentforce: catalog registration and secure Mule UAT

Salesforce supports Streamable HTTP and OAuth client credentials for MCP, but
its current [MCP considerations](https://help.salesforce.com/s/articleView?id=ai.agent_mcp_considerations.htm&language=en_US&type=5)
explicitly exclude user-level authentication and use cases that need individual
user IDs or personalized responses. Hussh therefore treats the direct
Agentforce profile as catalog-only. It rejects personalized tool calls with
`REQUIRES_SECURE_CONSENT_FLOW`; that protection must not be relaxed.

MuleSoft uses a separate Hussh execute application in its secured upstream
flow. This permits MuleSoft-to-Hussh UAT of the consent lifecycle but does not
remove Salesforce's documented Agentforce limitation. Production use requires
Salesforce confirmation of the exact branded host boundary. The implementation
and UAT checklist are in [MuleSoft and Agentforce secure relay](./reference/mulesoft-agentforce-secure-relay.md).

MuleSoft must relay the exact generated catalog into Salesforce API Catalog:

- Agentforce → MuleSoft and MuleSoft → Hussh are separate OAuth
  client-credential hops. Neither hop represents a Hussh end user.
- Preserve the five names and their flat input/output schemas exactly in the
  Exchange registration; do not add resources, prompts, nested fields, or a
  wider catalog. Use MuleSoft MCP Global Access to hide and reject tool 5 at
  the Agentforce-facing edge.
- Register and allowlist the server in API Catalog, then inspect the final
  Agentforce Asset Library mappings. Salesforce's
  [API Catalog guidance](https://help.salesforce.com/s/articleView?id=platform.api_catalog_manage_mulesoft_mcp_servers.htm&language=en_US&type=5)
  still requires an authentication protocol supported by the Agentforce MCP
  client.

Print the versioned, non-secret relay handoff before configuring the Mule flow:

```bash
cd packages/hushh-mcp
npm run print-mulesoft-agentforce-handoff
```

This catalog is generated from the runtime and has exactly five tools:

- `search-user-scopes`
- `prepare-campaign-context`
- `request-consent`
- `check-consent-status`
- `get-encrypted-scoped-export`

They have client-facing names/descriptions, primitive or string-array fields,
explicit required inputs, bounded field metadata, and complete output schemas.
The server exposes no resources or prompts to Agentforce and caps the request
timeout at 55 seconds so it settles before Agentforce's 60-second MCP timeout.
Salesforce still documents that Agentforce MCP has no user-level
authentication and does not support use cases requiring individualized
responses. Do not treat any client credential as a Salesforce or Hussh user
identity, and do not enable a personalized Agentforce action until Salesforce
confirms the exact host boundary.

Before every Agentforce registration or schema change, print and review the
generated catalog:

```bash
cd packages/hushh-mcp
npm run print-agentforce-manifest
```

In Agentforce Registry, register the MuleSoft Streamable HTTP endpoint and
configure MuleSoft OAuth client credentials. The Exchange registration remains
five tools; the MuleSoft Agentforce-facing policy controls the safe action
subset. Then inspect the Asset Library action schemas: verify all input/output
field counts and manually
replace any display labels that Salesforce renders as `string`. Salesforce
documents this as a current Builder issue; JSON Schema `title` is included for
inspection but is not claimed as a platform UI fix. Record only safe metadata
(tool IDs, field counts, mapping status, latency, and trace correlation), never
identities, tokens, ciphertext, or customer screenshots.
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
- The remote endpoint returns ciphertext directly over MCP, never plaintext.
  Results above the bounded inline ciphertext limit fail closed and require a
  narrower discovered scope. CRM connectors decrypt and narrow client-side
  with their own registered connector key.

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
cd packages/hushh-mcp
npm run verify:package
npm run print-gateway-manifest
```

`verify:package` installs the generated tarball through an empty npm cache,
initializes a real stdio MCP process, checks the exact public catalog, and
executes both a valid tool call and a strict-schema rejection.
