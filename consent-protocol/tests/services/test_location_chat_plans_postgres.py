"""Canonical Location transactions used by ONE main chat reviews."""

import asyncio
import hashlib
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError, ProgrammingError

from hushh_mcp.services import one_location_agent_service as location
from hushh_mcp.services.account_service import AccountService
from hushh_mcp.services.location_chat_plans import LocationChatPlanService
from tests.helpers.location_command_postgres import (
    active_location_provider_accounts as active_location_provider_accounts,
)
from tests.helpers.location_command_postgres import audience_writer_schema
from tests.helpers.location_command_postgres import db as db


@pytest.fixture
def location_plans(db, monkeypatch):
    monkeypatch.setenv("ONE_MAIN_CHAT_LOCATION_ENABLED", "true")
    service = audience_writer_schema(db, monkeypatch)
    migrations = Path(__file__).resolve().parents[2] / "db/migrations"
    for prefix in (153, 155, 156, 221, 464):
        with db.engine.begin() as connection:
            connection.exec_driver_sql(
                next(migrations.glob(f"{prefix:03d}_*.sql")).read_text(),
                execution_options={"no_parameters": True},
            )
    monkeypatch.setattr(service, "_assert_grant_capability_token", lambda *_: None)
    return service, db


def test_automatic_share_cannot_outlive_owners_rule(location_plans, monkeypatch):
    service_type, db = location_plans
    service = service_type()
    migrations = Path(__file__).resolve().parents[2] / "db/migrations"
    for prefix in (169, 199, 466):
        with db.engine.begin() as conn:
            conn.exec_driver_sql(
                next(migrations.glob(f"{prefix}_*.sql")).read_text(),
                execution_options={"no_parameters": True},
            )
    rule = service.update_auto_approve_preference(
        user_id="owner",
        enabled=True,
        scope_kind="all_contacts",
        circle_id=None,
        duration_hours=3,
    )
    start = datetime.fromisoformat(rule["enabledAt"])
    assert datetime.fromisoformat(rule["expiresAt"]) == start + timedelta(hours=3)
    # Advance the stored window to 2h55 after activation without sleeping.
    cutoff = db.execute_raw(
        """UPDATE one_location_auto_approve_preferences
           SET enabled_at = statement_timestamp() - INTERVAL '2 hours 55 minutes',
               expires_at = statement_timestamp() + INTERVAL '5 minutes'
           WHERE user_id = 'owner' RETURNING expires_at"""
    ).data[0]["expires_at"]
    minted = []

    def mint(self, **fields):
        minted.append(fields)
        return {"token": "fixture-capability"}

    monkeypatch.setattr(service_type, "_mint_grant_capability_token", mint)

    def ask(requester):
        return service.request_access(
            requester_user_id=requester, owner_user_id="owner", requested_duration_hours=1
        )["id"]

    def approve(request_id):
        return service.approve_request(
            owner_user_id="owner",
            request_id=request_id,
            approval_mode="automatic",
            duration_hours=None,
            expected_request_revision=1,
            auto_approve_rule_version=rule["ruleVersion"],
        )

    grant = approve(ask("other"))["grant"]
    assert datetime.fromisoformat(grant["expiresAt"]) == cutoff
    assert minted[-1]["expires_at"] == cutoff
    other = ask("third")
    db.execute_raw(
        "UPDATE one_location_auto_approve_preferences SET expires_at = clock_timestamp() WHERE user_id='owner'"
    )
    assert service.get_auto_approve_preference(user_id="owner")["enabled"] is False
    with pytest.raises(location.OneLocationAgentError) as denied:
        approve(other)
    assert denied.value.code == "LOCATION_AUTO_APPROVE_RULE_STALE"
    assert (
        db.execute_raw(
            "SELECT status FROM one_location_access_requests WHERE id=:id", {"id": other}
        ).data[0]["status"]
        == "pending"
    )
    assert len(minted) == 1
    with db.engine.begin() as conn:
        conn.exec_driver_sql(
            next((migrations / "rollback").glob("466_*.sql")).read_text(),
            execution_options={"no_parameters": True},
        )
    restored = db.execute_raw(
        "SELECT enabled, scope_kind, rule_version FROM one_location_auto_approve_preferences WHERE user_id='owner'"
    ).data[0]
    assert restored == {
        "enabled": False,
        "scope_kind": None,
        "rule_version": rule["ruleVersion"] + 1,
    }


