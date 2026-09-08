"""Hub authority must observe browser intent before advancing the shared ledger."""

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import pytest

from api.routes.one import pod_live_authority as module
from hushh_mcp.services.action_directive_ledger import (
    ActionConfirmationReceipt,
    ActionDirectiveAuthorityError,
    ActionDirectiveStore,
    IssuedActionDirective,
)


@pytest.fixture
def authority(monkeypatch):
    action = {
        "action_id": "test.action",
        "execution_policy": "confirm_required",
        "activation_policy": "trusted_activation_required",
        "execution_target": {"status": "wired"},
    }
    monkeypatch.setattr(module, "get_action_gateway_action", lambda _: action)
    monkeypatch.setattr(module, "sanitize_live_context", lambda value: value)
    now = datetime.now(UTC)
    store = AsyncMock(spec=ActionDirectiveStore)
    store.issue.return_value = IssuedActionDirective(
        "dir_test", "test.action", "rev", now + timedelta(minutes=5)
    )
    store.confirm.return_value = ActionConfirmationReceipt(
        "dir_test", "real-receipt", now + timedelta(minutes=5), now, True
    )
    access = AsyncMock()
    broker = module.HubVoiceAuthority(
        user_id="owner", session_id="socket", require_access=access, store=store
    )
    broker.observe_browser(
        {
            "type": "app_context",
            "appContext": {"available_action_ids": ["test.action"], "context_revision": "rev"},
        }
    )
    return broker, store, access, action


def issue_args(**overrides):
    return dict(
        user_id="owner",
        channel="voice",
        session_id="socket",
        action_id="test.action",
        context_revision="rev",
        action_contract={"forged": True},
        slots={},
        **overrides,
    )


def binding_args():
    return dict(
        user_id="owner", directive_id="dir_test", action_id="test.action", context_revision="rev"
    )


def directive(**overrides):
    return {
        "clientDirective": {
            "kind": "action",
            "payload": {
                "directiveId": "dir_test",
                "actionId": "test.action",
                "contextRevision": "rev",
                "slots": {},
                **overrides,
            },
        }
    }


def browser(kind, **overrides):
    key = "actionConfirmation" if kind == "action_confirm" else "actionSettlement"
    return {
        "type": kind,
        key: {
            "directiveId": "dir_test",
            "actionId": "test.action",
            "contextRevision": "rev",
            **overrides,
        },
    }


@pytest.mark.asyncio
async def test_confirmation_requires_observed_browser_and_real_receipt(authority):
    broker, store, access, action = authority
    await broker.invoke("issue", issue_args())
    assert store.issue.call_args.kwargs["action_contract"] == action
    output = broker.validate_outbound(
        directive(needsConfirmation=False, trustedActivationRequired=False)
    )
    assert output["clientDirective"]["payload"]["trustedActivationRequired"] is True
    with pytest.raises(ActionDirectiveAuthorityError):
        await broker.invoke("confirm", binding_args())
    store.confirm.assert_not_called()
    broker.observe_browser(browser("action_confirm"))
    await broker.invoke("confirm", binding_args())
    with pytest.raises(ActionDirectiveAuthorityError):
        await broker.invoke("consume", dict(binding_args(), receipt="forged"))
    store.consume.assert_not_called()
    await broker.invoke("consume", dict(binding_args(), receipt="real-receipt"))
    accepted = {
        "actionConfirmationAccepted": {"directiveId": "dir_test", "receipt": "real-receipt"}
    }
    broker.validate_outbound(accepted)
    with pytest.raises(ActionDirectiveAuthorityError):
        broker.validate_outbound(accepted)
    settled = dict(
        binding_args(), receipt="real-receipt", status="succeeded", reason_code="succeeded"
    )
    with pytest.raises(ActionDirectiveAuthorityError):
        await broker.invoke("settle", settled)
    broker.observe_browser(browser("action_settled", receipt="real-receipt", status="succeeded"))
    await broker.invoke("settle", settled)
    store.settle.assert_awaited_once()
    with pytest.raises(ActionDirectiveAuthorityError):
        await broker.invoke("settle", settled)
    assert access.await_count >= 4


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "field,value",
    [
        ("user_id", "foreign"),
        ("session_id", "other"),
        ("action_id", "unknown"),
        ("context_revision", "stale"),
        ("channel", "typed_chat"),
    ],
)
async def test_issue_rejects_wrong_binding_before_ledger(authority, field, value):
    broker, store, _, _ = authority
    args = issue_args()
    args[field] = value
    with pytest.raises(ActionDirectiveAuthorityError):
        await broker.invoke("issue", args)
    store.issue.assert_not_called()


@pytest.mark.asyncio
async def test_revoked_access_never_reaches_ledger(authority):
    broker, store, access, _ = authority
    access.side_effect = ActionDirectiveAuthorityError("revoked")
    with pytest.raises(ActionDirectiveAuthorityError):
        await broker.invoke("issue", issue_args())
    store.issue.assert_not_called()


