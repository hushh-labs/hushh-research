"""Real-transaction tests for the One Live Voice tables (migrations 221-223).

Run with ONE_COMMAND_TEST_DATABASE_URL pointing to an isolated PostgreSQL
database (CI provides one). Each test gets its own schema; migrations are
applied twice to prove idempotency.
"""

from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text

from hushh_mcp.one_voice.conversations import ConversationNotOwned, ConversationStore
from hushh_mcp.one_voice.pending_actions import (
    PendingAction,
    PendingActionConflict,
    PendingActionStore,
)
from hushh_mcp.services.one_location_account_settings_service import (
    OneLocationAccountSettingsService,
)
from hushh_mcp.services.one_location_agent_service import OneLocationAgentError
from hushh_mcp.services.one_location_setup_service import OneLocationSetupService

MIGRATIONS = Path(__file__).resolve().parents[2] / "db" / "migrations"
CONV = "11111111-2222-4333-8444-555555555555"


@pytest.fixture
def db(monkeypatch):
    url = os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not url:
        pytest.skip("An isolated PostgreSQL database is required.")
    engine = create_engine(url)
    schema = f"one_voice_test_{uuid4().hex}"
    with engine.begin() as conn:
        conn.execute(text(f'CREATE SCHEMA "{schema}"'))
    scoped = create_engine(url, connect_args={"options": f"-csearch_path={schema},public"})

    class Database:
        engine = scoped

        def execute_raw(self, sql, params=None):
            with scoped.begin() as conn:
                result = conn.execute(text(sql), params or {})
                return SimpleNamespace(
                    data=[dict(row) for row in result.mappings()] if result.returns_rows else []
                )

    database = Database()
    database.execute_raw(
        "CREATE TABLE actor_profiles(user_id TEXT PRIMARY KEY); "
        "INSERT INTO actor_profiles VALUES('owner'),('other'),('recipient'); "
        "CREATE TABLE one_location_recipient_keys(user_id TEXT, key_id TEXT, created_at TIMESTAMPTZ DEFAULT now()); "
        "CREATE TABLE one_location_share_grants(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), owner_user_id TEXT, "
        "recipient_user_id TEXT, status TEXT NOT NULL DEFAULT 'active', metadata JSONB NOT NULL DEFAULT '{}'::jsonb, "
        "reason TEXT, revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()); "
        "CREATE TABLE one_location_public_invites(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), owner_user_id TEXT, "
        "status TEXT NOT NULL DEFAULT 'active', updated_at TIMESTAMPTZ DEFAULT now()); "
        "CREATE TABLE one_location_map_preferences(user_id TEXT PRIMARY KEY, presence_mode TEXT NOT NULL DEFAULT 'ghost', "
        "renderer_consent_version TEXT, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()); "
        "CREATE TABLE one_location_events(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), owner_user_id TEXT, actor_user_id TEXT, "
        "recipient_user_id TEXT, grant_id UUID, event_type TEXT, metadata JSONB, created_at TIMESTAMPTZ DEFAULT now())"
    )
    for name in (
        "221_one_location_account_settings.sql",
        "222_one_voice_runtime.sql",
        "223_one_location_setup_progress.sql",
        "221_one_location_account_settings.sql",
        "222_one_voice_runtime.sql",
        "223_one_location_setup_progress.sql",
    ):
        database.execute_raw((MIGRATIONS / name).read_text())
    monkeypatch.setattr(
        "hushh_mcp.services.one_location_account_settings_service.get_db", lambda: database
    )
    monkeypatch.setattr("hushh_mcp.services.one_location_setup_service.get_db", lambda: database)
    yield database
    scoped.dispose()
    with engine.begin() as conn:
        conn.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
    engine.dispose()


