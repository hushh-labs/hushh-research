"""Mode ``user_azure_mi``: the person's own Azure OpenAI, never a fallthrough.

Three properties decide whose identity and whose bill a turn lands on, and each is
asserted against the real function rather than the string it returns:

* the pod selects the mode only when BOTH rendered topology values are present and
  no key came with the turn, and a half-rendered topology refuses instead of
  reaching down the list toward Hussh's managed Gemini;
* ``azure_openai`` and ``user_azure_mi`` are a pair at every builder (One's head, the
  specialists' model call, the client door), so neither can be borrowed alone;
* an owner who sends a key still gets their key.
"""

from __future__ import annotations

# ruff: noqa: S106 -- `consent_token="t"` names a test fixture, not a credential.
import sys
from types import ModuleType, SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException

from api.routes.one import pod_turn
from api.routes.one.pod_turn import PodTurnRequest
from hushh_mcp.runtime_providers import azure_openai, factory
from hushh_mcp.runtime_providers.adk_model import ProviderAdkModel
from hushh_mcp.runtime_providers.azure_openai import (
    AzureOpenAICredentialUnavailable,
    AzureOpenAIModeMismatch,
    AzureOpenAITopologyInvalid,
)

ENDPOINT = "https://hussh-agent-test.openai.azure.com/"
DEPLOYMENT = "gpt-5-mini"


@pytest.fixture
def azure_pod(monkeypatch):
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", ENDPOINT)
    monkeypatch.setenv("AZURE_OPENAI_DEPLOYMENT", DEPLOYMENT)


@pytest.fixture(autouse=True)
def _no_ambient_model_topology(monkeypatch):
    for name in (
        "AZURE_OPENAI_ENDPOINT",
        "AZURE_OPENAI_DEPLOYMENT",
        "HUSSH_POD_USER_ADC_ENABLED",
        "HUSSH_POD_MANAGED_MODEL_ENABLED",
    ):
        monkeypatch.delenv(name, raising=False)


# -- the rendered topology -------------------------------------------------------


def test_absent_topology_is_none_and_a_complete_one_names_the_v1_root(monkeypatch) -> None:
    assert azure_openai.azure_openai_topology() is None
    topology = azure_openai.azure_openai_topology(
        {
            "AZURE_OPENAI_ENDPOINT": "https://Hussh-Agent.openai.azure.com",
            "AZURE_OPENAI_DEPLOYMENT": "gpt-5-mini",
        }
    )
    assert topology is not None
    assert topology.endpoint == "https://hussh-agent.openai.azure.com/"
    assert topology.base_url == "https://hussh-agent.openai.azure.com/openai/v1/"
    assert topology.deployment == "gpt-5-mini"


@pytest.mark.parametrize(
    "env",
    [
        {"AZURE_OPENAI_ENDPOINT": ENDPOINT},
        {"AZURE_OPENAI_DEPLOYMENT": DEPLOYMENT},
    ],
)
def test_a_half_rendered_topology_refuses(env) -> None:
    with pytest.raises(AzureOpenAITopologyInvalid, match="incomplete"):
        azure_openai.azure_openai_topology(env)


@pytest.mark.parametrize(
    "endpoint",
    [
        "http://hussh-agent.openai.azure.com/",
        "https://evil.example.com/",
        "https://hussh-agent.openai.azure.com.evil.example.com/",
        "https://hussh-agent.openai.azure.com:8443/",
        "https://someone@hussh-agent.openai.azure.com/",
        "https://hussh-agent.openai.azure.com/openai/v1/",
        "https://hussh-agent.openai.azure.com/?next=x",
        "https://-hussh.openai.azure.com/",
        "https://hussh-agent.openai.azure.com:bad/",
    ],
)
def test_the_pods_token_never_travels_to_a_host_that_is_not_an_openai_resource(endpoint) -> None:
    with pytest.raises(AzureOpenAITopologyInvalid):
        azure_openai.azure_openai_topology(
            {"AZURE_OPENAI_ENDPOINT": endpoint, "AZURE_OPENAI_DEPLOYMENT": DEPLOYMENT}
        )


@pytest.mark.parametrize("deployment", ["../x", "a b", "x" * 65, "-lead"])
def test_a_malformed_deployment_name_refuses(deployment) -> None:
    with pytest.raises(AzureOpenAITopologyInvalid):
        azure_openai.azure_openai_topology(
            {"AZURE_OPENAI_ENDPOINT": ENDPOINT, "AZURE_OPENAI_DEPLOYMENT": deployment}
        )


