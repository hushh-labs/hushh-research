# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Real PostgreSQL constraint-trigger & sweeper tests for 14-day source-pod retirement."""

from __future__ import annotations

import copy
import json
from datetime import datetime, timedelta, timezone
from typing import Any

import psycopg2
import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import DatabaseError

from hushh_mcp.services.compute_backend import BACKEND_AZURE
from hushh_mcp.services.pod_umbrella_cell_pool import (
    PodSkeletonPoolService,
    SkeletonSlotConfig,
    UmbrellaCellConfig,
    UmbrellaCellRegistry,
)
from hushh_mcp.services.source_pod_retirement import (
    SourcePodRetirementSweeper,
    compute_placement_id,
    confirm_owner_source_pod_retirement,
)
from tests.test_data_model_audit_postgres import (
    isolated_postgres as isolated_postgres,  # noqa: F401
)


class _PgDbAdapter:
    def __init__(self, engine: Any) -> None:
        self.engine = engine


class _FakeArm:
    def __init__(
        self,
        existing_apps: dict[str, dict[str, Any]],
        role_assignments: dict[str, list[dict[str, Any]]],
    ) -> None:
        self.existing_apps = existing_apps
        self.role_assignments = role_assignments
        self.puts: list[tuple[str, dict[str, Any]]] = []
        self.deletes: list[str] = []

    def get_or_none(self, path: str, *, api_version: str, op: str = "") -> dict[str, Any] | None:
        del api_version, op
        if path in self.existing_apps:
            return self.existing_apps[path]
        if path in self.role_assignments:
            return {"value": list(self.role_assignments[path])}
        return None

    def put(
        self, path: str, *, api_version: str, body: dict[str, Any], op: str = ""
    ) -> dict[str, Any]:
        del api_version, op
        self.puts.append((path, body))
        return {"properties": {"provisioningState": "Succeeded"}}

    def delete(self, path: str, *, api_version: str, op: str = "") -> bool:
        del api_version, op
        self.deletes.append(path)
        return True


def _install_registry_and_retention_trigger(conn: Any) -> None:
    conn.execute(
        text(
            """
            CREATE TABLE public.personal_agent_registry (
                user_id text NOT NULL,
                hushh_id text NOT NULL,
                backend text,
                external_agent_id text,
                a2a_route text,
                backend_metadata jsonb,
                pod_pubkey text,
                pod_key_id text,
                pod_key_wrapping_alg text,
                runtime_version text,
                prompt_version text,
                status text NOT NULL,
                region text,
                model_credential_mode text,
                user_cloud_project text,
                user_cloud_region text,
                user_cloud_bootstrap_sa text,
                user_cloud_authorized_at timestamptz,
                pod_signing_pubkey text,
                pod_signing_key_id text,
                user_cloud_tenant_id text,
                user_cloud_subscription_id text,
                user_cloud_resource_group text,
                deployment_target text,
                placement_epoch bigint DEFAULT 0,
                updated_at timestamptz DEFAULT now()
            );
            CREATE OR REPLACE FUNCTION public.guard_test_detached_immutability()
            RETURNS trigger LANGUAGE plpgsql AS $$
            DECLARE detached jsonb; current_metadata jsonb;
            BEGIN
              SELECT backend_metadata INTO current_metadata
              FROM public.personal_agent_registry
              WHERE user_id = OLD.user_id AND hushh_id = OLD.hushh_id;
              FOR detached IN SELECT value FROM jsonb_array_elements(coalesce(OLD.backend_metadata->'detachedPlacements', '[]'::jsonb)) LOOP
                IF detached->'backend_metadata'->'notificationCheckpoint' IS NOT NULL
                   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(current_metadata->'detachedPlacements', '[]'::jsonb)) item WHERE item = detached) THEN
                  RAISE EXCEPTION 'notification checkpoint detached custody not retained' USING ERRCODE = '42501';
                END IF;
              END LOOP;
              RETURN NEW;
            END;
            $$;
            CREATE CONSTRAINT TRIGGER zz_personal_agent_notification_retention
            AFTER UPDATE OR DELETE ON public.personal_agent_registry
            DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.guard_test_detached_immutability();
            """
        )
    )


