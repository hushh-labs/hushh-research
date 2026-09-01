from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

import hushh_mcp.services.one_location_circle_service as circle_service_module
import hushh_mcp.services.push_notifications as push_notifications_module
from hushh_mcp.services.one_location_circle_service import (
    OneLocationCircleError,
    OneLocationCircleService,
    format_circle_code,
    normalize_circle_code,
)
from hushh_mcp.services.push_notifications import (
    send_circle_member_added_push,
    send_circle_member_invite_push,
)


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
            "role": "owner",
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


def test_a_person_with_no_profile_name_is_still_named_in_a_circle() -> None:
    """ "Circle member" and "Connection" were hiding a name the row carried.

    A Google account with no profile name arrives with an empty
    actor_identity_cache.display_name. Every surface then answered differently
    -- the roster said "Circle member", the picker said "Connection", the
    recipients list fell to a masked phone that the client rejects on sight and
    replaces with "A trusted person". None of them asked the question the
    notification path had already answered: the account has an email, and its
    handle is a name.

    Both these lists are scoped to a relationship the viewer already has -- a
    Circle they share, a connection they made -- so the handle is a name about
    someone they know rather than a fact about a stranger.
    """

    member = OneLocationCircleService._member_payload(
        {
            "user_id": "member-1",
            "display_name": "",
            "email": "damrianeelesh@gmail.com",
            "role": "owner",
        }
    )
    assert member["displayName"] == "damrianeelesh"

    eligible = OneLocationCircleService._eligible_connection_payload(
        {
            "connection_id": "connection-1",
            "user_id": "member-1",
            "display_name": "",
            "email": "damrianeelesh@gmail.com",
        }
    )
    assert eligible["displayName"] == "damrianeelesh"

    # A real name is untouched, and an account that resolves to nothing keeps
    # the generic word each list chose for itself.
    assert (
        OneLocationCircleService._member_payload(
            {"user_id": "m", "display_name": "Neelesh Meena", "email": "n@x.com"}
        )["displayName"]
        == "Neelesh Meena"
    )
    assert (
        OneLocationCircleService._member_payload({"user_id": "m", "display_name": ""})[
            "displayName"
        ]
        == "Circle member"
    )
    assert (
        OneLocationCircleService._eligible_connection_payload(
            {"connection_id": "c", "user_id": "m", "display_name": ""}
        )["displayName"]
        == "Connection"
    )


def test_eligible_connection_payload_marks_verified_ria_status() -> None:
    assert (
        OneLocationCircleService._eligible_connection_payload(
            {
                "connection_id": "connection-1",
                "user_id": "advisor-user",
                "display_name": "Ada Advisor",
                "is_ria": True,
            }
        )["isRia"]
        is True
    )
    assert (
        OneLocationCircleService._eligible_connection_payload(
            {
                "connection_id": "connection-2",
                "user_id": "person-user",
                "display_name": "Pat Person",
            }
        )["isRia"]
        is False
    )


def test_circle_member_payload_marks_verified_ria_status() -> None:
    assert (
        OneLocationCircleService._member_payload(
            {
                "user_id": "advisor-user",
                "display_name": "Ada Advisor",
                "phone_verified": True,
                "is_ria": True,
            }
        )["isRia"]
        is True
    )
    assert (
        OneLocationCircleService._member_payload(
            {
                "user_id": "person-user",
                "display_name": "Pat Person",
                "phone_verified": True,
            }
        )["isRia"]
        is False
    )


def test_the_roster_and_picker_queries_read_the_email_the_ladder_needs() -> None:
    """A ladder with no rung to stand on resolves nothing.

    `_member_payload` and `_eligible_connection_payload` fall back to the email
    handle, which only works if the statement that fed them selected the email.
    Both projections used to stop at display_name, so dropping the column again
    would silently restore "Circle member" for exactly the accounts this fixes
    -- with every test above still green, because they build their rows by hand.
    """

    import inspect

    source = inspect.getsource(OneLocationCircleService.get_circle)
    assert "identity.email" in source

    source = inspect.getsource(OneLocationCircleService.list_eligible_direct_connections)
    assert "identity.email" in source


def test_circle_member_queries_use_the_shared_verified_ria_gate() -> None:
    import inspect

    from hushh_mcp.services.ria_iam_service import RIAIAMService
    from hushh_mcp.services.ria_status import RIA_VERIFIED_STATUS_SQL

    for status in RIAIAMService._RIA_VERIFIED_STATUSES:
        assert f"'{status}'" in RIA_VERIFIED_STATUS_SQL

    source = inspect.getsource(OneLocationCircleService.get_circle)
    assert "RIA_VERIFIED_STATUS_SQL" in source
    assert "ria_profiles ria_annotation" in source

    source = inspect.getsource(OneLocationCircleService.list_circle_members_page)
    assert "RIA_VERIFIED_STATUS_SQL" in source
    assert "ria_profiles ria_annotation" in source


def test_eligible_connection_queries_use_the_shared_verified_ria_gate() -> None:
    import inspect

    from hushh_mcp.services.ria_iam_service import RIAIAMService
    from hushh_mcp.services.ria_status import RIA_VERIFIED_STATUS_SQL

    for status in RIAIAMService._RIA_VERIFIED_STATUSES:
        assert f"'{status}'" in RIA_VERIFIED_STATUS_SQL

    source = inspect.getsource(OneLocationCircleService.list_eligible_direct_connections)
    assert "RIA_VERIFIED_STATUS_SQL" in source
    assert "ria_profiles ria_annotation" in source

    source = inspect.getsource(OneLocationCircleService.list_eligible_direct_connections_page)
    assert "RIA_VERIFIED_STATUS_SQL" in source
    assert "ria_profiles ria_annotation" in source


def test_circle_summary_uses_canonical_owner_instead_of_membership_role() -> None:
    owner_summary = OneLocationCircleService._circle_summary(
        {
            "id": "circle-1",
            "name": "Family",
            "role": "owner",
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
    # Both doors into a Circle are the owner's. Shared membership is what lets
    # someone receive the owner's location, so a member who could add people
    # could put a stranger to the owner inside that scope.
    assert drifted_member_summary["viewerCapabilities"]["canInviteMembers"] is False
    assert drifted_member_summary["viewerCapabilities"]["canViewInviteCode"] is False
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


def test_owner_ensures_re_readable_shared_code_without_rotating_it() -> None:
    """The code is re-readable without being rotated -- for its owner.

    A member used to be able to read it. That made the code a second way
    into a Circle that the owner did not control: whoever redeemed it
    landed in the owner's sharing scope all the same.
    """

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
            "role": "owner",
        },
        {"role": "owner"},
        None,
        active_row,
    )
    service._db = _TransactionDb(conn)  # type: ignore[assignment]

    result = service.create_invite_code(
        actor_user_id="owner-user",
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


def test_owner_can_create_and_rotate_the_shared_code(
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
            "role": "owner",
        },
        {"role": "owner"},
        None,
        None,
        inserted_row,
    )
    service._db = _TransactionDb(conn)  # type: ignore[assignment]

    result = service.create_invite_code(
        actor_user_id="owner-user",
        circle_id=circle_id,
    )

    assert result["code"] == code
    insert_index = next(
        index
        for index, sql in enumerate(conn.sql)
        if "INSERT INTO one_location_circle_invite_codes" in sql
    )
    assert code not in str(conn.params[insert_index])
    assert conn.params[insert_index]["actor_user_id"] == "owner-user"

    # A member is refused the code outright now, not merely refused a rotate:
    # handing one out is a way into the owner's Circle, so it is the owner's.
    denied_conn = _CapacityConnection(
        {
            "id": circle_id,
            "owner_user_id": "owner-user",
            "member_limit": 20,
            "role": "member",
        },
        {"role": "member"},
    )
    service._db = _TransactionDb(denied_conn)  # type: ignore[assignment]
    with pytest.raises(OneLocationCircleError) as raised:
        service.create_invite_code(
            actor_user_id="member-user",
            circle_id=circle_id,
            rotate=False,
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
            "role": "owner",
        },
        {"role": "owner"},
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


def test_ensure_does_not_rotate_an_unreadable_legacy_code() -> None:
    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    service = OneLocationCircleService(db=object(), hmac_key="a" * 32)  # type: ignore[arg-type]
    conn = _CapacityConnection(
        {
            "id": circle_id,
            "owner_user_id": "owner-user",
            "member_limit": 20,
            "role": "owner",
        },
        {"role": "owner"},
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
            actor_user_id="owner-user",
            circle_id=circle_id,
        )

    assert raised.value.code == "LOCATION_CIRCLE_CODE_ROTATION_REQUIRED"
    assert not any("revoked_at = NOW()" in sql for sql in conn.sql)
    assert not any("INSERT INTO one_location_circle_invite_codes" in sql for sql in conn.sql)


