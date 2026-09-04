from __future__ import annotations

import asyncio
import copy
import logging
import sys
import types
from datetime import datetime, timezone

import pytest

import hushh_mcp.services.actor_identity_service as actor_identity_service
from hushh_mcp.services.actor_identity_service import (
    ActorIdentityAliasError,
    ActorIdentityService,
)


class _AliasFakeAcquire:
    def __init__(self, conn):
        self.conn = conn

    async def __aenter__(self):
        return self.conn

    async def __aexit__(self, *args: object) -> None:
        return None


class _AliasFakePool:
    def __init__(self, conn):
        self.conn = conn

    def acquire(self):
        return _AliasFakeAcquire(self.conn)


class _AliasFakeConnection:
    def __init__(self) -> None:
        self.rows: list[dict[str, object]] = []

    async def fetch(self, query: str, *args):
        normalized = " ".join(query.lower().split())
        if "from actor_verified_email_aliases" in normalized and "where user_id = $1" in normalized:
            user_id = args[0]
            return [row for row in self.rows if row["user_id"] == user_id]
        return []

    async def fetchrow(self, query: str, *args):
        normalized = " ".join(query.lower().split())
        if (
            "from actor_verified_email_aliases" in normalized
            and "email_normalized = $1" in normalized
            and "user_id <> $2" in normalized
        ):
            email_normalized, user_id = args
            return next(
                (
                    row
                    for row in self.rows
                    if row["email_normalized"] == email_normalized
                    and row["user_id"] != user_id
                    and row["verification_status"] == "verified"
                    and row["revoked_at"] is None
                ),
                None,
            )
        if (
            "from actor_verified_email_aliases" in normalized
            and "where user_id = $1" in normalized
            and "email_normalized = $2" in normalized
        ):
            user_id, email_normalized = args
            return next(
                (
                    row
                    for row in self.rows
                    if row["user_id"] == user_id and row["email_normalized"] == email_normalized
                ),
                None,
            )
        if "insert into actor_verified_email_aliases" in normalized:
            user_id, email, email_normalized, source, source_ref, code_hash = args
            existing = next(
                (
                    row
                    for row in self.rows
                    if row["user_id"] == user_id and row["email_normalized"] == email_normalized
                ),
                None,
            )
            if existing is None:
                existing = {
                    "alias_id": f"alias_{len(self.rows) + 1}",
                    "created_at": datetime.now(timezone.utc),
                    "last_matched_at": None,
                }
                self.rows.append(existing)
            existing.update(
                {
                    "user_id": user_id,
                    "email": email,
                    "email_normalized": email_normalized,
                    "verification_status": "pending",
                    "verification_source": source,
                    "source_ref": source_ref,
                    "verification_code_hash": code_hash,
                    "verification_requested_at": datetime.now(timezone.utc),
                    "verified_at": None,
                    "revoked_at": None,
                    "updated_at": datetime.now(timezone.utc),
                }
            )
            return existing
        if "update actor_verified_email_aliases" in normalized:
            user_id, email_normalized = args
            row = next(
                row
                for row in self.rows
                if row["user_id"] == user_id and row["email_normalized"] == email_normalized
            )
            row.update(
                {
                    "verification_status": "verified",
                    "verified_at": datetime.now(timezone.utc),
                    "revoked_at": None,
                    "verification_code_hash": None,
                    "updated_at": datetime.now(timezone.utc),
                }
            )
            return row
        return None


