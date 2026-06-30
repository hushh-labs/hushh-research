---
phase: "02-identity-domain"
plan: "01"
subsystem: pkm-domain-registry
tags: [pkm, identity, domain-registry, classifier, confirm-first, kyc, backend, python, tdd]

# Dependency graph
requires:
  - "CANONICAL_DOMAIN_REGISTRY single source of truth (domain_contracts.py)"
  - "Multi-agent structure-preview pipeline (pkm_agent_lab_service.generate_structure_preview)"
  - "DomainInferrer rule engine (domain_inferrer.py)"
  - "Phase 01 UAT failure record (01-VERIFICATION.md)"
provides:
  - "identity DomainContractEntry in CANONICAL_DOMAIN_REGISTRY (auto-surfaces to LLM ontology, scope catalog, dynamic frontend)"
  - "_IDENTITY_HINTS set + identity branch ordered first in _keyword_ranked_domains"
  - "identity as first profile_fact entry in _INTENT_DOMAIN_DEFAULTS"
  - "identity rule in domain_inferrer.DOMAIN_RULES (out-scores location for full_name/date_of_birth/address)"
  - "attribute_learner EXTRACTION_PROMPT emits identity attributes"
  - "normalizer force-confirm: target_domain==identity AND can_save -> confirm_first (identity_domain_requires_confirmation hint)"
  - "agent_chat_service offers identity to the LLM (disavowal removed)"
  - "regression tests capturing the exact phase-01 UAT (update my address -> identity + confirm_first)"
affects:
  - "consent-protocol/hushh_mcp/services/domain_contracts.py"
  - "consent-protocol/hushh_mcp/services/pkm_agent_lab_service.py"
  - "consent-protocol/hushh_mcp/services/domain_inferrer.py"
  - "consent-protocol/hushh_mcp/services/attribute_learner.py"
  - "consent-protocol/hushh_mcp/services/agent_chat_service.py"
  - "consent-protocol/hushh_mcp/services/one_email_kyc_service.py (existing consumer of attr.identity.*, now has a producer)"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Registry-as-single-source-of-truth: new DomainContractEntry auto-propagates to LLM ontology + dynamic frontend"
    - "Hint-set ordering as priority: identity branch placed first in _keyword_ranked_domains to out-prioritize financial/location"
    - "Pattern-weight scoring to break the inferrer ambiguity tie: identity's .*_name$/.*birth.*/.*address.* patterns (+3 each) push it >2 above location"
    - "can_save-scoped normalizer override mirroring financial_domain_requires_confirmation (write_mode force, not a domain reroute)"
    - "RED/GREEN TDD with self-consistent 5-call AsyncMock side_effect helper (_identity_agent_calls)"

key-files:
  created: []
  modified:
    - consent-protocol/hushh_mcp/services/domain_contracts.py
    - consent-protocol/hushh_mcp/services/pkm_agent_lab_service.py
    - consent-protocol/hushh_mcp/services/domain_inferrer.py
    - consent-protocol/hushh_mcp/services/attribute_learner.py
    - consent-protocol/hushh_mcp/services/agent_chat_service.py
    - consent-protocol/tests/test_domain_contracts.py
    - consent-protocol/tests/services/test_domain_inferrer.py
    - consent-protocol/tests/services/test_pkm_agent_lab_service.py

key-decisions:
  - "Excluded bare 'city'/'street' from _IDENTITY_HINTS: they collide with location-residence statements ('I live in New York City now') which must stay in the location domain. Discovered as a Rule 1 regression against 3 pre-existing location-correction tests. 'address'/'my address' still routes identity, so the UAT case is preserved (D-03 token list is Claude's discretion per CONTEXT)."
  - "Normalizer override gated strictly on write_mode == 'can_save' (mirrors financial guard) so read-only/no_op/ephemeral identity flows (already do_not_save upstream) are never upgraded to confirm_first."
  - "Identity write_mode regression tests use a self-consistent merge_mode + simulated_state: the address/name correction cases need a prior identity target (IDENTITY_SIMULATED_STATE) for the pipeline's merge validator to resolve correct_entity; the can_save-force test uses a fresh create ('my email address is ...') with no correction cue to deterministically reach can_save before the identity guard escalates it."
  - "No SSN anywhere per D-A: no ssn/ssn_last4/ssn_hash/social_security field in the registry entry, hint set, inferrer rule, or new tests. Pre-existing SSN references are sensitivity-classification only (detect-and-scrub in pii sanitizer paths) and were untouched."
  - "full_name kept canonical (D-B): identity inferrer carries full_name/first_name/last_name keywords and a .*_name$ pattern so KYC _IDENTITY_REQUIRED_FIELDS works with zero KYC changes."

requirements-completed:
  - D-01
  - D-02
  - D-03
  - D-04
  - D-05
  - D-06
  - D-07
  - D-08

# Metrics
duration: ~35min
completed: 2026-06-24
tasks_completed: 4
tasks_total: 4
files_modified: 8
---

# Phase 2 Plan 01: Register Identity Domain + PII Routing + Confirm-First Summary

Registered `identity` as a canonical PKM domain and built the missing producer that routes PII (name, email, address, dob, phone) to `identity` while structurally forcing every identity write to `confirm_first` at the normalizer — resolving the phase-01 UAT failure where "update my address" auto-saved to `financial` with no confirmation.

## What was built

