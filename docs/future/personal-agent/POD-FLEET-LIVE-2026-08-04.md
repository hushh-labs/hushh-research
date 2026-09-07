# Pod fleet live in dev — the image, the identity, and two defects the run exposed

> **Status:** ✅ **Executed live** on **2026-08-04** in **`hushh-pda-dev` only**.
> The slim pod image was built for the first time, a zero-role pod identity was
> created, and **two per-user pods were provisioned through the real
> `GcpBackend.provision()` path** and left running for inspection. **Nothing**
> touched UAT, production, `main`, or `hussh-developer-platform`. Auto-provisioning
> on sign-in remains **OFF**. Companions: [`M4-LIVE-VALIDATION.md`](./M4-LIVE-VALIDATION.md)
> (the 2026-07-21 single-pod run this builds on), [`BYOC-USER-GCP.md`](./BYOC-USER-GCP.md)
> (the user's-own-GCP tier this rehearses), [`ARCHITECTURE.md`](./ARCHITECTURE.md) §7.

## Visual Context

Canonical visual owner: [personal-agent Visual Map](./README.md).

## Why this run mattered

Before it, three things had never been true at once: the pod image had **never been
built** (no local docker daemon, so `Dockerfile.pod` was unproven), the pod had **no
identity to run as**, and `HUSSH_ONE_POD_IMAGE` resolved to empty in every
environment — so a real `provision()` had nothing to deploy. The contract tests
passed the whole time, because they read the YAML rather than running it.

The run was done by importing the **shipping `GcpBackend`** and calling `provision()`
exactly as the phone-verify hook does. Only the caller differed. That is what made
the defects below findable: they live in the gap between a config that looks right
and a container that actually serves.

## What is live in `hushh-pda-dev`

| Resource | Value | Note |
|---|---|---|
| Pod image | `gcr.io/hushh-pda-dev/consent-protocol-pod:podtest` | first successful build of `Dockerfile.pod` |
| Pod identity | `hussh-one-pod@hushh-pda-dev` | **zero project roles**, by design |
| Pods | `one-pod-devsim01`, `one-pod-devsim02` | `minScale=0`, `hussh-purpose=dev-validation` |
| Pod-scoped secrets | `HUSSH_POD_DEV_SIGNING_KEY`, `HUSSH_POD_DEV_VAULT_KEY` | readable **only** by the pod SA |
| Fleet tool | `consent-protocol/scripts/ops/pod_fleet.py` | read-only inventory |

Verified live on both pods: `/pod/info` returns `role: sovereign-pod`, `podMode:
true`, and the correct per-user `hushhId`/`billingSpaceId`; `/health` reports agents
`one, kai, nav, kyc` on ADK 2.4.0; **anonymous requests get 403**; and the
central-plane routes (`/api/one/consent/issue`, `/api/iam/agents`,
`/api/one/account/delete`) return **404** — the slim-pod split is real, not merely
asserted. `/.well-known/agent-card.json` returns 404, which is the documented
flag-off contract (`A2A_AGENT_CARD_ENABLED` defaults false), not a fault.

## Defect 1 — a dead pod reported itself healthy, end to end

The first pod deployed with every Cloud Run condition green: `Ready=True`,
`ContainerReady=True`, and `ContainerHealthy=True` with the message *"Containers
became healthy in 1.2s."* It returned **503 to every single request**.

Cloud Run's default startup probe is a **TCP connect**. Gunicorn's master binds
`:8080` and *then* forks workers; the workers died on import, but the socket was
already open, so the probe passed. Because `wait_ready()`, `GcpBackend.get()` and the
reconcile worker all read that same `Ready` condition, `provision()` returned
`status="live"` and the registry would have recorded a healthy pod that could not
answer. A 200 on an empty page, at fleet scale.

**Fix:** `render_deploy_config` now sets an explicit HTTP startup probe on `/health`
(with a matching declared `containerPort`). That repairs the signal **at its source**,
so provisioning, status and reconciliation all become honest without bolting a second
health check onto each of the three readers. Re-running the identical broken pod after
the fix returned `status="deploying"`, `ready=False`, and the real reason — the
before/after is the proof.

`consent-protocol/scripts/ops/pod_fleet.py` reports `probe=http|tcp` per pod for this reason:
a pod created before this change can still be Ready-but-dead.

## Defect 2 — the pod could not boot, and the obvious fix is dangerous

The workers were crashing on `get_core_security_settings()`, which eagerly validates
the **full app's** keyset at import: `APP_SIGNING_KEY` (≥32 chars) and
`VAULT_DATA_KEY` (64-hex AES key). `render_deploy_config` injects identity and version
pins only — deliberately no secrets — so no pod could ever have started.

The obvious fix is to mount the hub's existing secrets. **Do not.** `APP_SIGNING_KEY`
is the symmetric HMAC-SHA256 key behind consent tokens, fabric grants, receipts and
the audit chain, and `VAULT_DATA_KEY` decrypts holdings. **With HMAC, the ability to
verify is the ability to forge.** Giving every per-user pod the hub's key would make
one compromised pod a universal forger of consent, grants and audit entries for
*every* user — precisely the position the PCC threat model exists to prevent.

**What was done instead:** two **pod-scoped** secrets, mounted **by reference**
(`valueFrom.secretKeyRef`, never rendered into the artifact), readable only by the
zero-role pod SA, named by `HUSSH_POD_SIGNING_KEY_SECRET` /
`HUSSH_POD_VAULT_KEY_SECRET` and **unset by default** (no mount, behaviour unchanged
wherever they are not configured).

This boots the runtime and proves the surface. It does **not** let a pod validate
hub-issued consent tokens — that needs **asymmetric signing** (the pod holds a public
key only) or hub-side validation, and is now the blocking design decision for any
real consent traffic through a pod.

**Underlying smell:** the pod mounts four routers and performs no vault crypto, yet
cannot *import* without the vault data key. Scoping key validation to what a surface
actually uses would let a pod hold strictly less.

## PCC properties — what actually holds today

| Property | Status | Evidence |
|---|---|---|
| Per-user isolated instance | ✅ holds | two pods, distinct `HUSSH_ID`/`billingSpaceId`, separate services |
| Least-privilege identity | ✅ holds | pod SA has **no** project roles; verified by re-reading the policy |
| Not publicly reachable | ✅ holds | anonymous 403; no `allUsers`/`allAuthenticatedUsers` binding |
| Reduced runtime surface | ✅ holds | central-plane routes 404 on a live pod |
| No secret material in the artifact | ✅ holds | keys mounted by reference only |
| Attested / non-inspectable by hussh | ❌ **not yet** | Confidential Space is the dedicated tier (M5); these are `logical` |
| Consent enforced at the pod door | ❌ **not yet** | blocked on asymmetric signing, above |
| Pod-local storage | ❌ **not yet** | no Cloud SQL attachment; see below |

Ingress was widened to `all` **for these dev pods only** so a real pod could be
observed over HTTP from outside the VPC. The default in code remains `internal`, and
`all` widens *where* a caller may connect from, never *who* may invoke — Cloud Run
still requires a signed Google identity token, which is why anonymous is 403.

## How this maps to the user's own GCP (BYOC)

Same image, same `ComputeBackend` contract, same rendered service body — per
[`BYOC-USER-GCP.md`](./BYOC-USER-GCP.md), only the **target project** and the
**credential model** change. This run rehearsed the parts that are identical in both:
the image, the zero-role runtime identity, the secret-by-reference mount, the honest
startup probe, and the access boundary.

What is *not* rehearsed, and is the real BYOC work: hussh holds an operator key into
`hushh-pda-dev`, whereas BYOC is **keyless by construction** via Workload Identity
Federation, with a one-time least-privilege bootstrap in the user's project. The
pod-scoped secrets created here would, in BYOC, live in the **user's** Secret Manager
under the user's control — which is the point of the tier.

## Still not true

- **Auto-provisioning is OFF.** `PERSONAL_AGENT_ENABLED` and
  `PERSONAL_AGENT_BACKEND` appear in no deploy config, so they are unset. These pods
  were provisioned by an explicit operator call, not by a user signing in.
- **A pod cannot reach Postgres.** `render_deploy_config` attaches no Cloud SQL
  instance and mounts no DB credentials, so `agent_prompt` and any consent lookup
  will fail. The cheap fix — grant the pod SQL access — would destroy the zero-role
  property this run just established; the right shape is the pod reading through the
  consent-gated hub. **Open decision.**
- **The image tag is `podtest`,** built ad hoc from this branch. The committed
  Cloud Build step (`build-pod-image`, dev-gated) produces the real per-SHA tag on
  the next dev deploy.
- **These pods cost money** while they exist (`minScale=0`, so idle cost is
  storage/registry only). Delete with `GcpBackend.deprovision()` or the console when
  the inspection is done.

## Reproduce

```bash
# inventory the fleet (read-only)
python consent-protocol/scripts/ops/pod_fleet.py --project hushh-pda-dev
```

Provisioning drivers used for this run are session scratch, not committed: they set
`HUSSH_GCP_BACKEND_LIVE=1`, point `HUSSH_ONE_POD_IMAGE` at the tag above, set both
`HUSSH_POD_*_SECRET` names, and call `GcpBackend().provision(PodSpec(...))` directly.
