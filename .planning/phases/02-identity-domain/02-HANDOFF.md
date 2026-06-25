# Phase 02 — Identity Domain · Developer Handoff

**Date:** 2026-06-25
**Branch:** `feature/agent-pkm-update-intent`
**Status:** All 4 plans' CODE committed + unit-tested. Live UAT found 2 gaps. 1 new feature requested.
**Author of session:** pair session (orchestrated GSD execute-phase 02)

> TL;DR — The backend identity logic works and is unit-tested. Live UAT in the chatbot
> exposed two things automated tests could not: (1) the confirm-first **review panel is
> not surfaced end-to-end in the UI**, and (2) "what's my address?" returns a stale
> "123 Main St" that is **not present in the user's stored PKM**. Plus a new feature:
> auto-seed identity (name/email, phone-if-verified) from the account on login.

---

## 1. What this phase is

Introduce `identity` as a canonical PKM domain so the agent routes PII (name, email,
address, dob, phone) to `identity` instead of `financial`/`general`, **always** confirming
identity writes (never auto-save), then harden PII, wire identity to the existing KYC
consumer, and backfill any mis-stored data. ~90% backend (`consent-protocol/`); frontend is
fully dynamic.

Full context + locked decisions: `02-CONTEXT.md`. Research: `02-RESEARCH.md`.
Per-plan detail: `02-0{1..4}-PLAN.md` and `02-0{1..3}-SUMMARY.md`.

---

## 2. System structure (where things live)

**Domain registry = single source of truth.** Add/change domains here; everything else derives.
- `consent-protocol/hushh_mcp/services/domain_contracts.py` — `CANONICAL_DOMAIN_REGISTRY`
  (the `identity` entry is at ~line 105, `status="active_core"`, icon `user-round`, `#0EA5E9`).
  `CANONICAL_DOMAIN_KEYS`, scope catalog, registry payload all derive automatically.
- `consent-protocol/hushh_mcp/services/domain_registry_service.py` — `ensure_canonical_domains()`
  seeds new registry entries into the DB. **Called lazily** at `api/routes/pkm_routes_shared.py:1646`
  (when domains are listed) — so a backend restart + first domains request seeds `identity`.

**Classifier 1 — PKM agent lab** (Gemini multi-agent + keyword fallback):
- `consent-protocol/hushh_mcp/services/pkm_agent_lab_service.py`
  - `_IDENTITY_HINTS` (name/full_name/first_name/last_name/email/address/phone/dob/passport…;
    **bare `city`/`street` intentionally excluded** — they collided with location-residence tests).
  - `_INTENT_DOMAIN_DEFAULTS["profile_fact"]` includes `identity`.
  - `_keyword_ranked_domains` has an identity branch.
  - `_load_domain_registry_choices` builds the LLM ontology from the registry (identity now offered).
  - **Force-confirm normalizer** (~3330–3395): identity writes are pinned to `confirm_first`,
    mirroring `financial_domain_requires_confirmation`. Guard is gated strictly on `can_save`
    → identity can **never** resolve to `can_save`.

**Classifier 2 — domain inferrer + attribute learner:**
- `consent-protocol/hushh_mcp/services/domain_inferrer.py` — `DOMAIN_RULES` has an identity rule.
- `consent-protocol/hushh_mcp/services/attribute_learner.py` — prompt extended for identity attrs.

**Agent chat:** `consent-protocol/hushh_mcp/services/agent_chat_service.py` — the "there is no
identity domain" disavowal was removed; PII routes to `identity`.

**KYC consumer (the payoff, read-only target):**
- `consent-protocol/hushh_mcp/services/one_email_kyc_service.py` —
  `_DEFAULT_KYC_SCOPE = "attr.identity.*"`, `_IDENTITY_REQUIRED_FIELDS`
  (full_name, date_of_birth, address, phone_number, email, …). **No SSN field.**
  `_effective_required_fields_for_candidates` already branches on
  `domain in {"identity","financial"}` — identity producer fields pass through with zero KYC changes.

**PII / sensitivity:**
- `consent-protocol/hushh_mcp/consent/pii_sanitizer.py` — masking. Now splits
  `_FORMAT_MASK_KEYS` (email/phone, format-aware) vs `_TEXT_MASK_KEYS`
  (name/address/dob/passport/national_id/ssn, fully masked).
- Backend `_infer_sensitivity` (in `pkm_agent_lab_service.py`) and frontend
  `inferSensitivityLabel` (`hushh-webapp/lib/personal-knowledge-model/manifest.ts`) classify in
  lockstep: passport/national_id/ssn → `restricted`; name/dob/address/phone/nationality → `confidential`.

**Frontend (fully dynamic):**
- `hushh-webapp/lib/personal-knowledge-model/manifest.ts` accepts any domain key from backend
  `DomainSummary` (key/displayName/icon/color). No per-domain code.
