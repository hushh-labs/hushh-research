"""Read model for the One Personal Information Agent (marketplace).

The Personal Information Agent is the marketplace chatbot: it answers what the
owner has published as `default_available` PKM slices and what those slices are
worth. This service is the single, truthful read source for those questions.

Consent safety: it reads ONLY the owner's own scope-registry metadata (labels,
sensitivity tier, attribute count, visibility posture) and the safe summary
projection. It never returns raw PKM values or another user's data. Pricing is
computed by the pure, deterministic backend engine (hushh_mcp.pricing), so the
agent cannot fabricate a number.

Honesty about "earnings": there is NO payment rail and NO buyers yet. Published
slices have a *potential* monthly price only; nothing is accrued or settled. The
summary makes that explicit (accrued_cents is always 0) so the agent never
implies money that does not exist.
"""

from __future__ import annotations

import logging
from typing import Any

from hushh_mcp.pricing import (
    SlicePricingInput,
    category_from_sensitivity,
    compute_suggested_price,
)
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

    def __init__(self, pkm_service: PersonalKnowledgeModelService | None = None) -> None:
        self._pkm = pkm_service or PersonalKnowledgeModelService()

    async def list_published_slices(self, *, user_id: str) -> list[dict[str, Any]]:
        """Every scope the owner has set to `default_available` (published), across
        all their domains. Coordinate/value-free — labels and public metadata only.
        """
        index = await self._pkm.get_index_v2(user_id)
        if index is None:
            return []
        domains = list(index.available_domains or [])
        published: list[dict[str, Any]] = []
        for domain in domains:
            manifest = await self._pkm.get_domain_manifest(user_id, domain)
            if not manifest:
                continue
            for entry in manifest.get("scope_registry") or []:
                if entry.get("visibility_posture") != "default_available":
                    continue
                published.append(
                    {
                        "domain": entry.get("domain") or domain,
                        "domainTitle": _domain_title(entry.get("domain") or domain),
                        "label": entry.get("scope_label") or "Data slice",
                        "scopeHandle": entry.get("scope_handle"),
                        "sensitivityTier": entry.get("sensitivity_tier"),
                        "scopeKind": entry.get("scope_kind"),
                        "attributeCount": _attribute_count(entry),
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
            for entry in manifest.get("scope_registry") or []:
                if entry.get("visibility_posture") == "default_available":
                    continue  # already published
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
        """Potential (never accrued) monthly earnings across the owner's published
        slices. `accruedCents` is always 0 — there is no payment rail or buyer yet.
        """
        slices = await self.list_published_slices(user_id=user_id)
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
            # Explicit honesty flags the agent's prompt relies on.
            "hasBuyers": False,
            "hasPaymentRail": False,
            "note": (
                "Potential only. No buyer has subscribed and no payment rail exists "
                "yet, so nothing is accrued or settled."
            ),
        }
