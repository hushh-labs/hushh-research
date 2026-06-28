---
phase: 03-kyc-redraft-intelligence
plan: 02
subsystem: consent-protocol (KYC redact-safe LLM proxy)
tags: [kyc, llm-proxy, gemini-vertex, zero-knowledge, no-persist, consent-scope, tdd]
requires:
  - "ConsentScope.AGENT_KYC_REDRAFT_LLM ('agent.kyc.redraft.llm') scope (Wave 1 / 03-01)"
  - "Shared Gemini Vertex client _gemini_client (operons/kai/llm.py)"
provides:
  - "POST /api/one/kyc/workflows/{id}/redraft-llm route + LlmRedraftRequest schema"
  - "OneEmailKycService.redraft_llm() async service method (redact-safe Gemini proxy)"
  - "{rewritten_template: str} response contract for the Wave 3 frontend re-fill pipeline"
affects:
  - "Wave 3 frontend redact -> rewrite -> re-fill pipeline (calls this endpoint)"
tech-stack:
  added: []
  patterns:
    - "Mirror analyze_stock_with_gemini consent-gate + shared-client pattern for a new scope"
    - "Async service method offloads the synchronous Gemini SDK call via run_in_executor"
    - "No-persist / no-log contract: instruction hash logged, template body never logged/stored"
key-files:
  created:
    - consent-protocol/tests/services/test_one_email_kyc_service_llm.py
  modified:
    - consent-protocol/api/routes/one/email.py
    - consent-protocol/hushh_mcp/services/one_email_kyc_service.py
decisions:
  - "D-C: reuse the shared _gemini_client (no new genai.Client); KAI_LLM_* constants imported from hushh_mcp.constants"
  - "D-D: redraft_llm writes only metadata (revision + instruction hash); draft_body untouched/NULL; only instruction_hash logged"
  - "Consent uses the DB-aware validate_token_with_db so revoked tokens are rejected"
  - "Client resolution prefers the (test-patchable) module global, falling back to live _kai_llm globals after lazy init"
metrics:
  duration: ~25m
  completed: 2026-06-25
---

# Phase 03 Plan 02: Backend Redact-Safe LLM Proxy Summary

Built the `POST /api/one/kyc/workflows/{id}/redraft-llm` endpoint and `OneEmailKycService.redraft_llm()` method: a consent-gated proxy that forwards a PII-free tokenized template + instruction to server-side Gemini Vertex (reusing the shared Kai client) and returns the rewritten template — never persisting or logging the body, with `draft_body` staying NULL.

## What Was Built

**Task 1 — route + schema** (`api/routes/one/email.py`)
- `LlmRedraftRequest(WorkflowUserRequest)` with `tokenized_template` (max 20000) and `instruction` (max 1000), mirroring `DraftRedraftRequest` field limits.
- `one_kyc_redraft_llm` handler at `POST /kyc/workflows/{workflow_id}/redraft-llm` (router prefix `/api/one`), guarded by `require_vault_owner_token`.
- Calls `_verified_vault_user_id(token_data, payload.user_id)`, then `await _service().redraft_llm(...)`, forwarding the raw consent token via `token_data.get("token", "")` (the middleware key set at `middleware.py:75`). On error: `logger.exception(...)` (no body) + `_to_http_exception(exc, operation="redraft_llm")`.
- The handler writes no `draft_body` and logs no template body.

**Task 2 — service method (TDD)** (`hushh_mcp/services/one_email_kyc_service.py`)
- New async `redraft_llm(self, *, user_id, workflow_id, tokenized_template, instruction, consent_token)` placed after `redraft()`.
- Step 1: consent gate via `await validate_token_with_db(consent_token, ConsentScope.AGENT_KYC_REDRAFT_LLM)` — DB-aware, raises `PermissionError` if invalid.
- Step 2: workflow state check (`waiting_on_user` / `ready`) -> else `OneEmailKycError(409, ONE_KYC_DRAFT_NOT_READY)`.
- Step 3: `_redraft_requests_more_data(instruction)` scope-expansion guard runs before any Gemini call -> `OneEmailKycError(422, ONE_KYC_LLM_SCOPE_EXPANSION_BLOCKED)`.
- Step 4: `_require_gemini_ready()` -> `_gemini_unavailable_payload(...)` if not ready.
- Step 5-6: exact token-preserving system instruction + user message; `temperature=KAI_LLM_TEMPERATURE` (0.0), `max_output_tokens=KAI_LLM_MAX_OUTPUT_TOKENS_DEFAULT` (16384); shared client call offloaded via `loop.run_in_executor` (the SDK call is synchronous). Response text extracted via `.text` with a `candidates[0].content.parts[0].text` fallback.
- Step 7: logs only `instruction_hash` (sha256 hex) with `user_id` / `workflow_id`.
- Step 8: `self._update_workflow(...)` (synchronous; no await) writes metadata only — `draft_revision` (+1), `last_redraft_source="llm"`, `last_redraft_at`, `last_redraft_instruction_hash`, `client_draft_required`. No `draft_body` kwarg.
- Step 9: returns `{"rewritten_template": rewritten_template}`.
- Imports added (alphabetized to satisfy ruff I001): `validate_token_with_db`, `KAI_LLM_*` + `ConsentScope` from `hushh_mcp.constants`, `_kai_llm` module + `_gemini_client/_gemini_model_name/_gemini_unavailable_payload/_require_gemini_ready`, and a guarded `google.genai.types` import.

