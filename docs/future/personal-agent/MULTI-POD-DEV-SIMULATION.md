# The multi-pod dev simulation — every test case and edge case

> **Status:** harness built (`consent-protocol/scripts/sim_multi_pod.py`) and **run at 10
> and 20 pods**. Ten of eleven probes pass across the fleet; one fails and it is a **real
> defect**, reproduced independently by a security audit and by the simulation. This
> document is the catalogue: what must hold, what breaks it, and what is currently
> unenforced. Companions: [`ARCHITECTURE.md`](./ARCHITECTURE.md),
> [`CONTROL-PLANE-SPLIT.md`](./CONTROL-PLANE-SPLIT.md),
> [`BYOC-USER-GCP.md`](./BYOC-USER-GCP.md).

## Visual Context

Canonical visual owner: [personal-agent Visual Map](./README.md).

## What this simulates, and what it deliberately does not

The dev GCP project stands in for what will later be **the user's own GCP**. It is the
one place a fleet of pods can be run end to end before anyone brings their own cloud, so
the simulation's job is to answer two questions honestly: *does the fleet hold up*, and
*does one pod stay sealed from another*.

**Three tiers, because the architecture has three.** Two facts force this and a
simulation ignoring either would prove nothing:

1. **A pod cannot answer a cross-user query by construction.** `PkmWriteEngine`
   deliberately excludes `match_user_profiles` — a single-user engine cannot answer it.
   Cross-user discovery is control-plane work.
2. **Sharing is a hub-mediated, client-encrypted export — never a pod-to-pod read.**
   Nothing in the codebase lets pod A read pod B's store, and `PodPkmStore` has no
   cross-user surface at all.

| Tier | What it is | Real or simulated |
|---|---|---|
| **A — pod data plane** | per-pod `PodPkmStore`: real `SqlitePkmWriteEngine` + real sealed, hash-chained `PodCommitLog` over a real object store | **real** |
| **B — pod runtime** | one **OS process per pod** running the real `pod_server` app, own port, own identity | **real** |
| **C — control plane** | pod registry, scope catalogue, share ledger, metadata-only audit | in-process, **metadata-only by construction** |

### The correction that shaped the design

The brief said pods would "share scopes of information between each other." **That path
does not exist in the code.** `PersonalAgentRegistryRepo.get_by_hushh_id` — the reverse
lookup such a path would need — has **zero callers**; `a2a_route` is written into the
registry and echoed back, and nothing dials it. The only implemented cross-actor reads
are hub-mediated and none are pod-to-pod: a fabric grant read (subscriber → PWM fields), a
scoped export (developer app → wrapped envelope), and the pod relay (**owner only** → pod
metadata, not holdings).

So the simulation asserts the **absence** rather than hand-rolling the path. Hand-rolling
it in the harness would bypass every guard below, and a green run would mean nothing. This
is the single most important design decision in the harness.

## Harness rules — violate any one and every number below is noise

These are not style preferences. Each one, if broken, makes isolation tests pass for the
wrong reason:

| Rule | Why | Held? |
|---|---|---|
| **One OS process per pod** | `pod_self_registration._STATE` is a module-level global with no reset hook and `get_core_security_settings` is `@lru_cache(maxsize=1)`. Twenty in-process "pods" share one keypair, one signing key, one HusshID. | ✅ `subprocess` per pod |
| **Pod-unique `APP_SIGNING_KEY`** | With HMAC, verify **is** forge. One shared key makes any pod a universal forger of consent, grants, receipts and audit signatures for every user. | ✅ per-index digest |
| **Pod-unique commit-log seal key** | A shared key means any pod that can read another's bytes can decrypt them. | ✅ per-index digest |
| **Pod-unique `PKM_SQLITE_PATH`** | `get_domain_snapshot` also takes the **write** lock; two pods on one file serialise every read into `SQLITE_BUSY` storms. | ✅ per-pod dir |
| **Pod-unique `HUSSH_POD_MEMORY_KEY`** | `_digest` is a keyed HMAC **per word** — a shared key makes identical words produce identical digests across pods, a cross-pod content-correlation channel over nominally encrypted indexes. | ✅ per-index digest |
| **Pod-unique storage prefix** | A shared bucket + empty prefix collapses the fleet into one log. | ✅ per-pod dir |
| **`POD_HUB_IDENTITY_AUTH_ENABLED` off** | On, a pod can assert another pod's identity via `X-Hushh-Pod-Id` and read that owner's prompt. | ✅ explicitly `0` |

