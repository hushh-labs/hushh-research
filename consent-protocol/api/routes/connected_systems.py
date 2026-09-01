"""Profile Connected Systems routes."""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Path, Query
from pydantic import AliasChoices, BaseModel, ConfigDict, Field

from api.middleware import require_firebase_auth, require_vault_owner_token
from hushh_mcp.services.connected_systems_service import (
    ConnectedSystemConfigurationError,
    ConnectedSystemsError,
    ConnectedSystemValidationError,
    get_connected_systems_service,
)
from hushh_mcp.services.crm_product_availability import crm_product_available
from hushh_mcp.services.crm_schema_mapping_service import (
    CrmSchemaMappingError,
    get_crm_schema_mapping_service,
)


def _require_local_crm_product() -> None:
    if not crm_product_available():
        raise HTTPException(status_code=404, detail="Not found")


router = APIRouter(
    prefix="/api/connected-systems",
    tags=["Connected Systems"],
    dependencies=[Depends(_require_local_crm_product)],
)


class ConnectedSystemsResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    systems: list[dict[str, Any]]
    registry_revision: int = Field(alias="registryRevision")


class CrmReadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    object_type: str | None = Field(
        default=None,
        validation_alias=AliasChoices("objectType", "object_type"),
        max_length=80,
    )
    return_fields: list[str] | None = Field(
        default=None,
        validation_alias=AliasChoices("returnFields", "return_fields"),
    )


class CrmSearchRequest(CrmReadRequest):
    force_refresh: bool = Field(
        default=False,
        validation_alias=AliasChoices("forceRefresh", "force_refresh"),
        description=(
            "Bypass the bound-read cache and re-search the CRM. When false "
            "(default) and an active record binding exists, the bound record id "
            "is returned without an MCP search call."
        ),
    )


class CrmCreateIntentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    object_type: str | None = Field(
        default=None,
        validation_alias=AliasChoices("objectType", "object_type"),
        max_length=80,
    )


class CrmUpdateIntentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    object_type: str | None = Field(
        default=None,
        validation_alias=AliasChoices("objectType", "object_type"),
        max_length=80,
    )
    additional_fields: dict[str, Any] | None = Field(
        default=None,
        validation_alias=AliasChoices("additionalFields", "additional_fields"),
    )
    record_fields: dict[str, Any] | None = Field(
        default=None,
        validation_alias=AliasChoices("recordFields", "record_fields"),
        description="Schema-driven update field diff. Legacy additionalFields remains supported.",
    )


class CrmEncryptedFieldsReadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    object_type: str | None = Field(
        default=None,
        validation_alias=AliasChoices("objectType", "object_type"),
        max_length=80,
    )
    return_fields: list[str] = Field(
        validation_alias=AliasChoices("returnFields", "return_fields"),
        min_length=1,
        max_length=128,
    )
    encrypted_fields: dict[str, Any] = Field(
        validation_alias=AliasChoices("encryptedFields", "encrypted_fields")
    )


class CrmEncryptedFieldsUpdateIntentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    object_type: str | None = Field(
        default=None,
        validation_alias=AliasChoices("objectType", "object_type"),
        max_length=80,
    )
    field_names: list[str] = Field(
        validation_alias=AliasChoices("fieldNames", "field_names"),
        min_length=1,
        max_length=128,
    )
    encrypted_fields: dict[str, Any] = Field(
        validation_alias=AliasChoices("encryptedFields", "encrypted_fields")
    )


class CrmDeleteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    object_type: str | None = Field(
        default=None,
        validation_alias=AliasChoices("objectType", "object_type"),
        max_length=80,
    )


def _raise_connected_system_error(error: ConnectedSystemsError) -> None:
    raise HTTPException(
        status_code=error.status_code,
        detail={"code": error.code, "message": error.message},
    ) from error


def _user_id(token_data: dict) -> str:
    return str(token_data.get("user_id") or "")


def _schema_mapping_crm_id(*, service: Any, system_id: str) -> str:
    """Resolve the registry parent key used by the schema-mapping cache.

    Public system identifiers are stable connector handles and may differ from
    the registry's internal ``crm_id`` primary key. Mapping cache rows must use
    the parent key so every dynamically registered CRM satisfies the FK.
    """
    system = service.get_system(system_id)
    return str(system.registry_id or system.system_id)


def _operation_object_type(*, service: Any, system_id: str, operation: str) -> str:
    """Registry, not the browser, owns the CRM object used by each action."""
    system = service.get_system(system_id)
    resolver = getattr(system, "object_type_for_operation", None)
    if callable(resolver):
        return str(resolver(operation))
    return str(getattr(system, "object_type_default", "Contact"))


