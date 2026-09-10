"""Phase 1 multi-provider runtime transport tests.

Covers the registry, genai->neutral translation, normalized response shapes,
the provider-keyed factory, and native adapter normalization (Anthropic /
OpenAI / Grok) using lightweight fakes for the provider SDKs. Exercises both
happy paths and sad paths, plus a coarse perf guard on the hot translation
path.
"""

from __future__ import annotations

import sys
import time
import types
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.runtime_providers import (
    build_managed_gemini_adk_model,
    build_managed_runtime_client,
    build_runtime_client,
    default_model_for_provider,
    is_known_provider,
    normalize_provider,
    resolve_model_entry,
    supported_providers,
)
from hushh_mcp.runtime_providers.factory import _build
from hushh_mcp.runtime_providers.normalized import (
    NormalizedChunk,
    NormalizedFunctionCall,
    NormalizedResponse,
)
from hushh_mcp.runtime_providers.translate import to_neutral_request
from hushh_mcp.runtime_providers.vertex_failover import VertexRegionalClient

# --------------------------------------------------------------------------- #
# genai-shaped request fakes (mirror google.genai types the chat service uses)
# --------------------------------------------------------------------------- #


class _Part:
    def __init__(self, text: str):
        self.text = text


class _Content:
    def __init__(self, role: str, text: str):
        self.role = role
        self.parts = [_Part(text)]


class _FunctionDeclaration:
    def __init__(self, name: str, description: str, parameters: dict[str, Any]):
        self.name = name
        self.description = description
        self.parameters = parameters


class _Tool:
    def __init__(self, declarations: list[_FunctionDeclaration]):
        self.function_declarations = declarations


class _Config:
    def __init__(
        self,
        *,
        system_instruction: str | None = None,
        temperature: float | None = None,
        max_output_tokens: int | None = None,
        tools: list[_Tool] | None = None,
    ):
        self.system_instruction = system_instruction
        self.temperature = temperature
        self.max_output_tokens = max_output_tokens
        self.tools = tools or []


def _basic_contents() -> list[_Content]:
    return [
        _Content("user", "What is a stock split?"),
        _Content("model", "A stock split divides existing shares."),
        _Content("user", "Thanks, summarize again."),
    ]


# --------------------------------------------------------------------------- #
# registry
# --------------------------------------------------------------------------- #


def test_normalize_provider_accepts_known_aliases():
    assert normalize_provider("Gemini") == "gemini"
    assert normalize_provider("google") == "gemini"
    assert normalize_provider("claude") == "anthropic"
    assert normalize_provider("xai") == "grok"
    assert normalize_provider("OpenAI") == "openai"


def test_normalize_provider_rejects_unknown():
    with pytest.raises(ValueError, match="Unsupported runtime provider"):
        normalize_provider("mistral")


def test_is_known_provider_and_supported_set():
    assert is_known_provider("grok") is True
    assert is_known_provider("cohere") is False
    providers = supported_providers()
    assert set(providers) == {"gemini", "anthropic", "openai", "grok", "puppy"}


def test_default_model_per_provider_is_stable():
    for provider in ("gemini", "anthropic", "openai", "grok", "puppy"):
        assert default_model_for_provider(provider)


def test_resolve_model_entry_known_and_passthrough():
    known = resolve_model_entry("anthropic", "claude")
    assert known.provider == "anthropic"
    # Unknown-but-wellformed model on a known provider passes through.
    passthrough = resolve_model_entry("openai", "gpt-6-future")
    assert passthrough.provider == "openai"
    assert passthrough.model == "gpt-6-future"
    assert passthrough.supports_native_realtime is False


def test_resolve_model_entry_empty_model_uses_default():
    entry = resolve_model_entry("gemini", "")
    assert entry.provider == "gemini"
    assert entry.model == default_model_for_provider("gemini")


def test_only_gemini_live_models_advertise_native_realtime():
    assert resolve_model_entry("gemini", "gemini-3.5-flash").supports_native_realtime is False
    assert resolve_model_entry("gemini", "gemini-3.1-flash-lite").supports_native_realtime is False
    # Canonical live model (developer_api transport) and the Vertex GA
    # rollback model are the only two realtime-capable entries.
    assert (
        resolve_model_entry("gemini", "gemini-3.1-flash-live-preview").supports_native_realtime
        is True
    )
    assert (
        resolve_model_entry("gemini", "gemini-live-2.5-flash-native-audio").supports_native_realtime
        is True
    )


# --------------------------------------------------------------------------- #
# translate
# --------------------------------------------------------------------------- #


def test_to_neutral_request_maps_roles_and_config():
    config = _Config(
        system_instruction="You are Agent.",
        temperature=0.7,
        max_output_tokens=4096,
    )
    request = to_neutral_request(_basic_contents(), config)
    assert [m.role for m in request.messages] == ["user", "assistant", "user"]
    assert request.system_instruction == "You are Agent."
    assert request.temperature == 0.7
    assert request.max_output_tokens == 4096
    assert request.tools == ()


def test_to_neutral_request_extracts_tools():
    tool = _Tool(
        [
            _FunctionDeclaration(
                name="open_app_surface",
                description="Open a surface",
                parameters={"type": "object", "properties": {"surface": {"type": "string"}}},
            )
        ]
    )
    request = to_neutral_request(_basic_contents(), _Config(tools=[tool]))
    assert len(request.tools) == 1
    assert request.tools[0].name == "open_app_surface"
    assert request.tools[0].parameters["properties"]["surface"]["type"] == "string"


def test_to_neutral_request_handles_empty_and_none():
    empty = to_neutral_request([], None)
    assert empty.messages == ()
    assert empty.system_instruction is None
    assert empty.tools == ()


def test_to_neutral_request_perf_hot_path():
    # Coarse guard: translating a 20-turn history must stay well under budget.
    contents = [_Content("user" if i % 2 == 0 else "model", f"turn {i} " * 50) for i in range(20)]
    config = _Config(system_instruction="sys", temperature=0.7, max_output_tokens=4096)
    start = time.perf_counter()
    for _ in range(200):
        to_neutral_request(contents, config)
    elapsed = time.perf_counter() - start
    assert elapsed < 1.0, f"translation hot path too slow: {elapsed:.3f}s for 200 iters"


# --------------------------------------------------------------------------- #
# normalized response shape (the contract the chat service consumes)
# --------------------------------------------------------------------------- #


def test_normalized_response_exposes_genai_shape():
    response = NormalizedResponse(
        text="hello",
        function_calls=(NormalizedFunctionCall(name="open_app_surface", args={"surface": "pkm"}),),
    )
    # _chunk_text / _function_calls_from_response style access must work.
    assert response.text == "hello"
    assert list(response.function_calls)[0].name == "open_app_surface"
    candidates = response.candidates
    assert candidates
    parts = candidates[0].content.parts
    assert any(getattr(p, "text", None) == "hello" for p in parts)
    assert any(getattr(p, "function_call", None) is not None for p in parts)


