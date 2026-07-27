# Execution log — sovereign personal-agent workstream

> A chronological "what shipped, when" ledger so the context is traceable end to
> end. Pairs with [`ROADMAP.md`](./ROADMAP.md) (the plan), [`ARCHITECTURE.md`](./ARCHITECTURE.md)
> (design of record), and [`M4-LIVE-VALIDATION.md`](./M4-LIVE-VALIDATION.md) (live
> evidence). All on branch `claude/hushh-infrastructure-analysis-7o991c`,
> **flag-off / dev-only**; nothing merged to `main` or deployed to UAT/Prod.

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

## Live validations (dev only, `hushh-pda-dev`)

| Date | What was proven | Detail |
|---|---|---|
| 2026-07-21 | **First per-user pod, full lifecycle** — deploy → agents orchestrate (`one/kai/nav/kyc`) → 3-layer access lockdown → teardown, zero residue | [M4-LIVE-VALIDATION §1](./M4-LIVE-VALIDATION.md) |
| 2026-07-22 | **Slim pod surface split** — agent surface serves, consent/central routes 404 live; built via Cloud Build; zero residue | [M4-LIVE-VALIDATION "Slim pod"](./M4-LIVE-VALIDATION.md) |
| 2026-07-22 | **Warm-floor measurement** — `min=0` cold ~11.2s vs warm ~0.6s; `min=1` holds warm; default set to 1 | [M4-LIVE-VALIDATION "Minimum instance count"](./M4-LIVE-VALIDATION.md) |

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
