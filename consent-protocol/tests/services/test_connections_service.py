from types import SimpleNamespace
from unittest.mock import patch

import pytest

from hushh_mcp.services.connection_graph_service import ORIGIN_DIRECT_REQUEST
from hushh_mcp.services.connections_service import (
    _RIA_ACTIVE_PICKS_CAPABILITY,
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


def test_scope_catalog_is_directory_bounded_and_separates_offerable_scopes():
    svc = _svc()
    svc._directory_lookup = lambda _viewer: [{"userId": "ria-user", "displayName": "Ria"}]
    svc._scope_catalog_for_owner = lambda owner: [
        {"handle": f"scp-{owner}", "label": "RIA Picks", "description": "Picks"}
    ]

    result = svc.get_scope_catalog("investor-user", "ria-user")

    assert result["items"] == [
        {"handle": "scp-ria-user", "label": "RIA Picks", "description": "Picks"}
    ]
    assert result["offerableItems"] == [
        {"handle": "scp-investor-user", "label": "RIA Picks", "description": "Picks"}
    ]

    with pytest.raises(ConnectionsError) as exc:
        svc.get_scope_catalog("investor-user", "hidden-user")
    assert exc.value.code == "CONNECTION_SCOPE_TARGET_FORBIDDEN"


def test_scope_catalog_gate_accepts_every_verified_status():
    """Regression: the catalog gate must accept the exact status the RIA
    verification success path writes ('verified'). Migration 028 retired
    'finra_verified' and 'active' is never written, so a gate that omitted
    'verified' handed a genuinely verified RIA an empty catalog — the root
    cause of "no capabilities available yet" for real advisors."""
    from hushh_mcp.services.ria_iam_service import RIAIAMService

    _RIA_VERIFIED_STATUSES = RIAIAMService._RIA_VERIFIED_STATUSES

    svc = _svc()
    captured = {}

    def fake_execute_one(sql, params=None):
        captured["sql"] = sql
        return {"id": "ria-1"}

    svc._execute_one = fake_execute_one
    items = svc._scope_catalog_for_owner("ria-user")

    for status in _RIA_VERIFIED_STATUSES:
        assert f"'{status}'" in captured["sql"], f"catalog gate omits '{status}'"
    assert len(items) == 1
    assert items[0]["capabilityKey"] == _RIA_ACTIVE_PICKS_CAPABILITY
    assert items[0]["label"] == "RIA Picks"
    assert items[0]["description"]


def test_scope_catalog_empty_for_unverified_owner():
    svc = _svc()
    svc._execute_one = lambda _sql, _params=None: None
    assert svc._scope_catalog_for_owner("nobody") == []


def test_activate_ria_picks_gate_accepts_every_verified_status():
    """The activation gate mirrors the catalog gate: a 'verified' RIA whose
    capability we just offered must not fail closed at accept time."""
    from hushh_mcp.services.ria_iam_service import RIAIAMService

    _RIA_VERIFIED_STATUSES = RIAIAMService._RIA_VERIFIED_STATUSES

    svc = _svc()
    sqls: list[str] = []

    def fake_execute_one(sql, _params=None):
        sqls.append(sql)
        return None  # RIA lookup returns nothing -> activation returns False

    svc._execute_one = fake_execute_one
    result = svc._activate_ria_picks_scope(
        {"owner_user_id": "ria-user", "receiver_user_id": "investor-user"}, "req-1"
    )

    assert result is False
    gate_sql = sqls[0]
    for status in _RIA_VERIFIED_STATUSES:
        assert f"'{status}'" in gate_sql, f"activation gate omits '{status}'"


def test_proposal_items_distinct_capabilities_have_distinct_labels():
    """Two distinct capability handles must never collapse to the same label.
    The previous hardcoded fallback labelled every non-RIA capability
    "Requested capability", so any two future capabilities would be
    indistinguishable in the receiver's review dialog."""
    svc = _svc()
    rows = [
        {
            "id": "p1",
            "scope_handle": "scp-alpha",
            "capability_key": "alpha_feed_v1",
            "direction": "requested",
            "status": "pending",
            "created_at": None,
            "expires_at": None,
            "resolved_at": None,
        },
        {
            "id": "p2",
            "scope_handle": "scp-beta",
            "capability_key": "beta_feed_v1",
            "direction": "requested",
            "status": "pending",
            "created_at": None,
            "expires_at": None,
            "resolved_at": None,
        },
    ]
    svc._execute_many = lambda _sql, _params=None: rows

    items = svc._proposal_items("req-1")
    handles = [item["scopeHandle"] for item in items]
    labels = [item["label"] for item in items]

    assert len(set(handles)) == len(handles)
    assert len(set(labels)) == len(labels), f"distinct scope ids share a label: {labels}"
    assert all(item["description"] for item in items)


def test_proposal_items_ria_picks_label_matches_catalog():
    """The receiver-facing proposal view and the offer catalog read the same
    single source of capability metadata, so labels cannot drift apart."""
    svc = _svc()
    svc._execute_many = lambda _sql, _params=None: [
        {
            "id": "p1",
            "scope_handle": "scp-ria",
            "capability_key": _RIA_ACTIVE_PICKS_CAPABILITY,
            "direction": "requested",
            "status": "pending",
            "created_at": None,
            "expires_at": None,
            "resolved_at": None,
        }
    ]
    items = svc._proposal_items("req-1")
    assert items[0]["label"] == "RIA Picks"
    assert "picks" in items[0]["description"].lower()


def test_information_scope_catalog_requires_an_active_connection_and_filters_private_entries():
    svc = ConnectionsService(
        scope_entries_lookup=lambda _owner: [
            {
                "scope": "attr.financial.holdings",
                "label": "Holdings",
                "domain": "financial",
                "path": "holdings",
                "wildcard": False,
                "exposure_eligibility": True,
                "consumer_visible": True,
                "internal_only": False,
                "visibility_posture": "consent_required",
            },
            {
                "scope": "attr.financial.tax_id",
                "label": "Tax ID",
                "domain": "financial",
                "path": "tax_id",
                "exposure_eligibility": True,
                "consumer_visible": True,
                "internal_only": False,
                "visibility_posture": "private",
            },
        ]
    )
    svc._execute_one = lambda _sql, _params=None: {"id": "connection-1"}

    result = svc.get_information_scope_catalog("user-a", "user-b", query="hold")

    assert [entry["scope"] for entry in result["items"]] == ["attr.financial.holdings"]
    assert result["items"][0]["match_reason"] == "substring_match"

    svc._execute_one = lambda _sql, _params=None: None
    with pytest.raises(ConnectionsError) as exc:
        svc.get_information_scope_catalog("user-a", "user-b")
    assert exc.value.code == "CONNECTION_INFORMATION_SCOPE_FORBIDDEN"


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
    # 1) load request row -> addressee is user-b (the acceptor)
    # 2) no scope proposals
    # 3) insert connections -> returns id
    # 4) insert trusted edge a->b
    # 5) insert trusted edge b->a
    # 6) update request -> accepted
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
            [],  # proposal review -> no scopes
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
    # Regression guard: accepting a connection must never touch location
    # sharing on its own. A newly accepted connection used to silently
    # fan out a bidirectional live-location grant to both people with no
    # request involved (auto_start_share_for_new_peer, removed). Location
    # sharing may only ever be created by an explicit
    # OneLocationAgentService.approve_request call against a real,
    # explicit OneLocationAccessRequest.
    assert not any("one_location_share_grants" in c[0] for c in db.calls)
    assert not any("one_location_map_preferences" in c[0] for c in db.calls)


def test_accept_request_never_imports_or_calls_location_service():
    """Structural guard against re-wiring auto-share into accept_request.

    This is what actually broke: a prior commit imported
    OneLocationAgentService inside accept_request and called
    auto_start_share_for_new_peer as a bidirectional post-commit side
    effect, with no explicit location request anywhere in the path. Assert
    directly on the source so a future edit that reintroduces an import of
    or a call into the location service from here fails loudly instead of
    silently. (Comments in accept_request are allowed to *mention*
    OneLocationAgentService.approve_request as a pointer for readers --
    only real imports/calls are checked here.)
    """
    import inspect

    from hushh_mcp.services.connections_service import ConnectionsService

    lines = inspect.getsource(ConnectionsService.accept_request).splitlines()
    code_only = "\n".join(
        line for line in lines if not line.strip().startswith("#")
    )
    assert "one_location_agent_service" not in code_only.lower()
    assert "OneLocationAgentService" not in code_only
    assert "auto_start_share_for_new_peer" not in code_only
    assert "auto_share" not in code_only.lower()


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


def test_accept_with_scope_proposals_requires_explicit_bilateral_selection():
    svc = _svc()
    db = _RecordingDB(
        [
            [
                {
                    "id": "req-1",
                    "requester_user_id": "ria-user",
                    "addressee_user_id": "investor-user",
                    "status": "pending",
                }
            ],
            [
                {
                    "id": "proposal-1",
                    "scope_handle": "scp-ria",
                    "capability_key": "ria_active_picks_feed_v1",
                    "direction": "requested",
                    "owner_user_id": "ria-user",
                    "receiver_user_id": "investor-user",
                    "status": "pending",
                }
            ],
        ]
    )
    with patch("hushh_mcp.services.connections_service.get_db", lambda: db):
        with pytest.raises(ConnectionsError) as exc:
            svc.accept_request("investor-user", "req-1")

    assert exc.value.code == "CONNECTION_SCOPE_SELECTION_REQUIRED"
    assert not any("INSERT INTO connections" in sql for sql, _ in db.calls)


def test_scope_proposal_history_hides_authority_columns():
    svc = _svc()
    db = _RecordingDB(
        [
            [
                {
                    "id": "req-1",
                    "requester_user_id": "ria-user",
                    "addressee_user_id": "investor-user",
                    "status": "accepted",
                }
            ],
            [
                {
                    "id": "proposal-1",
                    "scope_handle": "scp-ria",
                    "capability_key": "ria_active_picks_feed_v1",
                    "direction": "requested",
                    "owner_user_id": "ria-user",
                    "receiver_user_id": "investor-user",
                    "status": "active",
                    "created_at": "2026-07-30T00:00:00Z",
                    "resolved_at": "2026-07-30T00:01:00Z",
                }
            ],
            [
                {
                    "connection_scope_proposal_id": "proposal-1",
                    "event_type": "ACTIVATED",
                    "reason": None,
                    "created_at": "2026-07-30T00:01:00Z",
                }
            ],
        ]
    )
    with patch("hushh_mcp.services.connections_service.get_db", lambda: db):
        result = svc.get_scope_proposal_history("investor-user", "req-1")

    item = result["items"][0]
    assert item["scopeHandle"] == "scp-ria"
    assert item["history"] == [
        {"type": "ACTIVATED", "reason": None, "createdAt": "2026-07-30T00:01:00Z"}
    ]
    assert "id" not in item
    assert "capabilityKey" not in item
    assert "ownerUserId" not in item


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


def test_cancel_marks_request_and_pending_scope_proposals_declined():
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
            ],
            [{"id": "req-1"}],
            [{"id": "proposal-1"}],
            [{"id": "event-1"}],
        ]
    )
    with patch("hushh_mcp.services.connections_service.get_db", lambda: db):
        out = svc.cancel_request("user-a", "req-1")

    assert out == {"status": "cancelled", "requestId": "req-1"}
    proposal_update = next(
        (sql, params) for sql, params in db.calls if "UPDATE connection_scope_proposals" in sql
    )
    assert proposal_update[1] == {"status": "declined", "request_id": "req-1"}
    _, event_params = next(
        (sql, params)
        for sql, params in db.calls
        if "INSERT INTO connection_scope_proposal_events" in sql
    )
    assert event_params == {
        "proposal_id": "proposal-1",
        "event_type": "DECLINED",
        "actor_user_id": "user-a",
        "reason": "connection_cancelled",
    }


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