## Measured capacity (the question the dev project exists to answer)

| Pods | Fleet RSS | Per pod | Host | Result |
|---|---|---|---|---|
| 1 | 216 MB | 216 MB | 16 GB / 4 vCPU | boots in ~25 s |
| 10 | 2,115 MB | 211 MB | 16 GB / 4 vCPU | 10/10 ready, 8 cycles, 160 revisions, zero deaths |
| 20 | 4,231 MB | 212 MB | 16 GB / 4 vCPU | 20/20 ready, stable under continuous mutation |

Per-pod footprint is **flat at ~212 MB** from 1 to 20 — the fleet scales linearly with no
per-pod overhead growth. On this host the memory ceiling is ~70 pods; CPU (4 cores) binds
first under continuous mutation. **This is the number that matters for the BYO-GCP tier:**
a user's own project hosts *one* pod, so 212 MB is the whole ask.

## The probe suite — what runs every cycle, against every pod

| # | Probe | Invariant | 20-pod result |
|---|---|---|---|
| 1 | `write_and_read_back` | A real commit lands and reads back at the exact revision written | ✅ 80/80 |
| 2 | `no_foreign_user` | A pod holds ONE user; another user's id returns nothing | ✅ 80/80 |
| 3 | `chain_integrity` | The sealed log replays; a broken hash chain raises `PodLogTampered` | ✅ 80/80 |
| 4 | `stale_revision_conflicts` | `expected_content_revision` mismatch conflicts **and writes nothing** | ✅ 80/80 |
| 5 | `commit_binding` | Same commit id + different fingerprint is refused | ✅ 80/80 |
| 6 | `seal_key_isolation` | Pod i's log is undecryptable with pod j's key | ✅ 80/80 |
| 7 | `rebuild_owner_filter` | A rebuild materialises only this pod's owner | ✅ 80/80 (see caveat) |
| 8 | `commit_binding_cross_user` | Same commit id under a **different user** is refused | ❌ **0/80 — real defect** |
| 9 | `log_anti_rollback` | History cannot be silently truncated | ⚠️ passes, **inconclusive** |
| 10 | `pod_identity` | Each live pod reports **its own** HusshID over HTTP | ✅ 80/80 |
| 11 | `share_metadata_only` | No share record or receipt carries content | ✅ every cycle |

### Two results that must not be over-read

- **#7 passes because of the harness, not because of a guard.** `PodPkmStore.rebuild`
  replays every record and dispatches on `kind` with **no check** that
  `payload["p_user_id"]` is this pod's owner (contrast `CommitLogPodStorage.restore`,
  which *does* filter on `hushh_id`). Pod-unique keys and prefixes are what keep this
  dormant. Under a shared bucket + shared log key, a pod rebuilds another user's **entire
  PKM** into its own index — no error, no receipt, no audit event.
- **#9's pass is not evidence.** A direct probe demonstrated that pointing `head.json` at
  an earlier valid record **silently truncates history**, after which the next append
  forks. The harness probe likely passes for an unrelated reason (a hand-edited head
  raising on structure rather than on an anti-rollback guard). Treat #9 as **not yet
  proven** and refine the probe before trusting it.

## Verified defects — found by executable probes, not by reading

Four were found by a trust-boundary audit; the simulation independently reproduced the
first. Listed worst first.

### D1 — Cross-user commit-id replay reports success `⛔ CONFIRMED TWICE`

