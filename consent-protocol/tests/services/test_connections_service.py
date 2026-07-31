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


class _TransactionalResult:
    def __init__(self, rows):
        self._rows = list(rows)

    def fetchall(self):
        return list(self._rows)

    def mappings(self):
        return self

    def first(self):
        return self._rows[0] if self._rows else None


class _TransactionalConnection:
    def __init__(self, results, events):
        self._results = list(results)
        self.events = events
        self.calls = []

    def execute(self, statement, params=None):
        sql = str(statement)
        self.calls.append((sql, params or {}))
        self.events.append(("execute", sql))
        rows = self._results.pop(0) if self._results else []
        return _TransactionalResult(rows)


class _TransactionContext:
    def __init__(self, connection, events):
        self._connection = connection
        self._events = events

    def __enter__(self):
        self._events.append(("begin", None))
        return self._connection

    def __exit__(self, exc_type, _exc, _traceback):
        self._events.append(("rollback" if exc_type else "commit", None))
        return False


class _TransactionalDB:
    def __init__(self, results, events):
        self.connection = _TransactionalConnection(results, events)
        self.engine = SimpleNamespace(
            begin=lambda: _TransactionContext(self.connection, events),
        )


def test_accept_creates_connection_and_two_trusted_edges():
    svc = _svc()
    request_row = {
        "id": "req-1",
        "requester_user_id": "user-a",
        "addressee_user_id": "user-b",
        "status": "pending",
    }
    events = []
    transactional = _TransactionalDB(
        [
            [],  # canonical pair advisory lock
            [request_row],  # request row revalidated under the pair lock
            [],  # no Nearby block
            [{"id": "conn-1"}],
            [],  # trusted edge a -> b
            [],  # trusted edge b -> a
            [],  # request accepted
        ],
        events,
    )
    db = SimpleNamespace(
        execute_raw=lambda sql, params=None: SimpleNamespace(data=[request_row]),
        engine=transactional.engine,
    )
    with patch("hushh_mcp.services.connections_service.get_db", lambda: db):
        out = svc.accept_request("user-b", "req-1")
    assert out["status"] == "accepted"
    assert out["connectionId"] == "conn-1"
    # Two trusted_connections INSERTs happened.
    trusted_inserts = [
        c for c in transactional.connection.calls if "INSERT INTO trusted_connections" in c[0]
    ]
    assert len(trusted_inserts) == 2
    assert events[0] == ("begin", None)
    assert events[-1] == ("commit", None)


def test_accept_cancels_request_when_nearby_block_committed_first():
    svc = _svc()
    request_row = {
        "id": "req-1",
        "requester_user_id": "user-a",
        "addressee_user_id": "user-b",
        "status": "pending",
    }
    events = []
    transactional = _TransactionalDB(
        [
            [],  # canonical pair advisory lock
            [request_row],
            [(1,)],  # block exists
            [],  # request cancellation
        ],
        events,
    )
    db = SimpleNamespace(
        execute_raw=lambda sql, params=None: SimpleNamespace(data=[request_row]),
        engine=transactional.engine,
    )

    with (
        patch("hushh_mcp.services.connections_service.get_db", lambda: db),
        pytest.raises(ConnectionsError) as exc,
    ):
        svc.accept_request("user-b", "req-1")

    assert exc.value.code == "CONNECTION_REQUEST_NOT_FOUND"
    assert events[-1] == ("commit", None)
    assert not any(
        "INSERT INTO connections" in sql for sql, _params in transactional.connection.calls
    )


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


