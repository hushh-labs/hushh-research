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
