"""Durable, content-free PWM email delivery, independent of research and Feed."""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from email.message import EmailMessage

from starlette.concurrency import run_in_threadpool

from db.connection import get_pool
from hushh_mcp.runtime_settings import get_app_runtime_settings, one_profile_research_enabled
from hushh_mcp.services.connection_graph_service import lock_connection_graph_users_async
from hushh_mcp.services.one_owner_admission import lookup_fresh_owner_identity, owner_setup_resolved
from hushh_mcp.services.support_email_service import (
    SupportEmailDeliveryUncertainError,
    SupportEmailNotConfiguredError,
    SupportEmailSendError,
    SupportEmailService,
)

logger = logging.getLogger(__name__)

# The unlocked read only decides whether a recipient is needed; the locked one is authority.
# The recipient is resolved before the owner graph lock, so the locked read itself must see
# a deletion approved since then: deletion holds that lock exclusively until it commits.
_SENDABLE_EVENT = """SELECT p.enabled,p.email_enabled,p.generation,p.active_draft_id,
    EXISTS(SELECT 1 FROM account_deletion_tombstones t
      WHERE t.user_id_hash='sha256:'||encode(sha256(convert_to(p.user_id,'UTF8')),'hex')) AS deleted
    FROM pwm_research_preferences p JOIN pwm_completion_events e USING(user_id)
    WHERE p.user_id=$1 AND e.draft_id=$2 AND e.lease_id=$3 AND e.email_state='leased'"""
_LOCKED_SENDABLE_EVENT = """SELECT p.enabled,p.email_enabled,p.generation,p.active_draft_id,
    EXISTS(SELECT 1 FROM account_deletion_tombstones t
      WHERE t.user_id_hash='sha256:'||encode(sha256(convert_to(p.user_id,'UTF8')),'hex')) AS deleted
    FROM pwm_research_preferences p JOIN pwm_completion_events e USING(user_id)
    WHERE p.user_id=$1 AND e.draft_id=$2 AND e.lease_id=$3 AND e.email_state='leased'
    FOR UPDATE OF p,e"""


def send_ready_email(*, email, draft_id, outcome):
    sender = SupportEmailService()
    config = sender.config
    runtime = get_app_runtime_settings()
    # UAT must use the existing test inbox. Never silently send to real owners.
    if runtime.environment != "production" and (
        config.delivery_mode != "test" or not config.test_to_email
    ):
        return "suppressed"
    message = EmailMessage()
    message["To"] = config.test_to_email if config.delivery_mode == "test" else email
    message["From"] = "One <one@hushh.ai>"
    message["Subject"] = (
        "[TEST] " if config.delivery_mode == "test" else ""
    ) + "Your Personal World Model is ready to review"
    origin = str(runtime.app_frontend_origin).rstrip("/")
    link = f"{origin}/one/profile/world-model?draft_id={draft_id}"
    line = (
        "Your research is ready to review."
        if outcome == "ready"
        else "Your research has results that need your review."
    )
    message.set_content(
        f"{line}\n\nView your model: {link}\n\nYou can turn these emails off in Personal World Model.\n"
    )
    sender._send_email(message)
    return "accepted"


