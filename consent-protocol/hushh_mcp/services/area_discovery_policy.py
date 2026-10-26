"""Bounds for explicitly opted-in postal-area discovery, never device location."""

from __future__ import annotations

import re
from collections.abc import Sequence
from typing import Any

CONSENT_VERSION = "one-area-discovery-v1"
MIN_GROUP_SIZE = 10
PAGE_SIZE = 20
MAX_PAGES = 5
MAX_CANDIDATES = 500
DAILY_SEARCH_LIMIT = 30


class AreaDiscoveryError(ValueError):
    def __init__(self, code: str, message: str, status_code: int = 422):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


def postal_area(value: str) -> str:
    if not re.fullmatch(r"[0-9]{5}", value):
        raise AreaDiscoveryError("AREA_INVALID", "Enter a five-digit US ZIP code.")
    return value


def result_page(eligible: Sequence[dict[str, Any]], page: int) -> dict[str, Any]:
    """Apply group suppression after authority filtering, before pagination.

    No name/age filters are accepted: they would enable differencing.
    """
    if not 1 <= page <= MAX_PAGES:
        raise AreaDiscoveryError("PAGE_INVALID", "Choose an available results page.")
    if len(eligible) < MIN_GROUP_SIZE:
        return {"items": [], "hasMore": False, "suppressed": True}
    offset = (page - 1) * PAGE_SIZE
    return {
        "items": list(eligible[offset : offset + PAGE_SIZE]),
        "hasMore": page < MAX_PAGES and offset + PAGE_SIZE < len(eligible),
        "suppressed": False,
    }