`pkm_sqlite_engine.py` checks a replayed `commit_id` against **`request_fingerprint`
only**. The Postgres oracle additionally checks `user_id`, `domain`, `commit_kind`,
`expected_content_revision`, and the upgrade run/claim ids. The conformance oracle only
ever tests same-user/different-fingerprint — **so the SQLite engine passes the oracle
while being strictly weaker.** `request_fingerprint` is optional, and `None != None` is
False, so the binding check passes trivially whenever no fingerprint is supplied — which
is every direct-engine and rebuild path.

Three failures in one, reproduced at 20/20 pods:

- **fabricated success** — user B's write returns `success: True` and writes nothing;
- **cross-binding metadata leak** — user B receives user A's `data_version`;
- **OCC bypass** — `expected_content_revision=99` against an actual `1` returns success
  instead of `conflict: True`.

This is the most dangerous item in the list because it makes the pod engine *look*
proven. Missing oracle scenarios: same `commit_id` with a different `user_id`; a different
`domain`; a different `expected_content_revision`; both fingerprints `None`.

### D2 — Pod-access audit fails **open**, producing a fabricated receipt `⛔`

`pod_access_audit.py` guards with `if hushh_id is not None and row_hushh is not None and
hushh_id != row_hushh`. When `row_hushh` is `None` a caller-supplied **foreign** HusshID
is accepted: the access is allowed **and the ledger records the foreign HusshID as
legitimately read**. Aggravating factors specific to a fleet run:

- migration 900 is **parked** — the `NOT NULL` and `UNIQUE` constraints that make
  `row_hushh` non-null in production are properties of a migration the simulation may not
  have applied;
- `pod_relay.py` resolves the pod URL by `repo.get(user_id)`, **not** by `hushh_id`,
  contradicting its own docstring — so a caller passing a foreign HusshID reaches *their
  own* pod and gets a 200 labelled with the other user's `hushhId`. **A sim assertion
  that checks the response body would be fooled.**
- `tests/test_pod_relay.py` uses a fake auditor, so the relay's integration with the real
  `authorize_owner_read` is unproven.

### D3 — Rebuild has no owner filter `⛔` (see probe #7 above)

### D4 — The commit log has no anti-rollback `⛔`

`PodCommitLog` refuses a broken hash and a missing record, but `replay()` walks backward
from whatever `head.json` says and the contiguity check passes on **any valid prefix**.
Nothing persists a high-water sequence. Any writer with store access can CAS the pointer
to an earlier valid head; history truncates and the next append forks. The module
docstring claims replay "refuses a tampered or **truncated** log" — true for a broken
hash, **false for a rollback**.

Related, same file: the local CAS writes data then the generation sidecar
non-atomically with no tmp+rename. A crash between them leaves content at N+1 and the
generation at N, so the next CAS with `expected=N` succeeds and overwrites; a crash mid
`write_bytes` leaves a truncated `head.json` and raises a raw `JSONDecodeError` rather
than a typed, handled `PodLogTampered`.

### D5 — Full bearer tokens are stored in the ledger `⛔ policy violation`

`personal_agent_grant_service.py` writes the **full HCT** into `consent_audit.token_id`
(`token_id=token_obj.token`), stored raw and truncated only for display. It is
load-bearing — `is_token_active` compares against it — but it means any read of
`consent_audit` for a user yields a **live 24-hour `pkm.read` token** for that user's pod.
Combined with a shared `APP_SIGNING_KEY` this is a complete escalation chain.

## The full invariant catalogue

### 1. Cross-tenant leakage

