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


def test_reject_rejected_when_not_addressee():
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
            svc.reject_request("user-c", "req-1")
    assert exc.value.status_code == 403


def test_search_directory_reuses_ready_people_and_annotates_relationship():
    svc = _svc()
    # People come from the One Location "Ready people" lookup (list_verified_recipients),
    # which resolves display names — never a raw user id.
    svc._directory_lookup = lambda owner_user_id: [
        {"userId": "user-b", "displayName": "Bob"},
        {"userId": "user-c", "displayName": "Cara"},
        {"userId": "user-d", "displayName": "Dan"},
        {"userId": "user-e", "displayName": "Eve"},
    ]
    # Relationship queries run in order: outgoing pending, incoming pending, connections.
    db = _RecordingDB(
        [
            [{"addressee_user_id": "user-b"}],  # outgoing pending -> user-b
            [{"requester_user_id": "user-d"}],  # incoming pending -> user-d
            [{"user_a_id": "user-a", "user_b_id": "user-c"}],  # connected -> user-c
        ]
    )
    with patch("hushh_mcp.services.connections_service.get_db", lambda: db):
        out = svc.search_directory("user-a", query="", page=1, limit=20)
    by_id = {i["userId"]: i for i in out["items"]}
    assert by_id["user-b"]["displayName"] == "Bob"
    assert by_id["user-b"]["relationship"] == "pending_outgoing"
    assert by_id["user-c"]["relationship"] == "connected"
    assert by_id["user-d"]["relationship"] == "pending_incoming"
    assert by_id["user-e"]["relationship"] == "none"


def test_search_directory_filters_by_query_against_display_name():
    svc = _svc()
    svc._directory_lookup = lambda owner_user_id: [
        {"userId": "user-b", "displayName": "Bob"},
        {"userId": "user-c", "displayName": "Cara"},
    ]
    db = _RecordingDB([[], [], []])  # no pending / connections
    with patch("hushh_mcp.services.connections_service.get_db", lambda: db):
        out = svc.search_directory("user-a", query="car", page=1, limit=20)
    assert [i["userId"] for i in out["items"]] == ["user-c"]


def test_list_connections_maps_rows():
    svc = _svc()
    rows = [
        {
            "connection_id": "conn-1",
            "user_id": "user-b",
            "display_name": "Bob",
            "photo_url": None,
            "created_at": "2026-07-09T00:00:00Z",
        }
    ]
    with patch("hushh_mcp.services.connections_service.get_db", _db_returning(rows)):
        out = svc.list_connections("user-a")
    assert out[0]["userId"] == "user-b"
    assert out[0]["connectionId"] == "conn-1"


def test_remove_connection_revokes_connection_and_trusted_edges():
    svc = _svc()
    # Call sequence: SELECT, UPDATE trusted_connections, UPDATE connections
    db = _RecordingDB(
        [
            [
                {
                    "id": "conn-1",
                    "user_a_id": "user-a",
                    "user_b_id": "user-b",
                    "status": "active",
                }
            ],  # SELECT
            [{"id": "tc-1"}],  # UPDATE trusted_connections
            [{"id": "conn-1"}],  # UPDATE connections
        ]
    )
    with patch("hushh_mcp.services.connections_service.get_db", lambda: db):
        out = svc.remove_connection("user-a", "conn-1")
    assert out == {"removed": 1}
    trusted_update_indices = [
        i for i, (sql, _) in enumerate(db.calls) if "UPDATE trusted_connections" in sql
    ]
    conn_update_indices = [i for i, (sql, _) in enumerate(db.calls) if "UPDATE connections" in sql]
    assert len(trusted_update_indices) >= 1, "UPDATE trusted_connections was not called"
    assert len(conn_update_indices) >= 1, "UPDATE connections was not called"
    # Trusted-edge revoke must happen BEFORE the connection revoke.
    assert trusted_update_indices[0] < conn_update_indices[0], (
        "UPDATE trusted_connections must precede UPDATE connections"
    )


def test_remove_connection_returns_zero_when_not_member_or_missing():
    svc = _svc()
    # SELECT returns no row — caller is not a member or id is unknown.
    db = _RecordingDB(
        [
            [],  # SELECT -> no row
        ]
    )
    with patch("hushh_mcp.services.connections_service.get_db", lambda: db):
        out = svc.remove_connection("user-x", "conn-999")
    assert out == {"removed": 0}
    trusted_updates = [sql for sql, _ in db.calls if "UPDATE trusted_connections" in sql]
    assert len(trusted_updates) == 0, (
        "No trusted_connections UPDATE should occur when member check fails"
    )


def test_remove_connection_self_heals_when_already_revoked():
    svc = _svc()
    # SELECT returns the row with status='revoked' (partial-failure state).
    # The trusted-edge UPDATE should still run (self-healing), but the
    # connection UPDATE finds status != 'active' and returns no row.
    db = _RecordingDB(
        [
            [
                {
                    "id": "conn-1",
                    "user_a_id": "user-a",
                    "user_b_id": "user-b",
                    "status": "revoked",
                }
            ],  # SELECT
            [],  # UPDATE trusted_connections -> already clean, 0 rows (no-op)
            [],  # UPDATE connections -> status != 'active', no row returned
        ]
    )
    with patch("hushh_mcp.services.connections_service.get_db", lambda: db):
        out = svc.remove_connection("user-a", "conn-1")
    # Connection was already revoked, so removed=0.
    assert out == {"removed": 0}
    # The trusted-edge cleanup must still have been attempted (self-healing).
    trusted_updates = [sql for sql, _ in db.calls if "UPDATE trusted_connections" in sql]
    assert len(trusted_updates) >= 1, (
        "Trusted-edge revoke must run even when connection is already revoked"
    )
