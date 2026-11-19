# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Contract, resource-guardrail, subprefix-broker, and Floci 4-cloud tests for #9511."""

from __future__ import annotations

import sys
from pathlib import Path

import boto3  # type: ignore[import-not-found]
import pytest

from browser_runtime.qualification import resolve_cli_execution_boundary
from hushh_mcp.operons.pod_workspace import (
    CLI_CREDENTIAL_APPROVAL_REQUIRED,
    CLI_WORKER_BOUNDARY_REQUIRED,
    RESOURCE_BUDGET_EXCEEDED,
    RESOURCE_PRESSURE_WARN,
    BoundedStreamRingBuffer,
    ResourceBudgetPolicy,
    WorkspaceResourceGuard,
    build_scrubbed_worker_env,
    classify_cli_command,
    evaluate_resource_pressure,
)
from hushh_mcp.services import pod_workload_identity
from hushh_mcp.services.pod_capability_broker import (
    PodCapabilityBrokerForbidden,
    mint_prefix_gateway_token,
    validated_workspace_subprefix,
    verify_prefix_gateway_token,
)
from hushh_mcp.services.pod_emulator_endpoints import (
    FLOCI_AZ_ENDPOINT_URL_ENV,
    FLOCI_GCP_ENDPOINT_URL_ENV,
    FLOCI_PREFIX_ALLOW_LOOPBACK_HTTP_ENV,
)
from hushh_mcp.services.pod_files.azure_storage import FilesAzureStore
from hushh_mcp.services.pod_files.storage import FilesGcsStore, FilesLocalStore
from hushh_mcp.services.pod_resource_snapshot import ResourceSnapshot
from hushh_mcp.services.pod_s3_object_store import (
    FLOCI_ENDPOINT_URL_ENV,
    PodMultiCloudStorageForbidden,
    PrefixTokenObjectStore,
    S3ObjectStore,
    resolve_aws_boto3_client_kwargs,
)
from hushh_mcp.services.pod_workspace import (
    CLI_OWNER_TAKEOVER_ACTIVE,
    WorkspaceCheckpointLibrary,
    WorkspaceCliRuntime,
    WorkspaceRefused,
)
from tests.floci_wire_harness import (
    floci_aws_wire_environment,
    floci_azure_wire_environment,
    floci_gcp_wire_environment,
    floci_prefix_gateway_environment,
)


def _synthetic_snapshot(
    *,
    current_mb: int,
    limit_mb: int = 1000,
    shm_used_mb: int = 50,
    shm_cap_mb: int = 512,
    oom_kills: int = 0,
    throttled: int = 0,
) -> ResourceSnapshot:
    mb = 1024 * 1024
    return {
        "status": "available",
        "observedAtMs": 1_763_000_000_000,
        "memory": {
            "currentBytes": current_mb * mb,
            "peakBytes": current_mb * mb,
            "limitBytes": limit_mb * mb,
            "unlimited": False,
            "events": {"low": 0, "high": 0, "max": 0, "oom": oom_kills, "oom_kill": oom_kills},
        },
        "cpu": {
            "usage_usec": 1000,
            "user_usec": 600,
            "system_usec": 400,
            "nr_periods": 100,
            "nr_throttled": throttled,
            "throttled_usec": throttled * 100,
        },
        "sharedMemory": {
            "capacityBytes": shm_cap_mb * mb,
            "usedBytes": shm_used_mb * mb,
            "availableBytes": max(0, (shm_cap_mb - shm_used_mb) * mb),
        },
    }


def test_ring_buffer_truncates_cleanly_without_unbounded_growth() -> None:
    ring = BoundedStreamRingBuffer(max_bytes=16)
    ring.append(b"0123456789")
    ring.append(b"abcdefghij")
    assert ring.retained_bytes == 16
    assert ring.total_bytes == 20
    assert ring.truncated_bytes == 4
    assert ring.utf8_tail() == "456789abcdefghij"


