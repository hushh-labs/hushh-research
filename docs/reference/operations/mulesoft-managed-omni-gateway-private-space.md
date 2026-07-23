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
- Registry writes have one authority: the validated `crm-registry.v1` operator
  CLI. Partner descriptors stay in ignored local files and reference credential
  environment-variable names only. `check` is static, `probe` verifies MCP,
  `apply --activate` transactionally replaces the exact operation set and
  increments `configuration_revision`, and `deactivate` preserves history while
  failing closed. The historical seed command only delegates to this CLI.
- Future CRM partners require a descriptor, runtime credentials, and a passing
  probe. They do not require a migration or CRM-specific application code.

## CRM schema contract v1

The `object-schema` tool must return an operation-contract-mapped primary
object metadata node and field collection according to the checked-in
`docs/reference/operations/mulesoft-crm-schema-contract-v1.json`. For the current rollout the collection is
`details[0]` and `details[0].fields`. Each descriptor supplies `name`,
`label`, `type`, and `required`; portable constraints such as picklist values
and maximum length are recommended. `readable`, `identityField`, `immutable`,
`createable`, and `updateable` are optional refinements, not prerequisites for
onboarding. When a partner supplies an explicit `false` value, Hussh enforces
it; it does not invent a conflicting field permission.

Executable CRM operations are authorised by the registered tool and its
response contract, then limited by the authenticated user's active
user–CRM-record binding. A person can look up only their server-verified email
and phone, and all later read/update/delete calls resolve the bound CRM record
ID server-side. Read and mutation result mappings remain registry-owned; they
are not guessed from raw MuleSoft envelopes. The two current demo rows map
reads from `records[]` / `Id`, create from `success` / `id`, and their empty
update/delete success result through an explicit `isError: false` transport
policy plus a post-mutation readback.

Hussh maps the public field catalogue with the manifest-owned
`crm_schema_mapper` child using Hussh-managed Vertex `gemini-3.6-flash`. It
receives only object and field metadata, not CRM records, verified profile
values, identifiers, credentials, consent material, or vault material. Its
validated result is cached by schema fingerprint for 24 hours. A mapping failure
keeps the CRM catalogue-only and cannot bypass the registered operation,
owner-binding, intent, confirmation, or readback controls.

The normalized field catalogue is also cached in Postgres by CRM, primary
object, and configuration revision. It is fresh for 24 hours. For up to seven
days the last catalogue may render as display-only while one refresh runs;
record actions always require a fresh catalogue. Successful operator activation
prewarms this cache. No CRM record, binding ID, credential, intent, or staged
edit enters the catalogue cache.

## Operator workflow

```bash
cd consent-protocol
python scripts/ops/configure_crm_registry.py check tmp/crm-registry/partner.json
python scripts/ops/configure_crm_registry.py probe tmp/crm-registry/partner.json
python scripts/ops/configure_crm_registry.py apply tmp/crm-registry/partner.json \
  --activate --operator "$USER"
```

CRUD descriptors include synthetic create/read/update/delete arguments. The
probe must create an isolated fixture, read it by returned ID, update and read
back, delete it, then prove an ID read is absent. Cleanup is attempted if any
intermediate verification fails. Audit events contain only the operator,
configuration fingerprint, capabilities, structural result, revision, and
timestamps.

## UAT verification boundary

The read-only connectivity proof is complete only when the deployed UAT
Secret Manager references authenticate `initialize` and `tools/list` and the
gateway returns its expected catalog. This proves the Hussh-to-Omni-Gateway
leg. Schema/read/write verification remains a separate CRM capability check;
writes always stay behind the intent and explicit-confirmation lifecycle.

## Consent-export decryptor target

The current gateway/Connected Systems transport above is shipped. Extending the
same partner-authorized MuleSoft boundary with a reviewed Java 17/JCA
`X25519-AES256-GCM` decryptor is a separate, UAT-gated target. It keeps the
canonical five-tool Hussh MCP contract and current envelope v2 unchanged,
decrypts only after an exact approved grant, writes purpose-approved fields,
and returns metadata-only status for Agentforce.

This user-information export path is distinct from the existing
PBKDF2/AES-CBC compatibility used to protect connector credentials at rest.
Neither mechanism substitutes for the other.

Never put live gateway URLs, private CIDRs, VPN/tunnel material, secret values,
or encrypted credential blobs in the repository, logs, screenshots, or docs.
