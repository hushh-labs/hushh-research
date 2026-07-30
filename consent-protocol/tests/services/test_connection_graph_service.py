from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from hushh_mcp.services.connection_graph_service import (
    ORIGIN_DIRECT_REQUEST,
    ORIGIN_NAMED_CIRCLE,
    ConnectionGraphService,
    ensure_connection_origin,
    revoke_circle_origins,
)


class _Result:
    def __init__(self, rows=None):
        self._rows = list(rows or [])

    def mappings(self):
        return self

    def first(self):
        return self._rows[0] if self._rows else None

    def all(self):
        return self._rows

    def fetchall(self):
        return self._rows


class _Connection:
    def __init__(self, results):
        self._results = list(results)
        self.calls = []

    def execute(self, statement, params=None):
        self.calls.append((str(statement), params or {}))
        rows = self._results.pop(0) if self._results else []
        return _Result(rows)


def test_canonical_pair_validates_and_sorts():
    assert ConnectionGraphService.canonical_pair("user-z", "user-a") == ("user-a", "user-z")
    with pytest.raises(ValueError):
        ConnectionGraphService.canonical_pair("same", "same")
    with pytest.raises(ValueError):
        ConnectionGraphService.canonical_pair("", "user-b")


def test_named_circle_origin_key_is_circle_specific():
    assert (
        ConnectionGraphService.origin_key(
            ORIGIN_NAMED_CIRCLE,
            source_circle_id="00000000-0000-4000-8000-000000000001",
        )
        == "named_circle:00000000-0000-4000-8000-000000000001"
    )
    with pytest.raises(ValueError):
        ConnectionGraphService.origin_key(ORIGIN_NAMED_CIRCLE)
    with pytest.raises(ValueError):
        ConnectionGraphService.origin_key(
            ORIGIN_DIRECT_REQUEST,
            source_circle_id="00000000-0000-4000-8000-000000000001",
        )


def test_ensure_named_circle_origin_is_idempotent_and_does_not_touch_trusted_edges():
    circle_id = "00000000-0000-4000-8000-000000000001"
    connection_id = "00000000-0000-4000-8000-000000000002"
    conn = _Connection(
        [
            [{"id": connection_id, "user_a_id": "user-a", "user_b_id": "user-b"}],
            [],
            [],
            [{"id": connection_id, "user_a_id": "user-a", "user_b_id": "user-b"}],
            [
                {
                    "active_origin_count": 1,
                    "direct_origin_count": 0,
                    "circle_origin_count": 1,
                    "circles": [{"id": circle_id, "name": "Family"}],
                    "aggregate_source": "named_circle",
                }
            ],
            [],
        ]
    )

    state = ensure_connection_origin(
        conn,
        user_a_id="user-b",
        user_b_id="user-a",
        kind=ORIGIN_NAMED_CIRCLE,
        source_circle_id=circle_id,
    )

    assert state["active"] is True
    assert state["connectionKind"] == "circle"
    assert state["circleIds"] == [circle_id]
    assert state["circleNames"] == ["Family"]
    assert state["circles"] == [{"id": circle_id, "name": "Family"}]
    assert conn.calls[0][1]["user_a"] == "user-a"
    assert conn.calls[0][1]["user_b"] == "user-b"
    origin_insert = next(sql for sql, _ in conn.calls if "INSERT INTO connection_origins" in sql)
    assert "ON CONFLICT (connection_id, origin_key)" in origin_insert
    assert all("trusted_connections" not in sql for sql, _ in conn.calls)
    assert any("supersededByConnectionId" in sql for sql, _ in conn.calls)


def test_revoke_direct_origin_preserves_circle_aggregate():
    connection_id = "00000000-0000-4000-8000-000000000002"
    circle_id = "00000000-0000-4000-8000-000000000001"
    conn = _Connection(
        [
            [{"id": "origin-direct"}],
            [{"id": connection_id, "user_a_id": "user-a", "user_b_id": "user-b"}],
            [
                {
                    "active_origin_count": 1,
                    "direct_origin_count": 0,
                    "circle_origin_count": 1,
                    "circles": [{"id": circle_id, "name": "Family"}],
                    "aggregate_source": "named_circle",
                }
            ],
            [],
        ]
    )

    state = ConnectionGraphService.revoke_origins(
        conn,
        connection_id=connection_id,
        origin_kinds=[ORIGIN_DIRECT_REQUEST],
    )

    assert state["revokedOrigins"] == 1
    assert state["active"] is True
    assert state["connectionKind"] == "circle"
    aggregate_update = conn.calls[-1]
    assert aggregate_update[1]["active"] is True
    assert aggregate_update[1]["source"] == "named_circle"


