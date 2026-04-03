# Developer API

> **Status:** UAT public beta  
> **Audience:** External developers, MCP hosts, and internal teams building against Kai consent flows


## Visual Context

Canonical visual owner: [consent-protocol](../README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

---

## Overview

The Hushh developer contract is versioned under `/api/v1` and built around one scalable rule:

1. Discover the user's scopes at runtime.
2. Request consent for one discovered scope.
3. Wait for the user's approval in Kai.
4. Read the encrypted export with `POST /api/v1/scoped-export` or `get_encrypted_scoped_export(...)`.

Do not hardcode domain keys. Dynamic scopes are derived from the indexed PKM and domain registry.

---

## Self-Serve Developer Access

Developer access is self-serve from `/developers` in the app:

- Sign in with the same Google or Apple auth flow used in Kai.
- Enable developer access once per Kai account.
- Receive one active developer token, revealed only when first issued or rotated.
- Update the app identity users see during consent review.

Portal endpoints:

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| `GET` | `/api/developer/access` | Firebase bearer token | Read the current developer workspace state |
| `POST` | `/api/developer/access/enable` | Firebase bearer token | Create the self-serve app and first active token |
| `PATCH` | `/api/developer/access/profile` | Firebase bearer token | Update display name, website, support, and policy links |
| `POST` | `/api/developer/access/rotate-key` | Firebase bearer token | Revoke the current token and issue a replacement |

The developer token is then used as:

```http
GET /api/v1/user-scopes/{user_id}?token=<developer-token>
```

---

## Public Endpoints

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| `GET` | `/api/v1` | Developer API enabled | Root summary for the versioned contract |
| `GET` | `/api/v1/list-scopes` | Developer API enabled | Canonical dynamic scope grammar |
| `GET` | `/api/v1/tool-catalog` | Optional `?token=...` | Current public-beta tool visibility |
| `GET` | `/api/v1/user-scopes/{user_id}` | `?token=<developer-token>` | Per-user discovered domains and scopes |
| `GET` | `/api/v1/consent-status` | `?token=<developer-token>` | App-scoped consent status by scope or request id |
| `POST` | `/api/v1/request-consent` | `?token=<developer-token>` | Create or reuse consent for one discovered scope |
| `POST` | `/api/v1/scoped-export` | `?token=<developer-token>` | Return ciphertext plus wrapped-key metadata for one approved grant |

---

## Scope Model

Requestable developer scopes:

- `pkm.read`
- `pkm.write`
- `attr.{domain}.*`
- `attr.{domain}.{subintent}.*`
- `attr.{domain}.{path}`

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
?token=<developer-token>
```

### 2. Request consent

```http
POST /api/v1/request-consent
?token=<developer-token>
Content-Type: application/json

{
  "user_id": "user_123",
  "scope": "attr.financial.*",
  "expiry_hours": 24,
  "approval_timeout_minutes": 60,
  "reason": "Explain why the app needs this scope",
  "connector_public_key": "<base64-encoded-x25519-public-key>",
  "connector_key_id": "connector-key-1",
  "connector_wrapping_alg": "X25519-AES256-GCM"
}
```

For the raw HTTP developer API, the connector fields are required. They tell Hushh which public key to use when wrapping the export key for later client-side decryption. MCP callers also provide the same connector bundle fields. Hushh never manages the connector private key.

### 3. Poll status

```http
GET /api/v1/consent-status?user_id=user_123&scope=attr.financial.*
?token=<developer-token>
```

### 4. Wait for approval in Kai

The user approves in the Kai app. Approval is separate from developer auth and remains app-scoped plus scope-scoped.

### 5. Fetch encrypted export

```http
POST /api/v1/scoped-export
?token=<developer-token>
Content-Type: application/json

{
  "user_id": "user_123",
  "consent_token": "HCT:...",
  "expected_scope": "attr.financial.*"
}
```

The response contains ciphertext only:

```json
{
  "status": "success",
  "user_id": "user_123",
  "granted_scope": "attr.financial.*",
  "expected_scope": "attr.financial.*",
  "coverage_kind": "exact",
  "encrypted_data": "<base64-ciphertext>",
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
  "export_refresh_status": "current"
}
```

Hushh does not return plaintext user data to developer callers. The external connector unwraps the export key locally, decrypts the payload locally, and narrows the export locally when `granted_scope` is broader than `expected_scope`.

## Coverage And Upgrade Rules

- If an app already has a broader active grant and asks for a narrower scope, Hushh reuses the existing broader token immediately.
- In that reused-token case, the response includes:
  - `requested_scope`
  - `granted_scope`
  - `coverage_kind`
  - `covered_by_existing_grant`
- When reading with a reused broader token, pass the narrower `expected_scope`. Hushh still returns the canonical broader encrypted export, and your connector narrows it after local decryption.
- If an app already has a narrower active grant and asks for a broader parent scope, that is a real privilege increase and still requires fresh user approval.
- After approval of a broader parent scope, the broader token becomes canonical and the older narrower token is superseded in the audit trail.
- Exact duplicate pending requests for the same app + scope are reused instead of creating a second pending row.

## Export Refresh

- Consent permissions stay active until expiry, revocation, or supersession.
- The encrypted export is refreshed separately from the permission when the user updates PKM data under an active granted scope.
- Refresh is generated on the unlocked first-party app after local decryption of the latest PKM and then uploaded back as new ciphertext plus a new wrapped export key.
- Hushh infrastructure stores ciphertext only and never performs server-side decrypt for developer data refreshes.

## Client-Side Connector Example

Generate the connector keypair locally and keep the private key off Hushh infrastructure:

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
await fetch("/api/v1/request-consent?token=<developer-token>", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    user_id: "user_123",
    scope: "attr.financial.*",
    connector_public_key: connectorPublicKey,
    connector_key_id: "connector-key-1",
    connector_wrapping_alg: "X25519-AES256-GCM",
  }),
});
```

Fetch the encrypted export after approval:

```js
const scopedExport = await fetch("/api/v1/scoped-export?token=<developer-token>", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    user_id: "user_123",
    consent_token: "HCT:...",
    expected_scope: "attr.financial.profile.*",
  }),
}).then((response) => response.json());
```

Then unwrap and decrypt locally:

```js
async function decryptScopedExport(scopedExport, connectorPrivateKey) {
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
    base64ToBytes(scopedExport.encrypted_data),
    base64ToBytes(scopedExport.tag)
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(scopedExport.iv) },
    exportKey,
    encryptedPayload
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}
```

If `granted_scope` is broader than `expected_scope`, narrow the decrypted JSON locally to the requested subtree before using it.

---

## Developer MCP Surface

The public developer MCP flow is:

1. `discover_user_domains(user_id)`
2. `request_consent(user_id, discovered_scope)`
3. `check_consent_status(user_id, discovered_scope)`
4. `get_encrypted_scoped_export(user_id, consent_token, expected_scope=discovered_scope)`

Machine-readable references:

- `hushh://info/connector`
- `hushh://info/developer-api`

---

## Scale Guidance

- Discover scopes per user and treat them as mutable runtime state.
- The app identity shown to users comes from the self-serve developer workspace, not a caller-supplied agent id.
- Prefer one encrypted scoped-export path over named domain-specific getters.
- Keep request volume bounded after denials; cooldown behavior may apply to repeated re-requests.
