"""Bounded account-export transport; queries and owner authority stay with AccountService."""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable, Generator, Iterator, Mapping
from datetime import datetime, timezone
from threading import BoundedSemaphore
from typing import Any

from fastapi.encoders import jsonable_encoder
from sqlalchemy import text

logger = logging.getLogger(__name__)

# Existing export scope, including the complete retained encrypted recovery history.
# consent_audit retains its existing SQL LIMIT 500; no new data or history cap.
EXPORT_SECTIONS = (
    ("actor_profile", "actor_profiles", False),
    ("runtime_persona_state", "runtime_persona_state", False),
    ("verified_email_aliases", "actor_verified_email_aliases", True),
    ("encrypted_vault_keys", "vault_keys", True),
    ("encrypted_pkm_manifests", "pkm_manifests", True),
    ("encrypted_pkm_index", "pkm_index", True),
    ("encrypted_pkm_blobs", "pkm_blobs", True),
    ("encrypted_pkm_recovery_revisions", "pkm_domain_revisions", True),
    ("encrypted_pkm_recovery_segments", "pkm_domain_revision_segments", True),
    ("consent_audit", "consent_audit", True),
)
EXPORT_DEADLINE_SECONDS = 240
_EXPORT_SLOTS = BoundedSemaphore(2)
_CHUNK_CHARS = 16 * 1024
_TRANSPORT_BYTES = 256 * 1024


class AccountExportBusy(RuntimeError):
    """This process already owns its bounded number of export snapshots."""


