"""Bounded, authenticated settlement drain; no new-purchase flag dependency."""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, HTTPException, Query, Request, Response

from hushh_mcp.services.consent_audit_chain_service import get_consent_audit_chain_service
from hushh_mcp.services.scheduler_identity import (
    SchedulerIdentityError,
    allowed_service_accounts,
    expected_audience,
    verify_scheduler_request,
)
from hushh_mcp.services.scope_commerce import ScopeCommerceService
from hushh_mcp.services.scope_commerce.monitoring_publisher import emit_financial_monitoring
from hushh_mcp.services.scope_commerce.provider_service import ScopeCommerceProviderService

router = APIRouter(prefix="/api/internal/scope-commerce-work", tags=["scope-commerce-work"])
logger = logging.getLogger(__name__)


@router.post("/drain")
async def drain(request: Request, response: Response, limit: int = Query(20, ge=1, le=50)):
    response.headers["Cache-Control"] = "no-store"
    try:
        await asyncio.to_thread(
            verify_scheduler_request,
            authorization_header=request.headers.get("authorization"),
            audience=expected_audience("SCOPE_COMMERCE_DRAIN_AUDIENCE"),
            allowed_emails=allowed_service_accounts(
                "SCOPE_COMMERCE_DRAIN_SCHEDULER_SERVICE_ACCOUNTS"
            ),
        )
    except SchedulerIdentityError:
        raise HTTPException(401, detail="scheduler_identity_required") from None
    store = ScopeCommerceService()
    started = asyncio.get_running_loop().time()
    try:
        # Every provider submission is persisted before I/O. Cancellation leaves
        # a durable operation for the next drain, never a guessed settlement.
        async with asyncio.timeout(55):
            terms = await store.settle_expired_earnings(limit=limit)
            provider_service = ScopeCommerceProviderService(store)
            provider = await provider_service.reconcile(max_operations=limit)
            receipts = await get_consent_audit_chain_service().reconcile_committed_paid_events(
                limit=limit
            )

            async def counters(conn):
                return dict(
                    await conn.fetchrow(
                        """SELECT
                      (SELECT count(*) FROM scope_commerce_obligations
                         WHERE status NOT IN ('succeeded','failed')) AS obligations,
                      (SELECT count(*) FROM scope_commerce_provider_operations
                         WHERE status='reconciliation_required') AS uncertain_operations,
                      (SELECT count(*) FROM scope_commerce_journal j
                         WHERE (SELECT COALESCE(sum(micro_usd),0)
                           FROM scope_commerce_postings p WHERE p.entry_id=j.entry_id)<>0) AS unbalanced_journals"""
                    )
                )

            alerts = await store._transaction(counters)
            backing = await store.treasury_position()
            alerts["backing_shortfalls"] = int(backing["backingShortfallMicroUsd"] > 0)
        alerts["receipt_failures"] = receipts["failed"]
        await emit_financial_monitoring(
            store,
            provider_service,
            receipt_failures=receipts["failed"],
            budget_seconds=55 - (asyncio.get_running_loop().time() - started),
        )
        result = {"terms": terms, "provider": provider, "receipts": receipts, "alerts": alerts}
        # Counts only: no owner identity, request purpose, keys or information.
        logger.info(
            "scope_commerce.drain terms=%s provider=%s receipts=%s alerts=%s",
            terms,
            provider,
            receipts,
            alerts,
        )
        if any(alerts.values()):
            logger.warning("scope_commerce.reconciliation_attention_required counts=%s", alerts)
        return result
    except TimeoutError:
        logger.warning("scope_commerce.drain_budget_exhausted")
        raise HTTPException(503, detail="settlement_retry_required") from None
    except Exception as error:
        logger.error("scope_commerce.drain_failed error_type=%s", type(error).__name__)
        raise HTTPException(503, detail="settlement_retry_required") from None
