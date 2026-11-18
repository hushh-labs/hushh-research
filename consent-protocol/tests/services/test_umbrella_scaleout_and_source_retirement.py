# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Unit & contract tests for Dev horizontal Umbrella Cell scale-out and 14-day source retirement."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import server
from api import database_listener_lifecycle as listener_lifecycle
from api.hub_route_classes import ROUTE_CLASSES, RouteClass
from api.middleware import require_firebase_auth
from api.routes.one import runtime as runtime_routes
from hushh_mcp.services.compute_backend import BACKEND_AZURE, BACKEND_GCP
from hushh_mcp.services.pod_umbrella_cell_pool import (
    PodSkeletonPoolService,
    SkeletonSlotConfig,
    UmbrellaCellConfig,
    UmbrellaCellRegistry,
)
from hushh_mcp.services.source_pod_retirement import (
    GraceDetachedPlacement,
    _retire_byoc_azure_observer_sync,
    _retire_hosted_azure_slot_sync,
    build_source_retirement_items,
    compute_placement_id,
    iter_grace_governed_detached_placements,
)
from hushh_mcp.services.umbrella_cell_replenisher import (
    UmbrellaCellReplenisher,
    get_replenisher_telemetry,
    provision_azure_warm_skeleton_sync,
)
from hushh_mcp.services.umbrella_cell_scaler import (
    discover_azure_umbrella_cells_sync,
    evaluate_horizontal_cell_scaleout,
    provision_azure_umbrella_cell_sync,
)


def _azure_cell(
    cell_id: str = "cell-az-eastus2-dev-01", *, min_warm: int = 2
) -> UmbrellaCellConfig:
    idx = int(cell_id.rsplit("-", 1)[-1])
    rg = f"rg-hussh-cell-dev-eastus2-{idx:02d}"
    return UmbrellaCellConfig(
        cell_id=cell_id,
        provider=BACKEND_AZURE,
        organization="HushOne Inc.",
        soft_watermark=40,
        hard_watermark=50,
        min_warm_skeletons=min_warm,
        max_warm_skeletons=2,
        replenish_batch_size=1,
        shared_cell_fixed_monthly_usd=18.0 if idx == 1 else 0.0,
        per_warm_slot_standing_monthly_usd=0.0,
        tenant_id="e1e09f9b-313b-4c57-a925-f2a573a919e9",
        subscription_id="3f5a1e87-97d6-4f05-b4ce-0e2cc675e118",
        resource_group=rg,
        shared_resource_group="rg-hussh-cell-dev-eastus2-01",
        location="eastus2",
        environment_name=f"cae-hussh-cell-dev-eus2-{idx:02d}",
        environment_id=(
            f"/subscriptions/3f5a1e87-97d6-4f05-b4ce-0e2cc675e118/resourceGroups/{rg}/"
            f"providers/Microsoft.App/managedEnvironments/cae-hussh-cell-dev-eus2-{idx:02d}"
        ),
        registry_server="crhusshcelldeveus201.azurecr.io",
        storage_account=f"sthusshcelldeveus2{idx:02d}",
        key_vault_name=f"kv-h1-celldeveus2{idx:02d}",
        openai_endpoint="https://oai-hussh-cell-dev-eus2-01.openai.azure.com/",
        openai_deployment="one-chat",
        controller_client_id="815df3ec-c8c4-4df3-a01a-f611dd6eb3c4",
        image_digest="sha256:" + ("a" * 64),
        slots=(),
    )


def _gcp_cell(cell_id: str = "cell-gcp-uscentral1-dev-01") -> UmbrellaCellConfig:
    return UmbrellaCellConfig(
        cell_id=cell_id,
        provider=BACKEND_GCP,
        organization="HushOne Inc.",
        soft_watermark=64,
        hard_watermark=80,
        min_warm_skeletons=0,
        max_warm_skeletons=0,
        replenish_batch_size=1,
        shared_cell_fixed_monthly_usd=0.0,
        per_warm_slot_standing_monthly_usd=0.0,
        location="us-central1",
        slots=(),
    )