class _AgentDouble:
    """Only the transition the settings service binds into its transaction."""

    def __init__(self):
        self.notifications = []

    def _revoke_grant_transition(self, *, owner_user_id, grant_id):
        result = (
            self._key_writer_connection.execute(
                text(
                    "UPDATE one_location_share_grants SET status='revoked', revoked_at=now() "
                    "WHERE id = CAST(:g AS UUID) AND owner_user_id = :o AND status='active' RETURNING *"
                ),
                {"g": grant_id, "o": owner_user_id},
            )
            .mappings()
            .first()
        )
        if not result:
            return {"changed": False, "row": {}}
        return {
            "changed": True,
            "row": dict(result),
            "recipient_user_id": result["recipient_user_id"],
            "owner_label": "Owner",
            "recipient_label": "Recipient",
            "revoked_share_kind": (result["metadata"] or {}).get("share_kind") or "",
            "revoked_via_sms": (result["metadata"] or {}).get("share_kind") == "sos",
        }

    def _send_metadata_notification(self, **kwargs):
        self.notifications.append(kwargs)
        return True


# --- account settings --------------------------------------------------------


def test_sharing_off_revokes_active_grants_and_links_in_one_transaction(db):
    db.execute_raw(
        "INSERT INTO one_location_share_grants(owner_user_id, recipient_user_id, metadata) "
        "VALUES('owner','recipient','{\"share_kind\":\"share\"}'::jsonb), ('owner','other','{\"share_kind\":\"check_in\"}'::jsonb); "
        "INSERT INTO one_location_public_invites(owner_user_id) VALUES('owner'); "
        "INSERT INTO one_location_map_preferences(user_id, presence_mode) VALUES('owner','foreground_private')"
    )
    agent = _AgentDouble()
    service = OneLocationAccountSettingsService(agent)
    transition = service.set_sharing_state(user_id="owner", state="off")
    assert transition.settings.sharing_state == "off"
    assert len(transition.revoked_grant_ids) == 2
    assert len(transition.revoked_link_ids) == 1
    assert transition.notified_recipients == 2
    rows = db.execute_raw("SELECT status FROM one_location_share_grants").data
    assert {r["status"] for r in rows} == {"revoked"}
    assert (
        db.execute_raw("SELECT presence_mode FROM one_location_map_preferences").data[0][
            "presence_mode"
        ]
        == "ghost"
    )
    assert (
        db.execute_raw("SELECT status FROM one_location_public_invites").data[0]["status"]
        == "revoked"
    )


def test_sharing_off_refuses_while_sos_is_active_unless_included(db):
    db.execute_raw(
        "INSERT INTO one_location_share_grants(owner_user_id, recipient_user_id, metadata) "
        "VALUES('owner','recipient','{\"share_kind\":\"sos\"}'::jsonb)"
    )
    service = OneLocationAccountSettingsService(_AgentDouble())
    with pytest.raises(OneLocationAgentError) as excinfo:
        service.set_sharing_state(user_id="owner", state="off")
    assert excinfo.value.code == "LOCATION_SOS_ACTIVE"
    assert (
        db.execute_raw("SELECT status FROM one_location_share_grants").data[0]["status"] == "active"
    )
    transition = service.set_sharing_state(user_id="owner", state="off", include_sos=True)
    assert len(transition.revoked_grant_ids) == 1


def test_sharing_on_requires_consent_then_persists(db):
    service = OneLocationAccountSettingsService(_AgentDouble())
    with pytest.raises(OneLocationAgentError) as excinfo:
        service.set_sharing_state(user_id="owner", state="on")
    assert excinfo.value.code == "LOCATION_SHARING_CONSENT_REQUIRED"
    service.record_consent(user_id="owner", consent_version="location-sharing-v1")
    transition = service.set_sharing_state(user_id="owner", state="on")
    assert transition.settings.sharing_enabled is True
    assert service.get(user_id="owner").sharing_state == "on"
    assert service.get(user_id="other").sharing_state == "unset"


# --- pending actions ----------------------------------------------------------


