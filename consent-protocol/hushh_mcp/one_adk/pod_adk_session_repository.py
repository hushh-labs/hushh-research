"""Encrypted ADK records projected from the existing owner pod commit log.

The shared session service still owns the owner-key cipher, ADK event semantics,
privacy projection and pending-call restoration. This adapter stores its sealed
records, using the log head CAS to prevent stale snapshots replacing new events.
No hub database credentials or second action ledger enter the pod.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from hushh_mcp.services.chat_key import CHAT_CIPHERTEXT_LIKE
from hushh_mcp.services.pod_commit_log import PodCommitLog, PodLogConflict, PodLogCursor

_KIND = "pod.adk.session.v1"
_MAX_SESSIONS = 1000
_MAX_PROJECTION_BYTES = 32 * 1024 * 1024
_MAX_SEALED_BYTES = 1024 * 1024


class PodAdkSessionUnavailable(RuntimeError):
    """Stable refusal; no storage payload or credentials enter the error."""


@dataclass
class SessionRows:
    data: list[dict[str, Any]]


class PodAdkSessionProjection:
    """Process-local ciphertext cache; rebuildable from the owner recovery log.

    Deletion is logical: tombstones prevent read/list/resurrection, while earlier
    ciphertext remains in the recovery chain until whole-pod erasure. This is not
    a physical conversation-erasure receipt. Recovery is bounded and refuses an
    oversized chain rather than silently losing history.
    """

    def __init__(self, *, owner_id: str, hushh_id: str, log: PodCommitLog) -> None:
        if not owner_id or not hushh_id or log._owner_id != hushh_id:
            raise PodAdkSessionUnavailable("Pod conversation owner mismatch.")
        self.owner_id, self.hushh_id, self.log = owner_id, hushh_id, log
        self._cursor: PodLogCursor | None = None
        self._entries: dict[tuple[str, str], dict] = {}
        self._lock = asyncio.Lock()

    async def snapshot(self) -> tuple[int, dict[tuple[str, str], dict]]:
        async with self._lock:
            records, cursor = await self.log.replay_since(self._cursor, max_records=10000)
            entries = self._apply(records)
            # Do not publish either half of a failed projection refresh.
            self._entries, self._cursor = entries, cursor
            return cursor.seq if cursor else 0, dict(entries)

    def _apply(self, records: list[dict]) -> dict[tuple[str, str], dict]:
        entries = dict(self._entries)
        for record in records:
            if record.get("kind") != _KIND:
                continue
            p = record.get("payload")
            if (
                not isinstance(p, dict)
                or type(p.get("format")) is not int
                or p.get("format") != 1
                or type(p.get("previous")) is not int
                or p["previous"] < 0
                or p.get("owner") != self.owner_id
                or p.get("hushhId") != self.hushh_id
                or not isinstance(p.get("app"), str)
                or not p["app"]
                or not isinstance(p.get("session"), str)
                or not p["session"]
            ):
                raise PodAdkSessionUnavailable("Pod conversation record invalid.")
            PodAdkSessionRepository._validate_identity(p["app"], p["session"])
            key = p["app"], p["session"]
            previous = entries.get(key)
            if previous and previous.get("deleted"):
                raise PodAdkSessionUnavailable("Pod conversation is deleted.")
            if p.get("previous") != (previous["revision"] if previous else 0):
                raise PodAdkSessionUnavailable("Pod conversation revision invalid.")
            if p.get("operation") == "delete":
                entries[key] = {
                    "revision": p["previous"] + 1,
                    "deleted": True,
                    "session_id": p["session"],
                }
            elif p.get("operation") == "write":
                row = p.get("record")
                if (
                    not isinstance(row, dict)
                    or type(row.get("revision")) is not int
                    or row.get("revision") != p["previous"] + 1
                ):
                    raise PodAdkSessionUnavailable("Pod conversation record invalid.")
                if row.get("session_id") != p["session"]:
                    raise PodAdkSessionUnavailable("Pod conversation identity invalid.")
                PodAdkSessionRepository._validate_payload(
                    {k: row.get("payload_" + k) for k in ("ciphertext", "iv", "tag", "algorithm")}
                )
                entries[key] = {**row, "_sequence": record["seq"]}
            else:
                raise PodAdkSessionUnavailable("Pod conversation operation invalid.")
        if (
            len(entries) > _MAX_SESSIONS
            or len(json.dumps(list(entries.values())).encode()) > _MAX_PROJECTION_BYTES
        ):
            raise PodAdkSessionUnavailable("Pod conversation capacity reached.")
        return entries


class PodAdkSessionRepository:
    def __init__(
        self,
        *,
        projection: PodAdkSessionProjection,
        require_access: Callable[[], Awaitable[None]],
    ) -> None:
        self._projection = projection
        self._owner_id, self._hushh_id = projection.owner_id, projection.hushh_id
        self._log, self._require_access = projection.log, require_access

    async def _admit(self, user: str) -> None:
        if user != self._owner_id or self._log._owner_id != self._hushh_id:
            raise PodAdkSessionUnavailable("Pod conversation owner mismatch.")
        await self._require_access()
        await self._log.require_open()

    async def _snapshot(self, user: str) -> tuple[int, dict[tuple[str, str], dict]]:
        await self._admit(user)
        result = await self._projection.snapshot()
        await self._admit(user)
        return result

    @staticmethod
    def _validate_identity(app: str, session: str) -> None:
        if (
            not isinstance(app, str)
            or not 1 <= len(app) <= 128
            or not isinstance(session, str)
            or not 1 <= len(session) <= 256
        ):
            raise PodAdkSessionUnavailable("Pod conversation identity invalid.")

    @staticmethod
    def _validate_payload(payload: dict[str, str]) -> None:
        if (
            set(payload) != {"ciphertext", "iv", "tag", "algorithm"}
            or not all(isinstance(v, str) and v for v in payload.values())
            or not payload["ciphertext"].startswith(CHAT_CIPHERTEXT_LIKE.removesuffix("%"))
            or len(json.dumps(payload).encode()) > _MAX_SEALED_BYTES
        ):
            raise PodAdkSessionUnavailable("Owner-encrypted conversation required.")

    async def _write(
        self,
        *,
        app: str,
        user: str,
        session: str,
        revision: int,
        payload: dict[str, str],
    ) -> SessionRows:
        self._validate_identity(app, session)
        if type(revision) is not int or revision < 0:
            raise PodAdkSessionUnavailable("Pod conversation revision invalid.")
        self._validate_payload(payload)
        for _ in range(3):
            seq, entries = await self._snapshot(user)
            previous = entries.get((app, session))
            if previous is None and len(entries) >= _MAX_SESSIONS:
                raise PodAdkSessionUnavailable("Pod conversation capacity reached.")
            if (previous and previous.get("deleted")) or (
                previous["revision"] if previous else 0
            ) != revision:
                return SessionRows([])
            row = {
                "session_id": session,
                "revision": revision + 1,
                **{"payload_" + key: value for key, value in payload.items()},
            }
            proposed = {**entries, (app, session): {**row, "_sequence": seq + 1}}
            if len(json.dumps(list(proposed.values())).encode()) > _MAX_PROJECTION_BYTES:
                raise PodAdkSessionUnavailable("Pod conversation capacity reached.")
            record = {
                "format": 1,
                "owner": user,
                "hushhId": self._hushh_id,
                "app": app,
                "session": session,
                "previous": revision,
                "operation": "write",
                "record": row,
            }
            await self._admit(user)
            try:
                await self._log.append(_KIND, record, expected_seq=seq)
            except PodLogConflict:
                continue
            await self._admit(user)
            return SessionRows([{"revision": revision + 1}])
        raise PodAdkSessionUnavailable("Pod conversation changed concurrently.")

    async def create(
        self,
        *,
        app: str,
        user: str,
        session: str,
        ciphertext: str,
        iv: str,
        tag: str,
        algorithm: str,
    ) -> SessionRows:
        return await self._write(
            app=app,
            user=user,
            session=session,
            revision=0,
            payload={
                "ciphertext": ciphertext,
                "iv": iv,
                "tag": tag,
                "algorithm": algorithm,
            },
        )

    async def get(self, *, app: str, user: str, session: str, chat_marker: str) -> SessionRows:
        self._validate_identity(app, session)
        _, entries = await self._snapshot(user)
        row = entries.get((app, session))
        return SessionRows([dict(row)] if row and not row.get("deleted") else [])

    async def list(self, *, app: str, user: str, chat_marker: str) -> SessionRows:
        _, entries = await self._snapshot(user)
        rows = [
            dict(value)
            for (owner_app, _), value in entries.items()
            if owner_app == app and not value.get("deleted")
        ]
        return SessionRows(sorted(rows, key=lambda row: row["_sequence"], reverse=True)[:100])

    async def delete(self, *, app: str, user: str, session: str, chat_marker: str) -> SessionRows:
        self._validate_identity(app, session)
        for _ in range(3):
            seq, entries = await self._snapshot(user)
            row = entries.get((app, session))
            if not row or row.get("deleted"):
                return SessionRows([])
            record = {
                "format": 1,
                "owner": user,
                "hushhId": self._hushh_id,
                "app": app,
                "session": session,
                "previous": row["revision"],
                "operation": "delete",
            }
            await self._admit(user)
            try:
                await self._log.append(_KIND, record, expected_seq=seq)
            except PodLogConflict:
                continue
            await self._admit(user)
            return SessionRows([{"session_id": session}])
        raise PodAdkSessionUnavailable("Pod conversation changed concurrently.")

    async def legacy(self, *, app: str, user: str, session: str, chat_marker: str) -> SessionRows:
        # This namespace admits only owner-key ciphertext, never legacy records.
        await self._admit(user)
        return SessionRows([])

    async def replace(
        self,
        *,
        app: str,
        user: str,
        session: str,
        revision: int,
        chat_marker: str,
        ciphertext: str,
        iv: str,
        tag: str,
        algorithm: str,
    ) -> SessionRows:
        return await self._write(
            app=app,
            user=user,
            session=session,
            revision=revision,
            payload={
                "ciphertext": ciphertext,
                "iv": iv,
                "tag": tag,
                "algorithm": algorithm,
            },
        )
