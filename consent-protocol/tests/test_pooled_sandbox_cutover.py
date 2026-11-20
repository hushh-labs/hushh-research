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
from hushh_mcp.services.personal_agent_hosting import resolve_hosting_mode
from hushh_mcp.services.pod_binding_contract import (
    make_pod_binding,
    verify_binding_capabilities,
)
from hushh_mcp.services.pooled_sandbox_cutover import (
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
    assert row["liveness_mode"] == "warm"
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
