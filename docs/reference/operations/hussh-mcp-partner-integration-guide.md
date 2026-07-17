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

## Export transport

The approved export stays entirely on MCP transport. Hosted connectors receive
`delivery: encrypted_inline`, ciphertext, and its X25519-AES256-GCM envelope in
the tool result; decryption happens in the connector process with its private
key. Local stdio connectors receive `delivery: decrypted_local` with bounded
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
