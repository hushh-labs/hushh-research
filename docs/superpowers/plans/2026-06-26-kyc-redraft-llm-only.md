# KYC Redraft — LLM-only Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire a fresh LLM-only KYC redraft path onto `promote/kyc-financial-consolidation` by porting the minimal pieces of PR-3665/3679 (from `feature/agent-kyc-enhancement`), so every redraft goes redact → Gemini → re-fill with no keyword routing and no UI toggle.

**Architecture:** Reuse infra already present on this branch (client ZK redact/re-fill pipeline, LLM renderer, `operons/kai/llm.py` Gemini client, `validate_token_with_db`, `vault.owner` master-key scope). Port six wiring pieces: a consent scope, a backend service method + route, a client API method, a pure client-side orchestrator, and the page wiring. The regex `/redraft` path stays but is no longer called from the UI.

**Tech Stack:** Python (FastAPI, pytest, `consent-protocol/.venv`), TypeScript/React (Next.js, vitest).

## Visual Map

```text
page.tsx runAction("redraft")
      │
      ▼
runLlmRedraft  (hushh-webapp/lib/services/one-kyc-client-zk-service.ts)
   splitDraftTemplate ─► redactDraftForLlm  (PII → {{Fn}}, token map stays local)
      │
      ▼  only PII-free tokenized text leaves the browser
OneKycService.redraftWithLlm ─► POST /kyc/workflows/{id}/redraft-llm
      │
      ▼  consent gate (agent.kyc.redraft.llm via vault.owner) → Gemini Vertex
redraft_llm()  (consent-protocol/hushh_mcp/services/one_email_kyc_service.py)
   returns { rewritten_template }   (draft_body stays NULL; logs hash only)
      │
      ▼  back in the browser
validateTokenIntegrity ─► resubstituteDraft ─► reassembleDraftTemplate
   guardrail 1 (token integrity) + guardrail 2 (field-key set) — both fail closed
      │
      ▼
renderLlmRedraftHtml ─► setLocalDrafts  (human review before send unchanged)
```

## Global Constraints

- **Zero-knowledge:** every PII value is redacted to `{{Fn}}` before anything leaves the browser; the token map and re-substitution stay client-side only.
- **`draft_body` stays NULL.** Backend transits only the PII-free tokenized template; it never persists or logs the template body — only `user_id`, `workflow_id`, and the SHA-256 instruction hash.
- **Guardrails fail closed:** on token-integrity failure or a changed consented field-key set, keep the prior draft — never set a mangled draft.
- **Human review before send unchanged.**
- **Do not revert** consolidation commits `3abc445…10f6bf2aa`. Do not touch `redraftTransformFromInstructions` (base-draft styling) or the regex `/redraft` route/method/client. Leave `isKeywordOnlyInstruction` in place.
- **Branch:** work on `promote/kyc-financial-consolidation` (already checked out). Do not work on `main`.
- Backend tests: `cd consent-protocol && .venv/bin/python -m pytest`. Frontend tests: `cd hushh-webapp && npx vitest run`.

---

## File Structure

- `consent-protocol/hushh_mcp/constants.py` — add `AGENT_KYC_REDRAFT_LLM` enum member (Task 1).
- `consent-protocol/hushh_mcp/agents/kyc/manifest.py` — declare optional scope (Task 1).
- `consent-protocol/hushh_mcp/services/one_email_kyc_service.py` — imports + `redraft_llm()` method (Task 2).
- `consent-protocol/tests/services/test_one_email_kyc_service_llm.py` — ported unit tests (Task 2).
- `consent-protocol/api/routes/one/email.py` — `LlmRedraftRequest` model + `/redraft-llm` route (Task 3).
- `consent-protocol/tests/test_one_email_routes.py` — route test (Task 3).
- `hushh-webapp/lib/services/one-kyc-service.ts` — `redraftWithLlm()` client method (Task 4).
- `hushh-webapp/__tests__/services/one-kyc-service.test.ts` — client method test (Task 4).
- `hushh-webapp/lib/services/one-kyc-client-zk-service.ts` — `runLlmRedraft()` orchestrator (Task 5).
- `hushh-webapp/__tests__/services/one-kyc-client-zk-service.redraft-llm.test.ts` — orchestrator tests (Task 5).
- `hushh-webapp/app/one/kyc/page.tsx` — wire `runLlmRedraft` into `runAction("redraft")` (Task 6).

---

## Task 1: Backend — add `AGENT_KYC_REDRAFT_LLM` consent scope

**Files:**
- Modify: `consent-protocol/hushh_mcp/constants.py` (ConsentScope enum, near line 63)
- Modify: `consent-protocol/hushh_mcp/agents/kyc/manifest.py` (`optional_scopes`)
- Test: `consent-protocol/tests/test_kyc_redraft_llm_scope.py` (create)

**Interfaces:**
- Produces: `ConsentScope.AGENT_KYC_REDRAFT_LLM` with value `"agent.kyc.redraft.llm"`.

- [ ] **Step 1: Write the failing test**

Create `consent-protocol/tests/test_kyc_redraft_llm_scope.py`:

