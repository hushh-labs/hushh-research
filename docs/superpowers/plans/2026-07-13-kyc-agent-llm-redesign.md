# KYC Agent LLM Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the One Email KYC brains so an LLM that sees the real request (and, after consent, the real data) maps each request to the correct PKM domain, extracts the exact fields requested, and composes the reply — replacing the keyword-regex classifier that mis-routed a hotel-booking request to the travel domain.

**Architecture:** Two server-side Gemini passes around a preserved human confirm gate. **Pass 1 (routing):** request text + sanitized `pkm_index` (no values) → proposed domain + fields + reasoning. User confirms (this is the consent act). **Pass 2 (extract+draft):** client decrypts only the approved domain, sends full values → LLM returns structured extracted values + composed draft. Deterministic renderer is demoted to HTML formatter/fallback. All existing Gmail/consent/send plumbing is kept.

**Tech Stack:** Python 3 (FastAPI, Pydantic v2, `google-genai` Vertex client), Next.js/TypeScript (React), Vitest (frontend), pytest (backend).

## Global Constraints

- **LLM determinism:** all KYC LLM calls use `temperature=KAI_LLM_TEMPERATURE` (`= 0.0`, `consent-protocol/hushh_mcp/constants.py:328`) and `max_output_tokens=KAI_LLM_MAX_OUTPUT_TOKENS_DEFAULT` (`= 16384`, line 330).
- **Structured output:** mirror `pkm_agent_lab_service._run_agent_contract` (`consent-protocol/hushh_mcp/services/pkm_agent_lab_service.py:1353-1410`) — `types.GenerateContentConfig(temperature=0.0, response_mime_type="application/json", response_schema=<dict>, automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True))`, read `response.parsed`, fall back to `json.loads(response.text)`. Schemas use uppercase type strings (`"OBJECT"`, `"STRING"`, `"ARRAY"`, `"NUMBER"`) and `enum` lists.
- **Shared LLM client reuse:** never instantiate a new client. Import from `hushh_mcp.operons.kai.llm` exactly as `one_email_kyc_service.py:43-49` does; guard with `_require_gemini_ready()`; on unavailability return `_gemini_unavailable_payload(<msg>)`.
- **Consent is DB-aware:** gate every PII-exposing endpoint with `validate_token_with_db(consent_token, ConsentScope.AGENT_KYC_DISCLOSE_LLM)` (pattern: `redraft_llm` step 1, `one_email_kyc_service.py:3914-3919`).
- **`draft_body` stays NULL server-side.** Pass 2 and redraft return the composed body to the client transiently; never persist it. Log only SHA-256 hashes, never bodies (pattern: `one_email_kyc_service.py:3990-3997`).
- **Fail-closed:** any guardrail failure (low confidence, malformed JSON, subset violation, provenance violation, scope expansion) keeps the prior state and surfaces an error; never disclose on doubt.
- **No `Co-Authored-By: Claude` trailer** in commits. Append `Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>` (DCO).

## Reference: files this plan touches

Backend (`consent-protocol/`):
- `hushh_mcp/constants.py` — scope enum + KAI LLM constants
- `hushh_mcp/consent/scope_helpers.py` — `_AGENT_SCOPE_MAP` (line 53), descriptor map (line 200)
- `hushh_mcp/consent/scope_bundles.py`
- `hushh_mcp/services/one_email_kyc_service.py` — the engine (`OneEmailKycService`, line 1086)
- `api/routes/one/email.py` — routes (`APIRouter(prefix="/api/one")`, line 30)
- `hushh_mcp/agents/kyc/agent.yaml` — declared scopes

Frontend (`hushh-webapp/`):
- `lib/services/one-kyc-service.ts` — `OneKycService` (static methods, `apiJson` + `authHeaders`)
- `lib/services/one-kyc-client-zk-service.ts` — `buildDraft`, `extractApprovedValues`, `runLlmRedraft`, `decryptScopedExport`
- `lib/services/one-kyc-approved-disclosure-renderer.ts` — renderer (formatter/fallback)
- `app/one/kyc/page.tsx` — the `/one/kyc` state machine + UI

Docs: `SECURITY.md`, `docs/reference/agent-development.md`, `docs/reference/architecture/one-email-kyc.md`.

## Shared contracts (types every task depends on)

**Pass 1 routing output** (`_KYC_ROUTING_SCHEMA`, returned by `classify_kyc_request`):
```json
{
  "classification": "kyc" | "kyc_financial" | "financial" | "unsupported",
  "requested_items": [
    { "label": "Full name", "domain": "identity", "scope": "attr.identity.name",
      "rationale": "personal info to confirm booking" }
  ],
  "primary_domains": ["identity"],
  "confidence": 0.0,
  "reasoning": "..."
}
```

**Pass 2 extract+draft output** (`_KYC_EXTRACT_DRAFT_SCHEMA`, returned by `extract_and_draft`):
```json
{
  "extracted": [ { "scope": "attr.identity.name", "label": "Full name", "value": "Jane A. Doe" } ],
  "missing": ["attr.identity.passport_number"],
  "draft": { "subject": "...", "body": "..." }
}
```

**New workflow metadata keys** (stored on the workflow row `metadata`):
- `kyc_proposal`: the full Pass-1 output dict (drives the confirm UI).
- `kyc_confirmed_items`: the subset of `requested_items` the user approved.

**New consent scope:** `agent.kyc.disclose.llm` → `ConsentScope.AGENT_KYC_DISCLOSE_LLM`.

**New workflow status:** `needs_confirm` (added to `_KYC_WORKFLOW_STATES`).

---

# Phase 1 — Consent scope + Pass 1 routing (fixes the reported bug)

### Task 1: Register the `agent.kyc.disclose.llm` consent scope

**Files:**
- Modify: `consent-protocol/hushh_mcp/constants.py:51`
- Modify: `consent-protocol/hushh_mcp/consent/scope_helpers.py:58` and `:218-223`
- Test: `consent-protocol/tests/test_kyc_disclose_llm_scope.py` (create)

**Interfaces:**
- Produces: `ConsentScope.AGENT_KYC_DISCLOSE_LLM` (value `"agent.kyc.disclose.llm"`), resolvable via `scope_helpers.resolve_scope("agent.kyc.disclose.llm")`.

- [ ] **Step 1: Write the failing test**

Create `consent-protocol/tests/test_kyc_disclose_llm_scope.py`:
```python
from hushh_mcp.constants import ConsentScope
from hushh_mcp.consent.scope_helpers import resolve_scope


def test_disclose_llm_scope_enum_value():
    assert ConsentScope.AGENT_KYC_DISCLOSE_LLM.value == "agent.kyc.disclose.llm"


def test_disclose_llm_scope_resolves():
    assert resolve_scope("agent.kyc.disclose.llm") is ConsentScope.AGENT_KYC_DISCLOSE_LLM
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd consent-protocol && python -m pytest tests/test_kyc_disclose_llm_scope.py -v`
Expected: FAIL with `AttributeError: AGENT_KYC_DISCLOSE_LLM`.

- [ ] **Step 3: Add the enum member**

In `consent-protocol/hushh_mcp/constants.py`, after line 51 (`AGENT_KYC_REDRAFT_LLM = "agent.kyc.redraft.llm"`):
```python
    AGENT_KYC_DISCLOSE_LLM = "agent.kyc.disclose.llm"
```

- [ ] **Step 4: Register in the resolver map + descriptor**

In `consent-protocol/hushh_mcp/consent/scope_helpers.py`, add to `_AGENT_SCOPE_MAP` after line 58:
```python
        "agent.kyc.disclose.llm": ConsentScope.AGENT_KYC_DISCLOSE_LLM,
```
And add the descriptor after the `agent.kyc.redraft.llm` block (line 223):
```python
        "agent.kyc.disclose.llm": {
            "label": "KYC Data Disclosure via AI",
            "description": "Allow One to send approved data to the AI to draft this KYC reply",
            "icon_name": "id-card",
            "color_hex": "#6366F1",
        },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd consent-protocol && python -m pytest tests/test_kyc_disclose_llm_scope.py -v`
