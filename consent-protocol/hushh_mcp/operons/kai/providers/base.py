# hushh_mcp/operons/kai/providers/base.py
"""
Abstract LLM provider contract used by Kai's debate engine.

Every concrete provider (Gemini, OpenAI, Anthropic, vLLM, llama.cpp)
implements this contract. The contract is intentionally narrow:
text-in, text-out, optional JSON mime type, optional streaming.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, AsyncIterator, Mapping, Optional


class Role(str, Enum):
    """Canonical role tags. Provider adapters translate to native shapes."""

    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"


@dataclass(frozen=True)
class Message:
    """A single turn in a chat-style prompt."""

    role: Role
    content: str


@dataclass(frozen=True)
class CompletionRequest:
    """
    Canonical inference request.

    Notes
    -----
    `prompt` is preserved as a single string for backward-compat with the
    existing Gemini operon (which calls `_generate_content_text(prompt=...)`).
    Providers that prefer chat-style turns synthesize them from
    (system_instruction, prompt) when `messages` is empty.

    `response_mime_type` mirrors the Gemini config field. Providers that
    don't support a JSON mode emulate it by injecting an instruction.
    """

    prompt: str = ""
    messages: tuple[Message, ...] = field(default_factory=tuple)
    system_instruction: Optional[str] = None
    temperature: float = 0.0
    max_output_tokens: int = 16384
    timeout_seconds: float = 60.0
    response_mime_type: Optional[str] = None
    extra: Mapping[str, Any] = field(default_factory=dict)

    def synthesized_messages(self) -> tuple[Message, ...]:
        """Build a chat-style message list when `messages` is not provided."""
        if self.messages:
            return self.messages
        out: list[Message] = []
        if self.system_instruction:
            out.append(Message(role=Role.SYSTEM, content=self.system_instruction))
        if self.prompt:
            out.append(Message(role=Role.USER, content=self.prompt))
        return tuple(out)


@dataclass(frozen=True)
class CompletionResponse:
    """Canonical inference response."""

    text: str
    provider: str
    model: str
    finish_reason: Optional[str] = None
    usage: Mapping[str, int] = field(default_factory=dict)
    raw: Optional[Any] = None  # provider-native object, never logged


@dataclass(frozen=True)
class StreamEvent:
    """One event from a streaming provider.

    type='token'    -> partial text chunk in `text`
    type='complete' -> end of stream; full text in `text`
    type='error'    -> error message in `text`
    """

    type: str
    text: str = ""
    metadata: Mapping[str, Any] = field(default_factory=dict)


class LLMProvider(abc.ABC):
    """Provider contract. Subclasses MUST be safe to construct without creds."""

    #: Stable provider identifier used in scope strings and audit metadata.
    name: str = "abstract"

    #: 'cloud' or 'private'. Drives the scope family.
    kind: str = "cloud"

    #: Human-readable model identifier returned in CompletionResponse.model
    default_model: str = ""

    @abc.abstractmethod
    async def complete(self, request: CompletionRequest) -> CompletionResponse:
        """Run a single non-streaming completion."""

    @abc.abstractmethod
    async def stream(self, request: CompletionRequest) -> AsyncIterator[StreamEvent]:
        """Stream a completion as StreamEvent items."""

    @abc.abstractmethod
    def is_ready(self) -> tuple[bool, Optional[str]]:
        """
        Return (ready, reason_if_not_ready).

        Providers MUST be importable and constructable even if creds are
        missing; readiness is checked at dispatch time, not import time.
        """
