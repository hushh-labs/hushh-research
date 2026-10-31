"""Universal sources and participant history against real, isolated Postgres."""
# Imported pytest fixtures intentionally have the same names as test parameters.
# ruff: noqa: F811

import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Barrier

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from test_wallet_card_access_postgres import (  # noqa: F401
    active_card,
    cards_db,
    legacy_cards_db,
    projection_db,
    refs,
)

from hushh_mcp.services.wallet_card_access_service import WalletCardAccessError


def profile(db, owner="alice"):
    with db.engine.begin() as conn:
        row = conn.execute(
            text("""INSERT INTO one_wallet_cards(user_id,share_token_hash,card_payload)
 VALUES(:owner,:hash,CAST(:payload AS jsonb)) RETURNING pass_serial"""),
            {
                "owner": owner,
                "hash": "a" * 64,
                "payload": json.dumps(
                    {"full_name": "Alice", "email": "alice@example.test", "pan": "NEVER_SHARE"}
                ),
            },
        ).scalar_one()
    return "profile_" + str(row)


def grants_by_recipient(db):
    return {
        r["recipient_user_id"]: str(r["id"])
        for r in db.execute_raw(
            "SELECT id,recipient_user_id FROM wallet_profile_access_grants", {}
        ).data
    }


@pytest.mark.parametrize("minutes", [15, 60, 120])
@pytest.mark.parametrize("source", ["payment", "profile"])
def test_share_duration_is_persisted_and_controls_expiry(cards_db, minutes, source):
    db, service = cards_db
    card = active_card(db, service) if source == "payment" else profile(db)
    request_id = str(uuid.uuid4())
    result = service.create_grants("alice", card, request_id, refs(db), minutes)
    table = "wallet_card_share_requests" if source == "payment" else "wallet_profile_share_requests"
    row = db.execute_raw(
        f"SELECT duration_minutes,created_at,expires_at FROM {table} WHERE request_id=CAST(:id AS uuid)",  # nosec B608
        {"id": request_id},
    ).data[0]
    assert row["duration_minutes"] == minutes
    assert row["expires_at"] - row["created_at"] == timedelta(minutes=minutes)
    assert len(result["grants"]) == 2
    assert service.create_grants("alice", card, request_id, refs(db), minutes) == result


def test_history_detail_handles_grant_erased_before_lock(cards_db, monkeypatch):
    from hushh_mcp.services import wallet_sharing_history

    db, service = cards_db
    service.create_grants("alice", profile(db), str(uuid.uuid4()), refs(db), 15)
    grant = grants_by_recipient(db)["charu"]
    graph_lock = wallet_sharing_history.lock_connection_graph_users

    def erase_after_selection(conn, **kwargs):
        graph_lock(conn, **kwargs)
        conn.execute(
            text("DELETE FROM wallet_profile_access_grants WHERE id=CAST(:id AS uuid)"),
            {"id": grant},
        )

    monkeypatch.setattr(
        wallet_sharing_history, "lock_connection_graph_users", erase_after_selection
    )
    with pytest.raises(WalletCardAccessError) as error:
        service.history("alice", grant_id=grant)
    assert error.value.code == "WALLET_CARD_ACCESS_NOT_FOUND"
    assert error.value.status_code == 404


def test_profile_live_fields_independent_verification_and_terminal_revocation(cards_db):
    db, service = cards_db
    card = profile(db)
    request = str(uuid.uuid4())
    result = service.create_grants("alice", card, request, refs(db), 15)
    assert service.create_grants("alice", card, request, refs(db), 15) == result
    ids = grants_by_recipient(db)
    public = service.view_grant("charu", ids["charu"])["profileCard"]
    assert public["fullName"] == "Alice" and public["email"] == "alice@example.test"
    assert "pan" not in public
    assert service.view_grant("bob", ids["bob"])["status"] == "verification_required"
    for _ in range(5):
        assert (
            service.view_grant("bob", ids["bob"], verified_auth_time=1)["status"]
            == "verification_required"
        )
    assert (
        service.view_grant(
            "bob", ids["bob"], verified_auth_time=datetime.now(timezone.utc).timestamp() + 1
        )["status"]
        == "verification_required"
    )
    with db.engine.begin() as conn:
        conn.execute(
            text("UPDATE one_wallet_cards SET card_payload=CAST(:payload AS jsonb)"),
            {"payload": json.dumps({"full_name": "Alice", "headline": "New field"})},
        )
    changed = service.view_grant("charu", ids["charu"])["profileCard"]
    assert "email" not in changed and "headline" not in changed
    with db.engine.begin() as conn:
        conn.execute(text("UPDATE one_wallet_cards SET status='paused'"))
    assert service.view_grant("charu", ids["charu"])["status"] == "unavailable"
    with db.engine.begin() as conn:
        conn.execute(text("UPDATE one_wallet_cards SET status='active'"))
    assert service.view_grant("charu", ids["charu"])["status"] == "active"
    service.revoke("alice", ids["bob"])
    service.revoke("alice", ids["bob"])
    assert service.view_grant("charu", ids["charu"])["status"] == "active"
    with db.engine.begin() as conn:
        conn.execute(
            text("UPDATE one_wallet_cards SET status='revoked',revoked_at=clock_timestamp()")
        )
        conn.execute(text("UPDATE one_wallet_cards SET status='active',revoked_at=NULL"))
    assert service.view_grant("charu", ids["charu"])["status"] == "revoked"
    assert (
        len(
            db.execute_raw(
                "SELECT id FROM wallet_card_access_audit WHERE event_type='revoked'", {}
            ).data
        )
        == 2
    )


