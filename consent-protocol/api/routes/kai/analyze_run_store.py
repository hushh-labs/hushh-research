"""Cross-process run state for Kai's long-running runs (debate and import).

Why this exists
---------------
A Kai analysis debate and a portfolio import each run in the memory of the
worker process that started them. Each Cloud Run instance runs several gunicorn
workers and each lane runs several instances, so a follow-up request -- "is my
run still active?", "stream it again", "cancel it" -- usually lands on a process
that never saw the run. On UAT (2 workers, 2+ instances) a reload marked healthy
runs failed, and import cancel answered 404 on 4 of 5 attempts.

What this does
--------------
Keeps one row per run in ``kai_run_state`` (migration 253), scoped by
``run_kind`` (``debate`` | ``import``):

* the owning process writes a ``running`` row when the run starts and, every
  :data:`HEARTBEAT_SECONDS`, refreshes its heartbeat and a progress checkpoint
  and reads any cancel request in the same round trip;
* any process can record the owner's cancel request;
* the owning process writes a terminal receipt when the run ends;
* a process that does not hold the run can follow it to its end
  (:func:`follow_remote_run`) and receive the real terminal frame through a
  one-time sealed hand-off (below).

What is and is not stored
-------------------------
Operational metadata only: identifiers, status, an event count and
server-defined event and phase names, and a receipt carrying a server-defined
code. The person's information -- holdings, statements, file names, decision
cards, transcripts, model output, market inputs, PKM context -- stays in the
owning process's memory and its live stream (the posture migration 128 set).

The terminal frame *is* the person's information (the parsed portfolio, the
decision card), and both clients need it to save the result to the person's
encrypted vault. To hand it to another process without it ever being readable
from the database, the requesting process generates a one-time X25519 key pair,
stores only the public key, and keeps the private key in memory for that one
request. The owner seals the frame to that key (X25519 + HKDF-SHA256 +
AES-256-GCM). The derivation is salted with a value only the backend can compute
from its signing secret and binds the run, the person and both public keys, so
someone who can write the database can neither forge a frame nor redirect one
to a key of their own. The requester deletes the ciphertext as soon as it reads
it (even when its client disconnected), and the owner deletes anything left
when it stops answering. A database copy holds ciphertext whose key was never
written anywhere.

Constraints carried over from the terminal-checkpoint store
-----------------------------------------------------------
* **Coarse writes** -- one at start, one per heartbeat, one at the terminal
  transition; never per streamed frame (the #4736 pool pin,
  ``DB_SQLALCHEMY_MAX_OVERFLOW=0``).
* **Portable SQL** -- ``TEXT`` JSON, epochs computed in Python, no ``now()`` /
  ``INTERVAL`` / ``::`` casts / ``RETURNING``, so the same statements run on
  Postgres and on the offline SQLite harness that gates these tests in CI.
* **All parameterized** (``$1..$N``) -> bandit B608 safe.
* **Fail-safe**: writes never raise; reads return ``None`` / ``False`` on error.
  Nothing here logs a payload.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any, AsyncGenerator, Callable, Optional

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

logger = logging.getLogger(__name__)

RunFrame = dict[str, str]

RUN_KINDS = frozenset({"debate", "import"})
TERMINAL_STATUSES = frozenset({"completed", "failed", "canceled"})

# Rows expire on the same horizon as the in-memory debate buffer.
RETENTION_SECONDS = 6 * 60 * 60
# The owner refreshes its heartbeat and progress this often and reads cancel
# requests in the same round trip.
HEARTBEAT_SECONDS = 5.0
# A running row whose heartbeat is older than this has lost its owner (process
# killed, instance scaled in). Generous against event-loop stalls on the owner.
OWNER_STALE_SECONDS = 60
# How often a process that does not hold a run re-reads its row while following.
FOLLOW_POLL_SECONDS = 2.0
# How long after the end of a run its owner keeps answering hand-off requests,
# unless its own attached stream already delivered the terminal frame.
RELAY_WINDOW_SECONDS = 15 * 60
# How long a follower waits for the owner to seal the terminal frame after the
# run has ended, before reporting that the result is not retained.
RELAY_WAIT_SECONDS = 3 * HEARTBEAT_SECONDS

_RELAY_INFO = b"hushh-kai-run-relay-v1"
_SAFE_IDENTIFIER = re.compile(r"^[a-z][a-z0-9_]{0,47}$")
_SAFE_CODE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")


def _now() -> int:
    return int(time.time())


# Cleanups that must finish even if the request awaiting them is cancelled.
# sse-starlette cancels a disconnected stream again at every await, so a plain
# ``await`` in a ``finally`` never completes; the reference keeps each task alive.
_CLEANUPS: set[asyncio.Task] = set()


async def _complete_even_if_cancelled(coro: Any) -> None:
    task = asyncio.ensure_future(coro)
    _CLEANUPS.add(task)
    task.add_done_callback(_CLEANUPS.discard)
    await asyncio.shield(task)


def _safe_identifier(value: Any) -> Optional[str]:
    text = str(value or "").strip()
    return text if _SAFE_IDENTIFIER.match(text) else None


def safe_code(value: Any) -> Optional[str]:
    text = str(value or "").strip()
    return text if _SAFE_CODE.match(text) else None


def _envelope(frame: RunFrame) -> dict[str, Any]:
    try:
        value = json.loads(frame.get("data", ""))
    except Exception:
        return {}
    return value if isinstance(value, dict) else {}


def progress_from_events(events: list[RunFrame]) -> dict[str, Any]:
    """The only progress checkpoint allowed in durable storage.

    An event count plus the server-defined event and phase names of the latest
    frame. ``progress_pct`` is a number the stream builder derives.
    """
    progress: dict[str, Any] = {"events_count": len(events)}
    if not events:
        return progress
    last = events[-1]
    payload = _envelope(last).get("payload")
    payload = payload if isinstance(payload, dict) else {}
    progress["last_event"] = _safe_identifier(last.get("event"))
    progress["phase"] = _safe_identifier(payload.get("phase"))
    pct = payload.get("progress_pct")
    if isinstance(pct, (int, float)) and not isinstance(pct, bool):
        progress["progress_pct"] = max(0.0, min(float(pct), 100.0))
    return progress


def safe_receipt(*, run_id: str, status: str, terminal_payload: Any) -> dict[str, Any]:
    """Terminal receipt: the outcome and a server-defined code, never the result."""
    source = terminal_payload if isinstance(terminal_payload, dict) else {}
    return {"run_id": run_id, "status": status, "code": safe_code(source.get("code"))}


# --------------------------------------------------------------------------- #
# sealed terminal hand-off
# --------------------------------------------------------------------------- #
def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.b64decode(text.encode("ascii"), validate=True)


def _relay_salt() -> bytes:
    """A salt only the backend can compute, derived from its signing secret.

    ECDH alone would let anyone who can write the database seal a forged frame
    to the stored public key, or swap in their own key and read the frame.
    Without this secret they can do neither.
    """
    from hushh_mcp.config import APP_SIGNING_KEY

    return hmac.new(
        APP_SIGNING_KEY.encode("utf-8"), _RELAY_INFO + b"|salt", hashlib.sha256
    ).digest()


def _binding(*, run_id: str, user_id: str, sender_public: str, recipient_public: str) -> bytes:
    return b"|".join(
        (
            _RELAY_INFO,
            run_id.encode("utf-8"),
            user_id.encode("utf-8"),
            sender_public.encode("ascii"),
            recipient_public.encode("ascii"),
        )
    )


def _derive_key(shared: bytes, binding: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=_relay_salt(), info=binding).derive(
        shared
    )


def _public_key_text(relay_identity: X25519PrivateKey) -> str:
    return _b64(
        relay_identity.public_key().public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        )
    )


def seal_frame(frame: RunFrame, *, recipient_public_key: str, run_id: str, user_id: str) -> str:
    """Seal one frame to a follower's one-time public key, for this run and person."""
    recipient = X25519PublicKey.from_public_bytes(_unb64(recipient_public_key))
    ephemeral = X25519PrivateKey.generate()
    sender_public = _public_key_text(ephemeral)
    binding = _binding(
        run_id=run_id,
        user_id=user_id,
        sender_public=sender_public,
        recipient_public=recipient_public_key,
    )
    key = _derive_key(ephemeral.exchange(recipient), binding)
    nonce = os.urandom(12)
    plaintext = json.dumps({"event": frame.get("event"), "data": frame.get("data")}).encode()
    ciphertext = AESGCM(key).encrypt(nonce, plaintext, binding)
    return json.dumps({"v": 1, "epk": sender_public, "n": _b64(nonce), "ct": _b64(ciphertext)})


