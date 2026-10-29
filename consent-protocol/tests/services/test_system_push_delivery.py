"""Real PostgreSQL regressions for source-atomic, per-installation alerts."""

import os
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest
from psycopg2.errors import RaiseException
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError

from db.migration_authority import _replay_sql, build_manifest_entries
from hushh_mcp.services import system_push_delivery as pushes

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def push_db(monkeypatch):
    source = os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not source:
        pytest.skip("An isolated PostgreSQL server is required.")
    url = make_url(source).set(drivername="postgresql+psycopg2")
    admin = create_engine(url, isolation_level="AUTOCOMMIT")
    name = "system_push_test_" + uuid.uuid4().hex
    with admin.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{name}"'))
    engine = create_engine(url.set(database=name))
    try:
        with engine.begin() as conn:
            conn.execute(
                text("""
                CREATE EXTENSION pgcrypto;
                CREATE TABLE actor_profiles(user_id TEXT PRIMARY KEY);
                CREATE TABLE vault_keys(user_id TEXT PRIMARY KEY);
                INSERT INTO actor_profiles VALUES('sender'),('recipient'),('next-owner');
                CREATE TABLE actor_identity_cache(user_id TEXT,display_name TEXT,email TEXT);
                INSERT INTO actor_identity_cache VALUES('sender','Alex',NULL);
                CREATE TABLE one_location_recipient_keys(user_id TEXT,key_id TEXT,status TEXT);
                INSERT INTO one_location_recipient_keys VALUES('recipient','location-key','active');
                CREATE TABLE one_location_share_grants(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                  owner_user_id TEXT DEFAULT 'sender',recipient_user_id TEXT DEFAULT 'recipient',
                  status TEXT DEFAULT 'active',expires_at TIMESTAMPTZ DEFAULT now()+interval '1 hour',
                  duration_hours NUMERIC DEFAULT 1,duration_mode TEXT DEFAULT 'timed',
                  latest_envelope_id UUID DEFAULT gen_random_uuid(),recipient_key_id TEXT DEFAULT 'location-key',
                  created_at TIMESTAMPTZ DEFAULT now(),metadata JSONB DEFAULT '{}');
                CREATE TABLE one_location_access_requests(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                  owner_user_id TEXT DEFAULT 'recipient',requester_user_id TEXT DEFAULT 'sender',
                  status TEXT DEFAULT 'pending',request_revision INTEGER DEFAULT 1,
                  requested_at TIMESTAMPTZ DEFAULT now(),expires_at TIMESTAMPTZ,
                  requested_duration_hours NUMERIC,requested_duration_mode TEXT,extends_grant_id UUID,
                  metadata JSONB DEFAULT '{}');
                CREATE TABLE connection_requests(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                  requester_user_id TEXT DEFAULT 'sender',addressee_user_id TEXT DEFAULT 'recipient',
                  status TEXT DEFAULT 'pending');
                CREATE TABLE one_location_circles(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                  owner_user_id TEXT DEFAULT 'sender',name TEXT DEFAULT 'Family',
                  status TEXT DEFAULT 'active',system_kind TEXT);
                CREATE TABLE one_location_circle_memberships(circle_id UUID,user_id TEXT DEFAULT 'recipient',
                  role TEXT DEFAULT 'member',status TEXT DEFAULT 'active',joined_at TIMESTAMPTZ DEFAULT now(),
                  PRIMARY KEY(circle_id,user_id));
                CREATE TABLE user_push_installations(id BIGSERIAL PRIMARY KEY,user_id TEXT,token TEXT,
                  platform TEXT,device_id UUID DEFAULT gen_random_uuid(),preview_key_id UUID,preview_public_key TEXT,
                  created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now());
                CREATE TABLE user_push_tokens(LIKE user_push_installations INCLUDING ALL);
            """)
            )
        raw = engine.raw_connection()
        with raw.cursor() as cursor:
            cursor.execute((ROOT / "db/migrations/201_account_deletion_tombstones.sql").read_text())
            # Prove 361 installs guards explicitly without the DDL safety net.
            cursor.execute(
                "ALTER EVENT TRIGGER trg_refresh_account_deletion_guards_after_identity_ddl DISABLE"
            )
            raw.commit()
            entry = build_manifest_entries(ROOT / "db/migrations", ("361_system_push_outbox.sql",))[
                0
            ]
            cursor.execute(_replay_sql(entry))
            cursor.execute((ROOT / "db/migrations/441_sms_alarm_capability.sql").read_text())
            raw.commit()
        raw.close()

        def execute_raw(sql, params):
            with engine.begin() as conn:
                return SimpleNamespace(
                    data=[dict(row) for row in conn.execute(text(sql), params).mappings()],
                    error=None,
                )

        db = SimpleNamespace(engine=engine, execute_raw=execute_raw)
        monkeypatch.setattr(pushes, "get_db", lambda: db)
        from firebase_admin import messaging

        from api import consent_listener
        from api.utils import firebase_admin
        from hushh_mcp.services.one_location_agent_service import OneLocationAgentService

        monkeypatch.setattr(firebase_admin, "ensure_firebase_admin", lambda: (True, None))
        monkeypatch.setattr(
            OneLocationAgentService,
            "_identity_row",
            lambda self, user: {"user_id": user, "display_name": "Alex"},
        )
        db.sse = []
        db.sent = []
        monkeypatch.setattr(
            consent_listener,
            "publish_user_state_event_threadsafe",
            lambda user, data: db.sse.append((user, data)),
        )
        monkeypatch.setattr(messaging, "send", lambda message: db.sent.append(message))
        yield db
    finally:
        engine.dispose()
        with admin.connect() as conn:
            conn.execute(text(f'DROP DATABASE "{name}" WITH (FORCE)'))
        admin.dispose()


