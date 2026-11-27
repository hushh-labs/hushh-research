"""A Sentinel gate with no Google web client must not take Gmail offline.

On 2026-11-27 every private-mailbox read on UAT failed with 503: the pod's token refresh went
to the Sentinel gate, which held no web client and answered 400, and the exchange (unlike the
readiness check) never fell back to the pod's own sidecar.
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from hushh_mcp.services import pod_google_oauth
from hushh_mcp.services.agent_sandbox.sentinel_proxy_server import (
    GOOGLE_OAUTH_GATE_UNCONFIGURED,
    SentinelProxyRuntime,
)

TOKEN_URL = pod_google_oauth.TOKEN_URL
GATE = "http://gate.test"
REFRESH = {
    "grant_type": "refresh_token",
    "client_id": "123456789-abcdefghij.apps.googleusercontent.com",
    "refresh_token": "1//refresh",
    "scope": "https://www.googleapis.com/auth/gmail.readonly",
}


def test_the_pod_and_the_gate_agree_on_the_unconfigured_code() -> None:
    assert pod_google_oauth.GOOGLE_OAUTH_GATE_UNCONFIGURED == GOOGLE_OAUTH_GATE_UNCONFIGURED


@pytest.fixture
def pod(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr("hushh_mcp.services.pod_owner_cloud.hosted_ace_runtime", lambda: True)
    monkeypatch.setenv("HUSSH_MODEL_GATEWAY_URL", GATE)
    monkeypatch.setenv("HUSSH_MODEL_GATEWAY_TOKEN", "surrogate")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "uat")
    calls: list[str] = []
    answers: dict[str, tuple[int, dict]] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        status, body = answers[str(request.url)]
        return httpx.Response(status, json=body)

    real = httpx.AsyncClient

    class Client(real):  # type: ignore[misc, valid-type]
        def __init__(self, *args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(handler)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", Client)
    return calls, answers


GATE_EXCHANGE = f"{GATE}/v1/oauth/google/exchange"
SIDECAR = "http://127.0.0.1:8764/exchange"
GRANT = {"access_token": "ya29.ok", "scope": REFRESH["scope"], "expires_in": 3599}


@pytest.mark.asyncio
async def test_a_gate_without_a_client_hands_the_exchange_to_the_uat_sidecar(pod) -> None:
    calls, answers = pod
    answers[GATE_EXCHANGE] = (503, {"error": GOOGLE_OAUTH_GATE_UNCONFIGURED})
    answers[SIDECAR] = (200, GRANT)
    status, body = await pod_google_oauth.hosted_web_oauth_exchange(TOKEN_URL, REFRESH)
    assert (status, body) == (200, GRANT)
    assert calls == [GATE_EXCHANGE, SIDECAR]


@pytest.mark.asyncio
async def test_a_configured_gate_answers_alone_and_a_real_refusal_is_final(pod) -> None:
    calls, answers = pod
    answers[GATE_EXCHANGE] = (200, GRANT)
    assert (await pod_google_oauth.hosted_web_oauth_exchange(TOKEN_URL, REFRESH))[0] == 200
    answers[GATE_EXCHANGE] = (400, {"error": "invalid_grant"})
    status, body = await pod_google_oauth.hosted_web_oauth_exchange(TOKEN_URL, REFRESH)
    assert (status, body) == (400, {"error": "invalid_grant"})
    # Google's own refusal is never retried through the sidecar.
    assert SIDECAR not in calls


@pytest.mark.asyncio
async def test_outside_uat_an_unconfigured_gate_is_reported_not_bypassed(
    pod, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls, answers = pod
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "production")
    answers[GATE_EXCHANGE] = (503, {"error": GOOGLE_OAUTH_GATE_UNCONFIGURED})
    status, body = await pod_google_oauth.hosted_web_oauth_exchange(TOKEN_URL, REFRESH)
    assert (status, body) == (503, {"error": GOOGLE_OAUTH_GATE_UNCONFIGURED})
    assert SIDECAR not in calls


def test_the_gate_names_an_unconfigured_client_instead_of_refusing_the_request(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for name in (
        "GOOGLE_WEB_OAUTH_CLIENT_ID",
        "GOOGLE_WEB_OAUTH_CLIENT_SECRET",
        "GOOGLE_UAT_MAIL_WEB_CLIENT_ID",
        "GOOGLE_UAT_MAIL_WEB_CLIENT_SECRET",
        "GOOGLE_OAUTH_CLIENT_ID",
        "GOOGLE_OAUTH_CLIENT_SECRET",
    ):
        monkeypatch.delenv(name, raising=False)
    runtime = SentinelProxyRuntime(
        hmac_key=b"S" * 32,
        control_token="ctrl-gate-unconfigured-01",  # noqa: S106 - synthetic test token
        audit_log_path=tmp_path / "audit.jsonl",
        proxy_port=0,
        control_port=0,
        model_gateway_port=0,
        upstream_transport=lambda *_: pytest.fail("an unconfigured gate must not reach Google"),
    )
    grant = type("Grant", (), {"lease_id": "lease", "owner_id": "owner"})()
    status, body = runtime.handle_google_oauth_exchange(grant=grant, form=REFRESH)
    assert (status, json.dumps(body)) == (
        503,
        json.dumps({"error": GOOGLE_OAUTH_GATE_UNCONFIGURED}),
    )
    assert runtime.handle_google_oauth_ready() == (503, {})
    # A malformed request is still a bad request, configured or not.
    assert runtime.handle_google_oauth_exchange(grant=grant, form={"": ""})[0] == 400