def test_nobody_is_capped_on_how_many_circles_they_may_belong_to() -> None:
    """The ten-Circle ceiling is gone, and this is why it should stay gone.

    It read as "how many Circles may a person create", but it counted
    MEMBERSHIPS -- so what it actually decided was how many Circles OTHER
    PEOPLE may put you in. Someone on ten emergency lists could not be added to
    an eleventh Circle, and no screen could explain why. That is not a limit
    that belonged to us.

    Three tests used to hold that ceiling in place. They are gone with it, and
    this one replaces them: read `create_circle` and find no ceiling, and it is
    reasonable to add one back. This fails if anyone does.
    """

    import inspect
    import re

    from hushh_mcp.services import one_location_circle_service as module

    source = inspect.getsource(module)
    # The NAME may survive in the comment explaining why it went; the constant,
    # the check and the refusal may not.
    assert not re.search(r"^CIRCLE_MAX_PER_USER\s*=", source, re.M)
    assert "_assert_user_circle_capacity" not in source
    assert "LOCATION_CIRCLE_LIMIT_REACHED" not in source

    # The per-person LOCK survives the limit it used to guard. It still
    # serializes one person's concurrent creates and joins against each other.
    assert "_lock_user_circle_memberships" in source


def test_an_sms_circle_holds_ten_people_where_an_ordinary_circle_holds_a_hundred() -> None:
    """An SMS Circle is not a small ordinary Circle.

    Everyone on it is woken at once, with the owner's address, at the worst
    moment of their day. A hundred recipients is not a bigger safety net -- it
    is a hundred messages nobody is accountable for, and a roster the owner
    cannot check at a glance when it matters most.
    """

    import inspect

    from hushh_mcp.services import one_location_circle_service as module

    assert module.CIRCLE_DEFAULT_MEMBER_LIMIT == 100
    assert module.SMS_SYSTEM_CIRCLE_MEMBER_LIMIT == 10

    # The system Circle is created with its own ceiling, not the ordinary one.
    insert = inspect.getsource(module.OneLocationCircleService._insert_system_circle)
    assert '"member_limit": SMS_SYSTEM_CIRCLE_MEMBER_LIMIT' in insert
    assert "CIRCLE_DEFAULT_MEMBER_LIMIT" not in insert

    # And Circles provisioned before that ceiling existed are brought down on
    # the next bootstrap, the same way the rename heals.
    bootstrap = inspect.getsource(module.OneLocationCircleService.ensure_sms_system_circle)
    assert "SET member_limit = :member_limit" in bootstrap
    assert "member_limit <> :member_limit" in bootstrap


def test_lowering_the_sms_ceiling_never_evicts_anyone() -> None:
    """An owner already over ten keeps everyone they have.

    member_limit is read when someone is ADDED. Nothing consults it to decide
    who may stay, and nothing should: removing people from an emergency list to
    satisfy a number chosen after they were added would be the wrong way round.
    """

    import inspect

    from hushh_mcp.services import one_location_circle_service as module

    source = inspect.getsource(module)
    # The only place the ceiling is consulted is the add path's capacity check.
    for line in source.splitlines():
        if "member_limit" in line and "DELETE" in line.upper():
            raise AssertionError(f"member_limit is being used to remove people: {line!r}")
    assert "reserved_count + len(new_user_ids) - already_reserved > member_limit" in source


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


