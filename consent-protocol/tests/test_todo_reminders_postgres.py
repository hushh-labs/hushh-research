"""Task reminder transaction, delivery and rollback fences against real PostgreSQL."""

import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import text

from db.migration_authority import _replay_sql, build_manifest_entries
from hushh_mcp.services import system_push_delivery as pushes
from tests.services.test_system_push_delivery import add_devices, sql
from tests.services.test_system_push_delivery import push_db as push_db

ROOT = Path(__file__).resolve().parents[1]
ROLLBACK_SQL = (ROOT / "db/migrations/rollback/428_one_todo_reminders.rollback.sql").read_text()


@pytest.fixture
def todo_reminders(push_db):
    db = push_db
    sql(db, "CREATE TABLE pkm_events(user_id TEXT,domain TEXT,operation_type TEXT,metadata JSONB)")
    sql(db, "CREATE TABLE pkm_manifests(user_id TEXT,domain TEXT)")
    sql(db, "CREATE TABLE task_cipher_fixture(value TEXT)")
    raw = db.engine.raw_connection()
    try:
        with raw.cursor() as cursor:
            entry = build_manifest_entries(ROOT / "db/migrations", ("428_one_todo_reminders.sql",))[
                0
            ]
            cursor.execute(_replay_sql(entry))
        raw.commit()
    finally:
        raw.close()
    due = datetime.now(timezone.utc) + timedelta(days=7)
    items = [{"task_ref": str(uuid.uuid4()), "due_at": due.isoformat()}]
    return db, items, due


def project(db, items, conn=None):
    statement = "INSERT INTO pkm_events VALUES('recipient','one_todos','content_write',CAST(:metadata AS JSONB))"
    params = {"metadata": json.dumps({"todo_reminders_v1": {"items": items}})}
    if conn is not None:
        conn.execute(text(statement), params)
    else:
        sql(db, statement, params)


def test_todo_reminders_commit_cancel_reschedule_and_erase_atomically(todo_reminders):
    db, items, due = todo_reminders
    project(db, items)
    event = sql(db, "SELECT * FROM system_push_outbox WHERE source_kind='todo_reminder'")[0]
    assert event["expires_at"] > due and event["source_revision"] == "1"
    assert sql(db, "SELECT metadata FROM pkm_events")[0]["metadata"] == {}
    project(db, items)
    assert len(sql(db, "SELECT * FROM system_push_outbox WHERE source_kind='todo_reminder'")) == 1
    sql(
        db,
        "UPDATE system_push_outbox SET status='leased',lease_id=gen_random_uuid() WHERE source_kind='todo_reminder'",
    )
    project(db, [{**items[0], "due_at": (due + timedelta(hours=1)).isoformat()}])
    assert (
        sql(db, "SELECT status FROM system_push_outbox WHERE id=:id", {"id": event["id"]})[0][
            "status"
        ]
        == "suppressed"
    )
    project(db, [])
    assert sql(db, "SELECT due_at,generation FROM one_todo_reminder_schedules")[0] == {
        "due_at": None,
        "generation": 3,
    }
    assert not sql(db, "SELECT id FROM system_push_outbox WHERE status IN ('pending','leased')")
    with pytest.raises(RuntimeError):
        with db.engine.begin() as conn:
            conn.execute(text("INSERT INTO task_cipher_fixture VALUES('encrypted task')"))
            project(db, items, conn)
            raise RuntimeError("Fail the enclosing encrypted write")
    assert not sql(db, "SELECT * FROM task_cipher_fixture")
    assert sql(db, "SELECT generation FROM one_todo_reminder_schedules")[0]["generation"] == 3
    project(db, items)
    assert sql(db, "SELECT generation FROM one_todo_reminder_schedules")[0]["generation"] == 4
    sql(db, "INSERT INTO pkm_manifests VALUES('recipient','one_todos')")
    sql(db, "DELETE FROM pkm_manifests WHERE user_id='recipient'")
    assert not sql(db, "SELECT * FROM one_todo_reminder_schedules")
    assert not sql(db, "SELECT * FROM system_push_outbox WHERE source_kind='todo_reminder'")


def test_todo_reminder_account_erasure_cascades_only_the_deleted_owner(todo_reminders):
    db, items, _ = todo_reminders
    project(db, items)
    sql(
        db,
        """INSERT INTO pkm_events VALUES('sender','one_todos','content_write',CAST(:metadata AS JSONB))""",
        {"metadata": json.dumps({"todo_reminders_v1": {"items": items}})},
    )
    sql(db, "DELETE FROM actor_profiles WHERE user_id='recipient'")
    assert not sql(db, "SELECT * FROM one_todo_reminder_schedules WHERE user_id='recipient'")
    assert not sql(db, "SELECT * FROM system_push_outbox WHERE recipient_user_id='recipient'")
    assert len(sql(db, "SELECT * FROM one_todo_reminder_schedules WHERE user_id='sender'")) == 1
    assert len(sql(db, "SELECT * FROM system_push_outbox WHERE recipient_user_id='sender'")) == 1


