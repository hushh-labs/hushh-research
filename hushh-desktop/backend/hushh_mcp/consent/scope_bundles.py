"""
Scope Bundles — pre-packaged scope groups for common consent use cases.

Bundles let ADK agents request "Financial Overview" instead of 3 individual scopes,
simplifying the consent UX for non-technical users.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ScopeBundle:
    bundle_key: str
    label: str
    description: str
    icon_name: str
    color_hex: str
    scopes: tuple[str, ...]


CANONICAL_BUNDLES: dict[str, ScopeBundle] = {
    "financial_overview": ScopeBundle(
        bundle_key="financial_overview",
        label="Financial Overview",
        description="Portfolio holdings, risk profile, and financial documents",
        icon_name="wallet",
        color_hex="#D4AF37",
        scopes=(
            "attr.financial.portfolio.*",
            "attr.financial.profile.*",
            "attr.financial.documents.*",
        ),
    ),
    "full_portfolio_review": ScopeBundle(
        bundle_key="full_portfolio_review",
        label="Full Portfolio Review",
        description="Complete financial data including analysis history and decisions",
        icon_name="briefcase",
        color_hex="#D4AF37",
        scopes=("attr.financial.*",),
    ),
    "risk_assessment": ScopeBundle(
        bundle_key="risk_assessment",
        label="Risk Assessment",
        description="Risk profile and portfolio holdings for risk evaluation",
        icon_name="shield",
        color_hex="#3B82F6",
        scopes=(
            "attr.financial.profile.*",
            "attr.financial.portfolio.*",
        ),
    ),
    "health_wellness": ScopeBundle(
        bundle_key="health_wellness",
        label="Health & Wellness",
        description="Fitness data, health metrics, and wellness preferences",
        icon_name="heart",
        color_hex="#EF4444",
        scopes=("attr.health.*",),
    ),
    "lifestyle_preferences": ScopeBundle(
        bundle_key="lifestyle_preferences",
        label="Lifestyle Preferences",
        description="Food, travel, entertainment, and shopping preferences",
        icon_name="compass",
        color_hex="#F97316",
        scopes=(
            "attr.food.*",
            "attr.travel.*",
            "attr.entertainment.*",
            "attr.shopping.*",
        ),
    ),
    "kyc_workflow": ScopeBundle(
        bundle_key="kyc_workflow",
        label="KYC Workflow",
        description="Identity workflow processing, approval-gated drafts, and structured PKM writeback",
        icon_name="id-card",
        color_hex="#6366F1",
        scopes=(
            "agent.kyc.process",
            "agent.kyc.draft",
            "agent.kyc.writeback",
            "pkm.write",
        ),
    ),
}


def expand_bundle(bundle_key: str) -> list[str]:
    """Expand a bundle key into its constituent scope strings."""
    bundle = CANONICAL_BUNDLES.get(bundle_key)
    if bundle is None:
        raise ValueError(f"Unknown scope bundle: {bundle_key}")
    return list(bundle.scopes)


def get_bundle_display_info(bundle_key: str) -> dict:
    """Get display metadata for a bundle."""
    bundle = CANONICAL_BUNDLES.get(bundle_key)
    if bundle is None:
        raise ValueError(f"Unknown scope bundle: {bundle_key}")
    return {
        "bundle_key": bundle.bundle_key,
        "label": bundle.label,
        "description": bundle.description,
        "icon_name": bundle.icon_name,
        "color_hex": bundle.color_hex,
        "scopes": list(bundle.scopes),
        "scope_count": len(bundle.scopes),
    }


def list_bundles() -> list[dict]:
    """List all available scope bundles with display metadata."""
    return [get_bundle_display_info(key) for key in CANONICAL_BUNDLES]