def test_resource_pressure_policy_stages_normal_warn_soft_backpressure_and_exceeded() -> None:
    policy = ResourceBudgetPolicy()
    v_norm = evaluate_resource_pressure(
        _synthetic_snapshot(current_mb=400, limit_mb=1000),
        workspace_used_bytes=10 * 1024 * 1024,
        policy=policy,
    )
    assert v_norm.level == "normal" and v_norm.admitted is True and v_norm.code is None

    v_warn = evaluate_resource_pressure(
        _synthetic_snapshot(current_mb=750, limit_mb=1000),
        workspace_used_bytes=10 * 1024 * 1024,
        policy=policy,
    )
    assert v_warn.level == "warn" and v_warn.admitted is True
    assert v_warn.code == RESOURCE_PRESSURE_WARN

    v_soft = evaluate_resource_pressure(
        _synthetic_snapshot(current_mb=880, limit_mb=1000),
        workspace_used_bytes=10 * 1024 * 1024,
        policy=policy,
    )
    assert v_soft.level == "soft_backpressure"
    assert v_soft.admitted is False
    assert v_soft.should_evict_caches is True
    assert v_soft.should_checkpoint_workspace is True

    # Kernel OOM kill delta triggers exceeded even if currentBytes dropped after child death
    v_oom = evaluate_resource_pressure(
        _synthetic_snapshot(current_mb=200, limit_mb=1000, oom_kills=3),
        workspace_used_bytes=0,
        baseline_oom_kills=2,
        policy=policy,
    )
    assert v_oom.level == "exceeded"
    assert v_oom.code == RESOURCE_BUDGET_EXCEEDED
    assert v_oom.oom_kill_delta == 1


def test_cli_boundary_and_scrubbed_env_enforce_option_a_vs_option_b_and_credential_gate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # gcp_cloud_run defaults to restricted_builtin_only until Option A worker is configured
    assert (
        resolve_cli_execution_boundary("gcp_cloud_run", worker_configured=False)
        == "restricted_builtin_only"
    )
    assert (
        resolve_cli_execution_boundary("gcp_cloud_run", worker_configured=True)
        == "ephemeral_task_worker"
    )

    # Option B refuses npm / pip / sh / arbitrary packages fail-closed
    denied_npm = classify_cli_command(
        ["npm", "install", "left-pad"], boundary_mode="restricted_builtin_only"
    )
    assert denied_npm.admitted is False and denied_npm.code == CLI_WORKER_BOUNDARY_REQUIRED

    allowed_ls = classify_cli_command(["ls", "-la"], boundary_mode="restricted_builtin_only")
    assert allowed_ls.admitted is True and allowed_ls.category == "builtin_file_op"

    # Option A allows general CLI/packages, while gating credentialed tools (`gh`, `gcloud`, `az`, `git push`)
    allowed_npm = classify_cli_command(["npm", "test"], boundary_mode="ephemeral_task_worker")
    assert allowed_npm.admitted is True and allowed_npm.category == "general_cli"

    denied_gh = classify_cli_command(
        ["gh", "repo", "list"],
        boundary_mode="ephemeral_task_worker",
        credential_approval_verified=False,
    )
    assert denied_gh.admitted is False and denied_gh.code == CLI_CREDENTIAL_APPROVAL_REQUIRED

    approved_gh = classify_cli_command(
        ["gh", "repo", "list"],
        boundary_mode="ephemeral_task_worker",
        credential_approval_verified=True,
    )
    assert approved_gh.admitted is True and approved_gh.category == "credentialed_cli"

    # Scrubbed worker environment strips pod/cloud/provider secrets and blocks metadata proxy
    monkeypatch.setenv("HUSSH_POD_LOG_KEY", "super-secret-pod-key")
    monkeypatch.setenv("GITHUB_TOKEN", "synthetic-ci-placeholder")
    env = build_scrubbed_worker_env(
        workspace_dir=tmp_path / "ws",
        scratch_tmp_dir=tmp_path / "tmp",
        extra_public_env={
            "HUSSH_SECRET": "blocked",
            "AWS_SECRET_ACCESS_KEY": "blocked",
            "MY_TOKEN": "blocked",
            "CI": "true",
        },
    )
    assert "HUSSH_POD_LOG_KEY" not in env
    assert "HUSSH_SECRET" not in env
    assert "AWS_SECRET_ACCESS_KEY" not in env
    assert "MY_TOKEN" not in env
    assert env["CI"] == "true"
    assert "169.254.169.254" in env["NO_PROXY"]