async def test_pending_proposal_and_spoken_confirm_db_call_budget(db, monkeypatch):
    """Count real pending-store SQL trips so future policy changes expose their cost."""
    await ConversationStore(db=db).open(
        user_id="owner", conversation_id=CONV, model_id="m", model_location="l"
    )
    calls: list[str] = []
    execute_raw = db.execute_raw

    def recording_execute_raw(sql, params=None):
        if "one_voice_pending_actions" in sql:
            calls.append(sql)
        return execute_raw(sql, params)

    monkeypatch.setattr(db, "execute_raw", recording_execute_raw)
    store = PendingActionStore(db=db)
    assert await store.list_open(user_id="owner", conversation_id=CONV) == []
    # The second read is a concurrency re-check after the executor's awaited prepare.
    assert await store.list_open(user_id="owner", conversation_id=CONV) == []
    row, _ = await store.create(
        user_id="owner",
        conversation_id=CONV,
        tool_name="request_location",
        gateway_action_id="location.send_request",
        tier="voice",
        args={"person": {"user_id": "other"}},
        summary="ask",
    )
    assert len(calls) <= 13

    await store.mark_shown(user_id="owner", pending_action_id=row.id)
    calls.clear()
    assert await store.get(user_id="owner", pending_action_id=row.id) is not None
    await store.confirm(user_id="owner", pending_action_id=row.id, source="voice")
    await store.resolve(
        user_id="owner", pending_action_id=row.id, status="executed", result={"status": "ok"}
    )
    assert len(calls) <= 4


async def test_pending_actions_single_open_cas_and_receipt(db):
    conversations = ConversationStore(db=db)
    await conversations.open(
        user_id="owner", conversation_id=CONV, model_id="m", model_location="l"
    )
    store = PendingActionStore(db=db)
    first, receipt = await store.create(
        user_id="owner",
        conversation_id=CONV,
        tool_name="delete_circle",
        gateway_action_id="location.delete_circle",
        tier="tap",
        args={"circle": {"circle_id": "c" * 36}},
        summary="delete",
    )
    assert receipt and first.tier == "tap"
    # a second mutation cancels the first
    second, _ = await store.create(
        user_id="owner",
        conversation_id=CONV,
        tool_name="request_location",
        gateway_action_id="location.send_request",
        tier="voice",
        args={"person": {"user_id": "u"}},
        summary="ask",
    )
    assert (await store.get(user_id="owner", pending_action_id=first.id)).status == "cancelled"
    # voice confirm needs the card shown
    with pytest.raises(PendingActionConflict, match="card_not_shown"):
        await store.confirm(user_id="owner", pending_action_id=second.id, source="voice")
    await store.mark_shown(user_id="owner", pending_action_id=second.id)
    confirmed = await store.confirm(user_id="owner", pending_action_id=second.id, source="voice")
    assert confirmed.status == "confirmed"
    with pytest.raises(PendingActionConflict):
        await store.confirm(user_id="owner", pending_action_id=second.id, source="voice")
    resolved = await store.resolve(
        user_id="owner",
        pending_action_id=second.id,
        status="executed",
        result={"status": "pending"},
    )
    assert resolved and resolved.status == "executed"
    # another user cannot see it
    assert await store.get(user_id="other", pending_action_id=second.id) is None


async def test_tap_receipt_is_hashed_single_use_and_expiry_is_db_clock(db):
    conversations = ConversationStore(db=db)
    await conversations.open(
        user_id="owner", conversation_id=CONV, model_id="m", model_location="l"
    )
    store = PendingActionStore(db=db)
    row, receipt = await store.create(
        user_id="owner",
        conversation_id=CONV,
        tool_name="stop_share",
        gateway_action_id="location.stop_share",
        tier="tap",
        args={"grant_id": "g"},
        summary="stop",
        ttl_seconds=1,
    )
    stored = db.execute_raw("SELECT receipt_token_hash FROM one_voice_pending_actions").data[0][
        "receipt_token_hash"
    ]
    assert stored and stored != receipt
    with pytest.raises(PendingActionConflict, match="receipt_invalid"):
        wrong_receipt = "wrong"
        await store.confirm(
            user_id="owner", pending_action_id=row.id, source="tap", receipt_token=wrong_receipt
        )
    db.execute_raw("UPDATE one_voice_pending_actions SET expires_at = now() - interval '1 second'")
    with pytest.raises(PendingActionConflict, match="expired"):
        await store.confirm(
            user_id="owner", pending_action_id=row.id, source="tap", receipt_token=receipt
        )
    assert (await store.get(user_id="owner", pending_action_id=row.id)).status == "expired"


# --- mail-draft rows (send_mail, reply_mail) ----------------------------------

