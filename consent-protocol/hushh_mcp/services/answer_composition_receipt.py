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
    processing_runtime: Mapping[str, Any] | None = None,
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
    version = "v1"
    if processing_runtime is not None:
        version = "v2"
        claims.update(
            model=processing_runtime["model"],
            processing_runtime=dict(processing_runtime),
            provenance="hub_execution",
            runtime_binding=None,
            selection_revision=None,
            runtime_mode="hushh_managed",
        )
    segment = _encode(json.dumps(claims, sort_keys=True, separators=(",", ":")).encode())
    return f"{version}.{segment}.{_signature(segment)}"


def verify_composition_receipt(
    receipt: object,
    *,
    request_id: str,
    owner_user_id: str,
    terms_digest: str,
    require_fresh: bool = True,
    runtime_binding: Mapping[str, Any] | None = None,
    processing_runtime: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Verify signed metadata and exact authority; initial staging also checks time."""
    try:
        if not isinstance(receipt, str) or len(receipt) > MAX_RECEIPT_CHARS:
            raise ValueError
        version, segment, signature = receipt.split(".")
        if version not in {"v1", "v2"} or not hmac.compare_digest(signature, _signature(segment)):
            raise ValueError
        claims = json.loads(base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4)))
        fields = {
            "request",
            "owner",
            "terms",
            "model",
            "issued",
            "expires",
            "answer_digest",
            "input_digest",
        }
        if version == "v2":
            fields |= {
                "provenance",
                "runtime_binding",
                "selection_revision",
                "runtime_mode",
                "processing_runtime",
            }
        if not isinstance(claims, dict) or set(claims) != fields:
            raise ValueError
        if version == "v2":
            from hushh_mcp.services.answer_composition_contract import (
                ProcessingRuntime,
                RuntimeBinding,
            )

            runtime = ProcessingRuntime.model_validate(claims["processing_runtime"]).model_dump()
            if claims["model"] != runtime["model"] or (
                require_fresh and runtime != processing_runtime
            ):
                raise ValueError
            if claims["provenance"] == "owner_pod_assertion":
                RuntimeBinding.model_validate(claims["runtime_binding"])
                if (
                    runtime["mode"] != "private"
                    or type(claims["selection_revision"]) is not int
                    or claims["selection_revision"] < 0
                    or claims["runtime_mode"]
                    not in {"byok", "user_adc", "hosted_pod_adc", "user_azure_mi"}
                    or (require_fresh and claims["runtime_binding"] != runtime_binding)
                ):
                    raise ValueError
            elif claims["provenance"] == "hub_execution":
                if (
                    runtime["mode"] != "shared"
                    or claims["runtime_binding"] is not None
                    or claims["selection_revision"] is not None
                    or claims["runtime_mode"] != "hushh_managed"
                ):
                    raise ValueError
            else:
                raise ValueError
        elif require_fresh and processing_runtime is not None:
            raise ValueError
        if (claims["request"], claims["owner"], claims["terms"]) != (
            request_id,
            owner_user_id,
            terms_digest,
        ):
            raise ValueError
        if not isinstance(claims["model"], str) or (
            version == "v1" and not claims["model"].startswith("gemini-")
        ):
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
            or (version == "v1" and claims["model"] != composition_model())
        ):
            raise ValueError
        return claims
    except (ValueError, TypeError, UnicodeError, KeyError):
        raise CompositionReceiptError("composition_receipt_required") from None


def issue_private_authority(
    *, work: Mapping[str, Any], binding: Mapping[str, Any], nonce: str
) -> str:
    """Short-lived metadata authority, carried only inside the sealed owner feed."""
    claims = {
        "request": work["requestId"],
        "owner": binding["owner"],
        "terms": work["termsDigest"],
        "runtime": work["processingRuntime"],
        "binding": dict(binding),
        "nonce": nonce,
        "expires": int(time.time()) + 90,
    }
    segment = _encode(json.dumps(claims, sort_keys=True, separators=(",", ":")).encode())
    return f"pa1.{segment}.{_signature('private-authority:' + segment)}"


def verify_private_authority(
    token: object, *, work: Mapping[str, Any], binding: Mapping[str, Any]
) -> None:
    try:
        if not isinstance(token, str) or len(token) > 4096:
            raise ValueError
        version, segment, signature = token.split(".")
        if version != "pa1" or not hmac.compare_digest(
            signature, _signature("private-authority:" + segment)
        ):
            raise ValueError
        claims = json.loads(base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4)))
        if set(claims) != {
            "request",
            "owner",
            "terms",
            "runtime",
            "binding",
            "nonce",
            "expires",
        } or (
            claims["request"],
            claims["owner"],
            claims["terms"],
            claims["runtime"],
            claims["binding"],
        ) != (
            work["requestId"],
            binding["owner"],
            work["termsDigest"],
            work["processingRuntime"],
            dict(binding),
        ):
            raise ValueError
        if (
            type(claims["expires"]) is not int
            or not int(time.time()) < claims["expires"] <= int(time.time()) + 90
        ):
            raise ValueError
    except (ValueError, TypeError, KeyError, UnicodeError):
        raise CompositionReceiptError("private_composition_authority_required") from None


def issue_private_composition_receipt(
    *,
    work: Mapping[str, Any],
    binding: Mapping[str, Any],
    processing_runtime: Mapping[str, Any],
    selection_revision: int,
    runtime_mode: str,
    answer_digest: str,
    input_digest: str,
) -> str:
    """Authenticate a current owner-pod assertion; never claim hub-observed inference.

    The pod blinds its commitments with a process-only key. Neither answer nor
    projection nor the blinding key is sent to this receipt issuer.
    """
    if (
        processing_runtime != work.get("processingRuntime")
        or processing_runtime.get("mode") != "private"
    ):
        raise CompositionReceiptError("private_composition_authority_required")
    now = int(time.time())
    claims = {
        "request": work["requestId"],
        "owner": binding["owner"],
        "terms": work["termsDigest"],
        "model": processing_runtime["model"],
        "processing_runtime": dict(processing_runtime),
        "issued": now,
        "expires": now + RECEIPT_TTL_SECONDS,
        "answer_digest": answer_digest,
        "input_digest": input_digest,
        "provenance": "owner_pod_assertion",
        "runtime_binding": dict(binding),
        "selection_revision": selection_revision,
        "runtime_mode": runtime_mode,
    }
    segment = _encode(json.dumps(claims, sort_keys=True, separators=(",", ":")).encode())
    receipt = f"v2.{segment}.{_signature(segment)}"
    verify_composition_receipt(
        receipt,
        request_id=work["requestId"],
        owner_user_id=binding["owner"],
        terms_digest=work["termsDigest"],
        runtime_binding=binding,
        processing_runtime=processing_runtime,
    )
    return receipt


__all__ = [
    "COMPOSITION_RECEIPT_KEY",
    "COMPOSITION_TERMS_KEY",
    "CompositionReceiptError",
    "issue_composition_receipt",
    "verify_composition_receipt",
]
