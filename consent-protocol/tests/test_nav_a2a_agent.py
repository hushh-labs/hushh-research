import pytest

from hushh_mcp.adk_bridge.contract import A2ATask
from hushh_mcp.adk_bridge.dispatch import dispatch, is_wired_specialist
from hushh_mcp.adk_bridge.nav_agent import NavAgent
from hushh_mcp.consent.token import issue_token
from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.consent_center_service import ConsentCenterService


@pytest.mark.asyncio
async def test_nav_agent_returns_consent_required_directive_without_review_scope():
    agent = NavAgent()

    result = await agent.handle(
        A2ATask(
            user_id="user_nav",
            consent_token="",
            conversation_id="thread_nav",
            message="Who has access to my vault?",
        )
    )

    assert result.conversation_id == "thread_nav"
    assert result.model == "one+nav"
    assert result.directive is not None
    assert result.directive.kind == "prompt"
    assert result.directive.payload["requiredScope"] == ConsentScope.AGENT_NAV_REVIEW.value
    assert "cannot review" in result.text


@pytest.mark.asyncio
async def test_nav_agent_answers_inline_with_review_scope():
    token = issue_token("user_nav", "agent_nav", ConsentScope.AGENT_NAV_REVIEW).token
    agent = NavAgent()

    result = await agent.handle(
        A2ATask(
            user_id="user_nav",
            consent_token=token,
            conversation_id="thread_nav",
            message="Who has access to my vault?",
        )
    )

    assert result.conversation_id == "thread_nav"
    assert result.model == "one+nav"
    assert result.directive is None
    assert result.text == "You do not have any approved consent requests right now."


@pytest.mark.asyncio
async def test_nav_agent_lists_approved_consent_requests(monkeypatch):
    async def _list_center(self, user_id, **kwargs):  # noqa: ANN001
        assert user_id == "user_nav"
        assert kwargs["actor"] == "investor"
        assert kwargs["surface"] == "active"
        return {
            "total": 2,
            "items": [
                {
                    "id": "grant_1",
                    "request_id": "req_1",
                    "counterpart_label": "Travel Planner",
                    "scope": "cap.location.live.view",
                    "expires_at": "2026-07-04T01:53:37.924978+00:00",
                },
                {
                    "id": "grant_2",
                    "request_id": "req_2",
                    "counterpart_label": "Kai",
                    "scope": "attr.financial.portfolio.*",
                    "scope_description": "Portfolio summary",
                },
            ],
        }

    monkeypatch.setattr(ConsentCenterService, "list_center", _list_center)
    token = issue_token("user_nav", "agent_nav", ConsentScope.AGENT_NAV_REVIEW).token
    agent = NavAgent()

    result = await agent.handle(
        A2ATask(
            user_id="user_nav",
            consent_token=token,
            conversation_id="thread_nav",
            message="show all my consent requests approved",
            timezone="America/Los_Angeles",
        )
    )

    assert result.directive is None
    assert "You have 2 approved consent requests active right now" in result.text
    assert "Travel Planner can view your live location until" in result.text
    assert "6:53 PM PDT" in result.text
    assert "1:53 AM UTC" not in result.text
    assert "Request req_1" not in result.text
    assert "Kai can access portfolio summary" in result.text


@pytest.mark.asyncio
async def test_nav_agent_lists_empty_approved_consent_requests(monkeypatch):
    async def _list_center(self, user_id, **kwargs):  # noqa: ANN001,ARG001
        return {"total": 0, "items": []}

    monkeypatch.setattr(ConsentCenterService, "list_center", _list_center)
    token = issue_token("user_nav", "agent_nav", ConsentScope.AGENT_NAV_REVIEW).token
    agent = NavAgent()

    result = await agent.handle(
        A2ATask(
            user_id="user_nav",
            consent_token=token,
            conversation_id="thread_nav",
            message="show all my consent requests approved",
        )
    )

    assert result.text == "You do not have any approved consent requests right now."


@pytest.mark.asyncio
async def test_nav_is_registered_without_replacing_location():
    import hushh_mcp.adk_bridge  # noqa: F401

    assert is_wired_specialist("agent_location") is True
    assert is_wired_specialist("agent_nav") is True

    token = issue_token("user_nav", "agent_nav", ConsentScope.AGENT_NAV_REVIEW).token
    result = await dispatch(
        "agent_nav",
        A2ATask(
            user_id="user_nav",
            consent_token=token,
            conversation_id="thread_nav",
            message="Explain this scope.",
        ),
    )

    assert result.model == "one+nav"
    assert "Explain this scope." in result.text
