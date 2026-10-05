"""Fire the owner's due scheduled Gmail sends, each at most once.

``schedule_mail`` stores a ``scheduled`` row in ``gmail_owner_send_actions``:
an envelope HMAC computed exactly as an immediate send's ``prepare()`` would,
an AES-GCM sealed payload, ``send_at`` and ``expires_at = send_at + 24h``. This
drain is the only thing that turns such a row into a delivery, and it adds no
send pipeline of its own:

1. Claim one due row at a time with ``FOR UPDATE SKIP LOCKED`` in a short
   transaction, so concurrent drains (and a voice cancel, which updates the
   same row under the same lock) elect exactly one winner.
2. While holding the lock: refuse a row past its send window, open the sealed
   payload, re-verify that the owner's Gmail is still connected
   (``gmail_unavailable``) as the account the email was scheduled from
   (``sender_changed``), and that the recipient is still a connection
   (``recipient_disconnected``) at the sealed address (``recipient_changed``).
   Each refusal is ``failed`` with its reason. Then arm it
   ``scheduled -> prepared`` and commit.
3. Hand the unsealed draft to the EXISTING ``GmailDeliveryService.execute()``,
   which re-locks the row, re-verifies the envelope HMAC, owns
   ``prepared -> sending -> {sent, failed, outcome_unknown}`` and POSTs once.
4. Read the row back -- the ledger, never the return value, says what happened
   -- and notify the owner once (``notified_at`` claims the notification).

An unsent email always leaves a lasting record: every refusal, including a
passed send window and a disconnected recipient, is settled ``failed``, which
migration 252's trigger projects into the Feed as ``mail_message_failed`` even
when the owner has notifications off. The drain never settles a row
``expired`` or ``cancelled``; those response keys stay for the documented shape.

Data minimization: every terminal transition the drain makes or observes clears
``payload_sealed`` and ``subject`` -- nothing ever re-sends such a row, so the
sealed mail and its subject have no further use. Each run first clears a
bounded batch of terminal scheduled rows still holding either (a crash between
execute() and the read-back, or a voice cancel, can leave them).

Never re-sent: ``sending`` and ``outcome_unknown`` rows are never claimed. A
row orphaned in ``prepared`` (armed, but ``execute()`` never reached
``sending``, so Gmail was never called) is re-armed after ten minutes; a row
stuck in ``sending`` for ten minutes (the process died mid-POST) is recorded as
``outcome_unknown``, because Gmail may have delivered it.

Nothing here logs or returns an address, subject, body or recipient name: the
result carries action ids and counts only.
"""

from __future__ import annotations

import asyncio
import hmac
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Protocol

from db.connection import get_pool
from hushh_mcp.services.connections_service import ConnectionsService
from hushh_mcp.services.gmail_delivery_service import (
    GmailDeliveryError,
    get_gmail_delivery_service,
    normalize_draft,
)
from hushh_mcp.services.push_notifications import send_user_data_push

logger = logging.getLogger(__name__)

MAX_DRAIN_LIMIT = 100
DEFAULT_DEADLINE_SECONDS = 240
# An armed row that never reached ``sending`` after this many arms is failed
# rather than re-armed forever; the 24h send window bounds it as well.
MAX_ATTEMPTS = 3

DRAIN_RESULT_KEYS = ("sent", "failed", "outcome_unknown", "cancelled", "expired")

_SCRUB_TERMINAL_ROWS_SQL = """
WITH held AS (
    SELECT action_id
    FROM gmail_owner_send_actions
    WHERE send_at IS NOT NULL
      AND state IN ('sent', 'failed', 'outcome_unknown', 'expired', 'cancelled')
      AND (payload_sealed IS NOT NULL OR subject IS NOT NULL)
    LIMIT $1
    FOR UPDATE SKIP LOCKED
)
UPDATE gmail_owner_send_actions AS action
SET payload_sealed = NULL, subject = NULL
FROM held
WHERE action.action_id = held.action_id
  AND action.state IN ('sent', 'failed', 'outcome_unknown', 'expired', 'cancelled')
RETURNING action.action_id
"""

