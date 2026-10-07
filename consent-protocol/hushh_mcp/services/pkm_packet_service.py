"""PKM packets: an owner's named, priced bundles of their own PKM details.

A packet references PKM scopes ({domain, scopeHandle, label}); it never holds a
value. Values reach a buyer only through an owner-approved marketplace request
sealed to the buyer's key (marketplace_request_service). Migration 264.

Ten standard kinds exist once per owner; custom packets are unlimited. A packet
is listed for sale only with contents, a dollar price and a credit cost; the DB
CHECK enforces the same rule so a bad write cannot list an empty packet.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from typing import Any

from db.db_client import JsonParam, get_db

logger = logging.getLogger(__name__)

TABLE = "pkm_packets"

# Display order is the catalogue order on every surface.
STANDARD_PACKETS: tuple[dict[str, str], ...] = (
    {
        "kind": "net_worth_scorecard",
        "title": "Net worth score card",
        "description": "Aggregate and liquid net worth, with how it was worked out.",
    },
    {
        "kind": "bank_statements",
        "title": "Bank statements",
        "description": "Last month's statements from your bank accounts.",
    },
    {
        "kind": "brokerage_statements",
        "title": "Brokerage statements",
        "description": "Last month's statements from your investment accounts.",
    },
    {
        "kind": "tax_documents",
        "title": "Tax documents",
        "description": "Return summary, W-2s and 1099s.",
    },
    {
        "kind": "insurance",
        "title": "Insurance packet",
        "description": "Auto, home, life, health and umbrella policies.",
    },
    {
        "kind": "will_trust",
        "title": "Will & trust summaries",
        "description": "Organized estate-planning summaries.",
    },
    {
        "kind": "business_documents",
        "title": "Business documents",
        "description": "Company and ownership records.",
    },
    {
        "kind": "lifestyle",
        "title": "Lifestyle packet",
        "description": "Hobbies, dining and travel preferences.",
    },
    {
        "kind": "full_financial",
        "title": "Full financial packet",
        "description": "Everything financial, one unlock.",
    },
    {
        "kind": "complete_supermodel",
        "title": "Complete supermodel",
        "description": "Your entire personal knowledge model.",
    },
)
STANDARD_KINDS = frozenset(p["kind"] for p in STANDARD_PACKETS)
CUSTOM_KIND = "custom"

MIN_PRICE_CENTS = 50  # card rails cannot settle less
MAX_PRICE_CENTS = 10_000_000
MAX_CREDIT_COST = 1000
MAX_CONTENTS = 200
MAX_CUSTOM_PACKETS = 50


class PacketValidationError(ValueError):
    """A packet write the owner can fix; the message is safe to show them."""


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _str_or_none(value: Any) -> str | None:
    return None if value is None else str(value)


def _clean_contents(raw: Any) -> list[dict[str, str]]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise PacketValidationError("contents must be a list")
    if len(raw) > MAX_CONTENTS:
        raise PacketValidationError(f"a packet can hold at most {MAX_CONTENTS} details")
    seen: set[tuple[str, str]] = set()
    out: list[dict[str, str]] = []
    for item in raw:
        if not isinstance(item, dict):
            raise PacketValidationError("each detail must be an object")
        domain = str(item.get("domain") or "").strip()
        scope = str(item.get("scopeHandle") or item.get("scope_handle") or "").strip()
        label = str(item.get("label") or "").strip()[:120]
        if not domain or len(domain) > 120 or len(scope) > 240:
            raise PacketValidationError("each detail needs a domain")
        key = (domain, scope)
        if key in seen:
            continue
        seen.add(key)
        out.append({"domain": domain, "scopeHandle": scope, "label": label or domain})
    return out


def _clean_price(value: Any) -> int | None:
    if value is None:
        return None
    try:
        cents = int(value)
    except (TypeError, ValueError):
        raise PacketValidationError("price must be a whole number of cents") from None
    if not MIN_PRICE_CENTS <= cents <= MAX_PRICE_CENTS:
        raise PacketValidationError("price must be at least $0.50")
    return cents


def _clean_credits(value: Any) -> int | None:
    if value is None:
        return None
    try:
        credits = int(value)
    except (TypeError, ValueError):
        raise PacketValidationError("credit cost must be a whole number") from None
    if not 1 <= credits <= MAX_CREDIT_COST:
        raise PacketValidationError(f"credit cost must be between 1 and {MAX_CREDIT_COST}")
    return credits


def _check_sale_ready(row: dict[str, Any]) -> None:
    if not row.get("for_sale"):
        return
    if not row.get("contents"):
        raise PacketValidationError("add at least one detail before listing this packet")
    if row.get("price_cents") is None or row.get("credit_cost") is None:
        raise PacketValidationError("set a price and a credit cost before listing this packet")


def _row_to_packet(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": _str_or_none(row.get("id")),
        "kind": row.get("packet_kind"),
        "title": row.get("title"),
        "description": row.get("description"),
        "contents": row.get("contents") or [],
        "priceCents": row.get("price_cents"),
        "creditCost": row.get("credit_cost"),
        "currency": row.get("currency") or "USD",
        "forSale": bool(row.get("for_sale")),
        "createdAt": _str_or_none(row.get("created_at")),
        "updatedAt": _str_or_none(row.get("updated_at")),
    }


def public_packet(row: dict[str, Any]) -> dict[str, Any]:
    """What a stranger may see: name, price and the packet id to buy it. Never
    contents or the owner's id."""
    return {
        "id": _str_or_none(row.get("id")),
        "kind": row.get("packet_kind"),
        "title": row.get("title"),
        "description": row.get("description"),
        "priceCents": row.get("price_cents"),
        "creditCost": row.get("credit_cost"),
        "currency": row.get("currency") or "USD",
    }


