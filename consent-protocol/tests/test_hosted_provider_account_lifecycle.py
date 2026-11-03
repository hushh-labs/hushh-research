from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace

import pytest

from hushh_mcp.services.hosted_provider_account_transition import PLACEMENTS
from scripts.ops.hosted_provider_account_evidence import _current_erasure_tombstone_pair
from scripts.ops.hosted_provider_account_identity import (
    EXPECTED_OPERATOR,
    OperatorRefused,
    _creation_recovery_ready,
)
from scripts.ops.hosted_provider_account_lifecycle import NamedGcloudOperatorCredentials
from scripts.ops.hosted_provider_account_ops import HostedProviderAccountRuntime
from tests.helpers.hosted_provider_account_ops import (
    _FakeTransition,
    _pilot_row,
    _runtime_snapshot_for_action,
    _service,
)


def test_personal_deprovision_tombstone_requires_exact_current_erasure_pair():
    from copy import deepcopy

    hushh_id = next(iter(PLACEMENTS))
    row = _pilot_row(hushh_id)
    erasure_attempt = "5c177d95-4a4f-4cda-b168-69468fd7e6f0"
    snapshot = deepcopy(row)
    row["status"] = "suspended"
    row["backend_metadata"] = {
        **snapshot["backend_metadata"],
        "erasure": {
            "ownerId": row["user_id"],
            "attemptId": erasure_attempt,
            "registrySnapshot": snapshot,
        },
    }
    tombstone = {
        "hushh_id": hushh_id,
        "status": "deprovision_requested",
        "external_agent_id": snapshot["external_agent_id"],
    }
    auxiliary = {"personalTombstones": [tombstone]}

    assert _current_erasure_tombstone_pair(row, auxiliary, PLACEMENTS[hushh_id])
    foreign = {**tombstone, "external_agent_id": "foreign-service"}
    assert not _current_erasure_tombstone_pair(
        row, {"personalTombstones": [foreign]}, PLACEMENTS[hushh_id]
    )


@pytest.mark.asyncio
async def test_billing_dispatch_refuses_if_named_operator_identity_is_unavailable():
    hushh_id = next(iter(PLACEMENTS))
    snapshot = _runtime_snapshot_for_action(hushh_id)
    transition = _FakeTransition()
    runtime = HostedProviderAccountRuntime(
        credentials=object(),
        operator_credentials=None,
        session=object(),
        registry=object(),
        operator_verifier=lambda **_: (_ for _ in ()).throw(RuntimeError("not named")),
        transition_factory=lambda: transition,
    )

    async def inventory():
        return snapshot

    runtime.inventory = inventory
    with pytest.raises(OperatorRefused, match="operator credentials must verify as"):
        await runtime.perform(
            "associate-account", snapshot.placements[hushh_id], reviewed_sha256=snapshot.sha256
        )
    assert transition.calls == []


@pytest.mark.asyncio
async def test_billing_start_and_resume_delegate_only_after_reviewed_actor_gate():
    hushh_id = next(iter(PLACEMENTS))
    snapshot = _runtime_snapshot_for_action(hushh_id)
    transition = _FakeTransition()
    verified = SimpleNamespace(
        principal=EXPECTED_OPERATOR,
        email=EXPECTED_OPERATOR.removeprefix("user:"),
        email_verified=True,
        token=None,
    )
    runtime = HostedProviderAccountRuntime(
        credentials=object(),
        operator_credentials=object(),
        session=object(),
        registry=object(),
        operator_verifier=lambda **_: verified,
        transition_factory=lambda: transition,
    )

    async def inventory():
        return snapshot

    runtime.inventory = inventory
    started = await runtime.perform(
        "associate-account", snapshot.placements[hushh_id], reviewed_sha256=snapshot.sha256
    )
    assert started == {"phase": "unknown", "generation": 2}
    assert transition.calls == [("start", "synthetic-owner")]

    snapshot = _runtime_snapshot_for_action(hushh_id, transition_phase="unknown")

    async def resume_inventory():
        return snapshot

    runtime.inventory = resume_inventory
    resumed = await runtime.perform(
        "resume", snapshot.placements[hushh_id], reviewed_sha256=snapshot.sha256
    )
    assert resumed == {"phase": "unknown", "generation": 3}
    assert transition.calls[-1] == ("resume", "synthetic-owner")


