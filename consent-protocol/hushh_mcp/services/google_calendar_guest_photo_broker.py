"""Exchange an authorized Calendar grant for one narrow browser photo token."""

from __future__ import annotations

import hashlib
import hmac
from typing import Any, Protocol

from hushh_mcp.services.google_connection_contract import (
    CALENDAR_GUEST_PHOTO_SCOPE,
    GoogleConnectionError,
    GoogleService,
)
from hushh_mcp.services.google_oauth_attempt import connection_generation


class GuestPhotoTokenPort(Protocol):
    def is_configured(self) -> bool: ...

    async def _guest_photo_account(
        self, user_id: str, account_id: str
    ) -> dict[str, Any] | None: ...

    def _decrypt(self, envelope: dict[str, Any], *, aad: str) -> str: ...

    def _calendar_account_aad(self, user_id: str, account_id: str) -> str: ...

    def _client_id(self) -> str: ...

    def _client_secret(self) -> str: ...

    async def _post_form(self, url: str, data: dict[str, str]) -> dict[str, Any]: ...

    async def _mark_needs_reauth(
        self, *, user_id: str, service: GoogleService, expected_refresh_ciphertext: str
    ) -> None: ...

    async def _mark_additional_needs_reauth(
        self, *, user_id: str, account_id: str, expected_refresh_ciphertext: str
    ) -> None: ...


def _authorized(
    row: dict[str, Any] | None,
    *,
    account_id: str,
    expected_generation: str,
    expected_subject_sha256: str,
) -> bool:
    if not row or row.get("status") != "connected":
        return False
    if account_id == "default" and row.get("grant_status") != "connected":
        return False
    subject = str(row.get("provider_subject") or "").strip()
    return bool(
        row.get("guest_photo_access")
        and CALENDAR_GUEST_PHOTO_SCOPE in set(str(row.get("scope_csv") or "").split())
        and row.get("refresh_token_ciphertext")
        and row.get("refresh_token_iv")
        and connection_generation(row) == expected_generation
        and subject
        and hmac.compare_digest(
            hashlib.sha256(subject.encode()).hexdigest(), expected_subject_sha256
        )
    )


async def _refresh_photo_token(
    port: GuestPhotoTokenPort,
    *,
    user_id: str,
    account_id: str,
    row: dict[str, Any],
    token_url: str,
) -> dict[str, Any]:
    refresh_token = port._decrypt(
        {"ciphertext": row["refresh_token_ciphertext"], "iv": row["refresh_token_iv"]},
        aad=(
            f"google-connection:{user_id}"
            if account_id == "default"
            else port._calendar_account_aad(user_id, account_id)
        ),
    )
    try:
        return await port._post_form(
            token_url,
            {
                "client_id": port._client_id(),
                "client_secret": port._client_secret(),
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
                "scope": CALENDAR_GUEST_PHOTO_SCOPE,
            },
        )
    except GoogleConnectionError as exc:
        if exc.status_code == 401:
            if account_id == "default":
                await port._mark_needs_reauth(
                    user_id=user_id,
                    service="calendar",
                    expected_refresh_ciphertext=row["refresh_token_ciphertext"],
                )
            else:
                await port._mark_additional_needs_reauth(
                    user_id=user_id,
                    account_id=account_id,
                    expected_refresh_ciphertext=row["refresh_token_ciphertext"],
                )
        raise


async def exchange_guest_photo_token(
    port: GuestPhotoTokenPort,
    *,
    user_id: str,
    account_id: str,
    expected_generation: str,
    expected_subject_sha256: str,
    token_url: str,
) -> dict[str, Any]:
    """Return only a short-lived Contacts bearer after grant and generation checks."""
    if not port.is_configured():
        raise GoogleConnectionError("Google photo access is unavailable", status_code=503)
    row = await port._guest_photo_account(user_id, account_id)
    if row is None or not _authorized(
        row,
        account_id=account_id,
        expected_generation=expected_generation,
        expected_subject_sha256=expected_subject_sha256,
    ):
        raise GoogleConnectionError("Calendar photo access is unavailable", status_code=403)
    token = await _refresh_photo_token(
        port,
        user_id=user_id,
        account_id=account_id,
        row=row,
        token_url=token_url,
    )
    if (
        set(str(token.get("scope") or "").strip().split()) != {CALENDAR_GUEST_PHOTO_SCOPE}
        or str(token.get("token_type") or "").strip().lower() != "bearer"
        or not str(token.get("access_token") or "").strip()
    ):
        raise GoogleConnectionError("Google did not return photo-only access", status_code=502)
    try:
        ttl = int(token.get("expires_in"))
    except (TypeError, ValueError):
        ttl = 0
    if ttl <= 0:
        raise GoogleConnectionError("Google photo access has no expiry", status_code=502)
    current = await port._guest_photo_account(user_id, account_id)
    if (
        not _authorized(
            current,
            account_id=account_id,
            expected_generation=expected_generation,
            expected_subject_sha256=expected_subject_sha256,
        )
        or current["refresh_token_ciphertext"] != row["refresh_token_ciphertext"]
    ):
        raise GoogleConnectionError("Calendar connection changed", status_code=409)
    return {
        "access_token": token["access_token"],
        "expires_in": min(ttl, 3600),
        "account_email": str(current.get("provider_email") or "").strip().lower(),
        "subject_sha256": expected_subject_sha256,
        "grant_generation": expected_generation,
    }
