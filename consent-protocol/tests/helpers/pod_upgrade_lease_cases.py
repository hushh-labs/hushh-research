"""Pod upgrade lease claim and publication cases for the PostgreSQL doorway."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo


def provider_image_ack(spec, digest, *, versioned=True):
    deployed = f"reg/copy@{digest}"
    receipt = {
        "attemptId": spec.upgrade_attempt_id,
        "image": deployed,
        "deployedImage": deployed,
    }
    if versioned:
        receipt.update(version=1, generation=4)
    return receipt


def assert_upgrade_ack(receipt_or_metadata, expected, *, exact=False):
    receipt = receipt_or_metadata.get("upgradeAcknowledgement", receipt_or_metadata)
    if exact:
        assert receipt == expected
    else:
        assert all(receipt.get(key) == value for key, value in expected.items())


def provider_ack_fields(digest, target_image):
    deployed = f"reg/copy@{digest}"
    return {"image": deployed, "deployedImage": deployed, "targetImage": target_image}


def legacy_writer_cannot_insert_or_claim_without_host_binding(pg, _row, _USER, pytest):
    from psycopg2.errors import InsufficientPrivilege

    _row(pg)
    with pytest.raises(InsufficientPrivilege, match="host-bound personal-agent upgrade lease"):
        pg.execute(
            "UPDATE personal_agent_registry SET backend_metadata=jsonb_set("
            "COALESCE(backend_metadata, '{}'::jsonb), '{upgradeLease}', "
            "to_jsonb('legacy|target'::text), true) WHERE user_id=%s",
            (_USER,),
        )
    with pytest.raises(InsufficientPrivilege, match="host-bound personal-agent upgrade lease"):
        pg.execute(
            "INSERT INTO personal_agent_registry (user_id,hushh_id,status,backend_metadata) "
            "VALUES (%s,%s,'provisioned',%s::jsonb)",
            (_USER + "-insert", "ha1_insert", '{"upgradeLease":"legacy|target"}'),
        )
    assert (
        pg.execute(
            "SELECT backend_metadata FROM personal_agent_registry WHERE user_id=%s", (_USER,)
        )[0][0]
        == {}
    )


async def old_lease_only_clear_is_refused_after_host_bound_claim(
    pg, engine, _row, _USER, _TARGET, pytest
):
    from psycopg2.errors import InsufficientPrivilege

    from db.db_client import DatabaseClient

    _row(pg)
    repo = PersonalAgentRegistryRepo(client=DatabaseClient(engine=engine))
    lease = await repo.claim_image_upgrade(
        user_id=_USER, target_image=_TARGET, observed=await repo.get(_USER)
    )
    assert lease
    before = pg.execute(
        "SELECT backend_metadata FROM personal_agent_registry WHERE user_id=%s", (_USER,)
    )[0][0]
    with pytest.raises(InsufficientPrivilege, match="host-bound personal-agent upgrade lease"):
        pg.execute(
            "UPDATE personal_agent_registry SET backend_metadata=backend_metadata "
            "- 'upgradeLease' - 'upgradeLeaseHost' WHERE user_id=%s",
            (_USER,),
        )
    assert (
        pg.execute(
            "SELECT backend_metadata FROM personal_agent_registry WHERE user_id=%s", (_USER,)
        )[0][0]
        == before
    )


async def fabricated_provider_json_and_legacy_repair_guc_cannot_clear_lease(
    pg, engine, _row, _USER, _TARGET, pytest
):
    import json

    from psycopg2.errors import InsufficientPrivilege

    from db.db_client import DatabaseClient

    _row(pg)
    repo = PersonalAgentRegistryRepo(client=DatabaseClient(engine=engine))
    lease = await repo.claim_image_upgrade(
        user_id=_USER, target_image=_TARGET, observed=await repo.get(_USER)
    )
    assert lease
    fake_evidence = {
        "schemaVersion": 1,
        "userId": _USER,
        "hushhId": "ha1_lease",
        "lease": lease,
        "targetImage": _TARGET,
        "provider": "gcp_cloud_run",
        "resource": "projects/hushh-pda-dev/locations/us-central1/services/owner-pod",
        "operationId": "fabricated-operation",
        "providerState": "succeeded",
        "providerPending": False,
        "executorState": "exited",
        "unresolvedProviderOperations": [],
        "unresolvedProvisioningWork": [],
        "observedImageDigest": "sha256:" + "a" * 64,
        "observedAt": datetime.now(timezone.utc).isoformat(),
        "evidenceRef": "gs://fabricated/settlement.json",
        "evidenceSha256": "b" * 64,
    }
    before = (await repo.get(_USER))["backend_metadata"]
    with pytest.raises(InsufficientPrivilege, match="host-bound personal-agent upgrade lease"):
        pg.execute(
            "WITH untrusted AS MATERIALIZED (SELECT set_config("
            "'hushh.legacy_upgrade_lease_repair', format('%%s|%%s|%%s', %s, %s, "
            "md5(%s::jsonb::text)), true)) "
            "UPDATE personal_agent_registry SET backend_metadata=(backend_metadata "
            "- 'upgradeLease' - 'upgradeLeaseHost') || jsonb_build_object("
            "'legacyUpgradeRepair', %s::jsonb) FROM untrusted WHERE user_id=%s",
            (
                _USER,
                lease,
                json.dumps(fake_evidence),
                json.dumps(fake_evidence),
                _USER,
            ),
        )
    assert (await repo.get(_USER))["backend_metadata"] == before


async def expired_worker_cannot_publish_over_new_claim(pg, engine, _row, _USER, _TARGET):
    from db.db_client import DatabaseClient

    _row(pg)
    repo = PersonalAgentRegistryRepo(client=DatabaseClient(engine=engine))
    observed = await repo.get(_USER)
    lease = await repo.claim_image_upgrade(user_id=_USER, target_image=_TARGET, observed=observed)
    assert lease
    stale = f"{(datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()}|old|{_TARGET}"
    assert not await repo.record_image_upgrade(
        user_id=_USER,
        observed=observed,
        expected_lease=stale,
        previous_metadata={},
        backend_metadata={"image": "old-worker"},
    )
    stored = pg.execute(
        "SELECT backend_metadata FROM personal_agent_registry WHERE user_id=%s", (_USER,)
    )[0][0]
    assert stored["upgradeLease"] == lease
    assert stored["upgradeLeaseHost"]


async def owner_claim_publishes_delta_without_dropping_new_heartbeat(
    pg, engine, _row, _USER, _TARGET
):
    import json

    from db.db_client import DatabaseClient

    _row(pg)
    repo = PersonalAgentRegistryRepo(client=DatabaseClient(engine=engine))
    previous = {"image": "old", "observed": {"imageTag": "old"}, "upgrade": {"attempts": 1}}
    pg.execute(
        "UPDATE personal_agent_registry SET backend_metadata=%s::jsonb WHERE user_id=%s",
        (json.dumps(previous), _USER),
    )
    observed = await repo.get(_USER)
    lease = await repo.claim_image_upgrade(user_id=_USER, target_image=_TARGET, observed=observed)
    current = {
        **previous,
        "observed": {"imageTag": "new"},
        "extra": "keep",
        "upgradeLease": lease,
        "upgradeLeaseHost": pg.execute(
            "SELECT backend_metadata->'upgradeLeaseHost' FROM personal_agent_registry WHERE user_id=%s",
            (_USER,),
        )[0][0],
    }
    pg.execute(
        "UPDATE personal_agent_registry SET backend_metadata=%s::jsonb WHERE user_id=%s",
        (json.dumps(current), _USER),
    )
    assert await repo.record_image_upgrade(
        user_id=_USER,
        observed=observed,
        expected_lease=lease,
        previous_metadata=previous,
        backend_metadata={"image": "new"},
        liveness_mode="economy",
    )
    row = pg.execute(
        "SELECT backend_metadata, liveness_mode FROM personal_agent_registry WHERE user_id=%s",
        (_USER,),
    )[0]
    assert row == ({"image": "new", "observed": {"imageTag": "new"}, "extra": "keep"}, "economy")
    assert not await repo.record_image_upgrade(
        user_id=_USER,
        observed=observed,
        expected_lease=lease,
        previous_metadata=previous,
        backend_metadata={"image": "replay"},
    )


async def lifecycle_transition_refuses_old_upgrade_publication(pg, engine, _row, _USER, _TARGET):
    from db.db_client import DatabaseClient

    _row(pg)
    repo = PersonalAgentRegistryRepo(client=DatabaseClient(engine=engine))
    observed = await repo.get(_USER)
    lease = await repo.claim_image_upgrade(user_id=_USER, target_image=_TARGET, observed=observed)
    pg.execute("UPDATE personal_agent_registry SET status='migrating' WHERE user_id=%s", (_USER,))
    assert not await repo.record_image_upgrade(
        user_id=_USER,
        observed=observed,
        expected_lease=lease,
        previous_metadata={},
        backend_metadata={"image": "old-worker"},
    )
    status, metadata = pg.execute(
        "SELECT status, backend_metadata FROM personal_agent_registry WHERE user_id=%s", (_USER,)
    )[0]
    assert status == "migrating"
    assert metadata["upgradeLease"] == lease
    assert metadata["upgradeLeaseHost"]


async def host_binding_migration_blocks_legacy_and_guards_replay(
    pg_before_host_guard, engine_before_host_guard, _REGISTRY_SCHEMA, _row, _USER, _TARGET, pytest
):
    from psycopg2.errors import ObjectNotInPrerequisiteState

    from db.db_client import DatabaseClient

    migration = _REGISTRY_SCHEMA.parent / "980_personal_agent_upgrade_host_binding.sql"
    rollback = (
        _REGISTRY_SCHEMA.parents[1]
        / "rollback"
        / "980_personal_agent_upgrade_host_binding.rollback.sql"
    )
    legacy_lease = f"{datetime.now(timezone.utc).isoformat()}|legacy|{_TARGET}"
    _row(pg_before_host_guard, lease=legacy_lease)

    with pytest.raises(ObjectNotInPrerequisiteState, match="provider upgrade leases"):
        pg_before_host_guard.apply_file(migration)
    pg_before_host_guard.execute("ROLLBACK")
    assert (
        pg_before_host_guard.execute(
            "SELECT 1 FROM pg_trigger WHERE tgname='zz_personal_agent_upgrade_lease_host_binding'"
        )
        == []
    )

    # Test setup simulates a lease already drained by its trusted owner; there is
    # deliberately no production repair writer for caller-supplied evidence.
    pg_before_host_guard.execute(
        "UPDATE personal_agent_registry SET backend_metadata=backend_metadata-'upgradeLease' "
        "WHERE user_id=%s",
        (_USER,),
    )
    pg_before_host_guard.apply_file(migration)
    assert pg_before_host_guard.execute(
        "SELECT 1 FROM pg_trigger WHERE tgname='zz_personal_agent_upgrade_lease_host_binding'"
    ) == [(1,)]

    _row(pg_before_host_guard)
    repo = PersonalAgentRegistryRepo(client=DatabaseClient(engine=engine_before_host_guard))
    lease = await repo.claim_image_upgrade(
        user_id=_USER,
        target_image=_TARGET,
        observed=await repo.get(_USER),
    )
    assert lease
    with pytest.raises(ObjectNotInPrerequisiteState, match="rollback 980 requires all provider"):
        pg_before_host_guard.apply_file(rollback)
    pg_before_host_guard.execute("ROLLBACK")
    assert pg_before_host_guard.execute(
        "SELECT 1 FROM pg_trigger WHERE tgname='zz_personal_agent_upgrade_lease_host_binding'"
    ) == [(1,)]

    # Removing the disposable test row is cleanup, not a lease repair path.
    pg_before_host_guard.execute("DELETE FROM personal_agent_registry WHERE user_id=%s", (_USER,))
    pg_before_host_guard.apply_file(rollback)
    assert (
        pg_before_host_guard.execute(
            "SELECT 1 FROM pg_trigger WHERE tgname='zz_personal_agent_upgrade_lease_host_binding'"
        )
        == []
    )
    pg_before_host_guard.apply_file(migration)
    assert pg_before_host_guard.execute(
        "SELECT 1 FROM pg_trigger WHERE tgname='zz_personal_agent_upgrade_lease_host_binding'"
    ) == [(1,)]


_HOST_IDENTITY_FIELDS = {
    "project",
    "region",
    "service",
    "serviceUid",
    "url",
    "runtime_service_account",
    "tenancy",
    "ingress",
    "hostKind",
    "vmHost",
    "vmConfigurationSha256",
    "vmUpdateModuleSha256",
    "runtime_principal_id",
    "runtime_client_id",
    "placement_epoch",
    "pod_pubkey",
    "pod_key_id",
    "pod_signing_key_id",
    "pod_signing_pubkey",
    "phone_e164_hash",
    "user_cloud_authorized_at",
    "deployment_target",
}


async def changed_host_refuses_claim_and_old_publication(
    pg, engine, changed_field, _row, _USER, _TARGET, pytest
):
    from db.db_client import DatabaseClient

    _row(pg)
    repo = PersonalAgentRegistryRepo(client=DatabaseClient(engine=engine))
    original = await repo.get(_USER)
    pg.execute(
        "UPDATE personal_agent_registry SET user_cloud_region='europe-west1' WHERE user_id=%s",
        (_USER,),
    )
    assert (
        await repo.claim_image_upgrade(user_id=_USER, target_image=_TARGET, observed=original)
        is None
    )
    observed = await repo.get(_USER)
    lease = await repo.claim_image_upgrade(user_id=_USER, target_image=_TARGET, observed=observed)
    assert lease
    if _mutate_changed_host_field(pg, changed_field, _USER, pytest):
        return
    before = pg.execute(
        "SELECT liveness_mode, backend_metadata FROM personal_agent_registry WHERE user_id=%s",
        (_USER,),
    )[0]
    assert not await repo.record_image_upgrade(
        user_id=_USER,
        expected_lease=lease,
        observed=observed,
        previous_metadata={},
        backend_metadata={"image": "stale"},
        liveness_mode="warm",
    )
    assert (
        pg.execute(
            "SELECT liveness_mode, backend_metadata FROM personal_agent_registry WHERE user_id=%s",
            (_USER,),
        )[0]
        == before
    )


def _mutate_changed_host_field(pg, changed_field, _USER, pytest) -> bool:
    if changed_field == "liveness_mode":
        pg.execute(
            "UPDATE personal_agent_registry SET liveness_mode='economy' WHERE user_id=%s", (_USER,)
        )
        return False
    refused = _refuse_authority_field_change(pg, changed_field, _USER, pytest)
    if refused is not None:
        return refused
    refused = _refuse_key_field_change(pg, changed_field, _USER, pytest)
    if refused is not None:
        return refused
    return _mutate_metadata_host_field(pg, changed_field, _USER, pytest)


def _refuse_authority_field_change(pg, changed_field, _USER, pytest):
    from psycopg2.errors import InsufficientPrivilege

    if changed_field == "user_cloud_authorized_at":
        with pytest.raises(InsufficientPrivilege, match="host-bound personal-agent upgrade lease"):
            pg.execute(
                "UPDATE personal_agent_registry SET user_cloud_authorized_at=NOW() "
                "WHERE user_id=%s",
                (_USER,),
            )
        return True
    elif changed_field == "deployment_target":
        with pytest.raises(InsufficientPrivilege, match="host-bound personal-agent upgrade lease"):
            pg.execute(
                "UPDATE personal_agent_registry SET deployment_target='user_azure' "
                "WHERE user_id=%s",
                (_USER,),
            )
        return True
    elif changed_field == "placement_epoch":
        with pytest.raises(InsufficientPrivilege, match="host-bound personal-agent upgrade lease"):
            pg.execute(
                "UPDATE personal_agent_registry SET placement_epoch=placement_epoch+1 "
                "WHERE user_id=%s",
                (_USER,),
            )
        return True
    return None


def _refuse_key_field_change(pg, changed_field, _USER, pytest):
    from psycopg2.errors import InsufficientPrivilege

    if changed_field == "pod_signing_key_id":
        with pytest.raises(InsufficientPrivilege, match="host-bound personal-agent upgrade lease"):
            pg.execute(
                "UPDATE personal_agent_registry SET pod_signing_key_id=%s WHERE user_id=%s",
                ("pods_" + "e" * 32, _USER),
            )
        return True
    elif changed_field == "pod_signing_pubkey":
        with pytest.raises(InsufficientPrivilege, match="host-bound personal-agent upgrade lease"):
            pg.execute(
                "UPDATE personal_agent_registry SET pod_signing_pubkey=%s WHERE user_id=%s",
                ("B" * 43 + "=", _USER),
            )
        return True
    elif changed_field == "phone_e164_hash":
        with pytest.raises(InsufficientPrivilege, match="host-bound personal-agent upgrade lease"):
            pg.execute(
                "UPDATE personal_agent_registry SET phone_e164_hash=%s WHERE user_id=%s",
                ("replacement-phone-hash", _USER),
            )
        return True
    elif changed_field == "pod_pubkey":
        with pytest.raises(InsufficientPrivilege, match="host-bound personal-agent upgrade lease"):
            pg.execute(
                "UPDATE personal_agent_registry SET pod_pubkey=%s WHERE user_id=%s",
                ("replacement-public", _USER),
            )
        return True
    return None


def _mutate_metadata_host_field(pg, changed_field, _USER, pytest):
    import json

    from psycopg2.errors import InsufficientPrivilege

    update_sql = (
        "UPDATE personal_agent_registry SET backend_metadata=backend_metadata || %s::jsonb "
        "WHERE user_id=%s"
    )
    update_params = (
        json.dumps(
            {
                changed_field: {"owner": "replacement"}
                if changed_field == "substrateReceipt"
                else "replacement"
            }
        ),
        _USER,
    )
    if changed_field in _HOST_IDENTITY_FIELDS:
        with pytest.raises(InsufficientPrivilege, match="host-bound personal-agent upgrade lease"):
            pg.execute(update_sql, update_params)
        return True
    pg.execute(update_sql, update_params)
    return False


async def azure_terminal_direct_admission(pg, engine, changed, _row, owner, target, pytest):
    """An Azure readback's external ingress must not undo exact owner admission."""
    import json
    from types import SimpleNamespace

    from db.db_client import DatabaseClient, DatabaseExecutionError
    from hushh_mcp.services.compute_backend import PodSpec
    from hushh_mcp.services.personal_agent_upgrade_publication import (
        UpgradePublication,
        publish_hosted_files_terminal,
    )
    from hushh_mcp.services.pod_update_identity import merged_upgrade_metadata

    _row(pg)
    host = {
        "service": "/subscriptions/synthetic/resourceGroups/owner/providers/Microsoft.App/containerApps/pod",
        "serviceUid": "synthetic-incarnation",
        "url": "https://owner.example.test",
        "region": "westus",
        "tenancy": "user-owned",
        "runtime_principal_id": "synthetic-principal",
        "runtime_client_id": "synthetic-client",
    }
    readiness = {
        "verified": True,
        "serviceUid": host["serviceUid"],
        "url": host["url"],
        "podKeyId": "podk_synthetic",
    }
    if changed == "readiness":
        readiness["podKeyId"] = "podk_foreign"
    pg.execute(
        "UPDATE personal_agent_registry SET backend='user_azure',deployment_target='user_azure',"
        "user_cloud_tenant_id='11111111-1111-1111-1111-111111111111',"
        "user_cloud_subscription_id='22222222-2222-2222-2222-222222222222',"
        "user_cloud_resource_group='synthetic-owner',user_cloud_region='westus',"
        "pod_key_id='podk_synthetic',backend_metadata=%s::jsonb WHERE user_id=%s",
        (json.dumps({**host, "ingress": "direct", "directReadiness": readiness}), owner),
    )
    repo = PersonalAgentRegistryRepo(client=DatabaseClient(engine=engine))
    lease = await repo.claim_image_upgrade(
        user_id=owner, target_image=target, observed=await repo.get(owner)
    )
    assert lease
    row = await repo.get(owner)
    metadata = row["backend_metadata"]
    spec = PodSpec(
        hushh_id=row["hushh_id"],
        phone_e164_hash="synthetic",
        pod_pubkey=row["pod_pubkey"],
        deployment_target="user_azure",
        expected_service_uid=host["serviceUid"],
    )
    handle = {**host, "ingress": "external", "image": target, "upgraded": True}
    if changed in host:
        handle[changed] = "foreign"
    # The same assembly is used by immediate publication and observation-only recovery.
    candidate = merged_upgrade_metadata(metadata, handle, spec=spec, row=row)
    state = UpgradePublication(
        registry=repo,
        user_id=owner,
        hushh_id=row["hushh_id"],
        current_image=target,
        lease=lease,
        spec=spec,
        backend=SimpleNamespace(),
        claimed_metadata=metadata,
        claimed_row=row,
        files_executor=None,
        files_capability=None,
        approval_operation_id="synthetic-operation",
        approval_release_id="synthetic-release",
        approval_incarnation=host["serviceUid"],
    )
    if changed is not None:
        with pytest.raises(DatabaseExecutionError):
            await publish_hosted_files_terminal(state, candidate)
        assert (await repo.get(owner))["backend_metadata"] == metadata
    else:
        await publish_hosted_files_terminal(state, candidate)
        final = (await repo.get(owner))["backend_metadata"]
        assert final["ingress"] == "direct" and final["directReadiness"] == readiness
        assert (
            final["image"] == target
            and "upgradeLease" not in final
            and "upgradeLeaseHost" not in final
        )
