"""Ordered connection-sharing erasure; the account owner supplies transaction and identity."""

from sqlalchemy import text
from sqlalchemy.sql.elements import TextClause

CONNECTION_SHARING_ERASURE_TABLES = (
    "finance_access_grants",
    "finance_share_requests",
    "wallet_card_access_audit",
    "wallet_profile_access_grants",
    "wallet_card_requests",
    "wallet_card_access_grants",
    "wallet_profile_share_requests",
    "wallet_card_share_requests",
    "wallet_card_registrations",
)


def connection_sharing_erasure_queries() -> dict[str, TextClause]:
    return {
        "finance_access_grants": text(
            "DELETE FROM finance_access_grants WHERE owner_user_id = :user_id OR recipient_user_id = :user_id"
        ),
        "finance_share_requests": text(
            "DELETE FROM finance_share_requests WHERE owner_user_id = :user_id"
        ),
        "wallet_card_access_audit": text(
            "DELETE FROM wallet_card_access_audit WHERE actor_user_id = :user_id"
        ),
        "wallet_profile_access_grants": text(
            "DELETE FROM wallet_profile_access_grants WHERE owner_user_id = :user_id OR recipient_user_id = :user_id"
        ),
        "wallet_card_requests": text(
            "DELETE FROM wallet_card_requests WHERE requester_user_id = :user_id OR target_user_id = :user_id"
        ),
        "wallet_card_access_grants": text(
            "DELETE FROM wallet_card_access_grants WHERE owner_user_id = :user_id OR recipient_user_id = :user_id"
        ),
        "wallet_profile_share_requests": text(
            "DELETE FROM wallet_profile_share_requests WHERE owner_user_id = :user_id"
        ),
        "wallet_card_share_requests": text(
            "DELETE FROM wallet_card_share_requests WHERE owner_user_id = :user_id"
        ),
        "wallet_card_registrations": text(
            "DELETE FROM wallet_card_registrations WHERE owner_user_id = :user_id"
        ),
    }
