"""The pod's own crypto-erase: key first, every chained object, idempotent, fenced.

On an owner cloud only the pod's identity can delete its key and objects, so an
erasure that reports done must actually have destroyed them, and a retry after a
crash must finish without the key it already destroyed. Each refusal below is a
case where deleting would act on the wrong attempt or on an unfenced agent.
"""

from __future__ import annotations

import base64
import json

import pytest
from fastapi import HTTPException

from hushh_mcp.services.pod_commit_log import (
    GcsObjectStore,
    LocalObjectStore,
    PodCommitLog,
    PodLogFenced,
    PodLogTampered,
)
from hushh_mcp.services.pod_crypto_erase import (
    ERASED_MEMORY_RECORD,
    ERASURE_TOMBSTONE_OBJECT,
    PodCryptoEraseRefused,
    crypto_erase,
)
from hushh_mcp.services.pod_identity_store import IDENTITY_KEY_OBJECT
from hushh_mcp.services.pod_memory_bank import MEMORY_BANK_RECORD_KEY
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
    assert recorded.deleted[0] == WRAPPED
    records = [key for key in recorded.deleted if key.startswith("records/")]
    assert len(records) == 3 and counts["records"] == 3
    assert counts["deleted"] == 5  # key, identity, three records
    assert counts["deleted"] + counts["alreadyAbsent"] == len(recorded.deleted)
    for key in recorded.deleted:
        assert await store.get(key) is None
    assert await store.get(ERASURE_TOMBSTONE_OBJECT) is not None  # the durable marker
    # The fences are closed, never deleted: neither object is in the delete order.
    assert PodCommitLog.HEAD not in recorded.deleted
    assert MEMORY_BANK_RECORD_KEY not in recorded.deleted
    assert await store.get(MEMORY_BANK_RECORD_KEY) == ERASED_MEMORY_RECORD
    assert OWNER.encode() not in ERASED_MEMORY_RECORD


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
    assert finished["records"] == 3
    with pytest.raises(PodLogFenced):  # the head is still the sealed fence
        await log.append("memory", {"n": "after-erase"})
    again = await crypto_erase(
        store=store, owner_id=OWNER, attempt_id=ATTEMPT, wrapped_key_object=WRAPPED,
        open_fenced_log=_never,
    )  # fmt: skip
    assert again["deleted"] == 0 and again["records"] == 3


async def test_a_live_process_cannot_write_after_the_erase(store):
    """Hussh cannot stop the container: the process that still holds the key in memory
    must find the log and memory admission closed, before and after a retry."""
    log = await _agent(store)
    counts = await crypto_erase(
        store=store, owner_id=OWNER, attempt_id=ATTEMPT, wrapped_key_object=WRAPPED,
        open_fenced_log=_fencer(log),
    )  # fmt: skip
    for _ in range(2):  # the erase, then a retry from the tombstone
        with pytest.raises(PodLogFenced):
            await log.append("memory", {"n": "after-erase"})
        with pytest.raises(PodLogFenced):
            await log.replay()
        assert await store.get(MEMORY_BANK_RECORD_KEY) == ERASED_MEMORY_RECORD
        assert await _surviving_records(store) == []
        again = await crypto_erase(
            store=store, owner_id=OWNER, attempt_id=ATTEMPT, wrapped_key_object=WRAPPED,
            open_fenced_log=_never,
        )  # fmt: skip
        assert again == {**counts, "deleted": 0, "alreadyAbsent": 5 + counts["records"]}


async def _surviving_records(store) -> list[str]:
    listed = json.loads(await store.get(ERASURE_TOMBSTONE_OBJECT))["records"]
    return [key for key in listed if await store.get(key) is not None]


async def test_closed_memory_bookkeeping_is_refused_by_every_memory_reader(tmp_path):
    from hushh_mcp.services import pod_memory_bank

    cfg = pod_memory_bank.MemoryBankConfig(
        project="p", location="us-central1", display_name=f"one-pod-memory-{OWNER}", engine_id=None
    )
    with pytest.raises(pod_memory_bank.MemoryBankUnavailable):
        pod_memory_bank._decode_record(ERASED_MEMORY_RECORD, cfg)
    store = LocalObjectStore(str(tmp_path))
    log = await _agent(store)
    await crypto_erase(
        store=store, owner_id=OWNER, attempt_id=ATTEMPT, wrapped_key_object=WRAPPED,
        open_fenced_log=_fencer(log),
    )  # fmt: skip
    with pytest.raises(pod_memory_bank.MemoryBankUnavailable):
        await pod_memory_bank.fence_memory_bank_admission(
            store=store, log=log, owner_id=OWNER, attempt_id=ATTEMPT
        )