# The mail-draft family, pinned by name rather than read from MAIL_DRAFT_TOOLS:
# dropping a tool from that family must fail its cases here, not quietly shrink
# the matrix. Each entry is (args as the executor stores them, what remains once
# the row can no longer execute): the sealed dictation and a reply's sealed
# source reference leave; public args and the rest of the snapshot stay.
_MAIL_DRAFT_ROWS: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {
    "send_mail": (
        {
            "recipient": {"user_id": "recipient"},
            "_sealed_args": "v1:fixture-ciphertext",
            "_prepared": {"recipient_user_id": "recipient", "email_binding": "b" * 32},
        },
        {
            "recipient": {"user_id": "recipient"},
            "_prepared": {"recipient_user_id": "recipient", "email_binding": "b" * 32},
        },
    ),
    "reply_mail": (
        {
            "ordinal": 2,
            "_sealed_args": "v1:fixture-ciphertext",
            "_prepared": {"source_mail_ref": "rs1.fixture-source", "target_key": "k" * 32},
        },
        {"ordinal": 2, "_prepared": {"target_key": "k" * 32}},
    ),
}
_GATEWAYS = {
    "send_mail": "email.chat.turn",
    "reply_mail": "email.chat.turn",
    "create_circle": "location.create_circle",
    "delete_circle": "location.delete_circle",
}
_INTERIM_RECEIPT = {"status": "draft_open_requested", "needs": "client_step"}
_UNCONFIRMED = {"status": "draft_open_unconfirmed", "needs": None}


async def _voice_store(db) -> PendingActionStore:
    await ConversationStore(db=db).open(
        user_id="owner", conversation_id=CONV, model_id="m", model_location="l"
    )
    return PendingActionStore(db=db)


async def _proposed(store, tool_name: str, args: dict[str, Any]) -> PendingAction:
    row, _ = await store.create(
        user_id="owner",
        conversation_id=CONV,
        tool_name=tool_name,
        gateway_action_id=_GATEWAYS[tool_name],
        tier="voice",
        args=args,
        summary="prepare",
    )
    return row


async def _confirmed(store, tool_name: str, args: dict[str, Any]) -> PendingAction:
    row = await _proposed(store, tool_name, args)
    await store.mark_shown(user_id="owner", pending_action_id=row.id)
    return await store.confirm(user_id="owner", pending_action_id=row.id, source="voice")


async def _awaiting_mount(store, tool_name: str, args: dict[str, Any]) -> PendingAction:
    """Executed, holding the interim receipt only a review card's mount settles."""
    row = await _confirmed(store, tool_name, args)
    resolved = await store.resolve(
        user_id="owner", pending_action_id=row.id, status="executed", result=_INTERIM_RECEIPT
    )
    assert resolved is not None
    return resolved


@pytest.mark.parametrize("tool_name", tuple(_MAIL_DRAFT_ROWS))
async def test_mail_draft_interim_receipt_recovers_lazily_after_missing_client_report(
    db, tool_name
):
    stored, remaining = _MAIL_DRAFT_ROWS[tool_name]
    store = await _voice_store(db)
    row = await _awaiting_mount(store, tool_name, stored)
    assert row.status == "executed"
    assert row.result == _INTERIM_RECEIPT
    assert row.args == remaining

    # While the device can still report the mount, a recovery pass leaves it.
    assert await store.list_open(user_id="owner", conversation_id=CONV) == []
    assert (await store.get(user_id="owner", pending_action_id=row.id)).status == "executed"

    db.execute_raw(
        "UPDATE one_voice_pending_actions SET resolved_at = NOW() - interval '40 seconds' "
        "WHERE id = CAST(:id AS UUID)",
        {"id": row.id},
    )
    assert await store.list_open(user_id="owner", conversation_id=CONV) == []
    recovered = await store.get(user_id="owner", pending_action_id=row.id)
    assert recovered.status == "failed"
    assert recovered.result == _UNCONFIRMED


