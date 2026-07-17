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

### CRM schema contract v1

CRM integration is a separate backend-to-MuleSoft plane. Each active operation
has a registry-owned response contract; a missing or invalid mapping is
unavailable before Hussh opens an MCP call. The current schema tool response
maps its primary object metadata from `details[0]` and field catalogue from
`details[0].fields`. That shape is display-only until every
field carries explicit `readable`, `identityField`, `immutable`, `createable`,
and `updateable` booleans, plus normalized constraints where applicable such
as `allowedValues` and `maxLength`.

Hussh derives `writable` only from `createable` or `updateable`. It never
interprets an omitted permission as allowed. Until MuleSoft publishes this
schema v1 contract, the Connected Systems interface shows a searchable field
catalogue and exposes no CRM read, create, update, or delete action.

## Partner checklist

- Use the UAT endpoint with its trailing slash and a Bearer header.
- Discover a narrow scope before requesting consent; do not guess scope names.
- Store `request_ref` while polling and use `grant_ref` only after approval.
- Expect encrypted-inline delivery with `resource: null`; do not implement a ResourceLink download step.
- Treat CRM MCP operations as a private Hussh backend integration, not as additions to the public Consent MCP tool catalog.
