"""Admission for staged connector effects, separate from owner/provider grants.

Connection, selected-file setup and owner-authorized Chat reads are available
without a reviewer cohort. OAuth configuration, grants and per-call authority
remain independent checks. Indexing, live Drive and sharing stay staged.
"""

from __future__ import annotations

import os

FEATURES = {
    "connections_panel_v2": "CONNECTIONS_PANEL_V2",
    "google_drive_connection": "GOOGLE_DRIVE_CONNECTION",
    "google_drive_live": "GOOGLE_DRIVE_LIVE",
    "google_drive_picker": "GOOGLE_DRIVE_PICKER",
    "drive_document_indexing": "DRIVE_DOCUMENT_INDEXING",
    "drive_document_sharing": "DRIVE_DOCUMENT_SHARING",
    "gmail_chat_reads": "GMAIL_CHAT_READS",
    "google_drive_chat_reads": "GOOGLE_DRIVE_CHAT_READS",
}

# These are ordinary owner-initiated capabilities, not UAT rollout effects.
# Keeping their response keys preserves existing clients while removing the
# environment/cohort dependency from connection and read-only Chat use.
OWNER_AVAILABLE = frozenset(
    {
        "google_drive_connection",
        "google_drive_picker",
        "google_drive_chat_reads",
        "gmail_chat_reads",
    }
)


def connector_feature_enabled(feature: str, user_id: str) -> bool:
    if feature in OWNER_AVAILABLE:
        return bool(user_id and user_id.strip() == user_id)
    environment = os.getenv("ENVIRONMENT", "").strip().lower()
    if environment not in {"uat", "test", "local", "development"}:
        return False
    env_name = FEATURES.get(feature)
    if not env_name or os.getenv(env_name, "").strip().lower() != "true":
        return False
    raw = os.getenv("CONNECTOR_INTERNAL_OWNER_COHORT", "")
    all_uat_users = os.getenv("CONNECTOR_UAT_ALL_USERS", "").strip().lower() == "true"
    if all_uat_users:
        # Keep the broad UAT mode explicit and mutually exclusive with the
        # exact-UID cohort. A malformed hosted config must fail closed.
        return environment == "uat" and not raw and bool(user_id and user_id.strip())
    members = [value.strip() for value in raw.split(",")]
    if not raw or any(
        not value
        or value.lower() in {"*", "all"}
        or len(value) > 128
        or any(char.isspace() for char in value)
        for value in members
    ):
        return False
    return bool(user_id) and user_id in members


def connector_features(user_id: str) -> dict[str, bool]:
    return {feature: connector_feature_enabled(feature, user_id) for feature in FEATURES}
