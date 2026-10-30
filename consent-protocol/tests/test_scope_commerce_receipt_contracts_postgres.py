"""Committed paid events produce one durable signed receipt across worker restarts."""

from __future__ import annotations

import base64
import json

import pytest

from hushh_mcp.consent import token_signing
from hushh_mcp.runtime_settings import clear_runtime_settings_caches
from hushh_mcp.services import consent_audit_chain_service as chain_module
from hushh_mcp.services.consent_audit_chain_service import ConsentAuditChainService
from hushh_mcp.services.consent_db import ConsentDBService
from tests import scope_commerce_contract_fixtures as contract_fixtures
from tests.scope_commerce_contract_harness import SCOPE, JsonObject, PaidContract

connector_postgres_url = contract_fixtures.connector_postgres_url
paid_contract_dsn = contract_fixtures.paid_contract_dsn
paid_contract = contract_fixtures.paid_contract


@pytest.fixture
async def receipt_worker(paid_contract: PaidContract, monkeypatch: pytest.MonkeyPatch):
    async def receipt_pool():
        return paid_contract.pool

    monkeypatch.setattr(chain_module, "get_pool", receipt_pool)
    monkeypatch.setenv("CONSENT_AUDIT_CHAIN_ENABLED", "1")
    monkeypatch.setenv("CONSENT_AUDIT_SIGNING_ALG", "ed25519")
    monkeypatch.setenv(
        "CONSENT_AUDIT_ED25519_PRIVATE_KEY", base64.b64encode(bytes(range(32))).decode()
    )
    monkeypatch.setenv("CONSENT_AUDIT_ED25519_KID", "paid-contract-audit")
    monkeypatch.delenv("CONSENT_AUDIT_ED25519_PUBLIC_KEYS", raising=False)
    clear_runtime_settings_caches()
    token_signing.reset_caches()
    worker = ConsentAuditChainService()
    await worker.ensure_table()
    try:
        yield worker
    finally:
        token_signing.reset_caches()
        clear_runtime_settings_caches()


async def _approve_for_receipt(ctx: PaidContract) -> tuple[int, JsonObject]:
    tariff = await ctx.tariff()
    assert tariff.status_code == 200, tariff.text
    approval = await ctx.approve(ctx.request_id)
    assert approval.status_code == 200, approval.text
    async with ctx.pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id,metadata FROM consent_audit WHERE request_id=$1 AND action='CONSENT_PAID_APPROVED'",
            ctx.request_id,
        )
    return int(row["id"]), json.loads(row["metadata"])


async def test_committed_paid_receipts_exclude_rollback_and_survive_restarted_drain(
    paid_contract: PaidContract, receipt_worker: ConsentAuditChainService
):
    ctx, worker = paid_contract, receipt_worker
    approved_id, metadata = await _approve_for_receipt(ctx)
    async with ctx.pool.acquire() as conn:
        transaction = conn.transaction()
        await transaction.start()
        try:
            rolled_back_id = await ConsentDBService().insert_event(
                user_id="owner",
                agent_id="developer:app",
                scope=SCOPE,
                action="CONSENT_PAID_APPROVED",
                request_id=ctx.request_id,
                metadata=metadata,
                connection=conn,
            )
            # Drain from a fresh connection while this valid event is visible
            # only to its uncommitted transaction. It must not be mirrored.
            first = await worker.reconcile_committed_paid_events()
            assert first["enabled"] is True and first["failed"] == 0
            assert first["appended"] == 1
            assert (
                await conn.fetchval(
                    "SELECT COUNT(*) FROM consent_audit_receipts WHERE audit_event_id=$1",
                    rolled_back_id,
                )
                == 0
            )
        finally:
            await transaction.rollback()
        async with conn.transaction():
            committed_id = await ConsentDBService().insert_event(
                user_id="owner",
                agent_id="developer:app",
                scope=SCOPE,
                action="CONSENT_PAID_APPROVED",
                request_id=ctx.request_id,
                metadata=metadata,
                connection=conn,
            )
            # Only exact boolean commercial authority and accepted lifecycle
            # events belong in the paid mirror, even with a real purchase link.
            for action, marker in (
                ("CONSENT_PAID_APPROVED", "true"),
                ("CONSENT_DENIED", True),
            ):
                await ConsentDBService().insert_event(
                    user_id="owner",
                    agent_id="developer:app",
                    scope=SCOPE,
                    action=action,
                    request_id=ctx.request_id,
                    metadata={**metadata, "commercial_required": marker},
                    connection=conn,
                )
    committed = await worker.reconcile_committed_paid_events()
    assert committed["appended"] == 1 and committed["failed"] == 0
    for instance in (worker, ConsentAuditChainService()):
        drained = await instance.reconcile_committed_paid_events()
        assert drained["appended"] == drained["failed"] == drained["scanned"] == 0
    async with ctx.pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT audit_event_id,COUNT(*) AS copies FROM consent_audit_receipts GROUP BY audit_event_id"
        )
        assert {row["audit_event_id"]: row["copies"] for row in rows} == {
            approved_id: 1,
            committed_id: 1,
        }
        assert not await conn.fetchval(
            "SELECT EXISTS(SELECT 1 FROM consent_audit WHERE id=$1)", rolled_back_id
        )
    verified = await ConsentAuditChainService().verify_chain("owner")
    assert verified["ok"] is True and verified["count"] == 2
