"""One verified startup scan for the existing owner-state reducers.

Only startup record families are retained, in original log order. This is an
encrypted derived optimization, not a second authority. Large histories fall back
to the existing loaders rather than truncating authority or consent records.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)
MAX_RECORDS = 10_000
MAX_BYTES = 8 * 1024 * 1024


async def startup_records(log: Any, *, projection: Any = None) -> list[dict[str, Any]] | None:
    from hushh_mcp.services.pod_recovery_projection import OwnerRecoveryProjection

    projection = projection or OwnerRecoveryProjection(
        owner=log._owner_id, max_records=MAX_RECORDS, max_bytes=MAX_BYTES
    )
    records = await projection.recover(log)
    if records is None:
        logger.info("pod.startup_projection_uncached reason=budget")
    return records


async def load_owner_state(log: Any, *, records: Any = None) -> None:
    from hushh_mcp.services.pod_ai_selection import load_owner_configuration
    from hushh_mcp.services.pod_connector_credentials import load_connector_credentials

    await load_owner_configuration(log, records=records)
    await load_connector_credentials(log, records=records)
