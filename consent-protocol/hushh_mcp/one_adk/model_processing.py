"""One-owned model construction with verified processing admission."""

from typing import Any

from hushh_mcp.runtime_providers.processing_terms import (
    ProcessingTermsUnverifiedError,
    require_verified_gemini_processing,
)


def managed_model(
    model: str, *, vertex_location: str | None = None, vertex_project: str | None = None
) -> Any:
    """Admit owner-context processing before the native model is constructed."""
    from hushh_mcp import runtime_providers

    require_verified_gemini_processing("gemini", "hushh_managed_vertex")
    options = {
        name: value
        for name, value in {
            "vertex_location": vertex_location,
            "vertex_project": vertex_project,
        }.items()
        if value is not None
    }
    return runtime_providers.build_managed_gemini_adk_model(model, **options)


def regional_model(model: str, *, vertex_project: str | None = None) -> Any:
    """Keep regional processing on the same admission without changing key probes."""
    from hushh_mcp import runtime_providers

    require_verified_gemini_processing("gemini", "hushh_managed_vertex")
    if vertex_project is None:
        return runtime_providers.build_managed_regional_gemini_adk_model(model)
    return runtime_providers.build_managed_regional_gemini_adk_model(
        model, vertex_project=vertex_project
    )


__all__ = [
    "ProcessingTermsUnverifiedError",
    "managed_model",
    "regional_model",
    "require_verified_gemini_processing",
]
