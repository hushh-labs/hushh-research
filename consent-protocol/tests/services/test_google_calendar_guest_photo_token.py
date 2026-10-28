"""A Calendar guest-photo bearer is exact-scope, owner/account-bound authority."""

import hashlib
from unittest.mock import AsyncMock, Mock

import pytest

from hushh_mcp.services.google_connection_service import (
    CALENDAR_GUEST_PHOTO_SCOPE,
    GoogleConnectionError,
    GoogleConnectionService,
)
from hushh_mcp.services.google_oauth_attempt import connection_generation


def test_browser_photo_token_is_not_an_agent_capability():
    from api.routes.one.calendar import router
    from hushh_mcp.services.app_intelligence_runtime import (
        _discover_service_api_endpoints_from_router,
        _discover_service_api_endpoints_from_source,
    )

    for endpoints in (
        _discover_service_api_endpoints_from_router("calendar", router),
        _discover_service_api_endpoints_from_source("calendar"),
    ):
        assert not any(
            endpoint["path"] == "/api/one/calendar/guest-photo-token" for endpoint in endpoints
        )


def _row(*, authorized: bool = True) -> dict:
    return {
        "provider_subject": "google-subject",
        "provider_email": "owner@example.com",
        "status": "connected",
        "grant_status": "connected",
        "scope_csv": f"https://www.googleapis.com/auth/calendar.events.readonly {CALENDAR_GUEST_PHOTO_SCOPE}",
        "guest_photo_access": authorized,
        "refresh_token_ciphertext": "sealed-refresh",
        "refresh_token_iv": "sealed-iv",
    }


def _service(row: dict) -> GoogleConnectionService:
    service = GoogleConnectionService(db=Mock())
    service.is_configured = Mock(return_value=True)
    service._client_id = Mock(return_value="client-id")
    service._client_secret = Mock(return_value="client-secret")
    service._decrypt = Mock(return_value="refresh-secret")
    service._guest_photo_account = AsyncMock(return_value=row)
    service._post_form = AsyncMock(
        return_value={
            "access_token": "contacts-only",
            "token_type": "Bearer",
            "scope": CALENDAR_GUEST_PHOTO_SCOPE,
            "expires_in": 1800,
        }
    )
    return service


async def _request(
    service: GoogleConnectionService, row: dict, account_id: str = "default"
) -> dict:
    return await service.calendar_guest_photo_token(
        user_id="owner",
        account_id=account_id,
        expected_generation=connection_generation(row),
        expected_subject_sha256=hashlib.sha256(b"google-subject").hexdigest(),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("account_id", ["default", "second"])
async def test_photo_token_is_exact_scope_and_fenced_to_selected_account(account_id: str):
    row = _row()
    service = _service(row)

    result = await _request(service, row, account_id)

    assert result == {
        "access_token": "contacts-only",
        "expires_in": 1800,
        "account_email": "owner@example.com",
        "subject_sha256": hashlib.sha256(b"google-subject").hexdigest(),
        "grant_generation": connection_generation(row),
    }
    assert service._guest_photo_account.await_args_list[0].args == ("owner", account_id)
    assert service._post_form.await_args.args[1] == {
        "client_id": "client-id",
        "client_secret": "client-secret",
        "refresh_token": "refresh-secret",
        "grant_type": "refresh_token",
        "scope": CALENDAR_GUEST_PHOTO_SCOPE,
    }


@pytest.mark.asyncio
async def test_historical_calendar_grant_cannot_mint_a_photo_token():
    row = _row(authorized=False)
    service = _service(row)
    with pytest.raises(GoogleConnectionError) as failure:
        await _request(service, row)
    assert failure.value.status_code == 403
    service._post_form.assert_not_awaited()


@pytest.mark.asyncio
async def test_broader_or_unproven_google_scope_fails_closed():
    row = _row()
    service = _service(row)
    for scope in (
        f"{CALENDAR_GUEST_PHOTO_SCOPE} https://www.googleapis.com/auth/calendar.events",
        "",
    ):
        service._post_form.return_value = {
            "access_token": "broad",
            "token_type": "Bearer",
            "scope": scope,
            "expires_in": 1800,
        }
        with pytest.raises(GoogleConnectionError) as failure:
            await _request(service, row)
        assert failure.value.status_code == 502


@pytest.mark.asyncio
async def test_reconnect_or_disconnect_during_exchange_discards_token():
    row = _row()
    service = _service(row)
    service._guest_photo_account.side_effect = [row, {**row, "refresh_token_ciphertext": "rotated"}]
    with pytest.raises(GoogleConnectionError) as failure:
        await _request(service, row)
    assert failure.value.status_code == 409


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "account_id,marker",
    [
        ("default", "_mark_needs_reauth"),
        ("second", "_mark_additional_needs_reauth"),
    ],
)
async def test_invalid_refresh_marks_only_selected_connection_for_reauth(
    account_id: str, marker: str
):
    row = _row()
    service = _service(row)
    service._post_form.side_effect = GoogleConnectionError(
        "Google connection needs reauthorization", status_code=401
    )
    marked = AsyncMock()
    setattr(service, marker, marked)
    with pytest.raises(GoogleConnectionError) as failure:
        await _request(service, row, account_id)
    assert failure.value.status_code == 401
    marked.assert_awaited_once()
    assert marked.await_args.kwargs["expected_refresh_ciphertext"] == "sealed-refresh"