def envelope(key="key"):
    return {
        "algorithm": "ECDH-P256-AES256-GCM",
        "recipientKeyId": key,
        "ciphertext": "fixture-ciphertext",
        "iv": "fixture-iv",
        "senderEphemeralPublicKeyJwk": {"kty": "EC"},
        "capturedAt": datetime.now(UTC).isoformat(),
        "sourcePlatform": "web",
        "publicationContext": "foreground_map_visible",
    }


def offer(service, *, origin_id=None):
    plan = LocationChatPlanService(service()).prepare(
        user_id="owner",
        action="share_live",
        person_user_id="other",
        duration_hours=2,
        origin_id=origin_id,
    )
    result = LocationChatPlanService(service()).execute(
        user_id="owner", plan_id=plan["planId"], envelope=envelope()
    )
    assert result["status"] == "executed"
    assert "recipientKey" not in result
    return result


def test_chat_refuses_new_and_pending_pins_and_preserves_historical_receipts(location_plans):
    service, db = location_plans
    origin_id = str(uuid4())
    live = offer(service, origin_id=origin_id)
    plans = LocationChatPlanService(service())
    with pytest.raises(location.OneLocationAgentError, match="one-time pin cannot be sent"):
        plans.prepare(user_id="owner", action="share_pin", person_user_id="other")
    # Seed a genuine historical grant and the receipt saved by the previous
    # Chat plan format. The general Location API remains compatible.
    historic = service().create_grant_with_initial_envelope(
        owner_user_id="owner",
        recipient_user_id="other",
        recipient_key_id="key",
        duration_hours=1,
        client_operation_id=str(uuid4()),
        confirmed_at=datetime.now(UTC),
        envelope=envelope(),
        share_kind="pin",
        enforce_connection=True,
    )
    historic_receipt = {
        "grantId": historic["grant"]["id"],
        "envelopeId": historic["envelope"]["id"],
        "expiresAt": historic["grant"]["expiresAt"],
    }
    legacy_hash = hashlib.sha256(b'["share_pin","other",null,null,null,null,null]').hexdigest()
    historical_plan_id = str(uuid4())
    pending_id = str(uuid4())
    db.execute_raw(
        """INSERT INTO one_location_chat_plans (
            id, user_id, person_user_id, origin_id, intent_hash, action, terms,
            expires_at, executed_at, receipt
        ) SELECT CAST(:plan_id AS UUID), user_id, person_user_id, origin_id, :hash, 'share_pin',
            terms || jsonb_build_object('durationHours', 1), expires_at, executed_at, CAST(:receipt AS JSONB)
          FROM one_location_chat_plans WHERE id=CAST(:live AS UUID)""",
        {
            "plan_id": historical_plan_id,
            "hash": legacy_hash,
            "live": live["planId"],
            "receipt": json.dumps(historic_receipt),
        },
    )
    db.execute_raw(
        """INSERT INTO one_location_chat_plans (
            id, user_id, person_user_id, origin_id, intent_hash, action, terms, expires_at
        ) SELECT CAST(:pending AS UUID), user_id, person_user_id, origin_id, repeat('a',64),
            action, terms, expires_at FROM one_location_chat_plans WHERE id=CAST(:pin AS UUID)""",
        {"pending": pending_id, "pin": historical_plan_id},
    )
    pin = plans.inspect(user_id="owner", plan_id=historical_plan_id)
    assert plans.execute(user_id="owner", plan_id=historical_plan_id) == pin
    assert (
        plans.prepare(
            user_id="owner", action="share_pin", person_user_id="other", origin_id=origin_id
        )
        == pin
    )
    with pytest.raises(location.OneLocationAgentError, match="one-time pin cannot be sent"):
        plans.execute(user_id="owner", plan_id=pending_id, envelope=envelope())
    with pytest.raises(location.OneLocationAgentError, match="one-time pin cannot be sent"):
        plans.inspect(user_id="owner", plan_id=pending_id)
    assert pin["durationHours"] == 1
    live_id, pin_id = live["receipt"]["grantId"], pin["receipt"]["grantId"]
    assert live_id != pin_id
    rows = db.execute_raw(
        "SELECT id,status,metadata->>'share_kind' AS kind FROM one_location_share_grants"
    ).data
    assert {(str(row["id"]), row["status"], row["kind"]) for row in rows} == {
        (live_id, "active", "share"),
        (pin_id, "active", "pin"),
    }

    with pytest.raises(location.OneLocationAgentError, match="cannot be updated"):
        service().store_encrypted_envelope(
            owner_user_id="owner", grant_id=pin_id, envelope=envelope()
        )
    assert len(db.execute_raw("SELECT id FROM one_location_envelopes").data) == 2

    view = LocationChatPlanService(service()).prepare(
        user_id="other", action="view", grant_id=pin_id
    )
    with pytest.raises(location.OneLocationAgentError, match="was not found"):
        LocationChatPlanService(service()).execute(user_id="third", plan_id=view["planId"])
    outcome = LocationChatPlanService(service()).execute(user_id="other", plan_id=view["planId"])
    assert outcome["receipt"]["grantId"] == pin_id
    assert (
        service().view_latest_envelope(recipient_user_id="other", grant_id=pin_id)["envelope"]["id"]
        == pin["receipt"]["envelopeId"]
    )

    # The retired pending review and rotated key cannot hide actual receipts.
    db.execute_raw("UPDATE one_location_recipient_keys SET status='rotated' WHERE user_id='other'")
    restored = LocationChatPlanService(service()).for_origin(user_id="owner", origin_id=origin_id)
    assert {row["planId"] for row in restored} == {live["planId"], pin["planId"]}
    assert LocationChatPlanService(service()).for_origin(user_id="third", origin_id=origin_id) == []
    with db.engine.begin() as connection:
        connection.execute(text("CREATE ROLE one_chat_plan_unprivileged NOLOGIN"))
        connection.execute(text("SET LOCAL ROLE one_chat_plan_unprivileged"))
        with pytest.raises(ProgrammingError, match="permission denied"):
            connection.execute(text("SELECT * FROM public.one_location_chat_plans"))


