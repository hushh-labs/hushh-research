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


def _ok_validate_factory():
    async def _ok_validate(token, scope):  # noqa: ANN001
        return True, None, SimpleNamespace(user_id="u1", agent_id="agent_one")

    return _ok_validate


def _capture_update_workflow(store: dict):
    def _fake_update(self, workflow_id, **values):  # noqa: ANN001
        store["workflow_id"] = workflow_id
        store["values"] = values
        return {"workflow_id": workflow_id, **values}

    return _fake_update


def _patch_valid_redraft_llm(monkeypatch, rewritten: str, update_store: dict) -> None:
    """Patch all collaborators for a successful redraft_llm call."""
    import hushh_mcp.services.one_email_kyc_service as svc_mod

    _patch_gemini(monkeypatch, rewritten)
    monkeypatch.setattr(svc_mod, "validate_token_with_db", _ok_validate_factory(), raising=False)

    async def _fake_get(self, *, user_id, workflow_id):  # noqa: ANN001
        return _ready_workflow()

    monkeypatch.setattr(
        OneEmailKycService,
        "_update_workflow",
        _capture_update_workflow(update_store),
        raising=False,
    )
    monkeypatch.setattr(OneEmailKycService, "get_workflow", _fake_get, raising=False)


@pytest.mark.asyncio
async def test_redraft_llm_rejects_missing_scope(monkeypatch):
    """Gate-named alias: a token without agent.kyc.redraft.llm is rejected."""
    import hushh_mcp.services.one_email_kyc_service as svc_mod

    _patch_gemini(monkeypatch, "ignored")

    async def _deny(token, scope):  # noqa: ANN001
        return False, "no scope", None

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
async def test_redraft_llm_no_draft_body_in_update(monkeypatch):
    """No-persist contract: draft_body never appears in the _update_workflow args."""
    update_store: dict = {}
    _patch_valid_redraft_llm(monkeypatch, "Hello {{F0}}", update_store)

    await _service().redraft_llm(
        user_id="u1",
        workflow_id="wf-1",
        tokenized_template="Hello {{F0}}",
        instruction="shorter",
        consent_token=VALID_TOKEN,
    )

    # draft_body must NOT be in the update kwargs nor the metadata blob.
    assert "draft_body" not in update_store["values"]
    assert "draft_body" not in update_store["values"]["metadata"]


@pytest.mark.asyncio
async def test_redraft_llm_metadata_updated(monkeypatch):
    """Revision bumped and a 64-char hex instruction hash is recorded."""
    update_store: dict = {}
    _patch_valid_redraft_llm(monkeypatch, "Hello {{F0}}", update_store)

    await _service().redraft_llm(
        user_id="u1",
        workflow_id="wf-1",
        tokenized_template="Hello {{F0}}",
        instruction="shorter",
        consent_token=VALID_TOKEN,
    )

    metadata = update_store["values"]["metadata"]
    instruction_hash = metadata["last_redraft_instruction_hash"]
    assert isinstance(instruction_hash, str)
    assert len(instruction_hash) == 64
    int(instruction_hash, 16)  # raises if not valid hex
    assert metadata["draft_revision"] == 2


@pytest.mark.asyncio
async def test_redraft_llm_token_preserving_prompt(monkeypatch):
    """The system instruction enforces exact placeholder preservation."""
    import hushh_mcp.services.one_email_kyc_service as svc_mod

    captured: dict = {}

    monkeypatch.setattr(svc_mod, "validate_token_with_db", _ok_validate_factory(), raising=False)
    monkeypatch.setattr(svc_mod, "_require_gemini_ready", lambda: True, raising=False)
    monkeypatch.setattr(svc_mod, "_gemini_model_name", "gemini-test", raising=False)

    class _FakeModels:
        def generate_content(self, *, model, contents, config):  # noqa: ANN001
            captured["config"] = config
            return SimpleNamespace(text="Hello {{F0}}")

    monkeypatch.setattr(
        svc_mod, "_gemini_client", SimpleNamespace(models=_FakeModels()), raising=False
    )

    async def _fake_get(self, *, user_id, workflow_id):  # noqa: ANN001
        return _ready_workflow()

    monkeypatch.setattr(
        OneEmailKycService, "_update_workflow", lambda self, wf_id, **v: {}, raising=False
    )
    monkeypatch.setattr(OneEmailKycService, "get_workflow", _fake_get, raising=False)

    await _service().redraft_llm(
        user_id="u1",
        workflow_id="wf-1",
        tokenized_template="Hello {{F0}}",
        instruction="shorter",
        consent_token=VALID_TOKEN,
    )

    system_instruction = captured["config"].system_instruction
    assert "Preserve EVERY placeholder token exactly" in system_instruction


@pytest.mark.asyncio
async def test_redraft_llm_returns_rewritten_template(monkeypatch):
    """The method returns {'rewritten_template': <gemini text>}."""
    update_store: dict = {}
    _patch_valid_redraft_llm(monkeypatch, "Hello {{F0}}", update_store)

    result = await _service().redraft_llm(
        user_id="u1",
        workflow_id="wf-1",
        tokenized_template="Hello {{F0}}",
        instruction="shorter",
        consent_token=VALID_TOKEN,
    )

    assert result == {"rewritten_template": "Hello {{F0}}"}


@pytest.mark.asyncio
async def test_regression_redraft_keyword_path_no_gemini_call(monkeypatch):
    """Regression: the existing regex redraft() bumps revision + records the hash
    and NEVER calls Gemini generate_content."""
    import hushh_mcp.services.one_email_kyc_service as svc_mod

    generate_called = {"count": 0}

    class _ExplodingModels:
        def generate_content(self, *args, **kwargs):  # noqa: ANN002, ANN003
            generate_called["count"] += 1
            raise AssertionError("regex redraft path must not call Gemini")

    monkeypatch.setattr(
        svc_mod, "_gemini_client", SimpleNamespace(models=_ExplodingModels()), raising=False
    )

    update_store: dict = {}

    monkeypatch.setattr(
        OneEmailKycService,
        "_update_workflow",
        _capture_update_workflow(update_store),
        raising=False,
    )

    async def _fake_get(self, *, user_id, workflow_id):  # noqa: ANN001
        return _ready_workflow()

    monkeypatch.setattr(OneEmailKycService, "get_workflow", _fake_get, raising=False)
    # No scope-expansion: a plain keyword instruction.
    monkeypatch.setattr(
        OneEmailKycService, "_detect_scope_candidates", lambda self, **kw: [], raising=False
    )

    result = await _service().redraft(
        user_id="u1",
        workflow_id="wf-1",
        instructions="make it formal",
        source="text",
    )

    assert generate_called["count"] == 0
    metadata = result["metadata"]
    assert metadata["draft_revision"] == 2
    assert len(metadata["last_redraft_instruction_hash"]) == 64
