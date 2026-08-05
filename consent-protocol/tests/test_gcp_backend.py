"""Tests for the GCP compute backend (Apple-PCC-on-GCP, plan-mode, inert)."""

from __future__ import annotations

from hushh_mcp.services.compute_backend import (
    BACKEND_GCP,
    TIER_DEDICATED,
    TIER_LOGICAL,
    ComputeBackend,
    PodSpec,
)
from hushh_mcp.services.gcp_backend import A2A_ADDRESS_BASE, GcpBackend, _service_name


def _spec(*, tier: str = TIER_LOGICAL, hushh_id: str = "HA1ABC234DEF") -> PodSpec:
    return PodSpec(
        hushh_id=hushh_id,
        phone_e164_hash="hash",
        pod_pubkey="pub",
        region="us-central1",
        tier=tier,
        space_id="sp_1",
        runtime_version="rt1",
        prompt_version="pv1",
    )


def _backend() -> GcpBackend:
    return GcpBackend(project="proj-x", image="img:1", service_account="sa@proj-x.iam", live=False)


def test_satisfies_compute_backend_protocol():
    assert isinstance(_backend(), ComputeBackend)
    assert _backend().backend_id == BACKEND_GCP


def test_service_name_is_dns_safe():
    name = _service_name("HA1_ABC/xyz")
    assert name == name.lower()
    assert name.startswith("one-pod-")
    assert all(c.isalnum() or c == "-" for c in name)
    assert len(name) <= 63


def test_render_deploy_config_is_a_cloud_run_service():
    cfg = _backend().render_deploy_config(_spec())
    assert cfg["kind"] == "Service"
    assert cfg["apiVersion"].startswith("serving.knative.dev")
    assert cfg["metadata"]["name"].startswith("one-pod-")
    # internal ingress: the pod is never publicly reachable
    assert cfg["metadata"]["annotations"]["run.googleapis.com/ingress"] == "internal"
    assert cfg["metadata"]["labels"]["hussh-space-id"] == "sp_1"


def test_rendered_config_carries_identity_but_no_secrets():
    cfg = _backend().render_deploy_config(_spec())
    env = cfg["spec"]["template"]["spec"]["containers"][0]["env"]
    names = {e["name"] for e in env}
    assert "HUSSH_ID" in names and "HUSSH_SPACE_ID" in names
    # No secret material is ever baked into the deploy artifact.
    blob = str(cfg).lower()
    for forbidden in ("secret", "api_key", "apikey", "password", "token", "private"):
        assert forbidden not in blob


def test_startup_probe_is_http_not_the_tcp_default():
    """The load-bearing fix for false health.

    Cloud Run's default startup probe is a TCP connect, and gunicorn binds its port
    before forking workers. A pod whose workers die on import therefore reported
    Ready=True and "Containers became healthy in 1.2s" while serving 503 to every
    request (hushh-pda-dev, 2026-08-04) -- and wait_ready(), get() and the reconcile
    worker all read that same condition, so provision() returned status="live" for a
    dead pod. An explicit HTTP probe is what makes the condition mean what it says.
    """
    container = _backend().render_deploy_config(_spec())["spec"]["template"]["spec"]["containers"][
        0
    ]
    probe = container["startupProbe"]
    assert probe["httpGet"]["path"] == "/health"
    assert probe["httpGet"]["port"] == 8080
    assert "tcpSocket" not in probe
    # The probe port has to match a declared container port or Cloud Run rejects it.
    assert container["ports"][0]["containerPort"] == 8080


def test_ingress_defaults_to_internal_and_is_overridable():
    """Default stays internal everywhere. The override exists so a dev environment can
    observe a real pod over HTTP; it widens WHERE a caller connects from, never WHO may
    invoke -- this backend never creates an allUsers binding."""
    assert (
        _backend().render_deploy_config(_spec())["metadata"]["annotations"][
            "run.googleapis.com/ingress"
        ]
        == "internal"
    )
    widened = GcpBackend(project="p", image="i", service_account="sa@p", ingress="all")
    cfg = widened.render_deploy_config(_spec())
    assert cfg["metadata"]["annotations"]["run.googleapis.com/ingress"] == "all"
    # The handle must report the ingress it actually deployed, not a hardcoded string.
    blob = str(cfg)
    assert "allUsers" not in blob and "allAuthenticatedUsers" not in blob