@pytest.mark.asyncio
async def test_outbound_forgery_and_replay_refused(authority):
    broker, _, _, _ = authority
    await broker.invoke("issue", issue_args())
    for frame in [
        directive(directiveId="foreign"),
        directive(slots={"target": "other"}),
        {"clientDirective": {"kind": "specialist", "payload": {}}},
    ]:
        with pytest.raises(ActionDirectiveAuthorityError):
            broker.validate_outbound(frame)
    broker.validate_outbound(directive())
    with pytest.raises(ActionDirectiveAuthorityError):
        broker.validate_outbound(directive())


@pytest.mark.asyncio
@pytest.mark.parametrize("tap", [False, True])
async def test_direct_policy_preserves_browser_tap_preference(authority, tap):
    broker, store, _, action = authority
    action["activation_policy"] = "none"
    broker.observe_browser(
        {
            "type": "app_context",
            "appContext": {
                "available_action_ids": ["test.action"],
                "context_revision": "rev",
                "voice_settings": {"require_tap_confirmation": tap},
            },
        }
    )
    await broker.invoke("issue", issue_args())
    assert (
        broker.validate_outbound(directive())["clientDirective"]["payload"]["needsConfirmation"]
        is tap
    )
    broker.observe_browser(browser("action_settled", status="succeeded"))
    args = dict(binding_args(), status="succeeded", reason_code="succeeded")
    if tap:
        with pytest.raises(ActionDirectiveAuthorityError):
            await broker.invoke("settle_direct", args)
        store.settle_direct.assert_not_called()
    else:
        await broker.invoke("settle_direct", args)
        store.settle_direct.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change",
    [
        {"context_revision": "new"},
        {"available_action_ids": []},
        {"voice_settings": {"voice_enabled": False}},
    ],
)
async def test_context_change_disarms_observed_confirmation(authority, change):
    broker, store, _, _ = authority
    await broker.invoke("issue", issue_args())
    broker.validate_outbound(directive())
    broker.observe_browser(browser("action_confirm"))
    broker.observe_browser(
        {
            "type": "app_context",
            "appContext": {
                "available_action_ids": ["test.action"],
                "context_revision": "rev",
                **change,
            },
        }
    )
    with pytest.raises(ActionDirectiveAuthorityError):
        await broker.invoke("confirm", binding_args())
    store.confirm.assert_not_called()


@pytest.mark.asyncio
async def test_disabled_voice_never_issues(authority):
    broker, store, _, _ = authority
    broker.observe_browser(
        {
            "type": "app_context",
            "appContext": {
                "available_action_ids": ["test.action"],
                "context_revision": "rev",
                "voice_settings": {"voice_enabled": False},
            },
        }
    )
    with pytest.raises(ActionDirectiveAuthorityError):
        await broker.invoke("issue", issue_args())
    store.issue.assert_not_called()


@pytest.mark.asyncio
async def test_store_port_round_trip_over_transport(authority):
    import asyncio
    import json

    from api.routes.one.pod_live_store import PodVoiceDirectiveStore
    from api.routes.one.pod_live_transport import PodLiveTransport

    broker, ledger, _, _ = authority

    class Socket:
        def __init__(self):
            self.inbound = asyncio.Queue()

        async def receive_text(self):
            return await self.inbound.get()

        async def send_text(self, raw):
            response = await broker.dispatch(json.loads(raw))
            await self.inbound.put(json.dumps(response))

        async def close(self, **kwargs):
            pass

    async with PodLiveTransport(Socket()) as transport:
        port = PodVoiceDirectiveStore(transport)
        issued = await port.issue(**issue_args())
        assert issued == ledger.issue.return_value
        broker.validate_outbound(directive())
        broker.observe_browser(browser("action_confirm"))
        receipt = await port.confirm(**binding_args())
        assert receipt == ledger.confirm.return_value
        await port.consume(**dict(binding_args(), receipt=receipt.receipt))
        broker.validate_outbound(
            {
                "actionConfirmationAccepted": {
                    "directiveId": issued.directive_id,
                    "receipt": receipt.receipt,
                }
            }
        )
        broker.observe_browser(
            browser("action_settled", status="succeeded", receipt=receipt.receipt)
        )
        await port.settle(
            **dict(
                binding_args(), receipt=receipt.receipt, status="succeeded", reason_code="succeeded"
            )
        )
    ledger.settle.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "frame",
    [
        {
            "type": "pod_voice_authority_request",
            "requestId": "x",
            "method": "__getattribute__",
            "arguments": {},
        },
        {
            "type": "pod_voice_authority_request",
            "requestId": "x",
            "method": "issue",
            "arguments": [],
        },
        {
            "type": "pod_voice_authority_request",
            "requestId": "",
            "method": "issue",
            "arguments": {},
        },
    ],
)
async def test_dispatch_refuses_invalid_internal_frames(authority, frame):
    broker, ledger, _, _ = authority
    with pytest.raises(ActionDirectiveAuthorityError):
        await broker.dispatch(frame)
    ledger.issue.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change", [{"expires_at": "2026-09-07T00:00:00"}, {"directive_id": 42}, {"unexpected": True}]
)
async def test_store_port_refuses_malformed_authority_record(change):
    from api.routes.one.pod_live_store import PodVoiceDirectiveStore

    transport = AsyncMock()
    transport.request.return_value = {
        "directive_id": "dir_test",
        "action_id": "test.action",
        "context_revision": "rev",
        "expires_at": "2026-09-07T00:00:00+00:00",
        **change,
    }
    with pytest.raises(ActionDirectiveAuthorityError):
        await PodVoiceDirectiveStore(transport).issue(**issue_args())
    transport.request.assert_awaited_once()


