# Execution log — sovereign personal-agent workstream

> A chronological "what shipped, when" ledger so the context is traceable end to
> end. Pairs with [`ROADMAP.md`](./ROADMAP.md) (the plan), [`ARCHITECTURE.md`](./ARCHITECTURE.md)
> (design of record), and [`M4-LIVE-VALIDATION.md`](./M4-LIVE-VALIDATION.md) (live
> evidence). All on branch `claude/hushh-infrastructure-analysis-7o991c`,
> **flag-off / dev-only**; nothing merged to `main` or deployed to UAT/Prod.

## Visual Context

Canonical visual owner: [personal-agent Visual Map](./README.md).

## Milestone → change → commit ledger

| Milestone | What shipped | Commit(s) |
|---|---|---|
| Phase 0 | Identity (HusshID), registry + tombstones (mig 900), standing Nav-governed `pkm.read`, X25519 pod key, provisioning brain, prompt-sync (mig 901 + `GET /api/one/agent-prompt`), owner-authorized routes, live lifecycle wiring | (Phase-0 series; see [`README.md`](./README.md) build table) |
| Migrations parked | Unapplied personal-agent migrations parked at 900/901/902 to end the renumber tax | `270c8ee` |
| M2 — session durability | Flag-gated `DatabaseSessionService` swap seam (`ONE_DB_SESSIONS_ENABLED`, default off, fail-safe to in-memory) | `b2e3816`, docs `57f8507` |
| M1 — compute seam | `ComputeBackend` Protocol + `NullBackend` + resolver; `GcpBackend` + `AnypointBackend` adapters (plan-mode, interchangeable, inert) | `e9494d4`, docs `ccb0b87` |
| M1 — brain threading | Provisioning brain threads through the selected backend (persist handle; teardown routes to same backend) | `ed2af97` |
| M14 — WebAuthn/FIDO2 | Server-side ceremony engine (`py_webauthn`); flag-gated endpoints + DB store (mig 903); passkey-login session minting; Titan/YubiKey AAL classification | `ab4d820`, `6945f65`, `4b42e1b`; docs `c0bfb28`, `032f400`, `fb53d0f` |
| M4 — live GCP wiring | `GcpBackend._execute` wired to `gcp_run_client.py` (Cloud Run Admin v1), mock-tested; gated by `HUSSH_GCP_BACKEND_LIVE` | `906f146` |
| M4a — pod hardening | Pod-access audit (owner==caller + receipt), `HUSSH_POD_MODE` (skip fleet workers), pod storage/sync seam | `f1182a8`, docs `0270694` |
| Slim pod | `pod_server.py` (agent + storage only; 4-router allowlist) + `Dockerfile.pod` | `5e10402` |
| Bug fixes (from live test) | Pinned missing `webauthn==3.0.0` dep; gunicorn writable-dir fix in `Dockerfile.pod` | `3ec004c` |
| Warm floor | `GcpBackend` default `minScale=1` (configurable via `HUSSH_POD_MIN_INSTANCES`) + measured 0-vs-1 evidence | `3fb1c80` |
| Housekeeping | Removed 12 orphaned repo-root codemod scripts (zero-reference) | `0f4daf5` |
| Docs cross-link | Cluster index + doc map + `EXECUTION-LOG`; fixed stale/dangling context (audit-driven) | `2ad998d` |
| M6 — BYOC seam | User-owned GCP adapter (`UserGcpBackend`) + keyless WIF least-privilege bootstrap plan + resolver wiring + contract tests (inert); [BYOC-USER-GCP.md](./BYOC-USER-GCP.md) | (this branch) |
| Anypoint-primary + Private Space | `AnypointBackend` reframed to primary runtime target; optional `ANYPOINT_PRIVATE_SPACE_ID` isolation; resolver + tests | (this branch) |
| Full doc reconciliation | Code ground-truth audit → README / ARCHITECTURE / ROADMAP reconciled to Anypoint-primary + GCP-validated, problems-backwards; fixed `compute_backend.py` self-contradiction + a 07-22→07-21 date error | (this branch) |
| Mail-event trigger (per-user inbox) | `UserGcpBackend` bootstrap plan gains the BYOC mail-trigger (Pub/Sub topic + `gmail-api-push` publisher binding + pod pull-`subscriber` + daily `watch`-renewal), a **metadata-only doorbell** — the pod opens the mail, hussh out of the path; Anypoint spec §5 row + §7d + Snippet 5 (Mule listener flow) | (this branch) |
| Workload-segmented posture (2026-07-25) | Primary chosen **per workload class**: **Anypoint = general/mass primary** (pre-purchased Titanium capacity → best cost at 1B); **GCP = FedRAMP-High / regulated primary** (+ the validated, live-wired backend). Reconciled code (`compute_backend`/`gcp_backend`/`anypoint_backend` docstrings) + ARCHITECTURE/README/ROADMAP. Supersedes the earlier "Anypoint-primary + GCP-validated" framing (rows above) on the FedRAMP-High basis | (this branch) |
| Founder sandbox environment — scaffolded, then removed | Briefly scaffolded a GCP `hushh-pda-founder` env mirroring `hushh-pda-dev`, then **removed it entirely** (`deploy-founder.yml`, `founder.autodeploy.backend.cloudbuild.yaml`, `provision-founder.sh` + `setup_founder_cloudbuild_triggers.sh`, `config/ci-governance.json` founder surface, `assert-governed-actor.py` founder surface, runbook, `/deploy-founder`). A separate founder GCP project was not cost-justified; the existing **dev** lane (`deploy-dev.yml` → `hushh-pda-dev`, any CI-green ref, `uat` runtime identity, never promotes) is the feature-branch preview path instead — see `docs/reference/operations/dev-fast-lane.md` | (this branch) |
| S0 custody unblock | Pod-mode scoping so a pod no longer requires `VAULT_DATA_KEY` (it performs no vault crypto; the hub still refuses to boot without one), durable pod-key seam, hub-initiated key rotation, and the generated `contracts/` tree shipped into the image (three loaders were resolving repo root and degrading silently to empty) | (this branch) |
| S1-S3 PKM engine seam | `PkmWriteEngine` Protocol extracted with zero behaviour change; conformance oracle transcribed from `pkm_v7_zero_loss_rehearsal.sql` and **proven green against real Postgres 16 first**; then the pod-local SQLite engine (`BEGIN IMMEDIATE`, `json_patch`, GIN dropped as confirmed-unused) green on that same oracle first run | (this branch) |
| S4 durable pod tier | Sealed, hash-chained commit log (AES-256-GCM) over an object store as the pod's system of record, SQLite as a rebuildable index. Object storage is the only primitive shared by GCP, CloudHub 2.0 and hardware — CloudHub has no managed DB and no durable volume, so any DB-dependent design fails the mass tier outright | (this branch) |
| S5 asymmetric consent | Alg-tagged signature slot (`ed25519.<kid>.<sig>`) with a byte-identical payload, verify-both rollout, HMAC still the issuance default. Old verifiers fail `compare_digest` and reject — fail-closed, which is what allows verify-both everywhere before issuance flips | (this branch) |
| S6 full fleet in the pod | Vertex/model env rendered into the pod, all six product specialists registered as **lazy handler thunks** (eager imports closed an import cycle), first-party `A2AAuthorityContext` carrying invocation capability only — reachable, self-guarding, and honest about the authority that exists | (this branch) |
| S7 control-plane split | `GET /api/one/u/{hushh_id}/info` — the owner-authorized private relay, the single door to a pod. First reader of the pod URL the hub wrote at creation (previously write-only) and first caller of `PodAccessAuditService` (complete, tested, zero callers). Migration is **reset, not move**; closed a real gap where `pwm_documents` was absent from both the reset and full-deletion paths | (this branch) |
| S8 backend capability parity | Per-backend capability extractors so parity is asserted semantically across differently-shaped artifacts; proven to fail against Anypoint on exactly four capabilities before Anypoint was brought to parity. `UserGcpBackend` added to the interface contract | (this branch) |
| CloudHub model access corrected | Anypoint has no Vertex: model access there is **BYOK** (the user's own AI connection, turn-bounded key, isolated from backend ADC). The previous render emitted dead `GOOGLE_CLOUD_PROJECT`/`LOCATION` onto a platform with no ambient identity. Parity now asserts the credential **mode**, not one vendor's env var | (this branch) |
| Multi-pod dev simulation | `consent-protocol/scripts/sim_multi_pod.py` + `consent-protocol/scripts/sim_consent.py` — N per-user pods, one OS process each, pod-unique signing/seal/memory keys, real `PodPkmStore`, real consent protocol. Run at 10, 20 and **50 pods**; ~211 MB/pod flat from 1 to 50 | (this branch) |
| Pod observability probe | `consent-protocol/scripts/ops/pod_resource_probe.py` + `consent-protocol/tests/test_pod_observability_contract.py` — cold start **3.94 s** (correcting a ~25 s figure that was never measured, only inferred from a timeout), idle 211.9 MB, loaded 212.7 MB, and `google.adk` at **58% of every pod boot**. Tripwire added: the startup probe must never point at `/health/ready`, which a pod answers 503 by design | (this branch) |

## Live validations (dev only, `hushh-pda-dev`)

| Date | What was proven | Detail |
|---|---|---|
| 2026-07-21 | **First per-user pod, full lifecycle** — deploy → agents orchestrate (`one/kai/nav/kyc`) → 3-layer access lockdown → teardown, zero residue | [M4-LIVE-VALIDATION §1](./M4-LIVE-VALIDATION.md) |
| 2026-07-22 | **Slim pod surface split** — agent surface serves, consent/central routes 404 live; built via Cloud Build; zero residue | [M4-LIVE-VALIDATION "Slim pod"](./M4-LIVE-VALIDATION.md) |
| 2026-07-22 | **Warm-floor measurement** — `min=0` cold ~11.2s vs warm ~0.6s; `min=1` holds warm; default set to 1 | [M4-LIVE-VALIDATION "Minimum instance count"](./M4-LIVE-VALIDATION.md) |
| 2026-08-05 | **50-pod fleet, real consent + dynamic PKM** — 50/50 pods live at 10,569 MB (~211 MB each, flat from 1 to 50); 23 cycles, 5,750 PKM revisions, 5,750 consent events; 8 consent checks x 50 pods green | [MULTI-POD-DEV-SIMULATION](./MULTI-POD-DEV-SIMULATION.md) |
| 2026-08-05 | **Single-pod resource probe** — cold start 3.94 s, idle 211.9 MB, loaded 212.7 MB (+0.8 MB across 150 requests), import breakdown attributing 58% of boot to `google.adk` | `consent-protocol/scripts/ops/pod_resource_probe.py` |
| 2026-08-05 | **Dev fleet torn down** — `one-pod-devsim01` / `devsim02` deleted; `pod_fleet.py` reports no pods labelled `app=hussh-one-pod` in `hushh-pda-dev` | `consent-protocol/scripts/ops/pod_fleet.py` |
| 2026-08-06 | **The journey was unreachable, and it was configuration, not code.** `grep -r PERSONAL_AGENT deploy/ scripts/deploy/` returned nothing, so every personal-agent flag sat at its OFF default in every environment. `HUSSH_GCP_BACKEND_LIVE` unset left `GcpBackend` in plan mode — rendering a config, never calling Cloud Run, reading as success at every layer above it. Measured live on the pre-deploy revision: 7 of 7 flags absent | `scripts/deploy/backend-deploy.sh`, `tests/test_personal_agent_deploy_lane.py` |
| 2026-08-06 | **Managed mode never told the server anything.** Managed is the DEFAULT connection mode and choosing it wrote to the user's own PKM vault, contacting no route at all; `GET /managed/readiness` had ZERO callers in the webapp. Provisioning hangs off "an AI connection was verified", which had one caller (BYOK validate) — so the default onboarding path finished with no agent, no error, and nothing anywhere saying so | `POST /api/one/runtime/managed/select` |
| 2026-08-06 | **Nothing drove key collection.** `collect_pod_key_if_pending` had one caller — a status read whose only client fires once on mount, no polling, on a screen the AI flow does not route to. Its comment claimed "onboarding polls this endpoint"; that poller does not exist. A pod's first heartbeat now TRIGGERS the hub's pull (the beat selects a row; the key still comes from the URL the hub recorded, so a lying pod gains nothing) | `api/routes/one/pod_heartbeat.py` |
| 2026-08-06 | **The heartbeat could not run.** Pods carried no `cpu-throttling` annotation, so a background asyncio loop barely progresses between requests — a warm pod would go quiet, be judged stale, and auto-heal would restart a pod answering its owner perfectly. Now allocated on the warm tier only | `hushh_mcp/services/gcp_backend.py` |
| 2026-08-06 | **Every pod older than 24h held no consent token.** The standing `pkm.read` grant is minted once at provisioning and the token string is deliberately never stored; nothing re-issued it. The only token still in hand anywhere was `vault.owner`, the master grant | `issue_or_reuse_standing_pkm_read` |
| 2026-08-06 | **Real fleet ceiling read from the quota authority** — Cloud Run `Services`, unit `1/{project}/{region}`, effectiveLimit **1000** = defaultLimit (no increase ever granted on `hushh-pda-dev`). `PERSONAL_AGENT_MAX_PODS` is only a registry row count | [POD-AUTOPROVISION §"The real fleet ceiling"](./POD-AUTOPROVISION.md) |
| 2026-08-06 | **The CI Status Gate was unobtainable on this branch** — `secret-scan` failed on 4 gitleaks findings, Preflight then skipped every expensive lane, and the gate reported failure, so no dev deploy could satisfy its CI-green check. All 4 were one false positive: `generic-api-key` reads `alias="runtimeCredential", max_length=12000` as a key assignment and captures `max_length=12000` as the secret | `.gitleaks.toml` |

## Execution process (how work lands here)

1. **Plan** a milestone in [`ROADMAP.md`](./ROADMAP.md); record design decisions in [`ARCHITECTURE.md`](./ARCHITECTURE.md).
2. **Build** behind a default-off flag; add hermetic tests; register them in `consent-protocol/scripts/test-ci.manifest.txt`.
3. **Gate**: `ruff + mypy + bandit + pytest` (locally `bash scripts/ci/orchestrate.sh protocol`).
4. **Sync `main`** into the branch each milestone (resolve drift early).
5. **Validate live** only in `hushh-pda-dev`, throwaway + IAM-locked, deleted immediately; record evidence in [`M4-LIVE-VALIDATION.md`](./M4-LIVE-VALIDATION.md).
6. **Commit + push**; append the row above. Nothing to UAT/Prod/`main` without founder sign-off.

## Next

The **BYOC adapter seam is built** (`UserGcpBackend`, inert) on top of the verified
slim pod — see [`BYOC-USER-GCP.md`](./BYOC-USER-GCP.md). The remaining BYOC work is
**external-gated**: stand up a real (throwaway, dev-only) "user" GCP project, apply
the keyless WIF least-privilege bootstrap (Terraform module or device-agent-over-MCP),
then flip `HUSSH_USER_GCP_LIVE` for a dev-only end-to-end. Until that external setup
exists, live raises. Tracked in [`ROADMAP.md`](./ROADMAP.md) (M6).