_STALE_SENDING_SQL = """
WITH stale AS (
    SELECT action_id
    FROM gmail_owner_send_actions
    WHERE state = 'sending'
      AND send_at IS NOT NULL
      AND sending_at < NOW() - INTERVAL '10 minutes'
    ORDER BY sending_at ASC
    LIMIT $1
    FOR UPDATE SKIP LOCKED
)
UPDATE gmail_owner_send_actions AS action
SET state = 'outcome_unknown', safe_error_code = 'drain_interrupted',
    payload_sealed = NULL, subject = NULL, updated_at = NOW()
FROM stale
WHERE action.action_id = stale.action_id AND action.state = 'sending'
RETURNING action.action_id, action.user_id
"""

_CLAIM_SQL = """
SELECT action_id, user_id, state, attempt_count, payload_sealed,
       (expires_at <= NOW()) AS window_passed
FROM gmail_owner_send_actions
WHERE ((state = 'scheduled' AND send_at <= NOW())
    OR (state = 'prepared' AND send_at IS NOT NULL AND sending_at IS NULL
        AND updated_at < NOW() - INTERVAL '10 minutes'))
  AND NOT (action_id = ANY($1::text[]))
ORDER BY send_at ASC, action_id ASC
LIMIT 1
FOR UPDATE SKIP LOCKED
"""

_SETTLE_UNSENT_SQL = """
UPDATE gmail_owner_send_actions
SET state = $3, safe_error_code = $4, payload_sealed = NULL, subject = NULL,
    updated_at = NOW()
WHERE action_id = $1 AND user_id = $2
  AND state IN ('scheduled', 'prepared') AND sending_at IS NULL
"""

_ARM_SQL = """
UPDATE gmail_owner_send_actions
SET state = 'prepared', attempt_count = attempt_count + 1, updated_at = NOW()
WHERE action_id = $1 AND user_id = $2
  AND state IN ('scheduled', 'prepared') AND sending_at IS NULL
RETURNING action_id
"""

# execute() refuses an armed row whose window closed while it was armed and
# leaves it armed (its expiry write skips scheduled rows), so the window names
# the reason here.
_FAIL_ARMED_SQL = """
UPDATE gmail_owner_send_actions
SET state = 'failed',
    safe_error_code = CASE
        WHEN expires_at <= NOW() THEN 'schedule_window_passed' ELSE $3::text
    END,
    payload_sealed = NULL, subject = NULL, updated_at = NOW()
WHERE action_id = $1 AND user_id = $2 AND state = 'prepared' AND sending_at IS NULL
"""

# execute() records sent / failed / outcome_unknown / expired with its own SQL;
# the drain clears the sealed payload and subject once it reads such a state back.
_SCRUB_TERMINAL_PAYLOAD_SQL = """
UPDATE gmail_owner_send_actions
SET payload_sealed = NULL, subject = NULL
WHERE action_id = $1 AND user_id = $2
  AND (payload_sealed IS NOT NULL OR subject IS NOT NULL)
  AND state IN ('sent', 'failed', 'outcome_unknown', 'expired', 'cancelled')
"""

_READ_STATE_SQL = """
SELECT state, safe_error_code
FROM gmail_owner_send_actions
WHERE action_id = $1 AND user_id = $2
"""

_CLAIM_NOTIFICATION_SQL = """
UPDATE gmail_owner_send_actions
SET notified_at = NOW()
WHERE action_id = $1 AND user_id = $2 AND state = $3 AND notified_at IS NULL
RETURNING recipient_display
"""

# execute() refusals that happen before it moves the row to ``sending``.
_PRE_SEND_CODES = {"DRAFT_CHANGED": "draft_changed", "INVALID_RECIPIENTS": "invalid_draft"}