async def test_a_missing_head_is_closed_and_an_open_head_refuses_the_retry(tmp_path):
    store = LocalObjectStore(str(tmp_path))
    log = await _agent(store)
    await crypto_erase(
        store=store, owner_id=OWNER, attempt_id=ATTEMPT, wrapped_key_object=WRAPPED,
        open_fenced_log=_fencer(log),
    )  # fmt: skip
    # Someone removed the head: the retry closes it rather than leave it absent.
    await store.delete(PodCommitLog.HEAD)
    await crypto_erase(
        store=store, owner_id=OWNER, attempt_id=ATTEMPT, wrapped_key_object=WRAPPED,
        open_fenced_log=_never,
    )  # fmt: skip
    with pytest.raises(PodLogTampered):
        await log.append("memory", {"n": "after-erase"})
    # A head a live process could extend is never reported as erased.
    await store.delete(PodCommitLog.HEAD)
    await log.append("memory", {"n": "restarted"})
    with pytest.raises(PodCryptoEraseRefused):
        await crypto_erase(
            store=store, owner_id=OWNER, attempt_id=ATTEMPT, wrapped_key_object=WRAPPED,
            open_fenced_log=_never,
        )  # fmt: skip


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
    assert await store.get(WRAPPED) is None
    assert await store.get(MEMORY_BANK_RECORD_KEY) == ERASED_MEMORY_RECORD
    with pytest.raises(PodLogFenced):  # the fence the route closed is still closed
        await PodCommitLog(store, KEY, owner_id=OWNER).append("memory", {"n": "late"})
    retry = await pod_migration.crypto_erase_pod(body, "Bearer proof")
    assert retry["erased"] is True and retry["deleted"] == 0
    with pytest.raises(HTTPException) as wrong_revision:
        await pod_migration.crypto_erase_pod(
            pod_migration.ErasureFenceRequest(**{**_payload(), "revision": "ca-hussh-one-pod--r0"}),
            "Bearer proof",
        )
    assert wrong_revision.value.status_code == 403


async def test_browser_intents_include_unpublished_and_forgotten_objects_before_key_deletion(store):
    log = await _agent(store)
    keys = [f"browser/sessions/{char * 32}.bin" for char in ("a", "b")]
    for key in keys:
        await log.append(
            "browser_session_v1",
            {"operation": "intent", "site": "c" * 64, "generation": 0, "object": key},
        )
        await store.put(key, b"sealed-fixture")
    await log.append(
        "browser_session_v1", {"operation": "forget", "site": "c" * 64, "generation": 1}
    )
    recorded = _Recording(store, fail_at=1)
    with pytest.raises(RuntimeError):
        await crypto_erase(
            store=recorded,
            owner_id=OWNER,
            attempt_id=ATTEMPT,
            wrapped_key_object=WRAPPED,
            open_fenced_log=_fencer(log),
        )
    raw = await store.get(ERASURE_TOMBSTONE_OBJECT)
    assert json.loads(raw)["browserObjects"] == keys
    assert recorded.deleted[0] == WRAPPED
    await crypto_erase(
        store=store,
        owner_id=OWNER,
        attempt_id=ATTEMPT,
        wrapped_key_object=WRAPPED,
        open_fenced_log=_never,
    )
    assert all([await store.get(key) is None for key in keys])


async def test_browser_erasure_inventory_cannot_delete_an_arbitrary_object(store):
    log = await _agent(store)
    await log.append("browser_session_v1", {"operation": "intent", "object": "keys/unrelated.bin"})
    with pytest.raises(PodCryptoEraseRefused, match="malformed"):
        await crypto_erase(
            store=store,
            owner_id=OWNER,
            attempt_id=ATTEMPT,
            wrapped_key_object=WRAPPED,
            open_fenced_log=_fencer(log),
        )
    assert await store.get(WRAPPED) == b"wrapped-dek"
    assert await store.get(ERASURE_TOMBSTONE_OBJECT) is None


