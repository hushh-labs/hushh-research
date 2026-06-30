# Phase 02: Identity Domain (Register → Route → Harden → KYC → Migrate) - Context

**Gathered:** 2026-06-24
**Status:** Ready for planning
**Source:** `01-IDENTITY-DOMAIN-PROPOSAL.md` (verified evidence) + decisions A–D
**Origin:** Phase 01 UAT failure — "update my address" auto-saved to `financial` with no confirmation; no `identity` domain existed. KYC agent already reads `attr.identity.*` but no producer writes it.

<domain>
## Phase Boundary

Introduce `identity` as a canonical PKM domain and make the agent's add/update
classification route PII (name, email, address, dob, phone) to `identity` — money to
`financial`, etc. — **always** confirming identity writes (never auto-save). Then harden
PII handling, wire the identity domain to the existing KYC consumer, and backfill the
already-mis-stored address.

This is ~90% a **backend** change in `consent-protocol/` (the domain registry is the single
source of truth; the registry auto-surfaces to the LLM and to the fully-dynamic frontend).
The frontend (`hushh-webapp/`) requires near-zero changes.

The work is split into **four waves** (mapping to proposal Phases A→D), executed in order:

- **Wave 1 — Phase A: Register + route (no SSN).** Add `identity` to the registry; add
  identity hints to both classifiers; force `identity` writes to `confirm_first`; planner/LLM
  prompt + tests. Acceptance: "update my address" lands in `identity` with confirmation.
- **Wave 2 — Phase B: PII hardening.** Extend sensitivity inferers (backend + frontend) and
  `pii_sanitizer.py` to mask name/address/dob/passport/national_id; run governance gates.
- **Wave 3 — Phase C: KYC integration (no SSN).** Map the `identity` domain to the existing
  KYC `_IDENTITY_REQUIRED_FIELDS`; verify `attr.identity.*` consent-export to the KYC agent.
- **Wave 4 — Phase D: Migration/backfill.** Move identity-type entities mis-stored in
  `financial`/`general`/`location` into `identity` (bespoke backfill; LEGACY_DOMAIN_ALIASES
  cannot do partial-field moves).

</domain>

<decisions>
## Implementation Decisions

### Locked decisions (A–D)
- **D-A (SSN): NEVER store SSN.** No `ssn`, `ssn_last4`, `ssn_hash`, or any SSN value in any
  wave. The identity schema and KYC mapping exclude SSN entirely. (User decision: "No SSN".)
  KYC `_IDENTITY_REQUIRED_FIELDS` has no SSN field anyway, so this loses nothing for KYC.
- **D-B (name shape): `full_name` canonical + optional `first_name`/`last_name`.** Store
  `full_name` as the canonical field so the existing KYC field map works unchanged; derive
  `full_name` from `first_name`+`last_name` when provided separately.
- **D-C (migration): backfill is in scope as Wave 4** — move the already-mis-stored address
  (and any other identity-type entities) from `financial`/`general`/`location` → `identity`.
  Earlier waves are fix-forward; Wave 4 corrects existing data.
- **D-D (process): run as this GSD phase** (discuss → plan → execute) with
  `vault-pkm-governance` checks, given size + PII sensitivity.

### Wave 1 — Register + route (Phase A)
- **D-01:** Add `DomainContractEntry(domain_key="identity", display_name="Identity",
  icon_name="user-round", color_hex="#0EA5E9", description="Legal name, contact, and verified
  identity attributes for KYC/compliance", status="active_core")` to
  `CANONICAL_DOMAIN_REGISTRY` in `domain_contracts.py`. Derived constants
  (`CANONICAL_DOMAIN_KEYS`, scope catalog, registry payload) update automatically;
  `domain_registry_service.ensure_canonical_domains()` auto-seeds.
- **D-02:** Identity schema (aligned to KYC consumer): `full_name` (canonical),
  `first_name`/`last_name` (optional components), `email`, `phone_number`, `date_of_birth`,
  `address: {line1, line2, city, region, postal_code, country}`. **No SSN.**
