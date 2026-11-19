"""The Location side of a committed connection disconnect."""

import logging
from typing import Any

logger = logging.getLogger("hushh_mcp.services.connections_service")


def end_location_memberships(
    service: Any, *, user_a_id: str, user_b_id: str, actor_user_id: str | None
) -> None:
    connection = getattr(service, "_transaction_connection", None)
    if connection is None:
        # Only reachable behind the lightweight doubles `_transaction`
        # falls back to; a real runtime database always exposes
        # `engine.begin`. Loud, because silently skipping this leaves a
        # live location path open.
        logger.warning(
            "connections.disconnect_circle_cleanup_skipped_no_transaction",
        )
        return
    from hushh_mcp.services.one_location_circle_service import (
        OneLocationCircleService,
    )

    OneLocationCircleService.end_memberships_for_disconnected_pair(
        connection,
        user_a_id=user_a_id,
        user_b_id=user_b_id,
        actor_user_id=actor_user_id,
    )
