# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Unit & contract tests for Pooled Personal Sandbox placement and silent cutover (#9744)."""

from __future__ import annotations

import copy
from typing import Any

import pytest
from fastapi import HTTPException

from api.routes.one import personal_agent, runtime
from hushh_mcp.services.agent_sandbox.edge_gateway_app import derive_owner_pod_identity
from hushh_mcp.services.compute_backend_resolution import private_pod_row
from hushh_mcp.services.hosted_ace_placement import (
    direct_ace_admission_snapshot,
    has_hosted_ace_evidence,
    retained_hosted_ace_placement,
)
from hushh_mcp.services.personal_agent_direct_admission import direct_owner_matches
from hushh_mcp.services.personal_agent_hosting import (
    resolve_hosting_mode,
    setup_job_superseded_by_detach,
)
from hushh_mcp.services.personal_agent_placement_detach import plan_detach
from hushh_mcp.services.pod_binding_contract import (
    make_pod_binding,
    verify_binding_capabilities,
)
from hushh_mcp.services.pooled_sandbox_cutover import (
    _OWNER_CLOUD_COLUMNS,
    adopt_pooled_sandbox_for_owner,
    derive_pooled_owner_public_keys,
    ensure_pooled_sandbox_placement,
    mint_pooled_hushh_id,
    sandbox_pool_cutover_enabled,
)

_SEED = "unit-test-sandbox-master-seed-32-bytes-minimum"
_EDGE_URL = "https://sandbox-edge.dev.one.hussh.ai"


class _FakeRegistry:
    def __init__(
        self,
        initial: dict[str, dict[str, Any]] | None = None,
        *,
        tombstoned: set[str] | None = None,
    ):
        self.rows: dict[str, dict[str, Any]] = copy.deepcopy(initial or {})
        self.tombstoned = set(tombstoned or set())
        self.upserts: list[dict[str, Any]] = []

    async def get(self, user_id: str) -> dict[str, Any] | None:
        row = self.rows.get(user_id)
        return copy.deepcopy(row) if row is not None else None

    async def tombstone_exists(self, user_id: str) -> bool:
        return user_id in self.tombstoned

    async def upsert(self, **kwargs: Any) -> None:
        self.upserts.append(copy.deepcopy(kwargs))
        uid = kwargs["user_id"]
        existing = self.rows.get(uid, {"user_id": uid})
        merged = {**existing, **{k: v for k, v in kwargs.items() if v is not None}}
        self.rows[uid] = merged


class _FakeJobs:
    def __init__(self, jobs: dict[str, dict[str, Any]] | None = None) -> None:
        self.jobs = jobs or {}

    async def _current(self, user_id: str) -> dict[str, Any] | None:
        return copy.deepcopy(self.jobs.get(user_id))


class _FakeGrants:
    def __init__(self) -> None:
        self.issued: list[str] = []

    async def issue_or_reuse_standing_pkm_read(self, user_id: str) -> dict[str, Any]:
        self.issued.append(user_id)
        return {"token_id": f"tok-{user_id}", "token": "consent-jwt"}


class _FakeMigrationJobs:
    def __init__(self, jobs: dict[str, dict[str, Any]] | None = None) -> None:
        self.jobs = jobs or {}

    async def get(self, user_id: str) -> dict[str, Any] | None:
        return copy.deepcopy(self.jobs.get(user_id))


class _FakeIdentityService:
    def __init__(self, identities: dict[str, dict[str, Any]] | None = None) -> None:
        self.identities = identities or {}

    async def get_many(self, user_ids: list[str]) -> dict[str, dict[str, Any]]:
        return {uid: copy.deepcopy(self.identities.get(uid, {})) for uid in user_ids}


def _make_fake_detach(reg: _FakeRegistry):
    async def _detach(
        *, row: dict[str, Any], reason: str, db: Any = None, allow_stalled_states: bool = False
    ) -> dict[str, Any] | None:
        del db
        plan = plan_detach(row, allow_stalled_states=allow_stalled_states)
        if plan is None or plan.refusal:
            raise ValueError(plan.refusal if plan else "no agent record")
        uid = str(row["user_id"])
        stored = reg.rows.get(uid)
        if stored is None or stored.get("external_agent_id") != row.get("external_agent_id"):
            return None
        prev_meta = copy.deepcopy(stored.get("backend_metadata") or {})
        prior_detached = list(prev_meta.get("detachedPlacements") or [])
        snapshot = {
            **{k: v for k, v in copy.deepcopy(stored).items() if k != "backend_metadata"},
            "backend_metadata": {k: v for k, v in prev_meta.items() if k != "detachedPlacements"},
            "detachedAt": "2026-11-19T00:00:00Z",
            "reason": reason,
        }
        prior_detached.append(snapshot)
        updated = copy.deepcopy(stored)
        updated["status"] = "unprovisioned"
        updated["backend"] = None
        updated["external_agent_id"] = None
        updated["deployment_target"] = None
        updated["model_credential_mode"] = None
        updated["pod_pubkey"] = None
        updated["pod_key_id"] = None
        updated["pod_key_wrapping_alg"] = None
        for col in _OWNER_CLOUD_COLUMNS:
            updated[col] = None
        updated["backend_metadata"] = {"detachedPlacements": prior_detached}
        reg.rows[uid] = updated
        return {"user_id": uid, "detached_count": len(prior_detached)}

    return _detach


def _enable_cutover(monkeypatch: pytest.MonkeyPatch, *, enabled: bool = True) -> None:
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    monkeypatch.setenv("HUSSH_AGENT_SANDBOX_CUTOVER_ENABLED", "1" if enabled else "0")
    monkeypatch.setenv("HUSSH_SANDBOX_EDGE_PUBLIC_URL", _EDGE_URL)
    monkeypatch.setenv("HUSSH_SANDBOX_IDENTITY_MASTER_KEY", _SEED)


