# Sovereign Agent One — roadmap to a 1B-user production platform

> **Status:** living roadmap, dev-branch only. Everything below stays behind
> `PERSONAL_AGENT_ENABLED` (off) until the founder turns it on; **no UAT/Prod deploy
> and no `main` merge without explicit founder sign-off.** Branch:
> `claude/hushh-infrastructure-analysis-7o991c`.
>
> Design of record: [`ARCHITECTURE.md`](./ARCHITECTURE.md). Engineering record:
> [`README.md`](./README.md). Audit: [`SECURITY-REVIEW.md`](./SECURITY-REVIEW.md).

## How to read this

- **Velocity assumption.** Timelines assume a well-resourced AI-engineering team moving
  at maximum velocity, measured in **engineering-weeks from kickoff (EW)**, where
  kickoff = the moment the flag-on decision + resourcing land. Today (2026-07-20) the
  work is **Phase-0-complete and flag-off**; the clock has not started.
- **Aggressive but honest.** Engineering-compressible work is estimated tightly. Items
  gated by things velocity *cannot* compress — a MuleSoft contract exhibit, a GCP quota
  grant, a 3PAO/ATO, a founder decision, another team's repo (HusshOne) — are marked
  **[external-gated]** and dated to the gate, not to our effort.
- **"1B-ready" ≠ "first user live."** These are different finish lines and the roadmap
  separates them (see §7). First real user is a Q4-2026 target; genuine 1B-scale
  hardening + compliance is a 2027→2028 horizon with external gates.
- **Every milestone ships flag-safe, versioned, reversible** — the design ethos from the
  plan: flag + kill-switch on everything, canary before general, and a named
  "what-would-tell-us-we're-wrong" signal per milestone.

## 1. Where we are today (live truth, 2026-07-21)

