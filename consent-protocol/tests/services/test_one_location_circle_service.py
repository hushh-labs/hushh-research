from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

import hushh_mcp.services.one_location_circle_service as circle_service_module
import hushh_mcp.services.push_notifications as push_notifications_module
from hushh_mcp.services.one_location_circle_service import (
    CIRCLE_MAX_PER_USER,
    OneLocationCircleError,
    OneLocationCircleService,
    format_circle_code,
    normalize_circle_code,
)
from hushh_mcp.services.push_notifications import send_circle_member_invite_push


def test_circle_member_payload_includes_public_recipient_key_for_group_selection() -> None:
    payload = OneLocationCircleService._member_payload(
        {
            "user_id": "member-1",
            "display_name": "Member",
            "role": "member",
            "phone_verified": True,
            "key_id": "key-1",
            "public_key_jwk": '{"kty":"EC","crv":"P-256"}',
            "algorithm": "ECDH-P256-AES256-GCM",
        }
    )

    assert payload["keyId"] == "key-1"
    assert payload["publicKeyJwk"] == {"kty": "EC", "crv": "P-256"}
    assert payload["canReceiveLocation"] is True
    assert payload["secureLocationReady"] is True


def test_circle_summary_uses_canonical_owner_instead_of_membership_role() -> None:
    owner_summary = OneLocationCircleService._circle_summary(
        {
            "id": "circle-1",
            "name": "Family",
            "role": "member",
            "owner_user_id": "owner-user",
            "viewer_user_id": "owner-user",
        }
    )
    drifted_member_summary = OneLocationCircleService._circle_summary(
        {
            "id": "circle-1",
            "name": "Family",
            "role": "owner",
            "owner_user_id": "owner-user",
            "viewer_user_id": "member-user",
        }
    )

    assert owner_summary["role"] == "owner"
    assert owner_summary["viewerCapabilities"]["canRotateInviteCode"] is True
    assert owner_summary["viewerCapabilities"]["canManageCircle"] is True
    assert drifted_member_summary["role"] == "member"
    assert drifted_member_summary["viewerCapabilities"]["canInviteMembers"] is True
    assert drifted_member_summary["viewerCapabilities"]["canRotateInviteCode"] is False
    assert drifted_member_summary["viewerCapabilities"]["canManageCircle"] is False


class _Rows:
    def __init__(self, *rows: dict | None) -> None:
        self._rows = list(rows)

    def fetchone(self):
        return self._rows.pop(0) if self._rows else None

    def fetchall(self):
        rows = list(self._rows)
        self._rows.clear()
        return rows


class _CapacityConnection:
    def __init__(self, *rows: dict | None) -> None:
        self.rows = list(rows)
        self.sql: list[str] = []
        self.params: list[dict] = []

    def execute(self, statement, params):
        self.sql.append(str(statement))
        self.params.append(dict(params))
        row = self.rows.pop(0) if self.rows else None
        return _Rows(*row) if isinstance(row, list) else _Rows(row)


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


def test_member_ensures_re_readable_shared_code_without_rotating_it() -> None:
    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    invite_id = "550e8400-e29b-41d4-a716-446655440001"
    service = OneLocationCircleService(db=object(), hmac_key="a" * 32)  # type: ignore[arg-type]
    code = service._code_for_invite_id(invite_id)
    active_row = {
        "id": invite_id,
        "circle_id": circle_id,
        "code_hash": service._code_hash(normalize_circle_code(code)),
        "expires_at": datetime.now(timezone.utc) + timedelta(hours=1),
        "metadata": {"codeVersion": "derived-v1"},
    }
    conn = _CapacityConnection(
        {
            "id": circle_id,
            "owner_user_id": "owner-user",
            "member_limit": 20,
            "role": "member",
        },
        {"role": "member"},
        None,
        active_row,
    )
    service._db = _TransactionDb(conn)  # type: ignore[assignment]

    result = service.create_invite_code(
        actor_user_id="member-user",
        circle_id=circle_id,
    )

    assert result["code"] == code
    assert not any("INSERT INTO one_location_circle_invite_codes" in sql for sql in conn.sql)
    assert not any("revoked_at = NOW()" in sql for sql in conn.sql)
    circle_lock_index = next(
        index
        for index, sql in enumerate(conn.sql)
        if "FROM one_location_circles circle" in sql and "FOR UPDATE" in sql
    )
    membership_lock_index = next(
        index
        for index, sql in enumerate(conn.sql)
        if "FROM one_location_circle_memberships" in sql and "FOR UPDATE" in sql
    )
    code_lock_index = next(
        index
        for index, sql in enumerate(conn.sql)
        if "FROM one_location_circle_invite_codes" in sql and "FOR UPDATE" in sql
    )
    assert circle_lock_index < membership_lock_index < code_lock_index