class _RecordingArm:
    def __init__(self) -> None:
        self.puts: list[tuple[str, str, dict[str, Any], str]] = []
        self.deletes: list[tuple[str, str, str]] = []
        self.resources: dict[str, dict[str, Any]] = {}
        self.lists: dict[str, list[dict[str, Any]]] = {}

    def get(self, path: str, *, api_version: str, op: str = "") -> dict[str, Any]:
        del api_version, op
        if path in self.lists:
            return {"value": list(self.lists[path])}
        return self.resources.get(path, {"value": []})

    def get_or_none(self, path: str, *, api_version: str, op: str = "") -> dict[str, Any] | None:
        del api_version, op
        if path in self.lists:
            return {"value": list(self.lists[path])}
        return self.resources.get(path)

    def put(
        self, path: str, *, api_version: str, body: dict[str, Any], op: str = ""
    ) -> dict[str, Any]:
        self.puts.append((path, api_version, body, op))
        if "/managedEnvironments/" in path:
            resp = {"id": path, "properties": {"provisioningState": "Succeeded"}}
            self.resources[path] = resp
            return resp
        if "/userAssignedIdentities/" in path:
            resp = {
                "id": path,
                "properties": {
                    "clientId": "00000000-0000-4000-8000-000000000099",
                    "principalId": "11111111-1111-4000-8000-000000000099",
                },
            }
            self.resources[path] = resp
            return resp
        if "/keys/" in path and "/providers/Microsoft.KeyVault/" in path:
            resp = {"properties": {"keyUriWithVersion": "https://vault.example/keys/k/v1"}}
            self.resources[path] = resp
            return resp
        if "/containerApps/" in path:
            app_name = path.rsplit("/", 1)[-1]
            resp = {
                "id": path,
                "tags": dict(body.get("tags") or {}),
                "properties": {
                    "provisioningState": "Succeeded",
                    "latestReadyRevisionName": f"{app_name}--0000001",
                    "configuration": {
                        "ingress": {"fqdn": f"{app_name}.example.azurecontainerapps.io"}
                    },
                    "template": body.get("properties", {}).get("template", {}),
                },
            }
            self.resources[path] = resp
            return resp
        self.resources[path] = dict(body)
        return dict(body)

    def delete(self, path: str, *, api_version: str, op: str = "") -> bool:
        self.deletes.append((path, api_version, op))
        self.resources.pop(path, None)
        return True


def test_evaluate_horizontal_cell_scaleout_triggers_at_soft_watermark() -> None:
    az01 = _azure_cell("cell-az-eastus2-dev-01")
    gcp01 = _gcp_cell("cell-gcp-uscentral1-dev-01")

    # Under 80% soft watermark -> stays single cell.
    under_az = evaluate_horizontal_cell_scaleout(
        provider=BACKEND_AZURE,
        cells=[az01],
        active_counts_by_cell={az01.cell_id: 39},
    )
    assert under_az.should_scale_out is False
    assert under_az.reason == "headroom_below_soft_watermark"

    under_gcp = evaluate_horizontal_cell_scaleout(
        provider=BACKEND_GCP,
        cells=[gcp01],
        active_counts_by_cell={gcp01.cell_id: 63},
    )
    assert under_gcp.should_scale_out is False

    # Azure hits 40/50 -> plans cell-az-eastus2-dev-02 with shared cell-01 RG & $0 fixed cost.
    at_az = evaluate_horizontal_cell_scaleout(
        provider=BACKEND_AZURE,
        cells=[az01],
        active_counts_by_cell={az01.cell_id: 40},
        cost_guard_by_cell={az01.cell_id: True},
    )
    assert at_az.should_scale_out is True
    assert at_az.next_cell_id == "cell-az-eastus2-dev-02"
    assert at_az.planned_config is not None
    assert at_az.planned_config.resource_group == "rg-hussh-cell-dev-eastus2-02"
    assert at_az.planned_config.shared_resource_group == "rg-hussh-cell-dev-eastus2-01"
    assert at_az.planned_config.shared_cell_fixed_monthly_usd == 0.0
    assert at_az.planned_config.min_warm_skeletons == 1

    # GCP hits 64/80 -> plans cell-gcp-uscentral1-dev-02.
    at_gcp = evaluate_horizontal_cell_scaleout(
        provider=BACKEND_GCP,
        cells=[gcp01],
        active_counts_by_cell={gcp01.cell_id: 64},
    )
    assert at_gcp.should_scale_out is True
    assert at_gcp.next_cell_id == "cell-gcp-uscentral1-dev-02"

    # Once cell-02 exists with headroom, scale-out stops until BOTH cells reach 40/50.
    az02 = at_az.planned_config
    multi = evaluate_horizontal_cell_scaleout(
        provider=BACKEND_AZURE,
        cells=[az01, az02],
        active_counts_by_cell={az01.cell_id: 45, az02.cell_id: 10},
    )
    assert multi.should_scale_out is False
    assert multi.reason == "headroom_below_soft_watermark"

    # Cost guard tripwire and subscription RBAC ceiling both block scale-out safely.
    tripped = evaluate_horizontal_cell_scaleout(
        provider=BACKEND_AZURE,
        cells=[az01],
        active_counts_by_cell={az01.cell_id: 45},
        cost_guard_by_cell={az01.cell_id: False},
    )
    assert tripped.should_scale_out is False
    assert tripped.reason == "cost_guard_tripped"

    capped = evaluate_horizontal_cell_scaleout(
        provider=BACKEND_AZURE,
        cells=[az01],
        active_counts_by_cell={az01.cell_id: 45},
        total_rbac_assignments_used=3800,
    )
    assert capped.should_scale_out is False
    assert capped.reason == "subscription_rbac_quota_ceiling"


