"""Canonical public MCP contract with shallow, host-safe schemas.

The five tools in this module are the one public Hussh Consent MCP surface.
Every hosted client receives the same semantic tools and field shapes; the
server only changes transport delivery where a trusted local stdio process can
decrypt an export on the connector machine.
"""

from __future__ import annotations

from typing import Any

from jsonschema import Draft202012Validator

from hushh_mcp.consent.connector_crypto_profiles import (
    available_connector_wrapping_algorithms,
)

FLAT_PROFILE = "flat"
LOCAL_INFORMATION_JSON_MAX_CHARS = 120_000
_CORE_TOOL_NAMES = (
    "search_user_scopes",
    "prepare_campaign_context",
    "request_consent",
    "check_consent_status",
    "get_encrypted_scoped_export",
)

_FIELD_TITLES = {
    "approval_timeout_at": "Approval timeout time",
    "approval_timeout_minutes": "Approval timeout minutes",
    "approval_required": "Approval required",
    "campaign_goal": "Offer goal",
    "ciphertext": "Encrypted ciphertext",
    "connector_key_id": "Connector key identifier",
    "connector_public_key": "Connector public key",
    "connector_wrapping_alg": "Connector wrapping algorithm",
    "country": "Country name",
    "country_iso2": "Country ISO 3166-1 alpha-2 code",
    "coverage_kind": "Scope coverage kind",
    "cursor": "Pagination cursor",
    "delivery": "Delivery mode",
    "domain": "Scope domain",
    "expected_scope": "Expected scope",
    "expires_at": "Expiry time",
    "export_envelope_json": "Encrypted export envelope JSON",
    "export_revision": "Export revision",
    "export_metadata_ready": "Export metadata ready",
    "fetch_export_metadata": "Fetch export metadata",
    "grant_ref": "Consent grant reference",
    "granted_scope": "Granted scope",
    "has_more": "More results available",
    "information_json": "Locally decrypted information JSON",
    "limit": "Result limit",
    "next_cursor": "Next-page cursor",
    "payload_iv": "Payload initialization vector",
    "payload_tag": "Payload authentication tag",
    "poll_after_seconds": "Polling delay seconds",
    "poll_seconds": "Offer polling window seconds",
    "preferred_context": "Preferred context",
    "purpose": "Consent purpose",
    "query": "Scope search text",
    "refresh_policy": "Grant refresh policy",
    "request_ref": "Consent request reference",
    "scope": "Consent scope",
    "scope_values": "Available consent scopes",
    "sender_public_key": "Sender public key",
    "selected_scope": "Selected consent scope",
    "selected_scope_label": "Selected scope label",
    "settlement_ref": "Settlement reference",
    "status": "Lifecycle status",
    "surface": "Experience surface",
    "user_identifier": "User identifier",
    "wrapped_export_key": "Wrapped export key",
    "wrapped_key_iv": "Wrapped-key initialization vector",
    "wrapped_key_tag": "Wrapped-key authentication tag",
    "wrapping_alg": "Key wrapping algorithm",
    "offer_amount": "Offer amount",
    "offer_currency": "Offer currency",
    "offer_summary": "Offer summary",
    "offer_status": "Offer status",
}


def _field_title(name: str) -> str:
    return _FIELD_TITLES.get(name, name.replace("_", " ").capitalize())


def _field(kind: str, description: str, **constraints: Any) -> dict[str, Any]:
    return {"type": kind, "description": description, **constraints}


def _object(properties: dict[str, dict[str, Any]], required: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "description": "A flat, capability-safe field set.",
        "additionalProperties": False,
        "properties": {
            name: {"title": _field_title(name), **schema} for name, schema in properties.items()
        },
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
    "Least-privilege scope returned by search-user-scopes. Preserve the value exactly when requesting consent.",
    minLength=3,
    maxLength=200,
    pattern=r"^attr(?:\.[a-z][a-z0-9_]{0,63})+\.\*$",
)
_PURPOSE_INPUT = _field(
    "string",
    "Plain-language purpose displayed to the user for this consent request.",
    minLength=8,
    maxLength=280,
)
_CONNECTOR_KEY_INPUT = _field(
    "string",
    "Optional connector X25519 public key. An unregistered connector supplies the complete key bundle per request; a registered app may omit it or must supply the exact registered value.",
    minLength=40,
    maxLength=128,
)
_CONNECTOR_KEY_ID_INPUT = _field(
    "string",
    "Optional connector key identifier. Supply it with the public key and wrapping algorithm for an unregistered connector; a registered app may omit it or must supply the exact registered value.",
    minLength=1,
    maxLength=128,
)
_CONNECTOR_ALGORITHM_INPUT = _field(
    "string",
    "Optional wrapping algorithm. It must be X25519-AES256-GCM and is supplied with an unregistered connector key bundle; a registered app may omit it or must supply the exact registered value.",
    enum=list(available_connector_wrapping_algorithms()),
)