def test_origin_pagination_restores_large_audiences_without_cross_owner_cursors(location_plans):
    service, db = location_plans
    origin_id = str(uuid4())
    first = offer(service, origin_id=origin_id)
    db.execute_raw(
        """INSERT INTO one_location_chat_plans
          (user_id, person_user_id, origin_id, intent_hash, action, terms,
           created_at, expires_at, executed_at, receipt)
        SELECT user_id, person_user_id, origin_id, repeat(md5(n::text), 2), action, terms,
               created_at, expires_at, executed_at, receipt
        FROM one_location_chat_plans CROSS JOIN generate_series(1, 204) n
        WHERE id = CAST(:id AS UUID)""",
        {"id": first["planId"]},
    )
    plans = LocationChatPlanService(service())
    page = plans.for_origin_page(user_id="owner", origin_id=origin_id)
    assert len(page["plans"]) == 100
    assert page["nextCursor"]
    cursor = page["nextCursor"]
    restored = list(page["plans"])
    while page["nextCursor"]:
        page = plans.for_origin_page(
            user_id="owner", origin_id=origin_id, cursor=page["nextCursor"]
        )
        restored.extend(page["plans"])
    assert len(restored) == len({row["planId"] for row in restored}) == 205
    assert plans.for_origin_page(user_id="other", origin_id=origin_id, cursor=cursor) == {
        "plans": [],
        "nextCursor": None,
    }
    foreign = offer(service, origin_id=str(uuid4()))
    assert plans.for_origin_page(
        user_id="owner", origin_id=origin_id, cursor=foreign["planId"]
    ) == {"plans": [], "nextCursor": None}
    db.execute_raw(
        "UPDATE one_location_chat_plans SET receipt=NULL, executed_at=NULL "
        "WHERE origin_id=CAST(:origin AS UUID)",
        {"origin": origin_id},
    )
    db.execute_raw("UPDATE one_location_recipient_keys SET status='rotated' WHERE user_id='other'")
    rotated = plans.for_origin_page(user_id="owner", origin_id=origin_id)
    assert rotated["plans"] == []
    assert rotated["nextCursor"]