def test_member_can_create_shared_code_but_cannot_rotate_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    invite_id = "550e8400-e29b-41d4-a716-446655440001"
    monkeypatch.setattr(circle_service_module.uuid, "uuid4", lambda: invite_id)
    service = OneLocationCircleService(db=object(), hmac_key="a" * 32)  # type: ignore[arg-type]
    code = service._code_for_invite_id(invite_id)
    inserted_row = {
        "id": invite_id,
        "circle_id": circle_id,
        "code_hash": service._code_hash(normalize_circle_code(code)),
        "expires_at": datetime.now(timezone.utc) + timedelta(hours=72),
        "metadata": {"codeVersion": "derived-v1"},
    }
    conn = _CapacityConnection(
        {
            "id": circle_id,
            "owner_user_id": "owner-user",
            "member_limit": 20,
            "role": "member",
        },
        {"role": "member"},
        None,
        None,
        inserted_row,
    )
    service._db = _TransactionDb(conn)  # type: ignore[assignment]

    result = service.create_invite_code(
        actor_user_id="member-user",
        circle_id=circle_id,
    )

    assert result["code"] == code
    insert_index = next(
        index
        for index, sql in enumerate(conn.sql)
        if "INSERT INTO one_location_circle_invite_codes" in sql
    )
    assert code not in str(conn.params[insert_index])
    assert conn.params[insert_index]["actor_user_id"] == "member-user"

    denied_conn = _CapacityConnection(
        {
            "id": circle_id,
            "owner_user_id": "owner-user",
            "member_limit": 20,
            "role": "owner",
        },
        {"role": "owner"},
    )
    service._db = _TransactionDb(denied_conn)  # type: ignore[assignment]
    with pytest.raises(OneLocationCircleError) as raised:
        service.create_invite_code(
            actor_user_id="member-user",
            circle_id=circle_id,
            rotate=True,
        )
    assert raised.value.code == "LOCATION_CIRCLE_OWNER_REQUIRED"
    assert not any("one_location_circle_invite_codes" in sql for sql in denied_conn.sql)


def test_owner_can_rotate_the_shared_circle_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    old_invite_id = "550e8400-e29b-41d4-a716-446655440001"
    new_invite_id = "550e8400-e29b-41d4-a716-446655440002"
    monkeypatch.setattr(circle_service_module.uuid, "uuid4", lambda: new_invite_id)
    service = OneLocationCircleService(db=object(), hmac_key="a" * 32)  # type: ignore[arg-type]

    def _row(invite_id: str) -> dict:
        code = service._code_for_invite_id(invite_id)
        return {
            "id": invite_id,
            "circle_id": circle_id,
            "code_hash": service._code_hash(normalize_circle_code(code)),
            "expires_at": datetime.now(timezone.utc) + timedelta(hours=1),
            "metadata": {"codeVersion": "derived-v1"},
        }

    conn = _CapacityConnection(
        {
            "id": circle_id,
            "owner_user_id": "owner-user",
            "member_limit": 20,
            "role": "member",
        },
        {"role": "member"},
        None,
        _row(old_invite_id),
        None,
        _row(new_invite_id),
    )
    service._db = _TransactionDb(conn)  # type: ignore[assignment]

    result = service.create_invite_code(
        actor_user_id="owner-user",
        circle_id=circle_id,
        rotate=True,
    )

    assert result["id"] == new_invite_id
    assert result["code"] != service._code_for_invite_id(old_invite_id)
    assert any(
        "WHERE id = CAST(:invite_id AS UUID)" in sql and "revoked_at = NOW()" in sql
        for sql in conn.sql
    )


