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
async def test_extract_draft_wildcard_scope_allows_granular_sub_scopes():
    """Regression: approved wildcard 'attr.identity.*' must accept granular sub-scopes.

    Before the fix the string-issubset check would raise ONE_KYC_EXTRACT_SUBSET_VIOLATION
    because 'attr.identity.name' != 'attr.identity.*'. The scope_matches-based check
    correctly recognises the granular scope as covered by the wildcard.
    """
    service = get_one_email_kyc_service()
    llm_out = {
        "extracted": [
            {"scope": "attr.identity.name", "label": "Full name", "value": "Jane Doe"},
            {"scope": "attr.identity.dob", "label": "Date of birth", "value": "1990-01-01"},
        ],
        "missing": [],
        "draft": {
            "subject": "Re: KYC",
            "body": "My name is Jane Doe and my date of birth is 1990-01-01.",
        },
    }
    workflow = {
        "workflow_id": "wf-reg",
        "status": "waiting_on_user",
        "draft_status": "ready",
        "metadata": {},
    }
    with (
        patch.object(service, "get_workflow", new=AsyncMock(return_value=workflow)),
        patch.object(service, "_llm_generate_structured", new=AsyncMock(return_value=llm_out)),
        patch.object(service, "_update_workflow", return_value=workflow),
        patch(
            "hushh_mcp.services.one_email_kyc_service.validate_token_with_db",
            new=AsyncMock(return_value=(True, "ok", None)),
        ),
    ):
        result = await service.extract_and_draft(
            user_id="u1",
            workflow_id="wf-reg",
            domain="identity",
            domain_data={"full_name": "Jane Doe", "dob": "1990-01-01"},
            approved_scopes=["attr.identity.*"],
            request_text="Please share your identity details.",
            consent_token="tok",  # noqa: S106
        )
    assert result["extracted"][0]["value"] == "Jane Doe"
    assert result["extracted"][1]["value"] == "1990-01-01"
    assert "Jane Doe" in result["draft"]["body"]


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


@pytest.mark.asyncio
async def test_extract_draft_prompt_framing():
    """Assert the prompt sent to the LLM contains the correct role/disclosure framing.

    The prompt must:
    - instruct the LLM to reply ON BEHALF OF the user (data owner)
    - write FROM the user's first-person perspective
    - make clear the reply DISCLOSES the requested information
    - NOT write from the requester's perspective
    """
    service = get_one_email_kyc_service()
    captured_prompts: list[str] = []

    llm_out = {
        "extracted": [{"scope": "attr.identity.name", "label": "Full name", "value": "Jane Doe"}],
        "missing": [],
        "draft": {"subject": "Re: KYC Request", "body": "My name is Jane Doe."},
    }
    workflow = {
        "workflow_id": "wf-prompt",
        "status": "waiting_on_user",
        "draft_status": "ready",
        "metadata": {},
    }

    async def capture_prompt(**kwargs):
        captured_prompts.append(kwargs.get("prompt", ""))
        return llm_out

    with (
        patch.object(service, "get_workflow", new=AsyncMock(return_value=workflow)),
        patch.object(
            service, "_llm_generate_structured", new=AsyncMock(side_effect=capture_prompt)
        ),
        patch.object(service, "_update_workflow", return_value=workflow),
        patch(
            "hushh_mcp.services.one_email_kyc_service.validate_token_with_db",
            new=AsyncMock(return_value=(True, "ok", None)),
        ),
    ):
        await service.extract_and_draft(
            user_id="u1",
            workflow_id="wf-prompt",
            domain="identity",
            domain_data={"full_name": "Jane Doe"},
            approved_scopes=["attr.identity.name"],
            request_text="Please provide your full name for KYC.",
            consent_token="tok",  # noqa: S106
        )

    assert len(captured_prompts) == 1, "Expected exactly one LLM call"
    prompt = captured_prompts[0]

    # Role framing: reply is on behalf of the data owner, from the user's perspective
    assert "ON BEHALF OF the user" in prompt, "Prompt must instruct reply on behalf of the user"
    assert "first-person perspective" in prompt, "Prompt must specify first-person perspective"
    assert "Do NOT write from the requester's perspective" in prompt, (
        "Prompt must explicitly forbid writing from requester's perspective"
    )

    # Disclosure goal: the reply must present the actual data
    assert "DISCLOSE the requested information" in prompt, (
        "Prompt must state the goal is to disclose the requested information"
    )
    assert "Present each approved field with its real extracted value" in prompt, (
        "Prompt must instruct presenting each field with its real value"
    )

    # Anti-hallucination: no fabrication, no requester sign-off
    assert "Do NOT sign as the requester" in prompt, (
        "Prompt must forbid signing as the requester's organisation"
    )