def test_provision_and_discover_azure_cell_zero_overhead_and_cross_rg_rbac(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "production")
    assert discover_azure_umbrella_cells_sync(_azure_cell(), arm_client=_RecordingArm()) == ()  # type: ignore[arg-type]
    with pytest.raises(PermissionError):
        provision_azure_umbrella_cell_sync(_azure_cell(), _azure_cell("cell-az-eastus2-dev-02"))

    monkeypatch.setenv("ENVIRONMENT", "dev")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    template = _azure_cell("cell-az-eastus2-dev-01")
    decision = evaluate_horizontal_cell_scaleout(
        provider=BACKEND_AZURE,
        cells=[template],
        active_counts_by_cell={template.cell_id: 40},
    )
    assert decision.planned_config is not None
    arm = _RecordingArm()
    provisioned = provision_azure_umbrella_cell_sync(
        template, decision.planned_config, arm_client=arm
    )  # type: ignore[arg-type]
    assert provisioned.shared_cell_fixed_monthly_usd == 0.0
    assert provisioned.shared_resource_group == "rg-hussh-cell-dev-eastus2-01"

    put_ops = {op: (path, body) for path, _ver, body, op in arm.puts}
    assert put_ops["umbrella_scaleout_storage"][1]["properties"]["allowSharedKeyAccess"] is False
    assert (
        put_ops["umbrella_scaleout_blob_service"][1]["properties"]["deleteRetentionPolicy"][
            "enabled"
        ]
        is False
    )
    assert (
        put_ops["umbrella_scaleout_key_vault"][1]["properties"]["enableRbacAuthorization"] is True
    )
    assert (
        put_ops["umbrella_scaleout_cae"][1]["properties"]["appLogsConfiguration"]["destination"]
        is None
    )
    assert "hussh-cae-id" in put_ops["umbrella_scaleout_rg_tags"][1]["tags"]

    # Discovery parses tagged cell-02 sibling alongside cell-01.
    arm.lists[f"/subscriptions/{template.subscription_id}/resourcegroups"] = [
        {
            "name": "rg-hussh-cell-dev-eastus2-02",
            "location": "eastus2",
            "tags": put_ops["umbrella_scaleout_rg_tags"][1]["tags"],
        },
        {"name": "rg-unrelated", "location": "eastus2", "tags": {"hussh-tenancy": "byoc"}},
    ]
    discovered = discover_azure_umbrella_cells_sync(template, arm_client=arm)  # type: ignore[arg-type]
    assert [c.cell_id for c in discovered] == ["cell-az-eastus2-dev-02"]
    assert discovered[0].shared_resource_group == "rg-hussh-cell-dev-eastus2-01"
    assert discovered[0].shared_cell_fixed_monthly_usd == 0.0

    # Slot provisioning inside cell-02 binds ACR + OpenAI RBAC on cell-01 shared RG, KV + Storage on cell-02 RG.
    slot_arm = _RecordingArm()
    minted = provision_azure_warm_skeleton_sync(
        provisioned, "slot01", arm_client=slot_arm, sleep=lambda _s: None
    )  # type: ignore[arg-type]
    assert minted.slot_id == "slot01"
    rbac_paths = {
        op: path for path, _ver, _body, op in slot_arm.puts if op.startswith("replenish_rbac_")
    }
    assert (
        "rg-hussh-cell-dev-eastus2-01/providers/Microsoft.ContainerRegistry"
        in rbac_paths["replenish_rbac_acr"]
    )
    assert (
        "rg-hussh-cell-dev-eastus2-01/providers/Microsoft.CognitiveServices"
        in rbac_paths["replenish_rbac_openai"]
    )
    assert (
        "rg-hussh-cell-dev-eastus2-02/providers/Microsoft.Storage"
        in rbac_paths["replenish_rbac_blob"]
    )
    assert (
        "rg-hussh-cell-dev-eastus2-02/providers/Microsoft.KeyVault"
        in rbac_paths["replenish_rbac_kv_key"]
    )


