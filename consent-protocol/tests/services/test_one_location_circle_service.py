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


def test_circle_name_accepts_one_character_and_still_bounds_the_column() -> None:
    clean = circle_service_module._clean_name

    # One character is a name. The old two-character floor left the Create
    # button dead with nothing on screen explaining the refusal.
    assert clean("A") == "A"
    assert clean("  A  ") == "A"
    # Interior whitespace still collapses to one space.
    assert clean("Meena   Family") == "Meena Family"
    assert clean("x" * 80) == "x" * 80

    # Empty, whitespace-only, and over-length remain refusals.
    for rejected in ("", "   ", "x" * 81):
        with pytest.raises(OneLocationCircleError) as excinfo:
            clean(rejected)
        assert excinfo.value.code == "LOCATION_CIRCLE_NAME_INVALID"


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


def _join_connection_calls(
    monkeypatch: pytest.MonkeyPatch,
    *,
    members: list[str],
    user_id: str,
    inviter_user_id: str | None,
) -> list[dict]:
    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    conn = _CapacityConnection([{"user_id": member} for member in members])
    calls: list[dict] = []
    monkeypatch.setattr(
        circle_service_module,
        "ensure_connection_origin",
        lambda _conn, **kwargs: calls.append(kwargs) or {},
    )

    OneLocationCircleService._connect_member_to_circle(
        conn,
        circle_id=circle_id,
        user_id=user_id,
        inviter_user_id=inviter_user_id,
    )
    return calls


