from types import SimpleNamespace
from unittest.mock import patch

import pytest

from hushh_mcp.services.connections_service import (
    ConnectionsError,
    ConnectionsService,
)


def _svc():
    return ConnectionsService.__new__(ConnectionsService)


def _db_returning(rows):
    """Mock get_db() whose execute_raw returns the given rows for every call."""
    db = SimpleNamespace(execute_raw=lambda sql, params=None: SimpleNamespace(data=rows))
    return lambda: db


def test_create_request_inserts_pending_with_explicit_id():
    svc = _svc()
    responses = iter(
        [
            SimpleNamespace(data=[]),  # idempotency SELECT -> none
            SimpleNamespace(data=[{"id": "req-1"}]),  # INSERT ... RETURNING id
        ]
    )
    db = SimpleNamespace(execute_raw=lambda sql, params=None: next(responses))
    with patch("hushh_mcp.services.connections_service.get_db", lambda: db):
        out = svc.create_request("user-a", addressee_user_id="user-b", message="hi")
    assert out["id"] == "req-1"
    assert out["requesterUserId"] == "user-a"
    assert out["addresseeUserId"] == "user-b"
    assert out["status"] == "pending"


def test_create_request_returns_existing_reverse_direction_request():
    svc = _svc()
    # A pending request already exists in the reverse direction (user-b -> user-a).
    existing_row = {
        "id": "req-9",
        "requester_user_id": "user-b",
        "addressee_user_id": "user-a",
        "status": "pending",
        "message": "hey",
    }
    with patch(
        "hushh_mcp.services.connections_service.get_db",
        _db_returning([existing_row]),
    ):
        out = svc.create_request("user-a", addressee_user_id="user-b")
    assert out["id"] == "req-9"
    assert out["requesterUserId"] == "user-b"
    assert out["addresseeUserId"] == "user-a"
    assert out["status"] == "pending"


def test_create_request_rejects_self():
    svc = _svc()
    with pytest.raises(ConnectionsError) as exc:
        svc.create_request("user-a", addressee_user_id="user-a")
    assert exc.value.code == "CONNECTION_NO_SELF"


def test_create_request_requires_identifier():
    svc = _svc()
    with pytest.raises(ConnectionsError) as exc:
        svc.create_request("user-a")
    assert exc.value.status_code == 422


class _RecordingDB:
    """Captures every (sql, params) and returns queued rows per call."""

    def __init__(self, results):
        self._results = list(results)
        self.calls = []

    def execute_raw(self, sql, params=None):
        self.calls.append((sql, params or {}))
        rows = self._results.pop(0) if self._results else []
        return SimpleNamespace(data=rows)


def test_accept_creates_connection_and_two_trusted_edges():
    svc = _svc()
    # 1) load request row -> addressee is user-b (the acceptor)
    # 2) insert connections -> returns id
    # 3) insert trusted edge a->b
    # 4) insert trusted edge b->a
    # 5) update request -> accepted
    db = _RecordingDB(
        [
            [
                {
                    "id": "req-1",
                    "requester_user_id": "user-a",
                    "addressee_user_id": "user-b",
                    "status": "pending",
                }
            ],
            [{"id": "conn-1"}],
            [{"id": "tc-1"}],
            [{"id": "tc-2"}],
            [{"id": "req-1"}],
        ]
    )
    with patch("hushh_mcp.services.connections_service.get_db", lambda: db):
        out = svc.accept_request("user-b", "req-1")
    assert out["status"] == "accepted"
    assert out["connectionId"] == "conn-1"
    # Two trusted_connections INSERTs happened.
    trusted_inserts = [c for c in db.calls if "INSERT INTO trusted_connections" in c[0]]
    assert len(trusted_inserts) == 2


def test_accept_rejected_when_not_addressee():
    svc = _svc()
    db = _RecordingDB(
        [
            [
                {
                    "id": "req-1",
                    "requester_user_id": "user-a",
                    "addressee_user_id": "user-b",
                    "status": "pending",
                }
            ]
        ]
    )
    with patch("hushh_mcp.services.connections_service.get_db", lambda: db):
        with pytest.raises(ConnectionsError) as exc:
            svc.accept_request("user-c", "req-1")
    assert exc.value.status_code == 403


def test_cancel_rejected_when_not_requester():
    svc = _svc()
    db = _RecordingDB(
        [
            [
                {
                    "id": "req-1",
                    "requester_user_id": "user-a",
                    "addressee_user_id": "user-b",
                    "status": "pending",
                }
            ]
        ]
    )
    with patch("hushh_mcp.services.connections_service.get_db", lambda: db):
        with pytest.raises(ConnectionsError) as exc:
            svc.cancel_request("user-b", "req-1")
    assert exc.value.status_code == 403
