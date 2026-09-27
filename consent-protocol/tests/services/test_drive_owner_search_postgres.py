"""Durable REST paging with synthetic files in disposable PostgreSQL only."""

# ruff: noqa: F811 -- shared isolated PostgreSQL fixtures

import asyncio
import base64
import copy
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from sqlalchemy import text

from hushh_mcp.services.drive_owner_search_service import DriveOwnerSearchService, compile_plan
from hushh_mcp.services.drive_owner_search_store import DriveOwnerSearchStore
from hushh_mcp.services.drive_owner_search_worker import DriveOwnerSearchWorker
from hushh_mcp.services.drive_sharing_retention import erase_drive_account_in_transaction
from hushh_mcp.services.drive_telemetry import correlation_tag
from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult
from hushh_mcp.services.google_drive_adapter import (
    DRIVE_BASE,
    DRIVE_POLICY,
    LIVE_POLICY_HASH,
    DriveReadError,
)
from tests.services.test_external_connector_lifecycle_postgres import (  # noqa: F401
    connector_postgres_url,
    lifecycle,
)

MIGRATIONS = Path(__file__).resolve().parents[2] / "db/migrations"


@pytest.fixture
def store(lifecycle, monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("GOOGLE_DRIVE_LIVE", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner,other")
    monkeypatch.setenv("DRIVE_SHARING_KEY_V1", base64.b64encode(b"s" * 32).decode())
    with lifecycle.db.engine.begin() as connection:
        connection.execute(text((MIGRATIONS / "251_drive_owner_search_jobs.sql").read_text()))
        connection.execute(text((MIGRATIONS / "251_drive_owner_search_jobs.sql").read_text()))
        connection.execute(
            text("""UPDATE external_mcp_connectors SET transport_kind='google_drive_rest',
            mcp_endpoint=:endpoint,capability_policy=CAST(:policy AS jsonb) WHERE connector_id='google_drive'"""),
            {"endpoint": DRIVE_BASE, "policy": json.dumps(DRIVE_POLICY)},
        )
        for user in ("owner", "other"):
            connection.execute(
                text("""INSERT INTO user_external_connector_connections
                (user_id,connector_id,status,validation_state,verified_policy_hash,connection_generation)
                VALUES(:user,'google_drive','connected','verified',:policy,7)"""),
                {"user": user, "policy": LIVE_POLICY_HASH},
            )
    return DriveOwnerSearchStore(db=lifecycle.db)


def checkpoint():
    return {
        "arguments": {"query": "name contains 'Synthetic'"},
        "phase": "user",
        "page_token": None,
        "drive_page_token": None,
        "drives": [],
        "drive_index": 0,
        "seen_tokens": [],
        "drive_tokens": [],
    }


async def create(store, *, user="owner", client=None, confirmed=True):
    return await store.create(
        user_id=user,
        client_request_id=client or str(uuid4()),
        request={"query": "Synthetic"},
        checkpoint=checkpoint(),
        confirmed=confirmed,
    )


def file(number):
    return {
        "id": f"file-{number}",
        "title": f"Synthetic private file {number}",
        "mimeType": "application/pdf",
        "modifiedTime": "2026-09-27T00:00:00Z",
    }


def result(number):
    value = file(number)
    return {
        "id": value["id"],
        "name": value["title"],
        "mimeType": value["mimeType"],
        "modifiedTime": value["modifiedTime"],
        "openUrl": f"https://drive.google.com/open?id=file-{number}",
    }


def sql(store, statement, params=None):
    with store.db.engine.begin() as connection:
        return connection.execute(text(statement), params or {})


async def test_thousand_results_checkpoint_every_page_and_resume_new_worker_instances(store):
    state, _ = await create(store)
    calls, concurrency = [], {"active": 0, "peak": 0}

    async def read(*, user_id, tool_name, arguments):
        assert user_id == "owner" and arguments["pageSize"] == 25
        concurrency["active"] += 1
        concurrency["peak"] = max(concurrency["peak"], concurrency["active"])
        await asyncio.sleep(0)
        concurrency["active"] -= 1
        calls.append((tool_name, copy.deepcopy(arguments)))
        if tool_name == "list_shared_drives":
            return ExternalMcpToolResult(False, {"drives": [], "nextPageToken": None}, False)
        page = int(arguments.get("pageToken", "0"))
        assert "driveId" not in arguments
        return ExternalMcpToolResult(
            False,
            {
                "files": [file(n) for n in range(page * 25, (page + 1) * 25)],
                "nextPageToken": str(page + 1) if page < 39 else None,
                "incompleteSearch": False,
            },
            False,
        )

    transport = SimpleNamespace(read_tool=AsyncMock(side_effect=read))
    while (await store.status(user_id="owner", job_id=state["jobId"]))["canStop"]:
        before = len(calls)
        # No in-process state survives a slice: the next worker reads Postgres.
        worker = DriveOwnerSearchWorker(
            DriveOwnerSearchService(store=DriveOwnerSearchStore(db=store.db), transport=transport)
        )
        await worker.run(max_jobs=1)
        assert 1 <= len(calls) - before <= 4
    final = await store.status(user_id="owner", job_id=state["jobId"])
    assert final["status"] == "completed" and final["matched"] == 1000
    assert final["pagesScanned"] == 41 and final["incompleteSearch"] is False
    assert concurrency["peak"] == 1
    assert len([call for call in calls if call[0] == "search_files"]) == 40
    cursor, identifiers = None, []
    while True:
        page = await store.results(user_id="owner", job_id=state["jobId"], cursor=cursor)
        assert len(page["files"]) <= 25
        identifiers.extend(item["id"] for item in page["files"])
        cursor = page["nextCursor"]
        if cursor is None:
            break
    assert identifiers == [f"file-{n}" for n in range(1000)]
    rows = sql(store, "SELECT metadata_envelope FROM drive_owner_search_results").all()
    assert "Synthetic private" not in str(rows) and '"file-' not in str(rows)


async def test_crash_reclaims_only_expired_lease_and_replays_without_duplicates(store):
    state, _ = await create(store)
    first = await store.claim(user_id="owner", job_id=state["jobId"])
    assert await store.claim(user_id="owner", job_id=state["jobId"]) is None
    advanced = {**first["checkpoint"], "page_token": "private-next-page"}
    await store.commit_page(first, checkpoint=advanced, files=[result(1)])
    sql(
        store,
        "UPDATE drive_owner_search_jobs SET lease_expires_at=clock_timestamp()-INTERVAL '1 second'",
    )
    second = await store.claim(user_id="owner", job_id=state["jobId"])
    assert second["checkpoint"]["page_token"] == "private-next-page"
    with pytest.raises(DriveReadError, match="search_superseded"):
        await store.commit_page(first, checkpoint=advanced, files=[result(2)])
    final = await store.commit_page(
        second, checkpoint=advanced, files=[result(1), result(2)], done=True
    )
    assert final["matched"] == 2
    assert "private-next-page" not in str(sql(store, "SELECT * FROM drive_owner_search_jobs").all())


async def test_stop_during_provider_call_discards_late_result(store):
    state, _ = await create(store)
    started, finish = asyncio.Event(), asyncio.Event()

    async def read(**_):
        started.set()
        await finish.wait()
        return ExternalMcpToolResult(False, {"files": [file(1)]}, False)

    service = DriveOwnerSearchService(store=store, transport=SimpleNamespace(read_tool=read))
    task = asyncio.create_task(service.run_one(user_id="owner", job_id=state["jobId"]))
    await started.wait()
    stopped = await service.stop(
        user_id="owner", job_id=state["jobId"], require_current=AsyncMock()
    )
    finish.set()
    assert await task == "superseded"
    assert stopped["status"] == "stopped"
    assert (await store.results(user_id="owner", job_id=state["jobId"]))["files"] == []
    assert (await store.stop(user_id="owner", job_id=state["jobId"]))["revision"] == stopped[
        "revision"
    ]


async def test_concurrent_create_same_client_one_job_and_different_client_refused(store):
    client = str(uuid4())
    first, second = await asyncio.gather(create(store, client=client), create(store, client=client))
    assert first[0]["jobId"] == second[0]["jobId"]
    assert sum([first[1], second[1]]) == 1
    with pytest.raises(DriveReadError, match="search_in_progress"):
        await create(store)
    with pytest.raises(DriveReadError, match="confirmation_required"):
        await create(store, user="other", confirmed=False)


async def test_result_cursor_owner_job_and_ciphertext_bindings(store):
    state, _ = await create(store)
    job = await store.claim(user_id="owner", job_id=state["jobId"])
    await store.commit_page(job, checkpoint=job["checkpoint"], files=[result(i) for i in range(25)])
    await store.commit_page(job, checkpoint=job["checkpoint"], files=[result(25)], done=True)
    page = await store.results(user_id="owner", job_id=state["jobId"])
    assert page["nextCursor"]
    with pytest.raises(DriveReadError, match="search_not_found"):
        await store.status(user_id="other", job_id=state["jobId"])
    with pytest.raises(DriveReadError, match="invalid_argument"):
        await store.results(user_id="other", job_id=state["jobId"], cursor=page["nextCursor"])
    other, _ = await create(store)
    with pytest.raises(DriveReadError, match="invalid_argument"):
        await store.results(user_id="owner", job_id=other["jobId"], cursor=page["nextCursor"])
    from hushh_mcp.services.drive_sharing_contract import DriveSharingError

    envelope = sql(
        store, "SELECT metadata_envelope FROM drive_owner_search_results LIMIT 1"
    ).scalar_one()
    with pytest.raises(DriveSharingError):
        store.search_cipher.open(
            envelope,
            user_id="other",
            resource_id=f"{state['jobId']}:1",
            purpose="owner-search-result",
        )


async def test_saved_result_reference_is_owner_connection_and_expiry_bound(store, monkeypatch):
    state, _ = await create(store)
    job = await store.claim(user_id="owner", job_id=state["jobId"])
    await store.commit_page(job, checkpoint=job["checkpoint"], files=[result(1)], done=True)
    page = await store.results(user_id="owner", job_id=state["jobId"])
    assert page["files"][0]["position"] == 1
    assert (await store.reference(user_id="owner", job_id=state["jobId"], position=1))[
        "id"
    ] == "file-1"
    with pytest.raises(DriveReadError, match="search_not_found"):
        await store.reference(user_id="other", job_id=state["jobId"], position=1)
    with pytest.raises(DriveReadError, match="search_not_found"):
        await store.reference(user_id="owner", job_id=state["jobId"], position=2)
    with pytest.raises(DriveReadError, match="invalid_argument"):
        await store.reference(user_id="owner", job_id=state["jobId"], position=True)
    sql(
        store,
        "UPDATE user_external_connector_connections SET connection_generation=8 WHERE user_id='owner'",
    )
    with pytest.raises(DriveReadError, match="connection_changed"):
        await store.reference(user_id="owner", job_id=state["jobId"], position=1)
    sql(
        store,
        "UPDATE user_external_connector_connections SET connection_generation=7 WHERE user_id='owner'",
    )
    sql(
        store, "UPDATE drive_owner_search_jobs SET expires_at=clock_timestamp()-INTERVAL '1 second'"
    )
    # More than 100 expired jobs can sit beyond a bounded purge slice.
    monkeypatch.setattr(store, "purge", AsyncMock())
    with pytest.raises(DriveReadError, match="search_not_found"):
        await store.reference(user_id="owner", job_id=state["jobId"], position=1)


async def test_saved_result_is_live_checked_without_content_or_share(store):
    state, _ = await create(store)
    job = await store.claim(user_id="owner", job_id=state["jobId"])
    await store.commit_page(job, checkpoint=job["checkpoint"], files=[result(1)], done=True)
    transport = SimpleNamespace(
        read_tool=AsyncMock(
            return_value=ExternalMcpToolResult(
                False,
                {
                    "file": {
                        "id": "file-1",
                        "title": "Synthetic private file 1",
                        "mimeType": "application/pdf",
                        "modifiedTime": "2026-09-27T00:00:00Z",
                        "viewUrl": "https://drive.google.com/open?id=file-1",
                    }
                },
                False,
            )
        )
    )
    service = DriveOwnerSearchService(store=store, transport=transport)
    current = AsyncMock()
    selected = await service.resolve_selection(
        user_id="owner", job_id=state["jobId"], position=1, require_current=current
    )
    assert selected["id"] == "file-1"
    assert selected["name"] == "Synthetic private file 1"
    transport.read_tool.assert_awaited_once_with(
        user_id="owner", tool_name="get_file_metadata", arguments={"fileId": "file-1"}
    )
    assert current.await_count == 3
    transport.read_tool.reset_mock()
    transport.read_tool.return_value = ExternalMcpToolResult(
        False, {"file": {"id": "file-1", "title": "Renamed file"}}, False
    )
    with pytest.raises(DriveReadError, match="source_changed"):
        await service.resolve_selection(
            user_id="owner", job_id=state["jobId"], position=1, require_current=current
        )


@pytest.mark.parametrize("mutation", ["generation", "revoked"])
async def test_connection_change_prevents_commit_and_releases_no_private_results(store, mutation):
    state, _ = await create(store)
    job = await store.claim(user_id="owner", job_id=state["jobId"])
    assignment = "connection_generation=8" if mutation == "generation" else "status='revoked'"
    sql(store, f"UPDATE user_external_connector_connections SET {assignment} WHERE user_id='owner'")
    with pytest.raises(DriveReadError, match="connection_changed"):
        await store.commit_page(job, checkpoint=job["checkpoint"], files=[result(1)])
    assert sql(store, "SELECT count(*) FROM drive_owner_search_results").scalar_one() == 0
    # A broken provider grant cannot prevent the owner from stopping work.
    assert (await store.stop(user_id="owner", job_id=state["jobId"]))["status"] == "stopped"


async def test_expiry_and_account_erasure_remove_result_ciphertext(store):
    for erase in (False, True):
        state, _ = await create(store)
        job = await store.claim(user_id="owner", job_id=state["jobId"])
        await store.commit_page(job, checkpoint=job["checkpoint"], files=[result(1)], done=True)
        if erase:
            with store.db.engine.begin() as connection:
                erase_drive_account_in_transaction(connection, user_id="owner", permanent=True)
        else:
            sql(
                store,
                "UPDATE drive_owner_search_jobs SET expires_at=clock_timestamp()-INTERVAL '1 second'",
            )
            await store.purge()
        assert sql(store, "SELECT count(*) FROM drive_owner_search_results").scalar_one() == 0
        assert sql(store, "SELECT count(*) FROM drive_owner_search_jobs").scalar_one() == 0


async def test_incomplete_provider_search_never_becomes_complete(store):
    state, _ = await create(store)
    job = await store.claim(user_id="owner", job_id=state["jobId"])
    await store.commit_page(job, checkpoint=job["checkpoint"], files=[result(1)], incomplete=True)
    final = await store.commit_page(job, checkpoint=job["checkpoint"], files=[], done=True)
    assert final["status"] == "limited" and final["incompleteSearch"] is True


async def test_limit_is_incomplete_and_has_no_live_lease(store, monkeypatch):
    monkeypatch.setattr("hushh_mcp.services.drive_owner_search_store.MAX_RESULTS", 2)
    state, _ = await create(store)
    job = await store.claim(user_id="owner", job_id=state["jobId"])
    final = await store.commit_page(
        job, checkpoint=job["checkpoint"], files=[result(i) for i in range(3)]
    )
    assert final["status"] == "limited" and final["matched"] == 2
    assert final["incompleteSearch"] is True and final["errorCode"] == "search_limit"
    assert sql(store, "SELECT lease_id FROM drive_owner_search_jobs").scalar_one() is None


async def test_retry_preserves_checkpoint_and_stops_after_three_failures(store):
    state, _ = await create(store)
    transport = SimpleNamespace(
        read_tool=AsyncMock(side_effect=DriveReadError("provider_unavailable", retryable=True))
    )
    service = DriveOwnerSearchService(store=store, transport=transport)
    for expected in ("queued", "queued", "failed"):
        assert await service.run_one(user_id="owner", job_id=state["jobId"]) == expected
        sql(store, "UPDATE drive_owner_search_jobs SET next_at=clock_timestamp()")
    assert transport.read_tool.await_count == 3
    assert (await store.status(user_id="owner", job_id=state["jobId"]))["pagesScanned"] == 0


def test_migration_has_working_down_path(store):
    with store.db.engine.connect() as connection:
        connection.exec_driver_sql(
            (MIGRATIONS / "rollback/251_drive_owner_search_jobs.rollback.sql").read_text()
        )
        assert (
            connection.execute(text("SELECT to_regclass('drive_owner_search_jobs')")).scalar_one()
            is None
        )
        connection.execute(text((MIGRATIONS / "251_drive_owner_search_jobs.sql").read_text()))
        assert (
            connection.execute(
                text("SELECT to_regclass('drive_owner_search_results')")
            ).scalar_one()
            is not None
        )


def test_search_only_plan_uses_exact_name_and_never_content_read_mode():
    query = compile_plan(
        {"terms": ["Budget"], "mode": "find", "exact_title": "Budget's 2026"}, "UTC"
    )
    assert query["query"] == "name = 'Budget\\'s 2026'"
    with pytest.raises(DriveReadError, match="invalid_argument"):
        compile_plan({"terms": ["Budget"], "mode": "read"}, "UTC")


async def test_per_drive_paging_deduplicates_already_seen_user_files(store):
    state, _ = await create(store)
    calls = []

    async def read(*, tool_name, arguments, **_):
        calls.append((tool_name, arguments))
        if tool_name == "list_shared_drives":
            payload = {
                "drives": [{"id": "shared-drive-one", "name": "Private drive"}],
                "nextPageToken": None,
            }
        else:
            payload = {"files": [file(1), *([file(2)] if arguments.get("driveId") else [])]}
        return ExternalMcpToolResult(False, payload, False)

    service = DriveOwnerSearchService(store=store, transport=SimpleNamespace(read_tool=read))
    assert await service.run_one(user_id="owner", job_id=state["jobId"]) == "completed"
    assert len(calls) == 3 and calls[-1][1]["driveId"] == "shared-drive-one"
    assert (await store.status(user_id="owner", job_id=state["jobId"]))["matched"] == 2


async def test_create_retry_binds_original_query_not_a_second_model_plan(store, monkeypatch):
    monkeypatch.setattr(
        "hushh_mcp.services.drive_owner_search_service.wake_drive_work", AsyncMock()
    )
    transport = SimpleNamespace(
        read_tool=AsyncMock(
            return_value=ExternalMcpToolResult(
                False, {"files": [file(1)], "nextPageToken": "more"}, False
            )
        )
    )
    service = DriveOwnerSearchService(store=store, transport=transport)
    args = dict(
        user_id="owner",
        client_request_id=str(uuid4()),
        query="Find my private budget",
        background_consent=True,
        require_current=AsyncMock(),
    )
    first = await service.create(**args, plan={"terms": ["budget"], "mode": "find"})
    second = await service.create(**args, plan={"terms": ["different"], "mode": "read"})
    assert second == first and transport.read_tool.await_count == 1
    existing = await service.existing(
        user_id="owner",
        client_request_id=args["client_request_id"],
        query=args["query"],
        require_current=AsyncMock(),
    )
    assert existing == first
    with pytest.raises(DriveReadError, match="invalid_argument"):
        await service.existing(
            user_id="owner",
            client_request_id=args["client_request_id"],
            query="A different request",
            require_current=AsyncMock(),
        )
    assert args["query"] not in str(sql(store, "SELECT * FROM drive_owner_search_jobs").all())


async def test_expired_row_is_unreadable_even_when_cleanup_has_not_reached_it(store, monkeypatch):
    state, _ = await create(store)
    sql(
        store, "UPDATE drive_owner_search_jobs SET expires_at=clock_timestamp()-INTERVAL '1 second'"
    )
    monkeypatch.setattr(store, "purge", AsyncMock())
    for method in (store.status, store.results):
        with pytest.raises(DriveReadError, match="search_not_found"):
            await method(user_id="owner", job_id=state["jobId"])
    assert (await store.list(user_id="owner"))["jobs"] == []


async def test_revoked_job_is_terminalized_without_provider_io(store):
    state, _ = await create(store)
    sql(
        store,
        "UPDATE user_external_connector_connections SET status='revoked' WHERE user_id='owner'",
    )
    transport = SimpleNamespace(read_tool=AsyncMock(side_effect=AssertionError("provider reached")))
    service = DriveOwnerSearchService(store=store, transport=transport)
    assert await service.run_one(user_id="owner", job_id=state["jobId"]) == "not_claimed"
    final = await store.status(user_id="owner", job_id=state["jobId"])
    assert final["status"] == "failed" and final["errorCode"] == "connection_changed"
    assert await store.due() == []


async def test_partial_insert_failure_rolls_back_results_and_checkpoint_together(
    store, monkeypatch
):
    state, _ = await create(store)
    job = await store.claim(user_id="owner", job_id=state["jobId"])
    seal = store._seal

    def fail_second(value, user_id, resource_id, purpose):
        if resource_id.endswith(":2"):
            raise RuntimeError("synthetic encryption interruption")
        return seal(value, user_id, resource_id, purpose)

    monkeypatch.setattr(store, "_seal", fail_second)
    with pytest.raises(RuntimeError, match="synthetic encryption"):
        await store.commit_page(
            job,
            checkpoint={**job["checkpoint"], "page_token": "next"},
            files=[result(1), result(2)],
        )
    assert sql(store, "SELECT count(*) FROM drive_owner_search_results").scalar_one() == 0
    sql(
        store,
        "UPDATE drive_owner_search_jobs SET lease_expires_at=clock_timestamp()-INTERVAL '1 second'",
    )
    resumed = await store.claim(user_id="owner", job_id=state["jobId"])
    assert resumed["checkpoint"]["page_token"] is None


async def test_owner_session_lost_before_results_publication_releases_nothing(store):
    state, _ = await create(store)
    job = await store.claim(user_id="owner", job_id=state["jobId"])
    await store.commit_page(job, checkpoint=job["checkpoint"], files=[result(1)], done=True)
    service = DriveOwnerSearchService(store=store, transport=SimpleNamespace())
    with pytest.raises(PermissionError):
        await service.results(
            user_id="owner",
            job_id=state["jobId"],
            require_current=AsyncMock(side_effect=[None, PermissionError()]),
        )


async def test_progress_slice_wakes_after_releasing_lease(store, monkeypatch):
    state, _ = await create(store)
    calls = []

    async def read(*, arguments, **_):
        page = int(arguments.get("pageToken", "0"))
        calls.append(page)
        return ExternalMcpToolResult(
            False, {"files": [file(page)], "nextPageToken": str(page + 1)}, False
        )

    async def wake(stage):
        assert stage == "suggestions"
        row = sql(store, "SELECT status,lease_id FROM drive_owner_search_jobs").one()
        assert row.status == "queued" and row.lease_id is None
        return True

    waking = AsyncMock(side_effect=wake)
    monkeypatch.setattr("hushh_mcp.services.drive_owner_search_worker.wake_drive_work", waking)
    service = DriveOwnerSearchService(store=store, transport=SimpleNamespace(read_tool=read))
    result = await DriveOwnerSearchWorker(service).run()
    assert calls == [0, 1, 2, 3]
    assert result["outcomes"] == {"queued": 1}
    waking.assert_awaited_once_with("suggestions")
    assert (await store.status(user_id="owner", job_id=state["jobId"]))["matched"] == 4


async def test_retry_backoff_does_not_create_an_early_wake_loop(store, monkeypatch):
    await create(store)
    waking = AsyncMock()
    monkeypatch.setattr("hushh_mcp.services.drive_owner_search_worker.wake_drive_work", waking)
    service = DriveOwnerSearchService(
        store=store,
        transport=SimpleNamespace(
            read_tool=AsyncMock(side_effect=DriveReadError("provider_unavailable", retryable=True))
        ),
    )
    await DriveOwnerSearchWorker(service).run()
    waking.assert_not_called()
    assert await store.due() == []


async def test_dated_title_fallback_is_frozen_and_filters_unrelated_dates(store, monkeypatch):
    monkeypatch.setattr(
        "hushh_mcp.services.drive_owner_search_service.wake_drive_work", AsyncMock()
    )
    calls = []

    async def read(*, tool_name, arguments, **_):
        calls.append((tool_name, arguments))
        if tool_name == "list_shared_drives":
            return ExternalMcpToolResult(False, {"drives": []}, False)
        if "createdTime >=" in arguments["query"]:
            files = []
        else:
            files = [
                {**file(1), "title": "Standup - 2026/09/10 Notes"},
                {**file(2), "title": "Standup - 2026/09/11 Notes"},
            ]
        return ExternalMcpToolResult(False, {"files": files}, False)

    service = DriveOwnerSearchService(store=store, transport=SimpleNamespace(read_tool=read))
    state = await service.create(
        user_id="owner",
        client_request_id=str(uuid4()),
        query="Find notes from September 10",
        plan={
            "terms": ["Standup"],
            "mode": "find",
            "date_from": "2026-09-10",
            "date_to": "2026-09-10",
            "file_time_field": "createdTime",
            "time_intent": "file_activity",
        },
        background_consent=True,
        require_current=AsyncMock(),
    )
    assert await service.run_one(user_id="owner", job_id=state["jobId"]) == "completed"
    files = (await store.results(user_id="owner", job_id=state["jobId"]))["files"]
    assert [item["id"] for item in files] == ["file-1"]
    assert len(calls) == 4
    assert "fullText contains" in calls[2][1]["query"]
    assert "createdTime >=" not in calls[2][1]["query"]


@pytest.mark.parametrize("primary_has_match", [False, True])
async def test_all_terms_search_never_broadens_after_empty_results(
    store, monkeypatch, primary_has_match
):
    monkeypatch.setattr(
        "hushh_mcp.services.drive_owner_search_service.wake_drive_work", AsyncMock()
    )
    calls = []

    async def read(*, tool_name, arguments, **_):
        if tool_name == "list_shared_drives":
            return ExternalMcpToolResult(False, {"drives": []}, False)
        query = arguments["query"]
        calls.append(query)
        files = [file(1)] if primary_has_match or ") or (" in query else []
        return ExternalMcpToolResult(False, {"files": files}, False)

    service = DriveOwnerSearchService(store=store, transport=SimpleNamespace(read_tool=read))
    state = await service.create(
        user_id="owner",
        client_request_id=str(uuid4()),
        query="Find bank statements",
        plan={"terms": ["bank", "statement"], "mode": "find"},
        background_consent=True,
        require_current=AsyncMock(),
    )
    assert await service.run_one(user_id="owner", job_id=state["jobId"]) == "completed"
    assert len(calls) == 1
    assert "fullText contains 'bank'" in calls[0]
    assert "fullText contains 'statement'" in calls[0]
    assert ") or (" not in calls[0]
    assert (await store.status(user_id="owner", job_id=state["jobId"]))["matched"] == int(
        primary_has_match
    )


@pytest.mark.parametrize("query", ["a" * 2048, "é" * 1024])
def test_request_accepts_2048_byte_boundary(query):
    assert DriveOwnerSearchService._request(query, "UTC")["query"] == query


@pytest.mark.parametrize("query", ["a" * 2049, "é" * 1025])
def test_request_rejects_over_2048_bytes(query):
    with pytest.raises(DriveReadError, match="invalid_argument"):
        DriveOwnerSearchService._request(query, "UTC")


async def test_search_telemetry_contains_only_opaque_id_closed_states_and_counts(store, caplog):
    state, _ = await create(store)
    caplog.set_level("INFO", logger="drive_owner_search")
    service = DriveOwnerSearchService(
        store=store,
        transport=SimpleNamespace(
            read_tool=AsyncMock(
                return_value=ExternalMcpToolResult(False, {"files": [file(1)]}, False)
            )
        ),
    )
    assert await service.run_one(user_id="owner", job_id=state["jobId"], max_pages=1) == "queued"
    messages = [
        record.getMessage() for record in caplog.records if record.name == "drive_owner_search"
    ]
    assert len(messages) == 2
    assert all(
        f"drive_op={correlation_tag(state['jobId'])}" in message and "elapsed_ms=" in message
        for message in messages
    )
    assert "phase=user status=received files=1" in messages[0]
    assert "status=queued pages=1 matched=1" in messages[1]
    assert all("Synthetic" not in message and "file-1" not in message for message in messages)


async def test_search_reads_never_write_a_connection_row_without_a_catalog_row(store):
    """Production 2026-09-27: GET /searches returned 500 on every load.

    Production has no google_drive catalog row (Drive is UAT-only). list() and
    status() took the connection lock, whose placeholder upsert violated
    user_external_connector_connections_connector_id_fkey. A GET must not write.
    """
    from hushh_mcp.services.external_connector_lifecycle_store import ConnectorLifecycleError

    sql(store, "DELETE FROM user_external_connector_connections")
    sql(store, "DELETE FROM external_mcp_connectors WHERE connector_id='google_drive'")
    missing = str(uuid4())

    assert await store.list(user_id="owner") == {"jobs": []}
    with pytest.raises(DriveReadError, match="search_not_found"):
        await store.status(user_id="owner", job_id=missing)
    with pytest.raises(DriveReadError, match="connection_changed"):
        await store.results(user_id="owner", job_id=missing)
    rows = sql(store, "SELECT count(*) FROM user_external_connector_connections").scalar()
    assert rows == 0

    # Negative control: the write path still takes _lock() and reproduces the
    # exact production failure in this environment.
    with pytest.raises(ConnectorLifecycleError, match="connector_storage_unavailable"):
        await store.stop(user_id="owner", job_id=missing)
