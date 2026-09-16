"""Focused contract tests for the durable missing-Circle-name form."""

from __future__ import annotations

import asyncio
import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any, Mapping

import pytest

from hushh_mcp.services.capability_run_service import (
    CapabilityRunConflictError,
    CapabilityRunV1,
)
from hushh_mcp.services.location_circle_name_interaction import (
    LOCATION_CIRCLE_NAME_ACTION_ID,
    LocationCircleNameConflictError,
    LocationCircleNameInteractionService,
)


class _RunStore:
    def __init__(self) -> None:
        self.runs: dict[str, CapabilityRunV1] = {}
        self._next = 0

    async def get(self, *, user_id: str, run_id: str, include_slots: bool = False):
        run = self.runs.get(run_id)
        if run is None or run.user_id != user_id:
            return None
        return run if include_slots else replace(run, slots=None)

    async def find_unique_open_for_capability(
        self, *, user_id: str, capability_id: str, include_slots: bool = False
    ):
        rows = [
            run
            for run in self.runs.values()
            if run.user_id == user_id
            and run.capability_id == capability_id
            and run.status not in {"verified_succeeded", "verified_failed", "cancelled", "expired"}
        ]
        if len(rows) > 1:
            raise CapabilityRunConflictError("ambiguous")
        if not rows:
            return None
        return rows[0] if include_slots else replace(rows[0], slots=None)

    async def find_unique_resumable(self, **kwargs: Any):
        run = await self.find_unique_open_for_capability(
            user_id=kwargs["user_id"],
            capability_id=kwargs["capability_id"],
            include_slots=kwargs.get("include_slots", False),
        )
        if run is not None and run.status not in {
            "needs_input",
            "entity_choice",
            "interaction_required",
            "confirmation_required",
            "paused",
        }:
            return None
        return run

    async def find_latest_for_capability(
        self, *, user_id: str, capability_id: str, include_slots: bool = False
    ):
        rows = [
            run
            for run in self.runs.values()
            if run.user_id == user_id and run.capability_id == capability_id
        ]
        if not rows:
            return None
        run = max(rows, key=lambda value: value.revision)
        return run if include_slots else replace(run, slots=None)

    async def create(self, **kwargs: Any) -> CapabilityRunV1:
        self._next += 1
        run = CapabilityRunV1(
            run_id=f"run_{'a' * 15}{self._next:x}",
            user_id=kwargs["user_id"],
            capability_id=kwargs["capability_id"],
            capability_version=kwargs["capability_version"],
            graph_revision=kwargs["graph_revision"],
            status=kwargs["status"],
            step_cursor=kwargs["step_cursor"],
            context_revision=kwargs["context_revision"],
            expected_context_revision=kwargs["expected_context_revision"],
            pending_interaction=kwargs.get("pending_interaction"),
            pending_directive_id=kwargs.get("pending_directive_id"),
            idempotency_key=kwargs["idempotency_scope"],
            settlement_reference_hmac=None,
            revision=1,
            expires_at=datetime.now(UTC) + timedelta(hours=1),
            slots=dict(kwargs.get("slots") or {}),
        )
        self.runs[run.run_id] = run
        return run

    async def replace_pending_directive(self, **kwargs: Any) -> CapabilityRunV1:
        run = self.runs[kwargs["run_id"]]
        if run.user_id != kwargs["user_id"] or run.revision != kwargs["expected_revision"]:
            raise CapabilityRunConflictError("stale")
        if run.status != "needs_input":
            raise CapabilityRunConflictError("not waiting")
        updated = replace(
            run,
            pending_interaction=kwargs["pending_interaction"],
            pending_directive_id=kwargs["pending_directive_id"],
            revision=run.revision + 1,
        )
        self.runs[run.run_id] = updated
        return updated

    async def transition(self, **kwargs: Any) -> CapabilityRunV1:
        run = self.runs[kwargs["run_id"]]
        if run.user_id != kwargs["user_id"] or run.revision != kwargs["expected_revision"]:
            raise CapabilityRunConflictError("stale")
        updated = replace(
            run,
            status=kwargs["to_status"],
            step_cursor=kwargs.get("step_cursor") or run.step_cursor,
            pending_interaction=kwargs.get("pending_interaction", run.pending_interaction),
            pending_directive_id=kwargs.get("pending_directive_id", run.pending_directive_id),
            slots=dict(kwargs.get("slots", run.slots) or {}),
            revision=run.revision + 1,
        )
        self.runs[run.run_id] = updated
        return updated


def _graph() -> Mapping[str, Any]:
    return {
        "revision": "a" * 64,
        "actions": [
            {
                "capability_id": LOCATION_CIRCLE_NAME_ACTION_ID,
                "version": 1,
                "inputSchema": {
                    "type": "object",
                    "properties": {"name": {"type": "string"}},
                    "required": ["name"],
                },
                "execution": {
                    "mode": "server_direct",
                    "outcome": "EXECUTE",
                    "executor": {
                        "kind": "backend_service",
                        "settlement": "verified_backend_service_result",
                    },
                },
            }
        ],
        "render_surfaces": [{"capability_id": "render.form"}],
    }


