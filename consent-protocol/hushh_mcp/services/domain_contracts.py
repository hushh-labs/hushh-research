"""
Canonical PKM domain contracts and Kai finance intent registry.

This module is the source of truth for:
- Allowed top-level domains
- Legacy alias mappings
- Finance domain intent-map metadata (Kai phase)
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class DomainContractEntry:
    domain_key: str
    display_name: str
    icon_name: str
    color_hex: str
    description: str
    status: str


@dataclass(frozen=True)
class DomainSubintentEntry:
    domain_key: str
    parent_domain: str
    display_name: str
    icon_name: str
    color_hex: str
    description: str
    status: str = "active_intent"


CANONICAL_DOMAIN_REGISTRY: tuple[DomainContractEntry, ...] = (
    DomainContractEntry(
        domain_key="financial",
        display_name="Financial",
        icon_name="wallet",
        color_hex="#D4AF37",
        description="Investment portfolio, risk profile, and financial preferences",
        status="active_core",
    ),
    DomainContractEntry(
        domain_key="subscriptions",
        display_name="Subscriptions",
        icon_name="credit-card",
        color_hex="#6366F1",
        description="Streaming services, memberships, and recurring payments",
        status="active_core",
    ),
    DomainContractEntry(
        domain_key="health",
        display_name="Health & Wellness",
        icon_name="heart",
        color_hex="#EF4444",
        description="Fitness data, health metrics, and wellness preferences",
        status="active_core",
    ),
    DomainContractEntry(
        domain_key="travel",
        display_name="Travel",
        icon_name="plane",
        color_hex="#0EA5E9",
        description="Travel preferences, loyalty programs, and trip history",
        status="active_core",
    ),
    DomainContractEntry(
        domain_key="food",
        display_name="Food & Dining",
        icon_name="utensils",
        color_hex="#F97316",
        description="Dietary preferences, favorite cuisines, and restaurant history",
        status="active_core",
    ),
    DomainContractEntry(
        domain_key="professional",
        display_name="Professional",
        icon_name="briefcase",
        color_hex="#8B5CF6",
        description="Career information, skills, and work preferences",
        status="active_core",
    ),
    DomainContractEntry(
        domain_key="ria",
        display_name="RIA",
        icon_name="briefcase",
        color_hex="#2F7D5C",
        description="Advisor-owned picks packages, screening rules, and relationship-share metadata",
        status="active_core",
    ),
    DomainContractEntry(
        domain_key="entertainment",
        display_name="Entertainment",
        icon_name="tv",
        color_hex="#EC4899",
        description="Movies, music, games, and media preferences",
        status="active_extension",
    ),
    DomainContractEntry(
        domain_key="shopping",
        display_name="Shopping",
        icon_name="shopping-bag",
        color_hex="#14B8A6",
        description="Purchase history, brand preferences, and wishlists",
        status="active_extension",
    ),
    DomainContractEntry(
        domain_key="social",
        display_name="Social",
        icon_name="users",
        color_hex="#3B82F6",
        description="Social graph, interactions, and community preferences",
        status="active_extension",
    ),
    DomainContractEntry(
        domain_key="location",
        display_name="Location",
        icon_name="map-pin",
        color_hex="#0F766E",
        description="Location history, home/work anchors, and mobility patterns",
        status="active_extension",
    ),
    DomainContractEntry(
        domain_key="general",
        display_name="General",
        icon_name="folder",
        color_hex="#6B7280",
        description="Catch-all fallback for uncategorized preferences",
        status="active_fallback",
    ),
)

CANONICAL_DOMAIN_KEYS = tuple(entry.domain_key for entry in CANONICAL_DOMAIN_REGISTRY)

# Legacy domain aliases: map retired keys to their canonical PKM domain.
# These aliases allow old callers to resolve to the correct domain transparently.
LEGACY_DOMAIN_ALIASES: dict[str, str] = {
    "kai_profile": "financial.profile",
    "kai_analysis_history": "financial.analysis_history",
    "kai_decisions": "financial.analysis.decisions",
    "kai_preferences": "financial.profile",
    "financial_documents": "financial.documents",
}
RETIRED_DOMAIN_REGISTRY_KEYS: tuple[str, ...] = (
    "financial_documents",
    "kai_profile",
    "kai_analysis_history",
    "kai_decisions",
    "kai_preferences",
)

CURRENT_PKM_MODEL_VERSION = 3
CURRENT_READABLE_SUMMARY_VERSION = 1
FINANCIAL_DOMAIN_SCHEMA_VERSION = 3
FINANCIAL_DOMAIN_CONTRACT_VERSION = 2
FINANCIAL_INTENT_MAP: tuple[str, ...] = (
    "portfolio",
    "profile",
    "documents",
    "analysis_history",
    "runtime",
    "analysis.decisions",
)

FINANCIAL_SUBINTENT_REGISTRY: tuple[DomainSubintentEntry, ...] = (
    DomainSubintentEntry(
        domain_key="financial.portfolio",
        parent_domain="financial",
        display_name="Financial Portfolio",
        icon_name="briefcase",
        color_hex="#D4AF37",
        description="Portfolio holdings, allocation, and balance metadata",
    ),
    DomainSubintentEntry(
        domain_key="financial.profile",
        parent_domain="financial",
        display_name="Financial Profile",
        icon_name="user-circle",
        color_hex="#D4AF37",
        description="Risk profile and user financial preferences",
    ),
    DomainSubintentEntry(
        domain_key="financial.documents",
        parent_domain="financial",
        display_name="Financial Documents",
        icon_name="file-text",
        color_hex="#D4AF37",
        description="Imported statements and document lineage metadata",
    ),
    DomainSubintentEntry(
        domain_key="financial.analysis_history",
        parent_domain="financial",
        display_name="Financial Analysis History",
        icon_name="history",
        color_hex="#D4AF37",
        description="Historical Kai analysis entries per ticker",
    ),
    DomainSubintentEntry(
        domain_key="financial.runtime",
        parent_domain="financial",
        display_name="Financial Runtime",
        icon_name="activity",
        color_hex="#D4AF37",
        description="Runtime caches and session-level portfolio context",
    ),
    DomainSubintentEntry(
        domain_key="financial.analysis.decisions",
        parent_domain="financial",
        display_name="Financial Decisions",
        icon_name="brain",
        color_hex="#D4AF37",
        description="Persisted Kai decision metadata and audit lineage",
    ),
)

CANONICAL_SUBINTENT_KEYS = tuple(entry.domain_key for entry in FINANCIAL_SUBINTENT_REGISTRY)
CANONICAL_REGISTRY_KEYS = tuple(sorted({*CANONICAL_DOMAIN_KEYS, *CANONICAL_SUBINTENT_KEYS}))


def normalize_domain_key(domain: str) -> str:
    return str(domain or "").strip().lower()


def resolve_domain_alias(domain_key: str) -> tuple[str, str | None]:
    normalized = normalize_domain_key(domain_key)
    canonical_target = LEGACY_DOMAIN_ALIASES.get(normalized)
    if not canonical_target:
        return normalized, None
    logger.warning(
        "⚠️ Legacy domain alias resolved: %s → %s (migrate callers to canonical key)",
        normalized,
        canonical_target,
    )
    top_level, _, subpath = canonical_target.partition(".")
    return top_level, (subpath or None)


def canonical_top_level_domain(domain_key: str) -> str:
    top_level, _subpath = resolve_domain_alias(domain_key)
    return top_level


def canonical_subpath_for_domain(domain_key: str) -> str | None:
    _top_level, subpath = resolve_domain_alias(domain_key)
    return subpath


def is_allowed_top_level_domain(domain: str) -> bool:
    return canonical_top_level_domain(domain) in CANONICAL_DOMAIN_KEYS


def current_domain_contract_version(domain: str) -> int:
    canonical = canonical_top_level_domain(domain)
    if canonical == "financial":
        return FINANCIAL_DOMAIN_CONTRACT_VERSION
    return 1


def get_canonical_domain_metadata(domain_key: str) -> DomainContractEntry | None:
    key = normalize_domain_key(domain_key)
    for entry in CANONICAL_DOMAIN_REGISTRY:
        if entry.domain_key == key:
            return entry
    return None


def canonical_domain_metadata_map() -> dict[str, dict[str, str]]:
    return {
        entry.domain_key: {
            "display_name": entry.display_name,
            "icon_name": entry.icon_name,
            "color_hex": entry.color_hex,
            "description": entry.description,
        }
        for entry in CANONICAL_DOMAIN_REGISTRY
    }


def domain_registry_payload() -> list[dict[str, object]]:
    payload = []
    for entry in CANONICAL_DOMAIN_REGISTRY:
        payload.append(
            {
                "domain_key": entry.domain_key,
                "display_name": entry.display_name,
                "icon_name": entry.icon_name,
                "color_hex": entry.color_hex,
                "description": entry.description,
                "status": entry.status,
                "is_legacy_alias": False,
                "canonical_target": None,
                "parent_domain": None,
            }
        )
    for subintent in FINANCIAL_SUBINTENT_REGISTRY:
        payload.append(
            {
                "domain_key": subintent.domain_key,
                "display_name": subintent.display_name,
                "icon_name": subintent.icon_name,
                "color_hex": subintent.color_hex,
                "description": subintent.description,
                "status": subintent.status,
                "is_legacy_alias": False,
                "canonical_target": None,
                "parent_domain": subintent.parent_domain,
            }
        )
    for legacy_key, canonical_target in sorted(LEGACY_DOMAIN_ALIASES.items()):
        payload.append(
            {
                "domain_key": legacy_key,
                "display_name": legacy_key.replace("_", " ").title(),
                "icon_name": "history",
                "color_hex": "#9CA3AF",
                "description": f"Legacy alias for {canonical_target}",
                "status": "legacy",
                "is_legacy_alias": True,
                "canonical_target": canonical_target,
                "parent_domain": None,
            }
        )
    return payload


def build_domain_intent(
    *,
    primary: str,
    secondary: str | None = None,
    source: str,
    updated_at: str,
) -> dict[str, object]:
    payload: dict[str, object] = {
        "primary": normalize_domain_key(primary),
        "source": source,
        "updated_at": updated_at,
    }
    if secondary:
        payload["secondary"] = str(secondary).strip().lower()
    return payload


def build_financial_summary_defaults() -> dict[str, object]:
    return {
        "domain_contract_version": FINANCIAL_DOMAIN_CONTRACT_VERSION,
        "intent_map": list(FINANCIAL_INTENT_MAP),
    }
