"""Recover capped financial discovery without losing originals or broadening authority."""

# ruff: noqa: F401,F811 -- canonical disposable PostgreSQL fixture graph
from copy import deepcopy
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from psycopg2.extras import execute_values
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from hushh_mcp.services.drive_period_packet_contract import PacketPeriod
from hushh_mcp.services.drive_period_packet_preview import snapshot_search
from hushh_mcp.services.drive_request_discovery import discovery_evidence
from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult
from hushh_mcp.services.google_drive_adapter import DriveReadError
from tests.services.test_drive_period_packet_previews_postgres import (
    collection,
    collection_pages,
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


def original(head, position):
    return {
        "id": f"large-original-{position}",
        "name": f"Synthetic statement row {position}",
        "mimeType": "video/mp4" if position == 1 else "application/pdf",
        "sourceVersion": "1",
        "shareable": position != 1,
        "createdTime": f"{head['period_start']}T12:00:00Z",
        "modifiedTime": f"{head['period_start']}T12:00:00Z",
    }


def saved_search(service, identity):
    with service.store.db.engine.connect() as connection:
        return dict(
            connection.execute(
                text("SELECT * FROM drive_owner_search_jobs WHERE job_id=:id"), {"id": identity}
            )
            .mappings()
            .one()
        )


def retained_rows(service, identity):
    with service.store.db.engine.connect() as connection:
        return connection.execute(
            text("""SELECT count(*),min(position),max(position),
              md5(string_agg(metadata_envelope::text||file_digest, '' ORDER BY position))
              FROM drive_owner_search_results WHERE job_id=:id AND position<=10000"""),
            {"id": identity},
        ).one()


async def seed_limited_financial(reusable, monkeypatch, *, historical=False, incomplete=False):
    service, head, planner, transport = await preview_runtime(
        reusable, monkeypatch, historical=historical
    )
    job = await service.store.claim_build(user_id="owner", packet_id=str(head["packet_id"]))
    plan, binding = await service._plan(job, AsyncMock())
    state = await service._search_job(job, plan, binding)
    claimed = await service.search.store.claim(user_id="owner", job_id=state["jobId"])
    checkpoint = {
        **deepcopy(claimed["checkpoint"]),
        "page_token": "advanced-past-partly-saved-page",
        "coverage_counts": {"scannedCount": 10003},
        **({"financial_limit_recovery": {"version": 1}} if incomplete else {}),
    }
    searches, identity = service.search.store, state["jobId"]
    values = []
    for position in range(1, 10001):
        source = original(head, position)
        source["discoveryEvidence"] = discovery_evidence(
            checkpoint, user_id="owner", generation=head["connection_generation"], metadata=source
        )
        values.append(
            (
                identity,
                "owner",
                position,
                searches.search_cipher.digest("owner-search-file", [identity, source["id"]]),
                searches._seal(source, "owner", f"{identity}:{position}", "owner-search-result"),
            )
        )
    with service.store.db.engine.begin() as connection:
        with connection.connection.driver_connection.cursor() as cursor:
            execute_values(
                cursor,
                """INSERT INTO drive_owner_search_results
              (job_id,user_id,position,file_digest,metadata_envelope) VALUES %s""",
                values,
                page_size=1000,
            )
        connection.execute(
            text("""UPDATE drive_owner_search_jobs SET status='limited',error_code=:error,
              matched=10000,unshareable_count=1,pages_scanned=3,incomplete_search=TRUE,
              lease_id=NULL,lease_expires_at=NULL,checkpoint_envelope=CAST(:checkpoint AS jsonb)
              WHERE job_id=:id"""),
            {
                "id": identity,
                "error": None if incomplete else "search_limit",
                "checkpoint": searches._seal(
                    checkpoint, "owner", identity, "owner-search-checkpoint"
                ),
            },
        )
    build = await snapshot_search(service.store, job, job["build"], identity)
    await service.store.save_build(
        job, build, error="search_incomplete" if incomplete else "search_limit"
    )
    with service.store.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE drive_packet_heads SET next_at=clock_timestamp(),attempts=:attempts WHERE packet_id=:id"
            ),
            {"id": head["packet_id"], "attempts": 8 if incomplete else 1},
        )
    return service, head, planner, transport, identity, checkpoint


