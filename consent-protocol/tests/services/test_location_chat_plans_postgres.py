"""Canonical Location transactions used by ONE main chat reviews."""

import asyncio
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import ProgrammingError

from hushh_mcp.services import one_location_agent_service as location
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


def offer(service, action="share_live", *, origin_id=None):
    plan = LocationChatPlanService(service()).prepare(
        user_id="owner",
        action=action,
        person_user_id="other",
        duration_hours=None if action == "share_pin" else 2,
        origin_id=origin_id,
    )
    result = LocationChatPlanService(service()).execute(
        user_id="owner", plan_id=plan["planId"], envelope=envelope()
    )
    assert result["status"] == "executed"
    assert "recipientKey" not in result
    return result


def test_pin_has_its_own_immutable_lane_and_pinned_view(location_plans):
    service, db = location_plans
    origin_id = str(uuid4())
    live = offer(service, origin_id=origin_id)
    pin = offer(service, "share_pin", origin_id=origin_id)
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

    # Stale pending key material cannot hide the existing receipts.
    LocationChatPlanService(service()).prepare(
        user_id="owner",
        action="share_pin",
        person_user_id="other",
        origin_id=origin_id,
        attempt_id=str(uuid4()),
    )
    db.execute_raw("UPDATE one_location_recipient_keys SET status='rotated' WHERE user_id='other'")
    restored = LocationChatPlanService(service()).for_origin(user_id="owner", origin_id=origin_id)
    assert {row["planId"] for row in restored} == {live["planId"], pin["planId"]}
    assert LocationChatPlanService(service()).for_origin(user_id="third", origin_id=origin_id) == []
    with db.engine.begin() as connection:
        connection.execute(text("CREATE ROLE one_chat_plan_unprivileged NOLOGIN"))
        connection.execute(text("SET LOCAL ROLE one_chat_plan_unprivileged"))
        with pytest.raises(ProgrammingError, match="permission denied"):
            connection.execute(text("SELECT * FROM public.one_location_chat_plans"))


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
    assert db.execute_raw(
        "SELECT recipient_user_id, source_circle_id::text FROM one_location_share_grants"
    ).data == [{"recipient_user_id": "third", "source_circle_id": circle_id}]