@pytest.mark.asyncio
async def test_postgres_two_key_retirement_preserves_detached_custody_and_founder_hold(
    isolated_postgres: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ENVIRONMENT", "dev")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "true")
    monkeypatch.setenv("HUSSH_SOURCE_POD_RETIREMENT_SWEEP_ENABLED", "true")
    monkeypatch.setenv("HUSSH_POD_MODE", "0")

    t0 = datetime(2026, 11, 18, 0, 0, tzinfo=timezone.utc)
    past_grace = (t0 - timedelta(hours=2)).isoformat()
    future_grace = (t0 + timedelta(days=13)).isoformat()

    founder_hold = {
        "detachedAt": "2026-11-01T00:00:00+00:00",
        "backend": "user_gcp",
        "deployment_target": "user_gcp",
        "user_cloud_project": "founder-keep",
        "backend_metadata": {"notificationCheckpoint": {"phase": "observed"}},
    }
    pre_grace_byoc = {
        "detachedAt": "2026-11-17T08:00:00+00:00",
        "backend": "user_azure",
        "deployment_target": "user_azure",
        "user_cloud_tenant_id": "11111111-1111-1111-1111-111111111111",
        "user_cloud_subscription_id": "22222222-2222-2222-2222-222222222222",
        "user_cloud_resource_group": "rg-owner-hold",
        "graceDays": 14,
        "graceReapAfter": future_grace,
        "backend_metadata": {"notificationCheckpoint": {"phase": "observed"}},
    }
    expired_hosted_azure = {
        "detachedAt": "2026-11-03T00:00:00+00:00",
        "backend": "azure",
        "deployment_target": "azure",
        "external_agent_id": (
            "/subscriptions/3f5a1e87-97d6-4f05-b4ce-0e2cc675e118/resourceGroups/"
            "rg-hussh-cell-dev-eastus2-01/providers/Microsoft.App/containerApps/ca-pod-slot02"
        ),
        "graceDays": 14,
        "graceReapAfter": past_grace,
        "backend_metadata": {
            "cellId": "cell-az-eastus2-dev-01",
            "notificationCheckpoint": {"phase": "observed"},
        },
    }
    expired_hosted_gcp = {
        "detachedAt": "2026-11-02T00:00:00+00:00",
        "backend": "gcp",
        "deployment_target": "gcp",
        "external_agent_id": "pod-old-gcp-123",
        "user_cloud_project": "hushh-pda-dev",
        "user_cloud_region": "us-central1",
        "graceDays": 14,
        "graceReapAfter": past_grace,
        "backend_metadata": {"notificationCheckpoint": {"phase": "observed"}},
    }

    pid_pre_byoc = compute_placement_id(pre_grace_byoc)
    pid_exp_az = compute_placement_id(expired_hosted_azure)
    pid_exp_gcp = compute_placement_id(expired_hosted_gcp)

    initial_detached = [founder_hold, pre_grace_byoc, expired_hosted_azure, expired_hosted_gcp]
    engine = create_engine(
        "postgresql+psycopg2://", creator=lambda: psycopg2.connect(isolated_postgres)
    )
    try:
        with engine.begin() as conn:
            _install_registry_and_retention_trigger(conn)
            conn.execute(
                text(
                    """
                    INSERT INTO public.personal_agent_registry (
                        user_id, hushh_id, backend, external_agent_id, a2a_route,
                        backend_metadata, status, deployment_target, placement_epoch
                    ) VALUES (
                        'uid-pg-retire', 'ha1_pg_retire', 'azure',
                        '/subscriptions/3f5a1e87-97d6-4f05-b4ce-0e2cc675e118/resourceGroups/rg-hussh-cell-dev-eastus2-01/providers/Microsoft.App/containerApps/ca-pod-slot01',
                        'https://ca-pod-slot01.example.azurecontainerapps.io',
                        CAST(:meta AS jsonb), 'provisioned', 'azure', 5
                    )
                    """
                ),
                {"meta": json.dumps({"detachedPlacements": initial_detached})},
            )

        db = _PgDbAdapter(engine)
        # Key #1 alone (expired_hosted_gcp is past grace, NOT confirmed) -> must NOT retire.
        # Confirm ONLY expired_hosted_azure and pre_grace_byoc via real SQL path.
        await confirm_owner_source_pod_retirement(
            "uid-pg-retire", placement_id=pid_pre_byoc, db=db, now=t0
        )
        res_exp = await confirm_owner_source_pod_retirement(
            "uid-pg-retire", placement_id=pid_exp_az, db=db, now=t0
        )
        items_by_id = {it["placementId"]: it for it in res_exp["items"]}
        assert items_by_id[pid_pre_byoc]["status"] == "owner_confirmed"
        assert items_by_id[pid_exp_az]["status"] == "ready_for_retirement"
        assert items_by_id[pid_exp_gcp]["status"] == "awaiting_owner_confirmation"

        cell = UmbrellaCellConfig(
            cell_id="cell-az-eastus2-dev-01",
            provider=BACKEND_AZURE,
            organization="HushOne Inc.",
            soft_watermark=40,
            hard_watermark=50,
            min_warm_skeletons=2,
            max_warm_skeletons=2,
            replenish_batch_size=1,
            tenant_id="e1e09f9b-313b-4c57-a925-f2a573a919e9",
            subscription_id="3f5a1e87-97d6-4f05-b4ce-0e2cc675e118",
            resource_group="rg-hussh-cell-dev-eastus2-01",
            shared_resource_group="rg-hussh-cell-dev-eastus2-01",
            location="eastus2",
            environment_name="cae-hussh-cell-dev-eus2-01",
            environment_id="/subscriptions/3f5a1e87-97d6-4f05-b4ce-0e2cc675e118/resourceGroups/rg-hussh-cell-dev-eastus2-01/providers/Microsoft.App/managedEnvironments/cae-hussh-cell-dev-eus2-01",
            registry_server="crhusshcelldeveus201.azurecr.io",
            storage_account="sthusshcelldeveus201",
            key_vault_name="kv-h1-celldeveus201",
            openai_endpoint="https://oai-hussh-cell-dev-eus2-01.openai.azure.com/",
            openai_deployment="one-chat",
            controller_client_id="815df3ec-c8c4-4df3-a01a-f611dd6eb3c4",
            image_digest="sha256:" + ("a" * 64),
            slots=(
                SkeletonSlotConfig(
                    slot_id="slot02",
                    app_name="ca-pod-slot02",
                    app_id=expired_hosted_azure["external_agent_id"],
                    fqdn="ca-pod-slot02.example.azurecontainerapps.io",
                    identity_id="/subscriptions/3f5a1e87-97d6-4f05-b4ce-0e2cc675e118/resourceGroups/rg-hussh-cell-dev-eastus2-01/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-pod-slot02",
                    identity_client_id="00000000-0000-4000-8000-000000000002",
                    identity_principal_id="11111111-1111-4000-8000-000000000002",
                    blob_url="https://sthusshcelldeveus201.blob.core.windows.net/pod-slot02",
                    key_vault_key="https://kv-h1-celldeveus201.vault.azure.net/keys/pod-log-key-slot02/v1",
                    signing_secret_url="https://kv-h1-celldeveus201.vault.azure.net/secrets/pod-signing-key-slot02",  # noqa: S106
                ),
            ),
        )
        registry = UmbrellaCellRegistry({"environment": "dev", "cells": []})
        registry.upsert_cells([cell])
        pool = PodSkeletonPoolService(registry=registry)
        fake_arm = _FakeArm(
            existing_apps={expired_hosted_azure["external_agent_id"]: {"tags": {}}},
            role_assignments={},
        )
        deleted_gcp: list[str] = []

        sweeper = SourcePodRetirementSweeper(
            db=db,
            pool=pool,
            arm_client=fake_arm,  # type: ignore[arg-type]
            gcp_hosted_retirer=lambda _u, gp, _a: (
                deleted_gcp.append(gp.placement_id) or {"status": "retired_hussh_hosted_gcp"}
            ),
            clock=lambda: t0,
        )
        report = await sweeper.sweep_once()
        # Only expired_hosted_azure had BOTH ownerConfirmed AND graceExpired.
        assert report.retired_ids == (pid_exp_az,)
        assert deleted_gcp == []
        assert len(fake_arm.puts) == 1
        assert fake_arm.puts[0][0] == expired_hosted_azure["external_agent_id"]

        # Verify DB detachedPlacements remained byte-for-byte identical across all operations.
        with engine.connect() as conn:
            stored_meta = conn.execute(
                text(
                    "SELECT backend_metadata FROM public.personal_agent_registry WHERE user_id = 'uid-pg-retire'"
                )
            ).scalar_one()
        assert stored_meta["detachedPlacements"] == copy.deepcopy(initial_detached)
        assert (
            stored_meta["sourcePodRetirements"][pid_exp_az]["status"]
            == "retired_hussh_hosted_azure_slot"
        )
        assert pid_pre_byoc in stored_meta["sourcePodRetirements"]
        assert stored_meta["sourcePodRetirements"][pid_pre_byoc].get("status") == "owner_confirmed"

        # Negative check: prove the installed trigger genuinely catches detachedPlacements mutation!
        with pytest.raises(DatabaseError):
            with engine.begin() as conn:
                conn.execute(
                    text(
                        "UPDATE public.personal_agent_registry "
                        "SET backend_metadata = jsonb_set(backend_metadata, '{detachedPlacements}', '[]'::jsonb) "
                        "WHERE user_id = 'uid-pg-retire'"
                    )
                )
    finally:
        engine.dispose()
