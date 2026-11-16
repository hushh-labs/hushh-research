# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Wave 2B (#9511) contract & negative-control tests for GCP/Azure Option A CLI worker jobs."""

from __future__ import annotations

import base64
import io
import os
import stat
import sys
import tarfile
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from hushh_mcp.operons.pod_workspace import (
    WorkerExecutionOverrideInput,
    WorkerJobSpecInput,
    WorkerJobSpecInvalid,
    render_azure_container_app_job_spec,
    render_azure_container_app_job_start_body,
    render_gcp_cloud_run_job_overrides,
    render_gcp_cloud_run_job_spec,
)
from hushh_mcp.services.azure_arm_client import ArmClient
from hushh_mcp.services.azure_container_app_jobs import (
    run_workspace_job_execution,
    upsert_workspace_job,
    workspace_job_resource_id,
)
from hushh_mcp.services.gcp_run_client import GcpRunClient
from hushh_mcp.services.pod_commit_log import ABSENT, LocalObjectStore
from hushh_mcp.services.pod_workspace import (
    LocalSubprefixWorkerDispatcher,
    WorkspaceCheckpointLibrary,
    WorkspaceCliRuntime,
    WorkspaceRefused,
    sanitize_and_measure_workspace_archive,
    seal_worker_run_envelope,
    verify_worker_container_env_scrubbed,
    worker_envelope_aad,
)

_SAMPLE_DIGEST = "a" * 64
_SAMPLE_IMAGE = f"us-central1-docker.pkg.dev/owner-proj/hussh/pod@sha256:{_SAMPLE_DIGEST}"


class _SubprefixLocalStoreView:
    """Strict subprefix-scoped view over `LocalObjectStore` mirroring subprefix capability tokens."""

    def __init__(self, backing: LocalObjectStore, subprefix: str) -> None:
        self._backing = backing
        self._subprefix = subprefix.strip("/")

    def _full(self, key: str) -> str:
        cleaned = str(key or "").strip().lstrip("/")
        if not cleaned or ".." in cleaned.split("/"):
            raise PermissionError("subprefix escape refused")
        return f"{self._subprefix}/{cleaned}"

    async def get_with_generation(self, key: str) -> tuple[bytes | None, Any]:
        return await self._backing.get_with_generation(self._full(key))

    async def put_if_generation(self, key: str, data: bytes, expected: Any) -> Any:
        return await self._backing.put_if_generation(self._full(key), data, expected)

    async def delete(self, key: str) -> bool:
        return await self._backing.delete(self._full(key))