```python
from hushh_mcp.constants import ConsentScope
from hushh_mcp.consent.scope_helpers import scope_matches


def test_redraft_llm_scope_value():
    assert ConsentScope.AGENT_KYC_REDRAFT_LLM.value == "agent.kyc.redraft.llm"


def test_vault_owner_satisfies_redraft_llm_scope():
    # vault.owner is the master key, so the route's vault-owner token
    # satisfies the LLM redraft consent gate.
    assert scope_matches("vault.owner", ConsentScope.AGENT_KYC_REDRAFT_LLM.value) is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd consent-protocol && .venv/bin/python -m pytest tests/test_kyc_redraft_llm_scope.py -v`
Expected: FAIL — `AttributeError: AGENT_KYC_REDRAFT_LLM`.

- [ ] **Step 3: Add the enum member**

In `consent-protocol/hushh_mcp/constants.py`, after the `AGENT_KYC_WRITEBACK` line (currently line 63):

```python
    AGENT_KYC_PROCESS = "agent.kyc.process"
    AGENT_KYC_DRAFT = "agent.kyc.draft"
    AGENT_KYC_WRITEBACK = "agent.kyc.writeback"
    AGENT_KYC_REDRAFT_LLM = "agent.kyc.redraft.llm"
```

- [ ] **Step 4: Declare the optional scope in the KYC manifest**

In `consent-protocol/hushh_mcp/agents/kyc/manifest.py`, add to `optional_scopes`:

```python
    "optional_scopes": [
        ConsentScope.AGENT_KYC_DRAFT,
        ConsentScope.AGENT_KYC_WRITEBACK,
        ConsentScope.AGENT_KYC_REDRAFT_LLM,
        ConsentScope.PKM_WRITE,
    ],
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd consent-protocol && .venv/bin/python -m pytest tests/test_kyc_redraft_llm_scope.py -v`
Expected: PASS (2 passed).

- [ ] **Step 6: Commit**

```bash
git add consent-protocol/hushh_mcp/constants.py consent-protocol/hushh_mcp/agents/kyc/manifest.py consent-protocol/tests/test_kyc_redraft_llm_scope.py
git commit -m "feat(kyc): add agent.kyc.redraft.llm consent scope"
```

---

## Task 2: Backend — `redraft_llm()` service method

**Files:**
- Modify: `consent-protocol/hushh_mcp/services/one_email_kyc_service.py` (imports near line 26–40; add method after the existing `redraft()` method, before `reject_draft`)
- Test: `consent-protocol/tests/services/test_one_email_kyc_service_llm.py` (create, ported)

**Interfaces:**
- Consumes: `ConsentScope.AGENT_KYC_REDRAFT_LLM` (Task 1); existing `_redraft_requests_more_data`, `_require_gemini_ready`, `_gemini_unavailable_payload`, `validate_token_with_db`, `_utcnow`, `_truncate`, `get_workflow`, `_update_workflow`, `OneEmailKycError`.
- Produces: `OneEmailKycService.redraft_llm(*, user_id, workflow_id, tokenized_template, instruction, consent_token) -> dict` returning `{"rewritten_template": str}`.

- [ ] **Step 1: Add the ported test file**

Extract the proven test verbatim from the feature branch (the method below is ported verbatim, so the test passes as-is):

```bash
cd /Users/gautamahuja/Desktop/RedPlanet/hushh-research
git show feature/agent-kyc-enhancement:consent-protocol/tests/services/test_one_email_kyc_service_llm.py > consent-protocol/tests/services/test_one_email_kyc_service_llm.py
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd consent-protocol && .venv/bin/python -m pytest tests/services/test_one_email_kyc_service_llm.py -v`
Expected: FAIL — `AttributeError: 'OneEmailKycService' object has no attribute 'redraft_llm'` (and/or import errors for the Gemini globals).

- [ ] **Step 3: Add imports to the service module**

In `consent-protocol/hushh_mcp/services/one_email_kyc_service.py`, add to the import block (after the existing `from hushh_mcp.consent.scope_helpers import scope_matches` line ~36):

```python
from hushh_mcp.constants import (
    KAI_LLM_MAX_OUTPUT_TOKENS_DEFAULT,
    KAI_LLM_TEMPERATURE,
    ConsentScope,
)
from hushh_mcp.consent.token import validate_token_with_db
from hushh_mcp.operons.kai import llm as _kai_llm
from hushh_mcp.operons.kai.llm import (
    _gemini_client,
    _gemini_model_name,
    _gemini_unavailable_payload,
    _require_gemini_ready,
)

try:
    from google.genai import types as _genai_types  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    _genai_types = None  # type: ignore
```

> Note: if `ConsentScope` is already imported elsewhere in this file, fold the
> name into that existing import instead of duplicating it.

- [ ] **Step 4: Add the `redraft_llm` method**

In `consent-protocol/hushh_mcp/services/one_email_kyc_service.py`, insert this method immediately after the existing `async def redraft(...)` method and before `async def reject_draft(...)`:

```python
    async def redraft_llm(
        self,
        *,
        user_id: str,
        workflow_id: str,
        tokenized_template: str,
        instruction: str,
        consent_token: str,
    ) -> dict[str, Any]:
        """Redact-safe LLM proxy for KYC redraft (Phase 03).

        Accepts a PII-free tokenized template (placeholders like ``{{F0}}``) plus
        a free-form instruction, validates the ``agent.kyc.redraft.llm`` consent
        scope, and forwards only the template + instruction to server-side Gemini
        Vertex (reusing the shared client from ``operons/kai/llm.py``). The
        rewritten template is returned to the client, which re-substitutes the
        real values locally.

        Zero-knowledge contract: the template body is NEVER persisted or logged.
        ``draft_body`` stays NULL. Only the instruction hash + revision metadata
        are recorded.
        """
        # Step 1 — Consent gate (DB-aware so revoked tokens are rejected).
        valid, reason, _token_obj = await validate_token_with_db(
            consent_token, ConsentScope.AGENT_KYC_REDRAFT_LLM
        )
        if not valid:
            raise PermissionError(f"KYC LLM redraft denied: {reason}")

        # Step 2 — Workflow must be awaiting user review with a ready draft.
        workflow = await self.get_workflow(user_id=user_id, workflow_id=workflow_id)
        if workflow.get("status") != "waiting_on_user" or workflow.get("draft_status") != "ready":
            raise OneEmailKycError(
                "KYC draft is not ready for redraft.",
                status_code=409,
                code="ONE_KYC_DRAFT_NOT_READY",
            )

        # Step 3 — Scope-expansion guard. The LLM must not pull in new scopes.
        if _redraft_requests_more_data(instruction):
            raise OneEmailKycError(
                "The instruction requests data outside the approved scopes.",
                status_code=422,
                code="ONE_KYC_LLM_SCOPE_EXPANSION_BLOCKED",
            )

        # Step 4 — Gemini readiness (lazy-inits the shared Vertex client).
        if not _require_gemini_ready():
            return _gemini_unavailable_payload("Gemini unavailable for KYC LLM redraft")

        # Step 5 — Token-preserving prompt.
        system_instruction = (
            "You are a professional email rewriter. Your task is to rewrite an email draft "
            "according to the user's instruction. The draft contains placeholder tokens in the "
            "format {{F0}}, {{F1}}, {{F2}}, etc. These tokens represent private information "
            "that you must not alter. Rules: (1) Preserve EVERY placeholder token exactly as-is "
            "— same spelling, same braces, same index. (2) Do not add, remove, rename, "
            "duplicate, or invent any placeholder. (3) Output ONLY the rewritten email text, "
            "no commentary, no markdown fences."
        )
        user_message = (
            f"Instruction: {_truncate(instruction, 1000)}\n\n"
            f"Email to rewrite:\n{tokenized_template}"
        )

        # Step 6 — Call Gemini via the shared client (no new client instantiated).
        # Prefer the (possibly test-patched) module-level globals; fall back to the
        # live values in the kai.llm module after lazy init.
        client = _gemini_client if _gemini_client is not None else _kai_llm._gemini_client
        model_name = _gemini_model_name or _kai_llm._gemini_model_name
        types_mod = _genai_types if _genai_types is not None else _kai_llm.types
        if client is None or types_mod is None:
            return _gemini_unavailable_payload("Gemini unavailable for KYC LLM redraft")

        config = types_mod.GenerateContentConfig(
            system_instruction=system_instruction,
            temperature=KAI_LLM_TEMPERATURE,
            max_output_tokens=KAI_LLM_MAX_OUTPUT_TOKENS_DEFAULT,
        )

        def _invoke() -> Any:
            return client.models.generate_content(
                model=model_name,
                contents=user_message,
                config=config,
            )

        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(None, _invoke)
        rewritten_template = getattr(response, "text", None)
        if not rewritten_template:
            candidates = getattr(response, "candidates", None) or []
            if candidates:
                parts = getattr(getattr(candidates[0], "content", None), "parts", None) or []
                if parts:
                    rewritten_template = getattr(parts[0], "text", None)
        rewritten_template = (rewritten_template or "").strip()

        # Step 7 — Log the instruction hash only. NEVER log the template body.
        instruction_hash = hashlib.sha256(instruction.encode("utf-8")).hexdigest()
        logger.info(
            "one.kyc.redraft_llm user_id=%s workflow_id=%s instruction_hash=%s",
            user_id,
            workflow_id,
            instruction_hash,
        )

        # Step 8 — Update workflow metadata only (no draft_body).
        metadata = workflow.get("metadata", {})
        revision = int(metadata.get("draft_revision") or 1) + 1
        self._update_workflow(
            workflow_id,
            metadata={
                **metadata,
                "draft_revision": revision,
                "last_redraft_source": "llm",
                "last_redraft_at": _utcnow().isoformat(),
                "last_redraft_instruction_hash": instruction_hash,
                "client_draft_required": True,
            },
        )

        # Step 9 — Return the rewritten template for client-side re-substitution.
        return {"rewritten_template": rewritten_template}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd consent-protocol && .venv/bin/python -m pytest tests/services/test_one_email_kyc_service_llm.py -v`
Expected: PASS (all ported tests green — success/no-draft-body, missing-scope PermissionError, not-ready 409, scope-expansion 422).

- [ ] **Step 6: Commit**

