"""Bounded server reminders; no app timer, vault key, or LLM required."""

from __future__ import annotations

import asyncio
import json
import os
import time
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import quote, urlsplit

from hushh_mcp.services.calendar_reminder_policy import event_times, reminder_copy
from hushh_mcp.services.calendar_reminder_store import CalendarReminderStore
from hushh_mcp.services.google_calendar_service import get_google_calendar_service
from hushh_mcp.services.google_connection_service import (
    GoogleConnectionError,
    get_google_connection_service,
)
from hushh_mcp.services.push_notifications import send_calendar_reminder_push


def reminders_enabled() -> bool:
    return os.getenv("CALENDAR_REMINDERS_ENABLED", "false").lower() == "true" and os.getenv(
        "ENVIRONMENT", ""
    ).lower() in {"production", "uat", "test", "local", "development"}


class CalendarReminderService:
    def __init__(self, *, store=None, calendar=None, connections=None, send_push=None):
        self.store = store or CalendarReminderStore()
        self.calendar = calendar or get_google_calendar_service()
        self.connections = connections or get_google_connection_service()
        self.send_push = send_push or send_calendar_reminder_push

    def locator(self, job: dict[str, Any]) -> dict[str, str]:
        return json.loads(
            self.connections.open_calendar_reminder(
                {
                    "ciphertext": job["locator_ciphertext"],
                    "iv": job["locator_iv"],
                    "tag": job["locator_tag"],
                },
                user_id=job["user_id"],
                reminder_id=str(job["reminder_id"]),
            )
        )

    async def event(self, owner: str, event_id: str) -> dict[str, Any]:
        return await self.calendar._request(
            user_id=owner,
            method="GET",
            access="read",
            path=f"/calendars/primary/events/{quote(event_id, safe='')}",
        )

    async def resolve(self, owner: str, reminder_id: str) -> dict[str, Any]:
        job = await self.store.resolve(owner, reminder_id)
        if not job:
            raise GoogleConnectionError("Meeting reminder is unavailable", status_code=404)
        locator = self.locator(job)
        if await self.store.live_generation(owner) != locator["generation"]:
            raise GoogleConnectionError(
                "Calendar connection changed. Refresh Calendar.", status_code=409
            )
        event = await self.event(owner, locator["event_id"])
        if await self.store.live_generation(owner) != locator["generation"]:
            raise GoogleConnectionError(
                "Calendar connection changed. Refresh Calendar.", status_code=409
            )
        times = event_times(event)
        if not times or times[1] <= datetime.now(UTC):
            raise GoogleConnectionError("Meeting was cancelled or is unavailable", status_code=410)
        return self.calendar._event_summary(event)

    async def join(self, owner: str, event_id: str) -> dict[str, str]:
        generation = await self.store.live_generation(owner)
        if not generation:
            raise GoogleConnectionError("Calendar is disconnected", status_code=409)
        event = await self.event(owner, event_id)
        if await self.store.live_generation(owner) != generation:
            raise GoogleConnectionError(
                "Calendar connection changed. Refresh Calendar.", status_code=409
            )
        times = event_times(event)
        now = datetime.now(UTC)
        if not times or not times[0] - timedelta(minutes=15) <= now < times[1]:
            raise GoogleConnectionError(
                "Meeting is not ready to join. Refresh Calendar.", status_code=409
            )
        url = self.calendar._event_summary(event).get("conference_url") or ""
        parsed = urlsplit(url)
        if (
            parsed.scheme != "https"
            or parsed.hostname != "meet.google.com"
            or parsed.username
            or parsed.password
            or parsed.port
        ):
            raise GoogleConnectionError("A Google Meet link is unavailable", status_code=409)
        return {"url": url}

    async def reconcile(self, account: dict[str, Any]) -> dict[str, str] | None:
        owner = account["user_id"]
        generation = await self.store.live_generation(owner)
        if not generation:
            return
        now = datetime.now(UTC)
        params = {
            "timeMin": now.isoformat(),
            "timeMax": (now + timedelta(hours=24)).isoformat(),
            "singleEvents": "true",
            "orderBy": "startTime",
            "maxResults": 250,
        }
        if account.get("scan_ciphertext"):
            saved = json.loads(
                self.connections.open_calendar_reminder(
                    {
                        "ciphertext": account["scan_ciphertext"],
                        "iv": account["scan_iv"],
                        "tag": account["scan_tag"],
                    },
                    user_id=owner,
                    reminder_id="scan",
                )
            )
            if (
                saved.get("generation") == generation
                and datetime.fromisoformat(saved["params"]["timeMax"]) > now
            ):
                params = saved["params"]
        restarted = False
        for _ in range(2):
            try:
                page = await self.calendar._request(
                    user_id=owner,
                    method="GET",
                    access="read",
                    path="/calendars/primary/events",
                    params=dict(params),
                )
            except GoogleConnectionError as error:
                if error.status_code != 400 or not params.get("pageToken") or restarted:
                    raise
                # An invalid/expired cursor must not pin this owner for the rest
                # of the scan window. Retry page one once; transient failures
                # still retain the checkpoint through finish_account.
                restarted = True
                params.pop("pageToken", None)
                page = await self.calendar._request(
                    user_id=owner,
                    method="GET",
                    access="read",
                    path="/calendars/primary/events",
                    params=dict(params),
                )
            await self.store.reconcile(account, generation, page.get("items") or [])
            if not page.get("nextPageToken"):
                return
            params["pageToken"] = page["nextPageToken"]
        # Fixed-window continuation prevents a dense Calendar from repeatedly
        # scanning page one. The provider cursor stays encrypted and owner-fenced.
        return self.connections.seal_calendar_reminder(
            json.dumps({"generation": generation, "params": params}),
            user_id=owner,
            reminder_id="scan",
        )

    async def dispatch(self, job: dict[str, Any]) -> str:
        try:
            locator = self.locator(job)
            if await self.store.live_generation(job["user_id"]) != locator["generation"]:
                await self.store.settle(job, state="suppressed")
                return "suppressed"
            event = await self.event(job["user_id"], locator["event_id"])
            times = event_times(event)
            if not times or times[0] != job["start_at"]:
                await self.store.settle(job, state="suppressed")
                return "suppressed"
            if times[0] <= datetime.now(UTC):
                await self.store.settle(job, state="expired")
                return "expired"
            prefs = await self.store.authorize_send(job, locator["generation"])
            if not prefs:
                await self.store.settle(job, state="queued")
                return "queued"
            if not reminders_enabled():
                await self.store.settle(job, state="suppressed")
                return "suppressed"
            title, body = reminder_copy(
                event,
                now=datetime.now(UTC),
                time_zone=prefs["time_zone"],
                show_title=prefs["show_title"],
            )
            reminder_id = str(job["reminder_id"])
            message_id = f"cal:{reminder_id}:{job['revision']}"
            result = await asyncio.to_thread(
                self.send_push,
                job["user_id"],
                skip_targets=prefs["accepted_targets"],
                expires_at=times[0],
                notification_type="calendar_meeting_reminder",
                title=title,
                body=body,
                deep_link=f"/one/feed?calendarReminder={reminder_id}",
                notification_tag=message_id,
                notification_category="ONE_CALENDAR",
                data={"reminder_id": reminder_id, "message_id": message_id},
            )
            state = (
                "queued"
                if result.retry
                else "accepted"
                if result.accepted or prefs["accepted_targets"]
                else "unavailable"
            )
            await self.store.settle(job, state=state, accepted=result.accepted)
            return state
        except GoogleConnectionError as error:
            state = "suppressed" if error.status_code in {401, 403, 404, 410} else "queued"
            await self.store.settle(job, state=state)
            return state
        except Exception:
            await self.store.settle(job, state="queued")
            return "queued"

    async def drain(self) -> dict[str, int]:
        counts: dict[str, int] = {
            "reconciled": 0,
            "accepted": 0,
            "queued": 0,
            "suppressed": 0,
            "expired": 0,
            "errors": 0,
            "unavailable": 0,
        }
        if not reminders_enabled():
            return counts
        await self.store.purge()
        # Cloud Scheduler serializes this job. Stay below the minute cadence,
        # prioritizing due pushes and leaving discovery for subsequent ticks.
        deadline = time.monotonic() + 45
        slots = asyncio.Semaphore(5)

        async def dispatch(job):
            async with slots:
                try:
                    outcome = await asyncio.wait_for(self.dispatch(job), timeout=20)
                    counts[outcome] += 1
                except TimeoutError:
                    # Leave the lease for recovery: an in-flight provider push
                    # can finish after timeout and must not be retried immediately.
                    counts["errors"] += 1

        async def due():
            for _ in range(10):
                if deadline - time.monotonic() < 20:
                    break
                jobs = await self.store.claim_due(limit=5)
                if not jobs:
                    break
                await asyncio.gather(*(dispatch(job) for job in jobs))

        await due()

        async def reconcile(account):
            failed = False
            checkpoint = None
            try:
                checkpoint = await asyncio.wait_for(self.reconcile(account), timeout=10)
                counts["reconciled"] += 1
            except Exception:
                failed = True
                counts["errors"] += 1
            await self.store.finish_account(account, failed=failed, checkpoint=checkpoint)

        # Claims fit inside their 90-second lease, including queue time.
        for _ in range(20):
            if deadline - time.monotonic() < 30:
                break
            accounts = await self.store.claim_accounts(limit=3)
            if not accounts:
                break
            await asyncio.gather(*(reconcile(account) for account in accounts))
        await due()
        return counts
