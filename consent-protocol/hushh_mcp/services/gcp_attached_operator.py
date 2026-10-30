"""Attached consent-plane authority; never owner impersonation or a key fallback."""

from __future__ import annotations

from typing import Any


class AttachedOperatorRefused(RuntimeError):
    pass


def attached_operator_headers(
    *, expected_service_account: str, credentials: Any = None
) -> tuple[dict[str, str], Any]:
    if not expected_service_account or expected_service_account.startswith("<"):
        raise AttachedOperatorRefused(
            "Gmail OAuth-project topic requires the exact consent-plane identity"
        )
    from google.auth.transport.requests import Request

    if credentials is None:
        import google.auth
        from google.auth.compute_engine import Credentials

        credentials, _ = google.auth.default(
            scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )
        if not isinstance(credentials, Credentials):
            raise AttachedOperatorRefused("Gmail OAuth-project setup requires attached managed ADC")
    if not getattr(credentials, "valid", False):
        credentials.refresh(Request())
    if getattr(
        credentials, "service_account_email", None
    ) != expected_service_account or not getattr(credentials, "token", None):
        raise AttachedOperatorRefused(
            "Gmail OAuth-project ADC identity differs from the configured consent plane"
        )
    return {
        "Authorization": f"Bearer {credentials.token}",
        "Content-Type": "application/json",
    }, credentials