```bash
git add consent-protocol/hushh_mcp/services/one_email_kyc_service.py consent-protocol/tests/services/test_one_email_kyc_service_llm.py
git commit -m "feat(kyc): redraft_llm service method (redact-safe Gemini proxy)"
```

---

## Task 3: Backend — `/redraft-llm` route + request model

**Files:**
- Modify: `consent-protocol/api/routes/one/email.py` (add model near `DraftRedraftRequest` ~line 72; add route after `one_kyc_redraft` ~line 553)
- Test: `consent-protocol/tests/test_one_email_routes.py` (add a test; follow existing patterns in this file)

**Interfaces:**
- Consumes: `OneEmailKycService.redraft_llm(...)` (Task 2).
- Produces: `POST /kyc/workflows/{workflow_id}/redraft-llm` accepting `{user_id, tokenized_template, instruction}`, returning the service dict.

- [ ] **Step 1: Write the failing test**

Open `consent-protocol/tests/test_one_email_routes.py`, read the top of the file to match its existing client/fixture/auth-override style, then add a test that asserts the route forwards to `redraft_llm`. Use the same `app`/`TestClient` and vault-owner auth override the other KYC route tests in this file use. Concretely:

```python
def test_redraft_llm_route_forwards_to_service(monkeypatch):
    # Arrange: stub the service method the route calls.
    import api.routes.one.email as email_mod

    captured = {}

    class _StubService:
        async def redraft_llm(self, *, user_id, workflow_id, tokenized_template, instruction, consent_token):
            captured.update(
                user_id=user_id,
                workflow_id=workflow_id,
                tokenized_template=tokenized_template,
                instruction=instruction,
            )
            return {"rewritten_template": "Hi {{F0}}"}

    monkeypatch.setattr(email_mod, "_service", lambda: _StubService())

    client = _make_client_with_vault_owner_auth()  # reuse this file's existing helper

    # Act
    resp = client.post(
        "/one/kyc/workflows/wf-1/redraft-llm",
        json={
            "user_id": "u1",
            "tokenized_template": "Hi {{F0}}, ref {{F1}}.",
            "instruction": "warmer tone",
        },
        headers=_vault_owner_headers("u1"),  # reuse this file's existing helper
    )

    # Assert
    assert resp.status_code == 200
    assert resp.json() == {"rewritten_template": "Hi {{F0}}"}
    assert captured["workflow_id"] == "wf-1"
    assert captured["tokenized_template"] == "Hi {{F0}}, ref {{F1}}."
    assert captured["instruction"] == "warmer tone"
```

> If `test_one_email_routes.py` does not already expose `_make_client_with_vault_owner_auth` / `_vault_owner_headers` helpers, replace those two lines with the exact client construction and auth-header/dependency-override pattern used by the existing `redraft`/`reject` route tests in the same file. The route prefix (`/one/...` vs `/api/one/...`) must also match how other tests in this file call KYC routes.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd consent-protocol && .venv/bin/python -m pytest tests/test_one_email_routes.py::test_redraft_llm_route_forwards_to_service -v`
Expected: FAIL — 404 (route not registered).

- [ ] **Step 3: Add the request model**

In `consent-protocol/api/routes/one/email.py`, after `DraftRedraftRequest` (~line 72):

```python
class LlmRedraftRequest(WorkflowUserRequest):
    tokenized_template: str = Field(min_length=1, max_length=20000)
    instruction: str = Field(min_length=1, max_length=1000)
```

- [ ] **Step 4: Add the route**

In `consent-protocol/api/routes/one/email.py`, immediately after the `one_kyc_redraft` handler (the block ending with `raise _to_http_exception(exc, operation="redraft") from exc`, ~line 553):

```python
@router.post("/kyc/workflows/{workflow_id}/redraft-llm")
async def one_kyc_redraft_llm(
    workflow_id: str,
    payload: LlmRedraftRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    _verified_vault_user_id(token_data, payload.user_id)
    try:
        # The PII-free tokenized template and instruction transit to server-side
        # Gemini Vertex. The body is never persisted or logged here; only the
        # workflow_id and user_id are logged, and the service logs the instruction
        # hash (no template body). draft_body stays NULL.
        return await _service().redraft_llm(
            user_id=payload.user_id,
            workflow_id=workflow_id,
            tokenized_template=payload.tokenized_template,
            instruction=payload.instruction,
            consent_token=token_data.get("token", ""),
        )
    except Exception as exc:
        logger.exception(
            "one.kyc.redraft_llm_failed user_id=%s workflow_id=%s",
            payload.user_id,
            workflow_id,
        )
        raise _to_http_exception(exc, operation="redraft_llm") from exc
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd consent-protocol && .venv/bin/python -m pytest tests/test_one_email_routes.py::test_redraft_llm_route_forwards_to_service -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add consent-protocol/api/routes/one/email.py consent-protocol/tests/test_one_email_routes.py
git commit -m "feat(kyc): add /redraft-llm route + LlmRedraftRequest model"
```

---

## Task 4: Frontend — `OneKycService.redraftWithLlm()`

**Files:**
- Modify: `hushh-webapp/lib/services/one-kyc-service.ts` (add static method after `redraft`)
- Test: `hushh-webapp/__tests__/services/one-kyc-service.test.ts` (add a test; follow the file's existing fetch-mock pattern)

**Interfaces:**
- Produces: `OneKycService.redraftWithLlm({ userId, vaultOwnerToken, workflowId, tokenizedTemplate, instruction }) => Promise<{ rewritten_template: string }>` calling `POST /api/one/kyc/workflows/{id}/redraft-llm` with body `{ user_id, tokenized_template, instruction }`.

- [ ] **Step 1: Write the failing test**

Read `hushh-webapp/__tests__/services/one-kyc-service.test.ts` first to match its fetch-mock + `apiJson` conventions, then add:

```ts
it("redraftWithLlm posts tokenized_template + instruction to the redraft-llm route", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ rewritten_template: "Hi {{F0}}" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);

  const result = await OneKycService.redraftWithLlm({
    userId: "u1",
    vaultOwnerToken: "tok",
    workflowId: "wf 1",
    tokenizedTemplate: "Hi {{F0}}, ref {{F1}}.",
    instruction: "warmer tone",
  });

  expect(result).toEqual({ rewritten_template: "Hi {{F0}}" });
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toContain("/api/one/kyc/workflows/wf%201/redraft-llm");
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body as string)).toEqual({
    user_id: "u1",
    tokenized_template: "Hi {{F0}}, ref {{F1}}.",
    instruction: "warmer tone",
  });
});
```

> Match the surrounding tests for imports (`OneKycService`), the fetch/`apiJson`
> mocking approach, and any `beforeEach`/`afterEach` cleanup already in the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hushh-webapp && npx vitest run __tests__/services/one-kyc-service.test.ts`
Expected: FAIL — `redraftWithLlm is not a function`.

