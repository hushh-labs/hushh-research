# M4 live validation — first single-user pod, deployed and torn down in dev

> **Status:** ✅ **Executed live** on **2026-07-21** in **`hushh-pda-dev` only**
> (hushh-research's dev GCP project). One throwaway per-user pod was created,
> proven to run the hussh agents and enforce owner-scoped access, then deleted —
> no residue. **Nothing** touched UAT, production, `main`, or the
> `hussh-developer-platform` project. Companion: [`ROADMAP.md`](./ROADMAP.md) (M4),
> [`ARCHITECTURE.md`](./ARCHITECTURE.md) (§7 Apple-PCC-on-GCP).

## Visual Context

Canonical visual owner: [personal-agent Visual Map](./README.md).

## What this validated (and what it did not)

**Proven, live:** the **deploy → agents-orchestrate → access-locked → teardown**
loop for a single user's pod, on real Google Cloud Run, using the *same runtime
image the current dev service runs* (so the agents are exactly today's agents).

**Not yet proven (still ahead, unchanged):** per-user network **routing**
(`/u/{hushh_id}` → this pod) is M3; the **attested** Confidential-Space tier is
M5; an actual owner **PKM read** through the pod exercises the new
`pod_access_audit` gate (built + unit-tested here, not yet run against a live
pod). This run validated the *host lifecycle + access boundary*, not the full
data path.

## Exactly what was deployed

| Property | Value | Why |
|---|---|---|
| Project / region | `hushh-pda-dev` / `us-central1` | dev-only, per standing directive |
| Service | `one-pod-e2etest01` (throwaway, labels `hussh-ephemeral-test=true`) | clearly disposable |
| Image | `gcr.io/hushh-pda-dev/consent-protocol:dev-b853c6e…` | **the current dev runtime** — same agent tree, "orchestrate as they are currently" |
| Ingress | `all` + IAM-locked (**no `allUsers`**) | test needs reachability from the validation sandbox (outside the VPC); locked so it is **not** open to the world. *Production posture is `ingress: internal`* (what `GcpBackend.render_deploy_config` emits) |
| Scale | `minScale=0 / maxScale=1` | a single, short-lived instance |
| Identity env | `HUSSH_ID`, `HUSSH_SPACE_ID`, `HUSSH_REGION` | single-user scoping |
| Fleet workers | neutralized for the test (blank Firebase creds + blank ONE_EMAIL) | so a second instance could **not** duplicate FCM pushes / Gmail watch renewals against shared dev. The durable fix — `HUSSH_POD_MODE` — is now committed so the *next* pod image is quiet by construction |

## Evidence (live, 2026-07-21)

1. **Deploy →** create accepted; polled to `Ready=True` (Cloud Run only flips
   Ready once the container serves on `:8080` → **the full agent runtime booted**).
2. **Agents orchestrate as today →** `GET /health` (authenticated) returned
   `{"agents":["one","kai","nav","kyc"],"agent_model":{"primary":"one",`
   `"specialists":["kai","nav","kyc"]}}` — Agent One as primary orchestrating
   kai / nav / kyc. `GET /api/one/a2a/card` returned the **Agent One** card
   (`agentId=agent_one`) advertising its consent-managed skills.
3. **Access is truly owner-scoped (three layers) →**
   - **Cloud Run IAM:** an **anonymous** `GET /health` → **`403 Forbidden`** (the
     pod is not publicly reachable).
   - **App developer auth:** a `POST /api/one/a2a/message` with a valid Google ID
     token but no hushh developer token → **`403 DEVELOPER_TOKEN_INVALID`**.
   - **Owner consent:** the same call has no path to execute without an
     `X-Consent-Token` scoped `cap.one.invoke` — the pod cannot act on anyone's
     behalf without the **owner's own** consent.
   - **IAM policy read:** `bindings=0`, no `allUsers`/`allAuthenticatedUsers`.
4. **Teardown →** `DELETE` → `200`; `GET` → `404` (gone); the service list
   returned to its original three entries. **No residue.**

**Honest caveat:** `GET /health/ready` returned `404` — the pinned dev image
(`b853c6e`) predates the dependency-aware readiness route added later on `main`.
`GET /health` (which does prove liveness + the agent list) returned `200`. Not a
failure of the pod; a property of the image SHA that happens to be deployed.

## The code this run motivated (committed alongside, flag-off)

- **`pod_access_audit.py`** — fail-closed **owner == caller** gate in front of the
  pod's standing `pkm.read`, writing a **visible** `POD_ACCESS_ALLOWED` /
  `POD_ACCESS_DENIED` receipt. A token minted for one owner can never be
  redirected to read another pod (agent-id + provisioned-row + HusshID checks).
  This is the "audit that access is truly the user himself" control.
- **`HUSSH_POD_MODE`** (`runtime_settings.pod_mode()` + `server.py`) — a per-user
  pod serves the full agent runtime + A2A + health but **skips fleet-wide
  singletons** (consent→FCM listener, Gmail renewal, revocation sweep). Default
  off; the durable version of the test-time neutralization above.
- **`pod_storage.py`** — typed, inert seam for the pod as **shared compute +
  storage**: PKM **cloud backup** (the zero-knowledge vault, canonical) ⇄ a
  **per-pod-key-encrypted cache** ⇄ the **device**, synced as *encrypted deltas*
  over the single-use **private tunnel**. Zero-knowledge is legible in code (the
  only cross-boundary struct is a ciphertext pointer — no plaintext field).

## Reproduce / re-run

Read-only probes and the deploy/verify/teardown scripts live under the session
scratchpad; each authenticates as the operator SA and targets **`hushh-pda-dev`
only**. The teardown is idempotent (already-gone = success). Any future run must
keep the same guardrails: dev project only, throwaway name, IAM-locked, deleted
immediately after evidence is captured.

## Slim pod (2026-07-22) — agent + storage only, built + verified live

The full-image run above proved the *lifecycle*; this run proved the **surface
split**. A slim image (`Dockerfile.pod` → `pod_server:app`) was built via Cloud
Build (`gcr.io/hushh-pda-dev/one-pod:slim-*`) and deployed as a throwaway pod, then
deleted (service + image + build bucket → zero residue).

Verified live:
- **Agents orchestrate:** `/health` → `one/kai/nav/kyc`; `/api/one/a2a/card` → Agent One.
- **Pod identity:** `/pod/info` → `role: sovereign-pod, podMode: true, controlPlane:`
  `central@hushh`; `/health/ready` → `database ok, firebase ok`.
- **Slim surface, live:** the consent control plane + unrelated routes **404 on the
  pod** — `/api/consent/*`, `/api/developer/*`, `/api/account/*`, `/api/one/webauthn/*`,
  `/api/one/personal-agent/*`. They exist only on the central hub.
- **Access locked:** anonymous → `403`.

**Two real latent bugs the live test surfaced** (invisible to unit tests, whose venv
already has everything) — the value of testing beyond the happy path:
1. `webauthn` (py_webauthn) was imported by the M14 code but **missing from
   `requirements.txt`** → a fresh build (full *or* slim) crash-loops on startup. The
   running dev image predates M14, which hid it. **Fixed:** pinned `webauthn==3.0.0`.
2. A newer **gunicorn's control server** could not write `/app/.gunicorn` under the
   non-root uid. **Fixed** in `Dockerfile.pod` (writable dir). *(The main `Dockerfile`
   has the same latent issue on a fresh build — tracked, not yet changed.)*

**Follow-up (honest):** the slim pod fixes the runtime **surface** (only the agent
routes are mounted) but still *imports* the full `one` package at startup, because
`api/routes/one/__init__.py` eagerly imports every sub-router. Physically slimming
the dependency/import graph (lazy package init) is the tracked next optimization.

## Minimum instance count — the warm floor (min=0 vs min=1), measured

A per-user agent should feel real-time, so **the config default is `minScale=1`**
(`GcpBackend`, configurable via `HUSSH_POD_MIN_INSTANCES` / `max`). Measured live on
the slim pod:

| | `minScale = 0` | `minScale = 1` (default) |
|---|---|---|
| Idle cost | ~$0 — scales to zero | one instance billed ~24/7 (order ~$40–70/mo per pod, CPU+mem-tier dependent) |
| First request after idle | **~11 s cold start** (measured 11.2 s) | **no cold start** — an instance is already warm |
| Steady-state latency | ~0.6 s once warm | ~0.6 s (measured 0.56–0.78 s, req 2–6) |
| First message UX | feels broken (11 s wait) | real-time |
| Scales to 1B pods? | yes (pay-per-use) | no — per-pod always-on ≈ $billions/mo |

**Cold-start impact at `min=0`:** a request that arrives after the pod has idled to
zero pays the full container start — boot gunicorn, import the ADK agent tree +
orchestrator, open the DB pool — **~11 s** here before the first byte. For an
interactive agent that is a broken-feeling first turn. (Even at `min=1`, a brand-new
*revision*'s first hit can cold-start — measured 11.5 s — but Cloud Run's rolling
deploy keeps the old revision serving, so users don't see it.)

**Decision:** default `min=1` for the **real-time / dedicated / active-user tier**
(no cold start). The **1B mass tier** cannot keep every pod warm, so there `min=0`
+ fast wake is the economic lever — softened by `startup-cpu-boost` (on), a slimmer
image, durable sessions (M2) for quick rehydrate, and/or a **shared warm pool** so an
idle user's next turn lands on an already-hot instance. This is a **per-tier knob**,
now configurable rather than hard-coded.