def test_normalized_chunk_candidates_empty_when_no_text():
    assert NormalizedChunk(text="").candidates == ()
    assert NormalizedChunk(text="hi").candidates[0].content.parts[0].text == "hi"


def test_normalized_chunk_preserves_function_calls():
    call = NormalizedFunctionCall(name="lookup", args={"q": "x"}, id="call-1")
    parts = NormalizedChunk(function_calls=(call,)).candidates[0].content.parts
    assert parts[0].function_call is call


class _PuppyModels:
    """A fake provider client whose stream is scripted per call."""

    def __init__(
        self, scripts: list[list[NormalizedChunk]], full: NormalizedResponse | None = None
    ):
        self._scripts = list(scripts)
        self._full = full
        self.calls: list[str] = []

    async def generate_content(self, *, model, contents, config):
        self.calls.append("generate")
        assert self._full is not None, "non-stream call was not scripted"
        return self._full

    async def generate_content_stream(self, *, model, contents, config):
        self.calls.append("stream")
        script = self._scripts.pop(0) if self._scripts else []

        async def _chunks():
            for chunk in script:
                yield chunk

        return _chunks()


def _puppy_model(monkeypatch, models: _PuppyModels, *, model: str = "meta/muse-glimmer"):
    from hushh_mcp.runtime_providers.adk_model import ProviderAdkModel

    bound: list[tuple[str, str, str | None]] = []

    class _Client:
        aio = types.SimpleNamespace(models=models)

    def _build(provider, credential, *, puppy_device_id=None, **_kwargs):
        bound.append((provider, credential, puppy_device_id))
        return _Client()

    monkeypatch.setattr("hushh_mcp.runtime_providers.adk_model.build_runtime_client", _build)
    return (
        ProviderAdkModel(model=model, provider="puppy", credential="grant", device_id="tdv_1"),
        bound,
    )


def _llm_request(text: str = "hello"):
    from google.adk.models.llm_request import LlmRequest
    from google.genai import types as genai_types

    return LlmRequest(
        contents=[genai_types.Content(role="user", parts=[genai_types.Part.from_text(text=text)])]
    )


def _call(part) -> tuple[str, str]:
    call = getattr(part, "function_call", None)
    return (str(getattr(call, "name", "") or ""), str(getattr(call, "id", "") or ""))


async def test_provider_adk_model_maps_puppy_transport_for_text_and_stream(monkeypatch):
    lookup = NormalizedFunctionCall(name="lookup", args={"q": "x"}, id="call-1")
    models = _PuppyModels(
        scripts=[[NormalizedChunk(text="local "), NormalizedChunk(function_calls=(lookup,))]],
        full=NormalizedResponse(text="local answer", function_calls=(lookup,)),
    )
    model, bound = _puppy_model(monkeypatch, models)
    request = _llm_request()

    full = [item async for item in model.generate_content_async(request)]
    assert full[-1].content is not None
    assert full[-1].content.parts[-1].function_call.id == "call-1"
    assert full[-1].partial is False

    streamed = [item async for item in model.generate_content_async(request, stream=True)]
    # Every intermediate event is partial; the LAST event is the single
    # non-partial aggregate ADK appends to the session and executes tools from.
    assert [item.partial for item in streamed[:-1]] == [True, True]
    final = streamed[-1]
    assert final.partial is False
    assert final.content is not None, "the terminal event must carry content"
    assert final.content.parts[0].text == "local "
    assert _call(final.content.parts[1]) == ("lookup", "call-1")
    assert final.model_version == "meta/muse-glimmer"
    assert bound[0] == ("puppy", "grant", "tdv_1")
    assert models.calls == ["generate", "stream"]


async def test_provider_adk_model_tool_only_stream_yields_executable_non_partial_call(monkeypatch):
    """A turn whose whole answer is a tool call must still end in a non-partial event."""
    from google.adk.events import Event

    lookup = NormalizedFunctionCall(name="lookup", args={"q": "x"}, id="call-1")
    model, _ = _puppy_model(
        monkeypatch, _PuppyModels(scripts=[[NormalizedChunk(function_calls=(lookup,))]])
    )

    streamed = [item async for item in model.generate_content_async(_llm_request(), stream=True)]
    assert streamed[0].partial is True
    final = streamed[-1]
    assert final.partial is False
    assert [_call(part) for part in final.content.parts] == [("lookup", "call-1")]
    # ADK executes function calls only from non-partial events; the aggregate
    # is that event, and an all-partial sequence never is.
    assert Event(author="one", **final.model_dump(exclude_none=True)).get_function_calls()
    partial_only = Event(author="one", **streamed[0].model_dump(exclude_none=True))
    assert partial_only.partial is True and partial_only.is_final_response() is False


async def test_provider_adk_model_multi_tool_stream_preserves_order_and_ids(monkeypatch):
    first = NormalizedFunctionCall(name="lookup", args={"q": "x"}, id="call-1")
    second = NormalizedFunctionCall(name="open_app_surface", args={"surface": "s"}, id="call-2")
    model, _ = _puppy_model(
        monkeypatch,
        _PuppyModels(
            scripts=[
                [
                    NormalizedChunk(text="one "),
                    NormalizedChunk(function_calls=(first,)),
                    NormalizedChunk(text="two"),
                    NormalizedChunk(function_calls=(second,)),
                ]
            ]
        ),
    )
    streamed = [item async for item in model.generate_content_async(_llm_request(), stream=True)]
    final = streamed[-1]
    assert final.partial is False
    shape = [
        (part.text or "") if getattr(part, "function_call", None) is None else _call(part)
        for part in final.content.parts
    ]
    assert shape == ["one ", ("lookup", "call-1"), "two", ("open_app_surface", "call-2")]


async def test_provider_adk_model_empty_stream_yields_nothing(monkeypatch):
    """A silent provider produces no event at all, so the runtime's empty-answer guard fires."""
    model, _ = _puppy_model(monkeypatch, _PuppyModels(scripts=[[NormalizedChunk(text="")]]))
    assert [item async for item in model.generate_content_async(_llm_request(), stream=True)] == []


