"""The environment stamp is set on vault unlock and never blocks the unlock."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from hushh_mcp.services import environment_enrollment

ROOT = Path(__file__).resolve().parents[1]


def test_stamp_sets_only_an_unset_active_vault(monkeypatch):
    seen: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        environment_enrollment, "_stamp_sync", lambda uid: seen.append(("stamp", {"uid": uid}))
    )
    asyncio.run(environment_enrollment.stamp_environment_enrollment("owner-1"))
    asyncio.run(environment_enrollment.stamp_environment_enrollment(""))
    assert seen == [("stamp", {"uid": "owner-1"})]
    sql = str(environment_enrollment._STAMP)
    assert "environment_enrolled_at IS NULL" in sql and "vault_status = 'active'" in sql


def test_a_failed_stamp_never_blocks_the_unlock(monkeypatch, caplog):
    def boom(_uid):
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(environment_enrollment, "_stamp_sync", boom)
    asyncio.run(environment_enrollment.stamp_environment_enrollment("owner-1"))
    assert "environment_enrollment.stamp_failed" in caplog.text


@pytest.mark.parametrize(
    "agent_id, stamped", [("self", True), ("device:abc", True), ("agent_x", False)]
)
def test_vault_owner_issuance_stamps_the_owner(monkeypatch, agent_id, stamped):
    from api.routes import consent

    calls: list[str] = []

    async def fake_stamp(uid: str) -> None:
        calls.append(uid)

    class _Service:
        async def get_active_internal_tokens(self, *_a, **_k):
            return []

        async def insert_internal_event(self, **_k):
            return None

    monkeypatch.setattr(consent, "stamp_environment_enrollment", fake_stamp)
    monkeypatch.setattr(consent, "ConsentDBService", _Service)
    asyncio.run(consent._issue_or_reuse_vault_owner_token(user_id="owner-1", agent_id=agent_id))
    assert calls == (["owner-1"] if stamped else [])


def test_migration_backfills_only_from_this_environments_recent_unlocks():
    sql = (ROOT / "db/migrations/295_vault_environment_enrollment.sql").read_text()
    assert "ADD COLUMN IF NOT EXISTS environment_enrolled_at" in sql
    # Inside a window that starts after the dev copy and the production restore.
    assert "'60 days'" in sql and "vault.owner" in sql and "CONSENT_GRANTED" in sql
    assert "environment_enrolled_at IS NULL" in sql
