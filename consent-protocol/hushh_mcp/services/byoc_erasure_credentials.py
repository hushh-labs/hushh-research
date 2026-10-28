"""Borrow cleanup credentials only after the current private operation is admitted."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any


def admit_cleanup(deployment: Any, guard: Callable[[], None] | None) -> None:
    if deployment is None:
        return
    if guard is None or getattr(guard, "operation", None) != "cleanup":
        raise RuntimeError("Managed cleanup requires its fenced erasure authority")
    guard()


def cleanup_token(
    *,
    deployment: Any,
    guard: Callable[[], None] | None,
    expected_bootstrap: str,
    bootstrap_sa: str,
    source_token: str | None = None,
) -> str:
    admit_cleanup(deployment, guard)
    if bootstrap_sa != expected_bootstrap.removeprefix("serviceAccount:"):
        raise RuntimeError("Cleanup bootstrap identity changed")
    from hushh_mcp.services.user_gcp_bootstrap import mint_bootstrap_token

    return mint_bootstrap_token(bootstrap_sa=bootstrap_sa, source_token=source_token)


def release_member(backend: Any) -> str:
    """Bind recovery ordering to the credential used for impersonation."""
    from google.auth.transport.requests import Request

    from hushh_mcp.services.gcp_run_client import load_operator_credentials

    admit_cleanup(backend._private_deployment, backend._require_private_admission)
    credentials = getattr(backend, "_bootstrap_release_credentials", None)
    if credentials is None:
        credentials = load_operator_credentials()
    # Attached credentials resolve their actual service account on refresh.
    credentials.refresh(Request())
    email = getattr(credentials, "service_account_email", None)
    configured = (backend._hushh_invoker_sa or "").removeprefix("serviceAccount:")
    if not email or email == "default" or email != configured or not credentials.token:
        raise RuntimeError("bootstrap recovery credential identity unverified")
    backend._bootstrap_release_credentials = credentials
    return f"serviceAccount:{email}"
