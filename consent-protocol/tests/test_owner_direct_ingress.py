"""A Google own-cloud agent is owner-direct by default, on Azure's model.

Before this, a `user_gcp` agent was always created hub-ingress-only and recorded a
hardcoded `internal`; becoming direct was a manual operator step that
`pod_ingress_mode` refused outside the dev lane. Azure, by contrast, starts public
with the in-pod wall and is promoted by the hub's heartbeat admission. These tests
hold the Google path to the same model: the rule is per deployment target (own-cloud
direct on any lane, the managed tier still dev-only), the registry records what was
rendered (`external` until admitted, never `direct` unverified), an existing hub-only
agent is never silently widened, and an organisation policy refusing `allUsers` is
recorded as a typed blocker rather than worked around.
"""

from __future__ import annotations

import copy
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from hushh_mcp.services import owner_direct_ingress as odi
from hushh_mcp.services import pod_external_ingress_admission as admission
from hushh_mcp.services.compute_backend import PodSpec
from hushh_mcp.services.gcp_backend import INGRESS_DIRECT, GcpBackend, pod_ingress_mode
from hushh_mcp.services.user_gcp_backend import UserGcpBackend

ORIGIN = "https://one.hushh.ai"
URL = "https://one-pod-ha1-owner-abc123-uc.a.run.app"
_REFUSAL = r"direct ingress is a dev-lane pilot"


def _spec(**kw: Any) -> PodSpec:
    base: dict[str, Any] = {
        "hushh_id": "HA1OWNERDIRECT",
        "phone_e164_hash": "hash",
        "pod_pubkey": "pub",
        "region": "us-central1",
        "billing_space_id": "sp_1",
    }
    base.update(kw)
    return PodSpec(**base)


def _user_gcp(live: bool = False) -> UserGcpBackend:
    return UserGcpBackend(
        user_project="their-project",
        user_region="us-central1",
        image="img:1",
        hushh_invoker_sa="hub@proj.iam.gserviceaccount.com",
        live=live,
    )


@pytest.fixture(params=["uat", "production", "", "staging"])
def off_dev(request, monkeypatch):
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", request.param)
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    return request.param


# -- the rule, per deployment target ------------------------------------------------------


@pytest.mark.parametrize("target", ["user_gcp", "user_azure"])
def test_own_cloud_targets_may_be_direct_on_every_lane(off_dev, target):
    spec = _spec(ingress=INGRESS_DIRECT, deployment_target=target)
    assert pod_ingress_mode(spec) == INGRESS_DIRECT


@pytest.mark.parametrize("target", [None, "gcp", "null", "unknown_cloud"])
def test_the_managed_tier_stays_hub_only_outside_dev(off_dev, target):
    spec = _spec(ingress=INGRESS_DIRECT, deployment_target=target)
    with pytest.raises(ValueError, match=_REFUSAL):
        pod_ingress_mode(spec)
    managed = GcpBackend(project="p", image="img:1", service_account="sa@p.iam", live=False)
    with pytest.raises(ValueError, match=_REFUSAL):
        managed.render_deploy_config(spec)


def test_an_unknown_axis_is_still_refused_for_own_cloud(off_dev):
    with pytest.raises(ValueError, match="unknown pod ingress axis"):
        pod_ingress_mode(_spec(ingress="public", deployment_target="user_gcp"))


def test_a_google_own_cloud_agent_renders_public_on_production(off_dev):
    spec = _spec(ingress=INGRESS_DIRECT, deployment_target="user_gcp")
    cfg = _user_gcp().render_deploy_config(spec)
    assert cfg["metadata"]["annotations"]["run.googleapis.com/ingress"] == "all"
    assert cfg["spec"]["template"]["spec"]["timeoutSeconds"] == 3600
    plan = _user_gcp().render_bootstrap_plan(spec)
    [run] = [r for r in plan["resources"] if r["type"] == "cloud_run_service"]
    assert run["ingress"] == "all"


# -- what the registry records ------------------------------------------------------------


async def test_a_direct_agent_records_external_never_direct_unadmitted(off_dev):
    handle = await _user_gcp().provision(
        _spec(ingress=INGRESS_DIRECT, deployment_target="user_gcp")
    )
    assert handle.backend_metadata["ingress"] == "external"


async def test_a_hub_agent_records_internal(off_dev):
    spec = _spec(deployment_target="user_gcp")
    handle = await _user_gcp().provision(spec)
    assert handle.backend_metadata["ingress"] == "internal"
    [run] = [
        r
        for r in _user_gcp().render_bootstrap_plan(spec)["resources"]
        if r["type"] == "cloud_run_service"
    ]
    assert run["ingress"] == "internal"


