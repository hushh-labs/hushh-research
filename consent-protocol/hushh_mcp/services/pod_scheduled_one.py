"""Compose an approved occurrence through One, never a parallel agent loop."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.services.pod_scheduled_authority import ScheduledGrantAuthority
from hushh_mcp.services.pod_scheduled_checkpoint import ScheduledModelBinding
from hushh_mcp.services.pod_scheduled_contracts import ScheduledContinuation, ScheduleRefused
from hushh_mcp.services.pod_scheduled_lease import ScheduledExecutionLease
from hushh_mcp.services.pod_scheduled_model import ScheduledModel, resolve_scheduled_model


class ScheduledOneParameters(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, hide_input_in_errors=True)
    goal: str = Field(min_length=1, max_length=2000, repr=False)


class ScheduledOneTask:
    max_active_seconds = 900
    required_scopes = ("pod.act", "pkm.read")

    def __init__(
        self, grants: ScheduledGrantAuthority, log: Any, check: Callable[[], Awaitable[None]]
    ):
        self.grants, self.log, self.check = grants, log, check

    @staticmethod
    def _manifest_version() -> str:
        from hushh_mcp.one_adk.agent_tree import _load_product_agent_manifest

        manifest = _load_product_agent_manifest("agent_one")
        if not manifest.version:
            raise ScheduleRefused("SCHEDULE_CAPABILITY_UNAVAILABLE")
        return str(manifest.version)

    async def prepare(self, parameters: dict) -> dict:
        try:
            request = ScheduledOneParameters.model_validate(parameters)
        except ValueError:
            raise ScheduleRefused("SCHEDULE_PARAMETERS_REFUSED") from None
        model = await resolve_scheduled_model(
            self.log, pod_id=self.grants.authority.hushh_id, check=self.check
        )
        return {
            "goal": request.goal,
            "agent_version": self._manifest_version(),
            "model_binding": model.binding.model_dump(),
        }

    async def check_continuation(self, row: dict) -> None:
        from hushh_mcp.services.pod_mcp_approval import PodMcpTerms

        await self.model_for(row["terms"], self.check)
        for pending in (row.get("checkpoint") or {}).get("pending", {}).values():
            try:
                review = PodMcpTerms.model_validate((pending.get("review") or {}).get("podReview"))
            except ValueError:
                raise ScheduleRefused("SCHEDULE_REVIEW_BINDING_REFUSED") from None
            authority = self.grants.authority
            if (review.ownerId, review.hushhId, review.podKeyId, review.environment) != (
                self.grants.owner_id,
                authority.hushh_id,
                authority.pod_key_id,
                authority.environment,
            ):
                raise ScheduleRefused("SCHEDULE_REVIEW_BINDING_REFUSED")
            if review.epoch != authority.epoch:
                raise ScheduleRefused("SCHEDULE_REVIEW_REBIND_REQUIRED")

    async def model_for(self, terms: dict, check: Callable[[], Awaitable[None]]) -> ScheduledModel:
        if set(terms) != {"goal", "agent_version", "model_binding"}:
            raise ScheduleRefused("SCHEDULE_TERMS_CHANGED")
        try:
            ScheduledOneParameters.model_validate({"goal": terms["goal"]})
            binding = ScheduledModelBinding.model_validate(terms["model_binding"])
        except ValueError:
            raise ScheduleRefused("SCHEDULE_TERMS_CHANGED") from None
        if terms["agent_version"] != self._manifest_version():
            raise ScheduleRefused("SCHEDULE_CAPABILITY_CHANGED")
        return await resolve_scheduled_model(
            self.log, pod_id=self.grants.authority.hushh_id, check=check, expected=binding
        )

    async def run(self, terms: dict, occurrence_id: str, check) -> str:
        # The generic callback-only interface cannot reconstruct a claim.
        raise ScheduleRefused("SCHEDULE_CLAIM_REQUIRED")

    async def run_claimed(self, lease: ScheduledExecutionLease) -> str:
        from hushh_mcp.one_adk.scheduled_one_execution import execute_scheduled_one

        return await execute_scheduled_one(self, lease)

    async def continue_claimed(
        self, lease: ScheduledExecutionLease, continuation: ScheduledContinuation
    ) -> str:
        from hushh_mcp.one_adk.scheduled_one_execution import execute_scheduled_one

        return await execute_scheduled_one(self, lease, continuation)
