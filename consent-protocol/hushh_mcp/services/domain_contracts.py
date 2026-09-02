"""
Canonical PKM domain contracts and Kai finance intent registry.

This module is the source of truth for:
- Allowed top-level domains
- Legacy alias mappings
- Finance domain intent-map metadata (Kai phase)
"""

from __future__ import annotations

import logging
import re
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


@dataclass(frozen=True)
class DomainSharingPolicy:
    """Server-owned external-sharing boundary for a canonical PKM domain."""

    domain_key: str
    allow_domain_wildcard: bool = True
    allowed_manifest_path_prefixes: tuple[str, ...] | None = None
    denied_manifest_path_prefixes: tuple[str, ...] = ()
    denied_manifest_path_parts: frozenset[str] = frozenset()
    requestable_scopes: frozenset[str] | None = None
    allow_public_projection: bool = True


CANONICAL_DOMAIN_REGISTRY: tuple[DomainContractEntry, ...] = (
    DomainContractEntry(
        domain_key="identity",
        display_name="Identity",
        icon_name="user-round",
        color_hex="#0F766E",
        description="Owner-authored identity details and personal profile facts",
        status="active_core",
    ),
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
        domain_key="runtime_secrets",
        display_name="Runtime Secrets",
        icon_name="key-round",
        color_hex="#475569",
        description="Encrypted user-owned runtime credentials for BYOK model execution",
        status="active_core",
    ),
    DomainContractEntry(
        domain_key="source_library",
        display_name="Source Library",
        icon_name="library",
        color_hex="#2563EB",
        description="Owner-reviewed knowledge derived from locally bound sources",
        status="active_core",
    ),
    DomainContractEntry(
        domain_key="wallet",
        display_name="Wallet",
        icon_name="credit-card",
        color_hex="#B45309",
        description="Owner-stored credit and debit cards, encrypted client-side under the vault key",
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

CURRENT_PKM_MODEL_VERSION = 6
CURRENT_PKM_CONTRACT_VERSION = "6.0.0"
CURRENT_READABLE_PROJECTION_VERSION = "6.0.0"
CURRENT_READABLE_SUMMARY_VERSION = 6
GENERIC_DOMAIN_CONTRACT_VERSION = 4
DYNAMIC_DOMAIN_CONTRACT_VERSION = 4
FINANCIAL_DOMAIN_SCHEMA_VERSION = 3
FINANCIAL_DOMAIN_CONTRACT_VERSION = GENERIC_DOMAIN_CONTRACT_VERSION
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

SOURCE_LIBRARY_SUBINTENT_REGISTRY: tuple[DomainSubintentEntry, ...] = (
    DomainSubintentEntry(
        domain_key="source_library.knowledge",
        parent_domain="source_library",
        display_name="Source Library Knowledge",
        icon_name="library",
        color_hex="#2563EB",
        description="Owner-reviewed facts and summaries derived from bound sources",
    ),
)

WALLET_SUBINTENT_REGISTRY: tuple[DomainSubintentEntry, ...] = (
    DomainSubintentEntry(
        domain_key="wallet.summary",
        parent_domain="wallet",
        display_name="Card Summaries",
        icon_name="credit-card",
        color_hex="#B45309",
        description="Card nicknames, brand, last four digits, expiry, and issuing region",
    ),
    DomainSubintentEntry(
        domain_key="wallet.secrets",
        parent_domain="wallet",
        display_name="Card Secrets",
        icon_name="key-round",
        color_hex="#B45309",
        description="Full card number, CVV, PIN, and cardholder name, revealed only on explicit owner consent",
    ),
)

CANONICAL_SUBINTENT_REGISTRY = (
    *FINANCIAL_SUBINTENT_REGISTRY,
    *SOURCE_LIBRARY_SUBINTENT_REGISTRY,
    *WALLET_SUBINTENT_REGISTRY,
)
CANONICAL_SUBINTENT_KEYS = tuple(entry.domain_key for entry in CANONICAL_SUBINTENT_REGISTRY)
CANONICAL_REGISTRY_KEYS = tuple(sorted({*CANONICAL_DOMAIN_KEYS, *CANONICAL_SUBINTENT_KEYS}))

# These domains are protocol-reserved and writable only through first-party
# owner-authorized PKM paths.  They must never be invented or repurposed by the
# semantic structure agent as arbitrary user domains.
OWNER_MANAGED_RESERVED_DOMAIN_SLUGS = frozenset({"source_library", "wallet"})

DOMAIN_SHARING_POLICY_REGISTRY: dict[str, DomainSharingPolicy] = {
    "identity": DomainSharingPolicy(
        domain_key="identity",
        allow_public_projection=False,
    ),
    "financial": DomainSharingPolicy(
        domain_key="financial",
        allow_domain_wildcard=False,
        denied_manifest_path_prefixes=("analysis_history",),
        denied_manifest_path_parts=frozenset(
            {
                "agent_votes",
                "debate_transcript",
                "raw_card",
                "stream_diagnostics",
                "transcript",
            }
        ),
    ),
    "source_library": DomainSharingPolicy(
        domain_key="source_library",
        allow_domain_wildcard=False,
        # Source Library is an owner-only capability boundary.  Its provider
        # files and private PKM organization are addressed through local,
        # object-level references rather than exported ``attr.*`` authority.
        allowed_manifest_path_prefixes=(),
        denied_manifest_path_parts=frozenset(
            {
                "artifact",
                "artifacts",
                "artifact_id",
                "audit",
                "audit_receipt",
                "catalog",
                "content_hash",
                "file_locator",
                "file_path",
                "operational_policy",
                "policy",
                "provider_id",
                "provider_identifier",
                "raw_content",
                "raw_extract",
                "source_title",
            }
        ),
        requestable_scopes=frozenset(),
        allow_public_projection=False,
    ),
    "wallet": DomainSharingPolicy(
        domain_key="wallet",
        allow_domain_wildcard=False,
        # Reserved owner-managed domain, but deliberately shareable: external
        # systems may request card summaries or full card secrets as exactly
        # these branch wildcards, and every grant is an explicit owner approval
        # delivered through the consent-gated encrypted export path.  The
        # domain-level wildcard and exact-path scopes stay non-requestable.
        allowed_manifest_path_prefixes=("summary", "secrets"),
        requestable_scopes=frozenset(
            {
                "attr.wallet.summary.*",
                "attr.wallet.secrets.*",
            }
        ),
        allow_public_projection=False,
    ),
}


def normalize_domain_key(domain: str) -> str:
    return str(domain or "").strip().lower()


DOMAIN_SLUG_PATTERN = re.compile(r"^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$")

# These names are protocol/runtime namespaces, not user information domains.
# Existing first-party storage domains are handled separately by their owning
# services and must never be proposed by the semantic structure agent.
RESERVED_DYNAMIC_DOMAIN_SLUGS = frozenset(
    {
        "agent",
        "agents",
        "attr",
        "cap",
        "consent",
        "internal",
        "mcp",
        "pkm",
        # `__quarantine_v1` normalizes to this slug. It is encrypted internal
        # preservation storage, never a user-authored or shareable domain.
        "quarantine_v1",
        "scope",
        "scopes",
        "system",
        "vault",
    }
)
INTERNAL_ONLY_DOMAIN_SLUGS = frozenset(
    {
        "kyc_connector",
        "kyc_workflow",
        "runtime_secrets",
    }
)


def normalize_dynamic_domain_slug(domain: str) -> str:
    """Return the deterministic user-domain slug for a proposed label.

    This is intentionally narrower than arbitrary JSON/path normalization:
    top-level domains are ASCII identifiers and cannot contain dots because
    dots delimit scope paths in ``attr.<domain>.<scope>.*``.
    """

    normalized = normalize_domain_key(domain)
    normalized = re.sub(r"[\s-]+", "_", normalized)
    normalized = re.sub(r"[^a-z0-9_]", "_", normalized)
    normalized = re.sub(r"_+", "_", normalized).strip("_")
    return normalized


def validate_dynamic_top_level_domain(
    domain: str,
    *,
    allow_internal: bool = False,
) -> str:
    """Validate a canonical or arbitrary custom top-level PKM domain.

    Returns the normalized slug or raises ``ValueError`` with a stable reason.
    Legacy aliases are resolved first so old stored data can still be upgraded,
    while new user-authored domains cannot occupy a reserved namespace.
    """

    alias_domain, alias_subpath = resolve_domain_alias(domain)
    candidate = alias_domain if alias_subpath else normalize_dynamic_domain_slug(alias_domain)
    if not candidate or len(candidate) > 64 or not DOMAIN_SLUG_PATTERN.fullmatch(candidate):
        raise ValueError("invalid_domain_slug")
    if candidate in RESERVED_DYNAMIC_DOMAIN_SLUGS:
        raise ValueError("reserved_domain_slug")
    if candidate in OWNER_MANAGED_RESERVED_DOMAIN_SLUGS and not allow_internal:
        raise ValueError("owner_managed_domain_slug")
    if not allow_internal and candidate in INTERNAL_ONLY_DOMAIN_SLUGS:
        raise ValueError("internal_domain_slug")
    return candidate


def is_valid_dynamic_top_level_domain(domain: str, *, allow_internal: bool = False) -> bool:
    try:
        validate_dynamic_top_level_domain(domain, allow_internal=allow_internal)
    except ValueError:
        return False
    return True


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
    _canonical = canonical_top_level_domain(domain)
    return GENERIC_DOMAIN_CONTRACT_VERSION


def get_canonical_domain_metadata(domain_key: str) -> DomainContractEntry | None:
    key = normalize_domain_key(domain_key)
    for entry in CANONICAL_DOMAIN_REGISTRY:
        if entry.domain_key == key:
            return entry
    return None


def get_canonical_subintent_metadata(domain_key: str) -> DomainSubintentEntry | None:
    """Return authored metadata for a canonical subintent branch, if registered.

    ``domain_key`` is the fully-qualified branch key (e.g. ``financial.profile``).
    Only financial subintents are registered today; every other branch returns
    None so callers compose a display label from the parent domain + branch name.
    Kept parallel to :func:`get_canonical_domain_metadata` so scope-display code
    can prefer a branch's authored name/description/icon over a generic one.
    """

    key = normalize_domain_key(domain_key)
    for entry in CANONICAL_SUBINTENT_REGISTRY:
        if entry.domain_key == key:
            return entry
    return None


def get_domain_sharing_policy(domain_key: str) -> DomainSharingPolicy:
    """Return the explicit policy or the generic dynamic-domain default."""

    key = canonical_top_level_domain(domain_key)
    return DOMAIN_SHARING_POLICY_REGISTRY.get(key, DomainSharingPolicy(domain_key=key))


def is_owner_managed_reserved_domain(domain_key: str) -> bool:
    return canonical_top_level_domain(domain_key) in OWNER_MANAGED_RESERVED_DOMAIN_SLUGS


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
    for subintent in CANONICAL_SUBINTENT_REGISTRY:
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
