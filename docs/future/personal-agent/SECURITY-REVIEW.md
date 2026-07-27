# Personal Agent (Private Cloud Compute) — Phase 0 Security Review

> **Status:** Phase 0, dev-branch only, feature-flagged **OFF**
> (`PERSONAL_AGENT_ENABLED`). Everything reviewed here is inert and unwired.
> **Method:** an independent adversarial code audit plus an author cross-check,
> with the key cross-references traced end-to-end (token validation, the
> account-deletion cascade, scope matching, the shared signing key).
> **Purpose:** this is the gate the plan requires *before* the live-path wiring
> (auto-provision on phone-verify, teardown on account-deletion) is enabled.

## Verdict

The **core authorization and zero-knowledge design is sound** (see "Confirmed
safe" below). All four gate items — the three MEDIUM findings (M1, M2, M3) and the
recycled-phone LOW (L1) — are now **closed**, so the surface is ready for the live
phone-verify / account-deletion wiring (which itself stays flag-gated and
best-effort). The one standing caveat is **I1**: when the remote pod transport
lands, the pod's read path must use the DB-backed validator so revocation bites.
None of this is live today; the flag is off.

**Required before the flag is enabled or any live path is wired:**

1. ~~**De-externalize prompt-sync auth** (M1)~~ — **DONE**: the endpoint now
   requires the internal-only `cap.agent.prompt.sync` scope (never
   external-requestable) and serves the prompt for the caller's OWN token
   identity — there is no client `agent_id` param to enumerate other agents.
2. ~~**Revoke the standing `pkm.read` on deprovision** (M2)~~ — **DONE**:
   deprovision now writes a `REVOKED` event first. Still confirm the pod's read
   path uses the DB-backed validator so revocation bites (I1), when the remote
   transport lands.
3. ~~**Fix the provision lifecycle** (M3)~~ — **DONE**: the registry row is now
   written (`provisioning`) before the grant is minted and flipped to
   `provisioned` after, so a registry failure can never orphan a live grant.
4. ~~**Wire recycled-phone `generation` rotation** (L1)~~ — **DONE**: `provision()`
   now picks the first generation whose HusshID has no deletion tombstone, so a
   reassigned number rotates to a fresh HusshID instead of re-deriving the prior
   owner's.

The cheap LOW/INFO hardening has landed (L2 ASCII digits, I4 tombstone
skip-empty, L5 docstring honesty); L3 (low-order key rejection) is deferred to the
Phase-2 export-to-pod path (no live path today).

## Confirmed safe (no change needed)

- **No IDOR.** Both routes are `VAULT_OWNER`-gated and derive `user_id` solely
  from the token, and the provisioning phone is read server-side from
  `ActorIdentityService`, never from the request body — a caller can only act on
  their own agent for their own verified phone.
- **Zero-knowledge boundary holds.** Only a public key is accepted, validated,
  stored, and logged. `generate_pod_keypair` (the only code touching a private
  key) is never called by the backend; no path logs or persists private material
  (provisioning logs booleans only).
- **No SQL injection.** Both repos use the parameterized PostgREST builder
  (`.eq()/.upsert()/.insert()/.delete()`); request fields are length-bounded.
- **Scope cannot escalate.** `scope_matches("pkm.read", "vault.owner")` and
  `scope_matches("pkm.read", "agent.kai.analyze")` are both False; `pkm.read`
  projects the `attr.*` domains by design and is Nav-revocable.
- **HusshID is non-reversible** without the server key; its 160-bit (20-byte,
  32-char base32) truncation is adequate, and the HusshID vs phone-hash HMAC
  contexts are domain-separated.
- **Constant-time compares** are used for both the token MAC and the prompt
  signature; the signing key is never logged or emitted. Error bodies and logs do
  not echo phone numbers, tokens, or keys.

## Findings

### [MEDIUM] M1 — Fleet-wide system-prompt disclosure to any external `cap.one.invoke` holder

`GET /api/one/agent-prompt` returns the full active system prompt for a
caller-supplied `agent_id`/`channel`, gated only by `cap.one.invoke` — a scope
that is explicitly *external-requestable* (`constants.py`) and documented as
control-plane only, "no information disclosure." Prompts are keyed by
`(agent_id, channel)`, not per-user.

- **Scenario:** a third-party app that a user granted `cap.one.invoke` (to invoke
  One) calls `agent-prompt?agent_id=<any>` and enumerates every agent's global
  system prompt — guardrail logic, tool contracts, business rules — aiding
  jailbreak/prompt-injection crafting and leaking internal IP.
- **Fix:** authorize prompt-sync with a dedicated **internal-only** scope (absent
  from the external-requestable set), and derive the served `agent_id` from the
  authenticated token identity (or require `query agent_id == token agent_id`)
  instead of trusting the query param. Treat as **HIGH** if any
  `agent_prompt_versions.prompt_text` can contain secrets or per-user content.
- **Status — ADDRESSED:** the endpoint now requires `cap.agent.prompt.sync`, a new
  internal-only scope in `INTERNAL_ONLY_SCOPE_VALUES` that `is_external_requestable_scope`
  rejects (so the developer request gate refuses it), and it serves the prompt for
  the caller's OWN token `agent_id` — the client `agent_id` query param is gone, so
  no caller can enumerate another agent's prompt.

### [MEDIUM] M2 — Deprovision never revokes the standing `pkm.read` grant

`deprovision()` writes a tombstone and deletes the registry row but performs no
revocation of the broad, renewable standing `pkm.read` token that `provision()`
minted; the registry stores no handle to it. Traced end-to-end:

- `validate_token_with_db` → `ConsentDBService.is_token_active(user, scope,
  agent_id, token_id)`; empty grant history → `False`
  (`consent_db.py:1017`), and the latest event must be `CONSENT_GRANTED` with a
  matching `token_id` and unexpired.
- **Account deletion is SAFE** (verified): the cascade deletes `consent_audit`
  rows → no rows → `is_token_active` False → fail-closed immediately.
- **Standalone deprovision is the GAP**: it neither deletes the `CONSENT_GRANTED`
  row nor writes a `REVOKED` row, so the grant stays valid until its 24h expiry.
- **Scenario:** a user provisions, then deprovisions but keeps the account. The
  pod's `pkm.read` keeps validating for up to 24h; a still-running or compromised
  pod keeps reading the whole PKM after teardown.
- **Fix:** persist a revocation handle at provision time and, in `deprovision()`,
  write a `REVOKED` event for `(user_id, personal_agent, pkm.read)` (or call the
  revoke path). Do not describe teardown as "clean" until this is wired. **See
  also I1** — this only bites if the pod read path uses `validate_token_with_db`.
- **Status — ADDRESSED:** `PersonalAgentGrantService.revoke_standing_pkm_read`
  writes a `REVOKED` event for `(user, pkm.read, personal_agent)` (no stored token
  needed — `is_token_active` keys off the latest event), and `deprovision()` now
  calls it first, best-effort. I1 (pod must validate via the DB-backed path)
  remains, enforced when the remote transport lands.

### [MEDIUM] M3 — Grant minted before the registry write, and re-minted every provision

`issue_standing_pkm_read()` (mints a live token + writes a ledger row) runs
*before* `registry.upsert()`, and every provision re-mints without revoking the
prior token.

- **Scenario:** `upsert()` raises (transient error, or the `hushh_id` unique-index
  collision from L1). The user now holds a live standing `pkm.read` and a
  `CONSENT_GRANTED` ledger entry but no registry row; each retry mints another.
  `upsert(on_conflict=user_id)` is row-idempotent, but the grant is not — repeated
  provisions leave N live standing reads with no registry linkage. Blast radius is
  bounded (own agent, own data, Nav-visible, revocable) but it breaks the intended
  clean lifecycle.
- **Fix:** mint the grant only after a successful `upsert`; reuse/short-circuit
  when a provisioned row already exists; revoke-or-reuse the prior token on
  re-provision; on `upsert` failure, revoke the just-minted grant (compensating
  action).
- **Status — ADDRESSED:** `provision()` now records the row as `provisioning`
  BEFORE minting, then flips to `provisioned` after — so a registry failure never
  orphans a grant, and a mint that never completes leaves the row visibly stuck in
  `provisioning` for a reconcile sweep. Token accumulation is a non-issue in
  practice: `is_token_active` is latest-wins + token_id-matched, so a re-provision's
  new grant supersedes (dead-ends) any prior token — only the newest is ever
  active. The reuse/short-circuit is deferred as a ledger-churn optimization, not
  a security gap.

### [LOW] L1 — Recycled-phone `generation` disambiguation is documented but not wired

`provision()` calls `mint_hushh_id(phone_e164)` with the default `generation=0`
and has no rotation logic, so a recycled phone deterministically yields the prior
owner's `hushh_id` and `phone_e164_hash`.

- **Scenario:** a number reassigned to user B derives the exact `hushh_id` user A
  held. The `hushh_id` UNIQUE index rejects B's provision (a collision DoS), and
  B's phone hash equals A's — conflating identities on any phone-hash lookup or on
  the public `/u/{hushh_id}` handle. Only Phase-0 flag-gating and the unique index
  prevent silent address reuse today.
- **Fix:** before enabling the flag, wire a `generation`/tombstone lookup into
  `provision()` so a reassigned number rotates to a fresh `hushh_id`; until then,
  document that recycled-phone provisioning fails closed by design.
- **Status — ADDRESSED:** `provision()` calls `_next_free_generation`, which walks
  generations from 0 and returns the first whose HusshID has no deletion tombstone
  (`tombstone_exists`, indexed by migration 902). A fresh phone lands on 0; a
  recycled one rotates forward. The active-collision case (same phone still
  provisioned to another UID) stays fail-closed via the `hushh_id` unique index +
  the M3 write-first ordering.

### [LOW] L2 — E.164 normalizer accepts Unicode digits

`_E164_RE = re.compile(r"^\+[1-9]\d{6,14}$")` is compiled without `re.ASCII`, so
`\d` matches Unicode digits (Arabic-Indic, fullwidth, …), which hash to a
different digest than the ASCII form of the same number.

- **Scenario:** `+1` followed by non-ASCII digits passes validation and produces a
  distinct `hushh_id`/`phone_e164_hash` — a duplicate identity for the "same"
  number, or a mismatch against the ASCII-normalized value used elsewhere. The
  normalizer is the trust boundary and should not admit the ambiguity.
- **Fix:** use `[0-9]` (or compile with `re.ASCII`); optionally NFKC-normalize and
  assert ASCII before hashing.

### [LOW] L3 — `parse_pod_public_key` accepts low-order / all-zero X25519 keys

The parser validates length and encoding but does not reject low-order points.

- **Scenario:** a pod supplies an all-zero/low-order public key. When hussh wraps a
  scoped export to it, the ECDH shared secret is a known constant, so the derived
  AES-256-GCM wrapping key (`SHA256(shared_secret)`) is predictable and the wrapped
  export key is decryptable by anyone who sees the ciphertext — breaking export
  confidentiality for that pod. Self-inflicted (provision is owner-gated and
  self-only), but it weakens a core confidentiality promise.
- **No live impact yet:** today the pod public key is only *stored*; no code path
  wraps an export to it, so nothing degenerate is derived from it. This becomes
  live only when the export-to-pod wrapping path is wired (Phase 2).
- **Fix (with that path):** reject the known small-order X25519 points using an
  established blocklist (e.g. the canonical low-order encoding set) rather than a
  hand-rolled constant, and add a test vector for each. Deferred to when wrapping
  to pod keys exists — implementing it now would ship a security constant with no
  exercised path to validate it.

### [LOW] L4 — Full standing token string persisted in the visible ledger

The mint writes the complete bearer token into `consent_audit` as `token_id`. For
a broad, renewable standing read this places a live, replayable credential at rest.

- **Scenario:** this follows system convention (`validate_token_with_db` looks up
  by full token string), but for the standing `pkm.read` it means any actor with
  read access to `consent_audit` obtains a token that reads the whole PKM until
  expiry — materially more sensitive than a one-shot `attr.*` grant.
- **Fix:** store a token fingerprint/id where the lookup allows, or tightly
  restrict `consent_audit` read access and revoke the standing token promptly on
  teardown (M2).

### [LOW] L5 — Flag is checked after authentication; disabled surface is not fully inert

The auth dependency runs before the in-handler `_require_enabled()`, so with the
kill-switch off the endpoints still perform full token validation (incl. DB
revocation lookups) and return **401** to unauthenticated callers, not the
documented **404**.

- **Scenario:** the "returns 404 until enabled" contract holds only for
  already-authenticated callers; an authenticated owner can use the 404-vs-2xx/409
  difference as a feature-state oracle, and the surface does auth/DB work while
  "disabled." No secret or PII is exposed, and auth-before-flag is the safer
  ordering for unauthenticated callers.
- **Fix:** correct the docstrings to describe the real ordering, or short-circuit
  `_require_enabled()` ahead of the auth dependency if full inertness is desired.

### [INFO] I1 — Revocation only bites if the pod read path uses the DB-backed validator

Cross-cutting: revocation from either path (the account-deletion cascade or an
explicit deprovision revoke) only takes effect if the pod validates with
`validate_token_with_db`. The pure `validate_token` checks only the in-process
`_revoked_tokens` set + HMAC + expiry, which a remote pod (running off-box on
Anypoint, where that in-memory set is never populated) would not reflect.

- **Fix:** when the remote pod transport lands, require the DB-backed validator on
  the pod's read path and confirm it in a test.

### [INFO] I2 — Standing-read `agent_id` binding is advisory, not enforced by the token core

The grant is minted bound to `agent_id="personal_agent"`, but `validate_token` and
the middleware do not check `agent_id`; the "a specialist can never use this token"
guarantee depends on downstream call sites (`adk_bridge.contract`) re-checking it.

- **Fix:** if the agent binding is load-bearing, enforce `agent_id` in the
  validation layer for this scope rather than relying on call-site discipline.

### [INFO] I3 — Consent-token MAC has no explicit domain-separation tag

All four MACs use the same `APP_SIGNING_KEY`. The three personal-agent values are
cleanly domain-separated by distinct `…v1` context tags, but the consent-token
signed payload has none. The prompt-signature message is coincidentally five
pipe-fields, so it structurally resembles a token payload; cross-protocol replay is
blocked only because `validate_token` requires integer `issued_at`/`expires_at` and
a valid scope, which a version string + hex sha256 cannot satisfy — incidental, not
cryptographic.

- **Fix (broader than this surface):** add an explicit version/context tag to the
  consent-token signed payload so domain separation is by construction.

### [INFO] I4 — Deprovision tombstones are not idempotent

`tombstone()` always inserts; a missing registry row still writes
`{hushh_id: "", …}`, and concurrent/retried deprovisions produce multiple
tombstones for one identity — audit noise, harmless to data safety.

- **Fix:** upsert/dedupe on `hushh_id`, or skip when `hushh_id` is empty.

## Disposition

- **Landing now (cheap, unambiguous hardening):** L2 (ASCII digits), I4 (tombstone
  skip-empty), and the L5 docstring correction.
- **Gating the live wiring (needs the design decisions above):** M1, M2, M3, L1,
  plus the I1/I2 enforcement when the remote pod transport lands. These are the
  checklist under "Verdict."
- **Deferred to Phase 2 (no live path today):** L3 (low-order key rejection) lands
  with the export-to-pod wrapping path, using an established blocklist + test
  vectors — not a rushed constant now.
- **Broader-scope observation:** I3 (consent-token domain tag) is a repo-wide
  candor improvement, tracked separately from this surface.

All items are inert today. No change here is deployed; dev-only, flag-off, never
merged to `main`.