def test_gcp_and_azure_job_spec_renderers_enforce_zero_trust_invariants() -> None:
    gcp_spec = WorkerJobSpecInput(
        image_by_digest=_SAMPLE_IMAGE,
        worker_principal="one-ws-worker@owner-proj.iam.gserviceaccount.com",
        pod_principal="one-pod-owner@owner-proj.iam.gserviceaccount.com",
        timeout_seconds=180,
        labels_or_tags={"env": "dev"},
    )
    rendered_gcp = render_gcp_cloud_run_job_spec(gcp_spec)
    tpl = rendered_gcp["template"]["template"]
    assert tpl["maxRetries"] == 0
    assert tpl["executionEnvironment"] == "EXECUTION_ENVIRONMENT_GEN2"
    assert tpl["serviceAccount"] == "one-ws-worker@owner-proj.iam.gserviceaccount.com"
    container = tpl["containers"][0]
    assert container["image"] == _SAMPLE_IMAGE
    env_names = {entry["name"] for entry in container["env"]}
    assert "NO_PROXY" in env_names
    assert "APP_SIGNING_KEY" not in env_names

    # Tag-only image or pod SA reuse or forbidden env must fail closed
    with pytest.raises(WorkerJobSpecInvalid):
        render_gcp_cloud_run_job_spec(
            WorkerJobSpecInput(
                image_by_digest="us-central1-docker.pkg.dev/p/r/pod:latest",
                worker_principal="one-ws-worker@owner-proj.iam.gserviceaccount.com",
            )
        )
    with pytest.raises(WorkerJobSpecInvalid):
        render_gcp_cloud_run_job_spec(
            WorkerJobSpecInput(
                image_by_digest=_SAMPLE_IMAGE,
                worker_principal="same-sa@owner-proj.iam.gserviceaccount.com",
                pod_principal="same-sa@owner-proj.iam.gserviceaccount.com",
            )
        )
    with pytest.raises(WorkerJobSpecInvalid):
        render_gcp_cloud_run_job_spec(
            WorkerJobSpecInput(
                image_by_digest=_SAMPLE_IMAGE,
                worker_principal="one-ws-worker@owner-proj.iam.gserviceaccount.com",
                base_env={"HUSSH_POD_KMS_KEY": "projects/p/locations/l/keyRings/r/cryptoKeys/k"},
            )
        )

    azure_spec = WorkerJobSpecInput(
        image_by_digest=f"owneracr.azurecr.io/consent-protocol-pod@sha256:{_SAMPLE_DIGEST}",
        worker_principal="/subscriptions/s/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/ws-pull",
        pod_principal="/subscriptions/s/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/pod-id",
        azure_location="eastus2",
        azure_environment_id="/subscriptions/s/resourceGroups/rg/providers/Microsoft.App/managedEnvironments/cae",
        azure_registry_server="owneracr.azurecr.io",
        timeout_seconds=240,
    )
    rendered_az = render_azure_container_app_job_spec(azure_spec)
    assert rendered_az["properties"]["workloadProfileName"] == "Consumption"
    assert rendered_az["properties"]["configuration"]["replicaRetryLimit"] == 0
    assert rendered_az["properties"]["configuration"]["secrets"] == []

    override = WorkerExecutionOverrideInput(
        run_id="b" * 32,
        workspace_id="ws_alpha_01",
        owner="usr_owner_1",
        account_generation=2,
        host_kind="azure_container_apps",
        storage_provider="azure_blob_delegation_sas",
        storage_url="https://owneracct.blob.core.windows.net/pods/usr_owner_1/workspaces/v1/ws_alpha_01",
        bearer_token="sv=2023-11-03&sr=c&sp=racwdl",  # noqa: S106
        run_key_b64=base64.b64encode(bytes([0x11]) * 32).decode("ascii"),
        timeout_seconds=90,
    )
    gcp_overrides = render_gcp_cloud_run_job_overrides(override)
    assert gcp_overrides["overrides"]["taskCount"] == 1
    az_start = render_azure_container_app_job_start_body(azure_spec, override)
    az_env = {e["name"]: e["value"] for e in az_start["containers"][0]["env"]}
    assert az_env["HUSSH_WS_ID"] == "ws_alpha_01"
    assert az_env["NO_PROXY"].startswith("169.254.169.254")


