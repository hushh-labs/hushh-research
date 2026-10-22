"""Failed Azure setup erasure requires exact absence and joined worker evidence."""

import json
import uuid

import pytest

from tests.test_azure_resource_teardown_postgres import (
    cleanup_connection as cleanup_connection,
)
from tests.test_azure_resource_teardown_postgres import (
    cleanup_pg as cleanup_pg,
)
from tests.test_azure_resource_teardown_postgres import (
    cleanup_state as cleanup_state,
)
from tests.test_azure_resource_teardown_postgres import (
    settled_cleanup as settled_cleanup,
)
from tests.test_owner_access_erasure import _hub_caller as _hub_caller
from tests.test_owner_access_erasure import arm as arm


@pytest.mark.parametrize("cleanup_pg", ["predeployment"], indirect=True)
async def test_failed_setup_cleans_exact_resources_without_fabricating_pod_erasure(settled_cleanup):
    pg, owner, current, _connection = settled_cleanup
    assert "agentCryptoErase" not in current
    assert "ownerAccessErasure" not in current
    assert current["azureTeardown"]["plan"]["context"]["neverDeployed"] is True
    assert pg.execute("SELECT personal_agent_erasure_complete(%s)", (owner,))[0][0] is True
    snapshot = current["registrySnapshot"]
    for changed in (
        {**snapshot, "user_id": "other-owner"},
        {**snapshot, "backend_metadata": {"serviceUid": "unrecorded-pod"}},
        {**snapshot, "external_agent_id": "/unrecorded-pod"},
    ):
        assert (
            pg.execute(
                "SELECT azure_setup_never_deployed(%s,%s::jsonb)", (owner, json.dumps(changed))
            )[0][0]
            is False
        )


@pytest.mark.parametrize("cleanup_pg", ["read_only"], indirect=True)
def test_early_model_refusal_with_zero_requests_can_delete_account_state(cleanup_pg):
    from hushh_mcp.services.account_service import AccountService
    from tests.standby_postgres_support import Db

    pg, owner, _reservation, _context = cleanup_pg
    assert pg.execute("SELECT azure_setup_no_effects(%s)", (owner,))[0][0] is True
    snapshot = pg.execute(
        "SELECT to_jsonb(p) FROM personal_agent_registry p WHERE user_id=%s", (owner,)
    )[0][0]
    assert (
        pg.execute(
            "SELECT azure_setup_never_deployed(%s,%s::jsonb)", (owner, json.dumps(snapshot))
        )[0][0]
        is False
    )
    from hushh_mcp.services.account_service import PersonalAgentDeprovisioningRequiredError

    pg.execute(
        "UPDATE personal_agent_registry SET space_id='unresolved-old-custody' WHERE user_id=%s",
        (owner,),
    )
    assert pg.execute("SELECT azure_setup_no_effects(%s)", (owner,))[0][0] is False
    pg.execute("UPDATE personal_agent_registry SET space_id=NULL WHERE user_id=%s", (owner,))
    # A second genuine read-only retry has a fresh nonce but no old cloud group.
    original = pg.execute("SELECT stages FROM byoc_setup_jobs WHERE user_id=%s", (owner,))[0][0]
    intent = next(x["intent"] for x in original if x["stage"] == "azure_setup_intent")
    pg.execute(
        "UPDATE byoc_setup_jobs SET job_id='setup-2',status='running',stages='[]'::jsonb WHERE user_id=%s",
        (owner,),
    )
    intent = {**intent, "jobId": "setup-2", "setupNonce": "fedcba9876543210"}
    assert (
        pg.execute(
            "SELECT retain_byoc_azure_setup_intent(%s,'setup-2',%s::jsonb)",
            (owner, json.dumps(intent)),
        )[0][0]
        is True
    )
    execution = str(uuid.uuid4())
    assert (
        pg.execute("SELECT begin_byoc_azure_worker(%s,'setup-2',%s)", (owner, execution))[0][0]
        is True
    )
    event = {"stage": "azure_worker_exited", "jobId": "setup-2", "executionId": execution}
    assert (
        pg.execute(
            "SELECT retain_byoc_azure_worker_event(%s,'setup-2',%s::jsonb)",
            (owner, json.dumps(event)),
        )[0][0]
        is True
    )
    pg.execute("SELECT pg_advisory_unlock(hashtextextended(%s,206))", (owner,))
    pg.execute("UPDATE byoc_setup_jobs SET status='failed' WHERE user_id=%s", (owner,))
    assert pg.execute("SELECT azure_setup_no_effects(%s)", (owner,))[0][0] is True

    pg.execute("SELECT pg_advisory_lock(hashtextextended(%s,206))", (owner,))
    try:
        with pytest.raises(PersonalAgentDeprovisioningRequiredError), Db(pg).engine.begin() as conn:
            AccountService()._delete_personal_agent_state(
                conn, params={"user_id": owner}, results={}
            )
    finally:
        pg.execute("SELECT pg_advisory_unlock(hashtextextended(%s,206))", (owner,))
    results = {}
    with Db(pg).engine.begin() as conn:
        AccountService()._delete_personal_agent_state(
            conn, params={"user_id": owner}, results=results
        )
    assert results["personal_agent_external_resources_absent"] is True
    assert pg.execute("SELECT count(*) FROM byoc_setup_jobs WHERE user_id=%s", (owner,))[0][0] == 0


@pytest.mark.parametrize("cleanup_pg", ["read_only_existing"], indirect=True)
def test_zero_new_requests_cannot_discard_a_preexisting_cloud_group(cleanup_pg):
    from hushh_mcp.services.account_service import (
        AccountService,
        PersonalAgentDeprovisioningRequiredError,
    )
    from tests.standby_postgres_support import Db

    pg, owner, _reservation, _context = cleanup_pg
    assert pg.execute("SELECT azure_setup_no_effects(%s)", (owner,))[0][0] is False
    with pytest.raises(PersonalAgentDeprovisioningRequiredError), Db(pg).engine.begin() as conn:
        AccountService()._delete_personal_agent_state(conn, params={"user_id": owner}, results={})
    assert pg.execute("SELECT count(*) FROM byoc_setup_jobs WHERE user_id=%s", (owner,))[0][0] == 1


def test_never_deployed_claim_refuses_an_actual_hosted_agent(arm):
    from hushh_mcp.services.azure_teardown_inventory import AzureTeardownRefused
    from hushh_mcp.services.azure_teardown_observation import inspect_plan
    from tests.test_azure_resource_teardown import _prepared
    from tests.test_owner_access_erasure import OWNER, _snapshot

    client, inputs, _resources, _journal = _prepared(arm)
    context = {
        "ownerId": OWNER,
        "attemptId": "attempt-preview",
        "hushhId": inputs.hushh_id,
        "tenantId": inputs.tenant_id,
        "subscriptionId": inputs.subscription_id,
        "resourceGroup": inputs.resource_group,
        "location": inputs.location,
        "setupNonce": inputs.nonce,
        "neverDeployed": True,
    }
    with pytest.raises(AzureTeardownRefused, match="AZURE_CLEANUP_UNRECORDED_AGENT"):
        inspect_plan(
            client,
            context=context,
            reservation={
                "ownerId": OWNER,
                "attemptId": "attempt-preview",
                "registrySnapshot": _snapshot(client),
            },
            hub_principal="88888888-8888-8888-8888-888888888888",
        )