async def _resolve_schema_mapping(
    *,
    service: Any,
    system_id: str,
    object_type: str | None,
    force_refresh: bool = False,
) -> tuple[dict[str, Any], dict[str, str]]:
    """Fetch public schema then resolve its private-agent mapping.

    The mapper receives the normalized schema only. It never receives the
    authenticated user, their verified values, a CRM record, or credentials.
    """
    schema = await service.get_schema(
        system_id=system_id,
        object_type=object_type,
        force_refresh=force_refresh,
        require_fresh=True,
    )
    resolved = await get_crm_schema_mapping_service().resolve(
        crm_id=_schema_mapping_crm_id(service=service, system_id=system_id),
        schema=schema,
        force_refresh=force_refresh,
    )
    return schema, resolved.mapping


def _schema_catalogue_only(schema: dict[str, Any]) -> dict[str, Any]:
    return {
        **schema,
        "profileFieldMappings": {},
        "schemaMappingStatus": "unavailable",
        "effectiveActions": {
            "schema": True,
            "read": False,
            "create": False,
            "update": False,
            "delete": False,
        },
        "configurationMessage": (
            "This CRM field catalogue is available, but its onboarding field mapping "
            "is temporarily unavailable. Record actions stay disabled until it refreshes."
        ),
    }


async def _require_schema_mapping(
    *, service: Any, system_id: str, object_type: str | None, force_refresh: bool = False
) -> dict[str, str]:
    try:
        _schema, mapping = await _resolve_schema_mapping(
            service=service,
            system_id=system_id,
            object_type=object_type,
            force_refresh=force_refresh,
        )
        return mapping
    except CrmSchemaMappingError as error:
        raise ConnectedSystemConfigurationError(
            "This CRM needs a verified field mapping before record actions can run.",
            code=error.code,
        ) from error


async def _require_signed_in_lister(
    background_tasks: BackgroundTasks,
    authorization: Optional[str] = Header(
        None, description="Bearer token: Firebase ID token or VAULT_OWNER consent token"
    ),
) -> str:
    """Auth for the list endpoint: signed-in is enough, vault unlock is not required.

    The listing exposes CRM registry metadata only (name, type, status,
    transport) - no user records and no vault-protected data - so a Firebase
    ID token is the correct boundary. VAULT_OWNER consent tokens also pass so
    in-app agent lanes that already hold one keep working. Record-level
    routes below still require the vault owner token.
    """
    raw = str(authorization or "").strip()
    bearer = raw[7:].strip() if raw.lower().startswith("bearer ") else ""
    if bearer.startswith("HCT:"):
        from hushh_mcp.consent.token import validate_token_with_db
        from hushh_mcp.types import ConsentScope

        valid, _reason, token_obj = await validate_token_with_db(bearer, ConsentScope.VAULT_OWNER)
        if valid and token_obj is not None:
            return str(token_obj.user_id)
        raise HTTPException(status_code=401, detail="Token validation failed.")
    return await require_firebase_auth(background_tasks, authorization)


@router.get("", response_model=ConnectedSystemsResponse)
async def list_connected_systems(
    firebase_uid: str = Depends(_require_signed_in_lister),
):
    _ = firebase_uid
    try:
        service = get_connected_systems_service()
        return ConnectedSystemsResponse(
            systems=service.list_systems(), registryRevision=service.registry_revision()
        )
    except ConnectedSystemsError as error:
        _raise_connected_system_error(error)


@router.get("/record-bindings")
async def list_connected_system_record_bindings(
    token_data: dict = Depends(require_vault_owner_token),
):
    service = get_connected_systems_service()
    try:
        return service.list_record_binding_statuses(user_id=_user_id(token_data))
    except ConnectedSystemsError as error:
        _raise_connected_system_error(error)


