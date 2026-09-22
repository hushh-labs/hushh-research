"""Shared API/tool admission using the existing hosted runtime configuration.

This rollout is internal-only and fail-closed. Status, recovery and disconnect
do not use these predicates: turning a feature off cannot strand a connection.
"""

from __future__ import annotations

import os

FEATURES = {
    "connections_panel_v2": "CONNECTIONS_PANEL_V2",
    "google_drive_connection": "GOOGLE_DRIVE_CONNECTION",
    "gmail_chat_reads": "GMAIL_CHAT_READS",
    "google_drive_chat_reads": "GOOGLE_DRIVE_CHAT_READS",
}


def connector_feature_enabled(feature: str, user_id: str) -> bool:
    environment = os.getenv("ENVIRONMENT", "").strip().lower()
    if environment not in {"uat", "test", "local", "development"}:
        return False
    env_name = FEATURES.get(feature)
    if not env_name or os.getenv(env_name, "").strip().lower() != "true":
        return False
    raw = os.getenv("CONNECTOR_INTERNAL_OWNER_COHORT", "")
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
