# The pod's data path — pod → hub → Postgres, and never pod → Postgres

> **Status:** seam built and wired; hub-side pod-identity auth is **flag-gated OFF**
> (`POD_HUB_IDENTITY_AUTH_ENABLED`, default false) and must stay off wherever pods hold
> real users' holdings, for the identity reason in *The limit* below. Companions:
> [`POD-FLEET-LIVE-2026-08-04.md`](./POD-FLEET-LIVE-2026-08-04.md) (the live fleet this
> extends), [`BYOC-USER-GCP.md`](./BYOC-USER-GCP.md), [`ARCHITECTURE.md`](./ARCHITECTURE.md) §7.

## Visual Context

Canonical visual owner: [personal-agent Visual Map](./README.md).

## The problem this solves

The per-user pod runs as `hussh-one-pod`, a service account holding **no project roles**.
That is the security win of the fleet: a compromised pod cannot reach anything. But the
pod mounts `/api/one/agent-prompt`, whose repo went straight to `get_db()` — so the route
could only ever have failed, and the obvious fix (grant the pod SQL access) would have
handed every pod a database credential and thrown the zero-role property away.

The shape that keeps both: **the pod asks the hub, and the hub asks Postgres.** One
egress path, one place to audit, no database credential anywhere near a pod.

```
   pod (zero roles)                    hub (consent authority)         Postgres
   ────────────────                    ───────────────────────         ────────
   HubPromptRepo  ──ID token──▶  /api/one/agent-prompt  ──▶  agent_prompt_versions
        ▲                                   │
        └────── prompt + hub's signature ───┘
```

## How a pod authenticates — keyless

`PodHubClient` mints a **Google ID token** from the instance metadata server against the
pod's own runtime service account. No bearer secret is stored in the pod, nothing to
rotate, nothing to leak from the deploy artifact. The token is **audience-bound to the
hub**, so it cannot be replayed against another service.

This is the same mechanism [`BYOC-USER-GCP.md`](./BYOC-USER-GCP.md) wants for a
user-hosted pod, so the client works unchanged when the pod runs in the user's own
project.

## The limit — what an ID token proves, and what it does not

**Every pod runs as the same service account.** That is precisely what lets that account
hold no roles. The consequence is unavoidable: an ID token proves *"a hussh pod is
calling"*, never *which user's pod*. The pod therefore asserts its own `HUSSH_ID` in a
header, and that assertion is trustworthy exactly as far as the pod is.

That matches the **`logical`** tier's stated trust level and **does not meet the bar for
real users** — with it on, one compromised pod could read another user's prompt. Hence
the flag defaults OFF. Per-pod cryptographic identity is what the attested
**`dedicated`** tier (Confidential Space, M5) provides.

Options when this needs to carry real users, cheapest first:

1. **Per-pod service account** — real per-caller identity, but IAM caps service accounts
   per project well below fleet scale, so this fits the prosumer/enterprise tier only.
2. **Attestation (M5)** — Confidential Space binds the workload cryptographically; the
   right answer for the regulated tier, and already the roadmap.
3. **Per-pod secret** — does *not* work under a shared SA: any pod could read any other
   pod's secret from Secret Manager, so it buys nothing until (1) or (2) exists.

## Integrity — what the pod can and cannot check

The pod **cannot verify the hub's HMAC**: it holds a different `APP_SIGNING_KEY`, and
with HMAC the ability to verify would be the ability to forge (see
[`POD-FLEET-LIVE-2026-08-04.md`](./POD-FLEET-LIVE-2026-08-04.md)). So the pod does the
check it genuinely can:

- it **recomputes SHA-256** over the received prompt bytes and constant-time-compares it
  with the hash the hub signed over — a body altered in transit is refused, not adopted;
- it **relays the hub's signature untouched**. Re-signing locally would silently replace
  the authority's attestation with a self-attestation that no holder of the hub's key
  could verify. `PersonalAgentPromptService` now passes through a signature that arrives
  on the row and signs only rows that arrive unsigned (i.e. straight from the DB).

End-to-end HMAC verification inside a pod stays blocked on **asymmetric signing** (pod
holds a public key only). That is the same blocker as pod-side consent-token validation.

## Failure semantics

`HubPromptRepo` distinguishes two answers that must never collapse:

| Hub says | Pod concludes |
|---|---|
| `404` | no active prompt configured → `None` |
| any other non-200, or unreachable | `PodHubUnavailable` raised |

Collapsing an outage into "no prompt" would make a hub failure read as a deliberately
empty configuration — the same class of lie as a `200` on an empty page.

## What still does not go through this path

**Consent-token validation.** `api/routes/one/a2a.py` calls `validate_token_with_db`,
which (a) validates an HMAC with `APP_SIGNING_KEY` — which a pod cannot do with its own
distinct key — and (b) checks revocation in Postgres. It **fails closed** for scoped
tokens when the DB is unreachable, so a pod today refuses A2A traffic rather than
admitting it insecurely. Routing revocation through the hub is the same seam as above,
but the HMAC half needs asymmetric signing first, so the A2A path is *correctly
inoperative* in a pod rather than half-wired.

