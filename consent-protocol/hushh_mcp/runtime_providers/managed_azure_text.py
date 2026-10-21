"""Azure transport behind the existing managed text and generated SDK ports.

The compatibility names do not claim Gemini answered. Responses retain the
actual model version, received citations and usage. BYOK never enters this port.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Iterator
from types import SimpleNamespace
from typing import Any

from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.adk.tools.google_search_tool import GoogleSearchTool
from google.genai import types

from hushh_mcp.managed_ai_config import load_pwm_policy
from hushh_mcp.runtime_providers.azure_adk import AzureOpenAIAdkModel
from hushh_mcp.runtime_providers.gemini_config import (
    generation_config_kwargs,
    is_supported_gemini_text_model,
    resolve_fleet_model_name,
)
from hushh_mcp.runtime_providers.managed_azure import ManagedAzureBinding


class AzurePublicSearchTool(GoogleSearchTool):
    """Keep the manifest tool identifier while selecting actual Bing transport."""

    async def process_llm_request(self, *, tool_context, llm_request):
        llm_request.config = llm_request.config or types.GenerateContentConfig()
        llm_request.config.tools = list(llm_request.config.tools or [])
        llm_request.config.tools.append(types.Tool(google_search=types.GoogleSearch()))


def _text_model(model: str) -> str:
    resolved = resolve_fleet_model_name(model)
    if not is_supported_gemini_text_model(resolved):
        raise ValueError("The managed Azure text mapping requires a declared fleet text model")
    return resolved


def build_azure_text_model(model: str, *, http_options=None) -> AzureOpenAIAdkModel | None:
    binding = ManagedAzureBinding.from_environment()
    if binding is None:
        return None
    _text_model(model)
    config = load_pwm_policy(environment="uat", provider="azure_openai")["azure"]
    timeout_ms = (
        http_options.get("timeout")
        if isinstance(http_options, dict)
        else getattr(http_options, "timeout", None)
    )

    async def require_current():
        binding.require_current()

    return AzureOpenAIAdkModel(
        model=config["primary_deployment"],
        endpoint=binding.endpoint,
        token_supplier=binding.token_supplier,
        require_current=require_current,
        timeout_seconds=min(120, max(0.001, timeout_ms / 1000)) if timeout_ms else 60,
        allow_web_search=True,
    )


def _contents(value: Any) -> list[types.Content]:
    items = value if isinstance(value, list) else [value]
    result: list[types.Content] = []
    parts: list[types.Part] = []
    for item in items:
        if isinstance(item, types.Content):
            if parts:
                result.append(types.Content(role="user", parts=parts))
                parts = []
            result.append(item)
        elif isinstance(item, str):
            parts.append(types.Part(text=item))
        elif isinstance(item, types.Part):
            parts.append(item)
        else:
            raise ValueError("Unsupported managed text input shape")
    if parts:
        result.append(types.Content(role="user", parts=parts))
    if not result:
        raise ValueError("Managed text requires input")
    return result


def _config(model: str, config: Any) -> types.GenerateContentConfig:
    if config is None:
        return types.GenerateContentConfig()
    value = config if isinstance(config, dict) else config.model_dump(exclude_none=True)
    return types.GenerateContentConfig(**generation_config_kwargs(_text_model(model), **value))


def _sdk_response(
    result: LlmResponse, *, config: types.GenerateContentConfig, content=None, parsed=True
):
    content = result.content if content is None else content
    value = types.GenerateContentResponse(
        candidates=[
            types.Candidate(
                content=content,
                finish_reason=result.finish_reason,
                grounding_metadata=result.grounding_metadata,
            )
        ],
        model_version=result.model_version,
        usage_metadata=result.usage_metadata,
    )
    schema = config.response_json_schema or config.response_schema
    if parsed and schema is not None and not result.partial:
        from hushh_mcp.hushh_adk.single_turn import _decode

        value.parsed = _decode(value.text or "", schema)
    return value


class ManagedAzureTextClient:
    """Real generated response shapes; no shared conversations or hidden memory."""

    def __init__(self, *, model_factory=build_azure_text_model):
        self._model_factory = model_factory
        self.aio = SimpleNamespace(models=_AsyncModels(self))
        self.models = _SyncModels(self)

    def adk_model(self, model: str, *, http_options=None):
        result = self._model_factory(model, http_options=http_options)
        if result is None:
            raise RuntimeError("Managed Azure text selection changed")
        return result


def adk_model_for_client(client: Any, model: str, *, legacy_factory):
    """Preserve injected/test and explicit Gemini clients at their existing seam."""
    if isinstance(client, ManagedAzureTextClient):
        return client.adk_model(model)
    return legacy_factory(model=model, client=client)


class _AsyncModels:
    def __init__(self, client: ManagedAzureTextClient):
        self.client = client

    def _request(self, model, contents, config):
        generation = _config(model, config)
        adapter = self.client.adk_model(model, http_options=generation.http_options)
        return (
            adapter,
            generation,
            LlmRequest(model=adapter.model, contents=_contents(contents), config=generation),
        )

    async def generate_content(self, *, model: str, contents: Any, config=None):
        adapter, generation, request = self._request(model, contents, config)
        final = None
        async for item in adapter.generate_content_async(request, stream=False):
            if item.partial or final is not None:
                raise ValueError("Managed nonstreaming response is not terminal")
            final = _sdk_response(item, config=generation)
        if final is None:
            raise ValueError("Managed text returned no response")
        return final

    async def generate_content_stream(
        self, *, model: str, contents: Any, config=None
    ) -> AsyncIterator[types.GenerateContentResponse]:
        adapter, generation, request = self._request(model, contents, config)

        async def iterate() -> AsyncIterator[types.GenerateContentResponse]:
            emitted: dict[bool, str] = {False: "", True: ""}
            stream = adapter.generate_content_async(request, stream=True)
            try:
                async for item in stream:
                    if item.partial:
                        for part in item.content.parts if item.content else []:
                            if part.text is not None:
                                emitted[bool(part.thought)] += part.text
                        yield _sdk_response(item, config=generation, parsed=False)
                        continue
                    # ADK terminal messages contain complete text. SDK stream
                    # consumers append deltas, so never repeat that text.
                    remaining = []
                    for thought in (False, True):
                        full = "".join(
                            p.text or ""
                            for p in item.content.parts or []
                            if bool(p.thought) == thought
                        )
                        if not full.startswith(emitted[thought]):
                            raise ValueError("Managed stream terminal content changed")
                        suffix = full[len(emitted[thought]) :]
                        if suffix:
                            remaining.append(types.Part(text=suffix, thought=thought or None))
                    remaining.extend(p for p in item.content.parts or [] if p.text is None)
                    complete = _sdk_response(item, config=generation)
                    terminal = _sdk_response(
                        item,
                        config=generation,
                        content=types.Content(role="model", parts=remaining),
                        parsed=False,
                    )
                    terminal.parsed = complete.parsed
                    yield terminal
            finally:
                await stream.aclose()

        return iterate()


def _require_sync_context():
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return
    raise RuntimeError("Use the asynchronous managed text port on an event-loop thread")


class _SyncModels:
    def __init__(self, client: ManagedAzureTextClient):
        self.client = client

    def generate_content(self, **kwargs):
        _require_sync_context()
        return asyncio.run(self.client.aio.models.generate_content(**kwargs))

    def generate_content_stream(self, **kwargs) -> Iterator[types.GenerateContentResponse]:
        _require_sync_context()
        with asyncio.Runner() as runner:
            stream = runner.run(self.client.aio.models.generate_content_stream(**kwargs))
            try:
                while True:
                    try:
                        yield runner.run(anext(stream))
                    except StopAsyncIteration:
                        return
            finally:
                runner.run(stream.aclose())
