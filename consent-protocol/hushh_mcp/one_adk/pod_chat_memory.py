"""Adapt Firebase-keyed chat to the existing single-owner pod memory authority."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from google.adk.memory.base_memory_service import BaseMemoryService

logger = logging.getLogger(__name__)
_memory_replay: tuple[Any, Any] | None = None
_WIKI_HYGIENE_MIN_INTERVAL_SECONDS = 300.0
_LAST_WIKI_HYGIENE_AT: dict[str, float] = {}


class PodChatMemory(BaseMemoryService):
    def __init__(self, context: Any, service: Any, *, wiki_library: Any = None) -> None:
        self.context, self.service = context, service
        self.wiki_library = wiki_library
        self._prior_event_ids: set[str] = set()

    async def search_memory(self, *, app_name: str, user_id: str, query: str):
        if user_id != self.context.owner:
            raise PermissionError("Pod memory owner mismatch.")
        await self.context.require_access()
        if self.service is None:
            from google.adk.memory.base_memory_service import SearchMemoryResponse

            return SearchMemoryResponse(memories=[])
        result = await self.service.search_memory(
            app_name=app_name, user_id=self.context.hushh_id, query=query
        )
        await self.context.require_access()
        return result

    async def _add_session_to_memory_with_status(self, session) -> bool:
        if session.user_id != self.context.owner:
            raise PermissionError("Pod memory owner mismatch.")
        if self.service is None:
            return False
        from hushh_mcp.one_adk.account_context_contract import (
            PRIVATE_ACCOUNT_ANSWER,
            account_private_invocations,
        )
        from hushh_mcp.one_adk.consent_redaction import tagged_bundles

        await self.context.require_access()
        # Consent-derived turns remain in grant-aware conversation recovery;
        # ordinary durable memory loses that lineage and must not ingest them.
        tagged = {
            invocation for ids in tagged_bundles(session.state).values() for invocation in ids
        }
        tagged |= account_private_invocations(session.state, session.events)
        events = [
            event
            for event in session.events
            if event.invocation_id not in tagged
            and (not tagged or event.invocation_id)
            and not (
                event.author == "one"
                and any(
                    getattr(part, "text", None) == PRIVATE_ACCOUNT_ANSWER
                    for part in (getattr(event.content, "parts", None) or [])
                )
            )
        ]
        if not events:
            return False
        await self.service.add_session_to_memory(
            session.model_copy(update={"user_id": self.context.hushh_id, "events": events})
        )
        return True

    async def add_session_to_memory(self, session) -> None:
        await self._add_session_to_memory_with_status(session)

    async def prepare(self, input, *, model: Any, provider: str, model_id: str) -> None:
        from api.routes.one.pod_memory import review_policy_for_session
        from hushh_mcp.one_adk.agent_tree import (
            ONE_APP_NAME,
            STATE_MEMORY_AVAILABLE,
            STATE_MEMORY_DIGEST,
        )
        from hushh_mcp.one_adk.text_runtime import _catch_up_memory_review, _memory_digest
        from hushh_mcp.one_adk.wiki_recall_tools import (
            STATE_WIKI_HOT_DIGEST,
            build_wiki_hot_digest_context,
            is_wiki_serving_primary,
            read_fenced_pod_wiki_hot_digest,
            read_pod_wiki_migration_state,
        )

        await self.context.require_access()
        previous = await self.context.sessions.get_session(
            app_name=ONE_APP_NAME, user_id=self.context.owner, session_id=input.thread_id
        )
        self._prior_event_ids = {event.id for event in previous.events} if previous else set()
        if self.service is not None:
            await _catch_up_memory_review(
                memory_service=self.service,
                model=model,
                runtime_provider=provider,
                runtime_model=model_id,
                session_owner_id=self.context.hushh_id,
                review_policy=review_policy_for_session(self.context.claims),
            )
            await self.context.require_access()

        wiki_hot = await read_fenced_pod_wiki_hot_digest()
        if not wiki_hot and self.wiki_library is not None:
            try:
                wiki_hot = await build_wiki_hot_digest_context(self.wiki_library)
            except Exception as exc:
                logger.warning("pod_chat.wiki_digest_failed kind=%s", type(exc).__name__)
        migration_state = await read_pod_wiki_migration_state(self.wiki_library)
        suppress_classic = bool(wiki_hot) and is_wiki_serving_primary(migration_state)

        if self.service is not None and not suppress_classic:
            input.state[STATE_MEMORY_AVAILABLE] = True
            input.state[STATE_MEMORY_DIGEST] = await _memory_digest(self.service)
        else:
            input.state[STATE_MEMORY_AVAILABLE] = False
            input.state[STATE_MEMORY_DIGEST] = ""

        if wiki_hot:
            input.state[STATE_WIKI_HOT_DIGEST] = wiki_hot

    async def commit(self, input) -> bool:
        import hashlib
        import time

        from hushh_mcp.one_adk.agent_tree import ONE_APP_NAME
        from hushh_mcp.one_adk.rolling_horizon import persist_rolling_horizon_post_turn

        await self.context.require_access()
        session = await self.context.sessions.get_session(
            app_name=ONE_APP_NAME, user_id=self.context.owner, session_id=input.thread_id
        )
        if session is None:
            raise RuntimeError("Pod conversation recovery unavailable.")

        # 1. Silently distill older turns beyond the verbatim horizon into encrypted state
        try:
            await persist_rolling_horizon_post_turn(
                self.context.sessions,
                app_name=ONE_APP_NAME,
                user_id=self.context.owner,
                session_id=input.thread_id,
                session=session,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("pod_chat.rolling_horizon_failed kind=%s", type(exc).__name__)

        new_events = [event for event in session.events if event.id not in self._prior_event_ids]
        session = session.model_copy(update={"events": new_events})
        # The existing memory service owns extraction and provider consent.
        # No second memory store or synthetic owner capability is introduced.
        wrote = False
        try:
            wrote = await self._add_session_to_memory_with_status(session)
        except Exception as exc:
            logger.warning("pod_chat.memory_write_failed kind=%s", type(exc).__name__)
            wrote = False

        # 2. Continuous bounded background wiki hygiene (grant-pinned deduplication & link/digest refresh)
        # Throttle hygiene sweeps so rapid conversational turns never flood storage with redundant scans.
        now_mono = time.monotonic()
        last_hyg = _LAST_WIKI_HYGIENE_AT.get(self.context.owner)
        hygiene_due = (
            last_hyg is None or (now_mono - last_hyg) >= _WIKI_HYGIENE_MIN_INTERVAL_SECONDS
        )
        if new_events and self.wiki_library is not None and hygiene_due:
            _LAST_WIKI_HYGIENE_AT[self.context.owner] = now_mono
            try:
                from hushh_mcp.services.pod_files.runtime import (
                    require_files_access,
                    wiki_operation,
                )
                from hushh_mcp.services.wiki_memory import (
                    WikiMaintenanceRunner,
                    resolve_owner_protected_grant_scopes,
                )

                protected = await resolve_owner_protected_grant_scopes(self.context.owner)
                await require_files_access(manage=True)
                async with wiki_operation(mutation=True) as wiki:
                    seed = f"bg_hyg:{self.context.owner}:{input.thread_id}:{int(time.time() // 60)}"
                    idem = f"hyg_{hashlib.sha256(seed.encode('utf-8')).hexdigest()[:24]}"
                    await WikiMaintenanceRunner(wiki).run_tick(
                        idempotency_key=idem,
                        max_pages_per_tick=4,
                        protected_scopes=protected,
                    )
            except Exception:  # noqa: BLE001 - continuous hygiene never fails a completed turn
                pass

        return wrote


async def build_memory_hooks(
    context: Any, *, owner_model: Any, provider: str, model: str
) -> tuple[PodChatMemory | None, Callable[[Any], Awaitable[None]]]:
    from hushh_mcp.one_adk.text_runtime import _resolve_pod_memory_service
    from hushh_mcp.services.pod_memory_replay import PodMemoryReplay

    global _memory_replay
    if _memory_replay is None or _memory_replay[0] is not context.authority:
        _memory_replay = (
            context.authority,
            getattr(context.authority, "recovery_projection", None)
            or PodMemoryReplay(owner=context.hushh_id, incarnation=context.authority.epoch),
        )
    service = await asyncio.to_thread(
        _resolve_pod_memory_service, replay_projection=_memory_replay[1]
    )
    from hushh_mcp.one_adk.wiki_recall_tools import optional_pod_wiki_library

    wiki_lib = optional_pod_wiki_library()
    memory = (
        PodChatMemory(context, service, wiki_library=wiki_lib)
        if (service is not None or wiki_lib is not None)
        else None
    )

    async def prepare(input):
        if memory is not None:
            await memory.prepare(input, model=owner_model, provider=provider, model_id=model)

    return memory, prepare
