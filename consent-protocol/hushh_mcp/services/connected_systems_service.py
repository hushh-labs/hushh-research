"""Capability-safe Connected Systems registry and CRM MCP adapter."""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from db.db_client import DatabaseExecutionError, get_db

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
    },
    {
        "name": "update-crm-record",
        "operation": "update",
        "description": "Update allowlisted Contact fields for the bound record.",
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
            and isinstance(contract.get("requireFieldAccess"), bool)
        )
    if operation == "read":
        return (
            version == "crm-record-collection.v1"
            and _has_contract_path(contract, "recordsPath")
            and _has_contract_path(contract, "recordIdPath")
        )
    if operation in {"create", "update", "delete"}:
        return (
            version == "crm-mutation-result.v1"
            and _has_contract_path(contract, "successPath")
            and _has_contract_path(contract, "recordIdPath")
            and isinstance(contract.get("successValue"), bool)
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
        # Compatibility-only fallback for the in-code adapter. Registry-backed
        # connectors cannot reach this branch because their contract is checked
        # before the outbound call.
        raw_records = (
            _records_from_payload(_ensure_dict(result.get("payload"))) if not contract else []
        )
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
    strict_access = bool(contract.get("requireFieldAccess"))
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
        permissions_declared = all(
            value is not None for value in (identity, immutable, readable, createable, updateable)
        )
        if strict_access:
            # Missing field permissions are unknown, never an allow. In
            # particular, writable is *derived* from the two operation-specific
            # declarations; an upstream `writable` convenience bit cannot
            # expand create or update authority.
            identity = bool(identity)
            immutable = bool(immutable)
            readable = bool(readable)
            createable = bool(createable)
            updateable = bool(updateable)
            writable = bool(createable or updateable)
        else:
            # Deterministic in-code fixtures predate the database registry.
            # They remain wire-compatible only; all registry rows set
            # requireFieldAccess and take the fail-closed branch above.
            immutable = bool(immutable)
            identity = bool(identity)
            readable = True if readable is None else readable
            createable = (not immutable) if createable is None else createable
            updateable = (not immutable) if updateable is None else updateable
            writable = bool(createable or updateable)
        fields.append(
            {
                "key": canonical,
                "name": raw_name or canonical,
                "label": _schema_label_from_descriptor(descriptor) or canonical,
                "dataType": _schema_type_from_descriptor(descriptor) or "string",
                "required": bool(descriptor_required) or canonical in required_fields,
                "identityField": bool(identity),
                "readable": bool(readable),
                "createable": bool(createable),
                "updateable": bool(updateable),
                "writable": bool(writable),
                "immutable": bool(immutable),
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

    def operation(self, operation: str) -> dict[str, Any] | None:
        return next(
            (
                _deepcopy_json(tool)
                for tool in self.tool_catalog
                if str(tool.get("operation") or "").strip() == operation
            ),
            None,
        )

    def operation_endpoint(self, operation: str) -> str | None:
        tool = self.operation(operation) or {}
        configured = str(tool.get("mcpEndpoint") or "").strip()
        # A legacy registry could contain a path-only operation endpoint. It is
        # not a valid Streamable HTTP target on its own; preserve the system's
        # registered absolute transport endpoint until that row is explicitly
        # configured with an absolute per-operation URL.
        if configured.startswith(("https://", "http://", "registry://")):
            return configured
        return (
            str(
                (self.delete_transport_endpoint if operation == "delete" else None)
                or self.transport_endpoint
                or ""
            ).strip()
            or None
        )

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
        return {
            "systemId": self.system_id,
            "displayName": self.display_name,
            "customerDisplayName": self.customer_display_name,
            "systemType": self.system_type,
            "systemName": self.system_name,
            "status": "connected" if endpoint_configured else "needs_configuration",
            "target": self.target,
            "objectTypeDefault": self.object_type_default,
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

        tool_arguments = {
            **_deepcopy_json(self.tool_arguments),
            **_deepcopy_json(arguments),
        }

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

    def upsert_binding(self, binding: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError

    def mark_binding_deleted(
        self,
        *,
        user_id: str,
        system_id: str,
        object_type: str,
        record_id: str,
        last_intent_id: str | None = None,
    ) -> dict[str, Any] | None:
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
    ):
        self._registry_explicit = registry is not None
        self.registry = registry or self._load_registry()
        self.adapter = adapter
        self.store = store or DatabaseConnectedSystemIntentStore()
        self.delete_enabled = True if delete_enabled is None else delete_enabled

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
        self, *, system: ConnectedSystemDefinition, operation: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        config = self._require_operation(system, operation)
        adapter = self._adapter_for_system(system)
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
                tool_name=str(config.get("name") or ""),
                endpoint=endpoint,
                timeout_seconds=system.timeout_seconds,
                retry_count=system.retry_count,
                arguments=payload,
            )
        else:
            legacy_method = {
                "schema": "object_schema",
                "read": "read_record",
                "create": "create_record",
                "update": "update_record",
                "delete": "delete_record",
            }[operation]
            result = await getattr(adapter, legacy_method)(payload)
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

    def get_system(self, system_id: str) -> ConnectedSystemDefinition:
        return self._resolve_system(system_id)

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

    async def get_schema(self, *, system_id: str, object_type: str | None = None) -> dict[str, Any]:
        system = self.get_system(system_id)
        self._require_operation(system, "schema")
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
            "objectType": _normalize_object_type(object_type, default=system.object_type_default),
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
        permissions_complete = (
            all(field.get("permissionsDeclared") for field in schema_fields)
            if response_contract.get("requireFieldAccess") is True
            else True
        )
        has_readable_identity = (
            any(field.get("readable") and field.get("identityField") for field in schema_fields)
            or response_contract.get("requireFieldAccess") is not True
        )
        effective_actions = {
            "schema": True,
            "read": bool(
                permissions_complete and has_readable_identity and system.supports("read")
            ),
            "create": bool(
                permissions_complete
                and any(field.get("createable") for field in schema_fields)
                and system.supports("create")
            ),
            "update": bool(
                permissions_complete
                and any(field.get("updateable") for field in schema_fields)
                and system.supports("update")
            ),
            "delete": bool(
                permissions_complete and system.supports("delete") and self.delete_enabled
            ),
        }
        return {
            "systemId": system.system_id,
            "target": system.target,
            "objectType": payload["objectType"],
            "objectMetadata": object_metadata,
            "supportedFields": [field["key"] for field in schema_fields],
            "fields": schema_fields,
            "schemaStatus": "ready" if permissions_complete else "capability_metadata_missing",
            "effectiveActions": effective_actions,
            "configurationMessage": (
                None
                if permissions_complete
                else "This connected system needs an update before its fields can be used."
            ),
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
        require_required_fields: bool = False,
    ) -> dict[str, Any]:
        if not isinstance(values, dict) or not values:
            raise ConnectedSystemValidationError(f"recordFields is required for {action}.")
        normalized: dict[str, Any] = {}
        for raw_name, value in values.items():
            key = _clean_text(raw_name, max_length=80)
            field = fields.get(key)
            if field is None:
                raise ConnectedSystemValidationError(
                    f"Field is not available in this CRM schema: {key}",
                    code="CONNECTED_SYSTEM_SCHEMA_FIELD_UNAVAILABLE",
                )
            if action == "update" and (
                field.get("immutable")
                or field.get("identityField")
                or field.get("updateable") is not True
            ):
                raise ConnectedSystemValidationError(
                    f"Field cannot be updated: {key}",
                    code="CONNECTED_SYSTEM_SCHEMA_FIELD_READ_ONLY",
                )
            if action == "create" and (
                field.get("immutable") or field.get("createable") is not True
            ):
                raise ConnectedSystemValidationError(
                    f"Field cannot be written: {key}",
                    code="CONNECTED_SYSTEM_SCHEMA_FIELD_READ_ONLY",
                )
            normalized[field["name"]] = value
        if require_required_fields:
            supplied = {str(key).lower() for key in normalized}
            missing = [
                field["label"]
                for field in fields.values()
                if field.get("required") and str(field["name"]).lower() not in supplied
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
    ) -> dict[str, Any]:
        system = self.get_system(system_id)
        self._require_operation(system, "create")
        schema = await self.get_schema(system_id=system_id, object_type=object_type)
        self._require_schema_action(schema, "create")
        fields = {str(field["key"]): field for field in schema["fields"]}
        normalized = self._validated_schema_fields(
            fields, record_fields, action="create", require_required_fields=True
        )
        object_type_value = str(schema["objectType"])
        payload: dict[str, Any] = {
            "target": system.target,
            "objectType": object_type_value,
            "recordFields": normalized,
        }
        # The currently deployed Macy's tool predates recordFields. This is an
        # explicit wire-compatibility adapter, not a generic CRM assumption.
        if system.system_id == CONNECTED_SYSTEM_SALESFORCE_ID:
            legacy = {str(key): value for key, value in normalized.items()}
            payload = {
                "target": system.target,
                "objectType": object_type_value,
                "email": legacy.pop("Email", ""),
                "phone": _normalize_crm_phone_for_mcp(legacy.pop("Phone", "")),
                "lastName": legacy.pop("LastName", ""),
                "firstName": legacy.pop("FirstName", "") or None,
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

    async def update_record_intent_from_fields(
        self,
        *,
        user_id: str,
        system_id: str,
        object_type: str | None,
        record_id: str,
        record_fields: dict[str, Any],
        readback_locator: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        system = self.get_system(system_id)
        self._require_operation(system, "update")
        record_id_value = _clean_text(record_id, max_length=128)
        if not record_id_value:
            raise ConnectedSystemValidationError("id is required for update.")
        schema = await self.get_schema(system_id=system_id, object_type=object_type)
        self._require_schema_action(schema, "update")
        fields = {str(field["key"]): field for field in schema["fields"]}
        normalized = self._validated_schema_fields(fields, record_fields, action="update")
        object_type_value = str(schema["objectType"])
        payload: dict[str, Any] = {
            "target": system.target,
            "objectType": object_type_value,
            "id": record_id_value,
            "recordFields": normalized,
        }
        if system.system_id == CONNECTED_SYSTEM_SALESFORCE_ID:
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
        if system.system_id == CONNECTED_SYSTEM_SALESFORCE_ID:
            return self._build_read_payload(
                system_id=system.system_id,
                object_type=object_type,
                email=str(search_fields.get("Email") or ""),
                phone=str(search_fields.get("Phone") or ""),
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
    ) -> dict[str, Any]:
        payload = await self._build_schema_read_payload(
            system_id=system_id,
            object_type=object_type,
            email=email,
            phone=phone,
            search_fields=search_fields,
            return_fields=return_fields,
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
    ) -> dict[str, Any]:
        system = self.get_system(system_id)
        schema = await self.get_schema(system_id=system_id, object_type=object_type)
        self._require_schema_action(schema, "read")
        fields = {
            str(field["key"]): field for field in schema["fields"] if field.get("readable") is True
        }
        by_name = {str(field["name"]): field for field in fields.values()}
        # Macy's aliases remain a compatibility input only. They cannot make a
        # future CRM look up arbitrary fields without a schema descriptor.
        if email is not None or phone is not None:
            if system.system_id != CONNECTED_SYSTEM_SALESFORCE_ID:
                raise ConnectedSystemValidationError(
                    "Use searchFields for this CRM.",
                    code="CONNECTED_SYSTEM_GENERIC_LOOKUP_REQUIRED",
                )
            return self._build_read_payload(
                system_id=system_id,
                object_type=object_type,
                email=email or "",
                phone=phone or "",
                search_fields=search_fields,
                return_fields=return_fields,
            )
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
        normalized_return: list[str] = []
        for raw_name in return_fields or []:
            field = fields.get(str(raw_name)) or by_name.get(str(raw_name))
            if not field:
                raise ConnectedSystemValidationError(
                    f"Return field is not available in this CRM schema: {raw_name}",
                    code="CONNECTED_SYSTEM_SCHEMA_FIELD_UNAVAILABLE",
                )
            normalized_return.append(str(field["name"]))
        return {
            "target": system.target,
            "objectType": str(schema["objectType"]),
            "searchFields": normalized_search,
            "returnFields": list(dict.fromkeys(normalized_return)),
        }

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
        record_id = _clean_text(read.get("recordId"), max_length=128)
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
        binding = self._store_call(
            self.store.get_binding,
            user_id=user_id,
            system_id=system_id,
            object_type=object_type_value,
        )
        record_id_value = _clean_text(record_id or (binding or {}).get("record_id"), max_length=128)
        if not record_id_value:
            raise ConnectedSystemValidationError("id is required for delete.")
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
            readback_payload={},
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
            if system.registry_source == "enterprise_crm_registry":
                schema = await self.get_schema(
                    system_id=system_id, object_type=intent.get("object_type")
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
            readback = (
                {"resultClass": "succeeded", "reason": "delete_confirmed"}
                if intent["action"] == "delete" and mutation_succeeded
                else await self._readback(intent, system=system)
            )
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
        self, intent: dict[str, Any], *, system: ConnectedSystemDefinition
    ) -> dict[str, Any]:
        readback_payload = intent.get("readback_payload") or {}
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
