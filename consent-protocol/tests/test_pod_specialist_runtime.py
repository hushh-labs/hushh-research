"""Pod-side specialist runtime contracts.

Phase 0 of the owner-pod direct runtime: the model-call budget. Lane B extends
this file with the port, access and honest-dependency cases.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hushh_mcp.one_adk import text_runtime  # noqa: E402
from hushh_mcp.services import pod_specialist_runtime  # noqa: E402


def test_puppy_specialist_call_budget_covers_the_measured_cold_first_token() -> None:
    """A cold local model measured 32.9s to first token; a 30s cap fails by construction."""
    puppy = pod_specialist_runtime.specialist_model_timeout_seconds("puppy_relay")
    assert puppy >= text_runtime._PUPPY_FIRST_EVENT_TIMEOUT_SECONDS
    assert puppy < text_runtime._TOTAL_TURN_TIMEOUT_SECONDS


def test_other_runtime_modes_keep_the_generic_specialist_budget() -> None:
    generic = pod_specialist_runtime._SPECIALIST_MODEL_TIMEOUT_SECONDS
    assert generic == 30.0
    for mode in ("byok", "user_adc", "hushh_managed_vertex", "", None):
        assert pod_specialist_runtime.specialist_model_timeout_seconds(mode) == generic


def test_the_model_call_reads_its_budget_from_the_helper() -> None:
    """A literal timeout would silently reintroduce the 30s wall for Puppy."""
    source = Path(pod_specialist_runtime.__file__).read_text(encoding="utf-8")
    assert "timeout=specialist_model_timeout_seconds(runtime_mode)" in source
    assert "timeout=30," not in source


# -- the second verifier (Lane A) ------------------------------------------------------
#
# `require_access` used to reach the hub unconditionally; the owner-local turn threads
# its session verifier here so a specialist re-checks the owner against the pod's own
# tombstones. Without the injection point every specialist on a local turn would ask
# a hub the turn never touched.


def _runtime(verifier=None):
    return pod_specialist_runtime.build_pod_specialist_runtime(
        user_id="uid-1",
        hushh_id="ha1_owner",
        consent_token="pod-session:sid",  # noqa: S106 - a session marker, not a credential
        provider="gemini",
        model="m",
        runtime_mode="byok",
        credential="k",
        credential_transport="developer_api",
        vertex_project=None,
        vertex_location=None,
        data_door_grants={},
        verifier=verifier,
    )


async def test_an_injected_verifier_answers_require_access_and_the_hub_is_never_asked(
    monkeypatch,
) -> None:
    from hushh_mcp.services import pod_consent_client
    from hushh_mcp.services.pod_consent_client import ConsentVerdict

    async def _never(*_a, **_k):
        raise AssertionError("the hub was asked with a local verifier injected")

    monkeypatch.setattr(pod_consent_client, "verify_consent", _never)
    monkeypatch.setenv("HUSSH_ID", "ha1_owner")
    calls = []

    async def _local(token, *, expected_scope="", **_k):
        calls.append((token, expected_scope))
        return ConsentVerdict(
            valid=True, available=True, user_id="uid-1", hushh_id="ha1_owner", scope=expected_scope
        )

    await _runtime(verifier=_local).require_access()
    assert calls == [("pod-session:sid", "pkm.read")]


async def test_a_verifier_that_revokes_refuses_and_a_missing_verifier_uses_the_hub(
    monkeypatch,
) -> None:
    from hushh_mcp.services import pod_consent_client
    from hushh_mcp.services.pod_consent_client import ConsentVerdict

    monkeypatch.setenv("HUSSH_ID", "ha1_owner")

    async def _revoked(_token, *, expected_scope="", **_k):
        return ConsentVerdict(valid=False, available=True, reason="subject revoked")

    with pytest.raises(PermissionError):
        await _runtime(verifier=_revoked).require_access()

    asked = []

    async def _hub(token, *, expected_scope="", **_k):
        asked.append(token)
        return ConsentVerdict(
            valid=True, available=True, user_id="uid-1", hushh_id="ha1_owner", scope=expected_scope
        )

    monkeypatch.setattr(pod_consent_client, "verify_consent", _hub)
    await _runtime().require_access()
    assert asked == ["pod-session:sid"]


# --------------------------------------------------------------------------- #
# Lane B4: the pod-side ports, access checks, adapter roster and dependency trace.
# Every refusal here is exercised against the real functions with only the hub
# authority and the provider transport replaced.
# --------------------------------------------------------------------------- #

from types import SimpleNamespace  # noqa: E402

from hushh_mcp.adk_bridge import dispatch as dispatch_mod  # noqa: E402
from hushh_mcp.services import pod_consent_client, pod_hub_client  # noqa: E402
from hushh_mcp.services.pod_consent_client import ConsentVerdict  # noqa: E402
from hushh_mcp.services.pod_specialist_runtime import (  # noqa: E402
    PodConsentCenterReadPort,
    PodEmailReadPort,
    PodLocationReadPort,
    PodMarketplaceReadPort,
    PodSpecialistCapabilityUnsupported,
    PodSpecialistInformationUnavailable,
    SpecialistDependencyTrace,
    build_pod_specialist_runtime,
    current_dependency_trace,
    trace_specialist_dependencies,
)

OWNER = "owner-uid"
POD = "pod-synthetic"


class _NeverConstructed:
    """A hub client that must not exist: constructing it is the failure."""

    def __init__(self, *args, **kwargs):
        raise AssertionError("PodHubClient constructed before the owner check")


class _HubDown:
    def __init__(self, *args, **kwargs):
        pass

    def read_specialist(self, name, scope_token, **options):
        raise pod_hub_client.PodHubUnavailable(f"hub unreachable: {name}")


class _HubReturns:
    def __init__(self, state):
        self._state = state
        self.calls = []

    def __call__(self, *args, **kwargs):
        return self

    def read_specialist(self, name, scope_token, **options):
        self.calls.append((name, scope_token, options))
        return self._state


@pytest.fixture
def pod_identity(monkeypatch):
    monkeypatch.setenv("HUSSH_ID", POD)


def _verdict(*, valid=True, available=True, hushh_id=POD, user_id=OWNER, scope="pkm.read"):
    return ConsentVerdict(valid, available, user_id, hushh_id, scope)


def _runtime(**over):
    args = dict(
        user_id=OWNER,
        hushh_id=POD,
        consent_token="owner-" + "grant",
        provider="gemini",
        model="synthetic-model",
        runtime_mode="byok",
        credential="owner-" + "key",
        credential_transport="developer_api",
        vertex_project=None,
        vertex_location=None,
        data_door_grants={"location": "loc-scope", "nav": "nav-scope", "email": "mail-scope"},
        puppy_device_id=None,
    )
    args.update(over)
    return build_pod_specialist_runtime(**args)


# -- each port refuses a foreign owner before any hub client exists ------------------


async def test_every_port_refuses_a_foreign_owner_before_constructing_the_hub_client(
    monkeypatch,
):
    monkeypatch.setattr(pod_hub_client, "PodHubClient", _NeverConstructed)
    with pytest.raises(PermissionError):
        PodLocationReadPort(OWNER, "scope").list_state(user_id="someone-else")
    with pytest.raises(PermissionError):
        await PodConsentCenterReadPort(OWNER, "scope").list_center(
            "someone-else", actor="investor", surface="active", top=3
        )
    with pytest.raises(PermissionError):
        await PodMarketplaceReadPort(OWNER, "scope").list_published_slices(user_id="someone-else")
    with pytest.raises(PermissionError):
        await PodEmailReadPort(OWNER, "scope").list_nudges(user_id="someone-else")


async def test_the_consent_center_port_refuses_a_non_investor_actor_and_unknown_surface(
    monkeypatch,
):
    monkeypatch.setattr(pod_hub_client, "PodHubClient", _NeverConstructed)
    port = PodConsentCenterReadPort(OWNER, "scope")
    with pytest.raises(PermissionError):
        await port.list_center(OWNER, actor="owner", surface="active", top=3)
    with pytest.raises(PermissionError):
        await port.list_center(OWNER, actor="investor", surface="all", top=3)


# -- an unreachable door is a typed error, never an empty state ---------------------


async def test_an_unreachable_door_raises_the_typed_error_never_an_empty_state(monkeypatch):
    monkeypatch.setattr(pod_hub_client, "PodHubClient", _HubDown)
    with trace_specialist_dependencies() as trace:
        with pytest.raises(PodSpecialistInformationUnavailable) as failed:
            PodLocationReadPort(OWNER, "scope").list_state(user_id=OWNER)
        assert failed.value.door == "location"
        with pytest.raises(PodSpecialistInformationUnavailable) as failed:
            await PodEmailReadPort(OWNER, "scope").list_nudges(user_id=OWNER)
        assert failed.value.door == "email"
        with pytest.raises(PodSpecialistInformationUnavailable) as failed:
            await PodMarketplaceReadPort(OWNER, "scope").list_published_slices(user_id=OWNER)
        assert failed.value.door == "marketplace"
        with pytest.raises(PodSpecialistInformationUnavailable) as failed:
            await PodConsentCenterReadPort(OWNER, "scope").list_center(
                OWNER, actor="investor", surface="active", top=3
            )
        assert failed.value.door == "nav"
    assert trace.hub_reads == 4
    assert trace.unavailable_doors == ["location", "email", "marketplace", "nav"]
    assert trace.information_source == "unavailable"
    assert trace.reason == "hub_information_unavailable"


async def test_a_door_that_answers_with_no_state_is_still_unavailable_negative_control(
    monkeypatch,
):
    """A hub that returns something that is not a projection must not be
    narrated as an empty projection ("you share with nobody")."""
    monkeypatch.setattr(pod_hub_client, "PodHubClient", _HubReturns(["not", "a", "dict"]))
    with pytest.raises(PodSpecialistInformationUnavailable):
        PodLocationReadPort(OWNER, "scope").list_state(user_id=OWNER)
    monkeypatch.setattr(pod_hub_client, "PodHubClient", _HubReturns({"active": "nope"}))
    with pytest.raises(PodSpecialistInformationUnavailable):
        await PodConsentCenterReadPort(OWNER, "scope").list_center(
            OWNER, actor="investor", surface="active", top=3
        )


async def test_a_served_read_is_counted_once_per_door_read(monkeypatch):
    hub = _HubReturns({"active": {"items": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]}})
    monkeypatch.setattr(pod_hub_client, "PodHubClient", hub)
    with trace_specialist_dependencies() as trace:
        page = await PodConsentCenterReadPort(OWNER, "nav-scope").list_center(
            OWNER, actor="investor", surface="active", top=50
        )
    assert len(page["items"]) == 10, "top is clamped to the broker's page bound"
    assert hub.calls == [("nav", "nav-scope", {})]
    assert trace.hub_reads == 1 and trace.doors_read == ["nav"]
    assert trace.unavailable_doors == [] and trace.information_source == "hub_door"
    assert current_dependency_trace() is None, "the trace is unbound after the scope"


# -- require_access: refusals before any construction -----------------------------


async def test_a_refused_scope_stops_service_for_before_any_construction(pod_identity, monkeypatch):
    async def denied(token, *, expected_scope):
        return _verdict(valid=False)

    monkeypatch.setattr(pod_consent_client, "verify_consent", denied)
    from hushh_mcp.services import pod_memory_service

    monkeypatch.setattr(
        pod_memory_service,
        "_resolve_log",
        lambda: pytest.fail("storage was resolved for a refused owner"),
    )
    runtime = _runtime()
    with pytest.raises(PermissionError):
        await runtime.service_for("agent_location")


async def test_an_unavailable_authority_is_a_runtime_error_not_a_denial(pod_identity, monkeypatch):
    async def unreachable(token, *, expected_scope):
        return _verdict(valid=False, available=False)

    monkeypatch.setattr(pod_consent_client, "verify_consent", unreachable)
    runtime = _runtime()
    with pytest.raises(RuntimeError) as failed:
        await runtime.require_access()
    assert not isinstance(failed.value, PermissionError)


async def test_a_token_bound_to_another_pod_is_refused(pod_identity, monkeypatch):
    async def foreign_pod(token, *, expected_scope):
        return _verdict(hushh_id="some-other-pod")

    monkeypatch.setattr(pod_consent_client, "verify_consent", foreign_pod)
    with pytest.raises(PermissionError):
        await _runtime().require_access()


async def test_the_runtime_refuses_a_hushh_id_that_differs_from_its_own(pod_identity, monkeypatch):
    """Even a verdict the consent client accepts is re-checked against the identity
    this runtime was built with; a mismatch is the pod being asked to be someone."""

    async def verdict_for_this_pod(token, *, expected_scope):
        return _verdict()

    monkeypatch.setattr(pod_consent_client, "verify_consent", verdict_for_this_pod)
    with pytest.raises(PermissionError, match="owner mismatch"):
        await _runtime(hushh_id="a-different-runtime-identity").require_access()


async def test_require_access_is_recorded_on_the_dependency_trace(pod_identity, monkeypatch):
    async def ok(token, *, expected_scope):
        return _verdict()

    monkeypatch.setattr(pod_consent_client, "verify_consent", ok)
    with trace_specialist_dependencies() as trace:
        await _runtime().require_access()
        await _runtime().require_access()
    assert trace.consent_verifies == 2


# -- service_for: the closed adapter roster ---------------------------------------


class _Log:
    _owner_id = POD

    async def require_open(self):
        return None


@pytest.fixture
def accepting_authority(pod_identity, monkeypatch):
    async def ok(token, *, expected_scope):
        return _verdict(scope=expected_scope)

    monkeypatch.setattr(pod_consent_client, "verify_consent", ok)
    from hushh_mcp.services import pod_memory_service

    monkeypatch.setattr(pod_memory_service, "_resolve_log", lambda: _Log())


@pytest.mark.parametrize("agent_id", ["agent_kyc", "agent_kai", "agent_gmail", "agent_wallet"])
async def test_service_for_refuses_specialists_with_no_owner_adapter(accepting_authority, agent_id):
    """Never a hub singleton in its place: a refused adapter is a RuntimeError the
    tool layer reports as runtime_unavailable, not a substituted shared service."""
    with pytest.raises(RuntimeError, match="adapter unavailable"):
        await _runtime().service_for(agent_id)


async def test_service_for_returns_the_shared_location_service_with_pod_ports(
    accepting_authority,
):
    from hushh_mcp.services.location_chat_service import LocationChatService

    service = await _runtime(
        data_door_grants={"location": "loc-scope", "cap.location.live.share": "share-scope"}
    ).service_for("agent_location")
    assert isinstance(service, LocationChatService)
    assert isinstance(service._location_service, PodLocationReadPort)
    assert service._scope_tokens == {
        "cap.location.live.view": "loc-scope",
        "cap.location.live.share": "share-scope",
    }


async def test_service_for_refuses_when_storage_belongs_to_another_owner(pod_identity, monkeypatch):
    async def ok(token, *, expected_scope):
        return _verdict()

    monkeypatch.setattr(pod_consent_client, "verify_consent", ok)
    from hushh_mcp.services import pod_memory_service

    class _ForeignLog(_Log):
        _owner_id = "someone-elses-pod"

    monkeypatch.setattr(pod_memory_service, "_resolve_log", lambda: _ForeignLog())
    with pytest.raises(PermissionError, match="storage owner mismatch"):
        await _runtime().service_for("agent_location")


# -- model_call: access is re-checked after generation ------------------------------


class _Client:
    def __init__(self, outcome):
        self._outcome = outcome
        self.aio = SimpleNamespace(models=SimpleNamespace(generate_content=self._generate))

    async def _generate(self, *, model, contents, config):
        if isinstance(self._outcome, Exception):
            raise self._outcome
        return self._outcome


def _bind_client(monkeypatch, client):
    from hushh_mcp.runtime_providers import factory

    monkeypatch.setattr(factory, "build_runtime_client", lambda *a, **kw: client)


async def test_model_call_rechecks_access_after_generation(pod_identity, monkeypatch):
    seen = []

    async def counting(token, *, expected_scope):
        seen.append(expected_scope)
        return _verdict(scope=expected_scope)

    monkeypatch.setattr(pod_consent_client, "verify_consent", counting)
    _bind_client(monkeypatch, _Client(SimpleNamespace(text="answer", function_calls=[])))
    runtime = _runtime()
    # The runtime exposes model_call only through service_for; reach it the way
    # the Location service does, via the closure the runtime built.
    service = await _runtime_location_service(runtime, monkeypatch)
    before = len(seen)
    result = await service._model_call([], None)
    assert result.text == "answer"
    assert len(seen) - before == 2, "one check before the model and one after"


async def _runtime_location_service(runtime, monkeypatch):
    from hushh_mcp.services import pod_memory_service

    monkeypatch.setattr(pod_memory_service, "_resolve_log", lambda: _Log())
    return await runtime.service_for("agent_location")


async def test_a_revocation_during_generation_refuses_the_answer(pod_identity, monkeypatch):
    calls = {"n": 0}

    async def revoked_after_first(token, *, expected_scope):
        calls["n"] += 1
        return _verdict(valid=calls["n"] <= 3, scope=expected_scope)

    monkeypatch.setattr(pod_consent_client, "verify_consent", revoked_after_first)
    _bind_client(monkeypatch, _Client(SimpleNamespace(text="answer", function_calls=[])))
    service = await _runtime_location_service(_runtime(), monkeypatch)
    # service_for consumed the first checks; the recheck after generation is the
    # one that sees the revocation, and the answer is withheld.
    with pytest.raises(PermissionError):
        await service._model_call([], None)


async def test_a_capability_refusal_from_the_transport_is_typed_and_traced(
    pod_identity, monkeypatch
):
    from hushh_mcp.runtime_providers.puppy_transport import PuppyCapabilityUnsupported

    async def ok(token, *, expected_scope):
        return _verdict(scope=expected_scope)

    monkeypatch.setattr(pod_consent_client, "verify_consent", ok)
    _bind_client(monkeypatch, _Client(PuppyCapabilityUnsupported("json_schema")))
    service = await _runtime_location_service(
        _runtime(provider="puppy", runtime_mode="puppy_relay", puppy_device_id="tdv_1"),
        monkeypatch,
    )
    with trace_specialist_dependencies() as trace:
        with pytest.raises(PodSpecialistCapabilityUnsupported) as refused:
            await service._model_call([], None)
    assert refused.value.capability == "json_schema"
    assert trace.unsupported_capability == "json_schema"
    assert trace.information_source == "unsupported"


async def test_any_other_provider_failure_is_a_generic_runtime_error(pod_identity, monkeypatch):
    async def ok(token, *, expected_scope):
        return _verdict(scope=expected_scope)

    monkeypatch.setattr(pod_consent_client, "verify_consent", ok)
    _bind_client(monkeypatch, _Client(ConnectionError("socket reset")))
    service = await _runtime_location_service(_runtime(), monkeypatch)
    with pytest.raises(RuntimeError, match="provider unavailable") as failed:
        await service._model_call([], None)
    assert not isinstance(failed.value, PodSpecialistCapabilityUnsupported)
    assert "socket reset" not in str(failed.value)


async def test_model_call_refuses_an_unrecognised_runtime_mode(pod_identity, monkeypatch):
    async def ok(token, *, expected_scope):
        return _verdict(scope=expected_scope)

    monkeypatch.setattr(pod_consent_client, "verify_consent", ok)
    service = await _runtime_location_service(
        _runtime(runtime_mode="hushh_managed_vertex", credential="a-key"), monkeypatch
    )
    with pytest.raises(RuntimeError, match="model authority unavailable"):
        await service._model_call([], None)


# -- dispatch binds and releases the runtime ------------------------------------------


def test_bind_specialist_runtime_is_released_on_exit_and_on_error():
    runtime = _runtime()
    assert dispatch_mod.specialist_runtime_bound() is False
    with dispatch_mod.bind_specialist_runtime(runtime):
        assert dispatch_mod.specialist_runtime_bound() is True
    assert dispatch_mod.specialist_runtime_bound() is False
    with pytest.raises(RuntimeError):
        with dispatch_mod.bind_specialist_runtime(runtime):
            raise RuntimeError("turn failed")
    assert dispatch_mod.specialist_runtime_bound() is False


def test_bind_specialist_runtime_refuses_an_empty_owner():
    with pytest.raises(ValueError):
        with dispatch_mod.bind_specialist_runtime(_runtime(user_id="   ")):
            pass


async def test_the_dependency_trace_survives_a_worker_thread():
    """Ports run under asyncio.to_thread; the copied context must reach the same
    trace object or every counted read would land on nothing."""
    import asyncio

    with trace_specialist_dependencies() as trace:
        await asyncio.to_thread(lambda: current_dependency_trace().record_hub_read("email"))
    assert trace.hub_reads == 1 and trace.doors_read == ["email"]
    assert current_dependency_trace() is None


def test_the_trace_payload_is_shape_never_content():
    trace = SpecialistDependencyTrace()
    trace.record_hub_read("location")
    trace.record_consent_verify()
    assert trace.payload() == {
        "execution": "pod",
        "information_source": "hub_door",
        "hub_reads": 1,
        "consent_verifies": 1,
        "doors": ["location"],
        "unavailable_doors": [],
        "reason": "",
    }
