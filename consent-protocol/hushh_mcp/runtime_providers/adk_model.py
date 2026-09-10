"""ADK model adapter for the existing provider transports.

The pod's One runner owns orchestration and tools. This adapter only translates
the ADK model call into the provider-neutral transport facade and translates the
answer back into ADK responses; it never executes tools or selects a provider.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from typing import Any

from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types

from .factory import build_runtime_client


class ProviderAdkModel(BaseLlm):
    """Expose one existing native provider transport as an ADK ``BaseLlm``."""

    provider: str
    credential: str
    device_id: str | None = None

    @staticmethod
    def _content(*, text: str = "", function_calls: Any = ()) -> types.Content | None:
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
        return types.Content(role="model", parts=parts) if parts else None

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
            chunks = await client.aio.models.generate_content_stream(
                model=self.model,
                contents=llm_request.contents,
                config=llm_request.config,
            )
            async for chunk in chunks:
                if chunk.text or chunk.function_calls:
                    yield LlmResponse(
                        model_version=self.model,
                        content=self._content(
                            text=chunk.text,
                            function_calls=chunk.function_calls,
                        ),
                        partial=True,
                    )
            yield LlmResponse(model_version=self.model, partial=False, turn_complete=True)
            return

        response = await client.aio.models.generate_content(
            model=self.model,
            contents=llm_request.contents,
            config=llm_request.config,
        )
        yield LlmResponse(
            model_version=self.model,
            content=self._content(text=response.text, function_calls=response.function_calls),
            partial=False,
            turn_complete=True,
        )
