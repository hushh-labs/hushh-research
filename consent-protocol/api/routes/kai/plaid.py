"""Kai Plaid portfolio source routes."""

from __future__ import annotations

import json
import logging
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from api.middleware import require_consent_scope, require_vault_owner_token
from hushh_mcp.integrations.alpaca import AlpacaApiError
from hushh_mcp.services.broker_funding_service import (
    FundingOrchestrationError,
    PlaidWebhookVerificationError,
    get_broker_funding_service,
)
from hushh_mcp.services.plaid_portfolio_service import (
    PlaidApiError,
    get_plaid_portfolio_service,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Kai Plaid"])
require_transfer_scope_token = require_consent_scope("brokerage.transfer.write")


class PlaidLinkTokenRequest(BaseModel):
    user_id: str
    item_id: Optional[str] = None
    redirect_uri: Optional[str] = None


class PlaidPublicTokenExchangeRequest(BaseModel):
    user_id: str
    public_token: str
    metadata: dict[str, Any] | None = None
    resume_session_id: Optional[str] = None
    terms_version: str | None = None
    consent_timestamp: str | None = None
    alpaca_account_id: str | None = None


class PlaidOAuthResumeRequest(BaseModel):
    user_id: str
    resume_session_id: str = Field(min_length=1)


class PlaidRefreshRequest(BaseModel):
    user_id: str
    item_id: str | None = None


class PlaidSourcePreferenceRequest(BaseModel):
    user_id: str
    active_source: Literal["statement", "plaid"]


class PlaidRefreshCancelRequest(BaseModel):
    user_id: str


class PlaidFundingTransactionsSyncRequest(BaseModel):
    user_id: str
    item_id: str = Field(min_length=1)
    cursor: str | None = None


class PlaidFundingDefaultAccountRequest(BaseModel):
    user_id: str
    item_id: str = Field(min_length=1)
    account_id: str = Field(min_length=1)


class PlaidFundingBrokerageAccountRequest(BaseModel):
    user_id: str
    alpaca_account_id: str | None = Field(default=None, min_length=1)
    set_default: bool = True


class PlaidTransferCreateRequest(BaseModel):
    user_id: str
    funding_item_id: str = Field(min_length=1)
    funding_account_id: str = Field(min_length=1)
    amount: float = Field(gt=0)
    user_legal_name: str = Field(min_length=1)
    direction: Literal["to_brokerage", "from_brokerage"] = "to_brokerage"
    network: str = "ach"
    ach_class: str = "web"
    description: str | None = None
    idempotency_key: str | None = None
    brokerage_item_id: str | None = None
    brokerage_account_id: str | None = None
    relationship_id: str | None = None
    redirect_uri: str | None = None


class PlaidFundingReconciliationRequest(BaseModel):
    user_id: str
    max_rows: int = Field(default=200, ge=1, le=1000)
    trigger_source: str = "manual"


class PlaidFundingEscalationRequest(BaseModel):
    user_id: str
    transfer_id: str | None = None
    relationship_id: str | None = None
    severity: Literal["low", "normal", "high", "urgent"] = "normal"
    notes: str = Field(min_length=1)
    created_by: str | None = None


class AlpacaConnectStartRequest(BaseModel):
    user_id: str
    redirect_uri: str | None = None


class AlpacaConnectCompleteRequest(BaseModel):
    user_id: str
    state: str = Field(min_length=1)
    code: str = Field(min_length=1)


class PlaidFundedTradeCreateRequest(BaseModel):
    user_id: str
    funding_item_id: str = Field(min_length=1)
    funding_account_id: str = Field(min_length=1)
    symbol: str = Field(min_length=1)
    user_legal_name: str = Field(min_length=1)
    notional_usd: float = Field(gt=0)
    side: Literal["buy", "sell"] = "buy"
    order_type: Literal["market", "limit"] = "market"
    time_in_force: Literal["day", "gtc", "opg", "cls", "ioc", "fok"] = "day"
    limit_price: float | None = Field(default=None, gt=0)
    brokerage_account_id: str | None = None
    transfer_idempotency_key: str | None = None
    trade_idempotency_key: str | None = None


class PlaidFundedTradeRefreshRequest(BaseModel):
    user_id: str


def _verify_user(token_data: dict[str, Any], requested_user_id: str) -> None:
    if token_data["user_id"] != requested_user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User ID does not match token",
        )