def sql(db, statement, params=None):
    with db.engine.begin() as conn:
        result = conn.execute(text(statement), params or {})
        return [dict(row) for row in result.mappings()] if result.returns_rows else []


def add_devices(db):
    sql(
        db,
        """INSERT INTO user_push_installations(user_id,token,platform)
        VALUES('recipient','iphone','ios'),('recipient','android','android')""",
    )


def retry_now(db):
    sql(db, "UPDATE system_push_outbox SET due_at=now() WHERE status IN ('pending','leased')")


def replay_migration(db):
    entry = build_manifest_entries(ROOT / "db/migrations", ("361_system_push_outbox.sql",))[0]
    raw = db.engine.raw_connection()
    try:
        with raw.cursor() as cursor:
            cursor.execute(_replay_sql(entry))
        raw.commit()
    finally:
        raw.close()


def test_migration_replay_preserves_intents_and_accepted_devices(push_db):
    db = push_db
    add_devices(db)
    grant = sql(db, "INSERT INTO one_location_share_grants DEFAULT VALUES RETURNING id")[0]["id"]
    pushes.dispatch_system_pushes(db)
    sql(db, "INSERT INTO connection_requests DEFAULT VALUES")
    request = sql(db, "INSERT INTO one_location_access_requests DEFAULT VALUES RETURNING id")[0][
        "id"
    ]
    sql(
        db,
        """UPDATE system_push_outbox SET status='leased',attempts=3,lease_id=:lease
        WHERE source_id=:source""",
        {"lease": uuid.uuid4(), "source": request},
    )
    intents = sql(db, "SELECT * FROM system_push_outbox ORDER BY id")
    accepted = sql(db, "SELECT * FROM system_push_device_deliveries ORDER BY event_id,device_id")
    assert {row["status"] for row in intents} == {"pending", "leased", "sent"}
    assert len(accepted) == 2
    triggers = sql(
        db,
        """SELECT oid,tgname FROM pg_trigger WHERE tgname LIKE 'system_push_%' ORDER BY tgname""",
    )
    for _ in range(2):
        replay_migration(db)
        assert sql(db, "SELECT * FROM system_push_outbox ORDER BY id") == intents
        assert (
            sql(db, "SELECT * FROM system_push_device_deliveries ORDER BY event_id,device_id")
            == accepted
        )
        assert (
            sql(
                db,
                "SELECT oid,tgname FROM pg_trigger WHERE tgname LIKE 'system_push_%' ORDER BY tgname",
            )
            == triggers
        )
    # A later point on an existing grant must not ring again after deployment.
    sql(
        db,
        "UPDATE one_location_share_grants SET latest_envelope_id=gen_random_uuid() WHERE id=:id",
        {"id": grant},
    )
    assert sql(db, "SELECT * FROM system_push_outbox ORDER BY id") == intents
    sql(db, "INSERT INTO connection_requests DEFAULT VALUES")
    assert len(sql(db, "SELECT * FROM system_push_outbox")) == 4
    assert len(db.sent) == 2


