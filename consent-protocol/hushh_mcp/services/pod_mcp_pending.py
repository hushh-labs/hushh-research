"""Deletable owner-encrypted native MCP recovery, never dispatch authority."""

from __future__ import annotations

import secrets
from collections.abc import Callable
from copy import deepcopy
from datetime import UTC, datetime
from typing import Any, Protocol, TypeVar

from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError

_T = TypeVar("_T")


class PrivatePendingStorage(Protocol):
    owner: str

    async def read(self) -> tuple[dict[str, Any], str]: ...

    async def change(self, mutate: Callable[[dict[str, Any]], _T]) -> _T: ...


def _current(value: dict) -> bool:
    try:
        expires = datetime.fromisoformat(value["expires_at"])
        return expires.tzinfo is not None and expires > datetime.now(UTC)
    except (ValueError, TypeError, KeyError):
        return False


class PodMcpPendingStore:
    def __init__(self, storage: PrivatePendingStorage):
        self.storage = storage

    async def save(self, payload: dict) -> str:
        if payload.get("owner") != self.storage.owner or not _current(payload):
            raise ActionDirectiveAuthorityError("Private connector review expired.")
        handle = "one_secret_ref:" + secrets.token_urlsafe(24)

        def save(values):
            expired = [
                key
                for key, value in values.items()
                if not isinstance(value, dict) or not _current(value)
            ]
            for key in expired:
                values.pop(key)
            values[handle] = deepcopy(payload)

        await self.storage.change(save)
        return handle

    async def details(self, session, handle: str) -> dict:
        from hushh_mcp.one_adk.mcp_pending_call import _require_pending_binding

        values, _ = await self.storage.read()
        pending = values.get(handle)
        if not isinstance(pending, dict) or not _current(pending):
            raise ActionDirectiveAuthorityError("Private connector review expired.")
        return deepcopy(_require_pending_binding(session, pending))

    async def for_call(self, session, call_id: str, tool_name: str) -> tuple[str, dict] | None:
        from hushh_mcp.one_adk.mcp_pending_call import _require_pending_binding

        values, _ = await self.storage.read()
        matches = [
            (handle, value)
            for handle, value in values.items()
            if isinstance(value, dict)
            and _current(value)
            and value.get("owner") == session.user_id
            and value.get("thread") == session.id
            and value.get("call_id") == call_id
            and value.get("tool_name") == tool_name
        ]
        if len(matches) > 1:
            raise ActionDirectiveAuthorityError("Private connector recovery is ambiguous.")
        if not matches:
            return None
        handle, pending = matches[0]
        return handle, deepcopy(_require_pending_binding(session, pending))

    async def replace_review(self, session, handle: str, *, expected: dict, review: dict) -> dict:
        from hushh_mcp.one_adk.mcp_pending_call import _require_pending_binding

        def replace(values):
            pending = values.get(handle)
            if not isinstance(pending, dict) or not _current(pending):
                raise ActionDirectiveAuthorityError("Private connector review expired.")
            _require_pending_binding(session, pending)
            if pending.get("review") != expected:
                raise ActionDirectiveAuthorityError("Private connector review changed.")
            # Never extend the captured absolute deadline or alter private arguments.
            if review.get("expiresAt") != expected.get("expiresAt"):
                raise ActionDirectiveAuthorityError("Private connector expiry changed.")
            pending["review"] = deepcopy(review)
            pending.pop("rebind", None)
            return deepcopy(pending)

        return await self.storage.change(replace)

    async def begin_rebind(self, session, handle: str, *, expected: dict, target: dict) -> dict:
        from hushh_mcp.one_adk.mcp_pending_call import _require_pending_binding

        def begin(values):
            pending = values.get(handle)
            if not isinstance(pending, dict) or not _current(pending):
                raise ActionDirectiveAuthorityError("Private connector review expired.")
            _require_pending_binding(session, pending)
            if pending.get("review") != expected:
                raise ActionDirectiveAuthorityError("Private connector review changed.")
            intent = {"previous": deepcopy(expected), "target": deepcopy(target)}
            if pending.get("rebind") not in (None, intent):
                raise ActionDirectiveAuthorityError(
                    "Reconcile the previous connector recovery first."
                )
            pending["rebind"] = intent
            return deepcopy(pending)

        return await self.storage.change(begin)

    async def discard(self, session, handle: str) -> None:
        from hushh_mcp.one_adk.mcp_pending_call import _require_pending_binding

        def discard(values):
            pending = values.get(handle)
            if pending is None:
                return
            _require_pending_binding(session, pending)
            values.pop(handle)

        await self.storage.change(discard)