def _to_http_exception(error: Exception) -> HTTPException:
    if isinstance(error, FundingOrchestrationError):
        return HTTPException(
            status_code=error.status_code,
            detail={
                "code": error.code,
                "message": str(error),
                "details": error.details,
            },
        )
    if isinstance(error, PlaidWebhookVerificationError):
        return HTTPException(
            status_code=error.status_code,
            detail={
                "code": error.code,
                "message": str(error),
                "details": error.details,
            },
        )
    if isinstance(error, PlaidApiError):
        detail = {
            "code": error.error_code or "PLAID_API_ERROR",
            "message": str(error),
            "error_type": error.error_type,
            "display_message": error.display_message,
            "payload": error.payload,
        }
        status_code = error.status_code if error.status_code >= 400 else 502
        return HTTPException(status_code=status_code, detail=detail)
    if isinstance(error, AlpacaApiError):
        detail = {
            "code": error.error_code or "ALPACA_API_ERROR",
            "message": str(error),
            "payload": error.payload,
        }
        status_code = error.status_code if error.status_code >= 400 else 502
        return HTTPException(status_code=status_code, detail=detail)
    if isinstance(error, RuntimeError):
        message = str(error)
        if message == "No active Plaid Item is available to refresh.":
            return HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "PLAID_REFRESH_UNAVAILABLE",
                    "message": message,
                },
            )
    return HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail={"code": "PLAID_ROUTE_FAILURE", "message": str(error)},
    )


def _raise_logged_http_exception(
    route_name: str,
    user_id: str,
    error: Exception,
) -> None:
    http_exc = _to_http_exception(error)
    if http_exc.status_code >= 500:
        logger.exception("%s user_id=%s", route_name, user_id)
    else:
        logger.warning(
            "%s user_id=%s status=%s detail=%s",
            route_name,
            user_id,
            http_exc.status_code,
            http_exc.detail,
        )
    raise http_exc from error