def test_erasure_removes_reviews_for_either_party(location_plans):
    _, db = location_plans
    db.execute_raw("""
        INSERT INTO one_location_chat_plans (
            user_id, person_user_id, intent_hash, action, terms, expires_at
        )
        VALUES
            ('owner', 'other', repeat('a', 64), 'view', '{}', now() + INTERVAL '1 hour'),
            ('other', 'owner', repeat('b', 64), 'view', '{}', now() + INTERVAL '1 hour'),
            ('other', 'third', repeat('c', 64), 'view', '{}', now() + INTERVAL '1 hour')
    """)
    with db.engine.begin() as connection:
        connection.execute(
            text(
                """INSERT INTO public.account_deletion_tombstones (user_id_hash)
                VALUES ('sha256:' || encode(digest('owner', 'sha256'), 'hex'))"""
            )
        )
        AccountService()._delete_user_rows_if_table_exists(
            connection,
            table_name="one_location_chat_plans",
            params={"user_id": "owner"},
        )

    assert db.execute_raw("SELECT user_id, person_user_id FROM one_location_chat_plans").data == [
        {"user_id": "other", "person_user_id": "third"}
    ]
    for owner, peer in (("owner", "other"), ("other", "owner")):
        with pytest.raises(IntegrityError, match="account identity is deleted"):
            db.execute_raw(
                """INSERT INTO one_location_chat_plans (
                    user_id, person_user_id, intent_hash, action, terms, expires_at
                )
                VALUES (:owner, :peer, repeat('d', 64), 'view', '{}', now() + INTERVAL '1 hour')""",
                {"owner": owner, "peer": peer},
            )


@pytest.mark.asyncio
async def test_concurrent_replays_and_workspace_duration_changes_use_same_grant(location_plans):
    service, db = location_plans
    original = offer(service)
    grant_id = original["receipt"]["grantId"]
    origin_id, attempt_id = str(uuid4()), str(uuid4())
    first = LocationChatPlanService(service()).prepare(
        user_id="owner",
        action="extend",
        grant_id=grant_id,
        duration_hours=0.5,
        origin_id=origin_id,
        attempt_id=attempt_id,
    )
    sibling = LocationChatPlanService(service()).prepare(
        user_id="owner", action="extend", grant_id=grant_id, duration_hours=1
    )

    def run():
        return LocationChatPlanService(service()).execute(user_id="owner", plan_id=first["planId"])

    outcomes = await asyncio.gather(*[asyncio.to_thread(run) for _ in range(3)])
    assert all(outcome == outcomes[0] for outcome in outcomes)
    canonical = db.execute_raw(
        "SELECT expires_at,latest_envelope_id FROM one_location_share_grants"
    ).data[0]
    assert canonical["expires_at"] == datetime.fromisoformat(first["currentExpiresAt"]) + timedelta(
        minutes=30
    )
    assert str(canonical["latest_envelope_id"]) == original["receipt"]["envelopeId"]
    assert (
        len(
            db.execute_raw(
                "SELECT id FROM one_location_events WHERE event_type='location_share_duration_changed'"
            ).data
        )
        == 1
    )

    replay = LocationChatPlanService(service()).prepare(
        user_id="owner",
        action="extend",
        grant_id=grant_id,
        duration_hours=0.5,
        origin_id=origin_id,
        attempt_id=attempt_id,
    )
    assert replay["planId"] == first["planId"] and replay["status"] == "executed"
    later = LocationChatPlanService(service()).prepare(
        user_id="owner",
        action="extend",
        grant_id=grant_id,
        duration_hours=0.5,
        origin_id=origin_id,
        attempt_id=str(uuid4()),
    )
    assert later["planId"] != first["planId"] and later["status"] == "pending"
    assert {
        row["planId"]
        for row in LocationChatPlanService(service()).for_origin(
            user_id="owner", origin_id=origin_id
        )
    } == {first["planId"], later["planId"]}

    with pytest.raises(location.OneLocationAgentError, match="share changed"):
        LocationChatPlanService(service()).execute(user_id="owner", plan_id=sibling["planId"])
    changed = service().set_grant_duration(
        owner_user_id="owner", grant_id=grant_id, duration_hours=4
    )
    fresh = LocationChatPlanService(service()).prepare(
        user_id="owner",
        action="set_duration",
        grant_id=grant_id,
        duration_mode="until_stopped",
    )
    assert datetime.fromisoformat(fresh["currentExpiresAt"]) == datetime.fromisoformat(
        changed["expiresAt"]
    )
    outcome = LocationChatPlanService(service()).execute(user_id="owner", plan_id=fresh["planId"])
    assert outcome["nextExpiresAt"] is None
    stop = LocationChatPlanService(service()).prepare(
        user_id="owner", action="stop", grant_id=grant_id
    )
    assert LocationChatPlanService(service()).execute(user_id="owner", plan_id=stop["planId"])[
        "receipt"
    ] == {"grantId": grant_id}