_FAILURE_REASONS = {
    "sender_changed": "your connected Gmail account changed",
    "recipient_changed": "their email address changed",
    "payload_unseal_failed": "it couldn't be opened securely",
    "draft_changed": "it changed after it was scheduled",
    "invalid_draft": "it couldn't be prepared for Gmail",
    "retry_exhausted": "several attempts didn't go through",
    "gmail_send_failed": "Gmail declined it",
}
_DEFAULT_FAILURE_REASON = "something went wrong"
# Nothing is kept to review once a scheduled send fails (its sealed mail is
# cleared), so no copy offers a resend; asking One to schedule it again is real.
_SCHEDULE_AGAIN = "Nothing was delivered. You can ask One to schedule it again."
_FAILURE_BODIES = {
    "gmail_unavailable": (
        "Your scheduled email to {name} wasn't sent because your Gmail is disconnected "
        "or needs to be reconnected. Nothing was delivered. Reconnect Gmail, then ask "
        "One to schedule it again."
    ),
    "recipient_disconnected": (
        "Your scheduled email to {name} wasn't sent because you're no longer connected "
        "with them. Nothing was delivered."
    ),
    "schedule_window_passed": (
        "Your scheduled email to {name} wasn't sent because the send window passed. "
        + _SCHEDULE_AGAIN
    ),
}
_FALLBACK_RECIPIENT = "your recipient"
# Every tap decider in the webapp (buildNotificationTapTarget,
# resolveNotificationClickTarget and the web worker's notificationTapTarget)
# sends an unrecognized type to the Feed and never trusts ``deep_link``. The
# Feed is also where the send outcome is projected (mail_message_sent /
# _failed / mail_delivery_unconfirmed), so the link states that landing.
_PUSH_DEEP_LINK = "/one/feed"
_PUSH_CATEGORY = "ONE_MAIL"


class ScheduledDelivery(Protocol):
    """The delivery port the drain needs: GmailDeliveryService satisfies it."""

    def open_schedule_payload(
        self, *, user_id: str, action_id: str, sealed: str
    ) -> dict[str, Any]: ...

    def scheduled_draft_payload(self, payload: dict[str, Any]) -> dict[str, Any]: ...

    async def current_sender_sub(self, *, user_id: str) -> str | None: ...

    async def execute(
        self, *, user_id: str, action_id: str, draft_payload: dict[str, Any]
    ) -> dict[str, Any]: ...


class RecipientDirectory(Protocol):
    def list_connections(self, user_id: str) -> list[dict[str, Any]]: ...


PushSender = Callable[..., int]
PoolProvider = Callable[[], Awaitable[Any]]


@dataclass(frozen=True)
class _Armed:
    action_id: str
    user_id: str
    draft_payload: dict[str, Any]


@dataclass(frozen=True)
class _Settled:
    action_id: str
    user_id: str
    state: str
    safe_error_code: str | None


def _single_address(raw: Any) -> str | None:
    """The one normalized address in ``raw``, with the delivery normalizer."""
    try:
        draft = normalize_draft({"to": raw, "subject": "", "body": ""})
    except GmailDeliveryError:
        return None
    if len(draft.to) != 1 or draft.cc or draft.bcc:
        return None
    return str(draft.to[0])


def scheduled_mail_push(
    *, state: str, action_id: str, recipient_display: str | None, safe_error_code: str | None
) -> dict[str, Any] | None:
    """The owner notification for a terminal scheduled-send outcome, or None.

    Names only who the owner addressed (the display label they confirmed);
    never the address, subject or body.
    """
    name = str(recipient_display or "").strip() or _FALLBACK_RECIPIENT
    if state == "sent":
        kind, title = "sent", "Scheduled email sent"
        body = f"Your scheduled email to {name} was sent."
    elif state == "failed":
        code = str(safe_error_code or "")
        reason = _FAILURE_REASONS.get(code, _DEFAULT_FAILURE_REASON)
        kind, title = "failed", "Scheduled email not sent"
        template = _FAILURE_BODIES.get(code)
        body = (
            template.format(name=name)
            if template is not None
            else f"Your scheduled email to {name} wasn't sent ({reason}). {_SCHEDULE_AGAIN}"
        )
    elif state == "outcome_unknown":
        kind, title = "unknown", "Scheduled email status unclear"
        body = (
            f"We couldn't confirm whether your scheduled email to {name} was sent. "
            "Please check your Gmail Sent folder before resending."
        )
    else:
        return None
    return {
        "notification_type": f"mail_scheduled_{kind}",
        "title": title,
        "body": body,
        "deep_link": _PUSH_DEEP_LINK,
        "notification_tag": f"mail-scheduled-{kind}-{action_id}",
        "notification_category": _PUSH_CATEGORY,
        "data": {"message_id": f"mail-scheduled-{kind}:{action_id}"},
        # Routing stays server-side; the account id never reaches the device.
        "include_user_id": False,
    }