def test_unified_history_is_paged_scoped_and_survives_source_removal(cards_db):
    db, service = cards_db
    payment = active_card(db, service)
    profile_card = profile(db)
    service.create_grants("alice", payment, str(uuid.uuid4()), refs(db), 5)
    service.create_grants("alice", profile_card, str(uuid.uuid4()), refs(db), 10)
    first = service.history("alice", limit=1)
    assert first["recipientCount"] == 2
    assert first["hasMore"] and first["items"][0]["cardType"] == "profile"
    ids = {first["items"][0]["id"]}
    cursor = first["nextCursor"]
    while cursor:
        page = service.history("alice", cursor=cursor, limit=1)
        assert page["recipientCount"] == 2
        assert page["items"][0]["id"] not in ids
        ids.add(page["items"][0]["id"])
        cursor = page["nextCursor"]
    assert len(ids) == 4
    with pytest.raises(WalletCardAccessError):
        service.history("bob", cursor=first["nextCursor"])
    assert service.history("bob")["items"] == []
    assert len(service.history("bob", direction="received")["items"]) == 2
    assert service.history("outsider", direction="received")["items"] == []
    rows = service.history("alice", card_type="payment")["items"]
    assert all(row["displayLabel"] == "VISA •••• 4242" for row in rows)
    assert {row["trustedCircle"] for row in rows} == {True, False}
    assert all(row["durationMinutes"] == 5 for row in rows)
    assert all(
        {a["event"] for a in row["activity"]} == {"SHARE_CREATED", "SHARE_DELIVERED"}
        for row in rows
    )
    with db.engine.begin() as conn:
        conn.execute(text("DELETE FROM pkm_manifests WHERE user_id='alice'"))
        conn.execute(text("DELETE FROM one_wallet_cards WHERE user_id='alice'"))
    history = service.history("alice")
    assert len(history["items"]) == 4 and all(
        row["status"] == "revoked" for row in history["items"]
    )
    assert all(row["revokedAt"] for row in history["items"])
    assert not any(
        secret in json.dumps(history)
        for secret in (
            "NEVER_SHARE",
            "alice@example.test",
            "content_ciphertext",
            "vaultKey",
            '"pan"',
        )
    )


def test_profile_owner_provenance_retry_collision_feed_and_erasure(cards_db):
    db, service = cards_db
    card = profile(db)
    with pytest.raises(WalletCardAccessError):
        service.create_grants("bob", card, str(uuid.uuid4()), refs(db), 5)
    for forbidden in (
        "agent-one-profile",
        "agent-one-referral",
        "agent-one-net-worth",
        "received_" + card,
    ):
        with pytest.raises(WalletCardAccessError):
            service.create_grants("alice", forbidden, str(uuid.uuid4()), refs(db), 5)
    request = str(uuid.uuid4())
    service.create_grants("alice", card, request, refs(db), 5)
    payment = active_card(db, service)
    with pytest.raises(WalletCardAccessError, match="RETRY_CONFLICT"):
        service.create_grants("alice", payment, request, refs(db), 5)
    ids = grants_by_recipient(db)
    with pytest.raises(WalletCardAccessError):
        service.view_grant("outsider", ids["charu"])
    from hushh_mcp.services.feed_service import FeedService

    feed = FeedService()
    feed._db = db
    rows = db.execute_raw("SELECT * FROM feed_events WHERE user_id='charu'", {}).data
    assert feed._with_wallet_card_grants("charu", rows)[0]["_wallet_card_grant_id"] == ids["charu"]
    assert "wallet_all_access_grants" in feed._grouped_feed_sql(count=False)
    rollback = Path("db/migrations/rollback/322_wallet_universal_sharing.rollback.sql").read_text()
    with db.engine.begin() as conn:
        conn.exec_driver_sql(rollback)
        conn.execute(text("DELETE FROM actor_identity_cache WHERE user_id='charu'"))
        conn.execute(text("DELETE FROM feed_event_counterparts WHERE counterpart_user_id='charu'"))
        conn.execute(text("DELETE FROM actor_profiles WHERE user_id='charu'"))
    assert len(service.history("alice")["items"]) == 1
    assert service.history("charu", direction="received")["items"] == []


