"""Current requester-bound consent metadata through the existing signed owner feed."""

from __future__ import annotations

import asyncio
import secrets
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictBool


class ConsentReadOptions(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    bundle_id: str = Field(
        pattern=r"^(?:[0-9a-f-]{36}|finance:[0-9a-f-]{36}:[1-9][0-9]{0,8})$", max_length=90
    )
    read_nonce: str = Field(pattern=r"^[0-9a-f]{32}$")
    submission_key: str | None = Field(default=None, min_length=16, max_length=256)


class ConsentItemProjection(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    requestId: str = Field(min_length=1, max_length=200)
    scopeRef: str = Field(min_length=1, max_length=200)
    label: str = Field(min_length=1, max_length=256)
    sensitivity: Literal["sensitive", "standard"] | None
    status: Literal["pending", "granted", "denied", "expired", "revoked", "cancelled"]
    accessReady: StrictBool = False
    modelProcessingAllowed: StrictBool = False


class ConsentBundleProjection(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    bundleId: str = Field(min_length=36, max_length=36)
    personRef: str = Field(min_length=1, max_length=200)
    purpose: str = Field(max_length=2000)
    durationSeconds: int = Field(ge=1, le=7_776_000)
    cancelled: StrictBool
    items: list[ConsentItemProjection] = Field(min_length=1, max_length=100)
    progress: dict[str, Any]


class ConsentFeedProjection(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    readNonce: str = Field(pattern=r"^[0-9a-f]{32}$")
    bundle: ConsentBundleProjection


def project_consent_feed(raw: Any) -> dict:
    """Reject undeclared fields at both signing and opening; never carry values."""
    if isinstance(raw, dict) and "finance" in raw:
        from hushh_mcp.one_adk.finance_share_context import FinanceReviewAuthority

        if set(raw) != {"readNonce", "finance"} or not __import__("re").fullmatch(
            r"[0-9a-f]{32}", str(raw["readNonce"])
        ):
            raise ValueError("invalid_finance_authority")
        return {
            "readNonce": raw["readNonce"],
            "finance": FinanceReviewAuthority.model_validate(raw["finance"]).model_dump(),
        }
    result = ConsentFeedProjection.model_validate(raw).model_dump()
    if any(
        item["modelProcessingAllowed"] and (item["status"] != "granted" or not item["accessReady"])
        for item in result["bundle"]["items"]
    ):
        raise ValueError("invalid_model_permission")
    progress = result["bundle"]["progress"]
    if set(progress) - {"outcome", "ended_at"} or progress.get("outcome") not in {
        "pending",
        "granted",
        "partially_granted",
        "denied",
        "expired",
        "revoked",
        "cancelled",
    }:
        raise ValueError("invalid_consent_progress")
    if progress.get("ended_at") is not None and not isinstance(progress["ended_at"], str):
        raise ValueError("invalid_consent_progress")
    return result


async def read_consent_feed(owner: str, options: ConsentReadOptions) -> dict:
    if options.bundle_id.startswith("finance:"):
        from hushh_mcp.services.finance_sharing_service import finance_review_authority

        if options.submission_key:
            raise ValueError("finance_has_no_bundle_submission")
        return project_consent_feed(
            {
                "readNonce": options.read_nonce,
                "finance": await finance_review_authority(owner, options.bundle_id),
            }
        )
    from hushh_mcp.services.information_request_service import InformationRequestService

    service = InformationRequestService()
    lookup = service.verify_submission_receipt if options.submission_key else service.get
    kwargs = {"requester_user_id": owner, "bundle_id": str(UUID(options.bundle_id))}
    if options.submission_key:
        kwargs["idempotency_key"] = options.submission_key
    bundle = await lookup(**kwargs)
    # The information-request service is the sole authority; this is only its projection.
    fields = ConsentBundleProjection.model_fields
    result = {key: bundle[key] for key in fields if key != "progress"}
    result["progress"] = {
        key: bundle["progress"][key] for key in ("outcome", "ended_at") if key in bundle["progress"]
    }
    return project_consent_feed({"readNonce": options.read_nonce, "bundle": result})


class PodConsentReadPort:
    def __init__(self, owner: Any) -> None:
        self.owner = owner

    async def get(
        self, *, requester_user_id: str, bundle_id: str, idempotency_key: str | None = None
    ) -> dict:
        from hushh_mcp.services.pod_owner_feed_client import owner_feed_client

        if requester_user_id != self.owner.owner:
            raise PermissionError("consent_requester_mismatch")
        await self.owner.require_access()
        options = ConsentReadOptions(
            bundle_id=bundle_id if bundle_id.startswith("finance:") else str(UUID(bundle_id)),
            read_nonce=secrets.token_hex(16),
            submission_key=idempotency_key,
        )
        client = owner_feed_client()
        if client is None:
            raise PermissionError("consent_authority_unavailable")
        projection = await asyncio.to_thread(
            client.read,
            "consent",
            requester_user_id,
            params=options.model_dump(exclude_none=True),
            fresh=True,
        )
        await self.owner.require_access()
        checked = project_consent_feed(projection)
        if options.bundle_id.startswith("finance:"):
            finance = checked.get("finance", {})
            if (
                checked["readNonce"] != options.read_nonce
                or finance.get("sourceRef") != options.bundle_id
                or finance.get("recipientUserId") != requester_user_id
            ):
                raise PermissionError("finance_read_binding_changed")
            return finance
        if (
            checked["readNonce"] != options.read_nonce
            or checked["bundle"]["bundleId"] != options.bundle_id
        ):
            raise PermissionError("consent_read_binding_changed")
        return checked["bundle"]

    async def lookup(self, owner_id: str, bundle_id: str) -> dict:
        result = await self.get(requester_user_id=owner_id, bundle_id=bundle_id)
        if bundle_id.startswith("finance:"):
            from hushh_mcp.one_adk.finance_share_context import finance_lifecycle

            return finance_lifecycle(result)
        return result
