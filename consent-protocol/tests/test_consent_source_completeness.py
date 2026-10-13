"""Strict memory reads preserve the existing resilient UI contributor contract."""

from unittest.mock import AsyncMock, Mock

import pytest

from hushh_mcp.services.consent_center_service import ConsentCenterService
from hushh_mcp.services.marketplace_center_contributor import MarketplaceCenterContributor
from hushh_mcp.services.one_location_center_contributor import OneLocationCenterContributor


@pytest.mark.parametrize("strict", [False, True])
async def test_marketplace_failure_is_unavailable_only_for_strict_source_reads(strict):
    requests = Mock(
        list_requests=AsyncMock(side_effect=RuntimeError("offline")),
        list_buyer_requests=AsyncMock(return_value=[]),
    )
    contributor = MarketplaceCenterContributor(requests, require_complete=strict)
    if strict:
        with pytest.raises(RuntimeError):
            await contributor.collect("owner")
    else:
        assert not any((await contributor.collect("owner")).values())


@pytest.mark.parametrize("strict", [False, True])
def test_location_failure_is_unavailable_only_for_strict_source_reads(strict):
    contributor = OneLocationCenterContributor(
        Mock(list_state=Mock(side_effect=RuntimeError("offline"))), require_complete=strict
    )
    if strict:
        with pytest.raises(RuntimeError):
            contributor.collect("owner")
    else:
        assert not any(contributor.collect("owner").values())


@pytest.mark.parametrize("strict", [False, True])
@pytest.mark.parametrize("source", ["marketplace", "answer"])
async def test_answer_contributor_failure_is_unavailable_only_for_strict_source_reads(
    strict, source, caplog
):
    service = ConsentCenterService.__new__(ConsentCenterService)
    service._require_complete = strict
    service._marketplace_center = service._answer_center = None
    failure = RuntimeError("synthetic-protected-request-context")
    setattr(service, f"_{source}_center", Mock(collect=AsyncMock(side_effect=failure)))
    if strict:
        with pytest.raises(RuntimeError):
            await service._extra_buckets_async("synthetic-owner-identifier")
        assert not caplog.records
    else:
        assert not any((await service._extra_buckets_async("synthetic-owner-identifier")).values())
        assert "RuntimeError" in caplog.text
        assert source in caplog.text
        assert str(failure) not in caplog.text
        assert "synthetic-owner-identifier" not in caplog.text


async def test_strict_previous_inventory_requests_uncapped_owner_history():
    service = ConsentCenterService.__new__(ConsentCenterService)
    service._require_complete = True
    service._owned_user_identifiers = AsyncMock(return_value=["owner"])
    service._consent_db = Mock(get_audit_log=AsyncMock(return_value={"items": [], "total": 0}))
    service._hydrate_entry_identities = AsyncMock(side_effect=lambda values: values)
    assert await service._load_investor_previous_entries("owner") == []
    assert service._consent_db.get_audit_log.call_args.kwargs["limit"] is None


@pytest.mark.parametrize("status", ["pending", "approved", "denied", "expired", "cancelled"])
@pytest.mark.parametrize("actor", ["owner", "requester"])
def test_strict_location_inventory_retains_lifecycle_request(status, actor):
    row = {
        "id": "stable-request",
        "ownerUserId": "owner",
        "requesterUserId": "requester",
        "status": status,
        "requestedAt": "2026-01-01T00:00:00Z",
        "expiresAt": "2026-01-02T00:00:00Z",
    }
    service = Mock(list_state=Mock(return_value={"requests": [row]}))
    buckets = OneLocationCenterContributor(service, require_complete=True).collect(actor)
    entries = [item for values in buckets.values() for item in values]
    assert len(entries) == 1
    assert entries[0]["id"] == "one_location_request:stable-request"
    assert entries[0]["status"] == status
    assert entries[0]["expires_at"] == row["expiresAt"]


@pytest.mark.parametrize("status", ["active", "claimed", "revoked", "expired"])
def test_strict_location_inventory_retains_circle_invites(status):
    service = Mock(
        list_state=Mock(return_value={"circleInvites": [{"id": "invite", "status": status}]})
    )
    buckets = OneLocationCenterContributor(service, require_complete=True).collect("owner")
    assert buckets["history"][0]["id"] == "one_location_circle:invite"
    assert buckets["history"][0]["status"] == status


async def test_strict_sent_inventory_includes_location_without_changing_default_ui():
    service = ConsentCenterService.__new__(ConsentCenterService)
    service._read_only = True
    service._require_complete = True
    service._extra_buckets_async = AsyncMock(return_value={"outgoing_requests": []})
    row = {"id": "one_location_request:sent", "status": "approved"}
    service._location_buckets_async = AsyncMock(return_value={"outgoing_requests": [row]})
    service._paginate_with_drive = AsyncMock(return_value={"items": [row]})
    result = await service.list_center(
        "owner", actor="investor", surface="pending", request_view="sent"
    )
    assert result["source_read_verified"] is True
    assert service._paginate_with_drive.call_args.args[0] == [row]
    service._require_complete = False
    result = await service.list_center(
        "owner", actor="investor", surface="pending", request_view="sent"
    )
    assert "source_read_verified" not in result
    assert service._paginate_with_drive.call_args.args[0] == []


@pytest.mark.parametrize("read_only,require_complete", [(True, False), (False, True)])
async def test_read_inventory_hydration_does_not_bootstrap_identity(read_only, require_complete):
    service = ConsentCenterService.__new__(ConsentCenterService)
    service._read_only = read_only
    service._require_complete = require_complete
    service._identity = Mock(
        get_many=AsyncMock(return_value={}),
        ensure_many=AsyncMock(side_effect=AssertionError("inventory must not write identities")),
    )
    assert await service._hydrate_entry_identities([]) == []
    service._identity.get_many.assert_awaited_once_with([])
    service._identity.ensure_many.assert_not_awaited()


@pytest.mark.parametrize(
    "status,active", [("active", True), ("revoked", False), ("expired", False)]
)
def test_strict_source_projection_has_truthful_activity_and_no_authority_payload(status, active):
    service = ConsentCenterService.__new__(ConsentCenterService)
    service._require_complete = True
    grant = service._normalize_active(
        {
            "source_record_id": 42,
            "token_id": "synthetic-bearer-do-not-persist",
            "scope": "attr.food.*",
            "metadata": {"reason": "private"},
        }
    )
    grant["status"] = status
    row = service._source_entries([grant])[0]
    assert row["id"] == "consent_grant:42"
    assert row["active"] is active
    assert "synthetic-bearer" not in str(row)
    assert "metadata" not in row and "reason" not in row


def test_strict_member_inventory_is_all_participants_read_only_and_unfiltered():
    from types import SimpleNamespace

    from hushh_mcp.services.one_location_circle_service import OneLocationCircleService

    service = OneLocationCircleService.__new__(OneLocationCircleService)
    service._db = Mock(execute_raw=Mock(return_value=SimpleNamespace(data=[])))
    assert service.list_member_invites(user_id="owner", require_complete=True) == []
    assert service._db.execute_raw.call_count == 1
    query, params = service._db.execute_raw.call_args.args
    assert "invite.inviter_user_id=:user_id" in query and "circle.owner_user_id=:user_id" in query
    assert "status = 'pending'" not in query and "expires_at > NOW()" not in query
    assert "UPDATE" not in query and params["user_id"] == "owner"
