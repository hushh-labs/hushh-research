"""Legacy meeting-chat Drive connector authority, separate from library browsing."""

from __future__ import annotations

import httpx

from hushh_mcp.services.calendar_meeting_common import ArtifactUnavailable
from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
from hushh_mcp.services.google_drive_adapter import (
    DRIVE_BASE,
    LIVE_POLICY_HASH,
    POLICY_HASH,
    DriveReadError,
    supports_selected_policy,
)


async def _check(service, user_id, grant, row, credential, *, connector_feature_enabled):
    profile = credential.get("profile", "selected")
    policy = LIVE_POLICY_HASH if profile == "live" else POLICY_HASH
    feature = "google_drive_live" if profile == "live" else "google_drive_picker"
    if profile == "selected":
        connector, _, _ = await service.oauth._configuration()
        if (
            connector.transport_kind != "google_drive_rest"
            or connector.mcp_endpoint != DRIVE_BASE
            or not supports_selected_policy(connector.capability_policy)
        ):
            raise ArtifactUnavailable("permission_required")
    await service.insights.calendar._check_read_binding(user_id, grant.binding)
    current = await service.oauth.lifecycle.read(user_id=user_id, connector_id="google_drive")
    if (
        not connector_feature_enabled(feature, user_id)
        or credential.get("subject") != grant.provider_subject
        or not current
        or current.get("status") != "connected"
        or current.get("validation_state") != "verified"
        or current.get("verified_policy_hash") != policy
        or current.get("connection_generation") != row["connection_generation"]
    ):
        raise ArtifactUnavailable("permission_required")


async def _text(service, user_id, grant, ref, token, profile, check, result):
    before = await service.drive.get_metadata(
        file_id=ref["file_id"],
        access_token=token,
        require_app_authorized=profile == "selected",
        require_genai_eligibility=True,
    )
    await check()
    mime, raw = await service.drive.read_live_bytes(
        file_id=ref["file_id"], mime_type=before.mime_type, access_token=token
    )
    await check()
    after = await service.drive.get_metadata(
        file_id=ref["file_id"],
        access_token=token,
        require_app_authorized=profile == "selected",
        require_genai_eligibility=True,
    )
    await check()
    if before != after:
        raise ArtifactUnavailable("source_changed")
    if mime != "text/plain":
        raise ArtifactUnavailable("unsupported_format")
    note = raw.decode("utf-8")
    result.update(text=note[:40000], truncated=len(note) > 40000, can_ask=bool(result["url"]))


async def _authorized_file(
    service, user_id, grant, ref, *, content, inspect_token, connector_feature_enabled, source_url
):
    result = {**ref, "state": "permission_required"}
    row, credential = await service.oauth.current_credential(user_id=user_id)
    profile = credential.get("profile", "selected")

    async def check():
        await _check(
            service,
            user_id,
            grant,
            row,
            credential,
            connector_feature_enabled=connector_feature_enabled,
        )

    await check()
    token = credential["accessToken"]
    scopes = await inspect_token(token, grant.provider_subject)
    permitted = {
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/drive.readonly",
    }
    if profile == "selected":
        permitted = {"https://www.googleapis.com/auth/drive.file"}
    if not scopes & permitted:
        raise ArtifactUnavailable("permission_required")
    await check()
    facts = await service.drive.get_file_facts(file_id=ref["file_id"], access_token=token)
    await check()
    link = source_url(facts.get("viewUrl"))
    result.update(state="available", title=facts["title"], url=link, can_ask=False)
    if content and ref["kind"] != "recording":
        await _text(service, user_id, grant, ref, token, profile, check, result)
    if await service.drive.get_file_facts(file_id=ref["file_id"], access_token=token) != facts:
        raise ArtifactUnavailable("source_changed")
    await check()
    return result


async def chat_file(
    service, user_id, grant, ref, *, content, inspect_token, connector_feature_enabled, source_url
):
    try:
        return await _authorized_file(
            service,
            user_id,
            grant,
            ref,
            content=content,
            inspect_token=inspect_token,
            connector_feature_enabled=connector_feature_enabled,
            source_url=source_url,
        )
    except ArtifactUnavailable as error:
        return {**ref, "state": error.state}
    except DriveOAuthError as error:
        return {
            **ref,
            "state": "temporarily_unavailable"
            if error.status_code >= 500 or str(error) == "refresh_in_progress"
            else "permission_required",
        }
    except DriveReadError as error:
        return {
            **ref,
            "state": "permission_required"
            if error.status_code == 403
            or str(error)
            in {"reconnect_required", "operation_not_allowed", "identity_not_verified"}
            else "temporarily_unavailable"
            if error.retryable or str(error) == "provider_response_invalid"
            else "unavailable",
        }
    except (UnicodeError, httpx.HTTPError):
        return {**ref, "state": "temporarily_unavailable"}