def safe_scheduled_drain_result(result: dict[str, Any]) -> dict[str, Any]:
    """Only the documented keys: counts, the limit and opaque action ids."""
    safe: dict[str, Any] = {
        "success": result.get("success") is True,
        "fired": int(result.get("fired") or 0),
        "limit": int(result.get("limit") or 0),
    }
    for key in DRAIN_RESULT_KEYS:
        safe[key] = [str(item) for item in result.get(key) or [] if isinstance(item, str)]
    return safe


class _ScheduledMailDrain:
    def __init__(
        self,
        *,
        delivery: ScheduledDelivery,
        directory: RecipientDirectory,
        push: PushSender,
        pool_provider: PoolProvider,
    ) -> None:
        self._delivery = delivery
        self._directory = directory
        self._push = push
        self._pool_provider = pool_provider
        self._outcomes: dict[str, list[str]] = {key: [] for key in DRAIN_RESULT_KEYS}
        self._fired = 0

    async def run(
        self, *, limit: int, deadline_seconds: float, clock: Callable[[], float]
    ) -> dict[str, Any]:
        started = clock()
        pool = await self._pool_provider()
        await self._scrub_terminal_rows(pool, limit=limit)
        for settled in await self._settle_stale_sending(pool, limit=limit):
            await self._record(pool, settled)
        seen: list[str] = []
        for _ in range(limit):
            if clock() - started >= deadline_seconds:
                break
            claimed = await self._claim_next(pool, seen)
            if claimed is None:
                break
            if isinstance(claimed, _Settled):
                await self._record(pool, claimed)
                continue
            if isinstance(claimed, _Armed):
                await self._record(pool, await self._fire(pool, claimed))
        return {"success": True, "fired": self._fired, **self._outcomes, "limit": limit}

    async def _scrub_terminal_rows(self, pool: Any, *, limit: int) -> None:
        """Clear mail a finished scheduled row still holds. Hygiene, never fatal."""
        try:
            async with pool.acquire() as conn:
                await conn.fetch(_SCRUB_TERMINAL_ROWS_SQL, limit)
        except Exception as exc:
            logger.warning("gmail.scheduled_drain.scrub_failed error=%s", type(exc).__name__)

    async def _settle_stale_sending(self, pool: Any, *, limit: int) -> list[_Settled]:
        async with pool.acquire() as conn:
            rows = await conn.fetch(_STALE_SENDING_SQL, limit)
        return [
            _Settled(
                action_id=str(row["action_id"]),
                user_id=str(row["user_id"]),
                state="outcome_unknown",
                safe_error_code="drain_interrupted",
            )
            for row in rows or []
        ]

    async def _claim_next(self, pool: Any, seen: list[str]) -> _Armed | _Settled | str | None:
        """Lock and decide one due row. Returns None when nothing is due.

        A failure before any row is locked propagates (the drain is unavailable);
        a failure while deciding a locked row rolls that row back untouched, so a
        later run takes it again, and is returned as its action id (deferred).
        """
        claimed_id: str | None = None
        try:
            async with pool.acquire() as conn:
                async with conn.transaction():
                    row = await conn.fetchrow(_CLAIM_SQL, seen)
                    if row is None:
                        return None
                    claimed_id = str(row["action_id"])
                    seen.append(claimed_id)
                    return await self._decide(conn, dict(row))
        except Exception as exc:
            if claimed_id is None:
                raise
            logger.warning("gmail.scheduled_drain.row_deferred error=%s", type(exc).__name__)
            return claimed_id

    async def _decide(self, conn: Any, row: dict[str, Any]) -> _Armed | _Settled:
        action_id = str(row["action_id"])
        user_id = str(row["user_id"])

        async def settle(state: str, code: str) -> _Settled:
            await conn.execute(_SETTLE_UNSENT_SQL, action_id, user_id, state, code)
            return _Settled(action_id=action_id, user_id=user_id, state=state, safe_error_code=code)

        if row.get("window_passed") is True:
            return await settle("failed", "schedule_window_passed")
        if str(row.get("state")) == "prepared" and int(row.get("attempt_count") or 0) >= (
            MAX_ATTEMPTS
        ):
            return await settle("failed", "retry_exhausted")
        try:
            payload = self._delivery.open_schedule_payload(
                user_id=user_id, action_id=action_id, sealed=str(row.get("payload_sealed") or "")
            )
            sealed_to = _single_address(payload.get("to"))
            recipient_user_id = str(payload.get("recipient_user_id") or "").strip()
            sealed_sender = str(payload.get("sender_sub") or "").strip()
            draft_payload = self._delivery.scheduled_draft_payload(payload)
        except Exception:
            # Never log the exception text: it may describe the plaintext.
            return await settle("failed", "payload_unseal_failed")
        if sealed_to is None or not recipient_user_id:
            return await settle("failed", "payload_unseal_failed")

        # The owner confirmed sending from one Gmail account. A reconnect to a
        # different account must not send it from that one, and no usable
        # connection (disconnected or needing re-auth) sends nothing. A lookup
        # error propagates: the row rolls back untouched and a later run retries.
        if not sealed_sender:
            return await settle("failed", "sender_changed")
        current_sender = str(await self._delivery.current_sender_sub(user_id=user_id) or "").strip()
        if not current_sender:
            return await settle("failed", "gmail_unavailable")
        if not hmac.compare_digest(sealed_sender.encode(), current_sender.encode()):
            return await settle("failed", "sender_changed")

        connections = await asyncio.to_thread(self._directory.list_connections, user_id)
        connection = next(
            (
                item
                for item in connections or []
                if str(item.get("userId") or "") == recipient_user_id
            ),
            None,
        )
        if connection is None:
            return await settle("failed", "recipient_disconnected")
        current = _single_address(connection.get("email"))
        if current is None or not hmac.compare_digest(current, sealed_to):
            return await settle("failed", "recipient_changed")

        armed = await conn.fetchrow(_ARM_SQL, action_id, user_id)
        if armed is None:
            raise RuntimeError("scheduled row changed under its lock")
        return _Armed(action_id=action_id, user_id=user_id, draft_payload=draft_payload)

    async def _fire(self, pool: Any, armed: _Armed) -> _Settled | str:
        self._fired += 1
        try:
            await self._delivery.execute(
                user_id=armed.user_id,
                action_id=armed.action_id,
                draft_payload=armed.draft_payload,
            )
        except GmailDeliveryError as exc:
            # Refused before ``sending`` leaves the row armed: settle it, so the
            # orphan reaper does not re-arm a send execute() already refused.
            # After ``sending`` execute() has recorded the terminal state and
            # this update matches nothing. If the update itself fails the row
            # stays armed; any re-arm goes back through execute()'s checks.
            try:
                async with pool.acquire() as conn:
                    await conn.execute(
                        _FAIL_ARMED_SQL,
                        armed.action_id,
                        armed.user_id,
                        _PRE_SEND_CODES.get(exc.code, "send_refused"),
                    )
            except Exception as settle_exc:
                logger.warning(
                    "gmail.scheduled_drain.settle_failed error=%s", type(settle_exc).__name__
                )
        except Exception as exc:
            # Pre-``sending`` (still prepared: re-armed later, Gmail never
            # called) or post-``sending`` (stale-sending sweep makes it
            # outcome_unknown). Either way, never retried here.
            logger.warning("gmail.scheduled_drain.execute_error error=%s", type(exc).__name__)
        try:
            async with pool.acquire() as conn:
                row = await conn.fetchrow(_READ_STATE_SQL, armed.action_id, armed.user_id)
                if row is not None and str(row["state"]) in DRAIN_RESULT_KEYS:
                    try:
                        await conn.execute(
                            _SCRUB_TERMINAL_PAYLOAD_SQL, armed.action_id, armed.user_id
                        )
                    except Exception as exc:
                        # The row is terminal either way; still report and notify.
                        logger.warning(
                            "gmail.scheduled_drain.scrub_failed error=%s", type(exc).__name__
                        )
        except Exception as exc:
            # execute() already ran: the ledger holds the outcome and nothing
            # re-sends a row past ``prepared``. Leave it for the next run's scrub
            # and sweeps rather than abort the batch.
            logger.warning("gmail.scheduled_drain.read_back_failed error=%s", type(exc).__name__)
            return armed.action_id
        if row is None or str(row["state"]) not in DRAIN_RESULT_KEYS:
            # Still prepared or sending: a later run settles it, never re-sends.
            return armed.action_id
        return _Settled(
            action_id=armed.action_id,
            user_id=armed.user_id,
            state=str(row["state"]),
            safe_error_code=str(row["safe_error_code"] or "") or None,
        )

    async def _record(self, pool: Any, settled: _Settled | str) -> None:
        if isinstance(settled, str):
            return
        self._outcomes[settled.state].append(settled.action_id)
        try:
            async with pool.acquire() as conn:
                claimed = await conn.fetchrow(
                    _CLAIM_NOTIFICATION_SQL, settled.action_id, settled.user_id, settled.state
                )
        except Exception as exc:
            logger.warning("gmail.scheduled_drain.notify_claim_failed error=%s", type(exc).__name__)
            return
        if claimed is None:
            return
        push = scheduled_mail_push(
            state=settled.state,
            action_id=settled.action_id,
            recipient_display=claimed["recipient_display"],
            safe_error_code=settled.safe_error_code,
        )
        if push is None:
            return
        try:
            await asyncio.to_thread(self._push, settled.user_id, **push)
        except Exception as exc:
            logger.warning("gmail.scheduled_drain.push_failed error=%s", type(exc).__name__)