def test_search_directory_fallback_matches_prefixes_and_ranks_them():
    """The in-memory fallback answers the same question as the SQL path.

    Typing one letter is an index request. A substring match answers a
    different question -- "Anand" contains an n -- and the two paths disagreeing
    would mean findability depended on which branch a deployment took.
    """
    svc = _svc()
    svc._directory_lookup = lambda owner_user_id: [
        {"userId": "u-anand", "displayName": "Anand"},  # contains n, starts with a
        {"userId": "u-nirmal", "displayName": "Nirmal"},
        {"userId": "u-abdul", "displayName": "Abdul Nasser"},  # second word starts with n
        {"userId": "u-nilesh", "displayName": "Nilesh"},
    ]
    db = _RecordingDB([[], [], []])
    with patch("hushh_mcp.services.connections_service.get_db", lambda: db):
        out = svc.search_directory("user-a", query="n", page=1, limit=20)

    # Anand is gone: it only ever matched as a substring. Name-prefix names
    # come first and A-Z within the tier; the surname match ranks below them
    # rather than being mixed in, which is what made the earlier version of
    # this read as random.
    assert [i["displayName"] for i in out["items"]] == ["Nilesh", "Nirmal", "Abdul Nasser"]


def test_search_directory_fallback_folds_separators_like_the_sql_path():
    svc = _svc()
    svc._directory_lookup = lambda owner_user_id: [
        {"userId": "u-hyphen", "displayName": "Abdul-Rashid"},
        {"userId": "u-initial", "displayName": "Abdul R."},
        {"userId": "u-spaced", "displayName": "  Rashid Ahmed"},
    ]
    db = _RecordingDB([[], [], []])
    with patch("hushh_mcp.services.connections_service.get_db", lambda: db):
        out = svc.search_directory("user-a", query="r", page=1, limit=20)

    # "  Rashid Ahmed" is trimmed, so it earns the first tier rather than being
    # demoted by a leading space. The hyphen and the full stop are separators,
    # so both reach the second tier instead of hiding their second word.
    #
    # Asserted as tiers rather than one exact sequence on purpose: how "Abdul
    # R." and "Abdul-Rashid" order against each other depends on whether
    # punctuation is significant in the active collation, and pinning that here
    # would be pinning the database's locale, not this code's behaviour.
    found = [i["userId"] for i in out["items"]]
    assert found[0] == "u-spaced"
    assert sorted(found[1:]) == ["u-hyphen", "u-initial"]


