"""Connected Systems registry and Salesforce CRM MCP adapter."""

from __future__ import annotations

import asyncio
import copy
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from db.db_client import DatabaseExecutionError, get_db

CONNECTED_SYSTEM_SALESFORCE_ID = "salesforce-fsc-customer0"
DEFAULT_TARGET = "Macys"
DEFAULT_OBJECT_TYPE = "Contact"
EXTERNAL_CRM_TRANSPORT = "external_crm_streamable_mcp"
REGISTRY_SOURCE = "customer0_connected_system_registry"
REGISTRY_MCP_ENDPOINT = "https://external-crm-mcp-gateway-a3e0me.y4rjsf.usa-e2.cloudhub.io/mcp"
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


def _normalize_object_type(object_type: str | None) -> str:
    value = _clean_text(object_type or DEFAULT_OBJECT_TYPE, max_length=80)
    if not value:
        value = DEFAULT_OBJECT_TYPE
    if value != DEFAULT_OBJECT_TYPE:
        raise ConnectedSystemValidationError(
            "Only Contact is supported for Salesforce CRM v1.",
            code="UNSUPPORTED_OBJECT_TYPE",
        )
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
            f"Unsupported Salesforce CRM field: {raw}",
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
    canonical = canonical or raw
    return canonical if canonical in SUPPORTED_CRM_FIELDS else None


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


def _collect_schema_field_descriptors(node: Any) -> list[Any]:
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


def _collect_schema_required_candidates(node: Any) -> list[str]:
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


def _schema_fields_from_schema_result(result: dict[str, Any]) -> list[dict[str, Any]]:
    required_fields = {
        canonical
        for candidate in _collect_schema_required_candidates(result)
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
        fields.append(
            {
                "key": canonical,
                "name": raw_name or canonical,
                "label": _schema_label_from_descriptor(descriptor)
                or _CRM_FIELD_LABELS.get(canonical)
                or canonical,
                "dataType": _schema_type_from_descriptor(descriptor)
                or _CRM_FIELD_INPUT_TYPES.get(canonical)
                or "string",
                "required": canonical in required_fields,
                "identityField": canonical in {"Email", "Phone"},
                "writable": canonical not in {"Email", "Phone"},
                "source": source,
            }
        )

    for descriptor in _collect_schema_field_descriptors(result):
        raw_name = _schema_field_name_from_descriptor(descriptor)
        canonical = _canonical_schema_field_name(raw_name)
        if canonical:
            _append_field(canonical=canonical, raw_name=raw_name, descriptor=descriptor)

    for canonical in required_fields:
        _append_field(canonical=canonical, raw_name=canonical)

    if not fields:
        for canonical in sorted(SUPPORTED_CRM_FIELDS):
            _append_field(canonical=canonical, raw_name=canonical, source="allowlist_fallback")

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
            f"Unsupported Salesforce CRM search field: {raw}",
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

    def to_summary(self, *, endpoint_configured: bool, delete_enabled: bool) -> dict[str, Any]:
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
            "toolCatalog": [_deepcopy_json(tool) for tool in self.tool_catalog],
            "supportedActions": {
                "schema": True,
                "read": True,
                "create": True,
                "update": True,
                "delete": delete_enabled,
            },
            "fieldAllowlist": sorted(SUPPORTED_CRM_FIELDS),
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
)

REGISTERED_CONNECTED_SYSTEMS: tuple[ConnectedSystemDefinition, ...] = (SALESFORCE_CRM_SYSTEM,)