def open_frame(
    sealed: str, *, relay_identity: X25519PrivateKey, run_id: str, user_id: str
) -> Optional[RunFrame]:
    """Open a sealed frame; ``None`` unless the backend sealed it to this key, run and person."""
    try:
        box = json.loads(sealed)
        if box.get("v") != 1:
            return None
        sender = X25519PublicKey.from_public_bytes(_unb64(box["epk"]))
        binding = _binding(
            run_id=run_id,
            user_id=user_id,
            sender_public=str(box["epk"]),
            recipient_public=_public_key_text(relay_identity),
        )
        key = _derive_key(relay_identity.exchange(sender), binding)
        plaintext = AESGCM(key).decrypt(_unb64(box["n"]), _unb64(box["ct"]), binding)
        value = json.loads(plaintext)
        frame = {"event": str(value["event"]), "data": str(value["data"])}
        frame["id"] = str(_envelope(frame).get("seq") or "")
        return frame
    except Exception:
        return None


# --------------------------------------------------------------------------- #
# durable state
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class DurableRunState:
    """One run's durable row, as any process reads it."""

    run_id: str
    user_id: str
    run_kind: str
    session_id: str
    ticker: str
    status: str
    terminal_event: Optional[str]
    receipt: dict[str, Any]
    started_at_iso: Optional[str]
    completed_at_iso: Optional[str]
    heartbeat_at: Optional[int]
    finished_at: Optional[int]
    cancel_requested: bool
    progress: dict[str, Any] = field(default_factory=dict)

    @property
    def is_terminal(self) -> bool:
        return self.status in TERMINAL_STATUSES

    @property
    def events_count(self) -> int:
        try:
            return max(0, int(self.progress.get("events_count") or 0))
        except (TypeError, ValueError):
            return 0

    def owner_alive(self, now: Optional[int] = None) -> bool:
        """True while a running row's owner is still heartbeating."""
        if self.status != "running" or self.heartbeat_at is None:
            return False
        return (_now() if now is None else now) - int(self.heartbeat_at) <= OWNER_STALE_SECONDS

    def relay_open(self, now: Optional[int] = None) -> bool:
        """True while the owner may still hand off this run's terminal frame."""
        if self.status == "running":
            return self.owner_alive(now)
        if self.finished_at is None:
            return False
        return (_now() if now is None else now) - int(self.finished_at) <= RELAY_WINDOW_SECONDS