def test_first_code_join_records_one_atomic_inviter_feed_event(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    invite_id = "550e8400-e29b-41d4-a716-446655440001"
    conn = _CapacityConnection(
        {"id": invite_id, "circle_id": circle_id},
        {
            "id": circle_id,
            "name": "Family",
            "owner_user_id": "owner-user",
            "member_limit": 20,
            "status": "active",
            "user_id": "member-user",
            "display_name": "Member User",
        },
        {"user_id": "member-user"},
        {
            "id": invite_id,
            "circle_id": circle_id,
            "status": "active",
            "expires_at": datetime.now(timezone.utc) + timedelta(hours=1),
            "max_uses": 20,
            "use_count": 1,
            "created_by_user_id": "owner-user",
        },
        None,
        {"member_count": 1},
        None,
        None,
        [{"user_id": "member-user"}, {"user_id": "owner-user"}],
        None,
    )
    service = OneLocationCircleService(
        db=_TransactionDb(conn),  # type: ignore[arg-type]
        hmac_key="a" * 32,
    )
    monkeypatch.setattr(
        circle_service_module,
        "ensure_connection_origin",
        lambda _conn, **_kwargs: {},
    )
    monkeypatch.setattr(
        service,
        "get_circle",
        lambda **_kwargs: {
            "id": circle_id,
            "name": "Family",
            "members": [
                {"userId": "member-user", "displayName": "Member User"},
            ],
        },
    )
    push_calls: list[dict] = []
    monkeypatch.setattr(
        push_notifications_module,
        "send_circle_code_joined_push",
        lambda **kwargs: push_calls.append(kwargs) or 1,
    )

    result = service.join_circle(user_id="member-user", code="2345-6789-ABCD")

    assert result["joined"] is True
    event_index = next(
        index for index, sql in enumerate(conn.sql) if "INSERT INTO one_location_events" in sql
    )
    event_params = conn.params[event_index]
    assert event_params["owner_user_id"] == "owner-user"
    assert event_params["actor_user_id"] == "member-user"
    assert event_params["event_type"] == "location_circle_code_joined"
    assert event_params["metadata"] == (
        f'{{"invite_id":"{invite_id}","circle_id":"{circle_id}",'
        '"circle_name":"Family","counterpart_label":"Member User"}'
    )
    assert len(push_calls) == 1


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


def test_targeted_invite_accept_notifies_inviter(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Accepting used to write the membership silently -- the inviter's
    # Circle only reflected the new member after a manual reload, since
    # nothing told their client anything had changed.
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
            "invitee_display_name": "Member User",
            "status": "pending",
            "expires_at": now + timedelta(hours=1),
            "created_at": now,
        },
        None,
        {"user_id": "inviter-member"},
        {"id": "connection-id"},
        {"id": "direct-origin-id"},
        {"circle_count": 0},
        # No `member_count` row here. The capacity check is one statement now --
        # the `circle_count` subquery above -- so a second count is a result the
        # service never asks for, and this scripted connection hands rows out in
        # order regardless of SQL. It was silently feeding the membership INSERT
        # a count and then feeding _connect_member_to_circle a None, which reads
        # as "you are not in this Circle" and raised
        # LOCATION_CIRCLE_MEMBERSHIP_NOT_ACTIVE on a member who had just joined.
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
    monkeypatch.setattr(
        circle_service_module,
        "ensure_connection_origin",
        lambda _conn, **kwargs: {},
    )
    monkeypatch.setattr(
        service,
        "get_circle",
        lambda **_kwargs: {"id": circle_id, "name": "Family"},
    )
    push_calls: list[dict] = []
    monkeypatch.setattr(
        push_notifications_module,
        "send_circle_member_invite_accepted_push",
        lambda **kwargs: push_calls.append(kwargs) or 1,
    )

    result = service.accept_member_invite(
        user_id="member-user",
        invite_id=invite_id,
    )

    assert result["accepted"] is True
    event_index = next(
        index for index, sql in enumerate(conn.sql) if "INSERT INTO one_location_events" in sql
    )
    event_params = conn.params[event_index]
    assert event_params["owner_user_id"] == "inviter-member"
    assert event_params["actor_user_id"] == "member-user"
    assert event_params["event_type"] == "location_circle_member_invite_accepted"
    assert event_params["metadata"] == (
        f'{{"invite_id":"{invite_id}","circle_id":"{circle_id}",'
        '"circle_name":"Family","counterpart_label":"Member User"}'
    )
    assert push_calls == [
        {
            "inviter_user_id": "inviter-member",
            "invitee_user_id": "member-user",
            "invitee_display_name": "Member User",
            "circle_id": circle_id,
            "circle_name": "Family",
            "invite_id": invite_id,
        }
    ]


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


def test_adding_connections_writes_memberships_and_tells_each_person(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Picking a connection puts them in the Circle. Nothing is left pending.

    This used to write an invitation and wait up to 72 hours for the other
    person to agree to something they had already agreed to: only ACTIVE DIRECT
    CONNECTIONS can be picked here, so both people had chosen each other before
    the sheet ever opened. The membership is written now, and the work
    acceptance used to do -- the Circle-scoped origin for the pair -- is done
    in the same transaction.

    An invitation that was already open for one of them is retired rather than
    left standing: the membership it was asking for now exists, so offering
    that person a decision about it would be offering a choice about something
    already settled.
    """

    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    existing_id = "550e8400-e29b-41d4-a716-446655440002"
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
        # Everyone named in the request, locked before the connection rows.
        [{"user_id": "friend-one"}, {"user_id": "friend-two"}],
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
        # friend-one: membership insert, then the co-member lock.
        None,
        [{"user_id": "friend-one"}, {"user_id": "owner-user"}],
        # friend-two: the same two.
        None,
        [
            {"user_id": "friend-one"},
            {"user_id": "friend-two"},
            {"user_id": "owner-user"},
        ],
        # Retiring the invitation that was already open for friend-one.
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
    push_calls: list[dict] = []
    monkeypatch.setattr(
        push_notifications_module,
        "send_circle_member_added_push",
        lambda **kwargs: push_calls.append(kwargs) or 1,
    )
    monkeypatch.setattr(
        push_notifications_module,
        "_lookup_display_name",
        lambda user_id: "Owner" if user_id == "owner-user" else "",
    )
    result = service.create_member_invites(
        actor_user_id="owner-user",
        circle_id=circle_id,
        invitee_user_ids=["friend-one", "friend-two", "friend-one"],
    )

    # Nobody is invited any more, and both people are in.
    assert result["invites"] == []
    assert result["createdInviteIds"] == []
    assert result["addedUserIds"] == ["friend-one", "friend-two"]
    assert not any("INSERT INTO one_location_circle_member_invites" in sql for sql in conn.sql)
    assert sum("INSERT INTO one_location_circle_memberships" in sql for sql in conn.sql) == 2

    # Each new member is paired with whoever added them, and with nobody else.
    assert {(call["user_a_id"], call["user_b_id"], call["kind"]) for call in origin_calls} == {
        ("friend-one", "owner-user", "circle_member"),
        ("friend-one", "owner-user", "named_circle"),
        ("friend-two", "owner-user", "circle_member"),
        ("friend-two", "owner-user", "named_circle"),
    }

    # And each is told, by name. "Someone added you to a Circle" is the one
    # thing this notification must never be able to say.
    assert [call["member_user_id"] for call in push_calls] == ["friend-one", "friend-two"]
    assert all(call["added_by_display_name"] == "Owner" for call in push_calls)
    assert all(call["circle_name"] == "Family" for call in push_calls)
    event_params = [
        params
        for sql, params in zip(conn.sql, conn.params, strict=True)
        if "INSERT INTO one_location_events" in sql
    ]
    assert [params["owner_user_id"] for params in event_params] == [
        "friend-one",
        "friend-two",
    ]
    assert all(params["actor_user_id"] == "owner-user" for params in event_params)
    assert all(params["event_type"] == "circle_member_added" for params in event_params)
    assert all('"added_by_label":"Owner"' in params["metadata"] for params in event_params)

    # The invitation friend-one already had is resolved, not left dangling.
    assert any(
        "UPDATE one_location_circle_member_invites" in sql and "'accepted'" in sql
        for sql in conn.sql
    )

    # Lock order: Circle, the actor's membership, the people being added, then
    # their memberships in this Circle.
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
    invitee_lock_index = next(
        index
        for index, sql in enumerate(conn.sql)
        if "FROM actor_profiles" in sql and "ORDER BY user_id" in sql
    )
    target_membership_lock_index = next(
        index
        for index, sql in enumerate(conn.sql)
        # The same statement also decides whether anyone here left recently,
        # so it is matched on that rather than on its column list.
        if "AS left_recently" in sql
        and "FROM one_location_circle_memberships" in sql
        and "FOR UPDATE" in sql
    )
    assert (
        circle_lock_index
        < actor_membership_lock_index
        < invitee_lock_index
        < target_membership_lock_index
    )


def test_the_people_being_added_are_locked_before_the_connection_rows() -> None:
    """The deadlock this ordering exists to prevent.

    `accept_member_invite` locks a profile and THEN the connection. If adding
    took them the other way round, A adding B to one Circle while B accepts A's
    older invitation to another would be a cycle on that exact pair: one
    transaction holding the connection and waiting for the profile, the other
    holding the profile and waiting for the connection. Postgres would break
    the tie by aborting one of them with a 500 the person did nothing to earn.
    """

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
        # One row short: friend-two has no actor profile.
        [{"user_id": "friend-one"}],
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

    assert raised.value.code == "LOCATION_CIRCLE_INVITEE_NOT_READY"
    # Not named. Which of your connections has finished onboarding is their
    # business, not the business of whoever is adding them.
    assert "friend-two" not in raised.value.args[0]
    # The lock is taken before anything is read about the pair.
    assert not any("FROM connections connection" in sql for sql in conn.sql)
    profile_lock_index = next(
        index
        for index, sql in enumerate(conn.sql)
        if "FROM actor_profiles" in sql and "FOR UPDATE" in sql
    )
    assert "ORDER BY user_id" in conn.sql[profile_lock_index]


def test_a_member_cannot_add_anybody_to_a_circle_they_do_not_own() -> None:
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
        [{"user_id": "removed-user"}],
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

    # This used to be a rule of its own -- "only the owner may re-add someone
    # they removed". It is now a consequence of the bigger one: a member cannot
    # add anybody, removed or not.
    assert raised.value.code == "LOCATION_CIRCLE_OWNER_REQUIRED"
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
        [{"user_id": "friend-one"}],
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
            actor_user_id="owner-user",
            circle_id=circle_id,
            invitee_user_ids=["friend-one"],
        )

    assert raised.value.code == "LOCATION_CIRCLE_INVITE_COOLDOWN"
    assert raised.value.status_code == 429
    # The cooldown outlived the invitation flow on purpose. A declined
    # invitation is that person saying no; without this, adding them directly
    # would be a way to overrule it twelve hours early.
    assert not any("INSERT INTO one_location_circle_memberships" in sql for sql in conn.sql)


def test_only_the_owner_may_open_either_door_into_a_circle() -> None:
    """The rule that replaced a ceiling, a system-Circle exception, and a
    re-add rule -- because all three were the same question badly split.

    Sharing through a Circle never asks whether two people connected: shared
    membership is enough (`_lock_share_delivery`). So whoever decides
    membership decides who may receive the owner's location. A member adding
    their own connection put a stranger to the owner inside that scope, and
    the owner was never shown the decision being made.

    A join code is the same door with a link attached, so it moved too.

    What used to guard fragments of this:
      * a five-person ceiling on how much of someone else's Circle a member
        could fill -- it bounded the damage instead of preventing it;
      * a system-Circle-only rule, because the emergency list was the case
        where it obviously mattered;
      * "only the owner may re-add someone they removed".
    All three are consequences of the one rule now, and gone as separate code.
    """

    import inspect

    from hushh_mcp.services import one_location_circle_service as module

    add = inspect.getsource(module.OneLocationCircleService.create_member_invites)
    code = inspect.getsource(module.OneLocationCircleService.create_invite_code)
    for name, source in (("adding", add), ("the invite code", code)):
        assert "LOCATION_CIRCLE_OWNER_REQUIRED" in source, f"{name} is not owner-only"

    summary = inspect.getsource(module.OneLocationCircleService._circle_summary)
    assert '"canInviteMembers": is_owner' in summary
    assert '"canViewInviteCode": is_owner and not is_system' in summary

    # The fragments are gone from the module, not merely bypassed.
    whole = inspect.getsource(module)
    assert "CIRCLE_NON_OWNER_PENDING_INVITE_LIMIT" not in whole
    assert "LOCATION_CIRCLE_MEMBER_INVITE_LIMIT_REACHED" not in whole
    assert "LOCATION_CIRCLE_SYSTEM_OWNER_ONLY" not in whole

    # And gone from the ADD path specifically. The same code still guards the
    # two paths a person walks themselves -- redeeming a code, accepting an
    # older invitation -- where the actor is the joiner and the owner's removal
    # is the thing being checked. That rule is still needed there.
    assert "LOCATION_CIRCLE_MEMBERSHIP_REMOVED" not in add
    assert "LOCATION_CIRCLE_MEMBERSHIP_REMOVED" in inspect.getsource(
        module.OneLocationCircleService.accept_member_invite
    )


def test_adding_someone_who_already_has_an_open_invitation_retires_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """This used to 409. Refusing here now refuses the outcome it asked for.

    Two members picking the same person was a conflict when picking meant
    reserving an invitation: the second tap had nothing to add and would have
    reassigned the first member's invitation to itself. Now the second tap
    makes that person a MEMBER, which is exactly what accepting the pending
    invitation would have produced -- so the invitation is marked accepted
    instead of standing in the way of its own result.
    """

    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    conn = _CapacityConnection(
        {
            "id": circle_id,
            "name": "Family",
            "kind": "family",
            "owner_user_id": "owner-user",
            "member_limit": 20,
            "role": "owner",
        },
        {"role": "owner", "inviter_display_name": "Owner"},
        [{"user_id": "friend-one"}],
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
        {"active_member_count": 2, "pending_invite_count": 1},
        None,
        [{"user_id": "friend-one"}, {"user_id": "member-user"}],
        None,
    )
    service = OneLocationCircleService(
        db=_TransactionDb(conn),  # type: ignore[arg-type]
        hmac_key="a" * 32,
    )

    monkeypatch.setattr(
        circle_service_module,
        "ensure_connection_origin",
        lambda _conn, **kwargs: {},
    )

    result = service.create_member_invites(
        actor_user_id="owner-user",
        circle_id=circle_id,
        invitee_user_ids=["friend-one"],
    )

    assert result["addedUserIds"] == ["friend-one"]
    assert any("INSERT INTO one_location_circle_memberships" in sql for sql in conn.sql)
    assert any(
        "UPDATE one_location_circle_member_invites" in sql
        and "'accepted'" in sql
        and "'direct_add'" in sql
        for sql in conn.sql
    )


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
        [{"user_id": "friend-one"}, {"user_id": "friend-two"}],
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
    # Batch capacity is all-or-nothing: one person over the limit adds nobody,
    # rather than filling the last seat and failing on the rest.
    assert not any("INSERT INTO one_location_circle_memberships" in sql for sql in conn.sql)


def test_disconnecting_takes_each_person_out_of_the_others_circles(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The membership was the second arm of an OR, not a leftover row.

    `remove_connection` revoked the connection, the trusted edge and every
    proposal-bound grant, and left Circle memberships alone. But One Location
    permits a delivery when there is an active non-Circle connection origin OR
    the two share an active Circle -- so the membership kept the permission
    alive on its own. Someone who removed you as a connection went on
    receiving your live location, and, because SOS reads the system Circle's
    roster, your address in an emergency SMS.
    """

    conn = _CapacityConnection(
        [
            {"circle_id": "circle-owned-by-a", "user_id": "user-b"},
            {"circle_id": "circle-sms-of-b", "user_id": "user-a"},
        ],
        # Per ended membership: code revoke, invite cancel, then the grant
        # reconciliation's three statements and the SMS-contact cleanup.
        *([None] * 12),
    )
    origin_revocations: list[dict] = []
    monkeypatch.setattr(
        circle_service_module,
        "revoke_circle_origins",
        lambda _conn, **kwargs: origin_revocations.append(kwargs),
    )

    ended = OneLocationCircleService.end_memberships_for_disconnected_pair(
        conn,
        user_a_id="user-a",
        user_b_id="user-b",
    )

    assert ended == [
        {"circleId": "circle-owned-by-a", "userId": "user-b"},
        {"circleId": "circle-sms-of-b", "userId": "user-a"},
    ]
    update = conn.sql[0]
    assert "UPDATE one_location_circle_memberships" in update
    assert "status = 'removed'" in update
    # Both directions: your Circles and theirs.
    assert "circle.owner_user_id = :user_a" in update
    assert "circle.owner_user_id = :user_b" in update
    # Never the owner's own row -- falling out with a member does not evict
    # you from the Circle you own.
    assert "membership.role = 'member'" in update
    # A system Circle has no exemption here. It is the one where a stale
    # membership costs the most.
    assert "is_system" not in update
    # And each departure drags the same tail a leave does.
    assert origin_revocations == [
        {"circle_id": "circle-owned-by-a", "member_user_id": "user-b"},
        {"circle_id": "circle-sms-of-b", "member_user_id": "user-a"},
    ]
    assert sum("UPDATE one_location_circle_invite_codes" in sql for sql in conn.sql) == 2
    assert sum("SET status = 'revoked', revoked_at = NOW()" in sql for sql in conn.sql) >= 2


def test_a_third_persons_circle_is_not_theirs_to_break_up() -> None:
    """Two members falling out is not the owner's decision to act on.

    A and B are both in C's Family Circle because C put them there. If they
    disconnect from each other, neither has been rejected by C, and evicting
    either would be C's Circle answering for a relationship it is not part of.
    Either of them can leave it; nothing here does it for them.
    """

    import inspect

    from hushh_mcp.services.one_location_circle_service import OneLocationCircleService

    source = inspect.getsource(OneLocationCircleService.end_memberships_for_disconnected_pair)

    # Every branch of the match is anchored on one of the two OWNING the
    # Circle. There is no clause that matches on co-membership alone.
    assert "circle.owner_user_id = :user_a" in source
    assert "circle.owner_user_id = :user_b" in source
    assert source.count("circle.owner_user_id") == 2


def test_disconnecting_from_yourself_is_not_an_eviction() -> None:
    """A malformed pair must not match every membership either user has."""

    conn = _CapacityConnection()

    assert (
        OneLocationCircleService.end_memberships_for_disconnected_pair(
            conn, user_a_id="user-a", user_b_id="user-a"
        )
        == []
    )
    assert (
        OneLocationCircleService.end_memberships_for_disconnected_pair(
            conn, user_a_id="", user_b_id="user-b"
        )
        == []
    )
    assert conn.sql == []


def test_leaving_a_circle_cannot_be_undone_the_moment_it_happens() -> None:
    """Leaving has to survive the person who is adding you.

    While adding meant inviting, add-leave-add went nowhere: putting someone
    back produced an invitation they could simply ignore, so the loop never
    closed. Adding immediately closes it -- someone still holding a connection
    could put you back the instant you left, as many times as they liked, and
    each round is a push notification.

    So leaving now costs the same twelve hours a decline does. It binds the
    OWNER too: every other rule here protects a Circle from its members, and
    this one protects a person from the Circle.

    The permanent remedy is one level up and always was -- a connection is
    what makes adding possible at all, so disconnecting ends it outright.
    """

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
        [{"user_id": "friend-one"}],
        None,
        [{"user_id": "friend-one", "status": "left", "left_recently": True}],
    )
    service = OneLocationCircleService(
        db=_TransactionDb(conn),  # type: ignore[arg-type]
        hmac_key="a" * 32,
    )

    with pytest.raises(OneLocationCircleError) as raised:
        service.create_member_invites(
            actor_user_id="owner-user",
            circle_id=circle_id,
            invitee_user_ids=["friend-one"],
        )

    assert raised.value.code == "LOCATION_CIRCLE_MEMBER_LEFT_RECENTLY"
    assert raised.value.status_code == 429
    # Unnamed, like every other refusal that is about somebody else's history.
    assert "friend-one" not in raised.value.args[0]
    # Refused before anything is read about the pair, and nobody is written.
    assert not any("FROM connections connection" in sql for sql in conn.sql)
    assert not any("INSERT INTO one_location_circle_memberships" in sql for sql in conn.sql)


def test_an_old_departure_does_not_block_being_added_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The cooldown is a cooldown, not a ban.

    Someone who left months ago and asked to come back is not being overruled;
    they are being let back in. Only a departure inside the window refuses.
    """

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
        [{"user_id": "friend-one"}],
        None,
        [{"user_id": "friend-one", "status": "left", "left_recently": False}],
        [{"connection_id": "connection-1", "user_id": "friend-one"}],
        [{"connection_id": "connection-1"}],
        [],
        {"active_member_count": 1, "pending_invite_count": 0},
        None,
        [{"user_id": "friend-one"}, {"user_id": "owner-user"}],
    )
    service = OneLocationCircleService(
        db=_TransactionDb(conn),  # type: ignore[arg-type]
        hmac_key="a" * 32,
    )

    monkeypatch.setattr(
        circle_service_module,
        "ensure_connection_origin",
        lambda _conn, **kwargs: {},
    )

    result = service.create_member_invites(
        actor_user_id="owner-user",
        circle_id=circle_id,
        invitee_user_ids=["friend-one"],
    )

    assert result["addedUserIds"] == ["friend-one"]


def test_a_seat_an_open_invitation_already_reserved_is_not_charged_twice(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A full-looking Circle that is not actually full.

    Capacity counts active members PLUS open invitations, because an
    invitation reserves a seat for whoever it was sent to. Adding that same
    person then charged for the seat a second time -- so a Circle with exactly
    one seat left, reserved by an invitation to Bob, refused to add Bob.

    Reachable only through invitations written before adding replaced them, and
    only against a nearly full Circle. Both of which will happen to somebody.
    """

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
        [{"user_id": "friend-one"}],
        None,
        [],
        [{"connection_id": "connection-1", "user_id": "friend-one"}],
        [{"connection_id": "connection-1"}],
        [
            {
                "id": "550e8400-e29b-41d4-a716-446655440002",
                "circle_id": circle_id,
                "inviter_user_id": "owner-user",
                "invitee_user_id": "friend-one",
                "status": "pending",
                "expires_at": datetime.now(timezone.utc) + timedelta(hours=1),
            }
        ],
        # Nineteen members and one seat, held by friend-one's own invitation.
        {"active_member_count": 19, "pending_invite_count": 1},
        None,
        [{"user_id": "friend-one"}, {"user_id": "owner-user"}],
        None,
    )
    service = OneLocationCircleService(
        db=_TransactionDb(conn),  # type: ignore[arg-type]
        hmac_key="a" * 32,
    )
    monkeypatch.setattr(
        circle_service_module,
        "ensure_connection_origin",
        lambda _conn, **kwargs: {},
    )

    result = service.create_member_invites(
        actor_user_id="owner-user",
        circle_id=circle_id,
        invitee_user_ids=["friend-one"],
    )

    assert result["addedUserIds"] == ["friend-one"]
    assert any("INSERT INTO one_location_circle_memberships" in sql for sql in conn.sql)


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
        [{"user_id": "friend-one"}, {"user_id": "friend-two"}],
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
    assert not any("INSERT INTO one_location_circle_memberships" in sql for sql in conn.sql)


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