class _PhoneClaimFakeConnection:
    def __init__(self) -> None:
        now = datetime.now(timezone.utc)
        self.rows: dict[str, dict[str, object]] = {
            "other-firebase-user-1234567890": {
                "user_id": "other-firebase-user-1234567890",
                "display_name": "Other User",
                "email": "other@example.com",
                "phone_number": "+16505550101",
                "photo_url": None,
                "email_verified": True,
                "phone_verified": True,
                "source": "firebase_phone_claim",
                "last_synced_at": now,
                "created_at": now,
                "updated_at": now,
            },
            "firebase-user-123456789012": {
                "user_id": "firebase-user-123456789012",
                "display_name": "Kai User",
                "email": "kai@example.com",
                "phone_number": None,
                "photo_url": None,
                "email_verified": True,
                "phone_verified": False,
                "source": "firebase_auth",
                "last_synced_at": now,
                "created_at": now,
                "updated_at": now,
            },
        }
        self.fail_claim = False
        self.statement_order: list[str] = []

    class _Transaction:
        def __init__(self, conn: "_PhoneClaimFakeConnection") -> None:
            self.conn = conn
            self.snapshot: dict[str, dict[str, object]] | None = None

        async def __aenter__(self) -> None:
            self.snapshot = copy.deepcopy(self.conn.rows)
            return None

        async def __aexit__(self, exc_type, *args: object) -> bool:
            if exc_type is not None and self.snapshot is not None:
                self.conn.rows = self.snapshot
            return False

    def transaction(self) -> "_PhoneClaimFakeConnection._Transaction":
        return self._Transaction(self)

    async def execute(self, query: str, *args):
        normalized = " ".join(query.lower().split())
        if "insert into vault_keys" in normalized:
            self.statement_order.append("vault")
            return "INSERT 0 1"
        if "insert into actor_profiles" in normalized:
            self.statement_order.append("profile")
            return "INSERT 0 1"
        if "pg_advisory_xact_lock" in normalized:
            self.statement_order.append("phone_lock")
            assert query.count("$1") == 1
            assert args == ("actor_identity_phone_claim:+16505550101",)
            assert "+16505550101" not in query
            return "SELECT 1"
        if "update actor_identity_cache" not in normalized:
            return "UPDATE 0"
        self.statement_order.append("clear_duplicate")
        assert "order by user_id" in normalized
        assert "for update" in normalized
        user_id, phone_number = args
        cleared = 0
        for row in self.rows.values():
            if row["user_id"] != user_id and row["phone_number"] == phone_number:
                row["phone_number"] = None
                row["phone_verified"] = False
                row["updated_at"] = datetime.now(timezone.utc)
                cleared += 1
        return f"UPDATE {cleared}"

    async def fetchrow(self, query: str, *args):
        normalized = " ".join(query.lower().split())
        if "insert into actor_identity_cache" not in normalized:
            return None
        self.statement_order.append("claim")
        if self.fail_claim:
            raise RuntimeError("simulated identity insert failure")
        user_id, phone_number, source = args
        now = datetime.now(timezone.utc)
        row = self.rows.setdefault(
            user_id,
            {
                "user_id": user_id,
                "display_name": None,
                "email": None,
                "photo_url": None,
                "email_verified": False,
                "created_at": now,
            },
        )
        row.update(
            {
                "phone_number": phone_number,
                "phone_verified": True,
                "source": source,
                "last_synced_at": now,
                "updated_at": now,
            }
        )
        return row


@pytest.mark.asyncio
async def test_verified_phone_owner_transfer_uses_parameterized_lock_and_ordered_rows() -> None:
    statements: list[tuple[str, tuple[object, ...]]] = []

    class FakeConnection:
        async def execute(self, query: str, *args: object) -> str:
            statements.append((query, args))
            return "OK"

    await ActorIdentityService._lock_and_clear_verified_phone_binding(
        FakeConnection(),  # type: ignore[arg-type]
        user_id="firebase-user-123456789012",
        phone_number="+16505550101",
    )

    assert len(statements) == 2
    lock_sql, lock_args = statements[0]
    assert "pg_advisory_xact_lock(hashtextextended($1, 0))" in lock_sql
    assert lock_args == ("actor_identity_phone_claim:+16505550101",)
    assert "+16505550101" not in lock_sql
    clear_sql, clear_args = statements[1]
    assert "WITH locked_bindings AS MATERIALIZED" in clear_sql
    assert clear_sql.index("ORDER BY user_id") < clear_sql.index("FOR UPDATE")
    assert clear_args == ("firebase-user-123456789012", "+16505550101")


@pytest.mark.asyncio
async def test_sync_from_firebase_mirrors_phone_number(monkeypatch: pytest.MonkeyPatch) -> None:
    service = ActorIdentityService()

    async def fake_get_many(user_ids: list[str]) -> dict[str, dict]:
        assert user_ids == ["firebase-user-123456789012"]
        return {}

    captured: dict[str, object] = {}

    async def fake_upsert_identity(**kwargs):
        captured.update(kwargs)
        return {"user_id": kwargs["user_id"]}

    monkeypatch.setattr(service, "get_many", fake_get_many)
    monkeypatch.setattr(service, "upsert_identity", fake_upsert_identity)
    monkeypatch.setattr(actor_identity_service, "get_firebase_auth_app", lambda: object())

    fake_user_record = types.SimpleNamespace(
        display_name="Kai User",
        email="kai@example.com",
        phone_number="+16505550101",
        photo_url="https://example.com/avatar.png",
        email_verified=True,
    )
    fake_auth = types.SimpleNamespace(get_user=lambda uid, app=None: fake_user_record)
    monkeypatch.setitem(sys.modules, "firebase_admin", types.SimpleNamespace(auth=fake_auth))

    await service.sync_from_firebase("firebase-user-123456789012", force=True)

    assert captured["user_id"] == "firebase-user-123456789012"
    assert captured["email"] == "kai@example.com"
    assert captured["phone_number"] == "+16505550101"
    assert captured["phone_verified"] is True
    assert captured["source"] == "firebase_auth"


