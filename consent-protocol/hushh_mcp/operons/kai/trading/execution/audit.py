"""Hash-chained append-only audit log for execution events.

Every Intent, Preview, Approval, Submit, Status, Fill, and Reconcile
event lands here. Entries are tamper-evident: each entry's hash chains
the prior entry's hash, so any later mutation is detectable.

Storage is a pure interface; concrete implementations live in services
(in-memory for tests, encrypted Postgres table for prod).
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Iterable, Protocol


@dataclass(frozen=True)
class AuditEntry:
    """A single audit-log row."""

    seq: int
    user_id: str
    event_type: str
    payload: dict[str, Any]
    prev_hash: str
    entry_hash: str
    timestamp_ms: int = field(default_factory=lambda: int(time.time() * 1000))

    @staticmethod
    def make(
        *,
        seq: int,
        user_id: str,
        event_type: str,
        payload: dict[str, Any],
        prev_hash: str,
        timestamp_ms: int | None = None,
    ) -> "AuditEntry":
        ts = timestamp_ms if timestamp_ms is not None else int(time.time() * 1000)
        body = {
            "seq": seq,
            "user_id": user_id,
            "event_type": event_type,
            "payload": _canonical(payload),
            "prev_hash": prev_hash,
            "timestamp_ms": ts,
        }
        digest = hashlib.sha256(
            json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        return AuditEntry(
            seq=seq,
            user_id=user_id,
            event_type=event_type,
            payload=payload,
            prev_hash=prev_hash,
            entry_hash=digest,
            timestamp_ms=ts,
        )


class AuditStorage(Protocol):
    def append(self, entry: AuditEntry) -> None: ...
    def latest_for_user(self, user_id: str) -> AuditEntry | None: ...
    def all_for_user(self, user_id: str) -> Iterable[AuditEntry]: ...


class InMemoryAuditStorage:
    """Test/dev backend. Production uses an encrypted Postgres table."""

    def __init__(self) -> None:
        self._entries: list[AuditEntry] = []

    def append(self, entry: AuditEntry) -> None:
        self._entries.append(entry)

    def latest_for_user(self, user_id: str) -> AuditEntry | None:
        for entry in reversed(self._entries):
            if entry.user_id == user_id:
                return entry
        return None

    def all_for_user(self, user_id: str) -> Iterable[AuditEntry]:
        return [e for e in self._entries if e.user_id == user_id]


class AuditLog:
    """Append-only hash-chained log facade."""

    GENESIS_HASH = "0" * 64

    def __init__(self, storage: AuditStorage) -> None:
        self._storage = storage

    def append(
        self,
        *,
        user_id: str,
        event_type: str,
        payload: dict[str, Any],
        timestamp_ms: int | None = None,
    ) -> AuditEntry:
        prev = self._storage.latest_for_user(user_id)
        prev_hash = prev.entry_hash if prev is not None else self.GENESIS_HASH
        seq = (prev.seq + 1) if prev is not None else 0
        entry = AuditEntry.make(
            seq=seq,
            user_id=user_id,
            event_type=event_type,
            payload=payload,
            prev_hash=prev_hash,
            timestamp_ms=timestamp_ms,
        )
        self._storage.append(entry)
        return entry

    def verify_chain(self, user_id: str) -> bool:
        prev_hash = self.GENESIS_HASH
        for entry in self._storage.all_for_user(user_id):
            if entry.prev_hash != prev_hash:
                return False
            recomputed = AuditEntry.make(
                seq=entry.seq,
                user_id=entry.user_id,
                event_type=entry.event_type,
                payload=entry.payload,
                prev_hash=entry.prev_hash,
                timestamp_ms=entry.timestamp_ms,
            )
            if recomputed.entry_hash != entry.entry_hash:
                return False
            prev_hash = entry.entry_hash
        return True


def _canonical(value: Any) -> Any:
    """Render a payload to JSON-canonical form for stable hashing."""
    if hasattr(value, "__dataclass_fields__"):
        return _canonical(asdict(value))
    if isinstance(value, dict):
        return {k: _canonical(v) for k, v in sorted(value.items())}
    if isinstance(value, (list, tuple)):
        return [_canonical(v) for v in value]
    return value


__all__ = ["AuditEntry", "AuditLog", "AuditStorage", "InMemoryAuditStorage"]
