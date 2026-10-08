"""Request-scoped completion visibility; never stores message content or keys."""

import asyncio
import contextvars
from dataclasses import dataclass, field


@dataclass
class DetachWatch:
    """Whether the stream consumer left before the bridge's background run settled.

    The bridge runs the ADK turn in its own task and keeps it running after the
    client disconnects, so the turn still finishes and persists. This records
    only what the completion notice needs: the owner and the conversation id. It
    never holds message text, state or a key.
    """

    owner_id: str
    conversation_id: str
    consumer_detached: bool = False
    stopped: bool = False
    # Set once the reader either handed on the terminal event or left.
    resolved: asyncio.Event = field(default_factory=asyncio.Event)


_CURRENT_DETACH: contextvars.ContextVar[DetachWatch | None] = contextvars.ContextVar(
    "one_chat_detach_watch", default=None
)