- **D-03:** Add `_IDENTITY_HINTS` set (name, full name, email, address, street, city, zip,
  postal, dob, "date of birth", passport, phone, "phone number") in `pkm_agent_lab_service.py`
  and add an `identity` branch to `_keyword_ranked_domains`.
- **D-04:** Add `"identity"` to `_INTENT_DOMAIN_DEFAULTS["profile_fact"]` (and any other intent
  classes where PII facts land) in `pkm_agent_lab_service.py`.
- **D-05:** Add an `identity` rule to `domain_inferrer.DOMAIN_RULES` (the second classifier)
  and extend the `attribute_learner` prompt so identity attributes are learned.
- **D-06:** In `agent_chat_service.py`, remove the "there is no identity domain" disavowal
  (~lines 67, 782) and route name/email/address/phone/dob → `identity`.
- **D-07:** Force `identity` writes to `confirm_first` in the structure normalizer — mirror the
  existing `financial_domain_requires_confirmation` precedent (`pkm_agent_lab_service.py`
  ~3251 / ~3330-3395). Identity must NEVER resolve to `can_save`.
- **D-08:** Tests: `tests/test_domain_contracts.py` (identity registered),
  `tests/services/test_pkm_agent_lab_service.py` (address/name/email route to `identity`;
  identity write_mode forced to `confirm_first`), and `agent_chat_service` routing tests.
  Re-test the exact failing UAT case: "update my address" → `identity` + confirmation.

### Wave 2 — PII hardening (Phase B)
- **D-09:** Extend backend `_infer_sensitivity` and frontend `inferSensitivityLabel` to mark
  `ssn`/`social_security`, `passport`, `national_id`, `dob`/`date_of_birth`, `address` as
  restricted/confidential (defensive: sensitivity is a substring heuristic today). Note: we do
  not store SSN, but the sensitivity rule should still classify it correctly if it ever appears.
- **D-10:** Extend `pii_sanitizer.py` `_ALWAYS_MASK_KEYS` + patterns to mask name, address,
  dob, passport, national_id before identity data can reach any log (today it masks email/phone
  only; name/address are unmasked).
- **D-11:** Run governance gates as acceptance: `eval_pkm_structure_agent.py
  --enforce-gates`, `audit_active_pkm_shape_readonly.py`.

### Wave 3 — KYC integration, no SSN (Phase C)
- **D-12:** Map the `identity` domain fields to the existing KYC consumer's
  `_IDENTITY_REQUIRED_FIELDS` (`one_email_kyc_service.py`): `full_name`, `email`,
  `phone_number`, `date_of_birth`, `address`. Do NOT collide with the separate internal
  `kyc_workflow` domain. **No SSN field** (KYC required fields have none).
- **D-13:** Verify dynamic `attr.identity.*` scopes auto-resolve and consent-export to the KYC
  agent once identity data exists; restricted tier remains force-blocked from
  `default_available`.

### Wave 4 — Migration/backfill (Phase D)
- **D-14:** Bespoke backfill: scan `financial`/`general`/`location` for identity-type entities
  (the mis-stored address from the phase 01 UAT) and move them into `identity`. Idempotent,
  dry-run first, reversible. `LEGACY_DOMAIN_ALIASES` cannot do partial-field moves, so this is a
  dedicated script.

### Claude's Discretion
- Exact token list inside `_IDENTITY_HINTS` (must at minimum catch the phase-01 UAT phrasing
  "update my address").
- Whether the identity schema lives as a manifest/path-descriptor or is purely registry-driven —
  follow the established pattern of existing canonical domains.
- Backfill detection heuristic (which entity shapes count as "identity-type").
- Frontend: optional icon/color fallback hardening only if the dynamic registry doesn't already
  cover a new domain key (verify first — proposal says frontend is fully dynamic).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.** Paths are repo-relative;
all line numbers verified 2026-06-24.

### Domain registry (single source of truth)
- `consent-protocol/hushh_mcp/services/domain_contracts.py` — `DomainContractEntry` dataclass
  (line 19), `CANONICAL_DOMAIN_REGISTRY` tuple (line 39), `CANONICAL_DOMAIN_KEYS` derived
  (line 146), `LEGACY_DOMAIN_ALIASES` (after 147). Add the `identity` entry here.
