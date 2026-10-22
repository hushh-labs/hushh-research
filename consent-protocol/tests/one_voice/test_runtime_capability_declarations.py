"""Live tool offers match the client's review capability and enabled gates."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from hushh_mcp.one_voice.instruction import build_instruction
from hushh_mcp.one_voice.tools import registry
from hushh_mcp.one_voice.tools.base import EntityContext, ScreenContext, ToolContext
from hushh_mcp.one_voice.tools.executor import ToolExecutor
from hushh_mcp.one_voice.tools.mail import SendMailInput, _prepare_send_mail, _send_mail
from hushh_mcp.one_voice.tools.session import OPENABLE_SCREENS


def _names(*, review: bool) -> set[str]:
    return {item["name"] for item in registry.runtime_declarations(mail_review_supported=review)}


def test_review_capability_presents_one_new_mail_path(monkeypatch):
    monkeypatch.setenv("ONE_VOICE_MAIL_READS_ENABLED", "true")
    monkeypatch.setenv("ONE_VOICE_MAIL_REPLY_ENABLED", "true")
    monkeypatch.setenv("ONE_VOICE_MAIL_DRAFTS_ENABLED", "true")
    monkeypatch.setenv("ONE_VOICE_MAIL_SCHEDULE_SEND_ENABLED", "true")
    monkeypatch.setenv("MAIL_SCHEDULED_DRAIN_ENABLED", "true")
    modern = _names(review=True)
    legacy = _names(review=False)
    assert "send_mail" not in modern
    assert {
        "compose_mail",
        "edit_mail_draft",
        "send_reviewed_mail",
        "get_mail_draft_status",
    } <= modern
    assert "send_mail" in legacy
    assert (
        not {"compose_mail", "edit_mail_draft", "send_reviewed_mail", "get_mail_draft_status"}
        & legacy
    )
    assert {"reply_mail", "read_calendar", "read_mail"} <= modern & legacy


def test_each_negotiated_full_mail_catalog_fits_the_existing_budget(monkeypatch):
    for key in (
        "ONE_VOICE_MAIL_READS_ENABLED",
        "ONE_VOICE_MAIL_REPLY_ENABLED",
        "ONE_VOICE_MAIL_DRAFTS_ENABLED",
        "ONE_VOICE_MAIL_SCHEDULE_SEND_ENABLED",
        "MAIL_SCHEDULED_DRAIN_ENABLED",
    ):
        monkeypatch.setenv(key, "true")
    cap_path = (
        Path(__file__).resolve().parents[2] / "contracts" / "one_voice_performance_budget.v1.json"
    )
    caps = json.loads(cap_path.read_text(encoding="utf-8"))
    for review in (False, True):
        declarations = registry.runtime_declarations(mail_review_supported=review)
        instruction = build_instruction(
            tool_declarations=declarations,
            screen_ids=list(OPENABLE_SCREENS),
            screen_id="one_home",
            display_name=None,
        )
        schema = json.dumps(declarations, ensure_ascii=False, separators=(",", ":"))
        assert len(declarations) <= caps["tool_count"]
        assert len(schema.encode("utf-8")) <= caps["tool_schema_json_bytes"]
        assert len(instruction) <= caps["instruction_chars"]
        assert len(instruction.encode("utf-8")) <= caps["instruction_utf8_bytes"]


def test_disabled_mail_gates_remove_dead_end_declarations(monkeypatch):
    for key in (
        "ONE_VOICE_MAIL_READS_ENABLED",
        "ONE_VOICE_MAIL_REPLY_ENABLED",
        "ONE_VOICE_MAIL_DRAFTS_ENABLED",
        "ONE_VOICE_MAIL_SCHEDULE_SEND_ENABLED",
        "MAIL_SCHEDULED_DRAIN_ENABLED",
    ):
        monkeypatch.setenv(key, "false")
    declared = _names(review=True)
    assert (
        not {
            "read_mail",
            "open_mail",
            "reply_mail",
            "schedule_mail",
            "list_scheduled_mail",
            "cancel_scheduled_mail",
            "list_drafts",
            "open_draft",
            "send_draft",
        }
        & declared
    )
    assert "read_calendar" in declared
    assert "get_mail_access" in declared


@pytest.mark.asyncio
async def test_review_client_refuses_legacy_send_before_lookup_or_pending_card():
    ctx = ToolContext(
        user_id="owner",
        conversation_id="conversation",
        entities=EntityContext(),
        screen=ScreenContext(),
        vault_owner_token="vault-token",  # noqa: S106 - test fixture
    )
    ctx.services["mail_compose"] = SimpleNamespace(review_supported=True)
    args = SendMailInput.model_validate(
        {"recipient": {"user_id": "unconfirmed-person"}, "subject": "", "message": "Hello"}
    )
    outcome = await ToolExecutor().call(ctx, "send_mail", args.model_dump())
    assert outcome.result.reason_code == "review_flow_required"
    assert outcome.pending is None
    assert (await _prepare_send_mail(ctx, args)).reason_code == "review_flow_required"
    assert (await _send_mail(ctx, args)).reason_code == "review_flow_required"
