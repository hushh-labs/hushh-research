"""Real-transaction tests for the One Live Voice tables (migrations 221-223).

Run with ONE_COMMAND_TEST_DATABASE_URL pointing to an isolated PostgreSQL
database (CI provides one). Each test gets its own schema; migrations are
applied twice to prove idempotency.
"""

from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text

from hushh_mcp.one_voice.conversations import ConversationNotOwned, ConversationStore
from hushh_mcp.one_voice.pending_actions import PendingActionConflict, PendingActionStore
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
