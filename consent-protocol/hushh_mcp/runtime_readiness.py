"""Process-local runtime invariants for the managed One/ADK service.

This is deliberately dependency and configuration only: liveness must stay
cheap and must not make a model request. Deployment probes can call the richer
managed-runtime checks separately, while every process proves it booted with
the ADK contract the authored One tree requires.
"""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version

PINNED_GOOGLE_ADK_VERSION = "2.4.0"


def google_adk_version() -> str | None:
    """Return the installed ADK version without importing the runtime."""
    try:
        return version("google-adk")
    except PackageNotFoundError:
        return None


def assert_pinned_google_adk() -> str:
    """Fail before accepting traffic when the One runtime is incompatible.

    ``AgentTool.propagate_grounding_metadata`` is part of the pinned 2.4
    contract. A system interpreter with an older package can otherwise start
    FastAPI and only fail when One is constructed for a real request.
    """
    installed = google_adk_version()
    if installed != PINNED_GOOGLE_ADK_VERSION:
        raise RuntimeError(
            "One runtime requires google-adk "
            f"{PINNED_GOOGLE_ADK_VERSION}; installed={installed or 'missing'}"
        )
    return installed


def runtime_dependency_evidence() -> dict[str, str | bool | None]:
    """Metadata-safe evidence for startup logs and preflight diagnostics."""
    installed = google_adk_version()
    return {
        "google_adk_expected": PINNED_GOOGLE_ADK_VERSION,
        "google_adk_installed": installed,
        "google_adk_compatible": installed == PINNED_GOOGLE_ADK_VERSION,
    }