@router.get("/{system_id}/schema")
async def get_connected_system_schema(
    system_id: str = Path(..., min_length=1, max_length=128),
    object_type: str | None = Query(
        default=None,
        alias="objectType",
        max_length=80,
    ),
    force_refresh: bool = Query(default=False, alias="forceRefresh"),
    token_data: dict = Depends(require_vault_owner_token),
):
    _ = _user_id(token_data)
    service = get_connected_systems_service()
    try:
        # Fetch the remote catalogue once. Mapping failure must not issue a
        # second 20s+ MuleSoft schema request merely to render catalogue-only.
        schema = await service.get_schema(
            system_id=system_id,
            object_type=object_type,
            force_refresh=force_refresh,
        )
        try:
            resolved = await get_crm_schema_mapping_service().resolve(
                crm_id=_schema_mapping_crm_id(service=service, system_id=system_id),
                schema=schema,
                force_refresh=force_refresh,
            )
            mapping = resolved.mapping
        except CrmSchemaMappingError:
            return _schema_catalogue_only(schema)
        return {
            **schema,
            "profileFieldMappings": mapping,
            "schemaMappingStatus": "ready",
        }
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
        read_object_type = _operation_object_type(
            service=service, system_id=system_id, operation="read"
        )
        await _require_schema_mapping(
            service=service, system_id=system_id, object_type=read_object_type
        )
        # A direct record read is binding-only. Browser lookup fields are not
        # forwarded, so an authenticated user cannot turn this endpoint into an
        # arbitrary CRM record probe.
        return await service.read_bound_record(
            user_id=_user_id(token_data),
            system_id=system_id,
            object_type=read_object_type,
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


@router.get("/{system_id}/encrypted-fields/config")
async def get_connected_system_encrypted_fields_config(
    system_id: str = Path(..., min_length=1, max_length=128),
    token_data: dict = Depends(require_vault_owner_token),
):
    _ = _user_id(token_data)
    try:
        return get_connected_systems_service().crm_encrypted_fields_configuration(
            system_id=system_id
        )
    except ConnectedSystemsError as error:
        _raise_connected_system_error(error)


@router.post("/{system_id}/records/read-encrypted")
async def read_connected_system_record_encrypted_fields(
    body: CrmEncryptedFieldsReadRequest,
    system_id: str = Path(..., min_length=1, max_length=128),
    token_data: dict = Depends(require_vault_owner_token),
):
    service = get_connected_systems_service()
    try:
        read_object_type = _operation_object_type(
            service=service, system_id=system_id, operation="read"
        )
        await _require_schema_mapping(
            service=service, system_id=system_id, object_type=read_object_type
        )
        return await service.read_bound_record_encrypted_fields(
            user_id=_user_id(token_data),
            system_id=system_id,
            object_type=read_object_type,
            return_fields=body.return_fields,
            encrypted_fields=body.encrypted_fields,
        )
    except ConnectedSystemsError as error:
        _raise_connected_system_error(error)


@router.post("/{system_id}/records/update-intents-encrypted")
async def update_connected_system_record_intent_encrypted_fields(
    body: CrmEncryptedFieldsUpdateIntentRequest,
    system_id: str = Path(..., min_length=1, max_length=128),
    token_data: dict = Depends(require_vault_owner_token),
):
    service = get_connected_systems_service()
    try:
        update_object_type = _operation_object_type(
            service=service, system_id=system_id, operation="update"
        )
        mapping = await _require_schema_mapping(
            service=service, system_id=system_id, object_type=update_object_type
        )
        return await service.create_encrypted_fields_update_intent(
            user_id=_user_id(token_data),
            system_id=system_id,
            object_type=update_object_type,
            field_names=body.field_names,
            encrypted_fields=body.encrypted_fields,
            locked_field_names=set(mapping.values()),
        )
    except ConnectedSystemsError as error:
        _raise_connected_system_error(error)


@router.delete("/{system_id}/record-binding")
async def disconnect_connected_system_record_binding(
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
        return service.disconnect_record_binding(
            user_id=_user_id(token_data),
            system_id=system_id,
            object_type=object_type,
        )
    except ConnectedSystemsError as error:
        _raise_connected_system_error(error)


@router.post("/{system_id}/records/search")
async def search_connected_system_record(
    body: CrmSearchRequest,
    system_id: str = Path(..., min_length=1, max_length=128),
    token_data: dict = Depends(require_vault_owner_token),
):
    service = get_connected_systems_service()
    try:
        read_object_type = _operation_object_type(
            service=service, system_id=system_id, operation="read"
        )
        await _require_schema_mapping(
            service=service, system_id=system_id, object_type=read_object_type
        )
        # Lookup is strictly derived from the authenticated user's server-side
        # verified email and phone claim. The public request contains no
        # lookup values, so this route cannot become a CRM record probe.
        return await service.search_verified_record(
            user_id=_user_id(token_data),
            system_id=system_id,
            object_type=read_object_type,
            return_fields=body.return_fields,
            force_refresh=body.force_refresh,
        )
    except ConnectedSystemsError as error:
        _raise_connected_system_error(error)


@router.post("/{system_id}/records/create-intents")
async def create_connected_system_record_intent(
    body: CrmCreateIntentRequest,
    system_id: str = Path(..., min_length=1, max_length=128),
    token_data: dict = Depends(require_vault_owner_token),
):
    service = get_connected_systems_service()
    try:
        create_object_type = _operation_object_type(
            service=service, system_id=system_id, operation="create"
        )
        mapping = await _require_schema_mapping(
            service=service, system_id=system_id, object_type=create_object_type
        )
        # Initial records contain only server-side verified identity values
        # mapped to this CRM's active schema. Client supplied values cannot
        # create a record for another person.
        try:
            return await service.create_record_intent_for_verified_user(
                user_id=_user_id(token_data),
                system_id=system_id,
                object_type=create_object_type,
                profile_field_mappings=mapping,
            )
        except ConnectedSystemValidationError as error:
            # A stale schema/model mapping gets exactly one forced refresh. The
            # user still reviews the normal pending intent; this does not retry
            # a CRM write or create an approval automatically.
            if error.code not in {
                "CONNECTED_SYSTEM_SCHEMA_FIELD_UNAVAILABLE",
                "CONNECTED_SYSTEM_SCHEMA_FIELD_READ_ONLY",
                "CONNECTED_SYSTEM_SCHEMA_REQUIRED_FIELDS",
            }:
                raise
            get_crm_schema_mapping_service().invalidate(
                crm_id=system_id,
                object_type=create_object_type,
            )
            mapping = await _require_schema_mapping(
                service=service,
                system_id=system_id,
                object_type=create_object_type,
                force_refresh=True,
            )
            return await service.create_record_intent_for_verified_user(
                user_id=_user_id(token_data),
                system_id=system_id,
                object_type=create_object_type,
                profile_field_mappings=mapping,
            )
    except ConnectedSystemsError as error:
        _raise_connected_system_error(error)


@router.post("/{system_id}/records/update-intents")
async def update_connected_system_record_intent(
    body: CrmUpdateIntentRequest,
    system_id: str = Path(..., min_length=1, max_length=128),
    token_data: dict = Depends(require_vault_owner_token),
):
    service = get_connected_systems_service()
    try:
        update_object_type = _operation_object_type(
            service=service, system_id=system_id, operation="update"
        )
        mapping = await _require_schema_mapping(
            service=service, system_id=system_id, object_type=update_object_type
        )
        return await service.update_record_intent_from_fields(
            user_id=_user_id(token_data),
            system_id=system_id,
            object_type=update_object_type,
            # The route never selects a CRM id. The service resolves the
            # authenticated owner's active binding and rejects any mismatch.
            record_id=None,
            record_fields=(
                body.record_fields
                if body.record_fields is not None
                else dict(body.additional_fields or {})
            ),
            readback_locator=None,
            locked_field_names=set(mapping.values()),
        )
    except ConnectedSystemsError as error:
        _raise_connected_system_error(error)


@router.post("/{system_id}/records/delete")
async def delete_connected_system_record(
    body: CrmDeleteRequest,
    system_id: str = Path(..., min_length=1, max_length=128),
    token_data: dict = Depends(require_vault_owner_token),
):
    service = get_connected_systems_service()
    try:
        delete_object_type = _operation_object_type(
            service=service, system_id=system_id, operation="delete"
        )
        await _require_schema_mapping(
            service=service, system_id=system_id, object_type=delete_object_type
        )
        # Compatibility route: delete is now a pending intent. Keeping this
        # URL prevents older clients from issuing an immediate destructive call.
        return service.create_delete_intent(
            user_id=_user_id(token_data),
            system_id=system_id,
            object_type=delete_object_type,
            record_id=None,
        )
    except ConnectedSystemsError as error:
        _raise_connected_system_error(error)


@router.post("/{system_id}/records/delete-intents")
async def create_connected_system_delete_intent(
    body: CrmDeleteRequest,
    system_id: str = Path(..., min_length=1, max_length=128),
    token_data: dict = Depends(require_vault_owner_token),
):
    service = get_connected_systems_service()
    try:
        delete_object_type = _operation_object_type(
            service=service, system_id=system_id, operation="delete"
        )
        await _require_schema_mapping(
            service=service, system_id=system_id, object_type=delete_object_type
        )
        return service.create_delete_intent(
            user_id=_user_id(token_data),
            system_id=system_id,
            object_type=delete_object_type,
            record_id=None,
        )
    except ConnectedSystemsError as error:
        _raise_connected_system_error(error)


@router.post("/{system_id}/intents/{intent_id}/approve")
async def approve_connected_system_intent(
    system_id: str = Path(..., min_length=1, max_length=128),
    intent_id: str = Path(..., min_length=1, max_length=128),
    token_data: dict = Depends(require_vault_owner_token),
):
    service = get_connected_systems_service()
    try:
        await _require_schema_mapping(service=service, system_id=system_id, object_type=None)
        return await service.approve_intent(
            user_id=_user_id(token_data),
            system_id=system_id,
            intent_id=intent_id,
        )
    except ConnectedSystemsError as error:
        _raise_connected_system_error(error)


@router.post("/{system_id}/intents/{intent_id}/approve-encrypted")
async def approve_connected_system_encrypted_fields_intent(
    system_id: str = Path(..., min_length=1, max_length=128),
    intent_id: str = Path(..., min_length=1, max_length=128),
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return await get_connected_systems_service().approve_encrypted_fields_intent(
            user_id=_user_id(token_data), system_id=system_id, intent_id=intent_id
        )
    except ConnectedSystemsError as error:
        _raise_connected_system_error(error)


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
