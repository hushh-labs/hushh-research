from __future__ import annotations

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