# -- the workload token ---------------------------------------------------------


def test_the_token_comes_from_the_pods_own_identity_for_the_openai_audience(monkeypatch) -> None:
    seen: list[str] = []
    module = ModuleType("hushh_mcp.services.pod_workload_identity")

    def get_workload_token(resource: str) -> str:
        seen.append(resource)
        return "workload-token"

    module.get_workload_token = get_workload_token  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "hushh_mcp.services.pod_workload_identity", module)

    assert azure_openai.workload_token_provider()() == "workload-token"
    assert seen == ["https://cognitiveservices.azure.com"]


@pytest.mark.parametrize("minted", ["", None, b"bytes-token"])
def test_a_workload_identity_that_mints_no_string_token_refuses_typed(monkeypatch, minted) -> None:
    module = ModuleType("hushh_mcp.services.pod_workload_identity")
    module.get_workload_token = lambda _resource: minted  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "hushh_mcp.services.pod_workload_identity", module)
    with pytest.raises(AzureOpenAICredentialUnavailable):
        azure_openai.workload_token_provider()()


def test_an_image_without_the_workload_identity_still_imports_and_refuses_typed(
    monkeypatch,
) -> None:
    monkeypatch.setitem(sys.modules, "hushh_mcp.services.pod_workload_identity", None)
    provider = azure_openai.workload_token_provider()  # constructing it costs nothing
    with pytest.raises(AzureOpenAICredentialUnavailable):
        provider()


# -- the client door: one door, one mode ---------------------------------------


def test_the_door_builds_azure_openai_for_user_azure_mi(azure_pod) -> None:
    transport = azure_openai.owner_azure_client("azure_openai", "user_azure_mi")
    assert transport.provider == "azure_openai"
    assert str(transport._client.base_url) == f"{ENDPOINT}openai/v1/"


@pytest.mark.parametrize("mode", ["byok", "user_adc", "hushh_managed_vertex", "puppy_relay", ""])
def test_the_door_refuses_azure_openai_in_every_other_mode(azure_pod, mode) -> None:
    with pytest.raises(AzureOpenAIModeMismatch):
        azure_openai.owner_azure_client("azure_openai", mode)


def test_the_door_refuses_the_mode_for_another_provider_and_with_a_key(azure_pod) -> None:
    with pytest.raises(AzureOpenAIModeMismatch):
        azure_openai.owner_azure_client("gemini", "user_azure_mi")
    with pytest.raises(AzureOpenAIModeMismatch, match="API key"):
        azure_openai.owner_azure_client("azure_openai", "user_azure_mi", "sk-not-here")


@pytest.mark.parametrize(
    ("provider", "mode"),
    [("gemini", "byok"), ("gemini", "hushh_managed_vertex"), ("user_azure_mi", "azure_openai")],
)
def test_the_door_serves_only_the_exact_pair_never_two_other_values(
    azure_pod, provider, mode
) -> None:
    """Agreeing that neither value is Azure is not admission: a caller that reaches an
    Azure door with any other pair, or the pair swapped, is refused, never served."""
    with pytest.raises(AzureOpenAIModeMismatch):
        azure_openai.owner_azure_client(provider, mode)
    with pytest.raises(AzureOpenAIModeMismatch):
        azure_openai.build_owner_azure_adk_model(
            DEPLOYMENT, mode=mode, provider=provider, api_key=None
        )


def test_the_door_refuses_without_rendered_topology() -> None:
    with pytest.raises(AzureOpenAITopologyInvalid):
        azure_openai.owner_azure_client("azure_openai", "user_azure_mi")


def test_the_byok_and_managed_builders_never_reach_azure_openai(azure_pod) -> None:
    with pytest.raises(ValueError, match="Unsupported runtime provider"):
        factory.build_runtime_client("azure_openai", "a-key")
    with pytest.raises(ValueError, match="Unsupported runtime provider"):
        factory.build_managed_runtime_client("azure_openai", "a-key")


# -- One's head: a named branch, checked before the Gemini default ----------------


def _head(**over: Any) -> Any:
    from hushh_mcp.one_adk.text_runtime import _runtime_model

    args: dict[str, Any] = dict(
        runtime_model=DEPLOYMENT,
        runtime_mode="user_azure_mi",
        runtime_credential=None,
        runtime_provider="azure_openai",
    )
    args.update(over)
    return _runtime_model(**args)