class ExternalCrmStreamableMcpAdapter:
    """Calls the Salesforce external CRM through MCP streamable HTTP."""

    def __init__(
        self,
        endpoint: str | None = None,
        *,
        timeout_seconds: float = 30.0,
        tool_catalog: tuple[dict[str, Any], ...] | None = None,
    ):
        self.endpoint = endpoint
        self.timeout_seconds = timeout_seconds
        self.tool_catalog = tuple(tool_catalog or ())
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

    async def _call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if not self.endpoint:
            raise ConnectedSystemConfigurationError(
                "Connected Systems registry does not include a Salesforce CRM MCP endpoint."
            )
        if self.endpoint.startswith("registry://"):
            return self._call_registry_tool(name, arguments)

        async def _run() -> dict[str, Any]:
            from mcp.client.session import ClientSession
            from mcp.client.streamable_http import streamablehttp_client

            async with streamablehttp_client(self.endpoint) as (read_stream, write_stream, _):
                async with ClientSession(read_stream, write_stream) as session:
                    await session.initialize()
                    result = await session.call_tool(name, arguments)
            return _normalize_mcp_tool_result(result)

        try:
            return await asyncio.wait_for(_run(), timeout=self.timeout_seconds)
        except ConnectedSystemsError:
            raise
        except TimeoutError as error:
            raise ConnectedSystemsError(
                "Salesforce CRM MCP request timed out.",
                code="CONNECTED_SYSTEM_MCP_TIMEOUT",
                status_code=504,
            ) from error
        except Exception as error:
            raise ConnectedSystemsError(
                "Salesforce CRM MCP request failed.",
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
        self.registry = registry or REGISTERED_CONNECTED_SYSTEMS
        default_system = self._registry_system(CONNECTED_SYSTEM_SALESFORCE_ID)
        self.adapter = adapter or ExternalCrmStreamableMcpAdapter.from_registry(default_system)
        self.store = store or DatabaseConnectedSystemIntentStore()
        self.delete_enabled = True if delete_enabled is None else delete_enabled

    def list_systems(self) -> list[dict[str, Any]]:
        return [
            system.to_summary(
                endpoint_configured=bool(system.transport_endpoint),
                delete_enabled=self.delete_enabled,
            )
            for system in self.registry
        ]

    def get_system(self, system_id: str) -> ConnectedSystemDefinition:
        return self._registry_system(system_id)

    def _registry_system(self, system_id: str) -> ConnectedSystemDefinition:
        for system in self.registry:
            if system.system_id == system_id:
                return system
        raise ConnectedSystemNotFoundError("Connected system was not found.")

    async def get_schema(self, *, system_id: str, object_type: str | None = None) -> dict[str, Any]:
        system = self.get_system(system_id)
        payload = {
            "target": system.target,
            "objectType": _normalize_object_type(object_type),
        }
        result = await self.adapter.object_schema(payload)
        schema_fields = _schema_fields_from_schema_result(result)
        return {
            "systemId": system.system_id,
            "target": system.target,
            "objectType": payload["objectType"],
            "supportedFields": [field["key"] for field in schema_fields],
            "fields": schema_fields,
            "mcp": result,
        }

    async def read_record(
        self,
        *,
        user_id: str | None = None,
        system_id: str,
        object_type: str | None,
        email: str,
        phone: str,
        search_fields: dict[str, Any] | None = None,
        return_fields: list[str] | None = None,
    ) -> dict[str, Any]:
        payload = self._build_read_payload(
            system_id=system_id,
            object_type=object_type,
            email=email,
            phone=phone,
            search_fields=search_fields,
            return_fields=return_fields,
        )
        result = await self.adapter.read_record(payload)
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
            "recordId": _extract_record_id(result),
            "mcp": result,
        }

    def get_record_binding(
        self,
        *,
        user_id: str,
        system_id: str,
        object_type: str | None,
    ) -> dict[str, Any]:
        system = self.get_system(system_id)
        object_type_value = _normalize_object_type(object_type)
        binding = self.store.get_binding(
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
        email: str,
        phone: str,
        search_fields: dict[str, Any] | None = None,
        return_fields: list[str] | None = None,
    ) -> dict[str, Any]:
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
            object_type_value = _normalize_object_type(object_type)
            binding = self.store.upsert_binding(
                {
                    "binding_id": _binding_id(),
                    "user_id": user_id,
                    "system_id": system_id,
                    "target": system.target,
                    "object_type": object_type_value,
                    "record_id": record_id,
                    "created_intent_id": None,
                    "last_intent_id": None,
                }
            )
        return {
            **read,
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
    ) -> dict[str, Any]:
        system = self.get_system(system_id)
        object_type_value = _normalize_object_type(object_type)
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
        normalized_additional = _normalize_additional_fields(additional_fields)
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
        readback_locator: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        system = self.get_system(system_id)
        object_type_value = _normalize_object_type(object_type)
        record_id_value = _clean_text(record_id, max_length=128)
        if not record_id_value:
            raise ConnectedSystemValidationError("id is required for update.")
        normalized_additional = _normalize_additional_fields(additional_fields)
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

    async def approve_intent(
        self, *, user_id: str, system_id: str, intent_id: str
    ) -> dict[str, Any]:
        self.get_system(system_id)
        intent = self._get_pending_intent(user_id=user_id, system_id=system_id, intent_id=intent_id)
        approval = _approval_id()
        intent = self.store.update_intent(
            intent_id=intent_id,
            updates={"status": "approved", "approval_id": approval},
        )
        try:
            if intent["action"] == "create":
                result = await self.adapter.create_record(intent["request_payload"])
            elif intent["action"] == "update":
                result = await self.adapter.update_record(intent["request_payload"])
            else:
                raise ConnectedSystemValidationError("Unsupported approval action.")
            record_id = intent.get("record_id") or _extract_record_id(result)
            readback = await self._readback(intent)
            if not record_id and isinstance(readback.get("mcp"), dict):
                record_id = _extract_record_id(readback.get("mcp") or {})
            readback_class = self._classify_readback(intent, readback)
            result_class = "failed" if result.get("isError") else readback_class
            status = "succeeded" if result_class == "succeeded" else result_class
            if result.get("isError"):
                status = "failed"
            mcp_error_message = _mcp_error_message(result) if status == "failed" else None
            terminal_updates = _scrub_terminal_intent_updates(
                intent,
                {
                    "status": status,
                    "record_id": record_id,
                    "approval_id": approval,
                    "result_class": result_class,
                    "result_payload": result,
                    "readback_result": readback,
                    "error_code": None if status != "failed" else "MCP_RESULT_ERROR",
                    "error_message": mcp_error_message,
                },
            )
            updated = self.store.update_intent(
                intent_id=intent_id,
                updates=terminal_updates,
            )
            binding = None
            if status != "failed" and record_id:
                binding = self._upsert_binding_for_intent(updated, record_id=record_id)
            self._audit_for_intent(
                updated,
                mcp_result_class="succeeded" if not result.get("isError") else "failed",
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
            updated = self.store.update_intent(
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
            if isinstance(error, DatabaseExecutionError):
                raise
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
        updated = self.store.update_intent(
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
        if not self.delete_enabled:
            raise ConnectedSystemBlockedError(
                "Delete is blocked for this connected system.",
                code="CRM_DELETE_BLOCKED",
            )
        system = self.get_system(system_id)
        object_type_value = _normalize_object_type(object_type)
        binding = None
        if user_id:
            binding = self.store.get_binding(
                user_id=user_id,
                system_id=system_id,
                object_type=object_type_value,
            )
        bound_record_id = _clean_text((binding or {}).get("record_id"), max_length=128)
        requested_record_id = _clean_text(record_id, max_length=128)
        record_id_value = requested_record_id or bound_record_id
        payload = {
            "target": system.target,
            "objectType": object_type_value,
            "id": record_id_value,
        }
        if not payload["id"]:
            raise ConnectedSystemValidationError("id is required for delete.")
        result = await self.adapter.delete_record(payload)
        status = "failed" if result.get("isError") else "succeeded"
        deleted_binding = None
        if user_id and status == "succeeded":
            deleted_binding = self.store.mark_binding_deleted(
                user_id=user_id,
                system_id=system_id,
                object_type=object_type_value,
                record_id=payload["id"],
            )
        self._audit(
            user_id=user_id or "",
            system_id=system_id,
            action="delete",
            object_type=object_type_value,
            record_id=payload["id"],
            field_names=[],
            mcp_result_class=status,
            readback_result_class=None,
            status=status,
            metadata=_summarize_mcp_result(result),
        )
        return {
            "systemId": system_id,
            "target": system.target,
            "objectType": object_type_value,
            "recordId": payload["id"],
            "resultClass": status,
            "mcp": result,
            "binding": self._public_binding(deleted_binding) if deleted_binding else None,
        }

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
            "objectType": _normalize_object_type(object_type),
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
        return self._public_intent(self.store.create_intent(intent))

    def _get_pending_intent(
        self, *, user_id: str, system_id: str, intent_id: str
    ) -> dict[str, Any]:
        intent = self.store.get_intent(user_id=user_id, system_id=system_id, intent_id=intent_id)
        if not intent:
            raise ConnectedSystemNotFoundError("CRM intent was not found.")
        if intent.get("status") != "pending":
            raise ConnectedSystemValidationError(
                "Only pending CRM intents can be approved or rejected.",
                code="CRM_INTENT_NOT_PENDING",
            )
        return intent

    async def _readback(self, intent: dict[str, Any]) -> dict[str, Any]:
        readback_payload = intent.get("readback_payload") or {}
        if not readback_payload:
            return {
                "resultClass": "partial",
                "reason": "readback_locator_missing",
            }
        try:
            result = await self.adapter.read_record(readback_payload)
            return {
                "resultClass": "succeeded" if not result.get("isError") else "failed",
                "mcp": result,
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
        self.store.record_audit_event(
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
            }
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
        return self.store.upsert_binding(
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
            }
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
    payload = _ensure_dict(_ensure_dict(readback.get("mcp")).get("payload"))
    return _records_from_payload(payload)


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
