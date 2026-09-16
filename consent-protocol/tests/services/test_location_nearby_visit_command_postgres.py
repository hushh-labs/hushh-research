"""Presence/visit correlation uses real encrypted stores and transactions."""

import asyncio
from datetime import datetime, timezone
from pathlib import Path

import pytest
from sqlalchemy import text

from hushh_mcp.services import location_command_effect_receipts as receipts
from hushh_mcp.services import one_location_nearby_presence_service as presence
from hushh_mcp.services import one_location_place_rating_service as ratings
from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError
from hushh_mcp.services.one_location_nearby_presence_service import OneLocationNearbyPresenceService
from tests.services.test_location_command_postgres import (
    db as db,
)
from tests.services.test_location_command_postgres import (
    nearby_checkout_command,
    nearby_command,
)


def rating_fixture(db, monkeypatch):
    db.execute_raw(
        "CREATE OR REPLACE VIEW actor_identity_cache AS SELECT user_id, user_id AS display_name, TRUE AS phone_verified FROM actor_profiles"
    )
    migrations = Path(__file__).resolve().parents[2] / "db/migrations"
    db.execute_raw((migrations / "219_location_presence_rating_visit.sql").read_text())
    monkeypatch.setattr(ratings, "get_db", lambda: db)
    monkeypatch.setattr(ratings, "VAULT_DATA_KEY", "12" * 32)
    monkeypatch.setattr(presence, "VAULT_DATA_KEY", "12" * 32)
    # Nearby's independent roster/connection read is empty in this owner-only fixture.
    monkeypatch.setattr(
        presence.PostgresNearbyPresenceStore, "read_active_candidates", lambda *_args, **_kwargs: []
    )
    return ratings.OneLocationPlaceRatingService()


def prepared(service, place="synthetic-cafe"):
    return service.prepare_visit(
        user_id="owner",
        place_id=place,
        place_label=place,
        latitude=1.0,
        longitude=2.0,
        checked_in_at=datetime.now(timezone.utc),
    )


@pytest.mark.asyncio
async def test_check_in_visit_and_receipt_are_atomic_and_replay_cannot_touch_a_later_visit(
    db, monkeypatch
):
    store, values, _, _, _ = await nearby_command(db, monkeypatch)
    service = rating_fixture(db, monkeypatch)
    values["prepared_rating_visit"] = prepared(service)
    save = receipts.CommandEffectReceipt.save

    def fail(*_):
        raise RuntimeError("synthetic receipt failure")

    monkeypatch.setattr(receipts.CommandEffectReceipt, "save", fail)
    with pytest.raises(RuntimeError):
        store.upsert_presence(**values)
    assert db.execute_raw("SELECT id FROM one_location_nearby_presences").data == []
    assert db.execute_raw("SELECT id FROM one_location_nearby_visits").data == []
    monkeypatch.setattr(receipts.CommandEffectReceipt, "save", save)
    first, replay = await asyncio.gather(
        *[asyncio.to_thread(store.upsert_presence, **values) for _ in range(2)]
    )
    assert first["_command_receipt"] == replay["_command_receipt"]
    pointer = db.execute_raw("SELECT rating_visit_id FROM one_location_nearby_presences").data[0][
        "rating_visit_id"
    ]
    assert db.execute_raw("SELECT id FROM one_location_nearby_visits").data == [{"id": pointer}]
    manual = {k: v for k, v in values.items() if k != "command_operation_id"}
    store.checkout("owner")
    store.upsert_presence(**manual)
    later = db.execute_raw(
        "SELECT rating_visit_id,checked_in_at FROM one_location_nearby_presences"
    ).data[0]
    assert later["rating_visit_id"] != pointer
    store.upsert_presence(**values)
    assert db.execute_raw(
        "SELECT rating_visit_id,checked_in_at FROM one_location_nearby_presences"
    ).data == [later]


