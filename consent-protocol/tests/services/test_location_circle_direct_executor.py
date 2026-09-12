"""Contract tests for the non-conversational Circle execution seam."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any, Mapping

import pytest

from hushh_mcp.services.capability_run_service import (
    CapabilityRunConflictError,
    CapabilityRunV1,
)
from hushh_mcp.services.location_circle_direct_executor import (
    LOCATION_CREATE_CIRCLE_CAPABILITY_ID,
    LocationCircleDirectExecutor,
)
from hushh_mcp.services.one_location_circle_service import OneLocationCircleError


def _graph(*, wired: bool = True) -> Mapping[str, Any]:
    return {
        "revision": "graph-circle-v1",
        "actions": [
            {
                "capability_id": LOCATION_CREATE_CIRCLE_CAPABILITY_ID,
                "version": 1,
                "inputSchema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {"name": {"type": "string"}},
                    "required": ["name"],
                },
                "execution": {
                    "mode": "server_direct" if wired else "client_directive",
                    "outcome": "EXECUTE",
                    "executor": {
                        "kind": "backend_service",
                        "settlement": "verified_backend_service_result",
                    },
                },
                "settlement_proof": "verified_backend_service_result",
                "preconditions": {"requires_signed_in": True, "requires_vault": True},
                "idempotency": {"strategy": "capability_run_bound_backend_receipt"},
                "supported_entrypoints": ["voice", "typed_search"],
            }
        ],
    }


class _RunStore:
    def __init__(self) -> None:
        self.runs: dict[str, CapabilityRunV1] = {}
        self.transitions: list[str] = []
        self._next = 0

    async def get(self, *, user_id: str, run_id: str, include_slots: bool = False):
        run = self.runs.get(run_id)
        if run is None or run.user_id != user_id:
            return None
        return run if include_slots else replace(run, slots=None)

    async def find_active_matching_slots(self, **kwargs: Any):
        wanted = dict(kwargs["slots"])
        rows = [
            run
            for run in self.runs.values()
            if run.user_id == kwargs["user_id"]
            and run.capability_id == kwargs["capability_id"]
            and run.graph_revision == kwargs["graph_revision"]
            and run.status in {"authorized", "executing", "settlement_received"}
            and run.slots == wanted
        ]
        if len(rows) > 1:
            raise CapabilityRunConflictError("ambiguous")
        if not rows:
            return None
        return rows[0] if kwargs.get("include_slots", False) else replace(rows[0], slots=None)

    async def find_unique_resumable(self, **kwargs: Any):
        rows = [
            run
            for run in self.runs.values()
            if run.user_id == kwargs["user_id"]
            and run.capability_id == kwargs["capability_id"]
            and run.graph_revision == kwargs["graph_revision"]
            and run.status
            in {
                "needs_input",
                "entity_choice",
                "interaction_required",
                "confirmation_required",
                "paused",
            }
        ]
        if len(rows) > 1:
            raise CapabilityRunConflictError("ambiguous")
        if not rows:
            return None
        return rows[0] if kwargs.get("include_slots", False) else replace(rows[0], slots=None)

    async def create(self, **kwargs: Any) -> CapabilityRunV1:
        self._next += 1
        run = CapabilityRunV1(
            run_id=f"run_circle{self._next:02d}",
            user_id=kwargs["user_id"],
            capability_id=kwargs["capability_id"],
            capability_version=kwargs["capability_version"],
            graph_revision=kwargs["graph_revision"],
            status=kwargs["status"],
            step_cursor="start",
            context_revision=kwargs["context_revision"],
            expected_context_revision=kwargs["expected_context_revision"],
            pending_interaction=None,
            pending_directive_id=None,
            idempotency_key=kwargs["idempotency_scope"],
            settlement_reference_hmac=None,
            revision=1,
            expires_at=datetime.now(UTC) + timedelta(hours=1),
            slots=dict(kwargs.get("slots") or {}),
        )
        self.runs[run.run_id] = run
        return run

    async def transition(self, **kwargs: Any) -> CapabilityRunV1:
        run = self.runs[kwargs["run_id"]]
        if run.user_id != kwargs["user_id"] or run.revision != kwargs["expected_revision"]:
            raise CapabilityRunConflictError("stale")
        status = kwargs["to_status"]
        self.transitions.append(status)
        updated = replace(
            run,
            status=status,
            step_cursor=kwargs.get("step_cursor") or run.step_cursor,
            context_revision=kwargs.get("context_revision", run.context_revision),
            expected_context_revision=kwargs.get(
                "expected_context_revision", run.expected_context_revision
            ),
            pending_interaction=kwargs.get("pending_interaction", run.pending_interaction),
            pending_directive_id=kwargs.get("pending_directive_id", run.pending_directive_id),
            settlement_reference_hmac=(
                "receipt" if status == "settlement_received" else run.settlement_reference_hmac
            ),
            slots=dict(kwargs.get("slots", run.slots) or {}),
            revision=run.revision + 1,
        )
        self.runs[run.run_id] = updated
        return updated


class _CircleService:
    def __init__(self) -> None:
        self.created_run_ids: list[str] = []
        self.receipt_reads: list[str] = []
        self.receipts: set[str] = set()

    def create_or_get_circle(self, **kwargs: Any):
        run_id = kwargs["capability_run_id"]
        self.created_run_ids.append(run_id)
        self.receipts.add(run_id)
        return ({"id": "not-exported", "name": kwargs["name"]}, True)

    def get_circle_for_capability_run(self, **kwargs: Any):
        run_id = kwargs["capability_run_id"]
        self.receipt_reads.append(run_id)
        if run_id not in self.receipts:
            raise OneLocationCircleError("LOCATION_CAPABILITY_RUN_INVALID", "missing")
        return {"id": "not-exported", "name": "not-exported"}


async def _token_validator(_token: str, _scope: Any):
    return True, "", SimpleNamespace(user_id="owner-1")


def _executor(store: _RunStore, service: _CircleService, *, graph: Mapping[str, Any] | None = None):
    return LocationCircleDirectExecutor(
        run_store=store,
        graph_loader=lambda: graph or _graph(),
        circle_service_factory=lambda: service,
        token_validator=_token_validator,
        now=lambda: datetime(2026, 9, 11, tzinfo=UTC),
    )


@pytest.mark.asyncio
async def test_direct_circle_executor_revalidates_then_settles_before_completion() -> None:
    store = _RunStore()
    circle = _CircleService()

    result = await _executor(store, circle).execute(
        user_id="owner-1",
        vault_owner_token="vault-owner-token",  # noqa: S106 - synthetic test value
        name="Family",
        execution_scope="lcc1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        context_revision="ctx-1",
    )

    assert result.status == "completed"
    assert result.run_id is not None
    assert circle.created_run_ids == [result.run_id]
    assert circle.receipt_reads == [result.run_id]
    assert store.transitions == ["executing", "settlement_received", "verified_succeeded"]


@pytest.mark.asyncio
async def test_settlement_recovery_is_read_only_and_never_creates_a_second_circle() -> None:
    store = _RunStore()
    circle = _CircleService()
    run = await store.create(
        user_id="owner-1",
        capability_id=LOCATION_CREATE_CIRCLE_CAPABILITY_ID,
        capability_version=1,
        graph_revision="graph-circle-v1",
        slots={"name": "Family"},
        context_revision="",
        expected_context_revision="",
        status="authorized",
        idempotency_scope="scope-recovery",
    )
    store.runs[run.run_id] = replace(
        run,
        status="settlement_received",
        settlement_reference_hmac="receipt",
    )
    circle.receipts.add(run.run_id)

    result = await _executor(store, circle).execute(
        user_id="owner-1",
        vault_owner_token="vault-owner-token",  # noqa: S106 - synthetic test value
        name="Family",
        execution_scope="lcc1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        resume_run_id=run.run_id,
    )

    assert result.status == "completed"
    assert circle.created_run_ids == []
    assert circle.receipt_reads == [run.run_id]
    assert store.transitions == ["verified_succeeded"]


@pytest.mark.asyncio
async def test_explicit_form_run_cannot_be_authorized_by_a_new_command_or_name() -> None:
    store = _RunStore()
    circle = _CircleService()
    run = await store.create(
        user_id="owner-1",
        capability_id=LOCATION_CREATE_CIRCLE_CAPABILITY_ID,
        capability_version=1,
        graph_revision="graph-circle-v1",
        slots={},
        context_revision="",
        expected_context_revision="",
        status="needs_input",
        idempotency_scope="scope-form",
    )

    result = await _executor(store, circle).execute(
        user_id="owner-1",
        vault_owner_token="vault-owner-token",  # noqa: S106 - synthetic test value
        name="Family",
        execution_scope="lcc1_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        resume_run_id=run.run_id,
    )

    assert result.status == "failed"
    assert circle.created_run_ids == []
    assert store.transitions == []


@pytest.mark.asyncio
async def test_unwired_or_malformed_graph_cannot_enter_the_domain_adapter() -> None:
    store = _RunStore()
    circle = _CircleService()

    result = await _executor(store, circle, graph=_graph(wired=False)).execute(
        user_id="owner-1",
        vault_owner_token="vault-owner-token",  # noqa: S106 - synthetic test value
        name="Family",
        execution_scope="lcc1_dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    )

    assert result.status == "blocked"
    assert result.reason_code == "contract_unavailable"
    assert circle.created_run_ids == []
    assert store.runs == {}
