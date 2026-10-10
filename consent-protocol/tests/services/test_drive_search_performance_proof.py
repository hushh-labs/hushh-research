"""Deterministic provider-work proof; this is not a network latency benchmark.

Run with ``pytest -q -s tests/services/test_drive_search_performance_proof.py``.
Synthetic corpora contain 10,000 originals and never call Drive or an LLM.
"""

import copy
import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from hushh_mcp.services.drive_owner_search_service import (
    DriveOwnerSearchService,
    compile_request_queries,
)
from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult


def synthetic_corpora(*, tied_boundary=False, rejected_newest=False):
    now = datetime(2026, 9, 1, tzinfo=UTC)
    corpora = {"user": [], "shared-drive": []}
    for number in range(10_000):
        # Interleave corpora: the globally newest 100 includes both sources.
        # Boundary ties cross provider pages and must be exhausted before
        # pruning, irrespective of provider tie ordering.
        at_boundary = tied_boundary and 75 <= number < 350
        age = 75 if at_boundary else number
        timestamp = (now - timedelta(seconds=age)).isoformat()
        corpus = "user" if number % 2 == 0 else "shared-drive"
        name = (
            "Historical 2020-01-01"
            if rejected_newest and number < 250
            else f"Synthetic document {number}"
        )
        corpora[corpus].append(
            {
                # Reverse the tied IDs: globally preferred tie winners arrive
                # on the second page, so stopping at the first N is incorrect.
                "id": f"synthetic-tie-{10_000 - number:05}"
                if at_boundary
                else f"synthetic-{number:05}",
                "title": name,
                "mimeType": "application/pdf",
                "createdTime": timestamp,
                "modifiedTime": timestamp,
                "capabilities": {"canShare": True},
            }
        )
    return corpora


class SyntheticDrive:
    def __init__(self, corpora):
        self.corpora = corpora
        self.calls = 0
        self.rows = 0

    async def read_tool(self, *, user_id, tool_name, arguments):
        assert user_id == "synthetic-owner"
        self.calls += 1
        if tool_name == "list_shared_drives":
            payload = {"drives": [{"id": "shared-drive"}]}
        else:
            assert tool_name == "search_files"
            assert arguments["orderBy"] == "modifiedTime desc"
            assert "folderId" not in arguments
            corpus = arguments.get("driveId", "user")
            offset = int(arguments.get("pageToken", "0"))
            end = offset + arguments["pageSize"]
            files = self.corpora[corpus][offset:end]
            self.rows += len(files)
            payload = {"files": copy.deepcopy(files), "incompleteSearch": False}
            if end < len(self.corpora[corpus]):
                payload["nextPageToken"] = str(end)
        return ExternalMcpToolResult(payload=payload, is_error=False, truncated=False)


async def collect(corpora, *, authority, bounded):
    plan = {
        "mode": "find",
        "file_kind": "document",
        "file_time_field": "modifiedTime",
        "sort": "recent",
        **({"result_limit": 100} if bounded else {}),
    }
    queries, period = compile_request_queries(
        plan,
        {
            "purpose": "Latest 100 documents",
            "periodStart": "2026-01-01",
            "periodEnd": "2026-12-31",
        },
        "UTC",
    )
    checkpoint = {
        "arguments": queries[0]["arguments"],
        "queries": queries,
        "query_index": 0,
        "request_origin_id": "synthetic-request",
        "request_explicit_dates": True,
        "request_file_kind": "document",
        "request_subject_terms": [],
        "request_exact_title": None,
        "request_notes": False,
        "request_result_limit": 100 if bounded else None,
        "request_order_field": "modifiedTime",
        "request_direct_originals": bounded,
        "requested_period": period,
        "authority_mode": authority,
        "coverage_counts": {},
        "folder_queue": [],
        "folder_digests": [],
        "phase": "user",
        "page_token": None,
        "drive_page_token": None,
        "drives": [],
        "drive_index": 0,
        "seen_tokens": [],
        "drive_tokens": [],
    }
    transport = SyntheticDrive(corpora)
    service = DriveOwnerSearchService(store=SimpleNamespace(), transport=transport)
    files = {}
    for _ in range(110):
        checkpoint, page, incomplete, done = await service._page(
            {"user_id": "synthetic-owner", "checkpoint": checkpoint}
        )
        assert not incomplete
        files.update((item["id"], item) for item in page)
        if done:
            return list(files.values()), checkpoint, transport
    pytest.fail("Synthetic scan did not terminate within expected provider calls")


def top_hundred(files):
    by_id = sorted(files, key=lambda item: item["id"])
    return [
        item["id"]
        for item in sorted(
            by_id,
            key=lambda item: datetime.fromisoformat(item["modifiedTime"]),
            reverse=True,
        )[:100]
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("authority", ["owner", "trusted_auto"])
@pytest.mark.parametrize("case", ["normal", "boundary_ties", "rejected_newest"])
async def test_latest_hundred_retains_global_results_with_less_provider_work(authority, case):
    corpora = synthetic_corpora(
        tied_boundary=case == "boundary_ties", rejected_newest=case == "rejected_newest"
    )
    exhaustive, _, baseline = await collect(corpora, authority=authority, bounded=False)
    bounded, checkpoint, optimized = await collect(corpora, authority=authority, bounded=True)

    # Independent full-corpus oracle verifies correctness, not just fewer calls.
    expected = [
        item
        for files in corpora.values()
        for item in files
        if not item["title"].startswith("Historical")
    ]
    assert top_hundred(bounded) == top_hundred(expected) == top_hundred(exhaustive)
    assert checkpoint["coverage_counts"]["boundedCorporaCompleted"] == 2
    assert baseline.calls == 101 and baseline.rows == 10_000
    expected_calls, expected_rows = (7, 600) if case == "rejected_newest" else (5, 400)
    assert (optimized.calls, optimized.rows) == (expected_calls, expected_rows)
    print(
        json.dumps(
            {
                "proof": "synthetic_provider_work_not_wall_clock",
                "authority": authority,
                "case": case,
                "requested": 100,
                "corpus_size": 10_000,
                "baseline_calls": baseline.calls,
                "optimized_calls": optimized.calls,
                "baseline_rows": baseline.rows,
                "optimized_rows": optimized.rows,
                "same_global_top_100": True,
            },
            sort_keys=True,
        )
    )
