# The consent log, end to end — pod → hub → app → native

> **Status:** proven at **50 concurrent pods** with dynamic PKM load and real
> consent issuance. Every consent operation goes through the real protocol
> (`issue_token` / `validate_token` / `revoke_token` / `ConsentScope.check_access`).
> The log is emitted in **both** shapes: the raw `consent_audit` row and the grouped
> shape `/api/consent/center/list` returns. Companions:
> [`MULTI-POD-DEV-SIMULATION.md`](./MULTI-POD-DEV-SIMULATION.md),
> [`CONTROL-PLANE-SPLIT.md`](./CONTROL-PLANE-SPLIT.md).

## Visual Context

Canonical visual owner: [personal-agent Visual Map](./README.md).

## What was run

50 pods, each an OS process running the real `pod_server`, each with its own PKM
(SQLite engine + sealed hash-chained commit log), its own signing key, log seal
key, memory key and storage prefix.

| Measure | Result |
|---|---|
| Pods live | **50 / 50** |
| Fleet memory | **10,569 MB** (~211 MB per pod) |
| Per-pod footprint 1 → 50 | **flat** (216 / 211 / 212 / 211 MB at 1 / 10 / 20 / 50) |
| PKM domains loaded dynamically | **100** (2 per pod, from a 5-domain catalogue) |
| Consent probes | **8 × 50, all passing** |
| Failing probe | 1 — `commit_binding_cross_user` (the known engine defect) |

**Dynamic PKM load** means each pod loads a different slice of the catalogue
(`financial`, `food`, `travel`, `health`, `shopping`), each domain on its **own**
content-revision stream. That last detail is load-bearing: domains are independent
optimistic-concurrency streams, and a single shared counter passes a one-domain
test while corrupting a multi-domain pod. It surfaced immediately as a revision
conflict the first time the probe domain collided with a catalogue domain.

## The consent interactions, through the real protocol

Per pod, per cycle, between the pod's owner and the next owner in the ring:

| Step | Assertion | 50-pod result |
|---|---|---|
| **Grant** | a real signed token bound to `(owner, counterparty, scope)` | ✅ |
| **Use in scope** | validates, and the token's `user_id` is the owner | ✅ 50/50 |
| **Use out of scope** | a `financial` token must not open `food` | ✅ 50/50 refused |
| **No widening** | holding `attr.x.y.*` must not imply `pkm.read` | ✅ 50/50 |
| **Revoke** | the same token stops working immediately | ✅ 50/50 |
| **Expiry** | an expired grant is refused before scope is even considered | ✅ 50/50 |

**The counterparty is `investor:<user_id>`, not a recipient field.** There is no
second-user principal in a consent token — the counterpart is carried in
`agent_id`. The simulation uses the real mechanism rather than inventing one.

**Scopes are built, never invented:** `attr.{domain}.{path}.*` and the reserved
values come from `ConsentScope`. Inventing a scope string would give a green run
and a scope-authority drift, which is precisely the failure the
`pkm-upgrade-rehearsal` lane names.

## The log the user sees

Emitted at `<root>/consent-log.json` in two shapes, because the product has two.

**Raw ledger row** — what `consent_audit` stores:

```
CONSENT_GRANTED      attr.financial.portfolio.*   -> investor:sim-user-0001
POD_ACCESS_ALLOWED   attr.financial.portfolio.*   -> investor:sim-user-0001
POD_ACCESS_DENIED    attr.food.preferences.*      -> investor:sim-user-0001
    reason=Scope mismatch: token has 'attr.financial.portfolio.*',
           but 'attr.food.preferences.*' required
CONSENT_REVOKED      attr.financial.portfolio.*   -> investor:sim-user-0001
POD_ACCESS_DENIED    attr.financial.portfolio.*   -> investor:sim-user-0001
    reason=Token has been revoked
```

Across the fleet: **50 grants, 50 allowed, 100 denied, 50 revoked** per cycle —
two denials per grant, because both the out-of-scope attempt and the post-revoke
attempt are recorded. *A refusal that leaves no trace is indistinguishable from an
attempt that never happened.*

**Grouped shape** — what `/api/consent/center/list?surface=previous` returns and
the History tab renders. The consent centre has **no flat activity feed**; it is a
three-level tree, so a flat fixture would be unconsumable by the real UI:

```
identifier row   investor|sim-user-0001|current_user   (trail_count=2, event_count=10)
  └ trail        …|attr.financial.portfolio.*          "Access 1"
      ├ event    CONSENT_GRANTED    → status "approved"
      ├ event    POD_ACCESS_ALLOWED → status "pod_access_allowed"
      └ event    CONSENT_REVOKED    → status "revoked"
```

**Metadata only, enforced structurally.** `ConsentLogEntry` is a frozen dataclass
with named fields and no slot for content, so a leak would take a schema change
rather than a slip. Two probes hold it every cycle: no entry carries content, and
no owner's log ever returns another owner's entry.

## Where the pod's access lands in the product

`agent_id="personal_agent"` is **deliberately not** in the internal-event set, so
pod reads stay owner-visible rather than being routed to `internal_access_events`.
The chain is real and complete:

```
pod read  →  PodAccessAuditService  →  consent_audit
          →  ConsentDBService.get_audit_log (internal events filtered out)
          →  consent_center_service.list_center (surface=previous)
          →  GET /api/consent/center/list
          →  /one/consent  History tab
```

## Parity defects found end to end

### Frontend

| # | Defect | Consequence |
|---|---|---|
| F1 | **No display mapping for `POD_ACCESS_*`.** `_map_action_to_status` falls through to `action.lower()`, and `formatStatus` only swaps underscores for spaces. | The user is shown the raw protocol identifier — literally **"Pod Access Allowed"** / **"Pod Access Denied"**. |
| F2 | **A denied pod access is not coloured as a denial.** `badgeClassName` knows `denied`/`revoked`/`cancelled`, not `pod_access_denied`. | A **denied** access is visually identical to an **expired** one — grey. The simulation reproduces this exactly (`status: pod_access_denied`). |
| F3 | **The row title is `personal_agent`.** The technical-identity mask requires `length >= 20`; `personal_agent` is 14. | The user's own agent appears under a raw internal id. |
| F4 | **`_is_internal_event` is duplicated with divergent rules** across `consent_db.py` and `db/consent.py` — the second copy is missing the `NOTIFICATION_*` and `device:` rules. | Two write paths classify the same event differently: an event visible via one path is hidden via the other. |
| F5 | **`get_audit_log` filters internal rows *after* SQL pagination**, while `total` comes from a separate unpaginated fetch. | A page can return fewer rows than `limit` while `has_more` is true, and `total` disagrees with the page. Masked today only because the history path passes `limit=5000`. |

The deny **reasons** the simulation records (`Scope mismatch: …`, `Token has been
revoked`) already travel in `POD_ACCESS_*` metadata today — and are never rendered.
The log answers *that* access happened at scope granularity, never *what* was read;
the record type that carries the "what" (`OPERATION_PERFORMED`) is the first rule
of the internal filter and is never shown.

### Native

Native has **no consent UI at all** — the shell is a `CAPBridgeViewController`
WKWebView and rendering is 100% webapp. Its consent contribution is transport only.

| # | Defect | Severity |
|---|---|---|
| N1 | **The parity gate is blind to the ed25519 flip.** `hct_golden_vectors.json` has **zero** ed25519 vectors; Python has 11 asymmetric tests, Swift has none. | **Highest leverage.** The Swift gate stays green through a flip it cannot detect. |
| N2 | **Both mobile plugins mint tokens with a committed key.** `ProcessInfo.environment["APP_SIGNING_KEY"] ?? "development_secret_key_32_chars!"` — nothing in any scheme, plist, xcconfig or build setting sets that variable, so it is not a fallback but *the only value in a shipped build*. Identical on Android. | Real, but **bounded**: the backend rejects these tokens (local forgery, not an authz bypass) and both methods have **zero callers**. |
| N3 | **The two Swift ports disagree on the wire format.** The plugin strips base64 padding; `TokenCodec` keeps it; Python raises `Incorrect padding`. 10 of 12 golden vectors are padded. | ~83% of device-minted tokens are malformed to the backend even with the right key. |
| N4 | **iOS rejects commercial tokens** — it hard-requires a 5-field payload, so 6-field commercial tokens fail. `TokenCodec` handles both. | Pre-existing, independent of ed25519. |

**The ed25519 question, answered precisely: nothing in the live native path
breaks at the flip.** Both Swift parsers capture the alg-tagged slot whole and
fall through to a failing HMAC compare — they **reject correctly and fail closed**,
which is exactly the verify-both rollout the backend documents. The only
backend-issued token native touches is the VAULT_OWNER token, and it is opaque end
to end: stored in Keychain unparsed and replayed as a bearer. Opaque pass-through
survives an algorithm change untouched.

The honest framing matters here. Reporting "the Swift codecs would misparse
ed25519" would be **wrong** — they reject by design. And reporting the forgery
surface without noting that the backend rejects those tokens and nothing calls the
methods would inflate it into a false P0. The genuine findings are N1 and N2.

**Web already does this correctly:** `consent-web.ts` posts to
`/api/consent/issue-token`. Web delegates; native mints. That is the parity defect
in one sentence — and the same file already fixed this exact class of bug for
TrustLinks, leaving the reasoning in place: *"the device never holds
APP_SIGNING_KEY, so locally signed links could never cross-verify with the
backend."* Consent tokens never got the same treatment.

## What to fix, in order

1. **N1** — add ed25519 golden vectors and a Swift verify path. Do it *before* the
   flip; `CONSENT_TOKEN_SIGNING_ALG` is set nowhere yet, so the window is open.
2. **N2** — delete `issueToken`/`validateToken` from both plugins and both
   `pluginMethods` lists, matching the TrustLink precedent. Smallest change,
   removes the whole surface, breaks no caller.
3. **F1/F2/F3** — map `POD_ACCESS_*` to human labels, colour a denial as a denial,
   and give the user's own agent a name. This is the surface where a user learns
   their pod was read; it should not speak in protocol identifiers.
4. **F4** — collapse the duplicated `_is_internal_event` to one definition.
5. **F5** — filter before paginating, and compute `total` from the filtered set.
6. **N3/N4** — reconcile padding and commercial-token support across the two ports.