def test_profile_expiry_logged_once_and_failed_delivery_rolls_back(cards_db, monkeypatch):
    db, service = cards_db
    card = profile(db)
    from hushh_mcp.services import wallet_card_access_service as module

    query = module.one

    def old_clock(conn, sql, values=None):
        if sql == "SELECT clock_timestamp() AS created_at":
            return {"created_at": datetime.now(timezone.utc) - timedelta(minutes=20)}
        return query(conn, sql, values)

    monkeypatch.setattr(module, "one", old_clock)
    service.create_grants("alice", card, str(uuid.uuid4()), refs(db), 5)
    ids = grants_by_recipient(db)
    assert service.view_grant("charu", ids["charu"])["status"] == "expired"
    service.history("alice")
    service.history("alice")
    assert (
        len(
            db.execute_raw(
                "SELECT id FROM wallet_card_access_audit WHERE event_type='expired'", {}
            ).data
        )
        == 2
    )
    assert all(row["revokedAt"] is None for row in service.history("alice")["items"])
    send = module.DirectMessagesService.send_message
    calls = 0

    def fail_second(self, *args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("delivery unavailable")
        return send(self, *args, **kwargs)

    monkeypatch.setattr(module.DirectMessagesService, "send_message", fail_second)
    with pytest.raises(RuntimeError):
        service.create_grants("alice", card, str(uuid.uuid4()), refs(db), 5)
    assert len(service.history("alice")["items"]) == 2
    assert len(db.execute_raw("SELECT id FROM messages", {}).data) == 2


def test_legacy_manual_grants_work_before_universal_migration(legacy_cards_db):
    db, service = legacy_cards_db
    card = active_card(db, service)
    request = str(uuid.uuid4())
    result = service.create_grants("alice", card, request, refs(db), 10)
    assert service.create_grants("alice", card, request, refs(db), 10) == result
    grants = db.execute_raw("SELECT id,recipient_user_id FROM wallet_card_access_grants", {}).data
    identifier = next(str(row["id"]) for row in grants if row["recipient_user_id"] == "charu")
    assert service.view_grant("charu", identifier)["card"]["last4"] == "4242"
    service.revoke("alice", identifier)
    assert service.view_grant("charu", identifier)["status"] == "revoked"
    assert not service.profile_access("alice")["eligible"]
    with pytest.raises(WalletCardAccessError, match="WALLET_CARD_ACCESS_NOT_READY") as unavailable:
        service.history("alice")
    assert unavailable.value.status_code == 503

    db.apply_migrations(
        [
            "132_one_wallet_card.sql",
            "322_wallet_universal_sharing.sql",
            "323_wallet_sharing_owner_index.sql",
            "324_wallet_sharing_recipient_index.sql",
            "325_wallet_sharing_audit_index.sql",
        ]
    )
    history = service.history("alice")["items"]
    assert len(history) == 2
    assert all(row["trustedCircle"] is None for row in history)
    assert all(row["method"] == "legacy_unspecified" for row in history)
    trusted_history = next(row for row in history if row["id"] == identifier)
    assert trusted_history["verificationMethod"] == "legacy_unspecified"
    assert trusted_history["status"] == "revoked"
    normal_history = next(row for row in history if row["id"] != identifier)
    assert normal_history["verificationMethod"] == "identity_reauthentication"


def test_profile_mutations_history_and_views_share_lock_order(cards_db, monkeypatch):
    from hushh_mcp.services import one_wallet_card_service as module

    db, service = cards_db
    monkeypatch.setattr(module, "get_db", lambda: db)
    card = profile(db)
    service.create_grants("alice", card, str(uuid.uuid4()), refs(db), 15)
    identifier = grants_by_recipient(db)["charu"]
    barrier = Barrier(3)

    def mutate():
        barrier.wait()
        source = module.OneWalletCardService()
        for _ in range(3):
            source.pause_card(user_id="alice")
            source.resume_card(user_id="alice")

    def read():
        barrier.wait()
        for _ in range(3):
            assert service.view_grant("charu", identifier)["status"] in {"active", "unavailable"}

    def ledger():
        barrier.wait()
        for _ in range(3):
            assert len(service.history("alice")["items"]) == 2

    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = [pool.submit(call) for call in (mutate, read, ledger)]
        for future in futures:
            future.result(timeout=20)
    assert service.view_grant("charu", identifier)["status"] == "active"


def test_creation_trust_and_service_role_view_are_enforced(cards_db):
    db, service = cards_db
    card = active_card(db, service)
    service.create_grants("alice", card, str(uuid.uuid4()), refs(db), 10)
    with pytest.raises(DBAPIError, match="IMMUTABLE"):
        with db.engine.begin() as conn:
            conn.execute(
                text(
                    "UPDATE wallet_card_access_grants SET trusted_at_creation=NOT trusted_at_creation"
                )
            )
    with db.engine.begin() as conn:
        conn.execute(
            text(
                "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF; END $$"
            )
        )
    db.apply_migrations(
        [
            "322_wallet_universal_sharing.sql",
            "323_wallet_sharing_owner_index.sql",
            "324_wallet_sharing_recipient_index.sql",
            "325_wallet_sharing_audit_index.sql",
        ]
    )
    with db.engine.begin() as conn:
        conn.execute(text("SET LOCAL ROLE service_role"))
        assert len(conn.execute(text("SELECT id FROM wallet_all_access_grants")).all()) == 2
        assert (
            conn.execute(text("SELECT count(*) FROM wallet_profile_access_grants")).scalar_one()
            == 0
        )


def test_recipient_before_owner_concurrent_terminal_revocations(cards_db, monkeypatch):
    from hushh_mcp.services import one_wallet_card_service as module

    db, service = cards_db
    monkeypatch.setattr(module, "get_db", lambda: db)
    with db.engine.begin() as conn:
        conn.execute(text("INSERT INTO actor_profiles(user_id) VALUES('z_owner'),('a_recipient')"))
        conn.execute(
            text("INSERT INTO connections(user_a_id,user_b_id) VALUES('a_recipient','z_owner')")
        )
        ref = str(
            conn.execute(
                text("SELECT public_person_ref FROM actor_profiles WHERE user_id='a_recipient'")
            ).scalar_one()
        )
    card = profile(db, "z_owner")
    created = service.create_grants("z_owner", card, str(uuid.uuid4()), [ref], 15)
    identifier = created["grants"][0]["id"]

    def concurrent(revoke):
        barrier = Barrier(3)

        def view():
            barrier.wait()
            return service.view_grant("a_recipient", identifier)

        def history():
            barrier.wait()
            return service.history("a_recipient", direction="received")

        def mutate():
            barrier.wait()
            return revoke()

        with ThreadPoolExecutor(max_workers=3) as pool:
            futures = [pool.submit(call) for call in (view, history, mutate)]
            for future in futures:
                future.result(timeout=20)

    concurrent(lambda: service.revoke("z_owner", identifier))
    service.create_grants("z_owner", card, str(uuid.uuid4()), [ref], 15)
    concurrent(lambda: module.OneWalletCardService().revoke_card(user_id="z_owner"))
    assert all(item["status"] == "revoked" for item in service.history("z_owner")["items"])


def test_account_tombstone_erasure_removes_grants_before_sources(cards_db):
    from hushh_mcp.services.account_service import AccountService

    db, service = cards_db
    service.create_grants("alice", active_card(db, service), str(uuid.uuid4()), refs(db), 10)
    service.create_grants("alice", profile(db), str(uuid.uuid4()), refs(db), 10)
    erasure = AccountService()
    with db.engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO account_deletion_tombstones(user_id_hash,firebase_uid) VALUES('sha256:'||encode(digest('alice','sha256'),'hex'),'alice')"
            )
        )
        # These same predicates execute in both reset and full-account erasure.
        for table in (
            "wallet_card_access_audit",
            "wallet_profile_access_grants",
            "wallet_card_access_grants",
            "wallet_profile_share_requests",
            "wallet_card_share_requests",
            "wallet_card_registrations",
            "messages",
            "one_wallet_cards",
        ):
            conn.execute(erasure._delete_by_user_queries[table], {"user_id": "alice"})
        conn.execute(text("DELETE FROM pkm_manifests WHERE user_id='alice'"))
    assert db.execute_raw("SELECT id FROM wallet_all_access_grants", {}).data == []
    assert db.execute_raw("SELECT id FROM wallet_card_access_audit", {}).data == []
