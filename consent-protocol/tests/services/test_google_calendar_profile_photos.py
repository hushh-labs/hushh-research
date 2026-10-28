"""Account-bound Google Calendar profile photo presentation."""

import hashlib
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from hushh_mcp.services.google_calendar_profile_photo import _google_picture_url
from hushh_mcp.services.google_connection_service import GoogleConnectionService
from hushh_mcp.services.google_oauth_attempt import connection_generation


@pytest.mark.asyncio
async def test_additional_calendar_account_does_not_impersonate_default_status():
    service = GoogleConnectionService(db=Mock())
    service.status = AsyncMock(
        return_value={
            "configured": True,
            "connected": False,
            "google_email": None,
            "status": "disconnected",
            "access_level": None,
            "scope_csv": "",
            "calendar_list_access": False,
        }
    )
    service._execute_raw_async = AsyncMock(
        return_value=SimpleNamespace(
            data=[
                {
                    "account_id": "second",
                    "provider_subject": "google-second",
                    "provider_email": "second@example.com",
                    "refresh_token_ciphertext": "second-generation",
                    "status": "connected",
                    "scope_csv": "",
                    "access_level": "manage",
                }
            ]
        )
    )
    service._calendar_picture = AsyncMock(
        return_value={
            "picture_url": "https://lh4.googleusercontent.com/a/second=s96-c",
            "hosted_domain": "example.com",
        }
    )

    result = await service.calendar_accounts_status(user_id="owner")

    assert result["connected"] is False
    assert result["google_email"] is None
    assert result["accounts"] == [
        {
            "account_id": "second",
            "google_email": "second@example.com",
            "profile_photo_url": "https://lh4.googleusercontent.com/a/second=s96-c",
            "hosted_domain": "example.com",
            "provider_subject_sha256": hashlib.sha256(b"google-second").hexdigest(),
            "status": "connected",
            "connected": True,
            "access_level": "manage",
            "scope_csv": "",
            "grant_generation": connection_generation(
                {
                    "provider_subject": "google-second",
                    "refresh_token_ciphertext": "second-generation",
                    "status": "connected",
                }
            ),
            "calendar_list_access": False,
        }
    ]


def test_google_profile_picture_accepts_only_google_avatar_urls():
    valid = "https://lh3.googleusercontent.com/a/ACg8oc_example=s96-c"
    assert _google_picture_url(valid) == valid
    for value in (
        "https://example.com/a/photo",
        "http://lh3.googleusercontent.com/a/photo",
        "https://lh3.googleusercontent.com/a/photo?token=secret",
        "https://lh3.googleusercontent.com.evil.test/a/photo",
        "javascript:alert(1)",
    ):
        assert _google_picture_url(value) is None


@pytest.mark.asyncio
async def test_calendar_picture_checks_subject_and_connection_generation():
    service = GoogleConnectionService(db=Mock())
    row = {
        "status": "connected",
        "provider_subject": "google-second",
        "refresh_token_ciphertext": "generation-one",
    }
    service.access_token = AsyncMock(return_value="synthetic-token")
    service._userinfo = AsyncMock(
        return_value={
            "sub": "google-second",
            "picture": "https://lh3.googleusercontent.com/a/second=s96-c",
        }
    )
    service._calendar_account = AsyncMock(return_value=row)

    photo = await service._calendar_picture(user_id="owner", account_id="second", row=row)
    assert photo == {
        "picture_url": "https://lh3.googleusercontent.com/a/second=s96-c",
        "hosted_domain": None,
    }
    assert service.access_token.await_args.kwargs["account_id"] == "second"
    assert await service._calendar_picture(user_id="owner", account_id="second", row=row) == photo
    service._userinfo.assert_awaited_once()

    other_generation = {**row, "refresh_token_ciphertext": "generation-two"}
    service._calendar_account.return_value = other_generation
    assert (
        await service._calendar_picture(user_id="owner", account_id="second", row=other_generation)
        == photo
    )
    assert service._userinfo.await_count == 2

    foreign = {**row, "provider_subject": "google-foreign"}
    service._calendar_account.return_value = foreign
    assert (
        await service._calendar_picture(user_id="owner", account_id="second", row=foreign) is None
    )


@pytest.mark.asyncio
async def test_calendar_picture_discards_result_after_reconnect():
    service = GoogleConnectionService(db=Mock())
    old = {
        "status": "connected",
        "provider_subject": "google-second",
        "refresh_token_ciphertext": "old-generation",
    }
    service.access_token = AsyncMock(return_value="synthetic-token")
    service._userinfo = AsyncMock(
        return_value={
            "sub": "google-second",
            "picture": "https://lh3.googleusercontent.com/a/old",
        }
    )
    service._calendar_account = AsyncMock(
        return_value={
            **old,
            "refresh_token_ciphertext": "new-generation",
        }
    )

    assert await service._calendar_picture(user_id="owner", account_id="second", row=old) is None
    assert not service._calendar_photos.cache


@pytest.mark.asyncio
async def test_photo_lookup_does_not_return_stale_connected_status():
    service = GoogleConnectionService(db=Mock())
    connected = {
        "configured": True,
        "connected": True,
        "google_email": "owner@example.com",
        "status": "connected",
        "access_level": "read",
        "scope_csv": "",
    }
    service.status = AsyncMock(
        side_effect=[
            connected,
            {**connected, "connected": False, "status": "needs_reauth"},
        ]
    )
    service._connection = AsyncMock(
        return_value={
            "status": "connected",
            "provider_subject": "google-owner",
            "refresh_token_ciphertext": "first-generation",
        }
    )
    service._execute_raw_async = AsyncMock(return_value=SimpleNamespace(data=[]))
    service._calendar_picture = AsyncMock(return_value=None)

    result = await service.calendar_accounts_status(user_id="owner")

    assert result["accounts"][0]["status"] == "needs_reauth"
    assert result["accounts"][0]["connected"] is False
    assert result["accounts"][0]["profile_photo_url"] is None


@pytest.mark.asyncio
async def test_calendar_account_photos_remain_bound_to_each_google_subject():
    service = GoogleConnectionService(db=Mock())
    service.status = AsyncMock(
        return_value={
            "configured": True,
            "connected": True,
            "google_email": "owner@example.com",
            "status": "connected",
            "access_level": "read",
            "scope_csv": "",
        }
    )
    service._connection = AsyncMock(
        return_value={
            "status": "connected",
            "provider_subject": "google-owner",
            "refresh_token_ciphertext": "owner-generation",
        }
    )
    additional = [
        {
            "account_id": account_id,
            "provider_subject": subject,
            "provider_email": email,
            "refresh_token_ciphertext": f"{account_id}-generation",
            "status": "connected",
            "scope_csv": "",
            "access_level": "read",
        }
        for account_id, subject, email in (
            ("second", "google-second", "second@example.com"),
            ("third", "google-third", "third@example.com"),
        )
    ]
    service._execute_raw_async = AsyncMock(return_value=SimpleNamespace(data=additional))
    service._calendar_picture = AsyncMock(
        side_effect=lambda *, account_id, **_: {
            "picture_url": f"https://lh3.googleusercontent.com/a/{account_id}",
            "hosted_domain": None,
        }
    )

    result = await service.calendar_accounts_status(user_id="owner")

    assert [item["profile_photo_url"] for item in result["accounts"]] == [
        "https://lh3.googleusercontent.com/a/default",
        "https://lh3.googleusercontent.com/a/second",
        "https://lh3.googleusercontent.com/a/third",
    ]
