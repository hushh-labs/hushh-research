"""The answer lane consumes the existing exact requestable scope catalog."""

from unittest.mock import AsyncMock, Mock

import pytest

from hushh_mcp.consent.answer_scope_resolution import validate_resolved_scopes
from hushh_mcp.services.connections_service import ConnectionsService
from hushh_mcp.services.pkm_answer_request_service import PkmAnswerRequestService


async def test_answer_catalog_reuses_profile_canonical_scopes_not_opaque_registry_handles(
    monkeypatch,
):
    connection_catalog = ConnectionsService(
        scope_entries_lookup=lambda _owner: [
            {
                "scope": "attr.preferences.meals",
                "label": "Meals",
                "domain": "preferences",
                "path": "meals",
                "registry_handle": "s_opaque",
                "exposure_enabled": True,
                "visibility_posture": "consent_required",
            },
            {
                "scope": "attr.one_living_sources.private",
                "label": "Private inventory",
                "domain": "one_living_sources",
                "path": "private",
                "exposure_enabled": True,
            },
            {
                "scope": "attr.preferences.secret",
                "label": "Withheld",
                "domain": "preferences",
                "path": "secret",
                "exposure_enabled": False,
            },
        ]
    )
    monkeypatch.setattr(
        "hushh_mcp.services.connections_service.ConnectionsService", lambda: connection_catalog
    )
    service = PkmAnswerRequestService(Mock())
    catalog = await service._catalog("requester", "owner")
    assert [entry["scope"] for entry in catalog] == ["attr.preferences.meals"]
    assert validate_resolved_scopes(
        ["attr.preferences.meals", "s_opaque"], owner_catalog=[entry["scope"] for entry in catalog]
    ).accepted == ("attr.preferences.meals",)


async def test_answer_catalog_port_receives_the_exact_participant_pair():
    reader = AsyncMock(return_value=[{"scope": "attr.travel.trips", "label": "Trips"}])
    service = PkmAnswerRequestService(Mock(), catalog_reader=reader)
    assert await service._catalog("requester", "owner") == [
        {"scope": "attr.travel.trips", "label": "Trips"}
    ]
    reader.assert_awaited_once_with("requester", "owner")


async def test_catalog_failure_creates_no_hidden_request():
    db = Mock()
    service = PkmAnswerRequestService(
        db, catalog_reader=AsyncMock(side_effect=RuntimeError("offline"))
    )
    service._transaction = AsyncMock()
    with pytest.raises(RuntimeError, match="offline"):
        await service.create(
            requester_user_id="requester",
            owner_user_id="owner",
            question="What trips do you prefer?",
        )
    service._transaction.assert_not_awaited()
