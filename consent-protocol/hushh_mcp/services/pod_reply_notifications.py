"""Sealed completion signals; retry needs no chat key or inference authority."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
from dataclasses import asdict

from hushh_mcp.services.pod_commit_log import PodLogConflict, PodLogCursor, PodLogTampered
from hushh_mcp.services.pod_object_version import ABSENT

KIND = "pod.reply_notification.v1"
KEY = "projections/reply-notifications-v1.bin"
MAX_ENTRIES = 512
MAX_BYTES = 512 * 1024
TTL_SECONDS = 6 * 60 * 60
_ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
_OUTBOXES: dict[tuple[str, int], PodReplyOutbox] = {}


class PodReplyOutbox:
    """The commit log owns receipts; this bounded sealed object accelerates replay."""

    def __init__(self, log):
        self.log = log
        self._lock = asyncio.Lock()
        self._cursor = None
        self._entries: dict[str, dict] = {}
        self._loaded = False
        self._generation = ABSENT

    def _validate(self, item):
        if not isinstance(item, dict) or set(item) - {
            "eventId",
            "conversationId",
            "runId",
            "createdAt",
            "expiresAt",
            "state",
            "nextAttemptAt",
        }:
            raise PodLogTampered("Completion receipt shape invalid.")
        conversation, run = item.get("conversationId"), item.get("runId")
        if (
            not isinstance(conversation, str)
            or len(conversation) < 8
            or not _ID.fullmatch(conversation)
            or not isinstance(run, str)
            or not _ID.fullmatch(run)
        ):
            raise PodLogTampered("Completion receipt identifiers invalid.")
        expected = hashlib.sha256(
            f"{self.log._owner_id}\0{conversation}\0{run}".encode()
        ).hexdigest()
        if item.get("eventId") != expected or item.get("state") not in {
            "pending",
            "read",
            "acknowledged",
        }:
            raise PodLogTampered("Completion receipt binding invalid.")
        created, expires, attempt = (
            item.get("createdAt"),
            item.get("expiresAt"),
            item.get("nextAttemptAt", 0),
        )
        if (
            type(created) is not int
            or type(expires) is not int
            or type(attempt) is not int
            or created < 0
            or expires != created + TTL_SECONDS
            or not 0 <= attempt <= expires
        ):
            raise PodLogTampered("Completion receipt lifetime invalid.")
        return item

    async def _snapshot(self) -> dict[str, dict]:
        await self.log.require_open()
        if hasattr(self.log, "read_role") and (await self.log.read_role()).is_standby:
            raise RuntimeError("Completion checkpoint requires the primary.")
        if not self._loaded:
            blob, self._generation = await self.log._store.get_bounded_with_generation(
                key=KEY,
                max_bytes=MAX_BYTES,
            )
            if blob:
                value = self.log._unseal(blob)
                if value.get("owner") != self.log._owner_id or value.get("kind") != KIND:
                    raise PodLogTampered("Completion checkpoint owner mismatch.")
                self._cursor = PodLogCursor(**value["cursor"]) if value["cursor"] else None
                self._entries = value["entries"]
                if not isinstance(self._entries, dict) or len(self._entries) > MAX_ENTRIES:
                    raise PodLogTampered("Completion checkpoint capacity invalid.")
                for event_id, item in self._entries.items():
                    if self._validate(item)["eventId"] != event_id:
                        raise PodLogTampered("Completion checkpoint binding invalid.")
            else:
                self._cursor, self._entries = None, {}
        now = int(time.time())
        entries = {key: item for key, item in self._entries.items() if item["expiresAt"] > now}
        changes: dict[str, dict] = {}

        def visit(row):
            if row.get("kind") != KIND:
                return
            item = self._validate(row.get("payload"))
            event_id = item["eventId"]
            if item.get("expiresAt", 0) <= now:
                return
            if event_id in changes:
                return
            # Every transition retains the fixed creation/expiry binding.
            changes[event_id] = item
            if len(changes) > MAX_ENTRIES:
                raise PodLogTampered("Completion recovery capacity exceeded.")

        cursor = await self.log.fold_since(self._cursor, visit)
        for event_id, item in changes.items():
            if item["expiresAt"] > now:
                entries[event_id] = item
            else:
                entries.pop(event_id, None)
        if len(entries) > MAX_ENTRIES:
            raise PodLogTampered("Completion capacity exceeded.")
        value = {
            "kind": KIND,
            "owner": self.log._owner_id,
            "cursor": asdict(cursor) if cursor else None,
            "entries": entries,
        }
        if len(json.dumps(value).encode()) > MAX_BYTES:
            raise PodLogTampered("Completion checkpoint too large.")
        sealed = self.log._seal(value)
        generation = await self.log._store.put_if_generation(KEY, sealed, self._generation)
        if generation is None:
            self._loaded = False
            await self.log.require_open()
            raise PodLogConflict("Completion checkpoint changed.")
        self._generation, self._cursor = generation, cursor
        self._entries, self._loaded = entries, True
        await self.log.require_open()
        return entries

    async def _write(self, item):
        await self.log.append(KIND, item, expected_seq=self._cursor.seq if self._cursor else 0)
        # Keep the prior anchor; folding the appended record updates the sealed
        # checkpoint. Log CAS also protects against unrelated concurrent writes.
        await self._snapshot()

    async def enqueue(self, *, conversation_id: str, run_id: str):
        event_id = hashlib.sha256(
            f"{self.log._owner_id}\0{conversation_id}\0{run_id}".encode()
        ).hexdigest()
        now = int(time.time())
        initial = self._validate(
            {
                "eventId": event_id,
                "conversationId": conversation_id,
                "runId": run_id,
                "createdAt": now,
                "expiresAt": now + TTL_SECONDS,
                "state": "pending",
            }
        )
        async with self._lock:
            for _ in range(4):
                try:
                    entries = await self._snapshot()
                    if event_id not in entries:
                        if len(entries) >= MAX_ENTRIES:
                            raise RuntimeError("Completion receipt capacity reached.")
                        await self._write(initial)
                    return
                except PodLogConflict:
                    self._loaded = False
            raise PodLogConflict("Completion receipt changed.")

    async def mark_read(self, conversation_id: str):
        async with self._lock:
            for _ in range(4):
                try:
                    entries = await self._snapshot()
                    for item in list(entries.values()):
                        if item["conversationId"] == conversation_id and item["state"] == "pending":
                            await self._write({**item, "state": "read", "nextAttemptAt": 0})
                    return
                except PodLogConflict:
                    self._loaded = False
            raise PodLogConflict("Completion read receipt changed.")

    async def drain(self, *, client=None, limit: int = 10):
        from hushh_mcp.services.pod_hub_client import PodHubClient

        # A standby never originates notifications, including recovered receipts.
        if hasattr(self.log, "read_role") and (await self.log.read_role()).is_standby:
            return {"outcome": "standby", "accepted": 0}
        accepted = 0
        async with self._lock:
            entries = await self._snapshot()
            now = int(time.time())
            pending = [
                item
                for item in entries.values()
                if item["state"] in {"pending", "read"} and item.get("nextAttemptAt", 0) <= now
            ]
            pending.sort(key=lambda item: (item.get("nextAttemptAt", 0), item["createdAt"]))
            for item in pending[: max(1, min(limit, 10))]:
                await self.log.require_open()
                payload = {
                    key: item[key]
                    for key in (
                        "eventId",
                        "conversationId",
                        "runId",
                        "createdAt",
                        "expiresAt",
                    )
                }
                payload["read"] = item["state"] == "read"
                try:
                    response = await asyncio.to_thread(
                        (client or PodHubClient(timeout_seconds=8)).post,
                        "/api/one/pod/reply-notifications",
                        json=payload,
                    )
                    if response.status_code != 200 or response.json().get("settled") is not True:
                        await self._write(
                            {**item, "nextAttemptAt": min(item["expiresAt"], now + 60)}
                        )
                        continue
                    await self._write({**item, "state": "acknowledged"})
                    accepted += 1
                except Exception:
                    # Unknown network/storage outcomes retain the stable event ID.
                    # Neither provider errors nor private receipt details are logged.
                    try:
                        await self._write(
                            {**item, "nextAttemptAt": min(item["expiresAt"], now + 60)}
                        )
                    except Exception:
                        self._loaded = False
                    continue
        return {"outcome": "drained", "accepted": accepted}


def reply_outbox(log) -> PodReplyOutbox:
    key = (log._owner_id, id(log))
    if key not in _OUTBOXES:
        _OUTBOXES.clear()  # one owner/incarnation per process
        _OUTBOXES[key] = PodReplyOutbox(log)
    return _OUTBOXES[key]


async def drain_reply_notifications():
    from hushh_mcp.services.pod_memory_service import _resolve_log

    log = _resolve_log()
    if log is None:
        return {"outcome": "unavailable", "accepted": 0}
    try:
        return await reply_outbox(log).drain()
    except Exception:
        return {"outcome": "pending", "accepted": 0}
