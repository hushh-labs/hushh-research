<!-- pdf:omit-start -->
## Visual Context

Canonical visual owner: [Operations index](README.md).
<!-- pdf:omit-end -->

## Integration contract at a glance

Hussh Consent MCP gives an external agent a consent-first way to discover the
narrowest available information scope, request approval, follow that approval
to a terminal state, and retrieve only an encrypted scoped export. The public
surface is one Streamable HTTP endpoint and one five-tool catalog. It does not
expose internal agent names, developer application identifiers, access tokens,
connector private keys, or raw backend payloads.

> **Release status · July 20, 2026.** This guide and the accompanying manifest describe package version `0.4.0` and MCP protocol revision `2025-11-25`. Confirm the live UAT `tools/list` response before registration; a package contract and a deployed catalog are separate proofs.

| Contract | Value |
| --- | --- |
| UAT endpoint | `https://api.uat.hushh.ai/mcp/` |
| Transport | MCP Streamable HTTP; keep the trailing slash |
| Protocol revision | `2025-11-25` |
| Public catalog | Five tools, in lifecycle order |
| Canonical result | `structuredContent`; `content[0].text` is its compatibility mirror |
| Export delivery | Inline encrypted MCP result; no `ResourceLink` download |

## One canonical five-tool catalog

The accompanying `hushh-mcp-gateway.json` is the single partner handoff. Its
tool definitions are generated from the same public contract used by
`tools/list`. Hosts may apply a narrower registration policy, but must not
rename tools, expand schemas, or change consent meaning.

| Tool | When an agent should use it | Expected outcome |
| --- | --- | --- |
| `search-user-scopes` | Discover the least-privilege scope available for one user and purpose. | Flat scope values plus pagination state. |
| `prepare-campaign-context` | Prepare a consent-backed offer or campaign context for an external agent or frontend. | Safe lifecycle, approval, scope, offer, and export-readiness fields. |
| `request-consent` | Create or reuse a consent request for one exact scope and stated purpose. | A pending `request_ref` or approved `grant_ref`. |
| `check-consent-status` | Poll one pending request at the returned cadence. | Current lifecycle state and, after approval, a `grant_ref`. |
| `get-encrypted-scoped-export` | Retrieve information only after the grant is approved. | Ciphertext and a flat cryptographic envelope over the MCP result. |

Version `0.4.0` publishes only the hyphenated names above. The earlier
underscore names remain accepted as inbound aliases until **October 20, 2026**,
but are not returned by `tools/list`. New integrations must use the published
hyphenated names.

## Authentication and execution authority

All credential types identify the same provisioned developer application; they
do not create alternate MCP products or endpoints. The application owns tool
entitlements, consent authority, connector public-key binding, status, and
audit attribution. Credential rotation and revocation remain independently
auditable.

| Method | Intended host | Personalized lifecycle execution |
| --- | --- | --- |
| Bearer credential | Hosted MCP clients and approved MuleSoft upstream calls | Supported according to the developer application's entitlements. |
| OAuth 2.0 authorization code with PKCE and refresh | Claude and other user-authorized remote clients | Supported after the person completes the authorization flow. |
| OAuth 2.0 client credentials | Operations-provisioned service clients, MuleSoft, and Agentforce registration | Executes the same consent lifecycle; user approval and a scoped grant still gate information delivery. |

Never place credentials in URLs, query parameters, a manifest, screenshots, or
support messages. Partner secrets are delivered once through the approved
secret manager. The connector private key never leaves partner custody.

### Hosted bearer example

```json
{
  "mcpServers": {
    "hushh-consent": {
      "url": "https://api.uat.hushh.ai/mcp/",
      "headers": {
        "Authorization": "Bearer ${HUSHH_DEVELOPER_TOKEN}"
      }
    }
  }
}
```

### OAuth discovery and token exchange

Use the OAuth metadata published by the environment rather than copying an
authorization URL into application code. A client-credentials token request is
form encoded and contains no user identity:

```text
POST https://api.uat.hushh.ai/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&client_id=${HUSHH_OAUTH_CLIENT_ID}
&client_secret=${HUSHH_OAUTH_CLIENT_SECRET}
&scope=mcp:tools
```