def _json_object(raw: Any) -> dict[str, Any]:
    try:
        value = json.loads(raw or "{}")
    except Exception:
        return {}
    return value if isinstance(value, dict) else {}


def _state_from_row(row: Any) -> DurableRunState:
    return DurableRunState(
        run_id=row["run_id"],
        user_id=row["user_id"] or "",
        run_kind=row["run_kind"],
        session_id=row["session_id"] or "",
        ticker=row["ticker"] or "",
        status=row["status"],
        terminal_event=row["terminal_event"],
        receipt=_json_object(row["terminal_receipt"]),
        started_at_iso=row["started_at_iso"],
        completed_at_iso=row["completed_at_iso"],
        heartbeat_at=row["heartbeat_at"],
        finished_at=row["finished_at"],
        cancel_requested=row["cancel_requested_at"] is not None,
        progress=_json_object(row["progress"]),
    )


async def _pool() -> Any:
    from db.connection import get_pool

    return await get_pool()


class KaiRunStore:
    """Read and write ``kai_run_state`` rows. Stateless; safe to share."""

    def __init__(self, *, retention_seconds: int = RETENTION_SECONDS) -> None:
        self._retention_seconds = max(60, int(retention_seconds))

    async def heartbeat(
        self,
        *,
        run_id: str,
        user_id: str,
        run_kind: str,
        session_id: str,
        ticker: str,
        started_at_iso: Optional[str],
        progress: dict[str, Any],
        sweep_expired: bool = False,
    ) -> bool:
        """Write or refresh the owner's running row. Returns True if cancel was requested.

        The first call (at run start, with ``sweep_expired``) creates the row and
        deletes expired rows; later calls refresh the heartbeat and progress. A
        row that is already terminal, or that belongs to another person, is never
        overwritten. Never raises; returns False on error.
        """
        try:
            now = _now()
            pool = await _pool()
            if sweep_expired:
                await self._sweep(pool, now)
            await pool.execute(
                """
                INSERT INTO kai_run_state (
                    run_id, user_id, run_kind, session_id, ticker, status,
                    progress, started_at_iso, heartbeat_at, created_at, expires_at
                ) VALUES ($1, $2, $3, $4, $5, 'running', $6, $7, $8, $9, $10)
                ON CONFLICT (run_id) DO UPDATE SET
                    progress = EXCLUDED.progress,
                    heartbeat_at = EXCLUDED.heartbeat_at,
                    expires_at = EXCLUDED.expires_at
                WHERE kai_run_state.status = 'running'
                  AND kai_run_state.user_id = EXCLUDED.user_id
                """,
                run_id,
                user_id,
                run_kind,
                session_id,
                ticker,
                json.dumps(progress),
                started_at_iso,
                now,
                now,
                now + self._retention_seconds,
            )
            return await self.is_cancel_requested(run_id=run_id, user_id=user_id)
        except Exception:
            logger.warning("[KaiRunStore] heartbeat failed for %s", run_id, exc_info=True)
            return False

    async def persist_terminal(
        self,
        *,
        run_id: str,
        user_id: str,
        run_kind: str,
        session_id: str,
        ticker: str,
        status: str,
        terminal_event: Optional[str],
        terminal_payload: Any,
        started_at_iso: Optional[str],
        completed_at_iso: Optional[str],
        progress: dict[str, Any],
    ) -> None:
        """Write the run's terminal receipt once, at its end. Never raises."""
        if status not in TERMINAL_STATUSES:
            return
        try:
            now = _now()
            receipt = safe_receipt(run_id=run_id, status=status, terminal_payload=terminal_payload)
            pool = await _pool()
            await pool.execute(
                """
                INSERT INTO kai_run_state (
                    run_id, user_id, run_kind, session_id, ticker, status,
                    terminal_event, terminal_receipt, progress, started_at_iso,
                    completed_at_iso, heartbeat_at, finished_at, created_at, expires_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                ON CONFLICT (run_id) DO UPDATE SET
                    status = EXCLUDED.status,
                    terminal_event = EXCLUDED.terminal_event,
                    terminal_receipt = EXCLUDED.terminal_receipt,
                    progress = EXCLUDED.progress,
                    completed_at_iso = EXCLUDED.completed_at_iso,
                    heartbeat_at = EXCLUDED.heartbeat_at,
                    finished_at = EXCLUDED.finished_at,
                    expires_at = EXCLUDED.expires_at
                WHERE kai_run_state.user_id = EXCLUDED.user_id
                """,
                run_id,
                user_id,
                run_kind,
                session_id,
                ticker,
                status,
                terminal_event,
                json.dumps(receipt),
                json.dumps(progress),
                started_at_iso,
                completed_at_iso,
                now,
                now,
                now,
                now + self._retention_seconds,
            )
            await self._sweep(pool, now)
        except Exception:
            logger.warning("[KaiRunStore] persist_terminal failed for %s", run_id, exc_info=True)

    async def load(self, *, run_id: str, run_kind: str) -> Optional[DurableRunState]:
        """Read a live (unexpired) row of this kind. ``None`` on miss or error."""
        try:
            pool = await _pool()
            row = await pool.fetchrow(
                """
                SELECT run_id, user_id, run_kind, session_id, ticker, status,
                       terminal_event, terminal_receipt, progress, started_at_iso,
                       completed_at_iso, heartbeat_at, finished_at, cancel_requested_at
                FROM kai_run_state
                WHERE run_id = $1 AND run_kind = $2 AND expires_at >= $3
                """,
                run_id,
                run_kind,
                _now(),
            )
            return _state_from_row(row) if row is not None else None
        except Exception:
            logger.warning("[KaiRunStore] load failed for %s", run_id, exc_info=True)
            return None

    async def load_active(
        self, *, user_id: str, run_kind: str, session_id: str
    ) -> Optional[DurableRunState]:
        """The person's newest running run of this kind whose owner is alive."""
        try:
            now = _now()
            pool = await _pool()
            row = await pool.fetchrow(
                """
                SELECT run_id, user_id, run_kind, session_id, ticker, status,
                       terminal_event, terminal_receipt, progress, started_at_iso,
                       completed_at_iso, heartbeat_at, finished_at, cancel_requested_at
                FROM kai_run_state
                WHERE user_id = $1 AND run_kind = $2 AND session_id = $3
                  AND status = 'running' AND expires_at >= $4 AND heartbeat_at >= $5
                ORDER BY created_at DESC
                LIMIT 1
                """,
                user_id,
                run_kind,
                session_id,
                now,
                now - OWNER_STALE_SECONDS,
            )
            return _state_from_row(row) if row is not None else None
        except Exception:
            logger.warning("[KaiRunStore] load_active failed", exc_info=True)
            return None

    async def request_cancel(self, *, run_id: str, user_id: str) -> bool:
        """Record the owner's cancel for a running row. Never raises.

        Scoped to the row's own person, so a cancel for someone else's run
        changes nothing. The owning process reads it on its next heartbeat.
        """
        try:
            pool = await _pool()
            await pool.execute(
                "UPDATE kai_run_state SET cancel_requested_at = $1 "
                "WHERE run_id = $2 AND user_id = $3 AND status = 'running' "
                "AND cancel_requested_at IS NULL",
                _now(),
                run_id,
                user_id,
            )
            return True
        except Exception:
            logger.warning("[KaiRunStore] request_cancel failed for %s", run_id, exc_info=True)
            return False

    async def is_cancel_requested(self, *, run_id: str, user_id: str) -> bool:
        """True when the owner recorded a cancel for this run. False on any error."""
        try:
            pool = await _pool()
            row = await pool.fetchrow(
                "SELECT status, cancel_requested_at FROM kai_run_state "
                "WHERE run_id = $1 AND user_id = $2",
                run_id,
                user_id,
            )
            if row is None:
                return False
            return row["status"] == "canceled" or row["cancel_requested_at"] is not None
        except Exception:
            logger.warning("[KaiRunStore] is_cancel_requested failed for %s", run_id, exc_info=True)
            return False

    # ---- sealed terminal hand-off ------------------------------------------ #
    async def request_relay(self, *, run_id: str, user_id: str) -> Optional[X25519PrivateKey]:
        """Ask the owner to seal the terminal frame to a fresh one-time key.

        Returns the private key, which must stay in the caller's memory. A newer
        request replaces an older one; the older follower then falls back to
        the receipt.
        """
        try:
            relay_identity = X25519PrivateKey.generate()
            pool = await _pool()
            await pool.execute(
                "UPDATE kai_run_state SET relay_public_key = $1, relay_ciphertext = NULL "
                "WHERE run_id = $2 AND user_id = $3",
                _public_key_text(relay_identity),
                run_id,
                user_id,
            )
            return relay_identity
        except Exception:
            logger.warning("[KaiRunStore] request_relay failed for %s", run_id, exc_info=True)
            return None

    async def pending_relay_key(self, *, run_id: str, user_id: str) -> Optional[str]:
        """The owner's view: a follower's public key still waiting for its frame."""
        try:
            pool = await _pool()
            row = await pool.fetchrow(
                "SELECT relay_public_key FROM kai_run_state "
                "WHERE run_id = $1 AND user_id = $2 "
                "AND relay_public_key IS NOT NULL AND relay_ciphertext IS NULL",
                run_id,
                user_id,
            )
            return row["relay_public_key"] if row is not None else None
        except Exception:
            logger.warning("[KaiRunStore] pending_relay_key failed for %s", run_id, exc_info=True)
            return None

    async def publish_relay(
        self, *, run_id: str, user_id: str, public_key: str, frame: RunFrame
    ) -> None:
        """The owner seals its terminal frame to the waiting follower's key."""
        try:
            sealed = seal_frame(
                frame, recipient_public_key=public_key, run_id=run_id, user_id=user_id
            )
            pool = await _pool()
            await pool.execute(
                "UPDATE kai_run_state SET relay_ciphertext = $1 "
                "WHERE run_id = $2 AND user_id = $3 AND relay_public_key = $4 "
                "AND relay_ciphertext IS NULL",
                sealed,
                run_id,
                user_id,
                public_key,
            )
        except Exception:
            logger.warning("[KaiRunStore] publish_relay failed for %s", run_id, exc_info=True)

    async def take_relay(
        self, *, run_id: str, user_id: str, relay_identity: X25519PrivateKey
    ) -> Optional[RunFrame]:
        """The follower collects and deletes its sealed frame, if the owner sent it."""
        try:
            public_key = _public_key_text(relay_identity)
            pool = await _pool()
            row = await pool.fetchrow(
                "SELECT relay_ciphertext FROM kai_run_state "
                "WHERE run_id = $1 AND user_id = $2 AND relay_public_key = $3",
                run_id,
                user_id,
                public_key,
            )
            sealed = row["relay_ciphertext"] if row is not None else None
            if not sealed:
                return None
            await self.release_relay(run_id=run_id, user_id=user_id, relay_identity=relay_identity)
            return open_frame(sealed, relay_identity=relay_identity, run_id=run_id, user_id=user_id)
        except Exception:
            logger.warning("[KaiRunStore] take_relay failed for %s", run_id, exc_info=True)
            return None

    async def release_relay(
        self, *, run_id: str, user_id: str, relay_identity: X25519PrivateKey
    ) -> None:
        """Delete this follower's request and any ciphertext sealed to it."""
        try:
            pool = await _pool()
            await pool.execute(
                "UPDATE kai_run_state SET relay_public_key = NULL, relay_ciphertext = NULL "
                "WHERE run_id = $1 AND user_id = $2 AND relay_public_key = $3",
                run_id,
                user_id,
                _public_key_text(relay_identity),
            )
        except Exception:
            logger.warning("[KaiRunStore] release_relay failed for %s", run_id, exc_info=True)

    async def close_relay(self, *, run_id: str, user_id: str) -> None:
        """The owner stops answering: delete any request or ciphertext left behind."""
        try:
            pool = await _pool()
            await pool.execute(
                "UPDATE kai_run_state SET relay_public_key = NULL, relay_ciphertext = NULL "
                "WHERE run_id = $1 AND user_id = $2 AND relay_public_key IS NOT NULL",
                run_id,
                user_id,
            )
        except Exception:
            logger.warning("[KaiRunStore] close_relay failed for %s", run_id, exc_info=True)

    async def _sweep(self, pool: Any, now: int) -> None:
        """Delete expired rows and hand-offs whose window has closed."""
        await pool.execute("DELETE FROM kai_run_state WHERE expires_at < $1", now)
        await pool.execute(
            "UPDATE kai_run_state SET relay_public_key = NULL, relay_ciphertext = NULL "
            "WHERE finished_at < $1 AND relay_public_key IS NOT NULL",
            now - RELAY_WINDOW_SECONDS,
        )


