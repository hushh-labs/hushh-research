"""Preserve request or frozen provider-plan bindings at the search facade."""

from hushh_mcp.services.google_drive_adapter import DriveReadError


def semantic_search_options(context, route):
    provider_packet = bool(route and route.get("provider_packet") is True)
    options = {}
    if provider_packet or context.get("semanticSearch") is True:
        options["semantic_search"] = True
    if provider_packet or context.get("discoveryDelivery") is True:
        options["discovery_delivery_enabled"] = True
    if not provider_packet and context.get("providerResultsOnly") is True:
        options["provider_results_only_enabled"] = True
    if not provider_packet and context.get("activityDateUnion") is True:
        options["activity_union_enabled"] = True
    if provider_packet and route.get("model_binding") is not None:
        options["semantic_model_binding"] = route["model_binding"]
    elif context.get("semanticSearch") is True and context.get("semanticModelBinding") is not None:
        options["semantic_model_binding"] = context["semanticModelBinding"]
    return options


def _admitted_vertex_transition(source: dict, target: dict) -> bool:
    """Match rollout generations and the Vertex project and location on both sides."""
    from hushh_mcp.runtime_providers.managed_text import (
        load_private_drive_text_policy,
        scoped_vertex_text_binding,
        text_policy_generation,
    )

    policy = load_private_drive_text_policy()

    def binding(version: str, model: str) -> dict:
        scoped = {
            "version": version,
            "provider": "vertex",
            "model": model,
            "thinking_level": "low",
            "max_output_tokens": 16384,
            "allow_cross_provider_fallback": False,
        }
        return scoped_vertex_text_binding(scoped, text_policy_generation(policy, "vertex", scoped))

    original_flash = binding("drive-vertex-flash-v2", "gemini-3.8-flash")
    carbon = binding("drive-vertex-carbon-v2", "gemini-4-carbon")
    recovery_flash = binding("drive-vertex-flash-v3", "gemini-3.8-flash")
    return (source == original_flash and target in (carbon, recovery_flash)) or (
        source == carbon and target == recovery_flash
    )


def require_uat_processor_transition(
    source: dict | None, target: dict, previous_migration: dict | None
) -> None:
    if not previous_migration and (source is None or source.get("deployment") != "gemini-4-carbon"):
        return
    if (
        source is None
        or target["provider"] != "gemini"
        or target.get("authorization_basis") != "uat_policy"
    ):
        raise DriveReadError("search_superseded")
    if previous_migration and not (
        isinstance(previous_migration, dict)
        and previous_migration.get("version") == 1
        and previous_migration.get("basis") == "administrator_rollout"
        and previous_migration.get("to_binding") == source
    ):
        raise DriveReadError("search_superseded")
    if (
        previous_migration
        and source.get("provider") == "azure_openai"
        and "previous_migration" not in previous_migration
    ):
        return
    if not _admitted_vertex_transition(source, target):
        raise DriveReadError("search_superseded")