def test_no_signing_keys_are_mounted_by_default(monkeypatch):
    """Unset -> no mount at all, so behaviour is unchanged where it is not configured."""
    monkeypatch.delenv("HUSSH_POD_SIGNING_KEY_SECRET", raising=False)
    monkeypatch.delenv("HUSSH_POD_VAULT_KEY_SECRET", raising=False)
    env = _backend().render_deploy_config(_spec())["spec"]["template"]["spec"]["containers"][0][
        "env"
    ]
    names = {e["name"] for e in env}
    assert "APP_SIGNING_KEY" not in names
    assert "VAULT_DATA_KEY" not in names


def test_signing_key_is_mounted_by_reference_never_by_value(monkeypatch):
    """The pod cannot import without APP_SIGNING_KEY, so it must be able to get it --
    but only as a Secret Manager REFERENCE. Key material must never be rendered into
    the deploy artifact, which is readable by anyone who can read the service."""
    monkeypatch.setenv("HUSSH_POD_SIGNING_KEY_SECRET", "POD_DEV_SIGNING_KEY")
    cfg = _backend().render_deploy_config(_spec())
    env = {e["name"]: e for e in cfg["spec"]["template"]["spec"]["containers"][0]["env"]}

    entry = env["APP_SIGNING_KEY"]
    assert entry["valueFrom"]["secretKeyRef"]["name"] == "POD_DEV_SIGNING_KEY"
    # A literal value alongside valueFrom would be the material leaking in.
    assert "value" not in entry