# --------------------------------------------------------------------------- #
# shared owner- and follower-side loops
# --------------------------------------------------------------------------- #
async def serve_relay(
    store: KaiRunStore,
    *,
    run_id: str,
    user_id: str,
    terminal_frame: Optional[RunFrame],
    delivered: Callable[[], bool],
) -> None:
    """Owner side: answer hand-off requests until delivered or the window closes.

    On exit it deletes whatever a follower left behind (a follower process that
    died cannot clean up after itself).
    """
    if terminal_frame is None:
        return
    deadline = time.monotonic() + RELAY_WINDOW_SECONDS
    try:
        while not delivered() and time.monotonic() < deadline:
            public_key = await store.pending_relay_key(run_id=run_id, user_id=user_id)
            if public_key:
                await store.publish_relay(
                    run_id=run_id, user_id=user_id, public_key=public_key, frame=terminal_frame
                )
            await asyncio.sleep(HEARTBEAT_SECONDS)
    finally:
        await _complete_even_if_cancelled(store.close_relay(run_id=run_id, user_id=user_id))


FallbackFrame = Callable[[DurableRunState, str, int], RunFrame]


async def follow_remote_run(
    store: KaiRunStore,
    *,
    state: DurableRunState,
    start_cursor: int,
    request: Any,
    fallback_frame: FallbackFrame,
) -> AsyncGenerator[RunFrame, None]:
    """Follower side: stream a run another process holds until it ends.

    Yields exactly one terminal frame: the owner's real terminal frame when the
    hand-off succeeds, otherwise ``fallback_frame(state, reason, seq)`` where
    ``reason`` is ``owner_lost``, ``not_retained`` or the terminal status.
    Emits nothing while the run is in progress; SSE pings keep the connection.
    """
    relay_identity = (
        await store.request_relay(run_id=state.run_id, user_id=state.user_id)
        if state.relay_open()
        else None
    )
    waited_after_end = 0.0
    try:
        while True:
            if await request.is_disconnected():
                return
            if relay_identity is not None:
                frame = await store.take_relay(
                    run_id=state.run_id, user_id=state.user_id, relay_identity=relay_identity
                )
                if frame is not None:
                    relay_identity = None
                    yield frame
                    return

            # A frame the client has not yet seen: at least one past its cursor
            # and never below the owner's own terminal sequence number.
            seq = max(state.events_count, start_cursor + 1, 1)
            if state.status == "running" and not state.owner_alive():
                yield fallback_frame(state, "owner_lost", seq)
                return
            if state.is_terminal:
                if state.status != "completed":
                    yield fallback_frame(state, state.status, seq)
                    return
                if relay_identity is None or waited_after_end >= RELAY_WAIT_SECONDS:
                    yield fallback_frame(state, "not_retained", seq)
                    return
                waited_after_end += FOLLOW_POLL_SECONDS

            await asyncio.sleep(FOLLOW_POLL_SECONDS)
            refreshed = await store.load(run_id=state.run_id, run_kind=state.run_kind)
            if refreshed is None:
                yield fallback_frame(state, "owner_lost", seq)
                return
            state = refreshed
    finally:
        if relay_identity is not None:
            # Deleted even when the client disconnected mid-follow.
            await _complete_even_if_cancelled(
                store.release_relay(
                    run_id=state.run_id, user_id=state.user_id, relay_identity=relay_identity
                )
            )


