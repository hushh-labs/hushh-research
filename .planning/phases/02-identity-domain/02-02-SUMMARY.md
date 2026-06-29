---
phase: "02-identity-domain"
plan: "02"
subsystem: pkm-pii-hardening
tags: [pkm, identity, pii, sanitizer, sensitivity, governance, security, backend, frontend, tdd]

# Dependency graph
requires:
  - "identity domain registered in CANONICAL_DOMAIN_REGISTRY (02-01)"
  - "_infer_sensitivity substring-token classifier (pkm_agent_lab_service.py)"
  - "inferSensitivityLabel frontend mirror (manifest.ts)"
  - "sanitize_payload / _ALWAYS_MASK_KEYS log sanitizer (pii_sanitizer.py)"
provides:
  - "identity PII tokens (passport/national_id/ssn/social_security) classified restricted in both inferers"
  - "identity PII tokens (full_name/first_name/last_name/date_of_birth/dob/address/phone_number/nationality) classified confidential in both inferers"
  - "_mask_text full-mask helper for arbitrary free-text PII"
  - "_TEXT_MASK_KEYS (identity keys) + _FORMAT_MASK_KEYS (email/phone) split feeding _ALWAYS_MASK_KEYS"
  - "sanitize_payload masks name/address/dob/passport/national_id values before any log sink, non-mutating"
  - "tests/test_security.py coverage for identity key masking + no-mutation + non-PII preservation"
affects:
  - "consent-protocol/hushh_mcp/services/pkm_agent_lab_service.py"
  - "consent-protocol/hushh_mcp/consent/pii_sanitizer.py"
  - "consent-protocol/tests/test_security.py"
  - "hushh-webapp/lib/personal-knowledge-model/manifest.ts"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Backend/frontend sensitivity inferers kept in lockstep: identical token sets mirrored in _infer_sensitivity and inferSensitivityLabel across the data-plane boundary"
    - "Two-tier mask key sets: _FORMAT_MASK_KEYS (email/phone -> format-aware sanitize_log_value) vs _TEXT_MASK_KEYS (identity -> _mask_text full mask), unioned into _ALWAYS_MASK_KEYS"
    - "Defensive classification of ssn/social_security: classified restricted and masked though never stored (D-A)"
    - "Label-preserving full mask (_mask_text keeps first char + length class, '***' for short values) so masked logs stay debuggable without leaking PII"
    - "Non-mutating sanitizer contract preserved (returns a copy)"

key-files:
  created: []
  modified:
    - consent-protocol/hushh_mcp/services/pkm_agent_lab_service.py
    - consent-protocol/hushh_mcp/consent/pii_sanitizer.py
    - consent-protocol/tests/test_security.py
    - hushh-webapp/lib/personal-knowledge-model/manifest.ts

key-decisions:
  - "Split _ALWAYS_MASK_KEYS into _FORMAT_MASK_KEYS (email/phone, routed through existing sanitize_log_value for pattern-aware masking) and _TEXT_MASK_KEYS (identity free-text, routed through new _mask_text). Identity values have no email/phone pattern, so format-only masking would have passed cleartext name/address/dob through."
  - "No SSN stored anywhere per D-A: ssn/social_security appear only as defensive sensitivity classification (restricted) and as mask keys. No SSN field added to any schema, registry, or stored payload."
  - "Backend and frontend token sets mirrored exactly so a given path resolves to the same label on both sides of the data-plane boundary (T-02B-03 mitigation)."
  - "Checkpoint approved on deterministic gates only (gate 1 pytest + gate 4 tsc). Live LLM/Supabase gates (2 eval-pkm-structure, 3 readonly audit) deferred to manual run by the user — recorded with exact commands, NOT claimed passed."

requirements-completed:
  - D-09
  - D-10
  - D-11

# Metrics
duration: ~25min
completed: 2026-06-24
tasks_completed: 3
tasks_total: 3
files_modified: 4
---

# Phase 2 Plan 02: Identity PII Hardening Summary

Extended the backend + frontend sensitivity inferers and the PII log sanitizer so identity attributes (name, address, dob, passport, national_id) are classified restricted/confidential and fully masked before they can reach any log, error reporter, or debug surface — closing the gap where identity PII registered in 02-01 would otherwise flow unmasked through the logging path.

## What was built

