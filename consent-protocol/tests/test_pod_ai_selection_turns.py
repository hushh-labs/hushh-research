"""Every turn runs on the owner's sealed AI selection, exactly, with no fallback (C4).

A stored selection is the person's configuration: it wins over a per-turn key, the
owner's Azure deployment and every fleet path, and its key travels with the target to
every door (the turn, agent chat, the close review, commands) and every builder (One's
head, the specialists). OpenAI is served through the owner door on api.openai.com,
never through the hub's Chat Completions factory. A provider that refuses the key
mid-turn is a typed refusal naming the provider. Each test's negative control is the
same request on a pod with no stored selection, which keeps today's behaviour.
"""

from __future__ import annotations

# ruff: noqa: S106 -- `consent_token="t"` names a test fixture, not a credential.
from types import SimpleNamespace
from typing import Any

import httpx
import openai
import pytest
from fastapi import HTTPException

from api.routes.one import pod_turn
from api.routes.one.pod_turn import PodTurnRequest
from hushh_mcp.runtime_providers import factory, owner_openai
from hushh_mcp.runtime_providers.adk_model import ProviderAdkModel
from hushh_mcp.services import pod_ai_selection
from hushh_mcp.services.pod_ai_selection import AiSelection

SECRET = "sk-owner-sealed-secret"
PER_TURN = "AIza-per-turn-key"


def _selection(provider: str = "openai", model: str | None = None) -> AiSelection:
    return AiSelection(
        provider=provider,
        model=model,
        api_key=SECRET,
        transport="developer_api" if provider == "gemini" else None,
        vertex_project=None,
        vertex_location=None,
        issued_at_ms=1,
        selection_id="sel-1",
        checked_at_ms=1,
    )


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    for name in (
        "AZURE_OPENAI_ENDPOINT",
        "AZURE_OPENAI_DEPLOYMENT",
        "HUSSH_POD_USER_ADC_ENABLED",
        "HUSSH_POD_MANAGED_MODEL_ENABLED",
    ):
        monkeypatch.delenv(name, raising=False)
    pod_ai_selection.set_active_ai_selection(None)
    pod_ai_selection.note_ai_selection_failure(None)
    yield
    pod_ai_selection.set_active_ai_selection(None)
    pod_ai_selection.note_ai_selection_failure(None)


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setattr(pod_turn, "pod_mode", lambda: True)
    monkeypatch.setattr(pod_turn, "pod_turn_enabled", lambda: True)
    monkeypatch.setattr(pod_turn, "_resolve_model", lambda *_a, **_k: ("gemini", "gemini-test"))

    async def _validate(_token, *, verifier=None):
        return {"user_id": "u1", "scope": "pkm.read"}

    monkeypatch.setattr(pod_turn, "_validate_consent", _validate)


def _recording_runner(seen: dict[str, Any], *, boom: Exception | None = None):
    async def _run(**kwargs):
        seen.update(kwargs)
        if boom is not None:
            raise boom
        yield SimpleNamespace(kind="token", text="hi")

    return _run


def _target(seen: dict[str, Any]) -> tuple:
    return (
        seen["runtime_provider"],
        seen["runtime_model"],
        seen["runtime_mode"],
        seen["runtime_credential"],
    )


async def _turn(seen: dict[str, Any], **kwargs: Any) -> dict:
    return await pod_turn.run_pod_turn(
        payload=PodTurnRequest(message="hello", pkmContext="ctx", runtimeCredential=PER_TURN),
        consent_token="t",
        stream_fn=_recording_runner(seen, **kwargs),
    )


# -- the turn ------------------------------------------------------------------------


async def test_the_stored_selection_wins_over_the_per_turn_key(enabled):
    pod_ai_selection.set_active_ai_selection(_selection("openai"))
    seen: dict[str, Any] = {}

    result = await _turn(seen)

    assert _target(seen) == ("openai", "gpt-5.6-luna", "byok", SECRET)
    assert (result["provider"], result["runtimeMode"]) == ("openai", "byok")
    assert SECRET not in str(result)


async def test_without_a_selection_the_turn_keeps_todays_per_turn_key(enabled):
    """Negative control for the test above."""
    seen: dict[str, Any] = {}
    await _turn(seen)
    assert _target(seen) == ("gemini", "gemini-test", "byok", PER_TURN)


async def test_a_gemini_selection_beats_the_owners_azure_and_the_fleet(enabled, monkeypatch):
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://owner-ai.openai.azure.com/")
    monkeypatch.setenv("AZURE_OPENAI_DEPLOYMENT", "gpt-5-mini")
    monkeypatch.setenv("HUSSH_POD_MANAGED_MODEL_ENABLED", "true")
    pod_ai_selection.set_active_ai_selection(_selection("gemini"))
    seen: dict[str, Any] = {}

    await _turn(seen)

    assert _target(seen) == ("gemini", "gemini-test", "byok", SECRET)
    assert seen["runtime_credential_transport"] == "developer_api"


