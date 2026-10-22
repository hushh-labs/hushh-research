"""Two people must not resolve to one project. This is the admission gate.

Before these paths read the spec, `deployment_target` was per-person while the
DESTINATION stayed `os.getenv("HUSSH_USER_GCP_PROJECT")` -- one value for the whole
deployment. Admitting a second BYOC person would have created their pod, their CMEK
bucket, their KMS key and their pod service account inside the FIRST person's project,
which their own `run.invoker` grant then makes reachable.

That is a data-isolation failure, not a configuration bug, and it is why nothing may
admit a second BYOC user until these tests pass.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.byoc_substrate import HushhFederatedSubstrate, resolve_substrate_ensurer
from hushh_mcp.services.compute_backend import PodSpec, resolve_compute_backend_for_spec


def _spec(**overrides) -> PodSpec:
    base = dict(
        hushh_id="ha1_abc",
        phone_e164_hash="deadbeef",
        pod_pubkey="",
        deployment_target="user_gcp",
        user_cloud_project="alice-project",
        user_cloud_region="us-central1",
        user_cloud_bootstrap_sa="one-bootstrap@alice-project.iam.gserviceaccount.com",
    )
    base.update(overrides)
    return PodSpec(**base)


def test_two_people_resolve_to_two_projects(monkeypatch):
    """The whole point. Broken by restoring the no-argument UserGcpBackend()."""
    monkeypatch.setenv("HUSSH_USER_GCP_PROJECT", "somebody-elses-project")

    alice = resolve_compute_backend_for_spec(_spec(user_cloud_project="alice-project"))
    bob = resolve_compute_backend_for_spec(_spec(user_cloud_project="bob-project"))

    assert alice._user_project == "alice-project"
    assert bob._user_project == "bob-project"
    # And neither inherited the deployment-wide value that used to decide for both.
    assert "somebody-elses-project" not in {alice._user_project, bob._user_project}


def test_the_bootstrap_account_is_carried_per_person(monkeypatch):
    """One person's bootstrap account is not another's.

    `one-bootstrap@alice-project` and `one-bootstrap@bob-project` are different
    principals, so this stopped being one environment variable the moment there were
    two people.
    """
    monkeypatch.setenv(
        "HUSSH_USER_GCP_BOOTSTRAP_SA", "one-bootstrap@somebody-else.iam.gserviceaccount.com"
    )

    backend = resolve_compute_backend_for_spec(_spec())

    assert backend._bootstrap_sa == "one-bootstrap@alice-project.iam.gserviceaccount.com"


def test_a_user_gcp_spec_with_no_project_is_refused_not_defaulted(monkeypatch):
    """The silent fallback is the bug. Refusing is the fix.

    With a fallback, this spec would build the person's pod inside whichever project
    the environment happens to name -- and the row would truthfully record a different
    one, which is worse than today because the record would then look right.
    """
    monkeypatch.setenv("HUSSH_USER_GCP_PROJECT", "somebody-elses-project")

    with pytest.raises(ValueError, match="never inferred"):
        resolve_compute_backend_for_spec(_spec(user_cloud_project=None))


def test_the_substrate_ensurer_is_also_per_person(monkeypatch):
    """The other half of the lifecycle had the identical defect.

    A per-person backend with a deployment-wide substrate would still apply one
    person's bucket, KMS key and signing secret inside another person's project.
    """
    monkeypatch.setenv("HUSSH_USER_GCP_PROJECT", "somebody-elses-project")
    monkeypatch.setenv(
        "HUSSH_USER_GCP_BOOTSTRAP_SA", "one-bootstrap@somebody-else.iam.gserviceaccount.com"
    )

    ensurer = resolve_substrate_ensurer(
        _spec(
            user_cloud_project="bob-project",
            user_cloud_bootstrap_sa="one-bootstrap@bob-project.iam.gserviceaccount.com",
        )
    )

    assert isinstance(ensurer, HushhFederatedSubstrate)
    assert ensurer._project == "bob-project"
    assert ensurer._bootstrap_sa == "one-bootstrap@bob-project.iam.gserviceaccount.com"


def test_the_substrate_refuses_a_tenant_with_no_project(monkeypatch):
    monkeypatch.delenv("HUSSH_USER_GCP_PROJECT", raising=False)

    with pytest.raises(ValueError, match="never inferred"):
        resolve_substrate_ensurer(_spec(user_cloud_project=None))


def test_non_tenant_targets_are_untouched():
    """Every other target's destination IS a property of the deployment.

    Routing them through the tenant branch would be the mirror-image mistake.
    """
    from hushh_mcp.services.byoc_substrate import NoSubstrateRequired

    for target in (None, "null", "gcp"):
        spec = _spec(deployment_target=target, user_cloud_project=None)
        resolve_compute_backend_for_spec(spec)  # must not raise
        assert isinstance(resolve_substrate_ensurer(spec), NoSubstrateRequired)