def get_flat_contract() -> dict[str, Any]:
    """Return the canonical five-tool public contract."""

    return {
        "tools": [
            {
                "name": "search_user_scopes",
                "title": "Search user scopes",
                "description": "Finds consent scopes available for one registered user. Use this before request-consent to choose the narrowest scope. Returns only scope strings and pagination state.",
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
                            "Optional cursor returned by the previous search-user-scopes call.",
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
                            "Available scope strings. Use one unchanged in request-consent.",
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
                "name": "prepare_campaign_context",
                "title": "Prepare consent-backed offer context",
                "description": "Prepares a least-privilege consent-backed offer or experience context for one user. It selects an available scope, creates or reuses consent, and returns safe lifecycle state for an agent or frontend.",
                "inputSchema": _object(
                    {
                        "user_identifier": _IDENTIFIER_INPUT,
                        "campaign_goal": _field(
                            "string",
                            "Plain-language goal for the offer or experience.",
                            minLength=8,
                            maxLength=500,
                        ),
                        "purpose": _PURPOSE_INPUT,
                        "surface": _field(
                            "string",
                            "Optional experience surface using this context.",
                            maxLength=80,
                        ),
                        "preferred_context": _field(
                            "string",
                            "Optional scope preference. Use auto to let Hussh select the least-privilege match.",
                            maxLength=256,
                        ),
                        "expiry_hours": _field(
                            "integer",
                            "How long an approved grant remains valid, from 24 through 2160 hours.",
                            minimum=24,
                            maximum=2160,
                        ),
                        "approval_timeout_minutes": _field(
                            "integer",
                            "How long Hussh waits for approval, from 5 through 1440 minutes.",
                            minimum=5,
                            maximum=1440,
                        ),
                        "refresh_policy": _field(
                            "string",
                            "Use snapshot for one export or continuous_until_expiry for approved refreshes.",
                            enum=["snapshot", "continuous_until_expiry"],
                        ),
                        "poll_seconds": _field(
                            "integer",
                            "Optional bounded in-call wait for lifecycle state, from 0 through 90 seconds.",
                            minimum=0,
                            maximum=90,
                        ),
                        "fetch_export_metadata": _field(
                            "boolean",
                            "Whether to report encrypted-export readiness after an already granted request.",
                        ),
                        "offer_amount": _field(
                            "number",
                            "Optional amount offered for the approved consent. This records an offer; it does not settle payment.",
                            exclusiveMinimum=0,
                            maximum=1000000,
                        ),
                        "offer_currency": _field(
                            "string",
                            "Optional ISO 4217 offer currency such as USD.",
                            minLength=3,
                            maxLength=3,
                        ),
                        "offer_summary": _field(
                            "string", "Optional user-facing summary of the offer.", maxLength=500
                        ),
                        "settlement_ref": _field(
                            "string",
                            "Optional opaque settlement reference owned by the caller.",
                            maxLength=128,
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
                        "status": _field("string", "Consent lifecycle state."),
                        "selected_scope": _field(
                            "string",
                            "Least-privilege scope selected for this offer or context.",
                            maxLength=200,
                        ),
                        "selected_scope_label": _field(
                            "string", "User-facing label for the selected scope.", maxLength=120
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
                        "approval_required": _field(
                            "boolean", "True when the person must still review the consent request."
                        ),
                        "poll_after_seconds": _field(
                            "integer",
                            "Minimum delay before another status check, or zero when terminal.",
                            minimum=0,
                        ),
                        "expires_at": _field(
                            "integer",
                            "Unix epoch milliseconds when the grant expires, or zero when unavailable.",
                            minimum=0,
                        ),
                        "approval_timeout_at": _field(
                            "integer",
                            "Unix epoch milliseconds when approval polling should stop, or zero when unavailable.",
                            minimum=0,
                        ),
                        "export_metadata_ready": _field(
                            "boolean",
                            "True when an approved encrypted export is ready for connector-side retrieval.",
                        ),
                        "export_revision": _field(
                            "integer",
                            "Encrypted export revision, or zero when not ready.",
                            minimum=0,
                        ),
                        "offer_amount": _field(
                            "number",
                            "Recorded offer amount, or zero when no offer was supplied.",
                            minimum=0,
                        ),
                        "offer_currency": _field(
                            "string",
                            "Recorded offer currency, or an empty string when no offer was supplied.",
                            maxLength=3,
                        ),
                        "offer_summary": _field(
                            "string",
                            "Recorded offer summary, or an empty string when no offer was supplied.",
                            maxLength=500,
                        ),
                        "settlement_ref": _field(
                            "string",
                            "Caller settlement reference, or an empty string when none was supplied.",
                            maxLength=128,
                        ),
                        "offer_status": _field(
                            "string",
                            "Offer state. An approved consent remains pending user clearance for settlement.",
                            maxLength=64,
                        ),
                    },
                    [
                        "status",
                        "selected_scope",
                        "selected_scope_label",
                        "request_ref",
                        "grant_ref",
                        "approval_required",
                        "poll_after_seconds",
                        "expires_at",
                        "approval_timeout_at",
                        "export_metadata_ready",
                        "export_revision",
                        "offer_amount",
                        "offer_currency",
                        "offer_summary",
                        "settlement_ref",
                        "offer_status",
                    ],
                ),
            },
            {
                "name": "request_consent",
                "title": "Request consent",
                "description": "Creates or reuses a least-privilege consent request for one user. Use after search-user-scopes. The user must approve before encrypted retrieval is available.",
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
                        "offer_amount": _field(
                            "number",
                            "Optional amount offered for the approved consent. This records an offer; it does not settle payment.",
                            exclusiveMinimum=0,
                            maximum=1000000,
                        ),
                        "offer_currency": _field(
                            "string",
                            "Optional ISO 4217 offer currency such as USD.",
                            minLength=3,
                            maxLength=3,
                        ),
                        "offer_summary": _field(
                            "string", "Optional user-facing summary of the offer.", maxLength=500
                        ),
                        "settlement_ref": _field(
                            "string",
                            "Optional opaque settlement reference owned by the caller.",
                            maxLength=128,
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
                            "Minimum delay before polling check-consent-status, or zero when terminal.",
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
                        "offer_amount": _field(
                            "number",
                            "Recorded offer amount, or zero when no offer was supplied.",
                            minimum=0,
                        ),
                        "offer_currency": _field(
                            "string",
                            "Recorded offer currency, or an empty string when no offer was supplied.",
                            maxLength=3,
                        ),
                        "offer_summary": _field(
                            "string",
                            "Recorded offer summary, or an empty string when no offer was supplied.",
                            maxLength=500,
                        ),
                        "settlement_ref": _field(
                            "string",
                            "Caller settlement reference, or an empty string when none was supplied.",
                            maxLength=128,
                        ),
                        "offer_status": _field(
                            "string",
                            "Offer state, or an empty string when no offer was supplied.",
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
                        "offer_amount",
                        "offer_currency",
                        "offer_summary",
                        "settlement_ref",
                        "offer_status",
                    ],
                ),
            },
            {
                "name": "check_consent_status",
                "title": "Check consent status",
                "description": "Checks one consent request previously returned by request-consent. Poll no faster than poll_after_seconds and stop at a terminal state.",
                "inputSchema": _object(
                    {
                        "request_ref": _field(
                            "string",
                            "Opaque request reference returned by request-consent.",
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
                "title": "Get encrypted scoped export",
                "description": "Secure connector delivery only: retrieves ciphertext for an approved grant. Use only after check-consent-status returns a grant_ref. Never display, interpret, or decrypt this result in an LLM; the registered connector decrypts it outside the model.",
                "inputSchema": _object(
                    {
                        "grant_ref": _field(
                            "string",
                            "Opaque approved-grant reference returned by request-consent or check-consent-status.",
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
                            "Delivery mode. Trusted hosted connectors receive encrypted_inline; trusted local stdio may receive decrypted_local. Decrypt outside every language-model context.",
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
                        ),
                        "payload_iv": _field(
                            "string",
                            "Base64 initialization vector for the ciphertext payload.",
                            maxLength=512,
                        ),
                        "payload_tag": _field(
                            "string",
                            "Base64 authentication tag for the ciphertext payload.",
                            maxLength=512,
                        ),
                        "wrapped_export_key": _field(
                            "string",
                            "Base64 wrapped symmetric export key.",
                            maxLength=2048,
                        ),
                        "wrapped_key_iv": _field(
                            "string",
                            "Base64 initialization vector for wrapped_export_key.",
                            maxLength=512,
                        ),
                        "wrapped_key_tag": _field(
                            "string",
                            "Base64 authentication tag for wrapped_export_key.",
                            maxLength=512,
                        ),
                        "sender_public_key": _field(
                            "string",
                            "Base64 ephemeral X25519 public key used for key agreement.",
                            maxLength=512,
                        ),
                        "connector_key_id": _field(
                            "string",
                            "Registered partner key identifier that must select the matching private key.",
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
                            maxLength=20000,
                        ),
                        "information_json": _field(
                            "string",
                            "Reserved for a trusted local stdio connector. Hosted responses, including MuleSoft and Agentforce relays, always return an empty string.",
                            maxLength=LOCAL_INFORMATION_JSON_MAX_CHARS,
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
                        "information_json",
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
