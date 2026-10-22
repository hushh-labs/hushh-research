"""Closed storage adapters; grant orchestration stays in WalletCardAccessService.

Profile projections are read live from the existing public-field authority, never
snapshotted into a second profile store. Removing a selected field takes effect
immediately, and newly published fields cannot expand an existing grant.
"""

from dataclasses import dataclass

from sqlalchemy import text

from hushh_mcp.runtime_settings import one_wallet_card_enabled
from hushh_mcp.services.one_wallet_card_service import build_public_projection


@dataclass(frozen=True)
class SharingSource:
    kind: str
    grants: str
    requests: str
    audit_key: str


PAYMENT = SharingSource(
    "payment", "wallet_card_access_grants", "wallet_card_share_requests", "grant_id"
)
PROFILE = SharingSource(
    "profile", "wallet_profile_access_grants", "wallet_profile_share_requests", "profile_grant_id"
)


def source_for_card(card_id: str) -> SharingSource:
    # This only chooses storage. Ownership/provenance is checked independently.
    return PROFILE if card_id.startswith("profile_") else PAYMENT


def profile_projection(conn, owner: str, card_id: str, *, lock=False):
    if not one_wallet_card_enabled():
        return None
    row = (
        conn.execute(
            text(
                # Only a fixed optional row-lock suffix; request values are bound.
                """SELECT c.*,COALESCE(i.custom_photo_url,i.photo_url) AS identity_photo_url
 FROM one_wallet_cards c LEFT JOIN actor_identity_cache i ON i.user_id=c.user_id WHERE c.user_id=:owner
 AND 'profile_'||c.pass_serial::text=:card AND c.status='active'
 AND (c.expires_at IS NULL OR c.expires_at>clock_timestamp())"""  # nosec B608
                + (" FOR SHARE OF c" if lock else "")
            ),
            {"owner": owner, "card": card_id},
        )
        .mappings()
        .first()
    )
    return build_public_projection(row) if row else None


def locate_source(conn, grant_id: str) -> SharingSource:
    # Legacy installations keep working until migration 322 is applied.
    installed = conn.execute(
        text("SELECT to_regclass('public.wallet_profile_access_grants') IS NOT NULL")
    ).scalar_one()
    if not installed:
        return PAYMENT
    kinds = (
        conn.execute(
            text("""SELECT 'payment' FROM wallet_card_access_grants WHERE id=CAST(:id AS uuid)
 UNION ALL SELECT 'profile' FROM wallet_profile_access_grants WHERE id=CAST(:id AS uuid)"""),
            {"id": grant_id},
        )
        .scalars()
        .all()
    )
    if len(kinds) > 1:
        raise ValueError("Ambiguous grant")
    return PROFILE if kinds == ["profile"] else PAYMENT
