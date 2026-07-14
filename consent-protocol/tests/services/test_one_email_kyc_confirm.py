"""Unit tests for OneEmailKycService.confirm_proposal (Task 4).

Verifies scope-subset validation, status guard, happy-path delegation,
and kyc_confirmed_items storage. No real DB or Gemini calls are made.
"""

from unittest.mock import AsyncMock, patch

import pytest

from hushh_mcp.services.one_email_kyc_service import (
    OneEmailKycError,
    get_one_email_kyc_service,
)

_PROPOSAL = {
    "classification": "kyc",
    "requested_items": [
        {
            "scope": "attr.identity.name",
            "domain": "identity",
            "label": "Full name",
            "rationale": "verify identity",
        },
        {
            "scope": "attr.identity.dob",
            "domain": "identity",
            "label": "Date of birth",
            "rationale": "age verification",
        },
    ],
    "primary_domains": ["identity"],
    "confidence": 0.9,
    "reasoning": "KYC request for identity verification",
}

_NEEDS_CONFIRM_WORKFLOW = {
    "workflow_id": "wf-1",
    "status": "needs_confirm",
    "metadata": {"kyc_proposal": _PROPOSAL},
}


@pytest.mark.asyncio
async def test_confirm_rejects_scope_outside_proposal():
    """Scope not in proposal's requested_items raises ONE_KYC_CONFIRM_SCOPE_INVALID."""
    service = get_one_email_kyc_service()
    workflow = {
        "workflow_id": "wf-1",
        "status": "needs_confirm",
        "metadata": {
            "kyc_proposal": {
                "requested_items": [
                    {
                        "scope": "attr.identity.name",
                        "domain": "identity",
                        "label": "Full name",
                        "rationale": "x",
                    }
                ]
            }
        },
    }
    with patch.object(service, "get_workflow", new=AsyncMock(return_value=workflow)):
        with pytest.raises(OneEmailKycError) as exc:
            await service.confirm_proposal(
                user_id="u1",
                workflow_id="wf-1",
                approved_scopes=["attr.travel.itinerary"],
            )
    assert exc.value.code == "ONE_KYC_CONFIRM_SCOPE_INVALID"


@pytest.mark.asyncio
async def test_confirm_rejects_wrong_status():
    """Workflow not in needs_confirm raises ONE_KYC_NOT_AWAITING_CONFIRM (409)."""
    service = get_one_email_kyc_service()
    workflow = {
        "workflow_id": "wf-2",
        "status": "needs_scope",
        "metadata": {"kyc_proposal": _PROPOSAL},
    }
    with patch.object(service, "get_workflow", new=AsyncMock(return_value=workflow)):
        with pytest.raises(OneEmailKycError) as exc:
            await service.confirm_proposal(
                user_id="u1",
                workflow_id="wf-2",
                approved_scopes=["attr.identity.name"],
            )
    assert exc.value.code == "ONE_KYC_NOT_AWAITING_CONFIRM"
    assert exc.value.status_code == 409


@pytest.mark.asyncio
async def test_confirm_happy_path_stores_confirmed_items_and_delegates():
    """Valid subset approval stores kyc_confirmed_items and awaits select_scopes."""
    service = get_one_email_kyc_service()
    select_scopes_result = {"status": "needs_scope", "workflow_id": "wf-1"}

    with (
        patch.object(service, "get_workflow", new=AsyncMock(return_value=_NEEDS_CONFIRM_WORKFLOW)),
        patch.object(
            service,
            "select_scopes",
            new=AsyncMock(return_value=select_scopes_result),
        ) as mock_select,
        patch.object(service, "_update_workflow", return_value=_NEEDS_CONFIRM_WORKFLOW),
    ):
        result = await service.confirm_proposal(
            user_id="u1",
            workflow_id="wf-1",
            approved_scopes=["attr.identity.name"],
        )

    # select_scopes was called with the approved scope
    mock_select.assert_awaited_once_with(
        user_id="u1",
        workflow_id="wf-1",
        selected_scopes=["attr.identity.name"],
    )
    assert result == select_scopes_result


@pytest.mark.asyncio
async def test_confirm_stores_only_approved_items():
    """kyc_confirmed_items contains only the approved subset (not the full proposal)."""
    service = get_one_email_kyc_service()
    captured_metadata: dict = {}

    def fake_update_workflow(workflow_id: str, **kwargs):
        if "metadata" in kwargs:
            captured_metadata.update(kwargs["metadata"])
        return _NEEDS_CONFIRM_WORKFLOW

    with (
        patch.object(service, "get_workflow", new=AsyncMock(return_value=_NEEDS_CONFIRM_WORKFLOW)),
        patch.object(service, "_update_workflow", side_effect=fake_update_workflow),
        patch.object(
            service,
            "select_scopes",
            new=AsyncMock(return_value={}),
        ),
    ):
        await service.confirm_proposal(
            user_id="u1",
            workflow_id="wf-1",
            approved_scopes=["attr.identity.name"],  # only first scope approved
        )

    confirmed = captured_metadata.get("kyc_confirmed_items", [])
    assert len(confirmed) == 1
    assert confirmed[0]["scope"] == "attr.identity.name"


@pytest.mark.asyncio
async def test_confirm_rejects_empty_approved_scopes_mixed():
    """If approved_scopes contains only invalid scopes, error payload lists them."""
    service = get_one_email_kyc_service()
    with patch.object(service, "get_workflow", new=AsyncMock(return_value=_NEEDS_CONFIRM_WORKFLOW)):
        with pytest.raises(OneEmailKycError) as exc:
            await service.confirm_proposal(
                user_id="u1",
                workflow_id="wf-1",
                approved_scopes=["attr.financial.portfolio"],
            )
    assert exc.value.code == "ONE_KYC_CONFIRM_SCOPE_INVALID"
    assert "invalid_scopes" in exc.value.payload
    assert "proposed_scopes" in exc.value.payload
