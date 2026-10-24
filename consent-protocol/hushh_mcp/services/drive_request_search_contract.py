"""Validate authored search contracts without changing their interpretation."""

from hushh_mcp.services.google_drive_adapter import DriveReadError


def validated_request_semantics(
    plan,
    *,
    discovery_delivery_enabled,
    semantic_model_binding,
    semantic_search,
    v1_live_request,
    indexed,
    provider_packet,
    parsed_brain,
):
    semantic_plan = plan.get("semantic_query")
    if (
        type(discovery_delivery_enabled) is not bool
        or discovery_delivery_enabled
        and semantic_plan is None
    ):
        raise DriveReadError("invalid_argument")
    if semantic_model_binding is not None and semantic_plan is None:
        raise DriveReadError("invalid_argument")
    if bool(semantic_plan is not None) != semantic_search:
        raise DriveReadError("invalid_argument")
    if semantic_plan is not None:
        from hushh_mcp.services.drive_request_semantic_plan import SemanticDrivePlan

        semantic_plan = SemanticDrivePlan.model_validate(semantic_plan).model_dump(mode="json")
        if v1_live_request or indexed and not provider_packet or parsed_brain is not None:
            raise DriveReadError("invalid_argument")
        from hushh_mcp.services.drive_request_package_service import assessment_policy_version

        if semantic_model_binding is not None:
            from hushh_mcp.services.drive_request_package_assessment import (
                validate_semantic_model_binding,
            )

            semantic_model_binding = validate_semantic_model_binding(semantic_model_binding)
        semantic_policy = assessment_policy_version(semantic_model_binding)
    return (
        semantic_plan,
        semantic_model_binding,
        semantic_policy if semantic_plan is not None else None,
    )


def provider_packet_scope(route, plan, purpose, semantic_model_binding, timezone, plan_source):
    provider_packet = route.get("provider_packet") is True and route["kind"] == "packet"
    if plan_source == "frozen_provider_packet" and not provider_packet:
        raise DriveReadError("invalid_argument")
    if provider_packet:
        if (
            plan != route["plan"]
            or semantic_model_binding != route["model_binding"]
            or purpose.get("periodStart") != route["period"]["start"]
            or purpose.get("periodEnd") != route["period"]["end"]
        ):
            raise DriveReadError("packet_integrity_invalid")
        timezone = route["period"]["timezone"]
    return provider_packet, timezone
