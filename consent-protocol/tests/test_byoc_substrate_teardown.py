"""The BYOC substrate teardown is DARK: it plans safely and destroys nothing unless
two independent guards open. These pin the ordering and, above all, the guards --
this deletes the user's sealed holdings in their own project, irreversibly.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.byoc_substrate_teardown import (
    _TEARDOWN_PRIORITY,
    execute_teardown,
    plan_teardown,
    substrate_resources,
)


def test_plan_orders_dependency_safe_with_kms_last():
    resources = [
        {"type": "kms_key", "id": "one-pod-x-key"},
        {"type": "gcs_bucket", "id": "one-pod-x-blobs"},
        {"type": "cloud_scheduler_job", "id": "one-pod-x-wake"},
        {"type": "service_account", "id": "one-pod-x-sa"},
    ]
    plan = plan_teardown(resources)
    order = [a["type"] for a in plan]
    # scheduler before bucket before SA before KMS (reverse of creation)
    assert order.index("cloud_scheduler_job") < order.index("gcs_bucket")
    assert order.index("gcs_bucket") < order.index("service_account")
    assert order.index("service_account") < order.index("kms_key")
    # the KMS key is a version-destroy, never a delete
    kms = next(a for a in plan if a["type"] == "kms_key")
    assert kms["op"] == "destroy_versions"


def test_every_emitted_type_has_an_explicit_priority_slot():
    # Every type substrate_resources emits must own a priority slot -- a stray
    # default-90 entry means a renamed type key silently fell out of the
    # dependency order (the scheduler_job -> cloud_scheduler_job drift).
    plan = plan_teardown(substrate_resources("ha1_abc", "proj-x"))
    types = [a["type"] for a in plan]
    assert set(types) <= set(_TEARDOWN_PRIORITY)
    assert types[0] == "cloud_scheduler_job"
    assert types[-1] == "kms_key"


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["gcs_bucket", "iam_binding", "service_account_iam_binding"])
async def test_duplicate_targets_refuse_before_admission_or_provider(monkeypatch, kind):
    from hushh_mcp.services.byoc_substrate_teardown import SubstrateDeleteError

    monkeypatch.setenv("PERSONAL_AGENT_SUBSTRATE_TEARDOWN_ENABLED", "1")
    calls = []

    async def observe(payload):
        calls.append(payload)
        return True

    resource = {
        "type": kind,
        "id": "target",
        "role": "roles/viewer",
        "member": "serviceAccount:owner@example.com",
        "resource": "owner@example.com",
    }
    duplicate = {**resource, "id": " target " if kind == "gcs_bucket" else "different-label"}
    with pytest.raises(SubstrateDeleteError, match="duplicate targets"):
        await execute_teardown(
            [resource, duplicate],
            deleter=observe,
            dry_run=False,
            before_action=observe,
            on_result=observe,
        )
    assert calls == []


def test_distinct_iam_grants_remain_separate_actions():
    base = {"type": "iam_binding", "id": "grant", "role": "roles/viewer"}
    assert (
        len(
            plan_teardown(
                [{**base, "member": "user:a@example.com"}, {**base, "member": "user:b@example.com"}]
            )
        )
        == 2
    )


def test_substrate_resources_names_the_project_level_grant():
    from hushh_mcp.services.user_gcp_backend import pod_service_account_id

    sa_email = f"{pod_service_account_id('ha1_abc')}@proj-x.iam.gserviceaccount.com"
    resources = substrate_resources("ha1_abc", "proj-x")
    bindings = [r for r in resources if r["type"] == "iam_binding"]
    # exactly ONE project-level grant: bootstrap's iam_pod_sa_vertex Vertex binding
    assert len(bindings) == 1
    assert bindings[0]["role"] == "roles/aiplatform.user"
    assert bindings[0]["member"] == f"serviceAccount:{sa_email}"
    plan = plan_teardown(resources)
    binding = next(a for a in plan if a["type"] == "iam_binding")
    # plan_teardown carries the structured fields through to the deleter
    assert binding["role"] == "roles/aiplatform.user"
    assert binding["member"] == f"serviceAccount:{sa_email}"
    # removed after the bucket and BEFORE the SA delete, so the live member form
    # (not the deleted: residue) is what the first attempt sees
    order = [a["type"] for a in plan]
    assert order.index("gcs_bucket") < order.index("iam_binding")
    assert order.index("iam_binding") < order.index("service_account")


@pytest.mark.asyncio
async def test_execute_is_dry_by_default_and_deletes_nothing():
    deleted: list = []

    async def _deleter(action):
        deleted.append(action)

    result = await execute_teardown(
        [{"type": "gcs_bucket", "id": "one-pod-x-blobs", "op": "delete"}], deleter=_deleter
    )
    assert result["executed"] is False
    assert deleted == []


@pytest.mark.asyncio
async def test_execute_refuses_without_the_flag_even_when_not_dry_run(monkeypatch):
    monkeypatch.delenv("PERSONAL_AGENT_SUBSTRATE_TEARDOWN_ENABLED", raising=False)
    deleted: list = []

    async def _deleter(action):
        deleted.append(action)

    result = await execute_teardown(
        [{"type": "gcs_bucket", "id": "b", "op": "delete"}], deleter=_deleter, dry_run=False
    )
    assert result["executed"] is False
    assert deleted == []  # the flag is the second guard; still nothing destroyed


@pytest.mark.asyncio
async def test_execute_destroys_in_order_only_with_both_guards_open(monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_SUBSTRATE_TEARDOWN_ENABLED", "1")
    deleted: list = []

    async def _deleter(action):
        deleted.append(action["id"])

    plan = plan_teardown(
        [
            {"type": "kms_key", "id": "k"},
            {"type": "cloud_scheduler_job", "id": "s"},
            {"type": "gcs_bucket", "id": "b"},
        ]
    )
    result = await execute_teardown(plan, deleter=_deleter, dry_run=False)
    assert result["executed"] is True
    # deleted in the safe order: scheduler, bucket, then kms last
    assert deleted == ["s", "b", "k"]


@pytest.mark.asyncio
async def test_execute_records_failures_and_continues(monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_SUBSTRATE_TEARDOWN_ENABLED", "1")
    attempted: list = []

    async def _deleter(action):
        attempted.append(action["id"])
        if action["id"] == "b":
            raise RuntimeError(
                "synthetic provider URL?token=private-value response=private-information"
            )

    plan = [
        {"type": "cloud_scheduler_job", "id": "s", "op": "delete"},
        {"type": "gcs_bucket", "id": "b", "op": "delete"},
        {"type": "kms_key", "id": "k", "op": "destroy_versions"},
    ]
    result = await execute_teardown(plan, deleter=_deleter, dry_run=False)
    assert result["executed"] is True
    assert result["complete"] is False
    # the failure is recorded with its reason, never minted into "deleted"
    assert [a["id"] for a in result["failed"]] == ["b", "k"]
    assert result["failed"][0]["reason"] == "cleanup_unavailable"
    assert "private-value" not in str(result)
    assert "private-information" not in str(result)
    assert result["failed"][1]["reason"] == "deferred_until_dependencies_erased"
    assert [a["id"] for a in result["deleted"]] == ["s"]
    # Recovery authority is retained until the failed dependency is erased.
    assert attempted == ["s", "b"]


@pytest.mark.asyncio
async def test_execute_full_success_reports_complete(monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_SUBSTRATE_TEARDOWN_ENABLED", "1")

    async def _deleter(action):
        return None

    plan = plan_teardown([{"type": "gcs_bucket", "id": "b"}, {"type": "kms_key", "id": "k"}])
    result = await execute_teardown(plan, deleter=_deleter, dry_run=False)
    assert result["complete"] is True
    assert result["failed"] == []
    assert result["deleted"] == plan


@pytest.mark.parametrize(
    "invalid",
    [
        None,
        {},
        "bucket",
        [None],
        [{}],
        [{"type": "gcs_bucket", "id": ""}],
        [{"type": "gcs_bucket", "id": 7}],
    ],
)
async def test_invalid_inventory_is_never_dropped_or_partially_executed(monkeypatch, invalid):
    from unittest.mock import AsyncMock

    from hushh_mcp.services.byoc_substrate_teardown import SubstrateDeleteError

    monkeypatch.setenv("PERSONAL_AGENT_SUBSTRATE_TEARDOWN_ENABLED", "1")
    deleter = AsyncMock()
    resources = (
        [{"type": "gcs_bucket", "id": "valid"}, *invalid] if isinstance(invalid, list) else invalid
    )
    with pytest.raises(SubstrateDeleteError):
        plan_teardown(resources)
    with pytest.raises(SubstrateDeleteError):
        await execute_teardown(resources, deleter=deleter, dry_run=False)
    deleter.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["admission", "outcome", "exception", "truthy"])
async def test_cleanup_checkpoint_failure_preserves_remaining_resources(monkeypatch, failure):
    monkeypatch.setenv("PERSONAL_AGENT_SUBSTRATE_TEARDOWN_ENABLED", "1")
    events = []

    async def admit(action):
        events.append(("admit", action["id"]))
        return failure != "admission"

    async def delete(action):
        events.append(("delete", action["id"]))

    async def record(outcome):
        events.append(("record", outcome["status"]))
        if failure == "exception":
            raise RuntimeError("synthetic-private-database-connection")
        return 1 if failure == "truthy" else False

    result = await execute_teardown(
        [
            {"type": "cloud_scheduler_job", "id": "first"},
            {"type": "pubsub_topic", "id": "second"},
            {"type": "secret", "id": "recovery"},
        ],
        deleter=delete,
        dry_run=False,
        before_action=admit,
        on_result=record,
    )
    assert result["complete"] is False
    assert result["deleted"] == []
    assert len(events) == (1 if failure == "admission" else 3)
    assert result["failed"][0]["reason"] == (
        "cleanup_admission_unconfirmed" if failure == "admission" else "cleanup_outcome_unconfirmed"
    )
    assert all(
        item["reason"] == "deferred_until_cleanup_receipt_confirmed"
        for item in result["failed"][1:]
    )
    assert "synthetic-private" not in str(result)


@pytest.mark.asyncio
async def test_cleanup_checkpoints_precede_next_action_and_cannot_mutate_its_target(monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_SUBSTRATE_TEARDOWN_ENABLED", "1")
    events = []

    async def admit(action):
        events.append(("admit", action["id"]))
        action["id"] = "foreign"
        return True

    async def delete(action):
        events.append(("delete", action["id"]))

    async def record(outcome):
        events.append(("record", outcome["action"]["id"]))
        assert outcome["status"] == "deleted"
        return True

    result = await execute_teardown(
        [{"type": "cloud_scheduler_job", "id": "first"}, {"type": "secret", "id": "last"}],
        deleter=delete,
        dry_run=False,
        before_action=admit,
        on_result=record,
    )
    assert result["complete"] is True
    assert events == [
        (stage, resource)
        for resource in ("first", "last")
        for stage in ("admit", "delete", "record")
    ]


@pytest.mark.asyncio
async def test_cleanup_rejects_unpaired_persistence_before_deletion(monkeypatch):
    from unittest.mock import AsyncMock

    from hushh_mcp.services.byoc_substrate_teardown import SubstrateDeleteError

    monkeypatch.setenv("PERSONAL_AGENT_SUBSTRATE_TEARDOWN_ENABLED", "1")
    delete = AsyncMock()
    with pytest.raises(SubstrateDeleteError, match="paired"):
        await execute_teardown(
            [{"type": "secret", "id": "recovery"}],
            deleter=delete,
            dry_run=False,
            on_result=AsyncMock(),
        )
    delete.assert_not_awaited()
