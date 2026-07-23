# Developer API

> **Status:** UAT public beta  
> **Audience:** External developers, MCP hosts, and internal teams building against first-party consent flows


## Visual Context

Canonical visual owner: [consent-protocol](../README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

For public host setup and install examples, use the npm package page first:

- [`@hushh/mcp`](https://www.npmjs.com/package/@hushh/mcp)

This page is the API and wire-contract reference, not the primary onboarding surface.

---

## Overview

The Hussh developer contract is versioned under `/api/v1` and built around one scalable rule:

1. Discover the user's scopes at runtime.
2. Request consent for one discovered scope.
3. Wait for the user's approval in the first-party app.
4. Read the encrypted export with `POST /api/v1/scoped-export` or `get-encrypted-scoped-export(...)`.

Do not hardcode domain keys. Dynamic scopes are derived from the indexed PKM and domain registry.

Identifier note:

- Raw `/api/v1` HTTP calls still use the canonical Firebase UID as `user_id`.
- Hosted MCP tool calls may accept the Firebase UID directly, the user's registered email, or the user's phone number.
- MCP resolves email and phone identifiers to the canonical Firebase UID before calling `/api/v1`.
- For national phone numbers, MCP requires an explicit `country_iso2` or `country` hint. It does not assume a default country.

Founder-language framing:

- `PCHP` is implemented today through this `/api/v1` contract plus the hosted MCP transport
- `Capability Tokens` remain explicit in this doc as `developer token` and `consent_token` because the wire contract requires those exact labels
- `Cryptographic Primitives` show up here as connector-held private keys, wrapped export keys, and ciphertext-only responses

---

## Self-Serve Developer Access

Developer access is self-serve from `/developers` in the app:

- Sign in with the same Google or Apple auth flow used by the first-party app.
- Enable developer access once per user account.
- Receive one active developer token, revealed only when first issued or rotated.
- Create an OAuth client and register its exact redirect URIs when the host requires OAuth.
- Update the app identity users see during consent review.

Portal endpoints:

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| `GET` | `/api/developer/access` | Firebase bearer token | Read the current developer workspace state |
| `POST` | `/api/developer/access/enable` | Firebase bearer token | Create the self-serve app and first active token |
| `PATCH` | `/api/developer/access/profile` | Firebase bearer token | Update display name, website, support, and policy links |
| `POST` | `/api/developer/access/rotate-key` | Firebase bearer token | Revoke the current token and issue a replacement |
| `GET` | `/api/developer/access/oauth-client` | Firebase bearer token | Read OAuth client metadata (never its secret) |
| `POST` | `/api/developer/access/oauth-client` | Firebase bearer token | Create or rotate an OAuth client secret; reveal it once |
| `PUT` | `/api/developer/access/oauth-client/redirect-uris` | Firebase bearer token | Register exact HTTPS callback URIs |

The developer token is then sent only in an Authorization header:

```http
GET /api/v1/user-scopes/{user_id}
Authorization: Bearer <developer-token>
```

### OAuth / PKCE for remote connector hosts

OAuth is an additional transport-authentication option for hosts such as Claude that cannot attach a static bearer header. It does **not** replace the consent lifecycle or grant any personal information access.

- Discovery: `GET /.well-known/oauth-authorization-server`
- Authorization: `GET /oauth/authorize` with `response_type=code`, a registered `redirect_uri`, and `code_challenge_method=S256`
- Token and refresh: `POST /oauth/token` with confidential-client authentication and PKCE `code_verifier`
- Revocation: `POST /oauth/revoke`

Authorization-code and refresh-token grants remain the self-serve interactive
path. `client_credentials` is available only to an operations-provisioned
`partner_crm` app with explicit client-credentials enablement. It issues a
short-lived app-bound access token, never a refresh token or synthetic user
subject, and authenticates the same v0.4 five-tool catalog as bearer and PKCE.
Operations-provisioned client credentials may execute the consent lifecycle.
They authenticate only the partner application and never create a synthetic
user subject. The supplied user identifier selects the consent subject;
explicit approval and a valid scoped grant remain mandatory before encrypted
information delivery. The direct Agentforce profile is catalog-only and returns
`REQUIRES_SECURE_CONSENT_FLOW` for a personalized call. The selected enterprise
target is a partner-authorized MuleSoft connector using a dedicated execute app
and partner-controlled key. It performs the consent lifecycle and decryption
outside Agentforce, then exposes only the authorized Salesforce record or
metadata-only delivery status. See [MuleSoft trusted connector for Salesforce
and Agentforce](./mulesoft-agentforce-secure-relay.md).
Register an exact
HTTPS redirect URI for PKCE first; loopback HTTP is permitted solely for local
development. Client secrets, authorization codes, access tokens, refresh
tokens, Firebase identifiers, and consent tokens are never returned by
ordinary portal reads or MCP tools.

### Connector crypto profile boundary

`connector_wrapping_alg` is an exact, allowlisted crypto-profile identifier
bound to the connector key and consent lifecycle. It is not a request-time
algorithm negotiation field. The currently enabled `X25519-AES256-GCM` profile
uses the envelope-v2 X25519 recipient-key exchange and AES-256-GCM payload.
No Salesforce-named profile is enabled until Salesforce provides an exact
recipient-key exchange plus a target-org unwrap, decrypt, and tamper-rejection
test vector. A future profile must use a new authenticated envelope version;
it cannot widen the current enum or reuse envelope v2 without binding its
profile and connector key identifier.

---

## Public Endpoints

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| `GET` | `/api/v1` | Developer API enabled | Root summary for the versioned contract |
| `GET` | `/api/v1/list-scopes` | Developer API enabled | Canonical dynamic scope grammar |
| `GET` | `/api/v1/tool-catalog` | Optional bearer header | Current public-beta tool visibility |
| `GET` | `/api/v1/user-scopes/{user_id}` | Bearer header | Per-user discovered domains and scopes |
| `GET` | `/api/v1/consent-status` | Bearer header | App-scoped consent status by scope or request id |
| `POST` | `/api/v1/request-consent` | Bearer header | Create or reuse consent for one discovered scope |
| `POST` | `/api/v1/scoped-export` | Bearer header | Return an encrypted-inline envelope and ciphertext in the response |

---

## Scope Model

Private-information access uses only the exact, dynamically discovered form:

- `attr.{domain_slug}.{scope_slug}.*`

`pkm.read`, `pkm.write`, and `vault.owner` are internal-only authorities and
are rejected from external discovery and consent requests. Public profiles are
separate owner-controlled projections, not `attr.*` grants.

Availability is derived from:

- `pkm_index.available_domains`
- `pkm_index.summary_projection`
- `domain_registry`

Two users can legitimately expose different scope catalogs.

---

## Request Flow

### 1. Discover user scopes

```http
GET /api/v1/user-scopes/{user_id}
Authorization: Bearer <developer-token>
```

### 2. Request consent

```http
POST /api/v1/request-consent
Content-Type: application/json
Authorization: Bearer <developer-token>

{
  "user_id": "user_123",
  "scope": "attr.financial.portfolio.*",
  "expiry_hours": 24,
  "approval_timeout_minutes": 60,
  "reason": "Explain why the app needs this scope",
  "connector_public_key": "<base64-encoded-x25519-public-key>",
  "connector_key_id": "connector-key-1",
  "connector_wrapping_alg": "X25519-AES256-GCM"
}
```

For the raw HTTP developer API, the connector fields are required unless the
developer app has an active registered connector bundle. An unregistered
standard/flat execute app supplies the complete bundle per request. Registered
apps may omit it; any supplied bundle must match the app's public key, key ID,
and wrapping algorithm exactly. This prevents one app from rebinding a grant to
another connector key. Hussh never manages the connector private key.

### 3. Poll status

```http
GET /api/v1/consent-status?user_id=user_123&scope=attr.financial.portfolio.*
Authorization: Bearer <developer-token>
```

### 4. Wait for first-party approval

The user approves in the first-party app surface. In founder language this is the user-facing PCHP moment. Approval is separate from developer auth and remains app-scoped plus scope-scoped.

### 5. Fetch encrypted export

```http
POST /api/v1/scoped-export
Content-Type: application/json
Authorization: Bearer <developer-token>

{
  "user_id": "user_123",
  "consent_token": "HCT:...",
  "expected_scope": "attr.financial.portfolio.*"
}
```

The response contains envelope metadata and ciphertext directly in the authenticated response:

```json
{
  "status": "success",
  "user_id": "user_123",
  "granted_scope": "attr.financial.portfolio.*",
  "expected_scope": "attr.financial.portfolio.*",
  "coverage_kind": "exact",
  "iv": "<base64-iv>",
  "tag": "<base64-tag>",
  "wrapped_key_bundle": {
    "wrapped_export_key": "<base64-ciphertext>",
    "wrapped_key_iv": "<base64-iv>",
    "wrapped_key_tag": "<base64-tag>",
    "sender_public_key": "<base64-x25519-public-key>",
    "wrapping_alg": "X25519-AES256-GCM",
    "connector_key_id": "connector-key-1"
  },
  "export_revision": 3,
  "export_generated_at": "2026-03-24T18:30:00Z",
  "export_refresh_status": "current",
  "encrypted_data": "<base64-ciphertext>"
}
```

Hussh does not return plaintext user data to developer callers. The external connector receives ciphertext in the authenticated MCP/API response, unwraps the export key locally, decrypts locally, and narrows the export when `granted_scope` is broader than `expected_scope`. No `ResourceLink` follow-up is required.

Before either successful inline route returns ciphertext, Hussh durably records
a state-neutral metadata-only `READ` event. If audit persistence is unavailable,
the route fails closed with `EXPORT_AUDIT_UNAVAILABLE`. The event records
issuance context and never records ciphertext, wrapped keys, complete envelopes,
credentials, supplied identifiers, or decrypted information. It proves release
from Hussh, not connector decryption or destination write success.

For the layer-by-layer PKM storage, consent, MCP, connector, and partner handoff
map, use [Personal Knowledge Model: PKM to MCP encrypted export flow](./personal-knowledge-model.md#pkm-to-mcp-encrypted-export-flow).

## Partner Storage Boundary

The Developer API authorizes an encrypted, scoped export. It does not authorize a partner to persist the export broadly.

External systems such as Salesforce should store only CRM-native metadata and the minimum approved fields needed for the workflow: app identity, request reason, consent receipt id, scope, status, expiry, audit reference, and narrow workflow payloads when there is a clear business or legal purpose. Raw PKM, KYC documents, full email bodies, vault data, user keys, connector private keys, and broad personal profiles are not default partner-storage data.

If a connector decrypts PII and sends plaintext into a partner CRM, that copy is outside the Hussh zero-knowledge boundary. The partner path must have explicit purpose, consent scope, retention, encryption or masking, access control, deletion, and audit ownership before persistence is acceptable.

## Coverage And Upgrade Rules

- If an app already has a broader active grant and asks for a narrower scope, Hussh reuses the existing broader token immediately.
- In that reused-token case, the response includes:
  - `requested_scope`
  - `granted_scope`
  - `coverage_kind`
  - `covered_by_existing_grant`
- When reading with a reused broader token, pass the narrower `expected_scope`. Hussh still returns the canonical broader encrypted export, and your connector narrows it after local decryption.
- If an app already has a narrower active grant and asks for a broader parent scope, that is a real privilege increase and still requires fresh user approval.
- After approval of a broader parent scope, the broader token becomes canonical and the older narrower token is superseded in the audit trail.
- Exact duplicate pending requests for the same app + scope are reused instead of creating a second pending row.

## Export Refresh

- Consent permissions stay active until expiry, revocation, or supersession.
- The encrypted export is refreshed separately from the permission when the user updates PKM data under an active granted scope.
- Refresh is generated on the unlocked first-party app after local decryption of the latest PKM and then uploaded back as new ciphertext plus a new wrapped export key.
- Hussh infrastructure stores ciphertext only and never performs server-side decrypt for developer data refreshes.

## Client-Side Connector Example

Generate the connector keypair locally and keep the private key off Hussh infrastructure:

```js
const keyPair = await crypto.subtle.generateKey(
  { name: "X25519" },
  true,
  ["deriveBits"]
);

const connectorPublicKey = btoa(
  String.fromCharCode(
    ...new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey))
  )
);
```

Request consent with that public key bundle:

```js
await fetch("/api/v1/request-consent", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer <developer-token>",
  },
  body: JSON.stringify({
    user_id: "user_123",
    scope: "attr.financial.portfolio.*",
    connector_public_key: connectorPublicKey,
    connector_key_id: "connector-key-1",
    connector_wrapping_alg: "X25519-AES256-GCM",
  }),
});
```

Fetch the encrypted export after approval:

```js
const scopedExport = await fetch("/api/v1/scoped-export", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer <developer-token>",
  },
  body: JSON.stringify({
    user_id: "user_123",
    consent_token: "HCT:...",
    expected_scope: "attr.financial.portfolio.*",
  }),
}).then((response) => response.json());

const ciphertext = base64ToBytes(scopedExport.encrypted_data);
```

For a successful hosted MCP equivalent, the envelope is nested in the MCP tool
result. Prefer `structuredContent`; `content[0].text` is its JSON-string
mirror for MCP clients that do not expose structured content. An execution
error uses `isError: true` plus safe text content and deliberately omits
`structuredContent`, because it cannot satisfy the strict success schema.
Hosted MCP uses
`ciphertext`, where the raw HTTP API uses `encrypted_data`:

```js
const scopedExport = toolResult.structuredContent ?? JSON.parse(
  toolResult.content.find((item) => item.type === "text")?.text ?? "{}"
);
const ciphertext = base64ToBytes(scopedExport.ciphertext);
```

Then unwrap and decrypt locally. Consent export envelope v2 authenticates both
AES-GCM operations. Do not omit `additionalData`, stringify the envelope
exactly as shown, or substitute a new key pair after requesting consent.

```js
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)])
    );
  }
  return value;
}

const canonicalJson = (value) => JSON.stringify(stableValue(value));

async function decryptScopedExport(
  scopedExport,
  ciphertext,
  connectorPrivateKey,
  connectorKeyId
) {
  const envelope = scopedExport.export_envelope;
  if (envelope?.version !== 2) throw new Error("Expected consent export envelope v2.");
  if (scopedExport.wrapped_key_bundle.connector_key_id !== connectorKeyId) {
    throw new Error("This export was wrapped for a different connector key.");
  }
  const senderPublicKey = await crypto.subtle.importKey(
    "raw",
    base64ToBytes(scopedExport.wrapped_key_bundle.sender_public_key),
    { name: "X25519" },
    false,
    []
  );
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: "X25519", public: senderPublicKey },
    connectorPrivateKey,
    256
  );
  const wrappingKeyBytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", sharedSecret)
  );
  const wrappingKey = await crypto.subtle.importKey(
    "raw",
    wrappingKeyBytes,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );

  const wrappedKeyCiphertext = concatBytes(
    base64ToBytes(scopedExport.wrapped_key_bundle.wrapped_export_key),
    base64ToBytes(scopedExport.wrapped_key_bundle.wrapped_key_tag)
  );
  const rawExportKey = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(scopedExport.wrapped_key_bundle.wrapped_key_iv),
      additionalData: new TextEncoder().encode(canonicalJson(envelope)),
    },
    wrappingKey,
    wrappedKeyCiphertext
  );

  const exportKey = await crypto.subtle.importKey(
    "raw",
    rawExportKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  const encryptedPayload = concatBytes(
    new Uint8Array(ciphertext),
    base64ToBytes(scopedExport.tag)
  );
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(scopedExport.iv),
      additionalData: new TextEncoder().encode(canonicalJson(envelope.aad)),
    },
    exportKey,
    encryptedPayload
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}
```

The connector private key must correspond to the exact public key and
`connector_key_id` supplied in the approved consent request. If that private
key is unavailable, create and securely retain a new connector key pair, then
request fresh consent and fetch a new export. For the selected MuleSoft target,
key generation/import happens in the partner-controlled connector/KMS boundary;
Agentforce and Hussh never receive the private key. Never send a connector
private key in a request, chat, log, or support ticket.

If `granted_scope` is broader than `expected_scope`, narrow the decrypted JSON locally to the requested subtree before using it.

For a Java 17 connector, use the runnable
[Java 17/JCA consent-export decryptor](../../examples/java17-jca-export-decryptor/README.md).
It consumes the flat hosted-MCP fields, validates the authenticated lifecycle
context, and implements the exact current `X25519-AES256-GCM` envelope without
adding a Java-specific profile.

---

## Developer MCP Surface

The v0.4 MCP surface is one host-safe projection over this compatible raw HTTP
API. Bearer, OAuth PKCE, and OAuth client credentials authenticate the same
developer-app identity and catalog:

1. `search-user-scopes(user_identifier, query?, domain?, cursor?, limit?)`
2. `prepare-campaign-context(user_identifier, ...)` for safe offer/context state
3. `request-consent(user_identifier, scope, purpose, ...)`
4. bounded `check-consent-status(request_ref)`
5. `get-encrypted-scoped-export(grant_ref, expected_scope)`

The MCP projection never returns raw HTTP `user_id` or `consent_token` fields.
It resolves identity, tokens, app binding, and revocation internally. Raw
`/api/v1` clients continue using the documented HTTP fields above.

The v0.3 underscore names remain accepted inbound until 2026-10-20, but
`tools/list` publishes only the v0.4 hyphenated names.

Machine-readable references:

- `hushh://info/connector`
- `hushh://info/developer-api`

---

## Scale Guidance

- Discover scopes per user and treat them as mutable runtime state.
- The app identity shown to users comes from the self-serve developer workspace, not a caller-supplied agent id.
- Prefer one encrypted scoped-export path over named domain-specific getters.
- Keep request volume bounded after denials; cooldown behavior may apply to repeated re-requests.
