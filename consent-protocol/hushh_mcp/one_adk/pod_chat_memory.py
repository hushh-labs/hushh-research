"""Adapt Firebase-keyed chat to the existing single-owner pod memory authority."""

from __future__ import annotations

import logging
from typing import Any

from google.adk.memory.base_memory_service import BaseMemoryService

logger = logging.getLogger(__name__)


class PodChatMemory(BaseMemoryService):
    def __init__(self, context: Any, service: Any) -> None:
        self.context, self.service = context, service
        self._prior_event_ids: set[str] = set()

    async def search_memory(self, *, app_name: str, user_id: str, query: str):
        if user_id != self.context.owner:
            raise PermissionError("Pod memory owner mismatch.")
        await self.context.require_access()
        result = await self.service.search_memory(
            app_name=app_name, user_id=self.context.hushh_id, query=query
        )
        await self.context.require_access()
        return result

    async def add_session_to_memory(self, session):
        if session.user_id != self.context.owner:
            raise PermissionError("Pod memory owner mismatch.")
        await self.context.require_access()
        await self.service.add_session_to_memory(
            session.model_copy(update={"user_id": self.context.hushh_id})
        )

    async def prepare(self, input, *, model: Any, provider: str, model_id: str) -> None:
        from api.routes.one.pod_memory import review_policy_for_session
        from hushh_mcp.one_adk.agent_tree import (
            ONE_APP_NAME,
            STATE_MEMORY_AVAILABLE,
            STATE_MEMORY_DIGEST,
        )
        from hushh_mcp.one_adk.text_runtime import _catch_up_memory_review, _memory_digest

        await self.context.require_access()
        previous = await self.context.sessions.get_session(
            app_name=ONE_APP_NAME, user_id=self.context.owner, session_id=input.thread_id
        )
        self._prior_event_ids = {event.id for event in previous.events} if previous else set()
        await _catch_up_memory_review(
            memory_service=self.service,
            model=model,
            runtime_provider=provider,
            runtime_model=model_id,
            session_owner_id=self.context.hushh_id,
            review_policy=review_policy_for_session(self.context.claims),
        )
        await self.context.require_access()
        input.state[STATE_MEMORY_AVAILABLE] = True
        input.state[STATE_MEMORY_DIGEST] = await _memory_digest(self.service)

    async def commit(self, input) -> None:
        from hushh_mcp.one_adk.agent_tree import ONE_APP_NAME

        await self.context.require_access()
        session = await self.context.sessions.get_session(
            app_name=ONE_APP_NAME, user_id=self.context.owner, session_id=input.thread_id
        )
        if session is None:
            raise RuntimeError("Pod conversation recovery unavailable.")
        session = session.model_copy(
            update={
                "events": [
                    event for event in session.events if event.id not in self._prior_event_ids
                ],
            }
        )
        # The existing memory service owns extraction and provider consent.
        # No second memory store or synthetic owner capability is introduced.
        try:
            await self.add_session_to_memory(session)
        except Exception as exc:
            logger.warning("pod_chat.memory_write_failed kind=%s", type(exc).__name__)
