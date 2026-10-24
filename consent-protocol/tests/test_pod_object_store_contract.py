"""One ObjectStore contract, three stores: local, GCS and Azure Blob.

The sealed commit log, the identity key, the incarnation fence and the wrapped log
key all ride on the same four calls. Each store must give identical answers, with
opaque string versions, or the log would behave differently per cloud, and the
dangerous difference is the one between "lost the race" and "refused".
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.pod_azure_blob_store import (
    AzureBlobObjectStore,
    PodBlobStorageError,
    PodBlobStorageForbidden,
    parse_blob_container_url,
)
from hushh_mcp.services.pod_commit_log import GcsObjectStore, LocalObjectStore, PodCommitLog
from hushh_mcp.services.pod_object_version import ABSENT
from tests.pod_azure_fakes import CONTAINER_URL, FakeBlobService, FakeGcsService, _error

KEY = b"K" * 32


class _Tokens:
    def __init__(self) -> None:
        self.resources: list[str] = []
        self.forgotten: list[str] = []

    def __call__(self, resource: str) -> str:
        self.resources.append(resource)
        return f"bearer-{len(self.resources)}"

    def forget(self, resource: str) -> None:
        self.forgotten.append(resource)


def _azure(blob: FakeBlobService | None = None, tokens: _Tokens | None = None):
    tokens = tokens or _Tokens()
    store = AzureBlobObjectStore(
        CONTAINER_URL,
        session=blob or FakeBlobService(),
        token_provider=tokens,
        forget_token=tokens.forget,
    )
    return store, tokens


@pytest.fixture(params=["local", "gcs", "azure"])
def store(request, tmp_path):
    if request.param == "local":
        return LocalObjectStore(str(tmp_path))
    if request.param == "gcs":
        return GcsObjectStore("pod-bucket", "pods/ha1", session=FakeGcsService())
    return _azure()[0]


async def test_absence_is_the_absent_version(store):
    assert await store.get_with_generation("head.json") == (None, ABSENT)
    assert await store.get("head.json") is None


@pytest.mark.parametrize(
    "outcome",
    [
        "complete",
        "incomplete",
        "cancel_completed",
        "uncertain_cancel",
        "invalidated",
        "expired",
        "lost_cancel",
    ],
)
async def test_shared_resumable_recovery_requires_provider_terminal_proof(monkeypatch, outcome):
    import hashlib
    import uuid
    from unittest.mock import AsyncMock

    from hushh_mcp.services.shared_files import bucket_admission, write_receipts, writes

    body = b"synthetic-encrypted-file-content"
    receipt = {
        "protocol": 2,
        "state": "uncertain",
        "path": "a" * 64 + "/" + "b" * 64,
        "digest": hashlib.sha256(body).hexdigest(),
        "byteCount": len(body),
        "expectedGeneration": "",
        "session": {"ciphertext": "sealed"},
    }
    row = {
        "user_id": "alice",
        "library_id": str(uuid.uuid4()),
        "bucket": "synthetic-files",
        "state": "active",
    }
    transitions = AsyncMock(return_value=True)
    monkeypatch.setattr(write_receipts, "transition", transitions)
    monkeypatch.setattr(write_receipts, "restore", lambda *args: "private-session-memory-only")
    monkeypatch.setattr(bucket_admission, "observe", AsyncMock(return_value={}))
    monkeypatch.setattr(bucket_admission, "verify", lambda *args: None)
    store = type("Store", (), {})()
    store.status = AsyncMock(
        return_value="invalidated"
        if outcome == "invalidated"
        else "uncertain"
        if outcome in {"expired", "uncertain_cancel"}
        else "complete"
        if outcome == "complete"
        else "incomplete"
    )
    store.cancel = AsyncMock(return_value=outcome != "expired")
    if outcome == "lost_cancel":
        store.cancel.side_effect = TimeoutError("synthetic lost response")
    store.get_bounded_with_generation = AsyncMock(
        return_value=(body, "3") if outcome in {"complete", "cancel_completed"} else (None, "")
    )
    if outcome == "lost_cancel":
        with pytest.raises(TimeoutError):
            await writes.reconcile(store, row, "operation", receipt)
    else:
        await writes.reconcile(store, row, "operation", receipt)
    terminal = [call for call in transitions.await_args_list if call.args[3] is None]
    assert bool(terminal) == (
        outcome in {"complete", "incomplete", "cancel_completed", "uncertain_cancel", "invalidated"}
    )
    if outcome == "invalidated":
        store.cancel.assert_not_awaited()
    if outcome == "expired":
        store.cancel.assert_awaited_once_with("private-session-memory-only", receipt["path"])
        store.get_bounded_with_generation.assert_not_awaited()
    assert transitions.await_args_list[-1].args[3]["state"] == "uncertain"


async def test_shared_upload_retains_cancel_proof_across_failed_verification(monkeypatch):
    import hashlib
    import uuid
    from unittest.mock import AsyncMock

    from hushh_mcp.services.pod_files.contracts import FilesRefused
    from hushh_mcp.services.shared_files import bucket_admission, write_receipts, writes

    body = b"synthetic-encrypted-file-content"
    receipt = {
        "protocol": 2,
        "state": "uncertain",
        "path": "a" * 64 + "/" + "b" * 64,
        "digest": hashlib.sha256(body).hexdigest(),
        "byteCount": len(body),
        "expectedGeneration": "",
        "session": {"ciphertext": "sealed"},
    }
    row = {
        "user_id": "alice",
        "library_id": str(uuid.uuid4()),
        "bucket": "synthetic-files",
        "state": "active",
    }
    current = receipt

    async def transition(_row, _operation, previous, replacement, **kwargs):
        nonlocal current
        if current != previous:
            return False
        current = replacement
        return True

    monkeypatch.setattr(write_receipts, "transition", transition)
    monkeypatch.setattr(write_receipts, "restore", lambda *args: "private-session-memory-only")
    monkeypatch.setattr(bucket_admission, "observe", AsyncMock(return_value={}))
    monkeypatch.setattr(bucket_admission, "verify", lambda *args: None)
    store = type("Store", (), {})()
    store.status = AsyncMock(return_value="uncertain")
    store.cancel = AsyncMock(return_value=True)
    store.get_bounded_with_generation = AsyncMock(
        side_effect=TimeoutError("synthetic read failure")
    )
    with pytest.raises(TimeoutError):
        await writes.reconcile(store, row, "operation", current)
    assert current["providerTerminal"] == "cancelled"
    assert current["state"] == "uncertain"

    # The already-cancelled provider session cannot supply another receipt.
    store.status.side_effect = AssertionError("terminal proof must survive restart")
    store.cancel.side_effect = AssertionError("do not repeat cancellation after confirmed receipt")
    store.get_bounded_with_generation.side_effect = None
    store.get_bounded_with_generation.return_value = (body, "3")

    def changed_bucket(*args):
        raise FilesRefused("FILES_BUCKET_CHANGED", 409)

    monkeypatch.setattr(bucket_admission, "verify", changed_bucket)
    with pytest.raises(FilesRefused, match="FILES_BUCKET_CHANGED"):
        await writes.reconcile(store, row, "operation", current)
    assert current["providerTerminal"] == "cancelled"
    monkeypatch.setattr(bucket_admission, "verify", lambda *args: None)
    await writes.reconcile(store, row, "operation", current)
    assert current is None
    store.cancel.assert_awaited_once()


@pytest.mark.parametrize(
    "bad_uri",
    [
        "http://storage.googleapis.com/upload/storage/v1/b/synthetic-files/o?uploadType=resumable&upload_id=x",
        "https://metadata.google.internal/upload/storage/v1/b/synthetic-files/o?uploadType=resumable&upload_id=x",
        "https://storage.googleapis.com/upload/storage/v1/b/other-owner/o?uploadType=resumable&upload_id=x",
    ],
)
async def test_shared_upload_refuses_unbound_session_destination_without_request(bad_uri):
    from hushh_mcp.services.pod_files.contracts import FilesRefused
    from hushh_mcp.services.shared_files.uploads import SharedCipherStore

    class Transport:
        def put(self, *args, **kwargs):
            raise AssertionError("An unbound destination must never receive a request")

    store = SharedCipherStore("synthetic-files", "owner/library", session=Transport())
    with pytest.raises(FilesRefused, match="FILES_UPLOAD_SESSION_INVALID"):
        await store.send(bad_uri, "opaque", b"K" * 28)


@pytest.mark.parametrize(
    "status, expected", [(410, "invalidated"), (404, "missing"), (412, "uncertain")]
)
async def test_shared_upload_only_provider_expiry_proves_session_invalidation(
    monkeypatch, status, expected
):
    from hushh_mcp.services.shared_files.uploads import SharedCipherStore
    from tests.pod_azure_fakes import FakeResponse

    response = FakeResponse(status)

    class Transport:
        def put(self, url, **kwargs):
            assert kwargs["allow_redirects"] is False
            return response

    store = SharedCipherStore("synthetic-files", "owner/library", session=Transport())
    monkeypatch.setattr(store, "_headers", lambda: {})
    uri = "https://storage.googleapis.com/upload/storage/v1/b/synthetic-files/o?uploadType=resumable&upload_id=synthetic-session"
    assert await store.status(uri, "opaque", 28) == expected


async def test_shared_upload_session_bearer_is_excluded_from_http_instrumentation(monkeypatch):
    import json

    from opentelemetry.instrumentation.utils import is_http_instrumentation_enabled

    from hushh_mcp.services.shared_files.uploads import SharedCipherStore
    from tests.pod_azure_fakes import FakeResponse

    class Transport:
        def put(self, url, **kwargs):
            assert not is_http_instrumentation_enabled(), "Provider session URI reached tracing"
            assert kwargs["allow_redirects"] is False and kwargs["stream"] is True
            return FakeResponse(
                200,
                content=json.dumps(
                    {"name": "owner/library/opaque", "generation": "123", "size": "28"}
                ).encode(),
            )

    store = SharedCipherStore("synthetic-files", "owner/library", session=Transport())
    monkeypatch.setattr(store, "_headers", lambda: {})
    uri = "https://storage.googleapis.com/upload/storage/v1/b/synthetic-files/o?uploadType=resumable&upload_id=synthetic-session"
    assert await store.send(uri, "opaque", b"K" * 28) == "123"


async def test_bounded_snapshot_keeps_version_and_refuses_oversize(store):
    from hushh_mcp.services.pod_bounded_object import ObjectReadTooLarge

    assert await store.get_bounded_with_generation("projection", max_bytes=4) == (None, ABSENT)
    first = await store.put_if_generation("projection", b"four", ABSENT)
    body, version = await store.get_bounded_with_generation("projection", max_bytes=4)
    assert (body, version) == (b"four", first)
    with pytest.raises(ObjectReadTooLarge):
        await store.get_bounded_with_generation("projection", max_bytes=3)
    second = await store.put_if_generation("projection", b"next", version)
    assert second and await store.put_if_generation("projection", b"stale", version) is None


async def test_bounded_blob_never_materializes_response_content():
    from hushh_mcp.services.pod_bounded_object import ObjectReadTooLarge

    class Stream:
        status_code = 200
        headers = {"ETag": '"bounded"'}
        closed = False

        @property
        def content(self):
            raise AssertionError("Unbounded body read")

        def iter_content(self, chunk_size):
            yield b"small"
            yield b"overflow"
            raise AssertionError("Read beyond bound")

        def close(self):
            self.closed = True

    service, response = FakeBlobService(), Stream()
    service.scripted.append(("get", response))
    with pytest.raises(ObjectReadTooLarge):
        await _azure(service)[0].get_bounded_with_generation("projection", max_bytes=5)
    assert response.closed


async def test_create_only_wins_once_then_reports_a_lost_race(store):
    first = await store.put_if_generation("keys/identity.bin", b"winner", ABSENT)
    assert isinstance(first, str) and first
    assert await store.put_if_generation("keys/identity.bin", b"loser", ABSENT) is None
    assert await store.get_with_generation("keys/identity.bin") == (b"winner", first)
    with pytest.raises(FileExistsError):
        await store.put("keys/identity.bin", b"again")


async def test_compare_and_swap_succeeds_on_current_and_fails_on_stale(store):
    first = await store.put_if_generation("head.json", b"one", ABSENT)
    second = await store.put_if_generation("head.json", b"two", first)
    assert isinstance(second, str) and second not in ("", first)
    assert await store.put_if_generation("head.json", b"stale", first) is None
    assert await store.get_with_generation("head.json") == (b"two", second)


async def test_delete_removes_once_then_reports_already_gone(store):
    await store.put_if_generation("keys/log-key.wrapped", b"sealed", ABSENT)
    assert await store.delete("keys/log-key.wrapped") is True
    assert await store.get_with_generation("keys/log-key.wrapped") == (None, ABSENT)
    assert await store.delete("keys/log-key.wrapped") is False
    with pytest.raises(ValueError):
        await store.delete("../ha2/keys/log-key.wrapped")


async def test_a_refused_gcs_delete_is_a_failure_never_already_gone():
    gcs = FakeGcsService()
    store = GcsObjectStore("pod-bucket", session=gcs)
    await store.put_if_generation("head.json", b"x", ABSENT)
    gcs.refuse_delete = True
    with pytest.raises(RuntimeError, match="delete unconfirmed"):
        await store.delete("head.json")
    assert gcs.metadata_calls == 2  # re-minted once, then refused
    assert "head.json" in gcs.objects


async def test_integer_versions_of_the_retired_contract_are_refused(store):
    with pytest.raises((TypeError, ValueError)):
        await store.put_if_generation("head.json", b"x", 0)


async def test_the_sealed_log_appends_and_replays_identically_on_every_store(store):
    log = PodCommitLog(store, KEY, owner_id="ha1")
    for index in range(3):
        await log.append("memory", {"n": index})
    assert [record["payload"]["n"] for record in await log.replay()] == [0, 1, 2]
    await log.fence_for_erasure(owner_id="ha1", attempt_id="erase-1")
    await log.require_fenced(owner_id="ha1", attempt_id="erase-1")


async def test_gcs_generations_are_their_decimal_text():
    gcs = FakeGcsService()
    store = GcsObjectStore("pod-bucket", session=gcs)
    created = await store.put_if_generation("head.json", b"x", ABSENT)
    assert created.isdigit() and int(created) == gcs.objects["head.json"][1]


# -- Azure Blob, as measured ---------------------------------------------------------


def test_blob_reuses_worker_connections_without_reusing_authority(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor

    import requests

    blob, tokens, pools = FakeBlobService(), _Tokens(), []
    session_type = requests.Session

    class Session(session_type):
        def __init__(self):
            super().__init__()
            pools.append(self)

        def request(self, method, url, **kwargs):
            return getattr(blob, method.lower())(url, **kwargs)

    monkeypatch.setattr(requests, "Session", Session)
    monkeypatch.setattr(requests.sessions, "Session", Session)
    store = AzureBlobObjectStore(CONTAINER_URL, token_provider=tokens, forget_token=tokens.forget)
    version = store.put_if_generation_blocking("head.json", b"sealed", ABSENT)
    assert store.get_with_generation_blocking("head.json") == (b"sealed", version)
    assert len(pools) == 1
    assert [row[2]["Authorization"] for row in blob.requests] == [
        "Bearer bearer-1",
        "Bearer bearer-2",
    ]
    assert "Authorization" not in pools[0].headers
    assert not pools[0].cookies.get_policy().set_ok(None, None)
    assert not pools[0].cookies.get_policy().return_ok(None, None)

    with ThreadPoolExecutor(max_workers=1) as worker:
        assert worker.submit(store.get_with_generation_blocking, "head.json").result() == (
            b"sealed",
            version,
        )
    assert len(pools) == 2  # mutable Sessions never cross workers
    other = AzureBlobObjectStore(CONTAINER_URL, token_provider=_Tokens())
    assert other.get_with_generation_blocking("head.json") == (b"sealed", version)
    assert len(pools) == 3  # another store has no ambient credentials or pool
    blob.scripted += [("get", _error(403, "AuthorizationPermissionMismatch"))] * 2
    with pytest.raises(PodBlobStorageForbidden):
        store.get_with_generation_blocking("head.json")
    assert tokens.forgotten == ["https://storage.azure.com"]
    assert len(pools) == 3  # fresh auth/refusal checks still use the same connection pool


async def test_blob_create_only_sends_if_none_match_and_maps_409_to_a_lost_race():
    blob = FakeBlobService()
    store, tokens = _azure(blob)
    await store.put_if_generation("k.bin", b"a", ABSENT)
    assert await store.put_if_generation("k.bin", b"b", ABSENT) is None
    method, url, headers = blob.requests[-1]
    assert (method, url) == ("put", f"{CONTAINER_URL}/k.bin")
    assert headers["If-None-Match"] == "*" and "If-Match" not in headers
    assert headers["x-ms-version"] == "2023-11-03"
    assert headers["x-ms-blob-type"] == "BlockBlob"
    assert headers["Authorization"].startswith("Bearer bearer-")
    assert set(tokens.resources) == {"https://storage.azure.com"}


async def test_blob_compare_and_swap_sends_the_etag_and_maps_412_to_a_lost_swap():
    blob = FakeBlobService()
    store, _ = _azure(blob)
    first = await store.put_if_generation("head.json", b"a", ABSENT)
    assert first.startswith('"0x') and first.endswith('"')
    second = await store.put_if_generation("head.json", b"b", first)
    assert blob.requests[-1][2]["If-Match"] == first
    assert await store.put_if_generation("head.json", b"c", first) is None
    assert await store.get_with_generation("head.json") == (b"b", second)


@pytest.mark.parametrize("operation", ["read", "create", "swap", "delete"])
async def test_a_refused_identity_is_never_absence_or_a_lost_race(operation):
    blob = FakeBlobService()
    store, tokens = _azure(blob)
    current = await store.put_if_generation("keys/log-key.wrapped", b"sealed", ABSENT)
    method = {"read": "get", "delete": "delete"}.get(operation, "put")
    refusal = _error(403, "AuthorizationPermissionMismatch")
    blob.scripted += [(method, refusal), (method, refusal)]
    with pytest.raises(PodBlobStorageForbidden):
        if operation == "read":
            await store.get_with_generation("keys/log-key.wrapped")
        elif operation == "delete":
            await store.delete("keys/log-key.wrapped")
        else:
            expected = ABSENT if operation == "create" else current
            await store.put_if_generation("keys/log-key.wrapped", b"other", expected)
    assert tokens.forgotten == ["https://storage.azure.com"]  # re-minted once, then refused


async def test_an_expired_bearer_is_reminted_once_and_the_call_lands():
    blob = FakeBlobService()
    store, tokens = _azure(blob)
    blob.scripted.append(("get", _error(401, "InvalidAuthenticationInfo")))
    assert await store.get_with_generation("head.json") == (None, ABSENT)
    assert tokens.forgotten == ["https://storage.azure.com"]


@pytest.mark.parametrize("code", ["ContainerNotFound", "ResourceNotFound", ""])
@pytest.mark.parametrize("method", ["get", "delete"])
async def test_only_blob_not_found_is_absence(code, method):
    blob = FakeBlobService()
    store, _ = _azure(blob)
    blob.scripted.append((method, _error(404, code)))
    with pytest.raises(PodBlobStorageError):
        if method == "get":
            await store.get_with_generation("head.json")
        else:
            await store.delete("head.json")


async def test_blob_delete_removes_snapshots_with_the_base_blob():
    blob = FakeBlobService()
    store, _ = _azure(blob)
    await store.put_if_generation("head.json", b"x", ABSENT)
    assert await store.delete("head.json") is True
    method, url, headers = blob.requests[-1]
    assert (method, url) == ("delete", f"{CONTAINER_URL}/head.json")
    assert headers["x-ms-delete-snapshots"] == "include"


async def test_a_write_without_a_stated_etag_is_unconfirmed():
    blob = FakeBlobService()
    store, _ = _azure(blob)
    from tests.pod_azure_fakes import FakeResponse

    blob.scripted.append(("put", FakeResponse(201, headers={"ETag": 'W/"weak"'})))
    with pytest.raises(PodBlobStorageError, match="version unverified"):
        await store.put_if_generation("head.json", b"x", ABSENT)


@pytest.mark.parametrize("bad", ["7", "0x8D", 'W/"0x8D"', 3])
async def test_a_version_this_store_never_issued_is_refused_before_any_request(bad):
    blob = FakeBlobService()
    store, _ = _azure(blob)
    with pytest.raises(ValueError):
        await store.put_if_generation("head.json", b"x", bad)
    assert blob.requests == []


@pytest.mark.parametrize("key", ["../ha2/head.json", "/abs.json", "a/%2e%2e/b"])
async def test_a_traversing_key_never_leaves_the_pod_prefix(key):
    blob = FakeBlobService()
    store, _ = _azure(blob)
    with pytest.raises(ValueError):
        await store.get_with_generation(key)
    assert blob.requests == []


def test_the_container_url_is_validated():
    parsed = parse_blob_container_url("https://podacct.blob.core.windows.net/agent/pods/ha1")
    assert (parsed.account_url, parsed.container, parsed.prefix) == (
        "https://podacct.blob.core.windows.net",
        "agent",
        "pods/ha1",
    )
    gov = parse_blob_container_url("https://podacct.blob.core.usgovcloudapi.net/agent")
    assert gov.prefix == ""
    for bad in (
        "http://podacct.blob.core.windows.net/agent",
        "https://podacct.blob.core.windows.net",
        "https://evil.example.com/agent",
        "https://podacct.blob.core.windows.net:8443/agent",
        "https://user@podacct.blob.core.windows.net/agent",
        "https://podacct.blob.core.windows.net/agent?sv=sas",
        "https://podacct.blob.core.windows.net/agent/../x",
        "https://PodAcct-1.blob.core.windows.net/agent",
    ):
        with pytest.raises(ValueError):
            parse_blob_container_url(bad)
