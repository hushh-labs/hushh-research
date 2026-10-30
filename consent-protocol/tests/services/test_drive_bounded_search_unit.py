"""Bounded transaction searches keep native ordering and complete corpus coverage."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services import drive_owner_search_service as module
from hushh_mcp.services.drive_owner_search_service import (
    DriveOwnerSearchService,
    compile_request_queries,
)


def _file(identity, day, **extra):
    return {
        "id": identity,
        "title": identity,
        "mimeType": "application/pdf",
        "modifiedTime": f"2026-10-{day:02d}T00:00:00Z",
        "createdTime": f"2026-10-{day:02d}T00:00:00Z",
        "capabilities": {"canShare": True},
        **extra,
    }


def _checkpoint(**extra):
    return {
        "request_origin_id": "request",
        "request_explicit_dates": True,
        "request_file_kind": "document",
        "request_result_limit": 2,
        "request_order_field": "modifiedTime",
        "request_direct_originals": True,
        "request_subject_terms": [],
        "requested_period": {"start": "2026-10-01", "end": "2026-10-31", "timezone": "UTC"},
        "arguments": {"query": "mimeType = 'application/pdf'", "orderBy": "modifiedTime desc"},
        "phase": "user",
        "page_token": None,
        "drive_page_token": None,
        "drives": [],
        "drive_index": 0,
        "seen_tokens": [],
        "drive_tokens": [],
        "coverage_counts": {},
        "folder_queue": [],
        **extra,
    }


def _service(pages):
    async def read(**kwargs):
        return SimpleNamespace(payload=pages.pop(0), is_error=False, truncated=False)

    reader = AsyncMock(side_effect=read)
    return DriveOwnerSearchService(
        store=SimpleNamespace(), transport=SimpleNamespace(read_tool=reader)
    ), reader


@pytest.mark.parametrize("order_field", ["modifiedTime", "createdTime"])
def test_latest_n_queries_rank_originals_without_alias_expansion(order_field):
    plan = {
        "mode": "find",
        "file_kind": "any",
        "sort": "recent",
        "result_limit": 100,
        "file_time_field": order_field,
    }
    purpose = {
        "purpose": "Latest 100 files",
        "periodStart": "2026-01-01",
        "periodEnd": "2026-10-09",
    }
    queries, _ = compile_request_queries(plan, purpose, "UTC")
    args = queries[0]["arguments"]
    assert args["orderBy"] == f"{order_field} desc"
    assert "mimeType != 'application/vnd.google-apps.folder'" in args["query"]
    assert "mimeType != 'application/vnd.google-apps.shortcut'" in args["query"]
    topical, _ = compile_request_queries({**plan, "terms": ["bank"]}, purpose, "UTC")
    assert "fullText contains 'bank'" in topical[0]["arguments"]["query"]
    assert "mimeType !=" not in topical[0]["arguments"]["query"]


@pytest.mark.asyncio
@pytest.mark.parametrize("authority_mode", ["owner", "trusted_auto"])
async def test_bounded_requests_freeze_selection_contract_and_use_full_inline_page(
    monkeypatch, authority_mode
):
    store = SimpleNamespace(
        clear_legacy_completed_request=AsyncMock(),
        by_client=AsyncMock(return_value=None),
        create=AsyncMock(return_value=({"jobId": "job"}, True)),
        align_request_expiry=AsyncMock(),
    )
    service = DriveOwnerSearchService(store=store, transport=SimpleNamespace())
    service.run_one = AsyncMock()
    service.status = AsyncMock(return_value={"status": "queued"})
    monkeypatch.setattr(module, "wake_drive_work", AsyncMock())
    await service.create_for_request(
        user_id="owner",
        request_id="request",
        request_revision=7,
        authority_mode=authority_mode,
        purpose={
            "purpose": "Latest 100 documents",
            "periodStart": "2026-01-01",
            "periodEnd": "2026-10-09",
        },
        plan={"mode": "find", "file_kind": "document", "sort": "recent", "result_limit": 100},
        require_current=AsyncMock(),
    )
    checkpoint = store.create.await_args.kwargs["checkpoint"]
    assert checkpoint["request_result_limit"] == 100
    assert checkpoint["request_order_field"] == "modifiedTime"
    assert checkpoint["request_direct_originals"] is True
    assert checkpoint["authority_mode"] == authority_mode
    assert checkpoint["coverage_manifest"]["folderDiscovery"] == "none_direct_originals"
    assert "initial_page_size" not in service.run_one.await_args.kwargs


@pytest.mark.asyncio
@pytest.mark.parametrize("authority_mode", ["owner", "trusted_auto"])
async def test_native_cutoff_preserves_ties_dedup_dates_and_every_shared_drive(authority_mode):
    pages = [
        {
            "files": [
                _file("outside-period", 31),
                _file("newest", 20, capabilities={"canShare": False}),
                _file("newest", 20, capabilities={"canShare": False}),
            ],
            "nextPageToken": "p2",
        },
        {"files": [_file("second", 19)], "nextPageToken": "p3"},
        {"files": [_file("tie", 19), _file("older", 18)], "nextPageToken": "skip-older-user-pages"},
        {"drives": [{"id": "drive-a"}], "nextPageToken": "drives-2"},
        {
            "files": [
                _file("shared-newest", 22),
                _file("shared-second", 21),
                _file("shared-older", 20),
            ],
            "nextPageToken": "skip-older-drive-pages",
        },
        {"drives": [{"id": "drive-b"}]},
        {"files": [_file("last-drive-newest", 24)]},
    ]
    service, reader = _service(pages)
    checkpoint = _checkpoint(authority_mode=authority_mode)
    checkpoint["requested_period"]["end"] = "2026-10-30"
    results = []
    for index in range(7):
        checkpoint, files, incomplete, done = await service._page(
            {"user_id": "owner", "checkpoint": checkpoint}
        )
        results.extend(file["id"] for file in files)
        assert not incomplete
        assert done is (index == 6)
        if index == 1:
            assert checkpoint["page_token"] == "p3"  # N reached; equal timestamps may follow.
    assert "outside-period" not in results
    assert "tie" in results and "last-drive-newest" in results
    assert checkpoint["coverage_counts"]["boundedCorporaCompleted"] == 2
    assert checkpoint["request_rank_pruned"] is True
    search_args = [
        call.kwargs["arguments"]
        for call in reader.await_args_list
        if call.kwargs["tool_name"] == "search_files"
    ]
    assert [args.get("driveId") for args in search_args] == [None, None, None, "drive-a", "drive-b"]
    assert all(args["pageSize"] == 100 for args in search_args)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "fault", ["incomplete", "missing-time", "invalid-time", "out-of-order", "topical"]
)
async def test_unproven_native_order_never_ends_a_corpus_early(fault):
    first = {"files": [_file("newest", 20)], "nextPageToken": "p2"}
    if fault == "incomplete":
        first["incompleteSearch"] = True
    if fault in {"missing-time", "invalid-time"}:
        first["files"][0]["modifiedTime"] = None if fault == "missing-time" else "not-a-time"
    second = {
        "files": [_file("second", 21 if fault == "out-of-order" else 19), _file("older", 18)],
        "nextPageToken": "p3",
    }
    service, _ = _service([first, second])
    checkpoint = _checkpoint(request_direct_originals=fault != "topical")
    checkpoint, _, _, done = await service._page({"user_id": "owner", "checkpoint": checkpoint})
    assert not done
    checkpoint, _, _, done = await service._page({"user_id": "owner", "checkpoint": checkpoint})
    assert not done and checkpoint["phase"] == "user" and checkpoint["page_token"] == "p3"


@pytest.mark.asyncio
async def test_direct_scope_never_expands_unexpected_shortcuts_or_folders():
    service, reader = _service(
        [
            {
                "files": [
                    _file(
                        "alias",
                        21,
                        mimeType=module.SHORTCUT_MIME,
                        shortcutDetails={"targetId": "private-target"},
                    ),
                    _file("folder", 20, mimeType=module.FOLDER_MIME),
                    _file("original", 19),
                ],
                "nextPageToken": "p2",
            }
        ]
    )
    checkpoint, files, incomplete, done = await service._page(
        {"user_id": "owner", "checkpoint": _checkpoint()}
    )
    assert [file["id"] for file in files] == ["original"]
    assert incomplete and not done and not checkpoint["folder_queue"]
    assert reader.await_count == 1
