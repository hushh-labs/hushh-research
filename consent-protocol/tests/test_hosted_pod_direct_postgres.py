"""Managed endpoint publication retains exact owner authority under PostgreSQL CAS."""

import asyncio
import json

import pytest
from sqlalchemy import text

from hushh_mcp.services.personal_agent_direct_admission import record_endpoint
from tests.test_pod_binding_transactions import db as db
from tests.test_pod_binding_transactions import pg as pg
from tests.test_pod_binding_transactions import pytestmark as pytestmark


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
