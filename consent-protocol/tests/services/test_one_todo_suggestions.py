import secrets
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError

from hushh_mcp.services.one_todo_suggestions import TaskSuggestionRequest, suggest_tasks

TOKEN = secrets.token_urlsafe()


@pytest.fixture(autouse=True)
def enabled(monkeypatch):
    monkeypatch.setenv("ONE_TODO_SUGGESTIONS_ENABLED", "true")


def request(**updates):
    return TaskSuggestionRequest.model_validate(
        {
            "allow_model_processing": True,
            "sources": [
                {"ref": "s1", "capability": "calendar", "summary": "An upcoming team meeting."}
            ],
            **updates,
        }
    )


@pytest.mark.asyncio
async def test_agent_authors_exact_task_and_only_offered_refs_leave_no_authority_in_prompt():
    output = {
        "items": [
            {
                "source_ref": "s1",
                "title": "Prepare the meeting notes",
                "reason": "The upcoming team meeting needs preparation.",
            }
        ]
    }
    runner, access = AsyncMock(return_value=output), AsyncMock()
    result = await suggest_tasks(
        request(),
        user_id="owner-fixture",
        consent_token=TOKEN,
        require_access=access,
        runner=runner,
    )
    assert result.model_dump() == output
    assert access.await_count == 2
    prompt = runner.call_args.kwargs["prompt"]
    assert "owner-fixture" not in prompt and TOKEN not in prompt


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "capability",
    ["messages", "finance", "wallet", "location", "ria", "gmail", "calendar", "pkm", "consent"],
)
async def test_every_visible_capability_can_reach_the_same_one_gene(capability):
    runner = AsyncMock(return_value={"items": []})
    body = request(
        sources=[{"ref": "s1", "capability": capability, "summary": "Current owner task summary."}]
    )
    assert not (
        await suggest_tasks(
            body,
            user_id="owner",
            consent_token=TOKEN,
            require_access=AsyncMock(),
            runner=runner,
        )
    ).items
    assert capability in runner.call_args.kwargs["prompt"]


@pytest.mark.asyncio
async def test_unapproved_processing_never_dispatches_a_model():
    runner = AsyncMock()
    with pytest.raises(PermissionError):
        await suggest_tasks(
            request(allow_model_processing=False),
            user_id="owner",
            consent_token=TOKEN,
            require_access=AsyncMock(),
            runner=runner,
        )
    runner.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("refs", [["invented"], ["s1", "s1"]])
async def test_unoffered_or_duplicate_output_fails_without_a_semantic_fallback(refs):
    runner = AsyncMock(
        return_value={
            "items": [
                {"source_ref": ref, "title": "Agent title", "reason": "Agent reason"}
                for ref in refs
            ]
        }
    )
    with pytest.raises(ValueError):
        await suggest_tasks(
            request(),
            user_id="owner",
            consent_token=TOKEN,
            require_access=AsyncMock(),
            runner=runner,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("checks", [[PermissionError()], [None, PermissionError()]])
async def test_revoked_authority_refuses_dispatch_or_the_late_result(checks):
    runner = AsyncMock(return_value={"items": []})
    with pytest.raises(PermissionError):
        await suggest_tasks(
            request(),
            user_id="owner",
            consent_token=TOKEN,
            require_access=AsyncMock(side_effect=checks),
            runner=runner,
        )
    assert runner.await_count == len(checks) - 1


def test_request_rejects_extra_private_blobs_and_non_boolean_approval():
    with pytest.raises(ValidationError):
        request(vault_key="not-accepted")
    with pytest.raises(ValidationError):
        request(allow_model_processing="true")
    with pytest.raises(ValidationError):
        request(
            sources=[
                {
                    "ref": "s1",
                    "capability": "calendar",
                    "summary": "x",
                    "message_body": "not-accepted",
                }
            ]
        )


@pytest.mark.asyncio
async def test_kill_switch_prevents_model_dispatch(monkeypatch):
    monkeypatch.setenv("ONE_TODO_SUGGESTIONS_ENABLED", "false")
    runner = AsyncMock()
    with pytest.raises(RuntimeError, match="disabled"):
        await suggest_tasks(
            request(),
            user_id="owner",
            consent_token=TOKEN,
            require_access=AsyncMock(),
            runner=runner,
        )
    runner.assert_not_called()