def test_gcp_run_jobs_client_and_azure_arm_jobs_transport() -> None:
    fake_creds = SimpleNamespace(valid=True, token="tok-gcp", refresh=lambda _req: None)  # noqa: S106
    client = GcpRunClient(project="proj-one", region="us-central1", credentials=fake_creds)

    calls: list[tuple[str, str]] = []

    class _FakeResp:
        def __init__(self, status_code: int, payload: dict[str, Any]) -> None:
            self.status_code = status_code
            self._payload = payload

        def json(self) -> dict[str, Any]:
            return self._payload

    class _FakeGcpSession:
        def get(self, url: str, **_kw: Any) -> _FakeResp:
            calls.append(("GET", url))
            if url.endswith("/jobs/hussh-ws-job"):
                return _FakeResp(404, {})
            if "/operations/op-create" in url:
                return _FakeResp(
                    200,
                    {
                        "name": "projects/proj-one/locations/us-central1/operations/op-create",
                        "done": True,
                        "response": {
                            "name": "projects/proj-one/locations/us-central1/jobs/hussh-ws-job"
                        },
                    },
                )
            if "/operations/op-run" in url:
                return _FakeResp(
                    200,
                    {
                        "name": "projects/proj-one/locations/us-central1/operations/op-run",
                        "done": True,
                        "response": {
                            "name": "projects/proj-one/locations/us-central1/jobs/hussh-ws-job/executions/exec-1",
                            "succeededCount": 1,
                            "failedCount": 0,
                            "conditions": [{"type": "Completed", "state": "CONDITION_SUCCEEDED"}],
                        },
                    },
                )
            raise AssertionError(f"unexpected GET {url}")

        def post(self, url: str, **_kw: Any) -> _FakeResp:
            calls.append(("POST", url))
            if url.endswith("/jobs"):
                return _FakeResp(
                    200,
                    {
                        "name": "projects/proj-one/locations/us-central1/operations/op-create",
                        "done": False,
                    },
                )
            if url.endswith("/jobs/hussh-ws-job:run"):
                return _FakeResp(
                    200,
                    {
                        "name": "projects/proj-one/locations/us-central1/operations/op-run",
                        "done": False,
                    },
                )
            raise AssertionError(f"unexpected POST {url}")

    sess = _FakeGcpSession()
    created = client.upsert_job(
        "hussh-ws-job", {"launchStage": "GA"}, interval_s=0.01, session=sess
    )
    assert created["name"].endswith("/jobs/hussh-ws-job")
    ran = client.run_job_execution("hussh-ws-job", {"overrides": {}}, interval_s=0.01, session=sess)
    assert ran["succeededCount"] == 1

    # Untrusted cross-project operation name must fail closed
    class _EvilSession(_FakeGcpSession):
        def post(self, url: str, **_kw: Any) -> _FakeResp:
            return _FakeResp(
                200,
                {
                    "name": "projects/evil-proj/locations/us-central1/operations/op-bad",
                    "done": True,
                },
            )

    with pytest.raises(RuntimeError, match="operation identity invalid"):
        client.run_job_execution("hussh-ws-job", {}, interval_s=0.01, session=_EvilSession())

    # Azure ARM `Microsoft.App/jobs` upsert + start + poll
    class _FakeArmHttp:
        def __init__(self) -> None:
            self.poll_count = 0

        @staticmethod
        def _resp(status_code: int, payload: dict[str, Any]) -> Any:
            return SimpleNamespace(
                status_code=status_code,
                headers={},
                content=b"{}",
                json=lambda: payload,
            )

        def request(self, method: str, url: str, **_kw: Any) -> Any:
            if method == "PUT" and "/providers/Microsoft.App/jobs/caj-hussh-one-ws" in url:
                return self._resp(
                    200,
                    {
                        "id": "job-1",
                        "name": "caj-hussh-one-ws",
                        "properties": {"provisioningState": "Succeeded"},
                    },
                )
            if method == "POST" and "/jobs/caj-hussh-one-ws/start" in url:
                return self._resp(
                    200,
                    {"name": "exec-az-1", "properties": {"status": "Running"}},
                )
            if method == "GET" and "/executions/exec-az-1" in url:
                self.poll_count += 1
                return self._resp(
                    200,
                    {"name": "exec-az-1", "properties": {"status": "Succeeded"}},
                )
            raise AssertionError(f"unexpected ARM {method} {url}")

    arm = ArmClient(
        lambda: "tok-az",
        session=_FakeArmHttp(),
    )
    jpath = workspace_job_resource_id("sub-1", "rg-1")
    upserted = upsert_workspace_job(arm, jpath, {"location": "eastus2", "properties": {}})
    assert upserted["name"] == "caj-hussh-one-ws"
    settled = run_workspace_job_execution(
        arm, jpath, {"containers": []}, timeout_s=5.0, poll_interval_s=0.01
    )
    assert settled["properties"]["status"] == "Succeeded"


