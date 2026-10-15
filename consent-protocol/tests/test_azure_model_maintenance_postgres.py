"""Real PostgreSQL admission/publication boundaries for Azure model maintenance."""

from __future__ import annotations

import copy
import hashlib
import json

import pytest

from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
from tests.pkm_conformance.postgres_harness import find_pg_bin
from tests.test_azure_model_maintenance import (
    repair as azure_model_repair,  # noqa: F401 -- canonical model fixture
)
from tests.test_pod_upgrade_lease_against_postgres import (  # noqa: F401 -- canonical PostgreSQL fixtures
    _USER,
    _row,
    engine,
    pg,
)
from tests.test_user_azure_backend import _hub_caller  # noqa: F401 -- canonical setup fixture
from tests.test_user_azure_backend import arm as azure_arm  # noqa: F401 -- canonical ARM fixture

pytestmark = pytest.mark.skipif(find_pg_bin() is None, reason="no PostgreSQL binaries on this host")


@pytest.mark.parametrize(
    "field", ["user_cloud_tenant_id", "user_cloud_subscription_id", "user_cloud_resource_group"]
)
async def test_azure_coordinate_changes_refuse_stale_claim_and_publication(pg, engine, field):  # noqa: F811 -- canonical fixtures
    from db.db_client import DatabaseClient

    _row(pg)
    repo = PersonalAgentRegistryRepo(client=DatabaseClient(engine=engine))
    observed = await repo.get(_USER)
    first = "11111111-1111-1111-1111-111111111111" if field.endswith("_id") else "first-group"
    second = "22222222-2222-2222-2222-222222222222" if field.endswith("_id") else "other-group"
    # A closed test-only field list; timestamps deliberately remain untouched.
    pg.execute(f"UPDATE personal_agent_registry SET {field}=%s WHERE user_id=%s", (first, _USER))
    assert (
        await repo.claim_image_upgrade(user_id=_USER, observed=observed, target_image="target")
        is None
    )
    observed = await repo.get(_USER)
    lease = await repo.claim_image_upgrade(user_id=_USER, observed=observed, target_image="target")
    assert lease
    pg.execute(f"UPDATE personal_agent_registry SET {field}=%s WHERE user_id=%s", (second, _USER))
    assert not await repo.record_image_upgrade(
        user_id=_USER,
        observed=observed,
        expected_lease=lease,
        previous_metadata={},
        backend_metadata={"image": "stale"},
    )
    assert (await repo.get(_USER))["backend_metadata"] == {"upgradeLease": lease}


async def _claim_model_repair(server, connection_engine, fixture_and_plan):
    from db.db_client import DatabaseClient
    from hushh_mcp.services.azure_model_enablement import owner_binding_digest

    _arm, fixture, plan = fixture_and_plan
    _row(server)
    source = fixture.row
    server.execute(
        """UPDATE personal_agent_registry SET hushh_id=%s, external_agent_id=%s,
        deployment_target='user_azure', model_credential_mode='byok_per_turn',
        user_cloud_tenant_id=%s, user_cloud_subscription_id=%s,
        user_cloud_resource_group=%s, user_cloud_region=%s,
        user_cloud_authorized_at=now(), backend_metadata=%s::jsonb WHERE user_id=%s""",
        (
            source["hushh_id"],
            source["external_agent_id"],
            source["user_cloud_tenant_id"],
            source["user_cloud_subscription_id"],
            source["user_cloud_resource_group"],
            source["user_cloud_region"],
            json.dumps(source["backend_metadata"]),
            _USER,
        ),
    )
    repo = PersonalAgentRegistryRepo(client=DatabaseClient(engine=connection_engine))
    row = await repo.get(_USER)
    plan = plan.model_copy(update={"owner_id": _USER, "owner_digest": owner_binding_digest(row)})
    lease = await repo.claim_image_upgrade(
        user_id=_USER,
        target_image=plan.image,
        observed=row,
        model_enablement_plan=plan.model_dump(),
    )
    assert lease
    row = await repo.get(_USER)
    record = row["backend_metadata"]["modelEnablement"]
    assert record["planDigest"] == plan.plan_digest and record["status"] == "pending"
    return repo, plan, lease, record


@pytest.mark.parametrize("variant", ["accepted", "forged_plan", "stale_mode", "stale_journal"])
async def test_model_mode_and_completion_share_one_bound_postgres_publication(
    pg,  # noqa: F811 -- canonical fixture
    engine,  # noqa: F811 -- canonical fixture
    azure_model_repair,  # noqa: F811 -- canonical shared fixture
    variant,
):
    repo, plan, lease, record = await _claim_model_repair(pg, engine, azure_model_repair)
    attempt = hashlib.sha256(lease.encode()).hexdigest()
    record.update(
        verified=["model", "role", "replacement"],
        intents=["model", "role", "replacement"],
        replacementDigest="a" * 64,
        drainReceipt={
            "operationId": "model_" + attempt,
            "incarnation": plan.revision,
            "activeWork": 0,
            "runtimeEpoch": "synthetic-epoch",
            "committedState": "b" * 64,
        },
        runtimeProof={
            "provider": "azure_openai",
            "model": "one-chat",
            "endpoint": plan.environment["AZURE_OPENAI_ENDPOINT"].split("/")[2],
            "revision": "ca-hussh-one-pod--u" + attempt[:12],
            "reachable": True,
        },
    )
    # Publish normalized provider observations as the maintenance owner would.
    previous = (await repo.get(_USER))["backend_metadata"]
    assert await repo.record_image_upgrade(
        user_id=_USER,
        expected_lease=lease,
        observed=await repo.get(_USER),
        previous_metadata=previous,
        backend_metadata={**previous, "modelEnablement": record},
        retain_lease=True,
        require_unchanged_metadata=True,
    )
    observed = await repo.get(_USER)
    desired = copy.deepcopy(observed["backend_metadata"])
    desired["modelEnablement"]["status"] = "verified"
    if variant == "forged_plan":
        desired["modelEnablement"]["plan"]["model_name"] = "other-model"
    elif variant == "stale_mode":
        pg.execute(
            "UPDATE personal_agent_registry SET model_credential_mode='user_adc' WHERE user_id=%s",
            (_USER,),
        )
    elif variant == "stale_journal":
        pg.execute(
            "UPDATE personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,'{modelEnablement,status}','\"changed\"') WHERE user_id=%s",
            (_USER,),
        )
    result = await repo.record_image_upgrade(
        user_id=_USER,
        expected_lease=lease,
        observed=observed,
        previous_metadata=observed["backend_metadata"],
        backend_metadata=desired,
        require_unchanged_metadata=True,
        model_credential_mode="user_azure_mi",
    )
    current = await repo.get(_USER)
    assert result is (variant == "accepted")
    assert (current["model_credential_mode"] == "user_azure_mi") is (variant == "accepted")
    assert ("upgradeLease" not in current["backend_metadata"]) is (variant == "accepted")
