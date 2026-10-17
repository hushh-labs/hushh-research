"""Owner placement admission around the existing provider refresh lease and recovery flow."""

from __future__ import annotations

import asyncio
import secrets
from datetime import UTC, datetime
from typing import Any

from hushh_mcp.services.owner_placement_guard import admit_hub_content


async def validated_connection(
    service, *, user_id: str, connector_id: str, connector=None
) -> tuple[dict, Any, str, str | None]:
    """Current placement and registry metadata, without opening or refreshing a credential."""
    from hushh_mcp.services.external_connector_curated_oauth import (
        CuratedConnectorOAuthError,
        CuratedNotConnectedError,
        curated_policy_hash,
    )

    await admit_hub_content(user_id, "curated_credential")
    row = await service.lifecycle.read(user_id=user_id, connector_id=connector_id, purge=False)
    if not row or row["status"] == "revoked":
        # Never connected, or the person disconnected it: nothing to report.
        raise CuratedNotConnectedError()
    if row["status"] not in {"connected", "verifying"} or row["envelope_version"] != 2:
        # needs_reauth (the provider rejected the refresh token), error, or a legacy
        # envelope: the person did connect it and it stopped working, so say so.
        raise CuratedConnectorOAuthError("reconnect_required", status_code=401)
    connector, client_id, client_secret = await service._configuration(connector_id, connector)
    # Check the registry hasn't drifted from what was consented to BEFORE
    # any decrypt or provider call: an operator edit (endpoint, token
    # URL, client) must force reconnect, never silently carry an old
    # refresh token or access token to a changed target.
    if row.get("verified_policy_hash") not in (None, curated_policy_hash(connector)):
        raise CuratedConnectorOAuthError("reconnect_required", status_code=401)
    await admit_hub_content(user_id, "curated_connection_snapshot_return")
    return row, connector, client_id, client_secret


async def current_credential(
    service, *, user_id: str, connector_id: str, connector=None
) -> tuple[dict, dict]:
    """Internal only. Execution additionally enforces chat admission and
    the review policy before/after any tool call. `connector` is the live
    registry row when the caller already holds it."""
    from hushh_mcp.services.external_connector_curated_oauth import (
        _REFRESH_MARGIN,
        CuratedConnectorOAuthError,
    )

    row, connector, client_id, client_secret = await validated_connection(
        service, user_id=user_id, connector_id=connector_id, connector=connector
    )
    await admit_hub_content(user_id, "curated_credential_open")
    credential = service.credentials.open_credential(
        user_id=user_id, connector_id=connector_id, row=row
    )
    if credential.get("oauthClientId") != client_id:
        raise CuratedConnectorOAuthError("reconnect_required", status_code=401)
    if row["credential_expires_at"] > datetime.now(UTC) + _REFRESH_MARGIN:
        await admit_hub_content(user_id, "curated_credential_return")
        return row, credential
    return await _refresh(
        service,
        user_id=user_id,
        connector_id=connector_id,
        row=row,
        credential=credential,
        connector=connector,
        client_id=client_id,
        client_secret=client_secret,
    )


async def _refresh(
    service,
    *,
    user_id: str,
    connector_id: str,
    row: dict,
    credential: dict,
    connector,
    client_id: str,
    client_secret: str | None,
) -> tuple[dict, dict]:
    from hushh_mcp.services.external_connector_curated_oauth import (
        _REFRESH_POST_TIMEOUT,
        CuratedConnectorOAuthError,
    )

    common = dict(
        user_id=user_id,
        connector_id=connector_id,
        generation=row["connection_generation"],
        version=row["credential_version"],
    )
    lease_id = secrets.token_urlsafe(24)
    if not await service.lifecycle.claim_refresh(**common, lease_id=lease_id):
        # Another caller holds the lease (parallel tool calls at the margin).
        # Give it a moment to persist, then use its fresh credential.
        await admit_hub_content(user_id, "curated_credential_return")
        return await service._await_concurrent_refresh(
            user_id=user_id,
            connector_id=connector_id,
            generation=row["connection_generation"],
            client_id=client_id,
        )
    refreshed: dict[str, Any] | None = None
    try:
        await admit_hub_content(user_id, "curated_refresh_dispatch")
        token = await service._post(
            connector.oauth_token_url,
            token_url=connector.oauth_token_url,
            data=dict(
                grant_type="refresh_token",
                refresh_token=credential["refreshToken"],
                **service._client_auth(client_id, client_secret),
            ),
            timeout_seconds=_REFRESH_POST_TIMEOUT,
        )
        refreshed = {**credential, **service._token_fields(token)}
        # RFC 6749 doesn't require a refresh grant to return a new
        # refresh token; HubSpot's is documented as single-use and
        # rotating, so a provider that omits one here is treated as
        # keeping the prior token valid, not as revoking it.
        refreshed["refreshToken"] = refreshed.get("refreshToken") or credential["refreshToken"]
        encrypted = service.credentials.seal_credential(
            user_id=user_id,
            connector_id=connector_id,
            generation=common["generation"],
            version=common["version"] + 1,
            secret=refreshed,
            expires_at=datetime.fromisoformat(refreshed["expiresAt"]),
        )
        await service._persist_refresh(common, lease_id, encrypted)
    except CuratedConnectorOAuthError as error:
        await service.lifecycle.settle_refresh(
            **common, lease_id=lease_id, rejected=str(error) == "grant_rejected"
        )
        if str(error) == "connection_changed" and refreshed is not None:
            # The person disconnected while the provider was rotating the token. The
            # new pair was never stored, so nothing here can ever revoke it later.
            await service._revoke_unstored(connector_id, client_id, client_secret, refreshed)
        raise
    except BaseException:
        # Cancellation (the chat turn's deadline) or a storage failure: never
        # leave the lease held. Shielded so a cancel cannot skip the release.
        await asyncio.shield(service._release_lease(common, lease_id))
        raise
    return await _read_refreshed(service, common, refreshed, client_id, client_secret)


async def _read_refreshed(
    service, common: dict, refreshed: dict, client_id: str, client_secret: str | None
) -> tuple[dict, dict]:
    from hushh_mcp.services.external_connector_curated_oauth import CuratedConnectorOAuthError

    user_id, connector_id = common["user_id"], common["connector_id"]
    updated = await service.lifecycle.read(user_id=user_id, connector_id=connector_id, purge=False)
    if (
        not updated
        or updated["connection_generation"] != common["generation"]
        or updated["status"] not in {"connected", "verifying"}
    ):
        await service._revoke_unstored(connector_id, client_id, client_secret, refreshed)
        raise CuratedConnectorOAuthError("connection_changed", status_code=409)
    await admit_hub_content(user_id, "curated_credential_return")
    return updated, service.credentials.open_credential(
        user_id=user_id, connector_id=connector_id, row=updated
    )
