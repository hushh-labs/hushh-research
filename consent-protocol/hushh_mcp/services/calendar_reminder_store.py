"""Owner-fenced reminder leases. Google remains the source of meeting contents."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from sqlalchemy import text

from hushh_mcp.services.calendar_reminder_policy import REMINDER_OFFSET, event_times
from hushh_mcp.services.external_connector_lifecycle_store import ExternalConnectorLifecycleStore
from hushh_mcp.services.google_connection_service import get_google_connection_service
from hushh_mcp.services.google_oauth_attempt import connection_generation


class CalendarReminderStore(ExternalConnectorLifecycleStore):
    def _live(self, conn: Any, owner: str) -> str | None:
        connections = get_google_connection_service()
        connections._lock_google_owner(conn, owner)
        row = self._row(
            conn,
            """SELECT c.*, g.status AS grant_status, g.scope_csv
            FROM google_provider_connections c JOIN google_service_grants g
              ON c.user_id=g.user_id AND c.provider=g.provider
            WHERE c.user_id=:owner AND c.provider='google' AND g.service='calendar'""",
            {"owner": owner},
        )
        if not row or row["status"] != "connected" or row["grant_status"] != "connected":
            return None
        if not connections.has_service_access("calendar", "read", row["scope_csv"] or ""):
            return None
        return connection_generation(row)

    async def live_generation(self, owner: str) -> str | None:
        return await self._transaction(lambda conn: self._live(conn, owner))

    async def preferences(self, owner: str) -> dict[str, Any]:
        row = await self._transaction(
            lambda conn: self._row(
                conn,
                "SELECT enabled,show_title,time_zone FROM calendar_reminder_preferences WHERE user_id=:owner",
                {"owner": owner},
            )
        )
        return row or {"enabled": False, "show_title": True, "time_zone": "UTC"}

    async def set_preferences(
        self, owner: str, *, enabled: bool, show_title: bool, time_zone: str
    ) -> dict[str, Any]:
        def update(conn: Any) -> dict[str, Any]:
            if enabled and not self._live(conn, owner):
                raise ValueError("calendar_disconnected")
            if not enabled:
                get_google_connection_service()._lock_google_owner(conn, owner)
            row = self._row(
                conn,
                """INSERT INTO calendar_reminder_preferences
                (user_id,enabled,show_title,time_zone) VALUES (:owner,:enabled,:show_title,:time_zone)
                ON CONFLICT(user_id) DO UPDATE SET enabled=EXCLUDED.enabled,
                  show_title=EXCLUDED.show_title,time_zone=EXCLUDED.time_zone,
                  generation=calendar_reminder_preferences.generation+1,
                  next_reconcile_at=clock_timestamp(),reconcile_lease_id=NULL,reconcile_lease_until=NULL,
                  scan_ciphertext=NULL,scan_iv=NULL,scan_tag=NULL,
                  updated_at=clock_timestamp()
                RETURNING enabled,show_title,time_zone""",
                locals_params,
            )
            conn.execute(
                text("""UPDATE calendar_reminder_instances SET state='suppressed',lease_id=NULL,
                lease_until=NULL WHERE user_id=:owner AND state IN ('queued','dispatching','sending')"""),
                {"owner": owner},
            )
            return row or {}

        locals_params = {
            "owner": owner,
            "enabled": enabled,
            "show_title": show_title,
            "time_zone": time_zone,
        }
        return await self._transaction(update)

    async def claim_accounts(self, limit: int = 10) -> list[dict[str, Any]]:
        def claim(conn: Any) -> list[dict[str, Any]]:
            return [
                dict(r)
                for r in conn.execute(
                    text("""WITH due AS (
                SELECT user_id FROM calendar_reminder_preferences WHERE enabled
                AND next_reconcile_at<=clock_timestamp()
                AND (reconcile_lease_until IS NULL OR reconcile_lease_until<clock_timestamp())
                ORDER BY next_reconcile_at LIMIT :limit FOR UPDATE SKIP LOCKED)
                UPDATE calendar_reminder_preferences p SET reconcile_lease_id=:lease,
                  reconcile_lease_until=clock_timestamp()+interval '90 seconds'
                FROM due WHERE p.user_id=due.user_id RETURNING p.*"""),
                    {"limit": limit, "lease": str(uuid4())},
                ).mappings()
            ]

        return await self._transaction(claim)

    async def reconcile(
        self, account: dict[str, Any], generation: str, events: list[dict[str, Any]]
    ) -> None:
        def save(conn: Any) -> None:
            owner = account["user_id"]
            if self._live(conn, owner) != generation:
                return
            prefs = self._row(
                conn,
                """SELECT * FROM calendar_reminder_preferences WHERE user_id=:owner
                AND enabled AND generation=:generation AND reconcile_lease_id=:lease
                AND reconcile_lease_until>clock_timestamp() FOR UPDATE""",
                {
                    "owner": owner,
                    "generation": account["generation"],
                    "lease": account["reconcile_lease_id"],
                },
            )
            if not prefs:
                return
            connections = get_google_connection_service()
            now = datetime.now(UTC)
            for event in events:
                times = event_times(event)
                if not times or times[0] <= now or not isinstance(event.get("id"), str):
                    continue
                start, end = times
                occurrence = connections.calendar_occurrence_key(
                    user_id=owner, event_id=event["id"], generation=generation
                )
                old = self._row(
                    conn,
                    "SELECT * FROM calendar_reminder_instances WHERE user_id=:owner AND occurrence_key=:key FOR UPDATE",
                    {"owner": owner, "key": occurrence},
                )
                reminder_id = str(old["reminder_id"]) if old else str(uuid4())
                if (
                    old
                    and old["state"] == "sending"
                    and old["lease_until"]
                    and old["lease_until"] > now
                ):
                    continue
                same_occurrence = False
                if old and old["start_at"] == start:
                    prior = json.loads(
                        connections.open_calendar_reminder(
                            {
                                "ciphertext": old["locator_ciphertext"],
                                "iv": old["locator_iv"],
                                "tag": old["locator_tag"],
                            },
                            user_id=owner,
                            reminder_id=reminder_id,
                        )
                    )
                    same_occurrence = prior["generation"] == generation
                    if same_occurrence and (
                        old["state"] in {"accepted", "unavailable"}
                        or (
                            old["preference_generation"] == prefs["generation"]
                            and old["state"] != "suppressed"
                        )
                    ):
                        continue
                sealed = connections.seal_calendar_reminder(
                    json.dumps({"event_id": event["id"], "generation": generation}),
                    user_id=owner,
                    reminder_id=reminder_id,
                )
                conn.execute(
                    text("""INSERT INTO calendar_reminder_instances
                    (reminder_id,user_id,occurrence_key,preference_generation,locator_ciphertext,locator_iv,locator_tag,
                     start_at,end_at,due_at,next_attempt_at)
                    VALUES (:id,:owner,:key,:generation,:ciphertext,:iv,:tag,:start,:end,:due,:due)
                    ON CONFLICT(user_id,occurrence_key) DO UPDATE SET
                      preference_generation=EXCLUDED.preference_generation,locator_ciphertext=EXCLUDED.locator_ciphertext,
                      locator_iv=EXCLUDED.locator_iv,locator_tag=EXCLUDED.locator_tag,start_at=EXCLUDED.start_at,
                      end_at=EXCLUDED.end_at,due_at=EXCLUDED.due_at,next_attempt_at=EXCLUDED.due_at,
                      revision=:revision,state='queued',attempts=:attempts,
                      lease_id=NULL,lease_until=NULL,error_code=NULL,updated_at=clock_timestamp()"""),
                    {
                        "id": reminder_id,
                        "owner": owner,
                        "key": occurrence,
                        "generation": prefs["generation"],
                        **sealed,
                        "start": start,
                        "end": end,
                        "due": start - REMINDER_OFFSET,
                        "revision": old["revision"]
                        if same_occurrence
                        else old["revision"] + 1
                        if old
                        else 1,
                        "attempts": old["attempts"] if same_occurrence else 0,
                    },
                )

        await self._transaction(save)

    async def finish_account(
        self, account: dict[str, Any], *, failed: bool, checkpoint: dict[str, str] | None = None
    ) -> None:
        await self._transaction(
            lambda conn: conn.execute(
                text("""UPDATE calendar_reminder_preferences
            SET next_reconcile_at=clock_timestamp()+make_interval(secs=>:delay),reconcile_lease_id=NULL,
                reconcile_lease_until=NULL,
                scan_ciphertext=CASE WHEN :failed THEN scan_ciphertext ELSE :ciphertext END,
                scan_iv=CASE WHEN :failed THEN scan_iv ELSE :iv END,
                scan_tag=CASE WHEN :failed THEN scan_tag ELSE :tag END
                WHERE user_id=:owner AND reconcile_lease_id=:lease"""),
                {
                    "owner": account["user_id"],
                    "lease": account["reconcile_lease_id"],
                    "delay": 60 if failed or checkpoint else 300,
                    "failed": failed,
                    "ciphertext": (checkpoint or {}).get("ciphertext"),
                    "iv": (checkpoint or {}).get("iv"),
                    "tag": (checkpoint or {}).get("tag"),
                },
            )
        )

    async def claim_due(self, limit: int = 50) -> list[dict[str, Any]]:
        def claim(conn: Any) -> list[dict[str, Any]]:
            conn.execute(
                text("""WITH expired AS (SELECT reminder_id FROM calendar_reminder_instances
                WHERE state IN ('queued','dispatching','sending') AND start_at<=clock_timestamp()
                ORDER BY start_at LIMIT 500 FOR UPDATE SKIP LOCKED)
                UPDATE calendar_reminder_instances i SET state='expired',lease_id=NULL,lease_until=NULL
                FROM expired WHERE i.reminder_id=expired.reminder_id""")
            )
            return [
                dict(r)
                for r in conn.execute(
                    text("""WITH due AS (
                SELECT reminder_id FROM calendar_reminder_instances
                WHERE state IN ('queued','dispatching','sending') AND attempts<6 AND start_at>clock_timestamp()
                  AND next_attempt_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<clock_timestamp())
                ORDER BY next_attempt_at LIMIT :limit FOR UPDATE SKIP LOCKED)
                UPDATE calendar_reminder_instances i SET state='dispatching',attempts=attempts+1,
                  lease_id=:lease,lease_until=clock_timestamp()+interval '90 seconds'
                FROM due WHERE i.reminder_id=due.reminder_id RETURNING i.*"""),
                    {"limit": limit, "lease": str(uuid4())},
                ).mappings()
            ]

        return await self._transaction(claim)

    async def authorize_send(self, job: dict[str, Any], generation: str) -> dict[str, Any] | None:
        def authorize(conn: Any) -> dict[str, Any] | None:
            if self._live(conn, job["user_id"]) != generation:
                return None
            prefs = self._row(
                conn,
                """SELECT * FROM calendar_reminder_preferences WHERE user_id=:owner
                AND enabled AND generation=:generation FOR UPDATE""",
                {"owner": job["user_id"], "generation": job["preference_generation"]},
            )
            if not prefs:
                return None
            live = self._row(
                conn,
                """UPDATE calendar_reminder_instances SET state='sending'
                WHERE reminder_id=:id AND lease_id=:lease AND revision=:revision AND state='dispatching'
                  AND lease_until>clock_timestamp() AND start_at>clock_timestamp() RETURNING reminder_id""",
                {"id": job["reminder_id"], "lease": job["lease_id"], "revision": job["revision"]},
            )
            if not live:
                return None
            prefs["accepted_targets"] = {
                r[0]
                for r in conn.execute(
                    text("""SELECT target_id FROM calendar_reminder_deliveries
                WHERE reminder_id=:id AND revision=:revision"""),
                    {"id": job["reminder_id"], "revision": job["revision"]},
                )
            }
            return prefs

        return await self._transaction(authorize)

    async def settle(
        self, job: dict[str, Any], *, state: str, accepted: set[str] | None = None
    ) -> None:
        def settle(conn: Any) -> None:
            # Record known acceptance even when preferences invalidated this
            # lease meanwhile. It must not disappear from a subsequent retry.
            for target in accepted or set():
                conn.execute(
                    text("""INSERT INTO calendar_reminder_deliveries(reminder_id,revision,target_id)
                    SELECT reminder_id,revision,:target FROM calendar_reminder_instances
                    WHERE reminder_id=:id AND revision=:revision ON CONFLICT DO NOTHING"""),
                    {**params, "target": target},
                )
            live = self._row(
                conn,
                """SELECT reminder_id FROM calendar_reminder_instances WHERE reminder_id=:id
                AND lease_id=:lease AND revision=:revision FOR UPDATE""",
                params,
            )
            if not live:
                return
            conn.execute(
                text("""UPDATE calendar_reminder_instances SET state=:state,lease_id=NULL,lease_until=NULL,
                next_attempt_at=clock_timestamp()+make_interval(secs=>:delay),updated_at=clock_timestamp()
                WHERE reminder_id=:id AND lease_id=:lease AND revision=:revision"""),
                {
                    **params,
                    "state": "unavailable" if state == "queued" and job["attempts"] >= 6 else state,
                    "delay": min(120, 15 * 2 ** min(job["attempts"], 3)),
                },
            )

        params = {"id": job["reminder_id"], "lease": job["lease_id"], "revision": job["revision"]}
        await self._transaction(settle)

    async def resolve(self, owner: str, reminder_id: str) -> dict[str, Any] | None:
        return await self._transaction(
            lambda conn: self._row(
                conn,
                "SELECT * FROM calendar_reminder_instances WHERE user_id=:owner AND reminder_id=:id",
                {"owner": owner, "id": reminder_id},
            )
        )

    async def purge(self) -> None:
        await self._transaction(
            lambda conn: conn.execute(
                text("""WITH old AS (
            SELECT reminder_id FROM calendar_reminder_instances WHERE end_at<clock_timestamp()-interval '24 hours'
            ORDER BY end_at LIMIT 500 FOR UPDATE SKIP LOCKED)
            DELETE FROM calendar_reminder_instances i USING old WHERE i.reminder_id=old.reminder_id""")
            )
        )
