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
    run = AsyncMock(return_value={"markdown": "# Memory\n\n## Preferences\n- Coffee.\n"})
    monkeypatch.setattr(memory, "build_single_turn_agent", build)
    monkeypatch.setattr(memory, "run_single_turn", run)
    result = await memory.rewrite_chat_memory(request(), model=selected_model)
    assert "Coffee" in result.markdown
    assert build.call_args.kwargs["model"] is selected_model
    payload = json.loads(run.call_args.kwargs["prompt_parts"])
    assert [message["id"] for message in payload["new_messages"]] == ["new-42"]
    assert "Tea" in payload["current_markdown"]
    assert "history" not in payload


async def test_invalid_or_failed_generation_never_returns_a_replacement(monkeypatch):
    monkeypatch.setattr(memory, "build_single_turn_agent", lambda *a, **kw: "agent")
    run = AsyncMock(return_value={"markdown": ""})
    monkeypatch.setattr(memory, "run_single_turn", run)
    with pytest.raises(ValidationError):
        await memory.rewrite_chat_memory(request())
    run.side_effect = TimeoutError()
    with pytest.raises(TimeoutError):
        await memory.rewrite_chat_memory(request())


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