async def test_puppy_stream_reaches_the_session_and_executes_a_tool_through_the_real_runner(
    monkeypatch,
):
    """The join that was silently broken: ADK stores and acts on the aggregate.

    Runs the real ADK ``Runner`` over an ``LlmAgent`` whose model is the Puppy
    adapter. The first stream answers with a tool call, the second with text.
    The tool must actually run, and the stored session must hold the model's
    function call, the tool response and the final text as NON-partial events,
    because ``add_session_to_memory`` reads exactly those.
    """
    from google.adk.agents import LlmAgent
    from google.adk.agents.run_config import RunConfig, StreamingMode
    from google.adk.runners import Runner
    from google.adk.sessions import InMemorySessionService
    from google.genai import types as genai_types

    invoked: list[str] = []

    def lookup(q: str) -> dict:
        """Look something up."""
        invoked.append(q)
        return {"answer": "42"}

    lookup_call = NormalizedFunctionCall(name="lookup", args={"q": "x"}, id="call-1")
    models = _PuppyModels(
        scripts=[
            [NormalizedChunk(function_calls=(lookup_call,))],
            [NormalizedChunk(text="the answer "), NormalizedChunk(text="is 42")],
        ]
    )
    model, _ = _puppy_model(monkeypatch, models, model="local")
    agent = LlmAgent(name="one", model=model, tools=[lookup])
    session_service = InMemorySessionService()
    runner = Runner(app_name="pod-test", agent=agent, session_service=session_service)
    await session_service.create_session(app_name="pod-test", user_id="owner", session_id="s1")

    yielded = [
        event
        async for event in runner.run_async(
            user_id="owner",
            session_id="s1",
            new_message=genai_types.Content(
                role="user", parts=[genai_types.Part.from_text(text="what is x")]
            ),
            run_config=RunConfig(streaming_mode=StreamingMode.SSE),
        )
    ]

    assert invoked == ["x"], "the tool never ran: ADK saw no non-partial function call"
    assert models.calls == ["stream", "stream"]
    stored = await session_service.get_session(
        app_name="pod-test", user_id="owner", session_id="s1"
    )
    stored_events = list(stored.events)
    assert any(event.partial for event in yielded), "partials must still stream"
    assert not any(event.partial for event in stored_events), "partials are never stored"
    assert any(event.author == "one" and event.get_function_calls() for event in stored_events), (
        "the model's function call must be stored as a non-partial event"
    )
    assert any(event.get_function_responses() for event in stored_events)
    final_text = [
        "".join(part.text or "" for part in event.content.parts)
        for event in stored_events
        if event.author == "one" and event.content and not event.get_function_calls()
    ]
    assert "the answer is 42" in final_text, final_text


async def test_the_old_all_partial_shape_never_runs_the_tool_negative_control(monkeypatch):
    """Documents the defect this adapter replaced, so a regression is loud."""
    from google.adk.agents import LlmAgent
    from google.adk.agents.run_config import RunConfig, StreamingMode
    from google.adk.models.base_llm import BaseLlm
    from google.adk.models.llm_response import LlmResponse
    from google.adk.runners import Runner
    from google.adk.sessions import InMemorySessionService
    from google.genai import types as genai_types

    invoked: list[str] = []

    def lookup(q: str) -> dict:
        """Look something up."""
        invoked.append(q)
        return {"answer": "42"}

    class _OldShape(BaseLlm):
        async def generate_content_async(self, llm_request, stream=False):
            yield LlmResponse(
                content=genai_types.Content(
                    role="model",
                    parts=[
                        genai_types.Part(
                            function_call=genai_types.FunctionCall(
                                id="call-1", name="lookup", args={"q": "x"}
                            )
                        )
                    ],
                ),
                partial=True,
            )
            yield LlmResponse(partial=False, turn_complete=True)

    agent = LlmAgent(name="one", model=_OldShape(model="local"), tools=[lookup])
    session_service = InMemorySessionService()
    runner = Runner(app_name="pod-test", agent=agent, session_service=session_service)
    await session_service.create_session(app_name="pod-test", user_id="owner", session_id="s1")
    _ = [
        event
        async for event in runner.run_async(
            user_id="owner",
            session_id="s1",
            new_message=genai_types.Content(
                role="user", parts=[genai_types.Part.from_text(text="what is x")]
            ),
            run_config=RunConfig(streaming_mode=StreamingMode.SSE),
        )
    ]
    stored = await session_service.get_session(
        app_name="pod-test", user_id="owner", session_id="s1"
    )
    assert invoked == []
    assert not any(event.author == "one" for event in stored.events)


# --------------------------------------------------------------------------- #
# factory routing
# --------------------------------------------------------------------------- #


def test_genai_client_construction_is_centralized() -> None:
    protocol_root = Path(__file__).resolve().parents[2]
    factory_path = protocol_root / "hushh_mcp" / "runtime_providers" / "factory.py"
    offenders: list[str] = []
    for root in (protocol_root / "hushh_mcp", protocol_root / "api", protocol_root / "scripts"):
        for path in root.rglob("*.py"):
            if path == factory_path:
                continue
            if "genai.Client(" in path.read_text(encoding="utf-8"):
                offenders.append(str(path.relative_to(protocol_root)))

    assert offenders == []


def test_build_runtime_client_requires_key():
    with pytest.raises(ValueError, match="BYOK runtime key is required"):
        build_runtime_client("anthropic", "   ")


def test_build_managed_non_gemini_runtime_client_requires_key():
    with pytest.raises(RuntimeError, match="Managed runtime API key is not configured"):
        build_managed_runtime_client("anthropic", "")


def test_factory_rejects_unknown_provider():
    with pytest.raises(ValueError, match="Unsupported runtime provider"):
        build_runtime_client("mistral", "key")


def test_factory_gemini_uses_byok_and_managed_adc_clients(monkeypatch):
    calls: list[dict] = []

    def fake_client(**kwargs):
        calls.append(kwargs)
        return types.SimpleNamespace(kind="genai")

    monkeypatch.setattr("google.genai.Client", fake_client)
    monkeypatch.setenv("HUSHH_GENAI_AUTH_MODE", "vertex_adc")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-test")
    monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", "global")
    byok = build_runtime_client("gemini", "K1")
    managed = build_managed_runtime_client("gemini", "K2")
    assert byok.kind == "genai" and managed.kind == "genai"
    assert calls == [
        {"vertexai": False, "api_key": "K1"},
        {"vertexai": True, "project": "hushh-test", "location": "global"},
    ]


def test_factory_managed_adc_separates_vertex_project_from_native_project(monkeypatch):
    calls: list[dict] = []

    monkeypatch.setenv("HUSHH_GENAI_AUTH_MODE", "vertex_adc")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda-uat")
    monkeypatch.setenv("GENAI_GOOGLE_CLOUD_PROJECT", "hushh-vertex-personal54")
    monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", "global")
    monkeypatch.setattr(
        "google.genai.Client",
        lambda **kwargs: calls.append(kwargs) or types.SimpleNamespace(kind="genai"),
    )

    build_managed_runtime_client("gemini")

    assert calls == [
        {
            "vertexai": True,
            "project": "hushh-vertex-personal54",
            "location": "global",
        }
    ]


