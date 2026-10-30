"""genai-shaped normalized response objects.

``AgentChatService`` consumes provider output through a narrow contract:

* streaming chunks expose ``.text`` (or ``.candidates[].content.parts[].text``)
* full responses expose ``.function_calls`` (list of objects with ``.name``,
  ``.args`` dict, ``.id``) or the same shape nested under
  ``.candidates[].content.parts[].function_call``

Native adapters translate provider SDK output into these objects so the rest
of the runtime never branches on provider.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class NormalizedFunctionCall:
    name: str
    args: dict[str, Any] = field(default_factory=dict)
    id: str = ""


@dataclass(frozen=True)
class NormalizedPart:
    text: str | None = None
    function_call: NormalizedFunctionCall | None = None


@dataclass(frozen=True)
class NormalizedContent:
    role: str = "model"
    parts: tuple[NormalizedPart, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class NormalizedCandidate:
    content: NormalizedContent


@dataclass(frozen=True)
class NormalizedChunk:
    """A streaming delta. ``text`` mirrors genai's top-level chunk text."""

    text: str = ""

    @property
    def candidates(self) -> tuple[NormalizedCandidate, ...]:
        if not self.text:
            return ()
        return (
            NormalizedCandidate(content=NormalizedContent(parts=(NormalizedPart(text=self.text),))),
        )


@dataclass(frozen=True)
class NormalizedResponse:
    """A complete (non-streaming) response."""

    text: str = ""
    function_calls: tuple[NormalizedFunctionCall, ...] = field(default_factory=tuple)

    @property
    def candidates(self) -> tuple[NormalizedCandidate, ...]:
        parts: list[NormalizedPart] = []
        if self.text:
            parts.append(NormalizedPart(text=self.text))
        for call in self.function_calls:
            parts.append(NormalizedPart(function_call=call))
        if not parts:
            return ()
        return (NormalizedCandidate(content=NormalizedContent(parts=tuple(parts))),)
