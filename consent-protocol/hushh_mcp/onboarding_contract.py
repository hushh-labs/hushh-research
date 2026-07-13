"""Shared deterministic contracts for One's onboarding journey.

This module contains policy identifiers only. It does not route actions, grant
authority, or import the product-agent runtime, so durable services and the
bounded onboarding specialist can validate the same authored setup catalog.
"""

from __future__ import annotations

from typing import Any

SETUP_CAPABILITY_ORDER = (
    "gmail",
    "location",
    "email",
    "finance",
    "ria",
    "connected-systems",
)
SETUP_CAPABILITY_IDS = frozenset(SETUP_CAPABILITY_ORDER)


def normalize_setup_capability_id(value: Any) -> str | None:
    """Return a current setup capability ID or ``None`` for stale input."""
    if not isinstance(value, str):
        return None
    candidate = value.strip()
    return candidate if candidate in SETUP_CAPABILITY_IDS else None


def normalize_setup_capability_ids(values: Any) -> list[str]:
    """Return current completed capabilities in canonical product order."""
    if not isinstance(values, list):
        return []
    admitted = {
        capability
        for value in values
        if (capability := normalize_setup_capability_id(value)) is not None
    }
    return [capability for capability in SETUP_CAPABILITY_ORDER if capability in admitted]
