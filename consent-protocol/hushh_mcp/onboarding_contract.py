"""Shared deterministic contracts for One's onboarding journey.

This module contains policy identifiers only. It does not route actions, grant
authority, or import the product-agent runtime, so durable services and the
bounded onboarding specialist can validate the same authored setup catalog.
"""

from __future__ import annotations

from typing import Any

SETUP_CAPABILITY_ORDER = (
    "gmail",
    "calendar",
    "location",
    "email",
    "finance",
    "ria",
    "connected-systems",
)
SETUP_CAPABILITY_IDS = frozenset(SETUP_CAPABILITY_ORDER)

# Root setup facts that use the same durable marker set without becoming
# product-agent capabilities or generated actions.
#
# `cloud` precedes `connections` because that is the product order: a person names and
# authorizes their own cloud, and only then chooses how the agent reaches a model -- by
# which point their own project's native ADC usually answers it, and a key is the
# exception rather than the front door.
#
# This tuple is the ADMISSION list, not merely a display order.
# `normalize_setup_capability_ids` filters against `SETUP_STATE_IDS` on both the read and
# the write path, so an id absent from here is dropped silently, with no error anywhere.
# That is why this constant ships before any surface that writes a `cloud` marker.
SETUP_PREREQUISITE_ORDER = ("cloud", "connections")
SETUP_STATE_ORDER = SETUP_PREREQUISITE_ORDER + SETUP_CAPABILITY_ORDER
SETUP_STATE_IDS = frozenset(SETUP_STATE_ORDER)


def normalize_setup_capability_id(value: Any) -> str | None:
    """Return a current setup capability ID or ``None`` for stale input."""
    if not isinstance(value, str):
        return None
    candidate = value.strip()
    return candidate if candidate in SETUP_CAPABILITY_IDS else None


def normalize_setup_capability_ids(values: Any) -> list[str]:
    """Return current setup markers in canonical root-setup order."""
    if not isinstance(values, list):
        return []
    admitted = {
        setup_id
        for value in values
        if isinstance(value, str) and (setup_id := value.strip()) in SETUP_STATE_IDS
    }
    return [setup_id for setup_id in SETUP_STATE_ORDER if setup_id in admitted]
