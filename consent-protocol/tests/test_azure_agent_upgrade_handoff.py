"""An approved Azure update drains the running agent first, like Google Cloud does.

Single revision mode keeps the old revision serving until the new one is ready, so
without the handoff two revisions could write one sealed log at once."""

from __future__ import annotations

import pytest

from hushh_mcp.services import pod_upgrade_handoff
from hushh_mcp.services.azure_arm_client import ArmError
from hushh_mcp.services.user_azure_backend import jit_person_authority
from tests.test_user_azure_backend import (  # noqa: F401 - shared fixtures and builders
    _backend,
    _hub_caller,
    _upgrade_spec,
    arm,
)


def _files_plan(arm, backend, target):  # noqa: F811 - shared fixture
    from hushh_mcp.services.pod_files.azure_capability import plan_from_observation
    from tests.test_user_azure_backend import _HUSHH_ID, _SUB, _TENANT

    app = arm.resources[backend.app_id]
    meta = backend.verified_handle(_HUSHH_ID, backend.observe_sync()).backend_metadata
    row = {
        "user_id": "files-owner",
        "hushh_id": _HUSHH_ID,
        "status": "provisioned",
        "deployment_target": "user_azure",
        "external_agent_id": backend.app_id,
        "user_cloud_tenant_id": _TENANT,
        "user_cloud_subscription_id": _SUB,
        "user_cloud_resource_group": backend._group,
        "user_cloud_region": "eastus2",
        "user_cloud_authorized_at": "2026-10-07",
        "backend_metadata": meta,
    }
    plan = plan_from_observation(row, target, app)
    # ARM supplies the default storage encryption status, absent from the PUT body.
    arm.resources[plan.storageId]["properties"]["encryption"] = {
        "services": {"blob": {"enabled": True}}
    }
    return plan, row


class _Handoff:
    """The pod lifecycle client, recording the order of everything it is asked."""

    events: list[tuple] = []
    fail_prepare = False

    def __init__(self, *, url, hushh_id, session=None):
        _Handoff.events.append(("connect", url, hushh_id))

    def prepare_and_wait(self, *, operation_id, incarnation, **_):
        _Handoff.events.append(("prepare", operation_id, incarnation))
        if _Handoff.fail_prepare:
            raise pod_upgrade_handoff.PodUpgradeHandoffUnavailable("busy")
        return {"operationId": operation_id, "incarnation": incarnation, "activeWork": 0}

    def release(self, *, operation_id, incarnation):
        _Handoff.events.append(("release", operation_id, incarnation))
        return {}


@pytest.fixture(autouse=True)
def _client(monkeypatch):
    _Handoff.events = []
    _Handoff.fail_prepare = False
    monkeypatch.setattr(pod_upgrade_handoff, "PodUpgradeHandoffClient", _Handoff)


async def test_the_agent_is_fenced_before_the_image_moves_and_never_released_after(arm):  # noqa: F811 - shared fixture
    backend, idle = _backend(arm), []
    revision = arm.resources[backend.app_id]["properties"]["latestReadyRevisionName"]
    spec = _upgrade_spec(arm, backend, [], upgrade_operation_id="op-1", on_upgrade_idle=idle.append)
    with jit_person_authority("person-jit-token"):
        handle = await backend.upgrade(spec)
    assert (
        _Handoff.events[0][1] == "https://ca-hussh-one-pod.happyfield.eastus2.azurecontainerapps.io"
    )
    assert _Handoff.events[1] == ("prepare", "op-1", revision)
    assert idle == [{"operationId": "op-1", "incarnation": revision, "activeWork": 0}]
    assert not any(event[0] == "release" for event in _Handoff.events)
    assert handle.backend_metadata["upgraded"] is True


async def test_a_refused_drain_changes_nothing(arm):  # noqa: F811 - shared fixture
    backend = _backend(arm)
    _Handoff.fail_prepare = True
    spec = _upgrade_spec(arm, backend, [], upgrade_operation_id="op-2")
    with jit_person_authority("person-jit-token"):
        with pytest.raises(pod_upgrade_handoff.PodUpgradeHandoffUnavailable):
            await backend.upgrade(spec)
    assert arm.writes() == []
    assert _Handoff.events[-1][0] == "release"


