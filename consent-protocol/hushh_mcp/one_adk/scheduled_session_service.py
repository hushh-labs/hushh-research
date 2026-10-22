"""ADK task sessions in the owner's sealed schedule, without a chat key.

The live session retains transient authority and tool output in memory. Its
bounded recovery projection carries native event identity/confirmation markers,
never request credentials, raw connector results or provider configuration.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from google.adk.events import Event
from google.adk.sessions import BaseSessionService, Session
from google.adk.sessions.base_session_service import GetSessionConfig, ListSessionsResponse
from google.genai import types

from hushh_mcp.one_adk.scheduled_session_projection import (
    pending_confirmations,
    task_session_projection,
)
from hushh_mcp.services.pod_scheduled_continuation import ScheduledTaskCheckpointStorage
from hushh_mcp.services.pod_scheduled_contracts import ScheduleRefused


class ScheduledSessionService(BaseSessionService):
    def __init__(self, storage: ScheduledTaskCheckpointStorage):
        self.storage = storage
        self._live: Session | None = None
        self._durable: dict | None = None

    def _identity(self, app: str, user: str, session: str) -> None:
        if (app, user, session) != ("hussh_one", self.storage.owner, self.storage.session_id):
            raise ScheduleRefused("SCHEDULE_SESSION_OWNER_REFUSED")

    async def create_session(
        self,
        *,
        app_name: str,
        user_id: str,
        state: dict[str, Any] | None = None,
        session_id: str | None = None,
    ) -> Session:
        self._identity(app_name, user_id, session_id or "")
        checkpoint, _ = await self.storage.checkpoint()
        if checkpoint.session is not None:
            raise ScheduleRefused("SCHEDULE_SESSION_ALREADY_EXISTS")
        session = Session(
            id=session_id or "", app_name=app_name, user_id=user_id, state=deepcopy(state or {})
        )
        projection = task_session_projection(session, self.storage.invocation_id)
        await self.storage.save_session(projection, expected_session=None)
        self._durable = projection
        self._live = session
        return session

    async def get_session(
        self,
        *,
        app_name: str,
        user_id: str,
        session_id: str,
        config: GetSessionConfig | None = None,
    ) -> Session | None:
        self._identity(app_name, user_id, session_id)
        checkpoint, _ = await self.storage.checkpoint()
        if checkpoint.session is None:
            return None
        if self._live is None:
            try:
                restored = Session.model_validate(checkpoint.session)
            except (ValueError, TypeError):
                raise ScheduleRefused("SCHEDULE_SESSION_CHECKPOINT_INVALID") from None
            if task_session_projection(restored, self.storage.invocation_id) != checkpoint.session:
                raise ScheduleRefused("SCHEDULE_SESSION_CHECKPOINT_INVALID")
            self._live = restored
            self._durable = deepcopy(checkpoint.session)
        return self._live

    async def restore_pending(self, handle: str) -> Session:
        from hushh_mcp.one_adk.mcp_pending_call import restore_pending_call

        checkpoint, _ = await self.storage.checkpoint()
        if checkpoint.phase not in {"running", "needs_review"}:
            raise ScheduleRefused("SCHEDULE_DISPATCH_OUTCOME_UNCERTAIN")
        session = await self.get_session(
            app_name="hussh_one", user_id=self.storage.owner, session_id=self.storage.session_id
        )
        if session is None:
            raise ScheduleRefused("SCHEDULE_SESSION_NOT_FOUND")
        self._live = await restore_pending_call(session, handle)
        return self._live

    async def confirmation_message(
        self,
        handle: str,
        confirmation_id: str,
        *,
        confirmed: bool,
    ) -> types.Content:
        checkpoint, _ = await self.storage.checkpoint()
        if checkpoint.session is None or checkpoint.phase not in {"running", "needs_review"}:
            raise ScheduleRefused("SCHEDULE_NATIVE_CONFIRMATION_CHANGED")
        references = pending_confirmations(
            checkpoint.session, checkpoint.pending, self.storage.invocation_id
        )
        if references.get(handle) != confirmation_id or type(confirmed) is not bool:
            raise ScheduleRefused("SCHEDULE_NATIVE_CONFIRMATION_CHANGED")
        return types.Content(
            role="user",
            parts=[
                types.Part(
                    function_response=types.FunctionResponse(
                        id=confirmation_id,
                        name="adk_request_confirmation",
                        response={"confirmed": confirmed},
                    )
                )
            ],
        )

    async def list_sessions(
        self, *, app_name: str, user_id: str | None = None
    ) -> ListSessionsResponse:
        session = await self.get_session(
            app_name=app_name, user_id=user_id or "", session_id=self.storage.session_id
        )
        return ListSessionsResponse(sessions=[session] if session is not None else [])

    async def delete_session(self, *, app_name: str, user_id: str, session_id: str) -> None:
        self._identity(app_name, user_id, session_id)
        # Account erasure owns removal of the sealed log. Deleting a live
        # checkpoint must not make a pending/uncertain effect replayable.
        raise ScheduleRefused("SCHEDULE_SESSION_DELETE_REQUIRES_TASK_CANCELLATION")

    async def append_event(self, session: Session, event: Event) -> Event:
        self._identity(session.app_name, session.user_id, session.id)
        if self._live is not session:
            raise ScheduleRefused("SCHEDULE_SESSION_CHANGED")
        if event.invocation_id != self.storage.invocation_id:
            raise ScheduleRefused("SCHEDULE_SESSION_INVOCATION_CHANGED")
        if event.partial:
            await self.storage.checkpoint()
            return event
        candidate = session.model_copy(deep=True)
        persisted = await super().append_event(candidate, event.model_copy(deep=True))
        projection = task_session_projection(candidate, self.storage.invocation_id)
        checkpoint, _ = await self.storage.checkpoint()
        settled = None
        if checkpoint.phase == "dispatching":
            pending = checkpoint.pending.get(checkpoint.dispatch_handle or "", {})
            for response in event.get_function_responses():
                if (response.id, response.name) == (
                    pending.get("call_id"),
                    pending.get("tool_name"),
                ):
                    if (response.response or {}).get("error") or (response.response or {}).get(
                        "isError"
                    ):
                        raise ScheduleRefused("SCHEDULE_DISPATCH_OUTCOME_UNCERTAIN")
                    if not response.id or not response.name:
                        raise ScheduleRefused("SCHEDULE_DISPATCH_RECEIPT_CHANGED")
                    settled = (response.id, response.name)
        await self.storage.save_session(
            projection, expected_session=self._durable, settled_call=settled
        )
        self._durable = projection
        # Publish only after the sealed record's CAS succeeds. Preserve the
        # original live object expected by the native Runner.
        session.state.clear()
        session.state.update(candidate.state)
        session.events[:] = candidate.events
        session.last_update_time = max(session.last_update_time, event.timestamp)
        return persisted