The returned access token belongs in `Authorization: Bearer <access-token>`.
No refresh token is issued for the client-credentials grant.

## Agentforce-first registration through MuleSoft

Agentforce is a tools-only MCP host. MuleSoft should register exactly the five
definitions from the canonical manifest into Salesforce API Catalog and keep
the schemas shallow and unchanged. The integration boundary is:

```text
Agentforce planner
  -> MuleSoft MCP registration: OAuth 2.0 client credentials, tools only
  -> Hussh MCP upstream: Streamable HTTP, registered partner credential
  -> Hussh consent lifecycle: approval, grant, encrypted export
  -> partner connector: decrypt outside the LLM
```

MuleSoft must preserve the published tool names, descriptions, input schemas,
output schemas, and lifecycle order. Do not register resources or prompts,
expand nested fields, or pass both result representations into the planner.
Map `structuredContent` as the canonical action result. Treat
`content[0].text` only as a fallback when structured content is unavailable.
The upstream request timeout is 55 seconds; polling follows the
`poll_after_seconds` returned by Hussh.

Client credentials authenticate Hussh Technologies as the partner application;
they do not authenticate the person identified in a tool request. The person
must still review and approve the exact scope and purpose before a scoped grant
can return encrypted information. A pending request is therefore a successful
lifecycle state, not an authorization failure:

```json
{
  "status": "pending",
  "scope": "attr.financial.sources.*",
  "request_ref": "req_example",
  "grant_ref": "",
  "poll_after_seconds": 5
}
```

Salesforce still documents that Agentforce MCP lacks user-level authentication
and does not support use cases requiring individualized responses. Hussh keeps
the actor model explicit: application authentication starts the workflow;
consent approval authorizes the scoped encrypted export. Partners must validate
this Salesforce host boundary separately from the Hussh lifecycle.

## Consent lifecycle

1. Call `search-user-scopes` with the supplied `user_identifier`. An empty
   query lists available scopes with pagination. Choose the narrowest returned
   value that satisfies the purpose.
2. Call `request-consent` with that exact scope and a clear purpose. Retain the
   returned `request_ref` while approval is pending.
3. Call `check-consent-status` only at the returned interval. Stop polling at a
   terminal state.
4. After approval, retain the returned `grant_ref` and call
   `get-encrypted-scoped-export` with the original scope as `expected_scope`.
5. Decrypt outside the language model. Stop using the grant after expiry or
   revocation.

`prepare-campaign-context` offers the same consent meaning as a one-shot
frontend-oriented preparation flow. It may carry a bounded offer amount,
currency, summary, and settlement reference, then returns only safe flat state
for rendering. It is a first-class public tool, not an internal compatibility
hook.

### Scope discovery request

```json
{
  "jsonrpc": "2.0",
  "id": "discover-1",
  "method": "tools/call",
  "params": {
    "name": "search-user-scopes",
    "arguments": {
      "user_identifier": "person@example.com",
      "query": "investment accounts",
      "limit": 20
    }
  }
}
```

### Consent request

```json
{
  "jsonrpc": "2.0",
  "id": "consent-1",
  "method": "tools/call",
  "params": {
    "name": "request-consent",
    "arguments": {
      "user_identifier": "person@example.com",
      "scope": "attr.financial.sources.*",
      "purpose": "Prepare a reviewed financial planning proposal",
      "expiry_hours": 24,
      "refresh_policy": "continuous_until_expiry"
    }
  }
}
```

## Encrypted export over pure MCP transport

Hosted connectors receive `delivery: encrypted_inline`, ciphertext, and the
flat X25519-AES256-GCM envelope directly in the tool result. Local stdio
connectors may return `delivery: decrypted_local` after decryption inside the
local connector process. Neither mode requires a `ResourceLink`, secondary
download URL, plaintext fallback, query-token authentication, or server-held
connector private key.

`structuredContent` is authoritative. Its JSON-string representation in
`content[0].text` is a backwards-compatible mirror recommended for clients
that do not surface structured content; it is not a second result and must not
be independently sent to an agent planner.