def _test_owner_credential() -> str:
    """Return a non-production fixture credential without inline secret-like literals."""

    return "vault-token"


def _service(store: _RunStore, dispatches: list[dict[str, Any]], mutations: set[str]):
    async def dispatch(**kwargs: Any) -> Mapping[str, Any]:
        dispatches.append(dict(kwargs))
        # Deliberately yield to model two concurrent lost-response retries.
        await asyncio.sleep(0)
        run = store.runs[kwargs["resume_run_id"]]
        if run.status != "verified_succeeded":
            # This represents the idempotent audited backend adapter: even if
            # recovery invokes it twice, its run-bound domain mutation is one.
            mutations.add(run.run_id)
            store.runs[run.run_id] = replace(
                run,
                status="verified_succeeded",
                revision=run.revision + 1,
                slots={"name": kwargs["name"]},
            )
        return {"status": "completed"}

    return LocationCircleNameInteractionService(
        run_store=store,
        graph_loader=_graph,
        dispatcher=dispatch,
        # Synthetic test-only authority material. Whitespace intentionally
        # keeps this from resembling a deployable API-key-shaped literal.
        hmac_key="fixture circle form authority key (test only)",
        now=lambda: datetime(2026, 9, 11, tzinfo=UTC),
    )


@pytest.mark.asyncio
async def test_missing_circle_name_issues_a_leased_form_then_recovers_lost_response_once() -> None:
    store = _RunStore()
    dispatches: list[dict[str, Any]] = []
    mutations: set[str] = set()
    service = _service(store, dispatches, mutations)

    directive = await service.issue(user_id="owner-1", context_revision="ctx-1")
    wire = directive.wire_projection()
    assert wire["surfaceId"] == "render.form"
    assert wire["formId"] == "one.location.create_circle_name.v1"
    assert "Family" not in json.dumps(wire)

    first = await service.submit(
        user_id="owner-1",
        vault_owner_token=_test_owner_credential(),
        run_id=directive.run_id,
        expected_revision=directive.run_revision,
        directive_id=directive.directive_id,
        lease_id=directive.lease_id,
        name="Family",
    )
    replay = await service.submit(
        user_id="owner-1",
        vault_owner_token=_test_owner_credential(),
        run_id=directive.run_id,
        expected_revision=directive.run_revision,
        directive_id=directive.directive_id,
        lease_id=directive.lease_id,
        name="Family",
    )

    assert first.status == replay.status == "verified"
    assert len(dispatches) == 1
    assert mutations == {directive.run_id}
    assert dispatches[0]["resume_run_id"] == directive.run_id
    assert dispatches[0]["execution_scope"].startswith("loccircleformexec_")


@pytest.mark.asyncio
async def test_concurrent_identical_submit_has_one_run_bound_circle_mutation() -> None:
    store = _RunStore()
    dispatches: list[dict[str, Any]] = []
    mutations: set[str] = set()
    service = _service(store, dispatches, mutations)
    directive = await service.issue(user_id="owner-1", context_revision="ctx-1")

    left, right = await asyncio.gather(
        service.submit(
            user_id="owner-1",
            vault_owner_token=_test_owner_credential(),
            run_id=directive.run_id,
            expected_revision=directive.run_revision,
            directive_id=directive.directive_id,
            lease_id=directive.lease_id,
            name="Family",
        ),
        service.submit(
            user_id="owner-1",
            vault_owner_token=_test_owner_credential(),
            run_id=directive.run_id,
            expected_revision=directive.run_revision,
            directive_id=directive.directive_id,
            lease_id=directive.lease_id,
            name="Family",
        ),
    )

    assert {left.status, right.status} <= {"verified", "working"}
    assert mutations == {directive.run_id}
    assert store.runs[directive.run_id].status == "verified_succeeded"


@pytest.mark.asyncio
async def test_circle_name_form_rejects_altered_lease_or_name_replay() -> None:
    store = _RunStore()
    service = _service(store, [], set())
    directive = await service.issue(user_id="owner-1", context_revision="ctx-1")

    with pytest.raises(LocationCircleNameConflictError):
        await service.submit(
            user_id="owner-1",
            vault_owner_token=_test_owner_credential(),
            run_id=directive.run_id,
            expected_revision=directive.run_revision,
            directive_id=directive.directive_id,
            lease_id=f"loccirclelease_2000000000_{'0' * 64}",
            name="Family",
        )

    await service.submit(
        user_id="owner-1",
        vault_owner_token=_test_owner_credential(),
        run_id=directive.run_id,
        expected_revision=directive.run_revision,
        directive_id=directive.directive_id,
        lease_id=directive.lease_id,
        name="Family",
    )
    with pytest.raises(LocationCircleNameConflictError):
        await service.submit(
            user_id="owner-1",
            vault_owner_token=_test_owner_credential(),
            run_id=directive.run_id,
            expected_revision=directive.run_revision,
            directive_id=directive.directive_id,
            lease_id=directive.lease_id,
            name="Different Circle",
        )
