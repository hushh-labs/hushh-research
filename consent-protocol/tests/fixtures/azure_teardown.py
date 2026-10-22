"""Bounded synthetic deleted-resource API bodies, with an excluded recovery handle."""

import json
import uuid

from hushh_mcp.services.azure_setup_plan import tags

CREATED = "2026-10-01T00:00:00Z"
DELETED = "2026-10-15T00:00:00Z"
PURGE = "2027-01-13T00:00:00Z"


def retention_body(inputs, path, deleted_path):
    return {
        "id": deleted_path,
        "location": inputs.location,
        "tags": tags(inputs),
        "properties": {
            "location": inputs.location,
            "vaultId": path,
            "tags": tags(inputs),
            "purgeProtectionEnabled": True,
            "deletionDate": DELETED,
            "scheduledPurgeDate": PURGE,
            "storageAccountResourceId": path,
            "creationTime": CREATED,
            "deletionTime": DELETED,
            "restoreReference": "synthetic-private-recovery-handle",
        },
    }


def partial_setup_state(server, mode, owner, hushh_id):
    """Seed a joined, failed setup without fabricating a running pod."""
    OWNER, HUSHH_ID = owner, hushh_id
    if mode in {
        "read_only",
        "read_only_existing",
        "predeployment",
    }:
        server.execute(
            "INSERT INTO pod_lifecycle_events(user_id,seq,hushh_id,event,stage,registry_status) VALUES (%s,1,%s,'stage','registry_row','pending')",
            (OWNER, HUSHH_ID),
        )
    if mode in {"read_only", "read_only_existing"}:
        server.execute("UPDATE byoc_setup_jobs SET status='failed' WHERE user_id=%s", (OWNER,))
        return server, OWNER, None, None
    if mode == "predeployment":
        server.execute("UPDATE byoc_setup_jobs SET status='failed' WHERE user_id=%s", (OWNER,))
        snapshot = server.execute(
            "SELECT to_jsonb(p) FROM personal_agent_registry p WHERE user_id=%s", (OWNER,)
        )[0][0]
        assert (
            server.execute(
                "SELECT azure_setup_never_deployed(%s,%s::jsonb)",
                (OWNER, json.dumps(snapshot)),
            )[0][0]
            is True
        )
        digest = server.execute(
            "SELECT azure_cleanup_candidate_digest(%s::jsonb)", (json.dumps(snapshot),)
        )[0][0]
        for invalid in (None, "0" * 64):
            assert (
                server.execute("SELECT reserve_azure_account_cleanup(%s,%s)", (OWNER, invalid))[0][
                    0
                ]
                is None
            )
        reservation = server.execute(
            "SELECT reserve_azure_account_cleanup(%s,%s)", (OWNER, digest)
        )[0][0]
        assert reservation and "agentCryptoErase" not in reservation
        context = server.execute("SELECT azure_erasure_context(%s)", (OWNER,))[0][0]
        assert context["neverDeployed"] is True
        return server, OWNER, reservation, context
    return None


def _seed_qualified_history(
    pg, owner, hushh_id, subscription, tenant, group, *, creates_group=True, initially_absent=True
):
    pg.execute(
        "INSERT INTO personal_agent_registry(user_id,hushh_id,status) VALUES (%s,%s,'unprovisioned')",
        (owner, hushh_id),
    )
    target = f"/subscriptions/{subscription}/resourceGroups/{group}"
    pg.execute(
        "INSERT INTO byoc_setup_jobs(user_id,job_id,project_id,status) VALUES (%s,'setup-1',%s,'running')",
        (owner, target),
    )
    intent = {
        "version": 1,
        "jobId": "setup-1",
        "hushhId": hushh_id,
        "tenantId": tenant,
        "subscriptionId": subscription,
        "resourceGroup": group,
        "location": "eastus2",
        "setupNonce": "0123456789abcdef",
        "groupInitiallyAbsent": initially_absent,
    }
    assert (
        pg.execute(
            "SELECT retain_byoc_azure_setup_intent(%s,'setup-1',%s::jsonb)",
            (owner, json.dumps(intent)),
        )[0][0]
        is True
    )
    execution, request_id = str(uuid.uuid4()), str(uuid.uuid4())
    assert (
        pg.execute("SELECT begin_byoc_azure_worker(%s,'setup-1',%s)", (owner, execution))[0][0]
        is True
    )
    events = [
        {
            "stage": "azure_provider_request",
            "requestId": request_id,
            "method": "PUT",
            "path": target,
            "apiVersion": "2021-04-01",
            "purpose": "creating_resource_group",
        },
        {
            "stage": "azure_provider_ack",
            "requestId": request_id,
            "status": 201,
            "operationUrl": None,
            "operationUrlSha256": None,
        },
        {"stage": "azure_provider_terminal", "requestId": request_id, "outcome": "succeeded"},
        {"stage": "azure_worker_exited"},
    ]
    if not creates_group:
        events = [events[-1]]
    for event in events:
        value = {"jobId": "setup-1", "executionId": execution, **event}
        assert (
            pg.execute(
                "SELECT retain_byoc_azure_worker_event(%s,'setup-1',%s::jsonb)",
                (owner, json.dumps(value)),
            )[0][0]
            is True
        )
    pg.execute("SELECT pg_advisory_unlock(hashtextextended(%s,206))", (owner,))
    pg.execute("UPDATE byoc_setup_jobs SET status='recorded' WHERE user_id=%s", (owner,))


def seed_qualified_history(pg, owner, hushh_id, subscription, tenant, group, mode):
    """Compose recorded setup effects for the requested cleanup boundary."""
    _seed_qualified_history(
        pg,
        owner,
        hushh_id,
        subscription,
        tenant,
        group,
        creates_group=mode not in {"read_only", "read_only_existing"},
        initially_absent=mode != "read_only_existing",
    )


def retain_provider_checkpoint(server, reservation, mode):
    """Retain the selected provider-revocation boundary in the existing checkpoint."""
    from tests.test_owner_access_erasure_migration import _checkpoint, _retain_checkpoint

    checkpoint = _checkpoint()
    provider_case = mode
    if provider_case == "provider_legacy":
        checkpoint["agentErased"].pop("providerCoverage")
    elif provider_case == "provider_pending":
        checkpoint["agentErased"]["providerUnconfirmed"] = 1
    elif provider_case == "provider_unavailable":
        checkpoint["agentErased"].update(providerRevoked=0, providerUnavailable=1)
    assert _retain_checkpoint(server, reservation, checkpoint) is True
