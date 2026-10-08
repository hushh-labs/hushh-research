"""One verified startup scan for the existing owner-state reducers.

Only startup record families are retained, in original log order. This is an
ephemeral optimization, not a second recovery store. Large histories fall back
to the existing loaders rather than truncating authority or consent records.
"""

from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)
MAX_RECORDS = 10_000
MAX_BYTES = 8 * 1024 * 1024


class _ProjectionBudgetExceeded(Exception):
    pass


async def startup_records(log: Any) -> list[dict[str, Any]] | None:
    from hushh_mcp.services.pod_ai_selection import POD_AI_SELECTION_RECORD_KIND
    from hushh_mcp.services.pod_authority_store import (
        AUTHORITY_TOMBSTONE_KIND,
        AUTHORITY_TRUST_KIND,
    )
    from hushh_mcp.services.pod_config import POD_CONFIG_RECORD_KIND
    from hushh_mcp.services.pod_connector_credentials import CLEARED_KIND, RECORD_KIND

    kinds = {
        POD_CONFIG_RECORD_KIND,
        POD_AI_SELECTION_RECORD_KIND,
        RECORD_KIND,
        CLEARED_KIND,
        AUTHORITY_TRUST_KIND,
        AUTHORITY_TOMBSTONE_KIND,
    }
    records: list[dict[str, Any]] = []
    size = 0

    def visit(record: dict[str, Any]) -> None:
        nonlocal size
        # Authority normalizes whitespace; retain original records for reducers.
        if str(record.get("kind") or "").strip() not in kinds:
            return
        size += len(json.dumps(record, ensure_ascii=False).encode("utf-8"))
        if len(records) >= MAX_RECORDS or size > MAX_BYTES:
            raise _ProjectionBudgetExceeded
        records.append(record)

    try:
        # The visitor is provisional until chain ancestry AND final erasure pass.
        await log.fold_since(None, visit)
    except _ProjectionBudgetExceeded:
        logger.info("pod.startup_projection_uncached reason=budget")
        return None
    records.reverse()
    return records


async def load_owner_state(log: Any, *, records: Any = None) -> None:
    from hushh_mcp.services.pod_ai_selection import load_owner_configuration
    from hushh_mcp.services.pod_connector_credentials import load_connector_credentials

    await load_owner_configuration(log, records=records)
    await load_connector_credentials(log, records=records)
