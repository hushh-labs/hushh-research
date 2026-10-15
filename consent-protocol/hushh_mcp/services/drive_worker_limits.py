"""Bounded Drive background-processing concurrency, tunable per environment.

Values are read on use, so a deploy can change them without a code change.
Invalid or out-of-range values fail closed to 1, the one-at-a-time behaviour.

The two owner lease caps are enforced in PostgreSQL across every worker
instance; the two slot counts bound one worker process. The default live
extraction cap (6) is two worker instances times three local owner slots.
"""

from __future__ import annotations

import os


def _bounded(name: str, default: int, maximum: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return 1
    return value if 1 <= value <= maximum else 1


def live_owner_leases() -> int:
    """Concurrent live extraction leases per owner, across all instances."""
    return _bounded("DRIVE_LIVE_EXTRACTION_OWNER_LEASES", 6, 16)


def facts_owner_leases() -> int:
    """Running current-policy facts jobs per owner, across all instances."""
    return _bounded("DRIVE_FACTS_OWNER_LEASES", 4, 16)


def extraction_owner_slots() -> int:
    """Concurrent extraction jobs for one owner inside one worker process."""
    return _bounded("DRIVE_EXTRACTION_OWNER_SLOTS", 3, 8)


def page_extraction_slots() -> int:
    """Concurrent single-threaded page-extraction children per process (per vCPU)."""
    return _bounded("DRIVE_PAGE_EXTRACTION_SLOTS", 2, 4)
