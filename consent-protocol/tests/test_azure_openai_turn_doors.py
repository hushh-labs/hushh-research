"""Every door that runs a model on an Azure pod gets the owner's deployment, or refuses.

Four doors share the pod's mode resolver: the turn, agent-chat (AG-UI), the
close-time memory review and private commands. Deciding the mode in one place and
the model in another let ``user_azure_mi`` reach a door still holding the manifest's
Gemini model. Commands then fell into Hussh-managed builders, and agent-chat and
close refused every build. So each door takes (provider, model, mode) together from
``pod_turn._resolve_turn_target``. These tests drive each door with BOTH topology
values rendered and make every managed or key builder raise.
"""

from __future__ import annotations

# ruff: noqa: S106 -- `consent_token="t"` names a test fixture, not a credential.
import re
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException

from api.routes.one import pod_turn
from api.routes.one.pod_turn import PodTurnRequest
from api.routes.one.pod_turn_target import turn_target
from hushh_mcp.runtime_providers import factory
from hushh_mcp.runtime_providers.adk_model import ProviderAdkModel

ENDPOINT = "https://hussh-agent-test.openai.azure.com/"
DEPLOYMENT = "gpt-5-mini"
AZURE = ("azure_openai", DEPLOYMENT, "user_azure_mi")
_SOURCE_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def _no_ambient_model_topology(monkeypatch):
    for name in (
        "AZURE_OPENAI_ENDPOINT",
        "AZURE_OPENAI_DEPLOYMENT",
        "HUSSH_POD_USER_ADC_ENABLED",
        "HUSSH_POD_MANAGED_MODEL_ENABLED",
    ):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def azure_pod(monkeypatch):
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", ENDPOINT)
    monkeypatch.setenv("AZURE_OPENAI_DEPLOYMENT", DEPLOYMENT)
    # A fleet flag must not capture an Azure pod either.
    monkeypatch.setenv("HUSSH_POD_MANAGED_MODEL_ENABLED", "true")


def _never(*_a: Any, **_k: Any) -> Any:
    raise AssertionError("a managed or key builder was reached on an Azure pod")


@pytest.fixture
def no_managed_or_key_builder(monkeypatch):
    from hushh_mcp.one_adk import text_runtime

    for name in ("build_gemini_byok_adk_model", "build_managed_gemini_adk_model"):
        monkeypatch.setattr(text_runtime, name, _never)
    for name in (
        "build_gemini_byok_adk_model",
        "build_managed_gemini_adk_model",
        "build_managed_runtime_client",
        "build_runtime_client",
    ):
        monkeypatch.setattr(factory, name, _never)


# -- the shared decision -----------------------------------------------------------


@pytest.mark.parametrize("mode", ["byok", "puppy_relay", "user_adc", "hushh_managed_vertex"])
def test_every_other_mode_keeps_the_target_it_was_given(azure_pod, mode) -> None:
    assert turn_target("gemini", "gemini-test", mode) == ("gemini", "gemini-test", mode)


def test_the_azure_mode_carries_the_deployment_as_the_model(azure_pod) -> None:
    assert turn_target("gemini", "gemini-test", "user_azure_mi") == AZURE


def test_the_azure_mode_without_a_topology_refuses_typed() -> None:
    with pytest.raises(HTTPException) as refused:
        turn_target("gemini", "gemini-test", "user_azure_mi")
    assert refused.value.status_code == 503
    assert refused.value.detail == {"code": "AZURE_MODEL_TOPOLOGY_INVALID"}


def test_no_door_outside_the_turn_module_resolves_the_mode_alone() -> None:
    """The drift guard: a door that calls the mode resolver directly can pair the mode
    with a model it did not come with. Only ``_resolve_turn_target`` may call it."""
    callers = []
    for path in [
        *(_SOURCE_ROOT / "api").rglob("*.py"),
        *(_SOURCE_ROOT / "hushh_mcp").rglob("*.py"),
    ]:
        if path.name == "pod_turn.py":
            continue
        if re.search(r"_resolve_runtime_mode\s*\(", path.read_text(encoding="utf-8")):
            callers.append(str(path.relative_to(_SOURCE_ROOT)))
    assert callers == []


