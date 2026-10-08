"""Where do pods get created, and how is that decided?

This was one line -- ``_env("GOOGLE_CLOUD_PROJECT")`` -- and that line is why the
dev pod fleet was empty for the entire time the pod journey was being built and
deployed.

The dev lane deliberately sets ``GOOGLE_CLOUD_PROJECT`` to UAT's *Vertex* project
so dev can borrow it for model access (``backend-deploy.sh`` line 176,
``genai_project_id``). So one variable was answering two unrelated questions:
"where do I call Gemini" and "where do I create billable Cloud Run services". The
hub aimed every provision at ``hushh-pda-uat``, where its runtime identity holds
no ``run.admin``, and every create 403'd at the caller before the pod service
account was ever considered.

Nothing surfaced it. A flag audit reported the pod journey healthy because all
seven personal-agent flags were present on the serving revision -- and a
misrouted project is not a flag. These tests exist so the resolution order is a
pinned contract rather than a line someone can quietly simplify back.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services import gcp_backend


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    for name in ("HUSSH_POD_PROJECT", "GOOGLE_CLOUD_PROJECT", "GCP_DEPLOY_SA_KEY_B64"):
        monkeypatch.delenv(name, raising=False)
    # Credentials resolution reaches the network/metadata server; neutralise it by
    # default so each test states its own answer.
    monkeypatch.setattr(gcp_backend, "_resolve_pod_project", gcp_backend._resolve_pod_project)
    monkeypatch.setattr(
        "hushh_mcp.services.gcp_run_client.resolve_admin_project", lambda *a, **k: None
    )


def test_explicit_setting_wins(monkeypatch):
    monkeypatch.setenv("HUSSH_POD_PROJECT", "hushh-pda-dev")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda-uat")
    project, source = gcp_backend._resolve_pod_project()
    assert project == "hushh-pda-dev"
    assert source == "HUSSH_POD_PROJECT"


def test_credentials_project_beats_google_cloud_project(monkeypatch):
    """The credentials know which project this caller can actually act in.

    For an attached identity that is the project the hub RUNS in, which is by
    definition where it holds run.admin. That is the question being asked, and it
    is a better answer than any environment variable.
    """
    monkeypatch.setattr(
        "hushh_mcp.services.gcp_run_client.resolve_admin_project", lambda *a, **k: "hushh-pda-dev"
    )
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda-uat")
    project, source = gcp_backend._resolve_pod_project()
    assert project == "hushh-pda-dev"
    assert source == "credentials"


def test_the_exact_dev_lane_bug(monkeypatch):
    """The regression, stated as the live configuration that caused it.

    Serving revision consent-protocol-00018-xs2, read 2026-08-06:
    GOOGLE_CLOUD_PROJECT=hushh-pda-uat, HUSSH_POD_PROJECT unset. With credentials
    resolving to the dev project, pods must land in dev -- NOT in the Vertex
    project the old single-line resolution would have chosen.
    """
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda-uat")
    monkeypatch.setattr(
        "hushh_mcp.services.gcp_run_client.resolve_admin_project", lambda *a, **k: "hushh-pda-dev"
    )
    backend = gcp_backend.GcpBackend()
    assert backend._project == "hushh-pda-dev"
    assert backend._project_source == "credentials"


def test_falls_back_to_google_cloud_project_last(monkeypatch):
    """Last, not never.

    Outside dev the deploy script forces genai_project_id == PROJECT_ID, so this
    variable IS correct in uat and production. Removing the fallback entirely
    would break those lanes to fix one.
    """
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda")
    project, source = gcp_backend._resolve_pod_project()
    assert project == "hushh-pda"
    assert source == "GOOGLE_CLOUD_PROJECT"


def test_unresolved_is_reported_as_unresolved(monkeypatch):
    project, source = gcp_backend._resolve_pod_project()
    assert project is None
    assert source == "unresolved"


def test_live_mode_refuses_without_a_project_and_says_which_variable(monkeypatch):
    """The failure has to name the right variable.

    The old message said GOOGLE_CLOUD_PROJECT, which would send whoever hit it
    straight back into the bug.
    """
    backend = gcp_backend.GcpBackend()
    with pytest.raises(RuntimeError) as excinfo:
        backend._build_client()
    message = str(excinfo.value)
    assert "HUSSH_POD_PROJECT" in message
    assert "Vertex" in message


def test_explicit_constructor_argument_is_labelled_explicit():
    backend = gcp_backend.GcpBackend(project="some-project")
    assert backend._project == "some-project"
    assert backend._project_source == "explicit"


def test_describe_surfaces_the_source(monkeypatch):
    """An ops surface must be able to show WHICH rule won.

    A resolution that cannot explain itself is how the original bug hid for the
    entire life of the feature.
    """
    monkeypatch.setenv("HUSSH_POD_PROJECT", "hushh-pda-dev")
    backend = gcp_backend.GcpBackend()
    rendered = backend.render_deploy_config(
        gcp_backend.PodSpec(hushh_id="ABC123", phone_e164_hash="h", pod_pubkey="k")
    )
    assert isinstance(rendered, dict)
    # The describe payloads carry it; the rendered service body must not, because
    # the project belongs in the API path, not in a user-visible artifact.
    assert "projectSource" not in str(rendered.get("metadata", {}))
