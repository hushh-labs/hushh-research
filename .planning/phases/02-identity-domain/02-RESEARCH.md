# Proposal: Canonical `identity` PKM domain + context-aware add/update routing

**Date:** 2026-06-24
**Status:** Proposal — awaiting decisions before planning
**Owners (governance):** `vault-pkm-governance` (spoke) under `security-audit`; `backend-agents-operons`; `frontend`
**Origin:** UAT failure in phase 01 — address auto-saved to `financial` with no confirmation; no `identity` domain exists.

---

## 1. Executive summary

Add `identity` as a **canonical PKM domain** (name, email, address; SSN last-4 optional — see Decision A), and rework agent **add + update** classification so PII routes to `identity`, money to `financial`, etc., always with confirmation for identity writes (never auto-save).

**Why it's feasible / low-risk on the consumer side:** A complete **KYC agent already targets `attr.identity.*`** (`one_email_kyc_service.py:_DEFAULT_KYC_SCOPE`). We are building the missing *producer*. The domain registry is the single source of truth; the **frontend is fully dynamic** and auto-propagates. So this is ~90% a backend change.

**The real risk is not plumbing — it's PII handling for SSN** (no precedent in the repo; logging not masked; sensitivity is substring-heuristic). That is gated behind Decision A.

---

## 2. Key findings (verified, with evidence)

### Classification (backend)
- `/api/pkm/agent-lab/structure` → `pkm_agent_lab_service.py` runs a **multi-agent Gemini pipeline** (segment → financial-guard → memory-intent → merge → structure) with **deterministic keyword fallback**.
- The domain ontology shown to the LLM is **derived from `CANONICAL_DOMAIN_REGISTRY`** (`domain_contracts.py`) via `_load_domain_registry_choices`. Agents are told "Never invent domains." → **Adding `identity` to the registry auto-surfaces it to the LLM.**
- Fallback keyword routing has per-domain hint sets (`_FINANCIAL_HINTS`, `_LOCATION_HINTS`, …) but **no `_IDENTITY_HINTS`**. A second classifier `domain_inferrer.DOMAIN_RULES` also lacks `identity`.

### write_mode / confirmation
- Decided in `pkm_agent_lab_service.py` (~lines 3330-3392). `requires_confirmation` or `save_class=="ambiguous"` → `confirm_first`. Financial already has a force-confirm precedent (`financial_domain_requires_confirmation`). **We mirror that to force `identity` → `confirm_first` (never `can_save`).**

### Frontend
- **No hardcoded domain registry.** Domains come from backend metadata (`DomainSummary.key/displayName/icon/color`). `manifest.ts` accepts any domain string. Update flow already always-confirms; add flow obeys backend `write_mode`. → **Frontend needs ~zero changes** (optional: sensitivity keyword hardening, icon/color fallback).

### Security / PII
- BYOK AES-256-GCM, **whole-domain blob** encryption — no field-level isolation (SSN shares the blob with name).
- Dynamic `attr.identity.*` scopes **auto-resolve** once data exists; restricted tier is force-blocked from `default_available` (good).
- Sensitivity is **substring heuristic**: `ssn`/`tax` → restricted. `social_security_last4` would NOT be caught unless named with `ssn`.
- `pii_sanitizer.py` masks email/phone only — **name, address, SSN are not masked in logs.**
- **No precedent for persisting any SSN value.** Existing posture is detect-and-scrub. Last-4 precedent exists only for phone/account (always last-4 + salted hash, never full).

### KYC alignment (the payoff)
- `one_email_kyc_service.py` already reads `attr.identity.*`; `_IDENTITY_REQUIRED_FIELDS` = full_name, date_of_birth, address, phone_number, email, tax_residency, nationality, employment, source_of_funds, brokerage_profile, identity_profile.
- **Mismatch:** KYC wants `full_name` (not first/last); KYC has **no SSN field**. `kyc_workflow` is a separate internal domain — don't collide with it.

---

## 3. Proposed design

### 3.1 Register `identity` canonically
- Add `DomainContractEntry(domain_key="identity", display_name="Identity", icon_name="user-round", color_hex="#0EA5E9", description="Legal name, contact, and verified identity attributes for KYC/compliance", status="active_core")` to `CANONICAL_DOMAIN_REGISTRY`. Derived constants (`CANONICAL_DOMAIN_KEYS`, scope catalog, registry payload) update automatically. `domain_registry_service.ensure_canonical_domains()` auto-seeds.

