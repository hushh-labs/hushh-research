"""Finite worker admission and aggregate-only reporting."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from hushh_mcp.services import owner_placement_guard
from hushh_mcp.services.drive_collection_sync import DriveCollectionSync
from hushh_mcp.services.drive_document_worker import DriveDocumentWorker
from hushh_mcp.services.drive_packet_worker import DrivePacketWorker
from hushh_mcp.services.drive_worker_limits import packet_slots, semantic_slots

pytestmark = pytest.mark.usefixtures("shared_hub_owner")


@pytest.mark.parametrize(
    "mode,code",
    [("byoc", "AGENT_PRIVATE_RUNTIME_REQUIRED"), ("unknown", "AGENT_HOSTING_UNAVAILABLE")],
)
@pytest.mark.parametrize("lane", ["collection", "facts", "packet", "facts_sweep"])
async def test_new_worker_lanes_refuse_before_claim_credentials_or_plaintext(
    monkeypatch, mode, code, lane
):
    monkeypatch.setattr(owner_placement_guard, "pod_mode", lambda: False)
    monkeypatch.setattr(
        owner_placement_guard, "get_owner_hosting_mode", AsyncMock(return_value=mode)
    )
    store = SimpleNamespace(
        due_owners=AsyncMock(return_value=["private-owner"]),
        claim=AsyncMock(return_value=None),
        enqueue=AsyncMock(return_value=0),
        claim_packet=AsyncMock(return_value=None),
    )
    oauth = SimpleNamespace(current_credential=AsyncMock())
    assessor = AsyncMock()
    if lane == "collection":
        worker = DriveCollectionSync(store=store, oauth=oauth, adapter=SimpleNamespace())
        call = worker.run_one
    else:
        worker = DrivePacketWorker(
            facts_store=store,
            packet_store=store,
            page_assessor=assessor,
            constructor=assessor,
            policy=lambda: "synthetic",
        )
        call = worker.run_facts_one if lane == "facts" else worker.run_packet_one
    if lane == "facts_sweep":
        store.due_owners = AsyncMock(return_value=["private-owner"])
        worker.run_facts_one = assessor
        assert await worker.run(max_jobs=1) == {"unavailable": 1}
    else:
        with pytest.raises(HTTPException) as failure:
            await call(user_id="private-owner")
        assert failure.value.detail["code"] == code
    store.claim.assert_not_awaited()
    store.enqueue.assert_not_awaited()
    store.claim_packet.assert_not_awaited()
    oauth.current_credential.assert_not_awaited()
    assessor.assert_not_awaited()


@pytest.fixture(autouse=True)
def enable_package_lanes_for_existing_worker_tests(monkeypatch):
    monkeypatch.setenv("DRIVE_AGENT_PACKAGES_ENABLED", "true")


async def test_indexing_kill_switch_skips_collection_and_packet_workers(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "false")
    monkeypatch.setenv("CONNECTOR_UAT_ALL_USERS", "true")
    service = SimpleNamespace(run_one=AsyncMock())
    collection = SimpleNamespace(run=AsyncMock())
    packets = SimpleNamespace(run=AsyncMock())
    worker = DriveDocumentWorker(service, collection_sync=collection, packet_worker=packets)
    worker.due_owners = AsyncMock()

    assert await worker.run() == {
        "schema_version": "drive.worker.v1",
        "outcomes": {"disabled": 1},
    }
    worker.due_owners.assert_not_awaited()
    service.run_one.assert_not_awaited()
    collection.run.assert_not_awaited()
    packets.run.assert_not_awaited()


async def test_package_switch_keeps_selected_documents_running(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner")
    monkeypatch.setenv("DRIVE_AGENT_PACKAGES_ENABLED", "false")
    service = SimpleNamespace(run_one=AsyncMock(return_value={"status": "ready"}))
    collection = SimpleNamespace(run=AsyncMock())
    packets = SimpleNamespace(run=AsyncMock())
    worker = DriveDocumentWorker(service, collection_sync=collection, packet_worker=packets)
    worker.due_owners = AsyncMock(return_value=["owner"])
    monkeypatch.setattr("hushh_mcp.services.drive_work_wake.wake_drive_work", AsyncMock())

    result = await worker.run(max_jobs=1)

    assert result == {"schema_version": "drive.worker.v1", "outcomes": {"ready": 1}}
    service.run_one.assert_awaited_once_with(user_id="owner", prefer_profile_upgrade=True)
    collection.run.assert_not_awaited()
    packets.run.assert_not_awaited()


def test_package_switch_avoids_constructing_collection_and_packet_lanes(monkeypatch):
    monkeypatch.setenv("DRIVE_AGENT_PACKAGES_ENABLED", "false")
    service = SimpleNamespace()
    monkeypatch.setattr(
        "hushh_mcp.services.drive_document_worker.DriveIngestionService",
        lambda **kwargs: service,
    )
    monkeypatch.setattr("hushh_mcp.services.drive_document_worker.LocalDocumentProcessor", object)

    worker = DriveDocumentWorker()

    assert worker.service is service
    assert worker.collection_sync is None
    assert worker.packet_worker is None


async def test_worker_requires_explicit_rollout_for_each_owner(monkeypatch, shared_hub_owner):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "approved-owner")
    service = SimpleNamespace(
        run_one=AsyncMock(return_value={"status": "ready", "secret": "PRIVATE"})
    )
    worker = DriveDocumentWorker(service)
    worker.due_owners = AsyncMock(return_value=["approved-owner", "other-owner"])
    result = await worker.run(max_jobs=2)
    assert result == {"schema_version": "drive.worker.v1", "outcomes": {"ready": 1, "disabled": 1}}
    worker.due_owners.assert_awaited_once_with(2, reserve_profile_upgrade=True)
    service.run_one.assert_awaited_once_with(user_id="approved-owner", prefer_profile_upgrade=True)
    assert "owner" not in str(result) and "PRIVATE" not in str(result)


@pytest.mark.parametrize(
    "bounds", [{"max_jobs": 0}, {"max_jobs": 21}, {"max_jobs": True}, {"deadline_seconds": 541}]
)
async def test_worker_rejects_unbounded_batches(bounds):
    with pytest.raises(ValueError):
        await DriveDocumentWorker(SimpleNamespace()).run(**bounds)


async def test_busy_extraction_reserves_parallel_facts_and_packet_budget(
    monkeypatch, shared_hub_owner
):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner")
    monkeypatch.setenv("DRIVE_SEMANTIC_SLOTS", "2")
    semantic_started = asyncio.Event()

    async def extraction(**kwargs):
        await asyncio.wait_for(semantic_started.wait(), timeout=1)
        return {"status": "ready"}

    async def semantics(**kwargs):
        assert kwargs == {"max_jobs": 2, "deadline_seconds": 160}
        semantic_started.set()
        return {"facts_complete": 1, "packet_queued": 1}

    service = SimpleNamespace(run_one=AsyncMock(side_effect=extraction))
    discovery = SimpleNamespace(run=AsyncMock(return_value={"outcomes": {"synced": 2}}))
    packet_worker = SimpleNamespace(run=AsyncMock(side_effect=semantics))
    worker = DriveDocumentWorker(service, collection_sync=discovery, packet_worker=packet_worker)
    worker.due_owners = AsyncMock(return_value=["owner"])
    wake = AsyncMock()
    monkeypatch.setattr("hushh_mcp.services.drive_work_wake.wake_drive_work", wake)
    result = await worker.run(max_jobs=8, deadline_seconds=160)
    assert service.run_one.await_count == 4
    flags = [call.kwargs["prefer_profile_upgrade"] for call in service.run_one.await_args_list]
    # At least half of the owner's slots prefer the profile-upgrade lane, and
    # the ordinary queue keeps a slot of its own.
    assert flags.count(True) >= len(flags) / 2 and False in flags
    discovery.run.assert_awaited_once_with(max_jobs=2, deadline_seconds=100)
    packet_worker.run.assert_awaited_once()
    assert result["outcomes"] == {"ready": 4, "synced": 2, "queued": 2}
    wake.assert_awaited_once_with("documents")


@pytest.mark.parametrize("slots", [1, 4])
async def test_single_owner_keeps_owner_slots_in_flight_and_discovery_still_runs(
    monkeypatch, slots
):
    """One large Drive must not process one file at a time per sweep."""
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner")
    monkeypatch.setenv("DRIVE_EXTRACTION_OWNER_SLOTS", str(slots))
    in_flight, peak = 0, 0

    async def extraction(**kwargs):
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        await asyncio.sleep(0.01)
        in_flight -= 1
        return {"status": "queued"}

    service = SimpleNamespace(run_one=AsyncMock(side_effect=extraction))
    discovery = SimpleNamespace(run=AsyncMock(return_value={"outcomes": {"synced": 1}}))
    packet_worker = SimpleNamespace(run=AsyncMock(return_value={"idle": 1}))
    worker = DriveDocumentWorker(service, collection_sync=discovery, packet_worker=packet_worker)
    worker.due_owners = AsyncMock(return_value=["owner"])
    monkeypatch.setattr("hushh_mcp.services.drive_work_wake.wake_drive_work", AsyncMock())

    result = await worker.run(max_jobs=20, deadline_seconds=160)

    assert service.run_one.await_count == 12
    assert peak == slots
    assert result["outcomes"]["queued"] == 12
    discovery.run.assert_awaited_once_with(max_jobs=2, deadline_seconds=100)


async def test_unsupported_live_file_does_not_block_next_file_for_same_owner(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner")
    monkeypatch.setenv("DRIVE_EXTRACTION_OWNER_SLOTS", "1")
    service = SimpleNamespace(
        run_one=AsyncMock(
            side_effect=[
                {"status": "unsupported"},
                {"status": "ready"},
                {"status": "not_ready"},
            ]
        )
    )
    worker = DriveDocumentWorker(service)
    worker.due_owners = AsyncMock(return_value=["owner"])
    monkeypatch.setattr("hushh_mcp.services.drive_work_wake.wake_drive_work", AsyncMock())

    result = await worker.run(max_jobs=4)

    assert service.run_one.await_count == 3
    assert result["outcomes"] == {"unsupported": 1, "ready": 1, "not_ready": 1}


async def test_unsupported_only_batch_self_wakes_but_stops_at_budget(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner")
    service = SimpleNamespace(run_one=AsyncMock(return_value={"status": "unsupported"}))
    worker = DriveDocumentWorker(service)
    worker.due_owners = AsyncMock(return_value=["owner"])
    wake = AsyncMock()
    monkeypatch.setattr("hushh_mcp.services.drive_work_wake.wake_drive_work", wake)

    result = await worker.run(max_jobs=3)

    assert result["outcomes"] == {"unsupported": 3}
    assert service.run_one.await_count == 3
    wake.assert_awaited_once_with("documents")


async def test_reserved_upgrade_slot_prefers_upgrade_for_selected_owner(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "upgrade-owner,due-owner")
    service = SimpleNamespace(run_one=AsyncMock(return_value={"status": "ready"}))
    worker = DriveDocumentWorker(service)
    worker.due_owners = AsyncMock(return_value=["upgrade-owner", "due-owner"])

    await worker.run(max_jobs=2)

    worker.due_owners.assert_awaited_once_with(2, reserve_profile_upgrade=True)
    assert [call.kwargs for call in service.run_one.await_args_list] == [
        {"user_id": "upgrade-owner", "prefer_profile_upgrade": True},
        {"user_id": "due-owner", "prefer_profile_upgrade": False},
    ]


async def test_single_owner_uses_bounded_sweep_for_packet_phase_progress(monkeypatch):
    """A large owner must not stall after one facts and one packet phase."""
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner")
    monkeypatch.setenv("DRIVE_SEMANTIC_SLOTS", "6")
    service = SimpleNamespace(run_one=AsyncMock(return_value={"status": "ready"}))
    discovery = SimpleNamespace(run=AsyncMock(return_value={"outcomes": {"synced": 2}}))
    packet_worker = SimpleNamespace(
        run=AsyncMock(
            side_effect=[
                {"facts_complete": 1, "packet_queued": 1},
                {"facts_complete": 1, "packet_queued": 1},
                {"facts_complete": 1, "ready": 1},
            ]
        )
    )
    worker = DriveDocumentWorker(service, collection_sync=discovery, packet_worker=packet_worker)
    worker.due_owners = AsyncMock(return_value=["owner"])
    wake = AsyncMock()
    monkeypatch.setattr("hushh_mcp.services.drive_work_wake.wake_drive_work", wake)

    result = await worker.run(max_jobs=20, deadline_seconds=160)

    assert service.run_one.await_count == 12
    assert [call.kwargs["max_jobs"] for call in packet_worker.run.await_args_list] == [6, 4, 2]
    assert sum(result["outcomes"].values()) == 20
    assert result["outcomes"] == {"ready": 13, "synced": 2, "queued": 5}
    wake.assert_awaited_once_with("documents")


@pytest.mark.parametrize(
    "configured,slots", [(None, 12), ("6", 6), ("20", 20), ("21", 2), ("many", 2)]
)
async def test_drain_runs_semantic_slots_beside_the_same_extraction_budget(
    monkeypatch, configured, slots
):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner")
    if configured is None:
        monkeypatch.delenv("DRIVE_SEMANTIC_SLOTS", raising=False)
    else:
        monkeypatch.setenv("DRIVE_SEMANTIC_SLOTS", configured)
    service = SimpleNamespace(run_one=AsyncMock(return_value={"status": "ready"}))
    discovery = SimpleNamespace(run=AsyncMock(return_value={"outcomes": {"synced": 2}}))
    packet_worker = SimpleNamespace(run=AsyncMock(return_value={"idle": slots}))
    worker = DriveDocumentWorker(service, collection_sync=discovery, packet_worker=packet_worker)
    worker.due_owners = AsyncMock(return_value=["owner"])
    monkeypatch.setattr("hushh_mcp.services.drive_work_wake.wake_drive_work", AsyncMock())

    await worker.run(max_jobs=20, deadline_seconds=160)

    # Extraction and discovery keep their 12 and 2 jobs. Facts and packet
    # builds run in their own slots, 12 by default (6 before); an invalid
    # setting fails closed to one facts and one packet slot.
    assert service.run_one.await_count == 12
    discovery.run.assert_awaited_once_with(max_jobs=2, deadline_seconds=100)
    packet_worker.run.assert_awaited_once_with(max_jobs=slots, deadline_seconds=160)


@pytest.mark.parametrize(
    "name,limit,default,maximum",
    [
        ("DRIVE_SEMANTIC_SLOTS", semantic_slots, 12, 20),
        ("DRIVE_PACKET_SLOTS", packet_slots, 3, 8),
    ],
)
def test_semantic_limits_have_safe_defaults_and_fail_closed(
    monkeypatch, name, limit, default, maximum
):
    monkeypatch.delenv(name, raising=False)
    assert limit() == default
    monkeypatch.setenv(name, str(maximum))
    assert limit() == maximum
    for invalid in (str(maximum + 1), "0", "-2", "four"):
        monkeypatch.setenv(name, invalid)
        assert limit() == 1


@pytest.mark.parametrize("outcome", [{"idle": 2}, {"facts_unavailable": 2}, {}])
async def test_semantic_sweep_does_not_spin_when_no_progress(monkeypatch, outcome):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner")
    packet_worker = SimpleNamespace(run=AsyncMock(return_value=outcome))
    worker = DriveDocumentWorker(SimpleNamespace(), packet_worker=packet_worker)
    worker.due_owners = AsyncMock(return_value=[])
    wake = AsyncMock()
    monkeypatch.setattr("hushh_mcp.services.drive_work_wake.wake_drive_work", wake)

    await worker.run(max_jobs=20)

    packet_worker.run.assert_awaited_once()
    wake.assert_not_awaited()


async def test_larger_sweep_still_cancels_all_lanes_at_shared_deadline(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner")
    cancelled = set()

    async def wait(lane):
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.add(lane)

    service = SimpleNamespace(run_one=lambda **kwargs: wait("extraction"))
    discovery = SimpleNamespace(run=lambda **kwargs: wait("discovery"))
    packet_worker = SimpleNamespace(run=lambda **kwargs: wait("semantics"))
    worker = DriveDocumentWorker(service, collection_sync=discovery, packet_worker=packet_worker)
    worker.due_owners = AsyncMock(return_value=["owner"])

    result = await worker.run(max_jobs=20, deadline_seconds=1)

    assert result["outcomes"] == {"deadline": 1}
    assert cancelled == {"extraction", "discovery", "semantics"}


async def test_completed_extraction_wakes_next_semantic_sweep(monkeypatch):
    """Facts can be idle before parallel extraction publishes its first result."""
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner")
    semantic_finished = asyncio.Event()

    async def semantics(**kwargs):
        semantic_finished.set()
        return {"idle": 2}

    async def extraction(**kwargs):
        await semantic_finished.wait()
        return {"status": "ready"}

    worker = DriveDocumentWorker(
        SimpleNamespace(run_one=extraction),
        packet_worker=SimpleNamespace(run=semantics),
    )
    worker.due_owners = AsyncMock(return_value=["owner"])
    wake = AsyncMock()
    monkeypatch.setattr("hushh_mcp.services.drive_work_wake.wake_drive_work", wake)

    result = await worker.run(max_jobs=4)

    assert result["outcomes"] == {"idle": 2, "ready": 2}
    wake.assert_awaited_once_with("documents")


@pytest.mark.parametrize("revoke_during_context", [False, True])
async def test_fact_consolidation_rechecks_authority_after_canonical_read(
    monkeypatch, revoke_during_context
):
    mode = {"value": "shared"}
    monkeypatch.setattr(owner_placement_guard, "pod_mode", lambda: False)
    monkeypatch.setattr(
        owner_placement_guard,
        "get_owner_hosting_mode",
        AsyncMock(side_effect=lambda _owner: mode["value"]),
    )
    job = {
        "user_id": "owner",
        "previous": {},
        "unit_kind": "page",
        "total_pages": 1,
        "pages": [
            {
                "page_number": 1,
                "text": "synthetic",
                "status": "ready",
                "quality": "complete",
                "error_code": None,
            }
        ],
    }
    facts = SimpleNamespace(
        enqueue=AsyncMock(),
        claim=AsyncMock(return_value=job),
        require_current=AsyncMock(),
        commit_batch=AsyncMock(return_value={"complete": True}),
        release=AsyncMock(),
    )

    async def context(**_kwargs):
        if revoke_during_context:
            mode["value"] = "byoc"
        return {"keys": ["synthetic"]}

    fold = AsyncMock(return_value={})
    worker = DrivePacketWorker(
        facts_store=facts,
        packet_store=SimpleNamespace(canonical_key_context=AsyncMock(side_effect=context)),
        page_assessor=AsyncMock(return_value={}),
        consolidator=fold,
        policy=lambda: "synthetic",
        wake=AsyncMock(),
    )
    result = await worker.run_facts_one(user_id="owner")
    if revoke_during_context:
        assert result == "facts_unavailable"
        fold.assert_not_awaited()
        facts.commit_batch.assert_not_awaited()
        facts.release.assert_awaited_once()
    else:
        assert result == "facts_complete"
        fold.assert_awaited_once()
        facts.commit_batch.assert_awaited_once()
