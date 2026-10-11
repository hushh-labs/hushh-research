from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services import consent_center_service as module
from hushh_mcp.services.consent_center_service import ConsentCenterService


def entry(identifier, kind, role, status, issued):
    return {
        "id": f"answer_request:{identifier}",
        "request_id": identifier,
        "kind": kind,
        "status": status,
        "action": "ANSWER_REQUEST_REVIEW",
        "scope": None,
        "counterpart_label": "Connected person",
        "issued_at": issued,
        "metadata": {"request_source": "answer_request", "role": role, "request_status": status},
    }


@pytest.mark.asyncio
async def test_answer_received_sent_history_counts_and_connections_mode_are_separate(monkeypatch):
    monkeypatch.setattr(module, "_consent_summary_v2_enabled", lambda: True)
    buckets = {
        "incoming_requests": [entry("receive", "incoming_request", "owner", "answering", 30)],
        "outgoing_requests": [
            entry("send-1", "outgoing_request", "owner", "approved", 10),
            entry("send-2", "outgoing_request", "requester", "awaiting_owner", 20),
        ],
        "history": [entry("history", "history", "requester", "cancelled", 5)],
        "active_grants": [],
        "invites": [],
    }
    svc = ConsentCenterService.__new__(ConsentCenterService)
    svc._marketplace_center = svc._drive_center = None
    svc._answer_center = SimpleNamespace(collect=AsyncMock(return_value=buckets))
    svc._location_buckets_async = AsyncMock(return_value={key: [] for key in buckets})
    for method in [
        "_load_investor_pending_entries",
        "_load_investor_active_entries",
        "_load_investor_previous_entries",
        "_incoming_connection_request_entries",
        "_load_connection_entries_for_actor",
    ]:
        setattr(svc, method, AsyncMock(return_value=[]))
    svc._present_pending_bundles = AsyncMock(side_effect=lambda user, entries: entries)
    svc._incoming_connection_request_count = AsyncMock(return_value=0)
    received = await svc.list_center(
        "owner-a", actor="investor", surface="pending", request_view="received"
    )
    assert received["total"] == 1
    assert [row["id"] for row in received["items"]] == ["answer_request:receive"]
    first = await svc.list_center(
        "owner-a", actor="investor", surface="pending", request_view="sent", limit=1, page=1
    )
    second = await svc.list_center(
        "owner-a", actor="investor", surface="pending", request_view="sent", limit=1, page=2
    )
    assert first["total"] == second["total"] == 2
    assert first["has_more"] is True and second["has_more"] is False
    assert [row["id"] for row in first["items"] + second["items"]] == [
        "answer_request:send-2",
        "answer_request:send-1",
    ]
    previous = await svc.list_center("owner-a", actor="investor", surface="previous")
    assert [row["id"] for row in previous["items"]] == ["answer_request:history"]
    summary = await svc.get_center_summary("owner-a", actor="investor")
    assert summary["counts"] == {"pending": 1, "active": 0, "previous": 1}
    svc._answer_center.collect.reset_mock()
    connections = await svc.list_center(
        "owner-a", actor="investor", surface="pending", mode="connections"
    )
    assert connections["items"] == []
    svc._answer_center.collect.assert_not_called()