@pytest.mark.asyncio
async def test_replenisher_auto_scales_out_cell_02_and_mints_standby_slot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ENVIRONMENT", "dev")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "true")
    monkeypatch.setenv("HUSSH_UMBRELLA_REPLENISHER_ENABLED", "true")
    monkeypatch.setenv("HUSSH_UMBRELLA_CELL_AUTOSCALEOUT_ENABLED", "true")

    base_cell = _azure_cell("cell-az-eastus2-dev-01", min_warm=1)
    cell01_slots = tuple(
        SkeletonSlotConfig(
            slot_id=f"slot{idx:02d}",
            app_name=f"ca-pod-slot{idx:02d}",
            app_id=f"/subscriptions/{base_cell.subscription_id}/resourceGroups/{base_cell.resource_group}/providers/Microsoft.App/containerApps/ca-pod-slot{idx:02d}",
            fqdn=f"ca-pod-slot{idx:02d}.example.azurecontainerapps.io",
            identity_id="/subs/id",
            identity_client_id=f"00000000-0000-4000-8000-{idx:012x}",
            identity_principal_id=f"11111111-1111-4000-8000-{idx:012x}",
            blob_url=f"https://{base_cell.storage_account}.blob.core.windows.net/pod-slot{idx:02d}",
            key_vault_key=f"https://{base_cell.key_vault_name}.vault.azure.net/keys/k-{idx:02d}",
            signing_secret_url=f"https://{base_cell.key_vault_name}.vault.azure.net/secrets/s-{idx:02d}",
        )
        for idx in range(1, 41)
    )
    full_cell01 = UmbrellaCellConfig(**{**base_cell.__dict__, "slots": cell01_slots})
    registry = UmbrellaCellRegistry({"environment": "dev", "cells": []})
    registry.upsert_cells([full_cell01])

    class _FakePool(PodSkeletonPoolService):
        def list_live_cells_sync(
            self, *, provider: str | None = None
        ) -> tuple[UmbrellaCellConfig, ...]:
            return self._registry.list_cells(provider=provider)

        def observe_azure_cell_inventory_sync(self, cell: UmbrellaCellConfig) -> dict[str, Any]:
            return {
                "slots": cell.slots,
                "arm_tags": {s.slot_id: {"hussh-pool-state": "claimed"} for s in cell.slots},
                "provisioning_slot_ids": set(),
                "zero_scale_verified_slots": [],
                "cost_guard_healthy": True,
            }

    minted_calls: list[tuple[str, str]] = []

    def _fake_cell_provisioner(
        _tpl: UmbrellaCellConfig, planned: UmbrellaCellConfig
    ) -> UmbrellaCellConfig:
        return planned

    def _fake_slot_provisioner(cell: UmbrellaCellConfig, slot_id: str) -> SkeletonSlotConfig:
        minted_calls.append((cell.cell_id, slot_id))
        return SkeletonSlotConfig(
            slot_id=slot_id,
            app_name=f"ca-pod-{slot_id}",
            app_id=f"/subscriptions/{cell.subscription_id}/resourceGroups/{cell.resource_group}/providers/Microsoft.App/containerApps/ca-pod-{slot_id}",
            fqdn=f"ca-pod-{slot_id}.example.azurecontainerapps.io",
            identity_id="/subs/id",
            identity_client_id="00000000-0000-4000-8000-000000000101",
            identity_principal_id="11111111-1111-4000-8000-000000000101",
            blob_url=f"https://{cell.storage_account}.blob.core.windows.net/pod-{slot_id}",
            key_vault_key=f"https://{cell.key_vault_name}.vault.azure.net/keys/k-{slot_id}",
            signing_secret_url=f"https://{cell.key_vault_name}.vault.azure.net/secrets/s-{slot_id}",
        )

    pool = _FakePool(registry=registry)
    replenisher = UmbrellaCellReplenisher(
        registry=registry,
        pool=pool,
        occupied_loader=lambda: {s.app_id.lower() for s in cell01_slots},
        provisioner=_fake_slot_provisioner,
        cell_provisioner=_fake_cell_provisioner,
    )
    report = await replenisher.replenish_once()
    assert report.skipped is False
    assert report.created_cells == ("cell-az-eastus2-dev-02",)
    assert "cell-az-eastus2-dev-02:slot01" in report.created_slots
    assert get_replenisher_telemetry()["cellsCreatedTotal"] >= 1