def _standard_order(row: dict[str, Any]) -> tuple[int, str]:
    kinds = [p["kind"] for p in STANDARD_PACKETS]
    kind = row.get("packet_kind")
    return (kinds.index(kind) if kind in kinds else len(kinds), str(row.get("created_at") or ""))


class PkmPacketService:
    def __init__(self) -> None:
        self._db = None

    @property
    def db(self):
        if self._db is None:
            self._db = get_db()
        return self._db

    async def _execute(self, query):
        return await asyncio.to_thread(query.execute)

    async def list_packets(self, *, owner_user_id: str) -> list[dict[str, Any]]:
        result = await self._execute(
            self.db.table(TABLE).select("*").eq("owner_user_id", owner_user_id)
        )
        rows = sorted(getattr(result, "data", None) or [], key=_standard_order)
        return [_row_to_packet(r) for r in rows]

    async def _get_row(self, *, owner_user_id: str, packet_id: str) -> dict[str, Any] | None:
        result = await self._execute(
            self.db.table(TABLE)
            .select("*")
            .eq("id", packet_id)
            .eq("owner_user_id", owner_user_id)
            .limit(1)
        )
        rows = getattr(result, "data", None) or []
        return rows[0] if rows else None

    async def create_packet(self, *, owner_user_id: str, body: dict[str, Any]) -> dict[str, Any]:
        kind = str(body.get("kind") or "").strip()
        standard = next((p for p in STANDARD_PACKETS if p["kind"] == kind), None)
        if kind != CUSTOM_KIND and standard is None:
            raise PacketValidationError("unknown packet kind")

        existing = await self.list_packets(owner_user_id=owner_user_id)
        if standard and any(p["kind"] == kind for p in existing):
            raise PacketValidationError("you already have this packet")
        if (
            kind == CUSTOM_KIND
            and sum(p["kind"] == CUSTOM_KIND for p in existing) >= MAX_CUSTOM_PACKETS
        ):
            raise PacketValidationError(f"you can have at most {MAX_CUSTOM_PACKETS} custom packets")

        title = str(body.get("title") or (standard or {}).get("title") or "").strip()
        if not 1 <= len(title) <= 80:
            raise PacketValidationError("a packet needs a title of up to 80 characters")
        description = body.get("description", (standard or {}).get("description"))
        description = str(description).strip()[:280] if description else None

        row = {
            "owner_user_id": owner_user_id,
            "packet_kind": kind,
            "title": title,
            "description": description,
            "contents": _clean_contents(body.get("contents")),
            "price_cents": _clean_price(body.get("priceCents")),
            "credit_cost": _clean_credits(body.get("creditCost")),
            "for_sale": bool(body.get("forSale")),
        }
        _check_sale_ready(row)
        # An empty list would bind as a Postgres array; contents is always JSONB.
        result = await self._execute(
            self.db.table(TABLE).insert({**row, "contents": JsonParam(row["contents"])})
        )
        rows = getattr(result, "data", None) or []
        return _row_to_packet(rows[0] if rows else row)

    async def update_packet(
        self, *, owner_user_id: str, packet_id: str, body: dict[str, Any]
    ) -> dict[str, Any] | None:
        current = await self._get_row(owner_user_id=owner_user_id, packet_id=packet_id)
        if current is None:
            return None
        patch: dict[str, Any] = {}
        if "title" in body:
            title = str(body.get("title") or "").strip()
            if not 1 <= len(title) <= 80:
                raise PacketValidationError("a packet needs a title of up to 80 characters")
            patch["title"] = title
        if "description" in body:
            desc = body.get("description")
            patch["description"] = str(desc).strip()[:280] if desc else None
        if "contents" in body:
            patch["contents"] = _clean_contents(body.get("contents"))
        if "priceCents" in body:
            patch["price_cents"] = _clean_price(body.get("priceCents"))
        if "creditCost" in body:
            patch["credit_cost"] = _clean_credits(body.get("creditCost"))
        if "forSale" in body:
            patch["for_sale"] = bool(body.get("forSale"))
        _check_sale_ready({**current, **patch})
        patch["updated_at"] = _now_iso()
        write = (
            {**patch, "contents": JsonParam(patch["contents"])} if "contents" in patch else patch
        )
        result = await self._execute(
            self.db.table(TABLE)
            .update(write)
            .eq("id", packet_id)
            .eq("owner_user_id", owner_user_id)
        )
        rows = getattr(result, "data", None) or []
        return _row_to_packet(rows[0] if rows else {**current, **patch})

    async def delete_packet(self, *, owner_user_id: str, packet_id: str) -> bool:
        result = await self._execute(
            self.db.table(TABLE).delete().eq("id", packet_id).eq("owner_user_id", owner_user_id)
        )
        return bool(getattr(result, "data", None))

    async def for_sale_by_owner(self, owner_user_ids: list[str]) -> dict[str, list[dict[str, Any]]]:
        """For-sale packets per owner, public shape only, in catalogue order."""
        if not owner_user_ids:
            return {}
        result = await self._execute(
            self.db.table(TABLE)
            .select("*")
            .in_("owner_user_id", owner_user_ids)
            .eq("for_sale", True)
        )
        grouped: dict[str, list[dict[str, Any]]] = {}
        for row in sorted(getattr(result, "data", None) or [], key=_standard_order):
            grouped.setdefault(str(row.get("owner_user_id")), []).append(public_packet(row))
        return grouped
