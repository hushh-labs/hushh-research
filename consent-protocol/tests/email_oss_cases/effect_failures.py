"""Known provider refusals and unsupported reviewed envelopes stay truthful."""

from types import SimpleNamespace

import pytest
from langchain_core.messages import AIMessage, ToolMessage

from tests.helpers.email_oss import Execution, call, make_runtime, turn


@pytest.mark.parametrize("uncertain", [False, True])
async def test_draft_rejected_credential_returns_guidance_but_uncertain_effect_stays_failed(
    uncertain,
):
    from hushh_mcp.services.email_oss.gmail_execution import GmailExecutionError

    class Rejected(Execution):
        async def create_draft(self, **kwargs):
            raise GmailExecutionError("reconnect_required", outcome_unknown=uncertain)

    runtime, model, _execution = make_runtime(
        [
            AIMessage(
                content="",
                tool_calls=[
                    call(
                        "create_draft",
                        {"to": "recipient@example.com", "subject": "Draft", "body": "Draft"},
                    )
                ],
            ),
            AIMessage(content="Reconnect Gmail before saving a draft."),
        ],
        execution=Rejected(),
    )
    result = await runtime.handle_turn(**turn())
    assert result["stateChanged"] is False
    if uncertain:
        assert result["status"] == "unavailable" and result["uncertainEffects"]
    else:
        assert result["status"] == "ok" and result["structured"]["status"] == "reconnect_required"
        assert result["response"] == "Reconnect Gmail before saving a draft."
        assert not result["uncertainEffects"]


async def test_reviewed_send_rejects_unsupported_html_instead_of_silently_dropping_it():
    from unittest.mock import AsyncMock

    review = SimpleNamespace(review=AsyncMock())
    runtime, model, execution = make_runtime(
        [
            AIMessage(
                content="",
                tool_calls=[
                    call(
                        "send_email",
                        {
                            "to": "recipient@example.com",
                            "subject": "Hello",
                            "body": "Plain",
                            "html_body": "<b>Rich</b>",
                        },
                    )
                ],
            ),
            AIMessage(content="The review surface supports a plain-text email."),
        ],
        review_port=review,
    )
    result = await runtime.handle_turn(**turn())
    review.review.assert_not_called()
    assert not execution.calls and result["stateChanged"] is False
    tool_result = next(message for message in model.seen[1] if isinstance(message, ToolMessage))
    assert tool_result.status == "error"