def test_source_retirement_projection_skips_founder_holds_and_respects_byoc_boundary() -> None:
    now = datetime(2026, 11, 20, 12, 0, tzinfo=timezone.utc)
    reap_future = (now + timedelta(days=10)).isoformat()
    reap_past = (now - timedelta(days=1)).isoformat()
    byoc_entry = {
        "detachedAt": "2026-11-17T08:00:00+00:00",
        "backend": "user_azure",
        "deployment_target": "user_azure",
        "user_cloud_tenant_id": "11111111-1111-1111-1111-111111111111",
        "user_cloud_subscription_id": "22222222-2222-2222-2222-222222222222",
        "user_cloud_resource_group": "rg-owner-byoc",
        "graceDays": 14,
        "graceReapAfter": reap_future,
    }
    pid = compute_placement_id(byoc_entry)
    row = {
        "user_id": "uid-1",
        "hushh_id": "ha1_1",
        "backend_metadata": {
            "detachedPlacements": [
                {
                    "detachedAt": "2026-11-01T00:00:00+00:00",
                    "deployment_target": "user_gcp",
                    "user_cloud_project": "founder-hold",
                },
                byoc_entry,
            ],
            "sourcePodRetirements": {},
        },
    }
    governed = iter_grace_governed_detached_placements(row)
    assert len(governed) == 1
    assert governed[0].placement_id == pid

    items = build_source_retirement_items(row, now=now)
    assert len(items) == 1
    assert items[0]["status"] == "awaiting_owner_confirmation"
    assert items[0]["daysRemaining"] == 10

    row["backend_metadata"]["sourcePodRetirements"][pid] = {"ownerConfirmed": True}
    assert build_source_retirement_items(row, now=now)[0]["status"] == "owner_confirmed"

    # Once past grace with ownerConfirmed=True -> ready_for_retirement.
    byoc_entry["graceReapAfter"] = reap_past
    assert build_source_retirement_items(row, now=now)[0]["status"] == "ready_for_retirement"

    # BYOC Azure retirement revokes ONLY Hussh observer role assignments, NEVER deleting RG/Vault/Storage.
    arm = _RecordingArm()
    scope = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-owner-byoc"
    arm.lists[f"{scope}/providers/Microsoft.Authorization/roleAssignments"] = [
        {
            "id": f"{scope}/providers/Microsoft.Authorization/roleAssignments/hussh-1",
            "properties": {"principalId": "oid-hussh"},
        },
        {
            "id": f"{scope}/providers/Microsoft.Authorization/roleAssignments/owner-1",
            "properties": {"principalId": "oid-owner"},
        },
    ]
    res = _retire_byoc_azure_observer_sync(
        gp=GraceDetachedPlacement(
            placement_id=pid,
            entry=byoc_entry,
            detached_at=byoc_entry["detachedAt"],
            grace_reap_after=reap_past,
            reap_at=now - timedelta(days=1),
            source_target="user_azure",
            source_provider="azure",
            source_kind="byoc",
            source_label="Your Azure",
            resource_hint="rg-owner-byoc",
        ),
        arm_client=arm,  # type: ignore[arg-type]
    )
    assert res["ownerCloudCleanupReady"] is True
    assert all("/providers/Microsoft.Authorization/roleAssignments/" in d[0] for d in arm.deletes)
    assert len(arm.deletes) >= 1

    # Slot recycle refuses if slot is still bound to active primary row.
    with pytest.raises(RuntimeError, match="still bound"):
        _retire_hosted_azure_slot_sync(
            user_id="uid-1",
            row=row,
            gp=GraceDetachedPlacement(
                placement_id="ret_slot",
                entry={
                    "external_agent_id": "/subscriptions/s/resourceGroups/rg/providers/Microsoft.App/containerApps/ca-pod-slot01"
                },
                detached_at="2026-11-01T00:00:00+00:00",
                grace_reap_after=reap_past,
                reap_at=now - timedelta(days=1),
                source_target="azure",
                source_provider="azure",
                source_kind="hussh_pods",
                source_label="Hussh Pods · Microsoft Azure",
                resource_hint="cell-az-eastus2-dev-01",
            ),
            active_external_ids={
                "/subscriptions/s/resourcegroups/rg/providers/microsoft.app/containerapps/ca-pod-slot01"
            },
            arm_client=_RecordingArm(),  # type: ignore[arg-type]
        )


