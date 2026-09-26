"""Founder decision 2026-09-25: localhost runs Drive on the UAT Drive project.

The shared registry row stays https-only; the runtime admits the loopback web
return only for a development process whose frontend origin is a loopback host.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from hushh_mcp.services.external_connector_google_oauth import registered_redirect_uris

UAT_ROW = SimpleNamespace(
    registered_redirect_uris=[
        "https://uat.one.hushh.ai/one/profile/connectors/oauth/return",
        "https://api.uat.hushh.ai/api/connectors/oauth/native/callback",
    ]
)
LOCAL_RETURN = "http://localhost:3000/one/profile/connectors/oauth/return"


def _env(monkeypatch: pytest.MonkeyPatch, environment: str, origin: str) -> None:
    monkeypatch.setenv("ENVIRONMENT", environment)
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", origin)


def test_development_loopback_origin_adds_the_local_web_return(monkeypatch):
    _env(monkeypatch, "development", "http://localhost:3000")
    uris = registered_redirect_uris(UAT_ROW)
    assert uris[-1] == LOCAL_RETURN
    assert set(UAT_ROW.registered_redirect_uris) <= set(uris)


@pytest.mark.parametrize("environment", ["uat", "production", "dev", ""])
def test_non_development_runtimes_never_add_loopback(monkeypatch, environment):
    _env(monkeypatch, environment, "http://localhost:3000")
    assert registered_redirect_uris(UAT_ROW) == tuple(UAT_ROW.registered_redirect_uris)


@pytest.mark.parametrize(
    "origin",
    [
        "https://localhost:3000",
        "http://evil.example.com",
        "http://localhost.evil.example.com:3000",
        "http://user@localhost:3000",
        "http://localhost:3000/extra",
        "",
    ],
)
def test_only_a_plain_http_loopback_origin_is_admitted(monkeypatch, origin):
    _env(monkeypatch, "development", origin)
    assert registered_redirect_uris(UAT_ROW) == tuple(UAT_ROW.registered_redirect_uris)


def test_loopback_return_is_not_duplicated(monkeypatch):
    _env(monkeypatch, "development", "http://localhost:3000")
    row = SimpleNamespace(registered_redirect_uris=[LOCAL_RETURN])
    assert registered_redirect_uris(row) == (LOCAL_RETURN,)