def test_factory_builds_google_cloud_vertex_api_key_transport(monkeypatch):
    calls: list[dict] = []

    monkeypatch.setattr(
        "google.genai.Client",
        lambda **kwargs: calls.append(kwargs) or types.SimpleNamespace(kind="vertex-api-key"),
    )

    client = build_runtime_client(
        "gemini",
        "K1",
        gemini_byok_transport="vertex_api_key",
        vertex_project="customer-vertex-project",
        vertex_location="us-central1",
    )

    assert client.kind == "vertex-api-key"
    assert calls == [
        {
            "vertexai": True,
            "api_key": "K1",
            "http_options": {"base_url": "https://us-central1-aiplatform.googleapis.com/"},
        }
    ]


def test_factory_managed_adc_ignores_legacy_environment_key(monkeypatch):
    calls: list[dict] = []

    monkeypatch.setenv("HUSHH_GENAI_AUTH_MODE", "vertex_adc")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-test")
    monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", "us-central1")
    monkeypatch.setenv("GOOGLE_API_KEY", "LEGACY_KEY_MUST_NOT_BE_USED")
    monkeypatch.setattr("google.genai.Client", lambda **kwargs: calls.append(kwargs) or object())

    build_managed_runtime_client("gemini")

    assert calls == [{"vertexai": True, "project": "hushh-test", "location": "us-central1"}]


def test_factory_builds_adk_model_with_explicit_managed_vertex_contract(monkeypatch):
    monkeypatch.setenv("HUSHH_GENAI_AUTH_MODE", "vertex_adc")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-test")
    monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", "global")
    monkeypatch.setenv("GOOGLE_API_KEY", "LEGACY_KEY_MUST_NOT_BE_USED")

    model = build_managed_gemini_adk_model("gemini-test")

    assert model.model == "gemini-test"
    assert model.client_kwargs == {
        "vertexai": True,
        "project": "hushh-test",
        "location": "global",
    }


def test_factory_adk_model_honors_explicit_live_location(monkeypatch):
    monkeypatch.setenv("HUSHH_GENAI_AUTH_MODE", "vertex_adc")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-test")
    monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", "global")

    model = build_managed_gemini_adk_model(
        "gemini-live-test",
        vertex_location="us-central1",
    )

    assert model.client_kwargs == {
        "vertexai": True,
        "project": "hushh-test",
        "location": "us-central1",
    }


@pytest.mark.parametrize("location", ["us", "eu"])
def test_factory_accepts_supported_vertex_multi_regions(monkeypatch, location):
    monkeypatch.setenv("HUSHH_GENAI_AUTH_MODE", "vertex_adc")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-test")
    monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", "global")

    model = build_managed_gemini_adk_model(
        "gemini-3.1-flash-lite",
        vertex_location=location,
    )

    assert model.client_kwargs["location"] == location


@pytest.mark.asyncio
async def test_managed_vertex_failover_preserves_model_request_and_uses_adc(monkeypatch):
    class ResourceExhaustedError(Exception):
        status_code = 429

    calls: list[dict[str, Any]] = []
    requests: list[tuple[str, dict[str, Any]]] = []

    def fake_client(**kwargs: Any) -> Any:
        calls.append(kwargs)
        location = str(kwargs["location"])
        generate_content = AsyncMock()
        if location == "global":
            generate_content.side_effect = ResourceExhaustedError("RESOURCE_EXHAUSTED")
        else:
            generate_content.side_effect = lambda **request: (
                requests.append((location, request)) or types.SimpleNamespace(text="OK")
            )
        return types.SimpleNamespace(
            aio=types.SimpleNamespace(
                models=types.SimpleNamespace(generate_content=generate_content)
            )
        )

    monkeypatch.setattr("google.genai.Client", fake_client)
    monkeypatch.setenv("HUSHH_GENAI_AUTH_MODE", "vertex_adc")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-test")
    monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", "global")
    monkeypatch.setenv("HUSHH_VERTEX_LOCATIONS", "global,asia-southeast1")

    client = build_managed_runtime_client("gemini")
    response = await client.aio.models.generate_content(
        model="gemini-3.5-flash",
        contents="Return OK",
        config={"temperature": 0},
    )

    assert isinstance(client, VertexRegionalClient)
    assert response.text == "OK"
    assert calls == [
        {"vertexai": True, "project": "hushh-test", "location": "global"},
        {"vertexai": True, "project": "hushh-test", "location": "asia-southeast1"},
    ]
    assert requests == [
        (
            "asia-southeast1",
            {
                "model": "gemini-3.5-flash",
                "contents": "Return OK",
                "config": {"temperature": 0},
            },
        )
    ]


@pytest.mark.asyncio
async def test_vertex_failover_cooldown_skips_exhausted_primary(monkeypatch):
    class ResourceExhaustedError(Exception):
        status_code = 429

    global_generate = AsyncMock(side_effect=ResourceExhaustedError("RESOURCE_EXHAUSTED"))
    regional_generate = AsyncMock(return_value=types.SimpleNamespace(text="OK"))

    def fake_client(**kwargs: Any) -> Any:
        generate = global_generate if kwargs["location"] == "global" else regional_generate
        return types.SimpleNamespace(
            aio=types.SimpleNamespace(models=types.SimpleNamespace(generate_content=generate))
        )

    client = VertexRegionalClient(
        project="hushh-test",
        locations=("global", "asia-southeast1"),
        client_factory=fake_client,
        cooldown_seconds=300,
    )

    first = await client.aio.models.generate_content(model="gemini-3.5-flash", contents="one")
    second = await client.aio.models.generate_content(model="gemini-3.5-flash", contents="two")

    assert first.text == second.text == "OK"
    assert global_generate.await_count == 1
    assert regional_generate.await_count == 2


def test_vertex_failover_does_not_retry_authorization_failure() -> None:
    class PermissionDeniedError(Exception):
        status_code = 403

    primary_generate = lambda **_kwargs: (_ for _ in ()).throw(  # noqa: E731
        PermissionDeniedError("PERMISSION_DENIED")
    )
    regional_generate = lambda **_kwargs: types.SimpleNamespace(text="unexpected")  # noqa: E731
    created: list[str] = []

    def fake_client(**kwargs: Any) -> Any:
        location = str(kwargs["location"])
        created.append(location)
        generate = primary_generate if location == "global" else regional_generate
        return types.SimpleNamespace(models=types.SimpleNamespace(generate_content=generate))

    client = VertexRegionalClient(
        project="hushh-test",
        locations=("global", "asia-southeast1"),
        client_factory=fake_client,
        cooldown_seconds=300,
    )

    with pytest.raises(PermissionDeniedError):
        client.models.generate_content(model="gemini-3.5-flash", contents="blocked")

    assert created == ["global"]