**Deployment posture.** **The primary is chosen per workload class.** **Anypoint is the
primary for general / mass deployments** — pre-purchased Titanium capacity (already paid for →
best cost at scale), CloudHub 2.0 / RTF, dedicated team; `AnypointBackend` renders the AMC
descriptor but **live raises until wired** → M7 is a **critical-path** milestone for the
general tier (capacity founder-stated / unreconciled). **GCP is the primary for the
FedRAMP-High / regulated tier** — **FedRAMP High** (a higher compliance ceiling than MuleSoft
Gov Cloud's Moderate, matching the FedRAMP-High + DoD-IL north star) **and** the validated,
live-wired backend where the loop below was proven live. See [ARCHITECTURE §2](./ARCHITECTURE.md).

**✅ M4 live loop validated in dev (2026-07-21).** A single throwaway per-user pod
was deployed to **`hushh-pda-dev`** from the current runtime image, proven to boot
the hussh agents (`/health` → `one/kai/nav/kyc`; Agent One A2A card served) and to
refuse access at three layers (Cloud Run IAM anon→403, developer-token→403, owner
consent required), then **torn down** cleanly (DELETE 200 → GET 404, no residue).
Full evidence: [`M4-LIVE-VALIDATION.md`](./M4-LIVE-VALIDATION.md). Motivated three
committed, flag-off additions: **`pod_access_audit`** (owner==caller gate + visible
receipt), **`HUSSH_POD_MODE`** (pod skips fleet-wide workers), and **`pod_storage`**
(the shared-compute + PKM cloud-backup ⇄ pod ⇄ device private-tunnel seam). Still
ahead, unchanged: per-user **routing** (M3), the **attested** tier (M5), and a live
owner **PKM read** through the pod.

**Built and on-branch (flag-off, dev-only, zero backend calls):** the entire
backend-neutral invariant — HusshID identity, the spaceID registry (migration 900),
the standing Nav-governed `pkm.read` (DAT), the X25519 zero-knowledge pod (Envelope),
the provisioning brain (record-before-mint, tombstones, recycled-phone rotation), the
prompt-sync read path (migration 901 + `GET /api/one/agent-prompt`), the owner-authorized
provision/deprovision + status routes, and the lifecycle wiring (phone-verify kickoff +
account-deletion teardown). Security review complete; all four gate items closed. Branch
is **0 behind `main`** after the 2026-07-20 sync.

**Not built yet (the gaps this roadmap closes; confirmed by a post-merge code sweep):**
- **The deployment abstraction is complete end-to-end (inert); only *live* execution
  remains.** The provider abstraction (`compute_backend.py`) plus `GcpBackend`
  (`gcp_backend.py`) and `AnypointBackend` (`anypoint_backend.py`) are merged, contract-
  tested as interchangeable, and **threaded through the provisioning brain**: `provision()`
  stands the host up on the selected backend and persists the handle; teardown routes to
  the same backend. Selected by `PERSONAL_AGENT_BACKEND` (default unset → inert
  `NullBackend`, byte-identical to the pre-threading stamp). In plan/dry-run mode the
  adapters render the real deploy artifact (Cloud Run service / AMC descriptor) + routing
  handle but make **no live cloud call**; live execution (`_execute`) is gated on
  credentials + founder go (GCP) and the written MuleSoft API/capacity confirmation (Anypoint).
- **No remote agent transport.** One is a single **stateless multi-tenant** ADK service
  (one voice head + one text head); runners are process-wide/ephemeral singletons. The
  A2A surface (`a2a.py`) is preview-grade (`officialA2A:false`, a release blocker pending
  the official A2A SDK) and its `POST /message` still calls the **legacy orchestrator**,
  not the new ADK text head; the per-user address `/u/{hushh_id}` is documented but
  **unrouted**. No per-user hosted instance exists. Revocation-on-the-pod-read-path
  (SECURITY-REVIEW **I1**) lands with this transport.
- **Session durability is the documented-but-unexecuted `DatabaseSessionService` swap** —
  every runner uses `InMemorySessionService` today (`agent_tree.py`, `text_runtime.py`);
  a mid-conversation reconnect to another worker loses ADK context.
- **No fleet observability / SLO surface, per-agent telemetry, per-user-agent
  rate-limit/throttle, or reconcile-at-scale.** Observability today is service-level
  (`deploy/observability/`); isolation is *logical* (HCT token binding), not physical.
- **Onboarding reveal + BYO-config screens** are designed, not built. BYOK Gemini itself
  *is* wired (`runtime_providers/factory.py`, `POST /api/one/runtime/gemini/validate`).

**One intentionally-live, production-safe surface (an honest exception to "dev-only").**
`GET /api/one/personal-agent/status` is deliberately **not** flag-gated and never 404s;
the `/one` home renders the "Your Agent One" presence card from it for every user. It
reveals nothing while the flag is off — it **fails safe to "reserved"** (and, because
migrations 900/901/902 are **unapplied and not yet in the release manifest**, the registry
read returns nothing in released envs, so "reserved" is what ships). Everything else in
this workstream is flag-off and dev-only.

## 2. Critical path to 1B (the dependency spine)

```
Phase 0 (done)
   └─► M1 ComputeBackend seam + schema rename        (unblocks all backends)
          ├─► M2 Session durability (DatabaseSessionService)
          │      └─► M3 Remote agent transport (A2A/MCP) + I1 revocation  ← the pivot to per-user
          │             ├─► M7 AnypointBackend (CloudHub 2.0 / RTF)       ← GENERAL/MASS primary · critical path (prepaid capacity) [external-gated: MuleSoft]
          │             │      └─► M8 Correction-request data-rights toolset
          │             ├─► M4 GcpBackend (Cloud Run)                     ← REGULATED-tier primary + validated live (FedRAMP High)
          │             │      └─► M5 Confidential Space attested tier      ← PCC parity
          │             ├─► M6 BYOC / user-owned GCP (keyless WIF)       ← sovereignty tier [external-gated]
          │             └─► M9 On-device body (mobile + Puppy sync)
          └─► M10 Onboarding reveal + BYO-config (parallel, needs only M1)
   M11 Observability/SLO/scale-hardening   (parallel from M4 onward)
   M12 Fleet rollout controller            (parallel from M4 onward)
   M13 FedRAMP High posture                [external-gated: 3PAO/ATO], parallel, long-lead
```

The **pivot** is M3: until a per-user agent is reachable over network transport with
durable state, "sovereign per-user agent" is a registry entry, not a running thing.
M1→M2→M3 is the non-negotiable spine; everything else fans out from it.

## 3. Milestones (scope · happy path · edge cases · exit · estimate)

Legend: **EW** = engineering-weeks from kickoff; estimates assume parallel tracks.

| # | Milestone | Happy path | Edge cases to cover | Exit criteria | Estimate |
|---|---|---|---|---|---|
| **M1 ✅ shipped** | `ComputeBackend` seam + backend-agnostic schema | Interface + `PodSpec`/`BackendHandle`/`BackendStatus`; rename `anypoint_agent_id`→`external_agent_id` + `backend`/`space_id`/`backend_metadata`/`attestation_ref`; `NullBackend`; `PERSONAL_AGENT_BACKEND` selector | migration edit-in-place is idempotent; NullBackend is a true no-op; existing tests pass unchanged | ✅ seam merged flag-off; 5 readers updated; brain behavior identical; ruff+mypy+bandit clean, 113 tests green | **done** (`0688103`) |
| **M2 ✅ wired (flag-off)** | Session durability | `DatabaseSessionService` swap in `get_one_runner`/`get_one_text_runner` on existing Postgres, behind `ONE_DB_SESSIONS_ENABLED` (default off), fail-safe fallback to in-memory | write-load under voice sessions; cold-start; concurrent turns; migration of in-flight sessions | ✅ seam wired + tested, flag-off (live runtime unchanged); **live enablement + write-load measurement remain founder-gated** (turning it on changes the live path) | **done** (`b2e3816`); enablement TBD |
| **M3** | Remote agent transport + I1 | `dispatch()` HTTP client keyed by `agent_id`; A2A `/u/{hushh_id}` indirection; **unify the A2A `POST /message` lane onto the ADK text head** (legacy orchestrator today); pod read path uses **DB-backed** validator so revocation bites; official A2A SDK conformance | revoked token mid-session; pod unreachable; address re-resolve after migration; replay/duplicate | a per-user pod answers A2A over network; `officialA2A:true`; revoke kills read within one validation; I1 closed | **2–3 EW** |
| **M4 ✅ live loop proven in dev — regulated-tier primary + validated** | `GcpBackend` — logical tier (FedRAMP-High / regulated primary + the proven backend) | Cloud Run provisioning (logical/mass tier); Vertex Gemini (BYOK) | throttle under burst; region pin; idempotent re-provision; teardown-on-delete | ✅ adapter renders Cloud Run artifact + handle (`gcp_backend.py`); ✅ **live** create→Ready→orchestrate→delete round-trip **executed in `hushh-pda-dev`** (2026-07-21, [`M4-LIVE-VALIDATION.md`](./M4-LIVE-VALIDATION.md)); ⏳ remaining: wire it behind phone-verify at scale + per-user routing (M3) | **live proven** in dev; productionization tracks M3/M11 |
| **M4a ✅ pod hardening (flag-off)** | pod access audit · pod mode · storage seam | owner==caller receipt gate (`pod_access_audit.py`); `HUSSH_POD_MODE` skips fleet workers (`server.py`); `pod_storage.py` cloud-backup ⇄ pod ⇄ device seam | cross-user token redirect; duplicate fleet workers; plaintext leakage | ✅ built + unit-tested (25 cases), inert by default | **done** (`f1182a8`) |
| **M5** | Confidential Space attested tier | GKE/Cloud Run + Confidential Space; **attestation-gated key release**; Binary Authorization | attestation mismatch → key withheld (fail-closed); image-digest rotation; measured-boot failure | dedicated pod's X25519 key unwraps only on matching attestation; PCC-parity claim verifiable | **4–6 EW** |
| **M6 ◐ adapter built (inert)** | BYOC — pod in the user's own GCP | Provision into the **user's own GCP project** via **keyless Workload Identity Federation** + a least-privilege bootstrap; same slim image + `ComputeBackend` seam (align with HusshOne Xtreme Compute Burst later) | idempotent teardown; orphaned-instance reconcile; key never persisted; Hushh holds no standing creds into the project | ✅ `UserGcpBackend` renders the pod + a keyless WIF bootstrap plan (plan-mode, `user_gcp_backend.py`, contract-tested, [BYOC-USER-GCP](./BYOC-USER-GCP.md)); ❌ **live** needs a real user project + applied WIF bootstrap | **struct done**; live 3–4 EW **[external-gated: user project + WIF]** |
| **M7 ◐ adapter built — GENERAL/MASS primary (critical path)** | `AnypointBackend` — general-tier primary runtime + enterprise / governance lane | The per-user pod as a Mule app on **CloudHub 2.0 / Runtime Fabric** in a **Private Space**; AMC provisioning (Connected-App client-cred); primary for general / mass via **prepaid Titanium capacity**; hosts the runtime **and** carries the consent-event/sync/correction path | 15 req/s AMC throttle; idempotent by hushh_id; already-gone teardown; secret custody; per-user isolation | ✅ adapter renders AMC descriptor + Private Space + handle (plan-mode, `anypoint_backend.py`); ❌ **live** AMC call **raises** — gated (Connected App + written MuleSoft confirmation + founder go) | **struct done** (`e9494d4`); **live = critical path** (general-tier primary), external-gated |
| **M8** | Correction-request data-rights toolset | GDPR Art.16 / CCPA correction requests with a PCHP receipt per request; enterprise validates+applies (no outside write) | denied/expired consent; sensitive-ID class (separate authz, field-encrypted, no retention); revocation flow-back | a consented correction request round-trips with receipts logged both sides | **3–4 EW** |
| **M9** | On-device body | Capacitor background agent (iOS BGTask + silent push; Android foreground service) + device↔cloud sync via `relay_auth` tickets | OS background limits (honest: no literal 24/7); offline; token refresh; battery | device agent wakes, syncs, and hands off to the cloud body; app-store-safe | **3–4 EW** |
| **M10** | Onboarding reveal + BYO-config | Reveal ("reserved→live") + `$0.69` spaceID reservation; BYO: MCP-OAuth, BYOK Gemini, region/tier; one-tap default | fail-safe to "reserved"; OAuth denial; invalid key; default-path zero-input | phone-verify → reveal → optional BYO, all flag-gated, Summer-26 bar, ≤ N taps | **2–3 EW** (needs only M1) |
| **M11** | Observability / SLO / scale-hardening | One event schema across backends; SLOs (provision latency, teardown success, orphaned-instance ceiling ~0, time-to-first-progress); reconcile-at-scale; rate-limit/throttle | thundering-herd provision; partial-failure; region outage; cost ceilings | dashboards + alerts live; SLOs measured; reconcile sweep proven | **3–4 EW**, then ongoing |
| **M12** | Fleet rollout controller | Cohort rollout (internal→canary→staged→general) for prompt + runtime versions; global kill-switch | bad prompt/runtime rollback; canary health-gate; per-cohort pin | a prompt/runtime change rolls out by cohort with instant rollback | **2–3 EW** |
| **M13** | FedRAMP High / DoD IL posture | Assured Workloads env; NIST 800-53 High controls; consent-receipt-per-access already in place | control gaps; audit-log completeness; IdP (IAL2/AAL2) | posture documented "in pursuit"; 3PAO engaged | **long-lead** **[external-gated: 3PAO/ATO]** |
| **M14 ◐ login shipped (flag-off)** | Identity & authenticator assurance (biometric·passkey·WebAuthn·hardware keys) | ✅ server WebAuthn ceremony + credential store (migration 903) + flag-gated endpoints; ✅ **passkey-login** (UV-gated → Firebase custom token); ✅ **AAL classification** (`webauthn_aal.py`: Titan/YubiKey→AAL3-candidate, platform+UV→AAL2). ❌ remaining: **step-up** on sensitive personal-agent actions (VAULT_OWNER, provision, correction requests) with a PCHP receipt; **MDS-verified attestation** to promote AAL3-candidate → hard AAL3 | Firefox/Windows-Hello/roaming-key coverage; cloned-authenticator (sign_count ✅); UV-gated login (✅); lost-device recovery; keep vault-unlock PRF distinct | passkey **login** works (✅); a Titan/YubiKey assertion gates a sensitive action at AAL3; posture mapped to NIST 800-63B, honest "in pursuit" | **login done** (`ab4d820`,`4bb25e4`); step-up + MDS 2–3 EW · design: [`../identity-assurance/README.md`](../identity-assurance/README.md) |

## 4. Workstream swimlanes (what runs in parallel)

- **Core (identity/consent/transport):** M1 → M2 → M3. One senior owner; blocks the rest.
- **Anypoint runtime (general / mass primary):** M7 → M8. The **primary** deployment lane for the general tier (prepaid Titanium capacity → best cost at scale) + the enterprise / governance lane; **critical path**; starts once M3 lands **and** the MuleSoft API + written exhibit confirm.
- **GCP runtime (regulated-tier primary + validated):** M4 → M5. The **primary** lane for the FedRAMP-High / regulated tier — FedRAMP High + the proven live loop + the Confidential-Space attested tier; de-risks the whole design; starts once M3 lands.
- **BYOC / sovereignty:** M6 (user-owned GCP, keyless WIF). The own-your-compute tier.
- **On-device:** M9. Coordinates with the app/HusshOne teams.
- **Frontend/onboarding:** M10. Starts right after M1 (needs only the status contract).
- **SRE/scale:** M11 → M12. Starts with M4; runs continuously.
- **Compliance:** M13. Long-lead, parallel from day one.

## 5. Dependencies & external gates (velocity cannot compress these)

| Gate | Blocks | Owner / source | Status |
|---|---|---|---|
| Flag-on + resourcing decision | everything (kickoff) | Founder | pending |
| MuleSoft provisioning/enterprise API shape | M7 (general / mass-tier primary — critical path) | Michael Jacobs (consultant of record, per 2026-07-13) | pending |
| **Written 1B-capacity exhibit** (verbal ≠ contract) | M7 general-tier go-live + all 1B-capacity claims | MuleSoft account team | **requested, unverified** |
| HusshOne Xtreme Compute Burst control-plane access | M6 | HusshOne repo/team | coordination needed |
| GCP quota + Confidential Space + Assured Workloads enablement | M4/M5/M13 | GCP account | pending |
| 3PAO assessment / agency ATO | M13 (FedRAMP claim) | 3PAO | not started ("in pursuit") |
| Stripe corporate entity for SKU-0000 | reservation $0.69 go-live | Founder (per wiki: account resolves to personal name) | **held** |
| McDermott counsel review of 🤫 coin mechanics | reservation coin credit | Legal | pending |

## 6. Risk register (likelihood × impact · mitigation · "we're wrong if…")

- **R1 — MuleSoft 1B capacity is verbal only** *(med × high; verbal ≠ contract).* Anypoint is
  the **general / mass-tier primary** (M7, critical path), and its 1B-scale economics rest on
  the **pre-purchased Titanium capacity** — which is **founder-stated / unreconciled**, so this
  is a real headline risk for the general tier. Mitigation: the **backend-neutral seam** means
  **GCP — the validated, live-wired backend — is the proven fallback for the general tier too**,
  so the runtime is never hostage to the MuleSoft exhibit; require the **written capacity
  exhibit** before any 1B claim that rests on Anypoint. *Wrong if:* the exhibit never
  materializes or caps below the workload → fall back to the GCP-hosted runtime for the general
  tier, with Anypoint kept to the enterprise lane.
- **R2 — Confidential-compute attestation is fiddly at scale** *(med × med).* Mitigation:
  ship the logical tier (M4) first; make M5 attested-tier opt-in (premium). *Wrong if:*
  key-release latency or attestation flakiness makes the attested tier unusable → fall
  back to crypto-isolation-only for mass tier, keep attestation for regulated tier.
- **R3 — Per-user fleet cost blows up** *(med × high).* Mitigation: a **per-tier warm
  floor** — the real-time / dedicated / active-user tier keeps `minScale=1` (no cold
  start), while the 1B **mass tier** runs `minScale=0` + fast wake (durable state, not
  warm compute) so idle users cost ~nothing; cost SLO in M11; BYOC pushes heavy compute
  to the user's own project. Configurable via `HUSSH_POD_MIN_INSTANCES` — see the measured
  0-vs-1 tradeoff in [M4-LIVE-VALIDATION](./M4-LIVE-VALIDATION.md). *Wrong if:* idle cost
  per reserved (mass-tier) user exceeds the free-for-life economics → tighten to on-demand
  wake only.
- **R4 — Session durability write-load** *(low × med).* Mitigation: measure before the
  swap (the docstring's own gate). *Wrong if:* voice-session write volume overwhelms
  Postgres → Redis tier earlier than planned.
- **R5 — Revocation doesn't bite on the remote pod** *(low × high, security).* Mitigation:
  I1 is a hard M3 exit criterion (DB-backed validator on the pod read path). *Wrong if:*
  any cached-token path lets a revoked read survive → M3 does not ship.
- **R6 — Scope/brand drift** *(med × med).* Mitigation: the parity matrix + divergence
  register (ARCHITECTURE §8/§9) reviewed on every backend-touching PR; honesty ledger
  (§11) enforced. *Wrong if:* a doc claims a certification or capacity we don't hold.
- **R7 — HusshOne burst integration diverges** *(med × med).* Mitigation: integrate, don't
  rebuild; treat their provider abstraction as the interface. *Wrong if:* their contract
  can't express our per-user consent binding → wrap it behind our `ComputeBackend`.

## 7. Realistic production-launch expectations (the honest dates)

Staged, each gated on real signals — not a single "launch day":

| Stage | What's true | Requires | Aggressive target |
|---|---|---|---|
| **Internal alpha** | flag-on for the team; one region; logical GCP tier; reveal screen | M1–M4, M10 | **Q4 2026** |
| **Canary** | small % of real, consenting users; durable sessions; SLOs live | M5 (or M4 + crypto-iso), M11 | **Q1 2027** |
| **Limited GA** | free-for-life Agent One at phone-verify; on-device body; fleet rollout | M6/M9, M12 | **Q2 2027** |
| **Scale / 1B-ready** | all rungs, cost + reconcile proven at volume, compliance in pursuit | M11 at volume, R3 closed, M13 progressing | **2027 → 2028**, external-gated |

**The honest headline:** engineering can put the **first real sovereign agent live in Q4
2026** at max velocity. **1 billion users** is not an engineering-velocity milestone — it
is gated on cost economics (R3), the MuleSoft/GCP capacity exhibits, compliance posture
(M13), and real demand. We build every layer 1B-correct (logical pods, durable state,
backend-agnostic, consent-per-action) so scale is a ramp, not a rewrite — but we will not
put a 1B date in ink until the capacity exhibits and cost SLOs are real.

## 8. Priorities

- **Done (all inert, flag-off):** M1 (`ComputeBackend` seam + schema, `0688103`), M2
  (durable session seam behind `ONE_DB_SESSIONS_ENABLED`, `b2e3816`), the **M4/M7 adapters**
  in plan-mode (`GcpBackend` + `AnypointBackend`, interchangeable + contract-tested,
  `e9494d4`), and the **provisioning brain threaded through the backend** (`ed2af97`). The
  modular deployment abstraction — deploy to GCP or Anypoint through one interface — is
  **complete end-to-end**; only *live* execution remains.
- **Now (safe, inert):** M10 (onboarding reveal + BYO-config) — flag-gated, no live-runtime
  risk, no external gate.
- **Next (a genuine pause point — needs credentials / founder go / design input):** **live**
  M7 (real AMC — the **general / mass-tier primary**, critical path, gated on the MuleSoft
  confirmations), **live** M4 (real Cloud Run — the **FedRAMP-High / regulated-tier primary** +
  the proven backend), and M3 (per-user transport, touches the live path).
- **Later / gated:** M5–M6, M8–M9, M11–M13 per their gates.
- **Identity track (M14):** elevate biometric/passkey from *vault-unlock only* (today's
  honest state) to a real WebAuthn/FIDO2 **login + step-up** with hardware-key (Titan)
  support and an AAL2/AAL3 posture. Design of record: [`../identity-assurance/README.md`](../identity-assurance/README.md).
  Underpins the FedRAMP/consent posture; can run parallel to the backend tracks.

## 9. Immediate next step (dev-only, no deploy)

**M1 and M2 are shipped, flag-off** (`0688103`, `b2e3816`): the `ComputeBackend` seam +
backend-agnostic schema, and the durable `DatabaseSessionService` seam behind
`ONE_DB_SESSIONS_ENABLED` (fail-safe fallback to in-memory). Both inert; M2's live
enablement + write-load measurement remain founder-gated (turning it on changes the live
path).

Next is **M10 — onboarding reveal + BYO-config:** the safe, inert, flag-gated increment
(reveal screen, spaceID reservation, MCP-OAuth, BYOK, region/tier), no live-runtime risk
and no external gate. The bigger **M3 pivot** (per-user remote transport) and **M4** (first
real GCP host) come after, and touch the live path / external gates — so they get a
considered go, not an autonomous run. **No UAT/Prod, no `main` merge, no external backend
calls** until the founder says so.
