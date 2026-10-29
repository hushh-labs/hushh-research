# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Auth health ADC scope and credential refresh ordering."""

import importlib.util
from contextlib import nullcontext
from pathlib import Path

import pytest

pytestmark = pytest.mark.feature_auth_reliability


def load_health_setup():
    root = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location(
        "setup_auth_health", root / "deploy/observability/setup_auth_health.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_health_transport_scopes_adc_before_identity_verification(monkeypatch):
    import google.auth
    import google.auth.transport.requests
    import requests

    module = load_health_setup()
    calls = []

    class Credentials:
        token = "access-token"

        def refresh(self, request):
            calls.append(("refresh", request))

    class Response:
        status_code = 200

        @staticmethod
        def json():
            return {"email": "github-actions-uat-deployer@hushh-pda-uat.iam.gserviceaccount.com"}

    credentials = Credentials()

    def default(**kwargs):
        calls.append(("default", kwargs))
        return credentials, "hushh-pda-uat"

    def post(url, **kwargs):
        calls.append(("tokeninfo", url, kwargs))
        return nullcontext(Response())

    monkeypatch.setattr(google.auth, "default", default)
    monkeypatch.setattr(google.auth.transport.requests, "Request", lambda: "request")
    monkeypatch.setattr(requests, "post", post)
    monkeypatch.setattr(
        google.auth.transport.requests,
        "AuthorizedSession",
        lambda observed: calls.append(("session", observed)) or "authorized-session",
    )

    _, api = module._transport("hushh-pda-uat", build_only=True)

    assert api == "authorized-session"
    assert calls[0] == (
        "default",
        {"scopes": ["https://www.googleapis.com/auth/cloud-platform"]},
    )
    assert calls[1] == ("refresh", "request")
    assert calls[2][0:2] == ("tokeninfo", "https://oauth2.googleapis.com/tokeninfo")
    assert calls[3] == ("session", credentials)


def test_health_transport_stops_before_identity_or_resource_access_on_refresh_failure(
    monkeypatch,
):
    import google.auth
    import google.auth.transport.requests
    import requests

    module = load_health_setup()
    calls = []

    class Credentials:
        def refresh(self, request):
            calls.append(("refresh", request))
            raise RuntimeError("credential refresh failed")

    def default(**kwargs):
        calls.append(("default", kwargs))
        return Credentials(), "hushh-pda-uat"

    def unexpected(*_args, **_kwargs):
        raise AssertionError("Identity or resource access must follow refresh")

    monkeypatch.setattr(google.auth, "default", default)
    monkeypatch.setattr(google.auth.transport.requests, "Request", lambda: "request")
    monkeypatch.setattr(requests, "post", unexpected)
    monkeypatch.setattr(google.auth.transport.requests, "AuthorizedSession", unexpected)

    with pytest.raises(RuntimeError, match="credential refresh failed"):
        module._transport("hushh-pda-uat", build_only=True)

    assert calls[0] == (
        "default",
        {"scopes": ["https://www.googleapis.com/auth/cloud-platform"]},
    )
    assert calls[1] == ("refresh", "request")
    assert len(calls) == 2
