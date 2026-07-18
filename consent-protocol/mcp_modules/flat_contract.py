"""Flat MCP capability projection for constrained, authenticated hosts.

The standard public contract remains the v0.3 source of truth. This module
intentionally contains only shallow primitive schemas, so hosts with limited
JSON Schema planners can register the same consent lifecycle safely.
"""

from __future__ import annotations

from typing import Any

from jsonschema import Draft202012Validator

FLAT_PROFILE = "flat"
_CORE_TOOL_NAMES = (
    "search_user_scopes",
    "request_consent",
    "check_consent_status",
    "get_encrypted_scoped_export",
)


def _field(kind: str, description: str, **constraints: Any) -> dict[str, Any]:
    return {"type": kind, "description": description, **constraints}


def _object(properties: dict[str, dict[str, Any]], required: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "description": "A flat, capability-safe result object.",
        "additionalProperties": False,
        "properties": properties,
        "required": required,
    }


_IDENTIFIER_INPUT = _field(
    "string",
    "Registered email address, phone number, or Hussh account identifier. Hussh resolves it internally and never returns it.",
    minLength=1,
    maxLength=320,
)
_SCOPE_INPUT = _field(
    "string",
    "Least-privilege scope returned by search_user_scopes. Preserve the value exactly when requesting consent.",
    minLength=3,
    maxLength=200,
)
_PURPOSE_INPUT = _field(
    "string",
    "Plain-language purpose displayed to the user for this consent request.",
    minLength=8,
    maxLength=280,
)
_CONNECTOR_KEY_INPUT = _field(
    "string",
    "Optional legacy connector X25519 public key. When supplied, it must exactly match this app's registered key.",
    minLength=40,
    maxLength=128,
)
_CONNECTOR_KEY_ID_INPUT = _field(
    "string",
    "Optional legacy connector key identifier. When supplied, it must exactly match this app's registered key identifier.",
    minLength=1,
    maxLength=128,
)
_CONNECTOR_ALGORITHM_INPUT = _field(
    "string",
    "Optional legacy wrapping algorithm. When supplied, it must be X25519-AES256-GCM and match this app's registered key.",
    enum=["X25519-AES256-GCM"],
)