@pytest.mark.asyncio
async def test_workspace_resource_guard_evicts_caches_checkpoints_pre_oom_and_recovers_cleanly(
    tmp_path: Path,
) -> None:
    store = FilesLocalStore(tmp_path / "store")
    dek = bytes([0x77]) * 32

    async def _ok() -> None:
        return None

    cp_lib = WorkspaceCheckpointLibrary(
        owner="ha1_owner_9511", key=dek, store=store, check=_ok, account_generation=1
    )

    # 1. Soft backpressure recovered automatically by evicting disposable `.cache`!
    policy = ResourceBudgetPolicy(
        max_workspace_bytes=10 * 1024 * 1024,  # 10 MiB workspace quota for fast test
        fallback_memory_budget_bytes=200 * 1024 * 1024,
    )
    guard = WorkspaceResourceGuard(
        policy=policy,
        snapshot_fn=lambda: _synthetic_snapshot(
            current_mb=50, limit_mb=200, shm_used_mb=10, shm_cap_mb=200
        ),
    )
    ws_dir = tmp_path / "work1"
    tmp_dir = tmp_path / "tmp1"
    (ws_dir / "src").mkdir(parents=True)
    (ws_dir / "src" / "main.py").write_text("print('alive')\n", encoding="utf-8")
    (ws_dir / ".env").write_text("LOCAL_TEST_PLACEHOLDER=excluded_dotenv\n", encoding="utf-8")
    # Fill 9 MiB in `.cache` (90% of 10 MiB quota -> soft_backpressure!)
    (ws_dir / ".cache").mkdir(parents=True)
    (ws_dir / ".cache" / "pip_wheel.bin").write_bytes(b"X" * (9 * 1024 * 1024))

    checkpoint_calls: list[str] = []

    async def _save_cp(reason: str) -> int:
        checkpoint_calls.append(reason)
        doc = await cp_lib.save_checkpoint("ws_alpha01", ws_dir, reason=reason)
        return int(doc["revision"])

    receipt = await guard.execute_command(
        [sys.executable, str(ws_dir / "src" / "main.py")],
        workspace_dir=ws_dir,
        scratch_tmp_dir=tmp_dir,
        boundary_mode="ephemeral_task_worker",
        checkpoint_fn=_save_cp,
    )
    # Cache eviction dropped workspace usage from 9 MiB -> ~15 bytes, so command succeeded!
    assert receipt.status == "completed"
    assert receipt.caches_evicted_bytes >= 9 * 1024 * 1024
    assert "pre_admission_backpressure" in checkpoint_calls
    assert "alive" in receipt.stdout_tail

    # Verify `.env` credential file was excluded from encrypted checkpoint!
    restored_dir = tmp_path / "restored1"
    hydrated = await cp_lib.hydrate_workspace("ws_alpha01", restored_dir)
    assert hydrated["hydrated"] is True
    assert (restored_dir / "src" / "main.py").exists()
    assert not (restored_dir / ".env").exists()

    # 2. Live mid-command memory spike (>= 92%) terminates child group cleanly WITHOUT crashing task
    snapshots = [
        _synthetic_snapshot(current_mb=100, limit_mb=1000),  # baseline
        _synthetic_snapshot(current_mb=100, limit_mb=1000),  # pre-admission
        _synthetic_snapshot(current_mb=950, limit_mb=1000),  # live poll -> 95% exceeded!
        _synthetic_snapshot(current_mb=200, limit_mb=1000),  # post-kill settled
    ]
    idx = 0

    def _stepping_snapshot() -> ResourceSnapshot:
        nonlocal idx
        val = snapshots[min(idx, len(snapshots) - 1)]
        idx += 1
        return val

    spike_guard = WorkspaceResourceGuard(
        policy=ResourceBudgetPolicy(),
        snapshot_fn=_stepping_snapshot,
        poll_interval_seconds=0.03,
    )
    spike_receipt = await spike_guard.execute_command(
        [sys.executable, "-c", "import time; time.sleep(5)"],
        workspace_dir=ws_dir,
        scratch_tmp_dir=tmp_dir,
        boundary_mode="ephemeral_task_worker",
        checkpoint_fn=_save_cp,
    )
    assert spike_receipt.status == "resource_exceeded"
    assert spike_receipt.code == RESOURCE_BUDGET_EXCEEDED
    assert spike_receipt.checkpoint_revision is not None
    assert spike_receipt.retry_guidance is not None


