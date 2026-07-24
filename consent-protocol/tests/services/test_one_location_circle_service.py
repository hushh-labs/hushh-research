from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from hushh_mcp.services.one_location_circle_service import (
    CIRCLE_MAX_PER_USER,
    OneLocationCircleError,
    OneLocationCircleService,
    format_circle_code,
    normalize_circle_code,
)


class _Rows:
    def __init__(self, *rows: dict | None) -> None:
        self._rows = list(rows)

    def fetchone(self):
        return self._rows.pop(0) if self._rows else None


class _CapacityConnection:
    def __init__(self, *rows: dict | None) -> None:
        self.rows = list(rows)
        self.sql: list[str] = []

    def execute(self, statement, _params):
        self.sql.append(str(statement))
        return _Rows(self.rows.pop(0) if self.rows else None)


class _Transaction:
    def __init__(self, conn: _CapacityConnection) -> None:
        self.conn = conn

    def __enter__(self):
        return self.conn

    def __exit__(self, exc_type, exc, traceback):
        return False


class _TransactionDb:
    def __init__(self, conn: _CapacityConnection) -> None:
        self.engine = SimpleNamespace(begin=lambda: _Transaction(conn))


def test_circle_code_normalization_is_human_friendly_and_bounded() -> None:
    assert normalize_circle_code("2345-6789-ABCD") == "23456789ABCD"
    assert normalize_circle_code(" 2345 6789 abcd ") == "23456789ABCD"
    assert format_circle_code("23456789ABCD") == "2345-6789-ABCD"

    for invalid in ("", "1234-5678-ABCD", "2345-6789-ABCI", "2345-6789-ABCDE"):
        with pytest.raises(OneLocationCircleError) as raised:
            normalize_circle_code(invalid)
        assert raised.value.code == "LOCATION_CIRCLE_CODE_INVALID"
        assert raised.value.status_code == 404


def test_circle_code_hash_is_keyed_domain_separated_and_contains_no_raw_code() -> None:
    code = normalize_circle_code("2345-6789-ABCD")
    first = OneLocationCircleService(db=object(), hmac_key="a" * 32)  # type: ignore[arg-type]
    second = OneLocationCircleService(db=object(), hmac_key="b" * 32)  # type: ignore[arg-type]

    first_digest = first._code_hash(code)
    second_digest = second._code_hash(code)

    assert re.fullmatch(r"[0-9a-f]{64}", first_digest)
    assert first_digest != second_digest
    assert code not in first_digest


def test_generated_circle_code_has_sixty_bits_of_unambiguous_entropy() -> None:
    codes = {OneLocationCircleService._new_code() for _ in range(100)}

    assert len(codes) == 100
    assert all(
        re.fullmatch(
            r"[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}(?:-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}){2}",
            code,
        )
        for code in codes
    )


def test_user_circle_capacity_is_serialized_on_the_actor_profile_row() -> None:
    conn = _CapacityConnection(
        {"user_id": "member-user"},
        {"circle_count": CIRCLE_MAX_PER_USER - 1},
    )

    OneLocationCircleService._lock_user_circle_memberships(
        conn,
        user_id="member-user",
    )
    OneLocationCircleService._assert_user_circle_capacity(
        conn,
        user_id="member-user",
    )

    assert "FROM actor_profiles" in conn.sql[0]
    assert "FOR UPDATE" in conn.sql[0]
    assert "one_location_circle_memberships" in conn.sql[1]


def test_user_circle_capacity_rejects_the_eleventh_membership() -> None:
    conn = _CapacityConnection({"circle_count": CIRCLE_MAX_PER_USER})

    with pytest.raises(OneLocationCircleError) as raised:
        OneLocationCircleService._assert_user_circle_capacity(
            conn,
            user_id="member-user",
        )

    assert raised.value.code == "LOCATION_CIRCLE_LIMIT_REACHED"
    assert raised.value.status_code == 409


def test_join_is_idempotent_before_capacity_is_consumed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    conn = _CapacityConnection(
        {"user_id": "member-user"},
        {
            "id": "550e8400-e29b-41d4-a716-446655440001",
            "circle_id": circle_id,
            "status": "active",
            "expires_at": datetime.now(timezone.utc) + timedelta(hours=1),
            "max_uses": 19,
            "use_count": 1,
            "owner_user_id": "owner-user",
            "member_limit": 20,
            "circle_status": "active",
        },
        {"role": "member", "status": "active"},
    )
    service = OneLocationCircleService(
        db=_TransactionDb(conn),  # type: ignore[arg-type]
        hmac_key="a" * 32,
    )
    monkeypatch.setattr(
        service,
        "get_circle",
        lambda **_kwargs: {"id": circle_id, "name": "Family"},
    )

    result = service.join_circle(
        user_id="member-user",
        code="2345-6789-ABCD",
    )

    assert result["joined"] is False
    assert result["circle"]["id"] == circle_id
    assert not any("INSERT INTO one_location_circle_memberships" in sql for sql in conn.sql)


def test_join_enforces_the_user_circle_limit_inside_the_locked_transaction() -> None:
    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    conn = _CapacityConnection(
        {"user_id": "member-user"},
        {
            "id": "550e8400-e29b-41d4-a716-446655440001",
            "circle_id": circle_id,
            "status": "active",
            "expires_at": datetime.now(timezone.utc) + timedelta(hours=1),
            "max_uses": 19,
            "use_count": 1,
            "owner_user_id": "owner-user",
            "member_limit": 20,
            "circle_status": "active",
        },
        None,
        {"circle_count": CIRCLE_MAX_PER_USER},
    )
    service = OneLocationCircleService(
        db=_TransactionDb(conn),  # type: ignore[arg-type]
        hmac_key="a" * 32,
    )

    with pytest.raises(OneLocationCircleError) as raised:
        service.join_circle(
            user_id="member-user",
            code="2345-6789-ABCD",
        )

    assert raised.value.code == "LOCATION_CIRCLE_LIMIT_REACHED"
    assert "FROM actor_profiles" in conn.sql[0]
    assert "FOR UPDATE" in conn.sql[0]
    assert not any("INSERT INTO one_location_circle_memberships" in sql for sql in conn.sql)