### 3.2 Identity schema (aligned to KYC consumer)
```
identity:
  full_name        # canonical; derive from first+last if provided separately
  first_name       # optional component
  last_name        # optional component
  email
  address: { line1, line2, city, region, postal_code, country }
  # SSN: see Decision A — if included: ssn_last4 + ssn_hash (salted), NEVER full SSN
```
Store `full_name` so the existing KYC field map works without changes.

### 3.3 Routing rework (add + update)
- Backend: add `_IDENTITY_HINTS` (name, email, address, dob, passport, phone, "social security") + if-block in `_keyword_ranked_domains`; add `identity` to `_INTENT_DOMAIN_DEFAULTS["profile_fact"]`; add to `domain_inferrer.DOMAIN_RULES` and `attribute_learner` prompt.
- `agent_chat_service.py`: remove the "there is no identity domain" disavowal (lines ~67, ~782 — already partly mine) and route name/email/address/SSN → `identity`.
- Force `identity` writes to `confirm_first` in the structure normalizer (mirror financial precedent).

### 3.4 Confirmation & sensitivity
- Identity always `confirm_first` → review panel (no auto-save).
- Extend sensitivity inferers (backend `_infer_sensitivity` + frontend `inferSensitivityLabel`) to mark `ssn`, `social_security`, `passport`, `national_id`, `dob`/`date_of_birth`, `address` as restricted/confidential.
- Extend `pii_sanitizer.py` `_ALWAYS_MASK_KEYS` + patterns for name/address/SSN before identity data can hit any log.

### 3.5 Migration
- Existing address mis-stored as a `financial_memory` entity in `financial`: write a **bespoke backfill** moving identity-type entities from `financial`/`general`/`location` → `identity` (LEGACY_DOMAIN_ALIASES can't do partial-field moves). Optional/manual for a single test user; required for any real users.

---

## 4. Decisions required (yours)

**Decision A — SSN last-4:** include now, defer, or never?
- Recommend: **defer SSN to the KYC-integration step.** Ship `identity` with name/email/address first (low risk, unblocks KYC reads). Add `ssn_last4` + salted hash + sanitizer + restricted posture only when KYC writeback actually needs it. (Including it now adds the most security surface for the least immediate value.)

**Decision B — name shape:** store `full_name` canonical (recommended, matches KYC) with optional `first_name`/`last_name` components? Or first/last only (then we must derive full_name for KYC)?

**Decision C — migration:** backfill the already-mis-stored address into `identity` now, or fix-forward only (leave old data, correct new writes)?

**Decision D — process:** run this as a **new GSD phase** (discuss → plan → execute, with vault-pkm-governance checks) given its size and PII sensitivity? Or implement directly on this branch?

---

## 5. Proposed phasing (if approved)

- **Phase A — Register + route (no SSN):** add `identity` to registry; identity hints in both classifiers; force confirm_first; planner prompt + tests. Re-test "update my address" → lands in `identity` with confirmation. Frontend auto-works.
- **Phase B — PII hardening:** extend sensitivity inferers + PII sanitizer; data-plane classification; vault-pkm-governance checks (`audit_active_pkm_shape_readonly.py`, `eval_pkm_structure_agent.py --enforce-gates`).
- **Phase C — KYC integration (incl. SSN if Decision A=include):** map identity domain → KYC required fields; add `ssn_last4`+hash if pursued; verify `attr.identity.*` consent-export to the KYC agent.
- **Phase D — Migration/backfill** of existing mis-stored identity data.

## 6. Required governance checks (per skills)
- `cd consent-protocol && python3 -m pytest tests/test_vault.py tests/test_domain_contracts.py tests/services/test_pkm_agent_lab_service.py tests/services/test_agent_chat_service.py -q`
- `cd consent-protocol && python3 scripts/eval_pkm_structure_agent.py --phase fresh_chain_60 --enforce-gates`
- `cd consent-protocol && python3 scripts/audit_active_pkm_shape_readonly.py --env-file .env`
- `cd hushh-webapp && npm run verify:cache && npm run typecheck`
- `./bin/hushh docs verify` ; `./bin/hushh codex data-model-audit`