| ID | Invariant | State |
|---|---|---|
| 1.1 | A pod may **verify** a consent token but never **mint** one | ✅ enforced (Ed25519 verify-only; separate secret, unset by default) |
| 1.2 | No two pods hold the same keypair | ⛔ **not enforced** — `attach_pod_public_key` checks only the user's own row; no `UNIQUE` on `pod_pubkey`/`pod_key_id`. Mount one key into 20 pods and all 20 register the same `pod_key_id` |
| 1.3 | One process serves exactly one pod identity | ⛔ not enforced in-process (module globals + `lru_cache`); the harness forces one process per pod |
| 1.4 | A rebuild materialises only its owner's records | ⛔ **D3** |
| 1.5 | Log key and storage prefix are pod-unique | ⚠️ refuses an unset key, but binds it to nothing |
| 1.6 | The hub reaches a pod only at an address **the hub itself recorded** | ✅ enforced, `https://` only — the pull direction removes the identity question rather than answering it |
| 1.7 | The hub never trusts a pod's self-asserted identity for a data read | ⚠️ flag-dependent; must stay **off** |

**Edge cases to run:** mount a deliberately shared pod key across 20 pods and assert
registrations 2..20 are refused (they will not be); poison `backend_metadata.url` with
`http://`, an SSRF target, and a caller-supplied override — assert 409 on all three;
assert `CONSENT_ED25519_PRIVATE_KEY` is absent from every pod and that a pod calling
`issue_token()` raises.

### 2. Scope sharing, revocation, expiry

| ID | Invariant | State |
|---|---|---|
| 2.1 | The reader receives exactly the granted fields, resolved **server-side** | ✅ fields come from the grant row, not the request |
| 2.2 | Revocation is fail-closed and immediate | ✅ DB unreachable → deny, with a bounded `vault.owner` grace |
| 2.3 | Only one standing token per `(user, pkm.read, personal_agent)` is live | ⚠️ side effect: re-minting silently invalidates every earlier token — looks like a flaky network at fleet scale |
| 2.4 | The in-memory revocation cache is not shared across pods | ⛔ module-level singleton; propagation must be measured **across processes** |
| 2.5 | Expiry is checked before scope | ✅ explicit |
| 2.6 | A failed audit write blocks the read | ⛔ **asymmetry**: the developer export path returns 503 and releases nothing; the pod-access path logs and **allows** |

**The scope-widening trap:** `pkm.read` matches **every** `attr.*` scope, and the pod's
standing grant *is* `pkm.read`. Any future cross-pod path that reuses the pod's standing
token as the reader's authority grants the **whole PKM**, not a scope. Test: grant
`attr.financial.holdings`, then assert `attr.financial.profile`, `attr.food.*` and
`pkm.read` are all refused; assert `attr.financial.*` covers `attr.financial.profile.*`
but not the reverse.

**Ledger tie-break:** `is_token_active` takes the latest event by `issued_at` ms with
**no `id` tiebreaker**. Two events in the same millisecond resolve nondeterministically —
reachable at 20 pods re-minting on a 24 h cadence. Assert the result is deterministic and
errs toward denied.

### 3. The per-pod store

| ID | Invariant | State |
|---|---|---|
| 3.1 | One writer per pod, file-wide | ✅ `BEGIN IMMEDIATE` + WAL — genuinely stronger than the Postgres advisory lock for a single-user store |
| 3.2 | `expected_content_revision` conflicts are never silently resolved | ⛔ **D1** |
| 3.3 | Torn reads are refused | ✅ mixed-revision and manifest/blob cross-checks |
| 3.4 | The engine commits **before** the log records it | ✅ correct ordering — but see below |
| 3.5 | The head pointer is monotonic | ⛔ **D4** |
| 3.6 | Local CAS survives a crash mid-write | ⛔ non-atomic write + sidecar |

**The crash window in 3.4:** a crash between `COMMIT` and `_log.append` leaves the
mutation in SQLite and absent from the log; the next rebuild **loses it**, because the log
is the system of record. The docstring says the idempotency ledger "reconverges" — it does
not, because the record was never written. Test that this mutation's fate is *explicitly
asserted* either way rather than left undefined.

### 4. Audit