@pytest.mark.asyncio
async def test_exact_checkout_and_prompt_leave_another_open_venue_and_new_visit_untouched(
    db, monkeypatch
):
    store, manual, checkout, _ = await nearby_checkout_command(db, monkeypatch)
    service = rating_fixture(db, monkeypatch)
    # The command was reviewed at version 1. Attach the protected visit under
    # its row lock, just as the unified production upsert does.
    visit = prepared(service)
    with db.engine.begin() as conn:
        conn.execute(text("SELECT id FROM one_location_nearby_presences FOR UPDATE"))
        saved = ratings.PostgresPlaceRatingStore().insert_visit(
            connection=conn,
            user_id="owner",
            envelope=visit.envelope,
            place_token_value=visit.place_token_value,
            checked_in_at=visit.checked_in_at,
            expires_at=visit.expires_at,
        )
        conn.execute(text("UPDATE one_location_nearby_presences SET rating_visit_id=:id"), saved)
    other = service.record_visit(
        user_id="owner", place_id="another-venue", place_label="Another venue"
    )
    nearby = OneLocationNearbyPresenceService(store=store, place_rating_factory=lambda: service)
    first = nearby.checkout(**checkout)
    assert first["reviewPrompt"]["visitId"] == str(saved["id"])
    assert service.describe_exact_visit(user_id="other", visit_id=str(saved["id"])) is None
    assert db.execute_raw(
        "SELECT ended_at FROM one_location_nearby_visits WHERE id=:id", other
    ).data == [{"ended_at": None}]
    manual["anchor_envelope"] = presence._encrypt_anchor(
        {
            "schemaVersion": 3,
            "coordinateKind": "selected_place_point_v1",
            "label": "Cafe",
            "latitude": 1.0,
            "longitude": 2.0,
        },
        owner_user_id="owner",
    )
    store.upsert_presence(**{**manual, "prepared_rating_visit": prepared(service)})
    newer = db.execute_raw("SELECT rating_visit_id,version FROM one_location_nearby_presences").data
    replay = nearby.checkout(**checkout)
    assert replay["checkoutReceipt"] == first["checkoutReceipt"]
    assert replay["presence"]["version"] == newer[0]["version"]
    assert replay["presence"]["status"] == "active"
    assert (
        db.execute_raw("SELECT rating_visit_id,version FROM one_location_nearby_presences").data
        == newer
    )
    assert db.execute_raw(
        "SELECT ended_at FROM one_location_nearby_visits WHERE id=:id",
        {"id": newer[0]["rating_visit_id"]},
    ).data == [{"ended_at": None}]
    manual_result = nearby.checkout(user_id="owner")
    assert manual_result["checkedOut"] and manual_result["reviewPrompt"]["visitId"] == str(
        newer[0]["rating_visit_id"]
    )
    assert nearby.checkout(user_id="owner") == {
        "presence": None,
        "attendees": [],
        "checkedOut": True,
        "reviewPrompt": None,
    }
    assert nearby.checkout(user_id="other")["checkedOut"] is True


@pytest.mark.asyncio
async def test_checkout_receipt_failure_rolls_back_visit_closure_and_presence(db, monkeypatch):
    store, manual, checkout, _ = await nearby_checkout_command(db, monkeypatch)
    service = rating_fixture(db, monkeypatch)
    visit = service.record_visit(user_id="owner", place_id="synthetic-cafe", place_label="Cafe")
    db.execute_raw("UPDATE one_location_nearby_presences SET rating_visit_id=:id", visit)

    def fail(*_):
        raise RuntimeError("synthetic receipt failure")

    monkeypatch.setattr(receipts.CommandEffectReceipt, "save", fail)
    with pytest.raises(RuntimeError):
        store.checkout(**checkout)
    assert db.execute_raw(
        "SELECT status,version,rating_visit_id FROM one_location_nearby_presences"
    ).data == [{"status": "active", "version": 1, "rating_visit_id": visit["id"]}]
    assert db.execute_raw("SELECT ended_at FROM one_location_nearby_visits").data == [
        {"ended_at": None}
    ]