def test_factory_developer_api_key_mode_is_explicit_and_local_only(monkeypatch):
    calls: list[dict] = []

    monkeypatch.setenv("HUSHH_GENAI_AUTH_MODE", "developer_api_key")
    monkeypatch.setenv("GOOGLE_API_KEY", "LOCAL_DEVELOPER_KEY")
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    monkeypatch.setattr("google.genai.Client", lambda **kwargs: calls.append(kwargs) or object())

    build_managed_runtime_client("gemini")

    assert calls == [{"vertexai": False, "api_key": "LOCAL_DEVELOPER_KEY"}]


def test_factory_rejects_developer_api_key_mode_in_hosted_environment(monkeypatch):
    monkeypatch.setenv("HUSHH_GENAI_AUTH_MODE", "developer_api_key")
    monkeypatch.setenv("GOOGLE_API_KEY", "HOSTED_KEY_MUST_NOT_BE_USED")
    monkeypatch.setenv("ENVIRONMENT", "uat")

    with pytest.raises(RuntimeError, match="Hosted Gemini runtimes must use Vertex ADC"):
        build_managed_runtime_client("gemini")


def test_factory_hosted_adc_requires_explicit_vertex_contract(monkeypatch):
    monkeypatch.setenv("HUSHH_GENAI_AUTH_MODE", "vertex_adc")
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("GOOGLE_GENAI_USE_VERTEXAI", raising=False)
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-test")
    monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", "global")

    with pytest.raises(RuntimeError, match="GOOGLE_GENAI_USE_VERTEXAI=true"):
        build_managed_runtime_client("gemini")


def test_factory_hosted_adc_requires_project_and_location(monkeypatch):
    monkeypatch.setenv("HUSHH_GENAI_AUTH_MODE", "vertex_adc")
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("GOOGLE_GENAI_USE_VERTEXAI", "true")
    monkeypatch.delenv("GOOGLE_CLOUD_PROJECT", raising=False)
    monkeypatch.delenv("GCP_PROJECT", raising=False)
    monkeypatch.delenv("GOOGLE_PROJECT", raising=False)
    monkeypatch.delenv("GCLOUD_PROJECT", raising=False)
    monkeypatch.delenv("VERTEX_PROJECT_ID", raising=False)

    with pytest.raises(RuntimeError, match="GOOGLE_CLOUD_PROJECT"):
        build_managed_runtime_client("gemini")

    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-test")
    monkeypatch.delenv("GOOGLE_CLOUD_LOCATION", raising=False)
    monkeypatch.delenv("GCP_LOCATION", raising=False)
    monkeypatch.delenv("VERTEX_LOCATION", raising=False)

    with pytest.raises(RuntimeError, match="GOOGLE_CLOUD_LOCATION"):
        build_managed_runtime_client("gemini")


def test_factory_grok_uses_openai_transport_with_base_url(monkeypatch):
    captured: dict[str, Any] = {}

    class _FakeAsyncOpenAI:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    fake_module = types.ModuleType("openai")
    fake_module.AsyncOpenAI = _FakeAsyncOpenAI
    monkeypatch.setitem(sys.modules, "openai", fake_module)

    transport = _build("grok", "GROK_KEY", managed=False)
    assert transport.provider == "grok"
    assert captured["base_url"] == "https://api.x.ai/v1"
    assert captured["api_key"] == "GROK_KEY"


# --------------------------------------------------------------------------- #
# native adapter normalization (Anthropic)
# --------------------------------------------------------------------------- #


def _install_fake_anthropic(monkeypatch, *, content_blocks, stream_texts):
    class _FakeStream:
        def __init__(self, texts):
            self._texts = texts

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        @property
        def text_stream(self):
            async def gen():
                for t in self._texts:
                    yield t

            return gen()

    class _FakeMessages:
        async def create(self, **kwargs):
            return types.SimpleNamespace(content=content_blocks)

        def stream(self, **kwargs):
            return _FakeStream(stream_texts)

    class _FakeAsyncAnthropic:
        def __init__(self, **kwargs):
            self.messages = _FakeMessages()

    fake_module = types.ModuleType("anthropic")
    fake_module.AsyncAnthropic = _FakeAsyncAnthropic
    monkeypatch.setitem(sys.modules, "anthropic", fake_module)


async def test_anthropic_generate_normalizes_text_and_tool_use(monkeypatch):
    blocks = [
        types.SimpleNamespace(type="text", text="Here is the answer."),
        types.SimpleNamespace(
            type="tool_use", name="open_app_surface", input={"surface": "pkm"}, id="tc_1"
        ),
    ]
    _install_fake_anthropic(monkeypatch, content_blocks=blocks, stream_texts=[])
    from hushh_mcp.runtime_providers.anthropic_transport import AnthropicTransport

    transport = AnthropicTransport(api_key="K")
    response = await transport.aio.models.generate_content(
        model="claude-sonnet-4-5",
        contents=_basic_contents(),
        config=_Config(system_instruction="sys", temperature=0.5, max_output_tokens=1000),
    )
    assert response.text == "Here is the answer."
    assert response.function_calls[0].name == "open_app_surface"
    assert response.function_calls[0].args == {"surface": "pkm"}
    assert response.function_calls[0].id == "tc_1"


async def test_anthropic_stream_yields_text_chunks(monkeypatch):
    _install_fake_anthropic(monkeypatch, content_blocks=[], stream_texts=["Hello", " ", "world"])
    from hushh_mcp.runtime_providers.anthropic_transport import AnthropicTransport

    transport = AnthropicTransport(api_key="K")
    stream = await transport.aio.models.generate_content_stream(
        model="claude-sonnet-4-5", contents=_basic_contents(), config=_Config()
    )
    chunks = [chunk.text async for chunk in stream]
    assert "".join(chunks) == "Hello world"


# --------------------------------------------------------------------------- #
# native adapter normalization (OpenAI / Grok)
# --------------------------------------------------------------------------- #


def _install_fake_openai(monkeypatch, *, completion, stream_deltas):
    class _FakeCompletions:
        async def create(self, **kwargs):
            if kwargs.get("stream"):

                async def gen():
                    for delta_text in stream_deltas:
                        yield types.SimpleNamespace(
                            choices=[
                                types.SimpleNamespace(
                                    delta=types.SimpleNamespace(content=delta_text)
                                )
                            ]
                        )

                return gen()
            return completion

    class _FakeChat:
        def __init__(self):
            self.completions = _FakeCompletions()

    class _FakeAsyncOpenAI:
        def __init__(self, **kwargs):
            self.chat = _FakeChat()

    fake_module = types.ModuleType("openai")
    fake_module.AsyncOpenAI = _FakeAsyncOpenAI
    monkeypatch.setitem(sys.modules, "openai", fake_module)


