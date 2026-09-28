"""Report and block on connection requests (Google Play user-generated content).

The directory lets a person find someone they do not know and send a request
with a free-text message, so the recipient must be able to report that request
and block the sender from sending another.
"""

from __future__ import annotations

import contextlib
import logging
from typing import Any

import pytest

from hushh_mcp.services.connections_service import (
    CONNECTION_REPORT_REASONS,
    ConnectionsError,
    ConnectionsService,
)


def _service(rows: dict[str, Any], calls: list[tuple[str, dict[str, Any]]]) -> ConnectionsService:
    service = ConnectionsService.__new__(ConnectionsService)

    def _execute_one(sql: str, params: dict[str, Any] | None = None):
        calls.append((sql, dict(params or {})))
        if "INSERT INTO connection_requests" in sql:
            # The guarded insert returns no row when the addressee blocked.
            return None if rows.get("blocked") else {"id": "req-2"}
        if "WHERE status = 'pending'" in sql:
            return None  # no existing pending request
        return {"id": "req-1"}

    service._execute_one = _execute_one  # type: ignore[method-assign]
    service._load_request = lambda request_id, for_update=False: dict(rows["request"])  # type: ignore[method-assign]
    service._transaction = contextlib.nullcontext  # type: ignore[method-assign]
    service._resolve_pending_scope_proposals = lambda *a, **k: None  # type: ignore[method-assign]
    service._record_connection_feed_transition = lambda **k: None  # type: ignore[method-assign]
    service._notify_request_resolved = lambda *a, **k: None  # type: ignore[method-assign]
    service._resolve_scope_handles = lambda owner, handles: []  # type: ignore[method-assign]
    return service


def _request(status: str = "pending") -> dict[str, Any]:
    return {
        "id": "req-1",
        "requester_user_id": "sender",
        "addressee_user_id": "recipient",
        "status": status,
    }


def test_decline_and_block_records_the_block_on_the_request() -> None:
    calls: list[tuple[str, dict[str, Any]]] = []
    service = _service({"request": _request()}, calls)

    result = service.reject_request("recipient", "req-1", block=True)

    assert result == {"status": "rejected", "requestId": "req-1", "blocked": True}
    update_sql, params = next(c for c in calls if "SET status = 'rejected'" in c[0])
    assert "blocked_by" in update_sql
    assert params == {"id": "req-1", "block": True, "blocker": "recipient"}


def test_plain_decline_is_unchanged() -> None:
    calls: list[tuple[str, dict[str, Any]]] = []
    service = _service({"request": _request()}, calls)

    assert service.reject_request("recipient", "req-1") == {
        "status": "rejected",
        "requestId": "req-1",
    }
    _, params = next(c for c in calls if "SET status = 'rejected'" in c[0])
    assert params["block"] is False


def test_block_after_an_earlier_decline_still_records_it() -> None:
    calls: list[tuple[str, dict[str, Any]]] = []
    service = _service({"request": _request("rejected")}, calls)

    result = service.reject_request("recipient", "req-1", block=True)

    assert result["blocked"] is True
    sql, params = calls[-1]
    assert "jsonb_build_object('blocked_by'" in sql
    assert params == {"id": "req-1", "blocker": "recipient"}


def test_a_blocked_sender_cannot_send_another_request() -> None:
    calls: list[tuple[str, dict[str, Any]]] = []
    service = _service({"request": _request(), "blocked": True}, calls)

    with pytest.raises(ConnectionsError) as exc:
        service.create_request("sender", addressee_user_id="recipient", message="hello again")

    assert exc.value.code == "CONNECTION_UNAVAILABLE"
    assert exc.value.status_code == 403
    # Neutral wording: the sender is not told they were blocked.
    assert "block" not in exc.value.message.lower()
    insert_sql, params = next(c for c in calls if "INSERT INTO connection_requests" in c[0])
    assert "blocked.metadata ->> 'blocked_by' = :addressee" in insert_sql
    assert params == {"requester": "sender", "addressee": "recipient", "message": "hello again"}


def test_an_unblocked_request_is_still_created() -> None:
    calls: list[tuple[str, dict[str, Any]]] = []
    service = _service({"request": _request()}, calls)
    service._notify_new_request = lambda *a, **k: None  # type: ignore[attr-defined]

    out = service.create_request("sender", addressee_user_id="recipient", message="hi")

    assert out["id"] == "req-2"


def test_recipient_report_logs_for_review_and_blocks_the_sender(
    caplog: pytest.LogCaptureFixture,
) -> None:
    calls: list[tuple[str, dict[str, Any]]] = []
    service = _service({"request": _request()}, calls)

    with caplog.at_level(logging.WARNING):
        result = service.reject_request("recipient", "req-1", report_reason="harassment")

    assert result == {"status": "rejected", "requestId": "req-1", "blocked": True}
    _, params = next(c for c in calls if "SET status = 'rejected'" in c[0])
    assert params == {"id": "req-1", "block": True, "blocker": "recipient"}
    messages = [r.getMessage() for r in caplog.records]
    assert any(
        "one_connection_request_reported reason=harassment reporter=recipient reported=sender" in m
        for m in messages
    )
    assert any("one_connection_blocked blocker=recipient blocked=sender" in m for m in messages)


def test_report_after_an_earlier_decline_still_blocks_and_logs(
    caplog: pytest.LogCaptureFixture,
) -> None:
    calls: list[tuple[str, dict[str, Any]]] = []
    service = _service({"request": _request("rejected")}, calls)

    with caplog.at_level(logging.WARNING):
        result = service.reject_request("recipient", "req-1", report_reason="spam")

    assert result["blocked"] is True
    assert any(
        "one_connection_request_reported reason=spam" in r.getMessage() for r in caplog.records
    )


def test_only_the_recipient_can_report_and_free_text_reasons_are_rejected() -> None:
    calls: list[tuple[str, dict[str, Any]]] = []
    service = _service({"request": _request()}, calls)

    with pytest.raises(ConnectionsError) as outsider:
        service.reject_request("someone-else", "req-1", report_reason="spam")
    assert outsider.value.code == "CONNECTION_NOT_ADDRESSEE"

    with pytest.raises(ConnectionsError) as bad_reason:
        service.reject_request("recipient", "req-1", report_reason="they were rude to me")
    assert bad_reason.value.code == "CONNECTION_REPORT_REASON_INVALID"
    assert not any("SET status = 'rejected'" in sql for sql, _ in calls)


def test_reject_route_accepts_report_on_the_existing_endpoint() -> None:
    from api.routes.one import connections as routes

    annotation = str(routes.RejectConnectionRequestBody.model_fields["report_reason"].annotation)
    assert all(reason in annotation for reason in CONNECTION_REPORT_REASONS)
    # No new endpoint: reporting rides on the existing reject route.
    paths = {getattr(r, "path", "") for r in routes.router.routes}
    assert "/api/one/connections/requests/{request_id}/report" not in paths
    assert not any(p.endswith("/report") for p in paths)
