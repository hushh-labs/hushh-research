"""Capability-safe Connected Systems registry and CRM MCP adapter."""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import os
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal
from uuid import uuid4

from db.db_client import DatabaseExecutionError, get_db
from hushh_mcp.services.crm_encrypted_fields_v1 import (
    CRM_ENCRYPTED_FIELDS_V1_PROFILE,
    CrmEncryptedFields,
    validate_crm_encrypted_fields_envelope,
    validate_crm_encrypted_fields_recipient_key,
)

logger = logging.getLogger(__name__)

CONNECTED_SYSTEM_SALESFORCE_ID = "salesforce-fsc-customer0"
DEFAULT_TARGET = "Macys"
DEFAULT_OBJECT_TYPE = "Contact"
EXTERNAL_CRM_TRANSPORT = "external_crm_streamable_mcp"
# This in-code fixture remains available only to explicit test registries. Runtime
# resolution always loads active systems from enterprise_crm_registry.
REGISTRY_SOURCE = "customer0_connected_system_registry"
REGISTRY_MCP_ENDPOINT = (
    "https://hussh-og-nonprod-ingress-a3e0me.y4rjsf.usa-e2.cloudhub.io/crm-connect/v1/mcp"
)
TERMINAL_INTENT_STATUSES = frozenset({"rejected", "succeeded", "partial", "failed"})
_CRM_ENCRYPTED_FIELDS_ACK_STATUSES = frozenset({"accepted", "success", "succeeded"})
_OPAQUE_PARTNER_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$")


def _crm_encrypted_fields_runtime_enabled() -> bool:
    """Fail closed outside UAT until the partner contract is production-approved."""
    return (
        str(os.getenv("ENVIRONMENT") or os.getenv("HUSHH_DEPLOY_ENV") or "").strip().lower()
        == "uat"
    )


def _normalize_crm_encrypted_fields_ack(payload: Any) -> dict[str, Any]:
    """Return the only plaintext partner metadata that may be persisted."""
    raw = _ensure_dict(payload)
    if set(raw) - {"status", "accepted", "operationId", "correlationId", "idempotent"}:
        raise ConnectedSystemConfigurationError(
            "The CRM partner returned an unsafe acknowledgement.",
            code="CONNECTED_SYSTEM_CRM_ENCRYPTED_FIELDS_ACK_INVALID",
            status_code=502,
        )
    status = str(raw.get("status") or "").strip().lower()
    if status not in _CRM_ENCRYPTED_FIELDS_ACK_STATUSES or raw.get("accepted") is not True:
        raise ConnectedSystemsError(
            "The CRM partner did not accept the update.",
            code="CONNECTED_SYSTEM_CRM_ENCRYPTED_FIELDS_UPDATE_UNCONFIRMED",
            status_code=502,
        )
    normalized: dict[str, Any] = {"status": status, "accepted": True}
    if "idempotent" in raw:
        if not isinstance(raw["idempotent"], bool):
            raise ConnectedSystemConfigurationError(
                "The CRM partner returned an unsafe acknowledgement.",
                code="CONNECTED_SYSTEM_CRM_ENCRYPTED_FIELDS_ACK_INVALID",
                status_code=502,
            )
        normalized["idempotent"] = raw["idempotent"]
    for key in ("operationId", "correlationId"):
        if key not in raw:
            continue
        value = raw[key]
        if not isinstance(value, str) or not _OPAQUE_PARTNER_ID.fullmatch(value):
            raise ConnectedSystemConfigurationError(
                "The CRM partner returned an unsafe acknowledgement.",
                code="CONNECTED_SYSTEM_CRM_ENCRYPTED_FIELDS_ACK_INVALID",
                status_code=502,
            )
        normalized[key] = value
    return normalized


EXTERNAL_CRM_TOOL_CATALOG = (
    {
        "name": "object-schema",
        "operation": "schema",
        "description": "Discover the Salesforce Contact field schema.",
    },
    {
        "name": "read-crm-record",
        "operation": "read",
        "description": "Read the bound Salesforce Contact by email and phone.",
    },
    {
        "name": "create-crm-record",
        "operation": "create",
        "description": "Create a Contact record from approved user fields.",
        "responseContract": {"requestStyle": "basic_identity_fields.v1"},
    },
    {
        "name": "update-crm-record",
        "operation": "update",
        "description": "Update allowlisted Contact fields for the bound record.",
        "responseContract": {"requestStyle": "id_additional_fields.v1"},
    },
    {
        "name": "delete-crm-record",
        "operation": "delete",
        "description": "Delete a Contact record; blocked outside maintainer tests.",
    },
)

SUPPORTED_CRM_FIELDS = frozenset(
    {
        "FirstName",
        "LastName",
        "Email",
        "Phone",
        "MobilePhone",
        "Title",
        "Department",
        "MailingCity",
        "MailingStreet",
        "LeadSource",
    }
)

_CRM_FIELD_ALIASES = {
    "firstname": "FirstName",
    "first_name": "FirstName",
    "lastname": "LastName",
    "last_name": "LastName",
    "email": "Email",
    "phone": "Phone",
    "mobilephone": "MobilePhone",
    "mobile_phone": "MobilePhone",
    "title": "Title",
    "department": "Department",
    "mailingcity": "MailingCity",
    "mailing_city": "MailingCity",
    "mailingstreet": "MailingStreet",
    "mailing_street": "MailingStreet",
    "leadsource": "LeadSource",
    "lead_source": "LeadSource",
}

SUPPORTED_CRM_SEARCH_FIELDS = SUPPORTED_CRM_FIELDS | frozenset({"Id"})

_CRM_SEARCH_FIELD_ALIASES = {
    **_CRM_FIELD_ALIASES,
    "id": "Id",
    "recordid": "Id",
    "record_id": "Id",
}

_CRM_FIELD_LABELS = {
    "FirstName": "First name",
    "LastName": "Last name",
    "Email": "Email",
    "Phone": "Phone",
    "MobilePhone": "Mobile phone",
    "Title": "Title",
    "Department": "Department",
    "MailingCity": "Mailing city",
    "MailingStreet": "Mailing street",
    "LeadSource": "Lead source",
}

_CRM_FIELD_INPUT_TYPES = {
    "Email": "email",
    "Phone": "tel",
    "MobilePhone": "tel",
}


class ConnectedSystemsError(RuntimeError):
    """Base error for Connected Systems failures."""

    status_code = 500
    code = "CONNECTED_SYSTEMS_ERROR"

    def __init__(self, message: str, *, code: str | None = None, status_code: int | None = None):
        self.message = message
        if code:
            self.code = code
        if status_code:
            self.status_code = status_code
        super().__init__(message)


class ConnectedSystemNotFoundError(ConnectedSystemsError):
    status_code = 404
    code = "CONNECTED_SYSTEM_NOT_FOUND"


class ConnectedSystemValidationError(ConnectedSystemsError):
    status_code = 422
    code = "CONNECTED_SYSTEM_VALIDATION_FAILED"


class ConnectedSystemBlockedError(ConnectedSystemsError):
    status_code = 403
    code = "CONNECTED_SYSTEM_ACTION_BLOCKED"


class ConnectedSystemConfigurationError(ConnectedSystemsError):
    status_code = 503
    code = "CONNECTED_SYSTEM_NOT_CONFIGURED"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clean_text(value: Any, *, max_length: int = 512) -> str:
    text = " ".join(str(value or "").split())
    if len(text) > max_length:
        text = text[:max_length]
    return text


def _parse_crm_phone_parts(value: Any) -> tuple[str, str, str]:
    """Parse E.164 phone string into (country_code, national_number, fallback)."""
    raw = str(value or "").strip()
    fallback = _normalize_crm_phone_for_mcp(raw)
    if not raw.startswith("+"):
        return "", fallback, fallback
    try:
        import phonenumbers

        parsed = phonenumbers.parse(raw, None)
        if not phonenumbers.is_valid_number(parsed):
            return "", fallback, fallback

        country_code = f"+{parsed.country_code}"
        national_number = str(parsed.national_number)
        return country_code, national_number, fallback
    except Exception:
        return "", fallback, fallback


def _normalize_crm_phone_for_mcp(value: Any) -> str:
    clean = _clean_text(value, max_length=80)
    digits = re.sub(r"\D", "", clean)
    if len(digits) == 11 and digits.startswith("1"):
        return digits[1:]
    return digits or clean


def _deepcopy_json(value: Any) -> Any:
    return copy.deepcopy(value)


def _ensure_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _ensure_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return list(value)
    if isinstance(value, tuple):
        return list(value)
    return []


def _response_contract(value: Any) -> dict[str, Any]:
    """Return a defensive copy of non-secret registry response metadata."""
    return _ensure_dict(value)


def _contract_path(contract: dict[str, Any], key: str) -> tuple[str | int, ...] | None:
    raw = contract.get(key)
    if not isinstance(raw, (list, tuple)) or not raw:
        return None
    path: list[str | int] = []
    for segment in raw:
        if isinstance(segment, int) and segment >= 0:
            path.append(segment)
        elif isinstance(segment, str) and segment.strip() and len(segment.strip()) <= 80:
            path.append(segment.strip())
        else:
            return None
    return tuple(path)


def _value_at_contract_path(value: Any, path: tuple[str | int, ...] | None) -> Any:
    if not path:
        return None
    current = value
    for segment in path:
        if isinstance(segment, int):
            if not isinstance(current, list) or segment >= len(current):
                return None
            current = current[segment]
        else:
            if not isinstance(current, dict):
                return None
            current = current.get(segment)
    return current


def _operation_response_contract(
    system: "ConnectedSystemDefinition", operation: str
) -> dict[str, Any]:
    return _response_contract((system.operation(operation) or {}).get("responseContract"))


def _operation_request_style(system: "ConnectedSystemDefinition", operation: str) -> str:
    """Read the registered request-shape selector without making it executable."""
    return _clean_text(
        _operation_response_contract(system, operation).get("requestStyle"), max_length=80
    )


def _has_contract_path(contract: dict[str, Any], key: str) -> bool:
    return _contract_path(contract, key) is not None


def _valid_operation_response_contract(operation: str, contract: dict[str, Any]) -> bool:
    """Validate the small, non-executable response-mapping language.

    The registry deliberately stores fixed path segments rather than JSONPath
    expressions. A malformed mapping is configuration unavailable, never an
    invitation to heuristically inspect an upstream CRM response.
    """
    version = str(contract.get("version") or "")
    if operation == "schema":
        return (
            version == "crm-primary-object-schema.v1"
            and _has_contract_path(contract, "fieldsPath")
            and _has_contract_path(contract, "objectPath")
        )
    if operation == "read":
        return (
            version == "crm-record-collection.v1"
            and _has_contract_path(contract, "recordsPath")
            and _has_contract_path(contract, "recordIdPath")
        )
    if operation in {"create", "update", "delete"}:
        success_policy = _clean_text(contract.get("successPolicy"), max_length=80)
        return (
            version == "crm-mutation-result.v1"
            and (
                success_policy == "mcp_is_error_false"
                or (
                    _has_contract_path(contract, "successPath")
                    and isinstance(contract.get("successValue"), (bool, str, int, float))
                )
            )
            # A create must return the newly-created identifier. Updates and
            # deletes operate on a previously owner-bound identifier, so their
            # response need only confirm success.
            and (operation != "create" or _has_contract_path(contract, "recordIdPath"))
        )
    return False


def _record_id_from_result(
    result: dict[str, Any], *, response_contract: dict[str, Any] | None = None
) -> str | None:
    path = _contract_path(_response_contract(response_contract), "recordIdPath")
    if path:
        return _clean_text(_value_at_contract_path(result, path), max_length=128)
    # The in-code test/demo connector predates registry response contracts.
    # Production registry calls always provide a contract before reaching here.
    return _extract_record_id(result)


def _mutation_succeeded(
    result: dict[str, Any], *, response_contract: dict[str, Any] | None = None
) -> bool:
    if result.get("isError"):
        return False
    contract = _response_contract(response_contract)
    if _clean_text(contract.get("successPolicy"), max_length=80) == "mcp_is_error_false":
        # The registered MCP tool has an intentionally empty success payload.
        # This is explicit registry policy; update/delete still require an
        # independently verified state readback before becoming terminal.
        return True
    path = _contract_path(contract, "successPath")
    if path:
        return _value_at_contract_path(result, path) is contract.get("successValue")
    # Compatibility for the deterministic in-code test adapter only.
    return not result.get("isError")


def _safe_record_value(value: Any) -> str | int | float | bool | None:
    """Keep a normalized record projection scalar-only.

    Related-record blobs and arbitrary nested tool content are not safe to
    surface merely because the outer field name happened to be requested.
    """
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return None


def _sanitize_read_records(
    result: dict[str, Any],
    *,
    response_contract: dict[str, Any] | None,
    allowed_fields: list[str],
) -> list[dict[str, Any]]:
    """Project a registered read collection onto explicitly requested fields."""
    contract = _response_contract(response_contract)
    records_path = _contract_path(contract, "recordsPath")
    raw_records = _value_at_contract_path(result, records_path) if records_path else None
    if not isinstance(raw_records, list):
        if contract:
            raise ConnectedSystemConfigurationError(
                "The connected system returned an invalid record collection.",
                code="CONNECTED_SYSTEM_READ_RESPONSE_INVALID",
                status_code=502,
            )
        # Compatibility-only fallback for the deterministic in-code adapter.
        raw_records = _records_from_payload(_ensure_dict(result.get("payload")))
    allowed = [str(field) for field in dict.fromkeys(allowed_fields) if str(field).strip()]
    sanitized: list[dict[str, Any]] = []
    for record in raw_records:
        if not isinstance(record, dict):
            continue
        record_allowed = allowed if contract else [str(key) for key in record]
        by_lower = {str(key).lower(): value for key, value in record.items()}
        fields: dict[str, str | int | float | bool | None] = {}
        for field_name in record_allowed:
            value = record.get(field_name, by_lower.get(field_name.lower()))
            safe_value = _safe_record_value(value)
            if value is None or safe_value is not None:
                fields[field_name] = safe_value
        record_id = _clean_text(
            _value_at_contract_path(record, _contract_path(contract, "recordIdPath")),
            max_length=128,
        )
        if not record_id and not contract:
            record_id = _extract_record_id({"payload": record})
        sanitized.append({"recordId": record_id, "fields": fields})
    return sanitized


def _normalize_object_type(object_type: str | None, *, default: str) -> str:
    value = _clean_text(object_type or default, max_length=80)
    if not value:
        raise ConnectedSystemValidationError("A CRM object type is required.")
    return value


def _normalize_field_name(field_name: str) -> str:
    raw = _clean_text(field_name, max_length=80)
    if not raw:
        raise ConnectedSystemValidationError("CRM field names cannot be empty.")
    canonical = _CRM_FIELD_ALIASES.get(raw.replace(" ", "").lower()) or _CRM_FIELD_ALIASES.get(
        raw.lower()
    )
    canonical = canonical or raw
    if canonical not in SUPPORTED_CRM_FIELDS:
        raise ConnectedSystemValidationError(
            f"Unsupported CRM field: {raw}",
            code="UNSUPPORTED_CRM_FIELD",
        )
    return canonical


def _canonical_schema_field_name(field_name: Any) -> str | None:
    raw = _clean_text(field_name, max_length=80)
    if not raw:
        return None
    canonical = _CRM_FIELD_ALIASES.get(raw.replace(" ", "").lower()) or _CRM_FIELD_ALIASES.get(
        raw.lower()
    )
    # Schema field names are owned by the active CRM. The legacy aliases
    # remain only for the compatibility adapter below; never discard a field
    # simply because another CRM uses a different vocabulary.
    return canonical or raw


def _schema_field_name_from_descriptor(descriptor: Any) -> str | None:
    if isinstance(descriptor, str):
        return descriptor
    if not isinstance(descriptor, dict):
        return None
    for key in ("name", "apiName", "fieldName", "field", "key"):
        candidate = descriptor.get(key)
        if isinstance(candidate, str) and candidate.strip():
            return candidate
    return None


def _schema_label_from_descriptor(descriptor: Any) -> str | None:
    if not isinstance(descriptor, dict):
        return None
    for key in ("label", "displayLabel", "displayName", "title"):
        candidate = descriptor.get(key)
        if isinstance(candidate, str) and candidate.strip():
            return _clean_text(candidate, max_length=80)
    return None


def _schema_type_from_descriptor(descriptor: Any) -> str | None:
    if not isinstance(descriptor, dict):
        return None
    for key in ("type", "dataType", "fieldType", "soapType"):
        candidate = descriptor.get(key)
        if isinstance(candidate, str) and candidate.strip():
            return _clean_text(candidate, max_length=80)
    return None


def _schema_constraints_from_descriptor(descriptor: Any) -> dict[str, Any]:
    """Normalize the portable subset of schema constraints for the UI/API."""
    source = _ensure_dict(descriptor)
    constraints = _ensure_dict(source.get("constraints"))
    max_length = source.get("maxLength", source.get("length"))
    if isinstance(max_length, int) and max_length > 0:
        constraints["maxLength"] = max_length
    allowed_values = source.get("allowedValues", source.get("picklistValues"))
    if isinstance(allowed_values, list):
        normalized_values: list[str] = []
        for value in allowed_values:
            if isinstance(value, str) and value.strip():
                normalized_values.append(value.strip())
            elif isinstance(value, dict):
                candidate = _clean_text(value.get("value", value.get("label")), max_length=240)
                if candidate:
                    normalized_values.append(candidate)
        if normalized_values:
            constraints["allowedValues"] = list(dict.fromkeys(normalized_values))
    return constraints


def _schema_object_metadata(
    result: dict[str, Any],
    *,
    response_contract: dict[str, Any] | None,
    default_object_type: str,
) -> dict[str, str]:
    """Expose only registered primary-object metadata, never its raw envelope."""
    contract = _response_contract(response_contract)
    object_node = _value_at_contract_path(result, _contract_path(contract, "objectPath"))
    source = _ensure_dict(object_node)
    name = (
        _clean_text(
            source.get(
                "objectType", source.get("apiName", source.get("name", default_object_type))
            ),
            max_length=80,
        )
        or default_object_type
    )
    label = (
        _clean_text(
            source.get("objectLabel", source.get("displayName", source.get("label", name))),
            max_length=120,
        )
        or name
    )
    return {"name": name, "label": label}


def _collect_schema_field_descriptors(
    node: Any, *, response_contract: dict[str, Any] | None = None
) -> list[Any]:
    """Collect descriptors only from the registered schema response shape.

    The legacy recursive extractor is retained for deterministic in-code test
    fixtures. Registry-backed integrations must declare ``fieldsPath`` so a
    new CRM cannot become writable because its response happened to contain a
    similarly named nested key.
    """
    contract = _response_contract(response_contract)
    fields_path = _contract_path(contract, "fieldsPath")
    if fields_path:
        value = _value_at_contract_path(node, fields_path)
        if isinstance(value, (list, tuple)):
            return list(value)
        if isinstance(value, dict):
            return [
                {"name": str(field_name), **descriptor}
                if isinstance(descriptor, dict)
                else str(field_name)
                for field_name, descriptor in value.items()
            ]
        return []

    descriptors: list[Any] = []
    if not isinstance(node, dict):
        return descriptors

    for key in ("fields", "fieldList", "objectFields"):
        value = node.get(key)
        if isinstance(value, (list, tuple)):
            descriptors.extend(value)
        elif isinstance(value, dict):
            for field_name, descriptor in value.items():
                if isinstance(descriptor, dict):
                    descriptors.append({"name": str(field_name), **descriptor})
                else:
                    descriptors.append(str(field_name))

    properties = node.get("properties")
    if isinstance(properties, dict):
        for field_name, descriptor in properties.items():
            if isinstance(descriptor, dict):
                descriptors.append({"name": str(field_name), **descriptor})
            else:
                descriptors.append(str(field_name))

    for key in ("payload", "schema", "objectSchema", DEFAULT_OBJECT_TYPE, "data", "result"):
        value = node.get(key)
        if isinstance(value, dict):
            descriptors.extend(_collect_schema_field_descriptors(value))

    return descriptors


