"""The pod's own workload identity on Azure, and the seam that keeps it off GCE.

A token is minted from the platform's identity endpoint for the pod's explicit
user-assigned identity, cached until five minutes before it dies, and never
requested from the Google metadata server by a pod running on Azure.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services import pod_workload_identity as identity
from hushh_mcp.services.byoc_key_custody import ByocKeyCustodyError, _metadata_token
from hushh_mcp.services.pod_commit_log import GcsObjectStore
from hushh_mcp.services.pod_workload_identity import (
    PodWorkloadIdentityUnavailable,
    forget_workload_token,
    get_workload_token,
    google_metadata_access_endpoint,
)
from tests.pod_azure_fakes import (
    CLIENT_ID,
    IDENTITY_ENDPOINT,
    FakeManagedIdentity,
    FakeResponse,
    azure_workload_env,
)

STORAGE = "https://storage.azure.com"
VAULT = "https://vault.azure.net"


@pytest.fixture(autouse=True)
def _fresh_cache(monkeypatch):
    monkeypatch.setattr(identity, "_cache", {})


def test_the_token_is_minted_for_the_explicit_identity_with_the_platform_header(monkeypatch):
    azure_workload_env(monkeypatch)
    endpoint = FakeManagedIdentity()
    token = get_workload_token(STORAGE, session=endpoint)
    assert token.startswith("mi-token-1-")
    (call,) = endpoint.calls
    assert call["url"] == IDENTITY_ENDPOINT
    assert call["params"] == {
        "api-version": "2019-08-01",
        "resource": STORAGE,
        "client_id": CLIENT_ID,
    }
    assert call["headers"] == {"X-IDENTITY-HEADER": "synthetic-identity-header"}
    assert call["allow_redirects"] is False


def test_each_resource_is_cached_until_five_minutes_before_expiry(monkeypatch):
    azure_workload_env(monkeypatch)
    endpoint = FakeManagedIdentity(lifetime_seconds=3600)
    clock = {"now": 1_000_000.0}
    # One clock for the issuer's expires_on and the cache's judgement of it.
    monkeypatch.setattr(identity.time, "time", lambda: clock["now"])
    first = get_workload_token(STORAGE, session=endpoint)
    assert get_workload_token(STORAGE, session=endpoint) == first
    assert get_workload_token(VAULT, session=endpoint) != first  # cached per resource
    clock["now"] += 3600 - 300 - 1
    assert get_workload_token(STORAGE, session=endpoint) == first
    clock["now"] += 2  # inside the five-minute margin
    assert get_workload_token(STORAGE, session=endpoint) != first
    assert [c["params"]["resource"] for c in endpoint.calls] == [STORAGE, VAULT, STORAGE]


def test_forgetting_a_resource_forces_a_fresh_mint(monkeypatch):
    azure_workload_env(monkeypatch)
    endpoint = FakeManagedIdentity()
    first = get_workload_token(STORAGE, session=endpoint)
    forget_workload_token(STORAGE)
    assert get_workload_token(STORAGE, session=endpoint) != first


@pytest.mark.parametrize(
    "unset,override",
    [
        ("IDENTITY_ENDPOINT", None),
        ("IDENTITY_HEADER", None),
        ("AZURE_CLIENT_ID", None),
        (None, ("AZURE_CLIENT_ID", "not-a-guid")),
        (None, ("IDENTITY_ENDPOINT", "http://attacker.example.com/msi/token")),
        (None, ("IDENTITY_ENDPOINT", "https://localhost:12356/msi/token")),
    ],
)
def test_no_token_without_a_local_platform_endpoint_and_explicit_identity(
    monkeypatch, unset, override
):
    azure_workload_env(monkeypatch)
    if unset:
        monkeypatch.delenv(unset)
    if override:
        monkeypatch.setenv(*override)
    endpoint = FakeManagedIdentity()
    with pytest.raises(PodWorkloadIdentityUnavailable):
        get_workload_token(STORAGE, session=endpoint)
    assert endpoint.calls == []


@pytest.mark.parametrize(
    "response",
    [
        FakeResponse(400, body={"error": "invalid_request"}),
        FakeResponse(200, body={"token_type": "Bearer"}),
        FakeResponse(200, body={"access_token": "t", "client_id": "99999999-0000-0000-0000-0000"}),
    ],
)
def test_a_refusal_or_a_token_for_another_identity_is_not_a_token(monkeypatch, response):
    azure_workload_env(monkeypatch)

    class Endpoint:
        def get(self, *_args, **_kwargs):
            return response

    with pytest.raises(PodWorkloadIdentityUnavailable):
        get_workload_token(STORAGE, session=Endpoint())


def test_the_resource_must_be_an_https_origin(monkeypatch):
    azure_workload_env(monkeypatch)
    with pytest.raises(ValueError):
        get_workload_token("https://storage.azure.com/&client_id=x", session=FakeManagedIdentity())


def test_an_azure_pod_never_asks_the_google_metadata_server(monkeypatch):
    azure_workload_env(monkeypatch)

    class NoEgress:
        def get(self, url, **_kwargs):
            pytest.fail(f"an Azure pod reached {url}")

        post = get

    with pytest.raises(PodWorkloadIdentityUnavailable):
        google_metadata_access_endpoint()
    with pytest.raises(ByocKeyCustodyError, match="credential unavailable"):
        _metadata_token(NoEgress())
    store = GcsObjectStore("misrendered-bucket", session=NoEgress())
    with pytest.raises(RuntimeError):
        store._token()


@pytest.mark.parametrize("platform_env", [{"K_SERVICE": "one-pod-ha1"}, {}])
def test_google_and_local_workloads_keep_the_metadata_server(monkeypatch, platform_env):
    for name in ("CONTAINER_APP_NAME", "K_SERVICE"):
        monkeypatch.delenv(name, raising=False)
    for name, value in platform_env.items():
        monkeypatch.setenv(name, value)
    assert "metadata.google.internal" in google_metadata_access_endpoint()