async def drain_scheduled_mail(
    *,
    limit: int,
    deadline_seconds: float = DEFAULT_DEADLINE_SECONDS,
    clock: Callable[[], float] = time.monotonic,
    delivery: ScheduledDelivery | None = None,
    directory: RecipientDirectory | None = None,
    push: PushSender | None = None,
    pool_provider: PoolProvider | None = None,
) -> dict[str, Any]:
    """Fire up to ``limit`` due scheduled sends before ``deadline_seconds``.

    ``fired`` counts the rows handed to ``execute()``; the outcome lists hold
    action ids only. Due-ness and the send window are judged by the database
    clock; ``clock`` bounds only this run's wall time.
    """
    if type(limit) is not int or not 1 <= limit <= MAX_DRAIN_LIMIT:
        raise ValueError("limit must be an integer from 1 through 100")
    if deadline_seconds <= 0:
        raise ValueError("deadline_seconds must be positive")
    drain = _ScheduledMailDrain(
        # GmailDeliveryService provides the schedule seal/open pair (I1) and
        # the connected account's stable id (current_sender_sub).
        delivery=delivery or get_gmail_delivery_service(),
        directory=directory or ConnectionsService(),
        push=push or send_user_data_push,
        pool_provider=pool_provider or get_pool,
    )
    result = await drain.run(limit=limit, deadline_seconds=deadline_seconds, clock=clock)
    logger.info(
        "gmail.scheduled_drain.completed fired=%s sent=%s failed=%s unknown=%s "
        "cancelled=%s expired=%s limit=%s",
        result["fired"],
        len(result["sent"]),
        len(result["failed"]),
        len(result["outcome_unknown"]),
        len(result["cancelled"]),
        len(result["expired"]),
        limit,
    )
    return result
