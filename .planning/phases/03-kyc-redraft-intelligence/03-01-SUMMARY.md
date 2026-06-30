---
phase: 03-kyc-redraft-intelligence
plan: 01
subsystem: consent-protocol (KYC agent consent + manifest)
tags: [consent-scope, kyc, zero-knowledge, manifest, carve-out]
requires: []
provides:
  - "ConsentScope.AGENT_KYC_REDRAFT_LLM ('agent.kyc.redraft.llm') scope constant"
  - "KYC manifest optional_scopes entry for redraft.llm"
  - "manifest capabilities.llm_redraft_tokenized carve-out block (auditable ZK narrowing)"
affects:
  - "Wave 2 backend redact-safe LLM proxy endpoint (consent gate)"
  - "Wave 3 frontend LLM-path gating"
tech-stack:
  added: []
  patterns:
    - "Optional consent scope declaration (mirrors existing AGENT_KYC_* members)"
    - "Machine-readable manifest carve-out flag with explicit guarantees dict"
key-files:
  created: []
  modified:
    - consent-protocol/hushh_mcp/constants.py
    - consent-protocol/hushh_mcp/agents/kyc/manifest.py
decisions:
  - "D-D: ZK carve-out documented as a narrowing of the transit rule, not a relaxation of the value gate; strict_client_zk_draft_rendering and backend_plaintext_allowed left unchanged"
  - "D-E: scope string is exactly 'agent.kyc.redraft.llm' (hard-referenced by Wave 2/3)"
  - "Declaration-only wave: no pip installs, no DB migrations, no runtime behavior change"
metrics:
  duration: ~10m
  completed: 2026-06-25
---

# Phase 03 Plan 01: Consent Scope + Manifest Carve-out Summary

Added the `agent.kyc.redraft.llm` optional consent scope and a documented, machine-readable `llm_redraft_tokenized` manifest carve-out block that records the narrow PII-free-template transit rule — the gating prerequisite for the Wave 2 proxy endpoint and Wave 3 frontend LLM path.

## What Was Built

**Task 1 — `ConsentScope.AGENT_KYC_REDRAFT_LLM`** (`constants.py`)
- New enum member `AGENT_KYC_REDRAFT_LLM = "agent.kyc.redraft.llm"`, placed immediately after `AGENT_KYC_WRITEBACK` so the KYC grouping stays obvious.
- Not added to `__all__` (only the class name `ConsentScope` is exported there, never individual members).
- Resolvable both ways: `ConsentScope.AGENT_KYC_REDRAFT_LLM.value == 'agent.kyc.redraft.llm'` and `ConsentScope('agent.kyc.redraft.llm') == ConsentScope.AGENT_KYC_REDRAFT_LLM`.
- Existing `AGENT_KYC_PROCESS`, `AGENT_KYC_DRAFT`, `AGENT_KYC_WRITEBACK` untouched.

**Task 2 — manifest registration + carve-out flag** (`agents/kyc/manifest.py`)
- Appended `ConsentScope.AGENT_KYC_REDRAFT_LLM` to `optional_scopes` after `PKM_WRITE`.
- Added a new `capabilities["llm_redraft_tokenized"]` block (after `approved_disclosure_formatter`) with: `enabled`, `mechanism`, `carve_out`, a `guarantees` dict (`no_real_pii_value_transmitted`, `no_persist`, `no_log_of_body`, `draft_body_null_constraint_unchanged`), `scope_required`, and a prose `rationale` stating the narrowing-not-relaxation intent.
- `strict_client_zk_draft_rendering: True` and `approved_disclosure_formatter.backend_plaintext_allowed: False` left exactly as-is (value gate preserved — threat T-03-01-01 mitigated).

## Verification

All plan verification commands pass (run via the project's `.venv` interpreter):
- `ConsentScope('agent.kyc.redraft.llm') == ConsentScope.AGENT_KYC_REDRAFT_LLM` — OK
- scope present in `MANIFEST['optional_scopes']`; `llm_redraft_tokenized.guarantees.no_real_pii_value_transmitted is True`; `strict_client_zk_draft_rendering is True`; `backend_plaintext_allowed is False` — OK
- `py_compile` of both files — OK
- pre-commit lint hooks passed on both commits.

## Deviations from Plan

### Verification-script note (non-blocking)

The plan's acceptance command `any('redraft.llm' in str(s) for s in MANIFEST['optional_scopes'])` assumes `str(ConsentScope.X)` returns the scope's *value* string. In this codebase the enum's `__str__` returns the *member name* (`ConsentScope.AGENT_KYC_REDRAFT_LLM`), so that literal command returns False even though the scope is correctly registered. The substantive intent — scope present in `optional_scopes` — is confirmed via `s.value` (`any('redraft.llm' in s.value for s in MANIFEST['optional_scopes'])` → True). No code change was required; this is a quirk of the plan's verification snippet, not a defect in the implementation. Wave 2/3 should reference `.value` (or `ConsentScope(...)`), not `str()`, when matching the scope.

### Environment note

The system `python3` lacks the `dotenv` dependency, so imports of `hushh_mcp` fail there. Verification was run with the project virtualenv at `consent-protocol/.venv/bin/python3`, which has the dependencies installed. No code impact.

## Threat Model Compliance

- **T-03-01-01 (Tampering — ZK value gate flags):** mitigated. Asserted `strict_client_zk_draft_rendering: True` and `backend_plaintext_allowed: False` unchanged post-edit.
- **T-03-01-02 (Repudiation — carve-out unauditable):** mitigated. `llm_redraft_tokenized` block makes the carve-out machine-readable with an explicit guarantees dict and prose rationale.
- **T-03-01-SC (supply chain):** accept. Zero packages installed; declaration-only changes.

## Known Stubs

None. This is a declaration-only wave; the consent gate is enforced in Wave 2.

## Commits

- `b5cc4382d` feat(03-01): add AGENT_KYC_REDRAFT_LLM consent scope
- `1c6dc4622` feat(03-01): register redraft.llm scope + llm_redraft_tokenized carve-out

## Self-Check: PASSED

- `consent-protocol/hushh_mcp/constants.py` — FOUND (modified)
- `consent-protocol/hushh_mcp/agents/kyc/manifest.py` — FOUND (modified)
- commit `b5cc4382d` — FOUND in git log
- commit `1c6dc4622` — FOUND in git log
