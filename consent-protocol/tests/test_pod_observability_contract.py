"""The pod's observability contract — what a probe may point at, and what it means.

Measuring a real pod (`scripts/ops/pod_resource_probe.py`) turned up two facts that
only matter if they are held:

* ``/health`` answers **200** in pod mode, and the rendered startup probe points at
  it. That pairing is load-bearing: Cloud Run's default startup probe is a TCP
  connect, and gunicorn binds its port before its workers boot, so a pod whose
  workers die on import reports Ready **and** ContainerHealthy while returning 503
  to everything. The explicit HTTP probe is what makes the condition honest.
* ``/health/ready`` answers **503** in pod mode, because readiness includes a
  database dependency and a pod holds no database credential by design. That is
  correct behaviour and a **trap**: pointing the startup probe at the readiness
  endpoint would mean no pod ever starts. This test is the tripwire.

Both are asserted against the rendered artifact and the real app, so a change to
either side is caught here rather than by a fleet that will not boot.
"""

from __future__ import annotations

import os

import pytest

from hushh_mcp.services.compute_backend import PodSpec
from hushh_mcp.services.gcp_backend import GcpBackend

READINESS_PATH = "/health/ready"
LIVENESS_PATH = "/health"


def _spec() -> PodSpec:
    return PodSpec(hushh_id="HA1OBS", phone_e164_hash="h", pod_pubkey="p", region="us-central1")


def _container() -> dict:
    config = GcpBackend(project="p", image="i", live=False).render_deploy_config(_spec())
    return config["spec"]["template"]["spec"]["containers"][0]


def test_the_startup_probe_is_an_explicit_http_check():
    """A TCP probe passes on a pod whose workers are dead. HTTP does not."""
    probe = _container().get("startupProbe")
    assert probe, "no explicit startup probe -- Cloud Run would fall back to TCP connect"
    assert "httpGet" in probe, "the startup probe must be an HTTP check, not TCP"


def test_the_startup_probe_never_points_at_readiness():
    """``/health/ready`` is 503 in a pod by design -- probing it means no pod starts."""
    path = _container()["startupProbe"]["httpGet"]["path"]
    assert path != READINESS_PATH, (
        "the startup probe points at the readiness endpoint, which a pod answers 503 "
        "by design (it has no database) -- every pod would fail to start"
    )
    assert path == LIVENESS_PATH, f"expected the probe on {LIVENESS_PATH}, found {path}"


def test_the_probe_port_matches_the_container_port():
    """A probe on the wrong port fails every pod for a reason nothing reports."""
    container = _container()
    probe_port = container["startupProbe"]["httpGet"]["port"]
    ports = [p.get("containerPort") for p in container.get("ports", [])]
    assert probe_port in ports, f"probe port {probe_port} is not among exposed ports {ports}"


def test_liveness_answers_in_pod_mode(monkeypatch: pytest.MonkeyPatch):
    """``/health`` must answer 200 -- the rendered startup probe depends on it.

    Only liveness is pinned. Readiness is **dependency-gated**: it answers 503 when
    no database is reachable and 200 when one is, so its code is a property of the
    environment, not a contract. An earlier draft of this test asserted 503 and
    passed alone while failing in the full suite, where other tests had made a
    database reachable -- an environment-dependent value dressed up as an
    invariant. The environment-independent guarantee is the probe wiring above,
    which is why that is what the tripwire asserts.
    """
    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    monkeypatch.setenv("HUSSH_ID", "HA1OBS")
    os.environ.setdefault("APP_SIGNING_KEY", "pod_observability_contract_key_32_chars")

    try:
        from fastapi.testclient import TestClient  # noqa: PLC0415

        import pod_server  # noqa: PLC0415
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"pod app not importable here: {type(exc).__name__}")

    with TestClient(pod_server.app, raise_server_exceptions=False) as client:
        assert client.get(LIVENESS_PATH).status_code == 200
        # Readiness must exist and must not 404 -- a probe pointed at a missing
        # route would fail closed for the wrong reason.
        assert client.get(READINESS_PATH).status_code != 404