@pytest.mark.parametrize("tool_name", tuple(_MAIL_DRAFT_ROWS))
async def test_expired_confirmed_mail_draft_scrubs_sealed_args_after_crash(db, tool_name):
    stored, remaining = _MAIL_DRAFT_ROWS[tool_name]
    store = await _voice_store(db)
    # A confirmed non-mail action expired by the same clock. Crash recovery
    # writes a mail-draft outcome, which would be false for it.
    bystander = await _confirmed(store, "create_circle", {"name": "Family"})
    confirmed = await _confirmed(store, tool_name, stored)
    assert confirmed.status == "confirmed"
    assert "_sealed_args" in confirmed.args

    db.execute_raw("UPDATE one_voice_pending_actions SET expires_at = NOW() - interval '1 second'")
    # Recovery is owner-scoped; a different actor's activity cannot settle it.
    assert await store.list_open(user_id="other", conversation_id=CONV) == []
    assert (await store.get(user_id="owner", pending_action_id=confirmed.id)).status == "confirmed"

    assert await store.list_open(user_id="owner", conversation_id=CONV) == []
    recovered = await store.get(user_id="owner", pending_action_id=confirmed.id)
    assert recovered.status == "failed"
    assert recovered.result == _UNCONFIRMED
    assert recovered.resolved_at is not None
    assert recovered.args == remaining
    untouched = await store.get(user_id="owner", pending_action_id=bystander.id)
    assert untouched.status == "confirmed"
    assert untouched.result is None


@pytest.mark.parametrize("tool_name", tuple(_MAIL_DRAFT_ROWS))
async def test_mount_report_settles_a_mail_draft_once_and_only_for_its_owner(db, tool_name):
    stored, _remaining = _MAIL_DRAFT_ROWS[tool_name]
    store = await _voice_store(db)
    row = await _awaiting_mount(store, tool_name, stored)
    other = await store.settle_mail_draft_step(
        user_id="other", pending_action_id=row.id, opened=True
    )
    assert other is None

    settled = await store.settle_mail_draft_step(
        user_id="owner", pending_action_id=row.id, opened=True
    )
    assert settled is not None
    assert settled.status == "executed"
    assert settled.result == {"status": "draft_opened", "needs": None}
    # The first settlement stands: a late watchdog or socket-close settlement
    # cannot turn an opened card into an unconfirmed one.
    late = await store.settle_mail_draft_step(
        user_id="owner", pending_action_id=row.id, opened=False, uncertain=True
    )
    assert late is None
    current = await store.get(user_id="owner", pending_action_id=row.id)
    assert current.status == "executed"
    assert current.result == {"status": "draft_opened", "needs": None}


async def test_mount_report_cannot_settle_a_non_mail_row_holding_the_same_receipt(db):
    store = await _voice_store(db)
    row = await _awaiting_mount(store, "create_circle", {"name": "Family"})
    refused = await store.settle_mail_draft_step(
        user_id="owner", pending_action_id=row.id, opened=True
    )
    assert refused is None
    current = await store.get(user_id="owner", pending_action_id=row.id)
    assert current.status == "executed"
    assert current.result == _INTERIM_RECEIPT


# --- terminal scrub -----------------------------------------------------------

# A reply row's private values beside what a terminal row keeps. The same args
# ride on a non-mail tool: the scrub must not depend on the tool name (it was
# once ``CASE WHEN tool_name = 'send_mail'``), and the ``#-`` path must remove
# the source reference alone, not the snapshot that holds it.
_SEALED_ROW_ARGS = {
    "_sealed_args": "v1:x",
    "_prepared": {"source_mail_ref": "rs1.abc", "target_key": "k"},
    "ordinal": 2,
}
_TERMINAL_ROW_ARGS = {"_prepared": {"target_key": "k"}, "ordinal": 2}


async def _cancel(db, store, row_id: str) -> None:
    await store.cancel(user_id="owner", pending_action_id=row_id)


async def _supersede(db, store, row_id: str) -> None:
    # A newer proposal in the same conversation cancels the open one.
    await _proposed(store, "delete_circle", {"circle": {"circle_id": "c" * 36}})


async def _expire(db, store, row_id: str) -> None:
    db.execute_raw(
        "UPDATE one_voice_pending_actions SET expires_at = NOW() - interval '1 second' "
        "WHERE id = CAST(:id AS UUID)",
        {"id": row_id},
    )
    await store.expire_stale(user_id="owner")