def test_the_vault_key_is_never_mounted_even_when_configured(monkeypatch):
    """A pod performs no vault crypto -- every consumer of VAULT_DATA_KEY is hub-only
    -- and get_core_security_settings() permits its absence in pod mode. Mounting it
    anyway would hand each pod a key it never uses, which is one more secret whose
    only function is widening the blast radius of a pod compromise. The renderer must
    not emit it even when the legacy env var is still set."""
    monkeypatch.setenv("HUSSH_POD_SIGNING_KEY_SECRET", "POD_DEV_SIGNING_KEY")
    monkeypatch.setenv("HUSSH_POD_VAULT_KEY_SECRET", "POD_DEV_VAULT_KEY")
    cfg = _backend().render_deploy_config(_spec())
    names = {e["name"] for e in cfg["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert "VAULT_DATA_KEY" not in names


def test_pod_keys_are_never_the_hubs_keys(monkeypatch):
    """APP_SIGNING_KEY is the symmetric HMAC key behind consent tokens, fabric grants,
    receipts and the audit chain; VAULT_DATA_KEY decrypts holdings. With HMAC the
    ability to verify IS the ability to forge, so pointing a per-user pod at the hub's
    own secrets would make one compromised pod a universal forger for every user."""
    monkeypatch.setenv("HUSSH_POD_SIGNING_KEY_SECRET", "APP_SIGNING_KEY")
    cfg = _backend().render_deploy_config(_spec())
    env = {e["name"]: e for e in cfg["spec"]["template"]["spec"]["containers"][0]["env"]}
    referenced = env["APP_SIGNING_KEY"]["valueFrom"]["secretKeyRef"]["name"]
    # This test documents the danger rather than blocking the string: the guard that
    # matters is operational (a pod-scoped secret, readable only by the pod SA). If
    # this ever needs to be enforced in code, enforce it here.
    assert referenced == "APP_SIGNING_KEY", (
        "the backend does not filter the secret NAME -- whoever configures "
        "HUSSH_POD_SIGNING_KEY_SECRET must point it at a pod-scoped key, never the hub's"
    )


def test_logical_tier_has_no_confidential_annotation():
    cfg = _backend().render_deploy_config(_spec(tier=TIER_LOGICAL))
    ann = cfg["spec"]["template"]["metadata"]["annotations"]
    assert "run.googleapis.com/confidential" not in ann


def test_dedicated_tier_is_attested():
    cfg = _backend().render_deploy_config(_spec(tier=TIER_DEDICATED))
    ann = cfg["spec"]["template"]["metadata"]["annotations"]
    assert ann["run.googleapis.com/confidential"] == "true"


def _scale(cfg) -> tuple[str, str]:
    ann = cfg["spec"]["template"]["metadata"]["annotations"]
    return ann["autoscaling.knative.dev/minScale"], ann["autoscaling.knative.dev/maxScale"]


def test_default_min_instances_is_one_warm_floor(monkeypatch):
    # Real-time default: a warm floor of 1 so the agent endpoint has no cold start.
    monkeypatch.delenv("HUSSH_POD_MIN_INSTANCES", raising=False)
    monkeypatch.delenv("HUSSH_POD_MAX_INSTANCES", raising=False)
    min_s, _ = _scale(_backend().render_deploy_config(_spec()))
    assert min_s == "1"


def test_min_instances_configurable_via_param():
    # The mass tier can opt into scale-to-zero (min=0 + fast wake) to bound cost.
    cfg = GcpBackend(
        project="p", image="i:1", min_instances=0, max_instances=3
    ).render_deploy_config(_spec())
    assert _scale(cfg) == ("0", "3")


def test_min_instances_from_env(monkeypatch):
    monkeypatch.setenv("HUSSH_POD_MIN_INSTANCES", "2")
    monkeypatch.setenv("HUSSH_POD_MAX_INSTANCES", "5")
    assert _scale(GcpBackend(project="p", image="i:1").render_deploy_config(_spec())) == ("2", "5")


def test_max_is_clamped_up_to_min():
    # max must never be below min; a warm floor of 2 forces max>=2.
    cfg = GcpBackend(
        project="p", image="i:1", min_instances=2, max_instances=1
    ).render_deploy_config(_spec())
    assert _scale(cfg) == ("2", "2")


async def test_provision_plan_mode_returns_handle():
    handle = await _backend().provision(_spec())
    assert handle.backend == BACKEND_GCP
    assert handle.status == "planned"
    assert handle.external_agent_id.startswith("one-pod-")
    assert handle.a2a_route == f"{A2A_ADDRESS_BASE}/HA1ABC234DEF"
    assert handle.backend_metadata["project"] == "proj-x"
    assert handle.attestation_ref is None  # logical tier


async def test_provision_dedicated_sets_attestation_ref():
    handle = await _backend().provision(_spec(tier=TIER_DEDICATED))
    assert handle.attestation_ref == "pending-attestation"


async def test_plan_mode_deprovision_and_get_are_inert():
    b = _backend()
    assert await b.deprovision("one-pod-x") is None
    status = await b.get("one-pod-x")
    assert status.status == "planned" and status.healthy is True
    assert await b.health() is True


class _FakeRunClient:
    """In-memory stand-in for GcpRunClient so live-path tests make no GCP call."""

    def __init__(self, ready: bool = True):
        self.created: list = []
        self.deleted: list = []
        self._ready = ready

    def create_service(self, body):
        self.created.append(body)
        return {"metadata": body["metadata"]}

    def wait_ready(self, name, **kw):
        svc = {
            "status": {
                "url": "https://svc-abc.run.app",
                "conditions": [{"type": "Ready", "status": "True" if self._ready else "False"}],
            }
        }
        return self._ready, svc

    def get_service(self, name):
        return {"status": {"conditions": [{"type": "Ready", "status": "True"}]}}

    def delete_service(self, name):
        self.deleted.append(name)


def _live(client) -> GcpBackend:
    return GcpBackend(project="p", region="us-central1", image="img:1", live=True, client=client)


async def test_live_provision_creates_service_and_returns_live_handle():
    fake = _FakeRunClient(ready=True)
    handle = await _live(fake).provision(_spec())
    assert len(fake.created) == 1
    assert fake.created[0]["metadata"]["name"].startswith("one-pod-")
    assert handle.status == "live"
    assert handle.backend == BACKEND_GCP
    assert handle.backend_metadata["url"] == "https://svc-abc.run.app"
    assert handle.backend_metadata["ready"] is True


async def test_live_provision_not_ready_is_deploying():
    handle = await _live(_FakeRunClient(ready=False)).provision(_spec())
    assert handle.status == "deploying"
    assert handle.backend_metadata["ready"] is False


async def test_live_get_and_deprovision():
    fake = _FakeRunClient()
    b = _live(fake)
    status = await b.get("one-pod-x")
    assert status.healthy is True and status.status == "live"
    await b.deprovision("one-pod-x")
    assert fake.deleted == ["one-pod-x"]


def test_render_omits_empty_service_account():
    no_sa = GcpBackend(project="p", image="i", live=False).render_deploy_config(_spec())
    assert "serviceAccountName" not in no_sa["spec"]["template"]["spec"]
    with_sa = _backend().render_deploy_config(_spec())  # _backend sets a service account
    assert with_sa["spec"]["template"]["spec"]["serviceAccountName"] == "sa@proj-x.iam"