@pytest.mark.parametrize("directory_offline", [False, True])
def test_owner_can_stop_the_selected_grant_when_peer_is_unavailable(
    location_plans, monkeypatch, directory_offline
):
    service, db = location_plans
    plans = LocationChatPlanService(service())
    grant_id = offer(service)["receipt"]["grantId"]
    circle_id = str(uuid4())
    db.execute_raw(
        """INSERT INTO one_location_circles(id, owner_user_id, name)
           VALUES (CAST(:circle AS UUID), 'owner', 'Family');
           UPDATE one_location_share_grants SET source_circle_id = CAST(:circle AS UUID)
           WHERE id = CAST(:grant AS UUID)""",
        {"circle": circle_id, "grant": grant_id},
    )

    def unavailable(user_ids, **_):
        if directory_offline:
            raise location.DirectoryIdentityUnavailableError()
        return set(user_ids) - {"other"}

    monkeypatch.setattr(location, "active_directory_user_ids", unavailable)
    with pytest.raises(location.OneLocationAgentError) as wrong_actor:
        plans.prepare(user_id="other", action="stop", grant_id=grant_id)
    assert wrong_actor.value.status_code == 404
    with pytest.raises(location.OneLocationAgentError) as wrong_circle:
        plans.prepare(user_id="owner", action="stop", grant_id=grant_id, circle_id=str(uuid4()))
    assert wrong_circle.value.status_code == 409
    with pytest.raises(location.OneLocationAgentError) as extension:
        plans.prepare(user_id="owner", action="extend", grant_id=grant_id, duration_hours=0.5)
    assert extension.value.code == (
        "DIRECTORY_IDENTITY_UNAVAILABLE" if directory_offline else "LOCATION_PEER_UNAVAILABLE"
    )

    review = plans.prepare(user_id="owner", action="stop", grant_id=grant_id, circle_id=circle_id)
    receipt = plans.execute(user_id="owner", plan_id=review["planId"])
    assert receipt["receipt"] == {"grantId": grant_id}
    assert plans.execute(user_id="owner", plan_id=review["planId"]) == receipt
    assert db.execute_raw("SELECT status FROM one_location_share_grants").data == [
        {"status": "revoked"}
    ]


