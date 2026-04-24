from __future__ import annotations

import sys
import types

import pytest

import hushh_mcp.services.actor_identity_service as actor_identity_service
from hushh_mcp.services.actor_identity_service import ActorIdentityService


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
