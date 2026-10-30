"""Profile Connected Systems routes."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import AliasChoices, BaseModel, ConfigDict, Field

from api.middleware import require_vault_owner_token
from db.db_client import DatabaseExecutionError
from hushh_mcp.services.connected_systems_service import (
    ConnectedSystemsError,
    get_connected_systems_service,
)

router = APIRouter(prefix="/api/connected-systems", tags=["Connected Systems"])


class ConnectedSystemsResponse(BaseModel):
    systems: list[dict[str, Any]]


class CrmReadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    object_type: str | None = Field(
        default=None,
        validation_alias=AliasChoices("objectType", "object_type"),
        max_length=80,
    )
    email: str = Field(..., min_length=1, max_length=320)
    phone: str = Field(..., min_length=1, max_length=80)
    search_fields: dict[str, Any] | None = Field(
        default=None,
        validation_alias=AliasChoices("searchFields", "search_fields"),
    )
    return_fields: list[str] | None = Field(
        default=None,
        validation_alias=AliasChoices("returnFields", "return_fields"),
    )


class CrmSearchRequest(CrmReadRequest):
    pass


class CrmCreateIntentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    object_type: str | None = Field(
        default=None,
        validation_alias=AliasChoices("objectType", "object_type"),
        max_length=80,
    )
    email: str = Field(..., min_length=1, max_length=320)
    phone: str = Field(..., min_length=1, max_length=80)
    first_name: str | None = Field(
        default=None,
        validation_alias=AliasChoices("firstName", "first_name"),
        max_length=80,
    )
    last_name: str = Field(
        ...,
        validation_alias=AliasChoices("lastName", "last_name"),
        min_length=1,
        max_length=80,
    )
    additional_fields: dict[str, Any] | None = Field(
        default=None,
        validation_alias=AliasChoices("additionalFields", "additional_fields"),
    )


class CrmUpdateIntentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    object_type: str | None = Field(
        default=None,
        validation_alias=AliasChoices("objectType", "object_type"),
        max_length=80,
    )
    record_id: str = Field(
        ...,
        validation_alias=AliasChoices("id", "recordId", "record_id"),
        min_length=1,
        max_length=128,
    )
    additional_fields: dict[str, Any] = Field(
        ...,
        validation_alias=AliasChoices("additionalFields", "additional_fields"),
    )
    readback_locator: dict[str, Any] | None = Field(
        default=None,
        validation_alias=AliasChoices("readbackLocator", "readback_locator"),
    )


class CrmDeleteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    object_type: str | None = Field(
        default=None,
        validation_alias=AliasChoices("objectType", "object_type"),
        max_length=80,
    )
    record_id: str | None = Field(
        default=None,
        validation_alias=AliasChoices("id", "recordId", "record_id"),
        max_length=128,
    )


def _raise_connected_system_error(error: ConnectedSystemsError) -> None:
    raise HTTPException(
        status_code=error.status_code,
        detail={"code": error.code, "message": error.message},
    ) from error


def _raise_database_error(error: DatabaseExecutionError) -> None:
    status_code = 503 if error.status_code >= 500 else error.status_code
    code = (
        "CONNECTED_SYSTEMS_SCHEMA_NOT_READY"
        if "connected_system_" in error.details.lower() or "connected_system_" in str(error).lower()
        else error.code
    )
    message = (
        "Connected Systems workflow storage is not ready."
        if code == "CONNECTED_SYSTEMS_SCHEMA_NOT_READY"
        else "Connected Systems workflow storage is temporarily unavailable."
    )
    raise HTTPException(
        status_code=status_code,
        detail={"code": code, "message": message},
    ) from error


def _user_id(token_data: dict) -> str:
    return str(token_data.get("user_id") or "")


@router.get("", response_model=ConnectedSystemsResponse)
async def list_connected_systems(
    token_data: dict = Depends(require_vault_owner_token),
):
    _ = _user_id(token_data)
    service = get_connected_systems_service()
    return ConnectedSystemsResponse(systems=service.list_systems())


@router.get("/{system_id}/schema")
async def get_connected_system_schema(
    system_id: str = Path(..., min_length=1, max_length=128),
    object_type: str | None = Query(
        default=None,
        alias="objectType",
        max_length=80,
    ),
    token_data: dict = Depends(require_vault_owner_token),
):
    _ = _user_id(token_data)
    service = get_connected_systems_service()
    try:
        return await service.get_schema(system_id=system_id, object_type=object_type)
    except ConnectedSystemsError as error:
        _raise_connected_system_error(error)


@router.post("/{system_id}/records/read")
async def read_connected_system_record(
    body: CrmReadRequest,
    system_id: str = Path(..., min_length=1, max_length=128),
    token_data: dict = Depends(require_vault_owner_token),
):
    service = get_connected_systems_service()
    try:
        return await service.read_record(
            user_id=_user_id(token_data),
            system_id=system_id,
            object_type=body.object_type,
            email=body.email,
            phone=body.phone,
            search_fields=body.search_fields,
            return_fields=body.return_fields,
        )
    except ConnectedSystemsError as error:
        _raise_connected_system_error(error)


@router.get("/{system_id}/record-binding")
async def get_connected_system_record_binding(
    system_id: str = Path(..., min_length=1, max_length=128),
    object_type: str | None = Query(
        default=None,
        alias="objectType",
        max_length=80,
    ),
    token_data: dict = Depends(require_vault_owner_token),
):
    service = get_connected_systems_service()
    try:
        return service.get_record_binding(
            user_id=_user_id(token_data),
            system_id=system_id,
            object_type=object_type,
        )
    except ConnectedSystemsError as error:
        _raise_connected_system_error(error)
    except DatabaseExecutionError as error:
        _raise_database_error(error)


@router.post("/{system_id}/records/search")
async def search_connected_system_record(
    body: CrmSearchRequest,
    system_id: str = Path(..., min_length=1, max_length=128),
    token_data: dict = Depends(require_vault_owner_token),
):
    service = get_connected_systems_service()
    try:
        return await service.search_record(
            user_id=_user_id(token_data),
            system_id=system_id,
            object_type=body.object_type,
            email=body.email,
            phone=body.phone,
            search_fields=body.search_fields,
            return_fields=body.return_fields,
        )
    except ConnectedSystemsError as error:
        _raise_connected_system_error(error)
    except DatabaseExecutionError as error:
        _raise_database_error(error)


@router.post("/{system_id}/records/create-intents")
async def create_connected_system_record_intent(
    body: CrmCreateIntentRequest,
    system_id: str = Path(..., min_length=1, max_length=128),
    token_data: dict = Depends(require_vault_owner_token),
):
    service = get_connected_systems_service()
    try:
        return service.create_record_intent(
            user_id=_user_id(token_data),
            system_id=system_id,
            object_type=body.object_type,
            email=body.email,
            phone=body.phone,
            first_name=body.first_name,
            last_name=body.last_name,
            additional_fields=body.additional_fields,
        )
    except ConnectedSystemsError as error:
        _raise_connected_system_error(error)
    except DatabaseExecutionError as error:
        _raise_database_error(error)


@router.post("/{system_id}/records/update-intents")
async def update_connected_system_record_intent(
    body: CrmUpdateIntentRequest,
    system_id: str = Path(..., min_length=1, max_length=128),
    token_data: dict = Depends(require_vault_owner_token),
):
    service = get_connected_systems_service()
    try:
        return service.update_record_intent(
            user_id=_user_id(token_data),
            system_id=system_id,
            object_type=body.object_type,
            record_id=body.record_id,
            additional_fields=body.additional_fields,
            readback_locator=body.readback_locator,
        )
    except ConnectedSystemsError as error:
        _raise_connected_system_error(error)
    except DatabaseExecutionError as error:
        _raise_database_error(error)


@router.post("/{system_id}/records/delete")
async def delete_connected_system_record(
    body: CrmDeleteRequest,
    system_id: str = Path(..., min_length=1, max_length=128),
    token_data: dict = Depends(require_vault_owner_token),
):
    service = get_connected_systems_service()
    try:
        return await service.delete_record(
            user_id=_user_id(token_data),
            system_id=system_id,
            object_type=body.object_type,
            record_id=body.record_id,
        )
    except ConnectedSystemsError as error:
        _raise_connected_system_error(error)
    except DatabaseExecutionError as error:
        _raise_database_error(error)


@router.post("/{system_id}/intents/{intent_id}/approve")
async def approve_connected_system_intent(
    system_id: str = Path(..., min_length=1, max_length=128),
    intent_id: str = Path(..., min_length=1, max_length=128),
    token_data: dict = Depends(require_vault_owner_token),
):
    service = get_connected_systems_service()
    try:
        return await service.approve_intent(
            user_id=_user_id(token_data),
            system_id=system_id,
            intent_id=intent_id,
        )
    except ConnectedSystemsError as error:
        _raise_connected_system_error(error)
    except DatabaseExecutionError as error:
        _raise_database_error(error)


@router.post("/{system_id}/intents/{intent_id}/reject")
async def reject_connected_system_intent(
    system_id: str = Path(..., min_length=1, max_length=128),
    intent_id: str = Path(..., min_length=1, max_length=128),
    token_data: dict = Depends(require_vault_owner_token),
):
    service = get_connected_systems_service()
    try:
        return service.reject_intent(
            user_id=_user_id(token_data),
            system_id=system_id,
            intent_id=intent_id,
        )
    except ConnectedSystemsError as error:
        _raise_connected_system_error(error)
    except DatabaseExecutionError as error:
        _raise_database_error(error)
