"""Gmail callback authority and signed-state continuity contracts."""

from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.gmail_receipts_service import GmailApiError, GmailReceiptsService
from tests.google_oauth_test_support import configure_gmail_oauth as _configure_gmail_oauth


def test_state_token_round_trip():
    service = GmailReceiptsService()
    state = service._build_state_token(
        user_id="user_123",
        redirect_uri="http://localhost:3000/one/profile/gmail/oauth/return",
    )

    payload = service._verify_state_token(
        state=state,
        user_id="user_123",
        redirect_uri="http://localhost:3000/one/profile/gmail/oauth/return",
    )

    assert payload["uid"] == "user_123"
    assert payload["redirect_uri"] == "http://localhost:3000/one/profile/gmail/oauth/return"


def test_state_token_invalid_signature_rejected():
    service = GmailReceiptsService()
    state = service._build_state_token(
        user_id="user_123",
        redirect_uri="http://localhost:3000/one/profile/gmail/oauth/return",
    )
    broken = f"{state}x"

    with pytest.raises(GmailApiError) as exc_info:
        service._verify_state_token(
            state=broken,
            user_id="user_123",
            redirect_uri="http://localhost:3000/one/profile/gmail/oauth/return",
        )

    assert exc_info.value.status_code == 400


def test_oauth_redirect_uses_environment_owned_callback(monkeypatch):
    redirect_uri = _configure_gmail_oauth(monkeypatch)
    service = GmailReceiptsService()

    assert service.is_configured() is True
    assert service._resolve_oauth_redirect_uri(redirect_uri) == redirect_uri
    assert service._resolve_oauth_redirect_uri(None) == redirect_uri


@pytest.mark.asyncio
async def test_oauth_alias_preserves_signed_callback_and_rejects_other_environment(monkeypatch):
    legacy = _configure_gmail_oauth(monkeypatch)
    alias = legacy.replace("hushh.ai", "hussh.ai")
    monkeypatch.setenv(
        "CORS_ALLOWED_ORIGINS",
        "https://uat.one.hushh.ai,https://uat.one.hussh.ai,https://one.hussh.ai",
    )
    service = GmailReceiptsService()
    state = service._build_state_token(user_id="owner", redirect_uri=alias)
    complete = AsyncMock(return_value={"connected": True})
    monkeypatch.setattr(service, "_complete_authorized_connect", complete)
    assert service._resolve_oauth_redirect_uri(alias) == alias
    await service.complete_connect(
        user_id="owner", code="synthetic", state=state, redirect_uri=alias
    )
    assert complete.await_args.kwargs["redirect_uri"] == alias
    complete.reset_mock()
    for invalid in (legacy, "https://one.hussh.ai/one/profile/gmail/oauth/return"):
        with pytest.raises(GmailApiError):
            await service.complete_connect(
                user_id="owner", code="synthetic", state=state, redirect_uri=invalid
            )
    complete.assert_not_awaited()
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "https://uat.one.hushh.ai")
    with pytest.raises(GmailApiError):
        service._resolve_oauth_redirect_uri(alias)


@pytest.mark.asyncio
async def test_older_client_completes_with_original_signed_callback_after_alias_switch(monkeypatch):
    legacy = _configure_gmail_oauth(monkeypatch)
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "https://uat.one.hushh.ai,https://uat.one.hussh.ai")
    service = GmailReceiptsService()
    state = service._build_state_token(user_id="owner", redirect_uri=legacy)
    _configure_gmail_oauth(monkeypatch, origin="https://uat.one.hussh.ai")
    complete = AsyncMock(return_value={"connected": True})
    monkeypatch.setattr(service, "_complete_authorized_connect", complete)
    await service.complete_connect(
        user_id="owner", code="synthetic", state=state, redirect_uri=None
    )
    assert complete.await_args.kwargs["redirect_uri"] == legacy
    complete.reset_mock()
    for invalid_state in (
        state + "x",
        service._build_state_token(
            user_id="owner", redirect_uri="https://one.hussh.ai/one/profile/gmail/oauth/return"
        ),
    ):
        with pytest.raises(GmailApiError):
            await service.complete_connect(
                user_id="owner", code="synthetic", state=invalid_state, redirect_uri=None
            )
    complete.assert_not_awaited()


def test_oauth_redirect_rejects_caller_selected_origin(monkeypatch):
    _configure_gmail_oauth(monkeypatch)
    service = GmailReceiptsService()

    with pytest.raises(GmailApiError) as exc_info:
        service._resolve_oauth_redirect_uri(
            "https://untrusted.example/one/profile/gmail/oauth/return"
        )

    assert exc_info.value.status_code == 400


def test_oauth_redirect_rejects_environment_configuration_drift(monkeypatch):
    _configure_gmail_oauth(monkeypatch)
    monkeypatch.setenv(
        "GMAIL_OAUTH_REDIRECT_URI",
        "http://localhost:3000/one/profile/gmail/oauth/return",
    )
    service = GmailReceiptsService()

    assert service.is_configured() is False
    with pytest.raises(GmailApiError) as exc_info:
        service._resolve_oauth_redirect_uri(None)

    assert exc_info.value.status_code == 503


@pytest.mark.asyncio
async def test_connect_boundaries_reject_wrong_redirect_before_oauth_work(monkeypatch):
    _configure_gmail_oauth(monkeypatch)
    service = GmailReceiptsService()
    wrong_redirect = "https://untrusted.example/one/profile/gmail/oauth/return"

    with pytest.raises(GmailApiError) as start_error:
        await service.start_connect(
            user_id="user_123",
            redirect_uri=wrong_redirect,
            login_hint=None,
            include_granted_scopes=False,
        )

    with pytest.raises(GmailApiError) as complete_error:
        await service.complete_connect(
            user_id="user_123",
            code="oauth-code",
            state="state-token",
            redirect_uri=wrong_redirect,
        )

    assert start_error.value.status_code == 400
    assert complete_error.value.status_code == 400
