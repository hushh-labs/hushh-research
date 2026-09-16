"""Command/workflow integration boundaries; persistence is covered by PostgreSQL tests."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from api.routes.one import command_proposals as routes
from hushh_mcp.operons.location.plan import LocationPlanV2
from hushh_mcp.services import location_command_workflow as binding
from hushh_mcp.services.location_onboarding_runtime import (
    _RECEIPT_SLOT,
    LOCATION_ONBOARDING_RECEIPT_SCHEMA_VERSION,
    LocationOnboardingRuntimeService,
)


def workflow_plan():
    return LocationPlanV2(
        capability_revision="cap",
        context_revision="ctx",
        mode="end_to_end",
        steps=[
            {"workflow_id": "workflow.setup.location"},
            {"action_id": "location.resume_updates"},
        ],
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("renew", [False, True])
async def test_consumed_workflow_admission_continues_exact_run_without_client_claim(
    monkeypatch, renew
):
    plan = workflow_plan()
    state = {
        "revision": 3,
        "status": "ready",
        "capsule": {"ciphertext": "opaque"},
        "next_step": 0,
        "step_count": 2,
        "step_digests": ["step"],
    }
    outcome = {
        "state": "consumed",
        "command_effect": "workflow",
        "workflow_run_id": "run_existing",
        "step_hmac": "step",
    }
    monkeypatch.setattr(routes, "_load", AsyncMock(return_value=state))
    monkeypatch.setattr(routes, "_check_plan", lambda *_args, **_kw: {})
    monkeypatch.setattr(
        routes,
        "workflow_command_descriptor",
        lambda _entry: {"action_id": "workflow.setup.location", "_command_effect": "workflow"},
    )
    monkeypatch.setattr(routes, "_context", lambda _: {"context_revision": "ctx"})
    monkeypatch.setattr(routes._ledger, "command_outcome", AsyncMock(return_value=outcome))
    reconcile = AsyncMock(return_value={"run_id": "run_existing", "finalize_retry_fenced": renew})
    monkeypatch.setattr(routes, "reconcile_command_workflow", reconcile)
    monkeypatch.setattr(routes, "location_run_result", lambda value: value)
    issued = AsyncMock()
    monkeypatch.setattr(routes._ledger, "issue_command", issued)
    result, *_ = await routes._admission(
        "owner", "command", routes.StepRequest(revision=3, plan=plan, context={}), renew=renew
    )
    assert result["status"] == "workflow" and result["workflow"]["run_id"] == "run_existing"
    assert reconcile.call_args.kwargs["resume"] is renew
    assert result["workflow_finalize_renewed"] is renew
    issued.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("resume", [False, True])
async def test_only_explicit_resume_requests_private_save_renewal(monkeypatch, resume):
    service = SimpleNamespace(
        get=AsyncMock(return_value={"run_id": "run_existing"}),
        advance_reserved_run=AsyncMock(
            return_value={"run_id": "run_existing", "finalize_retry_fenced": True}
        ),
        run_store=SimpleNamespace(get=AsyncMock(return_value=None)),
    )
    monkeypatch.setattr(binding, "get_location_onboarding_runtime_service", lambda: service)
    monkeypatch.setattr(binding, "workflow_revision_arguments", lambda: {})
    await binding.reconcile_command_workflow(
        ledger=SimpleNamespace(),
        user_id="owner",
        command_id="command",
        step=0,
        outcome={"command_effect": "workflow", "workflow_run_id": "run_existing"},
        resume=resume,
    )
    if resume:
        service.advance_reserved_run.assert_awaited_once_with(
            user_id="owner", run_id="run_existing", renew_finalizer=True
        )
        service.get.assert_not_called()
    else:
        service.get.assert_awaited_once_with(user_id="owner", run_id="run_existing")
        service.advance_reserved_run.assert_not_called()


@pytest.mark.asyncio
async def test_client_settlement_cannot_finish_a_workflow(monkeypatch):
    monkeypatch.setattr(routes, "_load", AsyncMock(return_value={"step_digests": ["step"]}))
    monkeypatch.setattr(
        routes._ledger,
        "command_outcome",
        AsyncMock(return_value={"step_hmac": "step", "command_effect": "workflow"}),
    )
    settled = AsyncMock()
    monkeypatch.setattr(routes._ledger, "settle_command", settled)
    with pytest.raises(HTTPException, match="completion receipt"):
        await routes.settle(
            "command",
            routes.SettlementRequest(
                step=0,
                operation_id="a" * 64,
                execution_receipt="synthetic-receipt",
                status="succeeded",
            ),
            {"user_id": "owner"},
        )
    settled.assert_not_called()


@pytest.mark.asyncio
async def test_completed_setup_reuses_exact_prior_receipts_without_replaying(monkeypatch):
    source = SimpleNamespace(
        run_id="run_source",
        user_id="owner",
        capability_id="workflow.setup.location",
        capability_version=2,
        status="verified_succeeded",
        step_cursor="location.onboarding.complete",
        revision=9,
        settlement_reference_hmac="proof",
        slots={
            "locationReceiptSchema": LOCATION_ONBOARDING_RECEIPT_SCHEMA_VERSION,
            **{slot: kind for kind, slot in _RECEIPT_SLOT.items()},
        },
    )
    current = SimpleNamespace(run_id="run_view", slots={"verified_prior_run_id": source.run_id})
    receipts = {
        kind: SimpleNamespace(
            receipt_id=kind,
            user_id="owner",
            run_id=source.run_id,
            workflow_version=2,
            outcome_code=outcome,
        )
        for kind, outcome in {
            "permission": "observed",
            "place": "saved",
            "circle": "provisioned",
            "completion": "verified",
        }.items()
    }
    service = SimpleNamespace(
        get=AsyncMock(
            return_value={"completion_claim_allowed": False, "waiting_reason": "already_complete"}
        ),
        advance_reserved_run=AsyncMock(),
        run_store=SimpleNamespace(get=AsyncMock(side_effect=[current, source])),
        ledger_store=SimpleNamespace(list_receipts=AsyncMock(return_value=receipts)),
        _has_verified_prior_completion=AsyncMock(return_value=True),
        _is_bound_verified_completion=LocationOnboardingRuntimeService._is_bound_verified_completion,
    )
    monkeypatch.setattr(binding, "get_location_onboarding_runtime_service", lambda: service)
    monkeypatch.setattr(binding, "workflow_revision_arguments", lambda: {})
    close_view = AsyncMock()
    monkeypatch.setattr(binding, "_settle_completed_view", close_view)
    ledger = SimpleNamespace(settle_workflow_command=AsyncMock())
    await binding.reconcile_command_workflow(
        ledger=ledger,
        user_id="owner",
        command_id="command",
        step=0,
        outcome={"command_effect": "workflow", "workflow_run_id": "run_view"},
    )
    close_view.assert_awaited_once_with(
        user_id="owner", command_id="command", step=0, run_id="run_view"
    )
    ledger.settle_workflow_command.assert_not_called()
    service.advance_reserved_run.assert_not_called()


@pytest.mark.asyncio
async def test_claimed_completion_without_full_receipts_is_rejected(monkeypatch):
    run = SimpleNamespace(
        run_id="run_source",
        user_id="owner",
        capability_id="workflow.setup.location",
        capability_version=2,
        status="verified_succeeded",
        step_cursor="location.onboarding.complete",
        revision=9,
        settlement_reference_hmac="proof",
        slots={},
    )
    service = SimpleNamespace(
        get=AsyncMock(return_value={"completion_claim_allowed": True}),
        run_store=SimpleNamespace(get=AsyncMock(return_value=run)),
        ledger_store=SimpleNamespace(list_receipts=AsyncMock(return_value={})),
        _is_bound_verified_completion=LocationOnboardingRuntimeService._is_bound_verified_completion,
    )
    monkeypatch.setattr(binding, "get_location_onboarding_runtime_service", lambda: service)
    monkeypatch.setattr(binding, "workflow_revision_arguments", lambda: {})
    ledger = SimpleNamespace(settle_workflow_command=AsyncMock())
    with pytest.raises(binding.ActionDirectiveAuthorityError, match="receipt"):
        await binding.reconcile_command_workflow(
            ledger=ledger,
            user_id="owner",
            command_id="command",
            step=0,
            outcome={"command_effect": "workflow", "workflow_run_id": run.run_id},
        )
    ledger.settle_workflow_command.assert_not_called()