(Note: `validate_token_with_db`'s docstring still says it "falls back to in-memory check
if DB is unavailable". The implementation fails closed except for a VAULT_OWNER grace
period — the docstring is stale, the code is right.)

## Verified live in `hushh-pda-dev`, 2026-08-04 — and what is still unproven

A pod on the branch image was pointed at the dev hub and asked for its prompt. The pod's
own traceback is the evidence, because it names every hop:

```
api/routes/one/agent_prompt.py   get_agent_prompt
  personal_agent_prompt_service  get_active_prompt
    personal_agent_prompt_repo   HubPromptRepo.get_active
      PodHubUnavailable: hub returned HTTP 401 for the prompt read
```

**Proven:** `resolve_prompt_repo()` selected `HubPromptRepo` (not the DB repo) inside a
pod; the pod minted a metadata-server ID token and reached the hub over the network; the
outage raised rather than being reported as "no prompt"; and **no database call appears
anywhere in the path.** The 401 is correct — the *deployed* dev hub runs an older SHA
with no pod-identity auth.

**Found by running it:** that outage surfaced as a raw **500** with a traceback.
`pod_server.py` now maps `PodHubUnavailable` to a clean **503**, matching the DB handlers
beside it — a transient refusal must not read as a permanent answer, and internals must
not leak to the caller.

### Proven end to end, 2026-08-04, after the branch reached dev

The dev lane deployed this branch (`efaccd616`) once the Cloud Build arg-limit fix landed,
which put the pod-identity code and its flag on the running hub. The round trip then
completed:

```
GET  pod /api/one/agent-prompt
  -> 404 {"code": "PROMPT_NOT_FOUND", "message": "No active prompt for this agent..."}
```

That 404 is the proof, not a non-answer. It can only be produced **after** a successful
hub query: the pod resolved to `HubPromptRepo`, minted a metadata-server ID token, the hub
**accepted** that identity, queried `agent_prompt_versions` in Postgres, found no row for
this synthetic agent, and `HubPromptRepo` mapped 404 to "no prompt configured". The
progression across the session is the evidence — **401** (hub rejected the pod, running
older code) → **503** (`PodHubUnavailable`) → **404 `PROMPT_NOT_FOUND`**. The hub's
`/health/ready` independently reports `database: ok`.

So **pod → hub → Postgres works, with no database credential anywhere in the pod.**

**Still not proven:** a **200 carrying a real prompt**, because no `agent_prompt_versions`
row exists for a synthetic agent. That is a seeding gap, not a path gap — every hop is now
demonstrated. Seed a row for a test agent to close it.

**Noticed while debugging, now fixed:** the hub had the same false-health defect as the
pod — its start-up log showed `Default STARTUP TCP probe succeeded`, because the
HTTP-probe fix had only been applied to `render_deploy_config` (which renders **pods**),
while the hub deploys via `gcloud run deploy`. It now carries an explicit
`httpGet /health` startup probe on every lane, confirmed on the deployed dev revision:

```
startupProbe: {httpGet: {path: /health, port: 8080}, periodSeconds: 10, failureThreshold: 24}
```

**What made all of this reachable:** the dev deploy lane had been unable to deploy since
2026-07-28 — `deploy/backend.cloudbuild.yaml`'s `deploy-backend` step exceeded Cloud
Build's 10,000-character per-arg cap, which gcloud enforces client-side, so no build was
ever created. The step body now lives in `scripts/deploy/backend-deploy.sh` and a
regression test asserts the limit. That fix is what let this branch reach dev at all.

The blast radius was **not** uniform across lanes, and an earlier draft of this note
overstated it. Cloud Build applies substitutions *before* enforcing the cap, so each lane
submits a different length from the same file: at `ba39d0342` the body measured 10,282
for UAT and 10,208 for dev (both over) but **8,937 for production** (under). Production
kept deploying throughout; UAT and dev could not. Measuring the raw YAML — which is only
an upper bound — is what produced the wrong conclusion. `test_cloudbuild_step_arg_limit.py`
now asserts the substituted length per lane for exactly this reason.

## Configuration

| Variable | Where | Meaning |
|---|---|---|
| `HUSSH_HUB_BASE_URL` | pod | the pod's one data-plane door; empty → `PodHubUnavailable` |
| `POD_HUB_IDENTITY_AUTH_ENABLED` | hub | accept pod ID tokens on the prompt route (**default off**) |
| `POD_HUB_ALLOWED_SERVICE_ACCOUNT` | hub | the single SA whose ID tokens are accepted |

`GcpBackend.render_deploy_config` injects `HUSSH_HUB_BASE_URL` into every pod it renders.
With the hub flag off, the route's behaviour is byte-identical to before: an
unauthenticated caller gets 401, and a `cap.agent.prompt.sync` consent token is the only
way in.