@pytest.mark.asyncio
async def test_workspace_cli_runtime_enforces_takeover_fence_and_preserves_state_across_runs(
    tmp_path: Path,
) -> None:
    store = FilesLocalStore(tmp_path / "rt_store")
    dek = bytes([0x88]) * 32

    async def _ok() -> None:
        return None

    cp_lib = WorkspaceCheckpointLibrary(
        owner="ha1_owner_rt", key=dek, store=store, check=_ok, account_generation=1
    )
    rt = WorkspaceCliRuntime(
        cp_lib,
        host_kind="gcp_cloud_run",
        worker_configured=True,
        scratch_parent=tmp_path / "scratch",
    )

    # Run 1 writes a file inside ephemeral scratch -> automatically checkpointed
    r1 = await rt.execute(
        workspace_id="ws_project01",
        argv=[
            sys.executable,
            "-c",
            "from pathlib import Path; Path('inventory.txt').write_text('gcp+azure-ok\\n')",
        ],
    )
    assert r1["status"] == "completed"
    assert r1["checkpoint_revision"] == 1

    # Run 2 hydrates from encrypted ObjectStore into a brand-new scratch dir and reads `inventory.txt`
    r2 = await rt.execute(
        workspace_id="ws_project01",
        argv=["cat", "inventory.txt"],
    )
    assert r2["status"] == "completed"
    assert "gcp+azure-ok" in r2["stdout_tail"]

    # Owner takeover blocks autonomous agent execution and suppresses private owner entry stdout
    ctrl = rt.set_control_mode("ws_project01", "take_control")
    assert ctrl["control_mode"] == "owner" and ctrl["model_observation_suppressed"] is True

    with pytest.raises(WorkspaceRefused) as takeover_exc:
        await rt.execute(
            workspace_id="ws_project01",
            argv=["ls"],
            actor="agent",
        )
    assert takeover_exc.value.code == CLI_OWNER_TAKEOVER_ACTIVE

    owner_run = await rt.execute(
        workspace_id="ws_project01",
        argv=[sys.executable, "-c", "print('private-owner-token-entry')"],
        actor="owner",
    )
    assert owner_run["stdout_tail"] == ""
    events = await cp_lib.list_execution_events("ws_project01")
    assert events[-1]["command_summary"] == "[owner private entry]"

    rt.set_control_mode("ws_project01", "resume_agent")
    r3 = await rt.execute(workspace_id="ws_project01", argv=["ls"], actor="agent")
    assert r3["status"] == "completed"