def _collect_schema_required_candidates(
    node: Any, *, response_contract: dict[str, Any] | None = None
) -> list[str]:
    candidates: list[str] = []
    if not isinstance(node, dict):
        return candidates

    for key in ("requiredFields", "required"):
        value = node.get(key)
        if isinstance(value, (list, tuple)):
            for item in value:
                field_name = _schema_field_name_from_descriptor(item)
                if field_name:
                    candidates.append(field_name)
        elif isinstance(value, dict):
            candidates.extend(str(field_name) for field_name in value.keys())

    for key in ("payload", "schema", "objectSchema", DEFAULT_OBJECT_TYPE, "data", "result"):
        value = node.get(key)
        if isinstance(value, dict):
            candidates.extend(_collect_schema_required_candidates(value))

    return candidates


def _descriptor_bool(descriptor: Any, *names: str) -> bool | None:
    if not isinstance(descriptor, dict):
        return None
    for name in names:
        value = descriptor.get(name)
        if isinstance(value, bool):
            return value
    return None


def _schema_fields_from_schema_result(
    result: dict[str, Any], *, response_contract: dict[str, Any] | None = None
) -> list[dict[str, Any]]:
    contract = _response_contract(response_contract)
    required_fields = {
        canonical
        for candidate in _collect_schema_required_candidates(result, response_contract=contract)
        if (canonical := _canonical_schema_field_name(candidate))
    }
    fields: list[dict[str, Any]] = []
    seen: set[str] = set()

    def _append_field(
        *,
        canonical: str,
        raw_name: str | None,
        descriptor: Any = None,
        source: str = "mcp_schema",
    ) -> None:
        if canonical in seen:
            return
        seen.add(canonical)
        identity = _descriptor_bool(
            descriptor, "identityField", "identity", "primaryKey", "identifier"
        )
        immutable = _descriptor_bool(descriptor, "immutable", "readOnly")
        readable = _descriptor_bool(descriptor, "readable", "isReadable")
        createable = _descriptor_bool(descriptor, "createable", "isCreateable")
        updateable = _descriptor_bool(descriptor, "updateable", "isUpdateable")
        descriptor_required = _descriptor_bool(descriptor, "required", "isRequired")
        defaulted_on_create = _descriptor_bool(
            descriptor,
            "defaultedOnCreate",
            "defaulted_on_create",
            "serverManaged",
            "systemManaged",
        )
        # CRM schemas often expose a catalogue before they expose field-level
        # access metadata. Keep that metadata optional: an omitted access bit
        # means "not declared", not an inferred deny or allow. Operation tool
        # mappings and the owner-bound record id remain the execution boundary.
        # We can safely recognize a record id descriptor without asking a
        # partner to add our redundant `identityField` extension.
        type_value = (_schema_type_from_descriptor(descriptor) or "").lower()
        raw_name_value = str(raw_name or canonical).strip().lower()
        if identity is None and (
            type_value == "id" or raw_name_value in {"id", "recordid", "record_id"}
        ):
            identity = True
        permissions_declared = all(
            value is not None for value in (identity, immutable, readable, createable, updateable)
        )
        writable = (
            bool(createable is True or updateable is True)
            if createable is not None or updateable is not None
            else None
        )
        fields.append(
            {
                "key": canonical,
                "name": raw_name or canonical,
                "label": _schema_label_from_descriptor(descriptor) or canonical,
                "dataType": _schema_type_from_descriptor(descriptor) or "string",
                "required": bool(descriptor_required) or canonical in required_fields,
                "identityField": identity,
                "readable": readable,
                "createable": createable,
                "updateable": updateable,
                "writable": writable,
                "immutable": immutable,
                "defaultedOnCreate": defaulted_on_create,
                "permissionsDeclared": permissions_declared,
                "constraints": _schema_constraints_from_descriptor(descriptor),
                "source": source,
            }
        )

    for descriptor in _collect_schema_field_descriptors(result, response_contract=contract):
        raw_name = _schema_field_name_from_descriptor(descriptor)
        canonical = _canonical_schema_field_name(raw_name)
        if canonical:
            _append_field(canonical=canonical, raw_name=raw_name, descriptor=descriptor)

    for canonical in required_fields:
        _append_field(canonical=canonical, raw_name=canonical)

    return fields


def _supported_fields_from_schema_result(result: dict[str, Any]) -> list[str]:
    canonical_fields: list[str] = []
    for field in _schema_fields_from_schema_result(result):
        candidate = field.get("key")
        canonical = _canonical_schema_field_name(candidate)
        if canonical and canonical not in canonical_fields:
            canonical_fields.append(canonical)
    return canonical_fields


def _normalize_additional_fields(additional_fields: dict[str, Any] | None) -> dict[str, Any]:
    if not additional_fields:
        return {}
    if not isinstance(additional_fields, dict):
        raise ConnectedSystemValidationError("additionalFields must be an object.")
    normalized: dict[str, Any] = {}
    for key, value in additional_fields.items():
        normalized[_normalize_field_name(str(key))] = value
    return normalized


def _normalize_search_field_name(field_name: str) -> str:
    raw = _clean_text(field_name, max_length=80)
    if not raw:
        raise ConnectedSystemValidationError("CRM search field names cannot be empty.")
    canonical = _CRM_SEARCH_FIELD_ALIASES.get(
        raw.replace(" ", "").lower()
    ) or _CRM_SEARCH_FIELD_ALIASES.get(raw.lower())
    canonical = canonical or raw
    if canonical not in SUPPORTED_CRM_SEARCH_FIELDS:
        raise ConnectedSystemValidationError(
            f"Unsupported CRM search field: {raw}",
            code="UNSUPPORTED_CRM_FIELD",
        )
    return canonical


def _normalize_search_fields(search_fields: dict[str, Any] | None) -> dict[str, Any]:
    if not search_fields:
        return {}
    if not isinstance(search_fields, dict):
        raise ConnectedSystemValidationError("searchFields must be an object.")
    normalized: dict[str, Any] = {}
    for key, value in search_fields.items():
        normalized[_normalize_search_field_name(str(key))] = value
    return normalized


def _normalize_return_fields(return_fields: list[str] | None) -> list[str]:
    normalized: list[str] = []
    for field_name in return_fields or []:
        canonical = _normalize_field_name(field_name)
        if canonical not in normalized:
            normalized.append(canonical)
    return normalized


def _intent_id() -> str:
    return f"csi_{uuid4().hex}"


def _approval_id() -> str:
    return f"csa_{uuid4().hex}"


def _binding_id() -> str:
    return f"csb_{uuid4().hex}"


def _safe_error_message(error: Exception) -> str:
    message = _redact_error_text(_clean_text(str(error), max_length=240))
    return message or "Connected Systems request failed."


def _http_status_from_error(error: BaseException, *, _seen: set[int] | None = None) -> int | None:
    """Find a nested HTTP status without serialising a provider exception."""
    seen = _seen if _seen is not None else set()
    if id(error) in seen:
        return None
    seen.add(id(error))
    response = getattr(error, "response", None)
    status_code = getattr(response, "status_code", None)
    if isinstance(status_code, int):
        return status_code
    nested = getattr(error, "exceptions", None)
    if isinstance(nested, (tuple, list)):
        for child in nested:
            status = _http_status_from_error(child, _seen=seen)
            if status is not None:
                return status
    for nested_error in (getattr(error, "__cause__", None), getattr(error, "__context__", None)):
        if isinstance(nested_error, BaseException):
            status = _http_status_from_error(nested_error, _seen=seen)
            if status is not None:
                return status
    return None


def _connected_systems_storage_error(error: DatabaseExecutionError) -> ConnectedSystemsError:
    details = str(getattr(error, "details", "") or "")
    code = (
        "CONNECTED_SYSTEMS_SCHEMA_NOT_READY"
        if "connected_system_" in details.lower() or "connected_system_" in str(error).lower()
        else getattr(error, "code", "CONNECTED_SYSTEMS_STORAGE_ERROR")
    )
    message = (
        "Connected Systems workflow storage is not ready."
        if code == "CONNECTED_SYSTEMS_SCHEMA_NOT_READY"
        else "Connected Systems workflow storage is temporarily unavailable."
    )
    status_code = getattr(error, "status_code", 500)
    return ConnectedSystemsError(
        message,
        code=code,
        status_code=503 if status_code >= 500 else status_code,
    )


def _redact_error_text(value: str) -> str:
    text = re.sub(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", "[email]", value)
    text = re.sub(r"\+?\d[\d\s().-]{6,}\d", "[phone]", text)
    return text


def _mcp_error_message(result: dict[str, Any]) -> str:
    payload = _ensure_dict(result.get("payload"))
    errors = payload.get("errors")
    if isinstance(errors, list):
        for item in errors:
            if isinstance(item, dict):
                for key in ("message", "errorMessage", "error", "detail"):
                    message = _clean_text(item.get(key), max_length=240)
                    if message:
                        return _redact_error_text(message)
            else:
                message = _clean_text(item, max_length=240)
                if message:
                    return _redact_error_text(message)
    for key in ("message", "errorMessage", "error", "detail", "text"):
        message = _clean_text(payload.get(key), max_length=240)
        if message:
            return _redact_error_text(message)
    return "CRM MCP returned an error result."


def _stable_keys(value: dict[str, Any] | None) -> list[str]:
    return sorted(str(key) for key in (value or {}).keys())


def _summarize_request_payload(payload: dict[str, Any], field_names: list[str]) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "target": payload.get("target"),
        "objectType": payload.get("objectType"),
        "fieldNames": list(dict.fromkeys(field_names)),
    }
    record_id = _clean_text(payload.get("id"), max_length=128)
    if record_id:
        summary["id"] = record_id
    if payload.get("email"):
        summary["emailPresent"] = True
    if payload.get("phone"):
        summary["phonePresent"] = True
    if isinstance(payload.get("additionalFields"), dict):
        summary["additionalFieldNames"] = _stable_keys(payload.get("additionalFields"))
    if isinstance(payload.get("searchFields"), dict):
        summary["searchFieldNames"] = _stable_keys(payload.get("searchFields"))
    if isinstance(payload.get("returnFields"), list):
        summary["returnFields"] = [str(field) for field in payload.get("returnFields") or []]
    return {key: value for key, value in summary.items() if value not in (None, "", [], {})}


def _summarize_readback_payload(payload: dict[str, Any]) -> dict[str, Any]:
    if not payload:
        return {}
    summary: dict[str, Any] = {
        "target": payload.get("target"),
        "objectType": payload.get("objectType"),
    }
    if payload.get("email"):
        summary["emailLocatorPresent"] = True
    if payload.get("phone"):
        summary["phoneLocatorPresent"] = True
    if isinstance(payload.get("searchFields"), dict):
        summary["searchFieldNames"] = _stable_keys(payload.get("searchFields"))
    if isinstance(payload.get("returnFields"), list):
        summary["returnFields"] = [str(field) for field in payload.get("returnFields") or []]
    return {key: value for key, value in summary.items() if value not in (None, "", [], {})}


def _summarize_mcp_result(result: dict[str, Any]) -> dict[str, Any]:
    if not result:
        return {}
    payload = _ensure_dict(result.get("payload"))
    summary: dict[str, Any] = {
        "isError": bool(result.get("isError")),
        "payloadKeys": _stable_keys(payload),
    }
    record_id = _extract_record_id(result)
    if record_id:
        summary["recordId"] = record_id
    records = _records_from_payload(payload)
    if records:
        summary["recordCount"] = len(records)
    if isinstance(payload.get("success"), bool):
        summary["success"] = payload.get("success")
    if isinstance(payload.get("responseCode"), int):
        summary["responseCode"] = payload.get("responseCode")
    return {key: value for key, value in summary.items() if value not in (None, "", [], {})}


def _summarize_readback_result(readback: dict[str, Any]) -> dict[str, Any]:
    if not readback:
        return {}
    summary: dict[str, Any] = {
        "resultClass": readback.get("resultClass"),
        "reason": readback.get("reason"),
    }
    records = _records_from_readback(readback)
    if records:
        summary["recordCount"] = len(records)
    if isinstance(readback.get("mcp"), dict):
        summary["mcp"] = _summarize_mcp_result(readback.get("mcp") or {})
    return {key: value for key, value in summary.items() if value not in (None, "", [], {})}


def _scrub_terminal_intent_updates(
    intent: dict[str, Any], updates: dict[str, Any]
) -> dict[str, Any]:
    merged = {**_deepcopy_json(intent), **_deepcopy_json(updates)}
    if merged.get("status") not in TERMINAL_INTENT_STATUSES:
        return updates
    return {
        **updates,
        "request_payload": _summarize_request_payload(
            _ensure_dict(merged.get("request_payload")),
            [str(field) for field in merged.get("field_names") or []],
        ),
        "readback_payload": _summarize_readback_payload(
            _ensure_dict(merged.get("readback_payload"))
        ),
        "result_payload": _summarize_mcp_result(_ensure_dict(merged.get("result_payload"))),
        "readback_result": _summarize_readback_result(_ensure_dict(merged.get("readback_result"))),
    }


@dataclass(frozen=True)
class ConnectedSystemDefinition:
    system_id: str
    display_name: str
    customer_display_name: str
    system_type: str
    system_name: str
    target: str
    object_type_default: str
    transport: str
    transport_endpoint: str | None
    registry_source: str
    tool_catalog: tuple[dict[str, Any], ...]
    # Decrypted transport auth headers (e.g. client_id / client_secret) carried
    # from the DB registry into the MCP streamable-HTTP call. Default empty keeps
    # the hardcoded in-code definitions backward compatible. NEVER surfaced in
    # to_summary() — headers must not leak through the API.
    transport_headers: tuple[tuple[str, str], ...] = ()
    # Extra MCP tool arguments sourced from the private registry row. These are
    # never exposed in to_summary(); they are merged into the tool call payload.
    transport_tool_arguments: dict[str, Any] | None = None
    # Salesforce delete uses a different endpoint path than schema/CRUD-read, so
    # the registry can carry a dedicated delete endpoint. None → fall back to
    # transport_endpoint. Only consulted when supports_delete is enabled.
    delete_transport_endpoint: str | None = None
    # Registry-projected executable capabilities. A tool catalog entry alone is
    # descriptive; an operation is executable only when it is declared here,
    # has a registered tool, and has a transport endpoint.
    capabilities: frozenset[str] = frozenset({"schema", "read", "create", "update", "delete"})
    timeout_seconds: float = 30.0
    retry_count: int = 0
    # Internal DB identity and monotonic configuration version. Neither carries
    # credentials; both make cache invalidation deterministic for aliased IDs.
    registry_id: str | None = None
    configuration_revision: int = 1
    # The external CRM field-value profile is deliberately narrow: browser and
    # MuleSoft handle the values; Hussh only validates envelope metadata,
    # owner authority, schema and the server-bound CRM record.
    crm_encrypted_fields_v1_enabled: bool = False
    crm_encrypted_fields_recipient_key: dict[str, Any] | None = None

    def operation(self, operation: str) -> dict[str, Any] | None:
        return next(
            (
                _deepcopy_json(tool)
                for tool in self.tool_catalog
                if str(tool.get("operation") or "").strip() == operation
            ),
            None,
        )

    def object_type_for_operation(self, operation: str) -> str:
        configured = str((self.operation(operation) or {}).get("objectType") or "").strip()
        return configured or self.object_type_default

    def crm_encrypted_fields_ready(self, operation: str) -> bool:
        key = self.crm_encrypted_fields_recipient_key or {}
        try:
            validate_crm_encrypted_fields_recipient_key(key)
        except Exception:
            return False
        return bool(
            self.crm_encrypted_fields_v1_enabled
            and _crm_encrypted_fields_runtime_enabled()
            and operation in {"read", "update"}
            and self.crm_encrypted_fields_tool_name(operation)
            and key.get("keyId")
            and key.get("publicKey")
            and key.get("publicKeyFingerprint")
            and key.get("environment") == "sandbox"
        )

    def crm_encrypted_fields_tool_name(self, operation: str) -> str | None:
        if not self.crm_encrypted_fields_v1_enabled or operation not in {"read", "update"}:
            return None
        tool = self.operation(operation) or {}
        name = str(tool.get("crmEncryptedFieldsToolName") or "").strip()
        return name or None

    def operation_endpoint(self, operation: str) -> str | None:
        tool = self.operation(operation) or {}
        configured = str(tool.get("mcpEndpoint") or "").strip()
        # A legacy registry could contain a path-only operation endpoint. It is
        # not a valid Streamable HTTP target on its own; preserve the system's
        # registered absolute transport endpoint until that row is explicitly
        # configured with an absolute per-operation URL.
        if configured.startswith(("https://", "http://", "registry://")):
            return configured
        delete_override = str(self.delete_transport_endpoint or "").strip()
        # `crm_delete_endpoint` was historically populated with a path on some
        # rows. A path cannot be a Streamable HTTP MCP target by itself; use it
        # only when it is an actual absolute endpoint and otherwise keep the
        # registered base MCP transport.
        if operation == "delete" and delete_override.startswith(
            ("https://", "http://", "registry://")
        ):
            return delete_override
        return str(self.transport_endpoint or "").strip() or None

    def supports(self, operation: str) -> bool:
        # A schema is mandatory for executable record actions so an untyped
        # connector cannot become write-capable merely by advertising a tool.
        if operation not in self.capabilities or not self.operation(operation):
            return False
        if not self.operation_endpoint(operation):
            return False
        if operation != "schema" and not self.operation("schema"):
            return False
        if (
            self.registry_source == "enterprise_crm_registry"
            and not _valid_operation_response_contract(
                operation, _operation_response_contract(self, operation)
            )
        ):
            return False
        return bool(self.operation_endpoint("schema"))

    def to_summary(self, *, endpoint_configured: bool, delete_enabled: bool) -> dict[str, Any]:
        supported_actions = {
            operation: self.supports(operation) and (operation != "delete" or delete_enabled)
            for operation in ("schema", "read", "create", "update", "delete")
        }
        # The registry, never a browser-supplied object name, owns the record
        # type used by each operation. This makes a Person Account create /
        # Contact read-update lifecycle explicit without exposing record IDs.
        operation_object_types = {
            operation: self.object_type_for_operation(operation)
            for operation, enabled in supported_actions.items()
            if enabled
        }
        return {
            "systemId": self.system_id,
            "configurationRevision": self.configuration_revision,
            "displayName": self.display_name,
            "customerDisplayName": self.customer_display_name,
            "systemType": self.system_type,
            "systemName": self.system_name,
            "status": "connected" if endpoint_configured else "needs_configuration",
            "target": self.target,
            "objectTypeDefault": self.object_type_default,
            "operationObjectTypes": operation_object_types,
            "transport": self.transport,
            "transportLabel": "External CRM MCP",
            "endpointConfigured": endpoint_configured,
            "registrySource": self.registry_source,
            "toolCatalog": [
                {
                    key: _deepcopy_json(value)
                    for key, value in tool.items()
                    if key != "responseContract"
                }
                for tool in self.tool_catalog
            ],
            "supportedActions": supported_actions,
            "capabilities": {
                "operations": [
                    operation for operation, enabled in supported_actions.items() if enabled
                ],
                "primaryObject": self.object_type_default,
                "version": "crm-operation-contract.v1",
            },
            "crmEncryptedFields": {
                "enabled": self.crm_encrypted_fields_v1_enabled,
                "profile": (
                    CRM_ENCRYPTED_FIELDS_V1_PROFILE
                    if self.crm_encrypted_fields_v1_enabled
                    else None
                ),
                "readReady": self.crm_encrypted_fields_ready("read"),
                "updateReady": self.crm_encrypted_fields_ready("update"),
            },
        }


