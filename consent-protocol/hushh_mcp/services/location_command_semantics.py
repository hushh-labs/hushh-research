"""One authored semantic stage, independent of checkpoint and effect persistence."""

from __future__ import annotations

import importlib
from typing import Any, Literal

from pydantic import Field

from hushh_mcp.hushh_adk.context import HushhContext
from hushh_mcp.operons.location.plan import CommandValue, LocationAssessment
from hushh_mcp.operons.location.references import LocationObservation, fresh_observations
from hushh_mcp.services.location_command_catalog import command_catalog


class CommandSemanticResult(CommandValue):
    assessment: LocationAssessment
    capability_revision: str = Field(min_length=1, max_length=128)
    observations: list[LocationObservation] = Field(default_factory=list, max_length=50)


async def assess_semantics(
    *,
    query: str,
    context: dict[str, Any],
    plan_version: Literal["location.plan.v1", "location.plan.v2"],
    brain: Any,
    reads: Any,
    consent_token: str,
    completed_steps: list[Any] | None = None,
) -> CommandSemanticResult:
    from hushh_mcp.services.app_intelligence_runtime import get_dynamic_service_knowledge

    revision, catalog = command_catalog(plan_version)
    service = get_dynamic_service_knowledge("location") or {}
    read_tools = []
    for path in brain.manifest.capabilities.get("command_read_tools", []):
        module, name = path.rsplit(".", 1)
        if module != "hushh_mcp.agents.location.command_read_tools":
            raise ValueError("Command tool is outside its read-only owner")
        read_tools.append(getattr(importlib.import_module(module), name))
    with HushhContext(
        user_id=reads.user_id,
        consent_token=consent_token,
        service_ports={"location_command_reads": reads},
    ):
        assessment = await brain.assess(
            query=query,
            context={
                **context,
                "observations": reads.semantic_observations(),
                "completed_steps": [
                    {"step_index": i, **step.model_dump()}
                    for i, step in enumerate(completed_steps or [])
                ],
            },
            catalog=catalog,
            read_tools=read_tools,
            knowledge={
                "package": service.get("knowledge_package"),
                "semantic_profile": (service.get("knowledge_projection") or {}).get(
                    "semantic_profile"
                ),
                "feature_groups": service.get("feature_groups", []),
            },
        )
    selected = {
        ref.reference for step in assessment.steps for ref in getattr(step, "references", [])
    }
    return CommandSemanticResult(
        assessment=assessment,
        capability_revision=revision,
        observations=[
            item
            for item in (
                LocationObservation.model_validate(value) for value in reads.observations(selected)
            )
            if item.reference in selected or fresh_observations([item])
        ],
    )