def test_migration_replay_creates_missing_trigger_and_rejects_drift(push_db):
    db = push_db
    sql(db, "DROP TRIGGER system_push_connection_request ON connection_requests")
    replay_migration(db)
    sql(db, "INSERT INTO connection_requests DEFAULT VALUES")
    assert len(sql(db, "SELECT * FROM system_push_outbox")) == 1
    sql(db, "ALTER TABLE connection_requests DISABLE TRIGGER system_push_connection_request")
    with pytest.raises(RaiseException, match="System push trigger has unexpected definition"):
        replay_migration(db)
    assert len(sql(db, "SELECT * FROM system_push_outbox")) == 1
    assert sql(
        db,
        "SELECT tgenabled FROM pg_trigger WHERE tgname='system_push_connection_request'",
    ) == [{"tgenabled": "D"}]


@pytest.mark.parametrize("replay", [False, True])
def test_new_outbox_rejects_deleted_recipient_even_with_retained_actor_root(push_db, replay):
    db = push_db
    if replay:
        replay_migration(db)
    sql(
        db,
        """INSERT INTO account_deletion_tombstones(user_id_hash)
        VALUES ('sha256:' || encode(digest('recipient','sha256'),'hex'))""",
    )
    insert = """INSERT INTO system_push_outbox(source_kind,source_id,recipient_user_id)
        VALUES ('share',:source,:user)"""
    with pytest.raises(IntegrityError) as rejected:
        sql(db, insert, {"source": uuid.uuid4(), "user": "recipient"})
    assert rejected.value.orig.pgcode == "23514"
    assert rejected.value.orig.diag.constraint_name == "account_deletion_tombstone_guard"
    sql(db, insert, {"source": uuid.uuid4(), "user": "sender"})
    assert sql(db, "SELECT recipient_user_id FROM system_push_outbox") == [
        {"recipient_user_id": "sender"}
    ]


def test_transition_and_alert_commit_or_rollback_together_and_no_history_replay(push_db):
    db = push_db
    with pytest.raises(RuntimeError), db.engine.begin() as conn:
        conn.execute(text("INSERT INTO one_location_share_grants DEFAULT VALUES"))
        assert conn.execute(text("SELECT count(*) FROM system_push_outbox")).scalar() == 1
        raise RuntimeError("request rolled back")
    assert sql(db, "SELECT * FROM system_push_outbox") == []
    grant = sql(db, "INSERT INTO one_location_share_grants DEFAULT VALUES RETURNING id")[0]["id"]
    # Replaying the operation or publishing another point does not create an alert.
    sql(db, "UPDATE one_location_share_grants SET metadata='{}' WHERE id=:id", {"id": grant})
    assert len(sql(db, "SELECT * FROM system_push_outbox")) == 1
    assert (
        pushes.durable_push_receipt("recipient", "location_share_created", {"grant_id": str(grant)})
        == 0
    )