def test_source_retirement_routes_and_startup_worker_fence(monkeypatch: pytest.MonkeyPatch) -> None:
    assert (
        ROUTE_CLASSES[("GET", "/api/one/runtime/byoc/hosted/source-retirement/status")]
        == RouteClass.OPS
    )
    assert (
        ROUTE_CLASSES[("POST", "/api/one/runtime/byoc/hosted/source-retirement/confirm")]
        == RouteClass.OPS
    )

    app = FastAPI()
    app.include_router(runtime_routes.router)
    app.dependency_overrides[require_firebase_auth] = lambda: "uid-owner-test"

    async def _fake_status(user_id: str) -> dict[str, Any]:
        return {
            "environment": "dev",
            "items": [{"placementId": f"ret_{user_id}"}],
            "hasPendingConfirmation": False,
        }

    async def _fake_confirm(user_id: str, *, placement_id: str | None = None) -> dict[str, Any]:
        return {"environment": "dev", "items": [], "confirmedPlacementId": placement_id or user_id}

    monkeypatch.setattr(
        "hushh_mcp.services.source_pod_retirement.get_owner_source_pod_retirement_status",
        _fake_status,
    )
    monkeypatch.setattr(
        "hushh_mcp.services.source_pod_retirement.confirm_owner_source_pod_retirement",
        _fake_confirm,
    )

    client = TestClient(app)
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "uat")
    assert client.get("/api/one/runtime/byoc/hosted/source-retirement/status").status_code == 404
    assert (
        client.post("/api/one/runtime/byoc/hosted/source-retirement/confirm", json={}).status_code
        == 404
    )

    monkeypatch.setenv("ENVIRONMENT", "dev")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    r_status = client.get("/api/one/runtime/byoc/hosted/source-retirement/status")
    assert r_status.status_code == 200
    assert r_status.json()["environment"] == "dev"

    r_confirm = client.post(
        "/api/one/runtime/byoc/hosted/source-retirement/confirm",
        json={"placementId": "ret_abc"},
    )
    assert r_confirm.status_code == 200
    assert r_confirm.json()["confirmedPlacementId"] == "ret_abc"

    async def _exercise_startup() -> None:
        monkeypatch.setattr(server, "pod_mode", lambda: False)
        monkeypatch.setenv("HUSSH_POD_MODE", "0")
        monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "true")
        monkeypatch.setenv("HUSSH_SOURCE_POD_RETIREMENT_SWEEP_ENABLED", "true")
        monkeypatch.setattr(listener_lifecycle, "_STARTUP_BACKGROUND_TASKS", set())
        await server.startup_source_pod_retirement_worker()
        tasks = list(listener_lifecycle._STARTUP_BACKGROUND_TASKS)
        assert [t.get_name() for t in tasks] == ["source-pod-retirement"]
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

        monkeypatch.setattr(server, "pod_mode", lambda: True)
        monkeypatch.setenv("HUSSH_POD_MODE", "1")
        monkeypatch.setattr(listener_lifecycle, "_STARTUP_BACKGROUND_TASKS", set())
        await server.startup_source_pod_retirement_worker()
        assert not listener_lifecycle._STARTUP_BACKGROUND_TASKS

    asyncio.run(_exercise_startup())