@pytest.mark.asyncio
async def test_foreign_visit_pointer_cannot_close_or_reveal_another_owners_visit(db, monkeypatch):
    store, values, _, _, _ = await nearby_command(db, monkeypatch)
    service = rating_fixture(db, monkeypatch)
    store.upsert_presence(**values)
    foreign = service.record_visit(user_id="other", place_id="synthetic-cafe", place_label="Cafe")
    db.execute_raw("UPDATE one_location_nearby_presences SET rating_visit_id=:id", foreign)
    result = OneLocationNearbyPresenceService(
        store=store, place_rating_factory=lambda: service
    ).checkout(user_id="owner")
    assert result["checkedOut"] and result["reviewPrompt"] is None
    assert db.execute_raw("SELECT ended_at FROM one_location_nearby_visits").data == [
        {"ended_at": None}
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["insert", "close"])
async def test_optional_rating_failure_rolls_back_only_its_savepoint(db, monkeypatch, phase):
    store, values, _, _, _ = await nearby_command(db, monkeypatch)
    service = rating_fixture(db, monkeypatch)
    if phase == "insert":
        db.execute_raw(
            "ALTER TABLE one_location_nearby_visits ADD CONSTRAINT fixture_reject CHECK (false)"
        )
        result = store.upsert_presence(**{**values, "prepared_rating_visit": prepared(service)})
        assert result["_command_receipt"]
        assert db.execute_raw("SELECT rating_visit_id FROM one_location_nearby_presences").data == [
            {"rating_visit_id": None}
        ]
    else:
        store.upsert_presence(**{**values, "prepared_rating_visit": prepared(service)})
        db.execute_raw(
            "ALTER TABLE one_location_nearby_visits ADD CONSTRAINT fixture_reject CHECK (ended_at IS NULL)"
        )
        assert store.checkout("owner")["checked_out"] is True
        assert db.execute_raw(
            "SELECT status,rating_visit_id FROM one_location_nearby_presences"
        ).data == [{"status": "checked_out", "rating_visit_id": None}]
        assert db.execute_raw("SELECT ended_at FROM one_location_nearby_visits").data == [
            {"ended_at": None}
        ]


@pytest.mark.asyncio
async def test_manual_same_place_deduplicates_and_mixed_version_alias_rotation_clears_pointer(
    db, monkeypatch
):
    store, values, _, _, _ = await nearby_command(db, monkeypatch)
    service = rating_fixture(db, monkeypatch)
    values.pop("command_operation_id")
    values["prepared_rating_visit"] = prepared(service)
    store.upsert_presence(**values)
    first = db.execute_raw("SELECT id,checked_in_at FROM one_location_nearby_visits").data
    store.upsert_presence(**values)
    assert db.execute_raw("SELECT id,checked_in_at FROM one_location_nearby_visits").data == first
    # Old binaries do not know the new column. Their alias rotation invalidates
    # it; checkout must not guess a visit by owner or time afterward.
    db.execute_raw("UPDATE one_location_nearby_presences SET participant_alias=gen_random_uuid()")
    assert db.execute_raw("SELECT rating_visit_id FROM one_location_nearby_presences").data == [
        {"rating_visit_id": None}
    ]
    assert store.checkout("owner").get("rating_visit_id") is None
    assert db.execute_raw("SELECT ended_at FROM one_location_nearby_visits").data == [
        {"ended_at": None}
    ]
    migrations = Path(__file__).resolve().parents[2] / "db/migrations"
    db.execute_raw(
        (migrations / "rollback/219_location_presence_rating_visit.rollback.sql").read_text()
    )
    db.execute_raw(
        (migrations / "rollback/219_location_presence_rating_visit.rollback.sql").read_text()
    )
    assert db.execute_raw("SELECT id,checked_in_at FROM one_location_nearby_visits").data == first
    db.execute_raw((migrations / "219_location_presence_rating_visit.sql").read_text())


@pytest.mark.asyncio
async def test_expiry_after_waiting_on_presence_rolls_back_new_visit_and_effect(db, monkeypatch):
    store, values, _, _, _ = await nearby_command(db, monkeypatch)
    service = rating_fixture(db, monkeypatch)
    store.upsert_presence(**{k: v for k, v in values.items() if k != "command_operation_id"})
    before = db.execute_raw("SELECT version FROM one_location_nearby_presences").data
    db.execute_raw(
        "UPDATE one_action_directive_ledger SET expires_at=clock_timestamp()+INTERVAL '2 seconds'"
    )
    with db.engine.begin() as conn:
        conn.execute(text("SELECT id FROM one_location_nearby_presences FOR UPDATE"))
        task = asyncio.create_task(
            asyncio.to_thread(
                store.upsert_presence, **{**values, "prepared_rating_visit": prepared(service)}
            )
        )
        for _ in range(100):
            waiting = await asyncio.to_thread(
                db.execute_raw,
                "SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%INSERT INTO one_location_nearby_presences%' AND pid<>pg_backend_pid()",
            )
            if waiting.data:
                break
            await asyncio.sleep(0.02)
        else:
            pytest.fail("Writer did not reach presence lock")
        await asyncio.sleep(2.1)
    with pytest.raises(ActionDirectiveAuthorityError):
        await task
    assert db.execute_raw("SELECT version FROM one_location_nearby_presences").data == before
    assert db.execute_raw("SELECT id FROM one_location_nearby_visits").data == []


