"""EmailAgentA2A adapts the read-only EmailChatService.handle_turn dict into the
generic SpecialistTurnResult envelope. The email agent emits no client directive."""

import time
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.adk_bridge.contract import A2AAuthorityContext, A2ATask
from hushh_mcp.adk_bridge.email_agent import EmailAgentA2A


class _FakeEmailService:
    def __init__(self):
        self.calls = []

    async def handle_delegated_turn(self, **kwargs):
        await kwargs["require_access"]()
        self.calls.append(kwargs)
        return {
            "conversationId": "c1",
            "response": "You have 1 thread waiting: Q3 plan from Ravi.",
            "isComplete": True,
            "stateChanged": False,
            "structured": {"connector": "mail", "status": "ok", "metadata_only": True},
        }


def _authority() -> A2AAuthorityContext:
    return A2AAuthorityContext(
        subject_user_id="u",
        tenant_id="tenant_u",
        task_id="task_email",
        caller_kind="first_party",
        invocation_capabilities=("cap.email.metadata.read",),
        expires_at_ms=int(time.time() * 1000) + 60000,
    )


@pytest.fixture(autouse=True)
def _owner_admission(monkeypatch):
    monkeypatch.setattr(
        "hushh_mcp.adk_bridge.email_agent.validate_first_party_owner_token",
        AsyncMock(return_value=SimpleNamespace(user_id="u")),
    )
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("GMAIL_CHAT_READS", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "u")


def _task(**changes):
    return replace(
        A2ATask(
            user_id="u",
            consent_token="t",  # noqa: S106 - synthetic test authority
            conversation_id="one-thread",
            message="search my inbox",
            authority=_authority(),
            expected_tenant_id="tenant_u",
            expected_task_id="task_email",
            execution_surface="typed_chat",
        ),
        **changes,
    )


@pytest.mark.asyncio
async def test_message_turn_maps_to_specialist_result():
    svc = _FakeEmailService()
    agent = EmailAgentA2A(service=svc)
    result = await agent.handle(_task(message="what needs a reply"))
    assert result.text == "You have 1 thread waiting: Q3 plan from Ravi."
    assert result.conversation_id == "one-thread"
    assert result.structured.status == "ok"
    assert result.is_complete is True
    assert result.state_changed is False
    assert result.directive is None
    assert result.model == "one+email"
    # forwarded correctly to the underlying service
    assert svc.calls[0]["user_id"] == "u"
    assert svc.calls[0]["message"] == "what needs a reply"
    assert svc.calls[0]["consent_token"] == "t"
    assert svc.calls[0]["conversation_id"] == "one-thread"


@pytest.mark.asyncio
async def test_read_only_agent_never_emits_directive():
    svc = _FakeEmailService()
    agent = EmailAgentA2A(service=svc)
    result = await agent.handle(_task())
    assert result.directive is None


@pytest.mark.parametrize(
    "changes",
    [
        {"authority": None},
        {"user_id": "other"},
        {"expected_task_id": "other"},
        {"expected_tenant_id": "other"},
        {"execution_surface": None},
        {"planned_action": {}},
        {"delegate_result": {}},
        {"conversation_id": None},
    ],
)
async def test_invalid_hop_is_rejected_before_service(changes):
    service = _FakeEmailService()
    with pytest.raises(PermissionError):
        await EmailAgentA2A(service=service).handle(_task(**changes))
    assert not service.calls


async def test_expired_invocation_and_revoked_owner_are_rejected(monkeypatch):
    service = _FakeEmailService()
    with pytest.raises(PermissionError):
        await EmailAgentA2A(service=service).handle(
            _task(authority=replace(_authority(), expires_at_ms=1))
        )
    monkeypatch.setattr(
        "hushh_mcp.adk_bridge.email_agent.validate_first_party_owner_token",
        AsyncMock(return_value=None),
    )
    with pytest.raises(PermissionError):
        await EmailAgentA2A(service=service).handle(_task())
    assert not service.calls


async def test_disabled_feature_is_unavailable(monkeypatch):
    # Owner-available reads ignore the env switch; admission itself still gates.
    from hushh_mcp.adk_bridge import email_agent

    monkeypatch.setattr(email_agent, "connector_feature_enabled", lambda *_: False)
    service = _FakeEmailService()
    with pytest.raises(PermissionError):
        await EmailAgentA2A(service=service).handle(_task())
    assert not service.calls


def test_get_email_a2a_is_singleton():
    from hushh_mcp.adk_bridge.email_agent import get_email_a2a

    assert get_email_a2a() is get_email_a2a()