- **Task 1 — Sensitivity inferers (commits d59ec9e6d RED, 6d17d028f GREEN):** Extended backend `_infer_sensitivity` (`pkm_agent_lab_service.py`) and frontend `inferSensitivityLabel` (`manifest.ts`) in lockstep. Added `passport`, `national_id`, `social_security` to the restricted-token set (`ssn` was already restricted) and `full_name`, `first_name`, `last_name`, `date_of_birth`, `dob`, `address`, `phone_number`, `nationality` to the confidential-token set. Both sides now resolve `identity.passport_number`/`identity.national_id`/`identity.ssn` -> `restricted` and `identity.full_name`/`identity.address.line1`/`identity.date_of_birth` -> `confidential`.
- **Task 2 — PII sanitizer (commits 1c86a7556 RED, 273bd1cc5 GREEN):** Added `_mask_text`, a label-preserving full-mask helper (keeps first char + length class, returns `***` for short values) for arbitrary free-text PII. Split the mask key set into `_FORMAT_MASK_KEYS` (email/phone, routed through the existing pattern-aware `sanitize_log_value`) and `_TEXT_MASK_KEYS` (identity keys: name/full_name/first/last, address/line1/line2/street, date_of_birth/dob, passport/passport_number, national_id, ssn/social_security), unioned into `_ALWAYS_MASK_KEYS`. `_sanitize_value` now routes identity keys through `_mask_text` so they are fully masked even without an email/phone pattern. Non-PII scalars are preserved and the non-mutating contract is intact. Added matching tests to `tests/test_security.py`.
- **Task 3 — Governance gates (human-verify checkpoint):** Ran the deterministic gates; the user reviewed and approved on those, deferring the two live-service gates to a manual run. See Governance Gates below.

## Verification

**Passed in this session (deterministic):**

- **Gate 1 — targeted pytest:** `cd consent-protocol && python3 -m pytest tests/test_vault.py tests/test_domain_contracts.py tests/services/test_pkm_agent_lab_service.py tests/services/test_agent_chat_service.py tests/test_security.py -q` — **357 passed** (re-confirmed during finalization).
- **Gate 4 — frontend typecheck:** `cd hushh-webapp && npm run typecheck` (`tsc --noEmit`) — clean, exits 0.
- Behavior spot-checks: `_infer_sensitivity` returns restricted for passport/national_id/ssn and confidential for full_name/address.line1/date_of_birth; `sanitize_payload({'full_name':'Jane Doe'})` masks the value (no `'Jane Doe'` in output); `sanitize_payload({'amount':42})['amount'] == 42` (non-PII preserved).

**DEFERRED to manual run (live services — NOT run in this session, NOT claimed passed):**

- **Gate 2 — PKM structure eval (live Gemini LLM benchmark over real shadow users, multi-minute):**
  `cd consent-protocol && python3 scripts/eval_pkm_structure_agent.py --enforce-gates`
- **Gate 3 — active PKM shape audit (live read-only Supabase audit, must confirm no stored ssn field):**
  `cd consent-protocol && python3 scripts/audit_active_pkm_shape_readonly.py --env-file .env`

The user will run gates 2 and 3 manually. Their pass/fail status is not yet known and is not asserted here.

## Deviations from Plan

None — plan executed as written. Tasks 1 and 2 followed the planned RED -> GREEN TDD cycle with no auto-fixes. One out-of-scope discovery was logged (not fixed) — see Deferred Items.

## Deferred Items

Logged in `.planning/phases/02-identity-domain/deferred-items.md` (committed alongside this summary):

- **Pre-existing `mask_phone` doctest mismatch** (`pii_sanitizer.py`, `mask_phone` docstring ~line 85): the doctest expects `'Call +15****4567 ...'` but `_mask_phone_digits` emits `'Call 155****4567 ...'` because the `+` is stripped before the `prefix_len = 3 if startswith("+")` branch is reached. Present before plan 02-02 (verified against commit 04e680128). Not exercised by the pytest suite (`test_security.py` asserts `endswith("4567")` only), so CI stays green. Out of scope for 02-02 (this plan only added `_mask_text` and identity key routing). A one-line `fix` commit can correct the doctest/prefix logic later.

## TDD Gate Compliance

Both `tdd="true"` tasks followed RED -> GREEN:

- Task 1: `test(02-02): add failing identity PII sensitivity classification tests` (d59ec9e6d, RED) -> `feat(02-02): classify identity PII in backend and frontend sensitivity inferers` (6d17d028f, GREEN).
- Task 2: `test(02-02): add failing identity PII key-masking sanitizer tests` (1c86a7556, RED) -> `feat(02-02): mask identity PII keys in pii_sanitizer before logging` (273bd1cc5, GREEN).

No REFACTOR commits were needed.

## Known Stubs

None. Identity PII classification and masking are wired end-to-end: both inferers classify in lockstep and the sanitizer masks identity keys before logging. No placeholder values or unwired data paths were introduced.

## Self-Check: PASSED

- consent-protocol/hushh_mcp/services/pkm_agent_lab_service.py — FOUND (passport/national_id/full_name/date_of_birth/address tokens)
- consent-protocol/hushh_mcp/consent/pii_sanitizer.py — FOUND (_mask_text, _TEXT_MASK_KEYS, full_name/national_id)
- consent-protocol/tests/test_security.py — FOUND (identity masking tests, 357-passing suite)
- hushh-webapp/lib/personal-knowledge-model/manifest.ts — FOUND (mirrored identity tokens)
- Commit d59ec9e6d — FOUND
- Commit 6d17d028f — FOUND
- Commit 1c86a7556 — FOUND
- Commit 273bd1cc5 — FOUND
