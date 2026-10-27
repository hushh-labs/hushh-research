"""Finance object lifecycle adapter for One's existing shared-context boundary.

No consent rows are invented. Only metadata crosses the signed pod owner feed;
the recipient explicitly submits the exact locally decrypted projection per turn.
"""

import hashlib
import json
import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt

from hushh_mcp.one_adk.consent_continuation import (
    SHARED_TEXT_TTL_SECONDS,
    STATE_CONSENT_CONTINUATION,
    ConsentContinuationError,
    _latest_user_text,
    consent_shared_state_key,
)
from hushh_mcp.one_adk.request_secrets import store_request_secret

FINANCE_SOURCE = re.compile(r"^finance:([a-f0-9-]{36}):([1-9][0-9]{0,8})$")
FINANCE_REVIEW_MESSAGE = "Review shared Finance"


class FinanceReviewAuthority(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    sourceRef: str = Field(pattern=FINANCE_SOURCE.pattern)
    recipientUserId: str = Field(min_length=1, max_length=160)
    senderName: str = Field(max_length=300)
    revision: StrictInt = Field(ge=1)
    contentHash: str = Field(pattern=r"^[a-f0-9]{64}$")
    status: Literal["active", "expired", "stopped", "changed"]
    modelProcessingAllowed: StrictBool
    sections: list[Literal["allocation", "performance", "holdings", "note"]] = Field(
        min_length=1, max_length=4
    )
    showAmounts: StrictBool


def finance_lifecycle(authority: dict) -> dict:
    checked = FinanceReviewAuthority.model_validate(authority).model_dump()
    active = checked["status"] == "active" and checked["modelProcessingAllowed"]
    return {
        "progress": {
            "outcome": "granted"
            if active
            else "expired"
            if checked["status"] == "expired"
            else "revoked"
        },
        "items": [{"status": "granted" if active else "revoked", "accessReady": active}],
    }


def validate_finance_review(payload: dict, authority: dict, owner_id: str) -> str:
    from hushh_mcp.services.finance_projection_contract import validate_finance_projection

    checked = FinanceReviewAuthority.model_validate(authority)
    text = payload.get("projectionText")
    if (
        set(payload) != {"grantId", "revision", "projectionText"}
        or type(payload.get("revision")) is not int
        or not isinstance(text, str)
        or not 1 <= len(text) <= 100_000
        or checked.recipientUserId != owner_id
        or checked.status != "active"
        or not checked.modelProcessingAllowed
        or checked.revision != payload["revision"]
        or checked.sourceRef != f"finance:{payload['grantId']}:{payload['revision']}"
        or hashlib.sha256(text.encode()).hexdigest() != checked.contentHash
    ):
        raise ValueError("finance_review_not_allowed")
    projection = json.loads(text)
    validate_finance_projection(projection, checked.sections, checked.showAmounts)
    # The random digest salt is recipient-encrypted and disclosed only with
    # this approved review; it has no meaning for the model.
    projection.pop("commitmentNonce")
    return json.dumps(projection, ensure_ascii=False, separators=(",", ":"))


async def admit_finance_share(
    forwarded: dict, *, owner_id: str, messages: Any, lookup: Any
) -> dict:
    payload = forwarded.pop("financeShare", None)
    if payload is None:
        return {}
    if (
        not owner_id
        or not isinstance(payload, dict)
        or forwarded.get("consentContinuation")
        or _latest_user_text(messages) != FINANCE_REVIEW_MESSAGE
    ):
        raise ConsentContinuationError(
            "Open shared Finance and choose Review with my private agent.", status_code=403
        )
    try:
        from uuid import UUID

        grant = str(UUID(payload.get("grantId", "")))
        revision = payload.get("revision")
        if type(revision) is not int or not 1 <= revision <= 999_999_999:
            raise ValueError("invalid_revision")
        source = f"finance:{grant}:{revision}"
        authority = await lookup(owner_id, source)
        shared = validate_finance_review(payload, authority, owner_id)
    except Exception:
        raise ConsentContinuationError(
            "Finance access changed or private-agent review is not allowed. Open the shared view again.",
            status_code=403,
        ) from None
    labels = [section.capitalize() for section in authority["sections"]]
    return {
        STATE_CONSENT_CONTINUATION: {
            "kind": "finance",
            "bundleId": source,
            "outcome": "granted",
            "personName": authority["senderName"],
            "sharedLabels": labels,
            "shared": store_request_secret(shared, ttl_seconds=SHARED_TEXT_TTL_SECONDS),
        },
        consent_shared_state_key(source): {"personName": authority["senderName"], "labels": labels},
    }


async def recheck_finance_context(callback_context, *, lookup):
    from hushh_mcp.one_adk.consent_redaction import tagged_bundles, track_consent_access

    state = callback_context.state
    if any(source.startswith("finance:") for source in tagged_bundles(state)):
        await track_consent_access(callback_context, lookup=lookup)


async def finance_response_guard(callback_context, llm_response, *, lookup):
    from google.genai import types

    from hushh_mcp.one_adk.consent_redaction import STATE_ENDED_CONSENT, tagged_bundles

    state = callback_context.state
    invocation = str(getattr(callback_context, "invocation_id", "") or "")
    current = [
        source
        for source, turns in tagged_bundles(state).items()
        if source.startswith("finance:") and invocation in turns
    ]
    if not current:
        return None
    await recheck_finance_context(callback_context, lookup=lookup)
    ended = state.get(STATE_ENDED_CONSENT) or {}
    if any(source in ended for source in current):
        # Explicit authority failure, not a replacement semantic assessment.
        import logging

        logging.getLogger(__name__).info("one.finance_review_access_ended")
        return llm_response.model_copy(
            update={
                "content": types.Content(
                    role="model",
                    parts=[
                        types.Part(
                            text="Access to the shared Finance view changed. Reopen the view to check current access."
                        )
                    ],
                )
            }
        )
    return None


async def hub_shared_authority(owner_id: str, bundle_id: str) -> dict[str, Any] | None:
    """Requester-bound bundle read for consent redaction; absent for anyone else."""
    from hushh_mcp.services.information_request_service import InformationRequestService

    if not owner_id or owner_id.startswith("anonymous:"):
        return None
    if bundle_id.startswith("finance:"):
        from hushh_mcp.services.finance_sharing_service import finance_review_authority

        return finance_lifecycle(await finance_review_authority(owner_id, bundle_id))
    bundle: dict[str, Any] = await InformationRequestService().get(
        requester_user_id=owner_id, bundle_id=bundle_id
    )
    return bundle


def finance_model_callbacks(*, lookup, before_model):
    from hushh_mcp.one_adk.consent_redaction import track_consent_access

    async def track_current_consent(callback_context: Any) -> None:
        await track_consent_access(callback_context, lookup=lookup)

    async def finance_before_model(callback_context: Any, llm_request: Any) -> None:
        await recheck_finance_context(callback_context, lookup=lookup)
        before_model(callback_context, llm_request)

    async def finance_after_model(callback_context: Any, llm_response: Any) -> Any:
        return await finance_response_guard(callback_context, llm_response, lookup=lookup)

    return track_current_consent, finance_before_model, finance_after_model
