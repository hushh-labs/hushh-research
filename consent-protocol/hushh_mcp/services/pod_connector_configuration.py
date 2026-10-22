"""Public connector configuration within the existing approved pod update.

This port only fills missing deployment-owned values. It cannot change an
owner's information policy, credentials, cloud placement or existing binding.
"""

from __future__ import annotations

import copy
import os
from typing import Any

from hushh_mcp.runtime_environment import pod_connector_public_environment

_NAMES = frozenset(
    {"APP_FRONTEND_ORIGIN", "SCOPE_COMMERCE_STRIPE_ACCOUNT_ID", "SCOPE_COMMERCE_STRIPE_LIVEMODE"}
)


def expected_connector_environment() -> list[dict[str, str]]:
    return pod_connector_public_environment(os.environ)


def validate_connector_environment(expected: Any) -> list[dict[str, str]]:
    """Validate a frozen receipt without consulting today's deployment settings."""
    if not isinstance(expected, list):
        raise RuntimeError("Connector configuration receipt is invalid.")
    values: dict[str, str] = {}
    for item in expected:
        if (
            not isinstance(item, dict)
            or set(item) != {"name", "value"}
            or not isinstance(item["name"], str)
            or item["name"] not in _NAMES
            or item["name"] in values
            or not isinstance(item["value"], str)
        ):
            raise RuntimeError("Connector configuration receipt is invalid.")
        values[item["name"]] = item["value"]
    try:
        canonical = pod_connector_public_environment(values)
    except ValueError:
        raise RuntimeError("Connector configuration receipt is invalid.") from None
    if expected != canonical:
        raise RuntimeError("Connector configuration receipt is invalid.")
    return copy.deepcopy(canonical)


def reconcile_connector_environment(
    entries: list[dict[str, Any]], expected: list[dict[str, str]] | None = None
) -> list[dict[str, Any]]:
    """Reject ambiguous/mismatched public values; preserve every other entry."""
    expected = expected_connector_environment() if expected is None else expected
    expected = validate_connector_environment(expected)
    if expected != expected_connector_environment():
        raise RuntimeError("Connector deployment configuration changed; reconcile the update.")
    return _reconciled(entries, expected)


def _reconciled(
    entries: list[dict[str, Any]], expected: list[dict[str, str]]
) -> list[dict[str, Any]]:
    if not isinstance(entries, list) or any(not isinstance(item, dict) for item in entries):
        raise RuntimeError("Connector runtime configuration is unavailable.")
    wanted = {item["name"]: item["value"] for item in expected}
    present: dict[str, dict[str, Any]] = {}
    for item in entries:
        name = item.get("name")
        if name not in _NAMES:
            continue
        if name in present or set(item) != {"name", "value"} or not isinstance(item["value"], str):
            raise RuntimeError("Connector public configuration is ambiguous.")
        present[name] = item
        if name in wanted and item["value"] and item["value"] != wanted[name]:
            raise RuntimeError("Connector public binding changed; reconcile the update.")
    result = copy.deepcopy(entries)
    for name, value in wanted.items():
        if name not in present:
            result.append({"name": name, "value": value})
        elif not present[name]["value"]:
            next(item for item in result if item.get("name") == name)["value"] = value
    return result


def connector_configuration_current(
    app: dict[str, Any], expected: list[dict[str, str]] | None = None
) -> bool:
    containers = ((app.get("properties") or {}).get("template") or {}).get("containers") or []
    if len(containers) != 1 or not isinstance(containers[0].get("env", []), list):
        raise RuntimeError("Connector runtime configuration is unavailable.")
    entries = containers[0].get("env", [])
    return reconcile_connector_environment(entries, expected) == entries


def require_connector_configuration(app: dict[str, Any], expected: list[dict[str, str]]) -> None:
    containers = ((app.get("properties") or {}).get("template") or {}).get("containers") or []
    if len(containers) != 1 or not isinstance(containers[0].get("env", []), list):
        raise RuntimeError("Connector runtime configuration is unavailable.")
    entries = containers[0].get("env", [])
    require_connector_environment(entries, expected)


def require_connector_environment(
    entries: list[dict[str, Any]], expected: list[dict[str, str]]
) -> None:
    """Prove observed public values against the immutable admitted receipt."""
    expected = validate_connector_environment(expected)
    if _reconciled(entries, expected) != entries:
        raise RuntimeError(
            "Connector public configuration was not installed; reconcile the update."
        )


def gcp_connector_environment(service: dict[str, Any]) -> list[dict[str, Any]]:
    return service["spec"]["template"]["spec"]["containers"][0].get("env", [])


def capture_gcp_connector_repair(
    service: dict[str, Any], operation_id: str | None
) -> tuple[list[dict[str, str]], bool]:
    """Capture public authority before an existing owner-approved update drains work."""
    expected = expected_connector_environment()
    entries = gcp_connector_environment(service)
    changed = reconcile_connector_environment(entries, expected) != entries
    if changed and not operation_id:
        raise RuntimeError("Connector configuration repair requires an approved upgrade handoff.")
    return expected, changed


def require_gcp_connector_configuration(
    service: dict[str, Any], expected: list[dict[str, str]]
) -> None:
    require_connector_environment(gcp_connector_environment(service), expected)


def preserve_connector_configuration(
    existing: list[dict[str, Any]],
    desired: list[dict[str, Any]],
    *,
    expected: list[dict[str, str]] | None = None,
) -> list[dict[str, Any]]:
    reconciled = (
        copy.deepcopy(existing)
        if expected is None
        else reconcile_connector_environment(existing, expected)
    )
    return [item for item in desired if item.get("name") not in _NAMES] + [
        item for item in reconciled if item.get("name") in _NAMES
    ]
