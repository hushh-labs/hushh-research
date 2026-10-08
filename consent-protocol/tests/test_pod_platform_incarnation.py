"""The incarnation fences read the platform's own names, on either cloud.

Before this seam every fence read only ``K_SERVICE``/``K_REVISION``, which Azure
never sets, so an Azure pod refused every erasure request and bound handoff
receipts to its HusshID instead of its revision.
"""

from __future__ import annotations

import json
import os

import pytest
from fastapi import HTTPException

os.environ.setdefault("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
os.environ.setdefault("VAULT_DATA_KEY", "0" * 64)

from api.routes.one import pod_migration  # noqa: E402
from hushh_mcp.services.pod_azure_blob_store import AzureBlobObjectStore  # noqa: E402
from hushh_mcp.services.pod_commit_log import PodCommitLog, PodLogFenced  # noqa: E402
from hushh_mcp.services.pod_platform import (  # noqa: E402
    pod_revision_name,
    pod_service_name,
    workload_platform,
)
from hushh_mcp.services.pod_upgrade_admission import pod_incarnation  # noqa: E402
from tests.pod_azure_fakes import CONTAINER_URL, FakeBlobService  # noqa: E402

_PLATFORM = ("K_SERVICE", "K_REVISION", "CONTAINER_APP_NAME", "CONTAINER_APP_REVISION")


@pytest.fixture
def clean(monkeypatch):
    for name in (*_PLATFORM, "HUSSH_POD_INCARNATION"):
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


def test_cloud_run_names_its_service_and_revision(clean):
    clean.setenv("K_SERVICE", "one-pod-ha1")
    clean.setenv("K_REVISION", "one-pod-ha1-00007-abc")
    assert workload_platform() == "gcp"
    assert (pod_service_name(), pod_revision_name()) == ("one-pod-ha1", "one-pod-ha1-00007-abc")


def test_container_apps_names_its_app_and_revision(clean):
    clean.setenv("CONTAINER_APP_NAME", "one-pod-ha1")
    clean.setenv("CONTAINER_APP_REVISION", "one-pod-ha1--r7")
    assert workload_platform() == "azure"
    assert (pod_service_name(), pod_revision_name()) == ("one-pod-ha1", "one-pod-ha1--r7")


def test_off_platform_there_is_no_incarnation_name(clean):
    assert workload_platform() == "local"
    assert (pod_service_name(), pod_revision_name()) == ("", "")


def test_upgrade_receipts_bind_the_azure_revision_and_keep_the_override(clean):
    clean.setenv("HUSSH_ID", "ha1_owner")
    clean.setenv("CONTAINER_APP_NAME", "one-pod-ha1")
    clean.setenv("CONTAINER_APP_REVISION", "one-pod-ha1--r7")
    assert pod_incarnation() == "one-pod-ha1--r7"
    clean.setenv("HUSSH_POD_INCARNATION", "explicit-incarnation")
    assert pod_incarnation() == "explicit-incarnation"


def test_the_self_report_carries_the_azure_revision(clean):
    pod_server = pytest.importorskip("pod_server")
    clean.setenv("CONTAINER_APP_NAME", "one-pod-ha1")
    clean.setenv("CONTAINER_APP_REVISION", "one-pod-ha1--r7")
    assert pod_server._self_report()["revision"] == "one-pod-ha1--r7"


def _azure_log() -> PodCommitLog:
    store = AzureBlobObjectStore(
        CONTAINER_URL,
        session=FakeBlobService(),
        token_provider=lambda _resource: "synthetic-bearer",
        forget_token=lambda _resource: None,
    )
    return PodCommitLog(store, b"S" * 32, owner_id="ha1_owner")


@pytest.mark.parametrize("mismatch", [None, "service", "revision", "cloud_run_names"])
async def test_the_erasure_fence_admits_the_running_azure_incarnation(clean, mismatch):
    from hushh_mcp.services import scheduler_identity

    payload = dict(
        hushhId="ha1_owner",
        attemptId="attempt-1",
        service="one-pod-ha1",
        serviceUid="uid-1",
        revision="one-pod-ha1--r7",
    )
    clean.setenv("HUSSH_POD_MIGRATION_ENABLED", "1")
    clean.setenv("HUSSH_ID", "ha1_owner")
    clean.setenv("CONTAINER_APP_NAME", "one-pod-ha1")
    clean.setenv("CONTAINER_APP_REVISION", "one-pod-ha1--r7")
    if mismatch == "cloud_run_names":
        # A Cloud Run-shaped incarnation is not this pod's, even if those vars appear.
        clean.setenv("K_SERVICE", "one-pod-other")
        payload.update(service="one-pod-other")
    elif mismatch:
        payload[mismatch] = "foreign"
    expected_audience = pod_migration.erasure_proof_audience(payload)

    def verify(**kwargs):
        if kwargs["audience"] != expected_audience:
            raise scheduler_identity.SchedulerIdentityError("refused")

    clean.setattr(scheduler_identity, "verify_scheduler_request", verify)
    from hushh_mcp.services.pod_files import runtime as files_runtime

    clean.setattr(files_runtime, "_draining", False)  # the fence drains Files; restore after
    log = _azure_log()
    clean.setattr(pod_migration, "_commit_log", lambda: log)
    body = pod_migration.ErasureFenceRequest(**payload)
    if mismatch:
        with pytest.raises(HTTPException) as error:
            await pod_migration.fence_erasure(body, "Bearer proof")
        assert error.value.status_code == 403
        await log.require_open()
        return
    assert await pod_migration.fence_erasure(body, "Bearer proof") == {
        "status": "fenced",
        **payload,
    }
    from hushh_mcp.services.pod_memory_bank import MEMORY_BANK_RECORD_KEY

    record = json.loads(await log._store.get(MEMORY_BANK_RECORD_KEY))
    # Absent before the fence: the admission record persists the absent version as 0.
    assert record["erasure"]["priorGeneration"] == 0
    with pytest.raises(PodLogFenced):
        await log.replay()