def test_list_requests_incoming_surfaces_requested_scopes():
    """The incoming read path must parse metadata and echo the requester's bundled
    data ask as ``requestedScopes`` so the addressee can review/modify it. Covers
    both metadata shapes the driver may return (parsed dict + raw JSON string)."""
    svc = _svc()
    rows = [
        {
            "id": "req-dict",
            "requester_user_id": "ria-1",
            "addressee_user_id": "user-a",
            "status": "pending",
            "message": "pick for you",
            "counterpart_user_id": "ria-1",
            "counterpart_display_name": "Ada RIA",
            # JSONB path: driver already parsed the cell into a dict.
            "metadata": {"requested_scopes": ["vault.read.finance", " vault.read.portfolio "]},
        },
        {
            "id": "req-str",
            "requester_user_id": "ria-2",
            "addressee_user_id": "user-a",
            "status": "pending",
            "message": None,
            "counterpart_user_id": "ria-2",
            "counterpart_display_name": None,
            # Raw JSON-string path.
            "metadata": '{"requested_scopes": ["vault.read.identity"]}',
        },
        {
            "id": "req-plain",
            "requester_user_id": "friend-1",
            "addressee_user_id": "user-a",
            "status": "pending",
            "message": None,
            "counterpart_user_id": "friend-1",
            "counterpart_display_name": None,
            "metadata": None,  # plain connect, no ask
        },
    ]
    with patch("hushh_mcp.services.connections_service.get_db", _db_returning(rows)):
        out = svc.list_requests("user-a", direction="incoming")

    by_id = {r["id"]: r for r in out}
    # Whitespace is stripped and order preserved.
    assert by_id["req-dict"]["requestedScopes"] == [
        "vault.read.finance",
        "vault.read.portfolio",
    ]
    assert by_id["req-str"]["requestedScopes"] == ["vault.read.identity"]
    assert by_id["req-plain"]["requestedScopes"] == []


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


def test_link_circle_invite_creates_connection_with_claim_proof():
    svc = _svc()
    responses = iter(
        [
            SimpleNamespace(data=[{"exists": 1}]),  # SELECT trusted edge (claim proof) -> found
            SimpleNamespace(data=[{"id": "conn-7"}]),  # INSERT connections RETURNING id
            SimpleNamespace(data=[{"id": "te-1"}]),  # _mirror_trusted_edge (caller -> peer)
            SimpleNamespace(data=[{"id": "te-2"}]),  # _mirror_trusted_edge (peer -> caller)
        ]
    )
    db = SimpleNamespace(execute_raw=lambda sql, params=None: next(responses))
    with patch("hushh_mcp.services.connections_service.get_db", lambda: db):
        out = svc.link_circle_invite("claimant", peer_user_id="inviter")
    assert out["status"] == "connected"
    assert out["connectionId"] == "conn-7"


def test_link_circle_invite_requires_claim_proof():
    svc = _svc()
    # No claim-sourced trusted edge exists -> reject.
    with patch(
        "hushh_mcp.services.connections_service.get_db",
        _db_returning([]),
    ):
        with pytest.raises(ConnectionsError) as err:
            svc.link_circle_invite("claimant", peer_user_id="stranger")
    assert err.value.code == "CONNECTION_CIRCLE_INVITE_REQUIRED"
    assert err.value.status_code == 403


def test_link_circle_invite_rejects_self_peer():
    svc = _svc()
    with pytest.raises(ConnectionsError) as err:
        svc.link_circle_invite("me", peer_user_id="me")
    assert err.value.code == "CONNECTION_INVALID_PEER"
    assert err.value.status_code == 422


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


def test_create_request_notifies_addressee_on_new_insert():
    """A brand-new pending request nudges the addressee's client (best-effort)."""
    svc = _svc()
    calls = []
    svc._notifier = lambda **kw: calls.append(kw)
    responses = iter(
        [
            SimpleNamespace(data=[]),  # idempotency SELECT -> none
            SimpleNamespace(data=[{"id": "req-1"}]),  # INSERT ... RETURNING id
        ]
    )
    db = SimpleNamespace(execute_raw=lambda sql, params=None: next(responses))
    with patch("hushh_mcp.services.connections_service.get_db", lambda: db):
        svc.create_request("user-a", addressee_user_id="user-b")
    assert calls == [{"addressee_user_id": "user-b", "requester_user_id": "user-a"}]


def test_create_request_does_not_notify_on_idempotent_existing():
    """Re-sending an already-pending request must NOT fire a duplicate nudge."""
    svc = _svc()
    calls = []
    svc._notifier = lambda **kw: calls.append(kw)
    existing = {
        "id": "req-9",
        "requester_user_id": "user-b",
        "addressee_user_id": "user-a",
        "status": "pending",
        "message": None,
    }
    db = SimpleNamespace(execute_raw=lambda sql, params=None: SimpleNamespace(data=[existing]))
    with patch("hushh_mcp.services.connections_service.get_db", lambda: db):
        svc.create_request("user-a", addressee_user_id="user-b")
    assert calls == []


