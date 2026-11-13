# Information boundary views

## Visual Context

The [architecture index](../README.md) provides the top-down visual map; the [view catalog](README.md) indexes this page and its figure status.

Canonical diagrams for this concern. Return to the [architecture view catalog](README.md).

## Data Boundary View

View metadata:

| Field | Value |
| --- | --- |
| Stakeholders | security, partners, platform, compliance reviewers |
| Concern | Where sensitive data, ciphertext, audit metadata, keys, and partner fields may reside |
| Model kind | ISO 42010 data/security view |
| Source anchors | `docs/architecture/runtime-db-fact-sheet.md`, `docs/architecture/data-model-governance.md`, `docs/architecture/pkm-cutover-runbook.md`, `consent-protocol/docs/reference/developer-api.md`, `packages/hushh-mcp/README.md` |

```mermaid
flowchart LR
  accTitle: Hussh information boundary
  accDescr: Hub, pod, owner recovery, and partner information boundaries.
  userDevice["User device / first-party client<br/>vault unlock, local keys, temporary plaintext"]
  memory["Process/browser memory<br/>decrypted PKM only while needed"]
  husshCloud["Hussh cloud runtime — the hub<br/>policy, workflow, export metadata"]
  pod["Per-user pod<br/>no hub database credential or vault data key<br/>scoped authority and configured model access"]
  ownerRecovery["BYOC owner cloud<br/>encrypted commit log + KMS"]
  pkmBlobs["pkm_blobs<br/>ciphertext, iv, tag, revisions"]
  pkmManifests["PKM manifests and scope registry<br/>metadata and handles"]
  pkmIndex["pkm_index<br/>discovery-safe projection/cache"]
  audit["Audit tables<br/>consent, export, regulated metadata"]
  providerCache["Provider caches<br/>refreshable bounded operational state"]
  connector["External connector<br/>connector-held private key"]
  crm["Partner CRM<br/>approved narrow fields and audit pointers"]

  userDevice --> memory
  memory -->|encrypt before persistence| husshCloud
  husshCloud --> pkmBlobs
  husshCloud --> pkmManifests
  husshCloud --> pkmIndex
  husshCloud --> audit
  husshCloud --> providerCache
  husshCloud -->|ciphertext scoped export| connector
  connector -->|local decrypt, explicit partner policy| crm

  husshCloud <-->|"hub-owned reads, scoped consent"| pod
  pod -->|"BYOC encrypted recovery, when configured"| ownerRecovery
  pod -.->|"no hub database credential"| pkmBlobs
```

Boundary rules:

- Vault keys and decrypted PKM stay memory-only.
- **A pod holds no hub database credential or vault data key.** Hub-owned Postgres reads go through the hub under scoped authority. A configured BYOC pod separately accesses its owner's encrypted commit log and KMS and keeps an encrypted local working copy. The dotted arrow prohibits direct hub database reads; it does not prohibit owner-cloud recovery.
- **A pod verifies consent; it cannot mint it.** It carries `CONSENT_ED25519_PUBLIC_KEYS` — the verifying half only. Any required pod-local signing secret is separately scoped and referenced through Secret Manager; it is not the hub consent-signing key.
- **Model credentials follow their admitted custody mode.** Legacy request-supplied keys remain turn-scoped and separate from backend ADC. Owner-authorized durable AI selection seals the provider, model and key to the pod and persists encrypted `pod_ai_selection_v1` state in the owner commit log; the hub does not hold the key. Never render credential values into deployment artifacts.
- `pkm_blobs` stores encrypted private content.
- PKM manifests and scope registry are authority for structure and exposure handles.
- `pkm_index` is discovery projection/cache, not canonical private memory.
- Provider caches are not durable user memory unless a consented encrypted PKM write makes them so.
- Partner CRM may store consent receipt ids, scope labels, status, expiry, audit references, and narrow approved workflow fields.
- Partner CRM must not store broad PKM, vault contents, vault keys, full email bodies, broad KYC packages, durable One memory, or reusable secrets by default.
