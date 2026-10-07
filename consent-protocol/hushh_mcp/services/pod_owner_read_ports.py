"""Owner-feed read ports for an agent in the person's own cloud.

The location, consent-center and marketplace ports in ``pod_specialist_runtime`` read
a hub door with a per-turn scope token. On an owner-cloud agent that can verify the
signed owner feed, :func:`owner_read_ports` hands the specialists these subclasses
instead: they read ONLY the feed and are built with no scope token at all, so a door
read is impossible rather than merely avoided. Each still refuses a foreign owner
before any client exists, and every failure is the typed
``PodSpecialistInformationUnavailable``, never an empty state.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Optional

from hushh_mcp.services.pod_specialist_runtime import (
    PodConsentCenterReadPort,
    PodLocationReadPort,
    PodMarketplaceReadPort,
    PodSpecialistInformationUnavailable,
    current_dependency_trace,
)


def _feed_read(feed: Any, door: str, owner: str, **params: Any) -> dict[str, Any]:
    try:
        state = feed.read(door, owner, params=params or None)
    except Exception as exc:  # noqa: BLE001 - one typed state for the specialist
        trace = current_dependency_trace()
        if trace is not None:
            trace.record_unavailable(door)
        raise PodSpecialistInformationUnavailable(door) from exc
    if not isinstance(state, dict):
        raise PodSpecialistInformationUnavailable(door)
    return state


class OwnerFeedLocationPort(PodLocationReadPort):
    def __init__(self, owner_user_id: str, feed: Any) -> None:
        super().__init__(owner_user_id, "")
        self._feed = feed

    def list_state(self, *, user_id: str) -> dict:
        if user_id != self._owner:
            raise PermissionError("Location owner mismatch")
        return _feed_read(self._feed, "location", self._owner)


class OwnerFeedConsentCenterPort(PodConsentCenterReadPort):
    def __init__(self, owner_user_id: str, feed: Any, *, owner_read_authority: Any = None) -> None:
        super().__init__(owner_user_id, "")
        self._feed = feed
        self._owner_read_authority = owner_read_authority

    async def authorize_owner_tool(self, user_id: str, token: str) -> None:
        """Trusted runtime seam for Nav metadata tools, never a delegated grant."""
        if user_id != self._owner or self._owner_read_authority is None:
            raise PermissionError("Consent review requires the owner's local session")
        await self._owner_read_authority(user_id, token)

    async def list_center(self, user_id: str, *, actor: str, surface: str, top: int) -> dict:
        if user_id != self._owner or actor != "investor" or surface not in {"active", "previous"}:
            raise PermissionError("Consent-center read scope denied")
        state = await asyncio.to_thread(_feed_read, self._feed, "nav", self._owner)
        page = state.get(surface)
        if not isinstance(page, dict) or not isinstance(page.get("items"), list):
            raise PodSpecialistInformationUnavailable("nav")
        return {**page, "items": page["items"][: max(1, min(top, 10))]}


class OwnerFeedMarketplacePort(PodMarketplaceReadPort):
    """Owner publication metadata only; no marketplace mutation authority."""

    def __init__(self, owner_user_id: str, feed: Any) -> None:
        super().__init__(owner_user_id, "")
        self._feed = feed

    async def _read(self, user_id: str, **options: Any) -> dict:
        if user_id != self._owner:
            raise PermissionError("Marketplace owner mismatch")
        from hushh_mcp.services.pod_marketplace_read import MarketplaceReadOptions

        params = MarketplaceReadOptions.model_validate(options).model_dump(exclude_none=True)
        return await asyncio.to_thread(_feed_read, self._feed, "marketplace", self._owner, **params)


@dataclass(frozen=True)
class OwnerReadPorts:
    feed: Optional[Any]
    location: PodLocationReadPort
    consent_center: PodConsentCenterReadPort
    marketplace: PodMarketplaceReadPort


def owner_read_ports(
    user_id: str,
    grants: dict[str, str],
    *,
    feed: Any = None,
    owner_read_authority: Any = None,
) -> OwnerReadPorts:
    """Local placement selects custody; absent feed keys never widen it."""
    from hushh_mcp.services.pod_owner_cloud import owner_cloud_agent

    local = owner_cloud_agent()
    if feed is None:
        from hushh_mcp.services.pod_owner_feed_client import owner_feed_client  # noqa: PLC0415

        feed = owner_feed_client()
    if local or feed is not None:
        return OwnerReadPorts(
            feed,
            OwnerFeedLocationPort(user_id, feed),
            OwnerFeedConsentCenterPort(user_id, feed, owner_read_authority=owner_read_authority),
            OwnerFeedMarketplacePort(user_id, feed),
        )
    return OwnerReadPorts(
        None,
        PodLocationReadPort(user_id, grants.get("location", "")),
        PodConsentCenterReadPort(user_id, grants.get("nav", "")),
        PodMarketplaceReadPort(user_id, grants.get("marketplace", "")),
    )


__all__ = [
    "OwnerFeedConsentCenterPort",
    "OwnerFeedLocationPort",
    "OwnerFeedMarketplacePort",
    "OwnerReadPorts",
    "owner_read_ports",
]