async def test_unplaced_new_signup_places_onto_ace_pooled_sandbox_with_exact_keys(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _enable_cutover(monkeypatch)
    assert sandbox_pool_cutover_enabled() is True

    reg = _FakeRegistry()
    jobs = _FakeJobs()
    grants = _FakeGrants()

    row = await ensure_pooled_sandbox_placement(
        user_id="uid-new-01",
        registry=reg,
        job_repo=jobs,
        grant_service=grants,
    )
    assert row is not None
    assert grants.issued == ["uid-new-01"]
    assert row["deployment_target"] == "ace"
    assert row["backend"] == "ace"
    assert row["status"] == "provisioned"
    assert row["liveness_mode"] == "economy"
    assert row["model_credential_mode"] == "byok_per_turn"

    hushh_id = row["hushh_id"]
    assert hushh_id == mint_pooled_hushh_id("uid-new-01")
    expected_url = f"{_EDGE_URL}/u/{hushh_id}"
    assert row["a2a_route"] == expected_url
    assert row["backend_metadata"]["url"] == expected_url

    # Edge Gateway's private key derivation matches Hub's registered public & signing keys 1:1.
    _priv_b64, edge_pub, edge_kid = derive_owner_pod_identity(_SEED.encode("utf-8"), hushh_id)
    keys = derive_pooled_owner_public_keys(_SEED.encode("utf-8"), hushh_id)
    assert row["pod_pubkey"] == edge_pub == keys["pod_pubkey"]
    assert row["pod_key_id"] == edge_kid == keys["pod_key_id"]
    assert row["pod_signing_pubkey"].endswith("=") and len(row["pod_signing_pubkey"]) == 44
    assert row["pod_signing_key_id"].startswith("pods_") and len(row["pod_signing_key_id"]) == 37

    # Placement validators, direct ingress matcher, and PodBindingV1 verifier all accept ACE row.
    assert has_hosted_ace_evidence(row) is True
    assert retained_hosted_ace_placement(row) is not None
    assert direct_ace_admission_snapshot(row) is not None
    assert private_pod_row(row) is True
    assert (
        resolve_hosting_mode(
            row=row,
            registry_read_ok=True,
            setup_job=None,
            setup_job_read_ok=True,
        )
        == "hussh_pods"
    )
    assert (
        direct_owner_matches(
            row,
            hushh_id=hushh_id,
            pod_key_id=row["pod_key_id"],
            pod_public_key=row["pod_pubkey"],
            service_uid=row["backend_metadata"]["serviceUid"],
            url=expected_url,
        )
        is True
    )
    binding = make_pod_binding(
        row=row,
        user_id="uid-new-01",
        device_id="dev-web-1",
        device={"platform": "web", "public_key": "pub-dev-1"},
        role="app",
        scopes=("pod.session.app",),
        environment="dev",
        ttl_ms=300_000,
        version=1,
        now_ms=1_000_000.0,
    )
    assert binding.deployment_target == "ace"
    assert binding.hosting_mode is None
    verify_binding_capabilities(binding, now_ms=1_001_000.0)

    # Re-running is a zero-upsert no-op once placed.
    second = await ensure_pooled_sandbox_placement(
        user_id="uid-new-01",
        registry=reg,
        job_repo=jobs,
        grant_service=grants,
    )
    assert second == row
    assert len(reg.upserts) == 1


async def test_legacy_shared_user_silently_cuts_over_and_preserves_puppy_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _enable_cutover(monkeypatch)
    reg = _FakeRegistry(
        {
            "uid-shared": {
                "user_id": "uid-shared",
                "hushh_id": "ha1_existing_shared_01",
                "billing_space_id": "hs_existing_01",
                "phone_e164_hash": "a" * 64,
                "status": "pending",
                "backend": None,
                "deployment_target": None,
                "backend_metadata": {"puppyAccess": {"dev-mac": {"approved": True}}},
            }
        }
    )
    row = await ensure_pooled_sandbox_placement(
        user_id="uid-shared", registry=reg, job_repo=_FakeJobs(), grant_service=_FakeGrants()
    )
    assert row is not None
    assert row["hushh_id"] == "ha1_existing_shared_01"
    assert row["deployment_target"] == "ace"
    assert row["backend_metadata"]["puppyAccess"] == {"dev-mac": {"approved": True}}


async def test_byoc_and_fenced_parth_byoc_jobs_are_never_overwritten(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _enable_cutover(monkeypatch)
    byoc_row = {
        "user_id": "uid-byoc",
        "hushh_id": "ha1_byoc_1",
        "deployment_target": "user_azure",
        "backend": "user_azure",
        "status": "provisioned",
        "backend_metadata": {},
    }
    fenced_parth_row = {
        "user_id": "tXCB0PdAavU01iSd4PenXKca7jI2",
        "hushh_id": "ha1_sxb3nucsi5wbyopdghwlgsa7nqygue2o",
        "backend": None,
        "deployment_target": None,
        "status": "pending",
        "backend_metadata": {},
    }
    reg = _FakeRegistry({"uid-byoc": byoc_row, "tXCB0PdAavU01iSd4PenXKca7jI2": fenced_parth_row})
    jobs = _FakeJobs(
        {
            "tXCB0PdAavU01iSd4PenXKca7jI2": {
                "user_id": "tXCB0PdAavU01iSd4PenXKca7jI2",
                "status": "failed",
                "stages": [
                    {"stage": "azure_worker_started", "jobId": "dd006ca2"},
                    {"stage": "azure_setup_prior_intent", "intent": {"version": 1}},
                    {"stage": "azure_provider_request", "purpose": "creating_identity"},
                ],
            }
        }
    )
    grants = _FakeGrants()

    assert (
        await ensure_pooled_sandbox_placement(
            user_id="uid-byoc", registry=reg, job_repo=jobs, grant_service=grants
        )
    ) == byoc_row
    assert (
        await ensure_pooled_sandbox_placement(
            user_id="tXCB0PdAavU01iSd4PenXKca7jI2",
            registry=reg,
            job_repo=jobs,
            grant_service=grants,
        )
    ) == fenced_parth_row
    assert reg.upserts == []
    assert grants.issued == []


async def test_select_shared_hosting_is_idempotent_on_pooled_cutover_and_preserves_409_when_off(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    marked: list[str] = []

    async def _hussh_status(*, user_id: str) -> dict[str, Any]:
        return {"hostingMode": "hussh_pods"}

    async def _mark(user_id: str) -> None:
        marked.append(user_id)

    async def _no_intent(_user_id: str) -> bool:
        return False

    monkeypatch.setattr(personal_agent, "resolve_personal_agent_status", _hussh_status)
    monkeypatch.setattr(runtime, "_write_cloud_setup_marker", _mark)
    monkeypatch.setattr("hushh_mcp.services.byoc_setup_intent.clear_intent", _no_intent)

    _enable_cutover(monkeypatch, enabled=False)
    with pytest.raises(HTTPException) as exc:
        await runtime.select_shared_hosting.__wrapped__(request=None, firebase_uid="u-off")  # type: ignore[attr-defined]
    assert exc.value.status_code == 409

    _enable_cutover(monkeypatch, enabled=True)
    resp = await runtime.select_shared_hosting.__wrapped__(request=None, firebase_uid="u-on")  # type: ignore[attr-defined]
    assert resp.hostingMode == "shared"
    assert marked == ["u-on"]


def _assert_clean_ace_row(row: dict[str, Any]) -> None:
    assert row["deployment_target"] == "ace"
    assert row["backend"] == "ace"
    assert row["status"] == "provisioned"
    for col in _OWNER_CLOUD_COLUMNS:
        assert row.get(col) is None, f"expected {col} to be None on ACE row"
    assert has_hosted_ace_evidence(row) is True
    assert retained_hosted_ace_placement(row) is not None


async def test_adopt_pooled_sandbox_switches_azure_migrating_hosted_and_unassigned_to_ace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _enable_cutover(monkeypatch)
    sub_id = "22222222-2222-2222-2222-222222222222"
    tenant_id = "11111111-1111-1111-1111-111111111111"
    reg = _FakeRegistry(
        {
            "uid-az-migrating": {
                "user_id": "uid-az-migrating",
                "hushh_id": "ha1_az_migrating",
                "status": "migrating",
                "deployment_target": "user_azure",
                "backend": "user_azure",
                "external_agent_id": "/subscriptions/sub/resourceGroups/rg/containerApps/pod",
                "user_cloud_tenant_id": tenant_id,
                "user_cloud_subscription_id": sub_id,
                "user_cloud_resource_group": "rg-hussh-one-abc",
                "user_cloud_region": "eastus2",
                "updated_at": "2026-11-18T00:00:00Z",
                "backend_metadata": {
                    "url": "https://old-azure.example.test",
                    "tenantId": tenant_id,
                    "subscriptionId": sub_id,
                    "resourceGroup": "rg-hussh-one-abc",
                },
            },
            "uid-az-hosted": {
                "user_id": "uid-az-hosted",
                "hushh_id": "ha1_az_hosted",
                "status": "provisioned",
                "deployment_target": "azure",
                "backend": "azure",
                "external_agent_id": "cell-az-slot-02",
                "updated_at": "2026-11-18T00:00:00Z",
                "backend_metadata": {
                    "tenancy": "hussh-hosted",
                    "url": "https://cell-slot.azurecontainerapps.io",
                    "hostedAzureAdmission": {"version": 1, "slotId": "slot02"},
                },
            },
            "uid-az-unassigned": {
                "user_id": "uid-az-unassigned",
                "hushh_id": "ha1_az_unassigned",
                "status": "needs_reinit",
                "deployment_target": "user_azure",
                "backend": "user_azure",
                "external_agent_id": None,
                "user_cloud_tenant_id": tenant_id,
                "user_cloud_subscription_id": sub_id,
                "user_cloud_resource_group": "rg-hussh-one-xyz",
                "user_cloud_region": "eastus2",
                "backend_metadata": {"puppyAccess": {"dev-1": {"approved": True}}},
            },
        }
    )
    detach = _make_fake_detach(reg)
    jobs = _FakeJobs()
    mig_jobs = _FakeMigrationJobs({"uid-az-migrating": {"status": "failed"}})
    grants = _FakeGrants()

    verdict_mig = await adopt_pooled_sandbox_for_owner(
        user_id="uid-az-migrating",
        allow_clean_slate=True,
        registry=reg,
        job_repo=jobs,
        migration_job_repo=mig_jobs,
        grant_service=grants,
        detach_fn=detach,
    )
    assert verdict_mig["detachedPriorHost"] is True
    assert verdict_mig["deploymentTarget"] == "ace"
    migrating_row = reg.rows["uid-az-migrating"]
    _assert_clean_ace_row(migrating_row)
    assert (
        migrating_row["backend_metadata"]["detachedPlacements"][0]["deployment_target"]
        == "user_azure"
    )
    assert (
        migrating_row["backend_metadata"]["detachedPlacements"][0]["user_cloud_subscription_id"]
        == sub_id
    )

    verdict_hosted = await adopt_pooled_sandbox_for_owner(
        user_id="uid-az-hosted",
        allow_clean_slate=True,
        registry=reg,
        job_repo=jobs,
        migration_job_repo=mig_jobs,
        grant_service=grants,
        detach_fn=detach,
    )
    assert verdict_hosted["detachedPriorHost"] is True
    hosted_row = reg.rows["uid-az-hosted"]
    _assert_clean_ace_row(hosted_row)
    assert hosted_row["backend_metadata"]["detachedPlacements"][0]["deployment_target"] == "azure"

    # Unassigned owner-cloud row without _db() must clear user_cloud_* inside the fake repo itself.
    verdict_unassigned = await adopt_pooled_sandbox_for_owner(
        user_id="uid-az-unassigned",
        allow_clean_slate=True,
        registry=reg,
        job_repo=jobs,
        migration_job_repo=mig_jobs,
        grant_service=grants,
        detach_fn=detach,
    )
    assert verdict_unassigned["detachedPriorHost"] is False
    unassigned_row = reg.rows["uid-az-unassigned"]
    _assert_clean_ace_row(unassigned_row)
    assert unassigned_row["backend_metadata"]["puppyAccess"] == {"dev-1": {"approved": True}}


async def test_adopt_pooled_sandbox_switches_gcp_provisioned_needs_reinit_and_hosted_to_ace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _enable_cutover(monkeypatch)
    reg = _FakeRegistry(
        {
            "uid-gcp-prov": {
                "user_id": "uid-gcp-prov",
                "hushh_id": "ha1_gcp_prov",
                "status": "provisioned",
                "deployment_target": "user_gcp",
                "backend": "user_gcp",
                "external_agent_id": "hussh-one-pod-1",
                "user_cloud_project": "owner-gcp-proj-1",
                "user_cloud_region": "us-central1",
                "user_cloud_bootstrap_sa": "hussh-boot@owner-gcp-proj-1.iam.gserviceaccount.com",
                "user_cloud_authorized_at": "2026-10-01T00:00:00Z",
                "updated_at": "2026-11-18T00:00:00Z",
                "backend_metadata": {"url": "https://gcp-pod-1.run.app"},
            },
            "uid-gcp-reinit-assigned": {
                "user_id": "uid-gcp-reinit-assigned",
                "hushh_id": "ha1_gcp_reinit_1",
                "status": "needs_reinit",
                "deployment_target": "user_gcp",
                "backend": "user_gcp",
                "external_agent_id": "hussh-one-pod-2",
                "user_cloud_project": "owner-gcp-proj-2",
                "user_cloud_region": "us-central1",
                "updated_at": "2026-11-18T00:00:00Z",
                "backend_metadata": {"url": "https://gcp-pod-2.run.app"},
            },
            "uid-gcp-reinit-unassigned": {
                "user_id": "uid-gcp-reinit-unassigned",
                "hushh_id": "ha1_gcp_reinit_2",
                "status": "needs_reinit",
                "deployment_target": "user_gcp",
                "backend": "user_gcp",
                "external_agent_id": None,
                "user_cloud_project": "owner-gcp-proj-3",
                "user_cloud_region": "us-central1",
                "user_cloud_bootstrap_sa": "hussh-boot@owner-gcp-proj-3.iam.gserviceaccount.com",
                "user_cloud_authorized_at": "2026-10-01T00:00:00Z",
                "backend_metadata": {},
            },
            "uid-gcp-hosted": {
                "user_id": "uid-gcp-hosted",
                "hushh_id": "ha1_gcp_hosted",
                "status": "provisioned",
                "deployment_target": "gcp",
                "backend": "gcp",
                "external_agent_id": "hosted-gcp-svc",
                "updated_at": "2026-11-18T00:00:00Z",
                "backend_metadata": {
                    "tenancy": "hussh-hosted",
                    "url": "https://hosted-gcp.run.app",
                    "provisionAttempt": {"phase": "provisioned", "hostedAdmission": {"version": 1}},
                },
            },
        }
    )
    detach = _make_fake_detach(reg)
    jobs = _FakeJobs()
    mig_jobs = _FakeMigrationJobs()
    grants = _FakeGrants()

    for uid, expect_detached in (
        ("uid-gcp-prov", True),
        ("uid-gcp-reinit-assigned", True),
        ("uid-gcp-reinit-unassigned", False),
        ("uid-gcp-hosted", True),
    ):
        verdict = await adopt_pooled_sandbox_for_owner(
            user_id=uid,
            allow_clean_slate=True,
            registry=reg,
            job_repo=jobs,
            migration_job_repo=mig_jobs,
            grant_service=grants,
            detach_fn=detach,
        )
        assert verdict["detachedPriorHost"] is expect_detached
        _assert_clean_ace_row(reg.rows[uid])
        if expect_detached:
            assert len(reg.rows[uid]["backend_metadata"]["detachedPlacements"]) == 1
            from hushh_mcp.services.source_pod_retirement import (  # noqa: PLC0415
                iter_grace_governed_detached_placements,
            )

            grace_items = iter_grace_governed_detached_placements(reg.rows[uid])
            assert len(grace_items) == 1
            assert grace_items[0].placement_id in reg.rows[uid]["backend_metadata"].get(
                "sourcePodRetirements", {}
            )


async def test_adopt_pooled_sandbox_preserves_prior_source_pod_retirements(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _enable_cutover(monkeypatch)
    prior_rec = {
        "status": "owner_confirmed",
        "ownerConfirmed": True,
        "graceReapAfter": "2026-12-01T00:00:00Z",
    }
    reg = _FakeRegistry(
        {
            "uid-az-hosted": {
                "user_id": "uid-az-hosted",
                "hushh_id": "ha1_az_hosted",
                "status": "provisioned",
                "deployment_target": "azure",
                "backend": "azure",
                "external_agent_id": "/subscriptions/s/resourceGroups/rg/providers/Microsoft.App/containerApps/ca-pod-slot01",
                "updated_at": "2026-11-18T00:00:00Z",
                "backend_metadata": {
                    "tenancy": "hussh-hosted",
                    "url": "https://ca-pod-slot01.example.azurecontainerapps.io",
                    "hostedAzureAdmission": {"cellId": "cell-az-eastus2-dev-01"},
                    "sourcePodRetirements": {"ret_existing_123": prior_rec},
                    "detachedPlacements": [
                        {
                            "detachedAt": "2026-11-01T00:00:00Z",
                            "backend": "user_azure",
                            "deployment_target": "user_azure",
                            "graceReapAfter": "2026-11-15T00:00:00Z",
                        }
                    ],
                },
            }
        }
    )
    verdict = await adopt_pooled_sandbox_for_owner(
        user_id="uid-az-hosted",
        allow_clean_slate=True,
        registry=reg,
        job_repo=_FakeJobs(),
        migration_job_repo=_FakeMigrationJobs(),
        grant_service=_FakeGrants(),
        detach_fn=_make_fake_detach(reg),
    )
    assert verdict["detachedPriorHost"] is True
    retirements = reg.rows["uid-az-hosted"]["backend_metadata"]["sourcePodRetirements"]
    assert retirements["ret_existing_123"] == prior_rec
    assert len(retirements) == 2


@pytest.mark.parametrize(
    ("user_id", "job"),
    [
        (
            "uid-gcp-fenced",
            {
                "user_id": "uid-gcp-fenced",
                "status": "failed",
                "stage": "linking_billing",
                "project_id": "owner-gcp-proj",
                "stages": [{"stage": "creating_project"}, {"stage": "linking_billing"}],
            },
        ),
        (
            "uid-azure-fenced",
            {
                "user_id": "uid-azure-fenced",
                "status": "failed",
                "stage": "azure_provider_request",
                "project_id": "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-1",
                "stages": [
                    {"stage": "azure_worker_started"},
                    {"stage": "azure_setup_prior_intent"},
                    {"stage": "azure_provider_request"},
                ],
            },
        ),
    ],
)
async def test_adopt_pooled_sandbox_supersedes_fenced_gcp_and_azure_byoc_jobs(
    monkeypatch: pytest.MonkeyPatch,
    user_id: str,
    job: dict[str, Any],
) -> None:
    _enable_cutover(monkeypatch)
    reg = _FakeRegistry(
        {
            user_id: {
                "user_id": user_id,
                "hushh_id": f"ha1_{user_id}",
                "status": "pending",
                "backend": None,
                "deployment_target": None,
                "backend_metadata": {},
            }
        }
    )
    jobs = _FakeJobs({user_id: job})
    mig_jobs = _FakeMigrationJobs()
    grants = _FakeGrants()

    # Silent cutover keeps fenced jobs untouched.
    untouched = await ensure_pooled_sandbox_placement(
        user_id=user_id, registry=reg, job_repo=jobs, grant_service=grants
    )
    assert untouched is not None and untouched.get("deployment_target") is None

    # Explicit owner switch bypasses the fence and places onto ACE.
    verdict = await adopt_pooled_sandbox_for_owner(
        user_id=user_id,
        allow_clean_slate=True,
        registry=reg,
        job_repo=jobs,
        migration_job_repo=mig_jobs,
        grant_service=grants,
    )
    assert verdict["hostingMode"] == "hussh_pods"
    assert verdict["deploymentTarget"] == "ace"
    updated = reg.rows[user_id]
    _assert_clean_ace_row(updated)
    assert setup_job_superseded_by_detach(updated, job) is True
    assert setup_job_superseded_by_detach(updated, {**job, "status": "running"}) is False
    assert (
        resolve_hosting_mode(
            row=updated, registry_read_ok=True, setup_job=job, setup_job_read_ok=True
        )
        == "hussh_pods"
    )


@pytest.mark.parametrize(
    "row",
    [
        {
            "user_id": "uid-lock-1",
            "status": "provisioned",
            "deployment_target": "user_gcp",
            "external_agent_id": "svc-1",
            "user_cloud_project": "proj-1",
        },
        {
            "user_id": "uid-lock-2",
            "status": "needs_reinit",
            "deployment_target": "user_gcp",
            "external_agent_id": None,
            "user_cloud_project": "proj-2",
        },
        {
            "user_id": "uid-lock-3",
            "status": "migrating",
            "deployment_target": "user_azure",
            "external_agent_id": "az-1",
            "user_cloud_subscription_id": "22222222-2222-2222-2222-222222222222",
        },
        {
            "user_id": "uid-lock-4",
            "status": "unprovisioned",
            "deployment_target": "user_azure",
            "external_agent_id": None,
            "user_cloud_subscription_id": "22222222-2222-2222-2222-222222222222",
        },
        {
            "user_id": "uid-lock-5",
            "status": "provisioned",
            "deployment_target": "gcp",
            "external_agent_id": "hosted-gcp",
        },
        {
            "user_id": "uid-lock-6",
            "status": "provisioned",
            "deployment_target": "azure",
            "external_agent_id": "hosted-azure",
        },
    ],
)
async def test_adopt_pooled_sandbox_requires_clean_slate_confirmation(
    monkeypatch: pytest.MonkeyPatch,
    row: dict[str, Any],
) -> None:
    _enable_cutover(monkeypatch)
    uid = row["user_id"]
    reg = _FakeRegistry({uid: row})
    with pytest.raises(ValueError, match="CLEAN_SLATE_CONFIRMATION_REQUIRED"):
        await adopt_pooled_sandbox_for_owner(
            user_id=uid,
            allow_clean_slate=False,
            registry=reg,
            job_repo=_FakeJobs(),
            migration_job_repo=_FakeMigrationJobs(),
            grant_service=_FakeGrants(),
            detach_fn=_make_fake_detach(reg),
        )
    assert reg.upserts == []


@pytest.mark.parametrize(
    ("row", "job", "mig_job", "expected_msg"),
    [
        (
            {"user_id": "uid-run-setup", "status": "pending"},
            {"user_id": "uid-run-setup", "status": "running", "stage": "proving"},
            None,
            "cloud setup job is currently running",
        ),
        (
            {"user_id": "uid-run-mig", "status": "migrating"},
            None,
            {"user_id": "uid-run-mig", "status": "running", "stage": "transferring"},
            "pod migration is currently running",
        ),
        (
            {
                "user_id": "uid-erasure",
                "status": "suspended",
                "deployment_target": "user_gcp",
                "external_agent_id": "svc-1",
                "backend_metadata": {"erasure": {"phase": "reserved"}},
            },
            None,
            None,
            "Account cloud removal is in progress",
        ),
        (
            {
                "user_id": "uid-lease",
                "status": "provisioned",
                "deployment_target": "user_azure",
                "external_agent_id": "az-1",
                "backend_metadata": {"upgradeLease": {"operationId": "op-1"}},
            },
            None,
            None,
            "agent update is currently running",
        ),
        (
            {
                "user_id": "uid-vmpower",
                "status": "provisioned",
                "deployment_target": "user_azure",
                "external_agent_id": "az-1",
                "backend_metadata": {"vmPower": {"phase": "deallocating"}},
            },
            None,
            None,
            "changing power state",
        ),
        (
            {
                "user_id": "uid-attempt",
                "status": "provisioning",
                "deployment_target": "user_gcp",
                "backend_metadata": {"provisionAttempt": {"phase": "reserved"}},
            },
            None,
            None,
            "unfinished cloud provisioning attempt",
        ),
    ],
)
async def test_adopt_pooled_sandbox_refuses_running_jobs_and_lifecycle_fences(
    monkeypatch: pytest.MonkeyPatch,
    row: dict[str, Any],
    job: dict[str, Any] | None,
    mig_job: dict[str, Any] | None,
    expected_msg: str,
) -> None:
    _enable_cutover(monkeypatch)
    uid = row["user_id"]
    reg = _FakeRegistry({uid: row})
    jobs = _FakeJobs({uid: job} if job else {})
    mig_jobs = _FakeMigrationJobs({uid: mig_job} if mig_job else {})

    with pytest.raises(ValueError, match=expected_msg):
        await adopt_pooled_sandbox_for_owner(
            user_id=uid,
            allow_clean_slate=True,
            registry=reg,
            job_repo=jobs,
            migration_job_repo=mig_jobs,
            grant_service=_FakeGrants(),
            detach_fn=_make_fake_detach(reg),
        )
    assert reg.upserts == []


async def test_adopt_pooled_sandbox_route_maps_http_responses(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    marked: list[str] = []

    async def _mark(user_id: str) -> None:
        marked.append(user_id)

    monkeypatch.setattr(runtime, "_write_cloud_setup_marker", _mark)

    async def _unavail(**_kwargs: Any) -> dict[str, Any]:
        raise PermissionError("POOLED_SANDBOX_UNAVAILABLE")

    monkeypatch.setattr(
        "hushh_mcp.services.pooled_sandbox_cutover.adopt_pooled_sandbox_for_owner", _unavail
    )
    with pytest.raises(HTTPException) as exc404:
        await runtime.adopt_pooled_sandbox_route.__wrapped__(  # type: ignore[attr-defined]
            request=None,
            body=runtime.PooledSandboxAdoptRequest(allowCleanSlate=True),
            firebase_uid="u-1",
        )
    assert exc404.value.status_code == 404

    async def _clean_slate(**_kwargs: Any) -> dict[str, Any]:
        raise ValueError("CLEAN_SLATE_CONFIRMATION_REQUIRED")

    monkeypatch.setattr(
        "hushh_mcp.services.pooled_sandbox_cutover.adopt_pooled_sandbox_for_owner", _clean_slate
    )
    with pytest.raises(HTTPException) as exc409:
        await runtime.adopt_pooled_sandbox_route.__wrapped__(  # type: ignore[attr-defined]
            request=None,
            body=runtime.PooledSandboxAdoptRequest(allowCleanSlate=False),
            firebase_uid="u-1",
        )
    assert exc409.value.status_code == 409
    assert exc409.value.detail["code"] == "CLEAN_SLATE_CONFIRMATION_REQUIRED"

    async def _ready(*, user_id: str, allow_clean_slate: bool) -> dict[str, Any]:
        assert user_id == "u-1" and allow_clean_slate is True
        return {
            "status": "ready",
            "hostingMode": "hussh_pods",
            "deploymentTarget": "ace",
            "hushhId": "ha1_u1",
            "podUrl": f"{_EDGE_URL}/u/ha1_u1",
            "detachedPriorHost": True,
        }

    monkeypatch.setattr(
        "hushh_mcp.services.pooled_sandbox_cutover.adopt_pooled_sandbox_for_owner", _ready
    )
    resp = await runtime.adopt_pooled_sandbox_route.__wrapped__(  # type: ignore[attr-defined]
        request=None,
        body=runtime.PooledSandboxAdoptRequest(allowCleanSlate=True),
        firebase_uid="u-1",
    )
    assert resp.deploymentTarget == "ace"
    assert resp.detachedPriorHost is True
    assert marked == ["u-1"]


async def test_adopt_pooled_sandbox_lossless_sync_and_fail_closed_head_sha(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _enable_cutover(monkeypatch)
    reg = _FakeRegistry(
        {
            "uid-lossless-az": {
                "user_id": "uid-lossless-az",
                "hushh_id": "ha1_lossless_az",
                "status": "provisioned",
                "deployment_target": "azure",
                "backend": "azure",
                "external_agent_id": "/subscriptions/s/resourceGroups/rg/providers/Microsoft.App/containerApps/ca-pod-slot01",
                "updated_at": "2026-11-20T09:00:00Z",
                "backend_metadata": {
                    "tenancy": "hussh-hosted",
                    "url": "https://ca-pod-slot01.example.azurecontainerapps.io",
                    "hostedAzureAdmission": {"cellId": "cell-az-eastus2-dev-01"},
                },
            }
        }
    )

    handoff_calls: list[str] = []

    class _FakeHandoff:
        def _request(self, method: str, path: str, **_kw: Any) -> dict[str, Any]:
            handoff_calls.append(f"{method}:{path}")
            return {"state": "accepting", "incarnation": "rev-1"}

        def prepare_and_wait(
            self, *, operation_id: str, incarnation: str, **_kw: Any
        ) -> dict[str, Any]:
            handoff_calls.append(f"prepare:{operation_id}:{incarnation}")
            return {"operationId": operation_id, "incarnation": incarnation, "activeWork": 0}

        def release(self, *, operation_id: str, incarnation: str, **_kw: Any) -> dict[str, Any]:
            handoff_calls.append(f"release:{operation_id}:{incarnation}")
            return {"state": "accepting"}

    class _MismatchedImportTransport:
        def export_from(self, **_kw: Any) -> dict[str, Any]:
            return {"bundle": {"cipher": "b"}, "headSha": "a" * 64, "recordCount": 2}

        def import_into(self, **_kw: Any) -> dict[str, Any]:
            return {
                "headSha": "b" * 64,
                "recordCount": 2,
                "sourceHeadSha": "a" * 64,
                "matchesSource": False,
            }

    woken: list[str] = []

    async def _wake(url: str) -> None:
        woken.append(url)

    # Negative control: mismatched destination SHA must fail closed BEFORE detaching source pod.
    with pytest.raises(ValueError, match="verification failed"):
        await adopt_pooled_sandbox_for_owner(
            user_id="uid-lossless-az",
            allow_clean_slate=True,
            registry=reg,
            job_repo=_FakeJobs(),
            migration_job_repo=_FakeMigrationJobs(),
            grant_service=_FakeGrants(),
            detach_fn=_make_fake_detach(reg),
            migration_transport=_MismatchedImportTransport(),
            handoff_factory=lambda _u, _h: _FakeHandoff(),
            wake_sandbox_fn=_wake,
        )
    assert reg.upserts == []
    assert reg.rows["uid-lossless-az"]["deployment_target"] == "azure"
    assert any(c.startswith("release:") for c in handoff_calls)

    class _MatchingTransport:
        def export_from(self, **kw: Any) -> dict[str, Any]:
            handoff_calls.append(f"export:{kw['hushh_id']}")
            return {"bundle": {"cipher": "ok"}, "headSha": "c" * 64, "recordCount": 3}

        def import_into(self, **kw: Any) -> dict[str, Any]:
            handoff_calls.append(f"import:{kw['hushh_id']}")
            return {
                "headSha": "c" * 64,
                "recordCount": 3,
                "sourceHeadSha": "c" * 64,
                "matchesSource": True,
            }

    sweeps: list[str] = []
    verdict = await adopt_pooled_sandbox_for_owner(
        user_id="uid-lossless-az",
        allow_clean_slate=True,
        registry=reg,
        job_repo=_FakeJobs(),
        migration_job_repo=_FakeMigrationJobs(),
        grant_service=_FakeGrants(),
        detach_fn=_make_fake_detach(reg),
        migration_transport=_MatchingTransport(),
        handoff_factory=lambda _u, _h: _FakeHandoff(),
        wake_sandbox_fn=_wake,
        trigger_retirement_sweep_fn=lambda: sweeps.append("triggered"),
    )
    assert verdict["migrationMode"] == "lossless_commit_log"
    assert verdict["syncedRecordCount"] == 3
    assert verdict["backgroundCleanupQueued"] is True
    assert sweeps == ["triggered"]
    retirements = reg.rows["uid-lossless-az"]["backend_metadata"]["sourcePodRetirements"]
    rec = next(iter(retirements.values()))
    assert rec["status"] == "ready_for_retirement"
    assert rec["ownerConfirmed"] is True
    assert rec["graceDays"] == 0


async def test_adopt_pooled_sandbox_dead_byoc_falls_back_to_3_day_grace_and_opt_in_delete(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from hushh_mcp.services.pod_upgrade_handoff import PodUpgradeHandoffUnavailable

    _enable_cutover(monkeypatch)

    class _DeadHandoff:
        def _request(self, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
            raise PodUpgradeHandoffUnavailable("pod lifecycle request unavailable: ConnectTimeout")

    reg = _FakeRegistry(
        {
            "uid-dead-az": {
                "user_id": "uid-dead-az",
                "hushh_id": "ha1_dead_az",
                "status": "migrating",
                "deployment_target": "user_azure",
                "backend": "user_azure",
                "external_agent_id": "/subscriptions/expired/resourceGroups/rg/providers/Microsoft.App/containerApps/ca-dead",
                "user_cloud_subscription_id": "22222222-2222-2222-2222-222222222222",
                "user_cloud_resource_group": "rg-dead",
                "updated_at": "2026-11-20T09:00:00Z",
                "backend_metadata": {"url": "https://dead-az.example.azurecontainerapps.io"},
            },
            "uid-opt-del": {
                "user_id": "uid-opt-del",
                "hushh_id": "ha1_opt_del",
                "status": "provisioned",
                "deployment_target": "user_gcp",
                "backend": "user_gcp",
                "external_agent_id": "pod-byoc-gcp-1",
                "user_cloud_project": "owner-proj-1",
                "updated_at": "2026-11-20T09:00:00Z",
                "backend_metadata": {"url": "https://dead-gcp.run.app"},
            },
        }
    )

    async def _wake(_url: str) -> None:
        return None

    sweeps: list[str] = []
    verdict_dead = await adopt_pooled_sandbox_for_owner(
        user_id="uid-dead-az",
        allow_clean_slate=True,
        remove_prior_cloud_resources=False,
        registry=reg,
        job_repo=_FakeJobs(),
        migration_job_repo=_FakeMigrationJobs(),
        grant_service=_FakeGrants(),
        detach_fn=_make_fake_detach(reg),
        handoff_factory=lambda _u, _h: _DeadHandoff(),
        wake_sandbox_fn=_wake,
        trigger_retirement_sweep_fn=lambda: sweeps.append("triggered"),
    )
    assert verdict_dead["migrationMode"] == "clean_slate_fallback"
    assert verdict_dead["syncedRecordCount"] == 0
    assert sweeps == []
    dead_rec = next(
        iter(reg.rows["uid-dead-az"]["backend_metadata"]["sourcePodRetirements"].values())
    )
    assert dead_rec["graceDays"] == 3
    assert dead_rec["ownerConfirmed"] is False
    assert dead_rec["status"] == "awaiting_owner_confirmation"

    verdict_del = await adopt_pooled_sandbox_for_owner(
        user_id="uid-opt-del",
        allow_clean_slate=True,
        remove_prior_cloud_resources=True,
        registry=reg,
        job_repo=_FakeJobs(),
        migration_job_repo=_FakeMigrationJobs(),
        grant_service=_FakeGrants(),
        detach_fn=_make_fake_detach(reg),
        handoff_factory=lambda _u, _h: _DeadHandoff(),
        wake_sandbox_fn=_wake,
        trigger_retirement_sweep_fn=lambda: sweeps.append("triggered"),
    )
    assert verdict_del["backgroundCleanupQueued"] is True
    assert sweeps == ["triggered"]
    del_rec = next(
        iter(reg.rows["uid-opt-del"]["backend_metadata"]["sourcePodRetirements"].values())
    )
    assert del_rec["graceDays"] == 0
    assert del_rec["ownerConfirmed"] is True
    assert del_rec["removePriorCloudResources"] is True
    assert del_rec["status"] == "ready_for_retirement"


async def test_ensure_pooled_sandbox_placement_writes_cloud_setup_marker_except_for_byoc(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _enable_cutover(monkeypatch)
    reg = _FakeRegistry(
        {
            "uid-byoc-preserve": {
                "user_id": "uid-byoc-preserve",
                "hushh_id": "ha1_byocpreserve0000000000000000000",
                "status": "provisioned",
                "deployment_target": "user_azure",
                "backend": "user_azure",
                "external_agent_id": "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.App/containerApps/pod",
                "user_cloud_subscription_id": "sub",
                "backend_metadata": {"url": "https://byoc-az.example"},
            }
        }
    )
    marked: list[str] = []

    async def _mark(uid: str) -> None:
        marked.append(uid)

    placed = await ensure_pooled_sandbox_placement(
        user_id="uid-cold-signup",
        registry=reg,
        job_repo=_FakeJobs(),
        grant_service=_FakeGrants(),
        cloud_marker_writer=_mark,
    )
    assert placed is not None and placed["deployment_target"] == "ace"
    assert marked == ["uid-cold-signup"]

    # Idempotent repeat on already-placed ACE row also ensures marker is present.
    repeated = await ensure_pooled_sandbox_placement(
        user_id="uid-cold-signup",
        registry=reg,
        job_repo=_FakeJobs(),
        grant_service=_FakeGrants(),
        cloud_marker_writer=_mark,
    )
    assert repeated is not None and repeated["deployment_target"] == "ace"
    assert marked == ["uid-cold-signup", "uid-cold-signup"]

    # Negative control: preserved BYOC placement never receives an ACE cloud marker.
    byoc = await ensure_pooled_sandbox_placement(
        user_id="uid-byoc-preserve",
        registry=reg,
        job_repo=_FakeJobs(),
        grant_service=_FakeGrants(),
        cloud_marker_writer=_mark,
    )
    assert byoc is not None and byoc["deployment_target"] == "user_azure"
    assert "uid-byoc-preserve" not in marked


async def test_switch_hosting_mode_route_detaches_ace_to_shared_and_own_cloud_while_protecting_byoc(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from api.routes.one import runtime_placement

    detached_calls: list[tuple[str, str]] = []
    recorded_shared: list[tuple[str, bool]] = []
    marked: list[str] = []
    current_mode = {"value": "hussh_pods"}

    async def _fake_placement(_uid: str) -> str:
        return current_mode["value"]

    async def _fake_get_row(self: Any, uid: str) -> dict[str, Any] | None:
        return {
            "user_id": uid,
            "hushh_id": "ha1_sandbox0000000000000000000000",
            "status": "provisioned",
            "deployment_target": "ace",
            "external_agent_id": "ace:ha1_sandbox0000000000000000000000",
            "updated_at": "2026-11-22T12:00:00Z",
        }

    async def _fake_detach(*, row: dict[str, Any], reason: str, **kwargs: Any) -> dict[str, Any]:
        detached_calls.append((str(row["user_id"]), reason))
        return {"user_id": row["user_id"], "detached_count": 1}

    async def _fake_record_shared(
        self: Any, uid: str, *, after_detach: bool = False
    ) -> dict[str, Any]:
        recorded_shared.append((uid, after_detach))
        return {"tier": "shared"}

    async def _fake_mark(uid: str) -> None:
        marked.append(uid)

    monkeypatch.setattr(runtime_placement, "_placement", _fake_placement)
    monkeypatch.setattr(runtime_placement, "require_byoc_setup_enabled", lambda: None)
    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_registry_repo.PersonalAgentRegistryRepo.get",
        _fake_get_row,
    )
    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_placement_detach.detach_placement",
        _fake_detach,
    )
    monkeypatch.setattr(
        "hushh_mcp.services.owner_hosting_choice.HostingChoiceRepo.record_shared",
        _fake_record_shared,
    )
    monkeypatch.setattr(runtime, "_write_cloud_setup_marker", _fake_mark)

    shared_resp = await runtime.switch_hosting_mode_route.__wrapped__(  # type: ignore[attr-defined]
        request=None,
        body=runtime.HostingSwitchRequest(target="shared"),
        firebase_uid="uid-ace-1",
    )
    assert shared_resp.hostingMode == "shared"
    assert shared_resp.detachedPriorHost is True
    assert detached_calls == [("uid-ace-1", "owner switched to Hussh Shared")]
    assert recorded_shared == [("uid-ace-1", True)]
    assert marked == ["uid-ace-1"]

    own_resp = await runtime.switch_hosting_mode_route.__wrapped__(  # type: ignore[attr-defined]
        request=None,
        body=runtime.HostingSwitchRequest(target="own_cloud"),
        firebase_uid="uid-ace-2",
    )
    assert own_resp.hostingMode == "unplaced"
    assert own_resp.detachedPriorHost is True
    assert detached_calls[-1] == ("uid-ace-2", "owner switched to Bring your own cloud")

    current_mode["value"] = "byoc"
    with pytest.raises(HTTPException) as exc:
        await runtime.switch_hosting_mode_route.__wrapped__(  # type: ignore[attr-defined]
            request=None,
            body=runtime.HostingSwitchRequest(target="shared"),
            firebase_uid="uid-byoc-1",
        )
    assert exc.value.status_code == 409
    assert exc.value.detail["code"] == "CLOUD_REMOVAL_REVIEW_REQUIRED"