@pytest.mark.parametrize("provider_status", [200, 503])
async def test_provider_receipts_survive_key_erasure_and_retries_without_secret_copies(
    store, monkeypatch, provider_status
):
    from hushh_mcp.services import pod_connector_credentials as credentials
    from hushh_mcp.services import pod_google_oauth as oauth
    from tests.pod_connector_harness import SCOPES, credential

    log = await _agent(store)
    gmail = credential("gmail", SCOPES["gmail_manage"])
    monkeypatch.setenv("GOOGLE_IOS_CONNECTOR_CLIENT_ID", gmail.client_id)
    calendar = credential("calendar", SCOPES["calendar"])
    await log.append(credentials.RECORD_KIND, credentials._payload(OWNER, gmail))
    await log.append(credentials.RECORD_KIND, credentials._payload(OWNER, calendar))
    calls = []

    async def provider(url, form):
        assert await store.get(WRAPPED) is not None, "revocation precedes key destruction"
        assert url == oauth.REVOKE_URL
        calls.append(form)
        return provider_status, {}

    counts = await crypto_erase(
        store=store,
        owner_id=OWNER,
        attempt_id=ATTEMPT,
        wrapped_key_object=WRAPPED,
        open_fenced_log=_fencer(log),
        provider_post=provider,
    )
    assert await store.get(WRAPPED) is None, "provider outage cannot retain local owner information"
    assert len(calls) == 1, "one project/account grant, even across connectors"
    assert counts["providerRevoked"] == int(provider_status == 200)
    assert counts["providerUnconfirmed"] == int(provider_status != 200)
    assert counts["providerUnavailable"] == 0
    raw = await store.get(ERASURE_TOMBSTONE_OBJECT)
    body = json.loads(raw)
    assert body["version"] == 3
    assert len(body["providerRevocations"]["receipts"]) == 1
    for private_value in (gmail.refresh_token, gmail.account_subject, gmail.client_id):
        assert private_value.encode() not in raw
    retry = await crypto_erase(
        store=store,
        owner_id=OWNER,
        attempt_id=ATTEMPT,
        wrapped_key_object=WRAPPED,
        open_fenced_log=_never,
        provider_post=provider,
    )
    assert len(calls) == 1 and retry["deleted"] == 0
    assert {name: retry[name] for name in counts if name.startswith("provider")} == {
        name: counts[name] for name in counts if name.startswith("provider")
    }


@pytest.mark.parametrize("version", [1, 2])
async def test_legacy_tombstones_remain_readable_and_do_not_claim_provider_completion(
    store, version
):
    from hushh_mcp.services.pod_crypto_erase import _owner_digest

    body = {
        "kind": "pod_crypto_erase_v1",
        "version": version,
        "ownerDigest": _owner_digest(OWNER),
        "attemptId": ATTEMPT,
        "records": [],
    }
    if version == 2:
        body["browserObjects"] = []
    await store.put(ERASURE_TOMBSTONE_OBJECT, json.dumps(body).encode())
    counts = await crypto_erase(
        store=store,
        owner_id=OWNER,
        attempt_id=ATTEMPT,
        wrapped_key_object=WRAPPED,
        open_fenced_log=_never,
    )
    assert counts["providerUnavailable"] == 1 and counts["providerRevoked"] == 0


@pytest.mark.parametrize(
    "invalid",
    [
        {"revoked": True, "unrevoked": 0, "unavailable": 0, "receipts": []},
        {"revoked": 1, "unrevoked": 0, "unavailable": 0, "receipts": []},
        {"revoked": 0, "unrevoked": 0, "unavailable": 0, "receipts": [], "token": "never-store"},
        {
            "revoked": 1,
            "unrevoked": 0,
            "unavailable": 0,
            "receipts": [
                {
                    "provider": "google",
                    "grantDigest": "a" * 64,
                    "outcome": "confirmed",
                    "refreshToken": "never-store",
                }
            ],
        },
    ],
)
async def test_provider_tombstone_receipts_are_strictly_bounded_metadata(store, invalid):
    from hushh_mcp.services.pod_crypto_erase import _owner_digest

    await store.put(WRAPPED, b"existing-key")
    body = {
        "kind": "pod_crypto_erase_v1",
        "version": 3,
        "ownerDigest": _owner_digest(OWNER),
        "attemptId": ATTEMPT,
        "records": [],
        "browserObjects": [],
        "providerRevocations": invalid,
    }
    await store.put(ERASURE_TOMBSTONE_OBJECT, json.dumps(body).encode())
    with pytest.raises(PodCryptoEraseRefused, match="malformed"):
        await crypto_erase(
            store=store,
            owner_id=OWNER,
            attempt_id=ATTEMPT,
            wrapped_key_object=WRAPPED,
            open_fenced_log=_never,
        )
    assert await store.get(WRAPPED) == b"existing-key"