def replayed_provider(head, calls, *, incomplete=False):
    async def read(*, user_id, tool_name, arguments):
        assert user_id == "owner"
        if tool_name == "list_shared_drives":
            return ExternalMcpToolResult(False, {"drives": [], "nextPageToken": None}, False)
        assert tool_name in {"list_files", "search_files"}, "No content reader is authorized"
        token = arguments.get("pageToken")
        calls.append(token)
        assert token in {None, "missed-tail"}, "The partially saved legacy page must be replayed"
        positions = [10000, 10001] if token is None else range(10002, 10031)
        files = []
        for position in positions:
            source = original(head, position)
            files.append(
                {
                    "id": source["id"],
                    "title": source["name"],
                    "mimeType": source["mimeType"],
                    "version": source["sourceVersion"],
                    "createdTime": source["createdTime"],
                    "modifiedTime": source["modifiedTime"],
                    "capabilities": {"canShare": True},
                }
            )
        return ExternalMcpToolResult(
            False,
            {
                "files": files,
                "nextPageToken": "missed-tail" if token is None else None,
                "incompleteSearch": incomplete,
            },
            False,
        )

    return read


def assert_large_scope_cannot_be_relabelled(service, head, identity):
    statements = (
        ("UPDATE drive_owner_search_jobs SET period_packet_id=NULL WHERE job_id=:id", identity),
        ("UPDATE drive_packet_heads SET category='bank' WHERE packet_id=:id", head["packet_id"]),
    )
    before = retained_rows(service, identity)
    for statement, target in statements:
        with pytest.raises(IntegrityError), service.store.db.engine.begin() as connection:
            connection.execute(text(statement), {"id": target})
    assert retained_rows(service, identity) == before


@pytest.mark.parametrize("historical", [False, True])
async def test_capped_financial_recovery_replays_missed_tail_and_pages_past_10000(
    reusable, monkeypatch, historical
):
    service, head, planner, transport, identity, frozen = await seed_limited_financial(
        reusable, monkeypatch, historical=historical
    )
    before = retained_rows(service, identity)
    assert before[:3] == (10000, 1, 10000)
    job = await service.store.claim_build(user_id="owner", packet_id=str(head["packet_id"]))
    plan, binding = await service._plan(job, AsyncMock())
    state = await service._search_job(job, plan, binding)
    assert state["jobId"] == identity and state["status"] == "queued"
    recovered = saved_search(service, identity)
    checkpoint = service.search.store._checkpoint(recovered)
    marker = checkpoint["financial_limit_recovery"]
    assert marker["retained_count"] == 10000 and marker["previous_pages"] == 3
    assert checkpoint["page_token"] is None and checkpoint["coverage_counts"] == {}
    for key in ("period_packet_origin", "queries", "query_source", "semantic_plan_digest"):
        assert checkpoint[key] == frozen[key]
    assert (await service._search_job(job, plan, binding))["jobId"] == identity
    assert (
        saved_search(service, identity)["checkpoint_envelope"] == recovered["checkpoint_envelope"]
    )
    assert retained_rows(service, identity) == before
    await service.store.save_build(job, job["build"])
    with service.store.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_packet_heads SET next_at=clock_timestamp() WHERE packet_id=:id"),
            {"id": head["packet_id"]},
        )
    calls = []
    transport.read_tool.side_effect = replayed_provider(head, calls)
    assert (
        await service.run_one(
            user_id="owner", packet_id=str(head["packet_id"]), deadline_seconds=20
        )
        == "completed"
    )
    after = saved_search(service, identity)
    assert (
        after["status"] == "completed"
        and after["matched"] == 10030
        and not after["incomplete_search"]
    )
    assert service.search.store._checkpoint(after)["financial_limit_recovery"] == marker
    assert retained_rows(service, identity) == before
    assert calls == [None, "missed-tail"]
    cursor = service.search.store._cursor("owner", identity, 10000)
    first = await service.preview(user_id="owner", packet_id=str(head["packet_id"]), cursor=cursor)
    assert first["matched"] == 10030 and first["complete"] and not first["limited"]
    assert len(first["documents"]) == 25 and first["nextCursor"]
    last = await service.preview(
        user_id="owner", packet_id=str(head["packet_id"]), cursor=first["nextCursor"]
    )
    assert len(last["documents"]) == 5 and last["nextCursor"] is None
    assert last["documents"][-1]["name"] == original(head, 10030)["name"]
    with service.store.db.engine.connect() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_owner_search_jobs WHERE period_packet_id=:id"),
                {"id": head["packet_id"]},
            ).scalar_one()
            == 1
        )
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_request_payment_orders")
            ).scalar_one()
            == 0
        )
        assert (
            connection.execute(text("SELECT count(*) FROM drive_bulk_share_effects")).scalar_one()
            == 0
        )
    planner.assert_not_awaited()
    assert_large_scope_cannot_be_relabelled(service, head, identity)
    await assert_completed_large_preview_is_not_for_sale(service, head, historical)