@pytest.mark.asyncio
async def test_ephemeral_worker_dispatch_reconciles_checkpoints_fences_forget_and_rejects_poison(
    tmp_path: Path,
) -> None:
    async def _ok() -> None:
        return None

    backing_store = LocalObjectStore(tmp_path / "pod_root")
    checkpoints = WorkspaceCheckpointLibrary(
        owner="usr_wave2_9511",
        key=bytes([0x42]) * 32,
        store=backing_store,
        check=_ok,
        account_generation=3,
    )

    async def _mint_subprefix(subprefix: str, _ttl: int) -> dict[str, Any]:
        return {
            "provider": "ace_prefix_bearer",
            "prefixUrl": f"https://storage.hussh.example/pods/usr_wave2_9511/{subprefix}",
            "bearerToken": "ephemeral-subprefix-bearer",
        }

    dispatcher = LocalSubprefixWorkerDispatcher(
        simulated_job_mode="cloud_run_jobs_v2",
        scratch_parent=tmp_path / "worker_scratch",
        subprefix_store_factory=lambda env: _SubprefixLocalStoreView(
            backing_store, f"workspaces/v1/{env['HUSSH_WS_ID']}"
        ),
    )
    runtime = WorkspaceCliRuntime(
        checkpoints,
        host_kind="gcp_cloud_run",
        job_dispatcher=dispatcher,
        storage_token_minter=_mint_subprefix,
    )
    assert runtime.boundary_mode() == "ephemeral_task_worker"
    assert runtime.status("ws_build_01")["cli_worker_job_mode"] == "cloud_run_jobs_v2"

    # 1. Execute inside isolated subprefix worker; verify child env has zero pod/worker tokens
    res = await runtime.execute(
        workspace_id="ws_build_01",
        argv=[
            sys.executable,
            "-c",
            (
                "import os, pathlib; "
                "assert 'HUSSH_WS_BEARER_TOKEN' not in os.environ; "
                "assert 'HUSSH_WS_RUN_KEY_B64' not in os.environ; "
                "pathlib.Path('artifact.txt').write_text('built-in-ephemeral-job', encoding='utf-8'); "
                "print('job-ok')"
            ),
        ],
        seed_files={"README.md": "# Wave 2 Workspace\n"},
    )
    assert res["status"] == "completed"
    assert res["cli_worker_job_mode"] == "cloud_run_jobs_v2"
    assert res["checkpoint_revision"] == 1
    assert "job-ok" in res["stdout_tail"]

    verify_dir = tmp_path / "verify_hydrate"
    hydrated = await checkpoints.hydrate_workspace("ws_build_01", verify_dir)
    assert hydrated["revision"] == 1
    assert (verify_dir / "artifact.txt").read_text(encoding="utf-8") == "built-in-ephemeral-job"
    assert (verify_dir / "README.md").read_text(encoding="utf-8") == "# Wave 2 Workspace\n"

    # Ephemeral `runs/*` objects must be scrubbed after reconciliation
    runs_dir = tmp_path / "pod_root" / "workspaces" / "v1" / "ws_build_01" / "runs"
    assert not runs_dir.exists() or list(runs_dir.glob("*.bin")) == []

    # 2. Pre-OOM `_ckpt.bin` recovery even if worker crashes before writing `_out.bin`
    class _CrashAfterPreOomCheckpointDispatcher:
        job_mode = "azure_container_apps_jobs"  # type: ignore[assignment]

        async def dispatch_execution(self, override: WorkerExecutionOverrideInput) -> Any:
            view = _SubprefixLocalStoreView(backing_store, f"workspaces/v1/{override.workspace_id}")
            buf = io.BytesIO()
            with tarfile.open(fileobj=buf, mode="w:gz") as tf:
                payload = b"saved-before-oom"
                info = tarfile.TarInfo(name="partial.txt")
                info.size = len(payload)
                info.mode = 0o644
                tf.addfile(info, io.BytesIO(payload))
            sealed_ckpt = seal_worker_run_envelope(
                base64.b64decode(override.run_key_b64),
                {
                    "archive_b64": base64.b64encode(buf.getvalue()).decode("ascii"),
                    "uncompressed_bytes": 16,
                    "file_count": 1,
                    "reason": "pre_oom_recovery",
                    "seq": 1,
                },
                aad=worker_envelope_aad(
                    owner=override.owner,
                    account_generation=override.account_generation,
                    workspace_id=override.workspace_id,
                    run_id=override.run_id,
                    stage="ckpt",
                ),
            )
            await view.put_if_generation(f"runs/{override.run_id}_ckpt.bin", sealed_ckpt, ABSENT)
            from hushh_mcp.operons.pod_workspace import NormalizedWorkerJobRunResult

            return NormalizedWorkerJobRunResult(
                provider_job_mode="azure_container_apps_jobs",
                execution_name="exec-oom",
                succeeded=False,
                failed_count=1,
                succeeded_count=0,
                raw_state="Failed",
            )

    oom_runtime = WorkspaceCliRuntime(
        checkpoints,
        host_kind="azure_container_apps",
        job_dispatcher=_CrashAfterPreOomCheckpointDispatcher(),  # type: ignore[arg-type]
        storage_token_minter=_mint_subprefix,
    )
    oom_res = await oom_runtime.execute(
        workspace_id="ws_build_01",
        argv=[sys.executable, "-c", "pass"],
    )
    assert oom_res["status"] == "budget_exceeded"
    assert oom_res["code"] == "RESOURCE_BUDGET_EXCEEDED"
    assert oom_res["checkpoint_revision"] == 2
    verify_dir2 = tmp_path / "verify_hydrate_2"
    await checkpoints.hydrate_workspace("ws_build_01", verify_dir2)
    assert (verify_dir2 / "partial.txt").read_text(encoding="utf-8") == "saved-before-oom"

    # 3. Concurrent `forget_workspace` during in-flight job must fence stale worker commit
    class _ConcurrentForgetDispatcher:
        job_mode = "cloud_run_jobs_v2"  # type: ignore[assignment]

        async def dispatch_execution(self, override: WorkerExecutionOverrideInput) -> Any:
            await checkpoints.forget_workspace(override.workspace_id)
            return await dispatcher.dispatch_execution(override)

    fenced_runtime = WorkspaceCliRuntime(
        checkpoints,
        host_kind="gcp_cloud_run",
        job_dispatcher=_ConcurrentForgetDispatcher(),  # type: ignore[arg-type]
        storage_token_minter=_mint_subprefix,
    )
    with pytest.raises(WorkspaceRefused) as exc_info:
        await fenced_runtime.execute(
            workspace_id="ws_build_01",
            argv=[sys.executable, "-c", "import pathlib; pathlib.Path('late.txt').write_text('x')"],
        )
    assert exc_info.value.code == "WORKSPACE_FORGOTTEN"

    # 4. Poisoned worker archive (symlink or `.env` credential) & leaked pod env fail closed
    poison_buf = io.BytesIO()
    with tarfile.open(fileobj=poison_buf, mode="w:gz") as tf:
        sym = tarfile.TarInfo(name="escape_link")
        sym.type = tarfile.SYMTYPE
        sym.linkname = "/etc/passwd"
        sym.mode = stat.S_IFLNK | 0o777
        tf.addfile(sym)
    with pytest.raises(WorkspaceRefused) as sym_exc:
        sanitize_and_measure_workspace_archive(poison_buf.getvalue())
    assert sym_exc.value.code == "WORKSPACE_ARCHIVE_UNSAFE"

    with pytest.raises(WorkspaceRefused) as env_exc:
        verify_worker_container_env_scrubbed({**os.environ, "APP_SIGNING_KEY": "leaked"})
    assert env_exc.value.code == "WORKER_ENV_UNSCRUBBED"
