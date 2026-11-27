# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Lifecycle regression tests for Pooled Confidential Sandbox (ACE) deletion and BYOC switching."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import pytest
from fastapi import HTTPException

from api.routes.one.pod_prefix_storage_gateway import set_storage_gateway_overrides_for_tests
from api.routes.one.runtime_placement import _require_unassigned_byoc
from hushh_mcp.services.account_personal_agent_erasure import (
    PersonalAgentDeprovisioningRequiredError,
    assert_external_resources_absent,
    collect_pooled_ace_hushh_ids,
    is_pure_pooled_ace_registry_state,
    purge_pooled_ace_storage_prefixes_best_effort,
)
from hushh_mcp.services.pod_commit_log import LocalObjectStore


def _ace_registry_row(
    user_id: str = "owner_ace_1",
    hushh_id: str = "ha1_7o6wt3s4mtydneyytqfswsxtafdlpjwz",
    *,
    extra_meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    owner_hash = "sha256:" + hashlib.sha256(user_id.encode("utf-8")).hexdigest()
    pod_url = f"https://sandbox-edge-gateway.example.run.app/u/{hushh_id}"
    meta: dict[str, Any] = {
        "tenancy": "hussh-hosted",
        "pool": "agent_sandbox_warm_pool",
        "service": "sandbox-edge-gateway",
        "serviceUid": f"ace-pool-{hushh_id}",
        "url": pod_url,
        "ingress": "direct",
        "ready": True,
        "hostedAceAdmission": {
            "version": 1,
            "environment": "dev",
            "ownerId": user_id,
            "ownerHash": owner_hash,
            "hushhId": hushh_id,
            "url": pod_url,
        },
    }
    if extra_meta:
        meta.update(extra_meta)
    return {
        "user_id": user_id,
        "hushh_id": hushh_id,
        "status": "provisioned",
        "external_agent_id": f"ace-pool:{hushh_id}",
        "a2a_route": pod_url,
        "backend": "ace",
        "deployment_target": "ace",
        "pod_pubkey": "A" * 43 + "=",
        "pod_key_id": "podk_" + ("0" * 32),
        "pod_key_wrapping_alg": "-".join(("x25519", "hkdf", "aes256gcm")),
        "provisioned_at": "2026-11-23T00:00:00Z",
        "updated_at": "2026-11-23T00:00:00Z",
        "user_cloud_project": None,
        "user_cloud_region": None,
        "user_cloud_bootstrap_sa": None,
        "user_cloud_authorized_at": None,
        "user_cloud_tenant_id": None,
        "user_cloud_subscription_id": None,
        "user_cloud_resource_group": None,
        "backend_metadata": meta,
    }


def test_pure_pooled_ace_allows_account_deletion_without_external_deprovision(monkeypatch) -> None:
    monkeypatch.setattr(
        "hushh_mcp.services.phone_transfer_service.assert_erasure_ready",
        lambda *_args, **_kwargs: None,
    )
    row = _ace_registry_row()
    assert is_pure_pooled_ace_registry_state(row) is True

    monkeypatch.setattr(
        "hushh_mcp.services.account_personal_agent_erasure._read_locked_state",
        lambda _conn, _params, _te: (
            {
                "byoc_setup_jobs": True,
                "pod_lifecycle_events": True,
                "personal_agent_registry": True,
                "pod_migration_jobs": True,
            },
            {"registry": row},
            None,
            {"present": True},
            None,
        ),
    )
    monkeypatch.setattr(
        "hushh_mcp.services.account_personal_agent_erasure._pending_deprovision",
        lambda *_args, **_kwargs: False,
    )
    monkeypatch.setattr(
        "hushh_mcp.services.account_personal_agent_erasure.standby_present",
        lambda *_args, **_kwargs: False,
    )

    presence = assert_external_resources_absent(
        object(), params={"user_id": "owner_ace_1"}, table_exists=lambda *_a: False
    )
    assert presence["personal_agent_registry"] is True


def test_detached_ace_only_with_untouched_byoc_intent_still_allows_account_deletion(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "hushh_mcp.services.phone_transfer_service.assert_erasure_ready",
        lambda *_args, **_kwargs: None,
    )
    prior_ace = _ace_registry_row()
    detached_row = {
        "user_id": "owner_ace_1",
        "hushh_id": prior_ace["hushh_id"],
        "status": "unprovisioned",
        "external_agent_id": None,
        "a2a_route": None,
        "backend": None,
        "deployment_target": None,
        "pod_pubkey": None,
        "pod_key_id": None,
        "pod_key_wrapping_alg": None,
        "region": None,
        "provisioned_at": None,
        "user_cloud_project": None,
        "user_cloud_region": None,
        "user_cloud_bootstrap_sa": None,
        "user_cloud_authorized_at": None,
        "backend_metadata": {"detachedPlacements": [prior_ace]},
    }
    untouched_intent_job = {
        "project_id": "",
        "status": "pending",
        "stage": "consent_pending",
        "stages": [{"stage": "consent_pending", "provider": "gcp", "project": "my-proj"}],
        "authorization_attempts": {},
    }
    monkeypatch.setattr(
        "hushh_mcp.services.account_personal_agent_erasure._read_locked_state",
        lambda _conn, _params, _te: (
            {
                "byoc_setup_jobs": True,
                "pod_lifecycle_events": True,
                "personal_agent_registry": True,
                "pod_migration_jobs": True,
            },
            {"registry": detached_row},
            {"job": untouched_intent_job},
            {"present": True},
            None,
        ),
    )
    monkeypatch.setattr(
        "hushh_mcp.services.account_personal_agent_erasure._pending_deprovision",
        lambda *_args, **_kwargs: False,
    )
    monkeypatch.setattr(
        "hushh_mcp.services.account_personal_agent_erasure.standby_present",
        lambda *_args, **_kwargs: False,
    )

    presence = assert_external_resources_absent(
        object(), params={"user_id": "owner_ace_1"}, table_exists=lambda *_a: False
    )
    assert presence["personal_agent_registry"] is True
    assert collect_pooled_ace_hushh_ids(detached_row) == [prior_ace["hushh_id"]]


def test_byoc_or_unretired_source_pod_still_blocks_account_deletion(monkeypatch) -> None:
    monkeypatch.setattr(
        "hushh_mcp.services.phone_transfer_service.assert_erasure_ready",
        lambda *_args, **_kwargs: None,
    )
    ace_with_unretired_cloud = _ace_registry_row(
        extra_meta={
            "sourcePodRetirements": {
                "ret_1": {"sourceTarget": "user_gcp", "status": "awaiting_owner_confirmation"}
            }
        }
    )
    assert is_pure_pooled_ace_registry_state(ace_with_unretired_cloud) is False

    monkeypatch.setattr(
        "hushh_mcp.services.account_personal_agent_erasure._read_locked_state",
        lambda _conn, _params, _te: (
            {
                "byoc_setup_jobs": True,
                "pod_lifecycle_events": False,
                "personal_agent_registry": True,
                "pod_migration_jobs": False,
            },
            {"registry": ace_with_unretired_cloud},
            None,
            None,
            None,
        ),
    )
    monkeypatch.setattr(
        "hushh_mcp.services.account_personal_agent_erasure._pending_deprovision",
        lambda *_args, **_kwargs: False,
    )
    monkeypatch.setattr(
        "hushh_mcp.services.account_personal_agent_erasure.standby_present",
        lambda *_args, **_kwargs: False,
    )
    with pytest.raises(PersonalAgentDeprovisioningRequiredError):
        assert_external_resources_absent(
            object(), params={"user_id": "owner_ace_1"}, table_exists=lambda *_a: False
        )


@pytest.mark.asyncio
async def test_purge_pooled_ace_storage_prefixes_deletes_only_target_owner(tmp_path: Path) -> None:
    store = LocalObjectStore(tmp_path)
    hid_a = "ha1_7o6wt3s4mtydneyytqfswsxtafdlpjwz"
    hid_b = "ha1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    await store.put(f"pods/{hid_a}/files/doc.enc", b"cipher-a")
    await store.put(f"pods/{hid_a}/wiki/index.enc", b"wiki-a")
    await store.put(f"pods/{hid_b}/files/keep.enc", b"cipher-b")
    set_storage_gateway_overrides_for_tests(store_factory=lambda: store)
    try:
        removed = await purge_pooled_ace_storage_prefixes_best_effort([hid_a])
        assert removed == 2
        assert await store.get(f"pods/{hid_a}/files/doc.enc") is None
        assert await store.get(f"pods/{hid_a}/wiki/index.enc") is None
        assert await store.get(f"pods/{hid_b}/files/keep.enc") == b"cipher-b"
    finally:
        set_storage_gateway_overrides_for_tests()


@pytest.mark.asyncio
async def test_require_unassigned_byoc_detaches_pooled_ace_and_preserves_byoc_pods(
    monkeypatch,
) -> None:
    monkeypatch.setattr("hushh_mcp.runtime_settings.personal_agent_enabled", lambda: True)
    monkeypatch.setattr(
        "hushh_mcp.services.pooled_sandbox_cutover.sandbox_pool_cutover_enabled", lambda: True
    )

    ace_row = _ace_registry_row("owner_ace_byoc")
    state: dict[str, dict[str, Any] | None] = {"row": ace_row}

    class _FakeRepo:
        async def get(self, _uid: str):
            return state["row"]

    async def _fake_detach(*, row: dict, reason: str, allow_stalled_states: bool = False):
        assert row["deployment_target"] == "ace"
        assert "Bring your own cloud" in reason
        assert allow_stalled_states is True
        state["row"] = {
            **row,
            "status": "unprovisioned",
            "external_agent_id": None,
            "deployment_target": None,
            "backend": None,
        }
        return {"user_id": row["user_id"], "detached_count": 1}

    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_registry_repo.PersonalAgentRegistryRepo", _FakeRepo
    )
    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_placement_detach.detach_placement", _fake_detach
    )

    await _require_unassigned_byoc("owner_ace_byoc")
    assert state["row"] is not None
    assert state["row"]["external_agent_id"] is None

    state["row"] = {
        **ace_row,
        "deployment_target": "user_gcp",
        "backend": "gcp",
        "external_agent_id": "pod-user-gcp",
    }
    with pytest.raises(HTTPException) as exc_info:
        await _require_unassigned_byoc("owner_ace_byoc")
    assert exc_info.value.status_code == 409
    assert exc_info.value.detail["code"] == "POD_ASSIGNMENT_PRESERVED"
