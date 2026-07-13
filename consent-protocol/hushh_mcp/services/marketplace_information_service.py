"""Read model for the One Personal Information Agent (marketplace).

The Personal Information Agent is the marketplace chatbot: it answers which
owner-published public-profile resources are active and what their safe summaries
are worth. This service is the single, truthful read source for those questions.

Consent safety: it reads ONLY the owner's own scope-registry metadata (labels,
sensitivity tier, attribute count, visibility posture) and the safe summary
projection. It never returns raw PKM values or another user's data. Pricing is
computed by the pure, deterministic backend engine (hushh_mcp.pricing), so the
agent cannot fabricate a number.

Honesty about "earnings": there is NO payment rail yet, so nothing is ever
accrued or settled (accrued_cents is always 0, payouts_enabled is always False).
What IS real is buyer *demand* — durable access requests (migration 076) that
buyers file against published slices. The summary reports that real demand
(pending/approved counts) alongside a *potential* monthly price tag, and says
payments are "coming soon" — so the agent surfaces genuine interest without ever
implying money has changed hands.
"""

from __future__ import annotations

import logging
from typing import Any

from hushh_mcp.pricing import (
    SlicePricingInput,
    category_from_sensitivity,
    compute_suggested_price,
)
from hushh_mcp.services.marketplace_request_service import MarketplaceRequestService
from hushh_mcp.services.personal_knowledge_model_service import (
    PersonalKnowledgeModelService,
)

logger = logging.getLogger(__name__)


def _domain_title(domain: str) -> str:
    """Human-readable title for a domain key (e.g. 'personal_data' -> 'Personal Data')."""
    return (domain or "").replace(".", " ").replace("_", " ").strip().title() or "Data"


def _attribute_count(entry: dict) -> int:
    segments = entry.get("segment_ids") or []
    return max(1, len(segments))


def _plural(n: int, singular: str, plural: str) -> str:
    return singular if n == 1 else plural


def _earnings_note(demand: dict[str, Any]) -> str:
    """Honest one-liner for the summary: report real buyer demand but never imply
    money — payouts are not enabled yet ("payments coming soon")."""
    approved = demand.get("approvedBuyerCount", 0)
    pending = demand.get("pendingRequestCount", 0)
    if approved or pending:
        parts: list[str] = []
        if approved:
            parts.append(f"{approved} {_plural(approved, 'buyer has', 'buyers have')} access")
        if pending:
            parts.append(f"{pending} {_plural(pending, 'request is', 'requests are')} waiting")
        lead = " and ".join(parts)
        return (
            f"{lead}. Payments are coming soon — no payout has been made yet, so "
            "nothing is accrued or settled."
        )
    return (
        "Potential only. No buyer has requested access yet and payments are coming "
        "soon (no payment rail), so nothing is accrued or settled."
    )


# Commercial-intent / life-event cues that make an unpublished slice worth offers
# (mirrors the frontend detectOfferSignal so backend and UI agree).
_OFFER_KEYWORDS = (
    "insurance",
    "renewal",
    "renew",
    "expir",
    "mortgage",
    "loan",
    "credit",
    "travel",
    "trip",
    "flight",
    "hotel",
    "vacation",
    "car",
    "vehicle",
    "auto",
    "shopping",
    "purchase",
    "buying",
    "move",
    "moving",
    "relocat",
    "baby",
    "expecting",
    "pregnan",
    "wedding",
    "engaged",
    "job",
    "salary",
    "income",
    "subscription",
    "warranty",
    "health",
    "fitness",
    "education",
    "tuition",
    "home",
    "property",
    "invest",
    "portfolio",
    "retirement",
    "savings",
    "spend",
    "financial",
    "professional",
)

# System/structural scope labels that can never be published (not personal data).
_STRUCTURAL_LABELS = {
    "hash",
    "metadata",
    "provenance",
    "schema version",
    "workflow",
    "workflow id",
    "domain intent",
    "updated at",
    "schema",
    "version",
}


def _looks_offer_worthy(label: str, domain_title: str) -> bool:
    hay = f"{label} {domain_title}".lower()
    return any(kw in hay for kw in _OFFER_KEYWORDS)


def _matches_topic(topic: str, label: str, domain_title: str) -> bool:
    t = (topic or "").strip().lower()
    if not t:
        return True
    hay = f"{label} {domain_title}".lower()
    # match on the topic word or any whitespace-separated token of it
    return any(tok and tok in hay for tok in [t, *t.split()])


