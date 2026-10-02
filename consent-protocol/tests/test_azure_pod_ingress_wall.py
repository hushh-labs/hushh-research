"""Negative control for the Azure public-ingress exception: the in-pod wall refuses.

Container Apps ingress is external and has no invoker lock, so the parity matrix lets
an Azure pod be public only because ``api/middlewares/pod_ingress.py`` verifies the
hub's Google ID token in-process. This proves the wall on the request shape Azure
actually delivers (measured: Host preserved, ``x-forwarded-proto: https``).
"""

from __future__ import annotations

import pytest

from api.middlewares import pod_ingress

_HOST = "ca-hussh-one-pod.happyfield-0123abcd.eastus2.azurecontainerapps.io"
_HUB = "consent-plane@hushh-pda-dev.iam.gserviceaccount.com"


def _scope(path: str, authorization: str = "") -> dict:
    headers = [(b"host", _HOST.encode()), (b"x-forwarded-proto", b"https")]
    if authorization:
        headers.append((b"authorization", authorization.encode()))
    return {"type": "http", "path": path, "headers": headers, "scheme": "http"}


async def _call(scope: dict) -> tuple[int, bool]:
    reached = {"app": False}
    sent: list[dict] = []

    async def app(_scope, _receive, _send):
        reached["app"] = True

    async def send(message):
        sent.append(message)

    await pod_ingress.PodIngressPolicy(app)(scope, None, send)
    status = next((m["status"] for m in sent if m["type"] == "http.response.start"), 200)
    return status, reached["app"]


@pytest.fixture(autouse=True)
def _wall(monkeypatch):
    monkeypatch.setenv("HUSSH_POD_HUB_CALLER_EMAILS", _HUB)
    monkeypatch.delenv("HUSSH_POD_TICK_ALLOWED_EMAILS", raising=False)
    monkeypatch.delenv("HUSSH_POD_TICK_AUDIENCE", raising=False)
    monkeypatch.setattr(pod_ingress, "identity_verifier", None)


def test_the_audience_is_the_agents_own_https_address():
    assert f"https://{_HOST}" in pod_ingress.accepted_audiences(_scope("/pod/public-key"))


async def test_a_machine_route_without_a_hub_token_answers_404_and_never_reaches_the_app():
    assert await _call(_scope("/pod/public-key")) == (404, False)


async def test_a_verified_token_from_anyone_but_the_hub_is_refused(monkeypatch):
    def verifier(token, audience):
        return {"email": "stranger@example.iam.gserviceaccount.com", "aud": audience}

    monkeypatch.setattr(pod_ingress, "identity_verifier", verifier)
    assert await _call(_scope("/pod/public-key", "Bearer forged")) == (404, False)


async def test_a_token_for_another_agents_address_is_refused(monkeypatch):
    def verifier(token, audience):
        if audience != "https://someone-else.azurecontainerapps.io":
            raise ValueError("audience mismatch")
        return {"email": _HUB, "aud": audience}

    monkeypatch.setattr(pod_ingress, "identity_verifier", verifier)
    assert await _call(_scope("/pod/public-key", "Bearer replayed")) == (404, False)


async def test_the_hubs_token_for_this_address_passes(monkeypatch):
    def verifier(token, audience):
        if audience != f"https://{_HOST}":
            raise ValueError("audience mismatch")
        return {"email": _HUB, "aud": audience, "email_verified": True}

    monkeypatch.setattr(pod_ingress, "identity_verifier", verifier)
    assert await _call(_scope("/pod/public-key", "Bearer hub-minted")) == (200, True)


async def test_health_stays_reachable_for_the_platform_probe():
    assert await _call(_scope("/health")) == (200, True)
