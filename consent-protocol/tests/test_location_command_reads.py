"""Read-port boundaries use owning-service fakes; no model or mutation service."""

import json
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from hushh_mcp.operons.location.references import LocationObservation
from hushh_mcp.services.location_command_reads import LocationCommandReadService


def fixture():
    people = {
        "items": [
            {
                "userId": "private-user-id",
                "displayName": "Abdul",
                "email": "secret@example.invalid",
                "relationship": "pending_outgoing",
                "privateKey": "never",
            }
        ],
        "hasMore": True,
    }
    circles = [
        {
            "id": "private-circle-id",
            "name": "Goa",
            "memberCount": 21,
            "kind": "other",
            "activeInviteCode": "never",
            "viewerCapabilities": {"canManageMembers": True},
        }
    ]
    return LocationCommandReadService(
        user_id="owner",
        connections=SimpleNamespace(
            list_connections_page=Mock(return_value=people),
            search_directory=Mock(return_value=people),
        ),
        circles=SimpleNamespace(
            list_circles=Mock(return_value=circles),
            list_circle_members_page=Mock(return_value=people),
        ),
        location=SimpleNamespace(
            get_auto_approve_preference=Mock(
                return_value={
                    "enabled": True,
                    "scope": {"kind": "circle", "circleId": "private-circle-id"},
                    "ruleVersion": 2,
                }
            ),
            get_map_preferences=Mock(
                return_value={"presenceMode": "ghost", "rendererConsentVersion": "private"}
            ),
        ),
    )


@pytest.mark.asyncio
async def test_created_circle_context_uses_exact_receipt_and_current_owner_visibility():
    service = fixture()
    results = [
        {"kind": "circle", "id": "private-circle-id"},
        {"kind": "circle", "id": "deleted-circle"},
    ]
    observed = await service.observe_created_circles(results)
    assert len(observed) == 1
    assert observed[0]["id"] == "private-circle-id" and observed[0]["name"] == "Goa"
    again = await fixture().observe_created_circles(results)
    assert again[0]["reference"] == observed[0]["reference"]
    assert set(observed[0]) == {"reference", "kind", "id", "name", "observed_at"}
    service._circles.list_circles.assert_called_once_with(user_id="owner")
    service._circles.list_circles.return_value = []
    fresh = LocationCommandReadService(
        user_id="owner",
        circles=service._circles,
        connections=service._connections,
        location=service._location,
    )
    assert await fresh.observe_created_circles(results) == []


@pytest.mark.asyncio
async def test_public_link_read_exposes_only_current_window_metadata():
    service = fixture()
    service._location.observe_command_status = Mock(
        return_value={
            "hasMore": True,
            "items": [
                {
                    "id": "private-link",
                    "publicUrl": "https://example.invalid/private-token",
                    "metadata": {"publicLocation": {"latitude": 0}},
                    "status": "active",
                    "expiresAt": "2026-09-13T20:00:00Z",
                    "durationHours": 1,
                }
            ],
        }
    )
    result = await service.read("links", page=2, limit=10)
    assert result == {
        "status": "observed",
        "page": 2,
        "hasMore": True,
        "items": [
            {
                "status": "active",
                "expiresAt": "2026-09-13T20:00:00Z",
                "durationHours": 1,
            }
        ],
    }
    service._location.observe_command_status.assert_called_once_with(
        user_id="owner", kind="links", page=2, limit=10
    )


@pytest.mark.asyncio
async def test_full_session_accepts_a_new_verified_candidate_and_retains_chosen_handles():
    observations = [
        LocationObservation(
            reference=f"candidate_{index:032x}",
            kind="place",
            id=f"place-{index}",
            name=f"Place {index}",
            observed_at=datetime.now(UTC),
        )
        for index in range(50)
    ]
    service = fixture()
    seeded = LocationCommandReadService(
        user_id="owner",
        observations=observations,
        connections=service._connections,
        circles=service._circles,
        location=service._location,
    )
    response = await seeded.read("directory", query="Abdul")
    chosen = response["items"][0]["reference"]
    retained = seeded.observations({chosen, observations[0].reference})
    assert len(retained) == 50
    assert {chosen, observations[0].reference} <= {value["reference"] for value in retained}
    assert "private-user-id" not in json.dumps(response)


@pytest.mark.asyncio
async def test_names_and_relationship_are_observed_without_identifiers_or_keys():
    service = fixture()
    response = await service.read("directory", query="Abdul")
    assert response["items"][0]["relationship"] == "pending_outgoing"
    assert response["hasMore"] is True
    assert response["items"][0]["name"] == "Abdul"
    serialized = json.dumps(response)
    assert (
        "private-user-id" not in serialized
        and "secret@" not in serialized
        and "never" not in serialized
    )
    assert service._connections.search_directory.call_args.args == ("owner",)


@pytest.mark.asyncio
async def test_circle_member_read_requires_observed_typed_handle_and_keeps_pagination():
    service = fixture()
    with pytest.raises(ValueError, match="candidate"):
        await service.read("members", reference="invented")
    circle = (await service.read("circles"))["items"][0]
    members = await service.read("members", reference=circle["reference"], page=2, limit=10)
    assert members["page"] == 2 and members["hasMore"] is True
    assert service._circles.list_circle_members_page.call_args.kwargs == {
        "user_id": "owner",
        "circle_id": "private-circle-id",
        "query": "",
        "page": 2,
        "limit": 10,
    }


