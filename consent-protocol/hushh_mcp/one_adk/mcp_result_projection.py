"""Bounded MCP result projection; no invocation or consent authority."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, cast

from mcp.types import CallToolResult

from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult, _normalize_and_cap


def _credential_values(headers: dict[str, str]) -> list[str]:
    values = []
    for value in headers.values():
        values.append(value)
        scheme, _, credential = value.partition(" ")
        if credential and scheme.isalpha():
            values.append(credential.strip())
    # Very short values would redact ordinary words; credentials are longer.
    return sorted({value for value in values if len(value) >= 8}, key=len, reverse=True)


def _redact_credentials(value: Any, secrets: list[str]) -> Any:
    """Best effort against a server echoing the credential it received verbatim.

    It cannot stop a hostile server (encoded, split or re-cased echoes, or
    values under 8 characters); that server already holds the credential.
    """
    if not secrets:
        return value
    if isinstance(value, str):
        for secret in secrets:
            value = value.replace(secret, "[redacted]")
        return value
    if isinstance(value, list):
        return [_redact_credentials(item, secrets) for item in value]
    if isinstance(value, dict):
        return {
            _redact_credentials(key, secrets): _redact_credentials(item, secrets)
            for key, item in value.items()
        }
    return value


def project_mcp_result(
    result: Any,
    headers: dict[str, str],
    tool_name: str,
    result_policy: Callable[[str, dict[str, Any]], dict[str, Any]] | None,
) -> ExternalMcpToolResult:
    secrets = _credential_values(headers)

    def projection(payload: dict[str, Any]) -> dict[str, Any]:
        if result_policy is not None:
            payload = result_policy(tool_name, payload)
        # Before serialization and capping, so a cut cannot split a secret.
        return cast(dict[str, Any], _redact_credentials(payload, secrets))

    return _normalize_and_cap(CallToolResult.model_validate(result), project=projection)