def test_an_update_never_rewrites_an_admitted_or_pending_ingress(off_dev):
    direct = _spec(ingress=INGRESS_DIRECT, deployment_target="user_gcp")
    assert odi.update_ingress_record(direct) == {}
    assert odi.update_ingress_record(_spec(deployment_target="user_gcp")) == {"ingress": "internal"}


@pytest.mark.parametrize(
    ("annotation", "recorded"),
    [("all", "external"), ("internal", "internal"), (None, "internal")],
)
def test_adoption_records_the_live_services_own_ingress(annotation, recorded):
    annotations = {"run.googleapis.com/ingress": annotation} if annotation else {}
    assert odi.observed_ingress({"metadata": {"annotations": annotations}}) == recorded
    assert odi.observed_ingress(None) == "internal"


# -- which agents provisioning asks to be direct ------------------------------------------


@pytest.mark.parametrize(
    ("target", "observed", "expected"),
    [
        ("user_gcp", None, "direct"),
        ("user_gcp", {"backend_metadata": {"provisionAttempt": {}}}, "direct"),
        ("user_gcp", {"backend_metadata": {"ingress": "external"}}, "direct"),
        ("user_gcp", {"backend_metadata": {"ingress": "direct"}}, "direct"),
        # An existing hub-only agent is never widened by a heal.
        ("user_gcp", {"backend_metadata": {"ingress": "internal"}}, None),
        ("user_azure", None, None),
        ("gcp", None, None),
        (None, None, None),
    ],
)
def test_provision_asks_for_direct_only_for_a_new_or_public_google_agent(
    target, observed, expected
):
    assert odi.ingress_for_provision(target, observed) == expected


@pytest.mark.parametrize(
    ("metadata", "expected"),
    [
        ({"ingress": "direct"}, "direct"),
        ({"ingress": "external"}, "direct"),
        ({"ingress": "internal"}, None),
        ({}, None),
        (None, None),
    ],
)
def test_an_update_keeps_the_recorded_axis(metadata, expected):
    assert odi.ingress_for_update(metadata) == expected


# -- the public grant and the organisation-policy blocker ---------------------------------


class _Client:
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.grants: list[tuple[str, str]] = []

    def grant_public_invoker(self, name: str, *, direct_ingress_axis: str) -> dict:
        self.grants.append((name, direct_ingress_axis))
        if self.error is not None:
            raise self.error
        return {}


def _http_error(status: int, text: str) -> Exception:
    error = RuntimeError(f"HTTP {status}")
    error.response = SimpleNamespace(status_code=status, text=text)  # type: ignore[attr-defined]
    return error


async def test_the_grant_binds_all_users_and_records_external(off_dev):
    client, stages = _Client(), []
    spec = _spec(ingress=INGRESS_DIRECT, deployment_target="user_gcp", on_stage=stages.append)
    assert await odi.bind_owner_direct_ingress(client, "one-pod-x", spec) == {"ingress": "external"}
    assert client.grants == [("one-pod-x", "direct")]
    assert stages == ["public_invoker_bound"]


async def test_a_hub_spec_is_never_granted_a_public_invoker():
    client = _Client()
    record = await odi.bind_owner_direct_ingress(client, "one-pod-x", _spec())
    assert record == {"ingress": "internal"} and client.grants == []


@pytest.mark.parametrize(
    ("status", "text"),
    [
        (400, "One or more users named in the policy do not belong to a permitted customer."),
        (412, "Request violates constraint constraints/iam.allowedPolicyMemberDomains"),
    ],
)
async def test_an_org_policy_refusal_is_a_typed_blocker_and_stays_hub(off_dev, status, text):
    client = _Client(_http_error(status, text))
    spec = _spec(ingress=INGRESS_DIRECT, deployment_target="user_gcp")
    record = await odi.bind_owner_direct_ingress(client, "one-pod-x", spec)
    assert record == {
        "ingress": "internal",
        "directIngressBlocker": {"code": odi.BLOCKER_ORG_POLICY, "status": status},
    }
    # The blocked row is hub-only, so the next provision does not retry the widening.
    assert odi.ingress_for_provision("user_gcp", {"backend_metadata": record}) is None
    assert admission.admission_due(_row(backend_metadata={**record, "url": URL})) is None


@pytest.mark.parametrize(
    "error",
    [_http_error(500, "backend error"), _http_error(403, "caller lacks permission"), OSError()],
)
async def test_any_other_grant_failure_is_raised_not_absorbed(off_dev, error):
    spec = _spec(ingress=INGRESS_DIRECT, deployment_target="user_gcp")
    with pytest.raises(type(error)):
        await odi.bind_owner_direct_ingress(_Client(error), "one-pod-x", spec)


# -- heartbeat admission, for a Google agent ----------------------------------------------