async def test_openai_generate_normalizes_text_and_tool_calls(monkeypatch):
    completion = types.SimpleNamespace(
        choices=[
            types.SimpleNamespace(
                message=types.SimpleNamespace(
                    content="An answer.",
                    tool_calls=[
                        types.SimpleNamespace(
                            id="call_1",
                            function=types.SimpleNamespace(
                                name="start_stock_analysis",
                                arguments='{"symbol": "AAPL"}',
                            ),
                        )
                    ],
                )
            )
        ]
    )
    _install_fake_openai(monkeypatch, completion=completion, stream_deltas=[])
    from hushh_mcp.runtime_providers.openai_transport import OpenAITransport

    transport = OpenAITransport(api_key="K", provider="openai")
    response = await transport.aio.models.generate_content(
        model="gpt-5.1", contents=_basic_contents(), config=_Config(temperature=0.0)
    )
    assert response.text == "An answer."
    assert response.function_calls[0].name == "start_stock_analysis"
    assert response.function_calls[0].args == {"symbol": "AAPL"}


async def test_openai_generate_handles_malformed_tool_args(monkeypatch):
    completion = types.SimpleNamespace(
        choices=[
            types.SimpleNamespace(
                message=types.SimpleNamespace(
                    content="",
                    tool_calls=[
                        types.SimpleNamespace(
                            id="call_x",
                            function=types.SimpleNamespace(
                                name="open_app_surface", arguments="not-json"
                            ),
                        )
                    ],
                )
            )
        ]
    )
    _install_fake_openai(monkeypatch, completion=completion, stream_deltas=[])
    from hushh_mcp.runtime_providers.openai_transport import OpenAITransport

    transport = OpenAITransport(api_key="K", provider="openai")
    response = await transport.aio.models.generate_content(
        model="gpt-5.1", contents=_basic_contents(), config=_Config()
    )
    # Malformed JSON args degrade to an empty dict instead of raising.
    assert response.function_calls[0].args == {}


async def test_openai_generate_empty_choices_returns_empty(monkeypatch):
    completion = types.SimpleNamespace(choices=[])
    _install_fake_openai(monkeypatch, completion=completion, stream_deltas=[])
    from hushh_mcp.runtime_providers.openai_transport import OpenAITransport

    transport = OpenAITransport(api_key="K", provider="openai")
    response = await transport.aio.models.generate_content(
        model="gpt-5.1", contents=_basic_contents(), config=_Config()
    )
    assert response.text == ""
    assert response.function_calls == ()


async def test_openai_stream_yields_text(monkeypatch):
    _install_fake_openai(monkeypatch, completion=None, stream_deltas=["Strea", "ming", " ok"])
    from hushh_mcp.runtime_providers.openai_transport import OpenAITransport

    transport = OpenAITransport(api_key="K", provider="openai")
    stream = await transport.aio.models.generate_content_stream(
        model="gpt-5.1", contents=_basic_contents(), config=_Config()
    )
    chunks = [chunk.text async for chunk in stream]
    assert "".join(chunks) == "Streaming ok"


class _PuppySocket:
    def __init__(self):
        self.sent: list[dict[str, Any]] = []
        self._frames = [
            {"type": "relay.ready", "role": "pod"},
            {"type": "inference.delta", "requestId": "", "text": "local "},
            {
                "type": "inference.result",
                "requestId": "",
                "text": "answer",
                "functionCalls": [{"id": "call-1", "name": "lookup", "args": {"q": "x"}}],
            },
        ]

    async def send(self, raw: str) -> None:
        payload = __import__("json").loads(raw)
        self.sent.append(payload)
        if payload.get("type") == "inference.request":
            for frame in self._frames:
                frame["requestId"] = payload["requestId"]

    async def recv(self) -> str:
        return __import__("json").dumps(self._frames.pop(0))

    async def close(self) -> None:
        return None


async def test_puppy_transport_preserves_request_binding_and_tool_calls(monkeypatch):
    from hushh_mcp.runtime_providers.puppy_transport import PuppyRelayTransport
    from hushh_mcp.runtime_providers.translate import NeutralMessage, NeutralRequest, NeutralTool

    socket = _PuppySocket()
    transport = PuppyRelayTransport("grant", relay_url="ws://relay", device_id="tdv_1")
    monkeypatch.setattr(transport, "_connect", lambda: _async_return(socket))
    request = NeutralRequest(
        messages=(
            NeutralMessage(role="user", text="hello"),
            NeutralMessage(
                role="assistant",
                tool_name="lookup",
                tool_call_id="call-1",
                tool_arguments={"q": "x"},
            ),
            NeutralMessage(role="tool", tool_call_id="call-1", tool_result={"ok": True}),
        ),
        tools=(NeutralTool(name="lookup", description="look up", parameters={"type": "object"}),),
    )
    result = await transport._generate(request, model="local")
    assert result.text == "local answer"
    assert result.function_calls[0].id == "call-1"
    assert socket.sent[0]["type"] == "relay.hello"
    sent = socket.sent[1]
    assert sent["messages"][1]["toolArguments"] == {"q": "x"}
    assert sent["messages"][2]["toolCallId"] == "call-1"
    assert sent["messages"][2]["toolResult"] == {"ok": True}


async def _async_return(value: Any) -> Any:
    return value


def test_puppy_messages_pair_tool_results_when_ids_are_empty():
    """ADK strips client-minted ids for this adapter; the wire must still pair."""
    from hushh_mcp.runtime_providers.puppy_transport import _messages
    from hushh_mcp.runtime_providers.translate import NeutralMessage, NeutralRequest

    request = NeutralRequest(
        messages=(
            NeutralMessage(role="user", text="hello"),
            NeutralMessage(role="assistant", tool_name="lookup", tool_arguments={"q": "x"}),
            NeutralMessage(role="tool", tool_name="lookup", tool_result={"ok": True}),
            NeutralMessage(role="assistant", tool_name="lookup", tool_arguments={"q": "y"}),
            NeutralMessage(role="tool", tool_name="lookup", tool_result={"ok": False}),
        )
    )
    wire = _messages(request)
    assert wire[1]["toolCallId"] == "call_1"
    assert wire[2]["toolCallId"] == "call_1"
    assert wire[3]["toolCallId"] == "call_2"
    assert wire[4]["toolCallId"] == "call_2"


def test_puppy_messages_keep_ids_the_runtime_preserved():
    from hushh_mcp.runtime_providers.puppy_transport import _messages
    from hushh_mcp.runtime_providers.translate import NeutralMessage, NeutralRequest

    request = NeutralRequest(
        messages=(
            NeutralMessage(
                role="assistant", tool_name="lookup", tool_call_id="adk-7", tool_arguments={}
            ),
            NeutralMessage(role="tool", tool_name="lookup", tool_call_id="adk-7", tool_result=1),
        )
    )
    wire = _messages(request)
    assert [item["toolCallId"] for item in wire] == ["adk-7", "adk-7"]