def test_specialist_proposal_uses_existing_owner_confirmation_handoff(authority):
    broker, ledger, _, _ = authority
    broker.observe_browser(
        {"type": "app_context", "appContext": {"route_family": "/one", "context_revision": "rev"}}
    )
    proposal = {
        "clientDirective": {
            "kind": "action",
            "delegateAgentId": "agent_location",
            "payload": {"type": "check_in", "id": "synthetic"},
        }
    }
    assert broker.validate_outbound(proposal) == proposal
    ledger.issue.assert_not_called()
    ledger.confirm.assert_not_called()


def test_gmail_draft_preserves_one_owner_in_live_handoff(authority):
    broker, _, _, _ = authority
    broker.observe_browser(
        {"type": "app_context", "appContext": {"route_family": "/one", "context_revision": "rev"}}
    )
    proposal = {
        "clientDirective": {
            "kind": "prompt",
            "payload": {"kind": "gmail_email_draft", "subject": "synthetic", "body": "synthetic"},
        }
    }
    result = broker.validate_outbound(proposal)
    assert result["clientDirective"]["delegateAgentId"] == "one"
    assert result["clientDirective"]["payload"] == proposal["clientDirective"]["payload"]


@pytest.mark.parametrize(
    "directive",
    [
        {"kind": "action_result", "payload": {"actionId": "test.action", "message": "done"}},
        {"kind": "publish_location_envelopes", "payload": {}},
        {
            "kind": "action",
            "delegateAgentId": "agent_location",
            "payload": {"type": "publish_location_envelopes"},
        },
        {"kind": "navigate", "payload": {"url": "/one"}},
        {"kind": "prompt", "delegateAgentId": "unknown-agent", "payload": {}},
        {"kind": "prompt", "payload": {"kind": "invented"}},
        {
            "kind": "action",
            "delegateAgentId": "agent_location",
            "payload": {"actionId": "test.action", "directiveId": "forged"},
        },
    ],
)
def test_proposal_handoff_cannot_bypass_execution_authority(authority, directive):
    broker, ledger, _, _ = authority
    broker.observe_browser(
        {"type": "app_context", "appContext": {"route_family": "/one", "context_revision": "rev"}}
    )
    with pytest.raises(ActionDirectiveAuthorityError):
        broker.validate_outbound({"clientDirective": directive})
    ledger.issue.assert_not_called()


def test_disabled_domain_blocks_specialist_proposal(authority):
    broker, _, _, _ = authority
    broker.observe_browser(
        {
            "type": "app_context",
            "appContext": {
                "route_family": "/one",
                "context_revision": "rev",
                "voice_settings": {"disabled_domains": ["location"]},
            },
        }
    )
    with pytest.raises(ActionDirectiveAuthorityError):
        broker.validate_outbound(
            {
                "clientDirective": {
                    "kind": "action",
                    "delegateAgentId": "agent_location",
                    "payload": {"type": "check_in"},
                }
            }
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "executable,allowed", [(["test.action"], True), ([], False), (None, False)]
)
async def test_execution_scope_is_independent_of_prompt_inventory(authority, executable, allowed):
    broker, store, _, _ = authority
    broker.observe_browser(
        {
            "type": "app_context",
            "appContext": {
                "context_revision": "rev",
                "available_action_ids": [] if allowed else ["test.action"],
                "executable_action_ids": executable,
            },
        }
    )
    if allowed:
        await broker.dispatch(
            {
                "type": "pod_voice_authority_request",
                "requestId": "execution-scope",
                "method": "issue",
                "arguments": issue_args(),
            }
        )
        assert (
            broker.validate_outbound(directive())["clientDirective"]["payload"]["actionId"]
            == "test.action"
        )
    else:
        with pytest.raises(ActionDirectiveAuthorityError):
            await broker.dispatch(
                {
                    "type": "pod_voice_authority_request",
                    "requestId": "execution-scope",
                    "method": "issue",
                    "arguments": issue_args(),
                }
            )
        store.issue.assert_not_awaited()
