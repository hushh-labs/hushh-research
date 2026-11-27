"""Actual OAuth/grant, encrypted ADK recovery and proposal SQL; synthetic Google only."""
# ruff: noqa: S106 -- provider credentials are synthetic fixtures

from __future__ import annotations

import asyncio
import base64
import copy
import secrets
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import create_engine, text

from db.db_client import DatabaseClient
from hushh_mcp.agents.calendar import opening_tools, tools
from hushh_mcp.agents.calendar.read_offer import STATE_OPENING_OFFER
from hushh_mcp.one_adk.adk_session_repository import PostgresAdkSessionRepository
from hushh_mcp.one_adk.encrypted_session_service import EncryptedAdkSessionService
from hushh_mcp.services.google_calendar_service import GoogleCalendarService
from hushh_mcp.services.google_connection_service import (
    GoogleConnectionError,
    GoogleConnectionService,
)
from tests.google_oauth_postgres_support import OWNER, install_calendar_schema
from tests.helpers.chat_keys import static_chat_cipher
from tests.services import test_external_connector_lifecycle_postgres as postgres_support

connector_postgres_url = postgres_support.connector_postgres_url


@pytest.mark.asyncio
async def test_guest_question_restores_privately_before_complete_review(calendar_pg, monkeypatch):
    from hushh_mcp.agents.calendar.guest_clarification import STATE_GUEST_CLARIFICATION
    from tests.agents.test_calendar_guest_clarification import REQUEST, reply, setup_question

    _google, db, engine = calendar_pg

    def service():
        async def execute(sql, params):
            return await asyncio.to_thread(db.execute_raw, sql, params)

        return EncryptedAdkSessionService(
            static_chat_cipher(), repository=PostgresAdkSessionRepository(execute)
        )

    _store, port, session, _ = await setup_question(monkeypatch, owner=OWNER, store=service())
    original = copy.deepcopy(session.state[STATE_GUEST_CLARIFICATION])
    restored_store = service()
    restored = await restored_store.get_session(app_name="one", user_id=OWNER, session_id="guests")
    assert restored is not None and restored.state[STATE_GUEST_CLARIFICATION] == original
    assert (
        await restored_store.get_session(
            app_name="one", user_id="another-owner", session_id="guests"
        )
        is None
    )
    with engine.connect() as connection:
        ciphertext = connection.execute(
            text("SELECT payload_ciphertext FROM one_adk_sessions WHERE session_id='guests'")
        ).scalar_one()
        assert REQUEST not in ciphertext and STATE_GUEST_CLARIFICATION not in ciphertext
    result, model = await reply(monkeypatch, restored_store, port, owner=OWNER)
    assert result["status"] == "confirmation_required", result
    assert result["directive"]["payload"]["attendees"] == ["guest@example.test"]
    assert model._inputs[0]["pending_clarification"]["original_user_messages"] == [REQUEST]
    assert model._planning[0]["original_user_messages"] == [REQUEST]
    assert model._planning[0]["original_turn_at"] == original["original_turn_at"]
    assert model._planning[0]["requested_time_zone"] == "Asia/Kolkata"
    assert model._planning[0]["original_request_clock"]["tomorrow"] == "2030-11-06"
    assert "grant_binding" not in str(model._planning)
    assert not (
        await service().get_session(app_name="one", user_id=OWNER, session_id="guests")
    ).state.get(STATE_GUEST_CLARIFICATION)
    port.propose.assert_awaited_once()
    port.execute.assert_not_awaited()