Expected: PASS (2 passed).

- [ ] **Step 6: Update the agent manifest**

In `consent-protocol/hushh_mcp/agents/kyc/agent.yaml`, add `agent.kyc.disclose.llm` to the optional scopes list alongside `agent.kyc.redraft.llm`.

- [ ] **Step 7: Commit**

```bash
git add consent-protocol/hushh_mcp/constants.py consent-protocol/hushh_mcp/consent/scope_helpers.py consent-protocol/hushh_mcp/agents/kyc/agent.yaml consent-protocol/tests/test_kyc_disclose_llm_scope.py
git commit -m "feat(kyc): add agent.kyc.disclose.llm consent scope

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

### Task 2: Pass 1 routing LLM method (`classify_kyc_request`)

**Files:**
- Modify: `consent-protocol/hushh_mcp/services/one_email_kyc_service.py` (add method + schema near the deterministic detectors, ~line 2001)
- Test: `consent-protocol/tests/services/test_one_email_kyc_routing.py` (create)

**Interfaces:**
- Consumes: shared kai client globals already imported at `one_email_kyc_service.py:43-49`; `KAI_LLM_TEMPERATURE`, `KAI_LLM_MAX_OUTPUT_TOKENS_DEFAULT`.
- Produces: `async OneEmailKycService.classify_kyc_request(self, *, subject: str, body: str, pkm_index: dict[str, Any]) -> dict[str, Any]` returning the Pass-1 routing dict (Shared contracts), or `_gemini_unavailable_payload(...)` if Gemini is down.

- [ ] **Step 1: Write the failing test**

Create `consent-protocol/tests/services/test_one_email_kyc_routing.py`:
```python
import json
import pytest
from unittest.mock import MagicMock, patch

from hushh_mcp.services.one_email_kyc_service import get_one_email_kyc_service


class _FakeResponse:
    def __init__(self, parsed):
        self.parsed = parsed
        self.text = json.dumps(parsed)


@pytest.mark.asyncio
async def test_classify_routes_hotel_booking_to_identity():
    service = get_one_email_kyc_service()
    routing = {
        "classification": "kyc",
        "requested_items": [
            {"label": "Full name", "domain": "identity",
             "scope": "attr.identity.name", "rationale": "personal info to confirm booking"}
        ],
        "primary_domains": ["identity"],
        "confidence": 0.94,
        "reasoning": "Asks for personal info to confirm a hotel booking -> identity, not travel.",
    }
    fake_client = MagicMock()
    fake_client.aio.models.generate_content = MagicMock(
        return_value=_FakeResponse(routing)
    )

    async def _fake_await(coro):
        return coro

    with patch.object(service, "_llm_generate_structured", return_value=routing) as gen:
        result = await service.classify_kyc_request(
            subject="Confirm your hotel booking",
            body="Please provide your information so we can confirm your hotel booking.",
            pkm_index={"available_domains": ["identity", "travel"],
                       "domain_summaries": {"travel": "flight search history",
                                            "identity": "name, dob, address"}},
        )
    assert result["primary_domains"] == ["identity"]
    assert result["classification"] == "kyc"
    gen.assert_called_once()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd consent-protocol && python -m pytest tests/services/test_one_email_kyc_routing.py -v`
Expected: FAIL with `AttributeError: ... has no attribute 'classify_kyc_request'` (and `_llm_generate_structured`).

- [ ] **Step 3: Add the structured-output helper + schema + method**

In `one_email_kyc_service.py`, add near the top-level constants (after the existing module imports):
```python
_KYC_ROUTING_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "classification": {
            "type": "STRING",
            "enum": ["kyc", "kyc_financial", "financial", "unsupported"],
        },
        "requested_items": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "label": {"type": "STRING"},
                    "domain": {"type": "STRING"},
                    "scope": {"type": "STRING"},
                    "rationale": {"type": "STRING"},
                },
                "required": ["label", "domain", "scope", "rationale"],
            },
        },
        "primary_domains": {"type": "ARRAY", "items": {"type": "STRING"}},
        "confidence": {"type": "NUMBER"},
        "reasoning": {"type": "STRING"},
    },
    "required": ["classification", "requested_items", "primary_domains", "confidence", "reasoning"],
}
```

Add a shared structured-output helper method on `OneEmailKycService` (mirrors `_run_agent_contract`):
```python
    async def _llm_generate_structured(
        self,
        *,
        prompt: str,
        response_schema: dict[str, Any],
        timeout_seconds: float = 30.0,
    ) -> dict[str, Any] | None:
        """Run a structured (JSON-schema) Gemini call on the shared kai client.

        Returns the parsed dict, or None on unavailability/parse failure so
        callers fail closed.
        """
        if not _require_gemini_ready():
            return None
        client = _gemini_client if _gemini_client is not None else _kai_llm._gemini_client
        model_name = _gemini_model_name or _kai_llm._gemini_model_name
        types_mod = _genai_types if _genai_types is not None else _kai_llm.types
        if client is None or types_mod is None:
            return None
        config = types_mod.GenerateContentConfig(
            temperature=KAI_LLM_TEMPERATURE,
            max_output_tokens=KAI_LLM_MAX_OUTPUT_TOKENS_DEFAULT,
            response_mime_type="application/json",
            response_schema=response_schema,
            automatic_function_calling=types_mod.AutomaticFunctionCallingConfig(disable=True),
        )

        def _invoke() -> Any:
            return client.models.generate_content(
                model=model_name, contents=prompt, config=config
            )

        loop = asyncio.get_running_loop()
        response = await loop.run_in_executor(None, _invoke)
        parsed = response.parsed if isinstance(getattr(response, "parsed", None), dict) else None
        if parsed is None:
            try:
                parsed = json.loads((getattr(response, "text", None) or "").strip() or "{}")
            except json.JSONDecodeError:
                return None
        return parsed if isinstance(parsed, dict) else None
```

Add the routing method:
```python
    async def classify_kyc_request(
        self, *, subject: str, body: str, pkm_index: dict[str, Any]
    ) -> dict[str, Any]:
        """Pass 1 — route the request to the correct PKM domain + fields.

        Sends the request text and the SANITIZED pkm_index (domain names +
        summaries, NO raw values) to Gemini. Never sees real data. Replaces the
        keyword detectors (_looks_like_kyc / _detect_scope_candidates /
        _extract_required_fields).
        """
        if not _require_gemini_ready():
            return _gemini_unavailable_payload("Gemini unavailable for KYC routing")
        prompt = (
            "You classify an inbound email that requests personal data, and map it "
            "to the correct domain(s) in the user's personal knowledge model.\n"
            "Decide WHAT DATA is being requested, not which keywords appear. "
            "Example: 'provide your information to confirm a hotel booking' is a "
            "request for IDENTITY data (name, address), NOT travel itinerary data.\n\n"
            f"Available domains and summaries (NO values):\n{json.dumps(pkm_index)}\n\n"
            f"Email subject: {_truncate(subject, 500)}\n"
            f"Email body: {_truncate(body, 4000)}\n\n"
            "Return the routing JSON. For each requested item, pick the single most "
            "appropriate domain and scope. Set confidence 0..1. If the email does not "
            "request personal data, set classification='unsupported' and requested_items=[]."
        )
        result = await self._llm_generate_structured(
            prompt=prompt, response_schema=_KYC_ROUTING_SCHEMA
        )
        if result is None:
            return _gemini_unavailable_payload("KYC routing produced no parseable result")
        return result
