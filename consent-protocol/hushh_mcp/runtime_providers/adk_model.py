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
from typing import Any

from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.adk.utils.streaming_utils import StreamingResponseAggregator
from google.genai import types

from . import factory


def build_runtime_client(*args: Any, **kwargs: Any) -> Any:
    """Keep one patchable seam while resolving the live factory at call time."""
    return factory.build_runtime_client(*args, **kwargs)


class ProviderAdkModel(BaseLlm):
    """Expose one existing native provider transport as an ADK ``BaseLlm``."""

    provider: str
    credential: str
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
            return owner_model_client(self.provider, self.runtime_mode or "", self.credential)
        if self.runtime_mode in {"user_adc", "hushh_managed_vertex"} and not self.credential:
            from .factory import build_managed_runtime_client

            return build_managed_runtime_client(self.provider)
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
        if self.runtime_mode in {"user_adc", "hushh_managed_vertex"}:
            return config
        copier = getattr(config, "model_copy", None)
        if callable(copier):
            return copier(update={"labels": None})
        return config

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        client = self._client()
        if stream:
            aggregator = StreamingResponseAggregator()
            chunks = await client.aio.models.generate_content_stream(
                model=self.model,
                contents=llm_request.contents,
                config=self._request_config(llm_request.config),
            )
            trailing_usage = None
            async for chunk in chunks:
                # A usage-only final chunk carries no parts; keep its counts for close().
                trailing_usage = self._usage_metadata(chunk) or trailing_usage
                response = self._genai_response(chunk)
                if response is None:
                    continue
                async for llm_response in aggregator.process_response(response):
                    yield llm_response
            final = aggregator.close()
            if final is not None:
                if final.usage_metadata is None and trailing_usage is not None:
                    final.usage_metadata = trailing_usage
                yield final
            return

        response = await client.aio.models.generate_content(
            model=self.model,
            contents=llm_request.contents,
            config=self._request_config(llm_request.config),
        )
        yield LlmResponse(
            model_version=self._model_version(response),
            content=self._content(text=response.text, function_calls=response.function_calls),
            usage_metadata=self._usage_metadata(response),
            partial=False,
            turn_complete=True,
        )