def get_flat_contract() -> dict[str, Any]:
    """Return the four core tools without unsupported schema constructs."""

    return {
        "tools": [
            {
                "name": "search_user_scopes",
                "description": "Finds consent scopes available for one registered user. Use this before request_consent to choose the narrowest scope. Returns only scope strings and pagination state.",
                "inputSchema": _object(
                    {
                        "user_identifier": _IDENTIFIER_INPUT,
                        "query": _field(
                            "string",
                            "Optional search text. Leave empty to list all scopes.",
                            maxLength=200,
                        ),
                        "domain": _field(
                            "string",
                            "Optional lower-case domain filter such as financial.",
                            maxLength=64,
                        ),
                        "cursor": _field(
                            "string",
                            "Optional cursor returned by the previous search_user_scopes call.",
                            maxLength=64,
                        ),
                        "limit": _field(
                            "integer",
                            "Maximum number of scopes to return, from 1 through 50.",
                            minimum=1,
                            maximum=50,
                        ),
                        "country_iso2": _field(
                            "string",
                            "Optional two-letter ISO country code used for phone resolution.",
                            minLength=2,
                            maxLength=2,
                        ),
                        "country": _field(
                            "string",
                            "Optional country name used for phone resolution when country_iso2 is absent.",
                            minLength=2,
                            maxLength=64,
                        ),
                    },
                    ["user_identifier"],
                ),
                "outputSchema": _object(
                    {
                        "status": _field(
                            "string", "Result status. A successful call returns success."
                        ),
                        "scope_values": _field(
                            "array",
                            "Available scope strings. Use one unchanged in request_consent.",
                            items=_field(
                                "string", "One least-privilege scope value.", maxLength=200
                            ),
                            maxItems=50,
                        ),
                        "next_cursor": _field(
                            "string",
                            "Cursor for the next page, or an empty string when no next page exists.",
                            maxLength=64,
                        ),
                        "has_more": _field(
                            "boolean", "True when another page of scopes is available."
                        ),
                    },
                    ["status", "scope_values", "next_cursor", "has_more"],
                ),
            },
            {
                "name": "request_consent",
                "description": "Creates or reuses a least-privilege consent request for one user. Use after search_user_scopes. The user must approve before encrypted retrieval is available.",
                "inputSchema": _object(
                    {
                        "user_identifier": _IDENTIFIER_INPUT,
                        "scope": _SCOPE_INPUT,
                        "purpose": _PURPOSE_INPUT,
                        "expiry_hours": _field(
                            "integer",
                            "How long an approved grant remains valid, from 24 through 2160 hours.",
                            minimum=24,
                            maximum=2160,
                        ),
                        "approval_timeout_minutes": _field(
                            "integer",
                            "How long Hussh waits for user approval, from 5 through 1440 minutes.",
                            minimum=5,
                            maximum=1440,
                        ),
                        "refresh_policy": _field(
                            "string",
                            "Use snapshot for one export or continuous_until_expiry for approved refreshes.",
                            enum=["snapshot", "continuous_until_expiry"],
                        ),
                        "connector_public_key": _CONNECTOR_KEY_INPUT,
                        "connector_key_id": _CONNECTOR_KEY_ID_INPUT,
                        "connector_wrapping_alg": _CONNECTOR_ALGORITHM_INPUT,
                        "country_iso2": _field(
                            "string",
                            "Optional two-letter ISO country code used for phone resolution.",
                            minLength=2,
                            maxLength=2,
                        ),
                        "country": _field(
                            "string",
                            "Optional country name used for phone resolution when country_iso2 is absent.",
                            minLength=2,
                            maxLength=64,
                        ),
                    },
                    ["user_identifier", "scope", "purpose"],
                ),
                "outputSchema": _object(
                    {
                        "status": _field(
                            "string", "Consent lifecycle state, for example pending or granted."
                        ),
                        "scope": _field(
                            "string", "Scope evaluated by this request.", maxLength=200
                        ),
                        "request_ref": _field(
                            "string",
                            "Opaque pending-request reference, or an empty string after approval.",
                            maxLength=64,
                        ),
                        "grant_ref": _field(
                            "string",
                            "Opaque approved-grant reference, or an empty string while pending.",
                            maxLength=64,
                        ),
                        "expires_at": _field(
                            "integer",
                            "Unix epoch milliseconds when the grant expires, or zero when unavailable.",
                            minimum=0,
                        ),
                        "poll_after_seconds": _field(
                            "integer",
                            "Minimum delay before polling check_consent_status, or zero when terminal.",
                            minimum=0,
                        ),
                        "approval_timeout_at": _field(
                            "integer",
                            "Unix epoch milliseconds when approval polling should stop, or zero when unavailable.",
                            minimum=0,
                        ),
                        "coverage_kind": _field(
                            "string",
                            "Coverage relationship between requested and granted scope, or an empty string when pending.",
                            maxLength=64,
                        ),
                    },
                    [
                        "status",
                        "scope",
                        "request_ref",
                        "grant_ref",
                        "expires_at",
                        "poll_after_seconds",
                        "approval_timeout_at",
                        "coverage_kind",
                    ],
                ),
            },
            {
                "name": "check_consent_status",
                "description": "Checks one consent request previously returned by request_consent. Poll no faster than poll_after_seconds and stop at a terminal state.",
                "inputSchema": _object(
                    {
                        "request_ref": _field(
                            "string",
                            "Opaque request reference returned by request_consent.",
                            minLength=1,
                            maxLength=64,
                        )
                    },
                    ["request_ref"],
                ),
                "outputSchema": _object(
                    {
                        "status": _field("string", "Current consent lifecycle state."),
                        "grant_ref": _field(
                            "string",
                            "Opaque approved-grant reference, or an empty string until granted.",
                            maxLength=64,
                        ),
                        "expires_at": _field(
                            "integer",
                            "Unix epoch milliseconds when the grant expires, or zero when unavailable.",
                            minimum=0,
                        ),
                        "poll_after_seconds": _field(
                            "integer",
                            "Minimum delay before another status check, or zero when terminal.",
                            minimum=0,
                        ),
                        "approval_timeout_at": _field(
                            "integer",
                            "Unix epoch milliseconds when polling should stop, or zero when unavailable.",
                            minimum=0,
                        ),
                    },
                    [
                        "status",
                        "grant_ref",
                        "expires_at",
                        "poll_after_seconds",
                        "approval_timeout_at",
                    ],
                ),
            },
            {
                "name": "get_encrypted_scoped_export",
                "description": "Retrieves ciphertext for an approved grant. Use only after check_consent_status returns a grant_ref. Decrypt outside the LLM with the partner-owned private key.",
                "inputSchema": _object(
                    {
                        "grant_ref": _field(
                            "string",
                            "Opaque approved-grant reference returned by request_consent or check_consent_status.",
                            minLength=1,
                            maxLength=64,
                        ),
                        "expected_scope": _SCOPE_INPUT,
                    },
                    ["grant_ref", "expected_scope"],
                ),
                "outputSchema": _object(
                    {
                        "status": _field(
                            "string", "Result status. A successful call returns success."
                        ),
                        "delivery": _field(
                            "string",
                            "Delivery mode. Flat-profile exports are always encrypted_inline.",
                        ),
                        "expected_scope": _field(
                            "string", "Scope requested for this export.", maxLength=200
                        ),
                        "granted_scope": _field(
                            "string",
                            "Approved scope that covers the requested scope.",
                            maxLength=200,
                        ),
                        "expires_at": _field(
                            "integer",
                            "Unix epoch milliseconds when the grant expires, or zero when unavailable.",
                            minimum=0,
                        ),
                        "export_revision": _field(
                            "integer",
                            "Positive revision number of this encrypted export.",
                            minimum=1,
                        ),
                        "ciphertext": _field(
                            "string",
                            "Base64 ciphertext. Never treat it as plaintext or model context.",
                            minLength=1,
                        ),
                        "payload_iv": _field(
                            "string",
                            "Base64 initialization vector for the ciphertext payload.",
                            minLength=1,
                            maxLength=512,
                        ),
                        "payload_tag": _field(
                            "string",
                            "Base64 authentication tag for the ciphertext payload.",
                            minLength=1,
                            maxLength=512,
                        ),
                        "wrapped_export_key": _field(
                            "string",
                            "Base64 wrapped symmetric export key.",
                            minLength=1,
                            maxLength=2048,
                        ),
                        "wrapped_key_iv": _field(
                            "string",
                            "Base64 initialization vector for wrapped_export_key.",
                            minLength=1,
                            maxLength=512,
                        ),
                        "wrapped_key_tag": _field(
                            "string",
                            "Base64 authentication tag for wrapped_export_key.",
                            minLength=1,
                            maxLength=512,
                        ),
                        "sender_public_key": _field(
                            "string",
                            "Base64 ephemeral X25519 public key used for key agreement.",
                            minLength=1,
                            maxLength=512,
                        ),
                        "connector_key_id": _field(
                            "string",
                            "Registered partner key identifier that must select the matching private key.",
                            minLength=1,
                            maxLength=128,
                        ),
                        "wrapping_alg": _field(
                            "string",
                            "Key-wrapping algorithm. Always X25519-AES256-GCM.",
                            enum=["X25519-AES256-GCM"],
                        ),
                        "export_envelope_json": _field(
                            "string",
                            "Canonical JSON envelope for partner-side integrity validation and decryption.",
                            minLength=2,
                            maxLength=20000,
                        ),
                    },
                    [
                        "status",
                        "delivery",
                        "expected_scope",
                        "granted_scope",
                        "expires_at",
                        "export_revision",
                        "ciphertext",
                        "payload_iv",
                        "payload_tag",
                        "wrapped_export_key",
                        "wrapped_key_iv",
                        "wrapped_key_tag",
                        "sender_public_key",
                        "connector_key_id",
                        "wrapping_alg",
                        "export_envelope_json",
                    ],
                ),
            },
        ]
    }


def get_flat_tool_names() -> tuple[str, ...]:
    return _CORE_TOOL_NAMES


def _validators() -> dict[str, tuple[Draft202012Validator, Draft202012Validator]]:
    return {
        str(tool["name"]): (
            Draft202012Validator(tool["inputSchema"]),
            Draft202012Validator(tool["outputSchema"]),
        )
        for tool in get_flat_contract()["tools"]
    }


def validate_flat_input(name: str, payload: object) -> bool:
    validator = _validators().get(name)
    return bool(validator) and not any(validator[0].iter_errors(payload))


def validate_flat_output(name: str, payload: object) -> bool:
    validator = _validators().get(name)
    return bool(validator) and not any(validator[1].iter_errors(payload))