# -- agent-chat (AG-UI) ------------------------------------------------------------


def _chat_context() -> Any:
    from hushh_mcp.one_adk.pod_agui_context import PodChatContext

    context = object.__new__(PodChatContext)
    context.owner = "owner-uid"
    context.hushh_id = "pod-synthetic"
    context.claims = {"user_id": "owner-uid", "hushh_id": "pod-synthetic"}
    context.authority = SimpleNamespace(
        local_token=lambda _claims: "local-token", local_verifier=lambda _claims: None
    )
    context.sessions = object()

    async def _require_access() -> None:
        return None

    context.require_access = _require_access
    return context


def _record_agent_chat_build(monkeypatch) -> dict[str, Any]:
    from hushh_mcp.one_adk import agent_tree, agui_factory, text_runtime
    from hushh_mcp.services import pod_specialist_runtime

    seen: dict[str, Any] = {}

    def _runtime(**kwargs: Any) -> Any:
        seen["specialists"] = kwargs
        return object()

    def _head(*, model: Any, **_k: Any) -> Any:
        seen["head"] = model
        return object()

    monkeypatch.setattr(pod_specialist_runtime, "build_pod_specialist_runtime", _runtime)
    monkeypatch.setattr(agent_tree, "build_one_text_agent", _head)
    monkeypatch.setattr(
        agui_factory,
        "build_authenticated_agui",
        lambda *_a, **_k: SimpleNamespace(configure_pod_turn=lambda **_kw: None),
    )
    monkeypatch.setattr(text_runtime, "_resolve_pod_memory_service", lambda: None)
    monkeypatch.setattr(pod_turn, "_resolve_model", lambda *_a, **_k: ("gemini", "gemini-test"))
    return seen


async def test_agent_chat_builds_one_and_its_specialists_on_the_deployment(
    azure_pod, no_managed_or_key_builder, monkeypatch
) -> None:
    seen = _record_agent_chat_build(monkeypatch)

    await _chat_context().build_agent(PodTurnRequest(message="hello", conversation_id="c1"))

    specialists = seen["specialists"]
    assert (specialists["provider"], specialists["model"], specialists["runtime_mode"]) == AZURE
    head = seen["head"]
    assert isinstance(head, ProviderAdkModel)
    assert (head.provider, head.model, head.runtime_mode, head.credential) == (*AZURE, "")


async def test_agent_chat_on_a_gcp_pod_keeps_managed_gemini_negative_control(
    monkeypatch,
) -> None:
    from hushh_mcp.one_adk import text_runtime

    monkeypatch.setenv("HUSSH_POD_MANAGED_MODEL_ENABLED", "true")
    seen = _record_agent_chat_build(monkeypatch)
    built: list[str] = []
    monkeypatch.setattr(
        text_runtime,
        "build_managed_gemini_adk_model",
        lambda model, **_k: built.append(model) or "managed-gemini",
    )

    await _chat_context().build_agent(PodTurnRequest(message="hello", conversation_id="c1"))

    specialists = seen["specialists"]
    assert (specialists["provider"], specialists["model"], specialists["runtime_mode"]) == (
        "gemini",
        "gemini-test",
        "hushh_managed_vertex",
    )
    assert seen["head"] == "managed-gemini" and built == ["gemini-test"]


# -- the close-time memory review ----------------------------------------------------


@pytest.fixture
def close_enabled(monkeypatch):
    from hushh_mcp.services.pod_config import PodConfig, set_active_pod_config

    monkeypatch.setattr(pod_turn, "pod_mode", lambda: True)
    monkeypatch.setattr(pod_turn, "pod_turn_enabled", lambda: True)
    monkeypatch.setattr(pod_turn, "_resolve_model", lambda *_a, **_k: ("gemini", "gemini-test"))

    async def _validate(_token, *, verifier=None):
        return {"user_id": "u1", "scope": "pkm.read"}

    monkeypatch.setattr(pod_turn, "_validate_consent", _validate)
    set_active_pod_config(PodConfig())
    yield
    set_active_pod_config(None)


