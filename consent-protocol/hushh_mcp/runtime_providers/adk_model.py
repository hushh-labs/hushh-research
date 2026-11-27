"""ADK model adapter for the existing provider transports.

The pod's One runner owns orchestration and tools. This adapter only translates
the ADK model call into the provider-neutral transport facade and translates the
answer back into ADK responses; it never executes tools or selects a provider.

Streaming rides ADK's own ``StreamingResponseAggregator``, the same aggregator
the Gemini adapter uses. Every chunk is yielded as a partial event and the
aggregator's ``close()`` produces the single non-partial event that carries the
complete text and every function call. That final event is the one ADK appends
to the session and executes tools from; the earlier hand-rolled stream yielded
only partial events plus a content-less terminal, so on a Puppy turn no tool
ever ran and nothing of One's answer reached memory.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import aclosing
from typing import Any

from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.adk.utils.streaming_utils import StreamingResponseAggregator
from google.genai import types
from pydantic import Field

from . import factory


def build_runtime_client(*args: Any, **kwargs: Any) -> Any:
    """Keep one patchable seam while resolving the live factory at call time."""
    return factory.build_runtime_client(*args, **kwargs)


_SAFETY_FINISH_REASONS = frozenset(
    {
        "SAFETY",
        "RECITATION",
        "BLOCKLIST",
        "PROHIBITED_CONTENT",
        "SPII",
        "IMAGE_SAFETY",
        "IMAGE_PROHIBITED_CONTENT",
    }
)


def _reason_name(raw: Any) -> str:
    if raw is None:
        return ""
    name = getattr(raw, "name", None) or getattr(raw, "value", None) or str(raw)
    cleaned = str(name).strip().upper()
    if "." in cleaned:
        cleaned = cleaned.rsplit(".", maxsplit=1)[-1]
    return cleaned


def _has_explicit_safety_block(value: Any) -> bool:
    prompt_feedback = getattr(value, "prompt_feedback", None)
    block_reason = _reason_name(getattr(prompt_feedback, "block_reason", None))
    if block_reason and block_reason not in {"NONE", "BLOCK_REASON_UNSPECIFIED"}:
        return True
    direct_finish = _reason_name(getattr(value, "finish_reason", None))
    if direct_finish in _SAFETY_FINISH_REASONS:
        return True
    for candidate in getattr(value, "candidates", None) or ():
        if _reason_name(getattr(candidate, "finish_reason", None)) in _SAFETY_FINISH_REASONS:
            return True
    return False


class ProviderAdkModel(BaseLlm):
    """Expose one existing native provider transport as an ADK ``BaseLlm``."""

    provider: str
    credential: str = Field(repr=False, exclude=True)
    device_id: str | None = None
    puppy_catalog_version: str | None = None
    # Managed pod runtimes use workload ADC; BYOK and Puppy relay runtimes
    # continue through the explicit credential transport.
    runtime_mode: str | None = None
    gemini_byok_transport: str = "developer_api"
    vertex_project: str | None = None
    vertex_location: str | None = None

    @staticmethod
    def _parts(*, text: str = "", function_calls: Any = ()) -> list[types.Part]:
        parts: list[types.Part] = []
        if text:
            parts.append(types.Part.from_text(text=text))
        for call in function_calls or ():
            parts.append(
                types.Part(
                    function_call=types.FunctionCall(
                        id=getattr(call, "id", None) or None,
                        name=getattr(call, "name", ""),
                        args=getattr(call, "args", {}) or {},
                    )
                )
            )
        return parts

    @classmethod
    def _content(cls, *, text: str = "", function_calls: Any = ()) -> types.Content | None:
        parts = cls._parts(text=text, function_calls=function_calls)
        return types.Content(role="model", parts=parts) if parts else None

    def _model_version(self, value: Any) -> str | None:
        """The model the provider reports for this answer, or None when it did not.

        Never the requested id: the turn route reports ``modelReported`` from
        whether a version arrived, and a fabricated one would make every Puppy
        turn look reported while the device had said nothing.
        """
        reported = str(getattr(value, "model_version", "") or "").strip()
        return reported or None

    @staticmethod
    def _usage_metadata(value: Any) -> types.GenerateContentResponseUsageMetadata | None:
        """Provider token counts in ADK's shape, so a non-Gemini pod can account spend."""
        usage = getattr(value, "usage", None)
        if usage is None:
            return None
        return types.GenerateContentResponseUsageMetadata(
            prompt_token_count=usage.input_tokens,
            candidates_token_count=usage.output_tokens,
            cached_content_token_count=usage.cached_input_tokens or None,
            thoughts_token_count=usage.reasoning_tokens or None,
            total_token_count=usage.input_tokens + usage.output_tokens,
        )

    def _genai_response(self, chunk: Any) -> types.GenerateContentResponse | None:
        """Wrap one normalized chunk as the genai response shape ADK aggregates."""
        parts = self._parts(
            text=getattr(chunk, "text", "") or "",
            function_calls=getattr(chunk, "function_calls", ()) or (),
        )
        if not parts:
            return None
        return types.GenerateContentResponse(
            candidates=[types.Candidate(content=types.Content(role="model", parts=parts))],
            model_version=self._model_version(chunk),
            usage_metadata=self._usage_metadata(chunk),
        )

    def _client(self) -> Any:
        from .owner_openai import is_owner_model, owner_model_client

        if is_owner_model(self.provider, self.runtime_mode):
            # The owner's Azure deployment or their own OpenAI key: one door for both,
            # never the general factory (whose ``openai`` is the hub's Chat Completions).
            return owner_model_client(
                self.provider, self.runtime_mode or "", self.credential or None
            )
        if (
            self.runtime_mode == "sentinel_vertex"
            and self.provider == "gemini"
            and not self.credential
        ):
            from .sentinel_gemini import build_sentinel_genai_client

            return build_sentinel_genai_client()
        if (
            self.runtime_mode in {"user_adc", "hosted_pod_adc"}
            and self.provider == "gemini"
            and not self.credential
        ):
            if self.runtime_mode == "hosted_pod_adc":
                from hushh_mcp.runtime_settings import pod_hosted_adc_enabled

                from .owner_gemini import require_admitted_model

                if not pod_hosted_adc_enabled():
                    raise RuntimeError("Hosted pod model authority is unavailable")
                self.model = require_admitted_model(self.model)
            from .owner_gemini import build_owner_gemini_client

            return build_owner_gemini_client()
        if self.runtime_mode == "hushh_managed_vertex" and not self.credential:
            from .factory import build_managed_runtime_client

            return build_managed_runtime_client(self.provider)
        if self.runtime_mode not in {None, "byok", "puppy_relay"}:
            raise RuntimeError("Pod model authority unavailable")
        return build_runtime_client(
            self.provider,
            self.credential,
            puppy_device_id=self.device_id,
            **(
                {"puppy_catalog_version": self.puppy_catalog_version}
                if self.puppy_catalog_version
                else {}
            ),
            gemini_byok_transport=self.gemini_byok_transport,
            vertex_project=self.vertex_project,
            vertex_location=self.vertex_location,
        )

    def _request_config(self, config: Any) -> Any:
        """Remove Enterprise-only fields before a Developer API request.

        ADK attaches labels for managed Agent Platform telemetry. The same
        ``LlmRequest`` is also used by BYOK/Developer API transports, where the
        genai client rejects that field before making a request. Keep labels for
        managed Vertex and copy the config for the developer path so one provider
        cannot mutate another turn's request.
        """
        if self.runtime_mode in {
            "user_adc",
            "hosted_pod_adc",
            "sentinel_vertex",
            "hushh_managed_vertex",
        }:
            return config
        copier = getattr(config, "model_copy", None)
        if callable(copier):
            return copier(update={"labels": None})
        return config

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        from .lifecycle import close_owned_model_client

        client = self._client()
        try:
            async with aclosing(self._generate_owned(client, llm_request, stream)) as responses:
                async for response in responses:
                    yield response
        finally:
            await close_owned_model_client(client)

    async def _generate_owned(
        self, client: Any, llm_request: LlmRequest, stream: bool
    ) -> AsyncGenerator[LlmResponse, None]:
        if stream:
            for attempt in range(2):
                aggregator = StreamingResponseAggregator()
                chunks = await client.aio.models.generate_content_stream(
                    model=self.model,
                    contents=llm_request.contents,
                    config=self._request_config(llm_request.config),
                )
                trailing_usage = None
                trailing_model_version = None
                saw_content = False
                safety_blocked = False
                async with aclosing(chunks):
                    async for chunk in chunks:
                        # Terminal metadata can arrive after the last text or tool delta.
                        trailing_usage = self._usage_metadata(chunk) or trailing_usage
                        trailing_model_version = (
                            self._model_version(chunk) or trailing_model_version
                        )
                        if _has_explicit_safety_block(chunk):
                            safety_blocked = True
                        response = self._genai_response(chunk)
                        if response is None:
                            continue
                        saw_content = True
                        async for llm_response in aggregator.process_response(response):
                            yield llm_response
                final = aggregator.close()
                empty_final = final is None or (
                    final.content is None and not getattr(final, "function_calls", None)
                )
                if empty_final and not saw_content and not safety_blocked and attempt == 0:
                    continue
                if final is not None:
                    if final.usage_metadata is None and trailing_usage is not None:
                        final.usage_metadata = trailing_usage
                    if trailing_model_version is not None:
                        final.model_version = trailing_model_version
                    yield final
                return

        for attempt in range(2):
            response = await client.aio.models.generate_content(
                model=self.model,
                contents=llm_request.contents,
                config=self._request_config(llm_request.config),
            )
            content = self._content(
                text=getattr(response, "text", "") or "",
                function_calls=getattr(response, "function_calls", ()) or (),
            )
            if (
                content is None
                and not (getattr(response, "function_calls", None) or ())
                and not _has_explicit_safety_block(response)
                and attempt == 0
            ):
                continue
            yield LlmResponse(
                model_version=self._model_version(response),
                content=content,
                usage_metadata=self._usage_metadata(response),
                partial=False,
                turn_complete=True,
            )
            return
