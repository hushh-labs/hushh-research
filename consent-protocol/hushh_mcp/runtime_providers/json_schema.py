"""Copy provider schemas into standard JSON Schema without altering payloads."""

from __future__ import annotations

from typing import Any

_TYPES = frozenset({"object", "array", "string", "number", "integer", "boolean", "null"})


def normalize_json_schema(schema: Any) -> dict[str, Any] | bool:
    """Normalize schema nodes only; enums, defaults and examples are information."""
    if isinstance(schema, bool):
        return schema
    if not isinstance(schema, dict):
        raise ValueError("Schema nodes must be objects or booleans")
    result = dict(schema)
    kind = result.get("type")
    if kind is not None:
        kinds = kind if isinstance(kind, list) else [kind]
        if not kinds or any(
            not isinstance(item, str) or item.lower() not in _TYPES for item in kinds
        ):
            raise ValueError("Schema type is unsupported")
        normalized = [item.lower() for item in kinds]
        result["type"] = normalized if isinstance(kind, list) else normalized[0]
    for key in ("properties", "$defs", "definitions", "patternProperties", "dependentSchemas"):
        if key in result:
            if not isinstance(result[key], dict):
                raise ValueError("Schema property maps must be objects")
            result[key] = {
                name: normalize_json_schema(value) for name, value in result[key].items()
            }
    for key in (
        "items",
        "additionalProperties",
        "not",
        "contains",
        "if",
        "then",
        "else",
        "propertyNames",
        "unevaluatedProperties",
    ):
        if key in result:
            value = result[key]
            result[key] = (
                [normalize_json_schema(item) for item in value]
                if key == "items" and isinstance(value, list)
                else normalize_json_schema(value)
            )
    for key in ("anyOf", "oneOf", "allOf", "prefixItems"):
        if key in result:
            if not isinstance(result[key], list):
                raise ValueError("Schema alternatives must be arrays")
            result[key] = [normalize_json_schema(value) for value in result[key]]
    nullable = result.pop("nullable", False)
    if not isinstance(nullable, bool):
        raise ValueError("Schema nullable must be boolean")
    return {"anyOf": [result, {"type": "null"}]} if nullable else result
