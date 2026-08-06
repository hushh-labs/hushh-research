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
    """"We are building your private agent" and "you are on the shared runtime" are
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
    card = (
        webapp / "components" / "connections" / "gemini-runtime-settings-card.tsx"
    ).read_text(encoding="utf-8")

    assert "/api/one/runtime/managed/select" in api_service
    assert "selectManagedGeminiRuntime" in card