```

Ensure `_genai_types` and `json` are imported at module top (add `import json` if absent; add `from hushh_mcp.operons.kai.llm import types as _genai_types` alongside the existing kai imports at line 43-49 — if `_genai_types` is already referenced by `redraft_llm`, it already exists).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd consent-protocol && python -m pytest tests/services/test_one_email_kyc_routing.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add consent-protocol/hushh_mcp/services/one_email_kyc_service.py consent-protocol/tests/services/test_one_email_kyc_routing.py
git commit -m "feat(kyc): add LLM Pass 1 routing (classify_kyc_request)

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

### Task 3: Wire Pass 1 into intake → `needs_confirm` proposal state

**Files:**
- Modify: `consent-protocol/hushh_mcp/services/one_email_kyc_service.py` — `_process_message` (~line 1795) and the `_KYC_WORKFLOW_STATES` set; add `_load_pkm_index_for_user`
- Test: `consent-protocol/tests/services/test_one_email_kyc_intake_routing.py` (create)

**Interfaces:**
- Consumes: `classify_kyc_request` (Task 2).
- Produces: after intake, a workflow with `status="needs_confirm"` and `metadata["kyc_proposal"]` = the Pass-1 dict; a confidence floor constant `_KYC_ROUTING_CONFIDENCE_FLOOR = 0.5`.

- [ ] **Step 1: Write the failing test**

Create `consent-protocol/tests/services/test_one_email_kyc_intake_routing.py`:
```python
import pytest
from unittest.mock import AsyncMock, patch

from hushh_mcp.services.one_email_kyc_service import get_one_email_kyc_service


