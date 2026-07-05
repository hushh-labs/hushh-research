"""Durable persistence for Information Marketplace opportunity signals.

An "opportunity signal" is a proactive, monetizable nudge surfaced on Agent One:
"your insurance expires soon — publish this so buyers can reach you", or an
offer-worthy unpublished slice worth listing. Unlike every other nudge in the app
(Gmail, Location), which is derived fresh on load and forgotten on reload, a signal
is a real record in `marketplace_opportunity_signals` (migration 077) with a
persisted lifecycle: it can be snoozed ("remind me later" → reappears the next day),
dismissed, or marked published, and that state survives reloads and days.

Consent-first: a signal never publishes anything on its own. The card's publish CTA
runs the normal owner-driven, server-side posture change; `mark_published` here only
records that the signal was acted on.

Re-derivation on every open is idempotent via `(user_id, dedupe_key)`: creating a
signal that already exists refreshes its display fields only while it is still
`active`, and never resurrects a `dismissed`/`published` row.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, date, datetime, timedelta
from typing import Any

from db.db_client import get_db

logger = logging.getLogger(__name__)

_STATUSES = {"active", "snoozed", "published", "dismissed", "expired"}
_KINDS = {"expiry", "intent"}
_SOURCES = {"derived", "authored"}

# Display fields refreshed on idempotent re-derivation of a still-active signal.
_REFRESHABLE = ("title", "body", "event_date", "suggested_price_cents", "metadata")


def _now() -> datetime:
    return datetime.now(UTC)


def _now_iso() -> str:
    return _now().isoformat()


def _str_or_none(value: Any) -> str | None:
    """Coerce UUID/datetime/date to a JSON-safe string (chat path uses json.dumps)."""
    return None if value is None else str(value)


def _row_to_signal(row: dict) -> dict[str, Any]:
    """Shape a DB row into the JSON-safe camelCase contract the frontend consumes."""
    return {
        "id": _str_or_none(row.get("id")),
        "userId": _str_or_none(row.get("user_id")),
        "kind": row.get("kind"),
        "domain": row.get("domain"),
        "scopeHandle": row.get("scope_handle"),
        "title": row.get("title"),
        "body": row.get("body"),
        "eventDate": _str_or_none(row.get("event_date")),
        "suggestedPriceCents": row.get("suggested_price_cents"),
        "currency": row.get("currency"),
        "source": row.get("source"),
        "status": row.get("status"),
        "snoozedUntil": _str_or_none(row.get("snoozed_until")),
        "dedupeKey": row.get("dedupe_key"),
        "showCount": row.get("show_count"),
        "metadata": row.get("metadata") or {},
        "createdAt": _str_or_none(row.get("created_at")),
        "updatedAt": _str_or_none(row.get("updated_at")),
    }


def _start_of_next_day(now: datetime) -> datetime:
    """Start of tomorrow (UTC) — the default 'remind me later' target."""
    tomorrow = (now + timedelta(days=1)).date()
    return datetime(tomorrow.year, tomorrow.month, tomorrow.day, tzinfo=UTC)


class OpportunitySignalService:
    """CRUD + lifecycle for durable opportunity signals (owner-scoped)."""

    def __init__(self) -> None:
        self._supabase = None

    @property
    def supabase(self):
        if self._supabase is None:
            self._supabase = get_db()
        return self._supabase

    async def _execute_query(self, query):
        return await asyncio.to_thread(query.execute)

    async def _find_by_dedupe(self, *, user_id: str, dedupe_key: str) -> dict[str, Any] | None:
        result = await self._execute_query(
            self.supabase.table("marketplace_opportunity_signals")
            .select("*")
            .eq("user_id", user_id)
            .eq("dedupe_key", dedupe_key)
            .limit(1)
        )
        rows = getattr(result, "data", None) or []
        return rows[0] if rows else None

    async def create_signal(
        self,
        *,
        user_id: str,
        kind: str,
        domain: str,
        title: str,
        dedupe_key: str,
        source: str = "derived",
        scope_handle: str | None = None,
        body: str | None = None,
        event_date: str | None = None,
        suggested_price_cents: int = 0,
        currency: str = "USD",
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Create a signal, idempotent on (user_id, dedupe_key).

        If a signal with the same dedupe_key already exists: refresh its display
        fields only while it is still `active`; never resurrect a dismissed/published
        signal (so a re-derivation on every open doesn't nag about handled items).
        """
        if kind not in _KINDS:
            raise ValueError(f"kind must be one of {_KINDS}")
        if source not in _SOURCES:
            raise ValueError(f"source must be one of {_SOURCES}")

        existing = await self._find_by_dedupe(user_id=user_id, dedupe_key=dedupe_key)
        if existing is not None:
            if existing.get("status") != "active":
                # Handled already (snoozed/published/dismissed/expired) — leave it be.
                return _row_to_signal(existing)
            update = {
                "title": title,
                "body": body,
                "event_date": event_date,
                "suggested_price_cents": int(suggested_price_cents or 0),
                "metadata": metadata or {},
                "updated_at": _now_iso(),
            }
            result = await self._execute_query(
                self.supabase.table("marketplace_opportunity_signals")
                .update(update)
                .eq("id", existing["id"])
                .eq("user_id", user_id)
                .eq("status", "active")
            )
            rows = getattr(result, "data", None) or []
            return _row_to_signal(rows[0]) if rows else _row_to_signal({**existing, **update})

        payload = {
            "user_id": user_id,
            "kind": kind,
            "domain": domain,
            "scope_handle": scope_handle,
            "title": title,
            "body": body,
            "event_date": event_date,
            "suggested_price_cents": int(suggested_price_cents or 0),
            "currency": currency or "USD",
            "source": source,
            "status": "active",
            "dedupe_key": dedupe_key,
            "metadata": metadata or {},
        }
        result = await self._execute_query(
            self.supabase.table("marketplace_opportunity_signals").insert(payload)
        )
        rows = getattr(result, "data", None) or []
        return _row_to_signal(rows[0]) if rows else _row_to_signal(payload)

    async def list_due(self, *, user_id: str, now: datetime | None = None) -> list[dict[str, Any]]:
        """Signals due to show now: active, or snoozed with snooze elapsed.

        Expired dated signals are self-cleaned first. Returned rows get their
        show_count bumped so we can reason about repeated exposure later.
        """
        now = now or _now()
        await self.expire_past(user_id=user_id, now=now)

        result = await self._execute_query(
            self.supabase.table("marketplace_opportunity_signals")
            .select("*")
            .eq("user_id", user_id)
            .in_("status", ["active", "snoozed"])
            .order("created_at", desc=True)
        )
        rows = getattr(result, "data", None) or []
        now_iso = now.isoformat()
        due = [
            r
            for r in rows
            if r.get("status") == "active"
            or (r.get("snoozed_until") is not None and str(r["snoozed_until"]) <= now_iso)
        ]

        for r in due:
            await self._execute_query(
                self.supabase.table("marketplace_opportunity_signals")
                .update(
                    {
                        "show_count": int(r.get("show_count") or 0) + 1,
                        "updated_at": now_iso,
                    }
                )
                .eq("id", r["id"])
                .eq("user_id", user_id)
            )
        return [_row_to_signal(r) for r in due]

    async def _owner_update(
        self, *, user_id: str, signal_id: str, update: dict[str, Any]
    ) -> dict[str, Any]:
        """Owner-scoped update; only a signal the owner owns can be mutated."""
        update = {**update, "updated_at": _now_iso()}
        result = await self._execute_query(
            self.supabase.table("marketplace_opportunity_signals")
            .update(update)
            .eq("id", signal_id)
            .eq("user_id", user_id)
        )
        rows = getattr(result, "data", None) or []
        if not rows:
            return {"ok": False, "reason": "not_found", "signalId": signal_id}
        return {"ok": True, "signal": _row_to_signal(rows[0])}

    async def snooze(
        self,
        *,
        user_id: str,
        signal_id: str,
        until: datetime | None = None,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        """Remind me later: hide until the given time (default start of tomorrow)."""
        target = until or _start_of_next_day(now or _now())
        return await self._owner_update(
            user_id=user_id,
            signal_id=signal_id,
            update={"status": "snoozed", "snoozed_until": target.isoformat()},
        )

    async def dismiss(self, *, user_id: str, signal_id: str) -> dict[str, Any]:
        return await self._owner_update(
            user_id=user_id, signal_id=signal_id, update={"status": "dismissed"}
        )

    async def mark_published(self, *, user_id: str, signal_id: str) -> dict[str, Any]:
        """Record that the owner published the slice this signal pointed at.

        The actual publish runs through the consent-first posture flow client-side;
        this only transitions the signal so it stops resurfacing.
        """
        return await self._owner_update(
            user_id=user_id, signal_id=signal_id, update={"status": "published"}
        )

    async def expire_past(self, *, user_id: str, now: datetime | None = None) -> int:
        """Flip active/snoozed dated signals whose event_date has passed to expired."""
        today: date = (now or _now()).date()
        result = await self._execute_query(
            self.supabase.table("marketplace_opportunity_signals")
            .update({"status": "expired", "updated_at": _now_iso()})
            .eq("user_id", user_id)
            .in_("status", ["active", "snoozed"])
            .lt("event_date", today.isoformat())
        )
        return len(getattr(result, "data", None) or [])