def test_the_head_builds_the_owners_deployment_as_its_own_identity() -> None:
    model = _head()
    assert isinstance(model, ProviderAdkModel)
    assert (model.provider, model.runtime_mode, model.model, model.credential) == (
        "azure_openai",
        "user_azure_mi",
        DEPLOYMENT,
        "",
    )


@pytest.mark.parametrize(
    "over",
    [
        {"runtime_credential": "sk-not-here"},
        {"runtime_provider": "gemini"},
        {"runtime_mode": "byok", "runtime_credential": "AIza-key"},
        {"runtime_mode": "hushh_managed_vertex"},
        {"runtime_mode": "user_adc"},
        {"runtime_model": ""},
        {"runtime_model": "../x"},
    ],
)
def test_the_head_refuses_anything_but_the_exact_pair(over) -> None:
    """A missing deployment must not become a Gemini id, and the provider must never
    ride a Gemini or managed branch."""
    with pytest.raises(AzureOpenAIModeMismatch):
        _head(**over)


def test_an_alias_shaped_deployment_is_sent_as_named_never_rewritten_to_gemini() -> None:
    """``default`` is a legal deployment name. The Gemini alias rewrite sits below the
    Azure branch, so it cannot turn the person's deployment into a Gemini model id."""
    assert _head(runtime_model="default").model == "default"


# -- the pod turn: selection, refusal, inheritance ------------------------------


def _req(**kw: Any) -> PodTurnRequest:
    return PodTurnRequest(message="hello", conversation_id="c1", **kw)


def test_both_topology_values_select_the_owners_azure_model(azure_pod) -> None:
    assert pod_turn._resolve_runtime_mode(_req()) == "user_azure_mi"


def test_an_owner_who_sends_a_key_still_gets_their_key_on_an_azure_pod(azure_pod) -> None:
    assert pod_turn._resolve_runtime_mode(_req(runtime_credential="AIza-own-key")) == "byok"


def test_hussh_managed_never_captures_an_azure_pod(azure_pod, monkeypatch) -> None:
    monkeypatch.setenv("HUSSH_POD_MANAGED_MODEL_ENABLED", "true")
    monkeypatch.setenv("HUSSH_POD_USER_ADC_ENABLED", "true")
    assert pod_turn._resolve_runtime_mode(_req()) == "user_azure_mi"


@pytest.mark.parametrize("present", ["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_DEPLOYMENT"])
def test_one_topology_value_refuses_and_never_falls_back_to_managed_gemini(
    monkeypatch, present
) -> None:
    monkeypatch.setenv(present, ENDPOINT if present.endswith("ENDPOINT") else DEPLOYMENT)
    monkeypatch.setenv("HUSSH_POD_MANAGED_MODEL_ENABLED", "true")
    with pytest.raises(HTTPException) as refused:
        pod_turn._resolve_runtime_mode(_req())
    assert refused.value.status_code == 503
    assert refused.value.detail == {"code": "AZURE_MODEL_TOPOLOGY_INVALID"}


def test_a_pod_without_azure_topology_keeps_todays_order_negative_control(monkeypatch) -> None:
    monkeypatch.setenv("HUSSH_POD_MANAGED_MODEL_ENABLED", "true")
    assert pod_turn._resolve_runtime_mode(_req()) == "hushh_managed_vertex"
    monkeypatch.delenv("HUSSH_POD_MANAGED_MODEL_ENABLED")
    with pytest.raises(HTTPException) as refused:
        pod_turn._resolve_runtime_mode(_req())
    assert refused.value.status_code == 400


@pytest.fixture
def pod_turn_enabled(monkeypatch):
    monkeypatch.setattr(pod_turn, "pod_mode", lambda: True)
    monkeypatch.setattr(pod_turn, "pod_turn_enabled", lambda: True)
    monkeypatch.setattr(pod_turn, "_resolve_model", lambda: ("gemini", "gemini-test"))

    async def _validate(_token, *, verifier=None):
        return {"user_id": "u1", "scope": "pkm.read"}

    monkeypatch.setattr(pod_turn, "_validate_consent", _validate)


def _recording_runner(seen: dict[str, Any]):
    async def _run(**kwargs: Any):
        seen.update(kwargs)
        yield SimpleNamespace(kind="token", text="ok", model_version="")

    return _run


def _record_specialist_runtime(monkeypatch) -> dict[str, Any]:
    from hushh_mcp.services import pod_specialist_runtime

    captured: dict[str, Any] = {}
    real = pod_specialist_runtime.build_pod_specialist_runtime

    def _capture(**kwargs: Any) -> Any:
        captured.update(kwargs)
        return real(**kwargs)

    monkeypatch.setattr(pod_specialist_runtime, "build_pod_specialist_runtime", _capture)
    return captured


