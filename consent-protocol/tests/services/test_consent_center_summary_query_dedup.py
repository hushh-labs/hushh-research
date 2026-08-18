import asyncio
from unittest.mock import AsyncMock, patch

from hushh_mcp.services.consent_center_service import ConsentCenterService

_EMPTY_BUCKETS = {"incoming_requests": [], "active_grants": [], "history": []}


def test_investor_consents_summary_fetches_buckets_once_not_per_surface():
    """Regression guard for #5387.

    get_center_summary's default (V1) path used to call _get_surface_count
    once per surface (pending/active/previous) via asyncio.gather, and each
    of those 3 concurrent calls independently re-fetched the same investor
    location/marketplace buckets -- ~3x the real query cost for one summary
    request, the actual cause behind the "app feels slow to load" report,
    not per-item N+1 loops. Both buckets must now be fetched exactly once
    per get_center_summary call, regardless of how many surfaces read them.
    """
    svc = ConsentCenterService.__new__(ConsentCenterService)

    location_buckets = AsyncMock(return_value=dict(_EMPTY_BUCKETS))
    marketplace_buckets = AsyncMock(return_value=dict(_EMPTY_BUCKETS))
    svc._location_buckets_async = location_buckets
    svc._marketplace_buckets_async = marketplace_buckets
    svc._load_investor_pending_entries = AsyncMock(return_value=[])
    svc._load_investor_active_entries = AsyncMock(return_value=[])
    svc._load_investor_previous_entries = AsyncMock(return_value=[])
    svc._incoming_connection_request_count = AsyncMock(return_value=0)

    with patch(
        "hushh_mcp.services.consent_center_service._consent_summary_v2_enabled",
        return_value=False,
    ):
        result = asyncio.run(svc.get_center_summary("user-a", actor="investor", mode="consents"))

    assert result["counts"] == {"pending": 0, "active": 0, "previous": 0}
    location_buckets.assert_called_once_with("user-a")
    marketplace_buckets.assert_called_once_with("user-a")


def test_ria_actor_summary_never_touches_investor_only_buckets():
    """The dedup pre-fetch is gated to investor+consents specifically -- an
    RIA actor must not trigger location/marketplace bucket queries at all,
    pre-fetched or otherwise."""
    svc = ConsentCenterService.__new__(ConsentCenterService)

    location_buckets = AsyncMock(return_value=dict(_EMPTY_BUCKETS))
    marketplace_buckets = AsyncMock(return_value=dict(_EMPTY_BUCKETS))
    svc._location_buckets_async = location_buckets
    svc._marketplace_buckets_async = marketplace_buckets
    svc._load_ria_active_entries = AsyncMock(return_value={"items": []})
    svc._load_ria_outgoing_entries = AsyncMock(return_value=[])
    svc._load_ria_invite_entries = AsyncMock(return_value=[])

    with patch(
        "hushh_mcp.services.consent_center_service._consent_summary_v2_enabled",
        return_value=False,
    ):
        asyncio.run(svc.get_center_summary("ria-a", actor="ria", mode="consents"))

    location_buckets.assert_not_called()
    marketplace_buckets.assert_not_called()
