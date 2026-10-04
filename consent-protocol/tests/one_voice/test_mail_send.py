"""Voice mail drafting keeps recipient identity and delivery behind separate gates."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from hushh_mcp.one_voice import private_pending
from hushh_mcp.one_voice.tools import mail, registry
from hushh_mcp.one_voice.tools.base import ToolPolicy
from hushh_mcp.one_voice.tools.executor import ToolExecutor
from hushh_mcp.services import action_gateway
from hushh_mcp.services.gmail_delivery_service import GmailDeliveryService
from tests.one_voice.fakes import MemoryPendingStore
from tests.one_voice.test_tools_people import AISHA, AYESHA, OWNER, ConnectionsDouble, make_ctx

MESSAGE = "I will send the demo tomorrow. Please check it when you can."


@pytest.fixture
def mail_harness(monkeypatch):
    # Both the pending ciphertext and recipient binding use the runtime key.
    # Keep this fixture independent of local or deployed secrets.
    settings = SimpleNamespace(app_signing_key="voice-mail-test-signing-key")
    monkeypatch.setattr(mail, "get_core_security_settings", lambda: settings)
    monkeypatch.setattr(private_pending, "get_core_security_settings", lambda: settings)

    async def no_delivery(*_args, **_kwargs):
        raise AssertionError("a voice tool must not call the Gmail delivery pipeline")

    monkeypatch.setattr(GmailDeliveryService, "prepare", no_delivery)
    monkeypatch.setattr(GmailDeliveryService, "execute", no_delivery)

    connections = ConnectionsDouble()
    ctx, _, _ = make_ctx(connections=connections)
    pending = MemoryPendingStore()
    return ctx, connections, ToolExecutor(pending_store=pending)


async def _confirm_ayesha(ctx, executor):
    found = await executor.call(
        ctx, "resolve_person", {"spoken_name": "Ayesha Sharma", "pool": "connections"}
    )
    assert found.result.status in {"single_likely", "multiple"}
    assert AYESHA in ctx.entities.offered_person_ids
    confirmed = await executor.call(ctx, "confirm_person", {"user_id": AYESHA})
    assert confirmed.result.status == "confirmed"


async def _pending_draft(ctx, executor, *, subject="Demo tomorrow", message=MESSAGE):
    outcome = await executor.call(
        ctx,
        "send_mail",
        {
            "recipient": {"user_id": AYESHA},
            "subject": subject,
            "message": message,
        },
    )
    assert outcome.result.status == "confirmation_required"
    assert outcome.result.tier == "voice"
    assert outcome.pending is not None
    return outcome.pending


@pytest.mark.asyncio
async def test_send_mail_binds_without_gateway_aliases_and_opens_only_a_review_draft(
    mail_harness, monkeypatch
):
    ctx, connections, executor = mail_harness
    real_gateway = action_gateway.get_action_gateway_action
    alias_reads: list[str] = []

    class AliasTrap(dict):
        def get(self, key, default=None):
            if key in {"aliases", "search_keywords"}:
                alias_reads.append(key)
            return super().get(key, default)

        def __getitem__(self, key):
            if key in {"aliases", "search_keywords"}:
                alias_reads.append(key)
            return super().__getitem__(key)

    def alias_free(action_id):
        entry = real_gateway(action_id)
        if entry is None:
            return None
        return AliasTrap({**entry, "aliases": [], "search_keywords": []})

    monkeypatch.setattr(action_gateway, "get_action_gateway_action", alias_free)
    assert registry.validate_gateway_binding() == []
    spec = registry.get_tool("send_mail")
    assert spec is not None
    assert spec.policy is ToolPolicy.confirm_voice
    assert spec.person_args == ("recipient",)
    assert spec.gateway_action_id == "email.chat.turn"
    assert "message" in spec.declaration()["parameters_json_schema"]["properties"]

    await _confirm_ayesha(ctx, executor)
    pending = await _pending_draft(ctx, executor)
    assert pending.summary == "draft an email to Ayesha Sharma"
    assert alias_reads == []

    # A spoken yes is accepted only after the pending card was shown.
    await executor.pending.mark_shown(user_id=OWNER, pending_action_id=pending.id)
    confirmed = await executor.call(
        ctx, "confirm_pending_action", {"pending_action_id": pending.id}
    )
    assert confirmed.result.status == "draft_open_requested"
    assert confirmed.result.needs == "client_step"
    assert confirmed.result.client_step == {
        "kind": "open_mail_draft",
        "draft": {
            "to": "ayesha@example.com",
            "to_name": "Ayesha Sharma",
            "subject": "Demo tomorrow",
            "body": MESSAGE,
        },
    }
    assert confirmed.pending is not None
    assert confirmed.pending.result == {"status": "draft_open_requested", "needs": "client_step"}
    assert "_sealed_args" not in confirmed.pending.args
    assert all(owner == OWNER for name, owner in connections.calls if name == "list_connections")
    assert alias_reads == []


@pytest.mark.asyncio
async def test_pending_row_and_model_receipt_do_not_expose_full_draft(mail_harness):
    ctx, _connections, executor = mail_harness
    await _confirm_ayesha(ctx, executor)
    private_message = "Private draft detail: " + "x" * 220
    pending = await _pending_draft(
        ctx, executor, subject="Private subject", message=private_message
    )
    stored = json.dumps(pending.args)
    visible = json.dumps(pending.public())
    for secret in ("Private subject", private_message, "ayesha@example.com"):
        assert secret not in stored
        assert secret not in visible
    assert pending.args["_sealed_args"].startswith("v1:")

    await executor.pending.mark_shown(user_id=OWNER, pending_action_id=pending.id)
    confirmed = await executor.call(
        ctx, "confirm_pending_action", {"pending_action_id": pending.id}
    )
    assert confirmed.result.client_step["draft"]["body"] == private_message
    receipt = json.dumps(confirmed.result.model_public())
    assert "ayesha@example.com" not in receipt
    assert private_message not in receipt
    assert "Private subject" in receipt  # The owner-authored spoken summary may name it.
    assert private_message not in json.dumps(confirmed.pending.result)


@pytest.mark.asyncio
async def test_identical_dictation_is_a_new_proposal_never_a_reused_card(mail_harness):
    """Sealed drafts are excluded from the duplicate-proposal guard: two
    dictations to one recipient compare equal on public args alone."""
    ctx, _connections, executor = mail_harness
    await _confirm_ayesha(ctx, executor)
    first = await _pending_draft(ctx, executor)
    outcome = await executor.call(
        ctx,
        "send_mail",
        {"recipient": {"user_id": AYESHA}, "subject": "Demo tomorrow", "message": MESSAGE},
    )
    assert outcome.result.status == "confirmation_required"
    assert outcome.pending is not None and outcome.pending.id != first.id
    assert [row.id for row in outcome.superseded] == [first.id]


@pytest.mark.asyncio
async def test_tampered_pending_recipient_cannot_open_the_sealed_draft(mail_harness):
    ctx, _connections, executor = mail_harness
    await _confirm_ayesha(ctx, executor)
    pending = await _pending_draft(ctx, executor)
    pending.args["recipient"] = {"user_id": AISHA}

    await executor.pending.mark_shown(user_id=OWNER, pending_action_id=pending.id)
    confirmed = await executor.call(
        ctx, "confirm_pending_action", {"pending_action_id": pending.id}
    )
    assert confirmed.result.status == "rejected"
    assert confirmed.result.reason_code == "execution_failed"
    assert "client_step" not in confirmed.result.public()
    assert confirmed.pending is not None and confirmed.pending.status == "failed"


@pytest.mark.asyncio
async def test_expired_confirmed_mail_draft_is_scrubbed_after_an_interrupted_execution():
    pending = MemoryPendingStore()
    row, _ = await pending.create(
        user_id=OWNER,
        conversation_id="conv-1",
        tool_name="send_mail",
        gateway_action_id="email.chat.turn",
        tier="voice",
        args={"recipient": {"user_id": AYESHA}, "_sealed_args": "v1:fixture-ciphertext"},
        summary="draft an email",
    )
    await pending.mark_shown(user_id=OWNER, pending_action_id=row.id)
    await pending.confirm(user_id=OWNER, pending_action_id=row.id, source="voice")
    row.expires_at = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()

    await pending.expire_stale(user_id="other-owner")
    assert row.status == "confirmed" and "_sealed_args" in row.args
    await pending.expire_stale(user_id=OWNER)
    assert row.status == "failed"
    assert row.result == {"status": "draft_open_unconfirmed", "needs": None}
    assert row.resolved_at is not None
    assert row.args == {"recipient": {"user_id": AYESHA}}


@pytest.mark.asyncio
async def test_send_mail_requires_a_confirmed_connected_person(mail_harness):
    ctx, _connections, executor = mail_harness
    unconfirmed = await executor.call(
        ctx,
        "send_mail",
        {"recipient": {"user_id": AYESHA}, "message": MESSAGE},
    )
    assert unconfirmed.result.reason_code == "person_not_confirmed"
    assert unconfirmed.pending is None

    found = await executor.call(
        ctx, "resolve_person", {"spoken_name": "Preeti", "pool": "directory"}
    )
    assert found.result.status == "single_likely"
    confirmed = await executor.call(ctx, "confirm_person", {"user_id": "u-preeti"})
    assert confirmed.result.status == "confirmed"
    not_connected = await executor.call(
        ctx,
        "send_mail",
        {"recipient": {"user_id": "u-preeti"}, "message": MESSAGE},
    )
    assert not_connected.result.reason_code == "recipient_not_connected"
    assert not_connected.pending is None


@pytest.mark.asyncio
@pytest.mark.parametrize("address", [None, "", "not-an-email", "one@example.com,two@example.com"])
async def test_missing_or_invalid_connection_email_never_creates_a_card(mail_harness, address):
    ctx, connections, executor = mail_harness
    # Aisha is a real confirmed connection in the people double, but her
    # address is absent or malformed in the owner's active connection row.
    connections.connections[1]["email"] = address
    found = await executor.call(
        ctx, "resolve_person", {"spoken_name": "Aisha Khan", "pool": "connections"}
    )
    assert found.result.status in {"single_likely", "multiple"}
    assert AISHA in ctx.entities.offered_person_ids
    confirmed = await executor.call(ctx, "confirm_person", {"user_id": AISHA})
    assert confirmed.result.status == "confirmed"
    outcome = await executor.call(
        ctx,
        "send_mail",
        {"recipient": {"user_id": AISHA}, "message": MESSAGE},
    )
    assert outcome.result.status == "rejected"
    assert outcome.result.reason_code == "person_has_no_email"
    assert outcome.result.spoken_facts == [
        "I don't have an email address for Aisha Khan, so I can't draft this."
    ]
    assert outcome.pending is None
    assert (
        await executor.pending.list_open(user_id=OWNER, conversation_id=ctx.conversation_id) == []
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["address", "removed"])
async def test_recipient_change_after_spoken_confirmation_does_not_open_draft(mail_harness, change):
    ctx, connections, executor = mail_harness
    await _confirm_ayesha(ctx, executor)
    pending = await _pending_draft(ctx, executor)
    if change == "address":
        connections.connections[0]["email"] = "other@example.com"
    else:
        connections.connections = [
            row for row in connections.connections if row["userId"] != AYESHA
        ]

    await executor.pending.mark_shown(user_id=OWNER, pending_action_id=pending.id)
    confirmed = await executor.call(
        ctx, "confirm_pending_action", {"pending_action_id": pending.id}
    )
    assert confirmed.result.status == "rejected"
    assert confirmed.result.reason_code in {"recipient_changed", "person_has_no_email"}
    assert "client_step" not in confirmed.result.public()
    assert confirmed.pending is not None and confirmed.pending.status == "failed"


@pytest.mark.asyncio
async def test_send_mail_rejects_values_the_gmail_draft_cannot_accept(mail_harness):
    ctx, _connections, executor = mail_harness
    await _confirm_ayesha(ctx, executor)
    for args in (
        {"subject": "s" * 257, "message": MESSAGE},
        {"subject": "ok", "message": "m" * 4001},
        {"subject": "bad\nheader", "message": MESSAGE},
        {"subject": "ok", "message": "   "},
    ):
        outcome = await executor.call(ctx, "send_mail", {"recipient": {"user_id": AYESHA}, **args})
        assert outcome.result.reason_code == "invalid_arguments"
        assert outcome.pending is None
