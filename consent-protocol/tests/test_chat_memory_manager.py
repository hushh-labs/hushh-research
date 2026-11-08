"""The rewrite boundary is incremental, bounded and never commits vault state."""

import json
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from hushh_mcp.services import chat_memory_manager as memory


def request(**changes):
    return memory.RewriteMemoryRequest.model_validate(
        {
            "user_id": "synthetic-owner",
            "current_markdown": "# Memory\n\n## Preferences\n- Tea.\n",
            "messages": [
                {
                    "id": "new-42",
                    "conversationId": "chat-1",
                    "role": "user",
                    "content": "Now I prefer coffee.",
                }
            ],
            **changes,
        }
    )


async def test_rewrite_supplies_only_incremental_source_and_explicit_owner_model(monkeypatch):
    selected_model = object()
    build = __import__("unittest.mock", fromlist=["Mock"]).Mock(return_value="agent")
    prepared = "    indented_note()\n\n# Memory\n\n## Preferences\n- Coffee.\n"
    run = AsyncMock(return_value={"markdown": prepared})
    monkeypatch.setattr(memory, "build_single_turn_agent", build)
    monkeypatch.setattr(memory, "run_single_turn", run)
    result = await memory.rewrite_chat_memory(request(), model=selected_model)
    assert result.markdown == prepared
    assert "Coffee" in result.markdown
    assert build.call_args.kwargs["model"] is selected_model
    payload = json.loads(run.call_args.kwargs["prompt_parts"])
    assert [message["id"] for message in payload["new_messages"]] == ["new-42"]
    assert "Tea" in payload["current_markdown"]
    assert "history" not in payload


async def test_sandbox_default_chat_and_ltm_use_azure_without_vertex(monkeypatch):
    from unittest.mock import Mock

    from hushh_mcp.one_adk.agent_tree import build_one_text_agent
    from hushh_mcp.runtime_providers import factory, managed_azure, managed_azure_text
    from tests.services.test_azure_adk import message, model, response

    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    monkeypatch.setenv("TESTING", "false")
    monkeypatch.setenv("K_SERVICE", "backend-dev-akshat")
    monkeypatch.setenv("HUSSH_POD_MODE", "false")
    monkeypatch.setenv("HUSHH_SANDBOX_MANAGED_AI_PROVIDER", "azure_openai")
    monkeypatch.setenv("HUSHH_SANDBOX_AZURE_CLIENT_ID", "afd2feb2-fd0f-422c-bdfe-0b7c7e14b5ed")
    adapter, client, client_factory, supplier = model(
        [response(message(json.dumps({"markdown": "# Memory\n- Prefers coffee.\n"})))]
    )
    monkeypatch.setattr(managed_azure, "_credential_supplier", lambda *_: supplier)
    original = managed_azure_text.build_azure_text_model

    def isolated_transport(*args, **kwargs):
        selected = original(*args, **kwargs)
        return selected.model_copy(update={"client_factory": client_factory})

    monkeypatch.setattr(managed_azure_text, "build_azure_text_model", isolated_transport)
    vertex = Mock(side_effect=AssertionError("Sandbox Azure must not dispatch to Vertex"))
    monkeypatch.setattr(factory.ManagedGeminiRuntimeBinding, "build_regional_adk_model", vertex)
    chat = build_one_text_agent(include_client_receipt_tools=False)
    assert chat.model.model == "one-search-gpt-54-mini-eval"
    assert chat.model.default_reasoning_effort == "none"
    # A caller-supplied owner model remains authoritative.
    assert build_one_text_agent(model=adapter, include_client_receipt_tools=False).model is adapter

    result = await memory.rewrite_chat_memory(request())
    assert "coffee" in result.markdown
    assert len(client.requests) == 1
    sent = client.requests[0]
    assert sent["model"] == "pwm-gpt-5-mini-eval"
    assert sent["store"] is False
    assert sent["text"]["format"]["type"] == "json_schema"
    assert sent["max_output_tokens"] == 32768
    payload = json.loads(sent["input"][-1]["content"])
    assert [item["id"] for item in payload["new_messages"]] == ["new-42"]
    assert "Tea" in payload["current_markdown"]
    vertex.assert_not_called()


@pytest.mark.parametrize("markdown", ["", "   ", "\n\t\r\n"])
async def test_invalid_or_failed_generation_never_returns_a_replacement(monkeypatch, markdown):
    monkeypatch.setattr(memory, "build_single_turn_agent", lambda *a, **kw: "agent")
    run = AsyncMock(return_value={"markdown": markdown})
    monkeypatch.setattr(memory, "run_single_turn", run)
    with pytest.raises(ValidationError):
        await memory.rewrite_chat_memory(request())
    run.side_effect = TimeoutError()
    with pytest.raises(TimeoutError):
        await memory.rewrite_chat_memory(request())


@pytest.mark.parametrize("content", [" ", "\n\t\r"])
def test_blank_incremental_sources_are_rejected_before_inference(content):
    item = request().messages[0].model_dump()
    with pytest.raises(ValidationError, match="Memory source message is blank"):
        request(messages=[{**item, "content": content}])


def test_incremental_source_preserves_meaningful_indentation():
    item = request().messages[0].model_dump()
    content = "    prefers_indented_notes()\n"
    assert request(messages=[{**item, "content": content}]).messages[0].content == content


def test_duplicate_or_oversize_sources_are_rejected_before_inference():
    item = request().messages[0].model_dump()
    with pytest.raises(ValidationError):
        request(messages=[item, item])
    with pytest.raises(ValidationError):
        request(messages=[{**item, "content": "x" * 192_001}])


async def test_shared_rewrite_checks_owner_before_model(monkeypatch):
    from api.routes import pkm

    rewrite = AsyncMock()
    monkeypatch.setattr(pkm, "rewrite_chat_memory", rewrite)
    with pytest.raises(HTTPException) as refused:
        await pkm.rewrite_memory_document(request(), {"user_id": "different-owner"})
    assert refused.value.status_code == 403
    rewrite.assert_not_awaited()
    rewrite.return_value = memory.RewriteMemoryResponse(markdown="# Memory\n- Coffee.\n")
    response = await pkm.rewrite_memory_document(request(), {"user_id": "synthetic-owner"})
    assert response.headers["cache-control"] == "private, no-store"
    rewrite.side_effect = RuntimeError("Private source text must never be returned")
    with pytest.raises(HTTPException) as failed:
        await pkm.rewrite_memory_document(request(), {"user_id": "synthetic-owner"})
    assert failed.value.status_code == 503
    assert "Private source text" not in failed.value.detail