def _row(**overrides: Any) -> dict:
    row = {
        "user_id": "owner",
        "hushh_id": "ha1_owner",
        "status": "provisioned",
        "deployment_target": "user_gcp",
        "pod_key_id": "pod_key_1",
        "pod_pubkey": "cHVibGlj",
        "backend_metadata": {"ingress": "external", "url": URL, "serviceUid": "svc-1"},
    }
    row.update(overrides)
    return row


def _pod(wall: int = 404, allow_origin: str | None = ORIGIN, preflight: int = 204):
    def handle(request: httpx.Request) -> httpx.Response:
        if request.method == "GET" and request.url.path == "/pod/info":
            return httpx.Response(wall)
        if request.method == "OPTIONS":
            headers = {"access-control-allow-origin": allow_origin} if allow_origin else {}
            return httpx.Response(preflight, headers=headers)
        return httpx.Response(500)

    return httpx.AsyncClient(transport=httpx.MockTransport(handle))


@pytest.fixture
def promoted(monkeypatch):
    calls: list[dict] = []

    async def promote(_db, **fields):
        calls.append(fields)
        return True

    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_direct_admission.promote_external_ingress", promote
    )
    return calls


async def test_a_verified_google_agent_is_promoted_to_direct(promoted):
    assert await admission.admit_external_ingress_if_due(
        _row(), client=_pod(), db=object(), origin=ORIGIN
    )
    [fields] = promoted
    assert fields["url"] == URL and fields["service_uid"] == "svc-1"


@pytest.mark.parametrize(
    ("pod", "why"),
    [
        ({"wall": 200}, "an open wall serves machine routes to anyone"),
        ({"allow_origin": "https://elsewhere.example"}, "a wrong origin echoed"),
        ({"allow_origin": None}, "no origin echoed"),
        # Cloud Run refusing an identity-less caller at its front (no `allUsers`).
        ({"wall": 403, "preflight": 403, "allow_origin": None}, "no public invoker"),
    ],
)
async def test_a_google_agent_that_fails_a_check_stays_not_ready(promoted, pod, why):
    assert not await admission.admit_external_ingress_if_due(
        _row(), client=_pod(**pod), db=object(), origin=ORIGIN
    ), why
    assert promoted == []


# -- provisioning, end to end in plan mode ------------------------------------------------


async def _provision(monkeypatch, observed_metadata: dict | None):
    from hushh_mcp.runtime_settings import get_core_security_settings
    from hushh_mcp.services.byoc_substrate import NoSubstrateRequired
    from hushh_mcp.services.personal_agent_provisioning_service import (
        PersonalAgentProvisioningService,
    )
    from hushh_mcp.services.pod_connector_keypair_service import generate_pod_keypair
    from tests.test_personal_agent_provisioning_service import FakeGrant, FakeRegistry

    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
    monkeypatch.setenv("VAULT_DATA_KEY", "0" * 64)
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "production")
    get_core_security_settings.cache_clear()
    registry = FakeRegistry()
    if observed_metadata is not None:
        registry.rows["uid_1"] = {"backend_metadata": observed_metadata}
    stored_get = registry.get

    async def snapshot(user_id):
        # The real repository returns a fresh row; the fake's later upsert would
        # otherwise mutate the observation provisioning decided from.
        return copy.deepcopy(await stored_get(user_id))

    registry.get = snapshot  # type: ignore[method-assign]
    specs: list[PodSpec] = []
    backend = _user_gcp()
    real = backend.provision

    async def capture(spec):
        specs.append(spec)
        return await real(spec)

    monkeypatch.setattr(backend, "provision", capture)
    service = PersonalAgentProvisioningService(
        registry=registry, grant=FakeGrant(), substrate=NoSubstrateRequired()
    )
    monkeypatch.setattr(service, "_backend_for", lambda _spec: backend)
    pod = generate_pod_keypair().public()
    await service.provision(
        user_id="uid_1",
        phone_e164="+14255550177",
        pod_public_key_b64=pod.public_key_b64,
        pod_key_id=pod.key_id,
        deployment_target="user_gcp",
    )
    get_core_security_settings.cache_clear()
    return specs, registry.upserts[-1]["backend_metadata"]


async def test_provisioning_creates_a_google_agent_direct_and_records_external(monkeypatch):
    specs, metadata = await _provision(monkeypatch, None)
    assert [spec.ingress for spec in specs] == ["direct"]
    assert metadata["ingress"] == "external"


async def test_provisioning_never_widens_a_hub_only_google_agent(monkeypatch):
    specs, metadata = await _provision(monkeypatch, {"ingress": "internal"})
    assert [spec.ingress for spec in specs] == [None]
    assert metadata["ingress"] == "internal"
