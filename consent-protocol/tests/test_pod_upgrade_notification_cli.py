"""One-owner notification recovery CLI wiring stays separate from image upgrades."""

from __future__ import annotations

import importlib.util
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

_UPGRADE = Path(__file__).resolve().parents[1] / "scripts" / "ops" / "pod_upgrade.py"
_SPEC = importlib.util.spec_from_file_location("pod_upgrade_notification_cli", _UPGRADE)
upgrade = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = upgrade
_SPEC.loader.exec_module(upgrade)


_INPUTS = [
    "--recover-notification-upgrade",
    "--user-id",
    "synthetic-owner",
    "--operation-id",
    "synthetic-operation",
    "--target-image",
    "registry.invalid/pod@sha256:" + "a" * 64,
    "--running-hub-source",
    "b" * 40,
    "--reviewed-executor-revision",
    "projects/demo/locations/us-central1/services/hub/revisions/hub-1",
    "--review-evidence-sha256",
    "c" * 64,
]


def _run_immediate(coro):
    try:
        coro.send(None)
    except StopIteration as result:
        return result.value
    raise AssertionError("CLI test coroutine unexpectedly awaited I/O")


def test_recovery_cli_is_one_owner_dry_run_by_default(monkeypatch):
    captured = []

    async def main(args):
        captured.append(args)
        return 0

    monkeypatch.setattr(upgrade, "_main", main)
    monkeypatch.setattr(upgrade, "_load_env", lambda: None)
    monkeypatch.setattr(upgrade.asyncio, "run", _run_immediate)
    monkeypatch.setattr(sys, "argv", [str(_UPGRADE), *_INPUTS])

    assert upgrade.main() == 0
    assert captured[0].user_id == "synthetic-owner"
    assert captured[0].execute is False
    assert captured[0].target_image.endswith("a" * 64)


@pytest.mark.parametrize(
    "extra",
    [
        ["--all"],
        ["--execute", "--dry-run"],
    ],
)
def test_recovery_cli_rejects_fleet_or_conflicting_execution(extra, monkeypatch):
    monkeypatch.setattr(sys, "argv", [str(_UPGRADE), *_INPUTS, *extra])
    with pytest.raises(SystemExit) as error:
        upgrade.main()
    assert error.value.code == 2


@pytest.mark.asyncio
async def test_main_recovery_mode_returns_before_normal_upgrade_path(monkeypatch):
    called = []

    async def recovery(args):
        called.append(args)
        return 7

    monkeypatch.setattr(upgrade, "_recover_notification_upgrade", recovery)
    assert await upgrade._main(SimpleNamespace(recover_notification_upgrade=True)) == 7
    assert len(called) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("execute", [False, True])
async def test_recovery_adapter_passes_owner_proofs_and_only_executes_registry_cas(
    execute, monkeypatch, capsys
):
    calls = _install_recovery_mocks(monkeypatch, execute)
    monkeypatch.setenv("HUSHH_DEPLOY_SHA", "b" * 40)
    monkeypatch.setenv("HUSSH_ONE_POD_IMAGE", _INPUTS[_INPUTS.index("--target-image") + 1])
    args = SimpleNamespace(
        user_id="synthetic-owner",
        running_hub_source="b" * 40,
        target_image=_INPUTS[_INPUTS.index("--target-image") + 1],
        operation_id="synthetic-operation",
        reviewed_executor_revision="projects/demo/locations/us-central1/services/hub/revisions/hub-1",
        review_evidence_sha256="c" * 64,
        execute=execute,
    )
    assert await upgrade._recover_notification_upgrade(args) == 0
    assert calls["validated"] is True
    assert calls["native"] == ["owner-service"]
    assert calls["handoff"] == [("https://owner-pod.invalid", "ha1_synthetic")]
    assert calls["inputs"]["reviewed_operation_id"] == "synthetic-operation"
    assert len(calls["cas"]) == int(execute)
    output = capsys.readouterr().out
    assert "SCHEDULED" in output if execute else "DRY RUN VERIFIED" in output


