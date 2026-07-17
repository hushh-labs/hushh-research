<!-- pdf:omit-start -->
## Visual Context

Canonical visual owner: [Operations index](README.md).
<!-- pdf:omit-end -->

## Partner integration guide · UAT

Hussh Consent MCP lets an external agent request narrowly scoped information
only after the person has approved the stated purpose. The public integration
surface is deliberately small: four core lifecycle tools and one compatibility
tool retained for the Hussh ADK campaign agent.

> **Current UAT contract.** Use `https://api.uat.hushh.ai/mcp/` with `Authorization: Bearer <developer-token>`. Keep the trailing slash. Never put credentials in a URL.

## The public tools

| Tool | Use it for | Integration note |
| --- | --- | --- |
| `search_user_scopes` | Find the narrowest available scope for a person and purpose. | An empty query can page through available scopes. |
| `request_consent` | Present a specific scope and purpose for approval. | Idempotent for an equivalent active grant or pending request. |
| `check_consent_status` | Check the status of a pending consent request. | Poll only at the returned interval and stop at a terminal state. |
| `get_encrypted_scoped_export` | Retrieve an approved scoped export. | Fails closed after revocation or expiry. |
| `prepare_campaign_context` | Compatibility one-shot for the Hussh ADK campaign agent. | New partner integrations should use the four core lifecycle tools directly. |

The prior MCP tools `discover_user_domains`, `list_scopes`, and `validate_token`
are not part of this catalog. Discovery is performed through
`search_user_scopes`; token handling is internal to Hussh.

## The consent lifecycle

1. Call `search_user_scopes` with the caller-supplied `user_identifier`, a query when useful, and optional domain or country hints. Hussh resolves the identity internally; it never returns the identifier or a Firebase UID.
2. Call `request_consent` with the selected scope and a clear, specific purpose.
3. If the request is still awaiting approval, retain the returned `request_ref` and call `check_consent_status` at the supplied interval.
4. After approval, Hussh returns a `grant_ref`. Call `get_encrypted_scoped_export` with that reference and the expected scope.

| Reference | Meaning | Retain until |
| --- | --- | --- |
| `request_ref` | The pending approval lifecycle request. | It reaches a terminal status. |
| `grant_ref` | The approved, scoped authority used for one encrypted export. | It expires, is revoked, or the export is no longer needed. |

## Connector setup

Use one transport mode per connector. The hosted connector is a Streamable HTTP
MCP client; it does not download a second resource after a tool call.

| Mode | Connector responsibility | Hussh responsibility |
| --- | --- | --- |
| Local stdio | Keep its private key locally and decrypt bounded approved information locally. | Return only the approved result to the local connector process. |
| Hosted Streamable HTTP | Send the developer Bearer header and its X25519 public-key bundle; decrypt ciphertext in its connector process. | Authenticate the tool call and return the encrypted inline envelope. |

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

## Export transport

The approved export stays entirely on MCP transport. Hosted connectors receive
`delivery: encrypted_inline`, `resource: null`, ciphertext, and its
X25519-AES256-GCM envelope in the tool result; decryption happens in the
connector process with its private key. Local stdio connectors receive `delivery: decrypted_local` with bounded
approved information after local decryption.

No `ResourceLink`, plaintext fallback, query-token authentication, or
server-held connector private key is part of the MCP contract. A ciphertext
result that exceeds the bounded MCP response limit fails closed; request a
narrower discovered scope.

## Decrypting an encrypted-inline export

Use `structuredContent` as the canonical tool result. The text item in
`content[0].text` is only its JSON-string mirror for MCP clients that do not
surface structured content. The connector private key and `connector_key_id`
must be the exact pair supplied when consent was requested.

The protocol is standard X25519 plus AES-256-GCM; there is no proprietary KDF:

```text
shared_secret = X25519(connector_private_key, wrapped_key_bundle.sender_public_key)
wrapping_key  = SHA-256(shared_secret)

export_key = AES-256-GCM.decrypt(
  key=wrapping_key,
  ciphertext=wrapped_export_key || wrapped_key_tag,
  iv=wrapped_key_iv,
  aad=canonical_json(export_envelope)
)

plaintext = AES-256-GCM.decrypt(
  key=export_key,
  ciphertext=ciphertext || tag,
  iv=iv,
  aad=canonical_json(export_envelope.aad)
)
```

`canonical_json` means recursively lexicographically key-sorted JSON, compact
separators (no whitespace), UTF-8 encoded. Both AES-GCM steps authenticate
their AAD; `aad_sha256` is an integrity diagnostic, not the AAD value. Do not
use the full MCP response as AAD, omit AAD, derive a replacement key pair, or
try alternate KDFs.