def test_an_explicit_puppy_turn_keeps_the_owners_device():
    from api.routes.one.pod_turn_target import owner_selected_turn

    pod_ai_selection.set_active_ai_selection(_selection("openai"))
    payload = PodTurnRequest(message="hi", runtimeProvider="puppy", puppyDeviceId="d1")
    assert owner_selected_turn(payload, "puppy", "local") is None
    assert owner_selected_turn(payload, "gemini", "gemini-test") is not None


def _openai_error(cls: type, status: int) -> Exception:
    request = httpx.Request("POST", "https://api.openai.com/v1/responses")
    response = httpx.Response(status, request=request)
    return cls(f"Incorrect API key provided: {SECRET}", response=response, body=None)


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (_openai_error(openai.AuthenticationError, 401), "OWNER_AI_KEY_REFUSED"),
        (_openai_error(openai.RateLimitError, 429), "OWNER_AI_QUOTA_EXCEEDED"),
    ],
    ids=["key_refused", "quota_exceeded"],
)
async def test_a_refusal_mid_turn_is_typed_never_a_fallback(enabled, caplog, error, code):
    pod_ai_selection.set_active_ai_selection(_selection("openai"))
    seen: dict[str, Any] = {}

    with pytest.raises(HTTPException) as refused:
        await _turn(seen, boom=error)

    assert refused.value.status_code == 409
    assert refused.value.detail == {"code": code, "provider": "openai"}
    assert pod_ai_selection.last_ai_selection_failure()["code"] == code.removeprefix("OWNER_AI_")
    assert SECRET not in caplog.text and SECRET not in str(refused.value.detail)


async def test_without_a_selection_a_provider_error_stays_the_generic_failure(enabled):
    """Negative control: a per-turn key's refusal is not reported as the sealed key's."""
    with pytest.raises(HTTPException) as failed:
        await _turn({}, boom=_openai_error(openai.AuthenticationError, 401))
    assert failed.value.status_code == 502
    assert pod_ai_selection.last_ai_selection_failure() is None


# -- One's head, the specialists and the owner door ----------------------------------


def _never(*_a: Any, **_k: Any) -> Any:
    raise AssertionError("a Gemini or hub builder was reached on an owner OpenAI turn")


def test_ones_head_on_openai_is_the_owner_responses_door(monkeypatch):
    from hushh_mcp.one_adk import text_runtime

    monkeypatch.setattr(text_runtime, "build_gemini_byok_adk_model", _never)
    monkeypatch.setattr(factory, "build_runtime_client", _never)
    monkeypatch.setenv("OPENAI_BASE_URL", "https://attacker.example/v1")

    head = text_runtime._runtime_model(
        runtime_model="gpt-5.6-luna",
        runtime_mode="byok",
        runtime_credential=SECRET,
        runtime_provider="openai",
    )
    assert isinstance(head, ProviderAdkModel)
    assert (head.provider, head.model, head.runtime_mode) == ("openai", "gpt-5.6-luna", "byok")
    client = head._client()
    assert type(client).__name__ == "OpenAIResponsesTransport"
    assert str(client._client.base_url) == "https://api.openai.com/v1/", "the key goes nowhere else"


def test_the_byok_gemini_head_is_unchanged_negative_control(monkeypatch):
    from hushh_mcp.one_adk import text_runtime

    built: list[str] = []
    monkeypatch.setattr(
        text_runtime, "build_gemini_byok_adk_model", lambda m, *_a, **_k: built.append(m) or "g"
    )
    assert (
        text_runtime._runtime_model(
            runtime_model="gemini-test", runtime_mode="byok", runtime_credential=PER_TURN
        )
        == "g"
    )
    assert built == ["gemini-test"]


@pytest.mark.parametrize(
    ("provider", "mode", "key"),
    [("openai", "user_azure_mi", SECRET), ("openai", "byok", ""), ("gemini", "byok", SECRET)],
    ids=["azure_mode", "no_key", "other_provider"],
)
def test_the_owner_openai_door_serves_only_openai_byok_with_a_key(provider, mode, key):
    with pytest.raises(owner_openai.OwnerOpenAIModeMismatch):
        owner_openai.build_owner_openai_transport(
            runtime_provider=provider, runtime_mode=mode, credential=key
        )


def test_the_intro_turn_stays_gemini_only():
    import asyncio

    from hushh_mcp.one_adk.text_runtime import stream_one_intro_text_turn

    async def first() -> Any:
        async for event in stream_one_intro_text_turn(
            user_id="anon",
            message="hi",
            screen_context=None,
            runtime_provider="openai",
            runtime_model="gpt-5.6-luna",
            runtime_mode="byok",
            runtime_credential=SECRET,
        ):
            return event

    with pytest.raises(ValueError, match="requires the Gemini provider"):
        asyncio.run(first())