def test_todo_reminders_deliver_only_when_due_and_refuse_active_rollback(
    todo_reminders, monkeypatch
):
    db, items, due = todo_reminders
    project(db, items)
    current = sql(
        db,
        "SELECT * FROM system_push_outbox WHERE source_kind='todo_reminder' ORDER BY created_at DESC LIMIT 1",
    )[0]
    with db.engine.begin() as conn:
        assert pushes._source(conn, dict(current)) is None  # Never alert early.
    rollback = (ROOT / "db/migrations/rollback/428_one_todo_reminders.rollback.sql").read_text()
    with pytest.raises(Exception, match="active"):
        with db.engine.begin() as conn:
            conn.exec_driver_sql(rollback)
    # A write that commits a moment after the due time still delivers within
    # the grace period, through the real generation and device checks.
    project(
        db,
        [{**items[0], "due_at": (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()}],
    )
    add_devices(db)
    from firebase_admin import messaging

    sent = []
    monkeypatch.setattr(messaging, "send", lambda message: sent.append(message))
    assert pushes.dispatch_system_pushes(db) == 1
    assert len(sent) == 2
    assert all(
        message.data["type"] == "todo_reminder" and message.data["request_url"] == "/one/todos"
        for message in sent
    )
    assert db.sse[-1][1]["title"] == "Task reminder"


def test_todo_reminder_replay_preserves_live_schedules_leases_and_device_receipts(todo_reminders):
    db, items, due = todo_reminders
    project(db, items)
    add_devices(db)
    sql(db, "UPDATE system_push_outbox SET status='leased',lease_id=gen_random_uuid()")
    sql(
        db,
        """INSERT INTO system_push_device_deliveries(event_id,device_id)
        SELECT o.id,d.device_id FROM system_push_outbox o CROSS JOIN user_push_installations d LIMIT 1""",
    )
    schedules = sql(db, "SELECT * FROM one_todo_reminder_schedules")
    outbox = sql(db, "SELECT * FROM system_push_outbox")
    receipts = sql(db, "SELECT * FROM system_push_device_deliveries")
    trigger_query = "SELECT oid,tgname FROM pg_trigger WHERE tgname IN ('one_todo_reminders_committed','one_todo_reminders_erased') ORDER BY tgname"
    triggers = sql(db, trigger_query)
    entries = build_manifest_entries(
        ROOT / "db/migrations",
        (
            "361_system_push_outbox.sql",
            "428_one_todo_reminders.sql",
        ),
    )
    raw = db.engine.raw_connection()
    try:
        with raw.cursor() as cursor:
            for _ in range(2):
                for entry in entries:
                    cursor.execute(_replay_sql(entry))
        raw.commit()
    finally:
        raw.close()
    assert sql(db, "SELECT * FROM one_todo_reminder_schedules") == schedules
    assert sql(db, "SELECT * FROM system_push_outbox") == outbox
    assert sql(db, "SELECT * FROM system_push_device_deliveries") == receipts
    assert sql(db, trigger_query) == triggers
    project(db, [{**items[0], "due_at": (due + timedelta(hours=1)).isoformat()}])
    assert sql(db, "SELECT generation FROM one_todo_reminder_schedules")[0]["generation"] == 2
    assert (
        sql(db, "SELECT status FROM system_push_outbox WHERE id=:id", {"id": outbox[0]["id"]})[0][
            "status"
        ]
        == "suppressed"
    )
    sql(db, "ALTER TABLE pkm_events DISABLE TRIGGER one_todo_reminders_committed")
    raw = db.engine.raw_connection()
    try:
        with raw.cursor() as cursor:
            with pytest.raises(Exception, match="Task reminder trigger has unexpected definition"):
                cursor.execute(_replay_sql(entries[-1]))
    finally:
        raw.rollback()
        raw.close()


def test_todo_reminder_rollback_fences_concurrent_writes(todo_reminders):
    db, items, due = todo_reminders
    rollback = ROLLBACK_SQL
    # The rollback guard must run AFTER fencing in-flight encrypted task writes.
    # The broken order sees an empty snapshot, waits on DROP TRIGGER, then erases
    # the schedule that commits during that wait.
    import time
    from concurrent.futures import ThreadPoolExecutor
    from queue import Queue

    worker_pid = Queue()

    def rollback_concurrently():
        with db.engine.begin() as conn:
            worker_pid.put(conn.exec_driver_sql("SELECT pg_backend_pid()").scalar())
            conn.exec_driver_sql(rollback)

    with ThreadPoolExecutor(max_workers=1) as pool, db.engine.connect() as writer:
        transaction = writer.begin()
        try:
            project(db, items, writer)
            attempt = pool.submit(rollback_concurrently)
            pid = worker_pid.get(timeout=5)
            deadline = time.monotonic() + 5
            while not sql(
                db, "SELECT pid FROM pg_locks WHERE pid=:pid AND NOT granted", {"pid": pid}
            ):
                assert time.monotonic() < deadline, "Rollback never reached its write fence"
                time.sleep(0.02)
            transaction.commit()
            with pytest.raises(Exception, match="active task reminders"):
                attempt.result(timeout=5)
        finally:
            if transaction.is_active:
                transaction.rollback()
    assert sql(db, "SELECT due_at FROM one_todo_reminder_schedules")[0]["due_at"] == due
    project(db, [])
    with db.engine.begin() as conn:
        conn.exec_driver_sql(rollback)


def test_todo_reminder_projection_accepts_only_opaque_schedule_metadata():
    from pydantic import ValidationError

    from hushh_mcp.services.todo_reminders import reminder_projection

    value = {
        "projection_type": "todo_reminders_v1",
        "projection_version": 1,
        "payload": {
            "items": [{"task_ref": str(uuid.uuid4()), "due_at": "2030-10-26T09:00:00+05:30"}]
        },
    }
    assert reminder_projection("one_todos", [value])["items"][0]["due_at"] == "2030-10-26T03:30:00Z"
    with pytest.raises(ValueError):
        reminder_projection("financial", [value])
    with pytest.raises(ValidationError):
        reminder_projection(
            "one_todos",
            [
                {
                    **value,
                    "payload": {"items": [{**value["payload"]["items"][0], "title": "Private"}]},
                }
            ],
        )
    with pytest.raises(ValidationError):
        reminder_projection(
            "one_todos", [{**value, "payload": {"items": value["payload"]["items"] * 2}}]
        )
