"""Organizing failures are recorded, retried within bounds, and recovered once."""

# ruff: noqa: F401,F811 -- reuse disposable PostgreSQL fixture dependencies
from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import text

from tests.services.test_drive_period_packet_loop_postgres import assert_persisted
from tests.services.test_drive_period_packet_previews_postgres import (
    collection,
    collection_pages,
    completed_preview,
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    ingestion,
    lifecycle,
    preview_runtime,
    reusable,
    sharing,
)

pytestmark = [pytest.mark.feature_drive_packets, pytest.mark.trace_loop]


@pytest.mark.parametrize(
    ("code", "delays"),
    [
        # Passes on its own: three quick retries, then slow ones, then a stop.
        ("refresh_in_progress", [300, 300, 21600, 21600, 21600, 21600]),
        # Needs the owner: unchanged three attempts.
        ("reconnect_required", [300, 300]),
    ],
)
async def test_failed_organizing_saves_its_code_and_retries_within_its_bound(
    reusable, monkeypatch, code, delays
):
    """Regression (UAT 2026-10-27): 8 failed records stored no cause and never retried."""
    from hushh_mcp.services import drive_financial_packet_tag_store as tags

    service, head, planner, _ = await preview_runtime(reusable, monkeypatch)
    identity = str(head["packet_id"])
    assert (await completed_preview(service, identity))["complete"]
    for attempt in range(1, len(delays) + 2):
        job = await tags.claim(service.store, "synthetic-local-organizer-v1")
        assert job and str(job["packet_id"]) == identity
        outcome = await tags.commit(service.store, job, error=code)
        with service.store.db.engine.begin() as connection:
            queue = (
                connection.execute(
                    text("""SELECT tagging_pending,
                  EXTRACT(EPOCH FROM tagging_next_at-clock_timestamp()) AS wait
                  FROM drive_packet_heads WHERE packet_id=:id"""),
                    {"id": identity},
                )
                .mappings()
                .one()
            )
            # Make the scheduled retry due for the next claim.
            connection.execute(
                text(
                    "UPDATE drive_packet_heads SET tagging_next_at=clock_timestamp() WHERE packet_id=:id"
                ),
                {"id": identity},
            )
        tagging = (await service.preview(user_id="owner", packet_id=identity))["tagging"]
        assert tagging["failureCode"] == code
        if attempt <= len(delays):
            assert outcome == "queued" and queue["tagging_pending"] is True
            assert abs(float(queue["wait"]) - delays[attempt - 1]) < 30
            assert tagging["status"] == "queued" and tagging["retryAt"]
        else:
            assert outcome == "failed" and queue["tagging_pending"] is False
            assert tagging["status"] == "failed" and "retryAt" not in tagging
    assert await tags.claim(service.store, "synthetic-local-organizer-v1") is None
    after = await service.preview(user_id="owner", packet_id=identity)
    assert after["complete"] and after["matched"] == 26
    assert set(after["tagging"]) == {"status", "policyVersion", "counts", "failureCode"}
    planner.assert_not_awaited()
    assert_persisted(service, 26)


def labels(job):
    from hushh_mcp.services.drive_financial_packet_tag_store import POLICY

    label = {"bucket": "review", "reason": "no_evidence", "group": None, "policyVersion": POLICY}
    return [label for _ in job["items"]]


async def test_unrecorded_organizing_stop_is_rearmed_once_and_keeps_progress(reusable, monkeypatch):
    """Regression (UAT 2026-10-28): organizing stopped by the refresh race saved no
    cause, and a closed period never re-armed it. One bounded re-arm keeps labels."""
    from hushh_mcp.services import drive_financial_packet_tag_store as tags
    from hushh_mcp.services.drive_period_packet_preview import write_build

    service, head, planner, _ = await preview_runtime(reusable, monkeypatch)
    identity = str(head["packet_id"])
    assert (await completed_preview(service, identity))["complete"]
    model = "synthetic-local-organizer-v1"

    def queue():
        with service.store.db.engine.begin() as connection:
            row = dict(
                connection.execute(
                    text("SELECT * FROM drive_packet_heads WHERE packet_id=:id"), {"id": identity}
                )
                .mappings()
                .one()
            )
            return row, service.store._build(row)

    def due_now():
        with service.store.db.engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE drive_packet_heads SET tagging_next_at=clock_timestamp() WHERE packet_id=:id"
                ),
                {"id": identity},
            )

    async def stop_unrecorded():
        for _ in range(tags.QUICK_RETRY_ATTEMPTS):
            due_now()
            await tags.commit(
                service.store, await tags.claim(service.store, model), error="reconnect_required"
            )
        assert queue()[0]["tagging_pending"] is False
        await service.ensure_owner(user_id="owner")  # a recorded failure keeps its own retries
        row, build = queue()
        assert row["tagging_pending"] is False
        # As written before failure codes were saved, when organizing last stopped.
        build["tagging"].pop("failureCode")
        with service.store.db.engine.begin() as connection:
            write_build(service.store, connection, row, build)
            connection.execute(
                text("""UPDATE drive_packet_heads SET tagging_next_at=:stopped
              WHERE packet_id=:id"""),
                {"id": identity, "stopped": tags.UNRECORDED_BEFORE - timedelta(days=3)},
            )

    job = await tags.claim(service.store, model)
    assert await tags.commit(service.store, job, labels(job)) == "queued"
    cursor = queue()[1]["tagging_work"]["cursor"]
    await stop_unrecorded()

    await service.ensure_owner(user_id="owner")
    row, build = queue()
    assert row["tagging_pending"] is True
    assert build["tagging_work"]["attempts"] == 0
    assert build["tagging_work"]["recovery"] == tags.RECOVERY_MARKER
    assert build["tagging_work"]["cursor"] == cursor
    assert build["tagging_work"]["counts"]["review"] == tags.BATCH
    resumed = await tags.claim(service.store, model)
    assert resumed and min(item["position"] for item in resumed["items"]) > cursor
    assert await tags.commit(service.store, resumed, labels(resumed)) == "queued"
    assert queue()[1]["tagging_work"]["counts"]["review"] == 2 * tags.BATCH
    await stop_unrecorded()
    await service.ensure_owner(user_id="owner")
    assert queue()[0]["tagging_pending"] is False  # at most one re-arm per packet
    planner.assert_not_awaited()
    assert_persisted(service, 26)
