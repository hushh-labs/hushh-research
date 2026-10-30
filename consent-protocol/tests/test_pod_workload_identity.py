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
    get_workload_access_token,
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
    issued = get_workload_access_token(STORAGE, session=endpoint)
    assert issued.token == token and issued.expires_at > identity.time.time() + 300
    assert token not in repr(issued)
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


@pytest.mark.parametrize("defect", [None, "client_id", "resource", "expires_on", "token_type"])
def test_vm_tokens_require_registered_exact_identity_resource_and_expiry(monkeypatch, defect):
    from hushh_mcp.services import pod_azure_vm_identity as vm
    from tests.pod_azure_fakes import vm_installation

    installation, _ = vm_installation(monkeypatch)
    with pytest.raises(PodWorkloadIdentityUnavailable):
        get_workload_token(STORAGE)
    vm.initialize_vm_installation()
    calls = []

    def mint(endpoint, params):
        assert endpoint == vm.IMDS_IDENTITY_ENDPOINT
        assert params == {
            "api-version": "2018-02-01",
            "resource": STORAGE,
            "client_id": installation.client_id,
        }
        calls.append(params)
        result = {
            "access_token": "synthetic-vm-token",
            "resource": STORAGE,
            "expires_on": str(int(identity.time.time()) + 3600),
            "token_type": "Bearer",
        }
        if defect:
            result[defect] = "wrong"
        return result

    monkeypatch.setattr(identity, "imds_json", mint)
    if defect:
        with pytest.raises(PodWorkloadIdentityUnavailable):
            get_workload_token(STORAGE)
    else:
        assert get_workload_token(STORAGE) == get_workload_token(STORAGE) == "synthetic-vm-token"
        with pytest.raises(PodWorkloadIdentityUnavailable):
            google_metadata_access_endpoint()
    assert len(calls) == 1


@pytest.mark.parametrize("response", ["ok", "redirect", "oversize", "invalid", "transport"])
def test_vm_imds_transport_bypasses_proxy_bounds_reads_and_closes(monkeypatch, response):
    import httpx

    from hushh_mcp.services import pod_azure_vm_identity as vm

    original_client = httpx.Client
    clients = []
    monkeypatch.setenv("HTTP_PROXY", "http://untrusted.example")

    def handler(request):
        assert request.url.host == "169.254.169.254"
        assert request.headers["metadata"] == "true"
        if response == "transport":
            raise httpx.ConnectError("synthetic-private-provider-detail", request=request)
        if response == "redirect":
            return httpx.Response(302, headers={"location": "https://untrusted.example"})
        content = (
            b'{"vmId":"synthetic"}'
            if response == "ok"
            else b"x" * (65537 if response == "oversize" else 2)
        )
        return httpx.Response(200, content=content)

    def client(**kwargs):
        assert kwargs["trust_env"] is False and kwargs["follow_redirects"] is False
        assert kwargs["timeout"].connect == 2.0 and kwargs["timeout"].read == 5.0
        instance = original_client(transport=httpx.MockTransport(handler), **kwargs)
        clients.append(instance)
        return instance

    monkeypatch.setattr(vm.httpx, "Client", client)
    if response == "ok":
        assert vm.imds_json(vm.IMDS_COMPUTE, {"api-version": "2025-04-07"}) == {"vmId": "synthetic"}
    else:
        with pytest.raises(vm.AzureVmIdentityRefused) as error:
            vm.imds_json(vm.IMDS_COMPUTE, {"api-version": "2025-04-07"})
        assert str(error.value) == (
            "VM metadata exceeds its bound" if response == "oversize" else "VM metadata unavailable"
        )
    assert len(clients) == 1 and clients[0].is_closed


@pytest.mark.parametrize("platform_env", [{"K_SERVICE": "one-pod-ha1"}, {}])
def test_google_and_local_workloads_keep_the_metadata_server(monkeypatch, platform_env):
    for name in ("CONTAINER_APP_NAME", "K_SERVICE"):
        monkeypatch.delenv(name, raising=False)
    for name, value in platform_env.items():
        monkeypatch.setenv(name, value)
    assert "metadata.google.internal" in google_metadata_access_endpoint()


@pytest.mark.asyncio
async def test_native_workload_credential_preserves_identity_scope_and_issuer_expiry(monkeypatch):
    import time

    from hushh_mcp.services import pod_workload_identity
    from hushh_mcp.services.pod_browser.azure_credentials import (
        DATA_PLANE_SCOPE,
        AzureWorkloadCredential,
    )
    from hushh_mcp.services.pod_browser.contracts import BrowserRefused

    azure_workload_env(monkeypatch)
    endpoint = FakeManagedIdentity(lifetime_seconds=3600)
    original = pod_workload_identity.get_workload_access_token
    monkeypatch.setattr(pod_workload_identity, "_cache", {})
    monkeypatch.setattr(
        pod_workload_identity,
        "get_workload_access_token",
        lambda resource: original(resource, session=endpoint),
    )
    credential = AzureWorkloadCredential(CLIENT_ID)
    issued = await credential.get_token(DATA_PLANE_SCOPE)
    assert issued.expires_at > time.time() + 300
    assert issued.token not in repr(issued)
    assert endpoint.calls[0]["params"]["resource"] == "https://management.azuredevcompute.io/"
    for scope, client_id in (
        ("https://storage.azure.com/.default", CLIENT_ID),
        (DATA_PLANE_SCOPE, "99999999-0000-0000-0000-000000000000"),
    ):
        monkeypatch.setenv("AZURE_CLIENT_ID", client_id)
        with pytest.raises(BrowserRefused, match="AZURE_PROBE_AUTH_REFUSED"):
            await credential.get_token(scope)
    assert len(endpoint.calls) == 1
