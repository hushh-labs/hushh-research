"""A user-owned pod reaches Vertex in the USER's project, whatever the hub says.

Under `docs/reference/architecture/private-agent-north-star.md` the hussh Vertex
identity is confined to the simulation tier. Path A -- the person's own GCP project
with their own ADC -- must therefore never render hussh's model coordinates.

`UserGcpBackend` delegates rendering to `GcpBackend`, whose model project resolves as
``HUSSH_POD_VERTEX_PROJECT or self._project``. That precedence is backwards here: the
override is read from the HUB's environment, so setting it -- which is the entire
reason the variable exists -- would silently repoint every user-owned pod at hussh's
project.

No deploy file sets that variable today, so path A rendered correctly by the accident
of an unset override. These tests assert the boundary holds when it IS set, which is
the only condition under which the accident stops covering for it.
"""

from __future__ import annotations

from hushh_mcp.services.compute_backend import PodSpec
from hushh_mcp.services.user_gcp_backend import UserGcpBackend

_SPEC = PodSpec(
    hushh_id="HA1ABC234DEF",
    phone_e164_hash="h" * 64,
    pod_pubkey="p" * 43,
    region="us-central1",
)


def _model_env(cfg: dict) -> dict[str, str]:
    env = cfg["spec"]["template"]["spec"]["containers"][0]["env"]
    return {e["name"]: e["value"] for e in env if e["name"].startswith("GOOGLE_")}


def _backend() -> UserGcpBackend:
    return UserGcpBackend(
        user_project="the-persons-own-project",
        user_region="europe-west4",
        image="img:1",
    )


def test_the_hub_override_cannot_repoint_a_user_owned_pod(monkeypatch):
    """The failure this exists to stop: an operator configures the fleet's Vertex
    project and every BYOC pod quietly starts thinking on hussh's credential."""
    monkeypatch.setenv("HUSSH_POD_VERTEX_PROJECT", "hushh-pda-dev")
    monkeypatch.setenv("HUSSH_POD_VERTEX_LOCATION", "us-central1")

    env = _model_env(_backend().render_deploy_config(_SPEC))

    assert env["GOOGLE_CLOUD_PROJECT"] == "the-persons-own-project"
    assert env["GOOGLE_CLOUD_LOCATION"] == "europe-west4"


def test_the_boundary_holds_with_no_override_set(monkeypatch):
    """The condition that holds today. Asserted so a later refactor cannot lose it."""
    monkeypatch.delenv("HUSSH_POD_VERTEX_PROJECT", raising=False)
    monkeypatch.delenv("HUSSH_POD_VERTEX_LOCATION", raising=False)

    env = _model_env(_backend().render_deploy_config(_SPEC))

    assert env["GOOGLE_CLOUD_PROJECT"] == "the-persons-own-project"
    assert env["GOOGLE_CLOUD_LOCATION"] == "europe-west4"


def test_the_artifact_still_says_whose_pod_it_is(monkeypatch):
    """Pinning model access must not disturb the tenancy label the artifact carries."""
    monkeypatch.setenv("HUSSH_POD_VERTEX_PROJECT", "hushh-pda-dev")

    cfg = _backend().render_deploy_config(_SPEC)

    assert cfg["metadata"]["labels"]["hussh-tenancy"] == "user-owned"