- Review panel `AgentPkmReviewPanel` (built in Phase 01, commit `ac8907ec9`) is what *should*
  render for confirm-first writes — see GAP 1.

---

## 3. What changed (per wave, with commits)

All commits on `feature/agent-pkm-update-intent`.

**Wave 1 — Register + route (02-01)** — `d58ba3c92`, `9815a1ad3`, `355a8c6f7`, `c1c9ebf0d`, `929d7b8a5`, `a59809889`
- Registered `identity` in the registry; identity hints in both classifiers; removed the
  identity disavowal in agent chat; **forced identity writes → `confirm_first`** at the normalizer.
- Regression test: "update my address" → `identity` + `confirm_first` (never financial/can_save);
  "what's my address?" (read-only) → `do_not_save`. 340 tests pass.
- Deviation: dropped bare `city`/`street` from identity hints (broke location-residence tests);
  `address`/`my address` retained so the UAT phrasing still routes to identity.

**Wave 2 — PII hardening (02-02)** — `d59ec9e6d`, `6d17d028f`, `1c86a7556`, `273bd1cc5`, `be5fb1379`
- Backend + frontend sensitivity inferers classify identity PII in lockstep; `pii_sanitizer`
  masks name/address/dob/passport/national_id before logging. SSN classified/masked defensively,
  never stored (D-A).
- Governance gates: **Gate 1 (targeted pytest, 357 passed) and Gate 4 (frontend typecheck) PASSED.**
  **Gates 2 & 3 DEFERRED to manual** (Gate 2 = `eval_pkm_structure_agent --enforce-gates`, a live
  multi-minute Gemini benchmark; Gate 3 = `audit_active_pkm_shape_readonly --env-file .env`, live
  SSN audit). See `02-02-SUMMARY.md` for exact commands. **These two still need to be run.**
- `deferred-items.md` logs a pre-existing (not introduced here) `mask_phone` **doctest** mismatch
  — not run by pytest, so CI stays green; out of scope to fix.

**Wave 3 — KYC integration (02-03)** — `52b1a775f`, `cd8e339e9`
- Verification wave: identity→KYC mapping was already correct from Wave 1 (no production change
  needed). Added 4 contract tests locking field passthrough, `attr.identity.*` scope
  resolution/consent-export, no-SSN, and no `kyc_workflow` collision. 57 tests pass.

**Wave 4 — Backfill (02-04)** — `022a149e3`  ⚠️ **SUMMARY.md not yet written** (paused at live checkpoint)
- `consent-protocol/scripts/backfill_identity_domain.py`: dry-run by default, `--apply` required,
  idempotent, reversible (records each move via `record_mutation_event`), per-user targeting,
  skips any `ssn`/`social_security` field. 10 offline tests pass
  (`tests/scripts/test_backfill_identity_domain.py`).
- **Live dry-run** on UID `rkEUelrK4lMOkIaLUfbdEuAUHPp1` → **planned=0**. The user's PKM has no
  mis-stored identity entity. The only name-ish data is `holder_name` deep inside financial bank
  statements (`account_info.holder_name`) — legitimate financial-document context, correctly
  **not** migrated. **TODO: write `02-04-SUMMARY.md`** to finalize the plan (code is committed).

**Locked decisions (from 02-CONTEXT.md):** D-A never store SSN (classify only) · D-B `full_name`
canonical + optional first/last · identity always `confirm_first`, never `can_save` · backfill is
fix-forward + idempotent + reversible.

---

## 4. Open gaps from live UAT — what we plan to change

Live test transcript (chatbot, logged in, local backend):
```
> update my address to 221B Baker Street, London
  "Reviewing your PKM update for your confirmation."   ← message only; NO confirm panel/action shown
> what's my address?
  "Based on your PKM, your address is 123 Main St, New York, NY 10001."
```

### GAP 1 — Confirm-first review panel not surfaced end-to-end  (highest priority — it's the phase's core promise)
- **Symptom:** agent says "Reviewing your PKM update for your confirmation" but the user is never
  presented an actionable review/approve panel. Nothing is auto-saved (good), but the user also
  can't *confirm* (bad).
- **What we know works:** backend correctly *decides* `write_mode=confirm_first` for identity
  (unit-tested in Wave 1). So routing + force-confirm decision are fine.
- **Hypothesis:** the backend response for an identity `confirm_first` write isn't carrying the
  pending-confirmation / review payload the frontend needs, OR the frontend isn't triggering
  `AgentPkmReviewPanel` for that response shape.
