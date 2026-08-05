# The control-plane split — the hub is the only door to a pod, and it keeps nothing

> **Status:** the private relay is **built and mounted hub-only**, behind
> `PERSONAL_AGENT_ENABLED` (default off). The reset path is **live** — it runs on the
> real account cascade today. Companions:
> [`POD-HUB-DATA-PATH.md`](./POD-HUB-DATA-PATH.md) (the reverse direction: pod → hub),
> [`POD-FLEET-LIVE-2026-08-04.md`](./POD-FLEET-LIVE-2026-08-04.md),
> [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Visual Context

Canonical visual owner: [personal-agent Visual Map](./README.md).

## What the split means

🤫 hussh operates the **control plane**: it registers pods, brokers export scopes, and runs
discovery, identity, consent, and orchestration. It does **not** own or persist the
user's private intelligence. Everything that belongs to the user lives in their pod.

Two properties have to hold at once, and they pull against each other:

- a pod is `internal` ingress with **no `allUsers` binding**, so nothing on the internet
  can reach it — that is the containment property worth keeping;
- the owner still has to reach their own pod.

The relay is the reconciliation: **one authorized bridge, and no second door.**

```
   owner (Firebase session)          hub (control plane)                pod (internal)
   ────────────────────────          ───────────────────                ──────────────
   GET /api/one/u/{id}/info  ──▶  authorize_owner_read  ──ID token──▶  GET /pod/info
                                   (receipt either way)
                                          │
                                   consent_audit  ◀── metadata only: who, scope,
                                                      when, which pod. Never content.
```

## The three guards, in order, each fail-closed

1. **Authenticated owner.** `require_firebase_auth` yields the caller's user id. There is
   no anonymous path.
2. **Ownership, audited.** `PodAccessAuditService.authorize_owner_read` proves the caller
   owns *this* HusshID and writes a `POD_ACCESS_ALLOWED` / `POD_ACCESS_DENIED` receipt
   either way. A valid session for user A can never reach user B's pod, and every attempt
   lands on the ledger. This guard was built and tested with **zero callers**; the relay
   is its first caller.
3. **Hub-minted identity.** The hub calls the pod as itself — the pod's service account
   grants `run.invoker` to the hub runtime — so no shared secret crosses the boundary and
   neither side holds the other's key.

**The address is never caller-supplied.** It is read from the `backend_metadata` row the
*hub itself* wrote at service creation, and only if it is `https://`. Until this route
existed that column was written and never read. There is nothing for a caller to point
the proxy at.

Failure shapes are deliberately uniform: every denial — wrong owner, no row, not
provisioned — returns the same `403`, so the relay is **not an existence oracle** for
HusshIDs. A pod with no address yet is `409`; a pod that is down is `503`; the whole
surface is `404` while the flag is off.

## The audit ledger is metadata-only

The founder's decision: the control plane **records that access happened, never what**.
`PodAccessAuditService._receipt` writes the actor, the agent id, the scope, the HusshID,
and the outcome into `consent_audit` — the same ledger Nav narrates and the owner can
inspect and revoke against. No content, no summaries, no record bodies. That is what lets
the ledger survive on the control plane while the intelligence does not.

## Migration: reset, not move

The developer-phase decision (founder, 2026-08-05) is that **every user is a developer on
the platform, so a PKM reset is acceptable** to unblock the roadmap; the standardized PKM
upgrade strategy comes later. Combined with the earlier decision that **agent chat history
is forfeited, not migrated**, the migration collapses into something far simpler and
far more attestable than a custody hand-off:

- a newly provisioned pod **starts clean**, on its own object-store commit log (see
  [`ARCHITECTURE.md`](./ARCHITECTURE.md) and the S4 pod-storage work);
- the hub-side copy is **cleared by the existing account cascade**, not re-encrypted and
  re-handed. There is no decrypt-and-rehand custody event anywhere in the flow, because
  nothing is moved.

Object storage — not a database — is the portable substrate for the pod. Cloud SQL is not
ours to scale: on the sovereign tier the database question is the *user's own* GCP, and
the 🤫 hussh GCP project is **dev-environment simulation only**, which stays in the low hundreds of
instances. The per-user-database quota ceiling is therefore not a constraint we carry.

### What "no trace" covers, and how it is held

`AccountService._clear_user_data_tables` is the shared reset path; `_delete_full_account`
is the deletion path. Both must clear every hub-side surface that holds private
intelligence:

| Surface | Why it counts |
|---|---|
| `pkm_index` | `domain_summaries` — natural-language prose about the owner, in plaintext |
| `pkm_manifest_paths` | `json_path` — the semantic shape of a life |
| `pkm_blobs` / `pkm_manifests` | the record bodies |
| `pkm_events` | the mutation trail |
| `pwm_documents` | the preference world model (migration 118) |
| `kai_receipt_memory_artifacts` | receipt-derived memory |
| `agent_chat_messages` / `agent_chat_conversations` | forfeited by decision, not moved |

`pwm_documents` was **missing from both paths** and is now added. It is private
intelligence about the owner keyed by `user_id`, so leaving it behind would have made
"no trace" false in exactly the place the claim matters most.

`tests/test_pod_no_trace_reset.py` holds the guarantee against the *real* cascade — it
drives `_clear_user_data_tables` with a recording connection rather than reading the table
list by eye, so a surface dropped from the cascade fails the suite instead of quietly
surviving in production. It also asserts the inverse: a reset **keeps** the identity spine
(`vault_keys`, `vault_key_wrappers`, `actor_profiles`, `actor_identity_cache`,
`actor_verified_email_aliases`), because a reset is not a deletion and the owner must
survive it to re-bind their pod.

### One trap worth recording

`_delete_user_rows_if_table_exists` **raises** `ValueError` for any table not registered in
`_delete_by_user_queries`. Adding a table to a cleanup list without registering its
statement turns account deletion into a hard failure the first time it runs somewhere the
table actually exists — silent in any environment where the table is absent. Both halves
are required, together.

## What this does not yet do

Stated plainly, so the doc is not read as more than it is:

- The relay proxies **`/pod/info`** — an info-level surface. It is the door and the audit
  path proven end to end; richer pod surfaces ride the same three guards when added.
- **DNS for `a2a.hushh.ai/u/{hushh_id}`** is not cut. The relay resolves through the hub's
  own origin against the recorded Cloud Run URL.
- **Revocation freshness** in a partitioned pod remains the open distributed-systems
  problem named in the consent work — near-term the pod verifies signatures locally and
  checks revocation over the keyless `PodHubClient`.
