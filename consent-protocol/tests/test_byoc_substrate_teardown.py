"""The BYOC substrate teardown is DARK: it plans safely and destroys nothing unless
two independent guards open. These pin the ordering and, above all, the guards --
this deletes the user's sealed holdings in their own project, irreversibly.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.byoc_substrate_teardown import execute_teardown, plan_teardown


def test_plan_orders_dependency_safe_with_kms_last():
    resources = [
        {"type": "kms_key", "id": "one-pod-x-key"},
        {"type": "gcs_bucket", "id": "one-pod-x-blobs"},
        {"type": "scheduler_job", "id": "one-pod-x-wake"},
        {"type": "service_account", "id": "one-pod-x-sa"},
    ]
    plan = plan_teardown(resources)
    order = [a["type"] for a in plan]
    # scheduler before bucket before SA before KMS (reverse of creation)
    assert order.index("scheduler_job") < order.index("gcs_bucket")
    assert order.index("gcs_bucket") < order.index("service_account")
    assert order.index("service_account") < order.index("kms_key")
    # the KMS key is a version-destroy, never a delete
    kms = next(a for a in plan if a["type"] == "kms_key")
    assert kms["op"] == "destroy_versions"


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
            {"type": "scheduler_job", "id": "s"},
            {"type": "gcs_bucket", "id": "b"},
        ]
    )
    result = await execute_teardown(plan, deleter=_deleter, dry_run=False)
    assert result["executed"] is True
    # deleted in the safe order: scheduler, bucket, then kms last
    assert deleted == ["s", "b", "k"]
