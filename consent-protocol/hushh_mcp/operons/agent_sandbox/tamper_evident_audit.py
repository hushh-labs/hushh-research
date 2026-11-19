# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Out-of-sandbox tamper-evident HMAC-SHA256 audit log chain (NIST AU-2, AU-9, #9744)."""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from typing import Any, Callable, Mapping

AUDIT_CHAIN_CORRUPTED = "AUDIT_CHAIN_CORRUPTED"
_GENESIS_HASH = "0" * 64


class AuditChainError(RuntimeError):
    """Raised on audit-log integrity breach or unavailable log storage."""

    def __init__(self, code: str, detail: str = "") -> None:
        self.code = code
        super().__init__(detail or code)


@dataclass(frozen=True)
class AuditEntry:
    seq: int
    timestamp_ms: int
    lease_id: str
    owner_id: str
    event_type: str
    payload: dict[str, Any]
    prev_hash: str
    entry_hash: str


def _canonical(value: Mapping[str, Any]) -> bytes:
    return json.dumps(
        dict(value),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("utf-8")


def _compute_entry_hash(
    hmac_key: bytes,
    *,
    seq: int,
    timestamp_ms: int,
    lease_id: str,
    owner_id: str,
    event_type: str,
    payload: Mapping[str, Any],
    prev_hash: str,
) -> str:
    body = _canonical(
        {
            "seq": seq,
            "timestamp_ms": timestamp_ms,
            "lease_id": lease_id,
            "owner_id": owner_id,
            "event_type": event_type,
            "payload": dict(payload),
            "prev_hash": prev_hash,
        }
    )
    return hmac.new(hmac_key, body, hashlib.sha256).hexdigest()


class TamperEvidentAuditLedger:
    """Append-only out-of-sandbox audit chain verifying contiguous HMAC linkage."""

    def __init__(
        self,
        hmac_key: bytes,
        *,
        clock_ms: Callable[[], int] | None = None,
    ) -> None:
        if len(hmac_key) < 32:
            raise ValueError("audit hmac_key must be at least 32 bytes")
        self._key = bytes(hmac_key)
        self._clock_ms = clock_ms or (lambda: int(time.time() * 1000))
        self._entries: list[AuditEntry] = []

    def append(
        self,
        *,
        lease_id: str,
        owner_id: str,
        event_type: str,
        payload: Mapping[str, Any] | None = None,
    ) -> AuditEntry:
        clean_lease = str(lease_id or "").strip()
        clean_owner = str(owner_id or "").strip()
        clean_event = str(event_type or "").strip()
        if not clean_lease or not clean_owner or not clean_event:
            raise ValueError("lease_id, owner_id, and event_type are required")
        clean_payload = dict(payload or {})
        seq = len(self._entries) + 1
        prev_hash = self._entries[-1].entry_hash if self._entries else _GENESIS_HASH
        ts = int(self._clock_ms())
        entry_hash = _compute_entry_hash(
            self._key,
            seq=seq,
            timestamp_ms=ts,
            lease_id=clean_lease,
            owner_id=clean_owner,
            event_type=clean_event,
            payload=clean_payload,
            prev_hash=prev_hash,
        )
        entry = AuditEntry(
            seq=seq,
            timestamp_ms=ts,
            lease_id=clean_lease,
            owner_id=clean_owner,
            event_type=clean_event,
            payload=clean_payload,
            prev_hash=prev_hash,
            entry_hash=entry_hash,
        )
        self._entries.append(entry)
        return entry

    def entries(self) -> tuple[AuditEntry, ...]:
        return tuple(self._entries)

    def verify_chain(self) -> None:
        """Raise AuditChainError if any entry was altered, omitted, or reordered."""
        expected_prev = _GENESIS_HASH
        for idx, entry in enumerate(self._entries, start=1):
            if entry.seq != idx or entry.prev_hash != expected_prev:
                raise AuditChainError(
                    AUDIT_CHAIN_CORRUPTED,
                    f"audit sequence mismatch at index {idx}",
                )
            recomputed = _compute_entry_hash(
                self._key,
                seq=entry.seq,
                timestamp_ms=entry.timestamp_ms,
                lease_id=entry.lease_id,
                owner_id=entry.owner_id,
                event_type=entry.event_type,
                payload=entry.payload,
                prev_hash=entry.prev_hash,
            )
            if not hmac.compare_digest(recomputed, entry.entry_hash):
                raise AuditChainError(
                    AUDIT_CHAIN_CORRUPTED,
                    f"audit HMAC mismatch at seq {entry.seq}",
                )
            expected_prev = entry.entry_hash
