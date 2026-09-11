"""The run.invoker binding — the thing two modules assumed and no code did.

`pod_relay.py` and `pod_key_collector.py` both state that the pod SA grants
run.invoker to the hub. Until now that was true in a runbook and nowhere else, so a
created pod was invokable by nobody: the key pull returned None, the registry row
parked in `connecting` forever, and nothing reported a fault.

Two properties here are load-bearing beyond the happy path:

  * a pod is NEVER made publicly invokable, and
  * writing the binding never drops bindings that were already there.

The second is the quiet one. `setIamPolicy` replaces the whole policy, so a
freshly-built one-binding document silently deletes everything else on the service.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.gcp_run_client import GcpRunClient


class _Response:
    def __init__(self, payload: dict, status: int = 200) -> None:
        self._payload = payload
        self.status_code = status

    def json(self) -> dict:
        return self._payload

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class _Requests:
    """Stands in for the `requests` module the client imports inside each method."""

    def __init__(self, policy: dict) -> None:
        self.policy = policy
        self.posted: list[tuple[str, dict]] = []

    def get(self, url, **_kwargs):
        return _Response(self.policy)

    def post(self, url, **kwargs):
        body = kwargs.get("json") or {}
        self.posted.append((url, body))
        return _Response(body.get("policy") or {})


@pytest.fixture
def client(monkeypatch):
    c = GcpRunClient(project="proj", region="us-central1", credentials=object())
    monkeypatch.setattr(c, "_headers", lambda: {"Authorization": "Bearer t"})
    return c


def _install(monkeypatch, policy: dict) -> _Requests:
    fake = _Requests(policy)
    monkeypatch.setitem(__import__("sys").modules, "requests", fake)
    return fake


HUB = "serviceAccount:hub@proj.iam.gserviceaccount.com"


# -- the refusal --------------------------------------------------------------


@pytest.mark.parametrize("public", ["allUsers", "allAuthenticatedUsers"])
def test_a_pod_is_never_made_publicly_invokable(client, monkeypatch, public):
    """Non-targetability is the pod's whole security property. IAM controls WHO,
    which is a stronger lever than ingress's WHERE -- so this refuses rather than
    trusting the caller."""
    fake = _install(monkeypatch, {"bindings": [], "etag": "e1"})

    with pytest.raises(RuntimeError, match="publicly invokable"):
        client.set_invoker_binding("one-pod-abc", public)

    assert fake.posted == []


def test_an_empty_member_is_refused(client, monkeypatch):
    fake = _install(monkeypatch, {"bindings": [], "etag": "e1"})
    with pytest.raises(RuntimeError, match="requires a member"):
        client.set_invoker_binding("one-pod-abc", "  ")
    assert fake.posted == []


# -- read-modify-write --------------------------------------------------------


def test_the_binding_is_added_when_the_policy_is_empty(client, monkeypatch):
    fake = _install(monkeypatch, {"bindings": [], "etag": "e1"})

    client.set_invoker_binding("one-pod-abc", HUB)

    url, body = fake.posted[0]
    assert url.endswith("/services/one-pod-abc:setIamPolicy")
    assert body["policy"]["bindings"] == [{"role": "roles/run.invoker", "members": [HUB]}]


def test_existing_bindings_are_never_dropped(client, monkeypatch):
    """setIamPolicy replaces the WHOLE policy. A blind write would delete this."""
    existing = {
        "bindings": [{"role": "roles/run.viewer", "members": ["serviceAccount:ops@x"]}],
        "etag": "e1",
    }
    fake = _install(monkeypatch, existing)

    client.set_invoker_binding("one-pod-abc", HUB)

    roles = {b["role"] for b in fake.posted[0][1]["policy"]["bindings"]}
    assert roles == {"roles/run.viewer", "roles/run.invoker"}


def test_a_second_member_joins_the_existing_invoker_binding(client, monkeypatch):
    existing = {
        "bindings": [{"role": "roles/run.invoker", "members": ["serviceAccount:other@x"]}],
        "etag": "e1",
    }
    fake = _install(monkeypatch, existing)

    client.set_invoker_binding("one-pod-abc", HUB)

    invoker = [
        b for b in fake.posted[0][1]["policy"]["bindings"] if b["role"] == "roles/run.invoker"
    ][0]
    assert set(invoker["members"]) == {"serviceAccount:other@x", HUB}


def test_the_etag_is_carried_so_a_concurrent_write_rejects(client, monkeypatch):
    """Without the etag, a racing change is overwritten with no error."""
    fake = _install(monkeypatch, {"bindings": [], "etag": "e-live"})

    client.set_invoker_binding("one-pod-abc", HUB)

    assert fake.posted[0][1]["policy"]["etag"] == "e-live"


def test_an_already_bound_member_writes_nothing(client, monkeypatch):
    """Re-provision and heal must not churn the policy."""
    existing = {"bindings": [{"role": "roles/run.invoker", "members": [HUB]}], "etag": "e1"}
    fake = _install(monkeypatch, existing)

    client.set_invoker_binding("one-pod-abc", HUB)

    assert fake.posted == []


def test_iam_uses_the_admin_surface_not_the_knative_one(client, monkeypatch):
    """There is no IAM verb under /apis/serving.knative.dev — a wrong base URL here
    would 404 at provision time, in the one code path nobody exercises locally."""
    fake = _install(monkeypatch, {"bindings": [], "etag": "e1"})

    client.set_invoker_binding("one-pod-abc", HUB)

    url = fake.posted[0][0]
    assert "/apis/serving.knative.dev" not in url
    assert url.startswith("https://us-central1-run.googleapis.com/v1/projects/proj/locations/")


# -- where the hub's Cloud Run credentials come from ---------------------------
#
# The live dev hub has no GCP_DEPLOY_SA_KEY_B64 among its 60 env entries, so this
# function used to raise and pod creation was impossible. Mounting the operator key
# would have "fixed" it by putting ORG-ADMIN credentials in a shared,
# internet-reachable, multi-tenant service. The hub already runs as
# consent-protocol-runtime, which holds roles/run.admin.


def test_an_explicit_key_is_used_when_supplied(monkeypatch):
    """Operator tooling and CI run outside GCP, where there is no attached identity."""
    import base64
    import json

    from hushh_mcp.services import gcp_run_client

    seen = {}

    class _SA:
        # Production calls service_account.Credentials.from_service_account_info,
        # so the fake has to carry the same nesting or it tests nothing real.
        class Credentials:
            @staticmethod
            def from_service_account_info(info, scopes=None):
                seen["email"] = info.get("client_email")
                seen["scopes"] = scopes
                return "explicit-creds"

    import google.oauth2

    monkeypatch.setattr(google.oauth2, "service_account", _SA, raising=False)
    key = base64.b64encode(json.dumps({"client_email": "op@example"}).encode()).decode()

    assert gcp_run_client.load_operator_credentials(key) == "explicit-creds"
    assert seen["email"] == "op@example"


def test_the_attached_identity_is_used_when_no_key_is_set(monkeypatch):
    """No key material anywhere: nothing to leak, rotate, or commit."""
    from hushh_mcp.services import gcp_run_client

    monkeypatch.delenv("GCP_DEPLOY_SA_KEY_B64", raising=False)
    seen = {}

    def _default(scopes=None):
        seen["scopes"] = scopes
        return ("attached-creds", "hushh-pda-dev")

    import google.auth

    monkeypatch.setattr(google.auth, "default", _default)

    assert gcp_run_client.load_operator_credentials() == "attached-creds"
    # Same scopes either way, so a caller cannot tell the paths apart.
    assert seen["scopes"] == gcp_run_client._SCOPES


def test_no_credentials_at_all_names_both_paths(monkeypatch):
    """ "No credentials" with no hint of where they should come from is how this
    stayed broken."""
    from hushh_mcp.services import gcp_run_client

    monkeypatch.delenv("GCP_DEPLOY_SA_KEY_B64", raising=False)

    def _boom(scopes=None):
        raise RuntimeError("could not determine default credentials")

    import google.auth

    monkeypatch.setattr(google.auth, "default", _boom)

    with pytest.raises(RuntimeError) as exc:
        gcp_run_client.load_operator_credentials()
    message = str(exc.value)
    assert "GCP_DEPLOY_SA_KEY_B64" in message
    assert "attached service account" in message
