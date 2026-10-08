"""Opaque hosted-onboarding returns and time-bounded Account Link validation."""

from __future__ import annotations

import time
from typing import Any
from urllib.parse import urlencode

from .provider_contracts import _hosted_url
from .stripe_adapter import CommerceProviderError


def onboarding_urls(origin: str, path: str, attempt_id: str) -> dict[str, str]:
    parameters = {"commerceAttemptId": attempt_id, "commerceReturn": "1"}
    base = origin + path + "?"
    return {
        "return_url": base + urlencode(parameters),
        "refresh_url": base + urlencode({**parameters, "commerceAction": "onboarding_refresh"}),
    }


def validate_onboarding_link(link: dict[str, Any]) -> None:
    if (
        link.get("object") != "account_link"
        or not _hosted_url(link.get("url"), {"connect.stripe.com"})
        or type(link.get("expires_at")) is not int
    ):
        raise CommerceProviderError("provider_response_mismatch")
    if link["expires_at"] <= int(time.time()):
        # A fresh authenticated POST must use a new operation ID. Never replay
        # an expired cached URL or reset an uncertain operation's retry age.
        raise CommerceProviderError("provider_onboarding_link_expired")