async def test_a_specialist_model_call_uses_the_owner_openai_door(monkeypatch):
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

    async def _generate(*, model, contents, config):
        return SimpleNamespace(text=f"answer from {model}", function_calls=[])

    built: list[tuple] = []

    def _transport(**kwargs: Any) -> Any:
        built.append((kwargs["runtime_provider"], kwargs["runtime_mode"], kwargs["credential"]))
        return SimpleNamespace(
            aio=SimpleNamespace(models=SimpleNamespace(generate_content=_generate))
        )

    monkeypatch.setattr(pod_consent_client, "verify_consent", ok)
    monkeypatch.setattr(pod_memory_service, "_resolve_log", lambda: _Log())
    monkeypatch.setattr(owner_openai, "build_owner_openai_transport", _transport)
    monkeypatch.setattr(factory, "build_runtime_client", _never)
    runtime = build_pod_specialist_runtime(
        user_id="owner-uid",
        hushh_id="pod-synthetic",
        consent_token="owner-grant",
        provider="openai",
        model="gpt-5.6-luna",
        runtime_mode="byok",
        credential=SECRET,
        credential_transport="developer_api",
        vertex_project=None,
        vertex_location=None,
        data_door_grants={"location": "loc-scope"},
    )
    service = await runtime.service_for("agent_location")

    result = await service._model_call([], None)

    assert result.text == "answer from gpt-5.6-luna"
    assert built == [("openai", "byok", SECRET)]


# -- the other doors ---------------------------------------------------------------


async def test_commands_refuse_an_openai_selection_before_any_builder(monkeypatch):
    from api.routes.one import pod_commands

    monkeypatch.setattr(pod_turn, "_resolve_model", lambda *_a, **_k: ("gemini", "gemini-test"))
    for name in ("build_gemini_byok_adk_model", "build_runtime_client"):
        monkeypatch.setattr(factory, name, _never)
    pod_ai_selection.set_active_ai_selection(_selection("openai"))

    with pytest.raises(HTTPException) as refused:
        await pod_commands._brain(
            pod_commands.CommandModel(), "owner-uid", "location.assess", {"hushh_id": "p"}
        )
    assert refused.value.status_code == 503
    assert refused.value.detail == {"code": "COMMAND_MODEL_UNAVAILABLE", "runtimeMode": "byok"}


async def test_commands_run_a_gemini_selection_on_its_sealed_key(monkeypatch):
    """Negative control for the refusal: Gemini commands work, on the sealed key."""
    from api.routes.one import pod_commands

    monkeypatch.setattr(pod_turn, "_resolve_model", lambda *_a, **_k: ("gemini", "gemini-test"))
    keys: list[tuple[str, str]] = []
    monkeypatch.setattr(
        factory, "build_runtime_client", lambda p, key, **_k: keys.append((p, key)) or "client"
    )
    monkeypatch.setattr(
        factory, "build_gemini_byok_adk_model", lambda m, key, **_k: keys.append((m, key)) or "adk"
    )
    monkeypatch.setattr(pod_commands, "LocationCommandBrain", lambda **kw: kw)
    pod_ai_selection.set_active_ai_selection(_selection("gemini"))

    brain = await pod_commands._brain(
        pod_commands.CommandModel(runtimeCredential=PER_TURN),
        "owner-uid",
        "location.assess",
        {"hushh_id": "p"},
    )

    assert brain["client"] == "client"
    assert {key for _, key in keys} == {SECRET}, "never the per-turn key, never a fleet path"