def test_revoke_circle_origins_recomputes_each_connection_in_locked_order():
    circle_id = "00000000-0000-4000-8000-000000000001"
    connection_id = "00000000-0000-4000-8000-000000000002"
    conn = _Connection(
        [
            [{"id": connection_id}],
            [{"id": "origin-circle"}],
            [{"id": connection_id, "user_a_id": "user-a", "user_b_id": "user-b"}],
            [
                {
                    "active_origin_count": 1,
                    "direct_origin_count": 1,
                    "circle_origin_count": 0,
                    "circles": [],
                    "aggregate_source": "request",
                }
            ],
            [],
        ]
    )

    states = revoke_circle_origins(
        conn,
        circle_id=circle_id,
        member_user_id="user-b",
    )

    assert len(states) == 1
    assert states[0]["active"] is True
    assert states[0]["connectionKind"] == "direct"
    assert conn.calls[0][1] == {
        "source_circle_id": circle_id,
        "member_user_id": "user-b",
    }
    assert "ORDER BY connection.user_a_id, connection.user_b_id" in conn.calls[0][0]


def test_ensure_origins_sorts_and_deduplicates_pairs():
    conn = SimpleNamespace()
    calls = []

    def _ensure(_conn, **kwargs):
        calls.append((kwargs["user_x"], kwargs["user_y"]))
        return kwargs

    with patch.object(ConnectionGraphService, "ensure_origin", side_effect=_ensure):
        ConnectionGraphService.ensure_origins(
            conn,
            pairs=[
                ("user-z", "user-a"),
                ("user-a", "user-z"),
                ("user-c", "user-b"),
            ],
            origin_kind=ORIGIN_NAMED_CIRCLE,
            source_circle_id="00000000-0000-4000-8000-000000000001",
        )

    assert calls == [("user-a", "user-z"), ("user-b", "user-c")]


def test_migration_backfills_existing_active_circle_member_pairs():
    migration_path = (
        Path(__file__).resolve().parents[2]
        / "db"
        / "migrations"
        / "126_one_location_circle_connection_origins.sql"
    )
    sql = migration_path.read_text(encoding="utf-8")

    assert "WITH active_circle_pairs AS" in sql
    assert "first_member.user_id < second_member.user_id" in sql
    assert "WHERE circle.status = 'active'" in sql
    assert "INSERT INTO connections" in sql
    assert "'named_circle:' || circle.id::text" in sql
    assert "ON CONFLICT (connection_id, origin_key) DO UPDATE" in sql
    assert "supersededByConnectionId" in sql


def test_recompute_uses_one_ordered_circle_mapping():
    connection_id = "00000000-0000-4000-8000-000000000002"
    circle_a = "00000000-0000-4000-8000-000000000001"
    circle_b = "00000000-0000-4000-8000-000000000003"
    conn = _Connection(
        [
            [{"id": connection_id, "user_a_id": "user-a", "user_b_id": "user-b"}],
            [
                {
                    "active_origin_count": 2,
                    "direct_origin_count": 0,
                    "circle_origin_count": 2,
                    "circles": [
                        {"id": circle_a, "name": "Same name"},
                        {"id": circle_b, "name": "Same name"},
                    ],
                    "aggregate_source": "named_circle",
                }
            ],
            [],
        ]
    )

    state = ConnectionGraphService.recompute_connection(
        conn,
        connection_id=connection_id,
    )

    provenance_sql = conn.calls[1][0]
    assert "JSONB_AGG(" in provenance_sql
    assert "ORDER BY origin.source_circle_id::text" in provenance_sql
    assert "ARRAY_AGG" not in provenance_sql
    assert state["circleIds"] == [circle_a, circle_b]
    assert state["circleNames"] == ["Same name", "Same name"]
    assert state["circles"] == [
        {"id": circle_a, "name": "Same name"},
        {"id": circle_b, "name": "Same name"},
    ]
