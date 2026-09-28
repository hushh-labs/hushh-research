"""Provider metadata search for a request includes date-named shortcut targets."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from hushh_mcp.services.drive_owner_search_service import (
    DriveOwnerSearchService,
    compile_request_queries,
)
from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult


def test_request_plan_keeps_all_candidate_file_dates_and_shortcut_mime():
    today = datetime.now(UTC).date()
    start = (today - timedelta(days=90)).isoformat()
    end = today.isoformat()
    queries, period = compile_request_queries(
        {
            "mode": "find",
            "terms": ["standup", "notes"],
            "file_kind": "document",
            "time_intent": "file_activity",
            "file_time_field": "modifiedTime",
            "date_from": start,
            "date_to": end,
        },
        {"purpose": "Standup notes from last 3 months", "periodStart": start, "periodEnd": end},
        "UTC",
    )
    query = queries[0]["arguments"]["query"]
    assert "standup" in query and "notes" in query
    assert "application/vnd.google-apps.document" in query
    assert "application/vnd.google-apps.shortcut" in query
    assert "modifiedTime" not in query
    assert period == {"start": start, "end": end, "timezone": "UTC"}


@pytest.mark.asyncio
async def test_request_shortcut_uses_verified_target_and_alias_date():
    today = datetime.now(UTC).date()
    old = (today - timedelta(days=120)).isoformat() + "T00:00:00Z"
    calls = []

    async def read(*, user_id, tool_name, arguments):
        assert user_id == "owner"
        calls.append((tool_name, arguments))
        if tool_name == "get_file_metadata":
            assert arguments == {"fileId": "target-standup-note"}
            return ExternalMcpToolResult(
                False,
                {
                    "file": {
                        "id": "target-standup-note",
                        "title": "Hushh Team Standup Notes",
                        "mimeType": "application/vnd.google-apps.document",
                        "modifiedTime": old,
                    }
                },
                False,
            )
        assert tool_name == "search_files"
        return ExternalMcpToolResult(
            False,
            {
                "files": [
                    {
                        "id": "shortcut-standup-note",
                        "title": f"Hushh Team Standup {today.isoformat()} Notes by Gemini",
                        "mimeType": "application/vnd.google-apps.shortcut",
                        "modifiedTime": old,
                        "shortcutDetails": {
                            "targetId": "target-standup-note",
                            "targetMimeType": "application/vnd.google-apps.document",
                        },
                    }
                ],
                "incompleteSearch": False,
            },
            False,
        )

    service = DriveOwnerSearchService(transport=SimpleNamespace(read_tool=read))
    arguments = {"query": "name contains 'Standup'", "orderBy": "createdTime desc"}
    checkpoint = {
        "request_origin_id": "request-id",
        "arguments": arguments,
        "queries": [{"arguments": arguments}],
        "query_index": 0,
        "requested_period": {
            "start": (today - timedelta(days=90)).isoformat(),
            "end": today.isoformat(),
            "timezone": "UTC",
        },
        "phase": "user",
        "page_token": None,
        "drive_page_token": None,
        "drives": [],
        "drive_index": 0,
        "seen_tokens": [],
        "drive_tokens": [],
    }
    _, files, incomplete, _ = await service._page({"user_id": "owner", "checkpoint": checkpoint})
    assert incomplete is False
    assert [(file["id"], file["mimeType"]) for file in files] == [
        ("target-standup-note", "application/vnd.google-apps.document")
    ]
    assert files[0]["shortcutName"].startswith("Hushh Team Standup")
    assert [call[0] for call in calls] == ["search_files", "get_file_metadata"]