def test_search_directory_fallback_pages_the_ranked_list_not_the_raw_one():
    svc = _svc()
    svc._directory_lookup = lambda owner_user_id: [
        {"userId": f"u-{name}", "displayName": name}
        for name in ["Nolan", "Anand", "Nilesh", "Chandan", "Nirmal"]
    ]
    db = _RecordingDB([[], [], []])
    with patch("hushh_mcp.services.connections_service.get_db", lambda: db):
        first = svc.search_directory("user-a", query="n", page=1, limit=2)
        second = svc.search_directory("user-a", query="n", page=2, limit=2)

    # Ranking finishes before the slice, so page 1 holds the first two N names
    # and page 2 continues the same list. Slicing first and ranking after is
    # exactly the bug this replaced.
    assert [i["displayName"] for i in first["items"]] == ["Nilesh", "Nirmal"]
    assert first["hasMore"] is True
    assert [i["displayName"] for i in second["items"]] == ["Nolan"]
    assert second["hasMore"] is False


def test_search_directory_delegates_pagination_to_eligible_directory_query():
    calls: list[tuple[str, dict[str, object]]] = []

    def directory_search(owner_user_id: str, **options: object) -> dict[str, object]:
        calls.append((owner_user_id, options))
        return {
            "items": [
                {
                    "userId": "user-c",
                    "displayName": "Cara",
                    "maskedPhone": "******4455",
                    "maskedEmail": "c***a@example.com",
                }
            ],
            "page": 2,
            "hasMore": True,
        }

    svc = ConnectionsService(directory_search=directory_search)
    db = _RecordingDB([[], [], []])  # no pending / connections
    with patch("hushh_mcp.services.connections_service.get_db", lambda: db):
        out = svc.search_directory("user-a", query="cara", page=2, limit=20)

    assert calls == [("user-a", {"query": "cara", "page": 2, "limit": 20})]
    assert out == {
        "items": [
            {
                "userId": "user-c",
                "displayName": "Cara",
                "photoUrl": None,
                "email": None,
                "maskedPhone": "******4455",
                "maskedEmail": "c***a@example.com",
                "relationship": "none",
            }
        ],
        "page": 2,
        "hasMore": True,
    }


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
    # Call sequence: SELECT, revoke proposals/grants, demote stale RIA relation, trusted edges, connection.
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
            [],  # explicit scope proposals -> none
            [],  # explicit share grants -> none
            [],  # RIA relation projection -> none
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
            [],  # explicit scope proposals -> none
            [],  # explicit share grants -> none
            [],  # RIA relation projection -> none
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