async def test_agent_chat_builds_one_and_its_specialists_on_the_selection(monkeypatch):
    from hushh_mcp.one_adk import agent_tree, agui_factory, text_runtime
    from hushh_mcp.one_adk.pod_agui_context import PodChatContext
    from hushh_mcp.services import pod_specialist_runtime

    seen: dict[str, Any] = {}
    monkeypatch.setattr(
        pod_specialist_runtime,
        "build_pod_specialist_runtime",
        lambda **kw: seen.setdefault("specialists", kw) and object(),
    )
    monkeypatch.setattr(
        agent_tree, "build_one_text_agent", lambda *, model, **_k: seen.setdefault("head", model)
    )
    monkeypatch.setattr(
        agui_factory,
        "build_authenticated_agui",
        lambda *_a, **_k: SimpleNamespace(configure_pod_turn=lambda **_kw: None),
    )
    monkeypatch.setattr(text_runtime, "_resolve_pod_memory_service", lambda: None)
    monkeypatch.setattr(pod_turn, "_resolve_model", lambda *_a, **_k: ("gemini", "gemini-test"))
    pod_ai_selection.set_active_ai_selection(_selection("openai", "gpt-6-luna"))

    context = object.__new__(PodChatContext)
    context.owner, context.hushh_id = "owner-uid", "pod-synthetic"
    context.claims = {"user_id": "owner-uid", "hushh_id": "pod-synthetic"}
    context.authority = SimpleNamespace(
        local_token=lambda _c: "local-token", local_verifier=lambda _c: None
    )
    context.sessions = object()

    async def _access() -> None:
        return None

    context.require_access = _access
    await context.build_agent(PodTurnRequest(message="hi", runtimeCredential=PER_TURN))

    specialists = seen["specialists"]
    assert (specialists["provider"], specialists["model"], specialists["runtime_mode"]) == (
        "openai",
        "gpt-6-luna",
        "byok",
    )
    assert specialists["credential"] == SECRET
    head = seen["head"]
    assert (head.provider, head.model, head.credential) == ("openai", "gpt-6-luna", SECRET)


async def test_the_close_review_runs_on_the_selection(monkeypatch):
    from api.routes.one.pod_memory import PodConversationCloseRequest, run_conversation_close
    from hushh_mcp.services.pod_config import PodConfig, set_active_pod_config

    monkeypatch.setattr(pod_turn, "pod_mode", lambda: True)
    monkeypatch.setattr(pod_turn, "pod_turn_enabled", lambda: True)
    monkeypatch.setattr(pod_turn, "_resolve_model", lambda *_a, **_k: ("gemini", "gemini-test"))

    async def _validate(_token, *, verifier=None):
        return {"user_id": "u1", "scope": "pkm.read"}

    monkeypatch.setattr(pod_turn, "_validate_consent", _validate)
    set_active_pod_config(PodConfig())
    pod_ai_selection.set_active_ai_selection(_selection("openai"))
    seen: dict[str, Any] = {}

    async def _review(**kwargs: Any) -> Any:
        seen.update(kwargs)
        raise RuntimeError("stop after the model is chosen")

    try:
        with pytest.raises(HTTPException):
            await run_conversation_close(
                conversation_id="c1",
                payload=PodConversationCloseRequest(runtimeCredential=PER_TURN),
                consent_token="t",
                review_fn=_review,
                memory_service=object(),
            )
    finally:
        set_active_pod_config(None)
    model = seen["model"]
    assert (model.provider, model.model, model.credential) == ("openai", "gpt-5.6-luna", SECRET)


# -- the pod's AG-UI chat: the same refusal, typed, with its provider text kept private --


@pytest.mark.parametrize(
    ("bridge_message", "code"),
    [
        (
            f"Error code: 401 - {{'error': {{'message': 'Incorrect API key: {SECRET}'}}}}",
            "OWNER_AI_KEY_REFUSED",
        ),
        ("Error code: 429 - {'error': {'code': 'insufficient_quota'}}", "OWNER_AI_QUOTA_EXCEEDED"),
        (
            f"400 INVALID_ARGUMENT. {{'message': 'API key not valid. {SECRET}'}}",
            "OWNER_AI_KEY_REFUSED",
        ),
    ],
    ids=["openai_401", "openai_429", "gemini_bad_key"],
)
def test_agent_chat_types_a_refused_sealed_key(bridge_message, code):
    from ag_ui.core import RunErrorEvent

    from hushh_mcp.one_adk.output_privacy import normalize_history_error, public_event

    bridge = RunErrorEvent(message=bridge_message, code="EXECUTION_ERROR")
    pod_ai_selection.set_active_ai_selection(_selection("openai"))

    shown = public_event(normalize_history_error(bridge))

    assert (shown.code, shown.metadata["provider"]) == (code, "openai")
    assert SECRET not in shown.model_dump_json()
    assert pod_ai_selection.last_ai_selection_failure()["code"] == code.removeprefix("OWNER_AI_")


def test_agent_chat_without_a_selection_keeps_the_generic_error_negative_control():
    from ag_ui.core import RunErrorEvent

    from hushh_mcp.one_adk.output_privacy import (
        normalize_history_error,
        public_event,
        safe_exception_event,
    )

    bridge = RunErrorEvent(message=f"Error code: 401 - {SECRET}", code="EXECUTION_ERROR")
    assert public_event(normalize_history_error(bridge)).code == "AGENT_ERROR"
    assert (
        safe_exception_event(_openai_error(openai.AuthenticationError, 401)).code == "AGENT_ERROR"
    )
    pod_ai_selection.set_active_ai_selection(_selection("openai"))
    escaped = safe_exception_event(_openai_error(openai.AuthenticationError, 401))
    assert escaped.code == "OWNER_AI_KEY_REFUSED"
