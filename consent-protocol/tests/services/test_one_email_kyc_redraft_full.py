"""Unit tests for OneEmailKycService.redraft_full (Task 8 — full-body redraft).

These tests exercise the non-tokenized LLM proxy service method in isolation:
- (a) scope-expansion instruction raises ONE_KYC_LLM_SCOPE_EXPANSION_BLOCKED
- (b) invalid consent token raises PermissionError
- (c) happy path returns {"rewritten_body": ...} and never persists draft_body

The Gemini client is fully mocked; no network, no Vertex creds required.
"""

from types import SimpleNamespace

import pytest

from hushh_mcp.services.one_email_kyc_service import (
    OneEmailKycError,
    OneEmailKycService,
)

VALID_TOKEN = "HCT:valid-disclose-llm-token"  # noqa: S105 - test fixture, not a secret
DRAFT_BODY = "Dear Jane Smith,\n\nYour reference is 123456. Regards."
INSTRUCTION = "Make the tone warmer and rephrase the intro."


def _service() -> OneEmailKycService:
    # Bypass __init__ (which wires DB/consent dependencies) — we only call
    # redraft_full which we fully isolate via monkeypatched collaborators.
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


# ---------------------------------------------------------------------------
# (a) Scope-expansion block
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_redraft_full_blocks_scope_expansion(monkeypatch):
    import hushh_mcp.services.one_email_kyc_service as svc_mod

    _patch_gemini(monkeypatch, "ignored")

    async def _ok_validate(token, scope):  # noqa: ANN001
        return True, None, SimpleNamespace(user_id="u1", agent_id="agent_one")

    monkeypatch.setattr(svc_mod, "validate_token_with_db", _ok_validate, raising=False)

    async def _fake_get(self, *, user_id, workflow_id):  # noqa: ANN001
        return _ready_workflow()

    monkeypatch.setattr(OneEmailKycService, "get_workflow", _fake_get, raising=False)

    with pytest.raises(OneEmailKycError) as exc:
        await _service().redraft_full(
            user_id="u1",
            workflow_id="wf-1",
            draft_body=DRAFT_BODY,
            instruction="also include my bank account and address",
            consent_token=VALID_TOKEN,
        )
    assert exc.value.code == "ONE_KYC_LLM_SCOPE_EXPANSION_BLOCKED"


# ---------------------------------------------------------------------------
# (b) Invalid consent raises PermissionError
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_redraft_full_invalid_consent_raises_permission_error(monkeypatch):
    import hushh_mcp.services.one_email_kyc_service as svc_mod

    _patch_gemini(monkeypatch, "ignored")

    async def _deny(token, scope):  # noqa: ANN001
        return False, "scope_not_granted", None

    monkeypatch.setattr(svc_mod, "validate_token_with_db", _deny, raising=False)

    async def _fake_get(self, *, user_id, workflow_id):  # noqa: ANN001
        return _ready_workflow()

    monkeypatch.setattr(OneEmailKycService, "get_workflow", _fake_get, raising=False)

    with pytest.raises(PermissionError):
        await _service().redraft_full(
            user_id="u1",
            workflow_id="wf-1",
            draft_body=DRAFT_BODY,
            instruction=INSTRUCTION,
            consent_token="HCT:bad",  # noqa: S106 - test fixture, not a secret
        )


# ---------------------------------------------------------------------------
# (c) Happy path returns {"rewritten_body": ...}
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_redraft_full_happy_path_returns_rewritten_body(monkeypatch):
    import hushh_mcp.services.one_email_kyc_service as svc_mod

    rewritten = "Dear Jane,\n\nYour reference is 123456. Warm regards."
    _patch_gemini(monkeypatch, rewritten)

    async def _ok_validate(token, scope):  # noqa: ANN001
        return True, None, SimpleNamespace(user_id="u1", agent_id="agent_one")

    monkeypatch.setattr(svc_mod, "validate_token_with_db", _ok_validate, raising=False)

    update_calls: dict = {}

    def _fake_update(self, workflow_id, **values):  # noqa: ANN001
        update_calls["workflow_id"] = workflow_id
        update_calls["values"] = values
        return {"workflow_id": workflow_id, **values}

    async def _fake_get(self, *, user_id, workflow_id):  # noqa: ANN001
        return _ready_workflow()

    monkeypatch.setattr(OneEmailKycService, "_update_workflow", _fake_update, raising=False)
    monkeypatch.setattr(OneEmailKycService, "get_workflow", _fake_get, raising=False)

    result = await _service().redraft_full(
        user_id="u1",
        workflow_id="wf-1",
        draft_body=DRAFT_BODY,
        instruction=INSTRUCTION,
        consent_token=VALID_TOKEN,
    )

    assert result == {"rewritten_body": rewritten}

    # No draft_body anywhere in the update call.
    assert "draft_body" not in update_calls["values"]
    metadata = update_calls["values"]["metadata"]
    assert "draft_body" not in metadata
    # Hash recorded, revision bumped from 1 -> 2.
    assert metadata["last_redraft_instruction_hash"]
    assert len(metadata["last_redraft_instruction_hash"]) == 64
    assert metadata["draft_revision"] == 2
    assert metadata["last_redraft_source"] == "llm_full"
    assert metadata["client_draft_required"] is True
