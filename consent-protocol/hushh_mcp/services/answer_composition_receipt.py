"""Request-bound proof of a successful Gemini call, without answer persistence.

The receipt proves that the gated composer returned a nonempty answer for the
approved terms. It cannot prove that client-encrypted ciphertext contains that
answer: the backend has no recipient key and must not gain one for this check.
Answer and input digests are keyed, so low-entropy names/ages cannot be guessed
from persisted metadata. Expiry bounds initial staging, not later purchase of
an already verified and immutable staged envelope.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any, Mapping

from hushh_mcp.runtime_settings import get_core_security_settings

COMPOSITION_RECEIPT_KEY = "_composition_receipt"
COMPOSITION_TERMS_KEY = "_composition_terms"
RECEIPT_TTL_SECONDS = 600
MAX_RECEIPT_CHARS = 2400
_CONTEXT = b"pkm-answer-gemini-composition-v1"


class CompositionReceiptError(ValueError):
    """Safe error code; never contains source data or the receipt."""


def composition_model() -> str:
    # Resolve the same fleet alias used by the single-turn writer factory.
    from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name

    return resolve_fleet_model_name("gemini-default")


def _key() -> bytes:
    return hmac.new(
        get_core_security_settings().app_signing_key.encode(), _CONTEXT, hashlib.sha256
    ).digest()


def _encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _signature(segment: str) -> str:
    return _encode(hmac.new(_key(), segment.encode("ascii"), hashlib.sha256).digest())


def issue_composition_receipt(
    *,
    request_id: str,
    owner_user_id: str,
    terms_digest: str,
    answer: str,
    projection: Mapping[str, Any],
    period: Mapping[str, str] | None = None,
) -> str:
    """Called only after successful consent-gated composition, never as fallback."""
    if not answer.strip() or not request_id or not owner_user_id or not terms_digest:
        raise CompositionReceiptError("composition_receipt_invalid")
    now = int(time.time())
    claims = {
        "request": request_id,
        "owner": owner_user_id,
        "terms": terms_digest,
        "model": composition_model(),
        "issued": now,
        "expires": now + RECEIPT_TTL_SECONDS,
        "answer_digest": hmac.new(_key(), b"answer:" + answer.encode(), hashlib.sha256).hexdigest(),
        "input_digest": hmac.new(
            _key(),
            b"input:"
            + json.dumps(
                {"projection": projection, "period": period},
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
            ).encode(),
            hashlib.sha256,
        ).hexdigest(),
    }
    segment = _encode(json.dumps(claims, sort_keys=True, separators=(",", ":")).encode())
    return f"v1.{segment}.{_signature(segment)}"


def verify_composition_receipt(
    receipt: object,
    *,
    request_id: str,
    owner_user_id: str,
    terms_digest: str,
    require_fresh: bool = True,
) -> dict[str, Any]:
    """Verify signed metadata and exact authority; initial staging also checks time."""
    try:
        if not isinstance(receipt, str) or len(receipt) > MAX_RECEIPT_CHARS:
            raise ValueError
        version, segment, signature = receipt.split(".")
        if version != "v1" or not hmac.compare_digest(signature, _signature(segment)):
            raise ValueError
        claims = json.loads(base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4)))
        if not isinstance(claims, dict) or set(claims) != {
            "request",
            "owner",
            "terms",
            "model",
            "issued",
            "expires",
            "answer_digest",
            "input_digest",
        }:
            raise ValueError
        if (claims["request"], claims["owner"], claims["terms"]) != (
            request_id,
            owner_user_id,
            terms_digest,
        ):
            raise ValueError
        if not isinstance(claims["model"], str) or not claims["model"].startswith("gemini-"):
            raise ValueError
        if any(
            not isinstance(claims[key], str)
            or len(claims[key]) != 64
            or any(c not in "0123456789abcdef" for c in claims[key])
            for key in ("answer_digest", "input_digest")
        ):
            raise ValueError
        if any(type(claims[key]) is not int for key in ("issued", "expires")):
            raise ValueError
        if claims["expires"] != claims["issued"] + RECEIPT_TTL_SECONDS:
            raise ValueError
        if require_fresh and (
            claims["issued"] > int(time.time()) + 30
            or claims["expires"] <= int(time.time())
            or claims["model"] != composition_model()
        ):
            raise ValueError
        return claims
    except (ValueError, TypeError, UnicodeError, KeyError):
        raise CompositionReceiptError("composition_receipt_required") from None


__all__ = [
    "COMPOSITION_RECEIPT_KEY",
    "COMPOSITION_TERMS_KEY",
    "CompositionReceiptError",
    "issue_composition_receipt",
    "verify_composition_receipt",
]