@pytest.mark.asyncio
async def test_intake_sets_needs_confirm_with_proposal():
    service = get_one_email_kyc_service()
    proposal = {
        "classification": "kyc",
        "requested_items": [
            {"label": "Full name", "domain": "identity",
             "scope": "attr.identity.name", "rationale": "identity check"}
        ],
        "primary_domains": ["identity"],
        "confidence": 0.9,
        "reasoning": "identity request",
    }
    with patch.object(service, "classify_kyc_request",
                      new=AsyncMock(return_value=proposal)), \
         patch.object(service, "_load_pkm_index_for_user",
                      new=AsyncMock(return_value={"available_domains": ["identity"]})):
        workflow = await service._apply_routing_to_workflow(
            user_id="user-1",
            workflow={"workflow_id": "wf-1", "metadata": {}, "subject": "KYC",
                      "status": "processing"},
            subject="KYC", body="Please share your full name.",
        )
    assert workflow["status"] == "needs_confirm"
    assert workflow["metadata"]["kyc_proposal"]["primary_domains"] == ["identity"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd consent-protocol && python -m pytest tests/services/test_one_email_kyc_intake_routing.py -v`
Expected: FAIL (`_apply_routing_to_workflow` / `_load_pkm_index_for_user` missing).

- [ ] **Step 3: Add the confidence floor + status + helpers**

Add near the module constants:
```python
_KYC_ROUTING_CONFIDENCE_FLOOR = 0.5
```
Add `"needs_confirm"` to the `_KYC_WORKFLOW_STATES` set (search for its definition and add the string).

Add `_load_pkm_index_for_user` (reads the sanitized index — no values — via the existing PKM service/index route the service already has access to; if the service already fetches a PKM index elsewhere, reuse that call):
```python
    async def _load_pkm_index_for_user(self, user_id: str) -> dict[str, Any]:
        """Fetch the sanitized PKM discovery index (domains + summaries, NO values)."""
        index = await self._pkm_index_provider(user_id)  # existing injected/available provider
        if not isinstance(index, dict):
            return {"available_domains": [], "domain_summaries": {}}
        return {
            "available_domains": index.get("available_domains", []),
            "domain_summaries": index.get("domain_summaries", {}),
            "computed_tags": index.get("computed_tags", []),
        }
```
> Implementation note for the executor: locate how the service currently reads `pkm_index` (grep `pkm_index` / `PersonalKnowledgeModelService` in the file). Wire `_pkm_index_provider` to that existing accessor rather than adding a new dependency.

Add the routing application:
```python
    async def _apply_routing_to_workflow(
        self, *, user_id: str, workflow: dict[str, Any], subject: str, body: str
    ) -> dict[str, Any]:
        pkm_index = await self._load_pkm_index_for_user(user_id)
        proposal = await self.classify_kyc_request(
            subject=subject, body=body, pkm_index=pkm_index
        )
        metadata = dict(workflow.get("metadata") or {})
        if proposal.get("fallback") or proposal.get("classification") == "unsupported":
            return self._update_workflow(
                workflow["workflow_id"],
                status="blocked",
                last_error_code="kyc_routing_unavailable",
                last_error_message="One could not determine what this request needs. Review manually.",
                metadata={**metadata, "kyc_proposal": proposal},
            )
        if float(proposal.get("confidence") or 0.0) < _KYC_ROUTING_CONFIDENCE_FLOOR:
            metadata["kyc_low_confidence"] = True
        return self._update_workflow(
            workflow["workflow_id"],
            status="needs_confirm",
            last_error_code=None,
            last_error_message=None,
            metadata={**metadata, "kyc_proposal": proposal},
        )
```

Replace the deterministic classification/scope-detection block inside `_process_message` (the calls to `_looks_like_kyc`, `_detect_scope_candidates`, `_extract_required_fields`) with a call to `_apply_routing_to_workflow(...)`. Leave sender-match and client-connector gating **before** it untouched.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd consent-protocol && python -m pytest tests/services/test_one_email_kyc_intake_routing.py -v`
Expected: PASS.

- [ ] **Step 5: Run the existing KYC service suite for regressions**

Run: `cd consent-protocol && python -m pytest tests/services/test_one_email_kyc_service.py -v`
Expected: some tests asserting the OLD deterministic classification will now fail — update them to the new `needs_confirm` proposal flow (or mark the removed-detector tests deleted). Fix each until green.

- [ ] **Step 6: Commit**

```bash
git add consent-protocol/hushh_mcp/services/one_email_kyc_service.py consent-protocol/tests/services/test_one_email_kyc_intake_routing.py consent-protocol/tests/services/test_one_email_kyc_service.py
git commit -m "feat(kyc): route intake through LLM Pass 1 into needs_confirm

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

### Task 4: Confirm endpoint — approve proposed items → create consent requests

**Files:**
- Modify: `consent-protocol/api/routes/one/email.py` — add `ConfirmProposalRequest` + `POST /kyc/workflows/{id}/confirm-proposal`
- Modify: `consent-protocol/hushh_mcp/services/one_email_kyc_service.py` — add `confirm_proposal`
- Test: `consent-protocol/tests/services/test_one_email_kyc_confirm.py` (create)

**Interfaces:**
- Consumes: workflow with `status="needs_confirm"` + `metadata["kyc_proposal"]`.
- Produces: `async confirm_proposal(self, *, user_id, workflow_id, approved_scopes: list[str]) -> dict` — validates each approved scope is a subset of the proposal's `requested_items[].scope`, stores `kyc_confirmed_items`, then delegates to the existing `select_scopes(...)` path (line 2702) to create per-scope consent requests. Reuses `_ensure_consent_request`.

- [ ] **Step 1: Write the failing test**

Create `consent-protocol/tests/services/test_one_email_kyc_confirm.py`:
```python
import pytest
from unittest.mock import AsyncMock, patch

from hushh_mcp.services.one_email_kyc_service import (
    get_one_email_kyc_service, OneEmailKycError,
)


@pytest.mark.asyncio
async def test_confirm_rejects_scope_outside_proposal():
    service = get_one_email_kyc_service()
    workflow = {
        "workflow_id": "wf-1", "status": "needs_confirm",
        "metadata": {"kyc_proposal": {"requested_items": [
            {"scope": "attr.identity.name", "domain": "identity", "label": "Full name",
             "rationale": "x"}]}},
    }
    with patch.object(service, "get_workflow", new=AsyncMock(return_value=workflow)):
        with pytest.raises(OneEmailKycError) as exc:
            await service.confirm_proposal(
                user_id="u1", workflow_id="wf-1",
                approved_scopes=["attr.travel.itinerary"],
            )
    assert exc.value.code == "ONE_KYC_CONFIRM_SCOPE_INVALID"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd consent-protocol && python -m pytest tests/services/test_one_email_kyc_confirm.py -v`
Expected: FAIL (`confirm_proposal` missing).

- [ ] **Step 3: Implement `confirm_proposal`**

In `one_email_kyc_service.py`:
```python
    async def confirm_proposal(
        self, *, user_id: str, workflow_id: str, approved_scopes: list[str]
    ) -> dict[str, Any]:
        workflow = await self.get_workflow(user_id=user_id, workflow_id=workflow_id)
        if workflow.get("status") != "needs_confirm":
            raise OneEmailKycError(
                "This request is not awaiting confirmation.",
                status_code=409, code="ONE_KYC_NOT_AWAITING_CONFIRM",
            )
        proposal = (workflow.get("metadata") or {}).get("kyc_proposal") or {}
        proposed_scopes = {
            str(item.get("scope"))
            for item in proposal.get("requested_items", [])
            if item.get("scope")
        }
        approved = _dedupe(approved_scopes)
        invalid = [s for s in approved if s not in proposed_scopes]
        if not approved or invalid:
            raise OneEmailKycError(
                "Approved data must be a subset of what One proposed.",
                status_code=400, code="ONE_KYC_CONFIRM_SCOPE_INVALID",
                payload={"invalid_scopes": invalid, "proposed_scopes": sorted(proposed_scopes)},
            )
        confirmed_items = [
            item for item in proposal.get("requested_items", [])
            if item.get("scope") in approved
        ]
        self._update_workflow(
            workflow_id,
            metadata={**(workflow.get("metadata") or {}), "kyc_confirmed_items": confirmed_items},
        )
        # Reuse the existing per-scope consent-request creation path.
        return await self.select_scopes(
            user_id=user_id, workflow_id=workflow_id, selected_scopes=approved,
        )
```
> Note: `select_scopes` validates against `metadata["candidate_scopes"]` if present. In `_apply_routing_to_workflow`, also write `candidate_scopes` derived from the proposal so `select_scopes` accepts them. Add to the `_update_workflow` metadata in Task 3 Step 3:
> ```python
> "candidate_scopes": [
>     {"scope": i["scope"], "domain": i["domain"], "label": i["label"],
>      "description": i.get("rationale", ""), "reason": i.get("rationale", "")}
>     for i in proposal.get("requested_items", [])
> ],
> ```

- [ ] **Step 4: Add the route**

In `api/routes/one/email.py`, after the request models (~line 75):
```python
class ConfirmProposalRequest(WorkflowUserRequest):
    approved_scopes: list[str] = Field(min_length=1, max_length=8)
```
After the redraft routes (~line 587):
```python
@router.post("/kyc/workflows/{workflow_id}/confirm-proposal")
async def one_kyc_confirm_proposal(
    workflow_id: str,
    payload: ConfirmProposalRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    _verified_vault_user_id(token_data, payload.user_id)
    try:
        return await _service().confirm_proposal(
            user_id=payload.user_id,
            workflow_id=workflow_id,
            approved_scopes=payload.approved_scopes,
        )
    except Exception as exc:
        logger.exception(
            "one.kyc.confirm_proposal_failed user_id=%s workflow_id=%s",
            payload.user_id, workflow_id,
        )
        raise _to_http_exception(exc, operation="confirm_proposal") from exc
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd consent-protocol && python -m pytest tests/services/test_one_email_kyc_confirm.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add consent-protocol/hushh_mcp/services/one_email_kyc_service.py consent-protocol/api/routes/one/email.py consent-protocol/tests/services/test_one_email_kyc_confirm.py
git commit -m "feat(kyc): add confirm-proposal endpoint gating consent to proposed scopes

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

### Task 5: Frontend — confirm UI (proposal + reasoning + approve/reject)

**Files:**
- Modify: `hushh-webapp/lib/services/one-kyc-service.ts` — add `confirmProposal`; extend `OneKycWorkflowStatus` + `OneKycWorkflow`
- Modify: `hushh-webapp/app/one/kyc/page.tsx` — render the `needs_confirm` proposal
- Test: `hushh-webapp/__tests__/services/one-kyc-service.confirm.test.ts` (create)

**Interfaces:**
- Consumes: backend `POST /api/one/kyc/workflows/{id}/confirm-proposal`.
- Produces: `OneKycService.confirmProposal({ userId, vaultOwnerToken, workflowId, approvedScopes }): Promise<OneKycWorkflow>`.

- [ ] **Step 1: Write the failing test**

Create `hushh-webapp/__tests__/services/one-kyc-service.confirm.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/services/api-client", () => ({
  apiJson: vi.fn(async () => ({ workflow_id: "wf-1", status: "needs_scope" })),
}));

import { apiJson } from "@/lib/services/api-client";
import { OneKycService } from "@/lib/services/one-kyc-service";

describe("OneKycService.confirmProposal", () => {
  beforeEach(() => vi.clearAllMocks());

  it("POSTs approved_scopes to confirm-proposal", async () => {
    await OneKycService.confirmProposal({
      userId: "u1", vaultOwnerToken: "tok", workflowId: "wf-1",
      approvedScopes: ["attr.identity.name"],
    });
    expect(apiJson).toHaveBeenCalledWith(
      "/api/one/kyc/workflows/wf-1/confirm-proposal",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ user_id: "u1", approved_scopes: ["attr.identity.name"] }),
      }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hushh-webapp && npx vitest run __tests__/services/one-kyc-service.confirm.test.ts`
Expected: FAIL (`confirmProposal` not a function).

- [ ] **Step 3: Add the service method + types**

In `hushh-webapp/lib/services/one-kyc-service.ts`, add `"needs_confirm"` to the `OneKycWorkflowStatus` union (lines 7-15). Add to the `OneKycWorkflow` metadata typing a `kyc_proposal` field (mirror existing metadata typing). Add the method to the class:
```ts
  static confirmProposal({
    userId,
    vaultOwnerToken,
    workflowId,
    approvedScopes,
  }: AuthInput & {
    workflowId: string;
    approvedScopes: string[];
  }): Promise<OneKycWorkflow> {
    return apiJson<OneKycWorkflow>(
      `/api/one/kyc/workflows/${encodeURIComponent(workflowId)}/confirm-proposal`,
      {
        method: "POST",
        headers: authHeaders(vaultOwnerToken),
        body: JSON.stringify({ user_id: userId, approved_scopes: approvedScopes }),
      },
    );
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hushh-webapp && npx vitest run __tests__/services/one-kyc-service.confirm.test.ts`
Expected: PASS.

- [ ] **Step 5: Render the proposal in `page.tsx`**

Add a `shouldShowProposal` predicate (module-level, near line 244):
```tsx
function shouldShowProposal(workflow: OneKycWorkflow): boolean {
  return workflow.status === "needs_confirm" && Boolean(workflow.metadata?.kyc_proposal);
}
```
In the component body, render (when `selected && shouldShowProposal(selected)`) a `SettingsGroup title="What One will share"` that lists each `kyc_proposal.requested_items` item as a `SettingsRow` (label + rationale) with a checkbox bound to a `confirmSelection` state (default: all checked), shows `kyc_proposal.reasoning` as the group description, and renders two buttons: **Confirm** → `OneKycService.confirmProposal({ ...input, workflowId, approvedScopes: confirmSelection })` then refresh; **Reject** → existing `denyWorkflowConsent`/reject path. Mirror the existing `scopeCandidates` rendering block (lines 1731-1795) for structure and `toggleScope`-style state handling.

- [ ] **Step 6: Manual verification**

Follow `run-ios-sim` / webapp run to open `/one/kyc`, forward a KYC email, and confirm the proposal card shows the reasoning and correct domain. (Full E2E in Task 9.)

- [ ] **Step 7: Commit**

```bash
git add hushh-webapp/lib/services/one-kyc-service.ts hushh-webapp/app/one/kyc/page.tsx hushh-webapp/__tests__/services/one-kyc-service.confirm.test.ts
git commit -m "feat(kyc): render LLM proposal confirm gate in /one/kyc

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

# Phase 2 — Pass 2 extract + draft (LLM drafting)

### Task 6: Pass 2 backend — `extract_and_draft` + endpoint

**Files:**
- Modify: `consent-protocol/hushh_mcp/services/one_email_kyc_service.py` — add `_KYC_EXTRACT_DRAFT_SCHEMA` + `extract_and_draft`
- Modify: `consent-protocol/api/routes/one/email.py` — add `ExtractDraftRequest` + `POST /kyc/workflows/{id}/extract-draft`
- Test: `consent-protocol/tests/services/test_one_email_kyc_extract_draft.py` (create)

**Interfaces:**
- Consumes: `_llm_generate_structured` (Task 2); DB consent gate `validate_token_with_db(..., ConsentScope.AGENT_KYC_DISCLOSE_LLM)`.
- Produces: `async extract_and_draft(self, *, user_id, workflow_id, domain, domain_data: dict, approved_scopes: list[str], request_text: str, consent_token: str) -> dict` returning `{extracted, missing, draft}` (Shared contracts). Enforces the **subset invariant** (`extracted[].scope ⊆ approved_scopes`) and **value-provenance** (every non-trivial token in `draft.body` appears in an extracted value) — both fail-closed with distinct error codes.

- [ ] **Step 1: Write the failing test**

Create `consent-protocol/tests/services/test_one_email_kyc_extract_draft.py`:
```python
import pytest
from unittest.mock import AsyncMock, patch

from hushh_mcp.services.one_email_kyc_service import (
    get_one_email_kyc_service, OneEmailKycError,
)


@pytest.mark.asyncio
async def test_extract_draft_rejects_scope_outside_approved():
    service = get_one_email_kyc_service()
    llm_out = {
        "extracted": [
            {"scope": "attr.identity.name", "label": "Full name", "value": "Jane Doe"},
            {"scope": "attr.identity.passport", "label": "Passport", "value": "X123"},
        ],
        "missing": [],
        "draft": {"subject": "Re: KYC", "body": "My name is Jane Doe."},
    }
    workflow = {"workflow_id": "wf-1", "status": "waiting_on_user", "draft_status": "ready"}
    with patch.object(service, "get_workflow", new=AsyncMock(return_value=workflow)), \
         patch.object(service, "_llm_generate_structured", new=AsyncMock(return_value=llm_out)), \
         patch("hushh_mcp.services.one_email_kyc_service.validate_token_with_db",
               new=AsyncMock(return_value=(True, "ok", None))):
        with pytest.raises(OneEmailKycError) as exc:
            await service.extract_and_draft(
                user_id="u1", workflow_id="wf-1", domain="identity",
                domain_data={"full_name": "Jane Doe"},
                approved_scopes=["attr.identity.name"],
                request_text="Please share your full name.",
                consent_token="tok",
            )
    assert exc.value.code == "ONE_KYC_EXTRACT_SUBSET_VIOLATION"


@pytest.mark.asyncio
async def test_extract_draft_happy_path():
    service = get_one_email_kyc_service()
    llm_out = {
        "extracted": [{"scope": "attr.identity.name", "label": "Full name", "value": "Jane Doe"}],
        "missing": [],
        "draft": {"subject": "Re: KYC", "body": "My name is Jane Doe."},
    }
    workflow = {"workflow_id": "wf-1", "status": "waiting_on_user", "draft_status": "ready",
                "metadata": {}}
    with patch.object(service, "get_workflow", new=AsyncMock(return_value=workflow)), \
         patch.object(service, "_llm_generate_structured", new=AsyncMock(return_value=llm_out)), \
         patch.object(service, "_update_workflow", return_value=workflow), \
         patch("hushh_mcp.services.one_email_kyc_service.validate_token_with_db",
               new=AsyncMock(return_value=(True, "ok", None))):
        result = await service.extract_and_draft(
            user_id="u1", workflow_id="wf-1", domain="identity",
            domain_data={"full_name": "Jane Doe"},
            approved_scopes=["attr.identity.name"],
            request_text="Please share your full name.",
            consent_token="tok",
        )
    assert result["draft"]["body"] == "My name is Jane Doe."
    assert result["extracted"][0]["value"] == "Jane Doe"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd consent-protocol && python -m pytest tests/services/test_one_email_kyc_extract_draft.py -v`
Expected: FAIL (`extract_and_draft` missing).

- [ ] **Step 3: Add schema + method**

Add the schema near `_KYC_ROUTING_SCHEMA`:
```python
_KYC_EXTRACT_DRAFT_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "extracted": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "scope": {"type": "STRING"},
                    "label": {"type": "STRING"},
                    "value": {"type": "STRING"},
                },
                "required": ["scope", "label", "value"],
            },
        },
        "missing": {"type": "ARRAY", "items": {"type": "STRING"}},
        "draft": {
            "type": "OBJECT",
            "properties": {
                "subject": {"type": "STRING"},
                "body": {"type": "STRING"},
            },
            "required": ["subject", "body"],
        },
    },
    "required": ["extracted", "missing", "draft"],
}
```
Add a provenance helper:
```python
    @staticmethod
    def _draft_values_are_grounded(draft_body: str, extracted: list[dict[str, Any]]) -> bool:
        """Every extracted value must appear verbatim in the draft body's source set.

        We check the inverse leak: any 3+ char alphanumeric run in the draft that
        is NOT part of an extracted value and NOT common prose is suspicious. We
        keep it simple and conservative: require that each extracted value used is
        present, and reject if the draft contains a disallowed known-PII-shaped
        token. For v1 we assert extracted values are the only value source.
        """
        allowed = {str(item.get("value", "")).strip() for item in extracted if item.get("value")}
        # Reject if the LLM emitted a value not in `allowed` that looks like PII
        # (email or long digit run) — a cheap, conservative provenance guard.
        import re
        for match in re.findall(r"[\w.+-]+@[\w-]+\.[\w.-]+|\b\d{6,}\b", draft_body):
            if match not in allowed and not any(match in v for v in allowed):
                return False
        return True
