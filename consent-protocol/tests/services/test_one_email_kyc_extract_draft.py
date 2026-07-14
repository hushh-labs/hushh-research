from unittest.mock import AsyncMock, patch

import pytest

from hushh_mcp.services.one_email_kyc_service import (
    OneEmailKycError,
    get_one_email_kyc_service,
)


@pytest.mark.asyncio
async def test_extract_draft_rejects_scope_outside_approved():
    service = get_one_email_kyc_service()
    llm_out = {
        "extracted": [
            {"scope": "attr.identity.name", "label": "Full name", "value": "Jane Doe"},
            {"scope": "attr.identity.passport", "label": "Passport", "value": "X123"},
        ],
        "missing": [],
        "draft": {"subject": "Re: KYC", "body": "My name is Jane Doe."},
    }
    workflow = {
        "workflow_id": "wf-1",
        "status": "waiting_on_user",
        "draft_status": "ready",
    }
    with (
        patch.object(service, "get_workflow", new=AsyncMock(return_value=workflow)),
        patch.object(service, "_llm_generate_structured", new=AsyncMock(return_value=llm_out)),
        patch(
            "hushh_mcp.services.one_email_kyc_service.validate_token_with_db",
            new=AsyncMock(return_value=(True, "ok", None)),
        ),
    ):
        with pytest.raises(OneEmailKycError) as exc:
            await service.extract_and_draft(
                user_id="u1",
                workflow_id="wf-1",
                domain="identity",
                domain_data={"full_name": "Jane Doe"},
                approved_scopes=["attr.identity.name"],
                request_text="Please share your full name.",
                consent_token="tok",  # noqa: S106
            )
    assert exc.value.code == "ONE_KYC_EXTRACT_SUBSET_VIOLATION"


@pytest.mark.asyncio
async def test_extract_draft_happy_path():
    service = get_one_email_kyc_service()
    llm_out = {
        "extracted": [{"scope": "attr.identity.name", "label": "Full name", "value": "Jane Doe"}],
        "missing": [],
        "draft": {"subject": "Re: KYC", "body": "My name is Jane Doe."},
    }
    workflow = {
        "workflow_id": "wf-1",
        "status": "waiting_on_user",
        "draft_status": "ready",
        "metadata": {},
    }
    with (
        patch.object(service, "get_workflow", new=AsyncMock(return_value=workflow)),
        patch.object(service, "_llm_generate_structured", new=AsyncMock(return_value=llm_out)),
        patch.object(service, "_update_workflow", return_value=workflow) as mock_update,
        patch(
            "hushh_mcp.services.one_email_kyc_service.validate_token_with_db",
            new=AsyncMock(return_value=(True, "ok", None)),
        ),
    ):
        result = await service.extract_and_draft(
            user_id="u1",
            workflow_id="wf-1",
            domain="identity",
            domain_data={"full_name": "Jane Doe"},
            approved_scopes=["attr.identity.name"],
            request_text="Please share your full name.",
            consent_token="tok",  # noqa: S106
        )
    assert result["draft"]["body"] == "My name is Jane Doe."
    assert result["extracted"][0]["value"] == "Jane Doe"
    mock_update.assert_called_once()


