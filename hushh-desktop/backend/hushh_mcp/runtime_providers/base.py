"""Provider transport base + genai-client-shaped facade.

Each native adapter implements two coroutines over a neutral request:

* ``_generate(request, model)`` -> ``NormalizedResponse``
* ``_stream(request, model)`` -> async iterator of ``NormalizedChunk``

The base wraps those behind the exact surface ``AgentChatService`` calls on a
``genai.Client``:

    client.aio.models.generate_content(model=..., contents=..., config=...)
    client.aio.models.generate_content_stream(model=..., contents=..., config=...)

so the chat service, voice lanes, and subagents never branch on provider.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, AsyncIterator

from .normalized import NormalizedChunk, NormalizedResponse
from .translate import NeutralRequest, to_neutral_request


class ProviderTransport(ABC):
    """Native transport adapter for a non-Gemini provider."""

    provider: str

    @abstractmethod
    async def _generate(self, request: NeutralRequest, *, model: str) -> NormalizedResponse:
        """Run a single, complete generation."""

    @abstractmethod
    def _stream(self, request: NeutralRequest, *, model: str) -> AsyncIterator[NormalizedChunk]:
        """Run a streaming generation, yielding normalized chunks."""

    # -- genai-client-shaped facade ------------------------------------------------

    @property
    def aio(self) -> "_AsyncNamespace":
        return _AsyncNamespace(self)


class _AsyncModels:
    def __init__(self, transport: ProviderTransport):
        self._transport = transport

    async def generate_content(
        self, *, model: str, contents: Any, config: Any = None
    ) -> NormalizedResponse:
        request = to_neutral_request(contents, config)
        return await self._transport._generate(request, model=model)

    async def generate_content_stream(
        self, *, model: str, contents: Any, config: Any = None
    ) -> AsyncIterator[NormalizedChunk]:
        request = to_neutral_request(contents, config)
        return self._transport._stream(request, model=model)


class _AsyncNamespace:
    def __init__(self, transport: ProviderTransport):
        self.models = _AsyncModels(transport)
