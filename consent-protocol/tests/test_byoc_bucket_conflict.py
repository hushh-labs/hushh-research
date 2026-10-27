"""Bucket-conflict custody and managed ownership regressions."""

from copy import deepcopy

import pytest

from hushh_mcp.services.user_gcp_backend import UserGcpBackend
from hushh_mcp.services.user_gcp_bootstrap import UserGcpBootstrap
from tests.test_byoc_bootstrap_and_custody import (
    BORROWED,
    USER_PROJECT,
    _Response,
    _Session,
    _spec,
)


@pytest.mark.parametrize(
    "drift", ["key", "public_access", "uniform_access", "malformed_uniform", "malformed"]
)
def test_existing_project_bucket_requires_the_approved_custody_settings(drift) -> None:
    """A same-project 409 cannot adopt storage with different custody settings."""
    plan = UserGcpBackend(user_project=USER_PROJECT, live=False).render_bootstrap_plan(_spec())
    boot = UserGcpBootstrap(project=USER_PROJECT, token=BORROWED, session=_Session())
    call = next(item for item in boot.plan_calls(plan) if item["step"] == "cmek_bucket")
    observed = deepcopy(call["body"])
    if drift == "key":
        observed["encryption"]["defaultKmsKeyName"] = (
            "projects/other/locations/us/keyRings/r/cryptoKeys/k"
        )
    elif drift == "public_access":
        observed["iamConfiguration"]["publicAccessPrevention"] = "inherited"
    elif drift == "uniform_access":
        observed["iamConfiguration"]["uniformBucketLevelAccess"]["enabled"] = False
    elif drift == "malformed_uniform":
        observed["iamConfiguration"]["uniformBucketLevelAccess"]["enabled"] = "false"
    else:
        observed["encryption"] = "malformed"
    boot._session = _Session(
        routes={"storage/v1/b": [_Response(409), _Response(200, {"items": [observed]})]}
    )
    result = boot.apply(plan, dry_run=False)
    bucket = next(step for step in result["steps"] if step["step"] == "cmek_bucket")
    assert bucket["ok"] is False


def test_hosted_bucket_conflict_requires_creation_evidence() -> None:
    plan = UserGcpBackend(user_project=USER_PROJECT, live=False).render_bootstrap_plan(_spec())
    plan["tenancy"] = "hussh-hosted"
    boot = UserGcpBootstrap(project=USER_PROJECT, token=BORROWED, session=_Session())
    call = next(item for item in boot.plan_calls(plan) if item["step"] == "cmek_bucket")
    boot._session = _Session(
        routes={"storage/v1/b": [_Response(409), _Response(200, {"items": [call["body"]]})]}
    )
    result = boot.apply(plan, dry_run=False)
    bucket = next(step for step in result["steps"] if step["step"] == "cmek_bucket")
    assert bucket["ok"] is False
