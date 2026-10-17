"""Owner placement admission around the existing provider refresh lease and recovery flow."""

from __future__ import annotations

import asyncio
import secrets
from datetime import UTC, datetime, timedelta

from hushh_mcp.services.owner_placement_guard import admit_hub_content


async def current_credential(
    service, *, user_id: str, required_profile=None, cleanup: bool = False, refresh: bool = True
) -> tuple[dict, dict]:
    """Internal only. Execution additionally enforces policy before/after I/O."""
    from hushh_mcp.services.external_connector_google_oauth import (
        CONNECTOR_ID,
        DRIVE_FILE_SCOPE,
        DRIVE_POLICY,
        LIVE_SCOPES,
        REGISTRY_SCOPES,
        SCOPES,
        DriveOAuthError,
    )

    if not cleanup:
        await admit_hub_content(user_id, "drive_credential")
    row = await service.lifecycle.read(
        user_id=user_id, connector_id=CONNECTOR_ID, **({"purge": False} if not refresh else {})
    )
    if not row or row["status"] not in {"connected", "verifying"} or row["envelope_version"] != 2:
        raise DriveOAuthError("reconnect_required", status_code=401)
    if not cleanup:
        await admit_hub_content(user_id, "drive_credential_open")
    credential = service.credentials.open_credential(
        user_id=user_id, connector_id=CONNECTOR_ID, row=row
    )
    profile = credential.get("profile", "selected")
    if profile not in {"selected", "live"} or (
        required_profile is not None and profile != required_profile
    ):
        raise DriveOAuthError("reconnect_required", status_code=401)
    expected = set(LIVE_SCOPES if profile == "live" else SCOPES)
    scopes = set(credential.get("grantedScopes", []))
    allowed = (expected, expected | {DRIVE_FILE_SCOPE}) if profile == "live" else (expected,)
    if scopes not in allowed:
        raise DriveOAuthError("reconnect_required", status_code=401)
    connector, client_id, client_secret = await service._configuration()
    if profile == "live" and (
        connector.capability_policy != DRIVE_POLICY
        or set(connector.oauth_scopes) != set(REGISTRY_SCOPES)
    ):
        raise DriveOAuthError("connector_configuration_invalid", status_code=503)
    if credential.get("oauthClientId") != client_id:
        raise DriveOAuthError("reconnect_required", status_code=401)
    if not refresh or row["credential_expires_at"] > datetime.now(UTC) + timedelta(seconds=90):
        if not cleanup:
            await admit_hub_content(user_id, "drive_credential_return")
        return row, credential
    return await _refresh(
        service,
        user_id=user_id,
        row=row,
        credential=credential,
        profile=profile,
        client_id=client_id,
        client_secret=client_secret,
        cleanup=cleanup,
    )


async def _refresh(
    service,
    *,
    user_id: str,
    row: dict,
    credential: dict,
    profile: str,
    client_id: str,
    client_secret: str,
    cleanup: bool,
) -> tuple[dict, dict]:
    from hushh_mcp.services.external_connector_google_oauth import (
        CONNECTOR_ID,
        TOKEN_URL,
        DriveOAuthError,
    )

    common = dict(
        user_id=user_id,
        connector_id=CONNECTOR_ID,
        generation=row["connection_generation"],
        version=row["credential_version"],
    )
    lease_id = secrets.token_urlsafe(24)
    if not await service.lifecycle.claim_refresh(**common, lease_id=lease_id):
        raise DriveOAuthError("refresh_in_progress", status_code=409)
    try:
        if not cleanup:
            await admit_hub_content(user_id, "drive_refresh_dispatch")
        token = await service._post(
            TOKEN_URL,
            dict(
                grant_type="refresh_token",
                refresh_token=credential["refreshToken"],
                client_id=client_id,
                client_secret=client_secret,
            ),
        )
        refreshed = {
            **credential,
            **service._token_fields(token, previous=credential, profile=profile),
        }
        refreshed["refreshToken"] = refreshed.get("refreshToken") or credential["refreshToken"]
        if token.get("id_token"):
            identity = await asyncio.to_thread(
                service._verify_identity, token["id_token"], client_id=client_id, nonce=None
            )
            if identity["subject"] != credential["subject"]:
                raise DriveOAuthError("identity_not_verified", status_code=401)
            refreshed.update(identity)
        encrypted = service.credentials.seal_credential(
            user_id=user_id,
            connector_id=CONNECTOR_ID,
            generation=common["generation"],
            version=common["version"] + 1,
            secret=refreshed,
            expires_at=datetime.fromisoformat(refreshed["expiresAt"]),
        )
        if not await service.lifecycle.settle_refresh(
            **common, lease_id=lease_id, envelope=encrypted
        ):
            raise DriveOAuthError("connection_changed", status_code=409)
    except DriveOAuthError as error:
        await service.lifecycle.settle_refresh(
            **common, lease_id=lease_id, rejected=str(error) == "grant_rejected"
        )
        raise
    except BaseException:
        await asyncio.shield(service.lifecycle.settle_refresh(**common, lease_id=lease_id))
        raise
    return await _read_refreshed(service, common, cleanup=cleanup)


async def _read_refreshed(service, common: dict, *, cleanup: bool) -> tuple[dict, dict]:
    from hushh_mcp.services.external_connector_google_oauth import CONNECTOR_ID, DriveOAuthError

    user_id = common["user_id"]
    updated = await service.lifecycle.read(user_id=user_id, connector_id=CONNECTOR_ID)
    if (
        not updated
        or updated["connection_generation"] != common["generation"]
        or updated["status"] not in {"connected", "verifying"}
    ):
        raise DriveOAuthError("connection_changed", status_code=409)
    if not cleanup:
        await admit_hub_content(user_id, "drive_credential_return")
    return updated, service.credentials.open_credential(
        user_id=user_id, connector_id=CONNECTOR_ID, row=updated
    )