async def test_a_failed_import_releases_the_drained_agent(arm):  # noqa: F811 - shared fixture
    backend = _backend(arm)
    arm.fail(
        "POST",
        "/importImage",
        ArmError("failed", status=200, code="ImportFailed", message="", op="x"),
    )
    spec = _upgrade_spec(arm, backend, [], upgrade_operation_id="op-3")
    with jit_person_authority("person-jit-token"):
        with pytest.raises(ArmError):
            await backend.upgrade(spec)
    assert [e[0] for e in _Handoff.events] == ["connect", "prepare", "release"]
    assert not any(method == "PUT" for method, _ in arm.writes())


async def test_without_an_approved_operation_there_is_nothing_to_drain(arm):  # noqa: F811 - shared fixture
    backend = _backend(arm)
    with jit_person_authority("person-jit-token"):
        await backend.upgrade(_upgrade_spec(arm, backend, []))
    assert _Handoff.events == []


@pytest.mark.parametrize("failure", ["forbidden", "timeout"])
async def test_files_preflight_read_refusal_has_no_mutations_or_ambiguous_receipts(arm, failure):  # noqa: F811
    from hushh_mcp.services.pod_files.capability_update import FilesCapabilityChanged
    from tests.test_user_azure_backend import _OLD, _SOURCE

    backend = _backend(arm)
    target = f"{_SOURCE}@{_OLD}"
    plan, _ = _files_plan(arm, backend, target)
    receipts = []
    refusal = (
        ArmError("forbidden", status=403, code="Denied", message="private", op="read")
        if failure == "forbidden"
        else TimeoutError("private transport context")
    )
    arm.fail("GET", plan.storageId, refusal)
    arm.calls.clear()
    spec = _upgrade_spec(
        arm,
        backend,
        [],
        upgrade_target_image=target,
        upgrade_operation_id="op-files",
        files_upgrade_plan=plan.model_dump(),
        on_files_upgrade_checkpoint=lambda *receipt: receipts.append(receipt),
    )
    with jit_person_authority("person-jit-token"):
        with pytest.raises(FilesCapabilityChanged, match="could not be verified"):
            await backend.upgrade(spec)
    assert not arm.writes() and not receipts and not _Handoff.events


