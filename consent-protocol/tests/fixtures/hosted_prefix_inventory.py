"""Actual SQL prefix coordinates and native resource reads; no cloud credentials."""

import json
from copy import deepcopy
from functools import partial
from types import SimpleNamespace

import pytest

from hushh_mcp.services.hosted_pod_journal import HostedPodJournal
from hushh_mcp.services.hosted_prefix_native_inventory import NativePrefixInventory
from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired
from tests.fixtures.hosted_prefix_abort import admitted_prefix_abort
from tests.fixtures.hosted_prefix_operator import TOKEN, NativePrefixFixture, PrefixRegistry
from tests.test_hosted_pilot_admission_postgres import _Client


async def verify_native_prefix_inventory(pg, monkeypatch):
    async for fixture in admitted_prefix_abort(pg, 18, bridge=True):
        client = _Client(pg)
        native = NativePrefixFixture(fixture)
        registry = PrefixRegistry(fixture, client)
        observer = NativePrefixInventory(registry, token=TOKEN)
        session = SimpleNamespace(get=partial(native.request, "GET"), request=native.request)
        memory = deepcopy(native.inventory["noMemory"])
        fields = {"buckets": "gcs_bucket", "kms_keys": "kms_key", "secrets": "secret"}
        core = {
            field: []
            for field in (
                "cloud_run_services",
                "cloud_run_jobs",
                "buckets",
                "soft_deleted_buckets",
                "kms_keys",
                "secrets",
            )
        }
        for field, kind in fields.items():
            item = next(row for row in native.inventory["resources"] if row["type"] == kind)
            core[field] = [deepcopy(item["identity"])]
        monkeypatch.setattr(
            "hushh_mcp.services.hosted_prefix_native_inventory.NativeProjectInventory.core",
            lambda self, core=core: deepcopy(core),
        )
        monkeypatch.setattr(
            "hushh_mcp.services.hosted_prefix_native_inventory.observe_memory_absence",
            lambda *a, memory=memory, **kw: deepcopy(memory),
        )
        try:
            admitted = observer(fixture.reservation(), "admission", session)
            assert admitted["writerFence"]["status"] == "admitted"
            assert pg.execute(
                "SELECT valid_managed_prefix_inventory_admission(%s::jsonb,%s::jsonb)",
                (
                    json.dumps(fixture.reservation()),
                    json.dumps(admitted),
                ),
            )[0][0]
            journal = HostedPodJournal(client)
            assert await journal.retain_prefix_abort(
                owner_id=fixture.owner,
                reservation=fixture.reservation(),
                kind="inventory",
                key="",
                stage="admission",
                receipt=admitted,
            )
            with pytest.raises(ProvisionReconciliationRequired, match="writer is not disabled"):
                observer(fixture.reservation(), "inventory", session)
            runtime = admitted["writerFence"]["identity"]
            native.resources["https://iam.googleapis.com/v1/" + runtime["name"]]["disabled"] = True
            for entry in memory["coverage"]:
                entry["observedAt"] = "2026-10-27T00:01:00Z"
            observed = observer(fixture.reservation(), "inventory", session)
            assert observed["noMemory"] == admitted["noMemory"]
            assert await journal.retain_prefix_abort(
                owner_id=fixture.owner,
                reservation=fixture.reservation(),
                kind="inventory",
                key="",
                stage="inventory",
                receipt=observed,
            )
            core["buckets"].append({"name": "foreign-owner-bucket"})
            with pytest.raises(ProvisionReconciliationRequired, match="unknown or missing"):
                observer(fixture.reservation(), "inventory", session)
            assert all(method == "GET" for method, _ in native.log)
        finally:
            client._engine.dispose()
