"""Paid answers between two connected people.

  POST /api/one/answer-requests                        ask a question
  GET  /api/one/answer-requests/inbox                  owner's queue to review
  POST /api/one/answer-requests/{id}/approve           owner: exact scopes + price
  POST /api/one/answer-requests/{id}/decline           owner: refuse (refunds if paid)
  POST /api/one/answer-requests/{id}/cancel            requester: withdraw (refunds)
  GET  /api/one/answer-requests/{id}/payment           state + the wait, before checkout
  POST /api/one/answer-requests/{id}/payment/checkout  hosted Stripe Checkout
  GET  /api/one/answer-requests/answerable             owner device: paid work to do
  POST /api/one/answer-requests/{id}/deliver           owner device: sealed answer
  GET  /api/one/answer-requests/{id}/answer            requester: sealed envelope

Firebase-authenticated on both sides. No `app/api` proxy for the money path:
the Stripe webhook needs the exact signed bytes and the status/checkout
endpoints stay on the same origin as it, matching the Drive lane.

The server never sees an answer in the clear. `/deliver` accepts ciphertext
sealed to the requester's key and refuses anything shaped like plaintext.
"""

from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Body, Depends, HTTPException, Response

from api.middleware import require_firebase_auth, require_firebase_auth_read_only
from hushh_mcp.services.answer_composer import AnswerComposer, AnswerComposerError
from hushh_mcp.services.answer_scope_resolver import AnswerScopeResolver
from hushh_mcp.services.pkm_answer_payment_service import (
    AnswerPaymentError,
    PkmAnswerPaymentService,
    answer_payments_enabled,
)
from hushh_mcp.services.pkm_answer_request_service import (
    AnswerRequestError,
    PkmAnswerRequestService,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/answer-requests", tags=["One Paid Answers"])

_STATUS = {
    "connection_required": 403,
    "no_self_request": 422,
    "invalid_question": 422,
    "invalid_period": 422,
    "invalid_price": 422,
    "invalid_envelope": 422,
    "no_scopes_approved": 422,
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
    "payment_already_paid": 409,
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


def _require_enabled() -> None:
    """Staged rollout, defaulting closed exactly like the Drive paywall."""
    if not answer_payments_enabled():
        raise HTTPException(
            status_code=503,
            detail="Answers are not available yet.",
            headers={"Cache-Control": "no-store"},
        )


@router.get("/availability")
async def answer_requests_available(
    response: Response,
    _user_id: str = Depends(require_firebase_auth_read_only),
) -> dict[str, bool]:
    """Whether this environment offers paid answers at all.

    The lane ships disabled, so the Request scope CTA asks before it appears.
    A dead button that 503s on submit is worse than no button.
    """
    response.headers["Cache-Control"] = "private, no-store"
    return {"enabled": answer_payments_enabled()}


@router.post("")
async def create_answer_request(
    response: Response,
    body: dict[str, Any] = Body(...),
    requester_user_id: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    _require_enabled()
    response.headers["Cache-Control"] = "private, no-store"
    owner_user_id = str(body.get("ownerUserId") or body.get("personRef") or "").strip()
    if not owner_user_id:
        raise HTTPException(status_code=422, detail="Choose who to ask.")
    try:
        return dict(
            await _requests().create(
                requester_user_id=requester_user_id,
                owner_user_id=owner_user_id,
                question=str(body.get("question") or ""),
                period_start=(body.get("periodStart") or None),
                period_end=(body.get("periodEnd") or None),
            )
        )
    except Exception as error:
        raise _http(error) from None


@router.get("/inbox")
async def owner_inbox(
    response: Response,
    owner_user_id: str = Depends(require_firebase_auth_read_only),
) -> dict[str, Any]:
    _require_enabled()
    response.headers["Cache-Control"] = "private, no-store"
    try:
        return {"requests": await _requests().pending_for_owner(owner_user_id=owner_user_id)}
    except Exception as error:
        raise _http(error) from None


@router.post("/{request_id}/approve")
async def approve_answer_request(
    request_id: UUID,
    response: Response,
    body: dict[str, Any] = Body(...),
    owner_user_id: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    _require_enabled()
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
    _require_enabled()
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
    _require_enabled()
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
    _require_enabled()
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
    _require_enabled()
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
    """Paid, undelivered work for the owner's device sweep.

    Returns questions and approved scope handles only; the device reads values
    from its own decrypted PKM.
    """
    _require_enabled()
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
    owner_user_id: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    """Write the answer from the projection the owner's device just built.

    Owner-only, and bound to a request that is actually paid and answerable:
    the gate runs first, so this cannot be used as a free model endpoint.

    Nothing is persisted. The projection exists for this request only and the
    written answer goes straight back to the device, which seals it. The
    backend decrypts nothing here -- the device had already decrypted its own
    PKM and chose what to send.
    """
    _require_enabled()
    response.headers["Cache-Control"] = "private, no-store"
    projection = body.get("projection")
    if not isinstance(projection, dict) or not projection:
        raise HTTPException(status_code=422, detail="Check the request details.")
    try:
        work = await _requests().assert_answerable(
            owner_user_id=owner_user_id, request_id=str(request_id)
        )
    except Exception as error:
        raise _http(error) from None
    try:
        written = await AnswerComposer().compose(
            question=work["question"],
            projection=projection,
            period=work.get("period"),
            user_id=owner_user_id,
        )
    except AnswerComposerError:
        # A model FAILURE is reported as such. The device then delivers the
        # approved projection labelled answer_mode='projection' rather than
        # passing anything off as a written answer.
        return {"answerMode": "projection", "answer": None}
    return {"answerMode": "agent", **written}


@router.post("/{request_id}/deliver")
async def deliver_answer(
    request_id: UUID,
    response: Response,
    body: dict[str, Any] = Body(...),
    owner_user_id: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    _require_enabled()
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
    _require_enabled()
    response.headers["Cache-Control"] = "private, no-store"
    try:
        return dict(
            await _requests().fetch_answer(
                requester_user_id=requester_user_id, request_id=str(request_id)
            )
        )
    except Exception as error:
        raise _http(error) from None