@pytest.mark.parametrize("reconciled_prefix", [False, True])
async def test_files_update_uses_exact_approval_and_checkpoints_even_on_same_image(
    arm,  # noqa: F811 - shared ARM fixture
    monkeypatch,
    reconciled_prefix,
):  # noqa: F811
    from copy import deepcopy

    from hushh_mcp.services.pod_files.azure_checkpoint import AzureFilesUpgradeCheckpoint
    from hushh_mcp.services.pod_files.capability_update import FilesCapabilityChanged
    from tests.fixtures.azure_files_upgrade import approved_update_fixture

    backend, target, plan, row, role_call, checkpoint, receipts, spec = approved_update_fixture(
        arm, monkeypatch
    )
    before = deepcopy(arm.resources[backend.app_id])
    arm.resources[plan.storageId]["properties"]["allowBlobPublicAccess"] = True
    arm.calls.clear()
    with jit_person_authority("person-jit-token"):
        with pytest.raises(FilesCapabilityChanged, match="private storage"):
            await backend.upgrade(spec)
    assert not arm.writes() and not _Handoff.events and not receipts
    arm.resources[plan.storageId]["properties"]["allowBlobPublicAccess"] = False
    if reconciled_prefix:
        from tests.fixtures.azure_files_upgrade import seed_verified_prefix

        spec = seed_verified_prefix(arm, plan, checkpoint, spec)
    with jit_person_authority("person-jit-token"):
        handle = await backend.upgrade(spec)
    assert checkpoint.complete and len(receipts) == (4 if reconciled_prefix else 8)
    if reconciled_prefix:
        assert {path for method, path in arm.writes() if method == "PUT"} == {
            backend.app_id,
            *(call["path"] for call in plan.operations()[2:]),
        }
    role_observation = next(
        entry["observation"]
        for entry in receipts[-1][0]["completed"]
        if entry["observation"]["kind"] == "role_definition"
    )
    assert role_observation["id"] == role_call["path"]
    assert all(entry[1]["version"] == "azure.files.inventory.v1" for entry in receipts)
    assert handle.backend_metadata["filesCapability"] == {
        "planDigest": plan.digest,
        "status": "enabled",
    }
    after = arm.resources[backend.app_id]
    assert (
        after["properties"]["template"]["containers"][0]["resources"]
        == before["properties"]["template"]["containers"][0]["resources"]
    )
    assert after["identity"] == before["identity"]
    assert after["properties"]["configuration"] == before["properties"]["configuration"]
    plan.require_installed(after)
    recovered = await backend.discover_files_upgrade_ack(spec)
    assert recovered["attemptId"] == "f" * 64
    assert (await backend.observe_upgrade(spec, recovered)).backend_metadata["filesCapability"][
        "status"
    ] == "enabled"
    assert not any(event[0] == "release" for event in _Handoff.events)
    last = deepcopy(receipts[-1][0])
    last["completed"][-1]["observation"]["properties"]["principalId"] = "foreign"
    with pytest.raises(ValueError, match="approved resource"):
        AzureFilesUpgradeCheckpoint(
            plan=plan,
            operation_id="op-files",
            attempt_id="f" * 64,
            original_inventory={},
            previous=last,
        )


@pytest.mark.parametrize(
    "change",
    [
        "subscription",
        "guid",
        "foreign_group",
        "tenant",
        "url",
        "dot_path",
        "encoded_path",
        "scope",
        "actions",
        "notActions",
        "dataActions",
        "notDataActions",
        "type",
        "queue_alias",
        "assignment_alias",
    ],
)
def test_files_canonical_role_readback_preserves_exact_authority(arm, change):  # noqa: F811
    from copy import deepcopy

    from hushh_mcp.services.pod_files.azure_checkpoint import qualify_readback
    from tests.test_user_azure_backend import _OLD, _SOURCE, _SUB

    backend = _backend(arm)
    plan, _ = _files_plan(arm, backend, f"{_SOURCE}@{_OLD}")
    calls = plan.operations()
    kind = {"queue_alias": "queue", "assignment_alias": "role_assignment"}.get(
        change, "role_definition"
    )
    call = next(
        c for c in calls if (c["step"] == "files_queue" if kind == "queue" else c["kind"] == kind)
    )
    value = {"id": call["path"], "properties": deepcopy(call["body"]["properties"])}
    canonical = plan.scopes.role_definition(call["path"].rsplit("/", 1)[-1])
    if kind == "role_definition":
        value["id"] = canonical
        assert qualify_readback(call, value)["id"] == call["path"]
    replacements = {
        "subscription": canonical.replace(_SUB, "33333333-3333-3333-3333-333333333333"),
        "guid": canonical.rsplit("/", 1)[0] + "/33333333-3333-3333-3333-333333333333",
        "foreign_group": call["path"].replace(plan.resourceGroup, "foreign-group"),
        "tenant": canonical[canonical.index("/providers/") :],
        "url": "https://management.azure.com" + canonical,
        "dot_path": canonical.replace("/providers/", "/./providers/"),
        "encoded_path": canonical.replace("/providers/", "/%70roviders/"),
        "queue_alias": canonical,
        "assignment_alias": canonical,
    }
    if change in replacements:
        value["id"] = replacements[change]
    elif change == "scope":
        value["properties"]["assignableScopes"] = [f"/subscriptions/{_SUB}"]
    elif change == "type":
        value["properties"]["type"] = "BuiltInRole"
    else:
        value["properties"]["permissions"][0].setdefault(change, []).append("*")
    with pytest.raises(ValueError):
        qualify_readback(call, value)