def test_partial_provider_failure_retries_only_unaccepted_installations(push_db, monkeypatch):
    db = push_db
    add_devices(db)
    sql(db, 'INSERT INTO one_location_share_grants(metadata) VALUES(\'{"share_kind":"sos"}\')')
    from firebase_admin import messaging

    attempts = []

    def send(message):
        attempts.append(message.token)
        if message.token == "android" and attempts.count("android") == 1:
            raise TimeoutError("provider temporarily unavailable")

    monkeypatch.setattr(messaging, "send", send)
    assert pushes.dispatch_system_pushes(db) == 1
    assert sql(db, "SELECT status FROM system_push_outbox")[0]["status"] == "pending"
    retry_now(db)
    assert pushes.dispatch_system_pushes(db) == 1
    assert attempts.count("iphone") == 1
    assert attempts.count("android") == 2
    assert sql(db, "SELECT status FROM system_push_outbox")[0]["status"] == "sent"
    assert len(sql(db, "SELECT * FROM system_push_device_deliveries")) == 2
    assert db.sse[0][1]["message_id"] == db.sse[1][1]["message_id"]
    assert db.sse[0][1]["notification_profile"] == "one_location_sms_emergency"


@pytest.mark.parametrize(
    "metadata", [{}, {"share_kind": "sos"}, {"share_kind": " ", "reason": "sos_panic"}]
)
def test_predeployment_share_point_does_not_replay_an_old_alert(push_db, metadata):
    import json

    db = push_db
    grant = sql(
        db,
        "INSERT INTO one_location_share_grants(metadata) VALUES(CAST(:metadata AS JSONB)) RETURNING id",
        {"metadata": json.dumps(metadata)},
    )[0]["id"]
    # A predeployment source has no intent or acceptance history to deduplicate.
    sql(db, "DELETE FROM system_push_outbox")
    sql(
        db,
        "UPDATE one_location_share_grants SET latest_envelope_id=gen_random_uuid() WHERE id=:id",
        {"id": grant},
    )
    assert sql(db, "SELECT * FROM system_push_outbox") == []


def test_public_request_suppression_is_atomic_and_next_direct_ask_can_alert(push_db):
    db = push_db
    request = sql(
        db,
        """INSERT INTO one_location_access_requests(metadata)
        VALUES('{"notify_owner": false}') RETURNING id""",
    )[0]["id"]
    assert sql(db, "SELECT * FROM system_push_outbox") == []
    sql(
        db,
        """UPDATE one_location_access_requests SET request_revision=2,
        metadata='{"notify_owner": true}' WHERE id=:id""",
        {"id": request},
    )
    assert len(sql(db, "SELECT * FROM system_push_outbox")) == 1
    # A source suppression set before a leased attempt must also fence retries.
    sql(
        db,
        "UPDATE one_location_access_requests SET metadata='{\"notify_owner\": false}' WHERE id=:id",
        {"id": request},
    )
    add_devices(db)
    pushes.dispatch_system_pushes(db)
    assert db.sent == []
    assert sql(db, "SELECT status FROM system_push_outbox")[0]["status"] == "suppressed"


def test_sms_waits_for_encryption_and_an_active_recipient_key(push_db):
    db = push_db
    add_devices(db)
    grant = sql(
        db,
        """INSERT INTO one_location_share_grants(metadata,latest_envelope_id)
        VALUES('{"share_kind":"sos"}',NULL) RETURNING id""",
    )[0]["id"]
    assert sql(db, "SELECT * FROM system_push_outbox") == []
    assert pushes.dispatch_system_pushes(db) == 0
    sql(
        db,
        "UPDATE one_location_share_grants SET latest_envelope_id=gen_random_uuid() WHERE id=:id",
        {"id": grant},
    )
    assert len(sql(db, "SELECT * FROM system_push_outbox")) == 1
    sql(
        db,
        "UPDATE one_location_share_grants SET latest_envelope_id=gen_random_uuid() WHERE id=:id",
        {"id": grant},
    )
    assert len(sql(db, "SELECT * FROM system_push_outbox")) == 1
    sql(db, "UPDATE one_location_recipient_keys SET status='revoked'")
    pushes.dispatch_system_pushes(db)
    assert db.sent == []
    assert sql(db, "SELECT status FROM system_push_outbox")[0]["status"] == "suppressed"