@pytest.mark.parametrize("denial", ["revoked", "background_off", "stale_origin"])
@pytest.mark.parametrize("incomplete", [False, True])
async def test_capped_financial_recovery_preserves_rows_when_authority_is_denied(
    reusable, monkeypatch, denial, incomplete
):
    service, head, planner, transport, identity, _ = await seed_limited_financial(
        reusable, monkeypatch, incomplete=incomplete
    )
    job = await service.store.claim_build(user_id="owner", packet_id=str(head["packet_id"]))
    plan, binding = await service._plan(job, AsyncMock())
    with service.store.db.engine.begin() as connection:
        if denial == "revoked":
            connection.exec_driver_sql(
                "UPDATE user_external_connector_connections SET status='revoked' WHERE user_id='owner'"
            )
        elif denial == "background_off":
            connection.exec_driver_sql("""INSERT INTO drive_live_preferences
              (user_id,connection_generation,background_enabled,disclosure_version)
              VALUES('owner',1,FALSE,'live-drive-background-v1')""")
        else:
            row = saved_search(service, identity)
            checkpoint = service.search.store._checkpoint(row)
            checkpoint["period_packet_origin"]["revision"] += 1
            connection.execute(
                text(
                    "UPDATE drive_owner_search_jobs SET checkpoint_envelope=CAST(:checkpoint AS jsonb) WHERE job_id=:id"
                ),
                {
                    "id": identity,
                    "checkpoint": service.search.store._seal(
                        checkpoint, "owner", identity, "owner-search-checkpoint"
                    ),
                },
            )
    before, retained = saved_search(service, identity), retained_rows(service, identity)
    with pytest.raises(DriveReadError):
        await service._search_job(job, plan, binding)
    assert saved_search(service, identity) == before
    assert retained_rows(service, identity) == retained
    planner.assert_not_awaited()
    transport.read_tool.assert_not_awaited()


