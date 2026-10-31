"""Owner-approved paid answers between connected people.

Firebase authorizes the declared financial routes; it grants no information access.
Delivery accepts recipient-bound ciphertext. Separately authorized composition
uses an approved transient projection and decrypts no stored PKM. Signed settlement
and answer fulfillment remain separate from time-limited scope purchases.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import date, datetime
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Body, Depends, HTTPException, Response

from api.middleware import require_firebase_auth, require_firebase_auth_read_only
from api.models.hosted_payouts import OnboardBody
from hushh_mcp.services.answer_composer import AnswerComposer, AnswerComposerError
from hushh_mcp.services.answer_composition_receipt import issue_composition_receipt
from hushh_mcp.services.answer_scope_resolver import AnswerScopeResolver
from hushh_mcp.services.owner_placement_guard import admit_hub_content, hub_content_firebase
from hushh_mcp.services.person_profile_service import (
    PersonProfileNotFoundError,
    PersonProfileService,
)
from hushh_mcp.services.pkm_answer_config import (
    answer_composer_enabled,
    answer_payment_config,
    answer_requests_enabled,
    answer_stripe_mode,
)
from hushh_mcp.services.pkm_answer_payment_service import (
    AnswerPaymentError,
    PkmAnswerPaymentService,
    answer_payments_enabled,
)
from hushh_mcp.services.pkm_answer_request_service import (
    AnswerRequestError,
    PkmAnswerRequestService,
)
from hushh_mcp.services.pkm_packet_order_service import PacketOrderError
from hushh_mcp.services.pkm_payout_service import PkmPayoutService
from hushh_mcp.services.stripe_mode import configured_connect_mode

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/answer-requests", tags=["One Paid Answers"])

_STATUS = {
    "connection_required": 403,
    "no_self_request": 422,
    "invalid_question": 422,
    "invalid_request_key": 422,
    "retry_conflict": 409,
    "invalid_period": 422,
    "invalid_price": 422,
    "invalid_envelope": 422,
    "no_scopes_approved": 422,
    "model_processing_consent_required": 422,
    "scope_not_offered": 422,
    "request_unavailable": 404,
    "answer_unavailable": 404,
    "request_not_approvable": 409,
    "request_not_declinable": 409,
    "request_not_cancellable": 409,
    "request_not_answerable": 409,
    "request_not_resolvable": 409,
    "answer_already_delivered": 409,
    "payment_required": 402,
    "terms_changed": 409,
    "payment_not_ready": 409,
    "answer_not_ready": 409,
    "composition_receipt_required": 409,
    "answer_not_found": 409,
    "payment_already_paid": 409,
    # The requester paid a session we were about to replace; the webhook
    # settles it. Retrying checkout would double-charge.
    "payment_in_flight": 409,
    # Stripe could not confirm the previous session is dead, so we refuse to
    # mint a second payable one. Retryable.
    "checkout_unavailable": 503,
    "payment_invalid_event": 409,
    "payment_invalid_signature": 400,
}

_DETAIL = {
    403: "You need an active connection with this person.",
    402: "This answer has not been paid for.",
    404: "This request is unavailable.",
    409: "This request cannot change state right now.",
    422: "Check the request details.",
}


def _http(error: Exception) -> HTTPException:
    code = str(error) if isinstance(error, (AnswerRequestError, AnswerPaymentError)) else ""
    status = _STATUS.get(code, 503)
    detail = _DETAIL.get(status, "Answers are temporarily unavailable.")
    return HTTPException(status_code=status, detail=detail, headers={"Cache-Control": "no-store"})


def _requests() -> PkmAnswerRequestService:
    # The real semantic stage. Without it every request would record
    # resolution_mode='skipped' and the owner would hand-pick every scope,
    # which is the honest fallback but not the product.
    return PkmAnswerRequestService(resolver=AnswerScopeResolver())


def _payments() -> PkmAnswerPaymentService:
    return PkmAnswerPaymentService()


def _scope_has_fact(scope: str, value: object) -> bool:
    """Structural completeness only; this never invents or writes an answer."""

    def substantive(item: object) -> bool:
        if item is None:
            return False
        if isinstance(item, str):
            return bool(item.strip())
        if isinstance(item, dict):
            return any(
                substantive(inner) for key, inner in item.items() if not key.startswith("__")
            )
        if isinstance(item, list):
            return any(substantive(inner) for inner in item)
        return isinstance(item, (int, float, bool))

    segments = scope.split(".")
    if len(segments) < 3 or segments[0] != "attr":
        return False
    # Scalars/lists may already be a leaf projection. Objects must carry the
    # approved attribute path; unrelated account context cannot fill a gap.
    if isinstance(value, dict):
        value = value.get(segments[1], value)
        for segment in segments[2:]:
            if segment == "*":
                break
            if not isinstance(value, dict) or segment not in value:
                return False
            value = value[segment]
    return substantive(value)


def _valid_source_freshness(
    value: object, approved_scopes: list[str], approved_values: dict[str, Any]
) -> bool:
    """Bound revision/date metadata to the same exact scopes as the facts."""
    if not isinstance(value, dict) or not set(value) <= set(approved_scopes):
        return False
    try:
        for scope, freshness in value.items():
            if not isinstance(freshness, dict) or set(freshness) != {
                "sources",
                "derivedOn",
                "builtAt",
            }:
                return False
            built = freshness["builtAt"]
            if (
                not isinstance(built, str)
                or len(built) > 40
                or datetime.fromisoformat(built.replace("Z", "+00:00")).tzinfo is None
            ):
                return False
            derived = freshness["derivedOn"]
            if derived is not None and (
                not isinstance(derived, str)
                or len(derived) != 10
                or date.fromisoformat(derived).isoformat() != derived
            ):
                return False
            sources = freshness["sources"]
            if not isinstance(sources, list) or not 1 <= len(sources) <= 5:
                return False
            allowed_domains = {scope.split(".")[1], "one_memory", "account_profile"}
            approved_value = approved_values.get(scope)
            if scope == "attr.professional.profile.age" or (
                scope == "attr.professional.profile.*"
                and derived is not None
                and isinstance(approved_value, dict)
                and _scope_has_fact("attr.professional.profile.age", approved_value)
            ):
                # An approved legacy age selector derives from canonical DOB;
                # only its source revisions travel, never the DOB value/path.
                allowed_domains.add("identity")
            for source in sources:
                if not isinstance(source, dict) or set(source) != {
                    "domain",
                    "contentRevision",
                    "manifestRevision",
                    "absent",
                }:
                    return False
                if source["domain"] not in allowed_domains or type(source["absent"]) is not bool:
                    return False
                if any(
                    revision is not None
                    and (type(revision) is not int or not 0 <= revision <= 2**53 - 1)
                    for revision in (source["contentRevision"], source["manifestRevision"])
                ):
                    return False
        return True
    except (ValueError, TypeError, IndexError):
        return False


def _require_paid_lane_enabled() -> None:
    """Gate for the money and written-answer path only.

    Staged rollout, defaulting closed exactly like the Drive paywall. Named
    for what it actually gates: asking a question and reviewing one are
    admitted by `_require_requests_enabled` instead, so pausing payments no
    longer closes intake.
    """
    if not (answer_payments_enabled() and answer_composer_enabled()):
        raise HTTPException(
            status_code=503,
            detail="Answers are not available yet.",
            headers={"Cache-Control": "no-store"},
        )


def _require_preparation_enabled() -> None:
    """Gate for preparing the answer. Composer only, never payments.

    The owner's device prepares the answer when they approve, before anyone is
    asked to pay: that is what makes "Answer not found" honest and what lets a
    verified payment release the answer with no second owner action. Preparing
    moves no money, so requiring the payment flag for it put the one step that
    decides whether an answer EXISTS behind the one flag that only decides
    whether it can be SOLD -- and a deployment with payments paused could
    never leave "Checking their memory for an answer".

    Checkout keeps `_require_paid_lane_enabled`; this is the same separation
    `_require_requests_enabled` already makes for intake.
    """
    if not answer_composer_enabled():
        raise HTTPException(
            status_code=503,
            detail="Answers are not available yet.",
            headers={"Cache-Control": "no-store"},
        )


def _require_requests_enabled() -> None:
    """Gate for intake and owner review. Independent of payments.

    A question to a connected person, and that person approving scopes and a
    price, move no money. Checkout keeps its own gate, so a deployment can
    take questions with payments still paused.
    """
    if not answer_requests_enabled():
        raise HTTPException(
            status_code=503,
            detail="Requests are not available yet.",
            headers={"Cache-Control": "no-store"},
        )


@router.get("/availability")
async def answer_requests_available(
    response: Response,
    _user_id: str = Depends(require_firebase_auth_read_only),
) -> dict[str, bool]:
    """The two independent gates, reported separately.

    `requests` admits the question form and the owner's review. `payments`
    admits checkout, and additionally requires usable answer credentials:
    offering a Pay control that cannot mint a Checkout session is the same
    dead control in a more expensive place.

    `enabled` is retained with its original paid-lane meaning so an older
    deployed client keeps failing closed rather than reading a missing field
    as permission.
    """
    response.headers["Cache-Control"] = "private, no-store"
    payments = answer_payments_enabled() and answer_composer_enabled()
    if payments:
        try:
            answer_payment_config()
        except ValueError:
            payments = False
    return {
        "enabled": payments,
        "requests": answer_requests_enabled(),
        "payments": payments,
        "payouts": _payout_mode_allowed(),
    }


def _payouts() -> PkmPayoutService:
    key, _, _ = answer_payment_config()
    return PkmPayoutService(mode=answer_stripe_mode(), api_key=key, resume_documents=False)


def _payout_mode_allowed() -> bool:
    """A paused answers lane must not open an Express account in another Connect mode.

    Reported by `/availability` as well as enforced here, so the owner's
    review sheet can omit the payout control instead of offering one that
    404s. One predicate, both callers.
    """
    try:
        return bool(answer_payments_enabled() or answer_stripe_mode() == configured_connect_mode())
    except ValueError:
        return False


def _require_payout_mode() -> None:
    if not _payout_mode_allowed():
        raise HTTPException(
            status_code=404,
            detail="Answer payouts are not available.",
            headers={"Cache-Control": "no-store"},
        )


@router.get("/payout-account")
async def answer_payout_account(
    response: Response, user_id: str = Depends(require_firebase_auth_read_only)
) -> dict[str, Any]:
    _require_payout_mode()
    response.headers["Cache-Control"] = "private, no-store"
    try:
        return cast(dict[str, Any], await _payouts().account_status(user_id=user_id))
    except (PacketOrderError, ValueError):
        raise HTTPException(
            status_code=503, detail="Could not verify answer payout setup. Please retry."
        ) from None


@router.post("/payout-account/{action}")
async def answer_payout_link(
    action: str,
    response: Response,
    user_id: str = Depends(require_firebase_auth),
    body: Annotated[OnboardBody | None, Body()] = None,
) -> dict[str, Any]:
    _require_payout_mode()
    response.headers["Cache-Control"] = "private, no-store"
    if action not in {"onboarding", "dashboard"}:
        raise HTTPException(status_code=404, detail="Payout action unavailable.")
    try:
        service = _payouts()
        if action == "onboarding":
            return cast(
                dict[str, Any],
                await service.onboarding_link(
                    user_id=user_id,
                    surface="answers",
                    purpose="verify" if body and body.purpose == "verify" else "onboarding",
                    **({"attempt_id": str(body.attempt_id)} if body and body.attempt_id else {}),
                ),
            )
        return cast(dict[str, Any], await service.management_link(user_id=user_id))
    except (PacketOrderError, ValueError):
        raise HTTPException(
            status_code=503,
            detail="Could not open answer payout setup. Please retry or contact support.",
        ) from None


@router.post("")
async def create_answer_request(
    response: Response,
    body: dict[str, Any] = Body(...),
    requester_user_id: str = Depends(require_firebase_auth),
    *,
    background_tasks: BackgroundTasks,
) -> dict[str, Any]:
    _require_requests_enabled()
    response.headers["Cache-Control"] = "private, no-store"
    person_ref = str(body.get("personRef") or "").strip()
    owner_user_id = str(body.get("ownerUserId") or "").strip()
    if person_ref:
        if owner_user_id:
            raise HTTPException(status_code=422, detail="Choose one person to ask.")
        try:
            public_ref = str(UUID(person_ref))
        except ValueError:
            raise HTTPException(status_code=422, detail="Choose who to ask.") from None
        try:
            async with asyncio.timeout(6):
                owner_user_id, _ = await asyncio.to_thread(
                    PersonProfileService().get_relationship_target,
                    viewer_user_id=requester_user_id,
                    public_person_ref=public_ref,
                )
        except PersonProfileNotFoundError:
            raise _http(AnswerRequestError("request_unavailable")) from None
        except Exception:
            raise HTTPException(
                status_code=503, detail="This person's profile is unavailable."
            ) from None
    if not owner_user_id:
        raise HTTPException(status_code=422, detail="Choose who to ask.")
    retry_options = {}
    if body.get("clientRequestId") is not None:
        try:
            retry_options["client_request_id"] = str(UUID(str(body["clientRequestId"])))
        except (TypeError, ValueError):
            raise _http(AnswerRequestError("invalid_request_key")) from None
    # The public reference locates the person; the store separately locks and
    # checks the active connection before admitting the question.
    try:
        service = _requests()
        result = await service.create(
            requester_user_id=requester_user_id,
            owner_user_id=owner_user_id,
            question=str(body.get("question") or ""),
            period_start=body.get("periodStart"),
            period_end=body.get("periodEnd"),
            **retry_options,
        )
        background_tasks.add_task(service.resolve_pending, request_id=result["requestId"])
        return dict(result)
    except Exception as error:
        raise _http(error) from None


@router.post("/{request_id}/resolve")
async def retry_answer_resolution(
    request_id: UUID,
    background_tasks: BackgroundTasks,
    response: Response,
    owner_user_id: str = Depends(require_firebase_auth),
) -> dict[str, bool]:
    _require_requests_enabled()
    response.headers["Cache-Control"] = "private, no-store"
    try:
        service = _requests()
        await service.retry_resolution(request_id=str(request_id), owner_user_id=owner_user_id)
        background_tasks.add_task(service.resolve_pending, request_id=str(request_id))
        return {"accepted": True}
    except Exception as error:
        raise _http(error) from None


@router.get("/inbox")
async def owner_inbox(
    response: Response,
    owner_user_id: str = Depends(require_firebase_auth_read_only),
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "private, no-store"
    try:
        return {"requests": await _requests().pending_for_owner(owner_user_id=owner_user_id)}
    except Exception as error:
        raise _http(error) from None


@router.get("/{request_id}/state")
async def participant_state(
    request_id: UUID, response: Response, user_id: str = Depends(require_firebase_auth_read_only)
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "private, no-store"
    try:
        return dict(
            await _requests().participant_state(user_id=user_id, request_id=str(request_id))
        )
    except Exception as error:
        raise _http(error) from None


@router.post("/{request_id}/approve")
async def approve_answer_request(
    request_id: UUID,
    response: Response,
    body: dict[str, Any] = Body(...),
    owner_user_id: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    _require_requests_enabled()
    response.headers["Cache-Control"] = "private, no-store"
    scopes = body.get("scopes")
    if not isinstance(scopes, list):
        raise HTTPException(status_code=422, detail="Choose the information to share.")
    try:
        return dict(
            await _requests().approve(
                owner_user_id=owner_user_id,
                request_id=str(request_id),
                scopes=[str(scope) for scope in scopes],
                amount_cents=body.get("amountCents"),
                model_processing_consent=body.get("modelProcessingConsent") is True,
            )
        )
    except Exception as error:
        raise _http(error) from None


@router.post("/{request_id}/decline")
async def decline_answer_request(
    request_id: UUID,
    response: Response,
    owner_user_id: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "private, no-store"
    try:
        return dict(
            await _requests().decline(owner_user_id=owner_user_id, request_id=str(request_id))
        )
    except Exception as error:
        raise _http(error) from None


@router.post("/{request_id}/cancel")
async def cancel_answer_request(
    request_id: UUID,
    response: Response,
    requester_user_id: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "private, no-store"
    try:
        return dict(
            await _requests().cancel(
                requester_user_id=requester_user_id, request_id=str(request_id)
            )
        )
    except Exception as error:
        raise _http(error) from None


@router.get("/{request_id}/payment")
async def get_answer_payment(
    request_id: UUID,
    response: Response,
    requester_user_id: str = Depends(require_firebase_auth_read_only),
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "private, no-store"
    try:
        return dict(
            await _payments().get_payment(
                requester_user_id=requester_user_id, request_id=str(request_id)
            )
        )
    except Exception as error:
        raise _http(error) from None


@router.post("/{request_id}/payment/checkout")
async def create_answer_checkout(
    request_id: UUID,
    response: Response,
    requester_user_id: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    _require_paid_lane_enabled()
    response.headers["Cache-Control"] = "private, no-store"
    try:
        return dict(
            await _payments().checkout(
                requester_user_id=requester_user_id, request_id=str(request_id)
            )
        )
    except Exception as error:
        raise _http(error) from None


@router.get("/answerable")
async def answerable_for_owner(
    response: Response,
    owner_user_id: str = Depends(require_firebase_auth_read_only),
) -> dict[str, Any]:
    """Unprepared work for the owner's device sweep.

    Approved-and-unprepared as well as paid-and-undelivered: the answer is
    normally prepared at approval, before anyone is asked to pay for it.

    Returns questions and approved scope handles only; the device reads values
    from its own decrypted PKM.
    """
    _require_preparation_enabled()
    response.headers["Cache-Control"] = "private, no-store"
    try:
        return {"requests": await _requests().claim_answerable(owner_user_id=owner_user_id)}
    except Exception as error:
        raise _http(error) from None


@router.post("/{request_id}/compose")
async def compose_answer(
    request_id: UUID,
    response: Response,
    body: dict[str, Any] = Body(...),
    owner_user_id: str = Depends(hub_content_firebase),
) -> dict[str, Any]:
    """Prepare an owner-approved answer or recover a historical paid answer.

    Current owner placement, exact scope and model-processing consent gate
    provider work. The device supplies its selected projection and seals the
    returned answer; this endpoint persists nothing and decrypts nothing.
    """
    _require_preparation_enabled()
    response.headers["Cache-Control"] = "private, no-store"
    if not answer_composer_enabled():
        raise HTTPException(
            status_code=503,
            detail="Answer writing is not enabled.",
            headers={"Cache-Control": "no-store"},
        )
    projection = body.get("projection")
    if not isinstance(projection, dict) or not projection:
        raise HTTPException(status_code=422, detail="Check the request details.")
    try:
        work = await _requests().assert_answerable(
            owner_user_id=owner_user_id, request_id=str(request_id)
        )
    except Exception as error:
        raise _http(error) from None
    if work.get("modelProcessingConsented") is not True:
        raise HTTPException(status_code=409, detail="Owner model-processing consent is required.")
    values = projection.get("values")
    if (
        not {"memory", "values"} <= set(projection) <= {"memory", "values", "sourceFreshness"}
        or not isinstance(values, dict)
        or not values
        or set(values) != set(work["approvedScopes"])
        or any(not _scope_has_fact(scope, value) for scope, value in values.items())
        or not isinstance(projection.get("memory"), str)
        or len(str(projection)) > 200_000
        or (
            "sourceFreshness" in projection
            and not _valid_source_freshness(
                projection["sourceFreshness"], work["approvedScopes"], values
            )
        )
    ):
        raise HTTPException(status_code=422, detail="Check the approved information.")
    started = time.monotonic()
    try:
        await admit_hub_content(owner_user_id, "paid_answer_writer")
        written = await AnswerComposer().compose(
            question=work["question"],
            projection=projection,
            period=work.get("period"),
            omitted_scopes=work.get("omittedScopes") or (),
            user_id=owner_user_id,
        )
    except AnswerComposerError:
        # A model failure remains queued on the device for retry; the deadline
        # worker refunds it if a written answer cannot be delivered.
        return {"answerMode": "projection", "answer": None}
    finally:
        logger.info(
            "answer.lifecycle request=%s stage=gemini_compose duration_ms=%.2f",
            request_id,
            (time.monotonic() - started) * 1000,
        )
    if written["gaps"]:
        # Gemini reports incomplete coverage. There is no payable answer or
        # receipt; preparation remains available for an explicit retry.
        return {"answerMode": "projection", "answer": None, "gaps": written["gaps"]}
    receipt = issue_composition_receipt(
        request_id=str(request_id),
        owner_user_id=owner_user_id,
        terms_digest=work["termsDigest"],
        answer=written["answer"],
        projection=projection,
        period=work.get("period"),
    )
    return {"answerMode": "agent", **written, "compositionReceipt": receipt}


@router.post("/{request_id}/deliver")
async def deliver_answer(
    request_id: UUID,
    response: Response,
    body: dict[str, Any] = Body(...),
    owner_user_id: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "private, no-store"
    envelope = body.get("envelope")
    if not isinstance(envelope, dict):
        raise HTTPException(status_code=422, detail="Check the request details.")
    source_revisions = body.get("sourceRevisions")
    try:
        return dict(
            await _requests().deliver(
                owner_user_id=owner_user_id,
                request_id=str(request_id),
                envelope=envelope,
                source_revisions=source_revisions if isinstance(source_revisions, dict) else None,
                has_content=bool(body.get("hasContent", True)),
                composition_receipt=body.get("compositionReceipt"),
            )
        )
    except Exception as error:
        raise _http(error) from None


@router.get("/{request_id}/answer")
async def get_answer(
    request_id: UUID,
    response: Response,
    requester_user_id: str = Depends(require_firebase_auth_read_only),
) -> dict[str, Any]:
    """Ciphertext to its requester only. Deliberately ungated.

    Reading an answer already delivered is not a purchase. The rollout gate
    used to sit here, which meant pausing payments made an answer the
    requester had already paid for unreadable -- the same regression
    `test_cancel_remains_available_after_admission_paused` guards on the
    other side. Entitlement is enforced where it belongs and does not depend
    on a flag: a delivery row exists only because `/deliver` verified a paid
    order, and the read joins on `requester_user_id`.
    """
    response.headers["Cache-Control"] = "private, no-store"
    try:
        return dict(
            await _requests().fetch_answer(
                requester_user_id=requester_user_id, request_id=str(request_id)
            )
        )
    except Exception as error:
        raise _http(error) from None