@pytest.mark.asyncio
async def test_extract_draft_provenance_violation():
    """Draft body containing an email not in extracted values → provenance violation."""
    service = get_one_email_kyc_service()
    llm_out = {
        "extracted": [{"scope": "attr.identity.name", "label": "Full name", "value": "Jane Doe"}],
        "missing": [],
        "draft": {
            "subject": "Re: KYC",
            "body": "My name is Jane Doe. Contact me at hallucinated@example.com.",
        },
    }
    workflow = {
        "workflow_id": "wf-2",
        "status": "waiting_on_user",
        "draft_status": "ready",
        "metadata": {},
    }
    with (
        patch.object(service, "get_workflow", new=AsyncMock(return_value=workflow)),
        patch.object(service, "_llm_generate_structured", new=AsyncMock(return_value=llm_out)),
        patch(
            "hushh_mcp.services.one_email_kyc_service.validate_token_with_db",
            new=AsyncMock(return_value=(True, "ok", None)),
        ),
    ):
        with pytest.raises(OneEmailKycError) as exc:
            await service.extract_and_draft(
                user_id="u1",
                workflow_id="wf-2",
                domain="identity",
                domain_data={"full_name": "Jane Doe"},
                approved_scopes=["attr.identity.name"],
                request_text="Please share your full name.",
                consent_token="tok",  # noqa: S106
            )
    assert exc.value.code == "ONE_KYC_DRAFT_PROVENANCE_VIOLATION"


@pytest.mark.asyncio
async def test_extract_draft_invalid_consent_token():
    """Invalid consent token → PermissionError raised."""
    service = get_one_email_kyc_service()
    with patch(
        "hushh_mcp.services.one_email_kyc_service.validate_token_with_db",
        new=AsyncMock(return_value=(False, "token revoked", None)),
    ):
        with pytest.raises(PermissionError):
            await service.extract_and_draft(
                user_id="u1",
                workflow_id="wf-3",
                domain="identity",
                domain_data={},
                approved_scopes=["attr.identity.name"],
                request_text="KYC request.",
                consent_token="bad-tok",  # noqa: S106
            )


@pytest.mark.asyncio
async def test_extract_draft_not_ready_non_waiting_status():
    """Workflow in non-waiting_on_user state → ONE_KYC_DRAFT_NOT_READY."""
    service = get_one_email_kyc_service()
    workflow = {
        "workflow_id": "wf-4",
        "status": "processing",
        "draft_status": "ready",
    }
    with (
        patch.object(service, "get_workflow", new=AsyncMock(return_value=workflow)),
        patch(
            "hushh_mcp.services.one_email_kyc_service.validate_token_with_db",
            new=AsyncMock(return_value=(True, "ok", None)),
        ),
    ):
        with pytest.raises(OneEmailKycError) as exc:
            await service.extract_and_draft(
                user_id="u1",
                workflow_id="wf-4",
                domain="identity",
                domain_data={"full_name": "Jane Doe"},
                approved_scopes=["attr.identity.name"],
                request_text="KYC request.",
                consent_token="tok",  # noqa: S106
            )
    assert exc.value.code == "ONE_KYC_DRAFT_NOT_READY"


@pytest.mark.asyncio
async def test_extract_draft_malformed_null_scope():
    """LLM returns an extracted item with scope=None → ONE_KYC_EXTRACT_MALFORMED."""
    service = get_one_email_kyc_service()
    llm_out = {
        "extracted": [
            {"scope": None, "label": "Full name", "value": "Jane Doe"},
        ],
        "missing": [],
        "draft": {"subject": "Re: KYC", "body": "My name is Jane Doe."},
    }
    workflow = {
        "workflow_id": "wf-5",
        "status": "waiting_on_user",
        "draft_status": "ready",
        "metadata": {},
    }
    with (
        patch.object(service, "get_workflow", new=AsyncMock(return_value=workflow)),
        patch.object(service, "_llm_generate_structured", new=AsyncMock(return_value=llm_out)),
        patch(
            "hushh_mcp.services.one_email_kyc_service.validate_token_with_db",
            new=AsyncMock(return_value=(True, "ok", None)),
        ),
    ):
        with pytest.raises(OneEmailKycError) as exc:
            await service.extract_and_draft(
                user_id="u1",
                workflow_id="wf-5",
                domain="identity",
                domain_data={"full_name": "Jane Doe"},
                approved_scopes=["attr.identity.name"],
                request_text="KYC request.",
                consent_token="tok",  # noqa: S106
            )
    assert exc.value.code == "ONE_KYC_EXTRACT_MALFORMED"