The protocol uses standard X25519 and AES-256-GCM:

```text
shared_secret = X25519(connector_private_key, sender_public_key)
wrapping_key  = SHA-256(shared_secret)

export_key = AES-256-GCM.decrypt(
  key=wrapping_key,
  ciphertext=wrapped_export_key || wrapped_key_tag,
  iv=wrapped_key_iv,
  aad=canonical_json(export_envelope)
)

plaintext = AES-256-GCM.decrypt(
  key=export_key,
  ciphertext=ciphertext || payload_tag,
  iv=payload_iv,
  aad=canonical_json(export_envelope.aad)
)
```

`canonical_json` is recursively key-sorted JSON with compact separators,
encoded as UTF-8. Both AES-GCM operations authenticate their Additional
Authenticated Data. The `aad_sha256` field is a diagnostic digest, not the AAD
value. Rotate an exposed or lost key pair and request a fresh export; never
send a private key in a request, chat, log, ticket, or attachment.

The complete reference implementation is in the
[Developer API decryption guide](https://github.com/hushh-labs/hushh-research/blob/main/consent-protocol/docs/reference/developer-api.md#decrypt-an-encrypted-export-locally).

## CRM transport is a separate plane

MuleSoft-backed Customer Relationship Management operations are private
backend integrations, not additions to the five-tool Consent MCP catalog.
Hussh routes each enabled CRM operation through its registered Streamable HTTP
tool and binds record authority to the authenticated user's server-owned CRM
record ID. The private agent may propose a typed change, but cannot authorize
or execute it. Create, update, and delete remain explicit, idempotent,
reviewable intents with post-operation readback.

The CRM plane and Consent MCP plane may share MuleSoft infrastructure, but
they do not share credentials, schemas, authorization, or payload meaning.

## Troubleshooting by observable result

Diagnose the layer that actually failed before changing schemas or
credentials. A successful connection is not the same proof as a successful
catalog load, and a successful catalog load is not authorization for a
person-specific tool call.

| What the host shows | Likely boundary | Correct next check |
| --- | --- | --- |
| No tools found | Catalog response was rejected or transformed. | Inspect the raw `tools/list` result and validate all five schemas without MuleSoft field expansion. |
| `Invalid method: initialize` | The client and endpoint are not completing the MCP handshake. | Use Streamable HTTP at `/mcp/`, include the trailing slash, and negotiate revision `2025-11-25`. |
| HTTP 401 or 403 | Credential exchange, expiry, revocation, or app entitlement. | Re-run the approved OAuth exchange or rotate the bearer credential; never move the secret into a URL. |
| Generic `Tool execution failed` after tools load | The host hid the MCP structured error or the lifecycle handler rejected the call. | Inspect `structuredContent`, the correlation reference, and backend metadata-only logs; do not infer failure from the host summary alone. |
| HTTP 200 followed by `INVALID_TOOL_RESULT` | The tool completed, but its result did not satisfy the published output schema. | Refresh the v0.4 manifest and compare the live result shape with its `outputSchema`; local decrypted `information_json` supports up to 120,000 characters. This is not a `ResourceLink` or download fallback. |
| Planner sees duplicate information | Both MCP result representations were forwarded. | Send `structuredContent` once and ignore the text mirror unless structured content is absent. |
| Consent remains pending | The person has not approved or the caller is polling incorrectly. | Respect `poll_after_seconds` and stop at the returned terminal state. |
| Decryption authentication fails | Wrong private key, wrong canonical AAD, changed envelope, or mixed ciphertext/tag ordering. | Verify the registered key ID and fingerprint, then follow the reference algorithm exactly. |
| Manifest and live tools differ | Package/deployment drift. | Treat the live `tools/list` response as runtime evidence and stop registration until the intended v0.4 deployment is confirmed. |

> **Acceptance gate.** Approve the integration only after token exchange, protocol initialization, the exact five-tool catalog, and schema loading pass independently. Then test the intended execution credential through consent, polling, encrypted retrieval, and partner-side decryption. Confirm that no secret, private key, supplied user identifier, plaintext information, or internal reference enters logs or planner context.