- **Task 1 — Registry (commit 355a8c6f7):** Added the `identity` `DomainContractEntry` (`user-round`, `#0EA5E9`, `active_core`) adjacent to the other `active_core` entries. Because the registry is the single source of truth, this auto-surfaces identity to the LLM ontology, the scope catalog, `domain_registry_payload()`, and the fully-dynamic frontend. Added 4 invariant tests (registration, key membership, metadata, no-SSN).
- **Task 2 — Both classifiers (commits 9815a1ad3 RED, d58ba3c92 GREEN):** Added `_IDENTITY_HINTS` and ordered an identity branch FIRST in `_keyword_ranked_domains` (ahead of financial and location); made `identity` the first `profile_fact` intent default; added an `identity` rule to `domain_inferrer.DOMAIN_RULES` whose `.*_name$`/`.*birth.*`/`.*address.*` patterns out-score location for `full_name`/`date_of_birth`/`address`; extended the `attribute_learner` extraction prompt to emit identity attributes.
- **Task 3 — LLM offer + force-confirm (commit c1c9ebf0d):** Removed the "there is no identity domain" disavowal from `agent_chat_service` prose and the `update_pkm` tool schema, replacing it with guidance routing name/email/address/phone/dob to `identity`. Added a `can_save`-scoped normalizer override (`target_domain == "identity" and write_mode == "can_save"` -> `confirm_first` + `identity_domain_requires_confirmation` hint), mirroring the existing `financial_domain_requires_confirmation` guard.
- **Task 4 — Regression tests (commit 929d7b8a5):** Added the exact phase-01 UAT regression and three companions: "update my address" -> identity + confirm_first (never financial); "my name is now Jane Doe" -> identity + confirm_first; identity `can_save` force-escalated to confirm_first; read-only "what's my address?" stays `do_not_save`.

## Verification

- `tests/test_domain_contracts.py tests/services/test_pkm_agent_lab_service.py tests/services/test_domain_inferrer.py tests/services/test_agent_chat_service.py` — **340 passed**.
- `'identity' in CANONICAL_DOMAIN_KEYS` -> True.
- `DomainInferrer().infer('full_name') == 'identity'` and `infer('date_of_birth') == 'identity'`.
- No SSN field in registry, inferrer rule, hint set, or new tests (only a `# NO SSN per D-A` documentation comment and pre-existing sensitivity-scrub tests remain).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Over-broad identity hints broke location-residence routing**
- **Found during:** Task 2 (GREEN)
- **Issue:** Including bare tokens `city` and `street` in `_IDENTITY_HINTS` caused "Actually I live in New York City now." to rank `identity` first, breaking 3 pre-existing location-correction tests (`test_obvious_location_correction_recovers_from_model_no_op`, `test_segmentation_cannot_strip_correction_cue`, and a parametrized CRUD-matrix case) that require those messages to resolve to `location`.
- **Fix:** Removed `city` and `street` from `_IDENTITY_HINTS` (kept `address`/`my address`, which carry the UAT case). The plan grants Claude discretion over the exact token list (CONTEXT D-03) provided it catches "update my address" — which it still does.
- **Files modified:** consent-protocol/hushh_mcp/services/pkm_agent_lab_service.py
- **Commit:** d58ba3c92

**2. [Rule 3 - Blocking] Regression mocks had to be made self-consistent with the merge validator**
- **Found during:** Task 4
- **Issue:** "update my address" / "update my email" contain the correction cue "update", so the pipeline reclassifies `mutation_intent` to `correct`; with no prior identity target the merge resolves to `no_op` -> `do_not_save`, never reaching the `can_save` branch the identity guard escalates.
- **Fix:** Gave the address/name correction tests a prior identity entity via `IDENTITY_SIMULATED_STATE` (so `correct_entity` resolves), and changed the pure can_save-force test to a fresh create ("my email address is ...", no correction cue) so it deterministically reaches `can_save` before the normalizer forces `confirm_first`. No production code changed for this fix — only test fixtures.
- **Files modified:** consent-protocol/tests/services/test_pkm_agent_lab_service.py
- **Commit:** 929d7b8a5

## TDD Gate Compliance

Both `tdd="true"` tasks followed RED -> GREEN:
- Task 2: `test(02-01): add failing identity classifier routing tests` (9815a1ad3, RED, 12 failing) -> `feat(02-01): route identity PII in both classifiers` (d58ba3c92, GREEN).
- Task 4: implementation gate (the normalizer force-confirm) landed in Task 3 (c1c9ebf0d); the regression artifact is `test(02-01): regression ...` (929d7b8a5). The RED state for Task 4's normalizer behavior was demonstrated during execution (address/email asserted `do_not_save`/`can_save` before fixtures were aligned), confirming the guard is load-bearing.

## Known Stubs

None. The identity domain is fully wired end-to-end through both classifiers, the LLM ontology, and the normalizer. The KYC consumer (`one_email_kyc_service.py`, reads `attr.identity.*`) now has a producer. Identity schema field-level structure (full_name/address sub-fields), PII hardening/sanitizer, KYC field-map wiring, and backfill of mis-stored data are intentionally deferred to Waves 2-4 (plans 02-02 / 02-03 / 02-04) per the phase plan.

## Self-Check: PASSED

- consent-protocol/hushh_mcp/services/domain_contracts.py — FOUND (identity entry)
- consent-protocol/hushh_mcp/services/pkm_agent_lab_service.py — FOUND (_IDENTITY_HINTS, identity_domain_requires_confirmation)
- consent-protocol/hushh_mcp/services/domain_inferrer.py — FOUND (identity rule)
- consent-protocol/hushh_mcp/services/attribute_learner.py — FOUND (identity in prompt)
- consent-protocol/hushh_mcp/services/agent_chat_service.py — FOUND (disavowal removed, identity offered)
- Commit 355a8c6f7 — FOUND
- Commit 9815a1ad3 — FOUND
- Commit d58ba3c92 — FOUND
- Commit c1c9ebf0d — FOUND
- Commit 929d7b8a5 — FOUND