async def _resolve(db, store, row_id: str) -> None:
    await store.mark_shown(user_id="owner", pending_action_id=row_id)
    await store.confirm(user_id="owner", pending_action_id=row_id, source="voice")
    await store.resolve(
        user_id="owner", pending_action_id=row_id, status="executed", result={"status": "done"}
    )


# store transition -> (how the row gets there, the status it lands in)
_TERMINAL_TRANSITIONS = {
    "cancel": (_cancel, "cancelled"),
    "cancel_open": (_supersede, "cancelled"),
    "expire_stale": (_expire, "expired"),
    "resolve": (_resolve, "executed"),
}


@pytest.mark.parametrize("transition", tuple(_TERMINAL_TRANSITIONS))
@pytest.mark.parametrize("tool_name", ("reply_mail", "create_circle"))
async def test_every_terminal_transition_scrubs_exactly_the_sealed_values(
    db, tool_name, transition
):
    store = await _voice_store(db)
    row = await _proposed(store, tool_name, _SEALED_ROW_ARGS)
    move, status = _TERMINAL_TRANSITIONS[transition]
    await move(db, store, row.id)
    terminal = await store.get(user_id="owner", pending_action_id=row.id)
    assert terminal.status == status
    assert terminal.args == _TERMINAL_ROW_ARGS


async def test_conversation_ownership_and_counters(db):
    store = ConversationStore(db=db)
    first = await store.open(
        user_id="owner", conversation_id=CONV, model_id="m", model_location="us-central1"
    )
    assert first.session_count == 1
    again = await store.open(
        user_id="owner", conversation_id=CONV, model_id="m", model_location="us-central1"
    )
    assert again.session_count == 2
    with pytest.raises(ConversationNotOwned):
        await store.open(
            user_id="other", conversation_id=CONV, model_id="m", model_location="us-central1"
        )
    await store.bump(
        user_id="owner", conversation_id=CONV, tool_calls=3, narration_without_receipt=1, bogus=9
    )
    await store.save_entity_context(user_id="owner", conversation_id=CONV, context={"people": {}})
    await store.close(
        user_id="owner", conversation_id=CONV, close_code=1000, reason_class="ended", ended=True
    )
    row = await store.get(user_id="owner", conversation_id=CONV)
    assert row.counters["tool_calls"] == 3 and row.counters["narration_without_receipt"] == 1
    assert row.status == "ended" and row.last_close_code == 1000


# --- setup progress -----------------------------------------------------------


def test_setup_consent_strictly_precedes_os_permission_and_done_turns_sharing_on(db):
    settings = OneLocationAccountSettingsService(_AgentDouble())
    service = OneLocationSetupService(settings)
    progress = service.start(user_id="owner")
    assert progress.step == "intro" and progress.started
    with pytest.raises(OneLocationAgentError) as excinfo:
        service.record_os_permission(user_id="owner", state="granted")
    assert excinfo.value.code == "LOCATION_SETUP_CONSENT_REQUIRED"
    # the table constraint agrees with the service rule
    from sqlalchemy.exc import IntegrityError

    with pytest.raises(IntegrityError):
        db.execute_raw(
            "UPDATE one_location_setup_progress SET step='os_permission' WHERE user_id='owner'"
        )
    progress = service.accept_consent(user_id="owner", consent_version="location-sharing-v1")
    assert progress.step == "consent" and progress.consent_accepted_at
    progress = service.record_os_permission(user_id="owner", state="granted")
    assert progress.step == "os_permission"
    progress = service.set_precision(user_id="owner", precision="approximate")
    assert progress.step == "precision" and settings.get(user_id="owner").precision == "approximate"
    with pytest.raises(OneLocationAgentError) as excinfo:
        service.confirm_recipient_key(user_id="owner")
    assert excinfo.value.code == "LOCATION_RECIPIENT_KEY_MISSING"
    db.execute_raw(
        "INSERT INTO one_location_recipient_keys(user_id, key_id) VALUES('owner','key-1')"
    )
    progress = service.confirm_recipient_key(user_id="owner")
    assert progress.step == "recipient_key"
    progress = service.complete(user_id="owner")
    assert progress.completed and settings.get(user_id="owner").sharing_state == "on"
    # refresh-safe: a fresh read returns the same step
    assert service.get(user_id="owner").step == "done"