# --- Receiver scope modification: intersection enforcement (accept path) -----
#
# The accept transaction defers all scope authority to _resolve_scope_proposals.
# These exercise that resolver directly so the security-critical intersection
# (requested x receiver-approved) and its fail-closed edges are pinned down
# without coupling to the full transaction's SQL ordering.


def _pending_proposal(scope_handle, capability_key, direction="requested"):
    return {
        "id": scope_handle,
        "scope_handle": scope_handle,
        "capability_key": capability_key,
        "direction": direction,
        "owner_user_id": "ria-user",
        "receiver_user_id": "investor-user",
        "status": "pending",
    }


def _wire_resolver(svc, pending_rows):
    """Record proposal UPDATEs and audit events emitted by the resolver."""
    updates: list[dict[str, object]] = []
    events: list[dict[str, object]] = []
    svc._execute_many = lambda _sql, _params=None: pending_rows

    def fake_execute_one(_sql, params=None):
        updates.append(dict(params or {}))
        return {"id": (params or {}).get("proposal_id")}

    def fake_record_event(proposal_id, *, event_type, actor_user_id, reason=None):
        events.append({"proposal_id": proposal_id, "event_type": event_type, "reason": reason})

    svc._execute_one = fake_execute_one
    svc._record_scope_event = fake_record_event
    return updates, events