@pytest.mark.asyncio
async def test_workspace_floci_four_cloud_wire_and_subprefix_confinement(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _ok() -> None:
        return None

    dek = bytes([0x99]) * 32
    src_dir = tmp_path / "src_ws"
    src_dir.mkdir(parents=True)
    (src_dir / "report.md").write_text("# Cloud Inventory\nVerified.\n", encoding="utf-8")

    # 1. Hussh-Hosted Prefix Gateway with narrow `workspaces/v1/ws_alpha1234` subprefix token!
    secret = b"floci-9511-gateway-secret-key-32b!"
    with floci_prefix_gateway_environment(secret=secret) as gw:
        monkeypatch.setenv("ENVIRONMENT", "test")
        monkeypatch.setenv(FLOCI_PREFIX_ALLOW_LOOPBACK_HTTP_ENV, "1")
        subprefix = validated_workspace_subprefix("workspaces/v1/ws_alpha1234")
        ws_token, claims = mint_prefix_gateway_token(
            hushh_id="ha1_floci_9511",
            owner_id="usr_floci_9511",
            placement_epoch=1,
            ttl_seconds=900,
            subprefix=subprefix,
            secret=secret,
        )
        assert claims["prefix"] == "pods/ha1_floci_9511/workspaces/v1/ws_alpha1234"

        # Token CANNOT access pod root (`head.json`), `wiki/v1`, or sibling workspace `ws_other9999`
        for forbidden_path in (
            "pods/ha1_floci_9511/head.json",
            "pods/ha1_floci_9511/wiki/v1/heads/secret.bin",
            "pods/ha1_floci_9511/workspaces/v1/ws_other9999/heads/current.bin",
        ):
            with pytest.raises(PodCapabilityBrokerForbidden):
                verify_prefix_gateway_token(ws_token, object_path=forbidden_path, secret=secret)

        # Store scoped to `pods/ha1_floci_9511` using the narrow `ws_token`:
        scoped_store = PrefixTokenObjectStore(
            f"{gw.endpoint_url}/pods/ha1_floci_9511",
            bearer_token=ws_token,
        )
        lib = WorkspaceCheckpointLibrary(
            owner="ha1_floci_9511", key=dek, store=scoped_store, check=_ok
        )
        saved = await lib.save_checkpoint("ws_alpha1234", src_dir, reason="floci_gw")
        assert saved["revision"] == 1

        out_dir = tmp_path / "out_gw"
        hydrated = await lib.hydrate_workspace("ws_alpha1234", out_dir)
        assert hydrated["hydrated"] is True
        assert (out_dir / "report.md").read_text(
            encoding="utf-8"
        ) == "# Cloud Inventory\nVerified.\n"

        # Sibling workspace write with `ws_alpha1234` token is refused over HTTP wire (403)!
        with pytest.raises(PodMultiCloudStorageForbidden):
            await lib.save_checkpoint("ws_other9999", src_dir, reason="escape_attempt")

        forgotten = await lib.forget_workspace("ws_alpha1234")
        assert forgotten["forgotten"] is True and forgotten["key_epoch"] == 2

    # 2. BYOC GCP (GCS), BYOC Azure (Blob), and BYOC AWS (S3) wire round-trips
    with floci_gcp_wire_environment() as gcp_env:
        monkeypatch.setenv("ENVIRONMENT", "test")
        monkeypatch.setenv(FLOCI_GCP_ENDPOINT_URL_ENV, gcp_env.endpoint_url)
        gcs_store = FilesGcsStore("hushh-floci-ws-gcs", "pods/ha1_gcp_9511")
        gcs_lib = WorkspaceCheckpointLibrary(
            owner="ha1_gcp_9511", key=dek, store=gcs_store, check=_ok
        )
        await gcs_lib.save_checkpoint("ws_gcp00001", src_dir)
        gcp_out = tmp_path / "out_gcp"
        assert (await gcs_lib.hydrate_workspace("ws_gcp00001", gcp_out))["hydrated"] is True

    pod_workload_identity.forget_workload_token("https://storage.azure.com")
    pod_workload_identity.forget_workload_token("https://management.azure.com/")
    with floci_azure_wire_environment() as az_env:
        acct = "husshwsacct"
        account_id = (
            "/subscriptions/11111111-2222-3333-4444-555555555555"
            f"/resourceGroups/rg-ws/providers/Microsoft.Storage/storageAccounts/{acct}"
        )
        monkeypatch.setenv("ENVIRONMENT", "test")
        monkeypatch.setenv(FLOCI_AZ_ENDPOINT_URL_ENV, az_env.endpoint_url)
        monkeypatch.setenv("IDENTITY_ENDPOINT", az_env.identity_endpoint)
        monkeypatch.setenv("IDENTITY_HEADER", az_env.identity_header)
        monkeypatch.setenv("AZURE_CLIENT_ID", az_env.client_id)
        az_store = FilesAzureStore(
            f"{az_env.endpoint_url}/{acct}/pod-ws/pods/ha1_az_9511",
            account_id=account_id,
        )
        az_lib = WorkspaceCheckpointLibrary(owner="ha1_az_9511", key=dek, store=az_store, check=_ok)
        await az_lib.save_checkpoint("ws_azure001", src_dir)
        az_out = tmp_path / "out_az"
        assert (await az_lib.hydrate_workspace("ws_azure001", az_out))["hydrated"] is True

    with floci_aws_wire_environment() as aws_env:
        monkeypatch.setenv("ENVIRONMENT", "test")
        monkeypatch.setenv(FLOCI_ENDPOINT_URL_ENV, aws_env.endpoint_url)
        s3_admin = boto3.client("s3", **resolve_aws_boto3_client_kwargs("s3"))
        s3_admin.create_bucket(Bucket="hushh-floci-ws-s3")
        s3_store = S3ObjectStore("s3://hushh-floci-ws-s3/pods/ha1_aws_9511")
        s3_lib = WorkspaceCheckpointLibrary(
            owner="ha1_aws_9511", key=dek, store=s3_store, check=_ok
        )
        await s3_lib.save_checkpoint("ws_aws00001", src_dir)
        aws_out = tmp_path / "out_aws"
        assert (await s3_lib.hydrate_workspace("ws_aws00001", aws_out))["hydrated"] is True