class MarketplaceInformationService:
    """Read-only view over the owner's published marketplace slices + pricing."""

    def __init__(
        self,
        pkm_service: PersonalKnowledgeModelService | None = None,
        request_service: MarketplaceRequestService | None = None,
    ) -> None:
        self._pkm = pkm_service or PersonalKnowledgeModelService()
        self._requests = request_service or MarketplaceRequestService()

    async def _demand_snapshot(self, *, user_id: str) -> dict[str, Any]:
        """Real buyer demand for this owner from the durable access-request inbox
        (migration 076). Best-effort: a broken inbox degrades to zero demand
        rather than breaking the earnings summary."""
        empty = {
            "pendingRequestCount": 0,
            "approvedBuyerCount": 0,
            "interestedBuyerCount": 0,
            "hasBuyers": False,
        }
        try:
            requests = await self._requests.list_requests(owner_user_id=user_id)
        except Exception:
            logger.exception("marketplace.earnings_demand_read_failed")
            return empty
        pending = [r for r in requests if r.get("status") == "pending"]
        approved = [r for r in requests if r.get("status") == "approved"]

        def _buyer_key(r: dict) -> str:
            # Prefer a real account id; fall back to the label, then the request id
            # so an anonymous request still counts as one distinct interested buyer.
            return r.get("buyerUserId") or r.get("buyerLabel") or str(r.get("id"))

        interested = {_buyer_key(r) for r in (pending + approved)}
        return {
            "pendingRequestCount": len(pending),
            "approvedBuyerCount": len(approved),
            "interestedBuyerCount": len(interested),
            "hasBuyers": len(approved) > 0,
        }

    async def list_published_slices(self, *, user_id: str) -> list[dict[str, Any]]:
        """Active owner-published public profiles, without projection plaintext."""
        index = await self._pkm.get_index_v2(user_id)
        if index is None:
            return []
        domains = list(index.available_domains or [])
        published: list[dict[str, Any]] = []
        for domain in domains:
            manifest = await self._pkm.get_domain_manifest(user_id, domain)
            if not manifest:
                continue
            active = await self._pkm.list_public_profile_projections(user_id=user_id, domain=domain)
            for projection in active:
                entry = next(
                    (
                        candidate
                        for candidate in (manifest.get("scope_registry") or [])
                        if candidate.get("scope_handle") == projection.get("scope_handle")
                        or (candidate.get("summary_projection") or {}).get("top_level_scope_path")
                        == projection.get("top_level_scope_path")
                    ),
                    {},
                )
                published.append(
                    {
                        "domain": entry.get("domain") or domain,
                        "domainTitle": _domain_title(entry.get("domain") or domain),
                        "label": entry.get("scope_label") or "Data slice",
                        "scopeHandle": entry.get("scope_handle"),
                        "sensitivityTier": entry.get("sensitivity_tier"),
                        "scopeKind": entry.get("scope_kind"),
                        "attributeCount": _attribute_count(entry),
                        "publicProfileHandle": projection.get("public_profile_handle"),
                    }
                )
        return published

    async def list_publishable_slices(
        self,
        *,
        user_id: str,
        topic: str | None = None,
        power: str = "affluent",
        mood: str = "affinity",
    ) -> list[dict[str, Any]]:
        """Unpublished, offer-worthy slices the owner could publish for offers —
        the source for the inline 'publish for offers' card. When `topic` is given
        (e.g. 'financial'), results are filtered to that context; otherwise all
        offer-worthy unpublished slices are returned. Excludes system/structural
        scopes. Value/coordinate-free — labels, counts, suggested price only.
        """
        index = await self._pkm.get_index_v2(user_id)
        if index is None:
            return []
        out: list[dict[str, Any]] = []
        for domain in list(index.available_domains or []):
            manifest = await self._pkm.get_domain_manifest(user_id, domain)
            if not manifest:
                continue
            active = await self._pkm.list_public_profile_projections(user_id=user_id, domain=domain)
            active_paths = {str(item.get("top_level_scope_path") or "") for item in active}
            for entry in manifest.get("scope_registry") or []:
                entry_path = str(
                    (entry.get("summary_projection") or {}).get("top_level_scope_path") or ""
                )
                if entry_path in active_paths:
                    continue  # already published as a public profile
                label = entry.get("scope_label") or "Data slice"
                if label.strip().lower() in _STRUCTURAL_LABELS:
                    continue
                domain_title = _domain_title(entry.get("domain") or domain)
                if topic:
                    if not _matches_topic(topic, label, domain_title):
                        continue
                elif not _looks_offer_worthy(label, domain_title):
                    continue
                category = category_from_sensitivity(
                    entry.get("sensitivity_tier"), entry.get("scope_kind")
                )
                try:
                    breakdown = compute_suggested_price(
                        SlicePricingInput(
                            category=category,
                            attribute_count=_attribute_count(entry),
                            power=power,
                            mood=mood,
                        )
                    )
                    price_cents = breakdown.suggested_price_cents
                    currency = breakdown.currency
                except KeyError:
                    price_cents = 0
                    currency = "USD"
                # The section path the publish flow targets (slice-publishing.ts
                # matches on `summary_projection.top_level_scope_path`). Surfacing it
                # here lets the opportunity card publish the slice without a second
                # manifest lookup to rediscover the section.
                projection = entry.get("summary_projection") or {}
                top_level_scope_path = projection.get("top_level_scope_path")
                out.append(
                    {
                        "domain": entry.get("domain") or domain,
                        "domainTitle": domain_title,
                        "label": label,
                        "scopeHandle": entry.get("scope_handle"),
                        "topLevelScopePath": top_level_scope_path,
                        "attributeCount": _attribute_count(entry),
                        "suggestedPriceCents": price_cents,
                        "currency": currency,
                    }
                )
        return out[:6]

    async def earnings_summary(
        self,
        *,
        user_id: str,
        power: str = "affluent",
        mood: str = "affinity",
    ) -> dict[str, Any]:
        """Real buyer demand + potential (never accrued) monthly price across the
        owner's published slices. `accruedCents` is always 0 and `payoutsEnabled`
        is always False — there is no payment rail yet ("payments coming soon").
        """
        slices = await self.list_published_slices(user_id=user_id)
        demand = await self._demand_snapshot(user_id=user_id)
        per_slice: list[dict[str, Any]] = []
        total_potential_cents = 0
        currency = "USD"
        for sl in slices:
            category = category_from_sensitivity(sl.get("sensitivityTier"), sl.get("scopeKind"))
            try:
                breakdown = compute_suggested_price(
                    SlicePricingInput(
                        category=category,
                        attribute_count=int(sl.get("attributeCount") or 1),
                        power=power,
                        mood=mood,
                    )
                )
            except KeyError:
                # Unknown band/category — skip pricing this slice rather than guess.
                continue
            currency = breakdown.currency
            total_potential_cents += breakdown.suggested_price_cents
            # The same "show math" factors the dashboard's PriceMath renders:
            # Price = ( floor + data value ) × buyer fit × freshness × exclusivity × geo
            floor_dollars = breakdown.floor_cents / 100.0
            data_value_dollars = max(0.0, breakdown.composite_dollars - floor_dollars)
            per_slice.append(
                {
                    "label": sl["label"],
                    "domainTitle": sl["domainTitle"],
                    "suggestedPriceCents": breakdown.suggested_price_cents,
                    "currency": breakdown.currency,
                    "math": {
                        "floorDollars": round(floor_dollars, 2),
                        "dataValueDollars": round(data_value_dollars, 2),
                        "buyerFit": round(breakdown.multiplier_b, 2),
                        "freshness": round(breakdown.multiplier_f, 2),
                        "exclusivity": round(breakdown.multiplier_x, 2),
                        "geo": round(breakdown.multiplier_g, 2),
                        "finalDollars": round(breakdown.suggested_price_cents / 100.0, 2),
                    },
                }
            )
        return {
            "sliceCount": len(slices),
            "pricedSliceCount": len(per_slice),
            "totalPotentialMonthlyCents": total_potential_cents,
            "accruedCents": 0,
            "currency": currency,
            "perSlice": per_slice,
            # The pricing formula the dashboard shows under "Show math" — the agent
            # can explain it and reference each slice's `math` factors above.
            "formula": (
                "Price = ( floor + data value ) × buyer fit × freshness × exclusivity × geo, "
                "floored at $0.10. Data value: financial data counts most, plain demographics "
                "least; more attributes help with diminishing returns. Buyer fit: spending power "
                "× buying mood. Freshness: updated today = full value, stale fades toward a floor. "
                "Exclusivity: sold to everyone = base, one buyer = worth more."
            ),
            "band": {"power": power, "mood": mood},
            # Real buyer demand from the durable access-request inbox (migration 076).
            "pendingRequestCount": demand["pendingRequestCount"],
            "approvedBuyerCount": demand["approvedBuyerCount"],
            "interestedBuyerCount": demand["interestedBuyerCount"],
            # Explicit honesty flags the agent's prompt relies on. Demand can be
            # real, but money never is yet: nothing is accrued and payouts are off.
            "hasBuyers": demand["hasBuyers"],
            "hasPaymentRail": False,
            "payoutsEnabled": False,
            "note": _earnings_note(demand),
        }