def test_resolve_scope_proposals_activates_only_receiver_selected_subset():
    """Receiver approves a subset: only selected scopes activate; every
    deselected scope is declined. Effective access is the intersection of the
    requested scopes and the receiver-approved scopes."""
    svc = _svc()
    pending = [
        _pending_proposal("scp-alpha", "alpha_feed_v1"),
        _pending_proposal("scp-beta", "beta_feed_v1"),
    ]
    updates, events = _wire_resolver(svc, pending)

    results = svc._resolve_scope_proposals(
        request_id="req-1",
        actor_user_id="investor-user",
        selected_requested_scope_handles=["scp-alpha"],
        selected_offered_scope_handles=[],
    )

    by_handle = {r["scopeHandle"]: r for r in results}
    assert by_handle["scp-alpha"]["status"] == "active"
    assert by_handle["scp-beta"]["status"] == "declined"
    # Each pending proposal resolved exactly once, to the expected status.
    assert {u["proposal_id"]: u["status"] for u in updates} == {
        "scp-alpha": "active",
        "scp-beta": "declined",
    }
    # Audit trail names the deselected scope as declined, not silently dropped.
    assert {e["proposal_id"]: e["event_type"] for e in events} == {
        "scp-alpha": "ACTIVATED",
        "scp-beta": "DECLINED",
    }