| ID | Invariant | State |
|---|---|---|
| 4.1 | Every cross-pod read receipts in the same transaction that releases the data | ⚠️ the good model exists on the developer export path; the pod path must copy it |
| 4.2 | A denial is receipted too | ✅ including the `registry_unavailable` fail-closed path |
| 4.3 | Ledger metadata is metadata, never content | ⚠️ `insert_event` accepts an **arbitrary** metadata dict with no schema and no content filter |
| 4.4 | The ledger is not a bearer-credential store | ⛔ **D5** |
| 4.5 | A receipt never asserts something that did not happen | ⛔ **D2** |

**Test:** a schema assertion over every `metadata` key written during the run — fail on
any unknown key or any value over N bytes. Assert `count(POD_ACCESS_DENIED) == attempts`
across 20 pods × cross-pod attempts.

### 5. Failure modes unique to many pods

| ID | Invariant | State |
|---|---|---|
| 5.1 | A HusshID in a receipt is the HusshID actually read | ⛔ **D2** |
| 5.2 | HusshID collision and recycled-phone rotation | ⚠️ rotation depends entirely on the tombstone table |
| 5.3 | Fleet-wide singletons run exactly once | ✅ pod mode skips the FCM listener, Gmail renewal and the revocation sweep |
| 5.4 | Connection pools and cost caps under concurrent provisioning | ⚠️ `count_active_pods` is read-then-act with no lock |
| 5.5 | Pod memory never crosses a boundary | ⚠️ see below |

- **5.2:** tearing pods down with `registry.delete()` while skipping `tombstone()` (which
  **returns early on an empty `hushh_id`**) lets the next user of that phone re-derive
  generation 0 and **inherit the previous owner's HusshID**. Also: `hushh_id` derives from
  `APP_SIGNING_KEY`, so rotating that key mid-run changes every HusshID and orphans every
  registry row. Assert the key is stable for the run.
- **5.4:** 20 concurrent provisions at cap 19 → all 20 read 18 and all 20 proceed. A cost
  invariant rather than a correctness one, but **reachable rather than theoretical** at
  this scale. Test: provision 20 concurrently at `PERSONAL_AGENT_MAX_PODS=10`; assert
  exactly 10.
- **5.5:** `search_memory` treats an **empty** `user_id` as the owner, so an ADK caller
  that omits it gets the owner's memory; `_seal` is an **unauthenticated XOR keystream**
  whose nonce derives from the plaintext — honest as a placeholder, but the simulation
  must not treat it as confidentiality.

## Running it

```bash
cd consent-protocol
uv run python scripts/sim_multi_pod.py --pods 10 --http          # 10 real pod processes
uv run python scripts/sim_multi_pod.py --pods 20 --http          # scale up
uv run python scripts/sim_multi_pod.py --pods 3 --max-cycles 3   # data plane only, fast
```

Status lands in `<root>/status.json` — rolling pass/fail per probe, revisions written,
pods alive, and the first 20 failure strings. The run holds the fleet up under continuous
mutation until stopped; it is not a suite that passes once and exits.

## What must happen before this run means "ready"

Ordered by severity. The first three make a green run misleading rather than merely
incomplete:

1. **D1** — add the four missing oracle scenarios and make the SQLite engine's binding
   check match the Postgres one (user, domain, kind, expected revision).
2. **D2** — make the audit guard fail **closed** when `row_hushh` is `None`, and fix
   `pod_relay` to resolve by `hushh_id` as its docstring says.
3. **D3** — add the owner filter to `PodPkmStore.rebuild`.
4. **D4** — persist a high-water sequence; make rollback raise `PodLogTampered`; make the
   local CAS atomic (tmp+rename) and its failures typed.
5. **D5** — store a token **fingerprint** in `consent_audit.token_id`, not the token.
6. **1.2 / 1.3** — enforce fleet-wide key uniqueness; keep one process per pod.

Then: apply parked migration 900 (or reproduce its `NOT NULL`/`UNIQUE` constraints) so the
registry has the shape production will have, and re-run at 20.
