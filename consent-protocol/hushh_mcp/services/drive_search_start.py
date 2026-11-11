"""Steps a Drive request search takes before its model plan is made."""

from __future__ import annotations

import asyncio
from typing import Any

from hushh_mcp.services.drive_owner_search_store import DriveOwnerSearchStore, _identity


async def owner_search_active(store: Any, user_id: str, request_id: str) -> bool:
    """Whether creating this request's search would now be refused as in progress.

    The owner's searches run one at a time, and create() refuses only after the
    caller has already spent about 20 s on a model plan that is then thrown away.
    This read-only mirror of create() asks first. Before refusing, create()
    removes expired ordinary searches, stops background preparation that holds no
    live lease, and fails other-generation searches, so none of those counts here.
    Another store keeps create() as the only, authoritative check.
    """
    if not isinstance(store, DriveOwnerSearchStore):
        return False
    client = _identity(request_id)

    def operation(connection):
        current = store._access(connection, user_id, read_only=True)
        found = store._row(
            connection,
            """SELECT job_id FROM drive_owner_search_jobs
            WHERE user_id=:user AND client_request_id<>:client
              AND status IN ('queued','running') AND connection_generation=:generation
              AND ((period_packet_id IS NULL AND expires_at>clock_timestamp())
                OR (period_packet_id IS NOT NULL AND lease_id IS NOT NULL
                  AND lease_expires_at>clock_timestamp()))
            LIMIT 1""",
            {"user": user_id, "client": client, "generation": current["connection_generation"]},
        )
        return found is not None

    return bool(await store._transaction(operation))


async def owner_vocabulary_hints(owner_index: Any, owner_id: str) -> list[str] | None:
    """Optional spelling hints from the owner's existing metadata index, or None."""
    try:
        async with asyncio.timeout(2):
            vocabulary = await owner_index.owner_vocabulary(owner_id=owner_id)
        if vocabulary:
            # Existing owner-scoped metadata only; never enumerate a
            # new corpus or turn a spelling hint into identity proof.
            return sorted(
                {word for word in vocabulary if isinstance(word, str) and 1 <= len(word) <= 80}
            )[:120]
    except Exception:
        pass  # Optional discovery hints cannot change the request.
    return None