def test_resolve_scope_proposals_rejects_scope_not_in_request():
    """A selected handle that was never part of the pending request is refused
    with 409 before any proposal is mutated: the requester cannot receive a
    scope they never asked for, and the receiver cannot invent one."""
    svc = _svc()
    updates, events = _wire_resolver(svc, [_pending_proposal("scp-alpha", "alpha_feed_v1")])

    with pytest.raises(ConnectionsError) as exc:
        svc._resolve_scope_proposals(
            request_id="req-1",
            actor_user_id="investor-user",
            selected_requested_scope_handles=["scp-alpha", "scp-forged"],
            selected_offered_scope_handles=[],
        )

    assert exc.value.code == "CONNECTION_SCOPE_SELECTION_INVALID"
    assert exc.value.status_code == 409
    # Fail closed: nothing was resolved or audited.
    assert updates == []
    assert events == []


def test_resolve_scope_proposals_declines_reserved_scope_when_activation_fails():
    """A selected RIA-reserved capability that cannot be materialized fails
    closed: the scope is declined, never granted. Authorization is not bypassed
    just because a downstream capability step failed."""
    svc = _svc()
    updates, events = _wire_resolver(
        svc, [_pending_proposal("scp-ria", _RIA_ACTIVE_PICKS_CAPABILITY)]
    )
    svc._activate_ria_picks_scope = lambda _proposal, _request_id: False

    results = svc._resolve_scope_proposals(
        request_id="req-1",
        actor_user_id="investor-user",
        selected_requested_scope_handles=["scp-ria"],
        selected_offered_scope_handles=[],
    )

    assert results[0]["status"] == "declined"
    assert results[0]["activated"] is False
    assert updates[0]["status"] == "declined"
    assert events[0]["event_type"] == "DECLINED"
    assert events[0]["reason"] == "capability_activation_failed"


def test_resolve_pending_scope_proposals_declines_all_and_audits():
    """Full rejection: every still-pending proposal is marked declined and an
    audit event is written for each, so no proposal is left dangling."""
    svc = _svc()
    svc._execute_many = lambda _sql, _params=None: [{"id": "p1"}, {"id": "p2"}]
    events: list[dict[str, object]] = []

    def fake_record_event(proposal_id, *, event_type, actor_user_id, reason=None):
        events.append({"proposal_id": proposal_id, "event_type": event_type, "reason": reason})

    svc._record_scope_event = fake_record_event

    svc._resolve_pending_scope_proposals(
        "req-1",
        status="declined",
        actor_user_id="investor-user",
        reason="connection_rejected",
    )

    assert [e["proposal_id"] for e in events] == ["p1", "p2"]
    assert {e["event_type"] for e in events} == {"DECLINED"}
    assert {e["reason"] for e in events} == {"connection_rejected"}


def test_accept_records_the_direct_request_origin_location_needs():
    """Accepting must materialize Location eligibility, not just Connect's row.

    Connect lists anyone with an active `connections` row. Location requires
    that AND an active non-circle `connection_origins` row. Acceptance wrote
    only the first, so a person could be connected in Connect and absent from
    Location's recipient list -- One answering "nobody in your connections
    matches that name" about someone plainly there, and "connect with X then
    share my location with X" breaking at a step that looked successful.

    The origin has to be written on the transaction connection, inside the same
    transaction that activates the connection, or the two can disagree.
    """
    svc = _svc()
    events: list = []
    db = _TransactionalDB(
        [
            [
                {
                    "id": "req-1",
                    "requester_user_id": "user-a",
                    "addressee_user_id": "user-b",
                    "status": "pending",
                }
            ],
            [],  # no scope proposals
            [{"id": "conn-1"}],
            [{"id": "tc-1"}],
            [{"id": "tc-2"}],
            [{"id": "req-1"}],
        ],
        events,
    )

    recorded: list[dict] = []

    def _capture_origin(conn, **kwargs):
        recorded.append({"conn": conn, **kwargs})
        return {"origin_kind": kwargs.get("kind")}

    with (
        patch("hushh_mcp.services.connections_service.get_db", lambda: db),
        patch(
            "hushh_mcp.services.connections_service.ensure_connection_origin",
            _capture_origin,
        ),
    ):
        out = svc.accept_request("user-b", "req-1")

    assert out["status"] == "accepted"
    assert len(recorded) == 1, "acceptance must record exactly one origin"
    origin = recorded[0]
    # `direct_request`, never a circle kind: Location's eligibility query
    # excludes circle-derived origins, so recording one of those would leave
    # the same invisible-recipient bug in place while looking fixed.
    assert origin["kind"] == ORIGIN_DIRECT_REQUEST
    assert {origin["user_a_id"], origin["user_b_id"]} == {"user-a", "user-b"}
    # Traceable back to the request that authorized it.
    assert origin["source_ref"] == "req-1"
    # On the TRANSACTION's connection, so it commits or rolls back with the
    # connection row rather than landing independently.
    assert origin["conn"] is db.connection


