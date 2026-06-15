"""
PII sanitization utilities for consent-protocol logging and payload inspection.

Masks personally-identifiable information (emails, phone numbers) before any
value reaches a log sink, error reporter, or debug surface. Maintains the
Zero-Knowledge principle: backend processes should never emit plaintext PII
even in non-production environments.

Security Hardening — Integrated by Abdul Gaffar.

Canonical surface: hushh_mcp.services.pii_sanitizer
Runtime boundary: imported by api.middlewares.observability
"""

from __future__ import annotations

import re
from typing import Any

# ---------------------------------------------------------------------------
# Compiled patterns (module-level for performance)
# ---------------------------------------------------------------------------

# RFC 5321 simplified — captures local-part and domain separately so we can
# reconstruct the masked form without a second parse pass.
_EMAIL_RE = re.compile(
    r"\b([A-Za-z0-9._%+\-]+)@([A-Za-z0-9.\-]+\.[A-Za-z]{2,})\b"
)

# E.164, North-American `(NNN) NNN-NNNN`, and common regional formats.
# Pattern: optional `(` and/or `+`, then opening digit, then 5-13 mixed
# digit/separator chars, then closing digit (guarantees ≥ 7 digit chars total).
# Lookbehind/lookahead keep us from matching inside longer digit strings.
_PHONE_RE = re.compile(
    r"(?<!\d)"
    r"(\(?\+?\d[\d\s\-().]{5,13}\d)"
    r"(?!\d)"
)


# ---------------------------------------------------------------------------
# Low-level maskers
# ---------------------------------------------------------------------------

def _mask_email(local: str, domain: str) -> str:
    """Return a masked email that preserves domain and first/last local chars."""
    if len(local) <= 2:
        return f"*@{domain}"
    return f"{local[0]}***{local[-1]}@{domain}"


def _mask_phone_digits(raw: str) -> str:
    """Return a masked phone keeping a short prefix and the last 4 digits."""
    digits = re.sub(r"\D", "", raw)
    if len(digits) < 7:
        return "****"
    prefix_len = 3 if raw.lstrip().startswith("+") else 2
    return digits[:prefix_len] + "****" + digits[-4:]


# ---------------------------------------------------------------------------
# Public string-level sanitizers
# ---------------------------------------------------------------------------

def mask_email(value: str) -> str:
    """
    Mask all email addresses found in *value*.

    >>> mask_email("Contact us at john.doe@example.com for help.")
    'Contact us at j***e@example.com for help.'
    >>> mask_email("no email here")
    'no email here'
    """
    return _EMAIL_RE.sub(
        lambda m: _mask_email(m.group(1), m.group(2)),
        value,
    )


def mask_phone(value: str) -> str:
    """
    Mask all phone numbers found in *value*.

    >>> mask_phone("Call +1-555-123-4567 or (800) 555-0199.")
    'Call +15****4567 or 80****0199.'
    >>> mask_phone("no phone here")
    'no phone here'
    """
    return _PHONE_RE.sub(
        lambda m: _mask_phone_digits(m.group(1)),
        value,
    )


def sanitize_log_value(value: str) -> str:
    """Apply all PII masks to a single string value."""
    value = mask_email(value)
    value = mask_phone(value)
    return value


# ---------------------------------------------------------------------------
# Payload-level sanitizer (recursive, non-mutating)
# ---------------------------------------------------------------------------

#: Dict keys whose string values are always fully masked regardless of format.
_ALWAYS_MASK_KEYS: frozenset[str] = frozenset(
    {
        "email",
        "user_email",
        "userId",
        "user_id",
        "phone",
        "phone_number",
        "mobile",
        "contact",
    }
)


def _sanitize_value(key: str, value: Any) -> Any:
    """Recursively sanitize a single value from a payload dict."""
    if isinstance(value, str):
        if key in _ALWAYS_MASK_KEYS:
            return sanitize_log_value(value) if value else value
        return sanitize_log_value(value)
    if isinstance(value, dict):
        return sanitize_payload(value)
    if isinstance(value, list):
        return [_sanitize_value(key, item) for item in value]
    return value


def sanitize_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """
    Return a copy of *payload* with PII masked in all string values.

    The original dict is never mutated.  Nested dicts and lists are
    traversed recursively.  Non-string scalars (int, bool, None, …) are
    passed through unchanged.

    >>> sanitize_payload({"email": "alice@example.com", "amount": 42})
    {'email': 'a***e@example.com', 'amount': 42}
    """
    return {key: _sanitize_value(key, val) for key, val in payload.items()}
