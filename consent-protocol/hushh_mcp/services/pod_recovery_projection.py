"""Bounded, sealed acceleration of existing owner-log recovery reducers.

The log remains authoritative. Every use verifies the tail against the saved
cursor and the live erasure fence. No conversation, Files or PKM ledger moves.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import asdict
from typing import Any

from hushh_mcp.services.pod_bounded_object import ObjectReadTooLarge
from hushh_mcp.services.pod_commit_log import PodLogCursor, PodLogTampered
from hushh_mcp.services.pod_memory_replay import _location
from hushh_mcp.services.pod_object_version import ABSENT

KEY = "projections/owner-recovery-v1.bin"
MAX_RECORDS = 10_000
MAX_BYTES = 8 * 1024 * 1024
INTERVAL = 64
logger = logging.getLogger(__name__)


def record_kinds() -> set[str]:
    from hushh_mcp.services.pod_ai_selection import POD_AI_SELECTION_RECORD_KIND
    from hushh_mcp.services.pod_authority_store import (
        AUTHORITY_TOMBSTONE_KIND,
        AUTHORITY_TRUST_KIND,
    )
    from hushh_mcp.services.pod_config import POD_CONFIG_RECORD_KIND
    from hushh_mcp.services.pod_connector_credentials import CLEARED_KIND, RECORD_KIND
    from hushh_mcp.services.pod_memory_service import MEMORY_RECORD_KINDS

    return {
        POD_CONFIG_RECORD_KIND,
        POD_AI_SELECTION_RECORD_KIND,
        RECORD_KIND,
        CLEARED_KIND,
        AUTHORITY_TRUST_KIND,
        AUTHORITY_TOMBSTONE_KIND,
        *MEMORY_RECORD_KINDS,
        "pod_upgrade_fence",
        "pod_upgrade_idle",
        "pod_upgrade_release",
    }


class _BudgetExceeded(Exception):
    pass


class OwnerRecoveryProjection:
    """A derived snapshot, shared by the current incarnation's existing readers."""

    def __init__(self, *, owner: str, max_records: int = MAX_RECORDS, max_bytes: int = MAX_BYTES):
        self.owner, self.max_records, self.max_bytes = owner, max_records, max_bytes
        self._sealed: bytes | None = None
        self._generation = ABSENT
        self._loaded = False
        self._uncached = False
        self._saved_seq = 0
        self._lock = asyncio.Lock()

    def _decode(self, log, blob: bytes | None, binding: dict) -> tuple[Any, list]:
        if blob is None:
            return None, []
        if len(blob) > self.max_bytes:
            raise PodLogTampered("Owner recovery projection exceeds its bound.")
        value = log._unseal(blob)
        if (
            not isinstance(value, dict)
            or set(value) != {*binding, "cursor", "records"}
            or any(value.get(k) != v for k, v in binding.items())
            or not isinstance(value["cursor"], dict)
            or set(value["cursor"]) != {"seq", "key", "sha"}
            or not isinstance(value["records"], list)
            or len(value["records"]) > self.max_records
        ):
            raise PodLogTampered("Owner recovery projection binding invalid.")
        cursor = PodLogCursor(**value["cursor"])
        previous = 0
        kinds = record_kinds()
        for row in value["records"]:
            if (
                not isinstance(row, dict)
                or type(row.get("seq")) is not int
                or type(cursor.seq) is not int
                or not previous < row["seq"] <= cursor.seq
                or str(row.get("kind") or "").strip() not in kinds
            ):
                raise PodLogTampered("Owner recovery projection records invalid.")
            previous = row["seq"]
        return cursor, value["records"]

    async def recover(self, log: Any, *, force_save: bool = False) -> list[dict] | None:
        if log._owner_id != self.owner:
            raise PodLogTampered("Owner recovery projection owner mismatch.")
        location = _location(log)
        if self._uncached or location is None:
            return None
        binding = {"kind": KEY, "owner": self.owner, "location": location}
        async with self._lock:
            await log.require_open()
            blob, generation = self._sealed, self._generation
            if not self._loaded:
                try:
                    blob, generation = await log._store.get_bounded_with_generation(
                        max_bytes=self.max_bytes, key=KEY
                    )
                except ObjectReadTooLarge:
                    raise PodLogTampered("Owner recovery projection exceeds its bound.") from None
            anchor, records = self._decode(log, blob, binding)
            saved_seq = self._saved_seq if self._loaded else anchor.seq if anchor else 0
            tail: list[dict] = []
            size = len(json.dumps(records, ensure_ascii=False).encode())
            kinds = record_kinds()

            def visit(row):
                nonlocal size
                if str(row.get("kind") or "").strip() not in kinds:
                    return
                size += len(json.dumps(row, ensure_ascii=False).encode()) + 2
                if len(records) + len(tail) >= self.max_records or size > self.max_bytes:
                    raise _BudgetExceeded
                tail.append(row)

            try:
                cursor = await log.fold_since(anchor, visit)
            except _BudgetExceeded:
                self._uncached, self._sealed = True, None
                return None
            records.extend(reversed(tail))
            if cursor is None:
                return records
            sealed = log._seal({**binding, "cursor": asdict(cursor), "records": records})
            if len(sealed) > self.max_bytes:
                self._uncached, self._sealed = True, None
                return None
            # Publish no partial replay. A fresh caller must also hold its lease.
            self._sealed, self._generation, self._loaded = sealed, generation, True
            if force_save or blob is None or cursor.seq - saved_seq >= INTERVAL:
                await log.require_open()
                try:
                    written = await log._store.put_if_generation(KEY, sealed, generation)
                except Exception:
                    # An uncertain optimization write cannot replace a log receipt.
                    self._loaded = False
                    logger.warning("pod.recovery_checkpoint_write_unconfirmed")
                else:
                    if written is None:
                        self._loaded = False  # reload the CAS winner before another save
                    else:
                        self._generation, saved_seq = written, cursor.seq
                await log.require_open()
            self._saved_seq = saved_seq
            return records

    async def replay(self, log: Any) -> list[dict]:
        records = await self.recover(log)
        return await log.replay() if records is None else records


async def replay_owner_records(log: Any) -> list[dict]:
    """Existing lifecycle readers may share only their current owner's projection."""
    from hushh_mcp.services.pod_session_authority import active_session_authority

    authority = active_session_authority()
    projection = getattr(authority, "recovery_projection", None)
    if projection is None:
        return await log.replay()
    await authority.require_held()
    records = await projection.replay(log)
    await authority.require_held()
    return records
