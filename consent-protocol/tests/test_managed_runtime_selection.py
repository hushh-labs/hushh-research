"""`POST /api/one/runtime/managed/select` — the route the default path never had.

Managed is the DEFAULT connection mode. Choosing it was an entirely client-side act:
the webapp wrote the mode into the user's own PKM vault and contacted no server route
at all. `GET /managed/readiness` existed but had ZERO callers anywhere in the webapp.

The consequence is the one worth remembering: provisioning a person's private agent
is gated on "an AI connection was verified", and the gate had exactly one caller --
the BYOK validate route. So for the majority of users the server never learned a
connection existed, and the default onboarding path completed with no agent, no
error, and nothing anywhere saying so.

Two properties carry the weight here:

  * the runtime is PROVED, not asserted -- a probe failure provisions nothing;
  * the probe's cache does not suppress the gate, because the managed binding is
    process-wide (one verification answers for every caller) while the pod decision
    is per-user.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from api.routes.one import runtime as runtime_route


@pytest.fixture(autouse=True)
def _no_cache(monkeypatch):
    """The readiness cache is module state. Left alone it leaks between tests and
    turns a probe assertion into a coin flip on ordering."""
    monkeypatch.setattr(runtime_route, "_managed_readiness_cache", None)


class _Gate:
    def __init__(self, verdict: dict | None = None) -> None:
        self.verdict = verdict or {"scheduled": True, "reason": "ai connection verified"}
        self.calls: list[dict] = []

    async def __call__(self, **kwargs):
        self.calls.append(kwargs)
        return self.verdict


def _ready(location="global"):
    async def _probe():
        return runtime_route.ManagedGeminiReadinessResponse(
            status="ready", model="gemini-3-pro", location=location
        )

    return _probe


def _not_ready():
    async def _probe():
        raise HTTPException(
            status_code=503,
            detail={"code": "MANAGED_GEMINI_NOT_READY", "status": "temporary_unavailable"},
        )

    return _probe


# -- the connection has to prove itself -------------------------------------------


async def test_a_verified_managed_runtime_starts_the_agent(monkeypatch):
    gate = _Gate()
    monkeypatch.setattr(runtime_route, "_probe_managed_gemini", _ready())
    monkeypatch.setattr(runtime_route, "on_ai_connection_verified", gate)

    result = await runtime_route.select_managed_gemini(request=None, firebase_uid="u1")

    assert result.status == "ready"
    assert result.agentScheduled is True
    assert gate.calls[0]["user_id"] == "u1"


async def test_an_unreachable_runtime_provisions_nothing(monkeypatch):
    """The founder's rule is validate-then-provision, and it has to mean the same
    thing in both modes or it is not a rule. A person whose runtime cannot generate
    does not get a billable host that cannot serve."""
    gate = _Gate()
    monkeypatch.setattr(runtime_route, "_probe_managed_gemini", _not_ready())
    monkeypatch.setattr(runtime_route, "on_ai_connection_verified", gate)

    with pytest.raises(HTTPException) as exc:
        await runtime_route.select_managed_gemini(request=None, firebase_uid="u1")

    assert exc.value.status_code == 503
    assert gate.calls == []


async def test_the_provider_names_managed_so_the_gate_can_tell_the_modes_apart(monkeypatch):
    """The gate refuses to provision a managed pod while a pod cannot serve one. It
    can only do that if this route says which mode it is."""
    gate = _Gate()
    monkeypatch.setattr(runtime_route, "_probe_managed_gemini", _ready())
    monkeypatch.setattr(runtime_route, "on_ai_connection_verified", gate)

    await runtime_route.select_managed_gemini(request=None, firebase_uid="u1")

    assert gate.calls[0]["provider"] == "hushh_managed_vertex"


# -- the cache answers for the process, not for the person -------------------------


async def test_a_cached_probe_still_reaches_the_gate(monkeypatch):
    """The managed binding is the fleet's own identity, so one verification genuinely
    answers for every caller -- but the pod decision is per-user. If the cache
    short-circuited the gate, the SECOND managed user of any 60-second window would
    silently get no agent, which is the original bug wearing a different hat."""
    import time

    gate = _Gate()

    async def _must_not_probe():
        raise AssertionError("a warm cache must not re-probe the model")

    # Seed a warm cache entry, which is the state this test is about. Stubbing the
    # probe to count calls would not do it: the real cache is written INSIDE the
    # probe, so a stub never warms it and the test would prove nothing.
    monkeypatch.setattr(
        runtime_route,
        "_managed_readiness_cache",
        (
            time.monotonic(),
            runtime_route.ManagedGeminiReadinessResponse(
                status="ready", model="gemini-3-pro", location="global"
            ),
        ),
    )
    monkeypatch.setattr(runtime_route, "_probe_managed_gemini", _must_not_probe)
    monkeypatch.setattr(runtime_route, "on_ai_connection_verified", gate)

    await runtime_route.select_managed_gemini(request=None, firebase_uid="u1")
    await runtime_route.select_managed_gemini(request=None, firebase_uid="u2")

    assert [c["user_id"] for c in gate.calls] == ["u1", "u2"]


# -- the answer is honest about which of two things happened -----------------------


async def test_the_response_states_whether_an_agent_was_actually_started(monkeypatch):
    """ "We are building your private agent" and "you are on the shared runtime" are
    different promises. The UI can only tell them apart if the response does."""
    gate = _Gate({"scheduled": False, "reason": "pod cannot serve this connection mode"})
    monkeypatch.setattr(runtime_route, "_probe_managed_gemini", _ready())
    monkeypatch.setattr(runtime_route, "on_ai_connection_verified", gate)

    result = await runtime_route.select_managed_gemini(request=None, firebase_uid="u1")

    assert result.status == "ready"
    assert result.agentScheduled is False
    assert result.agentReason == "pod cannot serve this connection mode"


async def test_a_provisioning_failure_never_fails_the_selection(monkeypatch):
    """The gate swallows its own errors by design: choosing a runtime and standing up
    a pod are unrelated concerns and only one of them is what the person asked about."""
    monkeypatch.setattr(runtime_route, "_probe_managed_gemini", _ready())
    monkeypatch.setattr(
        runtime_route, "on_ai_connection_verified", _Gate({"scheduled": False, "reason": "error"})
    )

    result = await runtime_route.select_managed_gemini(request=None, firebase_uid="u1")
    assert result.status == "ready"


# -- it is actually mounted --------------------------------------------------------


def test_the_route_is_reachable():
    """The whole point is that a client can call it. The previous version of this
    surface was mounted too -- and had no callers, which is why the gap survived."""
    from api.routes.one import router as one_router

    paths = {getattr(r, "path", "") for r in one_router.routes}
    assert "/api/one/runtime/managed/select" in paths


def test_the_webapp_actually_calls_it():
    """The lesson of `/managed/readiness`: a mounted route with no caller is not a
    feature. This asserts the client half exists, so the pair cannot half-land."""
    from pathlib import Path

    webapp = Path(__file__).resolve().parents[2] / "hushh-webapp"
    api_service = (webapp / "lib" / "services" / "api-service.ts").read_text(encoding="utf-8")
    card = (webapp / "components" / "connections" / "gemini-runtime-settings-card.tsx").read_text(
        encoding="utf-8"
    )

    assert "/api/one/runtime/managed/select" in api_service
    assert "selectManagedGeminiRuntime" in card


async def test_a_proven_byoc_cloud_schedules_without_touching_the_fleet_probe(monkeypatch):
    """A user-owned cloud's pod generates on the USER's Vertex ADC, so the fleet
    probe answers nothing about their runtime -- and coupling their journey to it
    couples them to hushh's billing state (observed 2026-08-20: fleet Vertex in
    dunning denied every BYOC onboarding while every BYOC pod was unaffected).
    Their validate-then-provision evidence is the PROVEN authorization: hushh
    minted a real token against their bootstrap account, and the first pod turn
    asserts runtimeMode=user_adc."""
    from hushh_mcp.services.user_cloud_service import UserCloud

    gate = _Gate()
    # The fleet probe is DEAD (billing dunning). It must never be consulted.
    monkeypatch.setattr(runtime_route, "_probe_managed_gemini", _not_ready())
    monkeypatch.setattr(runtime_route, "on_ai_connection_verified", gate)

    async def _byoc_cloud(_uid):
        return UserCloud(
            deployment_target="user_gcp",
            model_credential_mode="user_adc",
            project="hussh-one-kt3d9x",
            region="us-central1",
            bootstrap_sa="one-bootstrap@hussh-one-kt3d9x.iam.gserviceaccount.com",
            authorized=True,
        )

    monkeypatch.setattr(runtime_route, "resolve_user_cloud", _byoc_cloud)
    _patch_liveness(monkeypatch, "live")

    result = await runtime_route.select_managed_gemini(request=None, firebase_uid="u1")

    assert result.status == "ready"
    assert result.agentScheduled is True
    assert result.location == "us-central1"
    assert gate.calls[0]["provider"] == "hushh_managed_vertex"


async def test_an_unauthorized_byoc_cloud_still_faces_the_fleet_probe(monkeypatch):
    """Named-but-unauthorized is NOT proven. Until the grant is real, the person is
    on the managed path and the fleet probe keeps its authority."""
    from hushh_mcp.services.user_cloud_service import UserCloud

    gate = _Gate()
    monkeypatch.setattr(runtime_route, "_probe_managed_gemini", _not_ready())
    monkeypatch.setattr(runtime_route, "on_ai_connection_verified", gate)

    async def _named_only(_uid):
        return UserCloud(
            deployment_target="user_gcp",
            model_credential_mode="user_adc",
            project="hussh-one-kt3d9x",
            region="us-central1",
            bootstrap_sa="one-bootstrap@hussh-one-kt3d9x.iam.gserviceaccount.com",
            authorized=False,
        )

    monkeypatch.setattr(runtime_route, "resolve_user_cloud", _named_only)

    with pytest.raises(HTTPException) as exc:
        await runtime_route.select_managed_gemini(request=None, firebase_uid="u1")

    assert exc.value.status_code == 503
    assert gate.calls == []


# -- schedule-time project-liveness re-proof (Step 6) -----------------------------
# Authorization is sticky, so a proven BYOC cloud must be RE-checked at schedule time:
# a project the user deleted after authorizing must be caught here, not scheduled into.


def _byoc(authorized=True):
    from hushh_mcp.services.user_cloud_service import UserCloud

    async def _cloud(_uid):
        return UserCloud(
            deployment_target="user_gcp",
            model_credential_mode="user_adc",
            project="hussh-one-kt3d9x",
            region="us-central1",
            bootstrap_sa="one-bootstrap@hussh-one-kt3d9x.iam.gserviceaccount.com",
            authorized=authorized,
        )

    return _cloud


def _patch_liveness(monkeypatch, state):
    from hushh_mcp.services.user_gcp_bootstrap import LivenessVerdict

    status = {"live": 200, "gone": 404, "forbidden": 403, "unknown": 0}[state]

    def _probe(**_kwargs):
        return LivenessVerdict(state, status)

    monkeypatch.setattr("hushh_mcp.services.user_gcp_bootstrap.probe_project_liveness", _probe)


class _Registry:
    def __init__(self):
        self.reinit_calls: list[str] = []

    async def mark_needs_reinit(self, user_id):
        self.reinit_calls.append(user_id)
        return True


async def test_a_gone_project_refuses_and_marks_needs_reinit(monkeypatch):
    gate = _Gate()
    monkeypatch.setattr(runtime_route, "on_ai_connection_verified", gate)
    monkeypatch.setattr(runtime_route, "resolve_user_cloud", _byoc())
    _patch_liveness(monkeypatch, "gone")
    reg = _Registry()
    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_registry_repo.PersonalAgentRegistryRepo",
        lambda: reg,
    )

    with pytest.raises(HTTPException) as exc:
        await runtime_route.select_managed_gemini(request=None, firebase_uid="u1")

    assert exc.value.status_code == 409
    assert exc.value.detail["code"] == "CLOUD_PROJECT_GONE"
    assert reg.reinit_calls == ["u1"]  # only a conclusive gone unsticks the auth
    assert gate.calls == []  # never scheduled into a dead project


async def test_a_revoked_grant_refuses_but_does_not_unstick(monkeypatch):
    gate = _Gate()
    monkeypatch.setattr(runtime_route, "on_ai_connection_verified", gate)
    monkeypatch.setattr(runtime_route, "resolve_user_cloud", _byoc())
    _patch_liveness(monkeypatch, "forbidden")
    reg = _Registry()
    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_registry_repo.PersonalAgentRegistryRepo",
        lambda: reg,
    )

    with pytest.raises(HTTPException) as exc:
        await runtime_route.select_managed_gemini(request=None, firebase_uid="u1")

    assert exc.value.status_code == 409
    assert exc.value.detail["code"] == "CLOUD_GRANT_REVOKED"
    assert reg.reinit_calls == []  # a revoked grant must NOT strand a running pod
    assert gate.calls == []


async def test_an_unknown_liveness_proceeds_never_strands(monkeypatch):
    # A transient blip is not gone: the schedule proceeds, and a genuine gone is caught
    # later by provision/pod_wake. Blocking here would re-couple to hushh-side outages.
    gate = _Gate()
    monkeypatch.setattr(runtime_route, "on_ai_connection_verified", gate)
    monkeypatch.setattr(runtime_route, "resolve_user_cloud", _byoc())
    _patch_liveness(monkeypatch, "unknown")

    result = await runtime_route.select_managed_gemini(request=None, firebase_uid="u1")

    assert result.status == "ready"
    assert gate.calls[0]["provider"] == "hushh_managed_vertex"
