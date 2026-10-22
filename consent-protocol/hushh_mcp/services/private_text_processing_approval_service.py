"""Owner approval and scoped UAT Drive rollout, separate from model choice.

This is permission, never rollout or information-access authority. Callers must
retain their existing owner, vault, connector and request checks. Capture a grant
before preparing private inputs and run its current-authority callback immediately
before every provider send, including retries and sends after token acquisition.
No failed read may fall back to a model preference or deployment default.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any, cast

from db.connection import get_pool

PRIVATE_AZURE_TEXT_DISCLOSURE_VERSION = "one-private-azure-text-v1"
PRIVATE_AZURE_TEXT_PROVIDER = "azure_openai"
DRIVE_DOCUMENT_REQUESTS_SCOPE = "drive_document_requests"
_STORE_TIMEOUT_SECONDS = 5.0


class PrivateTextApprovalError(PermissionError):
    """A safe, content-free refusal suitable for the API and provider boundary."""

    def __init__(self, message: str, *, code: str, status_code: int = 403) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


@dataclass(frozen=True)
class PrivateAzureTextApproval:
    user_id: str
    generation: str
    disclosure_version: str = PRIVATE_AZURE_TEXT_DISCLOSURE_VERSION
    authorization_basis: str = "owner_approval"


def private_drive_text_policy() -> dict[str, Any] | None:
    """The checked-in default grants processor use only, never file access."""
    _require_uat()
    from hushh_mcp.runtime_providers.managed_text import managed_text_policy

    try:
        return managed_text_policy()
    except Exception:
        raise _unavailable() from None


def resolve_private_text_authority(
    row: Mapping[str, Any] | None, *, user_id: str, scope: str | None = None
) -> PrivateAzureTextApproval | None:
    """Admin policy is processor basis; legacy pilot receipts remain historical."""
    _require_uat()
    owner = _owner(user_id)
    if scope in {DRIVE_DOCUMENT_REQUESTS_SCOPE, "one_text_chat"}:
        policy = private_drive_text_policy()
        if policy is not None:
            return PrivateAzureTextApproval(
                owner, policy["generation"], policy["version"], "uat_policy"
            )
    if row is not None and _approved(row):
        return PrivateAzureTextApproval(owner, str(row["generation"]))
    return None


def _owner(user_id: str) -> str:
    if not user_id or user_id.strip() != user_id:
        raise PrivateTextApprovalError(
            "An authenticated owner is required.", code="PRIVATE_AZURE_TEXT_OWNER_REQUIRED"
        )
    return user_id


def _require_uat() -> None:
    environment = (
        os.getenv("HUSHH_DEPLOY_ENV", "").strip() or os.getenv("ENVIRONMENT", "").strip()
    ).lower()
    if environment != "uat":
        raise PrivateTextApprovalError(
            "Private Azure text approval is available only in UAT.",
            code="PRIVATE_AZURE_TEXT_UAT_ONLY",
        )


def _unavailable() -> PrivateTextApprovalError:
    return PrivateTextApprovalError(
        "Private text approval is unavailable. Try again before continuing.",
        code="PRIVATE_AZURE_TEXT_APPROVAL_UNAVAILABLE",
        status_code=503,
    )


def _approved(row: Mapping[str, Any] | None) -> bool:
    return bool(
        row
        and row["enabled"] is True
        and row["disclosure_version"] == PRIVATE_AZURE_TEXT_DISCLOSURE_VERSION
        and row["accepted_at"] is not None
        and row["generation"] is not None
        and row["revoked_at"] is None
    )


def _public(
    row: Mapping[str, Any] | None,
    *,
    user_id: str,
    include_policy: bool = False,
    include_processing_provider: bool = False,
) -> dict[str, Any]:
    result = {
        "provider": PRIVATE_AZURE_TEXT_PROVIDER,
        "disclosure_version": PRIVATE_AZURE_TEXT_DISCLOSURE_VERSION,
        "enabled": _approved(row),
        "generation": str(row["generation"]) if row else None,
        "accepted_at": row["accepted_at"].isoformat() if row and row["accepted_at"] else None,
        "revoked_at": row["revoked_at"].isoformat() if row and row["revoked_at"] else None,
    }
    if include_policy:
        grant = resolve_private_text_authority(
            row, user_id=user_id, scope=DRIVE_DOCUMENT_REQUESTS_SCOPE
        )
        result["processing_policy"] = {
            "enabled": grant is not None,
            "basis": grant.authorization_basis if grant else "disabled",
            "version": grant.disclosure_version if grant else None,
            "generation": grant.generation if grant else None,
            "scope": "one_text_chat_and_drive_requests",
        }
        if include_processing_provider:
            provider = PRIVATE_AZURE_TEXT_PROVIDER if grant else None
            if grant and grant.authorization_basis == "uat_policy":
                policy = private_drive_text_policy()
                if policy is None or policy["generation"] != grant.generation:
                    raise _unavailable()
                provider = "gemini" if policy["selected_provider"] == "vertex" else "azure_openai"
            result["processing_policy"]["provider"] = provider
    return result


async def _read(user_id: str) -> Mapping[str, Any] | None:
    try:
        async with asyncio.timeout(_STORE_TIMEOUT_SECONDS):
            pool = await get_pool()
            async with pool.acquire() as conn:
                return cast(
                    Mapping[str, Any] | None,
                    await conn.fetchrow(
                        """SELECT enabled, disclosure_version, generation, accepted_at, revoked_at
                    FROM one_private_text_processing_approvals WHERE user_id = $1""",
                        user_id,
                    ),
                )
    except Exception:
        raise _unavailable() from None


async def get_private_text_approval(
    *, user_id: str, include_policy: bool = False, include_processing_provider: bool = False
) -> dict[str, Any]:
    _require_uat()
    return _public(
        await _read(_owner(user_id)),
        user_id=user_id,
        include_policy=include_policy,
        include_processing_provider=include_processing_provider,
    )


async def set_private_text_approval(
    *,
    user_id: str,
    enabled: bool,
    expected_generation: str | None,
    disclosure_version: str | None = None,
    include_policy: bool = False,
    include_processing_provider: bool = False,
) -> dict[str, Any]:
    _require_uat()
    owner = _owner(user_id)
    if not isinstance(enabled, bool) or (
        enabled and disclosure_version != PRIVATE_AZURE_TEXT_DISCLOSURE_VERSION
    ):
        raise PrivateTextApprovalError(
            "Approve the current private Azure text disclosure before continuing.",
            code="PRIVATE_AZURE_TEXT_DISCLOSURE_MISMATCH",
            status_code=400,
        )
    try:
        expected = uuid.UUID(expected_generation) if expected_generation is not None else None
    except (ValueError, TypeError, AttributeError):
        raise PrivateTextApprovalError(
            "Read the current approval before changing it.",
            code="PRIVATE_AZURE_TEXT_APPROVAL_CHANGED",
            status_code=409,
        ) from None
    try:
        async with asyncio.timeout(_STORE_TIMEOUT_SECONDS):
            pool = await get_pool()
            async with pool.acquire() as conn:
                row = await conn.fetchrow(
                    """WITH updated AS (
                    UPDATE one_private_text_processing_approvals AS current_approval SET
                      enabled = $2,
                      disclosure_version = CASE WHEN $2 THEN $3
                        ELSE current_approval.disclosure_version END,
                      generation = CASE WHEN
                        current_approval.enabled <> $2 OR
                        ($2 AND current_approval.disclosure_version
                          IS DISTINCT FROM $3)
                        THEN $4 ELSE current_approval.generation END,
                      accepted_at = CASE WHEN $2 AND (
                        NOT current_approval.enabled OR
                        current_approval.disclosure_version IS DISTINCT FROM $3)
                        THEN NOW() ELSE current_approval.accepted_at END,
                      revoked_at = CASE WHEN $2 THEN NULL
                        WHEN current_approval.enabled THEN NOW()
                        ELSE current_approval.revoked_at END,
                      updated_at = NOW()
                    WHERE user_id = $1 AND generation = $5::uuid
                    RETURNING enabled, disclosure_version, generation, accepted_at, revoked_at
                    ), inserted AS (
                    INSERT INTO one_private_text_processing_approvals
                    (user_id, enabled, disclosure_version, generation, accepted_at, revoked_at)
                    SELECT $1, $2, CASE WHEN $2 THEN $3 ELSE NULL END, $4,
                        CASE WHEN $2 THEN NOW() ELSE NULL END,
                        CASE WHEN $2 THEN NULL ELSE NOW() END
                    WHERE $5::uuid IS NULL
                    ON CONFLICT (user_id) DO NOTHING
                    RETURNING enabled, disclosure_version, generation, accepted_at, revoked_at
                    ) SELECT * FROM updated UNION ALL SELECT * FROM inserted""",
                    owner,
                    enabled,
                    PRIVATE_AZURE_TEXT_DISCLOSURE_VERSION,
                    uuid.uuid4(),
                    expected,
                )
    except Exception:
        raise _unavailable() from None
    if row is None:
        raise PrivateTextApprovalError(
            "Private Azure text approval changed. Read it again before changing it.",
            code="PRIVATE_AZURE_TEXT_APPROVAL_CHANGED",
            status_code=409,
        )
    return _public(
        row,
        user_id=user_id,
        include_policy=include_policy,
        include_processing_provider=include_processing_provider,
    )


async def require_private_azure_text_approval(
    user_id: str, *, expected_generation: str | None = None, scope: str | None = None
) -> PrivateAzureTextApproval:
    """Fail closed before private Azure work; bind retries to this approval generation."""
    _require_uat()
    owner = _owner(user_id)
    row = None if scope in {DRIVE_DOCUMENT_REQUESTS_SCOPE, "one_text_chat"} else await _read(owner)
    grant = resolve_private_text_authority(row, user_id=owner, scope=scope)
    if grant is None:
        raise PrivateTextApprovalError(
            "Private Azure text processing needs your current approval.",
            code="PRIVATE_AZURE_TEXT_APPROVAL_REQUIRED",
        )
    if expected_generation is not None and grant.generation != expected_generation:
        raise PrivateTextApprovalError(
            "Private Azure text approval changed. Start again with the current approval.",
            code="PRIVATE_AZURE_TEXT_APPROVAL_CHANGED",
        )
    return grant


def private_azure_text_require_current(
    approval: PrivateAzureTextApproval,
) -> Callable[[], Awaitable[None]]:
    """A request-local guard; never cache a successful check across sends or retries."""

    async def require_current() -> None:
        policy_grant = approval.authorization_basis == "uat_policy"
        if (
            not policy_grant
            and approval.disclosure_version != PRIVATE_AZURE_TEXT_DISCLOSURE_VERSION
        ):
            raise PrivateTextApprovalError(
                "Private Azure text disclosure changed.",
                code="PRIVATE_AZURE_TEXT_APPROVAL_CHANGED",
            )
        current = await require_private_azure_text_approval(
            approval.user_id,
            expected_generation=approval.generation,
            **({"scope": DRIVE_DOCUMENT_REQUESTS_SCOPE} if policy_grant else {}),
        )
        if current.authorization_basis != approval.authorization_basis:
            raise PrivateTextApprovalError(
                "Private Azure text authority changed.", code="PRIVATE_AZURE_TEXT_APPROVAL_CHANGED"
            )

    return require_current