- [ ] **Step 3: Add the method**

In `hushh-webapp/lib/services/one-kyc-service.ts`, immediately after the existing `static redraft({...})` method:

```ts
  static redraftWithLlm({
    userId,
    vaultOwnerToken,
    workflowId,
    tokenizedTemplate,
    instruction,
  }: AuthInput & {
    workflowId: string;
    tokenizedTemplate: string;
    instruction: string;
  }): Promise<{ rewritten_template: string }> {
    return apiJson<{ rewritten_template: string }>(
      `/api/one/kyc/workflows/${encodeURIComponent(workflowId)}/redraft-llm`,
      {
        method: "POST",
        headers: authHeaders(vaultOwnerToken),
        body: JSON.stringify({
          user_id: userId,
          tokenized_template: tokenizedTemplate,
          instruction,
        }),
      }
    );
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hushh-webapp && npx vitest run __tests__/services/one-kyc-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hushh-webapp/lib/services/one-kyc-service.ts hushh-webapp/__tests__/services/one-kyc-service.test.ts
git commit -m "feat(kyc): OneKycService.redraftWithLlm client method"
```

---

## Task 5: Frontend — `runLlmRedraft()` orchestrator (pure, testable)

This encapsulates the full client-side ZK pipeline so the page stays thin and the
two guardrails are unit-tested in isolation.

**Files:**
- Modify: `hushh-webapp/lib/services/one-kyc-client-zk-service.ts` (add `runLlmRedraft` + result type near the existing LLM helpers ~line 1490+; extend the renderer import to include `renderLlmRedraftHtml`)
- Test: `hushh-webapp/__tests__/services/one-kyc-client-zk-service.redraft-llm.test.ts` (create)

**Interfaces:**
- Consumes: existing `splitDraftTemplate`, `redactDraftForLlm`, `validateTokenIntegrity`, `resubstituteDraft`, `reassembleDraftTemplate`, `sha256Hex`, `KycLlmRewriteCallable`, `OneKycClientZkService.buildDraft`, and `renderLlmRedraftHtml` (from the renderer); types `KycDraftBuildResult`, `OneKycWorkflow`.
- Produces:
  ```ts
  export type LlmRedraftResult =
    | { ok: true; draft: KycDraftBuildResult }
    | { ok: false; errorCode: "TOKEN_INTEGRITY" | "FIELD_SET_CHANGED" };

  export async function runLlmRedraft(params: {
    localDraft: KycDraftBuildResult;
    instruction: string;
    workflow: OneKycWorkflow;
    exportPayloads: Awaited<ReturnType<typeof OneKycClientZkService.buildDraft>> extends never
      ? never
      : { scope: string; payload: unknown }[];
    llmRewrite: KycLlmRewriteCallable;
  }): Promise<LlmRedraftResult>
  ```
  (Use the same `exportPayloads` element type that `OneKycClientZkService.buildDraft` already accepts in this file — match the existing `buildDraft` signature exactly rather than inventing a shape.)

- [ ] **Step 1: Write the failing tests**

Create `hushh-webapp/__tests__/services/one-kyc-client-zk-service.redraft-llm.test.ts`. First read `one-kyc-client-zk-service.ts` and the existing `one-kyc-client-zk-service.redact.test.ts` to learn the exact shape of `KycDraftBuildResult` (`body`, `renderModel`, `approvedValues`, `missingFields`, `htmlBody`, `draftHash`, …) and how `buildDraft` is invoked, then build a minimal `localDraft` fixture and a fake workflow accordingly.

