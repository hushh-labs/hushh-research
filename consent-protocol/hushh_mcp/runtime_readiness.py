"""Process-local runtime invariants for the managed One/ADK service.

This is deliberately dependency and configuration only: liveness must stay
cheap and must not make a model request. Deployment probes can call the richer
managed-runtime checks separately, while every process proves it booted with
the ADK contract the authored One tree requires.
"""

from __future__ import annotations

import os
from importlib.metadata import PackageNotFoundError, version

PINNED_GOOGLE_ADK_VERSION = "2.9.0"


def assert_account_generation_configuration() -> None:
    """Never activate replacements by disabling an existing identity integration.

    WorkOS captures generation zero and journals identity mutations. The
    conditional HushhTech exchange still needs its own captured authority.
    """
    if os.getenv("ACCOUNT_GENERATION_ADMISSION_ENABLED", "").strip().lower() != "true":
        return
    product_enabled = os.getenv("HUSSH_TECH_CLIENT_ENABLED", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    if product_enabled:
        raise RuntimeError("account_generation_identity_integration_not_qualified")


def google_adk_version() -> str | None:
    """Return the installed ADK version without importing the runtime."""
    try:
        return version("google-adk")
    except PackageNotFoundError:
        return None


def assert_pinned_google_adk() -> str:
    """Fail before accepting traffic when the One runtime is incompatible.

    A system interpreter with an older package can otherwise start FastAPI and
    only fail when One is constructed for a real request.
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