@pytest.mark.asyncio
async def test_sync_from_firebase_preserves_backend_phone_claim_when_firebase_has_no_phone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ActorIdentityService()

    async def fake_get_many(user_ids: list[str]) -> dict[str, dict]:
        assert user_ids == ["firebase-user-123456789012"]
        return {
            "firebase-user-123456789012": {
                "user_id": "firebase-user-123456789012",
                "phone_number": "+16505550101",
                "phone_verified": True,
                "last_synced_at": datetime.now(timezone.utc),
            }
        }

    captured: dict[str, object] = {}

    async def fake_upsert_identity(**kwargs):
        captured.update(kwargs)
        return {"user_id": kwargs["user_id"], "phone_verified": True}

    monkeypatch.setattr(service, "get_many", fake_get_many)
    monkeypatch.setattr(service, "upsert_identity", fake_upsert_identity)
    monkeypatch.setattr(actor_identity_service, "get_firebase_auth_app", lambda: object())

    fake_user_record = types.SimpleNamespace(
        display_name="Kai User",
        email="kai@example.com",
        phone_number=None,
        photo_url=None,
        email_verified=True,
    )
    fake_auth = types.SimpleNamespace(get_user=lambda uid, app=None: fake_user_record)
    monkeypatch.setitem(sys.modules, "firebase_admin", types.SimpleNamespace(auth=fake_auth))

    await service.sync_from_firebase("firebase-user-123456789012", force=True)

    assert captured["phone_number"] is None
    assert captured["phone_verified"] is None


