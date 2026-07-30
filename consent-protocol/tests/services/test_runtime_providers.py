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
    GeminiByokTransportUnsupportedError,
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
    assert set(providers) == {"gemini", "anthropic", "openai", "grok", "musespark"}


def test_default_model_per_provider_is_stable():
    for provider in ("gemini", "anthropic", "openai", "grok", "musespark"):
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


def test_muse_spark_resolves_from_the_names_a_person_actually_uses():
    # The vendor and the model family are different words, and a caller may
    # reach for either. Both resolve; a space-separated form does not, which
    # matches every other alias in the registry rather than inventing a rule
    # only this provider follows.
    for alias in ("musespark", "muse-spark", "muse", "meta", "metaai", "MUSE"):
        assert normalize_provider(alias) == "musespark"
    assert default_model_for_provider("meta") == "muse-spark-1.1"


def test_muse_spark_claims_only_capabilities_meta_documents():
    # Structured output and parallel tool calling are documented for the Meta
    # Model API. Prompt caching and native realtime are not, and borrowing the
    # OpenAI wire format is not evidence of either — asserting them here would
    # let the voice layer pick a transport the provider may not serve.
    entry = resolve_model_entry("musespark", "muse-spark-1.1")
    assert entry.supports_function_calling is True
    assert entry.supports_prompt_caching is False
    assert entry.supports_native_realtime is False


def test_only_gemini_live_model_advertises_native_realtime():
    assert resolve_model_entry("gemini", "gemini-3.5-flash").supports_native_realtime is False
    assert resolve_model_entry("gemini", "gemini-3.1-flash-lite").supports_native_realtime is False
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
    from hushh_mcp.runtime_providers.normalized import NormalizedChunk

    assert NormalizedChunk(text="").candidates == ()
    assert NormalizedChunk(text="hi").candidates[0].content.parts[0].text == "hi"


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


def test_factory_sends_muse_spark_to_metas_host_not_openais(monkeypatch):
    # Muse Spark reuses the OpenAI transport because it speaks that wire format.
    # The base_url is therefore the ONLY thing separating it from OpenAI, and
    # getting it wrong would post the user's Meta key to api.openai.com — a
    # credential leak to a third party that no test above would catch.
    captured: list[dict[str, Any]] = []

    def fake_async_openai(**kwargs):
        captured.append(kwargs)
        return types.SimpleNamespace(kind="openai-compatible")

    monkeypatch.setattr("openai.AsyncOpenAI", fake_async_openai)

    build_runtime_client("meta", "user-supplied-meta-key")

    assert len(captured) == 1
    assert captured[0]["base_url"] == "https://api.meta.ai/v1"
    assert captured[0]["api_key"] == "user-supplied-meta-key"


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


def test_factory_rejects_unrehearsed_google_cloud_vertex_api_key_transport(monkeypatch):
    calls: list[dict] = []

    monkeypatch.setattr(
        "google.genai.Client",
        lambda **kwargs: calls.append(kwargs) or types.SimpleNamespace(kind="vertex-api-key"),
    )

    with pytest.raises(GeminiByokTransportUnsupportedError):
        build_runtime_client(
            "gemini",
            "K1",
            gemini_byok_transport="vertex_api_key",
            vertex_project="customer-vertex-project",
            vertex_location="us-central1",
        )

    assert calls == []


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
