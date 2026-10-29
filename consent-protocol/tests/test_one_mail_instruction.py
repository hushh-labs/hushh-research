"""One's typed-chat Mail contract: routing text, owner clock and the receipts barrier."""

from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock
from zoneinfo import ZoneInfo

import pytest
from google.adk.tools import FunctionTool

from hushh_mcp.one_adk import agent_tree
from hushh_mcp.one_adk.external_read_boundary import (
    STATE_EXECUTION_SURFACE,
    STATE_EXTERNAL_READ,
    after_external_read_tool,
    before_external_read_tool,
)
from hushh_mcp.one_adk.mail_instruction import (
    STATE_EMAIL_DRAFT_ENVELOPE,
    draft_opened_message,
    owner_clock_line,
)


def _typed_chat_instruction(**state) -> str:
    base = {
        agent_tree.STATE_EXECUTION_SURFACE: "typed_chat",
        agent_tree.STATE_USER_ID: "owner",
    }
    return agent_tree._one_runtime_instruction(SimpleNamespace(state=base | state))


def test_mail_routing_has_one_owner_per_request_kind():
    composed = _typed_chat_instruction(**{agent_tree.STATE_TIMEZONE: "Asia/Kolkata"})
    # Regression: an earlier rule ("never the platform Email specialist") won
    # over MAIL READ ADMISSION because the instruction says earlier rules win.
    assert "never the platform Email specialist" not in composed
    assert "Call ask_email_agent once with their words" in composed
    assert "recipient_names" in composed
    assert "Spending, purchases, receipts, invoices, bills" in composed
    assert "Bank spending uses Finance" not in composed
    # Regression: "bills due" briefs went to ask_email_agent while bills belonged to the
    # receipt functions, so the same question had two owners.
    assert "bills due" not in composed


def test_owner_clock_grounds_receipt_periods_in_the_declared_zone():
    now = datetime(2026, 10, 29, 23, 30, tzinfo=ZoneInfo("Asia/Kolkata"))
    line = owner_clock_line("Asia/Kolkata", now=now)
    assert "Today is Thursday 2026-10-29 in Asia/Kolkata" in line
    assert "end at 2026-10-30" in line
    # Negative control: an unusable zone never invents a date.
    assert "get_current_time" in owner_clock_line("Not/AZone", now=now)
    assert "Today is" not in owner_clock_line("", now=now)


def test_draft_message_names_the_send_blocker_only_when_there_is_one():
    assert "Connect Gmail" in draft_opened_message("connect_required")
    assert "Allow sending" in draft_opened_message("send_permission_required")
    assert draft_opened_message("ready") == draft_opened_message("unknown")
    assert "Connect" not in draft_opened_message("ready")


@pytest.mark.parametrize("contract", [None, 1, 2])
async def test_only_a_draft_contract_2_app_gets_names_resolved(monkeypatch, contract):
    """Installed apps bundle their web client. One before contract 2 shows the call's
    own To and opens a card for every result, so it must get addresses, never names."""
    from api.routes.one import agent_chat
    from api.routes.one.pod_agent_chat import trusted_state
    from hushh_mcp.one_adk import email_draft_recipients, email_draft_tool
    from tests.test_one_agent_chat_ingress import incoming, request

    forwarded = {} if contract is None else {"emailDraftContract": contract}
    hub = await agent_chat._extract_state(request(), incoming(forwarded_props=dict(forwarded)))
    token = SimpleNamespace(local_token=lambda claims: "synthetic-token")
    owner = SimpleNamespace(owner="owner", claims={}, authority=token)
    pod, _ = trusted_state(incoming(forwarded_props=dict(forwarded)), owner)
    capable = hub[STATE_EMAIL_DRAFT_ENVELOPE]
    assert capable is pod[STATE_EMAIL_DRAFT_ENVELOPE] is (contract == 2)
    composed = _typed_chat_instruction(**{STATE_EMAIL_DRAFT_ENVELOPE: capable})
    address_first = "call list_my_connections first and put their actual email in to"
    assert (address_first in composed) is not capable

    reads: list[str] = []
    rows = [{"displayName": "Sharu Kumar", "email": "sharu@example.com"}]
    connections = SimpleNamespace(list_connections=lambda owner: reads.append(owner) or rows)
    monkeypatch.setattr(email_draft_recipients, "ConnectionsService", lambda: connections)
    monkeypatch.setattr(email_draft_tool, "gmail_send_readiness", AsyncMock(return_value="ready"))
    state = {
        agent_tree.STATE_USER_ID: "owner",
        agent_tree.STATE_EXECUTION_SURFACE: "typed_chat",
        STATE_EMAIL_DRAFT_ENVELOPE: capable,
    }
    context = SimpleNamespace(state=state)
    parked = f"{agent_tree.STATE_PENDING_DIRECTIVE}:gmail_email_draft"
    result = await agent_tree.open_gmail_email_draft("Mail Sharu", context, recipient_names="Sharu")
    if capable:
        assert result["envelope"]["to"] == "sharu@example.com" and parked in state
        return
    # Negative control: before the handshake this name resolved for an older app, which
    # then opened a card with no recipient.
    assert result["status"] == "recipient_address_required"
    assert "list_my_connections" in result["message"]
    assert parked not in state and reads == []
    named_to = await agent_tree.open_gmail_email_draft("Mail Sharu", context, to="Sharu")
    assert named_to["status"] == "recipient_address_required" and parked not in state
    addressed = await agent_tree.open_gmail_email_draft("Mail", context, to="sharu@example.com")
    assert addressed["envelope"]["to"] == "sharu@example.com" and parked in state
    # Surfaces without the typed-chat address rule (Live voice, scheduled tasks) keep names.
    elsewhere = SimpleNamespace(state={agent_tree.STATE_USER_ID: "owner"})
    spoken = await agent_tree.open_gmail_email_draft(
        "Mail Sharu", elsewhere, recipient_names="Sharu"
    )
    assert spoken["status"] == "draft_opened"


