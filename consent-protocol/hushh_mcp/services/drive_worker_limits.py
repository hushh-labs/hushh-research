"""Bounded Drive background-processing concurrency, tunable per environment.

Values are read on use, so a deploy can change them without a code change.
Invalid or out-of-range values fail closed to 1, the one-at-a-time behaviour.

The two owner lease caps are enforced in PostgreSQL across every worker
instance; the slot counts bound one worker process. The default live
extraction cap (6) is two worker instances times three local owner slots.

One documents drain runs its extraction and discovery jobs plus up to
DRIVE_SEMANTIC_SLOTS facts and packet jobs at once. Those jobs wait on the
model and hold the process's one database connection only for short claim,
check and commit transactions, so their slots do not come out of extraction.
At most DRIVE_PACKET_SLOTS of them build packets, one per owner with a build
due; the rest run facts jobs, every owner's first before any owner's second,
up to DRIVE_FACTS_OWNER_LEASES per owner.
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


def semantic_slots() -> int:
    """Facts and packet jobs one documents drain runs at once, per process."""
    return _bounded("DRIVE_SEMANTIC_SLOTS", 12, 20)


def packet_slots() -> int:
    """Semantic slots that may build packets; a slot with no build due runs facts."""
    return _bounded("DRIVE_PACKET_SLOTS", 3, 8)
