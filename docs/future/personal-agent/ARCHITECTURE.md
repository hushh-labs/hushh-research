# Sovereign Agent One — one logical architecture, many compute backends

> **Status:** design of record for the per-user sovereign agent. Dev-branch only,
> behind `PERSONAL_AGENT_ENABLED` (default **off**). Nothing here is deployed.
> Branch: `claude/hushh-infrastructure-analysis-7o991c`.
>
> Companion docs: [`README.md`](./README.md) (Phase-0 engineering record) ·
> [`SECURITY-REVIEW.md`](./SECURITY-REVIEW.md) (adversarial audit) ·
> [`ROADMAP.md`](./ROADMAP.md) (milestones, timelines, risks, 1B launch).

## Visual Context

Canonical visual owner: [personal-agent Visual Map](./README.md).

## 1. The one-line thesis

**One consent-native runtime — Agent One — portable across many compute backends.**
The runtime is defined by *identity + consent*, not by where it runs. `HusshID`
(one per human, phone-anchored) and its `spaceID`s (one per node/instance) are the
invariant; every compute host — the user's Mac, a hussh-hosted GCP pod, a burst into
the user's *own* GCP project, tomorrow an orbital node — is an interchangeable
**backend** underneath the same identity, the same PCHP consent handshake, and the
same zero-knowledge boundary.