- **Investigate (read-only first):**
  1. Backend: what does the agent-chat / pkm write path return to the FE when
     `write_mode == "confirm_first"`? Is a review/pending object attached? (start in
     `agent_chat_service.py` + the pkm write response builder in `pkm_agent_lab_service.py`).
  2. Frontend: where does `AgentPkmReviewPanel` get triggered? Does the identity confirm_first
     response match that trigger condition? (Phase 01 wired it for the update flow — commit `ac8907ec9`.)

### GAP 2 — "what's my address?" returns a value not in stored PKM
- **Symptom:** read returns `123 Main St, New York, NY 10001`, but the live read-only audit of the
  user's PKM (`audit_active_pkm_shape_readonly.py`) found **no address field in any domain**
  (financial/general/identity). The pending unconfirmed update means the read *should* show the old
  value — so the only question is **where that old value lives**.
- **Investigate:**
  1. `grep -rn "123 Main"` across `*.py`/`*.ts`/`*.tsx`/`*.json` (excl. node_modules/.venv) — is it
     hardcoded sample/few-shot/placeholder data feeding the read prompt?
  2. Confirm which UID the **frontend is actually logged in as** vs. the audited
     `rkEUelrK4lMOkIaLUfbdEuAUHPp1` (could be a different user with a stored address).
  3. Check the read path / any cache for a stale or seeded value.

---

## 5. New feature requested — identity auto-seed on login  (likely Phase 03)

**Spec (user's words, refined):** On login, check the `identity` domain for `email` and
`full_name`; if missing, populate from the account/auth profile; if present, leave as-is
(non-clobber). Add `phone_number` **when the phone is verified.** Idempotent, provenance-stamped.

**Design guidance (important — don't break confirm-first):**
- This is a **separate write path** from agent classification. Confirm-first guards *agent-inferred*
  identity facts (NL utterances that can be wrong). Account profile data is already verified, so it
  is **exempt** from confirm-first — but must be stamped `source: account_verified` (+ `verified_at`)
  and remain user-editable, so the invariant stays honest rather than quietly weakened.
- Non-clobber: only fill empty fields; never overwrite a user-edited value (same idempotency
  discipline as the Wave-4 backfill).
- This feeds KYC directly (`attr.identity.*` already consent-exports), so it improves KYC readiness.
- Frontend: dynamic already — Identity card shows seeded fields; mark them "from your account".

---

## 6. How to run / verify

**Backend** (from monorepo root): `./bin/hushh terminal backend --mode local --reload`
· health: `curl http://localhost:8000/health`
**Frontend:** `cd hushh-webapp && npm run dev` (:3000). `.env.local` is wired to local backend;
DB/runtime stays on UAT.

**Tests (use the project venv — system python lacks deps):**
```
cd consent-protocol && .venv/bin/python -m pytest \
  tests/test_domain_contracts.py tests/services/test_pkm_agent_lab_service.py \
  tests/services/test_agent_chat_service.py tests/services/test_one_email_kyc_service.py \
  tests/test_security.py tests/scripts/test_backfill_identity_domain.py -q
```

**Deferred governance gates (still TODO):**
```
cd consent-protocol
.venv/bin/python scripts/eval_pkm_structure_agent.py --enforce-gates          # live LLM benchmark
.venv/bin/python scripts/audit_active_pkm_shape_readonly.py --env-file .env    # confirm no SSN field
```

**Backfill (dry-run is read-only; default):**
```
cd consent-protocol && .venv/bin/python scripts/backfill_identity_domain.py \
  --env-file .env --user-id <UID> --passphrase '<vault passphrase>'
# add --apply to persist (per-user). Re-run without --apply to confirm idempotency (planned=0).
```
(Reviewer creds are NOT in `.env` — pass `--user-id`/`--passphrase` or set
`REVIEWER_UID`/`REVIEWER_VAULT_PASSPHRASE` in an untracked overlay. Passphrase is a secret — not
recorded here.)

---

## 7. Immediate next steps (suggested order)

1. **Fix GAP 1 (confirm panel)** — the phase's core promise; investigate backend payload + FE
   `AgentPkmReviewPanel` trigger, fix, re-test in the live UI.
2. **Trace GAP 2 (`123 Main St` source)** — grep for hardcoded value; verify logged-in UID.
3. **Finalize `02-04-SUMMARY.md`** (backfill code is already committed).
4. **Run deferred governance gates 2 & 3** (LLM benchmark + live SSN audit).
5. **Run phase goal verification** (`gsd-verifier` / VERIFICATION.md) once GAP 1 is fixed — UAT is
   currently failing on the confirm panel, so the phase is not yet "done".
6. **Plan the auto-seed feature** as Phase 03 (discuss → plan → execute) per §5.

GSD-proper path for 1–2: these are UAT gaps → `/gsd-plan-phase 02 --gaps` → `/gsd-execute-phase 02 --gaps-only`.