@pytest.mark.parametrize(
    ("service_state", "service_present"),
    [("absent", False), ("ambiguous", True)],
    ids=("lost-ack-service-missing", "lost-ack-service-mismatched"),
)
@pytest.mark.asyncio
async def test_lost_ack_resume_refuses_without_entering_existing_creation_recovery(
    service_state, service_present
):
    from types import SimpleNamespace

    hushh_id = next(iter(PLACEMENTS))
    row = _pilot_row(hushh_id)
    row["status"] = "provisioning"
    attempt = row["backend_metadata"]["provisionAttempt"]
    attempt["phase"] = "host_requested"
    attempt["evidence"]["host_requested"].pop("creationAcknowledgement")
    assert _creation_recovery_ready(row)

    snapshot = _runtime_snapshot_for_action(hushh_id, status="provisioning")
    snapshot.placements[hushh_id]["nativeServiceState"] = service_state
    services = []
    if service_present:
        mismatched = _service(row)
        mismatched["metadata"]["uid"] = "different-service-incarnation"
        services.append(mismatched)
    record = snapshot.records[hushh_id]
    record.update(
        registryRow=row,
        authorityRow=row,
        ownerId=row["user_id"],
        services=services,
    )
    snapshot = replace(snapshot, records={hushh_id: record})
    runtime = HostedProviderAccountRuntime(
        credentials=object(),
        session=object(),
        registry=SimpleNamespace(),
    )
    recovery_calls = []

    async def existing_recovery(**kwargs):
        recovery_calls.append(kwargs)

    runtime._resume_existing_creation = existing_recovery

    with pytest.raises(
        OperatorRefused, match="provider transition requires the exact active native service"
    ):
        await runtime.perform(
            "resume",
            snapshot.placements[hushh_id],
            reviewed_sha256=snapshot.sha256,
            inventory_snapshot=snapshot,
        )

    assert recovery_calls == []


@pytest.mark.asyncio
async def test_remove_delegates_to_existing_erasure_reservation(monkeypatch):
    from copy import deepcopy

    from hushh_mcp.services import personal_agent_provisioning_service

    hushh_id = next(iter(PLACEMENTS))
    base = _pilot_row(hushh_id)
    erasure_attempt = "5c177d95-4a4f-4cda-b168-69468fd7e6f0"
    snapshot_row = deepcopy(base)
    erasure = {
        "ownerId": base["user_id"],
        "attemptId": erasure_attempt,
        "phase": "reserved",
        "registrySnapshot": snapshot_row,
    }
    row = deepcopy(base)
    row["status"] = "suspended"
    row["backend_metadata"] = {**base["backend_metadata"], "erasure": erasure}
    inventory = _runtime_snapshot_for_action(hushh_id, status="suspended")
    inventory.records[hushh_id] = {"registryRow": row, "ownerId": base["user_id"]}
    calls = []

    class _Provisioner:
        def __init__(self, *, registry, managed_erasure):
            assert managed_erasure is not None

        async def deprovision(self, *, user_id, expected_erasure_attempt):
            calls.append((user_id, expected_erasure_attempt))
            return {"status": "unprovisioned", "rowDeleteDeferred": True}

    monkeypatch.setattr(
        personal_agent_provisioning_service, "PersonalAgentProvisioningService", _Provisioner
    )
    verified = SimpleNamespace(
        principal=EXPECTED_OPERATOR,
        email=EXPECTED_OPERATOR.removeprefix("user:"),
        email_verified=True,
        token=None,
    )
    runtime = HostedProviderAccountRuntime(
        credentials=object(),
        operator_credentials=object(),
        session=object(),
        registry=object(),
        operator_verifier=lambda **_: verified,
    )

    async def current_inventory():
        return inventory

    runtime.inventory = current_inventory
    result = await runtime.perform(
        "remove", inventory.placements[hushh_id], reviewed_sha256=inventory.sha256
    )

    assert result == {"status": "unprovisioned", "rowDeleteDeferred": True}
    assert calls == [(base["user_id"], erasure_attempt)]


def test_named_gcloud_operator_token_is_captured_in_memory(monkeypatch, tmp_path):
    import subprocess

    executable = tmp_path / "gcloud"
    executable.write_text("placeholder")
    executable.chmod(0o755)
    monkeypatch.setenv("HUSHH_GCLOUD_EXECUTABLE", str(executable))
    calls = []

    def fake_run(args, **kwargs):
        calls.append((args, kwargs))
        return subprocess.CompletedProcess(args, 0, stdout="ya29.fake.operator.token\n", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    credentials = NamedGcloudOperatorCredentials()

    credentials.refresh()

    assert credentials.valid is True
    assert credentials.token == "ya29.fake.operator.token"
    assert calls[0][0] == [
        str(executable.resolve()),
        "auth",
        "print-access-token",
        f"--account={EXPECTED_OPERATOR.removeprefix('user:')}",
    ]
    assert calls[0][1]["shell"] is False
    assert calls[0][1]["capture_output"] is True
