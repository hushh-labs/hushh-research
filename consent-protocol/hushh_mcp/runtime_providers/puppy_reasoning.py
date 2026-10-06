"""Display-only reasoning deltas from the owner's local model.

A local reasoning model (Gemma 4 in LM Studio, for example) spends seconds
writing a reasoning trace before its first answer token. The device may forward
that trace as ``inference.delta`` frames carrying a ``reasoning`` string. The
trace is for the owner's eyes on their own streamed turn only:

* it never enters the model's content, the ADK session, history or memory,
  which is why it travels on this side channel rather than as a model part;
* it reaches a sink only when the streamed turn route bound one for this task,
  so a JSON turn, a hub turn or any cloud provider has nowhere to send it;
* nothing is synthesised here: no frame, no trace.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar

ReasoningSink = Callable[[str], Awaitable[None]]

_SINK: ContextVar[ReasoningSink | None] = ContextVar("puppy_reasoning_sink", default=None)


@contextmanager
def bind_reasoning_sink(sink: ReasoningSink) -> Iterator[None]:
    """Route reasoning deltas produced inside this context to ``sink``."""
    token = _SINK.set(sink)
    try:
        yield
    finally:
        _SINK.reset(token)


def reasoning_text(frame: dict[str, object]) -> str:
    """The reasoning delta a device frame carries, or empty when it carries none."""
    value = frame.get("reasoning")
    return value if isinstance(value, str) else ""


async def publish_reasoning(text: str) -> None:
    """Hand one reasoning delta to the bound sink; a no-op when none is bound."""
    sink = _SINK.get()
    if sink is None or not text:
        return
    await sink(text)


__all__ = ["bind_reasoning_sink", "publish_reasoning", "reasoning_text", "ReasoningSink"]