**Test** (`tests/services/test_one_email_kyc_service_llm.py`)
- 4 async unit tests (pytest-asyncio auto mode), Gemini fully mocked: success returns `rewritten_template` and the `_update_workflow` call has no `draft_body` (revision 1->2, source "llm"); missing scope -> `PermissionError`; non-ready workflow -> `ONE_KYC_DRAFT_NOT_READY`; "also include my bank account and address" -> `ONE_KYC_LLM_SCOPE_EXPANSION_BLOCKED`.

## TDD Gate Compliance

RED -> GREEN sequence honored in git history:
- RED: `a29c4e30e` test(03-02) — 4 tests fail with `AttributeError: no attribute 'redraft_llm'`.
- GREEN: `c79e3b6ea` feat(03-02) — all 4 tests pass.
- No REFACTOR commit needed; implementation was clean on first pass.

## Verification

Run via the project venv (`consent-protocol/.venv/bin/python3`):
- route registered: `any('redraft-llm' in r ...)` -> OK
- `py_compile` of both `email.py` and `one_email_kyc_service.py` -> OK
- `grep draft_body | grep redraft_llm` -> empty (no body write in method)
- `grep _update_workflow_async` -> empty (non-existent async variant not referenced)
- `grep tokenized_template | grep logger/log/print` -> empty (body never logged)
- `ONE_KYC_LLM_SCOPE_EXPANSION_BLOCKED` present; `AGENT_KYC_REDRAFT_LLM` in the validate call; "Preserve EVERY placeholder" system instruction present
- new tests: 4 passed
- regression: existing `test_one_email_kyc_service.py` -> 57 passed
- pre-commit lint hooks passed on all commits

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Import ordering for lint (ruff I001)**
- **Found during:** Task 2 commit (pre-commit hook failure).
- **Issue:** ruff requires the `hushh_mcp` import block alphabetized; `hushh_mcp.constants` was placed before `hushh_mcp.consent.*`.
- **Fix:** Reordered so `consent.*` (incl. `validate_token_with_db`) precedes `constants`, which precedes `operons.kai.llm`.
- **Commit:** c79e3b6ea

**2. [Rule 3 - Blocking] Test fixture token strings flagged as secrets (ruff S105/S106)**
- **Found during:** RED commit (pre-commit hook failure).
- **Issue:** `VALID_TOKEN = "HCT:..."` and `consent_token="HCT:bad"` tripped hardcoded-password lint rules.
- **Fix:** Added `# noqa: S105` / `# noqa: S106` with a "test fixture, not a secret" note. No production code affected.
- **Commit:** a29c4e30e

### Implementation note (not a deviation)
- The plan's Step 6 says the SDK call may be wrapped in `run_in_executor` "if the service is async-only". The service methods are async, so the synchronous `_gemini_client.models.generate_content(...)` is offloaded via `loop.run_in_executor(None, ...)` to avoid blocking the event loop. Client/model/types are resolved preferring the module globals (so tests can monkeypatch them) with a fallback to the live `_kai_llm` globals after lazy init — this keeps production correct (the llm module reassigns its globals on lazy init) while the committed RED tests patch the service-module names.

## Threat Model Compliance

- **T-03-02-01 (Info Disclosure — template in logs):** mitigated. Only `instruction_hash` is logged; grep gate confirms `tokenized_template` never reaches a logger/print.
- **T-03-02-02 (Tampering — draft_body written):** mitigated. `_update_workflow` call omits `draft_body`; grep gate confirms absence in the method.
- **T-03-02-03 (EoP — call without scope):** mitigated. `validate_token_with_db(..., AGENT_KYC_REDRAFT_LLM)` is Step 1, raises `PermissionError` before any Gemini call (unit test covers this; route maps to 403 via `_to_http_exception`).
- **T-03-02-04 (Tampering — LLM scope expansion):** mitigated. `_redraft_requests_more_data` guard runs before the Gemini call; raises `ONE_KYC_LLM_SCOPE_EXPANSION_BLOCKED` (unit test covers this).
- **T-03-02-05 (DoS — oversized input):** mitigated. `LlmRedraftRequest.tokenized_template` max_length=20000; Pydantic validates before handler body.
- **T-03-02-SC (supply chain):** accept. No new packages; reused google-genai already installed for Kai LLM operons.

## Known Stubs

None. Both the route and service method are fully wired; the Gemini call uses the live shared client in production and is mocked only in unit tests.

## Commits

- `d5065a425` feat(03-02): add redraft-llm route + LlmRedraftRequest schema
- `a29c4e30e` test(03-02): add failing tests for redraft_llm service method (RED)
- `c79e3b6ea` feat(03-02): implement redraft_llm Gemini proxy with no-persist contract (GREEN)

## Self-Check: PASSED

- `consent-protocol/api/routes/one/email.py` — FOUND (modified)
- `consent-protocol/hushh_mcp/services/one_email_kyc_service.py` — FOUND (modified)
- `consent-protocol/tests/services/test_one_email_kyc_service_llm.py` — FOUND (created)
- commit `d5065a425` — FOUND in git log
- commit `a29c4e30e` — FOUND in git log
- commit `c79e3b6ea` — FOUND in git log
