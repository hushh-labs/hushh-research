"""Bounded, provider-neutral admission for untrusted MCP tool catalogs.

An MCP server's descriptions and schemas are information, not execution
authority. Callers supply their own reviewed exact-name allowlist and keep
read/action authorization outside this pure policy module.
"""

from __future__ import annotations

import json
from typing import Any, Iterable

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError, ValidationError
from referencing import Registry
from referencing.exceptions import NoSuchResource, Unresolvable

MAX_SCHEMA_BYTES = 16_000
MAX_DESCRIPTION_LENGTH = 700
MAX_ARGUMENT_BYTES = 4_096


def _reject_reference(uri: str) -> Any:
    """Provider schemas cannot trigger another, unpinned network fetch."""
    raise NoSuchResource(ref=uri)


OFFLINE_SCHEMA_REGISTRY = Registry(retrieve=_reject_reference)


def admit_tool(value: object, *, allowed_names: frozenset[str]) -> dict[str, Any] | None:
    """Admit one exact, bounded tool schema from a reviewed capability list."""
    if not isinstance(value, dict):
        return None
    name = value.get("name")
    if not isinstance(name, str) or name not in allowed_names:
        return None
    schema = value.get("inputSchema")
    if not isinstance(schema, dict) or schema.get("type") != "object":
        return None
    try:
        if len(json.dumps(schema, allow_nan=False).encode("utf-8")) > MAX_SCHEMA_BYTES:
            return None
        Draft202012Validator.check_schema(schema)
    except (SchemaError, TypeError, ValueError, RecursionError):
        return None
    pending = [schema]
    while pending:
        node = pending.pop()
        if isinstance(node, dict):
            if any(
                key in node for key in ("$id", "$dynamicRef", "$recursiveRef", "$dynamicAnchor")
            ):
                return None
            ref = node.get("$ref")
            if ref is not None and (not isinstance(ref, str) or not ref.startswith("#/")):
                return None
            pending.extend(node.values())
        elif isinstance(node, list):
            pending.extend(node)
    description = value.get("description")
    return {
        "name": name,
        "description": description[:MAX_DESCRIPTION_LENGTH] if isinstance(description, str) else "",
        "inputSchema": schema,
    }


def admit_catalog(
    values: Iterable[object], *, allowed_names: frozenset[str]
) -> list[dict[str, Any]]:
    """Reject ambiguous duplicate names rather than choosing provider order."""
    approved: dict[str, dict[str, Any]] = {}
    duplicated: set[str] = set()
    for value in values:
        capability = admit_tool(value, allowed_names=allowed_names)
        if capability is None:
            continue
        name = capability["name"]
        if name in approved:
            approved.pop(name)
            duplicated.add(name)
        elif name not in duplicated:
            approved[name] = capability
    return [approved[name] for name in sorted(approved)]


def arguments_bounded(arguments: object) -> bool:
    """Reject malformed or oversized input before contacting a provider."""
    if not isinstance(arguments, dict):
        return False
    try:
        if len(json.dumps(arguments, allow_nan=False).encode("utf-8")) > MAX_ARGUMENT_BYTES:
            return False
    except (TypeError, ValueError, RecursionError):
        return False
    return True


def arguments_valid(capability: dict[str, Any], arguments: object) -> bool:
    """Validate model-supplied arguments without revealing provider details."""
    if not arguments_bounded(arguments):
        return False
    try:
        Draft202012Validator(capability["inputSchema"], registry=OFFLINE_SCHEMA_REGISTRY).validate(
            arguments
        )
    except (
        KeyError,
        ValidationError,
        SchemaError,
        Unresolvable,
        TypeError,
        ValueError,
        RecursionError,
    ):
        return False
    return True
