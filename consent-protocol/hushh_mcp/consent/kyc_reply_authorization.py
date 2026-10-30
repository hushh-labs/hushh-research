"""The capability that lets a typed KYC reply write identity information.

``agent_chat_kyc_owner_confirmed`` is the writer label for a reply the owner
types to a KYC information request they selected. The label alone must not
authorize a write into ``identity.identity_documents`` or ``professional.profile``:
any client code path could claim it. ``contracts/pkm/reserved-branches.v1.json``
therefore marks the writer ``requires_capability: information_request_id``, and
this module is that capability.

The shape follows Location's finalize authority
(``LocationPkmFinalizeAuthorizationV1``): the server mints an opaque, expiring
token, an HMAC over canonical JSON with the app signing key, bound to one owner
and one open information request. ``/api/pkm/store-domain`` verifies the token
and then re-checks, live, that the request is still open for that owner. A KYC
save may write more than one domain (identity and professional), each with its
own mutation plan, so the binding is to the request rather than to one plan.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import uuid
from datetime import UTC, datetime, timedelta
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from hushh_mcp.runtime_settings import get_core_security_settings

KYC_REPLY_CAPABILITY = "information_request_id"
KYC_REPLY_AUTHORIZATION_TTL = timedelta(minutes=10)
_TOKEN_PATTERN = r"^kycreplytoken_[0-9a-f]{64}$"  # noqa: S105 - a pattern, not a secret
_DIGEST_KIND = "kyc_reply_pkm_authorization"


class KycReplyAuthorizationV1(BaseModel):
    """Opaque server capability for the KYC reply writer, for one open request."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal["one.kyc_reply_authorization.v1"] = "one.kyc_reply_authorization.v1"
    information_request_id: uuid.UUID
    token: str = Field(..., pattern=_TOKEN_PATTERN)
    expires_at: datetime

    @model_validator(mode="after")
    def validate_expiry_timezone(self) -> KycReplyAuthorizationV1:
        if self.expires_at.tzinfo is None:
            raise ValueError("kyc_reply_expiry_requires_timezone")
        return self


def _signature(
    *, user_id: str, information_request_id: uuid.UUID, expires_at: datetime, hmac_key: str
) -> str:
    payload = json.dumps(
        {
            "kind": _DIGEST_KIND,
            "user_id": user_id,
            "information_request_id": str(information_request_id),
            "expires_at": expires_at.astimezone(UTC).isoformat(),
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hmac.new(hmac_key.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()


def _key(hmac_key: str | None) -> str:
    key = hmac_key or get_core_security_settings().app_signing_key
    if not key:
        raise ValueError("kyc_reply_signing_key_unavailable")
    return key


def issue_kyc_reply_authorization(
    *,
    user_id: str,
    information_request_id: str | uuid.UUID,
    now: datetime | None = None,
    hmac_key: str | None = None,
) -> KycReplyAuthorizationV1:
    """Mint the capability. The caller has already checked the request is open."""
    owner = str(user_id or "").strip()
    if not owner or len(owner) > 256:
        raise ValueError("kyc_reply_owner_invalid")
    request_id = uuid.UUID(str(information_request_id))
    # Whole seconds, so the signed instant survives an ISO round trip exactly.
    expires_at = ((now or datetime.now(UTC)) + KYC_REPLY_AUTHORIZATION_TTL).replace(microsecond=0)
    signature = _signature(
        user_id=owner,
        information_request_id=request_id,
        expires_at=expires_at,
        hmac_key=_key(hmac_key),
    )
    return KycReplyAuthorizationV1(
        information_request_id=request_id,
        token=f"kycreplytoken_{signature}",
        expires_at=expires_at,
    )


def verify_kyc_reply_authorization(
    *,
    authorization: KycReplyAuthorizationV1,
    authenticated_user_id: str,
    now: datetime | None = None,
    hmac_key: str | None = None,
) -> None:
    """Raise ValueError unless the token is this owner's, unexpired and untampered.

    Liveness of the request itself is a database fact; the route checks it
    after this, so a request the owner ignored or answered stops authorizing.
    """
    if authorization.expires_at.astimezone(UTC) <= (now or datetime.now(UTC)):
        raise ValueError("kyc_reply_authorization_expired")
    expected = _signature(
        user_id=str(authenticated_user_id or "").strip(),
        information_request_id=authorization.information_request_id,
        expires_at=authorization.expires_at,
        hmac_key=_key(hmac_key),
    )
    presented = authorization.token.removeprefix("kycreplytoken_")
    if not hmac.compare_digest(presented, expected):
        raise ValueError("kyc_reply_authorization_invalid")