def test_member_ensure_does_not_rotate_an_unreadable_legacy_code() -> None:
    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    service = OneLocationCircleService(db=object(), hmac_key="a" * 32)  # type: ignore[arg-type]
    conn = _CapacityConnection(
        {
            "id": circle_id,
            "owner_user_id": "owner-user",
            "member_limit": 20,
            "role": "member",
        },
        {"role": "member"},
        None,
        {
            "id": "550e8400-e29b-41d4-a716-446655440001",
            "circle_id": circle_id,
            "code_hash": "f" * 64,
            "expires_at": datetime.now(timezone.utc) + timedelta(hours=1),
            "metadata": {},
        },
    )
    service._db = _TransactionDb(conn)  # type: ignore[assignment]

    with pytest.raises(OneLocationCircleError) as raised:
        service.create_invite_code(
            actor_user_id="member-user",
            circle_id=circle_id,
        )

    assert raised.value.code == "LOCATION_CIRCLE_CODE_ROTATION_REQUIRED"
    assert not any("revoked_at = NOW()" in sql for sql in conn.sql)
    assert not any("INSERT INTO one_location_circle_invite_codes" in sql for sql in conn.sql)


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
    invite_id = "550e8400-e29b-41d4-a716-446655440001"
    conn = _CapacityConnection(
        {"id": invite_id, "circle_id": circle_id},
        {
            "id": circle_id,
            "owner_user_id": "owner-user",
            "member_limit": 20,
            "status": "active",
        },
        {"user_id": "member-user"},
        {
            "id": invite_id,
            "circle_id": circle_id,
            "status": "active",
            "expires_at": datetime.now(timezone.utc) + timedelta(hours=1),
            "max_uses": 19,
            "use_count": 1,
        },
        {"role": "member", "status": "active"},
        [{"user_id": "member-user"}, {"user_id": "owner-user"}],
        None,
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
    monkeypatch.setattr(
        circle_service_module,
        "ensure_connection_origin",
        lambda _conn, **_kwargs: {},
    )

    result = service.join_circle(
        user_id="member-user",
        code="2345-6789-ABCD",
    )

    assert result["joined"] is False
    assert result["circle"]["id"] == circle_id
    assert not any("INSERT INTO one_location_circle_memberships" in sql for sql in conn.sql)
    assert any(
        "one_location_circle_member_invites" in sql and "accepted" in sql for sql in conn.sql
    )
    circle_lock_index = next(
        index
        for index, sql in enumerate(conn.sql)
        if "FROM one_location_circles" in sql and "FOR UPDATE" in sql
    )
    code_lock_index = next(
        index
        for index, sql in enumerate(conn.sql)
        if "FROM one_location_circle_invite_codes" in sql and "FOR UPDATE" in sql
    )
    membership_lock_index = next(
        index
        for index, sql in enumerate(conn.sql)
        if "FROM one_location_circle_memberships" in sql and "FOR UPDATE" in sql
    )
    assert circle_lock_index < code_lock_index < membership_lock_index


def test_join_enforces_the_user_circle_limit_inside_the_locked_transaction() -> None:
    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    invite_id = "550e8400-e29b-41d4-a716-446655440001"
    conn = _CapacityConnection(
        {"id": invite_id, "circle_id": circle_id},
        {
            "id": circle_id,
            "owner_user_id": "owner-user",
            "member_limit": 20,
            "status": "active",
        },
        {"user_id": "member-user"},
        {
            "id": invite_id,
            "circle_id": circle_id,
            "status": "active",
            "expires_at": datetime.now(timezone.utc) + timedelta(hours=1),
            "max_uses": 19,
            "use_count": 1,
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
    actor_lock_index = next(
        index for index, sql in enumerate(conn.sql) if "FROM actor_profiles" in sql
    )
    circle_lock_index = next(
        index
        for index, sql in enumerate(conn.sql)
        if "FROM one_location_circles" in sql and "FOR UPDATE" in sql
    )
    assert "FOR UPDATE" in conn.sql[actor_lock_index]
    assert circle_lock_index < actor_lock_index
    assert not any("INSERT INTO one_location_circle_memberships" in sql for sql in conn.sql)


def test_code_join_respects_capacity_reserved_by_other_pending_invites() -> None:
    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    invite_id = "550e8400-e29b-41d4-a716-446655440001"
    conn = _CapacityConnection(
        {"id": invite_id, "circle_id": circle_id},
        {
            "id": circle_id,
            "owner_user_id": "owner-user",
            "member_limit": 20,
            "status": "active",
        },
        {"user_id": "member-user"},
        {
            "id": invite_id,
            "circle_id": circle_id,
            "status": "active",
            "expires_at": datetime.now(timezone.utc) + timedelta(hours=1),
            "max_uses": 19,
            "use_count": 1,
        },
        None,
        {"circle_count": 0},
        {"member_count": 20},
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

    assert raised.value.code == "LOCATION_CIRCLE_FULL"
    assert any(
        "one_location_circle_member_invites invite" in sql
        and "invite.invitee_user_id <> :user_id" in sql
        for sql in conn.sql
    )
    assert not any("INSERT INTO one_location_circle_memberships" in sql for sql in conn.sql)


def test_code_join_revalidates_revocation_after_locking_the_circle() -> None:
    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    invite_id = "550e8400-e29b-41d4-a716-446655440001"
    conn = _CapacityConnection(
        {"id": invite_id, "circle_id": circle_id},
        {
            "id": circle_id,
            "owner_user_id": "owner-user",
            "member_limit": 20,
            "status": "active",
        },
        {"user_id": "member-user"},
        {
            "id": invite_id,
            "circle_id": circle_id,
            "status": "revoked",
            "expires_at": datetime.now(timezone.utc) + timedelta(hours=1),
            "max_uses": 19,
            "use_count": 1,
        },
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

    assert raised.value.code == "LOCATION_CIRCLE_CODE_INVALID"
    assert not any("one_location_circle_memberships" in sql for sql in conn.sql)
    assert not any("SET use_count = use_count + 1" in sql for sql in conn.sql)


def test_join_origin_sync_connects_every_other_active_member_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    conn = _CapacityConnection(
        [
            {"user_id": "member-user"},
            {"user_id": "owner-user"},
            {"user_id": "friend-user"},
            {"user_id": "friend-user"},
        ]
    )
    calls: list[dict] = []
    monkeypatch.setattr(
        circle_service_module,
        "ensure_connection_origin",
        lambda _conn, **kwargs: calls.append(kwargs) or {},
    )

    OneLocationCircleService._connect_member_to_circle(
        conn,
        circle_id=circle_id,
        user_id="member-user",
    )

    assert calls == [
        {
            "user_a_id": "member-user",
            "user_b_id": "friend-user",
            "kind": "named_circle",
            "source_circle_id": circle_id,
        },
        {
            "user_a_id": "member-user",
            "user_b_id": "owner-user",
            "kind": "named_circle",
            "source_circle_id": circle_id,
        },
    ]


def test_member_invite_payload_is_metadata_only() -> None:
    payload = OneLocationCircleService._member_invite_payload(
        {
            "id": "550e8400-e29b-41d4-a716-446655440002",
            "circle_id": "550e8400-e29b-41d4-a716-446655440000",
            "circle_name": "Family",
            "circle_kind": "family",
            "inviter_user_id": "inviter-member",
            "inviter_display_name": "Owner",
            "invitee_user_id": "member-user",
            "invitee_display_name": "Member",
            "status": "pending",
            "expires_at": datetime.now(timezone.utc) + timedelta(hours=1),
            "created_at": datetime.now(timezone.utc),
        }
    )

    assert payload["circleName"] == "Family"
    assert payload["inviteeUserId"] == "member-user"
    for forbidden in ("grant", "ciphertext", "latitude", "longitude", "sms"):
        assert forbidden not in str(payload).lower()


def test_targeted_invite_accept_rechecks_direct_connection_and_creates_origins(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    invite_id = "550e8400-e29b-41d4-a716-446655440002"
    now = datetime.now(timezone.utc)
    conn = _CapacityConnection(
        {"id": invite_id, "circle_id": circle_id},
        {
            "id": circle_id,
            "owner_user_id": "owner-user",
            "member_limit": 20,
            "status": "active",
            "name": "Family",
            "kind": "family",
        },
        {"user_id": "member-user"},
        {
            "id": invite_id,
            "circle_id": circle_id,
            "inviter_user_id": "inviter-member",
            "invitee_user_id": "member-user",
            "status": "pending",
            "expires_at": now + timedelta(hours=1),
            "created_at": now,
        },
        None,
        {"user_id": "inviter-member"},
        {"id": "connection-id"},
        {"id": "direct-origin-id"},
        {"circle_count": 0},
        {"member_count": 1},
        None,
        [
            {"user_id": "member-user"},
            {"user_id": "inviter-member"},
            {"user_id": "owner-user"},
        ],
        None,
    )
    service = OneLocationCircleService(
        db=_TransactionDb(conn),  # type: ignore[arg-type]
        hmac_key="a" * 32,
    )
    origin_calls: list[dict] = []
    monkeypatch.setattr(
        circle_service_module,
        "ensure_connection_origin",
        lambda _conn, **kwargs: origin_calls.append(kwargs) or {},
    )
    monkeypatch.setattr(
        service,
        "get_circle",
        lambda **_kwargs: {"id": circle_id, "name": "Family"},
    )

    result = service.accept_member_invite(
        user_id="member-user",
        invite_id=invite_id,
    )

    assert result["accepted"] is True
    assert result["joined"] is True
    assert result["invite"]["status"] == "accepted"
    assert origin_calls == [
        {
            "user_a_id": "member-user",
            "user_b_id": "inviter-member",
            "kind": "named_circle",
            "source_circle_id": circle_id,
        },
        {
            "user_a_id": "member-user",
            "user_b_id": "owner-user",
            "kind": "named_circle",
            "source_circle_id": circle_id,
        },
    ]
    connection_lock_index = next(
        index
        for index, sql in enumerate(conn.sql)
        if "FROM connections connection" in sql and "FOR UPDATE OF connection" in sql
    )
    origin_lock_index = next(
        index
        for index, sql in enumerate(conn.sql)
        if "FROM connection_origins" in sql and "FOR UPDATE" in sql
    )
    # The lock must not narrow to one provenance: a Circle co-member is a
    # connection, so the origin that keeps them connected is lockable whatever
    # kind it is.
    assert "origin_kind" not in conn.sql[origin_lock_index]
    membership_insert_index = next(
        index
        for index, sql in enumerate(conn.sql)
        if "INSERT INTO one_location_circle_memberships" in sql
    )
    assert "FOR UPDATE" in conn.sql[origin_lock_index]
    circle_lock_index = next(
        index
        for index, sql in enumerate(conn.sql)
        if "FROM one_location_circles" in sql and "FOR UPDATE" in sql
    )
    invite_lock_index = next(
        index
        for index, sql in enumerate(conn.sql)
        if "FROM one_location_circle_member_invites invite" in sql and "FOR UPDATE OF invite" in sql
    )
    target_membership_index = next(
        index
        for index, (sql, params) in enumerate(zip(conn.sql, conn.params, strict=True))
        if "FROM one_location_circle_memberships" in sql
        and params.get("user_id") == "member-user"
        and "FOR UPDATE" in sql
    )
    inviter_membership_index = next(
        index
        for index, (sql, params) in enumerate(zip(conn.sql, conn.params, strict=True))
        if "FROM one_location_circle_memberships" in sql
        and params.get("inviter_user_id") == "inviter-member"
        and "FOR UPDATE" in sql
    )
    assert (
        circle_lock_index
        < invite_lock_index
        < target_membership_index
        < inviter_membership_index
        < connection_lock_index
        < origin_lock_index
        < membership_insert_index
    )


def test_targeted_invite_accept_fails_if_direct_connection_was_removed() -> None:
    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    invite_id = "550e8400-e29b-41d4-a716-446655440002"
    conn = _CapacityConnection(
        {"id": invite_id, "circle_id": circle_id},
        {
            "id": circle_id,
            "owner_user_id": "owner-user",
            "member_limit": 20,
            "status": "active",
            "name": "Family",
            "kind": "family",
        },
        {"user_id": "member-user"},
        {
            "id": invite_id,
            "circle_id": circle_id,
            "inviter_user_id": "owner-user",
            "invitee_user_id": "member-user",
            "status": "pending",
            "expires_at": datetime.now(timezone.utc) + timedelta(hours=1),
        },
        None,
        {"user_id": "owner-user"},
        None,
    )
    service = OneLocationCircleService(
        db=_TransactionDb(conn),  # type: ignore[arg-type]
        hmac_key="a" * 32,
    )

    with pytest.raises(OneLocationCircleError) as raised:
        service.accept_member_invite(
            user_id="member-user",
            invite_id=invite_id,
        )

    assert raised.value.code == "LOCATION_CIRCLE_DIRECT_CONNECTION_REQUIRED"
    assert any(
        "FROM connections connection" in sql and "FOR UPDATE OF connection" in sql
        for sql in conn.sql
    )
    assert not any("INSERT INTO one_location_circle_memberships" in sql for sql in conn.sql)


def test_targeted_invite_accept_fails_after_inviter_leaves_circle() -> None:
    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    invite_id = "550e8400-e29b-41d4-a716-446655440002"
    conn = _CapacityConnection(
        {"id": invite_id, "circle_id": circle_id},
        {
            "id": circle_id,
            "owner_user_id": "owner-user",
            "member_limit": 20,
            "status": "active",
            "name": "Family",
            "kind": "family",
        },
        {"user_id": "member-user"},
        {
            "id": invite_id,
            "circle_id": circle_id,
            "inviter_user_id": "departed-member",
            "invitee_user_id": "member-user",
            "status": "pending",
            "expires_at": datetime.now(timezone.utc) + timedelta(hours=1),
        },
        None,
        None,
    )
    service = OneLocationCircleService(
        db=_TransactionDb(conn),  # type: ignore[arg-type]
        hmac_key="a" * 32,
    )

    with pytest.raises(OneLocationCircleError) as raised:
        service.accept_member_invite(
            user_id="member-user",
            invite_id=invite_id,
        )

    assert raised.value.code == "LOCATION_CIRCLE_INVITE_NOT_AVAILABLE"
    assert not any("FROM connections connection" in sql for sql in conn.sql)


def test_targeted_invite_accept_rechecks_direct_origin_after_connection_lock() -> None:
    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    invite_id = "550e8400-e29b-41d4-a716-446655440002"
    conn = _CapacityConnection(
        {"id": invite_id, "circle_id": circle_id},
        {
            "id": circle_id,
            "owner_user_id": "owner-user",
            "member_limit": 20,
            "status": "active",
            "name": "Family",
            "kind": "family",
        },
        {"user_id": "member-user"},
        {
            "id": invite_id,
            "circle_id": circle_id,
            "inviter_user_id": "owner-user",
            "invitee_user_id": "member-user",
            "status": "pending",
            "expires_at": datetime.now(timezone.utc) + timedelta(hours=1),
        },
        None,
        {"user_id": "owner-user"},
        {"id": "connection-id"},
        None,
    )
    service = OneLocationCircleService(
        db=_TransactionDb(conn),  # type: ignore[arg-type]
        hmac_key="a" * 32,
    )

    with pytest.raises(OneLocationCircleError) as raised:
        service.accept_member_invite(
            user_id="member-user",
            invite_id=invite_id,
        )

    assert raised.value.code == "LOCATION_CIRCLE_DIRECT_CONNECTION_REQUIRED"
    connection_lock_index = next(
        index for index, sql in enumerate(conn.sql) if "FROM connections connection" in sql
    )
    origin_lock_index = next(
        index for index, sql in enumerate(conn.sql) if "FROM connection_origins" in sql
    )
    assert connection_lock_index < origin_lock_index
    assert "FOR UPDATE OF connection" in conn.sql[connection_lock_index]
    assert "FOR UPDATE" in conn.sql[origin_lock_index]
    assert not any("INSERT INTO one_location_circle_memberships" in sql for sql in conn.sql)


def test_member_authored_invite_cannot_restore_an_owner_removed_membership() -> None:
    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    invite_id = "550e8400-e29b-41d4-a716-446655440002"
    conn = _CapacityConnection(
        {"id": invite_id, "circle_id": circle_id},
        {
            "id": circle_id,
            "owner_user_id": "owner-user",
            "member_limit": 20,
            "status": "active",
            "name": "Family",
            "kind": "family",
        },
        {"user_id": "removed-user"},
        {
            "id": invite_id,
            "circle_id": circle_id,
            "inviter_user_id": "member-user",
            "invitee_user_id": "removed-user",
            "status": "pending",
            "expires_at": datetime.now(timezone.utc) + timedelta(hours=1),
        },
        {"role": "member", "status": "removed"},
    )
    service = OneLocationCircleService(
        db=_TransactionDb(conn),  # type: ignore[arg-type]
        hmac_key="a" * 32,
    )

    with pytest.raises(OneLocationCircleError) as raised:
        service.accept_member_invite(
            user_id="removed-user",
            invite_id=invite_id,
        )

    assert raised.value.code == "LOCATION_CIRCLE_MEMBERSHIP_REMOVED"
    assert not any("FROM connections connection" in sql for sql in conn.sql)
    assert not any("INSERT INTO one_location_circle_memberships" in sql for sql in conn.sql)
    assert not any(
        "SET status = 'accepted'" in sql
        for sql in conn.sql
        if "one_location_circle_member_invites" in sql
    )


def test_owner_authored_invite_can_restore_a_removed_membership(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    invite_id = "550e8400-e29b-41d4-a716-446655440002"
    now = datetime.now(timezone.utc)
    conn = _CapacityConnection(
        {"id": invite_id, "circle_id": circle_id},
        {
            "id": circle_id,
            "owner_user_id": "owner-user",
            "member_limit": 20,
            "status": "active",
            "name": "Family",
            "kind": "family",
        },
        {"user_id": "removed-user"},
        {
            "id": invite_id,
            "circle_id": circle_id,
            "inviter_user_id": "owner-user",
            "invitee_user_id": "removed-user",
            "status": "pending",
            "expires_at": now + timedelta(hours=1),
            "created_at": now,
        },
        {"role": "member", "status": "removed"},
        {"user_id": "owner-user", "role": "owner"},
        {"id": "connection-id"},
        {"id": "direct-origin-id"},
        {"circle_count": 0},
        {"member_count": 1},
        None,
        None,
    )
    service = OneLocationCircleService(
        db=_TransactionDb(conn),  # type: ignore[arg-type]
        hmac_key="a" * 32,
    )
    monkeypatch.setattr(
        service,
        "_connect_member_to_circle",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(
        service,
        "get_circle",
        lambda **_kwargs: {"id": circle_id, "name": "Family"},
    )

    result = service.accept_member_invite(
        user_id="removed-user",
        invite_id=invite_id,
    )

    assert result["accepted"] is True
    assert result["joined"] is True
    assert any(
        "ON CONFLICT (circle_id, user_id) DO UPDATE SET" in sql and "status = 'active'" in sql
        for sql in conn.sql
    )


def test_accepted_invite_replay_after_leave_does_not_recreate_circle_origins(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    invite_id = "550e8400-e29b-41d4-a716-446655440002"
    conn = _CapacityConnection(
        {"id": invite_id, "circle_id": circle_id},
        {
            "id": circle_id,
            "owner_user_id": "owner-user",
            "member_limit": 20,
            "status": "active",
            "name": "Family",
            "kind": "family",
        },
        {"user_id": "member-user"},
        {
            "id": invite_id,
            "circle_id": circle_id,
            "inviter_user_id": "owner-user",
            "invitee_user_id": "member-user",
            "status": "accepted",
            "expires_at": datetime.now(timezone.utc) + timedelta(hours=1),
        },
        None,
    )
    service = OneLocationCircleService(
        db=_TransactionDb(conn),  # type: ignore[arg-type]
        hmac_key="a" * 32,
    )
    origin_calls: list[dict] = []
    monkeypatch.setattr(
        circle_service_module,
        "ensure_connection_origin",
        lambda _conn, **kwargs: origin_calls.append(kwargs) or {},
    )

    with pytest.raises(OneLocationCircleError) as raised:
        service.accept_member_invite(
            user_id="member-user",
            invite_id=invite_id,
        )

    assert raised.value.code == "LOCATION_CIRCLE_INVITE_NOT_AVAILABLE"
    assert origin_calls == []


def test_member_invite_batch_is_atomic_idempotent_and_pushes_only_new_rows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    existing_id = "550e8400-e29b-41d4-a716-446655440002"
    new_id = "550e8400-e29b-41d4-a716-446655440003"
    now = datetime.now(timezone.utc)
    conn = _CapacityConnection(
        {
            "id": circle_id,
            "name": "Family",
            "kind": "family",
            "owner_user_id": "owner-user",
            "member_limit": 20,
            "inviter_display_name": "Owner",
        },
        {"role": "owner", "inviter_display_name": "Owner"},
        None,
        [{"user_id": "friend-two", "status": "removed"}],
        [
            {
                "connection_id": "connection-1",
                "user_id": "friend-one",
                "invitee_display_name": "Friend One",
            },
            {
                "connection_id": "connection-2",
                "user_id": "friend-two",
                "invitee_display_name": "Friend Two",
            },
        ],
        [
            {"connection_id": "connection-1"},
            {"connection_id": "connection-2"},
        ],
        [
            {
                "id": existing_id,
                "circle_id": circle_id,
                "inviter_user_id": "owner-user",
                "invitee_user_id": "friend-one",
                "status": "pending",
                "expires_at": now + timedelta(hours=1),
                "created_at": now,
                "circle_name": "Family",
                "circle_kind": "family",
                "inviter_display_name": "Owner",
                "invitee_display_name": "Friend One",
            }
        ],
        {"active_member_count": 1, "pending_invite_count": 1},
        {
            "id": new_id,
            "circle_id": circle_id,
            "inviter_user_id": "owner-user",
            "invitee_user_id": "friend-two",
            "status": "pending",
            "expires_at": now + timedelta(hours=72),
            "created_at": now,
        },
    )
    service = OneLocationCircleService(
        db=_TransactionDb(conn),  # type: ignore[arg-type]
        hmac_key="a" * 32,
    )
    push_calls: list[dict] = []
    monkeypatch.setattr(
        push_notifications_module,
        "send_circle_member_invite_push",
        lambda **kwargs: push_calls.append(kwargs) or 1,
    )

    result = service.create_member_invites(
        actor_user_id="owner-user",
        circle_id=circle_id,
        invitee_user_ids=["friend-one", "friend-two", "friend-one"],
    )

    assert [invite["inviteeUserId"] for invite in result["invites"]] == [
        "friend-one",
        "friend-two",
    ]
    assert result["createdInviteIds"] == [new_id]
    assert push_calls == [
        {
            "invitee_user_id": "friend-two",
            "inviter_user_id": "owner-user",
            "circle_id": circle_id,
            "invite_id": new_id,
        }
    ]
    assert any(
        "ORDER BY connection.user_a_id, connection.user_b_id" in sql
        and "FOR UPDATE OF connection" in sql
        for sql in conn.sql
    )
    assert sum("INSERT INTO one_location_circle_member_invites" in sql for sql in conn.sql) == 1
    circle_lock_index = next(
        index
        for index, sql in enumerate(conn.sql)
        if "FROM one_location_circles circle" in sql and "FOR UPDATE OF circle" in sql
    )
    actor_membership_lock_index = next(
        index
        for index, sql in enumerate(conn.sql)
        if "FROM one_location_circle_memberships actor_membership" in sql
        and "FOR UPDATE OF actor_membership" in sql
    )
    target_membership_lock_index = next(
        index
        for index, sql in enumerate(conn.sql)
        if "SELECT user_id, status" in sql
        and "FROM one_location_circle_memberships" in sql
        and "FOR UPDATE" in sql
    )
    assert circle_lock_index < actor_membership_lock_index < target_membership_lock_index


def test_member_cannot_invite_a_user_removed_by_the_circle_owner() -> None:
    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    conn = _CapacityConnection(
        {
            "id": circle_id,
            "name": "Family",
            "kind": "family",
            "owner_user_id": "owner-user",
            "member_limit": 20,
            "role": "member",
        },
        {"role": "member", "inviter_display_name": "Member"},
        None,
        [{"user_id": "removed-user", "status": "removed"}],
    )
    service = OneLocationCircleService(
        db=_TransactionDb(conn),  # type: ignore[arg-type]
        hmac_key="a" * 32,
    )

    with pytest.raises(OneLocationCircleError) as raised:
        service.create_member_invites(
            actor_user_id="member-user",
            circle_id=circle_id,
            invitee_user_ids=["removed-user"],
        )

    assert raised.value.code == "LOCATION_CIRCLE_MEMBERSHIP_REMOVED"
    assert not any("FROM connections connection" in sql for sql in conn.sql)
    assert not any("INSERT INTO one_location_circle_member_invites" in sql for sql in conn.sql)


def test_recent_terminal_invite_enforces_a_circle_wide_reinvite_cooldown() -> None:
    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    conn = _CapacityConnection(
        {
            "id": circle_id,
            "name": "Family",
            "kind": "family",
            "owner_user_id": "owner-user",
            "member_limit": 20,
            "role": "member",
        },
        {"role": "member", "inviter_display_name": "Member"},
        None,
        [],
        [
            {
                "connection_id": "connection-1",
                "user_id": "friend-one",
                "invitee_display_name": "Friend One",
            }
        ],
        [{"connection_id": "connection-1"}],
        [
            {
                "id": "550e8400-e29b-41d4-a716-446655440002",
                "circle_id": circle_id,
                "inviter_user_id": "another-member",
                "invitee_user_id": "friend-one",
                "status": "declined",
                "expires_at": datetime.now(timezone.utc) + timedelta(hours=1),
                "updated_at": datetime.now(timezone.utc),
            }
        ],
    )
    service = OneLocationCircleService(
        db=_TransactionDb(conn),  # type: ignore[arg-type]
        hmac_key="a" * 32,
    )

    with pytest.raises(OneLocationCircleError) as raised:
        service.create_member_invites(
            actor_user_id="member-user",
            circle_id=circle_id,
            invitee_user_ids=["friend-one"],
        )

    assert raised.value.code == "LOCATION_CIRCLE_INVITE_COOLDOWN"
    assert raised.value.status_code == 429
    assert not any("INSERT INTO one_location_circle_member_invites" in sql for sql in conn.sql)


def test_non_owner_pending_invite_quota_cannot_reserve_every_circle_slot() -> None:
    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    conn = _CapacityConnection(
        {
            "id": circle_id,
            "name": "Family",
            "kind": "family",
            "owner_user_id": "owner-user",
            "member_limit": 20,
            "role": "member",
        },
        {"role": "member", "inviter_display_name": "Member"},
        None,
        [],
        [{"connection_id": "connection-1", "user_id": "friend-one"}],
        [{"connection_id": "connection-1"}],
        [],
        {
            "active_member_count": 5,
            "pending_invite_count": 5,
            "actor_pending_invite_count": 5,
        },
    )
    service = OneLocationCircleService(
        db=_TransactionDb(conn),  # type: ignore[arg-type]
        hmac_key="a" * 32,
    )

    with pytest.raises(OneLocationCircleError) as raised:
        service.create_member_invites(
            actor_user_id="member-user",
            circle_id=circle_id,
            invitee_user_ids=["friend-one"],
        )

    assert raised.value.code == "LOCATION_CIRCLE_MEMBER_INVITE_LIMIT_REACHED"
    assert not any("INSERT INTO one_location_circle_member_invites" in sql for sql in conn.sql)


def test_member_invite_does_not_reassign_another_members_pending_invite() -> None:
    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    conn = _CapacityConnection(
        {
            "id": circle_id,
            "name": "Family",
            "kind": "family",
            "member_limit": 20,
            "role": "member",
        },
        {"role": "member", "inviter_display_name": "Member"},
        None,
        [],
        [
            {
                "connection_id": "connection-1",
                "user_id": "friend-one",
                "invitee_display_name": "Friend One",
            }
        ],
        [{"connection_id": "connection-1"}],
        [
            {
                "id": "550e8400-e29b-41d4-a716-446655440002",
                "circle_id": circle_id,
                "inviter_user_id": "another-member",
                "invitee_user_id": "friend-one",
                "status": "pending",
                "expires_at": datetime.now(timezone.utc) + timedelta(hours=1),
            }
        ],
    )
    service = OneLocationCircleService(
        db=_TransactionDb(conn),  # type: ignore[arg-type]
        hmac_key="a" * 32,
    )

    with pytest.raises(OneLocationCircleError) as raised:
        service.create_member_invites(
            actor_user_id="member-user",
            circle_id=circle_id,
            invitee_user_ids=["friend-one"],
        )

    assert raised.value.code == "LOCATION_CIRCLE_INVITE_ALREADY_PENDING"
    assert not any("INSERT INTO one_location_circle_member_invites" in sql for sql in conn.sql)


def test_member_invite_batch_capacity_failure_writes_nothing() -> None:
    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    conn = _CapacityConnection(
        {
            "id": circle_id,
            "name": "Family",
            "kind": "family",
            "owner_user_id": "owner-user",
            "member_limit": 20,
        },
        {"role": "owner", "inviter_display_name": "Owner"},
        None,
        [],
        [
            {"connection_id": "connection-1", "user_id": "friend-one"},
            {"connection_id": "connection-2", "user_id": "friend-two"},
        ],
        [
            {"connection_id": "connection-1"},
            {"connection_id": "connection-2"},
        ],
        [],
        {"active_member_count": 19, "pending_invite_count": 0},
    )
    service = OneLocationCircleService(
        db=_TransactionDb(conn),  # type: ignore[arg-type]
        hmac_key="a" * 32,
    )

    with pytest.raises(OneLocationCircleError) as raised:
        service.create_member_invites(
            actor_user_id="owner-user",
            circle_id=circle_id,
            invitee_user_ids=["friend-one", "friend-two"],
        )

    assert raised.value.code == "LOCATION_CIRCLE_INVITE_CAPACITY_REACHED"
    assert not any("INSERT INTO one_location_circle_member_invites" in sql for sql in conn.sql)


def test_member_invite_batch_rechecks_origins_after_connection_locks() -> None:
    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    conn = _CapacityConnection(
        {
            "id": circle_id,
            "name": "Family",
            "kind": "family",
            "owner_user_id": "owner-user",
            "member_limit": 20,
        },
        {"role": "owner", "inviter_display_name": "Owner"},
        None,
        [],
        [
            {"connection_id": "connection-1", "user_id": "friend-one"},
            {"connection_id": "connection-2", "user_id": "friend-two"},
        ],
        [{"connection_id": "connection-1"}],
    )
    service = OneLocationCircleService(
        db=_TransactionDb(conn),  # type: ignore[arg-type]
        hmac_key="a" * 32,
    )

    with pytest.raises(OneLocationCircleError) as raised:
        service.create_member_invites(
            actor_user_id="owner-user",
            circle_id=circle_id,
            invitee_user_ids=["friend-one", "friend-two"],
        )

    assert raised.value.code == "LOCATION_CIRCLE_DIRECT_CONNECTION_REQUIRED"
    connection_lock_index = next(
        index for index, sql in enumerate(conn.sql) if "FROM connections connection" in sql
    )
    origin_lock_index = next(
        index for index, sql in enumerate(conn.sql) if "FROM connection_origins" in sql
    )
    assert connection_lock_index < origin_lock_index
    assert "FOR UPDATE OF connection" in conn.sql[connection_lock_index]
    assert "FOR UPDATE" in conn.sql[origin_lock_index]
    assert not any("INSERT INTO one_location_circle_member_invites" in sql for sql in conn.sql)


def test_circle_grant_reconciliation_preserves_other_relationship_origins() -> None:
    conn = _CapacityConnection(None, None, None)

    OneLocationCircleService._reconcile_circle_sourced_grants(
        conn,
        circle_id="550e8400-e29b-41d4-a716-446655440000",
        member_user_id="member-user",
    )

    assert len(conn.sql) == 3
    assert "origin.origin_kind <> 'named_circle'" in conn.sql[0]
    assert "SET source_circle_id = NULL" in conn.sql[0]
    assert "origin.origin_kind = 'named_circle'" in conn.sql[1]
    assert "replacement_circle_id" in conn.sql[1]
    assert "SET status = 'revoked'" in conn.sql[2]
    assert all("one_location_share_grants grant" not in sql for sql in conn.sql)


def test_member_exit_revokes_shared_code_and_authored_pending_invites(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    conn = _CapacityConnection(
        {"owner_user_id": "owner-user"},
        {"user_id": "member-user"},
        None,
        None,
        None,
        None,
        None,
        None,
    )
    service = OneLocationCircleService(
        db=_TransactionDb(conn),  # type: ignore[arg-type]
        hmac_key="a" * 32,
    )
    origin_revocations: list[dict] = []
    monkeypatch.setattr(
        circle_service_module,
        "revoke_circle_origins",
        lambda _conn, **kwargs: origin_revocations.append(kwargs),
    )

    service.leave_circle(user_id="member-user", circle_id=circle_id)

    assert any(
        "UPDATE one_location_circle_invite_codes" in sql and "revoked_at = NOW()" in sql
        for sql in conn.sql
    )
    assert any(
        "UPDATE one_location_circle_member_invites" in sql
        and "inviter_user_id = :target_user_id" in sql
        for sql in conn.sql
    )
    assert origin_revocations == [{"circle_id": circle_id, "member_user_id": "member-user"}]


def test_targeted_circle_invite_push_is_metadata_only_and_deep_links_to_people(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}

    def _capture(user_id: str, **kwargs):
        captured["user_id"] = user_id
        captured.update(kwargs)
        return 1

    monkeypatch.setattr(
        push_notifications_module,
        "send_user_data_push",
        _capture,
    )

    sent = send_circle_member_invite_push(
        invitee_user_id="member-user",
        inviter_user_id="owner-user",
        circle_id="550e8400-e29b-41d4-a716-446655440000",
        invite_id="550e8400-e29b-41d4-a716-446655440002",
    )

    assert sent == 1
    assert captured["notification_type"] == "location_circle_member_invite"
    assert captured["notification_category"] == "ONE_LOCATION"
    assert captured["deep_link"].endswith(
        "?tab=people&circleInviteId=550e8400-e29b-41d4-a716-446655440002"
    )
    assert captured["data"] == {
        "invite_id": "550e8400-e29b-41d4-a716-446655440002",
        "circle_id": "550e8400-e29b-41d4-a716-446655440000",
        "inviter_user_id": "owner-user",
    }
    assert captured["body"] == "You have a new Circle invitation."


class _RecordingDb:
    """Capture the SQL a read path emits and replay canned rows in order."""

    def __init__(self, *results: list[dict]) -> None:
        self.results = list(results)
        self.sql: list[str] = []
        self.params: list[dict] = []

    def execute_raw(self, sql: str, params: dict | None = None):
        self.sql.append(str(sql))
        self.params.append(dict(params or {}))
        rows = self.results.pop(0) if self.results else []
        return SimpleNamespace(data=rows)


def test_invitable_connections_are_not_narrowed_to_directly_requested_ones() -> None:
    """A Circle co-member is a connection, so they can be invited elsewhere.

    Requiring `origin_kind = 'direct_request'` here meant someone you met
    through a Circle — already in your connections list, already able to
    receive your location — could never be invited into another Circle.
    """
    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    db = _RecordingDb(
        [{"user_id": "actor-user"}],
        [
            {
                "connection_id": "conn-1",
                "user_id": "circle-only-peer",
                "connected_at": datetime.now(timezone.utc),
                "display_name": "Circle Only Peer",
                "photo_url": None,
                "custom_photo_url": None,
            }
        ],
    )
    service = OneLocationCircleService(db=db, hmac_key="a" * 32)  # type: ignore[arg-type]

    eligible = service.list_eligible_direct_connections(
        actor_user_id="actor-user",
        circle_id=circle_id,
    )

    assert [row["userId"] for row in eligible] == ["circle-only-peer"]
    listing_sql = next(
        sql for sql in db.sql if "FROM connection_origins" in sql or "connection_origins" in sql
    )
    assert "origin.status = 'active'" in listing_sql
    # The guard: provenance must not be filtered down to direct requests.
    assert "origin_kind = 'direct_request'" not in listing_sql