def test_chat_extension_requests_settle_in_place_in_either_surface(location_plans):
    service, db = location_plans
    initial = offer(service)
    grant_id = initial["receipt"]["grantId"]

    def ask():
        review = LocationChatPlanService(service()).prepare(
            user_id="other", action="ask_extension", grant_id=grant_id, duration_hours=0.5
        )
        return LocationChatPlanService(service()).execute(
            user_id="other", plan_id=review["planId"]
        )["receipt"]["requestId"]

    request_id = ask()
    plan = LocationChatPlanService(service()).prepare(
        user_id="owner", action="approve", request_id=request_id
    )
    reply = service().approve_request(
        owner_user_id="owner",
        request_id=request_id,
        approval_mode="manual",
        duration_hours=None,
        expected_request_revision=1,
    )
    assert reply["grant"]["id"] == grant_id
    assert reply["grant"]["latestEnvelopeId"] == initial["receipt"]["envelopeId"]
    assert datetime.fromisoformat(reply["grant"]["expiresAt"]) == datetime.fromisoformat(
        plan["nextExpiresAt"]
    )
    with pytest.raises(location.OneLocationAgentError, match="share changed"):
        LocationChatPlanService(service()).execute(user_id="owner", plan_id=plan["planId"])

    next_request = service().request_access(
        requester_user_id="other",
        owner_user_id="owner",
        requested_duration_hours=0.5,
        extends_grant_id=grant_id,
    )["id"]
    approve = LocationChatPlanService(service()).prepare(
        user_id="owner", action="approve", request_id=next_request
    )
    assert (
        LocationChatPlanService(service()).execute(
            user_id="owner",
            plan_id=approve["planId"],
        )["receipt"]["grantId"]
        == grant_id
    )

    final_request = ask()
    decline = LocationChatPlanService(service()).prepare(
        user_id="owner", action="decline", request_id=final_request
    )
    LocationChatPlanService(service()).execute(user_id="owner", plan_id=decline["planId"])
    assert [
        row["status"]
        for row in db.execute_raw(
            "SELECT status FROM one_location_access_requests ORDER BY requested_at"
        ).data
    ] == ["approved", "approved", "denied"]
    assert len(db.execute_raw("SELECT id FROM one_location_share_grants").data) == 1


def test_circle_review_rechecks_each_member_at_confirmation(location_plans):
    service, db = location_plans
    circle_id, origin_id = str(uuid4()), str(uuid4())
    db.execute_raw(
        """INSERT INTO actor_profiles(user_id) VALUES ('third') ON CONFLICT DO NOTHING;
           INSERT INTO one_location_circles(id, owner_user_id, name)
           VALUES (CAST(:circle AS UUID), 'owner', 'Family');
           INSERT INTO one_location_circle_memberships(circle_id, user_id, role)
           VALUES (CAST(:circle AS UUID), 'owner', 'owner'),
                  (CAST(:circle AS UUID), 'other', 'member'),
                  (CAST(:circle AS UUID), 'third', 'member');""",
        {"circle": circle_id},
    )
    plans = LocationChatPlanService(service())
    reviews = {
        person: plans.prepare(
            user_id="owner",
            action="share_live",
            person_user_id=person,
            origin_id=origin_id,
            circle_id=circle_id,
            duration_hours=1,
        )
        for person in ("other", "third")
    }
    assert db.execute_raw("SELECT id FROM one_location_share_grants").data == []
    db.execute_raw(
        """UPDATE one_location_circle_memberships SET status='removed'
           WHERE circle_id=CAST(:circle AS UUID) AND user_id='other'""",
        {"circle": circle_id},
    )
    with pytest.raises(location.OneLocationAgentError):
        plans.execute(user_id="owner", plan_id=reviews["other"]["planId"], envelope=envelope())
    outcome = plans.execute(
        user_id="owner",
        plan_id=reviews["third"]["planId"],
        envelope=envelope("key-3"),
    )
    assert outcome["circleId"] == circle_id
    # A lost confirmation response can be retried against the same reviewed
    # recipient without publishing a second envelope or extending the grant.
    retry = plans.execute(
        user_id="owner",
        plan_id=reviews["third"]["planId"],
        envelope=envelope("key-3"),
    )
    assert retry == outcome
    assert len(db.execute_raw("SELECT id FROM one_location_envelopes").data) == 1
    assert db.execute_raw(
        "SELECT recipient_user_id, source_circle_id::text FROM one_location_share_grants"
    ).data == [{"recipient_user_id": "third", "source_circle_id": circle_id}]