SALESFORCE_CRM_SYSTEM = ConnectedSystemDefinition(
    system_id=CONNECTED_SYSTEM_SALESFORCE_ID,
    display_name="Macy's",
    customer_display_name="Macy's",
    system_type="Salesforce",
    system_name="FSC",
    target=DEFAULT_TARGET,
    object_type_default=DEFAULT_OBJECT_TYPE,
    transport=EXTERNAL_CRM_TRANSPORT,
    transport_endpoint=REGISTRY_MCP_ENDPOINT,
    registry_source=REGISTRY_SOURCE,
    tool_catalog=EXTERNAL_CRM_TOOL_CATALOG,
    capabilities=frozenset({"schema", "read", "create", "update", "delete"}),
)


class ExternalCrmStreamableMcpAdapter:
    """Calls a registered external CRM through MCP Streamable HTTP."""

    def __init__(
        self,
        endpoint: str | None = None,
        *,
        timeout_seconds: float = 30.0,
        tool_catalog: tuple[dict[str, Any], ...] | None = None,
        headers: tuple[tuple[str, str], ...] = (),
        tool_arguments: dict[str, Any] | None = None,
    ):
        self.endpoint = endpoint
        self.timeout_seconds = timeout_seconds
        self.tool_catalog = tuple(tool_catalog or ())
        self.headers = tuple(headers or ())
        self.tool_arguments = _deepcopy_json(tool_arguments or {})
        self._demo_record: dict[str, Any] = {
            "Id": "003gK00000jlmaLQAQ",
            "FirstName": "Maria",
            "LastName": "Joe",
            "Email": "maria.joe@abc.com",
            "Phone": "123456789",
            "MobilePhone": "",
            "Title": "VP Sales",
            "Department": "",
            "MailingCity": "Dallas",
            "MailingStreet": "",
            "LeadSource": "",
        }

    @classmethod
    def from_registry(
        cls,
        system: ConnectedSystemDefinition = SALESFORCE_CRM_SYSTEM,
    ) -> "ExternalCrmStreamableMcpAdapter":
        return cls(
            endpoint=system.transport_endpoint,
            tool_catalog=system.tool_catalog,
            headers=system.transport_headers,
            tool_arguments=system.transport_tool_arguments,
        )

    @property
    def configured(self) -> bool:
        return bool(self.endpoint)

    async def object_schema(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._call_tool("object-schema", payload)

    async def read_record(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._call_tool("read-crm-record", payload)

    async def create_record(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._call_tool("create-crm-record", payload)

    async def update_record(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._call_tool("update-crm-record", payload)

    async def delete_record(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._call_tool("delete-crm-record", payload)

    async def call_operation(
        self,
        *,
        operation: str,
        tool_name: str,
        endpoint: str | None,
        timeout_seconds: float,
        retry_count: int,
        arguments: dict[str, Any],
        replace_tool_arguments: bool = False,
    ) -> dict[str, Any]:
        # Only idempotent discovery/read operations may retry. Retrying a write
        # without a connector idempotency contract could duplicate a CRM record.
        attempts = max(1, (int(retry_count) + 1) if operation in {"schema", "read"} else 1)
        last_error: ConnectedSystemsError | None = None
        for _ in range(attempts):
            try:
                return await self._call_tool(
                    tool_name,
                    arguments,
                    endpoint=endpoint,
                    timeout_seconds=timeout_seconds,
                    replace_tool_arguments=replace_tool_arguments,
                )
            except ConnectedSystemsError as error:
                last_error = error
        if last_error is None:
            raise ConnectedSystemsError("CRM MCP operation completed without a result.")
        raise last_error

    async def _call_tool(
        self,
        name: str,
        arguments: dict[str, Any],
        *,
        endpoint: str | None = None,
        timeout_seconds: float | None = None,
        replace_tool_arguments: bool = False,
    ) -> dict[str, Any]:
        resolved_endpoint = endpoint or self.endpoint
        if not resolved_endpoint:
            raise ConnectedSystemConfigurationError(
                "Connected Systems registry does not include a CRM MCP endpoint."
            )
        if resolved_endpoint == REGISTRY_MCP_ENDPOINT and not self.headers:
            raise ConnectedSystemConfigurationError(
                "This connected system is not configured in this environment.",
                code="CONNECTED_SYSTEM_GATEWAY_AUTH_UNCONFIGURED",
            )
        if resolved_endpoint.startswith("registry://"):
            return self._call_registry_tool(name, arguments)

        # Encrypted-fields calls are allowed to use only a trusted connector
        # reference.
        # Do not merge the legacy registry credentials/URLs into their MCP
        # arguments: MuleSoft resolves those from its own secret store.
        tool_arguments = (
            _deepcopy_json(arguments)
            if replace_tool_arguments
            else {
                **_deepcopy_json(self.tool_arguments),
                **_deepcopy_json(arguments),
            }
        )

        async def _run() -> dict[str, Any]:
            from mcp.client.session import ClientSession
            from mcp.client.streamable_http import streamablehttp_client

            client_kwargs: dict[str, Any] = {}
            if self.headers:
                client_kwargs["headers"] = dict(self.headers)

            async with streamablehttp_client(resolved_endpoint, **client_kwargs) as (
                read_stream,
                write_stream,
                _,
            ):
                async with ClientSession(read_stream, write_stream) as session:
                    await session.initialize()
                    result = await session.call_tool(name, tool_arguments)
            return _normalize_mcp_tool_result(result)

        try:
            return await asyncio.wait_for(_run(), timeout=timeout_seconds or self.timeout_seconds)
        except ConnectedSystemsError:
            raise
        except TimeoutError as error:
            raise ConnectedSystemsError(
                "Connected system request timed out.",
                code="CONNECTED_SYSTEM_MCP_TIMEOUT",
                status_code=504,
            ) from error
        except Exception as error:
            gateway_status = _http_status_from_error(error)
            logger.exception(
                "connected_systems.crm_mcp_request_failed tool=%s endpoint_configured=%s "
                "headers_present=%s gateway_status=%s tool_argument_keys=%s",
                name,
                bool(self.endpoint),
                bool(self.headers),
                gateway_status,
                _stable_keys(tool_arguments),
            )
            if gateway_status in {401, 403}:
                code = (
                    "CONNECTED_SYSTEM_MCP_AUTH_FAILED"
                    if gateway_status == 401
                    else "CONNECTED_SYSTEM_MCP_ACCESS_DENIED"
                )
                message = (
                    "The connected system gateway rejected this environment's authentication."
                    if gateway_status == 401
                    else "The connected system gateway denied this environment access."
                )
                raise ConnectedSystemConfigurationError(
                    message,
                    code=code,
                    status_code=502,
                ) from error
            raise ConnectedSystemsError(
                "Connected system request failed.",
                code="CONNECTED_SYSTEM_MCP_FAILED",
                status_code=502,
            ) from error

    def _call_registry_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        registered_tool_names = {str(tool.get("name")) for tool in self.tool_catalog}
        if name not in registered_tool_names:
            return {
                "isError": True,
                "payload": {"errors": [{"message": f"Tool {name} is not registered."}]},
            }
        payload = _deepcopy_json(arguments)
        if name == "object-schema":
            return {
                "isError": False,
                "payload": {
                    "target": payload.get("target") or DEFAULT_TARGET,
                    "objectType": payload.get("objectType") or DEFAULT_OBJECT_TYPE,
                    "requiredFields": ["Email", "Phone"],
                    "fields": sorted(SUPPORTED_CRM_FIELDS),
                    "source": REGISTRY_SOURCE,
                },
            }
        if name == "read-crm-record":
            record = _deepcopy_json(self._demo_record)
            return {
                "isError": False,
                "payload": {
                    "target": payload.get("target") or DEFAULT_TARGET,
                    "objectType": payload.get("objectType") or DEFAULT_OBJECT_TYPE,
                    "Contact": [record],
                },
            }
        if name == "create-crm-record":
            next_record = {
                **_deepcopy_json(self._demo_record),
                "Id": "003gK00000registryQAA",
                "Email": payload.get("email"),
                "Phone": payload.get("phone"),
                "FirstName": payload.get("firstName") or "",
                "LastName": payload.get("lastName") or "",
                **_ensure_dict(payload.get("additionalFields")),
            }
            self._demo_record = next_record
            return {"isError": False, "payload": {"success": True, "id": next_record["Id"]}}
        if name == "update-crm-record":
            record_id = _clean_text(payload.get("id"), max_length=128)
            if record_id and record_id != self._demo_record.get("Id"):
                self._demo_record["Id"] = record_id
            self._demo_record.update(_ensure_dict(payload.get("additionalFields")))
            return {
                "isError": False,
                "payload": {
                    "success": True,
                    "id": self._demo_record.get("Id"),
                    "updatedFieldNames": _stable_keys(
                        _ensure_dict(payload.get("additionalFields"))
                    ),
                },
            }
        if name == "delete-crm-record":
            return {
                "isError": False,
                "payload": {"success": True, "deleted": True, "id": payload.get("id")},
            }
        return {
            "isError": True,
            "payload": {"errors": [{"message": f"Unhandled registry tool {name}."}]},
        }


def _normalize_mcp_tool_result(result: Any) -> dict[str, Any]:
    is_error = bool(getattr(result, "isError", False) or getattr(result, "is_error", False))
    texts: list[str] = []
    for item in getattr(result, "content", None) or []:
        text = getattr(item, "text", None)
        if isinstance(text, str):
            texts.append(text)
    if len(texts) == 1:
        try:
            parsed = json.loads(texts[0])
        except json.JSONDecodeError:
            parsed = {"text": texts[0]}
        if isinstance(parsed, dict):
            return {"isError": is_error, "payload": parsed}
        return {"isError": is_error, "payload": {"value": parsed}}
    return {"isError": is_error, "payload": {"content": texts}}


class ConnectedSystemIntentStore:
    def create_intent(self, intent: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError

    def get_intent(self, *, user_id: str, system_id: str, intent_id: str) -> dict[str, Any] | None:
        raise NotImplementedError

    def get_encrypted_intent_by_client_operation(
        self,
        *,
        user_id: str,
        system_id: str,
        delivery_mode: str,
        client_operation_id: str,
    ) -> dict[str, Any] | None:
        raise NotImplementedError

    def update_intent(self, *, intent_id: str, updates: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError

    def claim_pending_intent(self, *, intent_id: str, approval_id: str) -> dict[str, Any]:
        """Atomically transition one pending intent to approved/executing."""
        raise NotImplementedError

    def record_audit_event(self, event: dict[str, Any]) -> None:
        raise NotImplementedError

    def get_binding(
        self, *, user_id: str, system_id: str, object_type: str
    ) -> dict[str, Any] | None:
        raise NotImplementedError

    def list_bindings(self, *, user_id: str) -> list[dict[str, Any]]:
        raise NotImplementedError

    def upsert_binding(self, binding: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError

    def mark_binding_deleted(
        self,
        *,
        user_id: str,
        system_id: str,
        object_type: str,
        record_id: str | None,
        last_intent_id: str | None = None,
    ) -> dict[str, Any] | None:
        raise NotImplementedError

    def mark_binding_disconnected(
        self,
        *,
        user_id: str,
        system_id: str,
        object_type: str,
        record_id: str,
    ) -> dict[str, Any] | None:
        """Retire a stale local pointer without deleting the remote record."""
        raise NotImplementedError


class InMemoryConnectedSystemIntentStore(ConnectedSystemIntentStore):
    """Test and local fallback store."""

    def __init__(self):
        self.intents: dict[str, dict[str, Any]] = {}
        self.audit_events: list[dict[str, Any]] = []
        self.bindings: dict[tuple[str, str, str], dict[str, Any]] = {}

    def create_intent(self, intent: dict[str, Any]) -> dict[str, Any]:
        self.intents[intent["intent_id"]] = _deepcopy_json(intent)
        return _deepcopy_json(intent)

    def get_intent(self, *, user_id: str, system_id: str, intent_id: str) -> dict[str, Any] | None:
        intent = self.intents.get(intent_id)
        if not intent:
            return None
        if intent.get("user_id") != user_id or intent.get("system_id") != system_id:
            return None
        return _deepcopy_json(intent)

    def get_encrypted_intent_by_client_operation(
        self,
        *,
        user_id: str,
        system_id: str,
        delivery_mode: str,
        client_operation_id: str,
    ) -> dict[str, Any] | None:
        return next(
            (
                _deepcopy_json(intent)
                for intent in self.intents.values()
                if intent.get("user_id") == user_id
                and intent.get("system_id") == system_id
                and intent.get("delivery_mode") == delivery_mode
                and intent.get("client_operation_id") == client_operation_id
            ),
            None,
        )

    def claim_pending_intent(self, *, intent_id: str, approval_id: str) -> dict[str, Any]:
        intent = self.intents.get(intent_id)
        if not intent:
            raise ConnectedSystemNotFoundError("CRM intent was not found.")
        if intent.get("status") == "pending":
            intent = {
                **intent,
                "status": "approved",
                "approval_id": approval_id,
                "updated_at": _now_iso(),
            }
            self.intents[intent_id] = intent
        return _deepcopy_json(intent)

    def update_intent(self, *, intent_id: str, updates: dict[str, Any]) -> dict[str, Any]:
        intent = self.intents.get(intent_id)
        if not intent:
            raise ConnectedSystemNotFoundError("CRM intent was not found.")
        next_intent = {
            **intent,
            **_deepcopy_json(updates),
            "updated_at": _now_iso(),
        }
        self.intents[intent_id] = next_intent
        return _deepcopy_json(next_intent)

    def record_audit_event(self, event: dict[str, Any]) -> None:
        self.audit_events.append(_deepcopy_json(event))

    def get_binding(
        self, *, user_id: str, system_id: str, object_type: str
    ) -> dict[str, Any] | None:
        binding = self.bindings.get((user_id, system_id, object_type))
        if not binding or binding.get("status") != "active":
            return None
        return _deepcopy_json(binding)

    def list_bindings(self, *, user_id: str) -> list[dict[str, Any]]:
        return [
            _deepcopy_json(binding)
            for binding in self.bindings.values()
            if binding.get("user_id") == user_id and binding.get("status") == "active"
        ]

    def upsert_binding(self, binding: dict[str, Any]) -> dict[str, Any]:
        key = (binding["user_id"], binding["system_id"], binding["object_type"])
        existing = self.bindings.get(key) or {}
        next_binding = {
            **_deepcopy_json(existing),
            **_deepcopy_json(binding),
            "binding_id": existing.get("binding_id") or binding.get("binding_id") or _binding_id(),
            "created_at": existing.get("created_at") or binding.get("created_at") or _now_iso(),
            "status": "active",
            "updated_at": _now_iso(),
            "deleted_at": None,
        }
        self.bindings[key] = next_binding
        return _deepcopy_json(next_binding)

    def mark_binding_deleted(
        self,
        *,
        user_id: str,
        system_id: str,
        object_type: str,
        record_id: str,
        last_intent_id: str | None = None,
    ) -> dict[str, Any] | None:
        key = (user_id, system_id, object_type)
        binding = self.bindings.get(key)
        if not binding:
            return None
        if binding.get("record_id") != record_id:
            return None
        next_binding = {
            **binding,
            "status": "deleted",
            "last_intent_id": last_intent_id or binding.get("last_intent_id"),
            "updated_at": _now_iso(),
            "deleted_at": _now_iso(),
        }
        self.bindings[key] = next_binding
        return _deepcopy_json(next_binding)

    def mark_binding_disconnected(
        self,
        *,
        user_id: str,
        system_id: str,
        object_type: str,
        record_id: str,
    ) -> dict[str, Any] | None:
        key = (user_id, system_id, object_type)
        binding = self.bindings.get(key)
        if not binding or binding.get("record_id") != record_id:
            return None
        if binding.get("status") != "active":
            return _deepcopy_json(binding)
        next_binding = {
            **binding,
            "status": "disconnected",
            "updated_at": _now_iso(),
            "deleted_at": _now_iso(),
        }
        self.bindings[key] = next_binding
        return _deepcopy_json(next_binding)


class DatabaseConnectedSystemIntentStore(ConnectedSystemIntentStore):
    def __init__(self, db: Any | None = None):
        self._db = db

    @property
    def db(self):
        if self._db is None:
            self._db = get_db()
        return self._db

    def create_intent(self, intent: dict[str, Any]) -> dict[str, Any]:
        rows = self.db.execute_raw(
            """
            INSERT INTO connected_system_intents (
              intent_id,
              user_id,
              system_id,
              action,
              status,
              target,
              object_type,
              record_id,
              approval_id,
              request_payload_json,
              readback_payload_json,
              field_names_json,
              result_payload_json,
              delivery_mode,
              encrypted_fields_json,
              zk_metadata_json,
              envelope_digest,
              client_operation_id,
              approval_challenge_id,
              error_code,
              error_message,
              updated_at
            )
            VALUES (
              :intent_id,
              :user_id,
              :system_id,
              :action,
              :status,
              :target,
              :object_type,
              :record_id,
              :approval_id,
              :request_payload_json,
              :readback_payload_json,
              :field_names_json,
              :result_payload_json,
              :delivery_mode,
              :encrypted_fields_json,
              :zk_metadata_json,
              :envelope_digest,
              :client_operation_id,
              :approval_challenge_id,
              :error_code,
              :error_message,
              NOW()
            )
            RETURNING *
            """,
            _intent_to_db_params(intent),
        ).data
        return _intent_from_db_row(rows[0]) if rows else intent

    def get_intent(self, *, user_id: str, system_id: str, intent_id: str) -> dict[str, Any] | None:
        rows = self.db.execute_raw(
            """
            SELECT *
            FROM connected_system_intents
            WHERE intent_id = :intent_id
              AND user_id = :user_id
              AND system_id = :system_id
            LIMIT 1
            """,
            {"intent_id": intent_id, "user_id": user_id, "system_id": system_id},
        ).data
        return _intent_from_db_row(rows[0]) if rows else None

    def get_encrypted_intent_by_client_operation(
        self,
        *,
        user_id: str,
        system_id: str,
        delivery_mode: str,
        client_operation_id: str,
    ) -> dict[str, Any] | None:
        rows = self.db.execute_raw(
            """
            SELECT * FROM connected_system_intents
            WHERE user_id = :user_id AND system_id = :system_id
              AND delivery_mode = :delivery_mode
              AND client_operation_id = :client_operation_id
            LIMIT 1
            """,
            {
                "user_id": user_id,
                "system_id": system_id,
                "delivery_mode": delivery_mode,
                "client_operation_id": client_operation_id,
            },
        ).data
        return _intent_from_db_row(rows[0]) if rows else None

    def claim_pending_intent(self, *, intent_id: str, approval_id: str) -> dict[str, Any]:
        rows = self.db.execute_raw(
            """
            UPDATE connected_system_intents
            SET status = 'approved', approval_id = :approval_id, updated_at = NOW()
            WHERE intent_id = :intent_id AND status = 'pending'
            RETURNING *
            """,
            {"intent_id": intent_id, "approval_id": approval_id},
        ).data
        if rows:
            return _intent_from_db_row(rows[0])
        current = self.db.execute_raw(
            "SELECT * FROM connected_system_intents WHERE intent_id = :intent_id LIMIT 1",
            {"intent_id": intent_id},
        ).data
        if not current:
            raise ConnectedSystemNotFoundError("CRM intent was not found.")
        return _intent_from_db_row(current[0])

    def update_intent(self, *, intent_id: str, updates: dict[str, Any]) -> dict[str, Any]:
        current = self.db.execute_raw(
            "SELECT * FROM connected_system_intents WHERE intent_id = :intent_id LIMIT 1",
            {"intent_id": intent_id},
        ).data
        if not current:
            raise ConnectedSystemNotFoundError("CRM intent was not found.")
        merged = {**_intent_from_db_row(current[0]), **_deepcopy_json(updates)}
        rows = self.db.execute_raw(
            """
            UPDATE connected_system_intents
            SET status = :status,
                record_id = :record_id,
                approval_id = :approval_id,
                request_payload_json = :request_payload_json,
                readback_payload_json = :readback_payload_json,
                result_class = :result_class,
                result_payload_json = :result_payload_json,
                readback_result_json = :readback_result_json,
                delivery_mode = :delivery_mode,
                encrypted_fields_json = :encrypted_fields_json,
                zk_metadata_json = :zk_metadata_json,
                envelope_digest = :envelope_digest,
                client_operation_id = :client_operation_id,
                approval_challenge_id = :approval_challenge_id,
                error_code = :error_code,
                error_message = :error_message,
                updated_at = NOW()
            WHERE intent_id = :intent_id
            RETURNING *
            """,
            _intent_to_db_params(merged),
        ).data
        return _intent_from_db_row(rows[0]) if rows else merged

    def record_audit_event(self, event: dict[str, Any]) -> None:
        self.db.execute_raw(
            """
            INSERT INTO connected_system_audit_events (
              event_id,
              user_id,
              system_id,
              target,
              object_type,
              action,
              record_id,
              intent_id,
              approval_id,
              field_names_json,
              mcp_result_class,
              readback_result_class,
              status,
              metadata_json
            )
            VALUES (
              :event_id,
              :user_id,
              :system_id,
              :target,
              :object_type,
              :action,
              :record_id,
              :intent_id,
              :approval_id,
              :field_names_json,
              :mcp_result_class,
              :readback_result_class,
              :status,
              :metadata_json
            )
            """,
            {
                "event_id": event["event_id"],
                "user_id": event["user_id"],
                "system_id": event["system_id"],
                "target": event["target"],
                "object_type": event["object_type"],
                "action": event["action"],
                "record_id": event.get("record_id"),
                "intent_id": event.get("intent_id"),
                "approval_id": event.get("approval_id"),
                "field_names_json": {"fields": event.get("field_names") or []},
                "mcp_result_class": event.get("mcp_result_class"),
                "readback_result_class": event.get("readback_result_class"),
                "status": event.get("status"),
                "metadata_json": event.get("metadata") or {},
            },
        )

    def get_binding(
        self, *, user_id: str, system_id: str, object_type: str
    ) -> dict[str, Any] | None:
        rows = self.db.execute_raw(
            """
            SELECT *
            FROM connected_system_record_bindings
            WHERE user_id = :user_id
              AND system_id = :system_id
              AND object_type = :object_type
              AND status = 'active'
            LIMIT 1
            """,
            {"user_id": user_id, "system_id": system_id, "object_type": object_type},
        ).data
        return _binding_from_db_row(rows[0]) if rows else None

    def list_bindings(self, *, user_id: str) -> list[dict[str, Any]]:
        rows = self.db.execute_raw(
            """
            SELECT *
            FROM connected_system_record_bindings
            WHERE user_id = :user_id
              AND status = 'active'
            ORDER BY system_id, object_type
            """,
            {"user_id": user_id},
        ).data
        return [_binding_from_db_row(row) for row in rows]

    def upsert_binding(self, binding: dict[str, Any]) -> dict[str, Any]:
        rows = self.db.execute_raw(
            """
            INSERT INTO connected_system_record_bindings (
              binding_id,
              user_id,
              system_id,
              target,
              object_type,
              record_id,
              status,
              created_intent_id,
              last_intent_id,
              updated_at,
              deleted_at
            )
            VALUES (
              :binding_id,
              :user_id,
              :system_id,
              :target,
              :object_type,
              :record_id,
              'active',
              :created_intent_id,
              :last_intent_id,
              NOW(),
              NULL
            )
            ON CONFLICT (user_id, system_id, object_type)
            WHERE status = 'active'
            DO UPDATE SET
              record_id = EXCLUDED.record_id,
              target = EXCLUDED.target,
              last_intent_id = EXCLUDED.last_intent_id,
              status = 'active',
              updated_at = NOW(),
              deleted_at = NULL
            RETURNING *
            """,
            {
                "binding_id": binding.get("binding_id") or _binding_id(),
                "user_id": binding["user_id"],
                "system_id": binding["system_id"],
                "target": binding["target"],
                "object_type": binding["object_type"],
                "record_id": binding["record_id"],
                "created_intent_id": binding.get("created_intent_id"),
                "last_intent_id": binding.get("last_intent_id"),
            },
        ).data
        return _binding_from_db_row(rows[0]) if rows else binding

    def mark_binding_deleted(
        self,
        *,
        user_id: str,
        system_id: str,
        object_type: str,
        record_id: str,
        last_intent_id: str | None = None,
    ) -> dict[str, Any] | None:
        rows = self.db.execute_raw(
            """
            UPDATE connected_system_record_bindings
            SET status = 'deleted',
                last_intent_id = COALESCE(:last_intent_id, last_intent_id),
                updated_at = NOW(),
                deleted_at = NOW()
            WHERE user_id = :user_id
              AND system_id = :system_id
              AND object_type = :object_type
              AND record_id = :record_id
              AND status = 'active'
            RETURNING *
            """,
            {
                "user_id": user_id,
                "system_id": system_id,
                "object_type": object_type,
                "record_id": record_id,
                "last_intent_id": last_intent_id,
            },
        ).data
        return _binding_from_db_row(rows[0]) if rows else None

    def mark_binding_disconnected(
        self,
        *,
        user_id: str,
        system_id: str,
        object_type: str,
        record_id: str,
    ) -> dict[str, Any] | None:
        rows = self.db.execute_raw(
            """
            UPDATE connected_system_record_bindings
            SET status = 'disconnected',
                updated_at = NOW(),
                deleted_at = NOW()
            WHERE user_id = :user_id
              AND system_id = :system_id
              AND object_type = :object_type
              AND record_id = :record_id
              AND status = 'active'
            RETURNING *
            """,
            {
                "user_id": user_id,
                "system_id": system_id,
                "object_type": object_type,
                "record_id": record_id,
            },
        ).data
        return _binding_from_db_row(rows[0]) if rows else None


def _intent_to_db_params(intent: dict[str, Any]) -> dict[str, Any]:
    return {
        "intent_id": intent["intent_id"],
        "user_id": intent["user_id"],
        "system_id": intent["system_id"],
        "action": intent["action"],
        "status": intent["status"],
        "target": intent["target"],
        "object_type": intent["object_type"],
        "record_id": intent.get("record_id"),
        "approval_id": intent.get("approval_id"),
        "request_payload_json": intent.get("request_payload") or {},
        "readback_payload_json": intent.get("readback_payload") or {},
        "field_names_json": {"fields": intent.get("field_names") or []},
        "result_class": intent.get("result_class"),
        "result_payload_json": intent.get("result_payload") or {},
        "readback_result_json": intent.get("readback_result") or {},
        "delivery_mode": intent.get("delivery_mode") or "legacy",
        "encrypted_fields_json": intent.get("encrypted_fields"),
        "zk_metadata_json": intent.get("zk_metadata"),
        "envelope_digest": intent.get("envelope_digest"),
        "client_operation_id": intent.get("client_operation_id"),
        "approval_challenge_id": intent.get("approval_challenge_id"),
        "error_code": intent.get("error_code"),
        "error_message": intent.get("error_message"),
    }


def _intent_from_db_row(row: dict[str, Any]) -> dict[str, Any]:
    field_names = _ensure_dict(row.get("field_names_json")).get("fields") or []
    intent = {
        "intent_id": row.get("intent_id"),
        "user_id": row.get("user_id"),
        "system_id": row.get("system_id"),
        "action": row.get("action"),
        "status": row.get("status"),
        "target": row.get("target"),
        "object_type": row.get("object_type"),
        "record_id": row.get("record_id"),
        "approval_id": row.get("approval_id"),
        "request_payload": _ensure_dict(row.get("request_payload_json")),
        "readback_payload": _ensure_dict(row.get("readback_payload_json")),
        "field_names": [str(field) for field in _ensure_list(field_names)],
        "result_class": row.get("result_class"),
        "result_payload": _ensure_dict(row.get("result_payload_json")),
        "readback_result": _ensure_dict(row.get("readback_result_json")),
        "delivery_mode": str(row.get("delivery_mode") or "legacy"),
        "encrypted_fields": _ensure_dict(row.get("encrypted_fields_json")),
        "zk_metadata": _ensure_dict(row.get("zk_metadata_json")),
        "envelope_digest": row.get("envelope_digest"),
        "client_operation_id": row.get("client_operation_id"),
        "approval_challenge_id": row.get("approval_challenge_id"),
        "error_code": row.get("error_code"),
        "error_message": row.get("error_message"),
        "created_at": _to_iso(row.get("created_at")),
        "updated_at": _to_iso(row.get("updated_at")),
    }
    return intent


def _to_iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def _binding_from_db_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "binding_id": row.get("binding_id"),
        "user_id": row.get("user_id"),
        "system_id": row.get("system_id"),
        "target": row.get("target"),
        "object_type": row.get("object_type"),
        "record_id": row.get("record_id"),
        "status": row.get("status"),
        "created_intent_id": row.get("created_intent_id"),
        "last_intent_id": row.get("last_intent_id"),
        "created_at": _to_iso(row.get("created_at")),
        "updated_at": _to_iso(row.get("updated_at")),
        "deleted_at": _to_iso(row.get("deleted_at")),
    }


class ConnectedSystemsService:
    def __init__(
        self,
        *,
        adapter: ExternalCrmStreamableMcpAdapter | None = None,
        store: ConnectedSystemIntentStore | None = None,
        delete_enabled: bool | None = None,
        registry: tuple[ConnectedSystemDefinition, ...] | None = None,
        identity_service: Any | None = None,
        schema_cache: Any | None = None,
    ):
        self._registry_explicit = registry is not None
        self.registry = registry or self._load_registry()
        self.adapter = adapter
        self.store = store or DatabaseConnectedSystemIntentStore()
        self.delete_enabled = True if delete_enabled is None else delete_enabled
        self.identity_service = identity_service
        if schema_cache is None:
            from hushh_mcp.services.crm_schema_catalog_cache import (
                InMemoryCrmSchemaCatalogCache,
                get_crm_schema_catalog_cache,
            )

            schema_cache = (
                InMemoryCrmSchemaCatalogCache()
                if self._registry_explicit
                else get_crm_schema_catalog_cache()
            )
        self.schema_cache = schema_cache
        self._schema_refresh_tasks: dict[str, asyncio.Task[dict[str, Any]]] = {}
        self._forced_schema_refresh_at: dict[str, float] = {}

    def _load_registry(self) -> tuple[ConnectedSystemDefinition, ...]:
        from hushh_mcp.services import crm_registry_repo

        try:
            return crm_registry_repo.load_active_definitions()
        except ConnectedSystemsError:
            raise
        except DatabaseExecutionError as error:
            logger.exception("crm_registry.load_failed")
            raise ConnectedSystemConfigurationError(
                "Connected Systems configuration is temporarily unavailable.",
                code="CONNECTED_SYSTEM_REGISTRY_UNAVAILABLE",
            ) from error

    def _adapter_for_system(
        self, system: ConnectedSystemDefinition
    ) -> ExternalCrmStreamableMcpAdapter:
        return self.adapter or ExternalCrmStreamableMcpAdapter.from_registry(system)

    def _finish_background_schema_refresh(
        self, key: str, task: asyncio.Task[dict[str, Any]]
    ) -> None:
        self._schema_refresh_tasks.pop(key, None)
        try:
            task.result()
        except Exception:  # noqa: BLE001 - stale display remains safe on refresh failure
            logger.info("crm_schema.background_refresh_failed cache_key=%s", key)

    def _require_operation(
        self, system: ConnectedSystemDefinition, operation: str
    ) -> dict[str, Any]:
        if operation == "delete" and not self.delete_enabled:
            raise ConnectedSystemBlockedError(
                "Delete is blocked for this connected system.", code="CRM_DELETE_BLOCKED"
            )
        if not system.supports(operation):
            raise ConnectedSystemBlockedError(
                f"The connected system does not support {operation}.",
                code="CONNECTED_SYSTEM_OPERATION_UNAVAILABLE",
            )
        config = system.operation(operation)
        if not config:
            raise ConnectedSystemConfigurationError(
                f"The connected system has no {operation} tool mapping.",
                code="CONNECTED_SYSTEM_OPERATION_UNCONFIGURED",
            )
        return config

    async def _call_operation(
        self,
        *,
        system: ConnectedSystemDefinition,
        operation: str,
        payload: dict[str, Any],
        tool_name: str | None = None,
        replace_tool_arguments: bool = False,
    ) -> dict[str, Any]:
        config = self._require_operation(system, operation)
        adapter = self._adapter_for_system(system)
        effective_payload = _deepcopy_json(payload)
        if system.crm_encrypted_fields_v1_enabled and not replace_tool_arguments:
            # Every MuleSoft connector owns target/connection selection through
            # connectorRef. Never forward a backend target label as tool input,
            # including for the current plaintext create/delete compatibility
            # path.
            effective_payload.pop("target", None)
        # The production adapter is operation-driven. The narrow legacy fallback
        # keeps injected test adapters compatible while all real registry calls
        # use the mapped tool name and endpoint.
        if hasattr(adapter, "call_operation"):
            endpoint = system.operation_endpoint(operation)
            # Explicit registry:// adapters are a deterministic test transport;
            # never use this override for a real HTTP endpoint.
            if str(getattr(adapter, "endpoint", "")).startswith("registry://"):
                endpoint = str(adapter.endpoint)
            result = await adapter.call_operation(
                operation=operation,
                tool_name=tool_name or str(config.get("name") or ""),
                endpoint=endpoint,
                timeout_seconds=system.timeout_seconds,
                retry_count=system.retry_count,
                arguments=effective_payload,
                replace_tool_arguments=replace_tool_arguments,
            )
        else:
            legacy_method = {
                "schema": "object_schema",
                "read": "read_record",
                "create": "create_record",
                "update": "update_record",
                "delete": "delete_record",
            }[operation]
            result = await getattr(adapter, legacy_method)(effective_payload)
        if result.get("isError"):
            raise ConnectedSystemsError(
                _mcp_error_message(result),
                code="CONNECTED_SYSTEM_MCP_TOOL_ERROR",
                status_code=502,
            )
        return result

    def list_systems(self) -> list[dict[str, Any]]:
        # Registry entries are operational configuration. Unlike an explicit
        # injected test registry, reload the active DB-backed set for each
        # list request so enables/disables appear without a backend restart.
        registry = self.registry if self._registry_explicit else self._load_registry()
        return [
            system.to_summary(
                endpoint_configured=all(
                    system.supports(operation) for operation in system.capabilities
                ),
                delete_enabled=self.delete_enabled,
            )
            for system in registry
        ]

    def registry_revision(self) -> int:
        registry = self.registry if self._registry_explicit else self._load_registry()
        # Every active-row update changes this aggregate revision. Deactivation
        # removes the row from the projection, which also changes the value.
        return sum(system.configuration_revision for system in registry)

    def get_system(self, system_id: str) -> ConnectedSystemDefinition:
        return self._resolve_system(system_id)

    def _require_crm_encrypted_fields_system(
        self, *, system_id: str, operation: str
    ) -> ConnectedSystemDefinition:
        system = self.get_system(system_id)
        if not system.crm_encrypted_fields_ready(operation):
            raise ConnectedSystemConfigurationError(
                "This connected system is not configured for encrypted CRM fields.",
                code="CONNECTED_SYSTEM_CRM_ENCRYPTED_FIELDS_UNAVAILABLE",
            )
        return system

    def crm_encrypted_fields_configuration(self, *, system_id: str) -> dict[str, Any]:
        system = self._require_crm_encrypted_fields_system(system_id=system_id, operation="read")
        if not system.crm_encrypted_fields_ready("update"):
            raise ConnectedSystemConfigurationError(
                "Encrypted CRM updates are not configured for this connected system.",
                code="CONNECTED_SYSTEM_CRM_ENCRYPTED_FIELDS_UPDATE_UNAVAILABLE",
            )
        key = system.crm_encrypted_fields_recipient_key or {}
        return {
            "profile": CRM_ENCRYPTED_FIELDS_V1_PROFILE,
            "configurationRevision": system.configuration_revision,
            "recipientKey": {"keyId": key["keyId"], "publicKey": key["publicKey"]},
            "keyDerivation": "SHA-256(X25519 shared secret)",
            "aad": False,
        }

    @staticmethod
    def _allowed_crm_field_names(
        *,
        schema: dict[str, Any],
        requested: list[str],
        operation: str,
        locked_field_names: set[str],
    ) -> list[str]:
        """Resolve field names against the current registry-owned schema."""
        if not isinstance(requested, list) or not requested or len(requested) > 128:
            raise ConnectedSystemValidationError(
                "Select one or more CRM fields.",
                code="CONNECTED_SYSTEM_CRM_FIELD_NAMES_INVALID",
            )
        descriptors = [
            field for field in _ensure_list(schema.get("fields")) if isinstance(field, dict)
        ]
        by_any_name: dict[str, dict[str, Any]] = {}
        for descriptor in descriptors:
            for candidate in (descriptor.get("key"), descriptor.get("name")):
                name = _clean_text(candidate, max_length=80)
                if name:
                    by_any_name[name] = descriptor
        resolved: list[str] = []
        for requested_name in requested:
            descriptor = by_any_name.get(_clean_text(requested_name, max_length=80))
            if not descriptor:
                raise ConnectedSystemValidationError(
                    "A selected CRM field is not available in the active schema.",
                    code="CONNECTED_SYSTEM_SCHEMA_FIELD_UNAVAILABLE",
                )
            name = _clean_text(descriptor.get("name") or descriptor.get("key"), max_length=80)
            if not name or name in resolved:
                raise ConnectedSystemValidationError(
                    "CRM fields must be unique.",
                    code="CONNECTED_SYSTEM_CRM_FIELD_NAMES_INVALID",
                )
            if operation == "update" and (
                descriptor.get("readOnly") is True
                or descriptor.get("identityField") is True
                or name in locked_field_names
            ):
                raise ConnectedSystemValidationError(
                    "A selected CRM field cannot be updated.",
                    code="CONNECTED_SYSTEM_SCHEMA_FIELD_READ_ONLY",
                )
            resolved.append(name)
        return resolved

    def _validated_crm_encrypted_fields_envelope(
        self,
        *,
        system: ConnectedSystemDefinition,
        encrypted_fields: dict[str, Any],
        direction: Literal["read_request", "read_response", "update_request"],
    ) -> CrmEncryptedFields:
        key = system.crm_encrypted_fields_recipient_key or {}
        try:
            return validate_crm_encrypted_fields_envelope(
                encrypted_fields,
                expected_direction=direction,
                expected_key_id=str(key.get("keyId") or ""),
                now_ms=int(time.time() * 1000),
            )
        except Exception as error:
            raise ConnectedSystemValidationError(
                "The encrypted CRM envelope is invalid or expired.",
                code="CONNECTED_SYSTEM_CRM_ENCRYPTED_FIELDS_ENVELOPE_INVALID",
            ) from error

    async def read_bound_record_encrypted_fields(
        self,
        *,
        user_id: str,
        system_id: str,
        object_type: str | None,
        return_fields: list[str],
        encrypted_fields: dict[str, Any],
    ) -> dict[str, Any]:
        """Relay an opaque read for the record already bound to this owner."""
        system = self._require_crm_encrypted_fields_system(system_id=system_id, operation="read")
        object_type_value = system.object_type_for_operation("read")
        record_id = self._require_bound_record_id(
            user_id=user_id,
            system_id=system_id,
            object_type=object_type_value,
            supplied_record_id=None,
        )
        binding = self._store_call(
            self.store.get_binding,
            user_id=user_id,
            system_id=system_id,
            object_type=object_type_value,
        )
        schema = await self.get_schema(
            system_id=system_id, object_type=object_type_value, require_fresh=True
        )
        self._require_schema_action(schema, "read")
        allowed_return = self._allowed_crm_field_names(
            schema=schema, operation="read", requested=return_fields, locked_field_names=set()
        )
        envelope = self._validated_crm_encrypted_fields_envelope(
            system=system, encrypted_fields=encrypted_fields, direction="read_request"
        )
        result = await self._call_crm_encrypted_fields_partner(
            system=system,
            operation="read",
            payload={
                "profile": CRM_ENCRYPTED_FIELDS_V1_PROFILE,
                "operation": "read",
                "objectType": object_type_value,
                "id": record_id,
                "returnFields": allowed_return,
                "encryptedFields": envelope.model_dump(mode="json"),
            },
        )
        payload = _ensure_dict(result.get("payload"))
        try:
            total_size = int(payload.get("totalSize") or 0)
        except (TypeError, ValueError):
            total_size = -1
        if total_size < 0 or total_size > 1:
            raise ConnectedSystemBlockedError(
                "The encrypted CRM lookup did not resolve exactly one safe result.",
                code="CONNECTED_SYSTEM_RECORD_MATCH_AMBIGUOUS",
                status_code=409,
            )
        response_fields = payload.get("encryptedFields")
        if not isinstance(response_fields, dict):
            raise ConnectedSystemConfigurationError(
                "The CRM partner returned no encrypted field response.",
                code="CONNECTED_SYSTEM_CRM_ENCRYPTED_FIELDS_RESPONSE_INVALID",
                status_code=502,
            )
        response_envelope = self._validated_crm_encrypted_fields_envelope(
            system=system, encrypted_fields=response_fields, direction="read_response"
        )
        if (
            response_envelope.client_operation_id != envelope.client_operation_id
            or response_envelope.client_public_key != envelope.client_public_key
        ):
            raise ConnectedSystemConfigurationError(
                "The encrypted CRM response does not match this request.",
                code="CONNECTED_SYSTEM_CRM_ENCRYPTED_FIELDS_RESPONSE_INVALID",
                status_code=502,
            )
        returned_record_id = _clean_text(
            payload.get("recordId") or payload.get("id"), max_length=128
        )
        if returned_record_id and returned_record_id != record_id:
            raise ConnectedSystemConfigurationError(
                "The CRM partner returned a different record than the owner binding.",
                code="CONNECTED_SYSTEM_BOUND_RECORD_MISMATCH",
                status_code=502,
            )
        response_status = str(payload.get("status") or "succeeded").strip().lower()
        if response_status not in {"success", "succeeded"}:
            raise ConnectedSystemConfigurationError(
                "The CRM partner returned an invalid read status.",
                code="CONNECTED_SYSTEM_CRM_ENCRYPTED_FIELDS_RESPONSE_INVALID",
                status_code=502,
            )
        self._audit(
            user_id=user_id,
            system_id=system_id,
            action="read",
            object_type=object_type_value,
            record_id=record_id,
            field_names=allowed_return,
            mcp_result_class="succeeded",
            readback_result_class="encrypted_response_returned",
            status="succeeded",
            metadata={"profile": CRM_ENCRYPTED_FIELDS_V1_PROFILE, "total_size": total_size},
        )
        return {
            "profile": CRM_ENCRYPTED_FIELDS_V1_PROFILE,
            "systemId": system_id,
            "objectType": object_type_value,
            "status": response_status,
            "totalSize": total_size,
            "recordId": record_id,
            "bindingStatus": "active",
            "binding": self._public_binding(binding),
            "encryptedFields": response_envelope.model_dump(mode="json", by_alias=True),
        }

    async def create_encrypted_fields_update_intent(
        self,
        *,
        user_id: str,
        system_id: str,
        object_type: str | None,
        field_names: list[str],
        encrypted_fields: dict[str, Any],
        locked_field_names: set[str],
    ) -> dict[str, Any]:
        system = self._require_crm_encrypted_fields_system(system_id=system_id, operation="update")
        object_type_value = system.object_type_for_operation("update")
        record_id = self._require_bound_record_id(
            user_id=user_id,
            system_id=system_id,
            object_type=object_type_value,
            supplied_record_id=None,
        )
        schema = await self.get_schema(
            system_id=system_id, object_type=object_type_value, require_fresh=True
        )
        self._require_schema_action(schema, "update")
        allowed_fields = self._allowed_crm_field_names(
            schema=schema,
            operation="update",
            requested=field_names,
            locked_field_names=locked_field_names,
        )
        envelope = self._validated_crm_encrypted_fields_envelope(
            system=system, encrypted_fields=encrypted_fields, direction="update_request"
        )
        existing = self._store_call(
            self.store.get_encrypted_intent_by_client_operation,
            user_id=user_id,
            system_id=system_id,
            delivery_mode=CRM_ENCRYPTED_FIELDS_V1_PROFILE,
            client_operation_id=envelope.client_operation_id,
        )
        if existing:
            if existing.get("delivery_mode") != CRM_ENCRYPTED_FIELDS_V1_PROFILE:
                raise ConnectedSystemValidationError(
                    "The encrypted CRM operation id is already in use.",
                    code="CONNECTED_SYSTEM_CRM_ENCRYPTED_FIELDS_REPLAYED",
                )
            return self._public_intent(existing)
        return self._create_intent(
            user_id=user_id,
            system=system,
            action="update",
            object_type=object_type_value,
            request_payload={},
            readback_payload={},
            field_names=allowed_fields,
            record_id=record_id,
            delivery_mode=CRM_ENCRYPTED_FIELDS_V1_PROFILE,
            encrypted_fields=envelope.model_dump(mode="json", by_alias=True),
            zk_metadata={
                "profile": CRM_ENCRYPTED_FIELDS_V1_PROFILE,
                "recipientKeyId": envelope.recipient_key_id,
                "configurationRevision": system.configuration_revision,
                "expiresAtMs": envelope.expires_at_ms,
            },
            envelope_digest=envelope.digest(),
            client_operation_id=envelope.client_operation_id,
        )

    async def approve_encrypted_fields_intent(
        self, *, user_id: str, system_id: str, intent_id: str
    ) -> dict[str, Any]:
        system = self._require_crm_encrypted_fields_system(system_id=system_id, operation="update")
        existing = self._store_call(
            self.store.get_intent, user_id=user_id, system_id=system_id, intent_id=intent_id
        )
        if not existing:
            raise ConnectedSystemNotFoundError("CRM intent was not found.")
        if existing.get("delivery_mode") != CRM_ENCRYPTED_FIELDS_V1_PROFILE:
            raise ConnectedSystemValidationError(
                "This approval route accepts only encrypted CRM intents.",
                code="CONNECTED_SYSTEM_CRM_ENCRYPTED_FIELDS_INTENT_REQUIRED",
            )
        if existing.get("status") in TERMINAL_INTENT_STATUSES:
            return self._public_intent(existing)
        if existing.get("status") == "pending":
            approval = _approval_id()
            intent = self._store_call(
                self.store.claim_pending_intent, intent_id=intent_id, approval_id=approval
            )
        elif existing.get("status") == "approved" and existing.get("approval_id"):
            approval = str(existing["approval_id"])
            intent = existing
        else:
            return self._public_intent(existing)
        if intent.get("approval_id") != approval:
            return self._public_intent(intent)
        partner_attempted = False
        try:
            record_id = self._require_bound_record_id(
                user_id=user_id,
                system_id=system_id,
                object_type=str(intent.get("object_type") or ""),
                supplied_record_id=str(intent.get("record_id") or ""),
            )
            metadata = _ensure_dict(intent.get("zk_metadata"))
            if metadata.get("configurationRevision") != system.configuration_revision:
                raise ConnectedSystemValidationError(
                    "The CRM connector changed. Review and submit a fresh update.",
                    code="CONNECTED_SYSTEM_CRM_ENCRYPTED_FIELDS_CONFIGURATION_STALE",
                )
            envelope = self._validated_crm_encrypted_fields_envelope(
                system=system,
                encrypted_fields=_ensure_dict(intent.get("encrypted_fields")),
                direction="update_request",
            )
            schema = await self.get_schema(
                system_id=system_id,
                object_type=str(intent.get("object_type") or ""),
                require_fresh=True,
            )
            self._require_schema_action(schema, "update")
            partner_attempted = True
            result = await self._call_crm_encrypted_fields_partner(
                system=system,
                operation="update",
                payload={
                    "profile": CRM_ENCRYPTED_FIELDS_V1_PROFILE,
                    "operation": "update",
                    "objectType": intent["object_type"],
                    "id": record_id,
                    "fieldNames": intent.get("field_names") or [],
                    "intentId": intent_id,
                    "approvalId": approval,
                    "clientOperationId": envelope.client_operation_id,
                    "encryptedFields": envelope.model_dump(mode="json"),
                },
            )
            normalized_ack = _normalize_crm_encrypted_fields_ack(result.get("payload"))
            updated = self._store_call(
                self.store.update_intent,
                intent_id=intent_id,
                updates={
                    "status": "succeeded",
                    "approval_id": approval,
                    "result_class": "succeeded",
                    "result_payload": normalized_ack,
                    "readback_result": {"resultClass": "metadata_acknowledged"},
                    "error_code": None,
                    "error_message": None,
                },
            )
            self._audit_for_intent(
                updated,
                mcp_result_class="succeeded",
                readback_result_class="metadata_acknowledged",
                status="succeeded",
                metadata={"profile": CRM_ENCRYPTED_FIELDS_V1_PROFILE},
            )
            return self._public_intent(updated)
        except Exception as error:
            updated = self._store_call(
                self.store.update_intent,
                intent_id=intent_id,
                updates={
                    "status": "approved" if partner_attempted else "failed",
                    "approval_id": approval,
                    "error_code": getattr(
                        error, "code", "CONNECTED_SYSTEM_CRM_ENCRYPTED_FIELDS_APPROVAL_FAILED"
                    ),
                    "error_message": "Encrypted CRM approval could not be completed.",
                },
            )
            self._audit_for_intent(
                updated,
                mcp_result_class="failed",
                readback_result_class=None,
                status="retry_pending" if partner_attempted else "failed",
                metadata={
                    "profile": CRM_ENCRYPTED_FIELDS_V1_PROFILE,
                    "error_code": updated.get("error_code"),
                },
            )
            if isinstance(error, ConnectedSystemsError):
                raise
            raise ConnectedSystemsError(
                "Encrypted CRM approval failed.",
                code="CONNECTED_SYSTEM_CRM_ENCRYPTED_FIELDS_APPROVAL_FAILED",
            ) from error

    async def _call_crm_encrypted_fields_partner(
        self,
        *,
        system: ConnectedSystemDefinition,
        operation: Literal["read", "update"],
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        """Call the registered encrypted-fields tool without connector secrets."""
        tool_name = system.crm_encrypted_fields_tool_name(operation)
        if not tool_name:
            raise ConnectedSystemConfigurationError(
                "Encrypted CRM partner routing is not configured.",
                code="CONNECTED_SYSTEM_CRM_ENCRYPTED_FIELDS_UNAVAILABLE",
            )
        try:
            result = await self._call_operation(
                system=system,
                operation=operation,
                payload=payload,
                tool_name=tool_name,
                replace_tool_arguments=True,
            )
            if bool(result.get("isError")):
                raise ConnectedSystemsError(
                    "Encrypted CRM partner request failed.",
                    code="CONNECTED_SYSTEM_CRM_ENCRYPTED_FIELDS_PARTNER_FAILED",
                    status_code=502,
                )
            return result
        except ConnectedSystemsError as error:
            raise ConnectedSystemsError(
                "Encrypted CRM partner request failed.",
                code="CONNECTED_SYSTEM_CRM_ENCRYPTED_FIELDS_PARTNER_FAILED",
                status_code=502,
            ) from error

    def list_record_binding_statuses(self, *, user_id: str) -> dict[str, Any]:
        """Return safe owner-scoped binding states without CRM ids or values."""
        active = self._store_call(self.store.list_bindings, user_id=user_id)
        indexed = {
            (str(binding.get("system_id")), str(binding.get("object_type"))): binding
            for binding in active
        }
        statuses: list[dict[str, Any]] = []
        for summary in self.list_systems():
            system_id = str(summary.get("systemId") or "")
            object_type = str(summary.get("objectTypeDefault") or "")
            binding = indexed.get((system_id, object_type))
            statuses.append(
                {
                    "systemId": system_id,
                    "objectType": object_type,
                    "status": "active" if binding else "unbound",
                }
            )
        return {"bindings": statuses}

    def _resolve_system(self, system_id: str) -> ConnectedSystemDefinition:
        """Resolve a connected system definition.

        The DB-backed enterprise CRM registry is the only runtime source of
        truth: a missing/inactive row raises ConnectedSystemNotFoundError
        ("no data found") rather than falling back to a hardcoded definition.
        A decryption/configuration error also surfaces so a misconfigured row
        fails loudly.
        """
        if self._registry_explicit:
            return self._registry_system(system_id)

        from hushh_mcp.services import crm_registry_repo

        definition = crm_registry_repo.load_active_definition(system_id)
        if definition is None:
            logger.warning("crm_registry.no_active_row system_id=%s", system_id)
            raise ConnectedSystemNotFoundError(
                "No active CRM registry entry found for this system.",
                code="CONNECTED_SYSTEM_REGISTRY_ROW_NOT_FOUND",
            )
        return definition

    def _registry_system(self, system_id: str) -> ConnectedSystemDefinition:
        for system in self.registry:
            if system.system_id == system_id:
                return system
        raise ConnectedSystemNotFoundError("Connected system was not found.")

    def _store_call(self, operation, *args, **kwargs):
        try:
            return operation(*args, **kwargs)
        except DatabaseExecutionError as error:
            raise _connected_systems_storage_error(error) from error

    @staticmethod
    def _profile_field_mappings(fields: list[dict[str, Any]]) -> dict[str, str]:
        """Derive a mapping for explicit in-code test registries only.

        Enterprise CRM rows must use the manifest-owned schema mapper/cache.
        This narrow fixture helper preserves legacy deterministic test adapters
        without silently making alias decisions for a partner schema.
        """
        aliases = {
            "email": ("email", "emailaddress", "email_address"),
            "phone": ("phone", "telephone", "phone_number", "mobilephone", "mobile_phone"),
            "phoneCountryCode": (
                "phonecountrycode",
                "countrycode",
                "dialcode",
                "phone_country_code",
                "mobilephonecountrycode",
            ),
            "firstName": ("firstname", "first_name", "givenname", "given_name"),
            "lastName": ("lastname", "last_name", "surname", "familyname", "family_name"),
            "fullName": ("name", "fullname", "full_name", "displayname", "display_name"),
            "address": ("mailingstreet", "street", "address", "addressline1", "address_line_1"),
        }

        normalized: list[tuple[dict[str, Any], str]] = []
        for field in fields:
            name = re.sub(
                r"[^a-z0-9]", "", str(field.get("name") or field.get("key") or "").lower()
            )
            label = re.sub(r"[^a-z0-9]", "", str(field.get("label") or "").lower())
            if name:
                normalized.append((field, name))
            elif label:
                normalized.append((field, label))

        mapping: dict[str, str] = {}
        for semantic, candidates in aliases.items():
            exact = next(
                (
                    field
                    for field, token in normalized
                    if token in candidates and field.get("identityField") is not True
                ),
                None,
            )
            # `Name` is a tempting substring of FirstName/LastName. A full
            # name fallback must only bind to an exact full-name descriptor,
            # otherwise it can overwrite a valid split last-name mapping.
            partial = exact or (
                None
                if semantic == "fullName"
                else next(
                    (
                        field
                        for field, token in normalized
                        if any(candidate in token for candidate in candidates)
                        and field.get("identityField") is not True
                    ),
                    None,
                )
            )
            if partial:
                mapping[semantic] = str(partial["name"])
        return mapping

    @staticmethod
    def _derived_required_full_name_field(fields: list[dict[str, Any]]) -> str | None:
        """Return a public derived-name descriptor for the basic CRM create shape.

        Salesforce-style create requests supply first and last name separately.
        Some schemas nevertheless advertise their computed ``Name`` / ``Full
        Name`` field as required. This is a narrow schema validation exception:
        the derived field remains absent from the upstream request payload.
        """
        for field in fields:
            if not isinstance(field, dict):
                continue
            if field.get("required") is not True or field.get("identityField") is True:
                continue
            tokens = {
                re.sub(r"[^a-z0-9]", "", str(field.get(key) or "").lower())
                for key in ("key", "name", "label")
            }
            if not tokens.intersection({"name", "fullname"}):
                continue
            field_name = _clean_text(field.get("name") or field.get("key"), max_length=80)
            if field_name:
                return field_name
        return None

    async def _verified_user_crm_profile(self, *, user_id: str) -> dict[str, str]:
        """Load the actor's server-side verified identity for CRM onboarding.

        Browser-request fields are deliberately not accepted here: the lookup
        and the initial CRM record use only the authenticated actor's verified
        email and verified phone claim.
        """
        provider = self.identity_service
        if provider is None:
            from hushh_mcp.services.actor_identity_service import ActorIdentityService

            provider = ActorIdentityService()
        try:
            identities = await provider.get_many([user_id])
        except Exception as error:  # never surface identity-provider details
            logger.warning("connected_systems.identity_lookup_failed user=%s", user_id)
            raise ConnectedSystemConfigurationError(
                "Verified account information is temporarily unavailable.",
                code="CONNECTED_SYSTEM_VERIFIED_IDENTITY_UNAVAILABLE",
            ) from error
        identity = _ensure_dict((identities or {}).get(user_id))
        email = _clean_text(identity.get("email"), max_length=320).lower()
        phone = _normalize_crm_phone_for_mcp(identity.get("phone_number"))
        if not identity.get("email_verified") or not email:
            raise ConnectedSystemBlockedError(
                "Verify your email before linking this CRM.",
                code="CONNECTED_SYSTEM_EMAIL_VERIFICATION_REQUIRED",
            )

        raw_phone = identity.get("phone_number")
        phone_country_code, phone_national, phone_fallback = _parse_crm_phone_parts(raw_phone)
        phone = phone_fallback

        if not identity.get("phone_verified") or not phone:
            raise ConnectedSystemBlockedError(
                "Verify your phone before linking this CRM.",
                code="CONNECTED_SYSTEM_PHONE_VERIFICATION_REQUIRED",
            )
        display_name = _clean_text(identity.get("display_name"), max_length=160)
        parts = display_name.split()
        return {
            "email": email,
            "phone": phone_national or phone,
            "phoneCountryCode": phone_country_code,
            "phoneFallback": phone,
            "displayName": display_name,
            "firstName": parts[0] if parts else "",
            "lastName": " ".join(parts[1:]) if len(parts) > 1 else (parts[0] if parts else ""),
        }

    def _require_bound_record_id(
        self,
        *,
        user_id: str,
        system_id: str,
        object_type: str,
        supplied_record_id: str | None = None,
    ) -> str:
        binding = self._store_call(
            self.store.get_binding,
            user_id=user_id,
            system_id=system_id,
            object_type=object_type,
        )
        bound_record_id = _clean_text((binding or {}).get("record_id"), max_length=128)
        if not binding or not bound_record_id or binding.get("status") != "active":
            raise ConnectedSystemBlockedError(
                "Link your CRM record before reading or changing it.",
                code="CONNECTED_SYSTEM_RECORD_BINDING_REQUIRED",
            )
        requested = _clean_text(supplied_record_id, max_length=128)
        if requested and requested != bound_record_id:
            raise ConnectedSystemBlockedError(
                "This CRM record is not linked to your account.",
                code="CONNECTED_SYSTEM_RECORD_BINDING_MISMATCH",
            )
        return bound_record_id

    def _require_unbound_for_create(
        self,
        *,
        user_id: str,
        system_id: str,
        object_type: str,
    ) -> None:
        binding = self._store_call(
            self.store.get_binding,
            user_id=user_id,
            system_id=system_id,
            object_type=object_type,
        )
        if binding:
            raise ConnectedSystemBlockedError(
                "Disconnect the existing CRM record before creating another one.",
                code="CONNECTED_SYSTEM_RECORD_ALREADY_BOUND",
                status_code=409,
            )

    async def get_schema(
        self,
        *,
        system_id: str,
        object_type: str | None = None,
        force_refresh: bool = False,
        require_fresh: bool = False,
    ) -> dict[str, Any]:
        system = self.get_system(system_id)
        self._require_operation(system, "schema")
        normalized_object_type = _normalize_object_type(
            object_type, default=system.object_type_default
        )
        registry_id = system.registry_id or system.system_id
        cache_key = f"{registry_id}:{normalized_object_type}:{system.configuration_revision}"
        cached = self.schema_cache.get(
            crm_id=registry_id,
            object_type=normalized_object_type,
            configuration_revision=system.configuration_revision,
        )
        if force_refresh:
            last_forced_at = self._forced_schema_refresh_at.get(cache_key, 0.0)
            if cached and time.monotonic() - last_forced_at < 30.0:
                return {
                    **_deepcopy_json(cached["schema"]),
                    "systemId": system.system_id,
                    "configurationRevision": system.configuration_revision,
                    "schemaFingerprint": cached.get("schemaFingerprint"),
                    "freshness": cached.get("freshness"),
                    "refreshedAt": cached.get("refreshedAt"),
                    "refreshGuidance": "A recent explicit refresh is already available.",
                }
            self._forced_schema_refresh_at[cache_key] = time.monotonic()
            cached = None
        if cached and cached.get("freshness") == "fresh":
            return {
                **_deepcopy_json(cached["schema"]),
                "systemId": system.system_id,
                "configurationRevision": system.configuration_revision,
                "schemaFingerprint": cached.get("schemaFingerprint"),
                "freshness": "fresh",
                "refreshedAt": cached.get("refreshedAt"),
                "refreshGuidance": "Cached schema is current.",
            }
        if cached and not require_fresh:
            if cache_key not in self._schema_refresh_tasks:
                task = asyncio.create_task(
                    self._refresh_schema(system=system, object_type=normalized_object_type)
                )
                self._schema_refresh_tasks[cache_key] = task
                task.add_done_callback(
                    lambda completed, key=cache_key: self._finish_background_schema_refresh(
                        key, completed
                    )
                )
            stale_schema = _deepcopy_json(cached["schema"])
            stale_schema["effectiveActions"] = {
                "schema": True,
                "read": False,
                "create": False,
                "update": False,
                "delete": False,
            }
            return {
                **stale_schema,
                "systemId": system.system_id,
                "configurationRevision": system.configuration_revision,
                "schemaFingerprint": cached.get("schemaFingerprint"),
                "freshness": "stale_display_only",
                "refreshedAt": cached.get("refreshedAt"),
                "refreshGuidance": "Showing the last safe field catalogue while it refreshes.",
                "configurationMessage": "The saved field catalogue is visible while this CRM refreshes. Record actions resume only with a fresh schema.",
            }
        existing = self._schema_refresh_tasks.get(cache_key)
        if existing:
            return await existing
        task = asyncio.create_task(
            self._refresh_schema(system=system, object_type=normalized_object_type)
        )
        self._schema_refresh_tasks[cache_key] = task
        try:
            return await task
        finally:
            self._schema_refresh_tasks.pop(cache_key, None)

    async def _refresh_schema(
        self, *, system: ConnectedSystemDefinition, object_type: str
    ) -> dict[str, Any]:
        response_contract = _operation_response_contract(system, "schema")
        if system.registry_source == "enterprise_crm_registry" and (
            response_contract.get("version") != "crm-primary-object-schema.v1"
            or not _contract_path(response_contract, "fieldsPath")
            or not _contract_path(response_contract, "objectPath")
        ):
            raise ConnectedSystemConfigurationError(
                "This connected system needs an updated field contract before it can be used.",
                code="CONNECTED_SYSTEM_SCHEMA_CONTRACT_UNCONFIGURED",
            )
        payload = {
            "target": system.target,
            "objectType": object_type,
        }
        result = await self._call_operation(system=system, operation="schema", payload=payload)
        schema_fields = _schema_fields_from_schema_result(
            result, response_contract=response_contract
        )
        if not schema_fields:
            raise ConnectedSystemConfigurationError(
                "The connected system did not return a usable primary-object schema.",
                code="CONNECTED_SYSTEM_SCHEMA_UNAVAILABLE",
            )
        object_metadata = _schema_object_metadata(
            result,
            response_contract=response_contract,
            default_object_type=payload["objectType"],
        )
        permissions_complete = all(field.get("permissionsDeclared") for field in schema_fields)
        effective_actions = {
            "schema": True,
            # The registered operation mapping, not invented per-field flags,
            # controls whether the tool may run. Individual explicit `false`
            # flags are still honoured during field validation below.
            "read": bool(system.supports("read")),
            "create": bool(system.supports("create")),
            "update": bool(system.supports("update")),
            "delete": bool(system.supports("delete") and self.delete_enabled),
        }
        schema = {
            "systemId": system.system_id,
            "configurationRevision": system.configuration_revision,
            "target": system.target,
            "objectType": payload["objectType"],
            "objectMetadata": object_metadata,
            "supportedFields": [field["key"] for field in schema_fields],
            "fields": schema_fields,
            "profileFieldMappings": (
                self._profile_field_mappings(schema_fields)
                if system.registry_source != "enterprise_crm_registry"
                else {}
            ),
            "schemaMappingStatus": "pending",
            "schemaStatus": "ready",
            "accessMetadata": "declared" if permissions_complete else "partial",
            "effectiveActions": effective_actions,
            "configurationMessage": (
                None
                if permissions_complete
                else "Some field-level access metadata is not declared. Registered CRM operations remain available and explicit field restrictions are still enforced."
            ),
        }
        cache_metadata = self.schema_cache.put(
            crm_id=system.registry_id or system.system_id,
            object_type=object_type,
            configuration_revision=system.configuration_revision,
            schema=schema,
        )
        return {
            **schema,
            **cache_metadata,
            "refreshGuidance": "Schema refreshed from the registered CRM MCP tool.",
        }

    @staticmethod
    def _require_schema_action(schema: dict[str, Any], action: str) -> None:
        if not _ensure_dict(schema.get("effectiveActions")).get(action):
            raise ConnectedSystemBlockedError(
                "This connected system does not currently authorize that record action.",
                code="CONNECTED_SYSTEM_SCHEMA_CAPABILITY_UNAVAILABLE",
            )

    @staticmethod
    def _validated_schema_fields(
        fields: dict[str, dict[str, Any]],
        values: dict[str, Any] | None,
        *,
        action: str,
        locked_field_names: set[str] | None = None,
        require_required_fields: bool = False,
        satisfied_required_fields: set[str] | None = None,
    ) -> dict[str, Any]:
        if not isinstance(values, dict) or not values:
            raise ConnectedSystemValidationError(f"recordFields is required for {action}.")
        normalized: dict[str, Any] = {}
        locked_tokens = {
            str(name).strip().casefold()
            for name in (locked_field_names or set())
            if str(name).strip()
        }
        for raw_name, value in values.items():
            key = _clean_text(raw_name, max_length=80)
            field = fields.get(key)
            if field is None:
                raise ConnectedSystemValidationError(
                    f"Field is not available in this CRM schema: {key}",
                    code="CONNECTED_SYSTEM_SCHEMA_FIELD_UNAVAILABLE",
                )
            if action == "update" and (
                field.get("immutable") is True
                or field.get("identityField") is True
                or field.get("updateable") is False
                or str(field.get("key") or "").strip().casefold() in locked_tokens
                or str(field.get("name") or "").strip().casefold() in locked_tokens
            ):
                raise ConnectedSystemValidationError(
                    f"Field cannot be updated: {key}",
                    code="CONNECTED_SYSTEM_SCHEMA_FIELD_READ_ONLY",
                )
            if action == "create" and (
                field.get("immutable") is True or field.get("createable") is False
            ):
                raise ConnectedSystemValidationError(
                    f"Field cannot be written: {key}",
                    code="CONNECTED_SYSTEM_SCHEMA_FIELD_READ_ONLY",
                )
            normalized[field["name"]] = value
        if require_required_fields:
            supplied = {str(key).lower() for key in normalized}
            supplied.update(str(key).lower() for key in (satisfied_required_fields or set()))
            missing = [
                field["label"]
                for field in fields.values()
                if (
                    field.get("required")
                    and field.get("identityField") is not True
                    and field.get("defaultedOnCreate") is not True
                    and str(field["name"]).lower() not in supplied
                )
            ]
            if missing:
                raise ConnectedSystemValidationError(
                    f"Required CRM fields are missing: {', '.join(missing)}.",
                    code="CONNECTED_SYSTEM_SCHEMA_REQUIRED_FIELDS",
                )
        return normalized

    async def create_record_intent_from_fields(
        self,
        *,
        user_id: str,
        system_id: str,
        object_type: str | None,
        record_fields: dict[str, Any],
        readback_locator: dict[str, Any] | None = None,
        profile_field_mappings: dict[str, str] | None = None,
        satisfied_required_fields: set[str] | None = None,
    ) -> dict[str, Any]:
        system = self.get_system(system_id)
        self._require_operation(system, "create")
        operation_object_type = system.object_type_for_operation("create")
        schema = await self.get_schema(
            system_id=system_id, object_type=operation_object_type, require_fresh=True
        )
        self._require_schema_action(schema, "create")
        fields = {str(field["key"]): field for field in schema["fields"]}
        normalized = self._validated_schema_fields(
            fields,
            record_fields,
            action="create",
            require_required_fields=True,
            satisfied_required_fields=satisfied_required_fields,
        )
        object_type_value = str(schema["objectType"])
        self._require_unbound_for_create(
            user_id=user_id,
            system_id=system_id,
            object_type=object_type_value,
        )
        payload: dict[str, Any] = {
            "target": system.target,
            "objectType": object_type_value,
            "recordFields": normalized,
        }
        # A registered request style keeps the current Salesforce-family MCP
        # wire shape out of the generic CRM validation path. Future systems
        # remain on the typed `recordFields` default unless their own operation
        # contract declares a different request style.
        if _operation_request_style(system, "create") == "basic_identity_fields.v1":
            mappings = dict(profile_field_mappings or {})
            if not mappings and system.registry_source != "enterprise_crm_registry":
                mappings = self._profile_field_mappings(list(fields.values()))
            if not mappings:
                raise ConnectedSystemConfigurationError(
                    "This CRM needs a verified profile-field mapping before a record can be created.",
                    code="CONNECTED_SYSTEM_PROFILE_FIELD_MAPPING_UNAVAILABLE",
                )
            legacy = {str(key): value for key, value in normalized.items()}
            payload = {
                "target": system.target,
                "objectType": object_type_value,
                "email": legacy.pop(str(mappings.get("email") or ""), ""),
                "phone": _normalize_crm_phone_for_mcp(
                    legacy.pop(str(mappings.get("phone") or ""), "")
                ),
                "lastName": legacy.pop(str(mappings.get("lastName") or ""), ""),
                "firstName": legacy.pop(str(mappings.get("firstName") or ""), "") or None,
                "additionalFields": legacy,
            }
        return self._create_intent(
            user_id=user_id,
            system=system,
            action="create",
            object_type=object_type_value,
            request_payload={
                key: value for key, value in payload.items() if value not in (None, {})
            },
            readback_payload=self._generic_readback_payload(
                system=system,
                object_type=object_type_value,
                fields=fields,
                record_fields=normalized,
                locator=readback_locator,
            ),
            field_names=list(normalized),
            record_id=None,
        )

    async def create_record_intent_for_verified_user(
        self,
        *,
        user_id: str,
        system_id: str,
        object_type: str | None,
        profile_field_mappings: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """Prepare a basic CRM create using server-side verified account data.

        This intentionally has no browser-supplied field values. The initial
        record is limited to the current user's verified email/phone and their
        signed-in display name mapped against the active CRM schema.
        """
        profile = await self._verified_user_crm_profile(user_id=user_id)
        schema = await self.get_schema(
            system_id=system_id, object_type=object_type, require_fresh=True
        )
        system = self.get_system(system_id)
        mappings = dict(profile_field_mappings or {})
        if not mappings and system.registry_source != "enterprise_crm_registry":
            mappings = _ensure_dict(schema.get("profileFieldMappings"))
        fields: dict[str, Any] = {}
        for semantic, profile_key in (
            ("email", "email"),
            ("phoneCountryCode", "phoneCountryCode"),
            ("phone", "phone"),
            ("firstName", "firstName"),
            ("lastName", "lastName"),
        ):
            field_name = _clean_text(mappings.get(semantic), max_length=80)
            value = _clean_text(profile.get(profile_key), max_length=320)
            if field_name and value:
                fields[field_name] = value

        # If the schema didn't map a distinct phoneCountryCode but did map phone,
        # fallback to the fully-constructed E.164-equivalent normalized value
        # to ensure the single mapped field receives all necessary dial digits.
        phone_field = _clean_text(mappings.get("phone"), max_length=80)
        phone_cc_field = _clean_text(mappings.get("phoneCountryCode"), max_length=80)
        if phone_field and not phone_cc_field:
            fields[phone_field] = _clean_text(profile.get("phoneFallback"), max_length=320)
        # Salesforce-style `Name` fields are frequently derived and cannot be
        # written alongside FirstName/LastName. Use a full-name field only for
        # schemas that do not expose the split name pair.
        first_name_field = _clean_text(mappings.get("firstName"), max_length=80)
        last_name_field = _clean_text(mappings.get("lastName"), max_length=80)
        split_name_is_complete = bool(
            first_name_field
            and last_name_field
            and first_name_field != last_name_field
            and first_name_field in fields
            and last_name_field in fields
        )
        satisfied_required_fields: set[str] = set()
        if split_name_is_complete:
            # Some CRM schemas expose a derived full-name field as required
            # even though create accepts its mapped first/last components.
            # Do not send the derived field back as a second, potentially
            # read-only value. Enterprise mappers may intentionally return
            # only the split-name pair, so resolve the exact public descriptor
            # from the schema only for the registered basic identity shape.
            full_name_field = _clean_text(mappings.get("fullName"), max_length=80)
            if (
                not full_name_field
                and _operation_request_style(system, "create") == "basic_identity_fields.v1"
            ):
                full_name_field = self._derived_required_full_name_field(
                    list(schema.get("fields") or [])
                )
            if full_name_field:
                satisfied_required_fields.add(full_name_field)
        else:
            full_name_field = _clean_text(mappings.get("fullName"), max_length=80)
            full_name = _clean_text(profile.get("displayName"), max_length=160)
            if full_name_field and full_name:
                fields[full_name_field] = full_name
        if "email" not in mappings or "phone" not in mappings:
            raise ConnectedSystemConfigurationError(
                "This CRM schema does not expose fields for verified email and phone.",
                code="CONNECTED_SYSTEM_PROFILE_FIELD_MAPPING_UNAVAILABLE",
            )
        return await self.create_record_intent_from_fields(
            user_id=user_id,
            system_id=system_id,
            object_type=object_type,
            record_fields=fields,
            profile_field_mappings=mappings,
            satisfied_required_fields=satisfied_required_fields,
        )

    async def update_record_intent_from_fields(
        self,
        *,
        user_id: str,
        system_id: str,
        object_type: str | None,
        record_id: str | None,
        record_fields: dict[str, Any],
        readback_locator: dict[str, Any] | None = None,
        locked_field_names: set[str] | None = None,
    ) -> dict[str, Any]:
        system = self.get_system(system_id)
        if system.crm_encrypted_fields_v1_enabled:
            raise ConnectedSystemBlockedError(
                "This CRM requires its configured encrypted update protocol.",
                code="CONNECTED_SYSTEM_ENCRYPTED_FIELDS_UPDATE_REQUIRED",
            )
        self._require_operation(system, "update")
        object_type_value = system.object_type_for_operation("update")
        record_id_value = self._require_bound_record_id(
            user_id=user_id,
            system_id=system_id,
            object_type=object_type_value,
            supplied_record_id=record_id,
        )
        schema = await self.get_schema(
            system_id=system_id, object_type=object_type_value, require_fresh=True
        )
        self._require_schema_action(schema, "update")
        fields = {str(field["key"]): field for field in schema["fields"]}
        # Verified profile mappings are the field names used to create and
        # re-find this owner's record. They are binding keys, not profile
        # preferences, so updates must reject them even when a partner schema
        # has omitted its own identity/immutable metadata.
        protected_fields = set(locked_field_names or set())
        if not protected_fields:
            protected_fields.update(
                str(name)
                for name in _ensure_dict(schema.get("profileFieldMappings")).values()
                if str(name).strip()
            )
        normalized = self._validated_schema_fields(
            fields,
            record_fields,
            action="update",
            locked_field_names=protected_fields,
        )
        object_type_value = str(schema["objectType"])
        payload: dict[str, Any] = {
            "target": system.target,
            "objectType": object_type_value,
            "id": record_id_value,
            "recordFields": normalized,
        }
        if _operation_request_style(system, "update") == "id_additional_fields.v1":
            payload["additionalFields"] = normalized
            payload.pop("recordFields")
        return self._create_intent(
            user_id=user_id,
            system=system,
            action="update",
            object_type=object_type_value,
            request_payload=payload,
            readback_payload=self._generic_readback_payload(
                system=system,
                object_type=object_type_value,
                fields=fields,
                record_fields=normalized,
                locator=readback_locator,
            ),
            field_names=list(normalized),
            record_id=record_id_value,
        )

    def _generic_readback_payload(
        self,
        *,
        system: ConnectedSystemDefinition,
        object_type: str,
        fields: dict[str, dict[str, Any]],
        record_fields: dict[str, Any],
        locator: dict[str, Any] | None,
    ) -> dict[str, Any]:
        if locator and isinstance(locator.get("searchFields"), dict):
            search_fields = locator["searchFields"]
        else:
            search_fields = {
                str(field["name"]): record_fields.get(str(field["name"]))
                for field in fields.values()
                if field.get("identityField") and str(field["name"]) in record_fields
            }
        search_fields = {
            key: value for key, value in search_fields.items() if value not in (None, "")
        }
        if not search_fields:
            return {}
        # A registered request style, rather than a CRM name, preserves the
        # email/phone lookup wire shape where a connector requires it. New
        # CRM rows otherwise receive the generic typed search shape.
        if (
            _operation_request_style(system, "read") == "id_or_verified_identity.v1"
            and locator
            and locator.get("email")
            and locator.get("phone")
        ):
            return self._build_read_payload(
                system_id=system.system_id,
                object_type=object_type,
                email=str(locator["email"]),
                phone=str(locator["phone"]),
                search_fields=None,
                return_fields=list(record_fields),
            )
        return {
            "target": system.target,
            "objectType": object_type,
            "searchFields": search_fields,
            "returnFields": list(record_fields),
        }

    async def read_record(
        self,
        *,
        user_id: str | None = None,
        system_id: str,
        object_type: str | None,
        email: str | None,
        phone: str | None,
        search_fields: dict[str, Any] | None = None,
        return_fields: list[str] | None = None,
        record_id: str | None = None,
    ) -> dict[str, Any]:
        payload = await self._build_schema_read_payload(
            system_id=system_id,
            object_type=object_type,
            email=email,
            phone=phone,
            search_fields=search_fields,
            return_fields=return_fields,
            record_id=record_id,
        )
        system = self.get_system(system_id)
        read_contract = _operation_response_contract(system, "read")
        if system.registry_source == "enterprise_crm_registry" and (
            read_contract.get("version") != "crm-record-collection.v1"
            or not _contract_path(read_contract, "recordsPath")
        ):
            raise ConnectedSystemConfigurationError(
                "This connected system needs an updated record contract before it can be used.",
                code="CONNECTED_SYSTEM_READ_CONTRACT_UNCONFIGURED",
            )
        result = await self._call_operation(system=system, operation="read", payload=payload)
        records = _sanitize_read_records(
            result,
            response_contract=read_contract,
            allowed_fields=list(payload.get("returnFields") or []),
        )
        self._audit(
            user_id=user_id or "",
            system_id=system_id,
            action="read",
            object_type=payload["objectType"],
            record_id=None,
            field_names=list(payload.get("searchFields", {}).keys())
            + payload.get("returnFields", []),
            mcp_result_class="succeeded" if not result.get("isError") else "failed",
            readback_result_class=None,
            status="succeeded" if not result.get("isError") else "failed",
            metadata={"audit_user_optional": True},
        )
        return {
            "systemId": system_id,
            "target": payload["target"],
            "objectType": payload["objectType"],
            "resultClass": "succeeded" if not result.get("isError") else "failed",
            "recordId": next(
                (record["recordId"] for record in records if record.get("recordId")),
                _record_id_from_result(result, response_contract=read_contract),
            ),
            "records": records,
        }

    async def _build_schema_read_payload(
        self,
        *,
        system_id: str,
        object_type: str | None,
        email: str | None,
        phone: str | None,
        search_fields: dict[str, Any] | None,
        return_fields: list[str] | None,
        record_id: str | None = None,
    ) -> dict[str, Any]:
        system = self.get_system(system_id)
        schema = await self.get_schema(
            system_id=system_id, object_type=object_type, require_fresh=True
        )
        self._require_schema_action(schema, "read")
        fields = {
            str(field["key"]): field
            for field in schema["fields"]
            if field.get("readable") is not False
        }
        by_name = {str(field["name"]): field for field in fields.values()}
        normalized_return: list[str] = []
        for raw_name in return_fields or []:
            field = fields.get(str(raw_name)) or by_name.get(str(raw_name))
            if not field:
                if system.registry_source != "enterprise_crm_registry":
                    # Compatibility-only in-code fixtures predate typed
                    # schema projection. Runtime registry connectors never
                    # take this branch.
                    normalized_return.append(str(raw_name))
                    continue
                raise ConnectedSystemValidationError(
                    f"Return field is not available in this CRM schema: {raw_name}",
                    code="CONNECTED_SYSTEM_SCHEMA_FIELD_UNAVAILABLE",
                )
            normalized_return.append(str(field["name"]))
        record_id_value = _clean_text(record_id, max_length=128)
        if record_id_value:
            return {
                "target": system.target,
                "objectType": str(schema["objectType"]),
                "id": record_id_value,
                "returnFields": list(dict.fromkeys(normalized_return)),
            }
        # Identity lookup is used only by the server-side verified-account
        # onboarding flow. It is deliberately not a public arbitrary-field
        # search path.
        if email is not None or phone is not None:
            email_value = _clean_text(email, max_length=320).lower()
            phone_value = _normalize_crm_phone_for_mcp(phone)
            if not email_value or not phone_value:
                raise ConnectedSystemValidationError(
                    "Verified email and phone are required for CRM lookup.",
                    code="CONNECTED_SYSTEM_VERIFIED_LOOKUP_REQUIRED",
                )
            return {
                "target": system.target,
                "objectType": str(schema["objectType"]),
                "email": email_value,
                "phone": phone_value,
                "returnFields": list(dict.fromkeys(normalized_return)),
            }
        if not isinstance(search_fields, dict) or not search_fields:
            raise ConnectedSystemValidationError("searchFields is required for this CRM.")
        normalized_search: dict[str, Any] = {}
        for raw_name, value in search_fields.items():
            field = fields.get(str(raw_name)) or by_name.get(str(raw_name))
            if not field:
                raise ConnectedSystemValidationError(
                    f"Search field is not available in this CRM schema: {raw_name}",
                    code="CONNECTED_SYSTEM_SCHEMA_FIELD_UNAVAILABLE",
                )
            normalized_search[str(field["name"])] = value
        return {
            "target": system.target,
            "objectType": str(schema["objectType"]),
            "searchFields": normalized_search,
            "returnFields": list(dict.fromkeys(normalized_return)),
        }

    async def read_bound_record(
        self,
        *,
        user_id: str,
        system_id: str,
        object_type: str | None,
        return_fields: list[str] | None = None,
    ) -> dict[str, Any]:
        system = self.get_system(system_id)
        if system.crm_encrypted_fields_v1_enabled:
            raise ConnectedSystemBlockedError(
                "This CRM requires its configured encrypted read protocol.",
                code="CONNECTED_SYSTEM_ENCRYPTED_FIELDS_READ_REQUIRED",
            )
        object_type_value = system.object_type_for_operation("read")
        record_id = self._require_bound_record_id(
            user_id=user_id,
            system_id=system_id,
            object_type=object_type_value,
        )
        result = await self.read_record(
            user_id=user_id,
            system_id=system_id,
            object_type=object_type_value,
            email=None,
            phone=None,
            return_fields=return_fields,
            record_id=record_id,
        )
        records = _ensure_list(result.get("records"))
        if result.get("resultClass") == "succeeded" and records:
            returned_ids = {
                _clean_text(record.get("recordId"), max_length=128)
                for record in records
                if isinstance(record, dict)
            }
            if returned_ids != {record_id}:
                raise ConnectedSystemConfigurationError(
                    "The connected system returned a different record than the active binding.",
                    code="CONNECTED_SYSTEM_BOUND_RECORD_MISMATCH",
                    status_code=502,
                )
        if result.get("resultClass") != "succeeded" or records:
            return result

        # A successful, contract-normalized read by the exact bound id that
        # returns no rows is authoritative evidence that the remote record is
        # missing. Keep the active pointer until the owner explicitly confirms
        # recovery; transient MCP, auth, timeout, and malformed responses never
        # reach this state.
        binding = self._store_call(
            self.store.get_binding,
            user_id=user_id,
            system_id=system_id,
            object_type=object_type_value,
        )
        return {
            **result,
            "recordId": None,
            "bindingStatus": "remote_record_missing",
            "binding": self._public_binding(binding),
            "recoveryAction": "create_or_relink",
        }

    def disconnect_record_binding(
        self,
        *,
        user_id: str,
        system_id: str,
        object_type: str | None,
    ) -> dict[str, Any]:
        """Idempotently retire the owner's current local CRM pointer."""
        system = self.get_system(system_id)
        object_type_value = _normalize_object_type(object_type, default=system.object_type_default)
        binding = self._store_call(
            self.store.get_binding,
            user_id=user_id,
            system_id=system_id,
            object_type=object_type_value,
        )
        if not binding:
            return {
                "systemId": system_id,
                "target": system.target,
                "objectType": object_type_value,
                "status": "unbound",
                "binding": None,
            }
        record_id = _clean_text(binding.get("record_id"), max_length=128)
        disconnected = self._store_call(
            self.store.mark_binding_disconnected,
            user_id=user_id,
            system_id=system_id,
            object_type=object_type_value,
            record_id=record_id,
        )
        if disconnected:
            self._audit(
                user_id=user_id,
                system_id=system_id,
                action="disconnect",
                object_type=object_type_value,
                record_id=record_id,
                field_names=[],
                mcp_result_class=None,
                readback_result_class=None,
                status="succeeded",
                metadata={"reason": "owner_confirmed_recovery"},
            )
        return {
            "systemId": system_id,
            "target": system.target,
            "objectType": object_type_value,
            "status": "disconnected" if disconnected else "unbound",
            "binding": self._public_binding(disconnected),
        }

    async def search_verified_record(
        self,
        *,
        user_id: str,
        system_id: str,
        object_type: str | None,
        return_fields: list[str] | None = None,
        force_refresh: bool = False,
    ) -> dict[str, Any]:
        """Find a record using only the authenticated owner's verified identity."""
        system = self.get_system(system_id)
        object_type = system.object_type_for_operation("read")
        profile = await self._verified_user_crm_profile(user_id=user_id)
        return await self.search_record(
            user_id=user_id,
            system_id=system_id,
            object_type=object_type,
            email=profile["email"],
            phone=profile["phone"],
            search_fields=None,
            return_fields=return_fields,
            force_refresh=force_refresh,
        )

    def get_record_binding(
        self,
        *,
        user_id: str,
        system_id: str,
        object_type: str | None,
    ) -> dict[str, Any]:
        system = self.get_system(system_id)
        object_type_value = _normalize_object_type(object_type, default=system.object_type_default)
        binding = self._store_call(
            self.store.get_binding,
            user_id=user_id,
            system_id=system_id,
            object_type=object_type_value,
        )
        return {
            "systemId": system_id,
            "target": system.target,
            "objectType": object_type_value,
            "status": "active" if binding else "unbound",
            "binding": self._public_binding(binding) if binding else None,
        }

    async def search_record(
        self,
        *,
        user_id: str,
        system_id: str,
        object_type: str | None,
        email: str | None,
        phone: str | None,
        search_fields: dict[str, Any] | None = None,
        return_fields: list[str] | None = None,
        force_refresh: bool = False,
    ) -> dict[str, Any]:
        # Bound-read optimization: read is a SOQL search on the CRM, which is
        # the most expensive operation. When an active binding already holds the
        # record id for this (user, system, object_type), serve it directly and
        # skip the redundant CRM search. Pass force_refresh=True to bypass the
        # cache and re-search (e.g. to reconcile a possibly-stale binding).
        system = self.get_system(system_id)
        object_type_value = _normalize_object_type(object_type, default=system.object_type_default)
        if not force_refresh:
            existing = self._store_call(
                self.store.get_binding,
                user_id=user_id,
                system_id=system_id,
                object_type=object_type_value,
            )
            existing_record_id = (
                _clean_text(existing.get("record_id"), max_length=128) if existing else None
            )
            if existing and existing_record_id:
                system = self.get_system(system_id)
                self._audit(
                    user_id=user_id,
                    system_id=system_id,
                    action="read",
                    object_type=object_type_value,
                    record_id=existing_record_id,
                    field_names=[],
                    mcp_result_class="served_from_binding",
                    readback_result_class=None,
                    status="succeeded",
                    metadata={"served_from_binding": True},
                )
                return {
                    "systemId": system_id,
                    "target": system.target,
                    "objectType": object_type_value,
                    "resultClass": "succeeded",
                    "recordId": existing_record_id,
                    "servedFromBinding": True,
                    "mcp": None,
                    "bindingStatus": "active",
                    "binding": self._public_binding(existing),
                }

        read = await self.read_record(
            user_id=user_id,
            system_id=system_id,
            object_type=object_type,
            email=email,
            phone=phone,
            search_fields=search_fields,
            return_fields=return_fields,
        )
        matched_records = _ensure_list(read.get("records"))
        if len(matched_records) > 1:
            raise ConnectedSystemBlockedError(
                "More than one CRM profile matched your verified account information.",
                code="CONNECTED_SYSTEM_RECORD_MATCH_AMBIGUOUS",
                status_code=409,
            )
        record_id = _clean_text(
            (matched_records[0] if matched_records else {}).get("recordId")
            if matched_records
            else read.get("recordId"),
            max_length=128,
        )
        binding: dict[str, Any] | None = None
        if read.get("resultClass") == "succeeded" and record_id:
            system = self.get_system(system_id)
            binding = self._store_call(
                self.store.upsert_binding,
                {
                    "binding_id": _binding_id(),
                    "user_id": user_id,
                    "system_id": system_id,
                    "target": system.target,
                    "object_type": object_type_value,
                    "record_id": record_id,
                    "created_intent_id": None,
                    "last_intent_id": None,
                },
            )
        if system.crm_encrypted_fields_v1_enabled:
            # Verified-identity discovery remains a deliberately narrow
            # server-side exception. An encrypted-fields connector never
            # receives plaintext
            # CRM fields on this route; the browser must issue a fresh bound
            # encrypted-fields read after it receives binding metadata.
            return {
                "systemId": system_id,
                "target": system.target,
                "objectType": object_type_value,
                "resultClass": read.get("resultClass"),
                "recordId": record_id or None,
                "servedFromBinding": False,
                "bindingStatus": "active" if binding else "unbound",
                "binding": self._public_binding(binding) if binding else None,
            }
        return {
            **read,
            "servedFromBinding": False,
            "bindingStatus": "active" if binding else "unbound",
            "binding": self._public_binding(binding) if binding else None,
        }

    def create_record_intent(
        self,
        *,
        user_id: str,
        system_id: str,
        object_type: str | None,
        email: str,
        phone: str,
        last_name: str,
        first_name: str | None = None,
        additional_fields: dict[str, Any] | None = None,
        record_fields: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        system = self.get_system(system_id)
        if system.registry_source == "enterprise_crm_registry":
            raise ConnectedSystemBlockedError(
                "Use the schema-driven recordFields contract for this connected system.",
                code="CONNECTED_SYSTEM_SCHEMA_FIELDS_REQUIRED",
            )
        object_type_value = _normalize_object_type(object_type, default=system.object_type_default)
        self._require_unbound_for_create(
            user_id=user_id,
            system_id=system_id,
            object_type=object_type_value,
        )
        email_value = _clean_text(email, max_length=320)
        phone_value = _normalize_crm_phone_for_mcp(phone)
        last_name_value = _clean_text(last_name, max_length=80)
        first_name_value = _clean_text(first_name, max_length=80)
        if not email_value:
            raise ConnectedSystemValidationError("email is required.")
        if not phone_value:
            raise ConnectedSystemValidationError("phone is required.")
        if not last_name_value:
            raise ConnectedSystemValidationError("lastName is required by the live MCP schema.")
        # `recordFields` is the schema-driven contract. `additionalFields` is
        # retained as the Macy's compatibility alias while current registry rows
        # are migrated to generic field mappings.
        normalized_additional = _normalize_additional_fields(record_fields or additional_fields)
        payload: dict[str, Any] = {
            "target": system.target,
            "objectType": object_type_value,
            "email": email_value,
            "phone": phone_value,
            "lastName": last_name_value,
        }
        if first_name_value:
            payload["firstName"] = first_name_value
        if normalized_additional:
            payload["additionalFields"] = normalized_additional
        readback_payload = self._build_read_payload(
            system_id=system_id,
            object_type=object_type_value,
            email=email_value,
            phone=phone_value,
            search_fields=None,
            return_fields=list(normalized_additional.keys()),
        )
        field_names = ["Email", "Phone", "LastName"]
        if first_name_value:
            field_names.append("FirstName")
        field_names.extend(normalized_additional.keys())
        return self._create_intent(
            user_id=user_id,
            system=system,
            action="create",
            object_type=object_type_value,
            request_payload=payload,
            readback_payload=readback_payload,
            field_names=field_names,
            record_id=None,
        )

    def update_record_intent(
        self,
        *,
        user_id: str,
        system_id: str,
        object_type: str | None,
        record_id: str,
        additional_fields: dict[str, Any],
        record_fields: dict[str, Any] | None = None,
        readback_locator: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        system = self.get_system(system_id)
        if system.registry_source == "enterprise_crm_registry":
            raise ConnectedSystemBlockedError(
                "Use the schema-driven recordFields contract for this connected system.",
                code="CONNECTED_SYSTEM_SCHEMA_FIELDS_REQUIRED",
            )
        object_type_value = _normalize_object_type(object_type, default=system.object_type_default)
        record_id_value = _clean_text(record_id, max_length=128)
        if not record_id_value:
            raise ConnectedSystemValidationError("id is required for update.")
        normalized_additional = _normalize_additional_fields(record_fields or additional_fields)
        if not normalized_additional:
            raise ConnectedSystemValidationError("additionalFields is required for update.")
        payload = {
            "target": system.target,
            "objectType": object_type_value,
            "id": record_id_value,
            "additionalFields": normalized_additional,
        }
        readback_payload: dict[str, Any] = {}
        if readback_locator:
            readback_payload = self._build_read_payload(
                system_id=system_id,
                object_type=object_type_value,
                email=str(readback_locator.get("email") or ""),
                phone=str(readback_locator.get("phone") or ""),
                search_fields=readback_locator.get("searchFields")
                or readback_locator.get("search_fields"),
                return_fields=list(normalized_additional.keys()),
            )
        return self._create_intent(
            user_id=user_id,
            system=system,
            action="update",
            object_type=object_type_value,
            request_payload=payload,
            readback_payload=readback_payload,
            field_names=list(normalized_additional.keys()),
            record_id=record_id_value,
        )

    def create_delete_intent(
        self,
        *,
        user_id: str,
        system_id: str,
        object_type: str | None,
        record_id: str | None = None,
    ) -> dict[str, Any]:
        """Create a reviewable delete intent; never call the CRM here."""
        system = self.get_system(system_id)
        self._require_operation(system, "delete")
        object_type_value = _normalize_object_type(object_type, default=system.object_type_default)
        record_id_value = self._require_bound_record_id(
            user_id=user_id,
            system_id=system_id,
            object_type=object_type_value,
            supplied_record_id=record_id,
        )
        return self._create_intent(
            user_id=user_id,
            system=system,
            action="delete",
            object_type=object_type_value,
            request_payload={
                "target": system.target,
                "objectType": object_type_value,
                "id": record_id_value,
            },
            # An empty successful MCP result is insufficient proof for delete.
            # The registered read tool must confirm the owner-bound ID is gone
            # before the binding transitions to deleted.
            readback_payload={
                "target": system.target,
                "objectType": object_type_value,
                "id": record_id_value,
                "returnFields": [],
            },
            field_names=[],
            record_id=record_id_value,
        )

    async def approve_intent(
        self, *, user_id: str, system_id: str, intent_id: str
    ) -> dict[str, Any]:
        system = self.get_system(system_id)
        existing = self._store_call(
            self.store.get_intent,
            user_id=user_id,
            system_id=system_id,
            intent_id=intent_id,
        )
        if not existing:
            raise ConnectedSystemNotFoundError("CRM intent was not found.")
        if str(existing.get("delivery_mode") or "legacy") != "legacy":
            raise ConnectedSystemValidationError(
                "This approval route accepts only standard CRM intents.",
                code="CONNECTED_SYSTEM_LEGACY_INTENT_REQUIRED",
            )
        if existing.get("status") in TERMINAL_INTENT_STATUSES:
            # Retry-safe: callers receive the stored terminal result and never
            # cause a second MCP mutation.
            return self._public_intent(existing)
        if existing.get("status") != "pending":
            return self._public_intent(existing)
        approval = _approval_id()
        intent = self._store_call(
            self.store.claim_pending_intent,
            intent_id=intent_id,
            approval_id=approval,
        )
        if intent.get("approval_id") != approval:
            return self._public_intent(intent)
        try:
            if intent["action"] in {"update", "delete"}:
                # Re-check at execution time: a stale UI request cannot mutate
                # a record after its binding was removed or replaced.
                self._require_bound_record_id(
                    user_id=user_id,
                    system_id=system_id,
                    object_type=str(intent["object_type"]),
                    supplied_record_id=str(intent.get("record_id") or ""),
                )
            elif intent["action"] == "create":
                # Re-check at execution time so another session cannot relink
                # the user after intent preparation and then approve a duplicate.
                self._require_unbound_for_create(
                    user_id=user_id,
                    system_id=system_id,
                    object_type=str(intent["object_type"]),
                )
            if system.registry_source == "enterprise_crm_registry":
                schema = await self.get_schema(
                    system_id=system_id,
                    object_type=intent.get("object_type"),
                    require_fresh=True,
                )
                self._require_schema_action(schema, str(intent.get("action") or ""))
            response_contract = _operation_response_contract(
                system, str(intent.get("action") or "")
            )
            if intent["action"] == "create":
                result = await self._call_operation(
                    system=system, operation="create", payload=intent["request_payload"]
                )
            elif intent["action"] == "update":
                result = await self._call_operation(
                    system=system, operation="update", payload=intent["request_payload"]
                )
            elif intent["action"] == "delete":
                result = await self._call_operation(
                    system=system, operation="delete", payload=intent["request_payload"]
                )
            else:
                raise ConnectedSystemValidationError("Unsupported approval action.")
            mutation_succeeded = _mutation_succeeded(result, response_contract=response_contract)
            record_id = intent.get("record_id") or _record_id_from_result(
                result, response_contract=response_contract
            )
            readback = await self._readback(intent, system=system, record_id=record_id)
            if not record_id:
                record_id = _clean_text(readback.get("recordId"), max_length=128)
            readback_class = self._classify_readback(intent, readback)
            result_class = "failed" if not mutation_succeeded else readback_class
            status = "succeeded" if result_class == "succeeded" else result_class
            if not mutation_succeeded:
                status = "failed"
            mcp_error_message = (
                "The connected system did not confirm this mutation."
                if status == "failed"
                else None
            )
            terminal_updates = _scrub_terminal_intent_updates(
                intent,
                {
                    "status": status,
                    "record_id": record_id,
                    "approval_id": approval,
                    "result_class": result_class,
                    "result_payload": result,
                    "readback_result": readback,
                    "error_code": None
                    if status != "failed"
                    else "CONNECTED_SYSTEM_MUTATION_UNCONFIRMED",
                    "error_message": mcp_error_message,
                },
            )
            updated = self._store_call(
                self.store.update_intent,
                intent_id=intent_id,
                updates=terminal_updates,
            )
            binding = None
            if status != "failed" and record_id and intent["action"] == "delete":
                binding = self._store_call(
                    self.store.mark_binding_deleted,
                    user_id=user_id,
                    system_id=system_id,
                    object_type=intent["object_type"],
                    record_id=record_id,
                    last_intent_id=intent_id,
                )
            elif status != "failed" and record_id:
                binding = self._upsert_binding_for_intent(updated, record_id=record_id)
            self._audit_for_intent(
                updated,
                mcp_result_class="succeeded" if mutation_succeeded else "failed",
                readback_result_class=readback_class,
                status=status,
            )
            public_intent = self._public_intent(updated)
            if binding:
                public_intent["binding"] = self._public_binding(binding)
            return public_intent
        except Exception as error:
            safe_message = _safe_error_message(error)
            failure_updates = _scrub_terminal_intent_updates(
                intent,
                {
                    "status": "failed",
                    "approval_id": approval,
                    "error_code": getattr(error, "code", "CONNECTED_SYSTEM_APPROVAL_FAILED"),
                    "error_message": safe_message,
                },
            )
            updated = self._store_call(
                self.store.update_intent,
                intent_id=intent_id,
                updates=failure_updates,
            )
            self._audit_for_intent(
                updated,
                mcp_result_class="failed",
                readback_result_class=None,
                status="failed",
                metadata={"error_code": updated.get("error_code")},
            )
            if isinstance(error, ConnectedSystemsError):
                raise
            raise ConnectedSystemsError(
                "CRM intent approval failed.",
                code="CONNECTED_SYSTEM_APPROVAL_FAILED",
            ) from error

    def reject_intent(self, *, user_id: str, system_id: str, intent_id: str) -> dict[str, Any]:
        self.get_system(system_id)
        intent = self._get_pending_intent(user_id=user_id, system_id=system_id, intent_id=intent_id)
        reject_updates = _scrub_terminal_intent_updates(
            intent,
            {"status": "rejected", "approval_id": _approval_id()},
        )
        updated = self._store_call(
            self.store.update_intent,
            intent_id=intent["intent_id"],
            updates=reject_updates,
        )
        self._audit_for_intent(
            updated,
            mcp_result_class="not_called",
            readback_result_class=None,
            status="rejected",
        )
        return self._public_intent(updated)

    async def delete_record(
        self,
        *,
        user_id: str | None = None,
        system_id: str,
        object_type: str | None,
        record_id: str | None = None,
    ) -> dict[str, Any]:
        _ = (user_id, system_id, object_type, record_id)
        raise ConnectedSystemBlockedError(
            "Delete must be created and approved as a CRM intent.",
            code="CONNECTED_SYSTEM_DELETE_INTENT_REQUIRED",
        )

    def _build_read_payload(
        self,
        *,
        system_id: str,
        object_type: str | None,
        email: str,
        phone: str,
        search_fields: dict[str, Any] | None,
        return_fields: list[str] | None,
    ) -> dict[str, Any]:
        system = self.get_system(system_id)
        email_value = _clean_text(email, max_length=320)
        phone_value = _normalize_crm_phone_for_mcp(phone)
        if not email_value:
            raise ConnectedSystemValidationError("email is required for read.")
        if not phone_value:
            raise ConnectedSystemValidationError("phone is required for read.")
        normalized_search = _normalize_search_fields(search_fields)
        normalized_return = _normalize_return_fields(return_fields)
        payload: dict[str, Any] = {
            "target": system.target,
            "objectType": _normalize_object_type(object_type, default=system.object_type_default),
            "email": email_value,
            "phone": phone_value,
        }
        if normalized_search:
            payload["searchFields"] = normalized_search
        if normalized_return:
            payload["returnFields"] = normalized_return
        return payload

    def _create_intent(
        self,
        *,
        user_id: str,
        system: ConnectedSystemDefinition,
        action: str,
        object_type: str,
        request_payload: dict[str, Any],
        readback_payload: dict[str, Any],
        field_names: list[str],
        record_id: str | None,
        delivery_mode: str = "legacy",
        encrypted_fields: dict[str, Any] | None = None,
        zk_metadata: dict[str, Any] | None = None,
        envelope_digest: str | None = None,
        client_operation_id: str | None = None,
    ) -> dict[str, Any]:
        deduped_fields = list(dict.fromkeys(field_names))
        intent = {
            "intent_id": _intent_id(),
            "user_id": user_id,
            "system_id": system.system_id,
            "action": action,
            "status": "pending",
            "target": system.target,
            "object_type": object_type,
            "record_id": record_id,
            "approval_id": None,
            "request_payload": request_payload,
            "readback_payload": readback_payload,
            "field_names": deduped_fields,
            "result_class": None,
            "result_payload": {},
            "readback_result": {},
            "delivery_mode": delivery_mode,
            "encrypted_fields": _deepcopy_json(encrypted_fields) if encrypted_fields else None,
            "zk_metadata": _deepcopy_json(zk_metadata) if zk_metadata else None,
            "envelope_digest": envelope_digest,
            "client_operation_id": client_operation_id,
            "approval_challenge_id": None,
            "error_code": None,
            "error_message": None,
            "created_at": _now_iso(),
            "updated_at": _now_iso(),
        }
        return self._public_intent(self._store_call(self.store.create_intent, intent))

    def _get_pending_intent(
        self, *, user_id: str, system_id: str, intent_id: str
    ) -> dict[str, Any]:
        intent = self._store_call(
            self.store.get_intent,
            user_id=user_id,
            system_id=system_id,
            intent_id=intent_id,
        )
        if not intent:
            raise ConnectedSystemNotFoundError("CRM intent was not found.")
        if intent.get("status") != "pending":
            raise ConnectedSystemValidationError(
                "Only pending CRM intents can be approved or rejected.",
                code="CRM_INTENT_NOT_PENDING",
            )
        return intent

    async def _readback(
        self,
        intent: dict[str, Any],
        *,
        system: ConnectedSystemDefinition,
        record_id: str | None,
    ) -> dict[str, Any]:
        readback_payload = _ensure_dict(intent.get("readback_payload"))
        record_id_value = _clean_text(record_id, max_length=128)
        if record_id_value:
            # A CRM mutation response or owner binding is the only authority
            # for this ID. Verify all mutations by that ID, never through a
            # broader identity lookup.
            readback_payload = {
                "target": system.target,
                "objectType": str(intent.get("object_type") or system.object_type_default),
                "id": record_id_value,
                "returnFields": []
                if intent.get("action") == "delete"
                else [str(field) for field in intent.get("field_names") or []],
            }
        if not readback_payload:
            return {
                "resultClass": "partial",
                "reason": "readback_locator_missing",
            }
        try:
            result = await self._call_operation(
                system=system, operation="read", payload=readback_payload
            )
            response_contract = _operation_response_contract(system, "read")
            records = _sanitize_read_records(
                result,
                response_contract=response_contract,
                allowed_fields=list(readback_payload.get("returnFields") or []),
            )
            return {
                "resultClass": "succeeded",
                "recordId": next(
                    (record["recordId"] for record in records if record.get("recordId")),
                    _record_id_from_result(result, response_contract=response_contract),
                ),
                "records": records,
            }
        except Exception as error:
            return {
                "resultClass": "partial",
                "reason": getattr(error, "code", "readback_failed"),
            }

    def _classify_readback(self, intent: dict[str, Any], readback: dict[str, Any]) -> str:
        if readback.get("resultClass") != "succeeded":
            return "partial"
        records = _records_from_readback(readback)
        if intent.get("action") == "delete":
            return "succeeded" if not records else "partial"
        expected = _expected_readback_fields(intent)
        if not expected:
            return "succeeded" if records else "partial"
        if not records:
            return "partial"
        record = records[0]
        for key, expected_value in expected.items():
            actual_value = record.get(key)
            if str(actual_value or "") != str(expected_value or ""):
                return "partial"
        return "succeeded"

    def _audit_for_intent(
        self,
        intent: dict[str, Any],
        *,
        mcp_result_class: str | None,
        readback_result_class: str | None,
        status: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        self._audit(
            user_id=intent["user_id"],
            system_id=intent["system_id"],
            action=intent["action"],
            object_type=intent["object_type"],
            record_id=intent.get("record_id"),
            intent_id=intent.get("intent_id"),
            approval_id=intent.get("approval_id"),
            field_names=intent.get("field_names") or [],
            mcp_result_class=mcp_result_class,
            readback_result_class=readback_result_class,
            status=status,
            metadata=metadata or {},
        )

    def _audit(
        self,
        *,
        user_id: str,
        system_id: str,
        action: str,
        object_type: str,
        record_id: str | None,
        field_names: list[str],
        mcp_result_class: str | None,
        readback_result_class: str | None,
        status: str,
        intent_id: str | None = None,
        approval_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        if not user_id:
            return
        system = self.get_system(system_id)
        self._store_call(
            self.store.record_audit_event,
            {
                "event_id": f"csae_{uuid4().hex}",
                "user_id": user_id,
                "system_id": system_id,
                "target": system.target,
                "object_type": object_type,
                "action": action,
                "record_id": record_id,
                "intent_id": intent_id,
                "approval_id": approval_id,
                "field_names": list(dict.fromkeys(field_names)),
                "mcp_result_class": mcp_result_class,
                "readback_result_class": readback_result_class,
                "status": status,
                "metadata": metadata or {},
            },
        )

    def _public_intent(self, intent: dict[str, Any]) -> dict[str, Any]:
        return {
            "intentId": intent["intent_id"],
            "systemId": intent["system_id"],
            "target": intent["target"],
            "objectType": intent["object_type"],
            "action": intent["action"],
            "status": intent["status"],
            "recordId": intent.get("record_id"),
            "approvalId": intent.get("approval_id"),
            "deliveryMode": intent.get("delivery_mode") or "legacy",
            "envelopeDigest": intent.get("envelope_digest"),
            "fieldNames": intent.get("field_names") or [],
            "payloadSummary": _payload_summary(intent),
            "resultClass": intent.get("result_class"),
            "result": intent.get("result_payload") or {},
            "readback": intent.get("readback_result") or {},
            "errorCode": intent.get("error_code"),
            "errorMessage": intent.get("error_message"),
            "createdAt": intent.get("created_at"),
            "updatedAt": intent.get("updated_at"),
        }

    def _upsert_binding_for_intent(
        self, intent: dict[str, Any], *, record_id: str
    ) -> dict[str, Any] | None:
        if intent.get("action") not in {"create", "update"}:
            return None
        return self._store_call(
            self.store.upsert_binding,
            {
                "binding_id": _binding_id(),
                "user_id": intent["user_id"],
                "system_id": intent["system_id"],
                "target": intent["target"],
                "object_type": intent["object_type"],
                "record_id": record_id,
                "created_intent_id": intent["intent_id"]
                if intent.get("action") == "create"
                else None,
                "last_intent_id": intent["intent_id"],
            },
        )

    def _public_binding(self, binding: dict[str, Any] | None) -> dict[str, Any] | None:
        if not binding:
            return None
        return {
            "bindingId": binding.get("binding_id"),
            "systemId": binding.get("system_id"),
            "target": binding.get("target"),
            "objectType": binding.get("object_type"),
            "recordId": binding.get("record_id"),
            "status": binding.get("status"),
            "createdIntentId": binding.get("created_intent_id"),
            "lastIntentId": binding.get("last_intent_id"),
            "createdAt": binding.get("created_at"),
            "updatedAt": binding.get("updated_at"),
            "deletedAt": binding.get("deleted_at"),
        }


def _payload_summary(intent: dict[str, Any]) -> dict[str, Any]:
    if intent.get("delivery_mode") == CRM_ENCRYPTED_FIELDS_V1_PROFILE:
        return {
            "profile": CRM_ENCRYPTED_FIELDS_V1_PROFILE,
            "fieldNames": intent.get("field_names") or [],
        }
    payload = intent.get("request_payload") or {}
    summary = {
        "target": payload.get("target"),
        "objectType": payload.get("objectType"),
        "fieldNames": intent.get("field_names") or [],
    }
    if payload.get("email"):
        summary["email"] = payload.get("email")
    elif payload.get("emailPresent"):
        summary["emailPresent"] = True
    if payload.get("phone"):
        summary["phone"] = payload.get("phone")
    elif payload.get("phonePresent"):
        summary["phonePresent"] = True
    if payload.get("id"):
        summary["id"] = payload.get("id")
    if isinstance(payload.get("additionalFieldNames"), list):
        summary["additionalFieldNames"] = payload.get("additionalFieldNames")
    if isinstance(payload.get("searchFieldNames"), list):
        summary["searchFieldNames"] = payload.get("searchFieldNames")
    if isinstance(payload.get("returnFields"), list):
        summary["returnFields"] = payload.get("returnFields")
    return summary


def _extract_record_id(result: dict[str, Any]) -> str | None:
    payload = _ensure_dict(result.get("payload"))
    candidates = [
        payload.get("id"),
        payload.get("Id"),
        payload.get("recordId"),
        payload.get("record_id"),
    ]
    for value in candidates:
        clean = _clean_text(value, max_length=128)
        if clean:
            return clean
    for record in _records_from_payload(payload):
        for key in ("Id", "id", "recordId", "record_id"):
            clean = _clean_text(record.get(key), max_length=128)
            if clean:
                return clean
    return None


def _records_from_readback(readback: dict[str, Any]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for record in _ensure_list(readback.get("records")):
        if not isinstance(record, dict):
            continue
        fields = _ensure_dict(record.get("fields"))
        if fields:
            records.append(fields)
    return records


def _records_from_payload(payload: dict[str, Any]) -> list[dict[str, Any]]:
    direct_records = payload.get("records")
    if isinstance(direct_records, list):
        return [dict(record) for record in direct_records if isinstance(record, dict)]
    for value in payload.values():
        if isinstance(value, list):
            records = [dict(record) for record in value if isinstance(record, dict)]
            if records:
                return records
    return [payload] if payload else []


def _expected_readback_fields(intent: dict[str, Any]) -> dict[str, Any]:
    payload = intent.get("request_payload") or {}
    if isinstance(payload.get("recordFields"), dict):
        return _ensure_dict(payload.get("recordFields"))
    if intent.get("action") == "update":
        return _ensure_dict(payload.get("additionalFields"))
    if intent.get("action") == "create":
        expected = _ensure_dict(payload.get("additionalFields"))
        if payload.get("firstName"):
            expected["FirstName"] = payload["firstName"]
        if payload.get("lastName"):
            expected["LastName"] = payload["lastName"]
        return expected
    return {}


_service: ConnectedSystemsService | None = None


def get_connected_systems_service() -> ConnectedSystemsService:
    global _service
    if _service is None:
        _service = ConnectedSystemsService()
    return _service
