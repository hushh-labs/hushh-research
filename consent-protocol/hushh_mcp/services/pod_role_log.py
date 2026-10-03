"""The pod's commit log with role-aware write admission: the one place a standby refuses writes.

``resolve_pod_storage`` is the only constructor of the pod's log, and every writer --
memory, Files, config, the authority store, upgrade markers, the PKM store -- reaches
it through that call. Gating ``append`` here therefore covers every in-process writer,
including background ones that no route middleware sees (E1: the standby's log changes
only by sync import).

On a primary (and on every pod without a role object, which is every pod today) the
gate is a cached read and ``append`` behaves exactly as ``PodCommitLog.append``.
"""

from __future__ import annotations

import os
from typing import Any, Optional

from hushh_mcp.services.pod_commit_log import (
    ObjectStore,
    PodCommitLog,
    PodLogCursor,
    PodLogTampered,
)
from hushh_mcp.services.pod_role import (
    CODE_STANDBY,
    CODE_UNREADABLE,
    PodRole,
    PodRoleRefused,
    PodRoleUnreadable,
    cached_role,
    in_sync_import,
    load_role,
    remember_role,
    role_seal_key,
    store_role,
)


class RoleAwareCommitLog(PodCommitLog):
    """``PodCommitLog`` whose appends honour the pod's role, plus a cheap verified head."""

    def __init__(
        self,
        store: ObjectStore,
        seal_key: bytes,
        *,
        max_retries: int = 8,
        owner_id: Optional[str] = None,
    ) -> None:
        super().__init__(store, seal_key, max_retries=max_retries, owner_id=owner_id)
        self._role_key = role_seal_key(seal_key)

    def _hushh_id(self) -> str:
        return self._owner_id or (os.getenv("HUSSH_ID") or "").strip()

    async def read_role(self, *, fresh: bool = False) -> PodRole:
        """The role from THIS log's own store. Fails closed (``PodRoleUnreadable``)."""
        if not fresh and (hit := cached_role()) is not None:
            return hit
        role = await load_role(self._store, self._role_key, hushh_id=self._hushh_id())
        remember_role(role)
        return role

    async def write_role(self, new: PodRole) -> PodRole:
        """Compare-and-swap the role object, strictly forward in epoch."""
        return await store_role(self._store, self._role_key, new, hushh_id=self._hushh_id())

    async def append(
        self, kind: str, payload: Any, *, expected_seq: int | None = None
    ) -> dict[str, Any]:
        try:
            role = await self.read_role()
        except PodRoleUnreadable as exc:
            raise PodRoleRefused(
                CODE_UNREADABLE, "this agent's role could not be confirmed"
            ) from exc
        if role.is_standby and not in_sync_import():
            raise PodRoleRefused(CODE_STANDBY, "a standby's log changes only by sync import")
        return await super().append(kind, payload, expected_seq=expected_seq)

    async def verified_head(self) -> Optional[PodLogCursor]:
        """The head pointer, checked against its own sealed record; no chain walk.

        The same predecessor check ``append`` performs before publishing a successor,
        so the head a sync compares is one this pod could append after. ``None`` for
        an empty log. Raises on a fenced or tampered log.
        """
        raw, _ = await self._store.get_with_generation(self.HEAD)
        head = self._read_head(raw)
        if head is None:
            return None
        blob = await self._store.get(head["key"])
        if blob is None:
            raise PodLogTampered("the log head references a missing record")
        record = self._unseal(blob)
        if record.get("seq") != head["seq"] or record.get("sha") != head["sha"]:
            raise PodLogTampered("the log head and its record disagree")
        await self.require_open()
        return PodLogCursor(head["seq"], head["key"], head["sha"])


__all__ = ["RoleAwareCommitLog"]
