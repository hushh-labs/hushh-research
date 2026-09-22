"""Owner-level Location sharing posture and voice-first setup progress.

Kept in its own router (same ``/api/one/location`` prefix) so the legacy
``workflow.setup.location`` contract, which is derived from
``api.routes.one.location``, does not acquire new executors. These routes are
the shared contract for the tap UI and the One Live Voice tools.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import ConfigDict, Field

from api.middleware import require_vault_owner_token
from api.routes.one.location import _CamelModel, _handle_error, _service, _user_id

router = APIRouter(prefix="/api/one", tags=["One Location"])


class UpdateAccountSettingsRequest(_CamelModel):
    """Owner-level sharing posture (migration 221). Every field optional; the
    tap UI and the voice tools share this one contract."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    sharing_state: Literal["on", "off"] | None = Field(default=None, alias="sharingState")
    precision: Literal["precise", "approximate"] | None = None
    include_sos: bool = Field(default=False, alias="includeSos")
    consent_version: str | None = Field(default=None, alias="consentVersion", max_length=80)
    os_permission_reported: Literal["unknown", "prompt", "granted", "denied"] | None = Field(
        default=None, alias="osPermissionReported"
    )


class AdvanceSetupProgressRequest(_CamelModel):
    """One setup transition per call; the service enforces the order."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    action: Literal[
        "start",
        "accept_consent",
        "record_os_permission",
        "set_precision",
        "confirm_recipient_key",
        "complete",
    ]
    consent_version: str | None = Field(default=None, alias="consentVersion", max_length=80)
    os_permission_state: Literal["unknown", "prompt", "granted", "denied"] | None = Field(
        default=None, alias="osPermissionState"
    )
    precision: Literal["precise", "approximate"] | None = None


def _account_settings_service():
    from hushh_mcp.services.one_location_account_settings_service import (
        OneLocationAccountSettingsService,
    )

    return OneLocationAccountSettingsService(_service())


def _setup_service():
    from hushh_mcp.services.one_location_setup_service import OneLocationSetupService

    return OneLocationSetupService(_account_settings_service())


@router.get("/location/account-settings")
def get_location_account_settings(token_data: dict = Depends(require_vault_owner_token)):
    """Owner-level sharing posture: on/off, precision, last reported OS permission."""
    try:
        return {
            "settings": _account_settings_service().get(user_id=_user_id(token_data)).as_payload()
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.patch("/location/account-settings")
def update_location_account_settings(
    payload: UpdateAccountSettingsRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    """Apply one or more posture changes. ``sharingState='off'`` revokes every
    active share and link in the same transaction (SOS lane needs ``includeSos``)."""
    user_id = _user_id(token_data)
    service = _account_settings_service()
    try:
        transition = None
        if payload.consent_version and payload.sharing_state != "on":
            service.record_consent(user_id=user_id, consent_version=payload.consent_version)
        if payload.os_permission_reported is not None:
            service.record_os_permission(user_id=user_id, state=payload.os_permission_reported)
        if payload.precision is not None:
            service.set_precision(user_id=user_id, precision=payload.precision)
        if payload.sharing_state is not None:
            transition = service.set_sharing_state(
                user_id=user_id,
                state=payload.sharing_state,
                include_sos=payload.include_sos,
                consent_version=payload.consent_version,
            )
        settings = transition.settings if transition else service.get(user_id=user_id)
        body: dict[str, Any] = {"settings": settings.as_payload()}
        if transition is not None:
            body["transition"] = transition.as_payload()
        return body
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.get("/location/setup-progress")
def get_location_setup_progress(token_data: dict = Depends(require_vault_owner_token)):
    """Server-side setup step so a refresh resumes exactly where the person was."""
    try:
        return {"progress": _setup_service().get(user_id=_user_id(token_data)).as_payload()}
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.patch("/location/setup-progress")
def advance_location_setup_progress(
    payload: AdvanceSetupProgressRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    user_id = _user_id(token_data)
    service = _setup_service()
    try:
        if payload.action == "start":
            progress = service.start(user_id=user_id)
        elif payload.action == "accept_consent":
            if not payload.consent_version:
                raise HTTPException(
                    status_code=422,
                    detail={
                        "code": "LOCATION_SETUP_CONSENT_INVALID",
                        "message": "consentVersion is required.",
                    },
                )
            progress = service.accept_consent(
                user_id=user_id, consent_version=payload.consent_version
            )
        elif payload.action == "record_os_permission":
            progress = service.record_os_permission(
                user_id=user_id, state=payload.os_permission_state or "unknown"
            )
        elif payload.action == "set_precision":
            progress = service.set_precision(
                user_id=user_id, precision=payload.precision or "precise"
            )
        elif payload.action == "confirm_recipient_key":
            progress = service.confirm_recipient_key(user_id=user_id)
        else:
            progress = service.complete(user_id=user_id)
        return {"progress": progress.as_payload()}
    except HTTPException:
        raise
    except Exception as exc:
        raise _handle_error(exc) from exc