```
Add the method:
```python
    async def extract_and_draft(
        self, *, user_id: str, workflow_id: str, domain: str,
        domain_data: dict[str, Any], approved_scopes: list[str],
        request_text: str, consent_token: str,
    ) -> dict[str, Any]:
        """Pass 2 — extract exact approved fields from the decrypted domain and
        compose the reply. Receives full plaintext for the ONE approved domain."""
        valid, reason, _tok = await validate_token_with_db(
            consent_token, ConsentScope.AGENT_KYC_DISCLOSE_LLM
        )
        if not valid:
            raise PermissionError(f"KYC disclose denied: {reason}")
        workflow = await self.get_workflow(user_id=user_id, workflow_id=workflow_id)
        if workflow.get("status") != "waiting_on_user" or workflow.get("draft_status") != "ready":
            raise OneEmailKycError(
                "KYC draft is not ready.", status_code=409, code="ONE_KYC_DRAFT_NOT_READY",
            )
        if not _require_gemini_ready():
            return _gemini_unavailable_payload("Gemini unavailable for KYC extract/draft")
        approved_set = set(_dedupe(approved_scopes))
        prompt = (
            "Extract ONLY the approved fields from the user's data and write a "
            "professional KYC reply email using the real values.\n"
            f"Approved scopes (extract only these): {json.dumps(sorted(approved_set))}\n"
            f"User data for domain '{domain}':\n{json.dumps(domain_data)}\n\n"
            f"Original request:\n{_truncate(request_text, 4000)}\n\n"
            "Rules: (1) 'extracted' must contain ONLY approved scopes. (2) If an "
            "approved field is absent from the data, list its scope in 'missing' and "
            "do not fabricate a value. (3) 'draft.body' must use only the extracted "
            "values — never invent data. Return the JSON."
        )
        result = await self._llm_generate_structured(
            prompt=prompt, response_schema=_KYC_EXTRACT_DRAFT_SCHEMA
        )
        if result is None:
            return _gemini_unavailable_payload("KYC extract/draft produced no parseable result")
        extracted = result.get("extracted", []) or []
        out_scopes = {str(item.get("scope")) for item in extracted}
        if not out_scopes.issubset(approved_set):
            raise OneEmailKycError(
                "Extraction returned data outside the approved scopes.",
                status_code=422, code="ONE_KYC_EXTRACT_SUBSET_VIOLATION",
                payload={"unexpected": sorted(out_scopes - approved_set)},
            )
        draft_body = str((result.get("draft") or {}).get("body") or "")
        if not self._draft_values_are_grounded(draft_body, extracted):
            raise OneEmailKycError(
                "Draft contains values not grounded in approved data.",
                status_code=422, code="ONE_KYC_DRAFT_PROVENANCE_VIOLATION",
            )
        # Log hashes only; never persist draft_body.
        logger.info(
            "one.kyc.extract_draft user_id=%s workflow_id=%s domain=%s scopes=%s",
            user_id, workflow_id, domain, sorted(out_scopes),
        )
        metadata = workflow.get("metadata", {})
        self._update_workflow(
            workflow_id,
            metadata={**metadata, "draft_revision": int(metadata.get("draft_revision") or 0) + 1,
                      "client_draft_required": True},
        )
        return result
