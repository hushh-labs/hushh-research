# KYC Redraft — LLM-only (port-and-wire)

- **Date:** 2026-06-26
- **Branch:** `promote/kyc-financial-consolidation` (= `origin/main` + 4 consolidation/UX commits)
- **Status:** Approved design, ready for implementation plan

## Visual Map

```text
Redraft (LLM-only) — zero-knowledge data flow

Browser                                        │  Server
────────────────────────────────────────────  │  ───────────────────────────────
localDraft                                     │
  split framing → redact PII to {{Fn}}         │
  (token map never leaves the browser)         │
        │  tokenized template + instruction    │
        └────────────────────────────────────► │  redraft_llm()
                                               │    consent gate (agent.kyc.redraft.llm
                                               │      satisfied by vault.owner)
                                               │    → Gemini Vertex (kai/llm.py)
                                               │    draft_body = NULL; log hash only
        ◄────────────────────────────────────┘    { rewritten_template }
  validate token integrity (guardrail 1)        │
  re-substitute real values + reassemble        │
  re-validate consented field set (guardrail 2) │
  render → preview (human review before send)   │

Both guardrails fail closed → keep the prior draft.
```

## 1. Goal

Make KYC "Redraft" **LLM-only**: every redraft instruction goes through the
redact → Gemini → re-fill pipeline. No keyword/regex routing, no UI toggle.

Land the work **on this branch**, porting only the minimal pieces needed (from
`feature/agent-kyc-enhancement` / `origin/integration/pr-train`, where the
PR-3665/3679 feature lives), so the eventual PR to `main` carries only these
changes and not the rest of those branches' commits.

## 2. Context — actual state on this branch (Step 0 findings)

The original task framing ("two paths + a toggle; remove the toggle") was written
against `feature/agent-kyc-enhancement`. On **this** branch the reality is
different and must drive the work:

- Redraft is currently **regex-only**. The LLM path is **not wired**.
- `redraft_llm` exists on `feature/agent-kyc-enhancement` and
  `origin/integration/pr-train`, but **not on `main`**, so it is absent here.
- `feature/agent-kyc-enhancement` is ~1059 commits behind `main` (very stale);
  porting the small wiring onto this branch is far cleaner than working there.

### Already present on this branch (reuse as-is)

| Area | Symbols |
|---|---|
| Client ZK pipeline (currently **dead code**, zero callers) | `redactDraftForLlm`, `resubstituteDraft`, `validateTokenIntegrity`, `splitDraftTemplate`, `reassembleDraftTemplate`, `sha256Hex`, `KycLlmRewriteCallable` type — all exported from `lib/services/one-kyc-client-zk-service.ts` |
| Renderer | `renderLlmRedraftHtml` (dead), `redraftTransformFromInstructions` (live — base-draft styling) in `lib/services/one-kyc-approved-disclosure-renderer.ts` |
| Backend Gemini infra | `consent-protocol/hushh_mcp/operons/kai/llm.py` exports `_gemini_client`, `_gemini_model_name`, `_require_gemini_ready`, `_gemini_unavailable_payload`, `types` |
| Constants | `KAI_LLM_TEMPERATURE`, `KAI_LLM_MAX_OUTPUT_TOKENS_DEFAULT` in `constants.py` |
| Service helpers | `_redraft_requests_more_data` (scope-expansion guard) in `one_email_kyc_service.py`; `validate_token_with_db` in `consent/token.py` |
| Consent model | `vault.owner` is a master key — `scope_matches()` (`consent/scope_helpers.py:110`) returns True for any requested scope, so the LLM consent gate passes with the vault-owner token the route already supplies |

### Missing wiring (must port — ~6 files)

