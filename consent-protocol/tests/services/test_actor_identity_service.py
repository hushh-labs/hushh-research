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
