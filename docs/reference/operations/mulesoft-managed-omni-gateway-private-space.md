# MuleSoft Managed Omni Gateway Private Space

## Visual Context

Canonical visual owner: [Operations Index](README.md).

```text
Cloud Run -- Streamable HTTP + gateway headers --> Omni Gateway -- Private Space --> CRM
```

## Current transport

Connected Systems reaches Salesforce through MuleSoft Managed Omni Gateway in
CloudHub 2.0 Private Spaces:

```text
Hussh Cloud Run -> Managed Omni Gateway Streamable HTTP ingress -> MuleSoft private space -> CRM
```

The Cloud Run service does not attach to a Hussh GCP VPC connector for this
integration. The private-network boundary is owned by MuleSoft behind its
managed gateway ingress; a public CloudHub hostname does not mean the
downstream CRM path is public.

## Credentials and registry

- `OMNIGATEWAY_CLIENT_ID` and `OMNIGATEWAY_CLIENT_SECRET` are Secret Manager
  values injected into the backend runtime. They authenticate Hussh to Omni
  Gateway as `client_id` and `client_secret` request headers.
- Each active CRM row in `enterprise_crm_registry` holds encrypted CRM
  credential fields. MuleSoft-managed rows forward those opaque values to the
  gateway as tool arguments; Hussh never logs or decrypts them in that path.
- The generic CRM adapter uses Streamable HTTP MCP. A valid session performs
  `initialize`, retains the returned `Mcp-Session-Id`, then calls `tools/list`
  or the declared tool. No CRM records are needed to prove the handshake.

## CRM schema contract v1

The `object-schema` tool must return an operation-contract-mapped primary
object metadata node and field collection according to the checked-in
`docs/reference/operations/mulesoft-crm-schema-contract-v1.json`. For the current rollout the collection is
`details[0]` and `details[0].fields`. Every field must declare `readable`, `identityField`,
`immutable`, `createable`, and `updateable`; it should also provide portable
constraints such as picklist values and maximum length. Hussh derives
`writable` from the create/update flags and never infers an omitted permission.

Until all descriptors validate, Hussh treats the result as a display-only
catalogue. Read, create, update, and delete are unavailable before their MCP
tool is called. Read and mutation result mappings are likewise registry-owned;
they are not guessed from raw MuleSoft envelopes.

## UAT verification boundary

The read-only connectivity proof is complete only when the deployed UAT
Secret Manager references authenticate `initialize` and `tools/list` and the
gateway returns its expected catalog. This proves the Hussh-to-Omni-Gateway
leg. Schema/read/write verification remains a separate CRM capability check;
writes always stay behind the intent and explicit-confirmation lifecycle.

Never put live gateway URLs, private CIDRs, VPN/tunnel material, secret values,
or encrypted credential blobs in the repository, logs, screenshots, or docs.