@pytest.fixture
def calendar_pg(connector_postgres_url, monkeypatch, shared_hub_owner):
    schema = "calendar_chat_" + uuid4().hex
    admin = create_engine(connector_postgres_url)
    engine = None
    try:
        with admin.begin() as connection:
            connection.exec_driver_sql(f'CREATE SCHEMA "{schema}"')
        engine = create_engine(
            connector_postgres_url, connect_args={"options": f"-csearch_path={schema}"}
        )
        with engine.begin() as connection:
            install_calendar_schema(connection, OWNER)
            migrations = Path(__file__).resolve().parents[2] / "db/migrations"
            for name in ("184_encrypted_one_adk_sessions.sql", "442_calendar_mail_read_grant.sql"):
                sql = (migrations / name).read_text().replace("BEGIN;", "").replace("COMMIT;", "")
                connection.exec_driver_sql(
                    sql.replace("SELECT install_account_deletion_write_guards();", "")
                )
        monkeypatch.setenv(
            "GOOGLE_OAUTH_TOKEN_KEY", base64.urlsafe_b64encode(secrets.token_bytes(32)).decode()
        )
        db = DatabaseClient(engine=engine)
        google = GoogleConnectionService(db=db)
        signing_key = secrets.token_bytes(32)
        monkeypatch.setattr(google, "_signing_key", lambda: signing_key)
        monkeypatch.setattr(google, "is_configured", lambda: True)
        monkeypatch.setattr(google, "_client_id", lambda: "synthetic-client")
        monkeypatch.setattr(google, "_client_secret", lambda: "synthetic-secret")
        monkeypatch.setattr(google, "_userinfo", AsyncMock())
        monkeypatch.setattr(google, "_post_form", AsyncMock())
        yield google, db, engine
    finally:
        if engine is not None:
            engine.dispose()
        with admin.begin() as connection:
            connection.exec_driver_sql(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')
        admin.dispose()


async def _connect(google, label, additional):
    scopes = set(google.scopes("calendar", "manage")) | {
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    }
    google._userinfo.return_value = {
        "sub": f"synthetic-subject-{label}",
        "email": f"{label.lower()}@example.test",
    }
    google._post_form.return_value = {
        "access_token": f"synthetic-access-{label}",
        "refresh_token": f"synthetic-refresh-{label}",
        "scope": " ".join(sorted(scopes)),
        "expires_in": 3600,
    }
    attempt = await google.start_native(
        user_id=OWNER,
        service="calendar",
        access_level="manage",
        include_calendar_list=True,
        calendar_additional=additional,
    )
    result = await google.complete_native(
        user_id=OWNER,
        service="calendar",
        access_level="manage",
        server_auth_code=f"synthetic-code-{label}",
        state=attempt["state"],
    )
    return result["completed_account_id"]


async def _journey(calendar_pg, monkeypatch):
    # This database recovery/executor fixture starts after request assessment.
    # Real SDK action-scope enforcement is covered by the Calendar contract matrix.
    monkeypatch.setattr(
        "hushh_mcp.agents.calendar.request_scope.scope_receipt",
        lambda _: {"actions": ["create", "reschedule", "cancel", "respond"], "continuation": False},
    )
    monkeypatch.setattr(
        "hushh_mcp.agents.calendar.request_scope.request_scope", AsyncMock(return_value=("create",))
    )
    google, db, engine = calendar_pg
    ids = {label: await _connect(google, label, label != "A") for label in ("A", "B", "C")}
    assert ids["A"] == "default" and len(set(ids.values())) == 3
    calls = []
    unavailable = set()

    async def transport(calendar, _client, *, method, path, access, payload=None, **_):
        account_id = calendar.connections.account_id
        calls.append((account_id, method, path, access))
        label = next(label for label, value in ids.items() if value == account_id)
        if path == "/users/me/calendarList":
            body = {
                "items": [
                    {"id": f"{label.lower()}@example.test", "primary": True, "accessRole": "owner"},
                    {"id": f"unknown-{label}", "accessRole": "reader"},
                    {"id": "en.usa#holiday@group.v.calendar.google.com", "accessRole": "reader"},
                ]
            }
        elif path == "/freeBusy":
            assert all("#holiday" not in item["id"] for item in payload["items"])
            start = {"A": "12", "B": "15", "C": "18"}[label]
            end = str(int(start) + 1)
            body = {
                "calendars": {
                    item["id"]: {"errors": [{"reason": "forbidden"}]}
                    if account_id in unavailable
                    else {
                        "busy": [
                            {
                                "start": f"2030-10-21T{start}:00:00Z",
                                "end": f"2030-10-21T{end}:00:00Z",
                            }
                        ]
                    }
                    for item in payload["items"]
                }
            }
        elif path == "/calendars/primary/events" and access == "manage":
            body = {"id": "synthetic-created-event", "summary": "Planning", "status": "confirmed"}
        else:
            pytest.fail("Unexpected provider request in shared availability journey")
        return httpx.Response(
            200, json=body, request=httpx.Request(method, "https://synthetic.invalid")
        )

    monkeypatch.setattr(GoogleCalendarService, "_provider_request", transport)
    monkeypatch.setattr(
        "hushh_mcp.services.calendar_account_board_service.get_google_connection_service",
        lambda: google,
    )
    monkeypatch.setattr(
        "hushh_mcp.services.google_connection_service.get_google_connection_service", lambda: google
    )
    monkeypatch.setattr(
        tools,
        "_calendar_service",
        lambda account_id: GoogleCalendarService(
            db=db, connections=google.for_calendar_account(account_id)
        ),
    )
    monkeypatch.setattr(
        "hushh_mcp.services.google_calendar_service.capture_value_epoch", AsyncMock(return_value=1)
    )
    monkeypatch.setattr(
        "hushh_mcp.services.google_calendar_service.record_calendar_effect", AsyncMock()
    )
    context = SimpleNamespace(
        state={
            "hussh:user_id": OWNER,
            "hussh:conversation_id": "synthetic-chat",
            "hussh:timezone": "America/New_York",
        }
    )
    result = await opening_tools.calendar_shared_free_slots(
        context, date="2030-10-21", duration_minutes=30
    )
    assert result["status"] == "ok", result
    assert result["openings"][1]["start_at"] == "2030-10-21T04:30:00Z"
    assert len(calls) == 6 and {item[3] for item in calls} == {"read"}
    assert "binding" not in str(result)
    original = copy.deepcopy(context.state[STATE_OPENING_OFFER])

    def session_service():
        async def execute(sql, params):
            return await asyncio.to_thread(db.execute_raw, sql, params)

        return EncryptedAdkSessionService(
            static_chat_cipher(), repository=PostgresAdkSessionRepository(execute)
        )

    await session_service().create_session(
        app_name="hussh_one", user_id=OWNER, session_id="synthetic-chat", state=context.state
    )
    restored = await session_service().get_session(
        app_name="hussh_one", user_id=OWNER, session_id="synthetic-chat"
    )
    assert restored is not None and restored.state[STATE_OPENING_OFFER] == original
    assert (
        await session_service().get_session(
            app_name="hussh_one", user_id="synthetic-other", session_id="synthetic-chat"
        )
        is None
    )
    with engine.connect() as connection:
        ciphertext = connection.execute(
            text("SELECT payload_ciphertext FROM one_adk_sessions")
        ).scalar_one()
        assert not any(
            value in ciphertext
            for value in ("a@example.test", "2030-10-21", "calendar_opening_read_offer")
        )
    restored.state["hussh:timezone"] = "Pacific/Auckland"
    detail = await opening_tools.calendar_opening_detail(restored, ordinal=2)
    assert detail["start_at"] == "2030-10-21T04:30:00Z"
    assert detail["time_zone"] == "America/New_York"
    assert restored.state[STATE_OPENING_OFFER] == original
    return google, db, engine, ids, calls, unavailable, restored


@pytest.mark.asyncio
async def test_postgres_shared_offer_recovers_and_confirms_one_exact_account(
    calendar_pg, monkeypatch
):
    _google, db, engine, ids, calls, _unavailable, restored = await _journey(
        calendar_pg, monkeypatch
    )
    # A nearly expired lookup becomes a normal ten-minute confirmed proposal.
    restored.state[STATE_OPENING_OFFER]["created_at_ms"] -= 299_000
    review = await tools.propose_calendar_event(
        restored, title="Planning", slot_ordinal=2, account_id=ids["B"]
    )
    assert review["status"] == "confirmation_required", review
    assert not any(item[3] == "manage" for item in calls)
    with engine.connect() as connection:
        assert (
            connection.execute(
                text(
                    "SELECT count(*) FROM google_calendar_action_proposals WHERE user_id=:owner AND status='pending'"
                ),
                {"owner": OWNER},
            ).scalar_one()
            == 1
        )
    service = tools._calendar_service(ids["B"])
    later = time.time() + 2
    monkeypatch.setattr(time, "time", lambda: later)
    await service.execute(user_id=OWNER, proposal_id=review["proposal_id"], account_id=ids["B"])
    assert [item for item in calls if item[3] == "manage"] == [
        (ids["B"], "POST", "/calendars/primary/events", "manage")
    ]
    with pytest.raises(GoogleConnectionError, match="already used"):
        await service.execute(user_id=OWNER, proposal_id=review["proposal_id"], account_id=ids["B"])
    assert len([item for item in calls if item[3] == "manage"]) == 1


@pytest.mark.parametrize("change", ["revoked", "scope", "partial", "expired"])
@pytest.mark.asyncio
async def test_postgres_restored_shared_source_cannot_cross_changed_authority(
    calendar_pg, monkeypatch, change
):
    google, _db, engine, ids, calls, unavailable, restored = await _journey(
        calendar_pg, monkeypatch
    )
    if change == "revoked":
        with engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE google_calendar_additional_accounts SET status='disconnected', revoked_at=NOW() WHERE user_id=:owner AND account_id=:account"
                ),
                {"owner": OWNER, "account": ids["C"]},
            )
        assert (
            await google.read_grant_binding(user_id=OWNER, service="calendar", account_id=ids["C"])
            is None
        )
    elif change == "scope":
        with engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE google_calendar_additional_accounts SET scope_csv='openid email' WHERE user_id=:owner AND account_id=:account"
                ),
                {"owner": OWNER, "account": ids["C"]},
            )
    elif change == "partial":
        unavailable.add(ids["C"])
        result = await opening_tools.calendar_shared_free_slots(
            restored, date="2030-10-21", duration_minutes=30
        )
        assert result["status"] == "incomplete" and result["openings"] == []
        assert restored.state[STATE_OPENING_OFFER] is None
    else:
        restored.state[STATE_OPENING_OFFER]["created_at_ms"] -= 300_001
    review = await tools.propose_calendar_event(
        restored, title="Planning", slot_ordinal=2, account_id=ids["B"]
    )
    assert review["status"] != "confirmation_required"
    assert not any(item[3] == "manage" for item in calls)
    with engine.connect() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM google_calendar_action_proposals")
            ).scalar_one()
            == 0
        )