1. `consent-protocol/hushh_mcp/constants.py` — add `AGENT_KYC_REDRAFT_LLM = "agent.kyc.redraft.llm"` to the `ConsentScope` enum (after `AGENT_KYC_WRITEBACK`).
2. `consent-protocol/hushh_mcp/agents/kyc/manifest.py` — add `ConsentScope.AGENT_KYC_REDRAFT_LLM` to `optional_scopes` (parity with feature branch).
3. `consent-protocol/hushh_mcp/services/one_email_kyc_service.py` — add imports + the `redraft_llm()` method.
4. `consent-protocol/api/routes/one/email.py` — add `LlmRedraftRequest` model + `POST /kyc/workflows/{workflow_id}/redraft-llm` route.
5. `hushh-webapp/lib/services/one-kyc-service.ts` — add `redraftWithLlm()` static method.
6. `hushh-webapp/app/one/kyc/page.tsx` — replace the regex redraft block in `runAction` with the LLM-only pipeline; **no** `useAiRedraft` state, **no** "Rewrite mode" selector, **no** `isKeywordOnlyInstruction` routing.

## 3. Data flow — the redraft action (LLM-only)

In `page.tsx` `runAction("redraft", workflow)`, the regex block is replaced by the
pipeline already coded on the feature branch (with routing removed):

```
localDraft
  └─ splitDraftTemplate({ body, renderModel })        peel opening + signature; rewrite content only
  └─ redactDraftForLlm({ body: content, approvedValues })   PII → {{F0}}…; tokenMap stays in browser
  └─ OneKycService.redraftWithLlm({ tokenizedTemplate, instruction })   ← only PII-free text leaves browser
        backend redraft_llm():
          consent gate (AGENT_KYC_REDRAFT_LLM via vault.owner) →
          workflow ready check (waiting_on_user + draft ready) →
          _redraft_requests_more_data() scope-expansion guard →
          _require_gemini_ready() →
          Gemini generate_content (token-preserving system prompt) →
          bump draft_revision, write last_redraft_source="llm" + instruction hash →
          return { rewritten_template }
  └─ validateTokenIntegrity(tokenized, rewritten, tokenMap)   guardrail 1
  └─ resubstituteDraft(rewritten, tokenMap)                   real values re-filled locally
  └─ reassembleDraftTemplate({ opening, content, signature }) (when split matched)
  └─ buildDraft re-validate: consented field-key set unchanged?   guardrail 2
  └─ renderLlmRedraftHtml(resubstitutedBody) → setLocalDrafts({ body, htmlBody, draftHash })
```

**Guardrails fail closed:** on token-integrity failure or a changed consented
field-key set, surface an error and keep the prior draft — never set a mangled
draft. Clear `redraftInstructions` after success.

## 4. Backend detail

`redraft_llm()` mirrors the feature-branch method:

- **Consent gate:** `validate_token_with_db(consent_token, ConsentScope.AGENT_KYC_REDRAFT_LLM)`. The route passes the vault-owner token (`token_data.get("token")`); `vault.owner` satisfies any scope. The enum member must exist so `ConsentScope.AGENT_KYC_REDRAFT_LLM` resolves.
- **Readiness:** workflow `status == "waiting_on_user"` and `draft_status == "ready"`, else `ONE_KYC_DRAFT_NOT_READY` (409).
- **Scope-expansion guard:** `_redraft_requests_more_data(instruction)` → `ONE_KYC_LLM_SCOPE_EXPANSION_BLOCKED` (422).
- **Gemini:** `_require_gemini_ready()`; on failure return `_gemini_unavailable_payload(...)`. Token-preserving system prompt instructs the model to keep every `{{Fn}}` placeholder exactly. `temperature=KAI_LLM_TEMPERATURE`, `max_output_tokens=KAI_LLM_MAX_OUTPUT_TOKENS_DEFAULT`. Call runs in an executor (sync client).
- **Zero-knowledge / audit:** never persist or log the template body. `draft_body` stays NULL. Log only `user_id`, `workflow_id`, and the SHA-256 instruction hash. Update workflow metadata: `draft_revision += 1`, `last_redraft_source="llm"`, `last_redraft_at`, `last_redraft_instruction_hash`, `client_draft_required=True`.
- **Return:** `{ "rewritten_template": <str> }`.

