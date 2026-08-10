"""A working AI connection earns a pod. A login does not.

Provisioning used to fire off phone verification, which put a billable, warm,
heartbeating Cloud Run service behind an event that said nothing about whether the
agent could ever think. This gate moves the trigger to the moment a key actually
answers a generation request.

Three properties carry the weight:

  * it is IDEMPOTENT — the validate endpoint is a pre-save probe the UI calls
    freely, and one user tapping "test" four times must not race four provisions;
  * the phone comes from the VERIFIED identity server-side, never from the request;
  * nothing here can fail a credential validation. A person testing their API key
    must never be shown a provisioning error.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.ai_connection_gate import on_ai_connection_verified


class _Registry:
    def __init__(self, row: dict | None = None) -> None:
        self._row = row

    async def get(self, _user_id: str):
        return self._row


class _Identity:
    def __init__(self, *, verified: bool = True, phone: str = "+15551234567") -> None:
        self._verified = verified
        self._phone = phone
        self.scheduled: list[tuple] = []

    async def get_many(self, user_ids):
        return {
            uid: {"phone_verified": self._verified, "phone_number": self._phone} for uid in user_ids
        }

    def schedule_provision_personal_agent(self, user_id, phone, *, via_ai_connection=False):
        self.scheduled.append((user_id, phone, via_ai_connection))
        return True


@pytest.fixture(autouse=True)
def _flags(monkeypatch):
    import hushh_mcp.runtime_settings as settings

    monkeypatch.setattr(settings, "personal_agent_enabled", lambda: True)
    monkeypatch.setattr(settings, "provision_on_ai_connection", lambda: True)


async def _verify(**kwargs):
    defaults = {
        "user_id": "u1",
        "provider": "gemini",
        "registry": _Registry(None),
        "identity": _Identity(),
    }
    defaults.update(kwargs)
    return await on_ai_connection_verified(**defaults)


# -- the trigger ---------------------------------------------------------------


async def test_a_verified_connection_schedules_provisioning():
    identity = _Identity()
    result = await _verify(identity=identity)

    assert result["scheduled"] is True
    assert identity.scheduled[0][0] == "u1"
    # The flag that tells the legacy phone-verify path to stand down.
    assert identity.scheduled[0][2] is True


async def test_the_phone_comes_from_the_verified_identity_not_the_caller():
    """A caller must not be able to name the phone their HusshID is minted from."""
    identity = _Identity(phone="+15559999999")
    await _verify(identity=identity)
    assert identity.scheduled[0][1] == "+15559999999"


async def test_an_unverified_phone_provisions_nothing():
    """An unverified number would mint a HusshID against a phone nobody proved."""
    identity = _Identity(verified=False)
    result = await _verify(identity=identity)

    assert result["scheduled"] is False
    assert identity.scheduled == []
    assert "phone" in result["reason"]


# -- idempotence ---------------------------------------------------------------


@pytest.mark.parametrize("status", ["provisioning", "connecting", "provisioned"])
async def test_a_user_who_already_has_a_host_is_not_provisioned_again(status):
    """The validate endpoint is a probe the UI calls repeatedly. Four taps on
    "test" must not race four provisions."""
    identity = _Identity()
    result = await _verify(registry=_Registry({"status": status}), identity=identity)

    assert result["scheduled"] is False
    assert identity.scheduled == []
    assert status in result["reason"]


async def test_a_row_that_is_only_reserved_still_provisions():
    """`pending` means an identity exists with no host — exactly the case this
    gate is for."""
    identity = _Identity()
    result = await _verify(registry=_Registry({"status": "pending"}), identity=identity)
    assert result["scheduled"] is True


# -- never break the validation -------------------------------------------------


async def test_a_registry_failure_does_not_raise():
    class _Broken:
        async def get(self, _user_id):
            raise RuntimeError("db is down")

    result = await _verify(registry=_Broken())
    assert result["scheduled"] is False
    assert "RuntimeError" in result["reason"]


async def test_a_scheduler_failure_does_not_raise():
    def _boom(*_args, **_kwargs):
        raise RuntimeError("task loop is gone")

    result = await _verify(scheduler=_boom)
    assert result["scheduled"] is False


async def test_an_empty_user_is_refused_without_touching_anything():
    identity = _Identity()
    result = await on_ai_connection_verified(user_id="  ", provider="gemini", identity=identity)
    assert result["scheduled"] is False
    assert identity.scheduled == []


# -- the flags ------------------------------------------------------------------


async def test_nothing_happens_while_the_personal_agent_is_off(monkeypatch):
    import hushh_mcp.runtime_settings as settings

    monkeypatch.setattr(settings, "personal_agent_enabled", lambda: False)
    identity = _Identity()
    result = await _verify(identity=identity)

    assert result["scheduled"] is False
    assert identity.scheduled == []


async def test_the_legacy_trigger_can_be_restored(monkeypatch):
    """Turning the AI-connection trigger off must hand ownership back rather than
    leaving no trigger at all."""
    import hushh_mcp.runtime_settings as settings

    monkeypatch.setattr(settings, "provision_on_ai_connection", lambda: False)
    identity = _Identity()
    result = await _verify(identity=identity)

    assert result["scheduled"] is False
    assert identity.scheduled == []


async def test_the_phone_verify_path_stands_down_while_this_gate_owns_the_trigger(monkeypatch):
    """The two triggers are mutually exclusive: running both races two provisions
    for one user."""
    import hushh_mcp.runtime_settings as settings
    from hushh_mcp.services.actor_identity_service import ActorIdentityService

    monkeypatch.setattr(settings, "personal_agent_enabled", lambda: True)
    monkeypatch.setattr(settings, "provision_on_ai_connection", lambda: True)

    service = ActorIdentityService()
    # The phone-verify caller passes no `via_ai_connection` flag.
    assert service.schedule_provision_personal_agent("u1", "+15551234567") is False


# -- a pod is only worth creating if it can actually serve ------------------------
#
# Managed is the DEFAULT connection mode, and choosing it used to contact no server
# route at all -- the webapp wrote the mode into the user's own PKM vault and
# `GET /managed/readiness` had zero callers anywhere. So for most users the server
# never learned an AI connection existed. `POST /managed/select` closes that; these
# cover what the gate does once it finally hears about it.


async def test_managed_does_not_provision_while_a_pod_cannot_serve_it(monkeypatch):
    """A managed pod would boot, warm, heartbeat and refuse every turn with "this
    pod has no model access", at full price. That is the same mistake as
    provisioning on login, one step later in the journey."""
    import hushh_mcp.runtime_settings as settings

    monkeypatch.setattr(settings, "pod_managed_model_enabled", lambda: False)
    identity = _Identity()
    result = await _verify(provider="hushh_managed_vertex", identity=identity)

    assert result["scheduled"] is False
    # The refusal used to be the single generic string "pod cannot serve this
    # connection mode". It now carries the SPECIFIC reason from
    # `model_access_policy`, because the gate asks per deployment path and the
    # answers differ -- "the fleet flag is off" and "CloudHub has no Vertex at all"
    # are different facts and a shared sentence hid that. Asserting the substance
    # keeps this test about behaviour rather than about wording.
    assert "pod_managed_model_enabled is off" in result["reason"]
    assert identity.scheduled == []


async def test_managed_provisions_once_a_pod_can_serve_it(monkeypatch):
    """One switch governs both halves. Flipping it must move BOTH -- otherwise the
    setting that lets a pod serve managed turns and the setting that creates managed
    pods drift apart, which is how you get a fleet that cannot think."""
    import hushh_mcp.runtime_settings as settings

    monkeypatch.setattr(settings, "pod_managed_model_enabled", lambda: True)
    identity = _Identity()
    result = await _verify(provider="hushh_managed_vertex", identity=identity)

    assert result["scheduled"] is True
    assert identity.scheduled and identity.scheduled[0][2] is True


async def test_byok_never_depends_on_the_managed_switch(monkeypatch):
    """A BYOK key arrives with each turn, so the pod needs no standing model access
    and the pod service account keeps its zero project roles."""
    import hushh_mcp.runtime_settings as settings

    monkeypatch.setattr(settings, "pod_managed_model_enabled", lambda: False)
    identity = _Identity()

    assert (await _verify(provider="gemini", identity=identity))["scheduled"] is True


@pytest.mark.parametrize("provider", ["HUSHH_MANAGED_VERTEX", "  hushh_managed_vertex  "])
async def test_the_managed_provider_is_matched_case_and_space_insensitively(monkeypatch, provider):
    """A near-miss on this string silently reverts to "provision anything", which is
    the failure mode that costs money rather than the one that shows an error.

    Writing this test is what found the near-miss: `hussh_` for `hushh_` sails
    through every reader and every linter, and the brand carries BOTH spellings."""
    import hushh_mcp.runtime_settings as settings

    monkeypatch.setattr(settings, "pod_managed_model_enabled", lambda: False)
    identity = _Identity()

    assert (await _verify(provider=provider, identity=identity))["scheduled"] is False
    assert identity.scheduled == []


def test_the_managed_provider_string_matches_what_the_route_actually_sends():
    """Pinned to the CALLER, not to a literal restated here. The gate reads a string
    the route chooses; if they diverge the gate silently stops recognising managed
    connections and starts provisioning pods that cannot serve them -- with every
    test in this file still green, because they would all restate the same wrong
    constant."""
    import inspect

    from api.routes.one import runtime as runtime_route
    from hushh_mcp.services.ai_connection_gate import _MANAGED_PROVIDER

    source = inspect.getsource(runtime_route.select_managed_gemini)
    assert f'provider="{_MANAGED_PROVIDER}"' in source