```ts
import { describe, it, expect, vi } from "vitest";
import {
  runLlmRedraft,
  OneKycClientZkService,
} from "@/lib/services/one-kyc-client-zk-service";

// Helper: a minimal localDraft whose redact/resubstitute round-trips cleanly.
// Build it from buildDraft against a fixture workflow + exportPayloads so the
// renderModel/approvedValues are internally consistent (mirror the setup in
// one-kyc-client-zk-service.redact.test.ts).

describe("runLlmRedraft", () => {
  it("returns ok with an LLM draft when tokens are preserved and field set is unchanged", async () => {
    const { localDraft, workflow, exportPayloads, tokenValue } = await makeFixture();
    // llmRewrite echoes the template back (all tokens preserved) with a small edit.
    const llmRewrite = vi.fn(async (tmpl: string) => tmpl.replace("Hello", "Hi"));

    const result = await runLlmRedraft({ localDraft, instruction: "warmer", workflow, exportPayloads, llmRewrite });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.draft.body).toContain("Hi");
      // Real PII value is back in the body (re-substituted locally), never a token.
      expect(result.draft.body).toContain(tokenValue);
      expect(result.draft.body).not.toMatch(/\{\{F\d+\}\}/);
      expect(result.draft.htmlBody).toBeTruthy();
    }
    expect(llmRewrite).toHaveBeenCalledOnce();
  });

  it("fails closed with TOKEN_INTEGRITY when the LLM drops a token", async () => {
    const { localDraft, workflow, exportPayloads } = await makeFixture();
    // llmRewrite removes all placeholder tokens -> integrity check must fail.
    const llmRewrite = vi.fn(async (tmpl: string) => tmpl.replace(/\{\{F\d+\}\}/g, "REDACTED"));

    const result = await runLlmRedraft({ localDraft, instruction: "x", workflow, exportPayloads, llmRewrite });

    expect(result).toEqual({ ok: false, errorCode: "TOKEN_INTEGRITY" });
  });

  it("fails closed with FIELD_SET_CHANGED when re-validated field keys differ", async () => {
    const { localDraft, workflow, exportPayloads } = await makeFixture();
    const llmRewrite = vi.fn(async (tmpl: string) => tmpl);
    // Force buildDraft to report a different consented field set on re-validation.
    vi.spyOn(OneKycClientZkService, "buildDraft").mockResolvedValueOnce({
      ...localDraft,
      approvedValues: { ...localDraft.approvedValues, __injected_extra_field__: "x" },
    });

    const result = await runLlmRedraft({ localDraft, instruction: "x", workflow, exportPayloads, llmRewrite });

    expect(result).toEqual({ ok: false, errorCode: "FIELD_SET_CHANGED" });
  });
});
```

> `makeFixture()` is test scaffolding you write at the top of this file: call
> `OneKycClientZkService.buildDraft` with a fixture workflow + decrypted
> exportPayloads (copy the construction from `one-kyc-client-zk-service.redact.test.ts`)
> and return `{ localDraft, workflow, exportPayloads, tokenValue }` where
> `tokenValue` is one known PII value present in `approvedValues`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd hushh-webapp && npx vitest run __tests__/services/one-kyc-client-zk-service.redraft-llm.test.ts`
Expected: FAIL — `runLlmRedraft` is not exported.

- [ ] **Step 3: Extend the renderer import**

In `hushh-webapp/lib/services/one-kyc-client-zk-service.ts`, add `renderLlmRedraftHtml` to the existing import from the renderer module `hushh-webapp/lib/services/one-kyc-approved-disclosure-renderer.ts` (the import that already pulls `redraftTransformFromInstructions`, `buildApprovedDisclosureHtml`, etc.):

```ts
import {
  APPROVED_DISCLOSURE_FORMATTER_CONTRACT_ID,
  buildApprovedDisclosureHtml,
  buildApprovedDisclosurePlainText,
  redraftTransformFromInstructions,
  renderLlmRedraftHtml,
  type ApprovedDisclosureRenderModel,
  type RedraftTransform,
  type RenderFact,
  type RenderSection,
} from "@/lib/services/one-kyc-approved-disclosure-renderer";
```

- [ ] **Step 4: Implement `runLlmRedraft`**

In `hushh-webapp/lib/services/one-kyc-client-zk-service.ts`, after the existing LLM helpers (`splitDraftTemplate` / `reassembleDraftTemplate`, ~line 1730), add:

```ts
export type LlmRedraftResult =
  | { ok: true; draft: KycDraftBuildResult }
  | { ok: false; errorCode: "TOKEN_INTEGRITY" | "FIELD_SET_CHANGED" };

/**
 * LLM-only KYC redraft orchestrator (zero-knowledge).
 *
 * Pipeline: split off the fixed framing (opening + signature) so only the middle
 * content is rewritten; redact every PII value to a token (map stays local);
 * call the injected LLM rewrite; verify token integrity (guardrail 1); re-substitute
 * real values and reassemble the framing; re-run buildDraft and confirm the
 * consented field-key set is unchanged (guardrail 2); render the LLM output into
 * the same themed email shell. Both guardrails fail closed — the caller keeps the
 * prior draft. The PII map and real values never leave the browser.
 */
