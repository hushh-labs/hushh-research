"""EmailAgentA2A adapts the read-only EmailChatService.handle_turn dict into the
generic SpecialistTurnResult envelope. The email agent issues no client directive
of its own: its one directive is the receipts "not ready" proposal, which One
validates and parks through the action gateway."""

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
    assert svc.calls[0]["timezone"] == "UTC"


async def test_person_timezone_reaches_the_mail_read():
    svc = _FakeEmailService()
    await EmailAgentA2A(service=svc).handle(_task(timezone="America/New_York"))
    assert svc.calls[0]["timezone"] == "America/New_York"


async def test_typed_offer_is_private_handback_and_latest_needs_explicit_plan():
    svc = _FakeEmailService()
    original = svc.handle_delegated_turn

    async def read(**kwargs):
        outcome = await original(**kwargs)
        outcome["offer"] = {
            "message_ids": ["private-mail-id"],
            "account": "private-google-account",
            "mailbox": "inbox",
        }
        return outcome

    svc.handle_delegated_turn = read
    result = await EmailAgentA2A(service=svc).handle(_task())
    assert svc.calls[0]["require_explicit_latest"] is True
    assert result.mail_read_offer["message_ids"] == ["private-mail-id"]
    assert result.mail_read_offer["owner_id"] == "u"
    assert result.mail_read_offer["conversation_id"] == "one-thread"
    assert "private-mail-id" not in result.text
    assert "private-mail-id" not in result.structured.model_dump_json()


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


async def test_receipt_memory_and_cursor_reach_the_service_and_the_proposal_is_mapped():
    class _ReceiptsService(_FakeEmailService):
        async def handle_delegated_turn(self, **kwargs):
            await kwargs["require_access"]()
            self.calls.append(kwargs)
            return {
                "conversationId": "c1",
                "response": "Your receipt memory is not ready yet. Sync and save your receipts in Mail.",
                "isComplete": True,
                "stateChanged": False,
                "structured": {
                    "connector": "mail",
                    "status": "input_required",
                    "metadata_only": True,
                },
                "receipt_cursor": {"action": "clear", "value": None},
                "directive": {
                    "type": "receipts_open_proposal",
                    "actionId": "route.profile_receipts",
                    "slots": {},
                },
            }

    service = _ReceiptsService()
    result = await EmailAgentA2A(service=service).handle(
        _task(message="show my receipts", receipt_memory={"schema": "x"}, receipt_cursor="cursor")
    )
    assert service.calls[0]["receipt_memory"] == {"schema": "x"}
    assert service.calls[0]["receipt_cursor"] == "cursor"
    assert result.structured.status == "input_required"
    assert result.directive.kind == "action"
    assert result.directive.payload["actionId"] == "route.profile_receipts"
    assert result.continuation == {"action": "clear", "value": None}
    assert result.state_changed is False


async def test_a_plain_read_carries_no_receipt_context_and_no_continuation():
    service = _FakeEmailService()
    result = await EmailAgentA2A(service=service).handle(_task())
    assert service.calls[0]["receipt_memory"] is None
    assert service.calls[0]["receipt_cursor"] is None
    assert result.continuation is None
