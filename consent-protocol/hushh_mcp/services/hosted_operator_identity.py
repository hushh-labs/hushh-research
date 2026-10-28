"""Verify a local operator credential without logging or persisting its token.

Not used by a serving hub. Only the explicitly authorized pilot operator calls
this boundary before binding its short-lived credentials to retained work.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired


@dataclass(frozen=True, repr=False)
class VerifiedOperator:
    principal: str
    token: str = field(repr=False)


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
    if (
        value.get("email_verified") is not True
        or "user:" + str(value.get("email", "")).lower() != expected
        or not value.get("sub")
    ):
        raise ProvisionReconciliationRequired("Operator credential differs from retained identity")
    return VerifiedOperator(expected, credentials.token)
