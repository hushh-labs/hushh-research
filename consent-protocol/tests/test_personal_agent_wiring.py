"""Tests for the live wiring of the personal agent into existing flows.

Two seams:
  * account-deletion teardown (``api.routes.account._deprovision_personal_agent``)
    -- best-effort, revoke=False (the cascade already wiped consent_audit), never
    raises;
  * phone-verify kickoff (``ActorIdentityService.schedule_provision_personal_agent``)
    -- flag-gated, fire-and-forget, never blocks phone verification.

Everything is faked/monkeypatched: no DB, no network, no real provisioning.
"""

from __future__ import annotations

import pytest

from hushh_mcp.runtime_settings import get_core_security_settings

_UID = "firebase_uid_test_1234567890"
_PHONE = "+14255550133"

_SVC_PATH = (
    "hushh_mcp.services.personal_agent_provisioning_service.PersonalAgentProvisioningService"
)
_REPO_PATH = "hushh_mcp.services.personal_agent_registry_repo.PersonalAgentRegistryRepo"


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
    monkeypatch.setenv("VAULT_DATA_KEY", "0" * 64)
    get_core_security_settings.cache_clear()
    yield
    get_core_security_settings.cache_clear()


# ---- account-deletion teardown helper --------------------------------------


async def test_account_teardown_calls_deprovision_revoke_false(monkeypatch):
    from api.routes import account

    calls: dict = {}

    class FakeService:
        def __init__(self, **kwargs):
            pass

        async def deprovision(self, *, user_id, revoke=True):
            calls["user_id"] = user_id
            calls["revoke"] = revoke
            return {"status": "deprovisioned", "hushhId": "ha1_x"}

    monkeypatch.setattr(_SVC_PATH, FakeService)
    monkeypatch.setattr(_REPO_PATH, lambda: object())

    status = await account._deprovision_personal_agent(_UID)

    assert status == "deprovisioned"
    assert calls["user_id"] == _UID
    # revoke MUST be suppressed: the deletion cascade already wiped consent_audit.
    assert calls["revoke"] is False


async def test_account_teardown_is_best_effort_on_failure(monkeypatch):
    from api.routes import account

    class BoomService:
        def __init__(self, **kwargs):
            pass

        async def deprovision(self, *, user_id, revoke=True):
            raise RuntimeError("registry down")

    monkeypatch.setattr(_SVC_PATH, BoomService)
    monkeypatch.setattr(_REPO_PATH, lambda: object())

    # Never raises -- account deletion must complete regardless.
    assert await account._deprovision_personal_agent(_UID) == "failed"


async def test_account_teardown_skips_empty_user():
    from api.routes import account

    assert await account._deprovision_personal_agent("") == "skipped"


# ---- phone-verify kickoff scheduler ----------------------------------------


def test_scheduler_is_noop_when_flag_off(monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "0")
    from hushh_mcp.services.actor_identity_service import ActorIdentityService

    assert ActorIdentityService().schedule_provision_personal_agent(_UID, _PHONE) is False


def test_scheduler_rejects_bad_input_when_enabled(monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    from hushh_mcp.services.actor_identity_service import ActorIdentityService

    svc = ActorIdentityService()
    assert svc.schedule_provision_personal_agent("", _PHONE) is False
    assert svc.schedule_provision_personal_agent(_UID, "") is False
    assert svc.schedule_provision_personal_agent("short-uid", _PHONE) is False  # not a firebase uid


async def test_scheduler_kicks_off_register_pending(monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    from hushh_mcp.services import actor_identity_service as ais

    seen: dict = {}

    async def fake_register(self, user_id, phone_number):
        seen["user_id"] = user_id
        seen["phone"] = phone_number

    monkeypatch.setattr(ais.ActorIdentityService, "_register_pending_personal_agent", fake_register)

    ok = ais.ActorIdentityService().schedule_provision_personal_agent(_UID, _PHONE)
    assert ok is True

    task = ais._PERSONAL_AGENT_PROVISION_TASKS.get(_UID)
    assert task is not None
    await task  # let the fire-and-forget task run

    assert seen == {"user_id": _UID, "phone": _PHONE}