def test_join_connects_the_joiner_to_their_inviter_and_to_nobody_else(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One invitation accepted is one connection, exactly like a request.

    The mesh this replaces connected a joiner to every existing member, so a
    single join into a full Circle produced 19 connections between people who
    had never chosen each other.
    """
    circle_id = "550e8400-e29b-41d4-a716-446655440000"

    calls = _join_connection_calls(
        monkeypatch,
        members=["member-user", "owner-user", "friend-user"],
        user_id="member-user",
        inviter_user_id="owner-user",
    )

    assert calls == [
        # Outlives the Circle: the pair accepted an invitation.
        {
            "user_a_id": "member-user",
            "user_b_id": "owner-user",
            "kind": "circle_member",
            "source_circle_id": None,
        },
        # Circle-scoped provenance, revoked when the membership ends.
        {
            "user_a_id": "member-user",
            "user_b_id": "owner-user",
            "kind": "named_circle",
            "source_circle_id": circle_id,
        },
    ]
    assert not any(call["user_b_id"] == "friend-user" for call in calls)


def test_join_connects_nobody_when_the_inviter_is_no_longer_a_member(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An inviter who has left introduces no one.

    The joiner is still in the Circle and can share through it; there is simply
    no live pair to record, and the remaining members must not be swept in.
    """
    assert (
        _join_connection_calls(
            monkeypatch,
            members=["member-user", "owner-user", "friend-user"],
            user_id="member-user",
            inviter_user_id="departed-user",
        )
        == []
    )
    assert (
        _join_connection_calls(
            monkeypatch,
            members=["member-user", "owner-user"],
            user_id="member-user",
            inviter_user_id=None,
        )
        == []
    )
    # Self-invitation is not a relationship.
    assert (
        _join_connection_calls(
            monkeypatch,
            members=["member-user", "owner-user"],
            user_id="member-user",
            inviter_user_id="member-user",
        )
        == []
    )


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
    # Accepting a targeted invitation connects the joiner to the member who
    # sent it. The Circle's owner did not invite them and is not swept in.
    assert origin_calls == [
        {
            "user_a_id": "member-user",
            "user_b_id": "inviter-member",
            "kind": "circle_member",
            "source_circle_id": None,
        },
        {
            "user_a_id": "member-user",
            "user_b_id": "inviter-member",
            "kind": "named_circle",
            "source_circle_id": circle_id,
        },
    ]
    assert not any(call["user_b_id"] == "owner-user" for call in origin_calls)
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
    # Only an independent relationship keeps a Circle-authorized grant alive.
    # `circle_member` is not independent — it exists because of a Circle
    # invitation — so counting it would mean removing someone from your Circle
    # silently kept their live location running as a connection-scoped share.
    preserve_sql = " ".join(conn.sql[0].split())
    assert "origin.origin_kind NOT IN ( 'named_circle', 'circle_member' )" in preserve_sql
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


def test_someone_elses_sms_circle_is_labelled_with_its_owner() -> None:
    """Three emergency lists must not read as three copies of yours.

    Reported from UAT as "multiple SMS circles, none of them deletable".
    `list_circles` returns every Circle you are an active MEMBER of, so being on
    two other people's emergency lists puts three rows in your Circles list --
    all called "SMS Contacts", because the product chose that name, not the
    people. The data was correct; the presentation was not.

    The delete half is the same thing wearing a different hat: your own system
    Circle refuses by design, someone else's refuses because you do not own it.
    Two correct rules, three identical rows, and it reads as "nothing works".
    """

    from hushh_mcp.services.one_location_circle_service import OneLocationCircleService

    summary = OneLocationCircleService._circle_summary

    mine = summary(
        {
            "id": "c1",
            "name": "SMS Contacts",
            "owner_user_id": "me",
            "viewer_user_id": "me",
            "is_system": True,
        }
    )
    assert mine["name"] == "SMS Contacts"
    assert mine["isSystem"] is True
    # Mine is the one I manage, so every owner power except deletion applies.
    assert mine["viewerCapabilities"]["canDeleteCircle"] is False
    assert mine["viewerCapabilities"]["canManageCircle"] is True

    theirs = summary(
        {
            "id": "c2",
            "name": "SMS Contacts",
            "owner_user_id": "neelesh",
            "owner_display_name": "Neelesh",
            "viewer_user_id": "me",
            "is_system": True,
        }
    )
    assert theirs["name"] == "Neelesh's SMS Contacts"
    assert theirs["viewerCapabilities"]["canManageCircle"] is False

    # An owner with no resolvable name still must not collide with mine.
    unnamed = summary(
        {
            "id": "c3",
            "name": "SMS Contacts",
            "owner_user_id": "ghost",
            "viewer_user_id": "me",
            "is_system": True,
        }
    )
    assert unnamed["name"] == "Shared SMS Contacts"
    assert unnamed["name"] != mine["name"]

    # Ordinary Circles are named by a person and are left exactly alone.
    ordinary = summary(
        {
            "id": "c4",
            "name": "Family",
            "owner_user_id": "neelesh",
            "owner_display_name": "Neelesh",
            "viewer_user_id": "me",
            "is_system": False,
        }
    )
    assert ordinary["name"] == "Family"


def test_only_the_owner_controls_who_is_on_their_emergency_list() -> None:
    """Everything that lets a non-owner change an SMS Circle is closed.

    Storing a private emergency list as a Circle inherited every Circle
    affordance, and three of them are wrong here:

      * anyone ON the list could invite others TO it -- a stranger added by a
        member would receive the owner's SOS alerts and the owner never chose
        them;
      * the list had a shareable join code any member could read, which is the
        same hole with a link attached;
      * being on someone's list consumed one of your own 10 Circle slots.

    Found by auditing from the other member's side -- the check whose absence
    let the duplicate-name bug reach UAT.
    """

    from hushh_mcp.services.one_location_circle_service import OneLocationCircleService

    summary = OneLocationCircleService._circle_summary

    theirs = summary(
        {
            "id": "c1",
            "name": "SMS Contacts",
            "owner_user_id": "neelesh",
            "owner_display_name": "Neelesh",
            "viewer_user_id": "me",
            "is_system": True,
        }
    )
    caps = theirs["viewerCapabilities"]
    assert caps["canInviteMembers"] is False
    assert caps["canViewInviteCode"] is False
    assert caps["canRotateInviteCode"] is False

    mine = summary(
        {
            "id": "c2",
            "name": "SMS Contacts",
            "owner_user_id": "me",
            "viewer_user_id": "me",
            "is_system": True,
        }
    )
    mine_caps = mine["viewerCapabilities"]
    # The owner still manages their own list...
    assert mine_caps["canInviteMembers"] is True
    assert mine_caps["canManageCircle"] is True
    # ...but an emergency list has no join code at all, for anyone.
    assert mine_caps["canViewInviteCode"] is False
    assert mine_caps["canRotateInviteCode"] is False
    assert mine_caps["canDeleteCircle"] is False

    # An ordinary Circle keeps every affordance it had.
    ordinary = summary(
        {
            "id": "c3",
            "name": "Family",
            "owner_user_id": "me",
            "viewer_user_id": "me",
            "is_system": False,
        }
    )
    ordinary_caps = ordinary["viewerCapabilities"]
    assert ordinary_caps["canInviteMembers"] is True
    assert ordinary_caps["canViewInviteCode"] is True
    assert ordinary_caps["canRotateInviteCode"] is True
    assert ordinary_caps["canDeleteCircle"] is True


def test_emergency_lists_do_not_consume_the_circle_budget() -> None:
    """Being on eight people's emergency lists must not block making a Circle.

    The limit is about Circles you belong to. An emergency list is somewhere
    you were placed, and no screen could have explained the refusal.
    """

    import inspect

    from hushh_mcp.services.one_location_circle_service import OneLocationCircleService

    source = inspect.getsource(OneLocationCircleService._assert_user_circle_capacity)
    assert "NOT circle.is_system" in source


def test_a_member_cannot_add_people_to_someone_elses_emergency_list() -> None:
    """The capability flag shapes the UI; this is the rule behind it."""

    import inspect

    from hushh_mcp.services.one_location_circle_service import OneLocationCircleService

    source = inspect.getsource(OneLocationCircleService.create_member_invites)
    assert "LOCATION_CIRCLE_SYSTEM_OWNER_ONLY" in source
    assert "is_system_circle" in source


def test_adding_to_the_sms_circle_does_not_walk_into_invitation_code() -> None:
    """The KeyError that made every SMS-Circle add fail on UAT.

    The direct-add path writes memberships and skips the invitation loop --
    an emergency contact is added outright, never invited. But that loop is
    also what fills `existing_by_user_id`, and a few lines below:

        payloads = [
            self._member_invite_payload(existing_by_user_id[invitee_user_id])
            for invitee_user_id in cleaned_invitee_user_ids
        ]

    builds a payload for EVERY requested person from that map. Nothing was ever
    put there for a system Circle, so it raised KeyError, the request 5xx'd, and
    the client showed "One is still catching up".

    So the path must RETURN once the memberships are written, not fall through
    into code whose only job is describing invitations it deliberately did not
    create.
    """

    import ast
    import inspect
    import textwrap

    from hushh_mcp.services.one_location_circle_service import OneLocationCircleService

    source = textwrap.dedent(inspect.getsource(OneLocationCircleService.create_member_invites))

    # The system-circle branch ends in a return, not a fallthrough.
    assert (
        '"invites": [], "createdInviteIds": []' in source.replace("\n", " ").replace("  ", " ")
        or 'return {"invites": [], "createdInviteIds": []}' in source
    )

    # And that return sits INSIDE the transaction, so the memberships it just
    # wrote are committed rather than rolled back. `engine.begin()` commits on a
    # normal __exit__, and a return is a normal exit.
    tree = ast.parse(source)
    inside_transaction = False
    for node in ast.walk(tree):
        if isinstance(node, ast.With) and "begin()" in ast.unparse(node.items[0].context_expr):
            for sub in ast.walk(node):
                if isinstance(sub, ast.Return) and isinstance(sub.value, ast.Dict):
                    if [ast.unparse(v) for v in sub.value.values] == ["[]", "[]"]:
                        inside_transaction = True
    assert inside_transaction, "early return must be inside the transaction block"
