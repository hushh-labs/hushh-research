"""S6: the pod can reach a model, and One's full specialist fleet is reachable.

Two layers, both verifiable without a live pod:

* **Model access** -- the rendered pod carries the Vertex env (USE_VERTEXAI,
  project, location) so the fleet inside it can call Gemini as itself, in the
  user's own cloud, holding no hub credential.
* **Delegation** -- every product specialist is registered, so none is
  hard-blocked at the availability layer; the three formerly-dark ones
  (email, connections, connected_systems) are now REACHABLE and protected by
  their own require_attenuated_authority guard. One forwards a first-party
  authority context carrying the invocation capability only, so those three
  still fail closed for information/action work until real grant refs exist --
  reachable, self-guarding, and honest about the authority that actually exists.
"""

from __future__ import annotations

import pytest

from hushh_mcp.adk_bridge.contract import (
    A2AAuthorityRequired,
    A2ATask,
    require_attenuated_authority,
)
from hushh_mcp.adk_bridge.dispatch import is_wired_specialist
from hushh_mcp.services.compute_backend import PodSpec
from hushh_mcp.services.gcp_backend import GcpBackend


def _spec() -> PodSpec:
    return PodSpec(hushh_id="HA1FLEET", phone_e164_hash="h", pod_pubkey="p", region="us-central1")


def _backend() -> GcpBackend:
    return GcpBackend(
        project="user-proj", image="img:1", service_account="sa@user-proj", live=False
    )


# --- model access ---------------------------------------------------------------------


