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
    """The scheduler still works — but only for a caller that owns the trigger.

    Provisioning now fires on a VERIFIED AI CONNECTION rather than on phone
    verification, because a login says nothing about whether the agent could ever
    think: a user who verified a phone and never connected a model got a warm,
    billable pod that answered nothing. `via_ai_connection=True` marks the caller
    that owns the trigger; the phone-verify caller stands down (asserted below).
    """
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    from hushh_mcp.services import actor_identity_service as ais

    seen: dict = {}

    async def fake_register(self, user_id, phone_number):
        seen["user_id"] = user_id
        seen["phone"] = phone_number

    monkeypatch.setattr(ais.ActorIdentityService, "_register_pending_personal_agent", fake_register)

    ok = ais.ActorIdentityService().schedule_provision_personal_agent(
        _UID, _PHONE, via_ai_connection=True
    )
    assert ok is True

    task = ais._PERSONAL_AGENT_PROVISION_TASKS.get(_UID)
    assert task is not None
    await task  # let the fire-and-forget task run

    assert seen == {"user_id": _UID, "phone": _PHONE}


async def test_phone_verify_alone_no_longer_provisions(monkeypatch):
    """The behaviour change, asserted directly: verifying a phone must not stand up
    a billable pod for someone who has not connected a working model yet."""
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    monkeypatch.delenv("PERSONAL_AGENT_PROVISION_ON_AI_CONNECTION", raising=False)
    from hushh_mcp.services import actor_identity_service as ais

    # async, deliberately: with no running loop the scheduler returns False because
    # it cannot create a task, which would make this pass for a reason unrelated to
    # the trigger. The restore test below is the control that proves it is the flag.
    assert ais.ActorIdentityService().schedule_provision_personal_agent(_UID, _PHONE) is False


async def test_the_legacy_phone_verify_trigger_can_be_restored(monkeypatch):
    """Turning the new trigger off hands ownership back rather than leaving none."""
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    monkeypatch.setenv("PERSONAL_AGENT_PROVISION_ON_AI_CONNECTION", "0")
    from hushh_mcp.services import actor_identity_service as ais

    # Clear the per-user in-flight dedupe so this asserts the FLAG rather than the
    # leftover task an earlier test in this module scheduled for the same uid.
    ais._PERSONAL_AGENT_PROVISION_TASKS.pop(_UID, None)

    assert ais.ActorIdentityService().schedule_provision_personal_agent(_UID, _PHONE) is True
