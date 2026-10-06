"""Kai Gmail receipts connector routes.

Canonical attach points
-----------------------
api.routes.kai.gmail.gmail_status   -> GET /gmail/status/{user_id}
api.routes.kai.gmail.gmail_receipts -> GET /gmail/receipts/{user_id}
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.exc import OperationalError as SqlalchemyOperationalError

from api.middleware import require_firebase_auth, require_vault_owner_token, verify_user_id_match
from hushh_mcp.consent.token import validate_token_with_db
from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.gmail_live_receipts_service import get_gmail_live_receipts_service
from hushh_mcp.services.gmail_receipt_cutover import GmailReceiptStorageCutoverError
from hushh_mcp.services.gmail_receipts_service import GmailApiError, get_gmail_receipts_service
from hushh_mcp.services.receipt_memory_service import get_receipt_memory_preview_service

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Kai Gmail"])


class GmailConnectStartRequest(BaseModel):
    user_id: str = Field(min_length=1, max_length=256)
    redirect_uri: str | None = Field(default=None, max_length=2048)
    login_hint: str | None = Field(default=None, max_length=512)
    include_granted_scopes: bool = False
    purpose: Literal["read", "send", "compose", "modify"] = "read"


class GmailNativeConnectStartRequest(BaseModel):
    purpose: Literal["read", "send", "compose", "modify"] = "read"


class GmailConnectCompleteRequest(BaseModel):
    user_id: str = Field(min_length=1, max_length=256)
    code: str = Field(min_length=1, max_length=512)
    state: str = Field(min_length=1, max_length=512)
    redirect_uri: str | None = Field(default=None, max_length=2048)


class GmailNativeConnectCompleteRequest(BaseModel):
    user_id: str = Field(min_length=1, max_length=256)
    server_auth_code: str = Field(min_length=1, max_length=2048)


class GmailDisconnectRequest(BaseModel):
    user_id: str = Field(min_length=1, max_length=256)


class GmailSyncRequest(BaseModel):
    user_id: str = Field(min_length=1, max_length=256)


class GmailReconcileRequest(BaseModel):
    user_id: str = Field(min_length=1, max_length=256)


class GmailReceiptMemoryPreviewRequest(BaseModel):
    user_id: str = Field(min_length=1, max_length=128)
    force_refresh: bool = False


class GmailLiveReceiptScanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_id: str = Field(min_length=1, max_length=128)
    page: int = Field(default=1, ge=1, le=50)
    per_page: int = Field(default=6, ge=1, le=6)
    cursor: str | None = Field(default=None, max_length=8192)


class GmailLiveReceiptDetailRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_id: str = Field(min_length=1, max_length=128)
    source_id: str = Field(min_length=1, max_length=340)


class GmailReceiptIdentifier(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["order", "invoice", "receipt", "pnr", "payment"]
    value: str = Field(min_length=1, max_length=100)


class GmailLiveReceiptItem(BaseModel):
    """Normalized, evidence-backed receipt returned only to its authorized owner."""

    model_config = ConfigDict(extra="forbid")

    id: int
    source_id: str = Field(min_length=1, max_length=340)
    receipt_key: str = Field(min_length=1, max_length=340)
    source_kind: Literal["gmail_live"]
    category: (
        Literal[
            "Shopping",
            "Food",
            "Travel",
            "Transport",
            "Software & Subscriptions",
            "Cloud & Infra",
            "Bills",
            "Uncategorized",
            "Subscription",
            "Other",
        ]
        | None
    ) = None
    category_confidence: float | None = Field(default=None, ge=0.85, le=1)
    gmail_message_id: str = Field(min_length=1, max_length=200)
    gmail_thread_id: str | None = Field(default=None, max_length=200)
    merchant_name: str | None = Field(default=None, max_length=200)
    merchant_domain: str | None = Field(default=None, max_length=253)
    sender_domain: str | None = Field(default=None, max_length=253)
    from_name: str | None = Field(default=None, max_length=200)
    from_email: str | None = Field(default=None, max_length=320)
    order_id: str | None = Field(default=None, max_length=80)
    amount: float | None = Field(default=None, ge=0)
    currency: Literal["INR", "USD", "EUR", "GBP", "$"] | None = None
    receipt_date: str | None = Field(default=None, max_length=64)
    gmail_internal_date: str | None = Field(default=None, max_length=64)
    subject: str | None = Field(default=None, max_length=1_000)
    preview: str | None = Field(default=None, max_length=2_000)
    snippet: str | None = Field(default=None, max_length=2_000)
    classification_confidence: float = Field(ge=0, le=1)
    classification_source: Literal["agent"]
    event_type: Literal["purchase", "fulfillment", "refund", "cancellation", "unknown"]
    status: (
        Literal[
            "paid",
            "overdue",
            "refunded",
            "cancelled",
            "trial",
            "delivered",
            "payment_failed",
            "suspended",
            "renewal_due",
        ]
        | None
    ) = None
    recurrence: Literal["recurring", "one_time", "unknown"] = "unknown"
    attention_state: Literal["none", "needs_attention", "coming_up", "needs_review"] = "none"
    attention_reason: (
        Literal["overdue", "payment_failed", "suspended", "renewal_due", "low_confidence"] | None
    ) = None
    attention_is_prediction: bool = False
    attention_date: str | None = Field(default=None, max_length=64)
    identifier_kind: Literal["order", "invoice", "receipt", "pnr"] | None = None
    identifier_value: str | None = Field(default=None, max_length=100)
    short_detail: str | None = Field(default=None, max_length=120)
    cleaned_preview: str | None = Field(default=None, max_length=420)
    document_kind: (
        Literal[
            "invoice",
            "receipt",
            "payment_confirmation",
            "order_confirmation",
            "booking",
            "fulfillment",
        ]
        | None
    ) = None
    identifiers: list[GmailReceiptIdentifier] = Field(default_factory=list, max_length=9)
    transaction_date: str | None = Field(default=None, max_length=64)


class GmailLiveReceiptRejectionCounts(BaseModel):
    model_config = ConfigDict(extra="forbid")

    missing_receipt_signal: int = Field(ge=0, le=6)
    extractor_not_receipt: int = Field(ge=0, le=6)


class GmailLiveReceiptEvidenceCounts(BaseModel):
    model_config = ConfigDict(extra="forbid")

    gmail_category: int = Field(ge=0, le=6)
    subject_signal: int = Field(ge=0, le=6)
    body_signal: int = Field(ge=0, le=6)
    verified_merchant: int = Field(ge=0, le=6)
    order_candidate: int = Field(ge=0, le=6)
    total_candidate: int = Field(ge=0, le=6)


class GmailLiveReceiptCoverage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source: Literal["gmail_live"]
    listed_count: int = Field(ge=0, le=6)
    candidate_count: int = Field(ge=0, le=6)
    matched_count: int = Field(ge=0, le=6)
    pages_scanned: int = Field(ge=1, le=50)
    max_messages: int = Field(ge=1, le=6)
    max_pages: int = Field(ge=1, le=50)
    max_scan_messages: int = Field(default=300, ge=1, le=300)
    window_start: str | None = None
    window_end: str | None = None
    reached_limit: bool
    query_scope: Literal["receipt_signals_all_mail_except_spam_trash"]
    rejection_counts: GmailLiveReceiptRejectionCounts
    evidence_counts: GmailLiveReceiptEvidenceCounts


class GmailLiveReceiptScanResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[GmailLiveReceiptItem]
    page: int = Field(ge=1, le=50)
    per_page: int = Field(ge=1, le=6)
    returned_count: int = Field(ge=0, le=6)
    has_more: bool
    coverage: GmailLiveReceiptCoverage
    next_cursor: str | None = Field(default=None, max_length=8192)


class GmailLiveReceiptExcerpt(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["email_excerpt"]
    label: Literal["Email preview"]
    text: str = Field(min_length=1, max_length=4_000)
    truncated: bool


class GmailLiveReceiptSourceEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["merchant", "category", "amount", "document", "status", "recurrence", "attention"]
    text: str = Field(min_length=3, max_length=240)


class GmailLiveReceiptDetailResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    item: GmailLiveReceiptItem
    email_excerpt: GmailLiveReceiptExcerpt | None
    source_evidence: list[GmailLiveReceiptSourceEvidence] = Field(
        default_factory=list, max_length=8
    )


def _service():
    return get_gmail_receipts_service()


def _receipt_memory_service():
    return get_receipt_memory_preview_service()


def _live_receipts_service():
    return get_gmail_live_receipts_service()


def _live_receipt_owner(
    *, firebase_uid: str, token_data: dict[str, Any], requested_user_id: str
) -> str:
    token_owner = str(token_data.get("user_id") or "").strip()
    if (
        not requested_user_id
        or requested_user_id != firebase_uid
        or requested_user_id != token_owner
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "GMAIL_RECEIPT_OWNER_REQUIRED",
                "message": "Receipt access requires the current vault owner.",
            },
            headers={"Cache-Control": "private, no-store", "Pragma": "no-cache"},
        )
    return requested_user_id


async def _await_live_receipt_scan(
    *, request: Request, operation: Awaitable[dict[str, Any]]
) -> dict[str, Any]:
    """Cancel only the receipt scan when its HTTP caller disconnects."""

    task = asyncio.create_task(operation)
    try:
        while True:
            done, _pending = await asyncio.wait({task}, timeout=0.25)
            if done:
                return task.result()
            if await request.is_disconnected():
                task.cancel()
                await asyncio.wait({task}, timeout=2.0)
                raise HTTPException(
                    status_code=499,
                    detail={
                        "code": "GMAIL_RECEIPT_SCAN_CANCELLED",
                        "message": "The receipt scan request was cancelled.",
                    },
                )
    finally:
        if not task.done():
            task.cancel()
            task.add_done_callback(
                lambda completed: None if completed.cancelled() else completed.exception()
            )
        elif not task.cancelled():
            task.exception()


async def _revalidate_live_receipt_access(*, token_data: dict[str, Any], owner: str) -> None:
    raw_token = str(token_data.get("token") or "").strip()
    if not raw_token:
        raise GmailApiError(
            "Open your private vault before loading receipts.",
            status_code=401,
            code="GMAIL_RECEIPT_VAULT_REQUIRED",
        )
    valid, _reason, token = await validate_token_with_db(raw_token, ConsentScope.VAULT_OWNER)
    if not valid or token is None or str(token.user_id) != owner:
        raise GmailApiError(
            "Receipt access changed. Open your private vault and try again.",
            status_code=401,
            code="GMAIL_RECEIPT_VAULT_REQUIRED",
        )


def _live_receipt_http_error(exc: Exception) -> HTTPException:
    if isinstance(exc, GmailApiError):
        code = exc.code or "GMAIL_RECEIPT_UNAVAILABLE"
        safe_messages = {
            "GMAIL_NOT_CONNECTED": "Connect Gmail before loading receipts.",
            "GMAIL_READ_PERMISSION_REQUIRED": (
                "Reconnect Gmail to grant email reading permission."
            ),
            "GMAIL_REAUTH_REQUIRED": "Reconnect Gmail before loading receipts.",
            "GMAIL_CONNECTION_CHANGED": (
                "The Gmail connection changed. Retry the receipt request."
            ),
            "GMAIL_RECEIPT_SCAN_IN_PROGRESS": (
                "A receipt scan is already running for this account."
            ),
            "GMAIL_RECEIPT_NOT_FOUND": "The selected receipt is not available.",
            "GMAIL_RECEIPT_VAULT_REQUIRED": ("Open your private vault before loading receipts."),
            "GMAIL_RECEIPT_SCAN_TIMEOUT": ("The Gmail receipt scan timed out. Please try again."),
            "GMAIL_RECEIPT_DETAIL_TIMEOUT": (
                "The Gmail receipt detail timed out. Please try again."
            ),
            "GMAIL_PROVIDER_UNAVAILABLE": ("Gmail is temporarily unavailable. Please try again."),
            "GMAIL_RECEIPT_RESPONSE_TOO_LARGE": (
                "The bounded Gmail receipt response was too large."
            ),
            "GMAIL_RECEIPT_INVALID_RESPONSE": ("Gmail returned an invalid receipt response."),
            "GMAIL_RECEIPT_EXTRACTION_INVALID": ("Receipt extraction returned an invalid result."),
            "GMAIL_RECEIPT_EXTRACTION_UNVERIFIED": (
                "Receipt extraction could not be verified from the message."
            ),
            "GMAIL_RECEIPT_EXTRACTION_UNAVAILABLE": (
                "Receipt extraction is temporarily unavailable."
            ),
            "GMAIL_RECEIPT_EXTRACTION_TIMEOUT": ("Receipt extraction timed out. Please try again."),
        }
        return HTTPException(
            status_code=max(400, min(599, int(exc.status_code))),
            detail={
                "code": code if code in safe_messages else "GMAIL_RECEIPT_UNAVAILABLE",
                "message": safe_messages.get(
                    code,
                    "Receipts are temporarily unavailable. Please try again.",
                ),
            },
            headers={"Cache-Control": "private, no-store", "Pragma": "no-cache"},
        )
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail={
            "code": "GMAIL_RECEIPT_UNAVAILABLE",
            "message": "Receipts are temporarily unavailable. Please try again.",
        },
        headers={"Cache-Control": "private, no-store", "Pragma": "no-cache"},
    )


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["Pragma"] = "no-cache"


_DEPENDENCY_ERROR_PATTERNS = (
    "connection refused",
    "server closed the connection unexpectedly",
    "could not connect to server",
    "timed out",
    "timeout",
    "headers timeout",
    "db operation failed",
    "psycopg2.operationalerror",
    "sqlalchemy.exc.operationalerror",
)


def _iter_exception_chain(exc: BaseException):
    current: BaseException | None = exc
    seen: set[int] = set()
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        yield current
        current = current.__cause__ or current.__context__


def _is_dependency_unavailable_error(exc: Exception) -> bool:
    for current in _iter_exception_chain(exc):
        if current.__class__.__name__ == "DatabaseExecutionError":
            return True
        if isinstance(current, SqlalchemyOperationalError):
            return True
        if isinstance(current, (ConnectionError, OSError, TimeoutError)):
            return True
        message = str(current).strip().lower()
        if message and any(pattern in message for pattern in _DEPENDENCY_ERROR_PATTERNS):
            return True
    return False


def _temporary_unavailable_message(operation: str) -> str:
    if operation == "status":
        return "We couldn't check your Gmail connection right now. Please try again in a moment."
    if operation == "sync":
        return "We couldn't start Gmail sync right now. Please try again in a moment."
    if operation == "receipts":
        return "We couldn't load your receipts right now. Please try again in a moment."
    if operation == "receipts_memory_preview":
        return "We couldn't create your shopping summary right now. Please try again in a moment."
    if operation == "connect_start":
        return "We couldn't start Gmail connect right now. Please try again in a moment."
    if operation == "connect_complete":
        return "We couldn't finish Gmail connect right now. Please try again in a moment."
    if operation == "disconnect":
        return "We couldn't disconnect Gmail right now. Please try again in a moment."
    if operation == "reconcile":
        return "We couldn't refresh your Gmail connection right now. Please try again in a moment."
    if operation == "sync_run":
        return "We couldn't load Gmail sync details right now. Please try again in a moment."
    if operation == "receipts_memory_artifact":
        return "We couldn't load your shopping summary right now. Please try again in a moment."
    if operation == "webhook":
        return "We couldn't process the Gmail webhook right now. Please try again in a moment."
    return "Gmail is temporarily unavailable. Please try again in a moment."


def _to_http_exception(exc: Exception, *, operation: str) -> HTTPException:
    if isinstance(exc, GmailReceiptStorageCutoverError):
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "GMAIL_RECEIPT_STORAGE_MIGRATION",
                "message": str(exc),
                "retryable": False,
            },
        )
    if _is_dependency_unavailable_error(exc):
        return HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "GMAIL_CONNECTOR_TEMPORARILY_UNAVAILABLE",
                "message": _temporary_unavailable_message(operation),
                "retryable": True,
            },
        )
    if isinstance(exc, GmailApiError):
        detail: dict[str, Any] = {
            "code": exc.code or "GMAIL_CONNECTOR_ERROR",
            "message": str(exc),
        }
        if exc.payload:
            detail["payload"] = exc.payload
        status_code = exc.status_code if exc.status_code >= 400 else 500
        return HTTPException(status_code=status_code, detail=detail)
    return HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail={
            "code": "GMAIL_CONNECTOR_UNEXPECTED",
            "message": _temporary_unavailable_message(operation),
        },
    )


@router.post("/gmail/connect/start")
async def gmail_connect_start(
    payload: GmailConnectStartRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, payload.user_id)
    try:
        return await _service().start_connect(
            user_id=payload.user_id,
            redirect_uri=payload.redirect_uri,
            login_hint=payload.login_hint,
            include_granted_scopes=payload.include_granted_scopes,
            purpose=payload.purpose,
        )
    except Exception as exc:
        logger.exception("kai.gmail.connect_start_failed user_id=%s", payload.user_id)
        raise _to_http_exception(exc, operation="connect_start") from exc


@router.post("/gmail/connect/complete")
async def gmail_connect_complete(
    payload: GmailConnectCompleteRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, payload.user_id)
    try:
        return await _service().complete_connect(
            user_id=payload.user_id,
            code=payload.code,
            state=payload.state,
            redirect_uri=payload.redirect_uri,
        )
    except Exception as exc:
        logger.exception("kai.gmail.connect_complete_failed user_id=%s", payload.user_id)
        raise _to_http_exception(exc, operation="connect_complete") from exc


@router.post("/gmail/connect/native/start")
async def gmail_native_connect_start(
    payload: GmailNativeConnectStartRequest | None = None,
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return await _service().start_native_connect(purpose=payload.purpose if payload else "read")
    except Exception as exc:
        logger.exception("kai.gmail.native_connect_start_failed user_id=%s", firebase_uid)
        raise _to_http_exception(exc, operation="connect_start") from exc


@router.post("/gmail/connect/native/complete")
async def gmail_native_connect_complete(
    payload: GmailNativeConnectCompleteRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, payload.user_id)
    try:
        return await _service().complete_native_connect(
            user_id=payload.user_id,
            server_auth_code=payload.server_auth_code,
        )
    except Exception as exc:
        logger.exception("kai.gmail.native_connect_complete_failed user_id=%s", payload.user_id)
        raise _to_http_exception(exc, operation="connect_complete") from exc


@router.get("/gmail/status/{user_id}")
async def gmail_status(
    user_id: str = Path(..., min_length=1, max_length=128),
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, user_id)
    try:
        return await _service().get_status(user_id=user_id)
    except Exception as exc:
        logger.exception("kai.gmail.status_failed user_id=%s", user_id)
        raise _to_http_exception(exc, operation="status") from exc


@router.post("/gmail/disconnect")
async def gmail_disconnect(
    payload: GmailDisconnectRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, payload.user_id)
    try:
        return await _service().disconnect(user_id=payload.user_id)
    except Exception as exc:
        logger.exception("kai.gmail.disconnect_failed user_id=%s", payload.user_id)
        raise _to_http_exception(exc, operation="disconnect") from exc


@router.post("/gmail/sync")
async def gmail_sync(
    payload: GmailSyncRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, payload.user_id)
    try:
        result = await _service().queue_sync(
            user_id=payload.user_id,
            trigger_source="manual",
        )
        return result
    except Exception as exc:
        logger.exception("kai.gmail.sync_failed user_id=%s", payload.user_id)
        raise _to_http_exception(exc, operation="sync") from exc


@router.post("/gmail/reconcile")
async def gmail_reconcile(
    payload: GmailReconcileRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, payload.user_id)
    try:
        return await _service().reconcile_connection(
            user_id=payload.user_id,
            allow_queue_catchup=True,
        )
    except Exception as exc:
        logger.exception("kai.gmail.reconcile_failed user_id=%s", payload.user_id)
        raise _to_http_exception(exc, operation="reconcile") from exc


@router.get("/gmail/sync/{run_id}")
async def gmail_sync_run(
    run_id: str,
    user_id: str = Query(..., min_length=1, max_length=128),
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, user_id)
    try:
        run = await _service().get_sync_run(run_id=run_id, user_id=user_id)
        if run is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={
                    "code": "GMAIL_SYNC_RUN_NOT_FOUND",
                    "message": "No Gmail sync run found for this user.",
                    "run_id": run_id,
                },
            )
        return {"run": run}
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("kai.gmail.sync_run_failed user_id=%s run_id=%s", user_id, run_id)
        raise _to_http_exception(exc, operation="sync_run") from exc


@router.get("/gmail/receipts/{user_id}")
async def gmail_receipts(
    user_id: str = Path(..., min_length=1, max_length=128),
    page: int = Query(1, ge=1, le=1_000),
    per_page: int = Query(25, ge=1, le=100),
    firebase_uid: str = Depends(require_firebase_auth),
    token_data: dict = Depends(require_vault_owner_token),
):
    """Ensures VAULT_OWNER consent scope is verified before accessing PII artifacts."""
    verify_user_id_match(firebase_uid, user_id)
    if token_data["user_id"] != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User ID does not match token",
        )
    try:
        return await _service().list_receipts(
            user_id=user_id,
            page=page,
            per_page=per_page,
        )
    except Exception as exc:
        logger.exception("kai.gmail.receipts_failed user_id=%s", user_id)
        raise _to_http_exception(exc, operation="receipts") from exc


@router.post("/gmail/receipts/scan", response_model=GmailLiveReceiptScanResponse)
async def gmail_live_receipt_scan(
    payload: GmailLiveReceiptScanRequest,
    request: Request,
    response: Response,
    firebase_uid: str = Depends(require_firebase_auth),
    token_data: dict = Depends(require_vault_owner_token),
):
    """Read one bounded Gmail receipt page without touching the legacy cache."""

    owner = _live_receipt_owner(
        firebase_uid=firebase_uid,
        token_data=token_data,
        requested_user_id=payload.user_id,
    )
    _no_store(response)
    access_check_count = 0

    async def require_current_access() -> None:
        nonlocal access_check_count
        access_check_count += 1
        # The dependency already performed the database-backed vault-owner
        # check immediately before entering this receipt route. The service's
        # first callback occurs before its Gmail read, so reuse that result;
        # every later callback revalidates before information is returned.
        if access_check_count == 1:
            return
        await _revalidate_live_receipt_access(token_data=token_data, owner=owner)

    try:
        result = await _await_live_receipt_scan(
            request=request,
            operation=_live_receipts_service().scan(
                user_id=owner,
                consent_token=str(token_data.get("token") or ""),
                require_access=require_current_access,
                page=payload.page,
                per_page=payload.per_page,
                cursor=payload.cursor,
            ),
        )
        coverage = result.get("coverage") if isinstance(result, dict) else None
        logger.info(
            "kai.gmail.live_receipt_scan_completed page=%s returned_count=%s "
            "listed_count=%s candidate_count=%s matched_count=%s has_more=%s "
            "missing_signal_count=%s model_rejected_count=%s",
            payload.page,
            result.get("returned_count") if isinstance(result, dict) else None,
            coverage.get("listed_count") if isinstance(coverage, dict) else None,
            coverage.get("candidate_count") if isinstance(coverage, dict) else None,
            coverage.get("matched_count") if isinstance(coverage, dict) else None,
            result.get("has_more") if isinstance(result, dict) else None,
            (
                coverage.get("rejection_counts", {}).get("missing_receipt_signal")
                if isinstance(coverage, dict) and isinstance(coverage.get("rejection_counts"), dict)
                else None
            ),
            (
                coverage.get("rejection_counts", {}).get("extractor_not_receipt")
                if isinstance(coverage, dict) and isinstance(coverage.get("rejection_counts"), dict)
                else None
            ),
        )
        return result
    except HTTPException:
        raise
    except Exception as exc:
        safe_error = _live_receipt_http_error(exc)
        logger.warning(
            "kai.gmail.live_receipt_scan_failed error=%s code=%s",
            type(exc).__name__,
            safe_error.detail["code"],
        )
        raise safe_error from None


@router.post("/gmail/receipts/detail", response_model=GmailLiveReceiptDetailResponse)
async def gmail_live_receipt_detail(
    payload: GmailLiveReceiptDetailRequest,
    response: Response,
    firebase_uid: str = Depends(require_firebase_auth),
    token_data: dict = Depends(require_vault_owner_token),
):
    """Read only the selected receipt from the currently connected Gmail account."""

    owner = _live_receipt_owner(
        firebase_uid=firebase_uid,
        token_data=token_data,
        requested_user_id=payload.user_id,
    )
    _no_store(response)
    access_check_count = 0

    async def require_current_access() -> None:
        nonlocal access_check_count
        access_check_count += 1
        if access_check_count == 1:
            return
        await _revalidate_live_receipt_access(token_data=token_data, owner=owner)

    try:
        result = await _live_receipts_service().detail(
            user_id=owner,
            source_id=payload.source_id,
            consent_token=str(token_data.get("token") or ""),
            require_access=require_current_access,
        )
        logger.info(
            "kai.gmail.live_receipt_detail_completed has_excerpt=%s",
            bool(result.get("email_excerpt")) if isinstance(result, dict) else False,
        )
        return result
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("kai.gmail.live_receipt_detail_failed error=%s", type(exc).__name__)
        raise _live_receipt_http_error(exc) from None


@router.get("/gmail/nudges/{user_id}")
async def gmail_nudges(
    user_id: str = Path(..., min_length=1, max_length=128),
    limit: int = Query(10, ge=1, le=50),
    firebase_uid: str = Depends(require_firebase_auth),
    token_data: dict = Depends(require_vault_owner_token),
):
    """Derive inbox flashcard nudges ("Needs a reply") from the connected Gmail
    account. Reuses the receipts gmail.readonly connection — no new scope. Verifies
    VAULT_OWNER consent before any inbox access."""
    verify_user_id_match(firebase_uid, user_id)
    if token_data["user_id"] != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User ID does not match token",
        )
    try:
        return await _service().list_nudges(user_id=user_id, limit=limit)
    except Exception as exc:
        logger.exception("kai.gmail.nudges_failed user_id=%s", user_id)
        raise _to_http_exception(exc, operation="nudges") from exc


@router.post("/gmail/receipts-memory/preview")
async def gmail_receipts_memory_preview(
    payload: GmailReceiptMemoryPreviewRequest,
    firebase_uid: str = Depends(require_firebase_auth),
    token_data: dict = Depends(require_vault_owner_token),
):
    """Ensures VAULT_OWNER consent scope is verified before accessing PII artifacts."""
    verify_user_id_match(firebase_uid, payload.user_id)
    if token_data["user_id"] != payload.user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User ID does not match token",
        )
    try:
        return await _receipt_memory_service().build_preview(
            user_id=payload.user_id,
            force_refresh=payload.force_refresh,
            consent_token=str(token_data.get("token") or ""),
        )
    except Exception as exc:
        logger.exception("kai.gmail.receipts_memory_preview_failed user_id=%s", payload.user_id)
        raise _to_http_exception(exc, operation="receipts_memory_preview") from exc


@router.get("/gmail/receipts-memory/artifacts/{artifact_id}")
async def gmail_receipts_memory_artifact(
    artifact_id: str,
    user_id: str = Query(..., min_length=1, max_length=128),
    firebase_uid: str = Depends(require_firebase_auth),
    token_data: dict = Depends(require_vault_owner_token),
):
    """Ensures VAULT_OWNER consent scope is verified before accessing PII artifacts."""
    verify_user_id_match(firebase_uid, user_id)
    if token_data["user_id"] != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User ID does not match token",
        )
    try:
        artifact = _receipt_memory_service().get_artifact(
            artifact_id=artifact_id,
            user_id=user_id,
        )
        if artifact is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={
                    "code": "GMAIL_RECEIPT_MEMORY_ARTIFACT_NOT_FOUND",
                    "message": "No receipt-memory artifact found for this user.",
                    "artifact_id": artifact_id,
                },
            )
        return artifact
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(
            "kai.gmail.receipts_memory_artifact_failed user_id=%s artifact_id=%s",
            user_id,
            artifact_id,
        )
        raise _to_http_exception(exc, operation="receipts_memory_artifact") from exc


@router.post("/gmail/webhook")
async def gmail_webhook(request: Request):
    headers = {key.lower(): value for key, value in request.headers.items()}
    try:
        payload = await request.json()
    except Exception as exc:
        logger.warning("kai.gmail.webhook.invalid_json: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "GMAIL_WEBHOOK_INVALID_JSON",
                "message": "Webhook payload is not valid JSON.",
            },
        ) from exc

    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "GMAIL_WEBHOOK_INVALID_PAYLOAD",
                "message": "Webhook payload must be a JSON object.",
            },
        )

    try:
        return await _service().handle_push_notification(payload, headers=headers)
    except Exception as exc:
        logger.exception("kai.gmail.webhook_failed")
        raise _to_http_exception(exc, operation="webhook") from exc