@router.get("/plaid/status/{user_id}")
async def get_plaid_status(
    user_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    _verify_user(token_data, user_id)
    try:
        return await get_plaid_portfolio_service().get_status(user_id=user_id)
    except Exception as exc:
        logger.exception("kai.plaid.status_failed user_id=%s", user_id)
        raise _to_http_exception(exc) from exc


@router.post("/plaid/link-token")
async def create_plaid_link_token(
    request: PlaidLinkTokenRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    _verify_user(token_data, request.user_id)
    try:
        return await get_plaid_portfolio_service().create_link_token(
            user_id=request.user_id,
            item_id=request.item_id,
            redirect_uri=request.redirect_uri,
        )
    except Exception as exc:
        logger.exception("kai.plaid.link_token_failed user_id=%s", request.user_id)
        raise _to_http_exception(exc) from exc


@router.post("/plaid/link-token/update")
async def create_plaid_update_link_token(
    request: PlaidLinkTokenRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    _verify_user(token_data, request.user_id)
    if not request.item_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "PLAID_ITEM_ID_REQUIRED",
                "message": "item_id is required for update mode.",
            },
        )
    try:
        return await get_plaid_portfolio_service().create_link_token(
            user_id=request.user_id,
            item_id=request.item_id,
            redirect_uri=request.redirect_uri,
        )
    except Exception as exc:
        logger.exception("kai.plaid.update_link_token_failed user_id=%s", request.user_id)
        raise _to_http_exception(exc) from exc


@router.post("/plaid/exchange-public-token")
async def exchange_plaid_public_token(
    request: PlaidPublicTokenExchangeRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    _verify_user(token_data, request.user_id)
    try:
        return await get_plaid_portfolio_service().exchange_public_token(
            user_id=request.user_id,
            public_token=request.public_token,
            metadata=request.metadata,
            resume_session_id=request.resume_session_id,
        )
    except Exception as exc:
        _raise_logged_http_exception("kai.plaid.exchange_failed", request.user_id, exc)


@router.post("/plaid/funding/link-token")
async def create_plaid_funding_link_token(
    request: PlaidLinkTokenRequest,
    token_data: dict = Depends(require_transfer_scope_token),
):
    _verify_user(token_data, request.user_id)
    try:
        return await get_broker_funding_service().create_funding_link_token(
            user_id=request.user_id,
            item_id=request.item_id,
            redirect_uri=request.redirect_uri,
        )
    except Exception as exc:
        _raise_logged_http_exception("kai.plaid.funding_link_token_failed", request.user_id, exc)


@router.post("/plaid/funding/exchange-public-token")
async def exchange_plaid_funding_public_token(
    request: PlaidPublicTokenExchangeRequest,
    token_data: dict = Depends(require_transfer_scope_token),
):
    _verify_user(token_data, request.user_id)
    try:
        return await get_broker_funding_service().exchange_funding_public_token(
            user_id=request.user_id,
            public_token=request.public_token,
            metadata=request.metadata,
            resume_session_id=request.resume_session_id,
            terms_version=request.terms_version,
            consent_timestamp=request.consent_timestamp,
            alpaca_account_id=request.alpaca_account_id,
        )
    except Exception as exc:
        _raise_logged_http_exception("kai.plaid.funding_exchange_failed", request.user_id, exc)


@router.get("/plaid/funding/status/{user_id}")
async def get_plaid_funding_status(
    user_id: str,
    token_data: dict = Depends(require_transfer_scope_token),
):
    _verify_user(token_data, user_id)
    try:
        return await get_broker_funding_service().get_funding_status(user_id=user_id)
    except Exception as exc:
        _raise_logged_http_exception("kai.plaid.funding_status_failed", user_id, exc)


@router.post("/plaid/funding/transactions/sync")
async def sync_plaid_funding_transactions(
    request: PlaidFundingTransactionsSyncRequest,
    token_data: dict = Depends(require_transfer_scope_token),
):
    _verify_user(token_data, request.user_id)
    try:
        return await get_broker_funding_service().sync_funding_transactions(
            user_id=request.user_id,
            item_id=request.item_id,
            cursor=request.cursor,
        )
    except Exception as exc:
        _raise_logged_http_exception(
            "kai.plaid.funding_transactions_sync_failed", request.user_id, exc
        )


@router.post("/plaid/funding/default-account")
async def set_plaid_funding_default_account(
    request: PlaidFundingDefaultAccountRequest,
    token_data: dict = Depends(require_transfer_scope_token),
):
    _verify_user(token_data, request.user_id)
    try:
        return await get_broker_funding_service().set_default_funding_account(
            user_id=request.user_id,
            item_id=request.item_id,
            account_id=request.account_id,
        )
    except Exception as exc:
        _raise_logged_http_exception(
            "kai.plaid.funding_default_account_failed",
            request.user_id,
            exc,
        )


@router.post("/plaid/funding/brokerage-account")
async def set_plaid_funding_brokerage_account(
    request: PlaidFundingBrokerageAccountRequest,
    token_data: dict = Depends(require_transfer_scope_token),
):
    _verify_user(token_data, request.user_id)
    try:
        return await get_broker_funding_service().set_brokerage_account(
            user_id=request.user_id,
            alpaca_account_id=request.alpaca_account_id,
            set_default=request.set_default,
        )
    except Exception as exc:
        _raise_logged_http_exception(
            "kai.plaid.funding_brokerage_account_failed",
            request.user_id,
            exc,
        )


@router.post("/alpaca/connect/start")
async def start_alpaca_connect(
    request: AlpacaConnectStartRequest,
    token_data: dict = Depends(require_transfer_scope_token),
):
    _verify_user(token_data, request.user_id)
    try:
        return await get_broker_funding_service().create_alpaca_connect_link(
            user_id=request.user_id,
            redirect_uri=request.redirect_uri,
        )
    except Exception as exc:
        _raise_logged_http_exception("kai.alpaca.connect_start_failed", request.user_id, exc)


@router.post("/alpaca/connect/complete")
async def complete_alpaca_connect(
    request: AlpacaConnectCompleteRequest,
    token_data: dict = Depends(require_transfer_scope_token),
):
    _verify_user(token_data, request.user_id)
    try:
        return await get_broker_funding_service().complete_alpaca_connect_link(
            user_id=request.user_id,
            state=request.state,
            code=request.code,
        )
    except Exception as exc:
        _raise_logged_http_exception("kai.alpaca.connect_complete_failed", request.user_id, exc)


@router.post("/plaid/transfers/create")
async def create_plaid_transfer(
    request: PlaidTransferCreateRequest,
    token_data: dict = Depends(require_transfer_scope_token),
):
    _verify_user(token_data, request.user_id)
    try:
        return await get_broker_funding_service().create_transfer(
            user_id=request.user_id,
            funding_item_id=request.funding_item_id,
            funding_account_id=request.funding_account_id,
            amount=request.amount,
            user_legal_name=request.user_legal_name,
            direction=request.direction,
            network=request.network,
            ach_class=request.ach_class,
            description=request.description,
            idempotency_key=request.idempotency_key,
            brokerage_item_id=request.brokerage_item_id,
            brokerage_account_id=request.brokerage_account_id,
            relationship_id=request.relationship_id,
            redirect_uri=request.redirect_uri,
        )
    except Exception as exc:
        _raise_logged_http_exception("kai.plaid.transfer_create_failed", request.user_id, exc)


@router.post("/plaid/trades/funded/create")
async def create_plaid_funded_trade(
    request: PlaidFundedTradeCreateRequest,
    token_data: dict = Depends(require_transfer_scope_token),
):
    _verify_user(token_data, request.user_id)
    try:
        return await get_broker_funding_service().create_funded_trade_intent(
            user_id=request.user_id,
            funding_item_id=request.funding_item_id,
            funding_account_id=request.funding_account_id,
            symbol=request.symbol,
            user_legal_name=request.user_legal_name,
            notional_usd=request.notional_usd,
            side=request.side,
            order_type=request.order_type,
            time_in_force=request.time_in_force,
            limit_price=request.limit_price,
            brokerage_account_id=request.brokerage_account_id,
            transfer_idempotency_key=request.transfer_idempotency_key,
            trade_idempotency_key=request.trade_idempotency_key,
        )
    except Exception as exc:
        _raise_logged_http_exception("kai.plaid.funded_trade_create_failed", request.user_id, exc)


@router.get("/plaid/trades/funded")
async def list_plaid_funded_trades(
    user_id: str,
    limit: int = 20,
    token_data: dict = Depends(require_transfer_scope_token),
):
    _verify_user(token_data, user_id)
    try:
        return await get_broker_funding_service().list_funded_trade_intents(
            user_id=user_id,
            limit=limit,
        )
    except Exception as exc:
        _raise_logged_http_exception("kai.plaid.funded_trade_list_failed", user_id, exc)


@router.get("/plaid/trades/funded/{intent_id}")
async def get_plaid_funded_trade(
    intent_id: str,
    user_id: str,
    token_data: dict = Depends(require_transfer_scope_token),
):
    _verify_user(token_data, user_id)
    try:
        return await get_broker_funding_service().get_funded_trade_intent(
            user_id=user_id,
            intent_id=intent_id,
        )
    except Exception as exc:
        _raise_logged_http_exception("kai.plaid.funded_trade_get_failed", user_id, exc)


@router.post("/plaid/trades/funded/{intent_id}/refresh")
async def refresh_plaid_funded_trade(
    intent_id: str,
    request: PlaidFundedTradeRefreshRequest,
    token_data: dict = Depends(require_transfer_scope_token),
):
    _verify_user(token_data, request.user_id)
    try:
        return await get_broker_funding_service().get_funded_trade_intent(
            user_id=request.user_id,
            intent_id=intent_id,
        )
    except Exception as exc:
        _raise_logged_http_exception(
            "kai.plaid.funded_trade_refresh_failed",
            request.user_id,
            exc,
        )


@router.get("/plaid/transfers/{transfer_id}")
async def get_plaid_transfer(
    transfer_id: str,
    user_id: str,
    token_data: dict = Depends(require_transfer_scope_token),
):
    _verify_user(token_data, user_id)
    try:
        return await get_broker_funding_service().get_transfer(
            user_id=user_id,
            transfer_id=transfer_id,
        )
    except Exception as exc:
        _raise_logged_http_exception("kai.plaid.transfer_get_failed", user_id, exc)


@router.post("/plaid/transfers/{transfer_id}/cancel")
async def cancel_plaid_transfer(
    transfer_id: str,
    request: PlaidRefreshCancelRequest,
    token_data: dict = Depends(require_transfer_scope_token),
):
    _verify_user(token_data, request.user_id)
    try:
        return await get_broker_funding_service().cancel_transfer(
            user_id=request.user_id,
            transfer_id=transfer_id,
        )
    except Exception as exc:
        _raise_logged_http_exception("kai.plaid.transfer_cancel_failed", request.user_id, exc)


@router.get("/plaid/funding/admin/search")
async def search_plaid_funding_records(
    user_id: str | None = None,
    transfer_id: str | None = None,
    relationship_id: str | None = None,
    limit: int = 50,
    token_data: dict = Depends(require_transfer_scope_token),
):
    effective_user_id = user_id or token_data["user_id"]
    _verify_user(token_data, effective_user_id)
    try:
        return await get_broker_funding_service().search_transfer_records(
            user_id=effective_user_id,
            transfer_id=transfer_id,
            relationship_id=relationship_id,
            limit=limit,
        )
    except Exception as exc:
        _raise_logged_http_exception("kai.plaid.funding_search_failed", effective_user_id, exc)


@router.post("/plaid/funding/admin/transfers/{transfer_id}/refresh")
async def refresh_plaid_transfer_status(
    transfer_id: str,
    request: PlaidRefreshCancelRequest,
    token_data: dict = Depends(require_transfer_scope_token),
):
    _verify_user(token_data, request.user_id)
    try:
        return await get_broker_funding_service().get_transfer(
            user_id=request.user_id,
            transfer_id=transfer_id,
        )
    except Exception as exc:
        _raise_logged_http_exception(
            "kai.plaid.funding_refresh_transfer_failed", request.user_id, exc
        )


@router.post("/plaid/funding/admin/escalations")
async def create_plaid_funding_escalation(
    request: PlaidFundingEscalationRequest,
    token_data: dict = Depends(require_transfer_scope_token),
):
    _verify_user(token_data, request.user_id)
    try:
        return await get_broker_funding_service().create_support_escalation(
            user_id=request.user_id,
            transfer_id=request.transfer_id,
            relationship_id=request.relationship_id,
            notes=request.notes,
            severity=request.severity,
            created_by=request.created_by or token_data.get("agent_id"),
        )
    except Exception as exc:
        _raise_logged_http_exception("kai.plaid.funding_escalation_failed", request.user_id, exc)


@router.post("/plaid/funding/reconcile")
async def reconcile_plaid_funding_transfers(
    request: PlaidFundingReconciliationRequest,
    token_data: dict = Depends(require_transfer_scope_token),
):
    _verify_user(token_data, request.user_id)
    try:
        return await get_broker_funding_service().run_reconciliation(
            user_id=request.user_id,
            trigger_source=request.trigger_source,
            max_rows=request.max_rows,
        )
    except Exception as exc:
        _raise_logged_http_exception("kai.plaid.funding_reconcile_failed", request.user_id, exc)


@router.post("/plaid/oauth/resume")
async def resume_plaid_oauth(
    request: PlaidOAuthResumeRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    _verify_user(token_data, request.user_id)
    try:
        result = await get_plaid_portfolio_service().get_oauth_resume(
            user_id=request.user_id,
            resume_session_id=request.resume_session_id,
        )
        if result is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={
                    "code": "PLAID_OAUTH_RESUME_NOT_FOUND",
                    "message": "No active Plaid OAuth resume session was found.",
                    "resume_session_id": request.resume_session_id,
                },
            )
        return result
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("kai.plaid.oauth_resume_failed user_id=%s", request.user_id)
        raise _to_http_exception(exc) from exc


@router.post("/plaid/refresh")
async def refresh_plaid_connections(
    request: PlaidRefreshRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    _verify_user(token_data, request.user_id)
    try:
        return await get_plaid_portfolio_service().refresh_items(
            user_id=request.user_id,
            item_id=request.item_id,
            trigger_source="manual_refresh",
        )
    except Exception as exc:
        _raise_logged_http_exception("kai.plaid.refresh_failed", request.user_id, exc)


@router.get("/plaid/refresh/{run_id}")
async def get_plaid_refresh_run(
    run_id: str,
    user_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    _verify_user(token_data, user_id)
    try:
        run = await get_plaid_portfolio_service().get_refresh_run_status(
            user_id=user_id,
            run_id=run_id,
        )
        if run is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={
                    "code": "PLAID_REFRESH_RUN_NOT_FOUND",
                    "message": "No Plaid refresh run found for this user.",
                    "run_id": run_id,
                },
            )
        return {"run": run}
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("kai.plaid.refresh_run_failed user_id=%s run_id=%s", user_id, run_id)
        raise _to_http_exception(exc) from exc


@router.post("/plaid/refresh/{run_id}/cancel")
async def cancel_plaid_refresh_run(
    run_id: str,
    request: PlaidRefreshCancelRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    _verify_user(token_data, request.user_id)
    try:
        run = await get_plaid_portfolio_service().cancel_refresh_run(
            user_id=request.user_id,
            run_id=run_id,
        )
        if run is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={
                    "code": "PLAID_REFRESH_RUN_NOT_FOUND",
                    "message": "No Plaid refresh run found for this user.",
                    "run_id": run_id,
                },
            )
        return {"run": run}
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(
            "kai.plaid.refresh_cancel_failed user_id=%s run_id=%s",
            request.user_id,
            run_id,
        )
        raise _to_http_exception(exc) from exc


@router.post("/plaid/source")
async def set_plaid_source_preference(
    request: PlaidSourcePreferenceRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    _verify_user(token_data, request.user_id)
    try:
        active_source = get_plaid_portfolio_service().set_active_source(
            user_id=request.user_id,
            active_source=request.active_source,
        )
        return {"user_id": request.user_id, "active_source": active_source}
    except Exception as exc:
        logger.exception("kai.plaid.source_preference_failed user_id=%s", request.user_id)
        raise _to_http_exception(exc) from exc


@router.post("/plaid/webhook")
async def plaid_webhook(request: Request):
    try:
        raw_body = await request.body()
        payload = json.loads(raw_body.decode("utf-8"))
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "PLAID_WEBHOOK_INVALID_JSON", "message": str(exc)},
        ) from exc

    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "PLAID_WEBHOOK_INVALID_PAYLOAD",
                "message": "Webhook payload must be a JSON object.",
            },
        )

    try:
        headers = {key: value for key, value in request.headers.items()}
        funding_result = await get_broker_funding_service().handle_plaid_webhook(
            payload,
            raw_body=raw_body,
            headers=headers,
        )
        if bool(funding_result.get("handled")):
            return funding_result

        plaid_result = await get_plaid_portfolio_service().handle_webhook(payload)
        if isinstance(plaid_result, dict):
            plaid_result["funding_webhook"] = funding_result
        return plaid_result
    except Exception as exc:
        logger.exception("kai.plaid.webhook_failed")
        raise _to_http_exception(exc) from exc
