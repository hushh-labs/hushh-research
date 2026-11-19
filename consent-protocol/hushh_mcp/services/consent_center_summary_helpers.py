"""Compact summary hydration and read-only identity helpers for ConsentCenterService."""

from __future__ import annotations

import asyncio
from typing import Any


async def list_identifiers_compat(identity: Any, user_id: str, read_only_mode: bool) -> Any:
    """List account identifiers without unnecessary writes when compatible."""
    if read_only_mode:
        try:
            return await identity.list_account_identifiers(user_id, refresh=False)
        except TypeError:
            pass
    return await identity.list_account_identifiers(user_id)


async def fetch_identities_compat(
    identity: Any, identity_ids: list[str], read_only_mode: bool
) -> dict[str, Any]:
    """Fetch counterpart identities via read-only get_many when supported."""
    if read_only_mode and callable(getattr(identity, "get_many", None)):
        return await identity.get_many(identity_ids)
    return await identity.ensure_many(identity_ids)


async def maybe_hydrate_entries(
    service: Any, entries: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Skip expensive per-surface counterpart hydration while computing count-only summaries."""
    if getattr(service, "_skip_summary_hydration", False):
        return entries
    return await service._hydrate_entry_identities(entries)


async def gather_investor_summary_inputs(service: Any, user_id: str) -> tuple[Any, ...]:
    """Load investor summary counts and entries without hydrating display identities."""
    prev_skip_hydration = getattr(service, "_skip_summary_hydration", False)
    service._skip_summary_hydration = True
    try:
        return await asyncio.gather(
            service._location_counts_async(user_id),
            service._extra_buckets_async(user_id),
            service._load_investor_pending_entries(user_id),
            service._load_investor_active_entries(user_id),
            service._load_investor_previous_entries(user_id),
            asyncio.gather(
                service._incoming_connection_request_count(user_id),
                service._drive_counts(user_id),
            ),
        )
    finally:
        service._skip_summary_hydration = prev_skip_hydration