async def test_the_close_review_runs_on_the_deployment(
    azure_pod, no_managed_or_key_builder, close_enabled
) -> None:
    from api.routes.one.pod_memory import PodConversationCloseRequest, run_conversation_close
    from hushh_mcp.one_adk.memory_review import MemoryReviewResult

    seen: dict[str, Any] = {}

    async def _review(**kwargs: Any) -> MemoryReviewResult:
        seen.update(kwargs)
        return MemoryReviewResult(
            outcome="applied",
            reason="close",
            through_seq=1,
            records=0,
            ops={"remember": 0, "supersede": 0, "forget": 0, "pkm_proposals": 0, "refused": 0},
            provider=kwargs["runtime_provider"],
            model=kwargs["runtime_model"],
            elapsed_ms=1,
            checkpoint_seq=1,
        )

    result = await run_conversation_close(
        conversation_id="conv-1",
        payload=PodConversationCloseRequest(),
        consent_token="t",
        review_fn=_review,
        memory_service=object(),
    )

    assert result["memory"]["review"]["outcome"] == "applied"
    assert (seen["runtime_provider"], seen["runtime_model"]) == AZURE[:2]
    model = seen["model"]
    assert isinstance(model, ProviderAdkModel)
    assert (model.provider, model.model, model.runtime_mode) == AZURE


# -- private commands ---------------------------------------------------------------


async def test_commands_refuse_on_the_azure_mode_before_any_builder(
    azure_pod, no_managed_or_key_builder
) -> None:
    """Commands need structured output and audio input, which the owner's Azure
    transport does not carry. The person's audio and location reach no identity."""
    from api.routes.one import pod_commands

    with pytest.raises(HTTPException) as refused:
        await pod_commands._brain(
            pod_commands.CommandModel(), "owner-uid", "location.assess", {"hushh_id": "p"}
        )
    assert refused.value.status_code == 503
    assert refused.value.detail == {
        "code": "COMMAND_MODEL_UNAVAILABLE",
        "runtimeMode": "user_azure_mi",
    }


def _record_command_builders(monkeypatch) -> list[tuple[str, Any]]:
    from api.routes.one import pod_commands

    calls: list[tuple[str, Any]] = []
    for name in (
        "build_gemini_byok_adk_model",
        "build_managed_gemini_adk_model",
        "build_managed_runtime_client",
        "build_runtime_client",
    ):
        monkeypatch.setattr(
            factory, name, lambda *a, _name=name, **_k: calls.append((_name, a[0])) or _name
        )
    monkeypatch.setattr(pod_commands, "LocationCommandBrain", lambda **kw: kw)
    return calls


async def test_an_owner_key_still_wins_for_commands_on_an_azure_pod(azure_pod, monkeypatch) -> None:
    from api.routes.one import pod_commands

    calls = _record_command_builders(monkeypatch)
    model = pod_commands.CommandModel(runtimeCredential="AIza-own-key")

    brain = await pod_commands._brain(model, "owner-uid", "location.assess", {"hushh_id": "p"})

    assert brain["client"] == "build_runtime_client"
    assert {name for name, _ in calls} == {"build_runtime_client", "build_gemini_byok_adk_model"}
    assert ("build_runtime_client", "gemini") in calls


async def test_commands_on_a_gcp_pod_keep_the_managed_builders_negative_control(
    monkeypatch,
) -> None:
    from api.routes.one import pod_commands

    monkeypatch.setenv("HUSSH_POD_MANAGED_MODEL_ENABLED", "true")
    calls = _record_command_builders(monkeypatch)

    brain = await pod_commands._brain(
        pod_commands.CommandModel(), "owner-uid", "location.assess", {"hushh_id": "p"}
    )

    assert brain["client"] == "build_managed_runtime_client"
    assert ("build_managed_runtime_client", "gemini") in calls
    assert {name for name, _ in calls} == {
        "build_managed_runtime_client",
        "build_managed_gemini_adk_model",
    }