def test_puppy_messages_never_pair_different_tools_negative_control():
    from hushh_mcp.runtime_providers.puppy_transport import _messages
    from hushh_mcp.runtime_providers.translate import NeutralMessage, NeutralRequest

    request = NeutralRequest(
        messages=(
            NeutralMessage(role="assistant", tool_name="lookup", tool_arguments={}),
            NeutralMessage(role="tool", tool_name="open_app_surface", tool_result={}),
        )
    )
    wire = _messages(request)
    assert wire[0]["toolCallId"] == "call_1"
    assert "toolCallId" not in wire[1], "a result for another tool must not steal the id"


# --------------------------------------------------------------------------- #
# Lane B1: the neutral wire carries schema, tool choice, sampling and thinking,
# and a capability the device lacks is refused BEFORE dispatch, never dropped.
# --------------------------------------------------------------------------- #


class _FunctionCallingConfig:
    def __init__(self, mode, allowed=None):
        self.mode = mode
        self.allowed_function_names = allowed


class _ToolConfig:
    def __init__(self, calling):
        self.function_calling_config = calling


class _ThinkingConfig:
    def __init__(self, budget, include):
        self.thinking_budget = budget
        self.include_thoughts = include


class _Mode:
    """Mimics the genai enum: `.value` carries the wire word."""

    def __init__(self, value):
        self.value = value


def _rich_config(**over):
    config = _Config(system_instruction="sys", temperature=0.2, max_output_tokens=64)
    config.response_schema = {"type": "object", "properties": {"colour": {"type": "string"}}}
    config.response_mime_type = "application/json"
    config.tool_config = _ToolConfig(_FunctionCallingConfig(_Mode("ANY"), ["lookup"]))
    config.top_p = 0.9
    config.stop_sequences = ["END"]
    config.seed = 7
    config.thinking_config = _ThinkingConfig(512, True)
    for key, value in over.items():
        setattr(config, key, value)
    return config


def test_to_neutral_request_reads_schema_tool_choice_sampling_and_thinking():
    request = to_neutral_request(_basic_contents(), _rich_config())
    assert request.response_schema == {
        "type": "object",
        "properties": {"colour": {"type": "string"}},
    }
    assert request.response_mime_type == "application/json"
    assert request.tool_choice == "any"
    assert request.allowed_function_names == ("lookup",)
    assert request.top_p == 0.9
    assert request.stop_sequences == ("END",)
    assert request.seed == 7
    assert request.thinking_budget == 512
    assert request.include_thoughts is True
    assert request.required_capabilities() == ("tool_calling", "json_schema")


def test_to_neutral_request_leaves_unset_knobs_unset_negative_control():
    """A plain config must not invent a schema or a tool choice."""
    request = to_neutral_request(_basic_contents(), _Config(temperature=0.5))
    assert request.response_schema is None
    assert request.response_mime_type is None
    assert request.tool_choice is None
    assert request.allowed_function_names == ()
    assert request.top_p is None
    assert request.stop_sequences == ()
    assert request.seed is None
    assert request.thinking_budget is None
    assert request.include_thoughts is None
    assert request.required_capabilities() == ()


def test_puppy_payload_carries_the_extended_wire_fields():
    from hushh_mcp.runtime_providers.puppy_transport import PuppyRelayTransport

    transport = PuppyRelayTransport("grant", relay_url="ws://relay", device_id="tdv_1")
    request = to_neutral_request(_basic_contents(), _rich_config())
    payload = transport._payload(request, "local", "req-1")
    assert payload["responseFormat"] == {
        "type": "json_schema",
        "jsonSchema": {"type": "object", "properties": {"colour": {"type": "string"}}},
    }
    assert payload["toolChoice"] == "any"
    assert payload["allowedFunctionNames"] == ["lookup"]
    assert payload["topP"] == 0.9
    assert payload["stopSequences"] == ["END"]
    assert payload["seed"] == 7
    assert payload["thinking"] == {"budgetTokens": 512, "includeThoughts": True}


def test_puppy_payload_omits_unset_wire_fields_negative_control():
    from hushh_mcp.runtime_providers.puppy_transport import PuppyRelayTransport

    transport = PuppyRelayTransport("grant", relay_url="ws://relay", device_id="tdv_1")
    payload = transport._payload(to_neutral_request(_basic_contents(), _Config()), "local", "r")
    for key in ("responseFormat", "toolChoice", "allowedFunctionNames", "topP", "seed"):
        assert key not in payload
    assert "stopSequences" not in payload and "thinking" not in payload


class _DeclaringSocket(_PuppySocket):
    """A relay whose admission frame declares the device's capabilities."""

    def __init__(self, capabilities, *, model=None):
        super().__init__()
        ready = {"type": "relay.ready", "role": "pod", "device": {"capabilities": capabilities}}
        if model is not None:
            ready["device"]["model"] = model
        self._frames[0] = ready


def _tooled_request():
    from hushh_mcp.runtime_providers.translate import NeutralMessage, NeutralRequest, NeutralTool

    return NeutralRequest(
        messages=(NeutralMessage(role="user", text="hello"),),
        tools=(NeutralTool(name="lookup", description="look up", parameters={"type": "object"}),),
    )


async def test_puppy_transport_refuses_before_dispatch_when_the_device_lacks_a_capability(
    monkeypatch,
):
    from hushh_mcp.runtime_providers.puppy_transport import (
        PuppyCapabilityUnsupported,
        PuppyRelayTransport,
    )

    socket = _DeclaringSocket({"tool_calling": False, "json_schema": True, "streaming": True})
    transport = PuppyRelayTransport("grant", relay_url="ws://relay", device_id="tdv_1")
    monkeypatch.setattr(transport, "_connect", lambda: _async_return(socket))
    with pytest.raises(PuppyCapabilityUnsupported) as refused:
        await transport._generate(_tooled_request(), model="local")
    assert refused.value.capability == "tool_calling"
    # Nothing was dispatched: the hello went out, the request never did.
    assert [frame["type"] for frame in socket.sent] == ["relay.hello"]


async def test_puppy_transport_refuses_a_schema_the_device_cannot_honour(monkeypatch):
    from hushh_mcp.runtime_providers.puppy_transport import (
        PuppyCapabilityUnsupported,
        PuppyRelayTransport,
    )
    from hushh_mcp.runtime_providers.translate import NeutralMessage, NeutralRequest

    socket = _DeclaringSocket({"tool_calling": True, "json_schema": False})
    transport = PuppyRelayTransport("grant", relay_url="ws://relay", device_id="tdv_1")
    monkeypatch.setattr(transport, "_connect", lambda: _async_return(socket))
    request = NeutralRequest(
        messages=(NeutralMessage(role="user", text="hello"),),
        response_schema={"type": "object"},
    )
    with pytest.raises(PuppyCapabilityUnsupported) as refused:
        await transport._generate(request, model="local")
    assert refused.value.capability == "json_schema"
    assert [frame["type"] for frame in socket.sent] == ["relay.hello"]


