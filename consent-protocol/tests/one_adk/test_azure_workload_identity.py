"""Cloud Run to Entra assertion exchange, without live metadata or Azure calls."""

import httpx
import pytest

from hushh_mcp.one_adk import azure_workload_identity as auth


def _mock_metadata(monkeypatch, handler):
    original_client = httpx.Client
    options = {}

    def client_factory(**kwargs):
        options.update(kwargs)
        return original_client(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(auth.httpx, "Client", client_factory)
    return options


def test_google_assertion_uses_cloud_run_metadata_and_bounded_request(monkeypatch):
    def metadata(request):
        assert request.url.host == "metadata.google.internal"
        assert request.url.path.endswith("/service-accounts/default/identity")
        assert request.url.params["audience"] == "api://AzureADTokenExchange"
        assert request.headers["Metadata-Flavor"] == "Google"
        return httpx.Response(200, text="  synthetic.google.jwt  ")

    options = _mock_metadata(monkeypatch, metadata)
    assert auth._google_identity_assertion(timeout_seconds=1.5) == "synthetic.google.jwt"
    assert options == {"timeout": 1.5, "trust_env": False, "follow_redirects": False}


@pytest.mark.parametrize(
    "response",
    [httpx.Response(503, text="provider error"), httpx.Response(200, text=" ")],
)
def test_google_assertion_fails_closed_without_exposing_response(monkeypatch, response):
    _mock_metadata(monkeypatch, lambda request: response)
    with pytest.raises(auth.AzureWorkloadIdentityError) as error:
        auth._google_identity_assertion(timeout_seconds=2.0)
    assert "provider error" not in str(error.value)


def test_google_assertion_bounds_network_timeout(monkeypatch):
    def metadata(request):
        raise httpx.ConnectTimeout("metadata timeout", request=request)

    _mock_metadata(monkeypatch, metadata)
    with pytest.raises(auth.AzureWorkloadIdentityError, match="metadata is unavailable"):
        auth._google_identity_assertion(timeout_seconds=1.0)


def test_token_provider_wires_google_assertion_into_cognitive_services_scope(monkeypatch):
    observed = {}

    def metadata(request):
        return httpx.Response(200, text="synthetic.google.jwt")

    options = _mock_metadata(monkeypatch, metadata)

    class FakeCredential:
        def __init__(self, *, tenant_id, client_id, func, **network_options):
            observed.update(
                tenant_id=tenant_id, client_id=client_id, network_options=network_options
            )
            self.func = func

    def fake_bearer_provider(credential, scope):
        observed["scope"] = scope
        return lambda: f"synthetic.azure.token:{credential.func()}"

    monkeypatch.setattr(auth, "ClientAssertionCredential", FakeCredential)
    monkeypatch.setattr(auth, "get_bearer_token_provider", fake_bearer_provider)

    provider = auth.azure_openai_token_provider(
        tenant_id="synthetic-tenant", client_id="synthetic-client", metadata_timeout_seconds=1.0
    )
    assert provider() == "synthetic.azure.token:synthetic.google.jwt"
    assert observed == {
        "tenant_id": "synthetic-tenant",
        "client_id": "synthetic-client",
        "scope": "https://cognitiveservices.azure.com/.default",
        "network_options": {
            "connection_timeout": 2.0,
            "read_timeout": 5.0,
            "retry_total": 0,
        },
    }
    assert options["timeout"] == 1.0


@pytest.mark.parametrize("tenant_id,client_id", [("", "client"), ("tenant", " ")])
def test_token_provider_requires_identity_configuration(tenant_id, client_id):
    with pytest.raises(ValueError, match="required"):
        auth.azure_openai_token_provider(tenant_id=tenant_id, client_id=client_id)


@pytest.mark.parametrize("timeout", [0, -1, 11])
def test_token_provider_rejects_unbounded_metadata_timeout(timeout):
    with pytest.raises(ValueError, match="metadata_timeout_seconds"):
        auth.azure_openai_token_provider(
            tenant_id="tenant", client_id="client", metadata_timeout_seconds=timeout
        )