def test_the_pod_render_carries_vertex_access(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("HUSSH_POD_VERTEX_PROJECT", raising=False)
    monkeypatch.delenv("HUSSH_POD_VERTEX_LOCATION", raising=False)
    env = {
        e["name"]: e.get("value")
        for e in _backend().render_deploy_config(_spec())["spec"]["template"]["spec"]["containers"][
            0
        ]["env"]
    }
    assert env["GOOGLE_GENAI_USE_VERTEXAI"] == "true"
    # Falls back to the pod's own project + region when not separately configured.
    assert env["GOOGLE_CLOUD_PROJECT"] == "user-proj"
    assert env["GOOGLE_CLOUD_LOCATION"] == "us-central1"


def test_a_byoc_compute_project_overrides_the_defaults(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("HUSSH_POD_VERTEX_PROJECT", "the-users-own-project")
    monkeypatch.setenv("HUSSH_POD_VERTEX_LOCATION", "europe-west4")
    env = {
        e["name"]: e.get("value")
        for e in _backend().render_deploy_config(_spec())["spec"]["template"]["spec"]["containers"][
            0
        ]["env"]
    }
    assert env["GOOGLE_CLOUD_PROJECT"] == "the-users-own-project"
    assert env["GOOGLE_CLOUD_LOCATION"] == "europe-west4"


def test_no_vertex_credential_is_ever_rendered_into_the_artifact():
    """The pod reaches Vertex as its OWN service account -- there is no key to render."""
    blob = str(_backend().render_deploy_config(_spec())).lower()
    for forbidden in ("service_account.json", "private_key", "credentials"):
        assert forbidden not in blob


# --- delegation -----------------------------------------------------------------------


def test_every_product_specialist_is_registered():
    import hushh_mcp.adk_bridge  # noqa: F401 - registration side effect

    for agent_id in (
        "agent_location",
        "agent_nav",
        "agent_personal_information",
        "agent_email",
        "agent_connections",
        "agent_connected_systems",
    ):
        assert is_wired_specialist(agent_id), f"{agent_id} is not reachable"


def test_the_first_party_authority_context_is_built_for_a_governed_task(
    monkeypatch: pytest.MonkeyPatch,
):
    from unittest.mock import MagicMock

    import hushh_mcp.adk_bridge.delegation as delegation
    import hushh_mcp.one_adk.agent_tree as tree

    # A validated first-party session: patch the consent check to accept. The
    # import is deferred inside _first_party_authority (to avoid a cycle), so the
    # patch target is the delegation module, not an agent_tree attribute.
    validation = MagicMock(ok=True, user_id="user-1")
    validation.required_scope.value = "cap.one.invoke"
    monkeypatch.setattr(delegation, "validate_a2a_consent_token", lambda *a, **k: validation)

    context = tree._first_party_authority("user-1", "HCT:token", "conv-1")

    assert context is not None
    assert context.caller_kind == "first_party"
    assert context.subject_user_id == "user-1"
    assert context.invocation_capabilities == ("cap.one.invoke",)
    # The honest boundary: no information/export/action authority is fabricated.
    assert context.information_grant_refs == ()
    assert context.encrypted_export_refs == ()
    assert context.action_capabilities == ()


def test_invocation_only_authority_still_fails_closed_for_information_work():
    """email needs information=True; a first-party invocation context lacks the
    grant + export refs, so require_attenuated_authority raises -- reachable, but
    honestly gated until real grant refs flow."""
    from hushh_mcp.adk_bridge.contract import A2AAuthorityContext

    authority = A2AAuthorityContext(
        subject_user_id="user-1",
        tenant_id="user-1",
        task_id="t1",
        caller_kind="first_party",
        invocation_capabilities=("cap.one.invoke",),
    )
    task = A2ATask(
        user_id="user-1",
        consent_token="HCT:x",  # noqa: S106 - test fixture, not a real credential
        conversation_id="c1",
        authority=authority,
    )
    with pytest.raises(A2AAuthorityRequired):
        require_attenuated_authority(task, information=True)


def test_a_task_with_no_authority_context_still_fails_closed():
    task = A2ATask(user_id="user-1", consent_token="HCT:x", conversation_id="c1", authority=None)  # noqa: S106
    with pytest.raises(A2AAuthorityRequired):
        require_attenuated_authority(task, information=True)


# -- the turn flag has to reach the POD ---------------------------------------------
#
# `pod_turn._require_enabled` reads HUSSH_POD_TURN_ENABLED inside the pod's own
# process, and `pod_turn_enabled()` defaults OFF. The hub having it set does
# nothing for the pod: without it in the rendered env, every provisioned pod
# answers 404 on POST /api/one/pod/turn -- the flag set exactly where it does not
# matter and absent where it does.


def _pod_env(monkeypatch, hub_value: bool):
    from hushh_mcp.services import gcp_backend as mod
    from hushh_mcp.services.compute_backend import PodSpec

    monkeypatch.setattr(mod, "pod_turn_enabled", lambda: hub_value)
    backend = mod.GcpBackend(project="proj", region="us-central1", live=False)
    config = backend.render_deploy_config(
        PodSpec(hushh_id="hushh-abc", phone_e164_hash="h", pod_pubkey="")
    )
    container = config["spec"]["template"]["spec"]["containers"][0]
    return {e["name"]: e.get("value") for e in container["env"]}


def test_a_pod_is_told_whether_it_may_serve_turns(monkeypatch):
    assert _pod_env(monkeypatch, True)["HUSSH_POD_TURN_ENABLED"] == "true"


def test_the_switch_is_propagated_not_hardcoded(monkeypatch):
    """One kill-switch, one meaning. Turning it off on the hub must stop new pods
    from serving turns; two independent settings could disagree, and the
    disagreement would surface as a 404 that reads like a routing bug rather than
    a policy decision."""
    assert _pod_env(monkeypatch, False)["HUSSH_POD_TURN_ENABLED"] == "false"


def test_the_pod_still_gets_the_feature_flag_it_needs_to_mount_anything(monkeypatch):
    """PERSONAL_AGENT_ENABLED gates the whole surface; the turn flag gates one
    route on it. Losing either leaves a pod whose only real endpoint is dead."""
    env = _pod_env(monkeypatch, True)
    assert env["PERSONAL_AGENT_ENABLED"] == "1"
