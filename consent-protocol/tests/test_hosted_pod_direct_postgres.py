"""Managed endpoint publication retains exact owner authority under PostgreSQL CAS."""

import asyncio
import json

import pytest
from sqlalchemy import text

from hushh_mcp.services.personal_agent_direct_admission import record_endpoint
from tests.test_pod_binding_transactions import db as db
from tests.test_pod_binding_transactions import pg as pg
from tests.test_pod_binding_transactions import pytestmark as pytestmark
from tests.test_pod_session_authority import hub_key as hub_key


@pytest.mark.parametrize("changed", [False, "replace", "append"])
def test_hosted_endpoint_promotion_binds_the_observed_owner_placement(db, changed):
    from copy import deepcopy

    from hushh_mcp.services.personal_agent_direct_admission import promote_external_ingress
    from tests.hosted_pod_support import hosted_registry_row

    row = hosted_registry_row(owner="u", hushh_id="ha1_test")
    metadata = row["backend_metadata"]
    metadata.update(ingress="external", url="https://pod.example")
    with db.engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE personal_agent_registry SET deployment_target='gcp',backend='gcp',"
                " user_cloud_project=NULL,backend_metadata=CAST(:metadata AS jsonb) WHERE user_id='u'"
            ),
            {"metadata": json.dumps(metadata)},
        )
        observed = dict(
            conn.execute(text("SELECT * FROM personal_agent_registry WHERE user_id='u'"))
            .mappings()
            .one()
        )
    if changed:
        altered = deepcopy(metadata)
        if changed == "replace":
            altered["provisionAttempt"]["hostedAdmission"]["assignment"]["project"] = (
                "foreign-project"
            )
        else:
            altered["provisionAttempt"]["hostedAdmission"]["assignment"]["extraAuthority"] = (
                "foreign"
            )
        with db.engine.begin() as conn:
            conn.execute(
                text(
                    "UPDATE personal_agent_registry SET backend_metadata=CAST(:metadata AS jsonb) WHERE user_id='u'"
                ),
                {"metadata": json.dumps(altered)},
            )
    promoted = asyncio.run(
        promote_external_ingress(
            db,
            user_id="u",
            hushh_id="ha1_test",
            service_uid=metadata["serviceUid"],
            pod_key_id="podk_test",
            url="https://pod.example",
            verified_at="2026-10-26T00:00:00Z",
            observed_row=observed,
        )
    )
    assert promoted is (not changed)
    if promoted:
        endpoint = asyncio.run(
            record_endpoint(
                db,
                user_id="u",
                hushh_id="ha1_test",
                pod_key_id="podk_test",
                pod_public_key="public",
                service_uid=metadata["serviceUid"],
                url="https://pod.example",
            )
        )
        assert endpoint["version"] == 1


@pytest.mark.parametrize(
    "case", ["valid", "missing", "unknown", "wrong_target", "wrong_environment", "byoc_runtime"]
)
async def test_managed_signed_session_requires_symmetric_hosting_authority(
    tmp_path, monkeypatch, hub_key, case
):
    from hushh_mcp.services.pod_session_authority import PodBindingV1, PodSessionRefused
    from tests.hosted_pod_support import install_hosted_runtime
    from tests.test_pod_session_authority import OWNER, Subject, World, _binding

    if case != "byoc_runtime":
        install_hosted_runtime(monkeypatch, owner=OWNER)
    world = World(tmp_path)
    await world.boot()
    subject = Subject("tdv_hosted", "web")
    binding = _binding(subject, deployment_target="gcp", hosting_mode="hussh_hosted")
    if case == "missing":
        binding.pop("hosting_mode")
    elif case == "unknown":
        binding["hosting_mode"] = "unknown"
    elif case == "wrong_target":
        binding["deployment_target"] = "user_gcp"
    elif case == "wrong_environment":
        binding["environment"] = "uat"
    before = await world.records()
    if case == "valid":
        token, claims = await world.admit(subject, binding)
        assert token.startswith("pst1.") and claims["role"] == "app"
    else:
        with pytest.raises(PodSessionRefused):
            await world.admit(subject, binding)
        assert await world.records() == before
    legacy = _binding(subject)
    assert PodBindingV1.from_mapping(legacy).to_dict() == legacy


@pytest.mark.parametrize("marker", [None, "hussh_hosted"])
@pytest.mark.parametrize("drift", [False, True])
def test_managed_binding_publication_rechecks_retained_placement(db, marker, drift):
    from hushh_mcp.services.personal_agent_direct_admission import record_binding
    from tests.hosted_pod_support import hosted_registry_row
    from tests.test_pod_binding_transactions import record

    row = hosted_registry_row(owner="u", hushh_id="ha1_test")
    metadata = row["backend_metadata"]
    metadata["url"] = "https://pod.example"
    if drift:
        metadata["provisionAttempt"]["hostedAdmission"]["assignment"]["project"] = "foreign-project"
    with db.engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE personal_agent_registry SET deployment_target='gcp',backend='gcp',"
                "user_cloud_project=NULL,backend_metadata=CAST(:metadata AS jsonb) WHERE user_id='u'"
            ),
            {"metadata": json.dumps(metadata)},
        )
    candidate = record()
    candidate["serviceUid"] = metadata["serviceUid"]
    candidate["envelope"]["binding"].update(deployment_target="gcp", environment="dev")
    if marker is not None:
        candidate["envelope"]["binding"]["hosting_mode"] = marker
    accepted = asyncio.run(record_binding(db, user_id="u", device_id="tdv_test", record=candidate))
    assert accepted is (marker == "hussh_hosted" and not drift)
    with db.engine.connect() as conn:
        stored = conn.execute(
            text("SELECT backend_metadata FROM personal_agent_registry WHERE user_id='u'")
        ).scalar_one()
    assert ("tdv_test" in stored.get("bindings", {})) is accepted