# The pair from the live failure. Not invented: accepting Abdul Rashid's
# request returned 500 three times, and these are the two real Firebase UIDs.
_UPPER_FIRST = "RPNmQAmVdlNz84GVfXxta50wnYx1"
_LOWER_FIRST = "oGltkj09rMcRnru7sBvfziC94px1"


def test_python_orders_this_pair_the_way_the_database_will_reject():
    """The disagreement, pinned so the fix cannot be "simplified" back.

    `connections` declares CHECK (user_a_id < user_b_id), and that `<` is
    Postgres's, under the database collation (en_US.UTF8), which compares
    case-insensitively at the primary level. Python's `<` is bytewise, so every
    uppercase letter sorts before every lowercase one.

    Ordering in Python and inserting the result produced CheckViolation, so
    accepting a connection failed whenever two UIDs differed in case at the
    first distinguishing character. Measured on UAT: 88 of 390 pending requests
    could never have been accepted, and the route logged nothing, so the only
    symptom was "That didn't go through. Try again."

    The survivorship trap is worth knowing: every row in `connections` agrees
    with Python's ordering, which reads as proof the code is fine. It is the
    opposite -- disagreeing pairs were refused at INSERT, so they were never
    written.
    """
    svc = _svc()

    # Python puts the uppercase-leading id first. Postgres does not, which is
    # why this ordering must never reach an INSERT.
    assert svc._canonical_pair(_UPPER_FIRST, _LOWER_FIRST) == (
        _UPPER_FIRST,
        _LOWER_FIRST,
    )


def test_every_connections_writer_lets_the_database_order_the_pair():
    """Ordering happens in the statement the constraint judges -- in all three.

    Reads are order-agnostic: every one matches
    `user_a_id = :id OR user_b_id = :id`, so existing rows stay findable
    whichever way round they were stored. Only the INSERTs must satisfy
    `connections_canonical_order`.

    There are three, and the third is easy to miss -- `ConnectionGraphService`
    writes the same table through its own `canonical_pair`, carrying the
    identical Python-ordering bug. Fixing only the two in `connections_service`
    would have left circle-invite and origin materialisation failing the same
    way, for the same reason, with the same silent 500.
    """
    import inspect
    import re

    from hushh_mcp.services import connection_graph_service, connections_service

    writers = []
    for module in (connections_service, connection_graph_service):
        source = inspect.getsource(module)
        for match in re.finditer(r"INSERT INTO connections\s*\(", source):
            # The VALUES clause belonging to this INSERT.
            tail = source[match.end() : match.end() + 600]
            writers.append((module.__name__, tail))

    assert len(writers) == 3, f"expected 3 connections writers, found {len(writers)}"

    for module_name, tail in writers:
        values = tail[tail.index("VALUES") :] if "VALUES" in tail else ""
        assert "LEAST(" in values and "GREATEST(" in values, (
            f"{module_name}: a connections INSERT orders its pair outside SQL. "
            "Python's `<` is bytewise and disagrees with the en_US.UTF8 "
            "collation the CHECK uses, which is the CheckViolation this guards."
        )

    # The Python helpers survive for other callers, but nothing may use one to
    # choose the columns of a row the CHECK will judge.
    service_source = inspect.getsource(connections_service)
    assert "self._canonical_pair(requester, user_id)" not in service_source
    assert "self._canonical_pair(user_id, peer_user_id)" not in service_source
