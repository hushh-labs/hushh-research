"""Unit tests for OneEmailKycService.redraft_llm (Phase 03 Wave 2).

These tests exercise the redact-safe LLM proxy service method in isolation:
- valid call returns {"rewritten_template": ...} and never writes draft_body
- a token missing agent.kyc.redraft.llm raises PermissionError
- a workflow not in waiting_on_user/ready raises ONE_KYC_DRAFT_NOT_READY
- a scope-expansion instruction raises ONE_KYC_LLM_SCOPE_EXPANSION_BLOCKED

The Gemini client is fully mocked; no network, no Vertex creds required.
"""

from types import SimpleNamespace

import pytest

from hushh_mcp.services.one_email_kyc_service import (
    OneEmailKycError,
    OneEmailKycService,
)

VALID_TOKEN = "HCT:valid-redraft-llm-token"  # noqa: S105 - test fixture, not a secret
TEMPLATE = "Hello {{F0}},\n\nYour reference is {{F1}}. Regards."
INSTRUCTION = "Make the tone warmer and rephrase the intro."


def _service() -> OneEmailKycService:
    # Bypass __init__ (which wires DB/consent dependencies) — we only call
    # redraft_llm which we fully isolate via monkeypatched collaborators.
    return OneEmailKycService.__new__(OneEmailKycService)


def _ready_workflow() -> dict:
    return {
        "workflow_id": "wf-1",
        "status": "waiting_on_user",
        "draft_status": "ready",
        "metadata": {"draft_revision": 1},
    }


def _patch_gemini(monkeypatch, rewritten: str) -> None:
    import hushh_mcp.services.one_email_kyc_service as svc_mod

    monkeypatch.setattr(svc_mod, "_require_gemini_ready", lambda: True, raising=False)
    monkeypatch.setattr(svc_mod, "_gemini_model_name", "gemini-test", raising=False)

    class _FakeModels:
        def generate_content(self, *, model, contents, config):  # noqa: ANN001
            return SimpleNamespace(text=rewritten)

    fake_client = SimpleNamespace(models=_FakeModels())
    monkeypatch.setattr(svc_mod, "_gemini_client", fake_client, raising=False)


@pytest.mark.asyncio
async def test_redraft_llm_success_returns_rewritten_and_no_draft_body(monkeypatch):
    import hushh_mcp.services.one_email_kyc_service as svc_mod

    rewritten = "Hi {{F0}}!\n\nQuick note — your reference is {{F1}}. Warm regards."
    _patch_gemini(monkeypatch, rewritten)

    async def _ok_validate(token, scope):  # noqa: ANN001
        return True, None, SimpleNamespace(user_id="u1", agent_id="agent_one")

    monkeypatch.setattr(svc_mod, "validate_token_with_db", _ok_validate, raising=False)

    update_calls = {}

    def _fake_update(self, workflow_id, **values):  # noqa: ANN001
        update_calls["workflow_id"] = workflow_id
        update_calls["values"] = values
        return {"workflow_id": workflow_id, **values}

    async def _fake_get(self, *, user_id, workflow_id):  # noqa: ANN001
        return _ready_workflow()

    monkeypatch.setattr(OneEmailKycService, "_update_workflow", _fake_update, raising=False)
    monkeypatch.setattr(OneEmailKycService, "get_workflow", _fake_get, raising=False)

    result = await _service().redraft_llm(
        user_id="u1",
        workflow_id="wf-1",
        tokenized_template=TEMPLATE,
        instruction=INSTRUCTION,
        consent_token=VALID_TOKEN,
    )

    assert result["rewritten_template"] == rewritten

    # No draft_body anywhere in the update call.
    assert "draft_body" not in update_calls["values"]
    metadata = update_calls["values"]["metadata"]
    assert "draft_body" not in metadata
    # Hash recorded, revision bumped from 1 -> 2.
    assert metadata["last_redraft_instruction_hash"]
    assert metadata["draft_revision"] == 2
    assert metadata["last_redraft_source"] == "llm"


@pytest.mark.asyncio
async def test_redraft_llm_missing_scope_raises_permission_error(monkeypatch):
    import hushh_mcp.services.one_email_kyc_service as svc_mod

    _patch_gemini(monkeypatch, "ignored")

    async def _deny(token, scope):  # noqa: ANN001
        return False, "scope_not_granted", None

    monkeypatch.setattr(svc_mod, "validate_token_with_db", _deny, raising=False)

    async def _fake_get(self, *, user_id, workflow_id):  # noqa: ANN001
        return _ready_workflow()

    monkeypatch.setattr(OneEmailKycService, "get_workflow", _fake_get, raising=False)

    with pytest.raises(PermissionError):
        await _service().redraft_llm(
            user_id="u1",
            workflow_id="wf-1",
            tokenized_template=TEMPLATE,
            instruction=INSTRUCTION,
            consent_token="HCT:bad",  # noqa: S106 - test fixture, not a secret
        )


@pytest.mark.asyncio
async def test_redraft_llm_not_ready_raises_draft_not_ready(monkeypatch):
    import hushh_mcp.services.one_email_kyc_service as svc_mod

    _patch_gemini(monkeypatch, "ignored")

    async def _ok_validate(token, scope):  # noqa: ANN001
        return True, None, SimpleNamespace(user_id="u1", agent_id="agent_one")

    monkeypatch.setattr(svc_mod, "validate_token_with_db", _ok_validate, raising=False)

    async def _fake_get(self, *, user_id, workflow_id):  # noqa: ANN001
        return {"status": "processing", "draft_status": "not_ready", "metadata": {}}

    monkeypatch.setattr(OneEmailKycService, "get_workflow", _fake_get, raising=False)

    with pytest.raises(OneEmailKycError) as exc_info:
        await _service().redraft_llm(
            user_id="u1",
            workflow_id="wf-1",
            tokenized_template=TEMPLATE,
            instruction=INSTRUCTION,
            consent_token=VALID_TOKEN,
        )
    assert exc_info.value.code == "ONE_KYC_DRAFT_NOT_READY"


@pytest.mark.asyncio
async def test_redraft_llm_scope_expansion_blocked(monkeypatch):
    import hushh_mcp.services.one_email_kyc_service as svc_mod

    _patch_gemini(monkeypatch, "ignored")

    async def _ok_validate(token, scope):  # noqa: ANN001
        return True, None, SimpleNamespace(user_id="u1", agent_id="agent_one")

    monkeypatch.setattr(svc_mod, "validate_token_with_db", _ok_validate, raising=False)

    async def _fake_get(self, *, user_id, workflow_id):  # noqa: ANN001
        return _ready_workflow()

    monkeypatch.setattr(OneEmailKycService, "get_workflow", _fake_get, raising=False)

    with pytest.raises(OneEmailKycError) as exc_info:
        await _service().redraft_llm(
            user_id="u1",
            workflow_id="wf-1",
            tokenized_template=TEMPLATE,
            instruction="also include my bank account and address",
            consent_token=VALID_TOKEN,
        )
    assert exc_info.value.code == "ONE_KYC_LLM_SCOPE_EXPANSION_BLOCKED"