async def test_a_ready_frame_without_a_device_block_keeps_legacy_behaviour_negative_control(
    monkeypatch,
):
    """An older relay declares nothing. The request must still go out and the
    device stays the only judge, exactly as before this lane."""
    from hushh_mcp.runtime_providers.puppy_transport import PuppyRelayTransport

    socket = _PuppySocket()
    assert "device" not in socket._frames[0]
    transport = PuppyRelayTransport("grant", relay_url="ws://relay", device_id="tdv_1")
    monkeypatch.setattr(transport, "_connect", lambda: _async_return(socket))
    result = await transport._generate(_tooled_request(), model="local")
    assert [frame["type"] for frame in socket.sent] == ["relay.hello", "inference.request"]
    assert result.text == "local answer"
    assert result.model_version == "", "no frame reported a model, so none may be claimed"


async def test_a_declared_capability_the_request_does_not_need_is_not_a_refusal(monkeypatch):
    from hushh_mcp.runtime_providers.puppy_transport import PuppyRelayTransport
    from hushh_mcp.runtime_providers.translate import NeutralMessage, NeutralRequest

    socket = _DeclaringSocket({"tool_calling": False, "json_schema": False})
    transport = PuppyRelayTransport("grant", relay_url="ws://relay", device_id="tdv_1")
    monkeypatch.setattr(transport, "_connect", lambda: _async_return(socket))
    plain = NeutralRequest(messages=(NeutralMessage(role="user", text="hello"),))
    result = await transport._generate(plain, model="local")
    assert result.text == "local answer"


class _RefusingSocket(_PuppySocket):
    def __init__(self, code, *, capability=None):
        super().__init__()
        error = {"type": "inference.error", "requestId": "", "code": code}
        if capability:
            error["capability"] = capability
        self._frames = [self._frames[0], error]


async def test_a_device_unsupported_capability_error_is_typed_not_unavailable(monkeypatch):
    from hushh_mcp.runtime_providers.puppy_transport import (
        PuppyCapabilityUnsupported,
        PuppyRelayTransport,
    )

    socket = _RefusingSocket("UNSUPPORTED_CAPABILITY", capability="json_schema")
    transport = PuppyRelayTransport("grant", relay_url="ws://relay", device_id="tdv_1")
    monkeypatch.setattr(transport, "_connect", lambda: _async_return(socket))
    with pytest.raises(PuppyCapabilityUnsupported) as refused:
        await transport._generate(_tooled_request(), model="local")
    assert refused.value.capability == "json_schema"


async def test_other_device_errors_stay_unavailable_negative_control(monkeypatch):
    from hushh_mcp.runtime_providers.puppy_transport import (
        PuppyCapabilityUnsupported,
        PuppyRelayTransport,
        PuppyRelayUnavailable,
    )

    socket = _RefusingSocket("LOCAL_MODEL_UNAVAILABLE")
    transport = PuppyRelayTransport("grant", relay_url="ws://relay", device_id="tdv_1")
    monkeypatch.setattr(transport, "_connect", lambda: _async_return(socket))
    with pytest.raises(PuppyRelayUnavailable) as failed:
        await transport._generate(_tooled_request(), model="local")
    assert not isinstance(failed.value, PuppyCapabilityUnsupported)


# --------------------------------------------------------------------------- #
# Lane B2: the model the device says answered travels to the normalized response
# --------------------------------------------------------------------------- #


class _ModelReportingSocket(_PuppySocket):
    def __init__(self, model):
        super().__init__()
        self._frames[2]["model"] = model


async def test_puppy_generate_reports_the_device_model(monkeypatch):
    from hushh_mcp.runtime_providers.puppy_transport import PuppyRelayTransport

    socket = _ModelReportingSocket("qwen3-30b-a3b-mlx")
    transport = PuppyRelayTransport("grant", relay_url="ws://relay", device_id="tdv_1")
    monkeypatch.setattr(transport, "_connect", lambda: _async_return(socket))
    result = await transport._generate(_tooled_request(), model="local")
    assert result.model_version == "qwen3-30b-a3b-mlx"


async def test_puppy_stream_stamps_the_device_model_on_chunks(monkeypatch):
    from hushh_mcp.runtime_providers.puppy_transport import PuppyRelayTransport

    socket = _ModelReportingSocket("qwen3-30b-a3b-mlx")
    transport = PuppyRelayTransport("grant", relay_url="ws://relay", device_id="tdv_1")
    monkeypatch.setattr(transport, "_connect", lambda: _async_return(socket))
    chunks = [chunk async for chunk in transport._stream(_tooled_request(), model="local")]
    # The delta arrived before the result named the model; the result chunk carries it.
    assert chunks[-1].model_version == "qwen3-30b-a3b-mlx"
    assert chunks[0].model_version == ""


@pytest.mark.parametrize(
    "bad",
    ["http://127.0.0.1:1234/v1", "/models/local", "two words", "x" * 129, 42, ""],
)
async def test_a_model_that_could_be_an_endpoint_or_path_is_not_reported(monkeypatch, bad):
    """The wire must never carry the local endpoint or a filesystem path as a
    'model'. Anything shaped like one is dropped, and the turn says unreported."""
    from hushh_mcp.runtime_providers.puppy_transport import PuppyRelayTransport

    socket = _ModelReportingSocket(bad)
    transport = PuppyRelayTransport("grant", relay_url="ws://relay", device_id="tdv_1")
    monkeypatch.setattr(transport, "_connect", lambda: _async_return(socket))
    result = await transport._generate(_tooled_request(), model="local")
    assert result.model_version == ""


async def test_provider_adk_model_reports_the_device_model_on_every_event(monkeypatch):
    lookup = NormalizedFunctionCall(name="lookup", args={"q": "x"}, id="call-1")
    models = _PuppyModels(
        scripts=[
            [
                NormalizedChunk(text="local ", model_version="qwen3"),
                NormalizedChunk(function_calls=(lookup,), model_version="qwen3"),
            ]
        ],
        full=NormalizedResponse(text="answer", model_version="qwen3"),
    )
    model, _ = _puppy_model(monkeypatch, models)
    stream = [event async for event in model.generate_content_async(_llm_request(), stream=True)]
    assert stream and all(event.model_version == "qwen3" for event in stream)
    assert stream[-1].partial is False
    full = [event async for event in model.generate_content_async(_llm_request(), stream=False)]
    assert full[0].model_version == "qwen3"


async def test_provider_adk_model_falls_back_to_the_requested_id_when_unreported(monkeypatch):
    """No fabricated version: an unreported model reads as the id One asked for,
    and the turn route is what turns that into `modelReported: false`."""
    models = _PuppyModels(scripts=[], full=NormalizedResponse(text="answer"))
    model, _ = _puppy_model(monkeypatch, models, model="local")
    full = [event async for event in model.generate_content_async(_llm_request(), stream=False)]
    assert full[0].model_version == "local"