The complete browser reference is in the
[Developer API decryption guide](https://github.com/hushh-labs/hushh-research/blob/main/consent-protocol/docs/reference/developer-api.md#decrypt-an-encrypted-export-locally).
If a private key is exposed or lost, rotate the key pair and request a fresh
encrypted export for the replacement public key; never put a private key in a
request, ticket, chat, log, or support attachment.

## Connected CRM systems

Hussh calls MuleSoft-backed CRM systems directly over registered Streamable HTTP
MCP transport. The private agent may propose a typed change, but does not select
arbitrary tools or execute CRM writes. Each registry entry declares its primary
object, supported operations, operation tool names/endpoints, timeout, and retry
policy. Create, update, and delete are reviewable intents; explicit user
confirmation approves one direct MCP call. Mutation retries are disabled to
avoid duplicate records.

CRM records hold only narrow CRM-native workflow fields. Hussh PKM, vault keys,
KYC documents, email bodies, and broad personal memory are not CRM replication
payloads.

### CRM lifecycle and owner binding

The CRM lifecycle is bounded per person and primary object:

```text
registered CRM list
  -> verified email + phone lookup
  -> create only when no record is found
  -> persist one active user–CRM record ID binding
  -> bound-ID read / update / delete
  -> post-delete ID read confirms absence, then clears the binding
```

- Lookup and initial create use only the authenticated person's server-verified
  email, phone, and display name. Browser input and chat text cannot select a
  different person.
- Read, update, delete, and approval-time rechecks resolve the binding on the
  server. A client-supplied CRM record ID is not an authority.
- Every create, update, and delete is an idempotent intent with an audit event,
  explicit review, confirmation, and readback. Delete clears the binding only
  after the registered read tool no longer returns the ID.

### CRM schema mapping and field UI

Hussh sends only normalized public schema metadata—object name plus field key,
label, type, required state, and constraints—to the manifest-owned
`crm_schema_mapper` child of the Connected Systems private agent. It uses
Hussh-managed Vertex `gemini-3.5-flash` to map `email`, `phone`, split or full
name, and optional address fields. It never receives CRM records, verified
profile values, record IDs, credentials, consent material, or vault material;
it has no tools and cannot execute a CRM operation.

The mapping is validated against the exact current schema and cached in
Postgres by CRM, object, schema fingerprint, and model version for at most 24
hours. A schema change or one field-validation failure forces one schema
refetch and remap. If that still fails, Hussh shows the searchable catalogue
only and keeps CRM record actions unavailable. There is no field-name alias or
deterministic mapping fallback for a partner CRM.

The interface starts with the mapped Basic fields and offers an All fields
selector. All fields render in a paginated, searchable table with Field, Type,
Access, Required, and Current value columns. Only non-identity, non-immutable,
not-explicitly-update-disabled fields can be staged for the existing review and
confirmation lifecycle.

### CRM operation contracts

CRM integration is a separate backend-to-MuleSoft plane. Each active operation
has a registry-owned response contract; a missing or invalid mapping is
unavailable before Hussh opens an MCP call. The current schema tool response
maps its primary object metadata from `details[0]` and field catalogue from
`details[0].fields`. Each descriptor supplies `name`, `label`, `type`, and
`required`; normalized constraints such as `allowedValues` and `maxLength` are
recommended. `readable`, `identityField`, `immutable`, `createable`, and
`updateable` are optional refinements. Explicit `false` is enforced; an absent
field flag is never treated as a new permission decision.

For the verified demo CRM tools, the registry maps create success and returned
ID from `success` and `id`; it maps reads from `records[]` and `Id`. Update and
delete intentionally return an empty successful MCP tool result, so their
registered success policy is `isError: false` plus a post-mutation state read.
This is a declared transport contract, not a Salesforce-specific heuristic.

Adding a future CRM requires only its registry row, schema contract, operation
tool names/endpoints, request style, and response paths. Its field catalogue
may be visible first, but no action is enabled until the complete contract and
isolated lifecycle check pass.

## Partner checklist

- Use the UAT endpoint with its trailing slash and a Bearer header.
- Discover a narrow scope before requesting consent; do not guess scope names.
- Store `request_ref` while polling and use `grant_ref` only after approval.
- Expect encrypted-inline delivery with `resource: null`; do not implement a ResourceLink download step.
- Treat CRM MCP operations as a private Hussh backend integration, not as additions to the public Consent MCP tool catalog. MuleSoft Streamable HTTP is direct backend transport; Hussh Consent MCP is the separate encrypted information-exchange transport.