@pytest.mark.parametrize("stop", ["status='revoked'", "expires_at=now()-interval '1 second'"])
def test_revoked_or_expired_sms_never_alerts_on_retry(push_db, monkeypatch, stop):
    db = push_db
    add_devices(db)
    grant = sql(
        db,
        'INSERT INTO one_location_share_grants(metadata) VALUES(\'{"share_kind":"sos"}\') RETURNING id',
    )[0]["id"]
    from api.utils import firebase_admin

    monkeypatch.setattr(firebase_admin, "ensure_firebase_admin", lambda: (False, None))
    pushes.dispatch_system_pushes(db)
    sql(db, f"UPDATE one_location_share_grants SET {stop} WHERE id=:id", {"id": grant})
    monkeypatch.setattr(firebase_admin, "ensure_firebase_admin", lambda: (True, None))
    retry_now(db)
    pushes.dispatch_system_pushes(db)
    assert db.sent == []
    assert sql(db, "SELECT status FROM system_push_outbox")[0]["status"] == "suppressed"


def test_registration_recovery_keeps_live_sms_independent_of_firebase(push_db):
    db = push_db
    sql(db, 'INSERT INTO one_location_share_grants(metadata) VALUES(\'{"share_kind":"sos"}\')')
    pushes.dispatch_system_pushes(db)
    assert db.sse[0][0] == "recipient"
    assert db.sse[0][1]["share_kind"] == "sos"
    assert db.sent == []
    assert sql(db, "SELECT status FROM system_push_outbox")[0]["status"] == "pending"
    add_devices(db)
    retry_now(db)
    pushes.dispatch_system_pushes(db)
    assert {message.token for message in db.sent} == {"iphone", "android"}


def test_account_transfer_is_rechecked_before_provider_send(push_db, monkeypatch):
    db = push_db
    add_devices(db)
    sql(db, "INSERT INTO connection_requests DEFAULT VALUES")
    from api.utils import firebase_admin

    def change_owner_before_send():
        sql(
            db,
            """WITH moved AS (DELETE FROM user_push_installations WHERE token='iphone'
              RETURNING token,platform,device_id)
            INSERT INTO user_push_installations(user_id,token,platform,device_id)
            SELECT 'next-owner',token,platform,device_id FROM moved""",
        )
        return True, None

    monkeypatch.setattr(firebase_admin, "ensure_firebase_admin", change_owner_before_send)
    pushes.dispatch_system_pushes(db)
    assert [message.token for message in db.sent] == ["android"]


def test_last_device_transfer_does_not_claim_a_successful_alert(push_db, monkeypatch):
    db = push_db
    sql(
        db,
        "INSERT INTO user_push_installations(user_id,token,platform) VALUES('recipient','iphone','ios')",
    )
    sql(db, "INSERT INTO connection_requests DEFAULT VALUES")
    from api.utils import firebase_admin

    def change_owner_before_send():
        sql(
            db,
            """WITH moved AS (DELETE FROM user_push_installations RETURNING token,platform,device_id)
            INSERT INTO user_push_installations(user_id,token,platform,device_id)
            SELECT 'next-owner',token,platform,device_id FROM moved""",
        )
        return True, None

    monkeypatch.setattr(firebase_admin, "ensure_firebase_admin", change_owner_before_send)
    pushes.dispatch_system_pushes(db)
    assert db.sent == []
    assert sql(db, "SELECT status FROM system_push_outbox")[0]["status"] == "pending"