- `consent-protocol/hushh_mcp/services/domain_registry_service.py` — `ensure_canonical_domains()`
  auto-seeds new registry entries.

### Classifier 1 — PKM agent lab (multi-agent Gemini + keyword fallback)
- `consent-protocol/hushh_mcp/services/pkm_agent_lab_service.py` —
  `_LOCATION_HINTS` (181), `_FINANCIAL_HINTS` (196) [hint-set shape to mirror for
  `_IDENTITY_HINTS`]; `_INTENT_DOMAIN_DEFAULTS` (401); `_keyword_ranked_domains` (995)
  [add identity branch]; `_load_domain_registry_choices` (1173) [registry → LLM ontology];
  force-confirm block (3330-3395) with `financial_domain_requires_confirmation` precedent
  (3251/3352) [mirror to force identity → confirm_first].

### Classifier 2 — domain inferrer + attribute learner
- `consent-protocol/hushh_mcp/services/domain_inferrer.py` — `DOMAIN_RULES` (line 18); add an
  `identity` rule.
- `consent-protocol/hushh_mcp/services/attribute_learner.py` — extend prompt for identity attrs.

### Agent chat (remove identity disavowal)
- `consent-protocol/hushh_mcp/services/agent_chat_service.py` — remove "no identity domain"
  disavowal (~67, ~782); route PII → `identity`.

### KYC consumer (the payoff — read-only target)
- `consent-protocol/hushh_mcp/services/one_email_kyc_service.py` — `_DEFAULT_KYC_SCOPE =
  "attr.identity.*"` (56); `_IDENTITY_REQUIRED_FIELDS` (100): full_name, date_of_birth, address,
  phone_number, email, tax_residency, nationality, employment, source_of_funds,
  brokerage_profile, identity_profile. **No SSN field.**

### PII / sensitivity (Wave 2)
- `consent-protocol/hushh_mcp/consent/pii_sanitizer.py` — `_ALWAYS_MASK_KEYS` + patterns
  (masks email/phone only today).
- Backend `_infer_sensitivity` (locate in pkm services) + frontend `inferSensitivityLabel`
  (`hushh-webapp/`).

### Tests + governance
- `consent-protocol/tests/test_domain_contracts.py`
- `consent-protocol/tests/services/test_pkm_agent_lab_service.py`
- `consent-protocol/scripts/eval_pkm_structure_agent.py` (`--enforce-gates`)
- `consent-protocol/scripts/audit_active_pkm_shape_readonly.py`

### Frontend (verify near-zero change)
- `hushh-webapp/lib/personal-knowledge-model/manifest.ts` — accepts any domain string;
  domains come from backend `DomainSummary.key/displayName/icon/color`.

</canonical_refs>

<specifics>
## Specific Ideas

- The exact failing UAT case is the regression test of record: user says **"update my
  address"** → must classify to `identity`, write_mode `confirm_first`, surface the review panel
  — never auto-save, never route to `financial`.
- Identity writes must be **structurally incapable** of `can_save` (force at the normalizer,
  not just via LLM prompt), mirroring how financial is forced.
- Store `full_name` canonical so the existing KYC `_IDENTITY_REQUIRED_FIELDS` map works with
  zero KYC code changes.
- No SSN anywhere — schema, hints, KYC map, and sanitizer treat SSN only as a *sensitivity
  classification* (block/mask if seen), never as a stored field.

</specifics>

<deferred>
## Deferred Ideas

- Any SSN storage (`ssn_last4` + salted hash) — explicitly **out of scope, permanently**, per
  decision D-A ("No SSN").
- Field-level (per-attribute) encryption isolation — current posture is whole-domain AES-256-GCM
  blob; not changed by this phase.

</deferred>

---

*Phase: 02-identity-domain*
*Context derived 2026-06-24 from 01-IDENTITY-DOMAIN-PROPOSAL.md + decisions A–D*
