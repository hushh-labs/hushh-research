"""Migration 259 and exactly-once consent delivery on real PostgreSQL.

Proves what an in-memory fake cannot:

* eight workers handling the same consent_audit NOTIFY send one push and write
  one delivery record (UAT 2026-09-28 measured eight of each), and the same
  handlers without the claim send eight (negative control);
* the NOTIFY payload carries the row id the claim is keyed on;
* a person-to-person request writes ONE owner Feed row per bundle, naming who
  asked, why, and every field in words, while other actions keep their rows;
* the bundle progress query runs as written;
* the migration replays and its rollback refuses while claims are recent.

Runs when ONE_COMMAND_TEST_DATABASE_URL points at an isolated PostgreSQL
database. Tables this test needs but finds missing are created as minimal
stand-ins and dropped afterwards.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import pytest

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = (ROOT / "db/migrations/260_consent_outcome_delivery.sql").read_text()
ROLLBACK = (ROOT / "db/migrations/rollback/260_consent_outcome_delivery.rollback.sql").read_text()
OWNER = "delivery-owner"
BUNDLE = "0f0e0d0c-0b0a-4908-8706-050403020100"
WORKERS = 8

_STAND_INS = {
    "consent_audit": (
        "CREATE TABLE consent_audit (id BIGSERIAL PRIMARY KEY, token_id TEXT, user_id TEXT,"
        " agent_id TEXT, scope TEXT, action TEXT, request_id TEXT, scope_description TEXT,"
        " issued_at BIGINT, expires_at BIGINT, poll_timeout_at BIGINT, metadata JSONB)"
    ),
    "feed_events": (
        "CREATE TABLE feed_events (id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL,"
        " source_domain TEXT NOT NULL, event_type TEXT NOT NULL, actor_label TEXT,"
        " metadata JSONB NOT NULL DEFAULT '{}'::jsonb, source_row_id TEXT,"
        " read_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now())"
    ),
}
# What migrations 011 and 117 attach; recreated only on a stand-in table.
_TRIGGERS = (
    "CREATE TRIGGER consent_audit_notify_trigger AFTER INSERT ON consent_audit"
    " FOR EACH ROW EXECUTE FUNCTION consent_audit_notify()",
    "CREATE TRIGGER consent_audit_feed_fanout AFTER INSERT ON consent_audit"
    " FOR EACH ROW EXECUTE FUNCTION feed_events_from_consent_audit()",
)


def _postgres_url() -> str:
    url = os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not url:
        pytest.skip("An isolated PostgreSQL database is required.")
    return url.replace("postgresql+psycopg2://", "postgresql://", 1)


async def _insert(pool: Any, action: str, request_id: str, metadata: dict | None, **extra) -> int:
    return await pool.fetchval(
        """INSERT INTO consent_audit (token_id, user_id, agent_id, scope, action, request_id,
                                      scope_description, issued_at, metadata)
           VALUES ('evt', $1, 'one_person:requester', $2, $3, $4, $5,
                   (extract(epoch from clock_timestamp()) * 1000)::BIGINT, $6::jsonb)
           RETURNING id""",
        OWNER,
        extra.get("scope", "attr.food.preferences.*"),
        action,
        request_id,
        extra.get("scope_description", "Preferences"),
        json.dumps(metadata) if metadata is not None else None,
    )


def _request_metadata(label: str) -> dict:
    return {
        "bundle_id": BUNDLE,
        "requester_label": "Kushal",
        "reason": "dinner planning",
        "human_label": label,
        "connector_public_key": "must-not-reach-the-feed",
    }


def test_consent_outcome_delivery_on_postgres(monkeypatch) -> None:
    import asyncpg

    from api import consent_listener

    url = _postgres_url()

    async def scenario() -> None:
        pool = await asyncpg.create_pool(url, min_size=2, max_size=WORKERS + 2)

        async def _pool() -> Any:
            return pool

        monkeypatch.setattr("db.connection.get_pool", _pool)
        created: list[str] = []
        listener = await pool.acquire()
        try:
            await pool.execute("DROP TABLE IF EXISTS consent_event_deliveries")
            for table, ddl in _STAND_INS.items():
                if await pool.fetchval("SELECT to_regclass($1)", f"public.{table}") is None:
                    await pool.execute(ddl)
                    created.append(table)
            await pool.execute(MIGRATION)
            await pool.execute(MIGRATION)  # every deploy replays it
            if "consent_audit" in created:
                for trigger in _TRIGGERS:
                    await pool.execute(trigger)

            # --- The NOTIFY payload names the row it came from. -------------
            notified: list[dict] = []
            await listener.add_listener(
                "consent_audit_new", lambda *args: notified.append(json.loads(args[-1]))
            )
            first_id = await _insert(
                pool, "REQUESTED", "one_person_r1", _request_metadata("Food preferences")
            )
            second_id = await _insert(
                pool,
                "REQUESTED",
                "one_person_r2",
                _request_metadata("Allergies"),
                scope="attr.health.allergies.*",
            )
            await _insert(pool, "REQUESTED", "dev_r3", None, scope="attr.food.cuisine")
            await _insert(pool, "CONSENT_GRANTED", "one_person_r1", {"bundle_id": BUNDLE})
            for _ in range(50):
                if len(notified) >= 4:
                    break
                await asyncio.sleep(0.05)
            assert [event["audit_id"] for event in notified[:2]] == [first_id, second_id]

            # --- One Feed row per bundle, who / what / why in words. --------
            rows = await pool.fetch(
                "SELECT event_type, actor_label, metadata FROM feed_events"
                " WHERE user_id = $1 ORDER BY id",
                OWNER,
            )
            bundle_rows = [
                json.loads(row["metadata"])
                for row in rows
                if json.loads(row["metadata"]).get("bundle_id") == BUNDLE
                and row["event_type"] == "consent_requested"
            ]
            assert len(bundle_rows) == 1
            item = bundle_rows[0]
            assert item["requested_labels"] == "Food preferences, Allergies"
            assert item["requested_count"] == 2
            assert (item["counterpart_label"], item["reason"]) == ("Kushal", "dinner planning")
            assert "connector_public_key" not in item
            # Requests without a bundle and every other action keep their rows.
            assert [row["event_type"] for row in rows].count("consent_requested") == 2
            assert [row["event_type"] for row in rows].count("consent_granted") == 1

            # --- The bundle progress query, as InformationRequestService runs it.
            from sqlalchemy import create_engine, text

            from hushh_mcp.services.information_request_service import PROGRESS_LEDGER_SQL

            engine = create_engine(url.replace("postgresql://", "postgresql+psycopg2://", 1))
            with engine.connect() as connection:
                ledger = (
                    connection.execute(
                        text(PROGRESS_LEDGER_SQL),
                        {"subject": OWNER, "request_ids": ["one_person_r1", "one_person_r2"]},
                    )
                    .mappings()
                    .all()
                )
            engine.dispose()
            assert [(row["request_id"], row["action"]) for row in ledger] == [
                ("one_person_r1", "REQUESTED"),
                ("one_person_r2", "REQUESTED"),
                ("one_person_r1", "CONSENT_GRANTED"),
            ]

            # --- Eight workers, one event: exactly one send and one record. --
            sends = AsyncMock()
            records = AsyncMock()
            monkeypatch.setattr(
                consent_listener, "_enrich_notify_payload", AsyncMock(side_effect=lambda d: d)
            )
            monkeypatch.setattr(consent_listener, "_push_to_developer_consent_queues", AsyncMock())
            monkeypatch.setattr(
                consent_listener, "_information_requester_doorbell", AsyncMock(return_value=None)
            )
            monkeypatch.setattr(consent_listener, "_send_fcm_for_user", sends)
            monkeypatch.setattr(consent_listener, "_record_notification_event", records)
            requested = json.dumps(notified[0])
            await asyncio.gather(
                *(consent_listener._handle_notify(requested) for _ in range(WORKERS))
            )
            assert (sends.await_count, records.await_count) == (1, 1)
            # The backfill job's claim for the same initial delivery now loses.
            from hushh_mcp.services.consent_delivery_claims import (
                claim_delivery,
                request_notification_key,
            )

            assert await claim_delivery(request_notification_key("one_person_r1", 1)) is False

            # A resolution rings the requester's doorbell exactly once too.
            doorbell = (
                "requester-uid",
                {"type": "information_request_updated", "bundle_id": BUNDLE},
            )
            monkeypatch.setattr(
                consent_listener,
                "_information_requester_doorbell",
                AsyncMock(return_value=doorbell),
            )
            monkeypatch.setattr(
                consent_listener, "_with_bundle_outcome", AsyncMock(side_effect=lambda _u, p: p)
            )
            sends.reset_mock()
            granted = json.dumps(notified[3])
            await asyncio.gather(
                *(consent_listener._handle_notify(granted) for _ in range(WORKERS))
            )
            recipients = sorted(call.args[0] for call in sends.await_args_list)
            assert recipients == [OWNER, "requester-uid"]

            # Negative control: the same eight handlers without the claim.
            sends.reset_mock()
            monkeypatch.setattr(
                consent_listener, "_information_requester_doorbell", AsyncMock(return_value=None)
            )
            monkeypatch.setattr(consent_listener, "claim_delivery", AsyncMock(return_value=True))
            await asyncio.gather(
                *(consent_listener._handle_notify(json.dumps(notified[2])) for _ in range(WORKERS))
            )
            assert sends.await_count == WORKERS

            # --- Rollback refuses while claims are recent, then applies. -----
            with pytest.raises(asyncpg.RaiseError, match="migration_260_rollback_refused"):
                await pool.execute(ROLLBACK)
            await pool.execute(
                "UPDATE consent_event_deliveries SET claimed_at = NOW() - INTERVAL '2 days'"
            )
            await pool.execute(ROLLBACK)
            assert (
                await pool.fetchval("SELECT to_regclass('public.consent_event_deliveries')") is None
            )
            await pool.execute(MIGRATION)  # and it comes back cleanly
        finally:
            listener.terminate()
            await pool.execute("DROP TABLE IF EXISTS consent_event_deliveries")
            await pool.execute("DELETE FROM feed_events WHERE user_id = $1", OWNER)
            await pool.execute("DELETE FROM consent_audit WHERE user_id = $1", OWNER)
            for table in reversed(created):
                await pool.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
            await pool.close()

    asyncio.run(scenario())
