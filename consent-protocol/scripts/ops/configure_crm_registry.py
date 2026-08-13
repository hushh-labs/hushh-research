#!/usr/bin/env python3
"""Canonical operator CLI for crm-registry.v1 check/probe/apply/deactivate."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from sqlalchemy import text

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from db.db_client import get_db  # noqa: E402
from hushh_mcp.runtime_settings import (  # noqa: E402
    get_connector_kdf_iterations,
    get_connector_kdf_salt,
    get_connector_secrets_key,
    get_omnigateway_transport_headers,
)
from hushh_mcp.services.connected_systems_service import (  # noqa: E402
    ConnectedSystemDefinition,
    ConnectedSystemsService,
    ExternalCrmStreamableMcpAdapter,
    InMemoryConnectedSystemIntentStore,
    _mutation_succeeded,
    _record_id_from_result,
    _sanitize_read_records,
)
from hushh_mcp.services.crm_registry_descriptor import (  # noqa: E402
    CrmRegistryDescriptorError,
    ValidatedCrmRegistryDescriptor,
    load_and_validate_descriptor,
    redacted_summary,
)
from hushh_mcp.vault.encrypt import (  # noqa: E402
    PBKDF2_CBC_ALGORITHM,
    encrypt_data_pbkdf2_cbc,
)


class _ProbeCache:
    def get(self, **_kwargs):
        return None

    def put(self, *, schema, **_kwargs):
        from hushh_mcp.services.crm_schema_catalog_cache import schema_fingerprint

        return {
            "schemaFingerprint": schema_fingerprint(schema),
            "freshness": "fresh",
            "refreshedAt": datetime.now(timezone.utc).isoformat(),
        }


def _credentials(descriptor: ValidatedCrmRegistryDescriptor) -> tuple[str, str]:
    first, second = descriptor.credential_env_names
    if not first or not second:
        raise CrmRegistryDescriptorError("This registry connector has no local CRM credentials.")
    return str(os.environ[first]), str(os.environ[second])


def _registry_kdf_parameters() -> tuple[str, int]:
    salt = get_connector_kdf_salt()
    iterations = get_connector_kdf_iterations()
    if not salt or not iterations:
        raise CrmRegistryDescriptorError(
            "Connector KDF configuration is unavailable; registry was not changed."
        )
    return salt, iterations


def _encrypted_credentials(descriptor: ValidatedCrmRegistryDescriptor) -> tuple[str, str]:
    client_id, client_secret = _credentials(descriptor)
    password = get_connector_secrets_key()
    salt, iterations = _registry_kdf_parameters()
    if not password:
        raise CrmRegistryDescriptorError(
            "Connector encryption configuration is unavailable; registry was not changed."
        )
    return (
        encrypt_data_pbkdf2_cbc(client_id, password, salt, iterations),
        encrypt_data_pbkdf2_cbc(client_secret, password, salt, iterations),
    )


def _definition(descriptor: ValidatedCrmRegistryDescriptor) -> ConnectedSystemDefinition:
    raw = descriptor.raw
    operations = tuple(
        {
            "name": config["toolName"],
            "operation": operation,
            "objectType": config.get("objectType") or raw["primaryObject"],
            "description": str(config.get("description") or ""),
            "mcpEndpoint": str(config.get("mcpEndpoint") or raw["mcpEndpoint"]),
            "responseContract": dict(config["responseContract"]),
            "crmEncryptedFieldsToolName": (
                ((descriptor.encrypted_fields or {}).get("tools") or {}).get(operation)
                if operation in {"read", "update"}
                else None
            ),
        }
        for operation, config in descriptor.operations.items()
    )
    auth_style = str(raw.get("authHeaderStyle") or "bearer").lower()
    connection_mode = str(raw.get("connectionMode") or "managed").lower()
    gateway_profile = str(raw.get("gatewayCredentialProfile") or "shared").lower()
    replacement_tool_arguments = None
    if auth_style == "bearer":
        headers = get_omnigateway_transport_headers(gateway_profile)
        if connection_mode == "dynamic_registry":
            client_id, client_secret = _credentials(descriptor)
            crm_connection = raw["crmConnection"]
            tool_arguments = {
                "target": raw["displayName"],
                "crmBaseUrl": crm_connection["baseUrl"],
                "crmMcpEndpoint": crm_connection["mcpEndpoint"],
                "clientId": client_id,
                "clientSecret": client_secret,
                "crmTokenUrl": crm_connection["tokenUrl"],
            }
            replacement_tool_arguments = dict(tool_arguments)
        else:
            tool_arguments = None
    else:
        client_id, client_secret = _credentials(descriptor)
        headers = (("client_id", client_id), ("client_secret", client_secret))
        tool_arguments = None
    return ConnectedSystemDefinition(
        system_id=descriptor.crm_id,
        registry_id=descriptor.crm_id,
        display_name=raw["displayName"],
        customer_display_name=raw["displayName"],
        system_type=raw["crmType"],
        system_name=raw["crmType"],
        target=raw["displayName"],
        object_type_default=raw["primaryObject"],
        transport="external_crm_streamable_mcp",
        transport_endpoint=raw["mcpEndpoint"],
        registry_source="enterprise_crm_registry",
        tool_catalog=operations,
        transport_headers=headers,
        transport_tool_arguments=tool_arguments,
        transport_replacement_tool_arguments=replacement_tool_arguments,
        capabilities=frozenset(descriptor.capabilities),
        timeout_seconds=max(1, int(raw.get("timeoutSeconds") or 30)),
        retry_count=max(0, int(raw.get("retryCount") or 0)),
    )


def _replace_record_id(value: Any, record_id: str) -> Any:
    if isinstance(value, dict):
        return {key: _replace_record_id(item, record_id) for key, item in value.items()}
    if isinstance(value, list):
        return [_replace_record_id(item, record_id) for item in value]
    return record_id if value == "{{recordId}}" else value


def _probe_schema_object_types(definition: ConnectedSystemDefinition) -> tuple[str, ...]:
    """Return every registry-owned object whose schema must pass before activation."""
    operation_types = [
        definition.object_type_for_operation(operation)
        for operation in ("create", "read", "update", "delete")
        if definition.operation(operation)
    ]
    return tuple(dict.fromkeys([definition.object_type_default, *operation_types]))


def _require_probe_coverage(
    descriptor: ValidatedCrmRegistryDescriptor, probe_result: dict[str, Any]
) -> None:
    verified = {str(value) for value in probe_result.get("verifiedOperations") or ()}
    missing = sorted(set(descriptor.capabilities) - verified)
    if missing:
        raise CrmRegistryDescriptorError(
            "Activation is blocked until the probe verifies every declared operation; "
            f"missing: {', '.join(missing)}."
        )


async def _probe(descriptor: ValidatedCrmRegistryDescriptor) -> dict[str, Any]:
    definition = _definition(descriptor)
    adapter = ExternalCrmStreamableMcpAdapter.from_registry(definition)
    from mcp.client.session import ClientSession
    from mcp.client.streamable_http import streamablehttp_client

    client_kwargs = (
        {"headers": dict(definition.transport_headers)} if definition.transport_headers else {}
    )
    async with streamablehttp_client(definition.transport_endpoint or "", **client_kwargs) as (
        read_stream,
        write_stream,
        _,
    ):
        async with ClientSession(read_stream, write_stream) as session:
            await session.initialize()
            listed = await session.list_tools()
    listed_names = {str(tool.name) for tool in listed.tools}
    # The encrypted profile may reuse the standard read/update tool names, but
    # it may never point at a tool absent from the MuleSoft catalog. Include
    # both mappings here so ``apply --activate`` proves the entire declared
    # capability surface before changing the registry.
    required_names = set(descriptor.required_mcp_tool_names)
    missing_names = sorted(required_names - listed_names)
    if missing_names:
        raise CrmRegistryDescriptorError(
            f"MCP tools/list is missing declared tools: {', '.join(missing_names)}."
        )
    service = ConnectedSystemsService(
        adapter=adapter,
        registry=(definition,),
        store=InMemoryConnectedSystemIntentStore(),
        schema_cache=_ProbeCache(),
    )
    operation_object_types = {
        operation: str((definition.operation(operation) or {}).get("objectType") or "")
        for operation in ("create", "read", "update", "delete")
        if definition.operation(operation)
    }
    schema_object_types = _probe_schema_object_types(definition)
    schemas = {
        object_type: await service.get_schema(
            system_id=definition.system_id,
            object_type=object_type,
            force_refresh=True,
        )
        for object_type in schema_object_types
    }
    schema = schemas[definition.object_type_default]
    result: dict[str, Any] = {
        "schemaFingerprint": schema.get("schemaFingerprint"),
        "fieldCount": len(schema.get("fields") or []),
        "schemaObjects": {
            object_type: {
                "schemaFingerprint": object_schema.get("schemaFingerprint"),
                "fieldCount": len(object_schema.get("fields") or []),
            }
            for object_type, object_schema in schemas.items()
        },
        "verifiedOperations": ["schema"],
        "_normalizedSchema": schema,
    }
    probe = descriptor.raw.get("probe") or {}
    lifecycle = probe.get("lifecycle") or {}
    if len(set(operation_object_types.values())) > 1:
        if probe.get("mode") != "cross-object-bound-lifecycle.v1":
            raise CrmRegistryDescriptorError(
                "Cross-object CRM operations require an explicit cross-object bound-lifecycle probe."
            )
        result["lifecycle"] = "cross-object-bound-lifecycle-required"
        result["bindingRule"] = "verified_identity_lookup_for_read_update_delete"
        result["verifiedObjectSchemas"] = list(schema_object_types)
        return result
    if not lifecycle:
        if "read" in descriptor.capabilities:
            read_config = definition.operation("read") or {}
            read_result = await adapter.call_operation(
                operation="read",
                tool_name=str(read_config.get("name") or ""),
                endpoint=definition.operation_endpoint("read"),
                timeout_seconds=definition.timeout_seconds,
                retry_count=definition.retry_count,
                arguments=dict((descriptor.raw.get("probe") or {})["read"]),
            )
            _sanitize_read_records(
                read_result,
                response_contract=read_config.get("responseContract"),
                allowed_fields=list(schema.get("supportedFields") or []),
            )
            result["verifiedOperations"] = ["schema", "read"]
        return result

    created_id = ""
    cleanup_needed = False
    try:
        create_contract = definition.operation("create")["responseContract"]
        create_result = await adapter.call_operation(
            operation="create",
            tool_name=definition.operation("create")["name"],
            endpoint=definition.operation_endpoint("create"),
            timeout_seconds=definition.timeout_seconds,
            retry_count=0,
            arguments=dict(lifecycle["create"]),
        )
        if not _mutation_succeeded(create_result, response_contract=create_contract):
            raise CrmRegistryDescriptorError(
                "Synthetic create did not satisfy its response contract."
            )
        created_id = _record_id_from_result(create_result, response_contract=create_contract) or ""
        if not created_id:
            raise CrmRegistryDescriptorError("Synthetic create did not return a record id.")
        cleanup_needed = True

        read_number = 0
        for operation in ("read", "update", "read", "delete", "read"):
            config = definition.operation(operation) or {}
            arguments = _replace_record_id(lifecycle[operation], created_id)
            operation_result = await adapter.call_operation(
                operation=operation,
                tool_name=str(config.get("name") or ""),
                endpoint=definition.operation_endpoint(operation),
                timeout_seconds=definition.timeout_seconds,
                retry_count=definition.retry_count,
                arguments=arguments,
            )
            if operation in {"update", "delete"} and not _mutation_succeeded(
                operation_result, response_contract=config.get("responseContract")
            ):
                raise CrmRegistryDescriptorError(
                    f"Synthetic {operation} did not satisfy its response contract."
                )
            if operation == "read":
                read_number += 1
                records = _sanitize_read_records(
                    operation_result,
                    response_contract=config.get("responseContract"),
                    allowed_fields=list(schema.get("supportedFields") or []),
                )
                if read_number < 3 and not any(
                    record.get("recordId") == created_id for record in records
                ):
                    raise CrmRegistryDescriptorError(
                        "Synthetic ID read did not return the created record."
                    )
                if read_number == 2:
                    expected_updates = dict(
                        lifecycle["update"].get("recordFields")
                        or lifecycle["update"].get("additionalFields")
                        or {}
                    )
                    matching = next(
                        (record for record in records if record.get("recordId") == created_id),
                        None,
                    )
                    actual_fields = dict((matching or {}).get("fields") or {})
                    actual_by_lower = {
                        str(key).lower(): value for key, value in actual_fields.items()
                    }
                    if any(
                        actual_by_lower.get(str(key).lower()) != value
                        for key, value in expected_updates.items()
                    ):
                        raise CrmRegistryDescriptorError(
                            "Synthetic update readback did not contain the declared field changes."
                        )
                if read_number == 3 and records:
                    raise CrmRegistryDescriptorError(
                        "Synthetic post-delete read still returned a record."
                    )
            if operation == "delete":
                cleanup_needed = False
        result["verifiedOperations"] = list(descriptor.capabilities)
        result["lifecycle"] = "create-read-update-read-delete-absent"
        return result
    finally:
        if cleanup_needed and created_id:
            delete_config = definition.operation("delete") or {}
            try:
                await adapter.call_operation(
                    operation="delete",
                    tool_name=str(delete_config.get("name") or ""),
                    endpoint=definition.operation_endpoint("delete"),
                    timeout_seconds=definition.timeout_seconds,
                    retry_count=0,
                    arguments=_replace_record_id(lifecycle["delete"], created_id),
                )
            except Exception:
                print(
                    "WARNING: synthetic fixture cleanup requires operator review.", file=sys.stderr
                )


def _apply(
    descriptor: ValidatedCrmRegistryDescriptor,
    *,
    operator: str,
    probe_result: dict[str, Any],
) -> None:
    _require_probe_coverage(descriptor, probe_result)
    raw = descriptor.raw
    auth_style = str(raw.get("authHeaderStyle") or "bearer").lower()
    connection_mode = str(raw.get("connectionMode") or "managed").lower()
    gateway_profile = str(raw.get("gatewayCredentialProfile") or "shared").lower()
    has_registry_credentials = auth_style != "bearer" or connection_mode == "dynamic_registry"
    cid_blob, secret_blob = (
        _encrypted_credentials(descriptor) if has_registry_credentials else (None, None)
    )
    kdf_salt, kdf_iterations = (
        _registry_kdf_parameters() if has_registry_credentials else (None, None)
    )
    crm_connection = raw.get("crmConnection") or {}
    operations = descriptor.operations
    safe_probe_result = {
        key: value for key, value in probe_result.items() if not key.startswith("_")
    }
    db = get_db()
    with db.engine.begin() as connection:
        current = (
            connection.execute(
                text(
                    "SELECT configuration_revision FROM enterprise_crm_registry WHERE crm_id=:crm_id"
                ),
                {"crm_id": descriptor.crm_id},
            )
            .mappings()
            .first()
        )
        revision = int((current or {}).get("configuration_revision") or 0) + 1
        capability_set = set(descriptor.capabilities)
        connection.execute(
            text(
                """
                INSERT INTO enterprise_crm_registry (
                  crm_id, crm_enterprise_name, crm_type, environment, crm_base_url,
                  crm_token_url, crm_mcp_endpoint, crm_client_id_blob, crm_client_secret_blob,
                  encryption_algorithm, key_id, auth_header_style, supports_create,
                  supports_read, supports_update, supports_delete, user_object_name,
                  timeout_seconds, retry_count, is_active, business_owner, technical_owner,
                  configuration_revision, crm_encrypted_fields_v1_enabled, validated_at, updated_at,
                  gateway_credential_profile, crm_connection_mode,
                  crm_connection_base_url, crm_connection_mcp_endpoint, crm_connection_token_url,
                  kdf_salt, kdf_iterations
                ) VALUES (
                  :crm_id, :name, :crm_type, :environment, :base_url, :token_url,
                  :mcp_endpoint, :cid_blob, :secret_blob, :algorithm, :key_id,
                  :auth_style, :supports_create, :supports_read, :supports_update,
                  :supports_delete, :object_type, :timeout_seconds, :retry_count,
                  FALSE, :business_owner, :technical_owner, :revision, :encrypted_fields_enabled, NOW(), NOW(),
                  :gateway_profile, :connection_mode, :crm_connection_base_url,
                  :crm_connection_mcp_endpoint, :crm_connection_token_url,
                  :kdf_salt, :kdf_iterations
                )
                ON CONFLICT (crm_id) DO UPDATE SET
                  crm_enterprise_name=EXCLUDED.crm_enterprise_name,
                  crm_type=EXCLUDED.crm_type, environment=EXCLUDED.environment,
                  crm_base_url=EXCLUDED.crm_base_url, crm_token_url=EXCLUDED.crm_token_url,
                  crm_mcp_endpoint=EXCLUDED.crm_mcp_endpoint,
                  crm_client_id_blob=EXCLUDED.crm_client_id_blob,
                  crm_client_secret_blob=EXCLUDED.crm_client_secret_blob,
                  encryption_algorithm=EXCLUDED.encryption_algorithm,
                  key_id=EXCLUDED.key_id, auth_header_style=EXCLUDED.auth_header_style,
                  supports_create=EXCLUDED.supports_create,
                  supports_read=EXCLUDED.supports_read,
                  supports_update=EXCLUDED.supports_update,
                  supports_delete=EXCLUDED.supports_delete,
                  user_object_name=EXCLUDED.user_object_name,
                  timeout_seconds=EXCLUDED.timeout_seconds, retry_count=EXCLUDED.retry_count,
                  business_owner=EXCLUDED.business_owner, technical_owner=EXCLUDED.technical_owner,
                  configuration_revision=EXCLUDED.configuration_revision,
                  crm_encrypted_fields_v1_enabled=EXCLUDED.crm_encrypted_fields_v1_enabled,
                  gateway_credential_profile=EXCLUDED.gateway_credential_profile,
                  crm_connection_mode=EXCLUDED.crm_connection_mode,
                  crm_connection_base_url=EXCLUDED.crm_connection_base_url,
                  crm_connection_mcp_endpoint=EXCLUDED.crm_connection_mcp_endpoint,
                  crm_connection_token_url=EXCLUDED.crm_connection_token_url,
                  kdf_salt=EXCLUDED.kdf_salt,
                  kdf_iterations=EXCLUDED.kdf_iterations,
                  validated_at=NOW(), is_active=FALSE, updated_at=NOW()
                """
            ),
            {
                "crm_id": descriptor.crm_id,
                "name": raw["displayName"],
                "crm_type": raw["crmType"],
                "environment": raw["environment"],
                "base_url": raw["baseUrl"],
                "token_url": raw.get("tokenUrl"),
                "mcp_endpoint": raw["mcpEndpoint"],
                "cid_blob": cid_blob,
                "secret_blob": secret_blob,
                "algorithm": PBKDF2_CBC_ALGORITHM
                if has_registry_credentials
                else "managed_gateway",
                "key_id": "connector_secrets_key_v1"
                if has_registry_credentials
                else "omnigateway_transport",
                "auth_style": auth_style,
                "supports_create": "create" in capability_set,
                "supports_read": "read" in capability_set,
                "supports_update": "update" in capability_set,
                "supports_delete": "delete" in capability_set,
                "object_type": raw["primaryObject"],
                "timeout_seconds": max(1, int(raw.get("timeoutSeconds") or 30)),
                "retry_count": max(0, int(raw.get("retryCount") or 0)),
                "business_owner": raw.get("businessOwner"),
                "technical_owner": raw.get("technicalOwner"),
                "revision": revision,
                "encrypted_fields_enabled": bool(descriptor.encrypted_fields),
                "gateway_profile": gateway_profile,
                "connection_mode": connection_mode,
                "crm_connection_base_url": crm_connection.get("baseUrl"),
                "crm_connection_mcp_endpoint": crm_connection.get("mcpEndpoint"),
                "crm_connection_token_url": crm_connection.get("tokenUrl"),
                "kdf_salt": kdf_salt,
                "kdf_iterations": kdf_iterations,
            },
        )
        connection.execute(
            text("DELETE FROM crm_operation_endpoints WHERE crm_id=:crm_id"),
            {"crm_id": descriptor.crm_id},
        )
        for operation, config in operations.items():
            connection.execute(
                text(
                    """
                    INSERT INTO crm_operation_endpoints (
                      crm_id, operation, tool_name, http_method, path, description,
                      mcp_endpoint, response_contract, crm_encrypted_fields_tool_name, object_type
                    ) VALUES (
                      :crm_id, :operation, :tool_name, :http_method, :path,
                      :description, :mcp_endpoint, CAST(:response_contract AS JSONB), :encrypted_fields_tool_name, :object_type
                    )
                    """
                ),
                {
                    "crm_id": descriptor.crm_id,
                    "operation": operation,
                    "tool_name": config["toolName"],
                    "http_method": config.get("httpMethod"),
                    "path": config.get("path"),
                    "description": config.get("description"),
                    "mcp_endpoint": config.get("mcpEndpoint") or raw["mcpEndpoint"],
                    "response_contract": json.dumps(config["responseContract"]),
                    "encrypted_fields_tool_name": (
                        (descriptor.encrypted_fields or {}).get("tools", {}).get(operation)
                        if operation in {"read", "update"}
                        else None
                    ),
                    "object_type": config.get("objectType") or raw["primaryObject"],
                },
            )
        connection.execute(
            text("DELETE FROM crm_encrypted_fields_recipient_keys WHERE crm_id=:crm_id"),
            {"crm_id": descriptor.crm_id},
        )
        encrypted_fields = descriptor.encrypted_fields
        if encrypted_fields:
            recipient_key = encrypted_fields["recipientKey"]
            connection.execute(
                text(
                    """
                    INSERT INTO crm_encrypted_fields_recipient_keys (
                      crm_id, key_id, public_key, public_key_fingerprint, environment, status
                    ) VALUES (
                      :crm_id, :key_id, :public_key, :fingerprint, 'sandbox', 'active'
                    )
                    """
                ),
                {
                    "crm_id": descriptor.crm_id,
                    "key_id": recipient_key["keyId"],
                    "public_key": recipient_key["publicKey"],
                    "fingerprint": recipient_key["publicKeyFingerprint"],
                },
            )
        connection.execute(
            text("DELETE FROM crm_schema_catalog_cache WHERE crm_id=:crm_id"),
            {"crm_id": descriptor.crm_id},
        )
        connection.execute(
            text("DELETE FROM crm_schema_mapping_cache WHERE crm_id=:crm_id"),
            {"crm_id": descriptor.crm_id},
        )
        connection.execute(
            text(
                """
                INSERT INTO crm_registry_audit_events (
                  event_id, crm_id, action, operator_identity, configuration_fingerprint,
                  configuration_revision, capabilities_json, validation_result,
                  validation_summary_json
                ) VALUES (
                  :event_id, :crm_id, :action, :operator, :fingerprint,
                  :revision, CAST(:capabilities AS JSONB), 'passed', CAST(:summary AS JSONB)
                )
                """
            ),
            {
                "event_id": f"crma_{uuid4().hex}",
                "crm_id": descriptor.crm_id,
                "action": "activate" if not current else "update",
                "operator": operator,
                "fingerprint": descriptor.fingerprint,
                "revision": revision,
                "capabilities": json.dumps(list(descriptor.capabilities)),
                "summary": json.dumps(safe_probe_result),
            },
        )
        connection.execute(
            text("UPDATE enterprise_crm_registry SET is_active=TRUE WHERE crm_id=:crm_id"),
            {"crm_id": descriptor.crm_id},
        )
    from hushh_mcp.services.crm_registry_repo import invalidate_registry_snapshot
    from hushh_mcp.services.crm_schema_catalog_cache import CrmSchemaCatalogCache

    invalidate_registry_snapshot()
    normalized_schema = probe_result.get("_normalizedSchema")
    if isinstance(normalized_schema, dict):
        CrmSchemaCatalogCache(db).put(
            crm_id=descriptor.crm_id,
            object_type=str(raw["primaryObject"]),
            configuration_revision=revision,
            schema=normalized_schema,
        )


def _deactivate(crm_id: str, *, operator: str) -> None:
    db = get_db()
    with db.engine.begin() as connection:
        row = (
            connection.execute(
                text(
                    """
                UPDATE enterprise_crm_registry
                SET is_active=FALSE, configuration_revision=configuration_revision+1, updated_at=NOW()
                WHERE crm_id=:crm_id
                RETURNING configuration_revision
                """
                ),
                {"crm_id": crm_id},
            )
            .mappings()
            .first()
        )
        if not row:
            raise CrmRegistryDescriptorError("CRM registry row was not found.")
        connection.execute(
            text(
                """
                INSERT INTO crm_registry_audit_events (
                  event_id, crm_id, action, operator_identity, configuration_fingerprint,
                  configuration_revision, capabilities_json, validation_result
                ) VALUES (
                  :event_id, :crm_id, 'deactivate', :operator, 'deactivated',
                  :revision, '[]'::jsonb, 'deactivated'
                )
                """
            ),
            {
                "event_id": f"crma_{uuid4().hex}",
                "crm_id": crm_id,
                "operator": operator,
                "revision": int(row["configuration_revision"]),
            },
        )
    from hushh_mcp.services.crm_registry_repo import invalidate_registry_snapshot

    invalidate_registry_snapshot()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("check", "probe", "apply"):
        sub = subparsers.add_parser(command)
        sub.add_argument("descriptor")
        if command == "apply":
            sub.add_argument("--activate", action="store_true", required=True)
            sub.add_argument("--operator", required=True)
    deactivate = subparsers.add_parser("deactivate")
    deactivate.add_argument("crm_id")
    deactivate.add_argument("--operator", required=True)
    args = parser.parse_args()

    try:
        if args.command == "deactivate":
            _deactivate(args.crm_id, operator=args.operator)
            print(json.dumps({"crmId": args.crm_id, "status": "deactivated"}))
            return 0
        descriptor = load_and_validate_descriptor(args.descriptor)
        if args.command == "check":
            print(json.dumps({**redacted_summary(descriptor), "status": "valid"}, sort_keys=True))
            return 0
        probe_result = asyncio.run(_probe(descriptor))
        public_probe_result = {
            key: value for key, value in probe_result.items() if not key.startswith("_")
        }
        if args.command == "probe":
            print(
                json.dumps({**redacted_summary(descriptor), **public_probe_result}, sort_keys=True)
            )
            return 0
        _apply(descriptor, operator=args.operator, probe_result=probe_result)
        print(
            json.dumps(
                {"crmId": descriptor.crm_id, "status": "active", **public_probe_result},
                sort_keys=True,
            )
        )
        return 0
    except CrmRegistryDescriptorError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
