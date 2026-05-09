# hushh_mcp/operons/kai/providers/gemini.py
"""
Gemini provider.

Delegates to the existing Gemini path in `hushh_mcp/operons/kai/llm.py`
so behavior is byte-for-byte unchanged when the registry routes to
`gemini`. This is intentional -- the refactor is purely additive.
"""

from __future__ import annotations

from typing import AsyncIterator, Optional

from hushh_mcp.constants import GEMINI_MODEL
from hushh_mcp.operons.kai import llm as _llm

from .base import CompletionRequest, CompletionResponse, LLMProvider, StreamEvent
from .errors import ProviderError, ProviderUnavailable


class GeminiProvider(LLMProvider):
    """Wraps the existing Vertex/Gemini path from llm.py."""

    name = "gemini"
    kind = "cloud"

    def __init__(self, model: Optional[str] = None) -> None:
        # Don't trigger client init here; llm.py initializes lazily on first call.
        self.default_model = model or str(GEMINI_MODEL)

    def is_ready(self) -> tuple[bool, Optional[str]]:
        ready = _llm.is_gemini_ready()
        if ready:
            return True, None
        return False, _llm.get_gemini_unavailable_reason() or "Gemini client unavailable"

    async def complete(self, request: CompletionRequest) -> CompletionResponse:
        try:
            text = await _llm._generate_content_text(  # noqa: SLF001 - stable internal API
                prompt=request.prompt,
                timeout_seconds=request.timeout_seconds,
                max_output_tokens=request.max_output_tokens,
                response_mime_type=request.response_mime_type,
            )
        except RuntimeError as exc:
            raise ProviderUnavailable(str(exc), provider=self.name) from exc
        except Exception as exc:  # noqa: BLE001
            raise ProviderError(
                f"Gemini call failed: {exc.__class__.__name__}: {exc}",
                provider=self.name,
            ) from exc
        return CompletionResponse(
            text=text,
            provider=self.name,
            model=self.default_model,
            finish_reason="stop",
        )

    async def stream(self, request: CompletionRequest) -> AsyncIterator[StreamEvent]:
        # Bridge llm.stream_gemini_response into our StreamEvent shape.
        async for event in _llm.stream_gemini_response(
            prompt=request.prompt,
            timeout=request.timeout_seconds,
        ):
            etype = event.get("type", "token")
            text = str(event.get("text") or event.get("message") or "")
            yield StreamEvent(type=etype, text=text)
