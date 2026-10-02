"""The pod's own crypto-erase: key first, every chained object, idempotent, fenced.

On an owner cloud only the pod's identity can delete its key and objects, so an
erasure that reports done must actually have destroyed them, and a retry after a
crash must finish without the key it already destroyed. Each refusal below is a
case where deleting would act on the wrong attempt or on an unfenced agent.
"""

from __future__ import annotations

import base64

import pytest
from fastapi import HTTPException

from hushh_mcp.services.pod_commit_log import (
    GcsObjectStore,
    LocalObjectStore,
    PodCommitLog,
    PodLogFenced,
)
from hushh_mcp.services.pod_crypto_erase import (
    ERASURE_TOMBSTONE_OBJECT,
    PodCryptoEraseRefused,
    crypto_erase,
)
from hushh_mcp.services.pod_identity_store import IDENTITY_KEY_OBJECT
from hushh_mcp.services.pod_object_version import ABSENT
from tests.pod_azure_fakes import FakeBlobService, FakeGcsService
from tests.test_pod_object_store_contract import _azure

OWNER, ATTEMPT = "ha1_owner", "erase-1"
WRAPPED = "keys/log-key.wrapped"
KEY = b"S" * 32


@pytest.fixture(params=["local", "gcs", "azure"])
def store(request, tmp_path):
    if request.param == "local":
        return LocalObjectStore(str(tmp_path))
    if request.param == "gcs":
        return GcsObjectStore("pod-bucket", "pods/ha1", session=FakeGcsService())
    return _azure(FakeBlobService())[0]


class _Recording:
    """Records delete order; ``fail_at`` refuses the n-th delete like a storage outage."""

    def __init__(self, inner, fail_at: int | None = None) -> None:
        self._inner, self.fail_at, self.deleted = inner, fail_at, []

    def __getattr__(self, name):
        return getattr(self._inner, name)

    async def delete(self, key: str) -> bool:
        if self.fail_at is not None and len(self.deleted) == self.fail_at:
            raise RuntimeError("pod storage delete unconfirmed")
        self.deleted.append(key)
        return await self._inner.delete(key)


async def _agent(store) -> PodCommitLog:
    log = PodCommitLog(store, KEY, owner_id=OWNER)
    await store.put_if_generation(WRAPPED, b"wrapped-dek", ABSENT)
    await store.put_if_generation(IDENTITY_KEY_OBJECT, b"sealed-identity", ABSENT)
    for index in range(3):
        await log.append("memory", {"n": index})
    return log


def _fencer(log: PodCommitLog, attempt: str = ATTEMPT):
    async def open_fenced_log() -> PodCommitLog:
        await log.fence_for_erasure(owner_id=OWNER, attempt_id=attempt)
        return log

    return open_fenced_log


async def _never() -> PodCommitLog:  # pragma: no cover - a retry must not need the key
    raise AssertionError("the retry reopened the log after its key was destroyed")


async def test_the_key_goes_first_and_every_chained_object_follows(store):
    log = await _agent(store)
    recorded = _Recording(store)
    counts = await crypto_erase(
        store=recorded, owner_id=OWNER, attempt_id=ATTEMPT, wrapped_key_object=WRAPPED,
        open_fenced_log=_fencer(log),
    )  # fmt: skip
    assert recorded.deleted[0] == WRAPPED and recorded.deleted[-1] == PodCommitLog.HEAD
    records = [key for key in recorded.deleted if key.startswith("records/")]
    assert len(records) == 3 and counts["records"] == 3
    assert counts["deleted"] == 6  # key, identity, three records, head
    assert counts["deleted"] + counts["alreadyAbsent"] == len(recorded.deleted)
    for key in recorded.deleted:
        assert await store.get(key) is None
    assert await store.get(ERASURE_TOMBSTONE_OBJECT) is not None  # the durable marker


async def test_a_retry_after_a_crash_finishes_from_the_tombstone_without_the_key(store):
    log = await _agent(store)
    interrupted = _Recording(store, fail_at=3)
    with pytest.raises(RuntimeError):
        await crypto_erase(
            store=interrupted, owner_id=OWNER, attempt_id=ATTEMPT, wrapped_key_object=WRAPPED,
            open_fenced_log=_fencer(log),
        )  # fmt: skip
    assert await store.get(WRAPPED) is None  # crypto-erased before the outage
    finished = await crypto_erase(
        store=store, owner_id=OWNER, attempt_id=ATTEMPT, wrapped_key_object=WRAPPED,
        open_fenced_log=_never,
    )  # fmt: skip
    assert finished["records"] == 3 and await store.get(PodCommitLog.HEAD) is None
    again = await crypto_erase(
        store=store, owner_id=OWNER, attempt_id=ATTEMPT, wrapped_key_object=WRAPPED,
        open_fenced_log=_never,
    )  # fmt: skip
    assert again["deleted"] == 0 and again["records"] == 3


