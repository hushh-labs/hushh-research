"""Anonymized cross-user catalog of published data slices (the Buyer directory).

The Information Marketplace's Buyer tab shows a browsing buyer *everyone else's*
published slices — the same safe-summary preview the owner published, priced by
the deterministic engine — but with the owner's identity hidden behind an opaque
ref. This makes demand real and two-account: a buyer files a request into the
owner's durable inbox (migration 076), not against themselves.

Discovery source is `pkm_default_available_projections` (migration 063): every
active row (`revoked_at IS NULL`) is a slice its owner set to `default_available`
and published a safe summary for. We read that table cross-user, exclude the
viewer's own rows, and never expose the real owner user_id — only a stable hash
(`ownerRef`), the owner's public display name (`ownerName`, so a buyer can see who
they'd be buying from), and an opaque `listingId` (the projection row id). The
server keeps the listingId -> owner map internal (see `resolve_listing`).

Consent safety mirrors the owner-side read model: we surface only the published
safe-summary projection plus scope-registry *metadata* (label, sensitivity tier,
attribute count) — never raw PKM values, and never another user's identity.
Pricing is the same pure engine the owner sees (`hushh_mcp.pricing`).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from typing import Any

from db.db_client import get_db
from hushh_mcp.pricing import (
    SlicePricingInput,
    category_from_sensitivity,
    compute_suggested_price,
)
from hushh_mcp.services.actor_identity_service import ActorIdentityService
from hushh_mcp.services.personal_knowledge_model_service import (
    PersonalKnowledgeModelService,
)

logger = logging.getLogger(__name__)

# Columns we read from the projection table — never select the whole row into a
# response; the mapping to owner identity stays server-side.
_PROJECTION_COLUMNS = (
    "id,user_id,domain,scope,scope_handle,top_level_scope_path,projection_payload,updated_at"
)


def _domain_title(domain: str) -> str:
    """Human-readable title for a domain key (mirrors MarketplaceInformationService)."""
    return (domain or "").replace(".", " ").replace("_", " ").strip().title() or "Data"


def _owner_ref(user_id: str) -> str:
    """Stable, opaque reference for an owner — a truncated SHA-256 of the user id.

    Same owner always maps to the same ref (so a buyer can tell two listings come
    from one seller), but the real id/name can never be recovered from it.
    """
    digest = hashlib.sha256((user_id or "").encode("utf-8")).hexdigest()
    return f"own_{digest[:16]}"


def _owner_display_name(identity: dict[str, Any] | None, owner_ref: str) -> str:
    """Public, buyer-facing name for the seller behind a listing. Prefers the
    owner's real display name, then the local-part of their email, and finally a
    short label derived from the opaque ref so the UI always has something to show.
    Only names/emails the identity cache already holds are used — no raw user id."""
    identity = identity or {}
    display_name = str(identity.get("display_name") or "").strip()
    if display_name:
        return display_name
    email = str(identity.get("email") or "").strip()
    if email:
        local = email.split("@", 1)[0].strip()
        if local:
            return local
    return f"Seller {owner_ref[-6:]}"


def _coerce_payload(value: Any) -> dict[str, Any]:
    """Projection payloads are JSONB but can come back as a str depending on the
    driver; coerce to a dict, degrading to {} rather than raising."""
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except Exception:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _presentation_attribute_count(presentation: dict[str, Any]) -> int:
    """Best-effort attribute count from a published preview presentation, used only
    when the owner's live manifest can't be matched. Counts visible fields, list/
    chip items, and entity fields so the price still reflects slice richness."""
    if not isinstance(presentation, dict):
        return 1
    count = 0
    for group in presentation.get("groups") or []:
        if not isinstance(group, dict):
            continue
        kind = group.get("kind")
        if kind == "fields":
            count += len(group.get("fields") or [])
        elif kind in ("chips", "list"):
            count += len(group.get("items") or [])
        elif kind == "entities":
            for entity in group.get("items") or []:
                if isinstance(entity, dict):
                    count += max(1, len(entity.get("fields") or []))
    return max(1, count)


def _attribute_count_for(entry: dict[str, Any] | None, presentation: dict[str, Any]) -> int:
    """The number of attributes in a slice, used for both display and pricing.

    A registry entry's `segment_ids` is authoritative for a *segment* scope (the
    owner hand-picked those attributes). But a *subtree* scope stores a single
    marker (`["root"]`), so its length is 1 regardless of how many leaf fields the
    subtree actually holds — that undercounts (and underprices) the slice. For
    subtrees (or a missing entry) we fall back to the published preview's field
    count, which reflects the real leaves.
    """
    presentation_count = _presentation_attribute_count(presentation)
    if entry is None:
        return presentation_count
    segment_ids = entry.get("segment_ids") or []
    is_subtree = entry.get("scope_kind") == "subtree" or segment_ids in ([], ["root"])
    if is_subtree:
        return max(presentation_count, len(segment_ids), 1)
    return max(1, len(segment_ids))


def _safe_preview(presentation: dict[str, Any]) -> dict[str, Any]:
    """Buyer-safe projection of an owner's published presentation.

    CRITICAL PRIVACY BOUNDARY. The presentation stored in
    `pkm_default_available_projections` is the OWNER's own preview and embeds raw
    saved VALUES (e.g. a home address, a postal code). A browsing buyer must never
    see those — only the *shape* of the slice: its title, which field names it
    contains, and how many items each group holds. This rebuilds a preview that
    keeps labels and aggregate counts and drops every value-bearing key.
    """
    if not isinstance(presentation, dict):
        return {}
    safe: dict[str, Any] = {"title": presentation.get("title") or "Data slice", "stats": []}
    if presentation.get("description"):
        safe["description"] = presentation["description"]
    # stats are aggregate counts (e.g. "Fields: 5") — no raw values, safe to keep.
    stats = presentation.get("stats")
    if isinstance(stats, list):
        safe["stats"] = [
            {"label": s.get("label"), "value": s.get("value")}
            for s in stats
            if isinstance(s, dict) and s.get("label") is not None
        ]

    field_names: list[str] = []
    for group in presentation.get("groups") or []:
        if not isinstance(group, dict):
            continue
        kind = group.get("kind")
        if kind == "fields":
            for field in group.get("fields") or []:
                if isinstance(field, dict) and field.get("label"):
                    field_names.append(str(field["label"]))
        elif kind == "entities":
            # Entity titles/subtitles/section items are raw values → never surface.
            # Only the field *names* inside entities describe the slice shape.
            for entity in group.get("items") or []:
                if not isinstance(entity, dict):
                    continue
                for field in entity.get("fields") or []:
                    if isinstance(field, dict) and field.get("label"):
                        field_names.append(str(field["label"]))
        # chips / list groups are pure values (e.g. saved preferences) — dropped
        # entirely; the count already lives in `stats`.

    # De-duplicate while preserving order so the buyer sees each field name once.
    seen: set[str] = set()
    unique_names = [n for n in field_names if not (n in seen or seen.add(n))]

    groups: list[dict[str, Any]] = []
    if unique_names:
        groups.append({"kind": "chips", "title": "Included fields", "items": unique_names})
    safe["groups"] = groups
    return safe


class MarketplaceCatalogService:
    """Read model for the anonymized cross-user Buyer directory + listing resolution."""

    def __init__(
        self,
        pkm_service: PersonalKnowledgeModelService | None = None,
    ) -> None:
        self._pkm = pkm_service or PersonalKnowledgeModelService()
        self._identity = ActorIdentityService()
        self._supabase = None

    @property
    def supabase(self):
        if self._supabase is None:
            self._supabase = get_db()
        return self._supabase

    async def _execute_query(self, query):
        return await asyncio.to_thread(query.execute)

    # --- pricing metadata -------------------------------------------------

    async def _registry_index(
        self, *, owner_user_id: str, domain: str, cache: dict[tuple[str, str], dict]
    ) -> dict[str, dict[str, Any]]:
        """Load the owner's scope-registry entries for a domain, indexed by both
        scope_handle and top_level_scope_path so a projection row can find its
        entry (for real sensitivity/attribute pricing inputs). Memoized per call;
        best-effort — a missing manifest degrades to an empty index (default price).
        """
        key = (owner_user_id, domain)
        if key in cache:
            return cache[key]
        index: dict[str, dict[str, Any]] = {}
        try:
            manifest = await self._pkm.get_domain_manifest(owner_user_id, domain)
        except Exception:
            logger.debug("catalog.manifest_load_failed owner=%s domain=%s", owner_user_id, domain)
            manifest = None
        if manifest:
            for entry in manifest.get("scope_registry") or []:
                if not isinstance(entry, dict):
                    continue
                handle = entry.get("scope_handle")
                if handle:
                    index[f"h:{handle}"] = entry
                projection = entry.get("summary_projection")
                top = (
                    projection.get("top_level_scope_path") if isinstance(projection, dict) else None
                )
                if top:
                    index[f"p:{top}"] = entry
        cache[key] = index
        return index

    def _price_for(self, entry: dict[str, Any] | None, *, attribute_count: int) -> tuple[int, str]:
        """Suggested 30-day price for a slice. Uses the owner's real registry entry
        for the sensitivity category when matched; otherwise a conservative
        demographics default. The attribute count is computed by the caller (see
        `_attribute_count_for`, which handles subtree scopes) and passed in so
        display and price never disagree. Band is the neutral affluent/affinity
        default the owner-side read model uses.
        """
        if entry is not None:
            category = category_from_sensitivity(
                entry.get("sensitivity_tier"), entry.get("scope_kind")
            )
        else:
            category = "demographics_lifestyle"
        attribute_count = max(1, int(attribute_count or 1))
        try:
            breakdown = compute_suggested_price(
                SlicePricingInput(
                    category=category,
                    attribute_count=attribute_count,
                    power="affluent",
                    mood="affinity",
                )
            )
        except KeyError:
            return 0, "USD"
        return breakdown.suggested_price_cents, breakdown.currency

    # --- directory --------------------------------------------------------

    async def _resolve_owner_identities(self, owner_ids: set[str]) -> dict[str, dict[str, Any]]:
        """Best-effort batch lookup of seller display names. Identity resolution
        must never break the directory, so any failure degrades to empty (each
        listing then falls back to a ref-derived seller label)."""
        if not owner_ids:
            return {}
        try:
            return await self._identity.get_many(owner_ids)
        except Exception:
            logger.warning("marketplace.owner_identity_resolution_failed", exc_info=True)
            return {}

    async def list_available_listings(self, *, viewer_user_id: str) -> list[dict[str, Any]]:
        """Every active published slice from OTHER users, anonymized. The viewer's
        own listings are excluded (you don't buy your own data)."""
        query = (
            self.supabase.table("pkm_default_available_projections")
            .select(_PROJECTION_COLUMNS)
            .neq("publication_provenance", "")
            .is_("revoked_at", None)
            .neq("user_id", viewer_user_id)
            .order("updated_at", desc=True)
        )
        result = await self._execute_query(query)
        rows = getattr(result, "data", None) or []
        # Resolve every distinct owner's public display name in one batch so the
        # directory can show who published each slice (identity cache only).
        owner_ids = {
            str(row.get("user_id") or "")
            for row in rows
            if str(row.get("user_id") or "") and str(row.get("user_id")) != viewer_user_id
        }
        identities = await self._resolve_owner_identities(owner_ids)
        registry_cache: dict[tuple[str, str], dict] = {}
        listings: list[dict[str, Any]] = []
        for row in rows:
            owner_user_id = str(row.get("user_id") or "")
            if not owner_user_id or owner_user_id == viewer_user_id:
                continue
            domain = row.get("domain") or ""
            payload = _coerce_payload(row.get("projection_payload"))
            presentation = payload.get("presentation")
            presentation = presentation if isinstance(presentation, dict) else {}
            label = payload.get("label") or row.get("scope") or "Data slice"
            top_level_scope_path = payload.get("section") or row.get("top_level_scope_path") or ""
            registry = await self._registry_index(
                owner_user_id=owner_user_id, domain=domain, cache=registry_cache
            )
            entry = registry.get(f"h:{row.get('scope_handle')}") or registry.get(
                f"p:{top_level_scope_path}"
            )
            attribute_count = _attribute_count_for(entry, presentation)
            price_cents, currency = self._price_for(entry, attribute_count=attribute_count)
            owner_ref = _owner_ref(owner_user_id)
            listings.append(
                {
                    "listingId": str(row.get("id")),
                    "ownerRef": owner_ref,
                    "ownerName": _owner_display_name(identities.get(owner_user_id), owner_ref),
                    "domain": domain,
                    "domainTitle": _domain_title(domain),
                    "label": label,
                    "topLevelScopePath": top_level_scope_path,
                    "attributeCount": attribute_count,
                    # NEVER send the raw presentation to a buyer — it embeds saved
                    # values. Only the value-stripped, names-only shape crosses the wire.
                    "preview": _safe_preview(presentation),
                    "suggestedPriceCents": price_cents,
                    "currency": currency,
                }
            )
        return listings

    async def resolve_listing(self, *, listing_id: str) -> dict[str, Any] | None:
        """Resolve an opaque listingId back to the real owner + slice descriptor +
        suggested price. Internal only — the owner user_id here is never returned to
        a buyer's browser; it is used server-side to file the access request."""
        try:
            numeric_id = int(str(listing_id).strip())
        except (TypeError, ValueError):
            return None
        query = (
            self.supabase.table("pkm_default_available_projections")
            .select(_PROJECTION_COLUMNS)
            .eq("id", numeric_id)
            .neq("publication_provenance", "")
            .is_("revoked_at", None)
            .limit(1)
        )
        result = await self._execute_query(query)
        rows = getattr(result, "data", None) or []
        if not rows:
            return None
        row = rows[0]
        owner_user_id = str(row.get("user_id") or "")
        if not owner_user_id:
            return None
        domain = row.get("domain") or ""
        payload = _coerce_payload(row.get("projection_payload"))
        presentation = payload.get("presentation")
        presentation = presentation if isinstance(presentation, dict) else {}
        label = payload.get("label") or row.get("scope") or "Data slice"
        top_level_scope_path = payload.get("section") or row.get("top_level_scope_path") or ""
        registry_cache: dict[tuple[str, str], dict] = {}
        registry = await self._registry_index(
            owner_user_id=owner_user_id, domain=domain, cache=registry_cache
        )
        entry = registry.get(f"h:{row.get('scope_handle')}") or registry.get(
            f"p:{top_level_scope_path}"
        )
        attribute_count = _attribute_count_for(entry, presentation)
        price_cents, currency = self._price_for(entry, attribute_count=attribute_count)
        return {
            "listingId": str(row.get("id")),
            "ownerUserId": owner_user_id,
            "domain": domain,
            "scopeHandle": row.get("scope_handle"),
            "sliceLabel": label,
            "topLevelScopePath": top_level_scope_path,
            "priceCents": price_cents,
            "currency": currency,
        }
