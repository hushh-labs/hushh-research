"""A BYOC pod serves on the owner's own Vertex, with no credential travelling.

Everything needed for this already existed except a NAME. `UserGcpBackend` renders
`GOOGLE_CLOUD_PROJECT` against the person's project and runs the pod as their own
service account, so ambient ADC inside that container is already theirs. What was
missing is that `_resolve_runtime_mode` had no branch for it, so a credential-less turn
on a fully-working BYOC pod returned 400 -- model access complete, refused for want of a
vocabulary entry.

The two properties under test are the ones that decide whose bill a turn lands on.
"""

from __future__ import annotations

import pytest

from api.routes.one.pod_turn import PodTurnRequest, _resolve_runtime_mode


def _req(**kw) -> PodTurnRequest:
    base = dict(message="hello", conversation_id="c1")
    base.update(kw)
    return PodTurnRequest(**base)


def test_a_credential_less_turn_serves_on_the_owners_own_adc(monkeypatch):
    monkeypatch.setenv("HUSSH_POD_USER_ADC_ENABLED", "true")
    monkeypatch.delenv("HUSSH_POD_MANAGED_MODEL_ENABLED", raising=False)

    assert _resolve_runtime_mode(_req()) == "user_adc"


def test_an_owner_who_sends_a_key_still_gets_their_key(monkeypatch):
    """BYOK wins over everything. Nothing below it may take a key from its owner."""
    monkeypatch.setenv("HUSSH_POD_USER_ADC_ENABLED", "true")
    monkeypatch.setenv("HUSSH_POD_MANAGED_MODEL_ENABLED", "true")

    assert _resolve_runtime_mode(_req(runtime_credential="AIza-their-own-key")) == "byok"


def test_user_adc_is_preferred_over_the_fleet_identity(monkeypatch):
    """Order is load-bearing, and this is the assertion that pins it.

    With managed first, a mis-set FLEET flag would capture a BYOC pod and quietly bill a
    person's thinking to hushh while their own project sat idle -- and nothing in the
    answer would look wrong.

    Broken on purpose: move the managed branch above the user_adc branch.
    """
    monkeypatch.setenv("HUSSH_POD_USER_ADC_ENABLED", "true")
    monkeypatch.setenv("HUSSH_POD_MANAGED_MODEL_ENABLED", "true")

    assert _resolve_runtime_mode(_req()) == "user_adc"


def test_a_pod_with_no_model_access_still_refuses(monkeypatch):
    """Refusing beats guessing, and that property must survive the new branch."""
    from fastapi import HTTPException

    monkeypatch.delenv("HUSSH_POD_USER_ADC_ENABLED", raising=False)
    monkeypatch.delenv("HUSSH_POD_MANAGED_MODEL_ENABLED", raising=False)

    with pytest.raises(HTTPException) as excinfo:
        _resolve_runtime_mode(_req())
    assert excinfo.value.status_code == 400


def test_the_runtime_builds_a_model_for_user_adc_and_refuses_a_key():
    """text_runtime must know the mode too, or the 400 becomes a 500.

    Shipping the pod_turn branch without this one turns an honest refusal into an
    unhandled "runtime mode is not recognised" on every credential-less turn.
    """
    from hushh_mcp.one_adk.text_runtime import _runtime_model

    with pytest.raises(ValueError, match="user ADC cannot be constructed from an API key"):
        _runtime_model(
            runtime_model="gemini-3.5-flash",
            runtime_mode="user_adc",
            runtime_credential="AIza-should-not-be-here",
        )


def test_an_unknown_mode_still_refuses_rather_than_reaching_for_the_fleet():
    """The closed set stays closed. Adding a member must not reopen the default."""
    from hushh_mcp.one_adk.text_runtime import _runtime_model

    with pytest.raises(ValueError, match="not recognised"):
        _runtime_model(
            runtime_model="gemini-3.5-flash",
            runtime_mode="something_new",
            runtime_credential=None,
        )


def test_only_the_byoc_renderer_grants_user_adc():
    """The flag is a fact about ONE person's pod, not a deployment setting.

    A hushh-managed pod that read this as on would reach for ambient ADC in HUSHH's
    project -- the fleet identity by another name, and exactly what the managed flag
    exists to gate.
    """
    from hushh_mcp.services.compute_backend import PodSpec
    from hushh_mcp.services.gcp_backend import GcpBackend
    from hushh_mcp.services.user_gcp_backend import UserGcpBackend

    spec = PodSpec(hushh_id="ha1_abc", phone_e164_hash="p", pod_pubkey="k")

    byoc_env = _env_names(UserGcpBackend(user_project="their-project").render_deploy_config(spec))
    assert "HUSSH_POD_USER_ADC_ENABLED" in byoc_env
    # The absence is load-bearing: it is what stops a BYOC pod reaching for a fleet
    # identity at all.
    assert "HUSSH_POD_MANAGED_MODEL_ENABLED" not in byoc_env

    managed_env = _env_names(GcpBackend().render_deploy_config(spec))
    assert "HUSSH_POD_USER_ADC_ENABLED" not in managed_env


def _env_names(cfg: dict) -> set[str]:
    container = cfg["spec"]["template"]["spec"]["containers"][0]
    return {e["name"] for e in container.get("env", [])}
