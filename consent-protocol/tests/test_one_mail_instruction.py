"""One's typed-chat Mail contract: routing text, owner clock and the receipts barrier."""

from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from zoneinfo import ZoneInfo

from google.adk.tools import FunctionTool

from hushh_mcp.one_adk import agent_tree
from hushh_mcp.one_adk.external_read_boundary import (
    STATE_EXECUTION_SURFACE,
    STATE_EXTERNAL_READ,
    after_external_read_tool,
    before_external_read_tool,
)
from hushh_mcp.one_adk.mail_instruction import draft_opened_message, owner_clock_line


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


def test_receipts_request_without_a_mail_read_keeps_the_receipt_functions():
    """Only the specialist's typed no-read status lifts the barrier it set."""

    mail = FunctionTool(agent_tree.ask_email_agent)
    receipts = SimpleNamespace(name="receipt_spending")
    context = SimpleNamespace(
        invocation_id="turn", state={STATE_EXECUTION_SURFACE: "typed_chat"}, user_id="owner"
    )
    assert before_external_read_tool(mail, {}, context) is None
    after_external_read_tool(mail, {}, context, {"status": "receipt_functions_required"})
    assert context.state[STATE_EXTERNAL_READ] is None
    assert before_external_read_tool(receipts, {}, context) is None

    # Negative control: an actual mail read keeps every later action blocked.
    assert before_external_read_tool(mail, {}, context) is None
    after_external_read_tool(mail, {}, context, {"status": "ok"})
    assert context.state[STATE_EXTERNAL_READ] == "turn"
    assert before_external_read_tool(receipts, {}, context)["reason"] == "connector_read_complete"
