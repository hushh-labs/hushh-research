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

from .factory import build_runtime_client


class ProviderAdkModel(BaseLlm):
    """Expose one existing native provider transport as an ADK ``BaseLlm``."""

    provider: str
    credential: str
    device_id: str | None = None

    @staticmethod
    def _parts(*, text: str = "", function_calls: Any = ()) -> list[types.Part]:
        parts: list[types.Part] = []
        if text:
            parts.append(types.Part.from_text(text=text))
        for call in function_calls or ():
            parts.append(
                types.Part(
                    function_call=types.FunctionCall(
                        id=call.id or None,
                        name=call.name,
                        args=call.args,
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
        )

    def _client(self) -> Any:
        return build_runtime_client(
            self.provider,
            self.credential,
            puppy_device_id=self.device_id,
        )

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        client = self._client()
        if stream:
            aggregator = StreamingResponseAggregator()
            chunks = await client.aio.models.generate_content_stream(
                model=self.model,
                contents=llm_request.contents,
                config=llm_request.config,
            )
            async for chunk in chunks:
                response = self._genai_response(chunk)
                if response is None:
                    continue
                async for llm_response in aggregator.process_response(response):
                    yield llm_response
            final = aggregator.close()
            if final is not None:
                yield final
            return

        response = await client.aio.models.generate_content(
            model=self.model,
            contents=llm_request.contents,
            config=llm_request.config,
        )
        yield LlmResponse(
            model_version=self._model_version(response),
            content=self._content(text=response.text, function_calls=response.function_calls),
            partial=False,
            turn_complete=True,
        )
