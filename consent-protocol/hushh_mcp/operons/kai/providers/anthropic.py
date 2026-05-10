# hushh_mcp/operons/kai/providers/anthropic.py
"""
Anthropic provider for Kai.

Uses the official `anthropic` SDK (anthropic==0.96.0 already in
requirements.txt).
"""

from __future__ import annotations

import asyncio
import os
from typing import AsyncIterator, Optional

from .base import CompletionRequest, CompletionResponse, LLMProvider, Role, StreamEvent
from .errors import ProviderError, ProviderResponseInvalid, ProviderTimeout, ProviderUnavailable

try:
    from anthropic import AsyncAnthropic  # type: ignore
    from anthropic import APIError, APITimeoutError  # type: ignore

    _ANTHROPIC_AVAILABLE = True
except ImportError:  # pragma: no cover
    _ANTHROPIC_AVAILABLE = False
    AsyncAnthropic = None  # type: ignore
    APIError = Exception  # type: ignore
    APITimeoutError = TimeoutError  # type: ignore


class AnthropicProvider(LLMProvider):
    """Anthropic Messages API provider."""

    name = "anthropic"
    kind = "cloud"

    def __init__(
        self,
        model: str = "claude-3-5-sonnet-latest",
        api_key_env: str = "ANTHROPIC_API_KEY",
    ) -> None:
        self.default_model = model
        self._api_key_env = api_key_env
        self._client: Optional[AsyncAnthropic] = None  # type: ignore[assignment]

    def is_ready(self) -> tuple[bool, Optional[str]]:
        if not _ANTHROPIC_AVAILABLE:
            return False, "anthropic SDK not installed"
        if not os.getenv(self._api_key_env):
            return False, f"missing env var {self._api_key_env}"
        return True, None

    def _get_client(self) -> "AsyncAnthropic":
        if self._client is None:
            self._client = AsyncAnthropic(api_key=os.getenv(self._api_key_env))  # type: ignore[call-arg]
        return self._client

    async def complete(self, request: CompletionRequest) -> CompletionResponse:
        ready, why = self.is_ready()
        if not ready:
            raise ProviderUnavailable(why or "Anthropic not ready", provider=self.name)

        # Anthropic separates system from messages; partition explicitly.
        # Seed system_text from system_instruction ONLY when explicit messages
        # are present. When messages=() is empty, synthesized_messages() builds
        # the SYSTEM block from system_instruction, so we'd double-count.
        system_text: Optional[str] = (
            request.system_instruction if request.messages else None
        )
        msgs = []
        for m in request.synthesized_messages():
            if m.role == Role.SYSTEM:
                # already captured above; if multiple SYSTEM messages, concat
                system_text = (system_text + "\n\n" + m.content) if system_text else m.content
                continue
            msgs.append({"role": _role_str(m.role), "content": m.content})

        # Anthropic requires at least one user message.
        if not msgs:
            msgs = [{"role": "user", "content": request.prompt or ""}]

        client = self._get_client()
        try:
            resp = await asyncio.wait_for(
                client.messages.create(
                    model=self.default_model,
                    max_tokens=request.max_output_tokens,
                    temperature=request.temperature,
                    system=system_text or "",
                    messages=msgs,
                ),
                timeout=request.timeout_seconds,
            )
        except APITimeoutError as exc:  # type: ignore[misc]
            raise ProviderTimeout(str(exc), provider=self.name) from exc
        except asyncio.TimeoutError as exc:
            raise ProviderTimeout(
                f"Anthropic call exceeded {request.timeout_seconds}s", provider=self.name
            ) from exc
        except APIError as exc:  # type: ignore[misc]
            raise ProviderError(f"Anthropic API error: {exc}", provider=self.name) from exc
        except Exception as exc:  # noqa: BLE001
            raise ProviderError(
                f"Anthropic call failed: {exc.__class__.__name__}: {exc}",
                provider=self.name,
            ) from exc

        text = "".join(
            block.text for block in (resp.content or []) if getattr(block, "type", "") == "text"
        ).strip()
        if not text:
            raise ProviderResponseInvalid("Anthropic returned no text blocks", provider=self.name)

        usage: dict[str, int] = {}
        usage_obj = getattr(resp, "usage", None)
        if usage_obj is not None:
            for field in ("input_tokens", "output_tokens"):
                val = getattr(usage_obj, field, None)
                if isinstance(val, int):
                    usage[field] = val

        return CompletionResponse(
            text=text,
            provider=self.name,
            model=self.default_model,
            finish_reason=getattr(resp, "stop_reason", None),
            usage=usage,
        )

    async def stream(self, request: CompletionRequest) -> AsyncIterator[StreamEvent]:
        ready, why = self.is_ready()
        if not ready:
            yield StreamEvent(type="error", text=why or "Anthropic not ready")
            return

        client = self._get_client()
        # Reuse the partitioning logic from complete().
        # Seed system_text from system_instruction ONLY when explicit messages
        # are present. When messages=() is empty, synthesized_messages() builds
        # the SYSTEM block from system_instruction, so we'd double-count.
        system_text: Optional[str] = (
            request.system_instruction if request.messages else None
        )
        msgs = []
        for m in request.synthesized_messages():
            if m.role == Role.SYSTEM:
                system_text = (system_text + "\n\n" + m.content) if system_text else m.content
                continue
            msgs.append({"role": _role_str(m.role), "content": m.content})
        if not msgs:
            msgs = [{"role": "user", "content": request.prompt or ""}]

        full: list[str] = []
        try:
            async with client.messages.stream(
                model=self.default_model,
                max_tokens=request.max_output_tokens,
                temperature=request.temperature,
                system=system_text or "",
                messages=msgs,
            ) as stream:
                async for delta in stream.text_stream:
                    full.append(delta)
                    yield StreamEvent(type="token", text=delta)
        except Exception as exc:  # noqa: BLE001
            yield StreamEvent(type="error", text=f"{exc.__class__.__name__}: {exc}")
            return

        yield StreamEvent(type="complete", text="".join(full))


def _role_str(role: Role) -> str:
    if role == Role.ASSISTANT:
        return "assistant"
    return "user"