```

- [ ] **Step 4: Add the route**

In `api/routes/one/email.py`:
```python
class ExtractDraftRequest(WorkflowUserRequest):
    domain: str = Field(min_length=1, max_length=120)
    domain_data: dict = Field(default_factory=dict)
    approved_scopes: list[str] = Field(min_length=1, max_length=8)
    request_text: str = Field(min_length=1, max_length=12000)
```
```python
@router.post("/kyc/workflows/{workflow_id}/extract-draft")
async def one_kyc_extract_draft(
    workflow_id: str,
    payload: ExtractDraftRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    _verified_vault_user_id(token_data, payload.user_id)
    try:
        return await _service().extract_and_draft(
            user_id=payload.user_id, workflow_id=workflow_id, domain=payload.domain,
            domain_data=payload.domain_data, approved_scopes=payload.approved_scopes,
            request_text=payload.request_text, consent_token=token_data.get("token", ""),
        )
    except Exception as exc:
        logger.exception(
            "one.kyc.extract_draft_failed user_id=%s workflow_id=%s",
            payload.user_id, workflow_id,
        )
        raise _to_http_exception(exc, operation="extract_draft") from exc
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd consent-protocol && python -m pytest tests/services/test_one_email_kyc_extract_draft.py -v`
Expected: PASS (2 passed).

- [ ] **Step 6: Commit**

```bash
git add consent-protocol/hushh_mcp/services/one_email_kyc_service.py consent-protocol/api/routes/one/email.py consent-protocol/tests/services/test_one_email_kyc_extract_draft.py
git commit -m "feat(kyc): add LLM Pass 2 extract+draft with subset+provenance guards

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

### Task 7: Frontend — call Pass 2 (decrypt approved domain, send full values)

**Files:**
- Modify: `hushh-webapp/lib/services/one-kyc-service.ts` — add `extractDraft`
- Modify: `hushh-webapp/lib/services/one-kyc-client-zk-service.ts` — add `buildDraftViaLlm` that decrypts + calls Pass 2 + assembles `KycDraftBuildResult`
- Modify: `hushh-webapp/app/one/kyc/page.tsx` — use `buildDraftViaLlm` for the draft (replace the `buildDraft` extraction path)
- Test: `hushh-webapp/__tests__/services/one-kyc-client-zk-service.extract-draft.test.ts` (create)

**Interfaces:**
- Consumes: `OneKycService.extractDraft(...)` → `{ extracted, missing, draft: { subject, body } }`; `decryptScopedExport` (line 1336); `renderLlmRedraftHtml` (renderer); `sha256Hex`.
- Produces: `OneKycClientZkService.buildDraftViaLlm(params): Promise<KycDraftBuildResult>` — decrypts each approved export, sends the domain data + approved scopes to Pass 2, and returns a `KycDraftBuildResult` whose `body` is the LLM draft, `htmlBody` via `renderLlmRedraftHtml`, `approvedValues` from `extracted`, `missingFields` from `missing`.

- [ ] **Step 1: Write the failing test**

Create `hushh-webapp/__tests__/services/one-kyc-client-zk-service.extract-draft.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/pkm/pkm-domain-resource", () => ({ PkmDomainResourceService: { getStaleFirst: vi.fn() } }));
vi.mock("@/lib/services/pkm-write-coordinator", () => ({ PkmWriteCoordinator: { saveMergedDomain: vi.fn() } }));
vi.mock("@/lib/services/one-kyc-service", () => ({
  OneKycService: {
    extractDraft: vi.fn(async () => ({
      extracted: [{ scope: "attr.identity.name", label: "Full name", value: "Jane Doe" }],
      missing: [],
      draft: { subject: "Re: KYC", body: "My name is Jane Doe." },
    })),
  },
}));

import { OneKycClientZkService } from "@/lib/services/one-kyc-client-zk-service";
import type { OneKycWorkflow } from "@/lib/services/one-kyc-service";

describe("buildDraftViaLlm", () => {
  beforeEach(() => vi.clearAllMocks());

  it("assembles a KycDraftBuildResult from the Pass 2 response", async () => {
    const workflow = { workflow_id: "wf-1", subject: "KYC", requested_scope: "attr.identity.name" } as unknown as OneKycWorkflow;
    const result = await OneKycClientZkService.buildDraftViaLlm({
      workflow,
      input: { userId: "u1", vaultOwnerToken: "tok" },
      decryptedDomains: [{ domain: "identity", scope: "attr.identity.name", data: { full_name: "Jane Doe" } }],
      approvedScopes: ["attr.identity.name"],
      requestText: "Please share your full name.",
    });
    expect(result.body).toBe("My name is Jane Doe.");
    expect(result.approvedValues["attr.identity.name"]).toBe("Jane Doe");
    expect(result.htmlBody).toBeTruthy();
    expect(result.missingFields).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hushh-webapp && npx vitest run __tests__/services/one-kyc-client-zk-service.extract-draft.test.ts`
Expected: FAIL (`buildDraftViaLlm` not a function).

- [ ] **Step 3: Add `extractDraft` to the service**

In `one-kyc-service.ts`:
```ts
  static extractDraft({
    userId,
    vaultOwnerToken,
    workflowId,
    domain,
    domainData,
    approvedScopes,
    requestText,
  }: AuthInput & {
    workflowId: string;
    domain: string;
    domainData: Record<string, unknown>;
    approvedScopes: string[];
    requestText: string;
  }): Promise<{
    extracted: Array<{ scope: string; label: string; value: string }>;
    missing: string[];
    draft: { subject: string; body: string };
  }> {
    return apiJson(
      `/api/one/kyc/workflows/${encodeURIComponent(workflowId)}/extract-draft`,
      {
        method: "POST",
        headers: authHeaders(vaultOwnerToken),
        body: JSON.stringify({
          user_id: userId,
          domain,
          domain_data: domainData,
          approved_scopes: approvedScopes,
          request_text: requestText,
        }),
      },
    );
  }
```

- [ ] **Step 4: Add `buildDraftViaLlm` to the ZK service**

In `one-kyc-client-zk-service.ts` (import `OneKycService` if not already; import `renderLlmRedraftHtml` and `sha256Hex` — both already used in the file):
```ts
  static async buildDraftViaLlm(params: {
    workflow: OneKycWorkflow;
    input: { userId: string; vaultOwnerToken: string };
    decryptedDomains: Array<{ domain: string; scope: string | null; data: Record<string, unknown> }>;
    approvedScopes: string[];
    requestText: string;
  }): Promise<KycDraftBuildResult> {
    // v1: one approved domain per confirm. Use the first decrypted domain.
    const primary = params.decryptedDomains[0];
    const response = await OneKycService.extractDraft({
      ...params.input,
      workflowId: params.workflow.workflow_id,
      domain: primary?.domain ?? "identity",
      domainData: primary?.data ?? {},
      approvedScopes: params.approvedScopes,
      requestText: params.requestText,
    });
    const approvedValues: Record<string, string> = {};
    for (const item of response.extracted) approvedValues[item.scope] = item.value;
    const body = response.draft.body;
    return {
      subject: response.draft.subject,
      body,
      htmlBody: renderLlmRedraftHtml(body),
      approvedValues,
      missingFields: response.missing,
      renderModel: buildFallbackRenderModel(params.workflow, response.extracted),
      scopeSummaries: params.approvedScopes.map((scope) => ({
        scope,
        approvedFields: response.extracted.filter((e) => e.scope === scope).map((e) => e.label),
        missingFields: response.missing.filter((m) => m === scope),
      })),
      draftHash: await sha256Hex(body),
    };
  }
```
Add a small `buildFallbackRenderModel(workflow, extracted)` helper that produces a minimal `ApprovedDisclosureRenderModel` (contractId `APPROVED_DISCLOSURE_FORMATTER_CONTRACT_ID`, contractVersion `"1.0.0"`, one section listing each extracted `label: value`) — reuse the same render-model construction already inside `buildDraft` (lines ~1490-1513); extract it into this shared helper so both call sites stay DRY.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd hushh-webapp && npx vitest run __tests__/services/one-kyc-client-zk-service.extract-draft.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire into `page.tsx`**

Where the client currently builds the draft after consent is ready (the `Prepare draft` / draft-ready path that calls `OneKycClientZkService.buildDraft`), replace it: decrypt the approved export(s) with `decryptScopedExport`, then call `OneKycClientZkService.buildDraftViaLlm(...)` with `approvedScopes` from `selected.selected_scopes` and `requestText` from the workflow subject+body. On a thrown provenance/subset error, `setError(...)` and fall back to the deterministic `buildDraft` result so the user still gets a draft.

- [ ] **Step 7: Commit**

```bash
git add hushh-webapp/lib/services/one-kyc-service.ts hushh-webapp/lib/services/one-kyc-client-zk-service.ts hushh-webapp/app/one/kyc/page.tsx hushh-webapp/__tests__/services/one-kyc-client-zk-service.extract-draft.test.ts
git commit -m "feat(kyc): draft via LLM Pass 2 (client decrypts approved domain)

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

### Task 8: Redraft with full data (drop tokenization)

**Files:**
- Modify: `consent-protocol/hushh_mcp/services/one_email_kyc_service.py` — add `redraft_full`
- Modify: `consent-protocol/api/routes/one/email.py` — add `FullRedraftRequest` + `POST /kyc/workflows/{id}/redraft-full`
- Modify: `hushh-webapp/lib/services/one-kyc-service.ts` — add `redraftFull`
- Modify: `hushh-webapp/lib/services/one-kyc-client-zk-service.ts` — add `runFullRedraft` (no tokenization); keep `runLlmRedraft` for backward-compat until removed
- Modify: `hushh-webapp/app/one/kyc/page.tsx` — `runAction("redraft")` calls `runFullRedraft`
- Test: `consent-protocol/tests/services/test_one_email_kyc_redraft_full.py`, `hushh-webapp/__tests__/services/one-kyc-client-zk-service.redraft-full.test.ts` (create)

**Interfaces:**
- Consumes: `ConsentScope.AGENT_KYC_DISCLOSE_LLM` gate; `_redraft_requests_more_data` (line 1034, scope-expansion block, kept).
- Produces: `async redraft_full(self, *, user_id, workflow_id, draft_body: str, instruction: str, consent_token: str) -> dict` returning `{ "rewritten_body": str }`; frontend `OneKycService.redraftFull(...)` and `runFullRedraft(...)` returning `{ ok: true, draft } | { ok: false, errorCode }`.

- [ ] **Step 1: Write the failing backend test**

Create `consent-protocol/tests/services/test_one_email_kyc_redraft_full.py`:
```python
import pytest
from unittest.mock import AsyncMock, patch

from hushh_mcp.services.one_email_kyc_service import (
    get_one_email_kyc_service, OneEmailKycError,
)


@pytest.mark.asyncio
async def test_redraft_full_blocks_scope_expansion():
    service = get_one_email_kyc_service()
    workflow = {"workflow_id": "wf-1", "status": "waiting_on_user", "draft_status": "ready"}
    with patch.object(service, "get_workflow", new=AsyncMock(return_value=workflow)), \
         patch("hushh_mcp.services.one_email_kyc_service.validate_token_with_db",
               new=AsyncMock(return_value=(True, "ok", None))):
        with pytest.raises(OneEmailKycError) as exc:
            await service.redraft_full(
                user_id="u1", workflow_id="wf-1",
                draft_body="My name is Jane.",
                instruction="also include my passport number",
                consent_token="tok",
            )
    assert exc.value.code == "ONE_KYC_LLM_SCOPE_EXPANSION_BLOCKED"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd consent-protocol && python -m pytest tests/services/test_one_email_kyc_redraft_full.py -v`
Expected: FAIL (`redraft_full` missing).

- [ ] **Step 3: Implement `redraft_full`**

Mirror `redraft_llm` (line 3892) but: gate on `AGENT_KYC_DISCLOSE_LLM`, send the **real** `draft_body` (no tokenized template), keep the `_redraft_requests_more_data(instruction)` scope-expansion block (raise `ONE_KYC_LLM_SCOPE_EXPANSION_BLOCKED`), use a system prompt instructing "rewrite per the instruction; do not add facts not already present in the draft; output only the rewritten email," call the shared client (executor pattern, lines 3957-3980), log the instruction hash only, bump `draft_revision`, and return `{"rewritten_body": rewritten}`.

- [ ] **Step 4: Add the backend route**

Add `FullRedraftRequest(WorkflowUserRequest)` with `draft_body: str = Field(min_length=1, max_length=20000)` and `instruction: str = Field(min_length=1, max_length=1000)`, and `POST /kyc/workflows/{workflow_id}/redraft-full` mirroring `one_kyc_redraft_llm` (line 561) but passing `draft_body`.

- [ ] **Step 5: Run backend test to verify it passes**

Run: `cd consent-protocol && python -m pytest tests/services/test_one_email_kyc_redraft_full.py -v`
Expected: PASS.

- [ ] **Step 6: Write the failing frontend test + implement `runFullRedraft`**

Create `hushh-webapp/__tests__/services/one-kyc-client-zk-service.redraft-full.test.ts` mirroring the redraft-llm test style (report §9 pattern): mock `OneKycService.redraftFull` to return `{ rewritten_body }`; assert `runFullRedraft` returns `{ ok: true, draft }` with `body === rewritten_body` and a re-derived `htmlBody` via `renderLlmRedraftHtml`. Implement `runFullRedraft(params: { localDraft; instruction; workflow; input }): Promise<LlmRedraftResult>` in `one-kyc-client-zk-service.ts`: call `OneKycService.redraftFull({ ...input, workflowId, draftBody: localDraft.body, instruction })`, then return `{ ok: true, draft: { ...localDraft, body: rewritten_body, htmlBody: renderLlmRedraftHtml(rewritten_body), draftHash: await sha256Hex(rewritten_body) } }`. Add `OneKycService.redraftFull` (endpoint `/redraft-full`, body `{ user_id, draft_body, instruction }`, returns `{ rewritten_body: string }`).

- [ ] **Step 7: Run frontend test to verify it passes**

Run: `cd hushh-webapp && npx vitest run __tests__/services/one-kyc-client-zk-service.redraft-full.test.ts`
Expected: PASS.

- [ ] **Step 8: Wire `page.tsx` `runAction("redraft")` to `runFullRedraft`**

Replace the `runLlmRedraft(...)` call in the redraft branch (lines 988-1015) with `runFullRedraft({ localDraft, instruction: redraftInstructions.trim(), workflow, input })`. Keep the error handling shape; drop the `TOKEN_INTEGRITY`/`FIELD_SET_CHANGED` branches (no longer produced) in favor of a single generic redraft-failed message.

- [ ] **Step 9: Commit**

```bash
git add consent-protocol/hushh_mcp/services/one_email_kyc_service.py consent-protocol/api/routes/one/email.py consent-protocol/tests/services/test_one_email_kyc_redraft_full.py hushh-webapp/lib/services/one-kyc-service.ts hushh-webapp/lib/services/one-kyc-client-zk-service.ts hushh-webapp/app/one/kyc/page.tsx hushh-webapp/__tests__/services/one-kyc-client-zk-service.redraft-full.test.ts
git commit -m "feat(kyc): redraft with full data (drop opaque tokenization)

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

# Phase 3 — Regression coverage, eval, docs

### Task 9: Regression test for the reported bug + eval harness

**Files:**
- Test: `consent-protocol/tests/services/test_one_email_kyc_routing.py` (extend)
- Create: `consent-protocol/scripts/eval_kyc_routing_agent.py`
- Test: `consent-protocol/tests/scripts/test_eval_kyc_routing_agent.py` (create)

**Interfaces:**
- Consumes: `classify_kyc_request` (Task 2).
- Produces: an eval script `eval_kyc_routing_agent.py` mirroring `scripts/eval_pkm_structure_agent.py` that runs a labeled set `[{subject, body, pkm_index, expected_domain}]` through `classify_kyc_request` and reports accuracy.

- [ ] **Step 1: Add the exact-bug regression assertion**

Extend `test_one_email_kyc_routing.py` with a case whose `pkm_index` has BOTH `travel` and `identity` domains and a hotel-booking request, asserting `result["primary_domains"] == ["identity"]` and `"travel" not in result["primary_domains"]`. Use the same `_llm_generate_structured` patch pattern (do NOT hit real Gemini in unit tests).

- [ ] **Step 2: Run it**

Run: `cd consent-protocol && python -m pytest tests/services/test_one_email_kyc_routing.py -v`
Expected: PASS.

- [ ] **Step 3: Build the eval harness**

Read `consent-protocol/scripts/eval_pkm_structure_agent.py` for the structure. Create `eval_kyc_routing_agent.py` with an inline labeled dataset (≥8 cases incl. the hotel-booking case, a financial-portfolio case, an identity case, and an `unsupported` case), a `run_eval()` that calls the real `classify_kyc_request`, computes per-case pass/fail on `primary_domains` + `classification`, and prints an accuracy summary. Gate the real-LLM run behind an env flag (e.g. `KYC_EVAL_LIVE=1`), matching how the PKM eval script guards live calls.

- [ ] **Step 4: Write + run the harness self-test**

Create `tests/scripts/test_eval_kyc_routing_agent.py` that imports the dataset and asserts it is well-formed (every case has `subject/body/pkm_index/expected_domain`) and that `run_eval` with a stubbed classifier returns 100% — mirror `tests/scripts/test_eval_pkm_structure_agent.py`.

Run: `cd consent-protocol && python -m pytest tests/scripts/test_eval_kyc_routing_agent.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add consent-protocol/scripts/eval_kyc_routing_agent.py consent-protocol/tests/scripts/test_eval_kyc_routing_agent.py consent-protocol/tests/services/test_one_email_kyc_routing.py
git commit -m "test(kyc): hotel-booking regression + routing eval harness

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

### Task 10: Update security + reference docs

**Files:**
- Modify: `SECURITY.md`
- Modify: `docs/reference/agent-development.md` (the One Email KYC section, ~line 447)
- Modify: `docs/reference/architecture/one-email-kyc.md`

**Interfaces:** none (docs).

- [ ] **Step 1: Amend `SECURITY.md`**

In the client-side-encryption guarantee section (~lines 116-119), add a scoped exception: One Email KYC sends the **approved domain's** decrypted plaintext to the server-side Gemini Vertex proxy during Pass-2 extract/draft and full redraft, gated by the `agent.kyc.disclose.llm` consent scope; `draft_body` is still never persisted server-side. Note this is transitional pending BYOK / on-device inference.

- [ ] **Step 2: Update `agent-development.md`**

Replace the One Email KYC intake description with the two-pass flow (Pass 1 routing → `needs_confirm` → consent → Pass 2 extract+draft → send). Fix the broken reference to `docs/reference/architecture/one-email-kyc.md` (confirm the path and correct it).

- [ ] **Step 3: Update `one-email-kyc.md`**

Document the new state machine, the two LLM contracts, the `agent.kyc.disclose.llm` scope, and the guardrails (subset invariant, provenance check, confidence floor, scope-expansion block).

- [ ] **Step 4: Commit**

```bash
git add SECURITY.md docs/reference/agent-development.md docs/reference/architecture/one-email-kyc.md
git commit -m "docs(kyc): document two-pass LLM redesign + disclose.llm scope

Signed-off-by: Gautam Ahuja <ahujagautam024@gmail.com>"
```

---

### Task 11: Full-suite verification

**Files:** none (verification).

- [ ] **Step 1: Backend suite**

Run: `cd consent-protocol && python -m pytest tests/services/test_one_email_kyc_service.py tests/services/test_one_email_kyc_service_llm.py tests/services/test_one_email_kyc_routing.py tests/services/test_one_email_kyc_confirm.py tests/services/test_one_email_kyc_extract_draft.py tests/services/test_one_email_kyc_redraft_full.py tests/test_kyc_disclose_llm_scope.py -v`
Expected: all PASS.

- [ ] **Step 2: Frontend suite**

Run: `cd hushh-webapp && npx vitest run __tests__/services/one-kyc-service.confirm.test.ts __tests__/services/one-kyc-client-zk-service.extract-draft.test.ts __tests__/services/one-kyc-client-zk-service.redraft-full.test.ts`
Expected: all PASS.

- [ ] **Step 3: E2E on the simulator (verify skill)**

Use the `run-ios-sim` skill (or webapp dev server) to open `/one/kyc`. Forward a "provide your information to confirm a hotel booking" email to the mailbox. Verify: the proposal card shows **identity** (not travel) with reasoning; confirm creates the consent request; after granting, the LLM-composed draft renders with real values; a free-form redraft ("make it warmer") visibly changes the prose; approve+send succeeds.

- [ ] **Step 4: Commit any fixes, then open PR**

```bash
git push -u origin feat/kyc-agent
gh pr create --title "KYC agent LLM redesign (two-pass routing + extract/draft)" --body "$(cat <<'EOF'
Rebuilds the One Email KYC brains around two server-side LLM passes with a
preserved confirm gate. Fixes domain misrouting (hotel-booking pulled travel
data instead of identity). Full data reaches the LLM (transitional, gated by
agent.kyc.disclose.llm) toward the BYOK/on-device direction.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:** ✅ Pass 1 routing (Tasks 2-3), confirm gate (Tasks 4-5), Pass 2 extract+draft (Tasks 6-7), LLM drafting (Task 7), redraft full data (Task 8), `agent.kyc.disclose.llm` scope (Task 1), drop tokenization (Task 8), keep `draft_body IS NULL` (enforced — Pass 2/redraft return bodies, never persist), guardrails: confidence floor (Task 3), confirm gate (Task 5), subset invariant + provenance (Task 6), scope-expansion block (Task 8), fail-closed JSON (Task 2 helper), pluggable provider (shared `_llm_generate_structured` + injected `llmRewrite` seam), regression + eval (Task 9), docs (Task 10).

**Open items from the spec resolved here:** endpoint shape = separate endpoints (`confirm-proposal`, `extract-draft`, `redraft-full`); confidence floor = `0.5` (`_KYC_ROUTING_CONFIDENCE_FLOOR`, tune during Task 9 eval); provider seam = `_llm_generate_structured` (backend) + `llmRewrite`/service-method injection (frontend).

**Type consistency:** `classify_kyc_request` → routing dict (Task 2) consumed by `_apply_routing_to_workflow` (Task 3) → `kyc_proposal` metadata → `confirm_proposal` (Task 4) → `confirmProposal` (Task 5). `extract_and_draft` → `{extracted, missing, draft}` (Task 6) consumed by `extractDraft` (Task 7) → `buildDraftViaLlm` → `KycDraftBuildResult`. `redraft_full` → `{rewritten_body}` (Task 8) consumed by `redraftFull` → `runFullRedraft` → `LlmRedraftResult`.

**Provenance-guard caveat (flagged for the executor):** `_draft_values_are_grounded` (Task 6) is a conservative v1 heuristic (emails + long digit runs). Full redraft (Task 8) intentionally allows value *transformation* (e.g. abbreviating a state), so it relies on the scope-expansion block, not strict provenance. Revisit the heuristic if false positives appear during Task 11 E2E.