def test_being_added_to_a_circle_always_names_who_added_you(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The one notification that cannot be allowed to say "Someone".

    Every other Circle notification follows something the person did: they were
    invited and tapped, or they redeemed a code. This one follows nothing they
    did at all, so it is the only moment they learn about it -- and a banner
    reading "You were added to a Circle" is a stranger's hand on the shoulder.

    The name is in `data` as well as `body` because the in-app toast reads only
    the data map. That gap is exactly how #5422 ended up showing "Someone" on a
    toast while the OS banner two inches above it had the name right.
    """

    captured: dict = {}

    def _capture(user_id: str, **kwargs):
        captured["user_id"] = user_id
        captured.update(kwargs)
        return 1

    monkeypatch.setattr(push_notifications_module, "send_user_data_push", _capture)

    sent = send_circle_member_added_push(
        member_user_id="member-user",
        added_by_user_id="owner-user",
        added_by_display_name="Neelesh",
        circle_id="550e8400-e29b-41d4-a716-446655440000",
        circle_name="Family",
    )

    assert sent == 1
    assert captured["notification_type"] == "location_circle_member_added"
    assert captured["notification_category"] == "ONE_LOCATION"
    assert captured["body"] == 'Neelesh added you to "Family".'
    assert captured["deep_link"].endswith(
        "?tab=people&circleId=550e8400-e29b-41d4-a716-446655440000"
    )
    assert captured["data"]["added_by_label"] == "Neelesh"
    assert captured["data"]["circle_name"] == "Family"


def test_an_unresolvable_name_degrades_to_the_circle_not_to_nobody(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the identity cache has nothing, say what it does know.

    `_lookup_display_name` returns "" rather than a raw uid when the cached
    display name is technical. Reaching for "Someone" at that point throws away
    the Circle name, which is still real and still tells the person where they
    landed.
    """

    captured: dict = {}
    monkeypatch.setattr(
        push_notifications_module,
        "send_user_data_push",
        lambda user_id, **kwargs: captured.update(kwargs) or 1,
    )

    send_circle_member_added_push(
        member_user_id="member-user",
        added_by_user_id="owner-user",
        added_by_display_name="",
        circle_id="550e8400-e29b-41d4-a716-446655440000",
        circle_name="SMS Circle",
    )

    assert captured["body"] == 'You were added to "SMS Circle".'
    assert "Someone" not in captured["body"]


def test_the_sms_circle_still_introduces_nobody_and_costs_nobody_a_circle(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two exemptions that would be easy to lose in the merge.

    A system Circle is one person's private emergency list. The people on it
    can see each other -- that is the point -- but being on it is not an
    introduction, so no connection origin is written between them and the
    owner. And it does not count against anyone's ten-Circle budget: being
    somebody's emergency contact should never cost you a Circle of your own.
    """

    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    conn = _CapacityConnection(
        {
            "id": circle_id,
            "name": "SMS Circle",
            "kind": "other",
            "owner_user_id": "owner-user",
            "member_limit": 20,
            "is_system": True,
        },
        {"role": "owner", "inviter_display_name": "Owner"},
        [{"user_id": "friend-one"}],
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
        [],
        {"active_member_count": 1, "pending_invite_count": 0},
        # One row only: the membership insert. No Circle-budget check and no
        # co-member lock, because neither happens on a system Circle.
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
    push_calls: list[dict] = []
    monkeypatch.setattr(
        push_notifications_module,
        "send_circle_member_added_push",
        lambda **kwargs: push_calls.append(kwargs) or 1,
    )
    monkeypatch.setattr(push_notifications_module, "_lookup_display_name", lambda _u: "Owner")
    result = service.create_member_invites(
        actor_user_id="owner-user",
        circle_id=circle_id,
        invitee_user_ids=["friend-one"],
    )

    assert result["addedUserIds"] == ["friend-one"]
    # No introductions.
    assert origin_calls == []
    # No Circle-budget check ran against the person being added.
    assert not any("SELECT COUNT(*) AS circle_count" in sql for sql in conn.sql)
    # They are still told, and still told by name.
    assert [call["member_user_id"] for call in push_calls] == ["friend-one"]
    assert push_calls[0]["added_by_display_name"] == "Owner"
    assert push_calls[0]["circle_name"] == "SMS Circle"
    # The membership records who put them there, which is what the non-owner
    # ceiling counts.
    insert_params = next(
        params
        for sql, params in zip(conn.sql, conn.params, strict=True)
        if "INSERT INTO one_location_circle_memberships" in sql
    )
    assert insert_params["added_via"] == "sms_system_circle"
    assert insert_params["actor_user_id"] == "owner-user"


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
                "is_ria": True,
            }
        ],
    )
    service = OneLocationCircleService(db=db, hmac_key="a" * 32)  # type: ignore[arg-type]

    eligible = service.list_eligible_direct_connections(
        actor_user_id="actor-user",
        circle_id=circle_id,
    )

    assert [row["userId"] for row in eligible] == ["circle-only-peer"]
    assert eligible[0]["isRia"] is True
    listing_sql = next(
        sql for sql in db.sql if "FROM connection_origins" in sql or "connection_origins" in sql
    )
    assert "origin.status = 'active'" in listing_sql
    # The guard: provenance must not be filtered down to direct requests.
    assert "origin_kind = 'direct_request'" not in listing_sql
    assert "ria_profiles ria_annotation" in listing_sql


def test_every_aggregating_circle_query_groups_by_the_owner_name_it_selects() -> None:
    """A GROUP BY that lost a column, and a test suite that could not see it.

    The owner-name label was added to two queries: the Circles LIST and the
    Circle DETAIL. Both aggregate a member count, so both need the new column
    in their GROUP BY. Only the list got it. Postgres rejects the other one
    outright -- "column owner_identity.display_name must appear in the GROUP BY
    clause" -- so `get_circle` 503'd on every call.

    Nothing in this file caught it, and nothing in this file could: the fake
    connection these tests drive records SQL strings and replays canned rows.
    It never parses anything, so a query the database refuses to plan passes
    every assertion here. This test reads the SQL instead of running it, which
    is the cheapest thing that can tell the two apart.
    """

    import inspect
    import re

    from hushh_mcp.services import one_location_circle_service

    source = inspect.getsource(one_location_circle_service)
    selects = [
        block
        for block in re.findall(r'"""(.*?)"""', source, re.S)
        if "owner_identity.display_name AS owner_display_name" in block
    ]
    assert selects, "the owner-name label is gone; delete this test with it"

    for block in selects:
        if "GROUP BY" not in block:
            # A query that aggregates nothing needs no GROUP BY at all.
            continue
        group_by = block[block.index("GROUP BY") :]
        # Stop at the next clause so ORDER BY/HAVING text cannot satisfy this.
        for terminator in ("ORDER BY", "HAVING", "LIMIT"):
            if terminator in group_by:
                group_by = group_by[: group_by.index(terminator)]
        assert "owner_identity.display_name" in group_by, (
            "a query selects owner_identity.display_name and aggregates, but "
            "does not group by it. Postgres refuses to plan this. "
            f"{block.strip()[:400]}"
        )


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


def test_no_add_path_can_walk_into_invitation_payload_code() -> None:
    """The KeyError that made every SMS-Circle add fail on UAT, made impossible.

    The direct-add path wrote memberships and then skipped the invitation loop
    -- but that loop was also what filled `existing_by_user_id`, and further
    down the function built a payload for EVERY requested person by looking
    each one up in that map:

        payloads = [
            self._member_invite_payload(existing_by_user_id[invitee_user_id])
            for invitee_user_id in cleaned_invitee_user_ids
        ]

    Nothing had ever been put there for a system Circle, so it raised KeyError,
    the request 5xx'd, and the client showed "One is still catching up". The
    first fix was an early return before that code. This is the second: adding
    is now the only path, so the invitation-payload code is not there to be
    walked into -- there is no lookup left to miss.
    """

    import ast
    import inspect
    import textwrap

    from hushh_mcp.services.one_location_circle_service import OneLocationCircleService

    source = textwrap.dedent(inspect.getsource(OneLocationCircleService.create_member_invites))

    # The map that could be missing a key, and the comprehension that indexed
    # it, are both gone.
    assert "existing_by_user_id" not in source
    assert "_member_invite_payload" not in source
    assert "INSERT INTO one_location_circle_member_invites" not in source

    # What replaces them: one membership write, and a return that reports the
    # people who got one.
    assert "INSERT INTO one_location_circle_memberships" in source

    # That write is inside the transaction, so a failure part-way through a
    # batch adds nobody rather than some. `engine.begin()` rolls back on an
    # exception and commits on a normal exit.
    tree = ast.parse(source)
    transaction = next(
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.With) and "begin()" in ast.unparse(node.items[0].context_expr)
    )
    assert "INSERT INTO one_location_circle_memberships" in ast.unparse(transaction)
    # And the return is OUTSIDE it, because the push and feed writes it reports
    # on must not run until the memberships are actually committed.
    assert not any(
        isinstance(node, ast.Return) and isinstance(node.value, ast.Dict)
        for node in ast.walk(transaction)
    )


def test_a_system_circle_has_no_join_code_on_the_server_not_only_in_the_payload() -> None:
    """`canViewInviteCode` was a claim the API did not keep.

    `_circle_summary` has always reported `is_owner and not is_system`, under a
    comment reading "A system Circle has no code at all." The SELECT in
    `create_invite_code` did not read `is_system` and nothing below checked it,
    so an owner reaching the endpoint directly could mint a bearer code that
    joins a stranger into their emergency SMS roster.
    """

    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    conn = _CapacityConnection(
        {
            "id": circle_id,
            "owner_user_id": "owner-user",
            "member_limit": 10,
            "is_system": True,
        },
        {"role": "owner"},
    )
    service = OneLocationCircleService(
        db=_TransactionDb(conn),  # type: ignore[arg-type]
        hmac_key="a" * 32,
    )

    with pytest.raises(OneLocationCircleError) as raised:
        service.create_invite_code(
            actor_user_id="owner-user",
            circle_id=circle_id,
            rotate=False,
        )

    assert raised.value.code == "LOCATION_CIRCLE_SYSTEM_NO_CODE"
    assert raised.value.status_code == 409
    # Refused before any code row is touched, so a rotate cannot revoke the
    # Circle's (nonexistent) code as a side effect of being refused.
    assert not any("one_location_circle_invite_codes" in sql for sql in conn.sql)
    # The other direction -- that an ordinary Circle still mints a code -- is
    # already proved by test_owner_can_rotate_the_shared_circle_code and the
    # two code tests above it, all of which pass a circle row carrying no
    # `is_system` key and reach the INSERT.


def test_a_code_minted_before_the_guard_still_cannot_open_a_system_circle() -> None:
    """Closing the minting side alone would leave the codes already out there.

    Until the guard above, `bootstrap_first_circle` could hand out a code for an
    SMS Circle. Those codes are live, valid for 72 hours, and redeemable by
    whoever holds them, so the redemption side has to refuse too.
    """

    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    invite_id = "550e8400-e29b-41d4-a716-446655440001"
    conn = _CapacityConnection(
        {"id": invite_id, "circle_id": circle_id},
        {
            "id": circle_id,
            "owner_user_id": "owner-user",
            "member_limit": 10,
            "status": "active",
            "is_system": True,
        },
    )
    service = OneLocationCircleService(
        db=_TransactionDb(conn),  # type: ignore[arg-type]
        hmac_key="a" * 32,
    )

    with pytest.raises(OneLocationCircleError) as raised:
        service.join_circle(user_id="stranger-user", code="2345-6789-ABCD")

    # Not a new error state: from the holder's side it is a code that does not
    # work, and naming the Circle's kind would tell a stranger something about a
    # roster they have no business knowing exists.
    assert raised.value.code == "LOCATION_CIRCLE_CODE_INVALID"
    assert raised.value.status_code == 404
    assert not any("INSERT INTO one_location_circle_memberships" in sql for sql in conn.sql)


def test_a_trusted_circle_has_no_join_code_either() -> None:
    """The same door, on the Circle the flag cannot see.

    The guard above asked `is_system`, which was the whole question while the
    SMS Circle was the only product-managed Circle. Trusted is deliberately NOT
    `is_system` -- migration 163 carries the reasoning -- so it walked straight
    through and could be minted a bearer code.

    A code into a Trusted Circle is a code into the list of everyone the owner
    is connected to, handed to whoever holds it.
    """

    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    conn = _CapacityConnection(
        {
            "id": circle_id,
            "owner_user_id": "owner-user",
            "member_limit": 100,
            "is_system": False,
            "system_kind": "trusted",
        },
        {"role": "owner"},
    )
    service = OneLocationCircleService(
        db=_TransactionDb(conn),  # type: ignore[arg-type]
        hmac_key="a" * 32,
    )

    with pytest.raises(OneLocationCircleError) as raised:
        service.create_invite_code(
            actor_user_id="owner-user",
            circle_id=circle_id,
            rotate=False,
        )

    assert raised.value.code == "LOCATION_CIRCLE_SYSTEM_NO_CODE"
    assert raised.value.status_code == 409
    assert not any("one_location_circle_invite_codes" in sql for sql in conn.sql)


def test_a_trusted_code_cannot_be_redeemed_either() -> None:
    """And the redemption side, for the same reason.

    Closing only the minting side would leave live any code handed out before
    the guard widened.
    """

    circle_id = "550e8400-e29b-41d4-a716-446655440000"
    invite_id = "550e8400-e29b-41d4-a716-446655440001"
    conn = _CapacityConnection(
        {"id": invite_id, "circle_id": circle_id},
        {
            "id": circle_id,
            "owner_user_id": "owner-user",
            "member_limit": 100,
            "status": "active",
            "is_system": False,
            "system_kind": "trusted",
        },
    )
    service = OneLocationCircleService(
        db=_TransactionDb(conn),  # type: ignore[arg-type]
        hmac_key="a" * 32,
    )

    with pytest.raises(OneLocationCircleError) as raised:
        service.join_circle(user_id="stranger-user", code="2345-6789-ABCD")

    # The same answer a stranger gets for any Circle that will not take them:
    # naming the kind would tell them a roster exists.
    assert raised.value.code == "LOCATION_CIRCLE_CODE_INVALID"
    assert raised.value.status_code == 404


def test_both_code_doors_read_the_kind_and_not_only_the_flag() -> None:
    """Structural, because the two tests above pass either way once fixed.

    What they cannot catch is the next product-managed Circle: a third kind
    added with `is_system = FALSE` would sail through a guard written as
    `bool(row.get("is_system"))` exactly as Trusted did. Both doors go through
    one predicate now, and this asserts they still do.
    """

    import inspect

    for fn in (
        OneLocationCircleService.create_invite_code,
        OneLocationCircleService.join_circle,
    ):
        source = inspect.getsource(fn)
        assert "_is_product_managed(" in source, fn.__name__
        assert 'bool(circle_row.get("is_system"))' not in source, fn.__name__
        # And it can only answer correctly if the row carries the column.
        assert "system_kind" in source, fn.__name__


def test_onboarding_never_names_or_shares_a_system_circle(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`list_circles` is ordered `updated_at DESC`.

    `ensure_sms_system_circle` stamps `updated_at` on every rename and
    limit-heal, so the most recently updated owned Circle is routinely the SMS
    Circle -- and onboarding would then name it, mint a code for it, and invite
    the person's friends into their emergency roster.
    """

    service = OneLocationCircleService(
        db=_TransactionDb(_CapacityConnection()),  # type: ignore[arg-type]
        hmac_key="a" * 32,
    )
    monkeypatch.setattr(
        service,
        "list_circles",
        lambda **_kwargs: [
            {"id": "sms-circle", "role": "owner", "isSystem": True, "name": "SMS Circle"},
        ],
    )
    created: list[dict] = []

    def _create_circle(**kwargs):
        created.append(kwargs)
        return {"id": "new-circle", "name": kwargs.get("name")}

    monkeypatch.setattr(service, "create_circle", _create_circle)
    monkeypatch.setattr(
        service,
        "create_invite_code",
        lambda **_kwargs: {"code": "2345-6789-ABCD"},
    )

    result = service.bootstrap_first_circle(user_id="owner-user", name="Neelesh's Circle")

    # A Circle of their own, not the emergency one wearing their name.
    assert result["circleId"] == "new-circle"
    assert result["circleName"] == "Neelesh's Circle"
    assert len(created) == 1


def test_onboarding_still_reuses_a_circle_the_person_actually_made(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = OneLocationCircleService(
        db=_TransactionDb(_CapacityConnection()),  # type: ignore[arg-type]
        hmac_key="a" * 32,
    )
    monkeypatch.setattr(
        service,
        "list_circles",
        lambda **_kwargs: [
            {"id": "sms-circle", "role": "owner", "isSystem": True, "name": "SMS Circle"},
            {"id": "family", "role": "owner", "isSystem": False, "name": "K Family"},
        ],
    )

    def _fail(**_kwargs):
        raise AssertionError("bootstrap created a Circle when one already existed")

    monkeypatch.setattr(service, "create_circle", _fail)
    monkeypatch.setattr(
        service,
        "create_invite_code",
        lambda **_kwargs: {"code": "2345-6789-ABCD"},
    )

    result = service.bootstrap_first_circle(user_id="owner-user", name="Neelesh's Circle")

    assert result["circleId"] == "family"
    assert result["circleName"] == "K Family"


def test_onboarding_does_not_pick_the_trusted_circle_as_your_first_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The one system Circle this picker cannot recognise by `isSystem`.

    Trusted is provisioned with `is_system = FALSE` on purpose, so the guard
    above -- written when the SMS Circle was the only product-managed one --
    lets it straight through. It is also the FIRST owned Circle most people
    have, because it is created the moment they accept a connection and long
    before they make one of their own.

    Picked here, it goes to `create_invite_code`, which refuses a Trusted
    Circle, so onboarding does not merely hand out the wrong Circle -- it
    raises, and the person gets no first Circle at all.
    """

    service = OneLocationCircleService(
        db=_TransactionDb(_CapacityConnection()),  # type: ignore[arg-type]
        hmac_key="a" * 32,
    )
    monkeypatch.setattr(
        service,
        "list_circles",
        lambda **_kwargs: [
            {
                "id": "trusted-circle",
                "role": "owner",
                "isSystem": False,
                "systemKind": "trusted",
                "name": "Trusted",
            },
        ],
    )
    created: list[dict] = []

    def _create_circle(**kwargs):
        created.append(kwargs)
        return {"id": "new-circle", "name": kwargs.get("name")}

    monkeypatch.setattr(service, "create_circle", _create_circle)
    minted: list[dict] = []

    def _mint(**kwargs):
        minted.append(kwargs)
        return {"code": "2345-6789-ABCD"}

    monkeypatch.setattr(service, "create_invite_code", _mint)

    result = service.bootstrap_first_circle(user_id="owner-user", name="Neelesh's Circle")

    assert result["circleId"] == "new-circle"
    assert result["circleName"] == "Neelesh's Circle"
    assert len(created) == 1
    # And the code it hands onboarding belongs to that new Circle, never to the
    # roster of everybody they are connected to.
    assert [str(call.get("circle_id")) for call in minted] == ["new-circle"]


def test_onboarding_still_reuses_a_circle_the_person_made_beside_trusted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The guard skips the product's Circles, not the person's."""

    service = OneLocationCircleService(
        db=_TransactionDb(_CapacityConnection()),  # type: ignore[arg-type]
        hmac_key="a" * 32,
    )
    monkeypatch.setattr(
        service,
        "list_circles",
        lambda **_kwargs: [
            {
                "id": "trusted-circle",
                "role": "owner",
                "isSystem": False,
                "systemKind": "trusted",
                "name": "Trusted",
            },
            {"id": "family", "role": "owner", "isSystem": False, "name": "K Family"},
        ],
    )

    def _fail(**_kwargs):
        raise AssertionError("bootstrap created a Circle when one already existed")

    monkeypatch.setattr(service, "create_circle", _fail)
    monkeypatch.setattr(
        service,
        "create_invite_code",
        lambda **_kwargs: {"code": "2345-6789-ABCD"},
    )

    result = service.bootstrap_first_circle(user_id="owner-user", name="Neelesh's Circle")

    assert result["circleId"] == "family"


# ---------------------------------------------------------------------------
# Trusted: a projection of the connection graph, not a permission over it.
# ---------------------------------------------------------------------------


def test_trusted_grants_no_location_authority_anywhere() -> None:
    """The consent property, asserted as a property of the idiom.

    Contact sync (#5458) puts matched people into the owner's Trusted Circle
    before they have accepted anything. The shared-circle arm of location
    eligibility would then make those people shareable -- membership becoming
    the thing that grants access, which is exactly backwards.

    Everyone genuinely connected satisfies the connection arm already, so
    excluding Trusted from the circle arm costs them nothing. Asserted at every
    site because the join is written seven times, and fixing one is how it came
    to be written seven times.
    """

    import inspect

    from hushh_mcp.services import one_location_agent_service as agent_module
    from hushh_mcp.services import one_location_circle_service as circle_module

    sites = 0
    for module in (agent_module, circle_module):
        source = inspect.getsource(module)
        for block in source.split('"""'):
            if "JOIN one_location_circles circle" not in block:
                continue
            if block.count("one_location_circle_memberships") < 2:
                continue
            sites += 1
            assert "circle.system_kind IS DISTINCT FROM 'trusted'" in block, (
                "a shared-Circle eligibility join does not exclude Trusted, so "
                "membership of it would grant location access:\n" + block[:500]
            )

    assert sites >= 7, f"expected at least 7 shared-Circle joins, found {sites}"


def test_a_trusted_circle_reports_no_member_ceiling() -> None:
    # Its stored limit is SMALLINT's, which is a storage fact rather than a
    # product one. "47 / 32767" would invite somebody to wonder what happens at
    # 32,767, and nothing does.
    summary = OneLocationCircleService._circle_summary(
        {
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "name": "Trusted",
            "kind": "other",
            "role": "owner",
            "owner_user_id": "owner-user",
            "viewer_user_id": "owner-user",
            "is_system": False,
            "system_kind": "trusted",
            "member_count": 47,
            "member_limit": 32767,
        }
    )

    assert summary["memberLimit"] is None
    assert summary["systemKind"] == "trusted"
    assert summary["isSystem"] is False


def test_a_trusted_circle_offers_no_door_and_no_exit() -> None:
    owner = OneLocationCircleService._circle_summary(
        {
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "name": "Trusted",
            "kind": "other",
            "role": "owner",
            "owner_user_id": "owner-user",
            "viewer_user_id": "owner-user",
            "is_system": False,
            "system_kind": "trusted",
            "member_count": 3,
            "member_limit": 32767,
        }
    )
    caps = owner["viewerCapabilities"]

    # No code: a link into the Circle would be a link into the whole
    # connection graph, handed to whoever holds it.
    assert caps["canViewInviteCode"] is False
    assert caps["canRotateInviteCode"] is False
    # Deleting it is not a decision the product offers -- the roster is derived.
    assert caps["canDeleteCircle"] is False
    # And the owner is not offered a Leave that would be refused.
    assert caps["canLeaveCircle"] is False


def test_an_ordinary_circle_keeps_every_door_it_had() -> None:
    # The guards above are narrowings, and a narrowing that catches the ordinary
    # case is just an outage.
    summary = OneLocationCircleService._circle_summary(
        {
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "name": "K Family",
            "kind": "family",
            "role": "owner",
            "owner_user_id": "owner-user",
            "viewer_user_id": "owner-user",
            "is_system": False,
            "system_kind": None,
            "member_count": 4,
            "member_limit": 100,
        }
    )
    caps = summary["viewerCapabilities"]

    assert summary["memberLimit"] == 100
    assert summary["systemKind"] is None
    assert caps["canViewInviteCode"] is True
    assert caps["canDeleteCircle"] is True


def test_a_member_of_an_ordinary_circle_can_still_leave() -> None:
    summary = OneLocationCircleService._circle_summary(
        {
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "name": "K Family",
            "kind": "family",
            "role": "member",
            "owner_user_id": "someone-else",
            "viewer_user_id": "member-user",
            "is_system": False,
            "system_kind": None,
            "member_count": 4,
            "member_limit": 100,
        }
    )

    assert summary["viewerCapabilities"]["canLeaveCircle"] is True


def test_the_trusted_reconcile_never_resurrects_a_removed_member() -> None:
    """`NOT EXISTS (any status)` is the whole guard.

    This runs on every bootstrap. Filtering the guard on `status = 'active'`
    instead would re-add somebody who had been removed, on every single login --
    the same trap `_migrate_sms_contacts_into_circle` documents and
    test_service_migration_never_resurrects_a_removed_contact locks.
    """

    import inspect

    source = inspect.getsource(OneLocationCircleService._reconcile_trusted_members)
    guard = source[source.index("NOT EXISTS") :]
    guard = guard[: guard.index("ON CONFLICT")]

    assert "existing.circle_id" in guard
    assert "existing.user_id" in guard
    # The absence that matters.
    assert "status" not in guard


def test_the_trusted_reconcile_seeds_only_real_connections() -> None:
    # Migration 135 backfilled a `named_circle` connection for every co-member
    # pair in every Circle -- eighteen pairs of strangers per twenty-person
    # Circle, by 138's own account. Those people never agreed to anything about
    # each other and do not belong in each other's Trusted Circle.
    import inspect

    source = inspect.getsource(OneLocationCircleService._reconcile_trusted_members)

    assert "origin.status = 'active'" in source
    assert "origin.origin_kind <> 'named_circle'" in source
    assert "conn_row.status = 'active'" in source


def test_the_trusted_reconcile_says_nothing_to_anybody() -> None:
    # `create_member_invites` sends a push and writes a feed event per member
    # added. A reconcile for a 200-connection account must be silent.
    import inspect

    source = (
        inspect.getsource(OneLocationCircleService._reconcile_trusted_members)
        + inspect.getsource(OneLocationCircleService.ensure_trusted_system_circle)
        + inspect.getsource(OneLocationCircleService.ensure_trusted_membership_for_pair)
    )

    assert "send_circle_member_added_push" not in source
    assert "FeedService" not in source
    assert "record_event" not in source


def test_the_trusted_reconcile_is_not_bound_by_a_member_ceiling() -> None:
    # Refusing to record a connection somebody already accepted would be worse
    # than an oversized roster. The ceiling is written once, when the Circle is
    # created; neither the reconcile nor the accept-path enroll consults it.
    import inspect

    for method in (
        OneLocationCircleService._reconcile_trusted_members,
        OneLocationCircleService.ensure_trusted_membership_for_pair,
    ):
        source = inspect.getsource(method)
        # The pair-enroll creates the Circle if it is missing, so it names the
        # constant -- but never reads the column back to compare against.
        assert "member_count" not in source


def test_a_trusted_membership_is_reactivated_on_reconnect() -> None:
    # The opposite of the contact-match path, where a dismissal must survive a
    # re-sync. Reconnecting is exactly when a Trusted membership should return.
    import inspect

    source = inspect.getsource(OneLocationCircleService.ensure_trusted_membership_for_pair)

    assert "ON CONFLICT (circle_id, user_id) DO UPDATE SET" in source
    assert "status = 'active'" in source
    assert "ended_at = NULL" in source


# ---------------------------------------------------------------------------
# What a Circle hands back, and to whom.
# ---------------------------------------------------------------------------


def test_the_join_code_is_withheld_from_anyone_who_may_not_see_it() -> None:
    """`canViewInviteCode` was an instruction sitting on top of the secret.

    `get_circle` attached the live twelve-character code to every response, so
    a plain member who could not see it on screen could read it out of the
    payload one request later. Minting was closed to non-owners earlier in this
    stack; reading is the other half of handing something out.
    """

    import inspect

    source = inspect.getsource(OneLocationCircleService.get_circle)
    # The payload is computed, then gated on the capability the same response
    # already carries.
    assert "invite_code_payload = self._invite_code_payload(" in source
    assert "canViewInviteCode" in source
    assert 'circle["activeInviteCode"] = invite_code_payload if can_view_code else None' in source
    # Never attached unconditionally again.
    assert 'circle["activeInviteCode"] = self._invite_code_payload(' not in source
    # And the rotation hint still reads the real state rather than this
    # viewer's view of it -- otherwise a member is told to rotate a healthy code.
    assert 'summary_row.get("code_id") and invite_code_payload is None' in source


def test_nobody_adds_a_member_to_trusted_by_hand() -> None:
    """Its roster is derived, so a hand-written membership is unexplainable.

    The capability said `is_owner` alone, and Trusted is owner-scoped, so the
    detail screen rendered a filled "Add people" button -- and the endpoint
    honoured it, writing a `named_circle` origin scoped to Trusted. That is the
    exact provenance `ensure_trusted_system_circle` documents it must never
    write: such an origin is revoked when the membership ends, which is
    backwards for a roster derived from the connection itself.
    """

    import inspect

    summary = inspect.getsource(OneLocationCircleService._circle_summary)
    assert '"canInviteMembers": is_owner and not is_trusted' in summary

    # And the endpoint refuses independently, because a capability flag is an
    # instruction rather than a control.
    invites = inspect.getsource(OneLocationCircleService.create_member_invites)
    assert "circle.system_kind" in invites
    assert 'if str(circle_row.get("system_kind") or "") == "trusted":' in invites
    assert "LOCATION_CIRCLE_TRUSTED_FOLLOWS_CONNECTION" in invites


def test_the_trusted_refusal_comes_before_the_ownership_check() -> None:
    """Its owner is refused too, so the order has to put the kind first.

    Checking ownership first would let the Circle's owner -- the one person who
    passes it -- straight through to the write.
    """

    import inspect

    invites = inspect.getsource(OneLocationCircleService.create_member_invites)
    assert invites.index('== "trusted"') < invites.index("LOCATION_CIRCLE_OWNER_REQUIRED")


def test_a_user_id_is_never_shown_where_a_name_belongs() -> None:
    """The identity cache can hold the uid as the display name.

    For an account with no display name the sync has been observed to store the
    Firebase uid itself, and a Circle row rendered it verbatim:
    "6mRRECV04CYyKrGQT1sGe2zszdt1's SMS Circle" on a real screen -- an opaque
    28-character token where a person's name belongs.

    Fixing the sync is its own change. Nothing that formats a name for a reader
    should trust it in the meantime.
    """

    from hushh_mcp.services.one_location_circle_service import _human_display_name

    uid = "6mRRECV04CYyKrGQT1sGe2zszdt1"
    # The name IS the id it is keyed by.
    assert _human_display_name(uid, uid) == ""
    # Or is uid-shaped even when keyed by somebody else.
    assert _human_display_name(uid, "another-user") == ""
    assert _human_display_name("", uid) == ""
    # Real names survive, including ones with unusual casing or a single word.
    assert _human_display_name("John Smith", uid) == "John Smith"
    assert _human_display_name("hushh Social", uid) == "hushh Social"
    assert _human_display_name("Anastasia", uid) == "Anastasia"


def test_a_shared_system_circle_falls_back_rather_than_showing_the_uid() -> None:
    """What the reader actually sees once the name is refused."""

    summary = OneLocationCircleService._circle_summary(
        {
            "id": "circle-1",
            "owner_user_id": "6mRRECV04CYyKrGQT1sGe2zszdt1",
            "name": "SMS Circle",
            "is_system": True,
            "system_kind": "sms",
            "member_count": 3,
            "member_limit": 10,
            "owner_display_name": "6mRRECV04CYyKrGQT1sGe2zszdt1",
            "viewer_user_id": "83gXHbAmS6eh4vhprEhO20ASjrL2",
        }
    )
    assert summary["name"] == "Shared SMS Circle"

    # And a real owner name still disambiguates, which is the whole point of
    # the rename: three friends' rosters must not be three identical rows.
    named = OneLocationCircleService._circle_summary(
        {
            "id": "circle-2",
            "owner_user_id": "PJc45gn3Qqb9wO42oHOks1NBVD83",
            "name": "SMS Circle",
            "is_system": True,
            "system_kind": "sms",
            "member_count": 3,
            "member_limit": 10,
            "owner_display_name": "hushh Social",
            "viewer_user_id": "83gXHbAmS6eh4vhprEhO20ASjrL2",
        }
    )
    assert named["name"] == "hushh Social's SMS Circle"


def test_one_person_who_left_recently_does_not_block_the_rest_of_the_batch():
    """Picking several people and having one be ineligible must not stop the rest.

    Both membership rules used to reject the whole request. Leaving a Circle
    costs a cooldown that binds the owner too -- correctly, it is how someone
    says no to a Circle and makes it stick -- but the rule is about ONE person,
    and applying it to the batch meant nobody was added and the only
    explanation was that "someone" you selected had left.

    Asserted at the guard rather than through a completed insert: what changed
    is which people survive it, and the surviving list is what every later
    step reads. Driving the full write path would need a dozen more positional
    fixtures and would pin the harness rather than the behaviour.
    """

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
        [{"user_id": "friend-one"}, {"user_id": "friend-two"}],
        None,
        [{"user_id": "friend-one", "status": "left", "left_recently": True}],
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

    # It got PAST the cooldown guard, which used to end the request here.
    assert raised.value.code != "LOCATION_CIRCLE_MEMBER_LEFT_RECENTLY"

    # And carried only the eligible person forward. The connection lookup is
    # the first step after the guard, so its parameters are where the filtered
    # roster first becomes observable.
    connection_params = [
        params
        for sql, params in zip(conn.sql, conn.params, strict=True)
        if "FROM one_location_connections" in sql or "connection.id AS connection_id" in sql
    ]
    assert connection_params, "expected the connection lookup to run"
    assert connection_params[0]["invitee_user_ids"] == ["friend-two"]


def test_an_add_naming_only_blocked_people_still_fails_loudly():
    """Filtering must not turn a doomed request into a silent success.

    With everyone named removed, there is nothing to do -- and returning an
    empty success would tell the person their add worked when nobody was
    added. The precise error each rule always raised is still raised.
    """

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
        [{"user_id": "friend-one"}],
        None,
        [{"user_id": "friend-one", "status": "active", "left_recently": False}],
    )
    service = OneLocationCircleService(
        db=_TransactionDb(conn),  # type: ignore[arg-type]
        hmac_key="a" * 32,
    )

    with pytest.raises(OneLocationCircleError) as raised:
        service.create_member_invites(
            actor_user_id="owner-user",
            circle_id=circle_id,
            invitee_user_ids=["friend-one"],
        )

    assert raised.value.code == "LOCATION_CIRCLE_ALREADY_MEMBER"
    assert raised.value.status_code == 409
    # Unnamed, like every other refusal about somebody else's history.
    assert "friend-one" not in raised.value.args[0]
