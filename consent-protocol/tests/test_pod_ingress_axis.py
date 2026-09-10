"""`PodSpec.ingress`: who may dial one person's pod, rendered from the spec, dev only.

Two properties carry the weight: `direct` is refused outside the dev lane before
anything is rendered or bound, and the existing refusal of `allUsers` in
`set_invoker_binding` stands untouched (the public grant is a separate, named act
that only the direct axis reaches).
"""

from __future__ import annotations

import pytest

from hushh_mcp.services import gcp_backend
from hushh_mcp.services.compute_backend import PodSpec
from hushh_mcp.services.gcp_backend import (
    DIRECT_INGRESS_REQUEST_TIMEOUT_SECONDS,
    INGRESS_DIRECT,
    INGRESS_HUB,
    GcpBackend,
    PodIngressRefused,
    pod_ingress_mode,
)
from hushh_mcp.services.gcp_run_client import GcpRunClient
from hushh_mcp.services.user_gcp_backend import UserGcpBackend


def _spec(**kw) -> PodSpec:
    return PodSpec(
        hushh_id="HA1INGRESS01",
        phone_e164_hash="hash",
        pod_pubkey="pub",
        region="us-central1",
        billing_space_id="sp_1",
        **kw,
    )


def _backend() -> GcpBackend:
    return GcpBackend(project="proj-x", image="img:1", service_account="sa@proj-x.iam", live=False)


@pytest.fixture
def dev_lane(monkeypatch):
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.delenv("ENVIRONMENT", raising=False)


# -- the axis -----------------------------------------------------------------------------


def test_the_axis_defaults_to_hub_and_renders_exactly_what_it_did_before(monkeypatch):
    monkeypatch.delenv("HUSSH_POD_INGRESS", raising=False)
    spec = _spec()
    assert spec.ingress is None and pod_ingress_mode(spec) == INGRESS_HUB
    cfg = _backend().render_deploy_config(spec)
    assert cfg["metadata"]["annotations"]["run.googleapis.com/ingress"] == "internal"
    assert "timeoutSeconds" not in cfg["spec"]["template"]["spec"]


def test_direct_renders_public_ingress_and_the_long_request_timeout_on_dev(dev_lane):
    cfg = _backend().render_deploy_config(_spec(ingress=INGRESS_DIRECT))
    assert cfg["metadata"]["annotations"]["run.googleapis.com/ingress"] == "all"
    assert (
        cfg["spec"]["template"]["spec"]["timeoutSeconds"] == DIRECT_INGRESS_REQUEST_TIMEOUT_SECONDS
    )
    assert DIRECT_INGRESS_REQUEST_TIMEOUT_SECONDS == 3600


async def test_direct_is_recorded_on_the_handle_and_hub_stays_the_cloud_run_value(dev_lane):
    direct = await _backend().provision(_spec(ingress=INGRESS_DIRECT))
    assert direct.backend_metadata["ingress"] == INGRESS_DIRECT
    hub = await _backend().provision(_spec())
    assert hub.backend_metadata["ingress"] == "internal"


@pytest.mark.parametrize("lane", ["uat", "production", "prod", "", "staging"])
def test_direct_is_refused_outside_the_dev_lane_before_anything_renders(monkeypatch, lane):
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", lane)
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    with pytest.raises(PodIngressRefused):
        pod_ingress_mode(_spec(ingress=INGRESS_DIRECT))
    with pytest.raises(PodIngressRefused):
        _backend().render_deploy_config(_spec(ingress=INGRESS_DIRECT))


def test_the_lane_is_read_from_the_deploy_env_first_not_the_runtime_environment(monkeypatch):
    """Dev deploys with HUSHH_DEPLOY_ENV=dev while running ENVIRONMENT=uat."""
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.setenv("ENVIRONMENT", "uat")
    assert pod_ingress_mode(_spec(ingress=INGRESS_DIRECT)) == INGRESS_DIRECT
    monkeypatch.delenv("HUSHH_DEPLOY_ENV")
    with pytest.raises(PodIngressRefused):
        pod_ingress_mode(_spec(ingress=INGRESS_DIRECT))


def test_an_unknown_axis_value_is_refused(dev_lane):
    with pytest.raises(PodIngressRefused):
        pod_ingress_mode(_spec(ingress="public"))


def test_byoc_inherits_the_direct_render_and_refusal(dev_lane, monkeypatch):
    backend = UserGcpBackend(
        user_project="their-project",
        user_region="us-central1",
        image="img:1",
        hushh_invoker_sa="hub@proj.iam.gserviceaccount.com",
        live=False,
    )
    cfg = backend.render_deploy_config(_spec(ingress=INGRESS_DIRECT))
    assert cfg["metadata"]["annotations"]["run.googleapis.com/ingress"] == "all"
    assert cfg["spec"]["template"]["spec"]["timeoutSeconds"] == 3600
    assert cfg["metadata"]["labels"]["hussh-tenancy"] == "user-owned"
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "uat")
    with pytest.raises(PodIngressRefused):
        backend.render_deploy_config(_spec(ingress=INGRESS_DIRECT))


# -- the public grant --------------------------------------------------------------------


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


def test_set_invoker_binding_still_refuses_all_users(client, monkeypatch):
    """The existing control is untouched; the public grant is a different, named act."""
    fake = _install(monkeypatch, {"bindings": [], "etag": "e1"})
    with pytest.raises(RuntimeError, match="publicly invokable"):
        client.set_invoker_binding("one-pod-abc", "allUsers")
    assert fake.posted == []


def test_the_public_grant_names_its_axis_and_keeps_existing_bindings(client, monkeypatch):
    hub = "serviceAccount:hub@proj.iam.gserviceaccount.com"
    fake = _install(
        monkeypatch,
        {"bindings": [{"role": "roles/run.invoker", "members": [hub]}], "etag": "e7"},
    )
    with pytest.raises(RuntimeError, match="direct ingress axis"):
        client.grant_public_invoker("one-pod-abc", direct_ingress_axis="hub")
    assert fake.posted == []

    client.grant_public_invoker("one-pod-abc", direct_ingress_axis=INGRESS_DIRECT)
    url, body = fake.posted[0]
    assert url.endswith("one-pod-abc:setIamPolicy")
    assert body["policy"]["etag"] == "e7"
    assert body["policy"]["bindings"] == [
        {"role": "roles/run.invoker", "members": [hub, "allUsers"]}
    ]


def test_the_public_grant_is_idempotent(client, monkeypatch):
    fake = _install(
        monkeypatch,
        {"bindings": [{"role": "roles/run.invoker", "members": ["allUsers"]}], "etag": "e1"},
    )
    client.grant_public_invoker("one-pod-abc", direct_ingress_axis=INGRESS_DIRECT)
    assert fake.posted == []


def test_the_renderer_reads_the_lane_the_cost_labels_read():
    """One reader for the lane, so IAM and billing can never disagree about it."""
    from pathlib import Path

    source = Path(gcp_backend.__file__).read_text(encoding="utf-8")
    assert "lane = _deploy_env_label()" in source