async def test_a_log_fenced_for_another_attempt_erases_nothing(tmp_path):
    store = LocalObjectStore(str(tmp_path))
    log = await _agent(store)
    await log.fence_for_erasure(owner_id=OWNER, attempt_id="someone-elses-attempt")
    with pytest.raises(PodLogFenced):
        await crypto_erase(
            store=store, owner_id=OWNER, attempt_id=ATTEMPT, wrapped_key_object=WRAPPED,
            open_fenced_log=_fencer(log),
        )  # fmt: skip
    assert await store.get(WRAPPED) == b"wrapped-dek"
    assert await store.get(ERASURE_TOMBSTONE_OBJECT) is None


async def test_a_tombstone_from_another_attempt_or_owner_refuses(tmp_path):
    store = LocalObjectStore(str(tmp_path))
    log = await _agent(store)
    await crypto_erase(
        store=store, owner_id=OWNER, attempt_id=ATTEMPT, wrapped_key_object=WRAPPED,
        open_fenced_log=_fencer(log),
    )  # fmt: skip
    for owner, attempt in ((OWNER, "erase-2"), ("ha1_stranger", ATTEMPT)):
        with pytest.raises(PodCryptoEraseRefused):
            await crypto_erase(
                store=store, owner_id=owner, attempt_id=attempt, wrapped_key_object=WRAPPED,
                open_fenced_log=_never,
            )  # fmt: skip


# -- the route, behind the hub-proof erasure fence ------------------------------------


@pytest.fixture
def azure_pod(monkeypatch, tmp_path):
    """A pod on Container Apps: the incarnation is the platform's own pair."""
    from api.routes.one import pod_migration
    from hushh_mcp.services.pod_files import runtime as files_runtime

    monkeypatch.setattr(files_runtime, "_draining", False)
    monkeypatch.setenv("HUSSH_POD_MIGRATION_ENABLED", "1")
    monkeypatch.setenv("HUSSH_ID", OWNER)
    monkeypatch.setenv("CONTAINER_APP_NAME", "ca-hussh-one-pod")
    monkeypatch.setenv("CONTAINER_APP_REVISION", "ca-hussh-one-pod--r1")
    for name in ("K_SERVICE", "K_REVISION", "HUSSH_POD_KMS_KEY", "HUSSH_POD_KEY_VAULT_KEY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("POD_STORAGE_BACKEND", "commit_log")
    monkeypatch.setenv("POD_STORAGE_LOCAL_ROOT", str(tmp_path))
    monkeypatch.setenv("HUSSH_POD_LOG_KEY", base64.b64encode(KEY).decode())
    return pod_migration, LocalObjectStore(str(tmp_path))


def _payload() -> dict:
    return dict(
        hushhId=OWNER,
        attemptId=ATTEMPT,
        service="ca-hussh-one-pod",
        serviceUid="incarnation-1",
        revision="ca-hussh-one-pod--r1",
    )


@pytest.mark.parametrize("purpose", ["fence", "memory-binding"])
async def test_only_a_crypto_erase_proof_reaches_the_storage(azure_pod, monkeypatch, purpose):
    from hushh_mcp.services import scheduler_identity

    pod_migration, store = azure_pod
    await _agent(store)
    granted = pod_migration.erasure_proof_audience(_payload(), purpose=purpose)

    def verify(**kwargs):
        if kwargs["audience"] != granted:
            raise scheduler_identity.SchedulerIdentityError("refused")

    monkeypatch.setattr(scheduler_identity, "verify_scheduler_request", verify)
    body = pod_migration.ErasureFenceRequest(**_payload())
    with pytest.raises(HTTPException) as refused:
        await pod_migration.crypto_erase_pod(body, "Bearer proof")
    assert refused.value.status_code == 403
    assert await store.get(WRAPPED) == b"wrapped-dek"


async def test_the_route_fences_erases_and_answers_a_retry_identically(azure_pod, monkeypatch):
    pod_migration, store = azure_pod
    await _agent(store)
    expected = pod_migration.erasure_proof_audience(_payload(), purpose="crypto-erase")

    def hub_caller(_proof, audience=None) -> None:
        if audience != expected:
            raise HTTPException(status_code=403, detail="migration refused")

    monkeypatch.setattr(pod_migration, "_require_hub_caller", hub_caller)
    body = pod_migration.ErasureFenceRequest(**_payload())
    first = await pod_migration.crypto_erase_pod(body, "Bearer proof")
    assert {key: first[key] for key in ("status", "erased", "records")} == {
        "status": "erased",
        "erased": True,
        "records": 3,
    }
    assert {key: first[key] for key in _payload()} == _payload()
    assert await store.get(WRAPPED) is None and await store.get(PodCommitLog.HEAD) is None
    retry = await pod_migration.crypto_erase_pod(body, "Bearer proof")
    assert retry["erased"] is True and retry["deleted"] == 0
    with pytest.raises(HTTPException) as wrong_revision:
        await pod_migration.crypto_erase_pod(
            pod_migration.ErasureFenceRequest(**{**_payload(), "revision": "ca-hussh-one-pod--r0"}),
            "Bearer proof",
        )
    assert wrong_revision.value.status_code == 403