class AccountExportStream:
    """One read-only snapshot, one server-side row at a time, explicitly closeable.

    Memory scales with the largest individual row, never the number of rows.
    A failure deliberately leaves invalid/incomplete JSON, never a success footer.
    """

    def __init__(
        self,
        *,
        user_id: str,
        connection_factory: Callable,
        table_exists: Callable,
        queries: Mapping[str, Any],
    ) -> None:
        self._user_id = user_id
        self._connection_factory = connection_factory
        self._table_exists = table_exists
        self._queries = queries
        self._iterator: Generator[bytes, None, None] | None = None
        self._first: bytes | None = None
        self._reserved = False
        self._started = 0.0
        self._rows = 0
        self._bytes = 0
        self._chunks = 0
        self._max_chunk_bytes = 0
        self._completed = False
        self._fetch_seconds = 0.0
        self._produce_seconds = 0.0
        self._yield_wait_seconds = 0.0
        self._suspended_at: float | None = None
        self._exhausted = False

    def prepare(self) -> AccountExportStream:
        if self._iterator is not None:
            raise RuntimeError("Export already prepared")
        if not _EXPORT_SLOTS.acquire(blocking=False):
            raise AccountExportBusy("Account export busy")
        self._reserved = True
        self._started = time.monotonic()
        self._iterator = self._document()
        try:
            # Open the snapshot and actually fetch the first section before HTTP headers.
            self._first = next(self._iterator)
        except BaseException:
            self.close()
            raise
        return self

    def __iter__(self) -> Iterator[bytes]:
        if self._first is None or self._iterator is None:
            raise RuntimeError("Export not prepared")
        first, self._first = self._first, None
        self._bytes += len(first)
        self._chunks += 1
        self._max_chunk_bytes = max(self._max_chunk_bytes, len(first))
        self._suspended_at = time.monotonic()
        yield first
        self._resume()
        # Fill across rows and punctuation, not just within one JSON value. The
        # first prepared prefix still reaches the client before filling a buffer.
        pending = bytearray()
        while True:
            started = time.monotonic()
            try:
                chunk = next(self._iterator)
            except StopIteration:
                break
            finally:
                self._produce_seconds += time.monotonic() - started
            self._check_deadline()
            pending.extend(chunk)
            while len(pending) >= _TRANSPORT_BYTES:
                output = bytes(pending[:_TRANSPORT_BYTES])
                del pending[:_TRANSPORT_BYTES]
                self._bytes += len(output)
                self._chunks += 1
                self._max_chunk_bytes = max(self._max_chunk_bytes, len(output))
                self._suspended_at = time.monotonic()
                yield output
                self._resume()
        if pending:
            self._check_deadline()
            output = bytes(pending)
            self._bytes += len(output)
            self._chunks += 1
            self._max_chunk_bytes = max(self._max_chunk_bytes, len(output))
            self._suspended_at = time.monotonic()
            yield output
            self._resume()
        # Exhaustion is acknowledged only after the last buffer's send resumes.
        # A buffered footer or a failed final send must never log success.
        self._exhausted = True

    def _resume(self) -> None:
        if self._suspended_at is not None:
            self._yield_wait_seconds += time.monotonic() - self._suspended_at
            self._suspended_at = None

    def confirm_produced(self) -> None:
        # Route-local ASGI boundary; outer middleware/network delivery is separate.
        self._completed = self._exhausted

    def close(self) -> None:
        self._resume()
        try:
            if self._iterator is not None:
                self._iterator.close()
                self._iterator = None
            self._first = None
        finally:
            if self._reserved:
                self._reserved = False
                _EXPORT_SLOTS.release()
                logger.info(
                    "account_export outcome=%s rows=%d bytes=%d elapsed_ms=%d "
                    "chunks=%d max_chunk_bytes=%d fetch_ms=%d produce_ms=%d yield_wait_ms=%d",
                    "producer_complete" if self._completed else "incomplete",
                    self._rows,
                    self._bytes,
                    int((time.monotonic() - self._started) * 1000),
                    self._chunks,
                    self._max_chunk_bytes,
                    int(self._fetch_seconds * 1000),
                    int(self._produce_seconds * 1000),
                    int(self._yield_wait_seconds * 1000),
                )

    @property
    def remaining_seconds(self) -> float:
        return max(0.0, EXPORT_DEADLINE_SECONDS - (time.monotonic() - self._started))

    def _check_deadline(self) -> None:
        if time.monotonic() - self._started > EXPORT_DEADLINE_SECONDS:
            raise TimeoutError("Account export deadline exceeded")

    def _encode(self, value: Any) -> Iterator[bytes]:
        encoder = json.JSONEncoder(ensure_ascii=True, separators=(",", ":"))
        # Escaped JSON is ASCII, so the character and byte budgets are equal.
        pending = bytearray()
        for fragment in encoder.iterencode(jsonable_encoder(value)):
            offset = 0
            while offset < len(fragment):
                self._check_deadline()
                end = min(len(fragment), offset + _CHUNK_CHARS - len(pending))
                pending.extend(fragment[offset:end].encode("ascii"))
                offset = end
                if len(pending) == _CHUNK_CHARS:
                    # One threadpool/ASGI hop per buffer, not per JSON token.
                    yield bytes(pending)
                    pending.clear()
        if pending:
            self._check_deadline()
            yield bytes(pending)

    def _rows_for(self, conn: Any, key: str) -> Generator[dict[str, Any], None, None]:
        # Options belong to SELECT only: psycopg2 must not wrap SET in a named cursor.
        self._check_deadline()
        started = time.monotonic()
        result = conn.execute(
            self._queries[key],
            {"user_id": self._user_id},
            execution_options={"stream_results": True, "yield_per": 1, "max_row_buffer": 1},
        ).mappings()
        self._fetch_seconds += time.monotonic() - started
        try:
            iterator = iter(result)
            while True:
                started = time.monotonic()
                row = next(iterator, None)
                self._fetch_seconds += time.monotonic() - started
                if row is None:
                    break
                self._check_deadline()
                self._rows += 1
                yield dict(row)
        finally:
            result.close()

    def _single(self, conn: Any, key: str, exists: bool) -> dict[str, Any] | None:
        if not exists:
            return None
        rows = self._rows_for(conn, key)
        try:
            return next(rows, None)
        finally:
            rows.close()

    def _document(self) -> Generator[bytes, None, None]:
        with self._connection_factory() as conn:
            conn.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"))
            conn.execute(text("SET LOCAL statement_timeout = '30s'"))
            conn.execute(text("SET LOCAL idle_in_transaction_session_timeout = '60s'"))
            present = {}
            for key, table, _ in EXPORT_SECTIONS:
                self._check_deadline()
                present[key] = self._table_exists(conn, table)
            self._check_deadline()
            first_key = EXPORT_SECTIONS[0][0]
            first_row = self._single(conn, first_key, present[first_key])
            yield b'{"requested_target":"account","exported_at":'
            yield from self._encode(datetime.now(timezone.utc).isoformat())
            yield b',"data":{'
            for index, (key, _, many) in enumerate(EXPORT_SECTIONS):
                self._check_deadline()
                if index:
                    yield b","
                yield from self._encode(key)
                yield b":"
                if not many:
                    value = first_row if index == 0 else self._single(conn, key, present[key])
                    yield from self._encode(value)
                    first_row = None
                    continue
                yield b"["
                if present[key]:
                    rows = self._rows_for(conn, key)
                    try:
                        for row_index, row in enumerate(rows):
                            if row_index:
                                yield b","
                            yield from self._encode(row)
                    finally:
                        rows.close()
                yield b"]"
            yield b"}"
        # Transaction/cursor cleanup must succeed before declaring a complete export.
        yield b',"success":true}'