class WorldModelNotificationWorker:
    def __init__(self):
        self.task = None
        self.lock = asyncio.Lock()
        self.wakeup = asyncio.Event()
        self.last_retention = 0.0

    def start(self):
        if self.task is None or self.task.done():
            self.task = asyncio.create_task(self._loop(), name="pwm-notifications")

    def wake(self):
        self.wakeup.set()

    async def stop(self):
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
            self.task = None

    async def _loop(self):
        while True:
            try:
                if time.monotonic() - self.last_retention > 3600:
                    from hushh_mcp.services.world_model_source_review import STORE

                    await STORE.purge_expired()
                    self.last_retention = time.monotonic()
                await self.drain()
            except Exception as error:
                logger.warning("pwm.notification_drain_failed error_type=%s", type(error).__name__)
            try:
                await asyncio.wait_for(self.wakeup.wait(), timeout=30)
            except TimeoutError:
                pass
            self.wakeup.clear()

    async def drain(self):
        if self.lock.locked():
            return
        async with self.lock:
            pool = await get_pool()
            # A process lost after send may have delivered. Do not send twice.
            await pool.execute(
                "UPDATE pwm_completion_events SET email_state='uncertain' WHERE email_state='leased' AND lease_expires_at<NOW()",
                timeout=5,
            )
            deadline = time.monotonic() + 60
            for _ in range(5):
                if time.monotonic() >= deadline:
                    return
                lease = uuid.uuid4()
                row = await pool.fetchrow(
                    """UPDATE pwm_completion_events SET email_state='leased',lease_id=$1,
                    lease_expires_at=NOW()+INTERVAL '90 seconds',email_attempts=email_attempts+1
                    WHERE (user_id,draft_id) IN (
                        SELECT user_id,draft_id FROM pwm_completion_events WHERE email_state='pending'
                        AND next_attempt_at<=NOW() AND email_attempts<5 ORDER BY next_attempt_at
                        LIMIT 1 FOR UPDATE SKIP LOCKED
                    ) RETURNING user_id,draft_id,generation,outcome,email_attempts""",
                    lease,
                    timeout=5,
                )
                if not row:
                    return
                await self._deliver(pool, dict(row), lease)

    async def _draft_available(self, conn, user_id):
        from hushh_mcp.services.world_model_service import world_model_jobs

        return await world_model_jobs.store.has_fresh_checkpoint(conn, user_id)

    async def _sendable(self, conn, event, lease, *, for_update):
        current = await conn.fetchrow(
            _LOCKED_SENDABLE_EVENT if for_update else _SENDABLE_EVENT,
            event["user_id"],
            event["draft_id"],
            lease,
            timeout=5,
        )
        return bool(
            one_profile_research_enabled()
            and current
            and not current.get("deleted")
            and current["enabled"]
            and current["email_enabled"]
            and current["generation"] == event["generation"]
            and current["active_draft_id"] == event["draft_id"]
            and await owner_setup_resolved(event["user_id"], conn=conn)
            and await self._draft_available(conn, event["user_id"])
        )

    async def _deliver(self, pool, event, lease):
        state = "suppressed"
        dispatch_started = False
        try:
            # Resolve the recipient only for an event that may still send, and outside the
            # owner graph lock: with generation admission on, this read takes that lock
            # shared on its own connection. The locked pass below rechecks everything.
            owner = None
            async with pool.acquire(timeout=5) as conn:
                sendable = await self._sendable(conn, event, lease, for_update=False)
            if sendable:
                owner = await asyncio.wait_for(
                    run_in_threadpool(lookup_fresh_owner_identity, event["user_id"]), 5
                )
            async with pool.acquire(timeout=5) as conn, conn.transaction():
                await lock_connection_graph_users_async(conn, user_ids=[event["user_id"]])
                if await self._sendable(conn, event, lease, for_update=True):
                    if owner is None:
                        # It became sendable after the unlocked check; retry with a recipient.
                        raise RuntimeError("pwm recipient not resolved")
                    if (
                        getattr(owner, "uid", None) == event["user_id"]
                        and not getattr(owner, "disabled", True)
                        and getattr(owner, "email_verified", False)
                        and getattr(owner, "email", None)
                    ):
                        dispatch_started = True
                        delivery = asyncio.create_task(
                            run_in_threadpool(
                                send_ready_email,
                                email=owner.email,
                                draft_id=event["draft_id"],
                                outcome=event["outcome"],
                            )
                        )
                        try:
                            state = await asyncio.shield(delivery)
                        except asyncio.CancelledError as cancellation:
                            # The Workspace HTTP transport has a bounded timeout.
                            # Keep authority locks until its thread actually stops;
                            # cancellation cannot revoke a send already in flight.
                            while not delivery.done():
                                try:
                                    await asyncio.shield(delivery)
                                except asyncio.CancelledError:
                                    continue
                                except Exception:
                                    break
                            raise cancellation
                await conn.execute(
                    "UPDATE pwm_completion_events SET email_state=$4,lease_id=NULL,lease_expires_at=NULL WHERE user_id=$1 AND draft_id=$2 AND lease_id=$3",
                    event["user_id"],
                    event["draft_id"],
                    lease,
                    state,
                    timeout=5,
                )
        except SupportEmailDeliveryUncertainError:
            state = "uncertain"
        except SupportEmailNotConfiguredError:
            state = "failed"
        except SupportEmailSendError:
            state = "failed" if event["email_attempts"] >= 5 else "pending"
        except Exception as error:
            logger.warning("pwm.email_failed error_type=%s", type(error).__name__)
            state = (
                "uncertain"
                if dispatch_started
                else ("failed" if event["email_attempts"] >= 5 else "pending")
            )
        else:
            return
        # Settlement only updates the matching surviving lease; reset cannot be undone.
        await pool.execute(
            """UPDATE pwm_completion_events SET email_state=$4,lease_id=NULL,lease_expires_at=NULL,
            next_attempt_at=NOW()+INTERVAL '60 seconds' WHERE user_id=$1 AND draft_id=$2 AND lease_id=$3""",
            event["user_id"],
            event["draft_id"],
            lease,
            state,
            timeout=5,
        )


world_model_notification_worker = WorldModelNotificationWorker()
