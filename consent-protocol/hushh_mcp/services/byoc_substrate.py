"""Retained storage-incarnation check for account erasure only."""

from typing import Any


def _bucket_creation_identity(value: Any, expected_name: str) -> dict[str, str] | None:
    """Select bounded identity fields, never copy a provider response into a receipt."""
    from datetime import datetime

    if not isinstance(value, dict) or value.get("name") != expected_name:
        return None
    for key in ("generation", "projectNumber"):
        field_value = value.get(key)
        if (
            not isinstance(field_value, str)
            or not 1 <= len(field_value) <= 20
            or not field_value.isascii()
            or not field_value.isdigit()
            or int(field_value) <= 0
        ):
            return None
    created = value.get("timeCreated")
    if not isinstance(created, str) or len(created) > 64:
        return None
    try:
        if datetime.fromisoformat(created.replace("Z", "+00:00")).tzinfo is None:
            return None
    except ValueError:
        return None
    return {key: value[key] for key in ("name", "generation", "projectNumber", "timeCreated")}
