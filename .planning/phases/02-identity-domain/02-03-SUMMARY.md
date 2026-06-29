---
phase: "02-identity-domain"
plan: "03"
subsystem: identity-kyc-integration
tags: [pkm, identity, kyc, consent-export, attr-identity-scope, contract-lock, backend, python, tdd, no-ssn]

# Dependency graph
requires:
  - "identity domain registered in CANONICAL_DOMAIN_REGISTRY (02-01)"
  - "identity producer field shape full_name/email/phone_number/date_of_birth/address (02-01, D-B)"
  - "KYC consumer one_email_kyc_service.py reading attr.identity.* (_DEFAULT_KYC_SCOPE, pre-existing)"
  - "_effective_required_fields_for_candidates identity branch (pre-existing line 1773)"
provides:
  - "verified identity->KYC field mapping: identity producer fields satisfy _IDENTITY_REQUIRED_FIELDS with zero KYC schema changes"
  - "regression lock: 4 tests asserting the producer->consumer contract (field passthrough, attr.identity.* resolution, no-SSN, identity!=kyc_workflow)"
  - "verified attr.identity.* is _DEFAULT_KYC_SCOPE, matches _ONE_EMAIL_ATTR_SCOPE_RE, and is in _ALLOWED_KYC_DATA_SCOPES (consent-export permitted)"
affects:
  - "consent-protocol/tests/services/test_one_email_kyc_service.py"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Verification-only wave: producer->consumer contract already existed in code (built in Wave 1); this wave proves and locks it rather than implementing it"
    - "Contract-as-test: the field-name mapping (identity producer -> _IDENTITY_REQUIRED_FIELDS) is pinned by assertions so a silent regression breaks CI (T-02C-01 mitigation)"
    - "Distinct-key assertion: identity (canonical PKM domain) vs kyc_workflow (internal one_kyc_workflows table) proven non-colliding (T-02C-03 mitigation)"

key-files:
  created: []
  modified:
    - consent-protocol/tests/services/test_one_email_kyc_service.py

key-decisions:
  - "Task 1 required NO production code change. _IDENTITY_REQUIRED_FIELDS already contains full_name/email/phone_number/date_of_birth/address (lines 100-114); _effective_required_fields_for_candidates already branches on domain in {identity, financial} (line 1773) passing extracted_fields through; the identity producer's canonical field names (full_name/email/phone_number/date_of_birth/address from 02-01, D-B) already match the required-field strings verbatim. No normalization mapping was needed. Per the plan ('if alignment is already correct, make no code change and record that in the summary')."
  - "No SSN added or mapped (D-A). _IDENTITY_REQUIRED_FIELDS has no ssn/social_security token; a test now asserts this invariant holds permanently."
  - "kyc_workflow is NOT a canonical PKM domain key — it is the internal one_kyc_workflows workflow-state table (one_email_kyc_service.py lines 2870/3996/4158+). No collision with the identity producer domain; asserted via CANONICAL_DOMAIN_KEYS membership in a test."
  - "Imports of private module constants (_IDENTITY_REQUIRED_FIELDS, _DEFAULT_KYC_SCOPE, _ALLOWED_KYC_DATA_SCOPES, _ONE_EMAIL_ATTR_SCOPE_RE) sorted by ruff isort before the public class names, per the repo pre-commit lint."

requirements-completed:
  - D-12
  - D-13

# Metrics
duration: ~20min
completed: 2026-06-24
tasks_completed: 2
tasks_total: 2
files_modified: 1
---

# Phase 2 Plan 03: Identity Domain → KYC Integration Summary

Wired and verified the new `identity` producer domain against the existing KYC consumer (`one_email_kyc_service.py`) and locked the producer→consumer contract with tests. The payoff of the phase: because identity stores `full_name` canonically (D-B), the existing KYC field map works with **zero KYC schema changes** — this wave proves it end-to-end and pins it against regression, with no SSN anywhere and no collision with the internal `kyc_workflow` table.

## What was built

- **Task 1 — Verify and lock identity → KYC field mapping (no production change):** Confirmed `_IDENTITY_REQUIRED_FIELDS` (lines 100-114) contains `full_name`, `email`, `phone_number`, `date_of_birth`, `address` and NO `ssn`; confirmed `_effective_required_fields_for_candidates` (line 1773) already branches on `domain in {"identity", "financial"}` and passes `extracted_fields` through for identity candidates; confirmed `_DEFAULT_KYC_SCOPE == "attr.identity.*"`, that it is in `_ALLOWED_KYC_DATA_SCOPES`, and that it matches `_ONE_EMAIL_ATTR_SCOPE_RE`. The identity producer's canonical field names (from 02-01) match the KYC required-field strings verbatim, so no normalization mapping was required. Per the plan, no code change was made; the alignment is recorded here.
- **Task 2 — Tests locking the contract (commit 52b1a775f, TDD):** Added 4 tests to `tests/services/test_one_email_kyc_service.py`:
  - `test_identity_candidate_yields_kyc_required_fields` — an `domain="identity"` / `scope="attr.identity.*"` candidate with extracted fields `[full_name, email, phone_number, date_of_birth, address]` returns those fields from `_effective_required_fields_for_candidates`, and all are members of `_IDENTITY_REQUIRED_FIELDS`.
  - `test_attr_identity_scope_resolves` — `_DEFAULT_KYC_SCOPE == "attr.identity.*"`, matches `_ONE_EMAIL_ATTR_SCOPE_RE`, and is in `_ALLOWED_KYC_DATA_SCOPES` (consent-export permitted).
  - `test_kyc_required_fields_have_no_ssn` — no required field contains the `ssn` or `social_security` substring (D-A).
  - `test_identity_domain_distinct_from_kyc_workflow` — `identity` is in `CANONICAL_DOMAIN_KEYS`, `kyc_workflow` is not, and an identity candidate resolves `full_name` (D-12 no-collision).