Route `POST /kyc/workflows/{workflow_id}/redraft-llm` uses `LlmRedraftRequest`
(`tokenized_template: str (1..20000)`, `instruction: str (1..1000)`) under
`require_vault_owner_token`, logs only ids on failure.

New imports needed in `one_email_kyc_service.py`: `from hushh_mcp.operons.kai
import llm as _kai_llm`; `from hushh_mcp.operons.kai.llm import _gemini_client,
_gemini_model_name, _gemini_unavailable_payload, _require_gemini_ready`; guarded
`from google.genai import types as _genai_types`; `KAI_LLM_TEMPERATURE`,
`KAI_LLM_MAX_OUTPUT_TOKENS_DEFAULT`; `validate_token_with_db` and `ConsentScope`
(verify both are imported, add if not). `asyncio` and `hashlib` are already present.

## 5. Frontend detail

- `one-kyc-service.ts`: `redraftWithLlm({ userId, vaultOwnerToken, workflowId, tokenizedTemplate, instruction })` → `POST /api/one/kyc/workflows/{id}/redraft-llm` with body `{ user_id, tokenized_template, instruction }`, returns `{ rewritten_template }`.
- `page.tsx`: extend the existing `one-kyc-client-zk-service` import with `splitDraftTemplate`, `redactDraftForLlm`, `validateTokenIntegrity`, `resubstituteDraft`, `reassembleDraftTemplate`, `sha256Hex`, and the `KycLlmRewriteCallable` type; import `renderLlmRedraftHtml` from the renderer. Implement the pipeline above. Remove `useAiRedraft` state and the "Rewrite mode" selector JSX. `buildDraft` for re-validation is called **without** `instructions` (no styling change on LLM redraft).

## 6. Keep / don't touch

- `redraftTransformFromInstructions` — sets `renderModel.style` for `buildDraft`/renderer on the **initial** approved-disclosure draft; unrelated to routing. Keep.
- Regex redraft path — `POST /kyc/workflows/{id}/redraft` route, `redraft()` service method, `OneKycService.redraft()` client method, and their existing tests: **kept, just no longer called from the UI** (decision: smallest, lowest-risk diff; no existing main endpoint removed).
- `isKeywordOnlyInstruction` — left in `one-kyc-client-zk-service.ts` (decision: zero-churn; already covered by existing tests).
- Consolidation commits `3abc445…10f6bf2aa` — untouched.

## 7. Testing

- **Backend** (`consent-protocol/.venv/bin/python -m pytest`): port
  `tests/services/test_one_email_kyc_service_llm.py` (present on feature/pr-train,
  absent here), adapted to this branch — consent denied, scope-expansion blocked,
  Gemini-unavailable payload, happy path returns `rewritten_template`, `draft_body`
  stays NULL, metadata bumped (`draft_revision`, `last_redraft_source="llm"`,
  instruction hash). Add a route test for `/redraft-llm`.
- **Frontend** (`cd hushh-webapp && npx vitest run`): redact-pipeline unit tests
  already exist (`__tests__/services/one-kyc-client-zk-service.redact.test.ts`).
  Add: `one-kyc-service` test for `redraftWithLlm` (endpoint + body shape); a
  pipeline-level test covering both guardrail fallbacks (token-integrity failure
  keeps prior draft; changed field-key set keeps prior draft) and the happy path.

## 8. Hard constraints (must not break)

- Zero-knowledge: redact every PII value to `{{Fn}}` before anything leaves the
  browser; token-map and re-substitution happen client-side only.
- Token-integrity check + field-set re-validation client-side; fail closed.
- `draft_body` stays NULL; backend transits only the PII-free template; logs only
  the instruction hash.
- Human review before send unchanged.

## 9. Out of scope

- No changes to the initial-draft build/styling path.
- No deletion of the regex redraft endpoint/method or `isKeywordOnlyInstruction`.
- No merge of `feature/agent-kyc-enhancement` or pr-train history.
