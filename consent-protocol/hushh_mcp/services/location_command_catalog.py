"""File-backed command catalog shared by pod semantics and hub validation."""

from typing import Any, cast

from fastapi import HTTPException

from hushh_mcp.operons.location.capabilities import compile_location_capabilities
from hushh_mcp.services.action_gateway import list_action_gateway_actions


def command_catalog(
    plan_version: str = "location.plan.v1",
) -> tuple[str, dict[str, dict[str, Any]]]:
    workflows = None
    if plan_version == "location.plan.v2":
        from hushh_mcp.services.app_intelligence_runtime import get_service_onboarding_workflow

        workflow = get_service_onboarding_workflow("workflow.setup.location")
        if workflow is None:
            raise HTTPException(503, "Location workflow capabilities are unavailable.")
        workflows = [workflow]
    return cast(
        tuple[str, dict[str, dict[str, Any]]],
        compile_location_capabilities(list_action_gateway_actions(), workflows),
    )
