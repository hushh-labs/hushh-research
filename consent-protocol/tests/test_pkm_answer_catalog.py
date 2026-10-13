"""The answer lane consumes the existing exact requestable scope catalog."""

from unittest.mock import AsyncMock, Mock

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
    scopes = [entry["scope"] for entry in catalog]
    assert "attr.preferences.meals" in scopes
    assert set(scopes[:4]) == {
        "attr.identity.identity_profile.full_name",
        "attr.identity.identity_profile.declared_age",
        "attr.identity.identity_profile.sex",
        "attr.identity.identity_profile.profile_photo_url",
    }
    assert "attr.one_living_sources.private" not in scopes
    assert "attr.preferences.secret" not in scopes
    assert "attr.identity.identity_profile.full_name" in scopes
    assert "attr.identity.identity_profile.profile_photo_url" in scopes
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


async def test_creation_does_not_wait_for_catalog_availability():
    reader = AsyncMock(side_effect=RuntimeError("offline"))
    service = PkmAnswerRequestService(Mock(), catalog_reader=reader)
    service._transaction = AsyncMock(return_value="synthetic-request")
    result = await service.create(
        requester_user_id="requester", owner_user_id="owner", question="What trips do you prefer?"
    )
    assert result == {"requestId": "synthetic-request"}
    reader.assert_not_awaited()
    service._transaction.assert_awaited_once()


async def test_profile_only_account_can_offer_exact_name_and_photo_without_kyc(monkeypatch):
    profile = Mock()
    profile.get_exact_requestable_scope_entries.return_value = []
    monkeypatch.setattr(
        "hushh_mcp.services.connections_service.ConnectionsService", lambda: profile
    )
    service = PkmAnswerRequestService(Mock())
    catalog = await service._catalog("requester", "existing-owner")
    available = [entry["scope"] for entry in catalog]
    assert validate_resolved_scopes(
        [
            "attr.identity.identity_profile.full_name",
            "attr.identity.identity_profile.profile_photo_url",
            "attr.identity.*",
            "attr.identity.identity_documents.passport",
        ],
        owner_catalog=available,
    ).accepted == (
        "attr.identity.identity_profile.full_name",
        "attr.identity.identity_profile.profile_photo_url",
    )