def test_create_request_notify_failure_does_not_break_write():
    """A failing notifier is swallowed; the request is still created."""
    svc = _svc()

    def _boom(**_kw):
        raise RuntimeError("fcm down")

    svc._notifier = _boom
    responses = iter([SimpleNamespace(data=[]), SimpleNamespace(data=[{"id": "req-2"}])])
    db = SimpleNamespace(execute_raw=lambda sql, params=None: next(responses))
    with patch("hushh_mcp.services.connections_service.get_db", lambda: db):
        out = svc.create_request("user-a", addressee_user_id="user-b")
    assert out["id"] == "req-2"
    assert out["status"] == "pending"


def test_nearby_alias_request_atomically_revalidates_versions_and_inserts():
    svc = _svc()
    events = []
    notifications = []

    def _record_notification(**kwargs):
        events.append(("notify", None))
        notifications.append(kwargs)

    svc._notifier = _record_notification
    db = _TransactionalDB(
        [
            [
                {"owner_user_id": "user-a"},
                {"owner_user_id": "user-b"},
            ],
            [
                {
                    "target_user_id": "user-b",
                    "relationship": "pending_outgoing",
                    "created": True,
                }
            ],
        ],
        events,
    )

    with patch("hushh_mcp.services.connections_service.get_db", lambda: db):
        result = svc.create_request_from_nearby_alias(
            "user-a",
            participant_alias="6f80b5ee-85b8-4678-a663-9f84ae985ed5",
            requester_presence_version=4,
            target_presence_version=7,
        )

    assert result == {"relationship": "pending_outgoing"}
    assert len(db.connection.calls) == 2
    lock_sql, lock_params = db.connection.calls[0]
    mutation_sql, mutation_params = db.connection.calls[1]
    normalized_lock_sql = " ".join(lock_sql.split()).lower()
    normalized_mutation_sql = " ".join(mutation_sql.split()).lower()
    assert "order by p.owner_user_id for update of p" in normalized_lock_sql
    assert "viewer.version = :requester_presence_version" in normalized_mutation_sql
    assert "target.version = :target_presence_version" in normalized_mutation_sql
    assert "insert into connection_requests" in normalized_mutation_sql
    assert "target.allow_connection_requests" in normalized_mutation_sql
    assert "'pending', null" in normalized_mutation_sql
    expected_params = {
        "requester_user_id": "user-a",
        "participant_alias": "6f80b5ee-85b8-4678-a663-9f84ae985ed5",
        "requester_presence_version": 4,
        "target_presence_version": 7,
    }
    assert lock_params == expected_params
    assert mutation_params == expected_params
    assert [event[0] for event in events] == [
        "begin",
        "execute",
        "execute",
        "commit",
        "notify",
    ]
    assert notifications == [
        {
            "addressee_user_id": "user-b",
            "requester_user_id": "user-a",
        }
    ]


def test_nearby_alias_request_returns_reverse_pending_without_notification():
    svc = _svc()
    svc._notifier = lambda **_kwargs: pytest.fail("must not notify")
    events = []
    db = _TransactionalDB(
        [
            [
                {"owner_user_id": "user-a"},
                {"owner_user_id": "user-b"},
            ],
            [
                {
                    "target_user_id": "user-b",
                    "relationship": "pending_incoming",
                    "created": False,
                }
            ],
        ],
        events,
    )

    with patch("hushh_mcp.services.connections_service.get_db", lambda: db):
        result = svc.create_request_from_nearby_alias(
            "user-a",
            participant_alias="6f80b5ee-85b8-4678-a663-9f84ae985ed5",
            requester_presence_version=4,
            target_presence_version=7,
        )

    assert result == {"relationship": "pending_incoming"}
    assert [event[0] for event in events] == [
        "begin",
        "execute",
        "execute",
        "commit",
    ]


def test_nearby_alias_request_fails_closed_without_current_eligibility():
    svc = _svc()
    svc._notifier = lambda **_kwargs: pytest.fail("must not notify")
    events = []
    db = _TransactionalDB(
        [
            [{"owner_user_id": "user-a"}],
            [],
        ],
        events,
    )

    with patch("hushh_mcp.services.connections_service.get_db", lambda: db):
        result = svc.create_request_from_nearby_alias(
            "user-a",
            participant_alias="6f80b5ee-85b8-4678-a663-9f84ae985ed5",
            requester_presence_version=4,
            target_presence_version=7,
        )

    assert result is None
    assert [event[0] for event in events] == [
        "begin",
        "execute",
        "execute",
        "commit",
    ]
