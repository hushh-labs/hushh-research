"""Fail-safe private-agent lifecycle projection into the existing One Feed.

Registry publication remains authoritative. A verified update uses its approved
operation as the existing Feed source key; database uniqueness handles retries.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from hushh_mcp.runtime_settings import personal_agent_enabled

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# One Feed projection of the provisioning lifecycle
# ---------------------------------------------------------------------------
# One row per state transition, so the user watches their private agent being
# created instead of nothing happening. snake_case event_type, matching the
# existing vocabulary (``consent_requested``, ``location_share_created``).
FEED_EVENT_RESERVED = "personal_agent_reserved"
FEED_EVENT_PROVISIONING = "personal_agent_provisioning"
# The host EXISTS and is booting; we are waiting on the pod to come up and hand us
# its public key. Distinct from ``provisioning`` (which covers "we are asking a
# backend to build one") because the honest answer to "what is happening" differs:
# one is our work, the other is a machine starting. The onboarding surface shows
# them differently, and only this one has a host worth billing.
FEED_EVENT_CONNECTING = "personal_agent_connecting"
FEED_EVENT_READY = "personal_agent_ready"
FEED_EVENT_FAILED = "personal_agent_failed"
# The fleet is at PERSONAL_AGENT_MAX_PODS: nothing was provisioned, nothing
# failed, and the reservation still stands. A distinct line, because "we are at
# capacity, your agent is queued" is a different truth from "setup failed".
FEED_EVENT_CAPPED = "personal_agent_provisioning_capped"
# The host was torn down after HUSSH_POD_IDLE_REAP_HOURS of inactivity. The
# registry row, HusshID and A2A address survive; the agent re-provisions on the
# owner's next activity (see personal_agent_reconcile_worker).
FEED_EVENT_REAPED = "personal_agent_reaped"
#: An image update reached this person's pod. Emitted only when the revision
#: actually moved (`upgrade_noop` writes nothing): the feed is the software-update
#: notice the founder asked for, and a notice about nothing is noise.
FEED_EVENT_UPDATED = "personal_agent_updated"


_FEED_EVENT_TYPES = frozenset(
    {
        FEED_EVENT_RESERVED,
        FEED_EVENT_PROVISIONING,
        FEED_EVENT_CONNECTING,
        FEED_EVENT_READY,
        FEED_EVENT_FAILED,
        FEED_EVENT_CAPPED,
        FEED_EVENT_REAPED,
        FEED_EVENT_UPDATED,
    }
)

# ``feed_events.source_domain`` is CHECK-constrained (migration 117) and
# allowlisted in FeedService to six domains. The personal agent's lifecycle
# terminates in the standing, Nav-governed ``pkm.read`` consent grant, so it
# projects under ``consent`` -- no new domain, no migration. The human-facing
# label lives in the webapp renderer, where all feed wording lives.
_FEED_SOURCE_DOMAIN = "consent"
_FEED_ACTOR_LABEL = "Private agent"

# Closed vocabulary of user-safe failure reasons. NEVER put an exception message,
# stack detail, phone number, HusshID, or key material in a feed row: feed_events
# is explicitly a bounded, non-sensitive presentation table and the row is
# rendered straight back to the user.
FEED_REASON_INVALID_DETAILS = "invalid_details"
FEED_REASON_TEMPORARY = "temporary_issue"
# The platform's own verdict that the pod's revision failed to start -- distinct
# from a slow boot, which stays "temporary". Provider-neutral by construction.
FEED_REASON_POD_BOOT_FAILED = "pod_boot_failed"
# A host that became Ready but whose pod never published its key within the
# handshake deadline; written by the reconcile sweep's overdue transition.
FEED_REASON_POD_UNRESPONSIVE = "pod_unresponsive"


async def record_update_completion_safe(*, user_id: str, operation_id: str | None) -> None:
    """Project only after the owning update path publishes verified completion."""
    await record_provisioning_feed_event_safe(
        user_id=user_id, event_type=FEED_EVENT_UPDATED, source_row_id=operation_id
    )


async def record_provisioning_feed_event_safe(
    *,
    user_id: str,
    event_type: str,
    reason: str | None = None,
    source_row_id: str | None = None,
) -> None:
    """Flag-gated, FAIL-SAFE mirror of one provisioning transition into the One feed.

    Same contract as ``append_consent_receipt_safe`` for the consent ledger: does
    nothing unless ``PERSONAL_AGENT_ENABLED`` is on, and a projection failure is
    logged and swallowed so it can NEVER break or block provisioning -- which runs
    fire-and-forget off the phone-verify path, where a raised feed error would be
    an invisible, unretried break. ``feed_events`` is presentation only; the
    registry row remains the authority for provisioning state, so a dropped row
    costs a missing feed line and nothing else.

    ``FeedService.record_event`` is a blocking DB write, so it is offloaded to a
    worker thread (mirroring ``api/routes/kai/run_manager.py``) rather than
    stalling the event loop.
    """
    if not user_id or event_type not in _FEED_EVENT_TYPES or not personal_agent_enabled():
        return
    try:
        # Deferred import: no feed/DB dependency at module import time, and nothing
        # is loaded at all on the flag-off path.
        from hushh_mcp.services.feed_service import FeedService

        metadata: dict[str, Any] = {}
        if reason:
            metadata["reason"] = reason
        await asyncio.to_thread(
            FeedService().record_event,
            user_id=user_id,
            source_domain=_FEED_SOURCE_DOMAIN,
            event_type=event_type,
            actor_label=_FEED_ACTOR_LABEL,
            metadata=metadata,
            **({"source_row_id": source_row_id} if source_row_id else {}),
        )
    except Exception:  # noqa: BLE001 -- fail-safe: the feed projection must never break provisioning
        logger.exception("personal_agent.feed_projection_failed event_type=%s", event_type)