def _install_recovery_mocks(monkeypatch, execute):
    from hushh_mcp.services import gcp_notification_upgrade_recovery as recovery
    from hushh_mcp.services import (
        personal_agent_registry_repo,
        pod_upgrade_handoff,
        user_cloud_service,
        user_gcp_backend,
    )

    calls = {"cas": [], "native": [], "events": [], "handoff": []}

    class Registry:
        async def get(self, user_id):
            return {
                "user_id": user_id,
                "hushh_id": "ha1_synthetic",
                "deployment_target": "user_gcp",
            }

        def _db(self):
            return SimpleNamespace(
                execute_raw=lambda _sql, _params: SimpleNamespace(data=[{"seq": 7}])
            )

        async def record_image_upgrade(self, **fields):
            calls["cas"].append(fields)
            return True

    class Run:
        def get_service(self, service_name):
            calls["native"].append(service_name)
            return {"service": service_name}

    class Backend:
        def __init__(self, **kwargs):
            calls["backend"] = kwargs

        def _client(self):
            return Run()

    class Handoff:
        def __init__(self, *, url, hushh_id):
            calls["handoff"].append((url, hushh_id))

        def recovery_snapshot(self):
            return {"status": "accepting"}

    async def resolve(_user_id, **_kwargs):
        return SimpleNamespace(
            is_ready_to_provision=True,
            project="owner-project",
            region="us-central1",
            bootstrap_sa="owner-bootstrap@owner-project.iam.gserviceaccount.com",
        )

    async def validate(registry):
        assert isinstance(registry, Registry)
        calls["validated"] = True

    _patch_recovery_modules(
        monkeypatch,
        recovery,
        personal_agent_registry_repo,
        pod_upgrade_handoff,
        user_cloud_service,
        user_gcp_backend,
        Registry,
        Backend,
        Handoff,
        resolve,
        validate,
        _recovery_result(calls, execute),
    )
    return calls


def _recovery_result(calls, execute):
    async def recover(**kwargs):
        calls["inputs"] = kwargs
        await kwargs["notification_validator"]()
        candidate = SimpleNamespace(
            user_id="synthetic-owner",
            hushh_id="ha1_synthetic",
            service_name="owner-service",
            attempted_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        )
        calls["events"] = await kwargs["event_reader"](candidate)
        await kwargs["native_reader"](candidate)
        calls["handoff_result"] = await kwargs["handoff_reader"](
            candidate, {"podUrl": "https://owner-pod.invalid"}
        )
        if execute:
            await kwargs["writer"](
                user_id="synthetic-owner",
                backend_metadata={"upgradeApproval": {"status": "scheduled"}},
                expected_lease="lease",
                previous_metadata={},
                observed={},
                retain_lease=False,
                require_unchanged_metadata=True,
            )
        return {"status": "scheduled" if execute else "dry_run"}

    return recover


def _patch_recovery_modules(
    monkeypatch,
    recovery,
    registry_repo,
    handoff_module,
    cloud_module,
    backend_module,
    registry,
    backend,
    handoff,
    resolve,
    validate,
    recover,
):
    monkeypatch.setattr(registry_repo, "PersonalAgentRegistryRepo", registry)
    monkeypatch.setattr(cloud_module, "resolve_user_cloud", resolve)
    monkeypatch.setattr(backend_module, "UserGcpBackend", backend)
    monkeypatch.setattr(handoff_module, "PodUpgradeHandoffClient", handoff)
    monkeypatch.setattr(recovery, "validate_notification_admission", validate)
    monkeypatch.setattr(recovery, "recover_blocked_upgrade", recover)


@pytest.mark.asyncio
async def test_adapter_sanitizes_bootstrap_provider_failure(monkeypatch, capsys):
    from hushh_mcp.services import (
        gcp_notification_upgrade_recovery,
        personal_agent_registry_repo,
        user_cloud_service,
        user_gcp_backend,
    )

    calls = []

    class Registry:
        async def get(self, _user_id):
            return {"user_id": "synthetic-owner", "hushh_id": "ha1_synthetic"}

        async def record_image_upgrade(self, **_fields):
            raise AssertionError("dry-run recovery must not write")

    class Backend:
        def __init__(self, **_kwargs):
            calls.append("constructed")

        def _client(self):
            calls.append("client")
            raise RuntimeError("sensitive bootstrap response")

    async def resolve(_user_id, **_kwargs):
        return SimpleNamespace(
            is_ready_to_provision=True,
            project="owner-project",
            region="us-central1",
            bootstrap_sa="owner-bootstrap@owner-project.iam.gserviceaccount.com",
        )

    async def recover(**kwargs):
        candidate = SimpleNamespace(
            user_id="synthetic-owner", hushh_id="ha1_synthetic", service_name="owner-service"
        )
        await kwargs["native_reader"](candidate)

    monkeypatch.setattr(personal_agent_registry_repo, "PersonalAgentRegistryRepo", Registry)
    monkeypatch.setattr(user_cloud_service, "resolve_user_cloud", resolve)
    monkeypatch.setattr(user_gcp_backend, "UserGcpBackend", Backend)
    monkeypatch.setattr(gcp_notification_upgrade_recovery, "recover_blocked_upgrade", recover)
    monkeypatch.setenv("HUSHH_DEPLOY_SHA", "b" * 40)
    monkeypatch.setenv("HUSSH_ONE_POD_IMAGE", "target")
    args = SimpleNamespace(
        user_id="synthetic-owner",
        running_hub_source="b" * 40,
        target_image="target",
        operation_id="operation",
        reviewed_executor_revision="revision",
        review_evidence_sha256="evidence",
        execute=False,
    )

    assert await upgrade._recover_notification_upgrade(args) == upgrade.EXIT_REFUSED
    assert calls == ["constructed", "client"]
    output = capsys.readouterr().err
    assert "RuntimeError" in output
    assert "sensitive bootstrap response" not in output