@pytest.mark.asyncio
async def test_firebase_sync_failure_never_logs_identity_or_phone_details(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    service = ActorIdentityService()
    firebase_uid = "firebase-user-123456789012"
    phone_number = "+16505550101"

    async def fake_get_many(user_ids: list[str]) -> dict[str, dict]:
        assert user_ids == [firebase_uid]
        return {}

    def fail_get_user(uid: str, *, app: object) -> None:
        assert uid == firebase_uid
        raise RuntimeError(f"provider rejected phone {phone_number}")

    monkeypatch.setattr(service, "get_many", fake_get_many)
    monkeypatch.setattr(actor_identity_service, "get_firebase_auth_app", lambda: object())
    monkeypatch.setitem(
        sys.modules,
        "firebase_admin",
        types.SimpleNamespace(auth=types.SimpleNamespace(get_user=fail_get_user)),
    )
    caplog.set_level(logging.DEBUG, logger=actor_identity_service.__name__)

    result = await service.sync_from_firebase(firebase_uid, force=True)

    assert result is None
    messages = "\n".join(record.getMessage() for record in caplog.records)
    assert "error=RuntimeError" in messages
    assert firebase_uid not in messages
    assert phone_number not in messages
    assert not any(character.isdigit() for character in messages)
    assert all(record.exc_info is None for record in caplog.records)


@pytest.mark.asyncio
async def test_claim_verified_phone_moves_duplicate_shadow_to_current_actor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ActorIdentityService()
    conn = _PhoneClaimFakeConnection()
    conn.rows.pop("firebase-user-123456789012")

    async def fake_get_pool() -> _AliasFakePool:
        return _AliasFakePool(conn)

    monkeypatch.setattr(actor_identity_service, "get_pool", fake_get_pool)

    identity = await service.claim_verified_phone(
        user_id="firebase-user-123456789012",
        phone_number="+16505550101",
    )

    assert identity is not None
    assert identity["phone_number"] == "+16505550101"
    assert identity["phone_verified"] is True
    assert identity["source"] == "firebase_phone_claim"
    previous_owner = conn.rows["other-firebase-user-1234567890"]
    assert previous_owner["phone_number"] is None
    assert previous_owner["phone_verified"] is False
    assert conn.statement_order == ["vault", "profile", "phone_lock", "clear_duplicate", "claim"]


@pytest.mark.asyncio
async def test_claim_verified_phone_rolls_back_duplicate_clear_when_claim_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ActorIdentityService()
    conn = _PhoneClaimFakeConnection()
    conn.rows.pop("firebase-user-123456789012")
    conn.fail_claim = True

    async def fake_get_pool() -> _AliasFakePool:
        return _AliasFakePool(conn)

    monkeypatch.setattr(actor_identity_service, "get_pool", fake_get_pool)

    identity = await service.claim_verified_phone(
        user_id="firebase-user-123456789012",
        phone_number="+16505550101",
    )

    assert identity is None
    previous_owner = conn.rows["other-firebase-user-1234567890"]
    assert previous_owner["phone_number"] == "+16505550101"
    assert previous_owner["phone_verified"] is True
    assert "firebase-user-123456789012" not in conn.rows
    assert conn.statement_order == ["vault", "profile", "phone_lock", "clear_duplicate", "claim"]


@pytest.mark.asyncio
@pytest.mark.parametrize("writer", ["upsert", "claim"])
async def test_verified_phone_writer_never_logs_exception_phone_details(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    writer: str,
) -> None:
    phone_number = "+16505550101"
    database_error = RuntimeError(
        "duplicate key value violates unique constraint; "
        f"Key (phone_number)=({phone_number}) already exists"
    )

    class FailingAcquire:
        async def __aenter__(self) -> None:
            raise database_error

        async def __aexit__(self, *args: object) -> None:
            return None

    class FailingPool:
        def acquire(self) -> FailingAcquire:
            return FailingAcquire()

    async def fake_get_pool() -> FailingPool:
        return FailingPool()

    monkeypatch.setattr(actor_identity_service, "get_pool", fake_get_pool)
    caplog.set_level(logging.DEBUG, logger=actor_identity_service.__name__)

    service = ActorIdentityService()
    if writer == "upsert":
        result = await service.upsert_identity(
            user_id="firebase-user-alpha",
            phone_number=phone_number,
            phone_verified=True,
        )
    else:
        result = await service.claim_verified_phone(
            user_id="firebase-user-alpha",
            phone_number=phone_number,
        )

    assert result is None
    messages = "\n".join(record.getMessage() for record in caplog.records)
    assert "error=RuntimeError" in messages
    assert phone_number not in messages
    assert not any(character.isdigit() for character in messages)
    assert all(record.exc_info is None for record in caplog.records)


@pytest.mark.asyncio
async def test_get_many_tolerates_pre_phone_shadow_schema(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ActorIdentityService()

    class FakeConnection:
        def __init__(self) -> None:
            self.calls = 0

        async def fetch(self, query: str, user_ids: list[str]) -> list[dict[str, object]]:
            self.calls += 1
            assert user_ids == ["firebase-user-123456789012"]
            if self.calls == 1:
                raise actor_identity_service.asyncpg.UndefinedColumnError(
                    'column "phone_number" does not exist'
                )
            assert "NULL::TEXT AS phone_number" in query
            return [
                {
                    "user_id": "firebase-user-123456789012",
                    "display_name": "Kai User",
                    "email": "kai@example.com",
                    "phone_number": None,
                    "photo_url": None,
                    "email_verified": True,
                    "phone_verified": False,
                    "source": "firebase_auth",
                    "last_synced_at": None,
                    "created_at": None,
                    "updated_at": None,
                }
            ]

    class FakeAcquire:
        def __init__(self, conn: FakeConnection) -> None:
            self.conn = conn

        async def __aenter__(self) -> FakeConnection:
            return self.conn

        async def __aexit__(self, *args: object) -> None:
            return None

    class FakePool:
        def __init__(self, conn: FakeConnection) -> None:
            self.conn = conn

        def acquire(self) -> FakeAcquire:
            return FakeAcquire(self.conn)

    conn = FakeConnection()

    async def fake_get_pool() -> FakePool:
        return FakePool(conn)

    monkeypatch.setattr(actor_identity_service, "get_pool", fake_get_pool)

    identities = await service.get_many(["firebase-user-123456789012"])

    identity = identities["firebase-user-123456789012"]
    assert identity["display_name"] == "Kai User"
    assert identity["phone_number"] is None
    assert identity["phone_verified"] is False
    assert conn.calls == 2


@pytest.mark.asyncio
async def test_list_account_identifiers_uses_verified_account_aliases(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ActorIdentityService()

    async def fake_sync_from_firebase(user_id: str):
        assert user_id == "firebase-user-123456789012"
        return {
            "email": "Primary@Example.com",
            "email_verified": True,
            "phone_number": "+16505550101",
            "phone_verified": True,
        }

    async def fake_list_aliases(user_id: str):
        assert user_id == "firebase-user-123456789012"
        return [
            {
                "email_normalized": "relay@privaterelay.appleid.com",
                "verification_status": "verified",
                "revoked_at": None,
            },
            {
                "email_normalized": "pending@example.com",
                "verification_status": "pending",
                "revoked_at": None,
            },
        ]

    monkeypatch.setattr(service, "sync_from_firebase", fake_sync_from_firebase)
    monkeypatch.setattr(service, "list_verified_email_aliases", fake_list_aliases)

    identifiers = await service.list_account_identifiers("firebase-user-123456789012")

    assert identifiers == [
        "firebase-user-123456789012",
        "primary@example.com",
        "+16505550101",
        "relay@privaterelay.appleid.com",
    ]


@pytest.mark.asyncio
async def test_email_alias_verification_flow_returns_code_only_in_uat_review_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ActorIdentityService()
    conn = _AliasFakeConnection()

    async def fake_get_pool() -> _AliasFakePool:
        return _AliasFakePool(conn)

    monkeypatch.setattr(actor_identity_service, "get_pool", fake_get_pool)
    monkeypatch.setenv("ENVIRONMENT", "uat")

    requested = await service.request_email_alias_verification(
        user_id="firebase-user-123456789012",
        email="Original@Example.com",
    )

    assert requested["alias"]["email_normalized"] == "original@example.com"
    assert requested["alias"]["verification_status"] == "pending"
    assert requested["review_verification_code"]

    verified = await service.confirm_email_alias_verification(
        user_id="firebase-user-123456789012",
        email="original@example.com",
        verification_code=requested["review_verification_code"],
    )

    assert verified["verification_status"] == "verified"
    assert verified["verified_at"] is not None
    assert "verification_code_hash" not in verified

    aliases = await service.list_verified_email_aliases("firebase-user-123456789012")
    assert aliases[0]["email_normalized"] == "original@example.com"


@pytest.mark.asyncio
async def test_email_alias_verification_blocks_existing_verified_owner(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ActorIdentityService()
    conn = _AliasFakeConnection()
    now = datetime.now(timezone.utc)
    conn.rows.append(
        {
            "alias_id": "alias_existing",
            "user_id": "other-user-1234567890123",
            "email": "original@example.com",
            "email_normalized": "original@example.com",
            "verification_status": "verified",
            "verification_source": "user_verified",
            "source_ref": None,
            "verification_code_hash": None,
            "verification_requested_at": now,
            "verified_at": now,
            "revoked_at": None,
            "last_matched_at": None,
            "created_at": now,
            "updated_at": now,
        }
    )

    async def fake_get_pool() -> _AliasFakePool:
        return _AliasFakePool(conn)

    monkeypatch.setattr(actor_identity_service, "get_pool", fake_get_pool)

    with pytest.raises(ActorIdentityAliasError) as exc:
        await service.request_email_alias_verification(
            user_id="firebase-user-123456789012",
            email="original@example.com",
        )

    assert exc.value.code == "EMAIL_ALIAS_ALREADY_VERIFIED"


@pytest.mark.asyncio
async def test_upsert_identity_ensures_actor_profile_spine_row(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    executed_statements: list[tuple[str, tuple[object, ...]]] = []

    class FakeTx:
        async def __aenter__(self) -> None:
            return None

        async def __aexit__(self, *args: object) -> None:
            return None

    class FakeConn:
        def transaction(self) -> FakeTx:
            return FakeTx()

        async def execute(self, query: str, *args: object) -> str:
            executed_statements.append((query, args))
            return "INSERT 0 1"

        async def fetchrow(self, query: str, *args: object) -> dict[str, object]:
            executed_statements.append((query, args))
            now = datetime.now(timezone.utc)
            return {
                "user_id": args[0],
                "display_name": args[1],
                "email": args[2],
                "phone_number": args[3],
                "photo_url": args[4],
                "email_verified": bool(args[5]),
                "phone_verified": bool(args[6]),
                "source": args[7],
                "last_synced_at": now,
                "created_at": now,
                "updated_at": now,
            }

    class FakeAcquire:
        async def __aenter__(self) -> FakeConn:
            return FakeConn()

        async def __aexit__(self, *args: object) -> None:
            return None

    class FakePool:
        def acquire(self) -> FakeAcquire:
            return FakeAcquire()

    async def fake_get_pool() -> FakePool:
        return FakePool()

    monkeypatch.setattr(actor_identity_service, "get_pool", fake_get_pool)

    service = ActorIdentityService()
    identity = await service.upsert_identity(
        user_id="new-signup-user-9999",
        display_name="New Signup User",
        email="newuser@example.com",
        phone_number="+15559990000",
        phone_verified=True,
    )

    assert identity is not None
    assert identity["user_id"] == "new-signup-user-9999"
    assert identity["phone_verified"] is True
    assert len(executed_statements) == 5
    assert "INSERT INTO vault_keys" in executed_statements[0][0]
    assert "'placeholder'" in executed_statements[0][0]
    assert "INSERT INTO actor_profiles" in executed_statements[1][0]
    lock_sql, lock_args = executed_statements[2]
    assert "pg_advisory_xact_lock(hashtextextended($1, 0))" in lock_sql
    assert lock_args == ("actor_identity_phone_claim:+15559990000",)
    assert "+15559990000" not in lock_sql
    clear_sql, clear_args = executed_statements[3]
    assert "ORDER BY user_id" in clear_sql
    assert "FOR UPDATE" in clear_sql
    assert clear_args == ("new-signup-user-9999", "+15559990000")
    assert "INSERT INTO actor_identity_cache" in executed_statements[4][0]


@pytest.mark.asyncio
async def test_awaited_sync_coalesces_concurrent_callers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ActorIdentityService()
    user_id = "firebase-user-coalesced-1234567890"
    actor_identity_service._IDENTITY_SYNC_TASKS.clear()
    actor_identity_service._IDENTITY_SYNC_IN_FLIGHT.clear()
    actor_identity_service._IDENTITY_SYNC_COOLDOWN_UNTIL.clear()
    started = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def slow_sync(_user_id: str, *, force: bool = False):
        nonlocal calls
        assert _user_id == user_id
        assert force is False
        calls += 1
        started.set()
        await release.wait()
        return {"user_id": _user_id}

    monkeypatch.setattr(service, "sync_from_firebase", slow_sync)

    first = asyncio.create_task(service.sync_from_firebase_if_due(user_id))
    await started.wait()
    second = asyncio.create_task(service.sync_from_firebase_if_due(user_id))
    await asyncio.sleep(0)

    assert calls == 1
    release.set()
    assert await asyncio.gather(first, second) == [
        {"user_id": user_id},
        {"user_id": user_id},
    ]
    assert user_id not in actor_identity_service._IDENTITY_SYNC_IN_FLIGHT
    assert user_id in actor_identity_service._IDENTITY_SYNC_COOLDOWN_UNTIL
    actor_identity_service._IDENTITY_SYNC_COOLDOWN_UNTIL.clear()


@pytest.mark.asyncio
async def test_awaited_sync_success_cooldown_skips_underlying_cache_query(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ActorIdentityService()
    user_id = "firebase-user-cooldown-1234567890"
    actor_identity_service._IDENTITY_SYNC_TASKS.clear()
    actor_identity_service._IDENTITY_SYNC_IN_FLIGHT.clear()
    actor_identity_service._IDENTITY_SYNC_COOLDOWN_UNTIL.clear()
    calls = 0

    async def successful_sync(_user_id: str, *, force: bool = False):
        nonlocal calls
        calls += 1
        return {"user_id": _user_id}

    monkeypatch.setattr(service, "sync_from_firebase", successful_sync)

    assert await service.sync_from_firebase_if_due(user_id) == {"user_id": user_id}
    assert await service.sync_from_firebase_if_due(user_id) is None
    assert calls == 1
    actor_identity_service._IDENTITY_SYNC_COOLDOWN_UNTIL.clear()


@pytest.mark.asyncio
@pytest.mark.parametrize("failure_mode", ["none", "exception"])
async def test_awaited_sync_failure_clears_cooldown_for_retry(
    monkeypatch: pytest.MonkeyPatch,
    failure_mode: str,
) -> None:
    service = ActorIdentityService()
    user_id = "firebase-user-awaited-retry-1234567890"
    actor_identity_service._IDENTITY_SYNC_TASKS.clear()
    actor_identity_service._IDENTITY_SYNC_IN_FLIGHT.clear()
    actor_identity_service._IDENTITY_SYNC_COOLDOWN_UNTIL.clear()
    calls = 0

    async def failed_sync(_user_id: str, *, force: bool = False):
        nonlocal calls
        calls += 1
        if failure_mode == "exception":
            raise RuntimeError("simulated sync failure")
        return None

    monkeypatch.setattr(service, "sync_from_firebase", failed_sync)

    if failure_mode == "exception":
        with pytest.raises(RuntimeError, match="simulated sync failure"):
            await service.sync_from_firebase_if_due(user_id)
    else:
        assert await service.sync_from_firebase_if_due(user_id) is None

    assert user_id not in actor_identity_service._IDENTITY_SYNC_COOLDOWN_UNTIL
    if failure_mode == "exception":
        with pytest.raises(RuntimeError, match="simulated sync failure"):
            await service.sync_from_firebase_if_due(user_id)
    else:
        assert await service.sync_from_firebase_if_due(user_id) is None
    assert calls == 2
    actor_identity_service._IDENTITY_SYNC_IN_FLIGHT.clear()
    actor_identity_service._IDENTITY_SYNC_COOLDOWN_UNTIL.clear()


@pytest.mark.asyncio
@pytest.mark.parametrize("failure_mode", ["none", "exception"])
async def test_failed_scheduled_sync_clears_cooldown_for_immediate_retry(
    monkeypatch: pytest.MonkeyPatch,
    failure_mode: str,
) -> None:
    service = ActorIdentityService()
    user_id = "firebase-user-retry-1234567890"
    actor_identity_service._IDENTITY_SYNC_TASKS.clear()
    actor_identity_service._IDENTITY_SYNC_IN_FLIGHT.clear()
    actor_identity_service._IDENTITY_SYNC_COOLDOWN_UNTIL.clear()

    async def failed_sync(_user_id: str, *, force: bool = False):
        assert _user_id == user_id
        assert force is False
        if failure_mode == "exception":
            raise RuntimeError("simulated sync failure")
        return None

    monkeypatch.setattr(service, "sync_from_firebase", failed_sync)

    assert service.schedule_sync_from_firebase(user_id) is True
    first = actor_identity_service._IDENTITY_SYNC_TASKS[user_id]
    await asyncio.gather(first, return_exceptions=True)
    await asyncio.sleep(0)

    assert user_id not in actor_identity_service._IDENTITY_SYNC_COOLDOWN_UNTIL
    assert service.schedule_sync_from_firebase(user_id) is True
    second = actor_identity_service._IDENTITY_SYNC_TASKS[user_id]
    await asyncio.gather(second, return_exceptions=True)
    await asyncio.sleep(0)
    actor_identity_service._IDENTITY_SYNC_TASKS.clear()
    actor_identity_service._IDENTITY_SYNC_IN_FLIGHT.clear()
    actor_identity_service._IDENTITY_SYNC_COOLDOWN_UNTIL.clear()


@pytest.mark.asyncio
async def test_successful_scheduled_sync_keeps_cooldown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ActorIdentityService()
    user_id = "firebase-user-success-1234567890"
    actor_identity_service._IDENTITY_SYNC_TASKS.clear()
    actor_identity_service._IDENTITY_SYNC_IN_FLIGHT.clear()
    actor_identity_service._IDENTITY_SYNC_COOLDOWN_UNTIL.clear()

    async def successful_sync(_user_id: str, *, force: bool = False):
        assert _user_id == user_id
        assert force is False
        return {"user_id": _user_id}

    monkeypatch.setattr(service, "sync_from_firebase", successful_sync)

    assert service.schedule_sync_from_firebase(user_id) is True
    first = actor_identity_service._IDENTITY_SYNC_TASKS[user_id]
    await first
    await asyncio.sleep(0)

    assert user_id in actor_identity_service._IDENTITY_SYNC_COOLDOWN_UNTIL
    assert service.schedule_sync_from_firebase(user_id) is False
    actor_identity_service._IDENTITY_SYNC_TASKS.clear()
    actor_identity_service._IDENTITY_SYNC_IN_FLIGHT.clear()
    actor_identity_service._IDENTITY_SYNC_COOLDOWN_UNTIL.clear()