export async function runLlmRedraft(params: {
  localDraft: KycDraftBuildResult;
  instruction: string;
  workflow: OneKycWorkflow;
  exportPayloads: Parameters<typeof OneKycClientZkService.buildDraft>[0]["exportPayloads"];
  llmRewrite: KycLlmRewriteCallable;
}): Promise<LlmRedraftResult> {
  const { localDraft, instruction, workflow, exportPayloads, llmRewrite } = params;

  // 0. Preserve framing: rewrite only the middle content.
  const templateSplit = splitDraftTemplate({
    body: localDraft.body,
    renderModel: localDraft.renderModel,
  });

  // 1. Redact: PII -> tokens; map stays in the browser.
  const { tokenizedTemplate, tokenMap } = redactDraftForLlm({
    body: templateSplit.content,
    approvedValues: localDraft.approvedValues,
  });

  // 2. Rewrite through the injected callable (server Gemini proxy by default).
  const rewrittenTemplate = await llmRewrite(tokenizedTemplate, instruction);

  // 3. Token-integrity gate (guardrail 1) — fail closed.
  if (!validateTokenIntegrity(tokenizedTemplate, rewrittenTemplate, tokenMap)) {
    return { ok: false, errorCode: "TOKEN_INTEGRITY" };
  }

  // 4. Re-substitute real values locally, then reassemble around the framing.
  const resubstitutedContent = resubstituteDraft(rewrittenTemplate, tokenMap);
  const resubstitutedBody = templateSplit.matched
    ? reassembleDraftTemplate({
        opening: templateSplit.opening,
        content: resubstitutedContent,
        signature: templateSplit.signature,
      })
    : resubstitutedContent;

  // 5. Field re-validation (guardrail 2): consented field set must be unchanged.
  const revalidatedDraft = await OneKycClientZkService.buildDraft({
    workflow,
    exportPayloads,
  });
  const beforeKeys = new Set(Object.keys(localDraft.approvedValues));
  const afterKeys = new Set(Object.keys(revalidatedDraft.approvedValues));
  const keysMatch =
    beforeKeys.size === afterKeys.size &&
    [...beforeKeys].every((key) => afterKeys.has(key));
  if (!keysMatch) {
    return { ok: false, errorCode: "FIELD_SET_CHANGED" };
  }

  // 6. Build the LLM draft. body AND htmlBody both reflect the LLM output;
  //    htmlBody is re-derived from the resubstituted plaintext via
  //    renderLlmRedraftHtml so the preview/sent email stays visually consistent.
  const llmHtmlBody = renderLlmRedraftHtml(resubstitutedBody);
  const llmDraftHash = await sha256Hex(resubstitutedBody);
  return {
    ok: true,
    draft: {
      ...revalidatedDraft,
      body: resubstitutedBody,
      htmlBody: llmHtmlBody,
      draftHash: llmDraftHash,
    },
  };
}
```

> Verify the exact `buildDraft` parameter object shape in this file. If `buildDraft`
> takes `{ workflow, exportPayloads }` (it does on the regex path), the call above
> is correct. If property names differ, match them — do not invent.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd hushh-webapp && npx vitest run __tests__/services/one-kyc-client-zk-service.redraft-llm.test.ts`
Expected: PASS (happy path + both guardrail fallbacks).

- [ ] **Step 6: Typecheck**

Run: `cd hushh-webapp && npx tsc --noEmit`
Expected: no new errors from this file.

- [ ] **Step 7: Commit**

```bash
git add hushh-webapp/lib/services/one-kyc-client-zk-service.ts hushh-webapp/__tests__/services/one-kyc-client-zk-service.redraft-llm.test.ts
git commit -m "feat(kyc): runLlmRedraft orchestrator with fail-closed guardrails"
```

---

## Task 6: Frontend — wire `runLlmRedraft` into the page (LLM-only)

Replace the regex redraft block in `runAction("redraft")` so every redraft uses
the LLM pipeline. This branch has **no** `useAiRedraft` state and **no** "Rewrite
mode" UI to remove (confirmed absent) — this is purely a swap of the redraft block.

**Files:**
- Modify: `hushh-webapp/app/one/kyc/page.tsx` (import + the `if (action === "redraft") { ... }` block in `runAction`, ~lines 988–1038)

**Interfaces:**
- Consumes: `runLlmRedraft`, `OneKycService.redraftWithLlm` (Tasks 4–5).

- [ ] **Step 1: Add the import**

In `hushh-webapp/app/one/kyc/page.tsx`, extend the existing import from
`@/lib/services/one-kyc-client-zk-service` (currently `effectiveOneKycRequiredFields`,
`OneKycClientZkService`, `type KycDraftBuildResult`) to add `runLlmRedraft`:

```ts
import {
  effectiveOneKycRequiredFields,
  OneKycClientZkService,
  runLlmRedraft,
  type KycDraftBuildResult,
} from "@/lib/services/one-kyc-client-zk-service";
```

- [ ] **Step 2: Replace the redraft block**

In `runAction`, replace the entire current redraft block — from `if (action === "redraft") {` through its closing `return;` (the block that calls `OneKycService.redraft(...)` then `updateWorkflow`/`buildDraft`) — with:

```ts
        if (action === "redraft") {
          if (!localDraft) {
            setError("Prepare the email draft before revising it.");
            return;
          }
          const exportPayloads = localExportPayloads[workflow.workflow_id] || [];
          const result = await runLlmRedraft({
            localDraft,
            instruction: redraftInstructions.trim(),
            workflow,
            exportPayloads,
            llmRewrite: (tokenizedTemplate, instruction) =>
              OneKycService.redraftWithLlm({
                ...input,
                tokenizedTemplate,
                instruction,
              }).then((response) => response.rewritten_template),
          });
          if (!result.ok) {
            setError(
              result.errorCode === "TOKEN_INTEGRITY"
                ? "AI output failed token integrity check — using original draft. Try again or use a simpler instruction."
                : "AI output altered the consented field set — using original draft. Try again.",
            );
            setRedraftInstructions("");
            return;
          }
          setLocalDrafts((current) => ({
            ...current,
            [workflow.workflow_id]: result.draft,
          }));
          setRedraftInstructions("");
          return;
        }
```

> `input` here is the existing `{ userId, vaultOwnerToken, workflowId }` object
> already built at the top of the `try` block. `localExportPayloads`,
> `setLocalDrafts`, `setRedraftInstructions`, and `setError` are existing state
> setters in this component — confirm the names by reading the surrounding code.

- [ ] **Step 3: Typecheck**

Run: `cd hushh-webapp && npx tsc --noEmit`
Expected: no new errors. (If `OneKycService.redraft` or `buildDraft`-with-instructions is now reported as unused, that is expected — leave the regex path code in place per Global Constraints.)

- [ ] **Step 4: Run the focused frontend tests + lint**

Run: `cd hushh-webapp && npx vitest run __tests__/services/one-kyc-service.test.ts __tests__/services/one-kyc-client-zk-service.redraft-llm.test.ts __tests__/services/one-kyc-client-zk-service.redact.test.ts`
Expected: PASS.

Run: `cd hushh-webapp && npx next lint --file app/one/kyc/page.tsx` (or the repo's configured lint command for this file)
Expected: no new errors.

- [ ] **Step 5: Manual smoke (human verification)**

Start the webapp, open `/one/kyc`, take a workflow to a ready draft, enter a
free-form redraft instruction, and confirm: (a) the preview updates with the
rewritten text, (b) real PII values appear correctly (no `{{Fn}}` leak), (c) the
network call goes to `/redraft-llm` (not `/redraft`), and (d) approve/send still
requires human review. This step is a checkpoint, not automated.

- [ ] **Step 6: Commit**

```bash
git add hushh-webapp/app/one/kyc/page.tsx
git commit -m "feat(kyc): route redraft action through LLM-only pipeline"
```

---

## Task 7: Full suite + final verification

**Files:** none (verification only).

- [ ] **Step 1: Backend suite (KYC-relevant)**

Run: `cd consent-protocol && .venv/bin/python -m pytest tests/services/test_one_email_kyc_service_llm.py tests/services/test_one_email_kyc_service.py tests/test_one_email_routes.py tests/test_kyc_redraft_llm_scope.py -v`
Expected: all PASS.

- [ ] **Step 2: Frontend suite (KYC-relevant)**

Run: `cd hushh-webapp && npx vitest run __tests__/services/one-kyc-service.test.ts __tests__/services/one-kyc-client-zk-service.test.ts __tests__/services/one-kyc-client-zk-service.redact.test.ts __tests__/services/one-kyc-client-zk-service.redraft-llm.test.ts __tests__/services/one-kyc-approved-disclosure-renderer.test.ts`
Expected: all PASS.

- [ ] **Step 3: Confirm constraints held**

Verify by inspection: `draft_body` is never set in `redraft_llm` (only metadata); the regex `/redraft` route/method/client and `redraftTransformFromInstructions` and `isKeywordOnlyInstruction` are unchanged; consolidation commits are intact (`git log --oneline -8`).

- [ ] **Step 4: Final commit (if any verification fixups were needed)**

```bash
git add -A && git commit -m "test(kyc): verify LLM-only redraft suite green" || echo "nothing to commit"
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** consent scope (T1), backend method + ZK/no-draft_body + audit hash (T2), route + model (T3), client API (T4), client orchestrator + both guardrails (T5), page wiring LLM-only (T6), suite verification (T7). Kept-as-is items (regex path, `redraftTransformFromInstructions`, `isKeywordOnlyInstruction`) are enforced via Global Constraints + T6 Step 3 / T7 Step 3. ✓
- **Placeholder scan:** no unresolved placeholder markers; the one externally-sourced artifact (backend test file) is fetched via an exact `git show` command; test-scaffolding (`makeFixture`, route-test helpers) is described with the exact reference file to copy from, because the precise fixture shape must be read from the live file rather than guessed. ✓
- **Type consistency:** `redraftWithLlm` body keys (`tokenized_template`, `instruction`) match `LlmRedraftRequest` and the service signature; `LlmRedraftResult` error codes (`TOKEN_INTEGRITY`, `FIELD_SET_CHANGED`) are used identically in T5 and T6; `runLlmRedraft` params match its call site. ✓