def test_expired_worker_lease_recovers_without_replaying_an_accepted_device(push_db):
    db = push_db
    add_devices(db)
    sql(db, "INSERT INTO connection_requests DEFAULT VALUES")
    old_lease = uuid.uuid4()
    event = sql(
        db,
        """UPDATE system_push_outbox SET status='leased',attempts=1,
        lease_id=:lease,due_at=now()-interval '1 second' RETURNING id""",
        {"lease": old_lease},
    )[0]["id"]
    sql(
        db,
        """INSERT INTO system_push_device_deliveries(event_id,device_id)
        SELECT :event,device_id FROM user_push_installations WHERE token='iphone'""",
        {"event": event},
    )
    assert pushes.dispatch_system_pushes(db) == 1
    assert [message.token for message in db.sent] == ["android"]
    current = sql(db, "SELECT * FROM system_push_outbox")[0]
    assert current["status"] == "sent"
    assert current["attempts"] == 2
    assert current["lease_id"] != old_lease
    # A late completion from the dead worker cannot overwrite the new lease.
    sql(
        db,
        "UPDATE system_push_outbox SET status='pending' WHERE id=:id AND lease_id=:lease",
        {"id": event, "lease": old_lease},
    )
    assert sql(db, "SELECT status FROM system_push_outbox")[0]["status"] == "sent"


def test_approval_does_not_duplicate_its_own_location_alert(push_db):
    db = push_db
    sql(
        db,
        'INSERT INTO one_location_share_grants(metadata) VALUES(\'{"reason":"request_approved"}\')',
    )
    assert sql(db, "SELECT * FROM system_push_outbox") == []


def test_request_revision_and_membership_epoch_bound_recovery(push_db):
    db = push_db
    request = sql(db, "INSERT INTO one_location_access_requests DEFAULT VALUES RETURNING id")[0][
        "id"
    ]
    sql(
        db,
        "UPDATE one_location_access_requests SET request_revision=2 WHERE id=:id",
        {"id": request},
    )
    circle = sql(db, "INSERT INTO one_location_circles DEFAULT VALUES RETURNING id")[0]["id"]
    sql(db, "INSERT INTO one_location_circle_memberships(circle_id) VALUES(:id)", {"id": circle})
    sql(
        db,
        "UPDATE one_location_circle_memberships SET status='removed' WHERE circle_id=:id",
        {"id": circle},
    )
    sql(
        db,
        "UPDATE one_location_circle_memberships SET status='active',joined_at=now() WHERE circle_id=:id",
        {"id": circle},
    )
    add_devices(db)
    pushes.dispatch_system_pushes(db)
    statuses = [
        row["status"]
        for row in sql(db, "SELECT status FROM system_push_outbox ORDER BY created_at,id")
    ]
    assert statuses.count("suppressed") == 2
    assert statuses.count("sent") == 2
    assert len(db.sent) == 4


def test_location_request_alert_preserves_the_requested_duration(push_db):
    db = push_db
    add_devices(db)
    sql(
        db,
        """INSERT INTO one_location_access_requests(requested_duration_hours,requested_duration_mode)
        VALUES(2,'timed')""",
    )
    pushes.dispatch_system_pushes(db)
    assert len(db.sent) == 2
    assert db.sent[0].notification.title == "Location access request"
    assert db.sent[0].notification.body == "Alex is asking to view your location for 2 hours."
    assert db.sent[0].data["requested_duration_hours"] == "2.0"


def test_migration_rollback_removes_only_delivery_infrastructure(push_db):
    db = push_db
    sql(db, "INSERT INTO connection_requests DEFAULT VALUES")
    raw = db.engine.raw_connection()
    with raw.cursor() as cursor:
        cursor.execute(
            (ROOT / "db/migrations/rollback/361_system_push_outbox.rollback.sql").read_text()
        )
    raw.close()
    assert sql(db, "SELECT count(*) AS n FROM connection_requests")[0]["n"] == 1
    sql(db, "INSERT INTO connection_requests DEFAULT VALUES")