async def test_one_and_its_specialists_run_on_the_deployment(
    azure_pod, pod_turn_enabled, monkeypatch
) -> None:
    seen: dict[str, Any] = {}
    specialists = _record_specialist_runtime(monkeypatch)

    result = await pod_turn.run_pod_turn(
        payload=_req(), consent_token="t", stream_fn=_recording_runner(seen)
    )

    assert (seen["runtime_provider"], seen["runtime_model"], seen["runtime_mode"]) == (
        "azure_openai",
        DEPLOYMENT,
        "user_azure_mi",
    )
    assert not seen["runtime_credential"]
    assert (specialists["provider"], specialists["model"], specialists["runtime_mode"]) == (
        "azure_openai",
        DEPLOYMENT,
        "user_azure_mi",
    )
    assert (result["provider"], result["runtimeMode"], result["model"]) == (
        "azure_openai",
        "user_azure_mi",
        DEPLOYMENT,
    )


async def test_byok_gemini_keeps_working_on_an_azure_pod(azure_pod, pod_turn_enabled) -> None:
    seen: dict[str, Any] = {}
    result = await pod_turn.run_pod_turn(
        payload=_req(runtime_credential="AIza-own-key"),
        consent_token="t",
        stream_fn=_recording_runner(seen),
    )
    assert (seen["runtime_provider"], seen["runtime_mode"]) == ("gemini", "byok")
    assert result["runtimeMode"] == "byok"


async def test_a_half_rendered_pod_refuses_before_any_model_work(
    pod_turn_enabled, monkeypatch
) -> None:
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", ENDPOINT)
    monkeypatch.setenv("HUSSH_POD_MANAGED_MODEL_ENABLED", "true")
    seen: dict[str, Any] = {}
    with pytest.raises(HTTPException) as refused:
        await pod_turn.run_pod_turn(
            payload=_req(), consent_token="t", stream_fn=_recording_runner(seen)
        )
    assert refused.value.status_code == 503
    assert seen == {}, "the runner never started"


# -- the specialists' own model call ------------------------------------------


async def test_a_specialist_model_call_uses_the_owners_azure_client(monkeypatch) -> None:
    from hushh_mcp.services import pod_consent_client, pod_memory_service
    from hushh_mcp.services.pod_consent_client import ConsentVerdict
    from hushh_mcp.services.pod_specialist_runtime import build_pod_specialist_runtime

    monkeypatch.setenv("HUSSH_ID", "pod-synthetic")

    async def ok(token, *, expected_scope):
        return ConsentVerdict(True, True, "owner-uid", "pod-synthetic", expected_scope)

    class _Log:
        _owner_id = "pod-synthetic"

        async def require_open(self) -> None:
            return None

    monkeypatch.setattr(pod_consent_client, "verify_consent", ok)
    monkeypatch.setattr(pod_memory_service, "_resolve_log", lambda: _Log())
    built: list[tuple[str, str, Any]] = []

    async def _generate(*, model, contents, config):
        return SimpleNamespace(text=f"answer from {model}", function_calls=[])

    def _azure_client(provider: str, mode: str, credential: Any = None) -> Any:
        built.append((provider, mode, credential))
        return SimpleNamespace(
            aio=SimpleNamespace(models=SimpleNamespace(generate_content=_generate))
        )

    def _never(*_a: Any, **_k: Any) -> Any:
        raise AssertionError("a key or managed builder was reached on an Azure turn")

    monkeypatch.setattr(azure_openai, "owner_azure_client", _azure_client)
    monkeypatch.setattr(factory, "build_runtime_client", _never)
    monkeypatch.setattr(factory, "build_managed_runtime_client", _never)
    runtime = build_pod_specialist_runtime(
        user_id="owner-uid",
        hushh_id="pod-synthetic",
        consent_token="owner-grant",
        provider="azure_openai",
        model=DEPLOYMENT,
        runtime_mode="user_azure_mi",
        credential=None,
        credential_transport="developer_api",
        vertex_project=None,
        vertex_location=None,
        data_door_grants={"location": "loc-scope"},
    )
    service = await runtime.service_for("agent_location")

    result = await service._model_call([], None)

    assert result.text == f"answer from {DEPLOYMENT}"
    assert built == [("azure_openai", "user_azure_mi", None)]
