"""Represent response schemas without deleting model-authored dynamic fields."""

from __future__ import annotations

import json
from typing import Any

from .json_schema import (
    current_validated_output_schema,
    normalize_json_schema,
    schema_document,
)


def _schema(value: Any, *, strict: bool) -> dict:
    """Translate native schema syntax; response selection protects open maps."""
    value = schema_document(value)

    def visit(node):
        if isinstance(node, list):
            return [visit(item) for item in node]
        if not isinstance(node, dict):
            return node
        result = {}
        for key, child in node.items():
            if key in {"default", "title"}:
                continue
            if key in {"properties", "$defs", "definitions", "patternProperties"}:
                result[key] = {name: visit(item) for name, item in child.items()}
            else:
                result["anyOf" if key == "oneOf" else key] = visit(child)
        if isinstance(result.get("type"), str):
            result["type"] = result["type"].lower()
        if "const" in result:
            result["enum"] = [result.pop("const")]
        nullable = result.pop("nullable", False)
        if strict and result.get("type") == "object":
            if result.get("additionalProperties") not in (None, False):
                raise ValueError("Azure strict output cannot represent open object fields")
            result.setdefault("properties", {})
            result["additionalProperties"] = False
            result["required"] = list(result["properties"])
        if nullable:
            return {"anyOf": [result, {"type": "null"}]}
        return result

    converted = visit(value)
    if not isinstance(converted, dict):
        raise ValueError("Azure structured schema must remain an object")
    return converted


def _has_open_map(node: Any) -> bool:
    """Visit schema positions, never enum, example, default or other values."""
    if not isinstance(node, dict):
        return False
    kind = node.get("type")
    kinds = kind if isinstance(kind, list) else [kind]
    object_node = (
        "object" in [item.lower() for item in kinds if isinstance(item, str)]
        or "properties" in node
        or "additionalProperties" in node
    )
    if object_node:
        additional = node.get("additionalProperties")
        if additional is not False and (
            not node.get("properties") or additional is True or isinstance(additional, dict)
        ):
            return True
    if node.get("patternProperties"):
        return True
    for key in ("properties", "$defs", "definitions", "patternProperties", "dependentSchemas"):
        if isinstance(node.get(key), dict) and any(
            _has_open_map(item) for item in node[key].values()
        ):
            return True
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
        value = node.get(key)
        if (
            any(_has_open_map(item) for item in value)
            if isinstance(value, list)
            else _has_open_map(value)
        ):
            return True
    return any(
        _has_open_map(item)
        for key in ("anyOf", "oneOf", "allOf", "prefixItems")
        for item in node.get(key, [])
    )


def response_format(schema: Any) -> tuple[dict, str]:
    """Use JSON mode only within the turn that owns exact host validation.

    Azure's closed native objects cannot express Memory's dynamic maps. Do not
    retry a rejected request, switch provider, invent fields or erase values.
    General callers without the owning validator remain refused before I/O.
    """
    document = schema_document(schema)
    if not _has_open_map(document):
        return {
            "type": "json_schema",
            "name": "adk_response",
            "strict": True,
            "schema": _schema(document, strict=True),
        }, ""
    owner = current_validated_output_schema()
    normalized = normalize_json_schema(document)
    if owner is None or owner != normalized:
        raise ValueError("Azure open response schema requires its original host validator")
    instruction = "Return a JSON object matching this output schema:\n" + json.dumps(
        normalized, sort_keys=True, allow_nan=False
    )
    return {"type": "json_object"}, instruction
