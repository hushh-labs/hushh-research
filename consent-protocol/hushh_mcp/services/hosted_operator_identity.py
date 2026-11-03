"""Verify a local operator credential without logging or persisting its token.

Not used by a serving hub. Only the explicitly authorized pilot operator calls
this boundary before binding its short-lived credentials to retained work.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired


@dataclass(frozen=True, repr=False)
class VerifiedOperator:
    principal: str
    token: str = field(repr=False)
    subject: str = ""
    email: str = ""
    email_verified: bool = False
    verified_at: str = ""

    def provider_account_transition_verification(self) -> dict[str, Any]:
        """Return the exact Google userinfo evidence, never an ID-token claim."""
        if (
            not self.subject
            or not self.email
            or self.email_verified is not True
            or not self.verified_at
        ):
            raise ProvisionReconciliationRequired("Operator identity evidence is incomplete")
        return {
            "version": 1,
            "provider": "google",
            "verificationMethod": "google_userinfo_access_token_verified",
            "verificationEndpoint": "https://openidconnect.googleapis.com/v1/userinfo",
            "subject": self.subject,
            "principal": self.principal,
            "email": self.email,
            "emailVerified": self.email_verified,
            "verifiedAt": self.verified_at,
        }


def verify_operator(credentials: Any, session: Any, *, expected: str) -> VerifiedOperator:
    from google.auth.transport.requests import Request

    if not isinstance(expected, str) or not expected.startswith("user:"):
        raise ProvisionReconciliationRequired("Managed pilot requires its named user operator")
    credentials.refresh(Request(session=session))
    response = session.get(
        "https://openidconnect.googleapis.com/v1/userinfo",
        headers={"Authorization": "Bearer " + credentials.token},
        timeout=20,
        allow_redirects=False,
    )
    if response.status_code != 200:
        raise ProvisionReconciliationRequired("Operator credential identity cannot be verified")
    value = response.json()
    token = getattr(credentials, "token", None)
    email = str(value.get("email", "")).strip().lower() if isinstance(value, dict) else ""
    subject = str(value.get("sub", "")) if isinstance(value, dict) else ""
    if (
        not isinstance(value, dict)
        or value.get("email_verified") is not True
        or "user:" + email != expected
        or not subject
        or not isinstance(token, str)
        or not token
    ):
        raise ProvisionReconciliationRequired("Operator credential differs from retained identity")
    return VerifiedOperator(
        principal=expected,
        token=token,
        subject=subject,
        email=email,
        email_verified=True,
        verified_at=datetime.now(timezone.utc).isoformat(),
    )
