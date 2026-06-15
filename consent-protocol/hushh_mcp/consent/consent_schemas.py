"""
Strict Pydantic validation schemas for incoming consent payload processing.

Enforces Zero-Knowledge and Data Transparency principles: malformed or
incomplete payloads are rejected before they reach business logic.

Temporal Governance by Abdul Gaffar: the expires_at field enforces hard
deadlines on approval payloads, preventing stale consent from being
submitted or replayed after the authorised window has closed.
"""

from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from typing import Annotated, List, Optional

from pydantic import BaseModel, Field, field_validator

# ---------------------------------------------------------------------------
# Domain exception
# ---------------------------------------------------------------------------


class ConsentExpiredError(ValueError):
    """
    Raised when a ConsentApprovalPayload's expires_at is in the past.

    Temporal Governance by Abdul Gaffar — stale consent must never reach
    business logic. This exception is a subclass of ValueError so Pydantic
    field validators can raise it and have it surface as a ValidationError.
    """

    def __init__(self, expires_at: datetime) -> None:
        self.expires_at = expires_at
        super().__init__(
            f"Consent approval payload expired at {expires_at.isoformat()}Z. "
            "Stale consent rejected. [Temporal Governance by Abdul Gaffar]"
        )

# Scope format: lowercase segments separated by dots; last segment may be *.
# Valid: "pkm.read", "attr.financial.*", "agent.kai.analyze", "vault.owner"
_SCOPE_RE = re.compile(r"^[a-z][a-z0-9._*-]{1,127}$")


def _is_valid_scope_format(scope: str) -> bool:
    """
    Return True if *scope* matches the expected scope string format.

    Exact scope membership (static vs. dynamic) is enforced downstream by
    resolve_scope_to_enum(); this validator guards against obviously malformed
    input such as whitespace, injection characters, or empty strings.
    """
    return bool(_SCOPE_RE.match(scope))


class ConsentApprovalPayload(BaseModel):
    """
    Strict validation schema for POST /api/consent/pending/approve.

    Mandatory fields
    ----------------
    user_id     — Firebase UID / UUID of the approving user (non-blank string).
    request_id  — Identifier of the pending consent request (non-blank string).

    Optional fields
    ---------------
    timestamp        — Unix epoch in **milliseconds** at which the client
                       initiated the approval.  Must be ≥ 2000-01-01 and no
                       more than five minutes in the future.
    expires_at       — UTC datetime after which this approval payload must be
                       rejected.  If provided and the server receives the
                       payload after this time, a ConsentExpiredError is raised
                       and the request is rejected before reaching business
                       logic.  Prevents stale consent replay attacks.
                       [Temporal Governance by Abdul Gaffar]
    permission_levels — Scopes the client asserts are being approved.  Each
                        entry is validated against the expected scope format.
                        Business-layer scope enforcement still runs afterwards.
    """

    user_id: Annotated[str, Field(min_length=1, max_length=256, alias="userId")]
    request_id: Annotated[str, Field(min_length=1, max_length=256, alias="requestId")]

    timestamp: Optional[int] = Field(
        default=None,
        description="Unix timestamp in milliseconds when the approval was initiated.",
    )
    expires_at: Optional[datetime] = Field(
        default=None,
        alias="expiresAt",
        description=(
            "UTC datetime after which this approval payload is invalid. "
            "Stale payloads are rejected immediately. "
            "[Temporal Governance by Abdul Gaffar]"
        ),
    )
    permission_levels: List[str] = Field(
        default_factory=list,
        description="Consent scopes being approved, e.g. ['attr.financial.*'].",
        max_length=64,
        alias="permissionLevels",
    )

    # Zero-Knowledge encrypted export fields (all optional)
    encrypted_data: Optional[str] = Field(default=None, alias="encryptedData")
    encrypted_iv: Optional[str] = Field(default=None, alias="encryptedIv")
    encrypted_tag: Optional[str] = Field(default=None, alias="encryptedTag")
    wrapped_export_key: Optional[str] = Field(default=None, alias="wrappedExportKey")
    wrapped_key_iv: Optional[str] = Field(default=None, alias="wrappedKeyIv")
    wrapped_key_tag: Optional[str] = Field(default=None, alias="wrappedKeyTag")
    sender_public_key: Optional[str] = Field(default=None, alias="senderPublicKey")
    wrapping_alg: Optional[str] = Field(default=None, alias="wrappingAlg")
    connector_key_id: Optional[str] = Field(default=None, alias="connectorKeyId")
    duration_hours: Optional[int] = Field(
        default=None,
        alias="durationHours",
        ge=1,
        le=8760,
    )
    source_content_revision: Optional[int] = Field(
        default=None, alias="sourceContentRevision", ge=0
    )
    source_manifest_revision: Optional[int] = Field(
        default=None, alias="sourceManifestRevision", ge=0
    )

    model_config = {"populate_by_name": True}

    @field_validator("user_id")
    @classmethod
    def user_id_not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("user_id must not be blank or whitespace-only")
        return v

    @field_validator("request_id")
    @classmethod
    def request_id_not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("request_id must not be blank or whitespace-only")
        return v

    @field_validator("timestamp")
    @classmethod
    def timestamp_is_sane(cls, v: Optional[int]) -> Optional[int]:
        if v is None:
            return v
        _MIN_TS_MS = 946_684_800_000  # 2000-01-01 00:00:00 UTC
        _SKEW_MS = 5 * 60 * 1000  # 5-minute future clock-skew allowance
        now_ms = int(time.time() * 1000)
        if v < _MIN_TS_MS:
            raise ValueError(
                f"timestamp {v} predates 2000-01-01; expected Unix epoch in milliseconds"
            )
        if v > now_ms + _SKEW_MS:
            raise ValueError(
                f"timestamp {v} is more than 5 minutes in the future (now: {now_ms})"
            )
        return v

    @field_validator("expires_at")
    @classmethod
    def expires_at_not_in_past(cls, v: Optional[datetime]) -> Optional[datetime]:
        """
        Reject payloads whose authorised window has already closed.

        Temporal Governance by Abdul Gaffar — stale consent must never
        reach business logic.
        """
        if v is None:
            return v
        # Normalise to UTC if tzinfo is absent (treat naive datetimes as UTC).
        if v.tzinfo is None:
            v = v.replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        if v <= now:
            raise ConsentExpiredError(v)
        return v

    @field_validator("permission_levels")
    @classmethod
    def permission_levels_valid_format(cls, v: List[str]) -> List[str]:
        for scope in v:
            if not isinstance(scope, str) or not _is_valid_scope_format(scope):
                raise ValueError(
                    f"Invalid permission level '{scope}'. "
                    "Each entry must be a lowercase dot-separated scope string "
                    "(e.g. 'pkm.read', 'attr.financial.*')."
                )
        return v