@pytest.mark.asyncio
async def test_settings_scope_stays_specific_and_nearby_cannot_invent_results():
    service = fixture()
    settings = (await service.read("settings"))["autoApproval"]
    assert settings["scopeKind"] == "circle" and settings["scopeComplete"] is True
    assert settings["circles"][0]["name"] == "Goa"
    assert "private-circle-id" not in json.dumps(settings)
    assert (await service.read("nearby"))["status"] == "needs_client_observation"


@pytest.mark.asyncio
async def test_invalid_bounds_and_budget_fail_closed_and_service_failure_is_not_empty_success():
    service = fixture()
    with pytest.raises(ValueError):
        await service.read("connections", limit=21)
    service._connections.list_connections_page.side_effect = RuntimeError("private backend failure")
    result = await service.read("connections")
    assert result["status"] == "unavailable" and "private" not in json.dumps(result)
    for _ in range(9):
        await service.read("nearby")
    with pytest.raises(ValueError, match="budget"):
        await service.read("nearby")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "valid,token_owner,port_owner",
    [(False, "owner", "owner"), (True, "other", "owner"), (True, "owner", "other")],
)
async def test_declared_read_tool_rejects_revocation_and_owner_mismatch(
    monkeypatch, valid, token_owner, port_owner
):
    from hushh_mcp.agents.location.command_read_tools import find_people
    from hushh_mcp.hushh_adk import tools
    from hushh_mcp.hushh_adk.context import HushhContext

    monkeypatch.setattr(
        tools,
        "validate_token_with_db",
        AsyncMock(return_value=(valid, "revoked", SimpleNamespace(user_id=token_owner))),
    )
    port = SimpleNamespace(user_id=port_owner, read=AsyncMock())
    with HushhContext(
        user_id="owner",
        consent_token="synthetic",  # noqa: S106 - synthetic test authority
        service_ports={"location_command_reads": port},
    ):
        with pytest.raises(PermissionError):
            await find_people("Abdul")
    port.read.assert_not_called()


@pytest.mark.asyncio
async def test_revocation_while_provider_waits_does_not_reveal_result(monkeypatch):
    from hushh_mcp.agents.location.command_read_tools import find_people
    from hushh_mcp.hushh_adk import tools
    from hushh_mcp.hushh_adk.context import HushhContext

    token = SimpleNamespace(user_id="owner")
    validator = AsyncMock(side_effect=[(True, "", token), (False, "revoked", token)])
    monkeypatch.setattr(tools, "validate_token_with_db", validator)
    port = SimpleNamespace(
        user_id="owner", read=AsyncMock(return_value={"items": [{"name": "protected"}]})
    )
    with HushhContext(
        user_id="owner",
        consent_token="synthetic",  # noqa: S106 - synthetic test authority
        service_ports={"location_command_reads": port},
    ):
        with pytest.raises(PermissionError, match="changed"):
            await find_people("Abdul")
    assert validator.await_count == 2
    port.read.assert_awaited_once()


@pytest.mark.asyncio
async def test_saved_selection_survives_session_expiry_as_task_input_without_freshness_or_authority():
    from datetime import timedelta

    selected = LocationObservation(
        reference="candidate_" + "a" * 32,
        kind="place",
        id="saved-place",
        name="Chosen restaurant",
        observed_at=datetime.now(UTC) - timedelta(hours=2),
    )
    service = fixture()
    scoped = LocationCommandReadService(
        user_id="owner",
        observations=[selected],
        saved_observations=[selected],
        connections=service._connections,
        circles=service._circles,
        location=service._location,
    )
    observed = scoped.semantic_observations()
    assert observed[0]["observation_status"] == "saved_selection_needs_refresh"
    assert "saved-place" not in json.dumps(observed)
    assert (
        scoped.observations({selected.reference})[0]["observed_at"]
        == selected.model_dump(mode="json")["observed_at"]
    )
    stale = selected.model_copy(update={"observed_at": datetime.now(UTC) - timedelta(hours=25)})
    expired = LocationCommandReadService(user_id="owner", saved_observations=[stale])
    assert expired.semantic_observations() == []


@pytest.mark.asyncio
async def test_saved_place_is_separate_from_the_current_nearby_result_order():
    from datetime import timedelta

    selected = LocationObservation(
        reference="candidate_" + "a" * 32,
        kind="place",
        id="old",
        name="Earlier selection",
        observed_at=datetime.now(UTC) - timedelta(hours=2),
    )
    current = LocationObservation(
        reference="candidate_" + "b" * 32,
        kind="place",
        id="current",
        name="Current result",
        observed_at=datetime.now(UTC),
    )
    ports = fixture()
    service = LocationCommandReadService(
        user_id="owner",
        observations=[current],
        saved_observations=[selected],
        connections=ports._connections,
        circles=ports._circles,
        location=ports._location,
    )
    result = await service.read("nearby")
    assert [value["name"] for value in result["items"]] == ["Current result"]
    assert len(service.semantic_observations()) == 2
