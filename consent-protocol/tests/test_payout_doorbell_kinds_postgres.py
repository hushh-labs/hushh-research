"""Migration 318: the owner-earning trigger names its kinds and request (real PostgreSQL)."""

# ruff: noqa: F811 -- isolated PostgreSQL fixture import
import json
import time
from pathlib import Path
from uuid import uuid4

from sqlalchemy import create_engine, text

from hushh_mcp.services.payout_doorbell import notify_payout_changed, payout_doorbell_payload
from tests.services.test_external_connector_lifecycle_postgres import (
    connector_postgres_url,  # noqa: F401
)

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "db/migrations"
NAME = "318_payout_doorbell_kinds.sql"


def test_doorbell_kinds_migration_and_rollback_are_in_release_lanes():
    manifest = json.loads((ROOT / "db/release_migration_manifest.json").read_text())
    assert NAME in manifest["ordered_migrations"]
    assert (MIGRATIONS / manifest["rollback_migrations"][NAME]).is_file()
    for lane in ("dev_minimum_schema", "uat_integrated_schema", "prod_core_schema"):
        contract = json.loads((ROOT / f"db/contracts/{lane}.json").read_text())
        assert "notify_document_owner_earning_changed" in contract["required_functions"]


def _apply(engine, path: Path) -> None:
    with engine.begin() as connection:
        connection.exec_driver_sql(path.read_text(), execution_options={"no_parameters": True})


def _notifications(listener, quiet_seconds: float = 0.3) -> list[str]:
    """Everything delivered to the LISTEN connection within a short quiet window."""
    payloads: list[str] = []
    deadline = time.monotonic() + quiet_seconds
    while time.monotonic() < deadline:
        listener.poll()
        while listener.notifies:
            payloads.append(listener.notifies.pop(0).payload)
        time.sleep(0.02)
    return payloads


def _set_status(engine, request_id: str, status: str, *, service_doorbell: bool = False) -> None:
    with engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_request_owner_payouts SET status=:status WHERE request_id=:id"),
            {"status": status, "id": request_id},
        )
        if service_doorbell:
            notify_payout_changed(connection, "owner-1", ["wallet", "earnings"], request_id)


def test_trigger_doorbell_is_typed_deterministic_and_rolls_back(connector_postgres_url):
    engine = create_engine(connector_postgres_url)
    with engine.begin() as connection:
        connection.exec_driver_sql("CREATE TABLE pkm_owner_payout_accounts(user_id TEXT)")
        connection.exec_driver_sql(
            "CREATE TABLE drive_share_requests(request_id UUID PRIMARY KEY, user_id TEXT)"
        )
        connection.exec_driver_sql(
            "CREATE TABLE drive_request_owner_payouts("
            "request_id UUID PRIMARY KEY, status TEXT NOT NULL)"
        )
    _apply(engine, MIGRATIONS / "297_document_commerce_readiness.sql")
    for _ in range(2):  # UAT replays every migration on every deploy.
        _apply(engine, MIGRATIONS / NAME)

    request_id = str(uuid4())
    with engine.begin() as connection:
        connection.execute(
            text("INSERT INTO drive_share_requests VALUES (:id, 'owner-1')"), {"id": request_id}
        )
        connection.execute(
            text("INSERT INTO drive_request_owner_payouts VALUES (:id, 'awaiting_delivery')"),
            {"id": request_id},
        )

    raw = engine.raw_connection()
    listener = raw.driver_connection
    listener.autocommit = True
    try:
        with listener.cursor() as cursor:
            cursor.execute("LISTEN one_user_state_changed")
        typed = payout_doorbell_payload("owner-1", ["earnings", "wallet"], request_id)

        _set_status(engine, request_id, "hashcoins_credited")
        assert _notifications(listener) == [typed]

        # An unchanged status rings nothing.
        _set_status(engine, request_id, "hashcoins_credited")
        assert _notifications(listener) == []

        # Byte-identical to the service helper, so one transaction rings once.
        _set_status(engine, request_id, "hashcoins_held", service_doorbell=True)
        assert _notifications(listener) == [typed]

        _apply(engine, MIGRATIONS / "rollback/318_payout_doorbell_kinds.rollback.sql")
        _set_status(engine, request_id, "hashcoins_credited")
        (untyped,) = _notifications(listener)
        assert json.loads(untyped) == {"type": "bank_payout_changed", "user_id": "owner-1"}

        _apply(engine, MIGRATIONS / NAME)
        _set_status(engine, request_id, "hashcoins_held")
        assert _notifications(listener) == [typed]
    finally:
        raw.close()
        engine.dispose()
