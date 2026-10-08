"""Private Live identity and graceful-session memory handoff.

This is not route admission: the pod route must establish the scoped consent
binding before constructing this session. Every use rechecks that same binding.
"""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass, field
from typing import Any

from fastapi import HTTPException

from api.routes.one.pod_turn import _require_enabled, _validate_consent
from hushh_mcp.one_adk.agent_tree import ONE_APP_NAME
from hushh_mcp.services.pod_memory_service import _resolve_log

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class PodLiveSession:
    user_id: str
    hushh_id: str
    session_id: str
    consent_token: str = field(repr=False)
    data_door_grants: dict[str, str] = field(default_factory=dict, repr=False)
    _log: Any = field(default=None, init=False, repr=False, compare=False)

    async def require_access(self) -> None:
        _require_enabled()
        if (
            not self.user_id
            or not self.hushh_id
            or not self.session_id
            or self.hushh_id != (os.getenv("HUSSH_ID") or "").strip()
        ):
            raise HTTPException(status_code=403, detail="private voice owner unavailable")
        claims = await _validate_consent(self.consent_token)
        if claims.get("user_id") != self.user_id:
            raise HTTPException(status_code=403, detail="private voice owner unavailable")
        if self._log is None:
            object.__setattr__(self, "_log", await asyncio.to_thread(_resolve_log))
        if self._log is None:
            raise HTTPException(status_code=503, detail="private voice recovery unavailable")
        await self._log.require_open()


def memory_session(session: Any) -> Any:
    """Project finalized Live transcription into the existing textual memory port.

    ADK emits transcription-only events before ordinary content handling. Keep
    ordinary text unchanged, omit partial/control-only events, and never
    mutate the transient session retained by the runner. No audio blob is copied.
    """
    from google.adk.events import Event
    from google.genai import types

    events = []
    for event in session.events:
        if getattr(event, "partial", False):
            continue
        content = getattr(event, "content", None)
        texts = [
            part.text
            for part in (getattr(content, "parts", None) or [])
            if isinstance(getattr(part, "text", None), str) and part.text.strip()
        ]
        entries = []
        if texts:
            entries.append((event.author, getattr(content, "role", None) or "model", texts))
        else:
            for attribute, author in (
                ("input_transcription", "user"),
                ("output_transcription", "model"),
            ):
                transcription = getattr(event, attribute, None)
                text = getattr(transcription, "text", None)
                if isinstance(text, str) and text.strip():
                    entries.append((author, author, [text]))
        for author, role, texts in entries:
            events.append(
                Event(
                    author=author,
                    invocation_id=event.invocation_id,
                    timestamp=event.timestamp,
                    content=types.Content(
                        role=role, parts=[types.Part(text=text) for text in texts]
                    ),
                )
            )
    return session.model_copy(update={"events": events, "state": {}})


async def persist_live_session(runner: Any, private: PodLiveSession) -> bool:
    """Submit once after pumps stop, before ephemeral cleanup; never retry.

    This proves graceful-end persistence only. A process crash before submission
    can still lose the active session. Storage failure is class-only telemetry,
    never a claim that the conversation was saved.
    """
    try:
        await private.require_access()
        if runner.memory_service is None:
            raise RuntimeError("private memory unavailable")
        session = await runner.session_service.get_session(
            app_name=ONE_APP_NAME,
            user_id=private.hushh_id,
            session_id=private.session_id,
        )
        if session is None or session.user_id != private.hushh_id:
            raise RuntimeError("private session unavailable")
        projected = memory_session(session)
        if projected.events:
            await private.require_access()
            await runner.memory_service.add_session_to_memory(projected)
        return True
    except Exception as error:
        logger.warning("one_live_memory_persistence_unavailable error=%s", type(error).__name__)
        return False
