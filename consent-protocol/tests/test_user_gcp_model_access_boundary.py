"""A user-owned pod resolves Vertex against the USER's project. Always.

This test existed once and is gone from the tree -- only
``tests/__pycache__/test_user_gcp_model_access_boundary.cpython-313-pytest-9.0.3.pyc``
survives, and nothing present enforced the boundary it asserted. It is restored here
because the boundary is the whole point of the BYO GCP tier, and because the defect it
guards is live in the renderer right now.

The managed renderer resolves the Vertex address as
``_env("HUSSH_POD_VERTEX_PROJECT") or self._project`` (gcp_backend.py:372) -- the HUB's
environment wins. ``UserGcpBackend`` inherits the managed config and filters it, so
before this change a user-owned pod could be rendered running as the USER's service
account while ``GOOGLE_CLOUD_PROJECT`` pointed at HUSHH's project. That is a
cross-tenant address, and it is backwards for the one tier whose entire claim is that
the compute and the model access belong to the person.

It was latent rather than exploited only because ``HUSSH_POD_VERTEX_PROJECT`` happens
to be unset on the dev hub (verified against the serving revision, 2026-08-12), so the
fallback landed on the right project by luck. The day the managed tier sets it -- which
is exactly what it is for -- every BYOC pod silently re-points. A boundary that holds
only while an unrelated variable stays unset is not a boundary.

This also underwrites the product rule that a BYO GCP person needs no separate AI
connection: their pod's native ADC is theirs precisely because these two variables name
their project.
"""

from __future__ import annotations

import base64

from hushh_mcp.services.compute_backend import PodSpec
from hushh_mcp.services.user_gcp_backend import UserGcpBackend

USER_PROJECT = "a-real-persons-project"
HUSHH_PROJECT = "hushh-pda-dev"


def _spec() -> PodSpec:
    return PodSpec(
        hushh_id="boundaryuser",
        phone_e164_hash="0" * 64,
        pod_pubkey=base64.b64encode(b"\x00" * 32).decode(),
        region="us-central1",
    )


def _env_entries(cfg: dict, name: str) -> list[str]:
    """Every entry for a name, not a dict.

    Building a dict here is how the first version of this test passed while the code
    was broken: the renderer APPENDED the user's project without removing the hub's, so
    the body carried two GOOGLE_CLOUD_PROJECT entries and last-write-wins in Python
    hid it. A Knative env list with duplicate names is undefined -- the platform is
    free to take either -- so the count is part of the assertion, not a detail.
    """
    container = cfg["spec"]["template"]["spec"]["containers"][0]
    return [e.get("value", "") for e in container.get("env", []) if e["name"] == name]


def _env_of(cfg: dict) -> dict[str, str]:
    container = cfg["spec"]["template"]["spec"]["containers"][0]
    return {e["name"]: e.get("value", "") for e in container.get("env", []) if "value" in e}


def test_vertex_project_is_the_users_even_when_the_hub_names_its_own(monkeypatch) -> None:
    """The regression. Set the hub's Vertex project and it must not reach the pod."""
    monkeypatch.setenv("HUSSH_POD_VERTEX_PROJECT", HUSHH_PROJECT)
    monkeypatch.setenv("HUSSH_POD_VERTEX_LOCATION", "europe-west4")

    cfg = UserGcpBackend(user_project=USER_PROJECT, live=False).render_deploy_config(_spec())
    entries = _env_entries(cfg, "GOOGLE_CLOUD_PROJECT")

    assert entries == [USER_PROJECT], (
        "a user-owned pod must carry exactly one Vertex project and it must be the "
        f"user's. Got {entries!r}. Two entries means the hub's value was appended to "
        "rather than replaced, and which one Cloud Run honours is undefined -- the pod "
        "runs as the user's service account, so the hub's project is cross-tenant."
    )
    assert HUSHH_PROJECT not in entries


def test_vertex_project_is_the_users_when_the_hub_names_nothing(monkeypatch) -> None:
    """The state dev is actually in. Correct here by fallback; must be correct by rule."""
    monkeypatch.delenv("HUSSH_POD_VERTEX_PROJECT", raising=False)
    monkeypatch.delenv("HUSSH_POD_VERTEX_LOCATION", raising=False)

    env = _env_of(
        UserGcpBackend(user_project=USER_PROJECT, live=False).render_deploy_config(_spec())
    )

    assert env.get("GOOGLE_CLOUD_PROJECT") == USER_PROJECT


def test_vertex_location_follows_the_users_region(monkeypatch) -> None:
    """The location is half the address; a right project in a wrong region still fails."""
    monkeypatch.setenv("HUSSH_POD_VERTEX_LOCATION", "europe-west4")

    env = _env_of(
        UserGcpBackend(user_project=USER_PROJECT, live=False).render_deploy_config(_spec())
    )

    assert env.get("GOOGLE_CLOUD_LOCATION") == "us-central1"


def test_vertex_is_still_addressed_at_all(monkeypatch) -> None:
    """Stripping the hub's value must not leave the pod with no Vertex address.

    Deleting the variables would also pass the assertions above by making them vacuous,
    which is the failure mode this test exists to rule out: the pod needs a real
    address, it just needs the person's own.
    """
    monkeypatch.setenv("HUSSH_POD_VERTEX_PROJECT", HUSHH_PROJECT)

    env = _env_of(
        UserGcpBackend(user_project=USER_PROJECT, live=False).render_deploy_config(_spec())
    )

    assert env.get("GOOGLE_CLOUD_PROJECT"), "the pod has no Vertex project at all"
    assert env.get("GOOGLE_CLOUD_LOCATION"), "the pod has no Vertex location at all"
    assert env.get("GOOGLE_GENAI_USE_VERTEXAI") == "true"