def test_a_receipts_handback_admits_only_the_receipt_functions():
    """The specialist's typed no-read status adds One's receipt functions; the barrier stays."""
    import asyncio

    from ag_ui.core import Tool
    from ag_ui_adk.client_proxy_tool import ClientProxyTool
    from google.genai import types

    from hushh_mcp.one_adk.external_read_boundary import before_external_read_model
    from hushh_mcp.one_adk.receipt_client_tools import receipt_tool_declaration
    from tests.test_one_external_read_boundary import _reviewed_native_tool

    mail = FunctionTool(agent_tree.ask_email_agent)
    receipts = ClientProxyTool(
        Tool(**receipt_tool_declaration("receipt_spending")), asyncio.Queue()
    )
    clock = FunctionTool(agent_tree.get_current_time)
    other = FunctionTool(agent_tree.list_my_connections)

    async def get_current_time() -> dict:  # same name and type, not One's clock
        return {}

    impostor_clock = FunctionTool(get_current_time)
    context = SimpleNamespace(
        invocation_id="a", state={STATE_EXECUTION_SURFACE: "typed_chat"}, user_id="owner"
    )

    def next_model_step() -> set[str]:
        request = SimpleNamespace(
            tools_dict={tool.name: tool for tool in (receipts, clock, other)},
            config=types.GenerateContentConfig(),
        )
        before_external_read_model(context, request)
        return set(request.tools_dict)

    def hand_back(invocation: str, *, mcp_read_in_batch: bool) -> None:
        context.invocation_id = invocation
        assert before_external_read_tool(mail, {}, context) is None
        if mcp_read_in_batch:
            # A reviewed MCP read in the same batch writes the same barrier marker.
            assert before_external_read_tool(_reviewed_native_tool(), {}, context) is None
        after_external_read_tool(mail, {}, context, {"status": "receipt_functions_required"})
        # Negative control: the old release cleared the marker and reopened every tool,
        # even with the MCP read's untrusted text in context.
        assert context.state[STATE_EXTERNAL_READ] == invocation
        # Nothing opens until the model has seen the hand-back, so a receipt call in
        # the Email call's own batch stays refused.
        assert before_external_read_tool(receipts, {}, context)["status"] == "blocked"
        assert next_model_step() == {"receipt_spending", "get_current_time"}
        assert before_external_read_tool(receipts, {}, context) is None
        assert before_external_read_tool(clock, {}, context) is None
        # Every other tool stays refused, including same-name stand-ins for the proxy
        # and the clock.
        for refused in (
            other,
            SimpleNamespace(name=receipts.name),
            SimpleNamespace(name=clock.name),
            impostor_clock,
        ):
            assert before_external_read_tool(refused, {}, context)["status"] == "blocked"

    hand_back("a", mcp_read_in_batch=False)
    hand_back("b", mcp_read_in_batch=True)

    # A later turn's actual mail read never inherits an earlier hand-back.
    context.invocation_id = "c"
    assert before_external_read_tool(mail, {}, context) is None
    after_external_read_tool(mail, {}, context, {"status": "ok"})
    assert next_model_step() == set()
    assert before_external_read_tool(receipts, {}, context)["reason"] == "connector_read_complete"