## Verification

- `cd consent-protocol && python3 -m pytest tests/services/test_one_email_kyc_service.py -k "identity or kyc_required or attr_identity" -q` — **5 passed** (4 new + 1 pre-existing match).
- `cd consent-protocol && python3 -m pytest tests/services/test_one_email_kyc_service.py -q` — **57 passed** (no regression).
- `python3 -c "from hushh_mcp.services.one_email_kyc_service import _IDENTITY_REQUIRED_FIELDS, _DEFAULT_KYC_SCOPE; assert _DEFAULT_KYC_SCOPE=='attr.identity.*'; assert not any('ssn' in f for f in _IDENTITY_REQUIRED_FIELDS)"` — OK.
- `_IDENTITY_REQUIRED_FIELDS` (verified): `address, brokerage_profile, date_of_birth, email, employment, full_name, identity_profile, nationality, phone_number, source_of_funds, tax_residency` — contains all 5 producer fields, zero SSN.
- `'identity' in CANONICAL_DOMAIN_KEYS` → True; `'kyc_workflow' in CANONICAL_DOMAIN_KEYS` → False (it is the `one_kyc_workflows` internal table).

Note: tests were run with the project's `.venv` interpreter (`consent-protocol/.venv/bin/python`) because the system Python lacks `dotenv`; the plan's bare `python3` invocations require an activated project venv.

## Restricted tier (D-13, verified not weakened)

No change was made to the sensitivity/`default_available` force-block. The restricted tier remains force-blocked from `default_available` (pre-existing posture documented in 02-RESEARCH and unchanged by this wave). This wave only added tests and made no production-code changes that could weaken it.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Orphaned assertion from incomplete edit match (self-inflicted, immediately fixed)**
- **Found during:** Task 2 (first RED test run)
- **Issue:** My initial Edit appended the new tests between the `reject_draft` test's `with pytest.raises(...)` block and its trailing `assert exc.value.code == "ONE_KYC_DRAFT_NOT_READY"` line (which I had not included in the match), orphaning that assertion at module scope and producing `NameError: name 'exc' is not defined`.
- **Fix:** Restored the trailing assertion to its correct position inside `test_reject_draft_requires_ready_review_draft` and removed the duplicated stray line.
- **Files modified:** consent-protocol/tests/services/test_one_email_kyc_service.py
- **Commit:** 52b1a775f (folded into the Task 2 commit before it was created)

**2. [Rule 3 - Blocking] Pre-commit lint required import sort + format**
- **Found during:** Task 2 commit
- **Issue:** The repo pre-commit hook (ruff isort I001 + ruff format) rejected the commit: private constants must sort before public class names in the import block, and one multi-line `assert` was reflowed.
- **Fix:** Ran `ruff check --fix` and `ruff format` on the test file (cosmetic only; tests re-run green afterward). No `--no-verify`.
- **Files modified:** consent-protocol/tests/services/test_one_email_kyc_service.py
- **Commit:** 52b1a775f

## TDD Gate Compliance

Task 2 is `tdd="true"`. This is a **verification wave**: the production contract (identity branch at line 1773, allowed-scope set at line 63, required-fields frozenset at lines 100-114) was already implemented in Wave 1 by design — the plan explicitly states "this wave is largely verification" and "if alignment is already correct, make no code change." The tests therefore pass against existing code, which is the expected and correct outcome per the plan; per the TDD fail-fast rule I investigated the immediate-pass and confirmed it is intentional (the contract exists and is load-bearing), not a mis-targeted test. A single `test(02-03): ...` commit (52b1a775f) records the RED→locked artifact; no separate `feat` commit exists because no production code needed to change.

## Threat Flags

None. No new network endpoints, auth paths, file access patterns, or schema changes were introduced — this wave added tests only and made no production-code changes. The threat register entries (T-02C-01 contract drift, T-02C-03 kyc_workflow collision) are now mitigated by the Task 2 tests; T-02C-02 (restricted tier) is `accept` and was verified not weakened.

## Known Stubs

None. The identity producer→KYC consumer path is fully wired and locked by tests. Remaining phase work (Wave 4 / plan 02-04) is the bespoke backfill of identity-type entities mis-stored in `financial`/`general`/`location`, which is out of scope here.

## Self-Check: PASSED

- consent-protocol/tests/services/test_one_email_kyc_service.py — FOUND (4 new identity contract tests, 57-passing suite)
- consent-protocol/hushh_mcp/services/one_email_kyc_service.py — FOUND (verified read-only target; no change required)
- Commit 52b1a775f — FOUND
