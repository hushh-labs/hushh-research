"""The owner-payout tick runs Connect ledger upkeep once, bounded and contained.

Balance and deposit-contents reads are read-only Stripe calls. They may never
delay or hide the financial reconciliation outcomes that run before them.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.drive_request_owner_payout_worker import DriveRequestOwnerPayoutWorker
from hushh_mcp.services.hashcoin_redemption_service import HashcoinRedemptionService
from hushh_mcp.services.stripe_connect_balances import StripeConnectBalances
from hushh_mcp.services.stripe_connect_bank_payouts import StripeConnectBankPayouts


@pytest.fixture
def worker(monkeypatch):
    for name in (
        "ENVIRONMENT",
        "HUSHH_DEPLOY_ENV",
        "HUSSH_DEPLOY_ENV",
        "STRIPE_CONNECT_MODE",
        "STRIPE_CONNECT_SECRET_KEY",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("STRIPE_MODE", "test")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_" + "k" * 30)
    monkeypatch.setattr(
        HashcoinRedemptionService, "reconcile_due", AsyncMock(return_value={"succeeded": 1})
    )
    monkeypatch.setattr(StripeConnectBalances, "__init__", lambda self, *args, **kwargs: None)
    base = SimpleNamespace(
        reconcile_due=AsyncMock(return_value={"checked": 1}),
        transfer_due=AsyncMock(return_value={}),
        reconcile_external_debits=AsyncMock(return_value={}),
        reconcile_reversals=AsyncMock(return_value={}),
    )
    return DriveRequestOwnerPayoutWorker(service=base)


async def test_ledger_upkeep_runs_once_after_the_bank_scan_within_the_tick(worker, monkeypatch):
    order = []

    async def bank_scan(self, **bounds):
        order.append(("bank", bounds))
        return {"bank_accounts_checked": 1}

    async def ledger(self, **bounds):
        order.append(("ledger", bounds))
        return {"balance_accounts_checked": 2, "payout_reconciliations_completed": 1}

    monkeypatch.setattr(StripeConnectBankPayouts, "reconcile_due", bank_scan)
    monkeypatch.setattr(StripeConnectBalances, "run_due", ledger)

    result = await worker.run(max_jobs=1, deadline_seconds=20)

    assert [step for step, _ in order] == ["bank", "ledger"]
    bounds = order[1][1]
    assert (bounds["max_refreshes"], bounds["max_reconciliations"]) == (2, 1)
    # Only what the tick has left, minus a margin: never the whole stage budget.
    assert 0 < bounds["budget_seconds"] <= 18
    assert result["outcomes"]["balance_accounts_checked"] == 2
    assert result["outcomes"]["payout_reconciliations_completed"] == 1
    assert result["outcomes"]["bank_accounts_checked"] == 1


async def test_ledger_failure_never_hides_financial_outcomes(worker, monkeypatch):
    monkeypatch.setattr(
        StripeConnectBankPayouts,
        "reconcile_due",
        AsyncMock(return_value={"bank_payouts_changed": 1}),
    )
    monkeypatch.setattr(
        StripeConnectBalances, "run_due", AsyncMock(side_effect=RuntimeError("private acct_x"))
    )

    result = await worker.run(max_jobs=1, deadline_seconds=20)

    assert result["outcomes"]["checked"] == 1
    assert result["outcomes"]["succeeded"] == 1
    assert result["outcomes"]["bank_payouts_changed"] == 1
    assert result["outcomes"]["balance_refresh_deferred"] == 1
    assert "acct_x" not in str(result)