This is the engineering expression of the founder doctrine on the wiki
([spaceID × HusshID — Consent-Native Compute](https://wiki.hushh.ai/wiki/concepts/spaceid-husshid-consent-compute),
[Puppy Compute Ladder](https://wiki.hushh.ai/wiki/concepts/puppy-compute-ladder)):
*your data, your business — your silicon, your business.* "Backend-agnostic" is not a
nice-to-have; it is the doctrine, because the compute ladder spans ten rungs from the
phone in your pocket to orbit and the only constant is the consent layer.

## 2. Deployment posture — read this first (primary chosen per workload class: Anypoint = general/mass, GCP = FedRAMP-High/regulated)

**The question this resolves:** which backend hosts the per-user runtime, and what is
true *today* versus intended. **The primary is chosen per workload class**, not once for
everything. Working backwards from the outcome — every person's agent runs on a governed,
compliant, operable platform, at the best cost for its class — and anchored to the code:

- **Anypoint is the PRIMARY for general / mass-market deployments (the default runtime).**
  Primary because hussh holds **pre-purchased Titanium capacity** (already paid for → the
  best cost per workload at 1B scale), operated by the dedicated MuleSoft team on **CloudHub
  2.0 / Runtime Fabric**. It hosts the per-user pod **and** carries the enterprise lane
  (CRM / OmniGateway, consent events, syncs, data-correction). FedRAMP **Moderate** (Gov
  Cloud). `AnypointBackend` renders the AMC deployment descriptor today; **live is gated**
  (`HUSSH_ANYPOINT_BACKEND_LIVE` + a Connected App + the written MuleSoft confirmation) and
  **raises until wired** — so Anypoint go-live (M7) is a **critical-path** milestone for the
  general tier. (Capacity is founder-stated / unreconciled — verbal ≠ contract.)
- **GCP is the PRIMARY for the FedRAMP-High / government / regulated tier (only).** Primary
  there because GCP carries **FedRAMP High** (Assured Workloads) — a higher compliance
  ceiling than MuleSoft Government Cloud's **FedRAMP Moderate**, matching the FedRAMP-High +
  DoD-IL north star — **and** it is the **validated, live-wired** backend: `GcpBackend` is
  live-wired (`_execute` → `gcp_run_client.py`) and where the deploy → orchestrate →
  teardown loop was first **proven** in dev on 2026-07-21 (scope bounded — see
  §4/M4-LIVE-VALIDATION, *not* per-user routing / the attested tier / a
  PKM-read-through-the-pod). It is **not** the general-tier primary; it is the regulated-tier
  primary + the proven backend (mass-tier fallback + Apple-PCC parity, §7).
- **User-owned GCP (BYOC) + edge / Puppy One** are the sovereignty tiers (§7a, `BYOC-USER-GCP.md`).
- **The seam is backend-neutral, so "primary" is a per-workload-class choice, not an
  architecture change.**
  `ComputeBackend` (§5) is the provider abstraction; identity, consent, the
  zero-knowledge boundary, and the agent contract (Layers A–D, §3) do not change when
  the backend changes. That invariant is exactly what Phase 0 built. The founder's Xtreme
  Compute Burst white paper already names *"the provider abstraction"* — this is blessed
  doctrine, not a new invention.

**Honest supersession (layered, not erased).** This supersedes two earlier framings.
(1) The **2026-07-13** framing ([Salesforce + MuleSoft](https://wiki.hushh.ai/wiki/partnerships/salesforce-mulesoft):
*"MuleSoft carries the enterprise lane, **not** agent runtime"*) — a real founder statement,
superseded once Anypoint was blessed as a runtime host and not only the enterprise lane.
(2) The intermediate **2026-07 "Anypoint-primary"** framing (Anypoint the single primary
runtime target, GCP the validated backend), **refined 2026-07-25** to a **workload-segmented**
posture: the primary is chosen **per workload class** — **Anypoint** is primary for the
**general / mass** tier (pre-purchased Titanium capacity → best cost at scale), while **GCP**
is primary for the **FedRAMP-High / regulated** tier (higher compliance ceiling than MuleSoft
Government Cloud's Moderate + the validated live loop). Anypoint still hosts the general
runtime **and** carries the enterprise lane. In every case hussh remains the **consent /
identity / audit authority** — the pod reaches a person's data only through a per-user consent
token, never holding or issuing consent itself.

So: *one logical architecture; a compute-provider abstraction; the primary chosen per
workload class — Anypoint for general / mass (prepaid Titanium capacity), GCP for
FedRAMP-High / regulated (compliance ceiling + validated live); user-cloud (BYOC) and edge as
the sovereignty tiers; more providers (Azure/AWS/neocloud/orbital) behind the same seam over
time.*

## 3. The invariant — one logical architecture (backend-neutral)

Four layers. None of them changes when the compute backend changes.

**Layer A — Sovereign identity & address.**
- `HusshID` — the person. One per human, **phone-number-anchored** (E.164 → HMAC hash,
  never raw), opaque in URLs, sovereign, non-transferable. Built:
  `personal_agent_identity_service.py`.
- `spaceID` — the node/instance. Every compute surface an agent runs on gets one; many
  `spaceID`s : one `HusshID`. Today the registry stores a single per-user agent row;
  the column rename in §6 makes it a first-class `spaceID` + `backend`.
- **A2A address indirection** — a stable hussh address (`…/u/{hushh_id}`) resolves to
  the agent's *current* backend route, so the agent is portable ("on wheels") without
  its address changing.

**Layer B — Consent & PKM binding (PCHP).**
Consent to compute is the same handshake as consent to data — one protocol, two
resources ([spaceID doctrine](https://wiki.hushh.ai/wiki/concepts/spaceid-husshid-consent-compute)).
Every job/instance carries:
- **CRT** — a consent receipt for the grant (who, what class, scope, duration).
- **DAT** — a scope token that sandboxes the workload with **zero reach into personal
  data**. Realized today as the standing, Nav-governed `pkm.read` grant
  (`personal_agent_grant_service.py`), bound to the dedicated `personal_agent` id and
  one user, logged to the *visible* consent ledger and revocable.
- **Transparency Log** — one ledger entry per execution (the PCHP receipt).
- **Ephemeral Envelope** — the pod holds its own **X25519** keypair
  (`pod_connector_keypair_service.py`); hussh stores only the public key and wraps each
  scoped export to it. hussh never decrypts. Zero-knowledge.

**Layer C — Agent runtime contract.**
ADK agents (`hushh_mcp/one_adk/`), the A2A surface (`api/routes/one/a2a.py`), MCP tool
transport, and **runtime prompt-sync** (`GET /api/one/agent-prompt`, migration 901):
a pod resolves its system prompt at runtime and rolls forward/back by flipping an
`active` row — no redeploy. The *contract* is backend-neutral; only the *hosting* of it
differs per backend.

**Layer D — On-device body.**
The Capacitor/mobile background agent and the macOS "One Puppy" agent: local UX, BYOK
vault unlock, on-device PKM cache, sync to the cloud body. This is the default runtime
per the 2026-07-13 framing ("on-device and on hussh infrastructure").

## 4. What Phase 0 already built (the invariant is real code)

All flag-off, dev-only, makes **zero** outbound backend calls:

| Layer | Built | File(s) |
|---|---|---|
| A — HusshID, phone-hash | ✅ | `personal_agent_identity_service.py`, migration `900` |
| A — spaceID registry (as per-user row) | ✅ (`space_id`/`backend` added §6, M1) | `personal_agent_registry_repo.py`, migration `900` |
| B — standing `pkm.read` (DAT) | ✅ | `personal_agent_grant_service.py` |
| B — X25519 zero-knowledge pod (Envelope) | ✅ | `pod_connector_keypair_service.py` |
| B — consent ledger visibility + revoke | ✅ | grant service + `insert_event` |
| C — provisioning **brain** (record-before-mint, tombstones, recycled-phone rotation) | ✅ | `personal_agent_provisioning_service.py` |
| C — prompt-sync (versioned, signed, ETag/304) | ✅ | `personal_agent_prompt_service.py`, `api/routes/one/agent_prompt.py`, migration `901` |
| C — owner-authorized provision/deprovision + status | ✅ | `api/routes/one/personal_agent.py` |
| Lifecycle — phone-verify kickoff + delete teardown | ✅ | `actor_identity_service.py`, `api/routes/account.py` |
| C — the `ComputeBackend` **seam** (Protocol + `NullBackend` + selector) | ✅ (M1) | `compute_backend.py` |
| C — `AnypointBackend` (general-tier primary) + `GcpBackend` (regulated-tier primary + validated) + `UserGcpBackend` adapters (render artifact/handle) | ✅ (M7/M4/M6-struct) | `anypoint_backend.py`, `gcp_backend.py`, `user_gcp_backend.py` |
| C — provisioning brain threaded through the backend (persist handle; teardown routes to same backend) | ✅ | `personal_agent_provisioning_service.py` |
| **C — live host execution** | ✅ **GCP** (regulated-tier primary + validated backend) wired + loop validated in dev 2026-07-21 ([M4-LIVE-VALIDATION](./M4-LIVE-VALIDATION.md); bounded scope); ❌ **Anypoint** (general-tier primary) + **BYOC** live raise until wired | GCP `_execute()`→`gcp_run_client.py` (`HUSSH_GCP_BACKEND_LIVE`); `anypoint_backend.py` (`HUSSH_ANYPOINT_BACKEND_LIVE`); `user_gcp_backend.py` |

**On-the-fly deployable configs today: none.** Provisioning records a registry row and
mints the standing read; it calls no Anypoint/GCP API and renders no per-user deploy
artifact. `anypoint_agent_id` / `a2a_route` / `region` are NULL placeholders. Config
rendering is a §5 backend concern (premium/dedicated tier only), designed once and
implemented per backend.

## 5. The compute-provider abstraction (the seam)

One interface; N adapters; the Phase-0 brain untouched.

```
ComputeBackend (Protocol)          # a.k.a. PodBackend
  backend_id: str                  # "gcp" | "gcp_byoc" | "anypoint" | "on_device" | ...
  async provision(spec: PodSpec) -> BackendHandle
  async deprovision(external_agent_id: str) -> None       # idempotent; already-gone = ok
  async get(external_agent_id: str) -> BackendStatus
  async render_deploy_config(spec: PodSpec) -> DeployArtifact   # dedicated tier only
  async health() -> bool

PodSpec       = { hushh_id, space_id, phone_e164_hash, region, tier(logical|dedicated),
                  consent_binding_ref, pod_pubkey, runtime_version, prompt_version }   # neutral
BackendHandle = { external_agent_id, a2a_route, status, backend,
                  backend_metadata, attestation_ref? }                                  # neutral
```

`PersonalAgentProvisioningService` already takes `(registry, grant)` by injection; it
gains a third injected dependency — a `ComputeBackend` — selected by a new
`PERSONAL_AGENT_BACKEND` setting (default unset ⇒ a `NullBackend` no-op, so behavior is
unchanged and inert). **The record-before-mint ordering, tombstones, and recycled-phone
rotation stay exactly as they are.** Adapters are thin:

- **`AnypointBackend` (general-tier primary — the default runtime + enterprise / integration
  / governance lane).** The per-user pod as a Mule app on **CloudHub 2.0 / Runtime Fabric**,
  isolated in a **Private Space** (optional `ANYPOINT_PRIVATE_SPACE_ID`), provisioned via the
  **AMC Application Manager API** with a Connected-App client-credential (mirrors the existing
  outbound OmniGateway CRM connector). Primary for general / mass deployments because hussh
  holds **pre-purchased Titanium capacity** (already paid for → best cost per workload at 1B
  scale; founder-stated / unreconciled). It hosts the agent **and** carries the enterprise
  consent-event / sync / correction-request path. FedRAMP **Moderate** (Gov Cloud). Renders
  the AMC descriptor today; **live raises until wired** (M7 — Connected App + written MuleSoft
  confirmation + founder go).
- **`GcpBackend` (regulated-tier primary + the validated backend).** Primary for the
  **FedRAMP-High / government / regulated** tier because GCP carries **FedRAMP High** (Assured
  Workloads) — a higher ceiling than MuleSoft Gov Cloud's Moderate — **and** it is
  **live-wired** (`_execute` → `gcp_run_client.py`), the backend where the deploy →
  orchestrate → teardown loop was first proven. Cloud Run revision (mass/logical tier) or GKE
  + **Confidential Space** (dedicated/attested tier); Vertex AI Gemini for the model (BYOK
  today via AI Studio + Vertex ADC).
- **`UserGcpBackend` (BYOC — sovereignty tier).** Provisions the pod into the **user's own
  GCP project** via **keyless Workload Identity Federation** and tears it down — "own your
  compute" (`BYOC-USER-GCP.md`); aligns with the shipped [Xtreme Compute Burst](https://wiki.hushh.ai/wiki/products/one-burst-compute-whitepaper)
  control plane rather than rebuilding it. Renders the bootstrap plan today; live gated.

All implement the same `ComputeBackend` contract, so provisioning, teardown, and
reconcile are uniform across hosts.

## 6. Backend-agnostic schema change (exact, ready to execute)

Migration `900_personal_agent_registry.sql` is **unapplied and flag-off**, so it is
edited in place (no new migration, no data-loss risk). Rename the Anypoint-specific
column and add the discriminators:

```sql
-- BEFORE                                   -- AFTER
anypoint_agent_id  TEXT                      external_agent_id  TEXT          -- backend-neutral
                                             backend            TEXT          -- 'gcp'|'gcp_byoc'|'anypoint'|'on_device'
                                             space_id           TEXT          -- the node/instance spaceID
                                             backend_metadata   JSONB         -- gcp: project/service/revision/image-digest; anypoint: deployment/space
                                             attestation_ref    TEXT          -- Confidential-Space attestation / BYOC token-mint evidence (NULL until dedicated tier)
```

`a2a_route`, `region`, `runtime_version`, `prompt_version`, and the pod-key columns are
already neutral and unchanged. The same rename lands in the tombstone table
(`anypoint_agent_id` → `external_agent_id`).

**Shipped in M1** (`0688103`): the rename landed across all readers
(`personal_agent_provisioning_service.py`, `personal_agent_registry_repo.py`, and their
tests), the `ComputeBackend` seam + `NullBackend` + selector are merged, and the gate is
green (ruff + mypy + bandit, 113 tests). Still unapplied and flag-off.

## 7. Apple Private Cloud Compute blueprint → GCP mapping

The founder reference is Apple's PCC (and the Apple↔Google model where a powerful
third-party model runs inside a hardware-attested, stateless, non-targetable, verifiable
envelope so *neither the model provider nor the operator* can see the data). We reproduce
it one level down — for the individual sovereign user — on GCP:

| Apple PCC guarantee | GCP primitive that enforces it | Our binding |
|---|---|---|
| Hardware root of trust + attestation | **Confidential Space** attestation tokens (AMD SEV-SNP / Intel TDX) | pod runs in Confidential Space; key released only to a measured image |
| Stateless / no retention | ephemeral Cloud Run/GKE pod; no PKM persisted **in the control plane** | scoped exports are per-user-key encrypted (Layer B); the pod itself keeps a **per-pod-key-encrypted** working copy and its own agent memory — see §7a, which supersedes a literal reading of this row. Neither hussh nor the operator can read either. |
| No privileged runtime access | Confidential Space (operator can't read workload memory) + **Binary Authorization** | no SSH; only signed/attested images run |
| Non-targetability | HusshID indirection + per-pod X25519 key + **attestation-gated key release** | key unwrap gated on attestation match |
| Verifiable transparency | Binary Authorization attestations + published image digests | transparency-log entry per execution |

**The upgrade GCP unlocks (documented divergence *in our favor*):** on Anypoint the pod
is isolated by per-pod key + crypto isolation, but nothing *attests the code* before the
key is handed over. On GCP Confidential Space the pod's key is released **only when its
attestation matches the known-good image** — moving us from "isolated by policy + crypto"
to Apple's "enforceable guarantee." **Keyless BYOC via Workload Identity Federation** is
already the "next" milestone in the burst white paper — the same attestation-gated model
for the user's own project. Honest divergence in the other direction: Apple uses custom
silicon; our root of trust is SEV-SNP/TDX — equivalent guarantee, different hardware.

## 7a. The pod as shared compute **and** storage (PKM cloud-backup ⇄ pod ⇄ device)

Founder directive (2026-07-21): the pod is not only shared *compute* for the
user's agents — the user will want it as *storage* for their PKM, with a **cloud
backup**, **natively syncing** with their device and pod over a **private tunnel**.
This refines "no PKM persisted / ephemeral-only" (§5, §7) into a three-replica
model that keeps zero-knowledge intact:

| Replica | What it holds | Role |
|---|---|---|
| **Cloud backup-of-record** | canonical PKM, encrypted, in hussh's **zero-knowledge vault** | durable backup; already live today |
| **Pod cache** | a **per-pod-key-encrypted** working copy next to the agents | fast local read/write = "shared compute + storage" |
| **Device** | the on-device **BYOK** copy (mobile / Puppy One) | offline-first; the user's own hardware |

They stay consistent by syncing **encrypted deltas** over a **single-use, signed,
replay-checked private tunnel** (the existing One ADK relay ticket) — never a
public reusable URL. **Zero-knowledge is preserved end to end:** plaintext exists
only inside the pod's isolated (M5: hardware-attested) process and on the device;
hussh's backend and the transit see **ciphertext only**. This is *consistent* with
§7 — on the attested tier the operator cannot read even a persisted per-pod cache,
so "the pod stores your PKM" and "neither operator nor hussh can read it" hold at
once. Honest divergence: on the logical tier the cache is crypto-isolated but not
attested (weaker; documented in §9); the attested tier (M5) closes that gap.

**Code seam:** `hushh_mcp/services/pod_storage.py` — a typed, **inert** contract
(`EncryptedBlobRef` carries a ciphertext pointer with *no plaintext field*, so the
zero-knowledge property is legible in code), `NullPodStorage` default, resolver
that fails loud on an unknown backend. The concrete pod cache + a per-user
encrypted-object backend (GCS/S3 + per-user KMS) are a later milestone; the vault
already provides the cloud backup. Access to the pod's read path is owner-gated and
receipted (`pod_access_audit.py`).

## 7b. The slim pod (surface split) + the warm floor

**Surface split — the control plane stays central.** The pod does **not** run the whole
backend. The **consent control plane** (token issuance, the audit-DB authority,
developer/admin APIs) and every unrelated surface (RIA, email, marketplace, account,
IAM, login/WebAuthn) stay **central at hussh**; the pod runs only the **agent runtime +
storage + consent *enforcement*** (validate the token, revocation check, owner-verified
pod-access receipt — enforcement, not issuance). The slim entrypoint (`pod_server:app`,
`Dockerfile.pod`) mounts an allowlist of exactly four routers (health, A2A + well-known,
agent-prompt) and never registers the fleet-wide workers (`HUSSH_POD_MODE`). Verified
live: the consent/central routes **404 on the pod** ([M4-LIVE-VALIDATION](./M4-LIVE-VALIDATION.md)).
*Follow-up:* the image still imports the full `one` package at startup (eager package
init); physical dependency slimming (lazy init) is the tracked next optimization.

**Warm floor — real-time by default.** A per-user agent must answer in real time, so the
pod default is `minScale=1` (`gcp_backend.py`, configurable via `HUSSH_POD_MIN_INSTANCES`):
no cold start on the agent endpoint (measured ~11 s cold vs ~0.6 s warm at `min=0`). It is
a **per-tier knob** — the dedicated/active tier keeps `min=1`; the 1B mass tier runs
`min=0` + fast wake to bound cost (see ROADMAP R3).

## 8. Parity matrix (kept in sync to prevent drift)

*(Column order is comparison, not priority: the primary is chosen **per workload class** —
**Anypoint = general / mass primary** (prepaid Titanium capacity), **GCP = FedRAMP-High /
regulated primary** + validated — see §2. Kept side-by-side to prevent drift.)*

| Dimension | GCP (regulated-tier primary) | Anypoint (general-tier primary) | Parity status |
|---|---|---|---|
| Onboarding | shared control-plane path (phone-verify → spaceID) | same | **shared code** |
| Auth (control→backend) | Workload Identity Federation / SA OAuth | Connected-App `client_credentials` | **at parity** (both client-cred shaped) |
| Provisioning | logical stamp; dedicated = Cloud Run/GKE deploy | logical stamp; dedicated = AMC deploy | **at parity** via `ComputeBackend` |
| Orchestration | ADK agents on Cloud Run/GKE | ADK/enterprise flow on Mule runtime | **at parity** (same ADK contract) |
| Config (on-the-fly) | Cloud Run/GKE manifest (dedicated only) | Mule descriptor (dedicated only) | **at parity** via `render_deploy_config` |
| Pod capabilities in the artifact | hub door, consent verifying keys, model slot, flag on, internal-only, signing key by reference | same slots in the AMC descriptor | **at parity**, held by `test_compute_backend_parity.py` (see §9.6) |
| APIs | identical provision/deprovision/get contract | same | **one contract** |
| Deploy (CI/CD) | GCP Cloud Build → backend | GCP Cloud Build → backend | **at parity** (dev lane only) |
| Observability | Cloud Monitoring/Logging/Trace | Anypoint Monitoring | **normalize to one event schema** |
| Security | + attestation-gated key release, Binary Auth | crypto isolation + per-pod key | GCP **exceeds** (§9) |
| Ops (lifecycle) | shared reconcile worker + tombstones | same | **shared brain** |
| Compliance | **FedRAMP High** (Assured Workloads), IL2/4/5 | **Moderate** (Gov Cloud only) | GCP **exceeds** ⇒ **regulated-tier primary** (§9) |

## 9. Divergence register (intentional; documented per the anti-drift rule)

1. **Strategic role differs** (the big one): the primary is chosen **per workload class** —
   **Anypoint = general / mass-tier primary** (dedicated team, CloudHub 2.0 / RTF,
   pre-purchased Titanium capacity → best cost at scale; hosts the runtime + enterprise lane);
   **GCP = FedRAMP-High / regulated-tier primary** + the validated live loop + the
   Confidential-attestation tier. This supersedes the 2026-07-13 "enterprise lane only"
   framing **and** refines the intermediate 2026-07 "Anypoint-primary" framing (2026-07-25 →
   workload-segmented) — see §2. Not a defect — the assignment.
2. **Confidential attestation is GCP-only.** No first-class Anypoint equivalent. GCP tier
   upgrade, not an Anypoint gap to close.
3. **FedRAMP High is GCP-only** (Assured Workloads) vs Anypoint Moderate (Gov Cloud) — a
   property of the **platforms**. Material for the compliance north star, and the **reason
   the FedRAMP-High / regulated tier is primary on GCP** (the 2026-07-25 workload-segmented
   posture, §2). hussh's own posture stays **"in pursuit"** until a 3PAO/ATO — never claimed.
4. **Cost model.** Anypoint = **pre-purchased Titanium capacity** (~$1.2M/yr licensed,
   founder-stated, unreconciled) — **already paid for**, so it is the best cost per workload
   for the **general / mass-tier primary** at 1B scale. GCP = pay-as-you-go +
   confidential-compute premium — favorable for the **FedRAMP-High / regulated tier**,
   elastic burst, and BYOC.
5. **Gateway.** Anypoint's AI/Omni Gateway is batteries-included; GCP's equivalent is
   Apigee + Model Armor, composed. Same capability, more assembly on GCP.
6. **Model access has no ambient identity on Anypoint.** On Cloud Run the pod reaches
   Vertex *as itself* — its own service account carries `aiplatform.user`, so there is no
   credential to render and none to leak. CloudHub has no equivalent identity to borrow,
   so the pod there can only reach a model when a compute project is configured for it
   explicitly. The **slot is present on both** (that is what `render_deploy_config` parity
   means, and what the parity test enforces); the toggle turns on only when that project
   exists, which keeps a dark-shipped Anypoint pod inert rather than claiming an identity
   it does not have. Closing this needs an explicit credential path on CloudHub — it is a
   real gap, recorded rather than rendered away, and Anypoint live provisioning is gated
   regardless.

## 10. BYO + onboarding (frontend)

Today: **BYOK for Gemini** is wired end-to-end — the runtime provider factory
(`hushh_mcp/runtime_providers/factory.py`) builds an *isolated* BYOK client (AI Studio
`developer_api` or `vertex_api_key`, kept separate from managed Vertex ADC), and
`POST /api/one/runtime/gemini/validate` pre-checks a key without ever storing it. The
onboarding extends this, holding the standing UX bar (see `AGENTS.md`) — Summer-26, colorful,
**fewest-clicks-to-done**, sensible defaults pre-selected, only 🤫 + flag emoji:

1. **The reveal.** Right after phone-verify: "🤫 Your Agent One is reserved & ready."
   Honest `reserved → live` presence (the status endpoint already exists). Zero required
   input — one tap. (This is also the `$0.69` **spaceID reservation** activation moment,
   SKU-0000 — mint the spaceID bound to the phone-verified HusshID.)
2. **BYO-config (all optional, all pre-defaulted):**
   - **Model** — default managed Gemini; disclosure to bring your own key (AI Studio /
     Vertex ADC — already supported).
   - **Connect your own MCP servers via OAuth** — the BYO surface: a consented OAuth
     handshake registering the user's own MCP endpoints as tools their agent may call,
     scoped and revocable through the normal consent ledger. Backend-neutral (binds to
     the logical agent).
   - **Region / tier** — pre-selected nearest; "dedicated confidential instance" is the
     premium upsell (surfaces the GCP attested tier / BYOC).
3. **One-tap default path.** Tap-through ⇒ managed Gemini, nearest region, no MCP
   connections, logical tier. Everything else is progressive disclosure.

Onboarding screens are **backend-agnostic** — they configure the logical agent; the
backend resolves server-side from region/tier/setting, so the same screens serve every
provider with no divergence.

## 11. Honesty ledger (Munger/Rude-FAQ candor — never let the story outrun the code)

- **Agent runtime home:** the primary is chosen **per workload class** — **Anypoint is
  primary for the general / mass tier** (CloudHub 2.0 / RTF, dedicated team, **pre-purchased
  Titanium capacity** → best cost at scale; hosts the runtime + enterprise lane; FedRAMP
  **Moderate**), and **GCP is primary for the FedRAMP-High / regulated tier** (higher
  compliance ceiling than MuleSoft Gov Cloud's Moderate **and** the validated, live-wired
  backend); on-device / edge are the sovereignty tiers. This supersedes the 2026-07-13
  "MuleSoft does not host the runtime" framing **and** refines the intermediate 2026-07
  "Anypoint-primary" framing (**2026-07-25 → workload-segmented**) — see §2. **Code truth:**
  GCP live-wired + loop-validated in dev (2026-07-21, bounded scope — *not* per-user routing
  / the attested tier / a PKM-read-through-the-pod); **Anypoint live raises until wired**
  (`HUSSH_ANYPOINT_BACKEND_LIVE` + Connected App + written MuleSoft confirmation) — so the
  **general-tier primary is the intent, not yet a live claim.** GCP FedRAMP High is a
  **platform** property; hussh's own ATO stays **"in pursuit"** — never claimed. The
  pre-purchased Titanium capacity is **founder-stated / unreconciled** (verbal ≠ contract).
- **MuleSoft 1B capacity:** **verbal, unverified** (verbal ≠ contract); written
  entitlement exhibit requested. Never stated as fact. ([Verification Findings](https://wiki.hushh.ai/wiki/reference/verification-findings).)
- **FedRAMP / DoD IL:** "in pursuit." Never claimed until 3PAO/ATO.
- **Enterprise capability:** **requesting corrections** (GDPR Art. 16 / CCPA right to
  correct) — the enterprise validates and applies a consent-backed correction; an outside
  agent never gets write access. Every request carries a PCHP receipt.
- **Sensitive identifiers** (gov IDs): never enumerated in a PII list; separately
  controlled class, independent authorization per request, field-level encryption, no
  retention by default.
- **HusshOne / Xtreme Compute Burst** lives in a separate repo — referenced as the
  founder-blessed GCP reference architecture, an integration dependency, not re-derived
  here.