@pytest.mark.asyncio
@pytest.mark.parametrize("command", [False, True])
async def test_locked_optional_visit_cannot_block_checkout(db, monkeypatch, command):
    store, _, checkout, _ = await nearby_checkout_command(db, monkeypatch)
    service = rating_fixture(db, monkeypatch)
    visit = service.record_visit(user_id="owner", place_id="synthetic-cafe", place_label="Cafe")
    db.execute_raw("UPDATE one_location_nearby_presences SET rating_visit_id=:id", visit)
    with db.engine.begin() as connection:
        connection.execute(text("SELECT id FROM one_location_nearby_visits FOR UPDATE"))
        result = await asyncio.wait_for(
            asyncio.to_thread(store.checkout, **(checkout if command else {"user_id": "owner"})),
            timeout=2,
        )
        assert result["checked_out"] is True
        assert result.get("rating_visit_id") is None
        assert db.execute_raw("SELECT status FROM one_location_nearby_presences").data == [
            {"status": "checked_out"}
        ]
    assert db.execute_raw("SELECT ended_at FROM one_location_nearby_visits").data == [
        {"ended_at": None}
    ]


@pytest.mark.asyncio
async def test_locked_optional_same_place_visit_cannot_block_check_in(db, monkeypatch):
    store, values, _, _, _ = await nearby_command(db, monkeypatch)
    service = rating_fixture(db, monkeypatch)
    visit = prepared(service)
    service.record_visit(user_id="owner", place_id="synthetic-cafe", place_label="Cafe")
    with db.engine.begin() as connection:
        connection.execute(text("SELECT id FROM one_location_nearby_visits FOR UPDATE"))
        result = await asyncio.wait_for(
            asyncio.to_thread(store.upsert_presence, **{**values, "prepared_rating_visit": visit}),
            timeout=2,
        )
        assert result["_command_receipt"]
        assert db.execute_raw(
            "SELECT status,rating_visit_id FROM one_location_nearby_presences"
        ).data == [{"status": "active", "rating_visit_id": None}]


@pytest.mark.asyncio
async def test_late_old_checkout_cannot_close_new_active_visit(db, monkeypatch):
    store, values, _, _, _ = await nearby_command(db, monkeypatch)
    service = rating_fixture(db, monkeypatch)
    values.pop("command_operation_id")
    store.upsert_presence(**{**values, "prepared_rating_visit": prepared(service, "venue-a")})
    # Characterize the original two-transaction writer: primary checkout
    # commits, a new check-in arrives, then the old broad visit closure runs.
    db.execute_raw("""UPDATE one_location_nearby_presences SET status='checked_out',
        anchor_ciphertext=NULL,anchor_iv=NULL,anchor_tag=NULL,anchor_algorithm=NULL,anchor_key_id=NULL,
        anchor_cell_epoch=NULL,anchor_cell_token=NULL,checked_out_at=clock_timestamp()""")
    store.upsert_presence(**{**values, "prepared_rating_visit": prepared(service, "venue-b")})
    current = db.execute_raw("SELECT rating_visit_id FROM one_location_nearby_presences").data[0][
        "rating_visit_id"
    ]
    ratings.PostgresPlaceRatingStore().end_open_visits(
        user_id="owner", ended_at=datetime.now(timezone.utc)
    )
    assert db.execute_raw(
        "SELECT ended_at FROM one_location_nearby_visits WHERE id=:id", {"id": current}
    ).data == [{"ended_at": None}]
    nearby = OneLocationNearbyPresenceService(store=store, place_rating_factory=lambda: service)
    assert nearby.checkout(user_id="owner")["reviewPrompt"]["visitId"] == str(current)