def default_store_from_flag() -> Optional[KaiRunStore]:
    """The durable store unless ``KAI_ANALYZE_DURABLE_RUN_STORE`` is explicitly off.

    Durable state is required for correctness on any lane with more than one
    worker process, so it is on by default; the existing variable remains only
    as an emergency kill switch.
    """
    try:
        from hushh_mcp.runtime_settings import kai_analyze_durable_run_store_enabled

        return KaiRunStore() if kai_analyze_durable_run_store_enabled() else None
    except Exception:  # pragma: no cover - defensive
        logger.warning("[KaiRunStore] unavailable; continuing in-memory only", exc_info=True)
        return None


async def owner_heartbeat(
    store: KaiRunStore, *, run: Any, run_kind: str, session_id: str, ticker: str
) -> None:
    """Owner side: refresh the running row and act on a cancel recorded elsewhere.

    ``run`` is a debate or import run record (``run_id``, ``user_id``,
    ``started_at``, ``events``, ``status``, ``cancel_event``, ``condition``).
    """
    while run.status == "running":
        await asyncio.sleep(HEARTBEAT_SECONDS)
        if run.status != "running":
            return
        canceled = await store.heartbeat(
            run_id=run.run_id,
            user_id=run.user_id,
            run_kind=run_kind,
            session_id=session_id,
            ticker=ticker,
            started_at_iso=run.started_at,
            progress=progress_from_events(run.events),
        )
        if canceled and not run.cancel_event.is_set():
            run.cancel_event.set()
            async with run.condition:
                run.condition.notify_all()


def fallback_terminal_frame(
    state: DurableRunState,
    *,
    seq: int,
    event: str,
    code: str,
    message: str,
    retryable: bool,
    stream_prefix: str,
    stream_kind: str,
    extra: Optional[dict[str, Any]] = None,
) -> RunFrame:
    """A terminal frame built from durable metadata alone (no owner information)."""
    payload: dict[str, Any] = dict(extra or {})
    payload.update(
        {"code": code, "message": message, "run_id": state.run_id, "retryable": retryable}
    )
    return {
        "event": event,
        "id": str(seq),
        "data": json.dumps(
            {
                "schema_version": "1.0",
                "stream_id": f"{stream_prefix}{state.run_id}",
                "stream_kind": stream_kind,
                "seq": seq,
                "event": event,
                "terminal": True,
                "payload": payload,
            }
        ),
    }