@pytest.mark.parametrize("overflow", ["position", "matched"])
async def test_ordinary_search_sql_capacity_still_rejects_values_above_10000(
    reusable, monkeypatch, overflow
):
    service, _, _, _ = await preview_runtime(reusable, monkeypatch)
    state, _ = await service.search.store.create(
        user_id="owner",
        client_request_id=str(uuid4()),
        request={"query": "synthetic ordinary"},
        checkpoint={},
        confirmed=True,
    )
    if overflow == "matched":
        with pytest.raises(IntegrityError), service.store.db.engine.begin() as connection:
            connection.execute(
                text("UPDATE drive_owner_search_jobs SET matched=10001 WHERE job_id=:id"),
                {"id": state["jobId"]},
            )
        return
    with pytest.raises(IntegrityError), service.store.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO drive_owner_search_results
          (job_id,user_id,position,file_digest,metadata_envelope)
          VALUES(:id,'owner',10001,:digest,CAST(:envelope AS jsonb))"""),
            {
                "id": state["jobId"],
                "digest": "a" * 64,
                "envelope": service.search.store._seal(
                    {}, "owner", f"{state['jobId']}:10001", "owner-search-result"
                ),
            },
        )
    with service.store.db.engine.connect() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_owner_search_results WHERE job_id=:id"),
                {"id": state["jobId"]},
            ).scalar_one()
            == 0
        )


async def test_financial_continuation_crosses_1000_pages_without_losing_cycle_detection(
    reusable, monkeypatch
):
    import hashlib

    from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult

    service, head, _, transport = await preview_runtime(reusable, monkeypatch)
    job = await service.store.claim_build(user_id="owner", packet_id=str(head["packet_id"]))
    plan, binding = await service._plan(job, AsyncMock())
    state = await service._search_job(job, plan, binding)
    claimed = await service.search.store.claim(user_id="owner", job_id=state["jobId"])
    await service.search.store.require_current(claimed)
    checkpoint = claimed["checkpoint"]
    checkpoint["coverage_counts"] = {"providerFilePages": 1000}
    checkpoint["seen_tokens"] = [
        hashlib.sha256(f"prior-{i}".encode()).hexdigest() for i in range(1000)
    ]
    checkpoint["page_token"] = "prior-999"
    transport.read_tool.side_effect = None
    transport.read_tool.return_value = ExternalMcpToolResult(
        False, {"files": [], "nextPageToken": "next-1001", "incompleteSearch": False}, False
    )
    continued, files, incomplete, done = await service.search._page(claimed)
    assert not done and not incomplete and files == []
    assert continued["coverage_counts"]["providerFilePages"] == 1001
    assert not continued["coverage_counts"].get("workLimitReached")
    claimed["checkpoint"] = continued
    transport.read_tool.return_value = ExternalMcpToolResult(
        False, {"files": [], "nextPageToken": "prior-0", "incompleteSearch": False}, False
    )
    with pytest.raises(DriveReadError, match="provider_response_invalid"):
        await service.search._page(claimed)


async def assert_completed_large_preview_is_not_for_sale(service, head, historical):
    from hushh_mcp.services.drive_packet_public_summary import _project

    with service.store.db.engine.connect() as connection:
        row = dict(
            connection.execute(
                text("SELECT * FROM drive_packet_heads WHERE packet_id=:id"),
                {"id": head["packet_id"]},
            )
            .mappings()
            .one()
        )
    assert row["current_version"] == 0 and row["dirty"] is not historical
    # No sale version exists: public discovery can be factual without checkout.
    summary = _project(row, "recipient", True, "connected", True)
    assert summary["documentCount"] == 10030 and summary["complete"]
    assert summary["availability"] == "unavailable" and summary["viewerAction"] == "unavailable"
    if historical:
        assert await service.run_one(user_id="owner", packet_id=str(head["packet_id"])) == "idle"


async def test_capped_partial_preview_keeps_all_saved_pages_during_provider_failure(
    reusable, monkeypatch
):
    service, head, _, _, identity, _ = await seed_limited_financial(reusable, monkeypatch)
    preview = await service.preview(
        user_id="owner",
        packet_id=str(head["packet_id"]),
        cursor=service.search.store._cursor("owner", identity, 125),
    )
    assert preview["stale"] and not preview["complete"] and preview["matched"] == 10000
    assert len(preview["documents"]) == 25 and preview["nextCursor"] and not preview["limited"]
    assert preview["documents"][0]["name"] == original(head, 126)["name"]


@pytest.mark.parametrize(
    "outcome", ["complete", "incomplete", "future", "head_lease", "foreground"]
)
async def test_scheduled_legacy_incomplete_recovery_is_once_only_and_respects_fences(
    reusable, monkeypatch, outcome
):
    service, head, planner, transport, identity, frozen = await seed_limited_financial(
        reusable, monkeypatch, incomplete=True
    )
    period = PacketPeriod(start=head["period_start"], end=head["period_end"], timezone="UTC")
    monkeypatch.setattr(
        "hushh_mcp.services.drive_period_packet_enrollment.current_year_periods",
        lambda *_: [period],
    )
    monkeypatch.setattr(
        "hushh_mcp.services.drive_financial_packet_tagging.FinancialPacketTagger.run_one",
        AsyncMock(return_value="idle"),
    )
    with service.store.db.engine.begin() as connection:
        connection.execute(
            text("DELETE FROM drive_packet_heads WHERE packet_id<>:id"), {"id": head["packet_id"]}
        )
        change = {
            "future": "next_at=clock_timestamp()+INTERVAL '1 day'",
            "head_lease": "lease_id=gen_random_uuid(),lease_expires_at=clock_timestamp()+INTERVAL '1 minute'",
        }.get(outcome)
        if change:
            connection.execute(
                text(f"UPDATE drive_packet_heads SET {change} WHERE packet_id=:id"),
                {"id": head["packet_id"]},
            )
    if outcome == "foreground":
        await service.search.store.create(
            user_id="owner",
            client_request_id=str(uuid4()),
            request={"query": "foreground"},
            checkpoint={},
            confirmed=True,
        )
    before, calls = retained_rows(service, identity), []
    transport.read_tool.side_effect = replayed_provider(
        head, calls, incomplete=outcome == "incomplete"
    )
    assert await service.store.due_owners(limit=1) == (
        [] if outcome in {"future", "head_lease", "foreground"} else ["owner"]
    )
    result = await service.run(max_jobs=1, deadline_seconds=20)
    assert retained_rows(service, identity) == before
    planner.assert_not_awaited()
    if outcome in {"future", "head_lease", "foreground"}:
        transport.read_tool.assert_not_awaited()
        assert saved_search(service, identity)["error_code"] is None
        return
    after = saved_search(service, identity)
    checkpoint = service.search.store._checkpoint(after)
    assert checkpoint["financial_incomplete_recovery"] == {
        "version": 1,
        "reason": "legacy_incomplete_search",
        "retained_count": 10000,
        "previous_pages": 3,
    }
    assert str(after["job_id"]) == identity and after["matched"] == 10030
    assert calls == [None, "missed-tail"]
    assert checkpoint["financial_limit_recovery"] == frozen["financial_limit_recovery"]
    assert after["status"] == ("limited" if outcome == "incomplete" else "completed")
    assert after["incomplete_search"] is (outcome == "incomplete")
    assert after["error_code"] == ("search_incomplete" if outcome == "incomplete" else None)
    assert result["outcomes"]["queued" if outcome == "incomplete" else "completed"] == 1
    with service.store.db.engine.begin() as connection:
        assert connection.execute(
            text(
                "SELECT (SELECT count(*) FROM drive_request_payment_orders),(SELECT count(*) FROM drive_bulk_share_effects)"
            )
        ).one() == (0, 0)
        if outcome == "incomplete":
            connection.execute(
                text("UPDATE drive_packet_heads SET next_at=clock_timestamp() WHERE packet_id=:id"),
                {"id": head["packet_id"]},
            )
    await service.run(max_jobs=1, deadline_seconds=20)
    assert calls == [None, "missed-tail"]
    assert saved_search(service, identity)["checkpoint_envelope"] == after["checkpoint_envelope"]
