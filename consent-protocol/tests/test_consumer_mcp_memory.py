from contextlib import contextmanager

import pytest
from pydantic import ValidationError

from hushh_mcp.services.consumer_mcp_connections import ConsumerConnection
from hushh_mcp.services.consumer_mcp_memory import (
    ConsumerMcpMemory,
    ConsumerMemoryInvalid,
    ConsumerMemoryUnavailable,
    OwnerPodConsumerMemoryTransport,
    UnavailableConsumerMemoryTransport,
    validate_memory_request,
)
from hushh_mcp.services.pkm_sqlite_engine import SqlitePkmWriteEngine
from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog
from hushh_mcp.services.pod_consumer_memory import (
    PodConsumerMemoryConflict,
    PodConsumerMemoryExecutor,
    PodConsumerMemoryUnavailable,
    _decrypt,
    _encrypt,
)
from hushh_mcp.services.pod_pkm_store import PodPkmStore
from mcp_modules.tools.consumer_tools import ConsumerMemoryResult

_RUNTIME_TOKEN = "HCT:runtime-token"


def test_memory_requests_are_typed_and_bounded() -> None:
    request = validate_memory_request(
        "save",
        {
            "domain": " Food ",
            "content": " vegetarian ",
            "idempotency_key": "save-1",
            "expected_revision": 3,
        },
    )
    assert request.arguments == {
        "domain": "food",
        "content": "vegetarian",
        "idempotency_key": "save-1",
        "expected_revision": 3,
    }
    with pytest.raises(ConsumerMemoryInvalid):
        validate_memory_request("read", {"domain": "food", "query": "x" * 513})
    with pytest.raises(ConsumerMemoryInvalid):
        validate_memory_request("delete", {"domain": "food"})
    with pytest.raises(ConsumerMemoryInvalid, match="fresh confirmation"):
        validate_memory_request(
            "delete",
            {"domain": "food", "memory_id": "m1", "idempotency_key": "delete-1"},
        )
    request = validate_memory_request(
        "delete",
        {
            "domain": "food",
            "memory_id": "m1",
            "idempotency_key": "delete-1",
            "confirm": True,
        },
    )
    assert request.arguments["confirm"] is True


def test_memory_result_schema_keeps_pod_payload_bounded() -> None:
    base = {
        "state": "completed",
        "operation": "read",
        "execution_target": "owner_pod",
        "deployment_id": "pod-a",
        "result": {"records": [], "revision": 1},
        "next_action": "done",
    }
    assert ConsumerMemoryResult.model_validate(base).result.revision == 1
    with pytest.raises(ValidationError):
        ConsumerMemoryResult.model_validate(
            {
                **base,
                "result": {
                    "records": [
                        {"id": str(index), "content": "ok", "updated_at": "now"}
                        for index in range(21)
                    ]
                },
            }
        )
    with pytest.raises(ValidationError):
        ConsumerMemoryResult.model_validate({**base, "result": {"secret": "unexpected"}})


@pytest.mark.asyncio
async def test_default_transport_fails_closed() -> None:
    with pytest.raises(ConsumerMemoryUnavailable):
        await UnavailableConsumerMemoryTransport().execute(operation="read")


@pytest.mark.asyncio
async def test_pod_data_plane_revalidates_typed_request_before_custody(monkeypatch) -> None:
    from hushh_mcp.services import pod_consumer_memory, pod_session_authority

    monkeypatch.setattr(
        pod_session_authority,
        "active_session_authority",
        lambda: pytest.fail("invalid request reached custody"),
    )
    with pytest.raises(ConsumerMemoryInvalid, match="query is required"):
        await pod_consumer_memory.execute_pod_consumer_memory(
            owner_id="owner-a",
            operation="read",
            arguments={"domain": "food"},
        )


class _Connections:
    def admit_memory(self, principal, *, operation):
        assert operation == "save"
        return ConsumerConnection(
            connection_id="cmc_1234567890abcdef1234567890abcdef",
            generation=2,
            deployment_id="pod-owner-a",
            authorization_id=7,
            client_name="Assistant",
            memory_access=True,
            grant_receipt="cmr_receipt",
            grant_token=_RUNTIME_TOKEN,
        )

    def verify_memory_admission(self, principal, *, operation, admitted):
        assert operation == "save"
        return admitted

    @contextmanager
    def memory_transaction(self, principal, *, operation):
        assert operation == "save"
        yield (
            object(),
            ConsumerConnection(
                connection_id="cmc_1234567890abcdef1234567890abcdef",
                generation=2,
                deployment_id="pod-owner-a",
                authorization_id=7,
                client_name="Assistant",
                memory_access=True,
                grant_receipt="cmr_receipt",
                grant_token=_RUNTIME_TOKEN,
            ),
        )


class _Transport:
    def __init__(self):
        self.call = None

    async def execute(self, **kwargs):
        self.call = kwargs
        return {"result": {"revision": 4}}


@pytest.mark.asyncio
async def test_transport_receives_verified_binding_without_keys() -> None:
    transport = _Transport()
    service = ConsumerMcpMemory(connections=_Connections(), transport=transport)
    principal = type(
        "Principal",
        (),
        {"subject_firebase_uid": "owner-a"},
    )()
    result = await service.execute(
        principal,
        operation="save",
        arguments={"domain": "food", "content": "vegetarian", "idempotency_key": "save-1"},
    )
    assert result == {
        "operation": "save",
        "execution_target": "owner_pod",
        "deployment_id": "pod-owner-a",
        "result": {"revision": 4},
    }
    assert transport.call["owner_id"] == "owner-a"
    assert transport.call["deployment_id"] == "pod-owner-a"
    assert transport.call["grant_token"] == _RUNTIME_TOKEN
    assert "vault_key" not in transport.call
    assert transport.call["arguments"]["content"] == "vegetarian"


@pytest.mark.asyncio
async def test_memory_metadata_is_derived_from_connection_not_pod_response():
    class _SpoofingTransport:
        async def execute(self, **_kwargs):
            return {
                "operation": "delete",
                "execution_target": "shared_runtime",
                "deployment_id": "foreign-pod",
                "result": {"revision": 4},
            }

    service = ConsumerMcpMemory(connections=_Connections(), transport=_SpoofingTransport())
    principal = type("Principal", (), {"subject_firebase_uid": "owner-a"})()
    result = await service.execute(
        principal,
        operation="save",
        arguments={"domain": "food", "content": "vegetarian", "idempotency_key": "save-1"},
    )
    assert result == {
        "operation": "save",
        "execution_target": "owner_pod",
        "deployment_id": "pod-owner-a",
        "result": {"revision": 4},
    }


class _PodStore:
    def __init__(self, snapshot=None, result=None):
        self.snapshot = snapshot or {
            "content_revision": 0,
            "manifest": None,
            "paths": [],
            "scopes": [],
            "segments": None,
        }
        self.params = None
        self.result = result or {"success": True, "data_version": 1}

    async def get_domain_snapshot(self, params):
        return self.snapshot

    async def commit_domain_mutation(self, params):
        self.params = params
        return self.result


@pytest.mark.asyncio
async def test_pod_executor_commits_ciphertext_only_and_preserves_idempotency():
    store = _PodStore()
    executor = PodConsumerMemoryExecutor(store=store, vault_key=b"K" * 32)

    result = await executor.execute(
        owner_id="owner-a",
        operation="save",
        arguments={
            "domain": "food",
            "content": "vegetarian",
            "idempotency_key": "save-1",
        },
    )

    assert result["result"]["saved"] is True
    assert store.params is not None
    segment = store.params["p_segment_rows"][0]
    assert "vegetarian" not in str(segment)
    assert store.params["p_event_rows"][0]["metadata"] == {
        "operation": "save",
        "record_count": 1,
    }
    assert store.params["p_commit_kind"] == "consumer_memory"


@pytest.mark.asyncio
async def test_pod_executor_save_retry_reuses_the_same_memory_id():
    class _ReplayStore(_PodStore):
        def __init__(self):
            super().__init__()
            self.calls = 0

        async def commit_domain_mutation(self, params):
            self.calls += 1
            self.params = params
            return {
                "success": True,
                "data_version": 1,
                "idempotent_replay": self.calls > 1,
            }

    arguments = {
        "domain": "food",
        "content": "vegetarian",
        "idempotency_key": "save-retry",
    }
    store = _ReplayStore()
    executor = PodConsumerMemoryExecutor(store=store, vault_key=b"K" * 32)
    first = await executor.execute(owner_id="owner-a", operation="save", arguments=arguments)
    second = await executor.execute(owner_id="owner-a", operation="save", arguments=arguments)

    assert first["result"]["memory_id"] == second["result"]["memory_id"]
    assert store.calls == 2


@pytest.mark.asyncio
async def test_pod_executor_reads_the_existing_encrypted_domain():
    encrypted = _encrypt(
        {"consumer_memory": [{"id": "m1", "content": "vegetarian", "updated_at": "now"}]},
        b"K" * 32,
    )
    store = _PodStore(
        snapshot={
            "content_revision": 3,
            "manifest": {},
            "paths": [],
            "scopes": [],
            "segments": {"root": encrypted},
        }
    )

    result = await PodConsumerMemoryExecutor(store=store, vault_key=b"K" * 32).execute(
        owner_id="owner-a",
        operation="query",
        arguments={"domain": "food", "query": "veg", "limit": 10},
    )

    assert result["result"]["records"] == [
        {"id": "m1", "content": "vegetarian", "updated_at": "now"}
    ]


def test_pod_consumer_memory_reads_legacy_blob_without_encoding_marker():
    value = {"consumer_memory": [{"id": "m1", "content": "vegetarian"}]}
    legacy = _encrypt(value, b"K" * 32)
    legacy.pop("encoding")

    from hushh_mcp.services.pod_consumer_memory import _decrypt

    assert _decrypt(legacy, b"K" * 32) == value


@pytest.mark.asyncio
async def test_pod_executor_delete_commits_an_encrypted_tombstone():
    encrypted = _encrypt(
        {"consumer_memory": [{"id": "m1", "content": "vegetarian", "updated_at": "now"}]},
        b"K" * 32,
    )
    store = _PodStore(
        snapshot={
            "content_revision": 3,
            "manifest": {},
            "paths": [],
            "scopes": [],
            "segments": {"root": encrypted},
        },
        result={"success": True, "data_version": 4},
    )
    result = await PodConsumerMemoryExecutor(store=store, vault_key=b"K" * 32).execute(
        owner_id="owner-a",
        operation="delete",
        arguments={
            "domain": "food",
            "memory_id": "m1",
            "idempotency_key": "delete-1",
            "confirm": True,
        },
    )

    assert result["result"] == {"saved": False, "deleted": True, "memory_id": "m1", "revision": 4}
    sealed = store.params["p_segment_rows"][0]
    assert "vegetarian" not in str(sealed)
    assert sealed["encoding"] == "base64"
    deleted_value = _decrypt(sealed, b"K" * 32)
    assert deleted_value["consumer_memory"] == []
    assert deleted_value["consumer_memory_tombstones"]
    assert store.params["p_event_rows"][0]["metadata"]["operation"] == "delete"


@pytest.mark.asyncio
async def test_pod_executor_delete_retry_is_idempotent_and_new_key_cannot_recreate():
    class _StatefulStore(_PodStore):
        def __init__(self):
            super().__init__(
                snapshot={
                    "content_revision": 3,
                    "manifest": {},
                    "paths": [],
                    "scopes": [],
                    "segments": {
                        "root": _encrypt(
                            {
                                "consumer_memory": [
                                    {"id": "m1", "content": "vegetarian", "updated_at": "now"}
                                ]
                            },
                            b"K" * 32,
                        )
                    },
                },
                result={"success": True, "data_version": 4},
            )
            self.calls = 0

        async def commit_domain_mutation(self, params):
            self.calls += 1
            self.params = params
            self.snapshot = {
                "content_revision": params["p_next_content_revision"],
                "manifest": params["p_manifest_row"],
                "paths": params["p_path_rows"],
                "scopes": params["p_scope_rows"],
                "segments": {"root": params["p_segment_rows"][0]},
            }
            return self.result

    arguments = {
        "domain": "food",
        "memory_id": "m1",
        "idempotency_key": "delete-retry",
        "confirm": True,
    }
    store = _StatefulStore()
    executor = PodConsumerMemoryExecutor(store=store, vault_key=b"K" * 32)
    first = await executor.execute(owner_id="owner-a", operation="delete", arguments=arguments)
    second = await executor.execute(owner_id="owner-a", operation="delete", arguments=arguments)

    assert first["result"]["deleted"] is True
    assert second["result"]["deleted"] is True
    assert store.calls == 1
    with pytest.raises(PodConsumerMemoryUnavailable, match="not found"):
        await executor.execute(
            owner_id="owner-a",
            operation="delete",
            arguments={**arguments, "idempotency_key": "delete-new-key"},
        )


@pytest.mark.asyncio
async def test_consumer_memory_survives_real_pkm_store_rebuild(tmp_path):
    owner = "owner-a"
    key = b"L" * 32
    log = PodCommitLog(LocalObjectStore(str(tmp_path / "log")), key, owner_id=owner)
    first_store = PodPkmStore(SqlitePkmWriteEngine(str(tmp_path / "first.sqlite3")), log)
    first = PodConsumerMemoryExecutor(store=first_store, vault_key=key)

    saved = await first.execute(
        owner_id=owner,
        operation="save",
        arguments={"domain": "food", "content": "vegetarian", "idempotency_key": "save-1"},
    )
    memory_id = saved["result"]["memory_id"]

    rebuilt = await PodPkmStore.rebuild(log, str(tmp_path / "rebuilt.sqlite3"), owner_user_id=owner)
    recovered = await PodConsumerMemoryExecutor(store=rebuilt, vault_key=key).execute(
        owner_id=owner,
        operation="query",
        arguments={"domain": "food", "query": "vegetarian", "limit": 10},
    )
    assert recovered["result"]["records"][0]["id"] == memory_id

    await PodConsumerMemoryExecutor(store=rebuilt, vault_key=key).execute(
        owner_id=owner,
        operation="delete",
        arguments={
            "domain": "food",
            "memory_id": memory_id,
            "idempotency_key": "delete-1",
            "confirm": True,
        },
    )
    rebuilt_again = await PodPkmStore.rebuild(
        log, str(tmp_path / "rebuilt-again.sqlite3"), owner_user_id=owner
    )
    after_delete = await PodConsumerMemoryExecutor(store=rebuilt_again, vault_key=key).execute(
        owner_id=owner,
        operation="query",
        arguments={"domain": "food", "query": "vegetarian", "limit": 10},
    )
    assert after_delete["result"]["records"] == []


@pytest.mark.asyncio
async def test_pod_executor_rejects_stale_revision_before_commit():
    store = _PodStore(snapshot={"content_revision": 4, "segments": None})

    with pytest.raises(PodConsumerMemoryConflict, match="changed"):
        await PodConsumerMemoryExecutor(store=store, vault_key=b"K" * 32).execute(
            owner_id="owner-a",
            operation="save",
            arguments={
                "domain": "food",
                "content": "vegetarian",
                "idempotency_key": "save-2",
                "expected_revision": 3,
            },
        )
    assert store.params is None


@pytest.mark.asyncio
async def test_owner_pod_transport_binds_registry_deployment_and_grant():
    calls = {}

    class _Registry:
        async def get(self, owner_id):
            assert owner_id == "owner-a"
            return {
                "user_id": "owner-a",
                "hushh_id": "pod-a",
                "backend_metadata": {"url": "https://pod.example"},
            }

    async def proxy(url, path, *, body, consent_token):
        calls.update(url=url, path=path, body=body, consent_token=consent_token)
        return 200, {"execution_target": "owner_pod", "result": {"revision": 1}}

    transport = OwnerPodConsumerMemoryTransport(registry=_Registry(), proxy_post=proxy)
    result = await transport.execute(
        operation="read",
        owner_id="owner-a",
        deployment_id="pod-a",
        connection_id="connection-a",
        generation=2,
        grant_receipt="receipt-a",
        grant_token=_RUNTIME_TOKEN,
        arguments={"domain": "food", "query": "veg", "limit": 10},
    )

    assert result == {"result": {"revision": 1}}
    assert calls == {
        "url": "https://pod.example",
        "path": "/api/one/pod/consumer/memory",
        "body": {
            "ownerId": "owner-a",
            "connectionId": "connection-a",
            "generation": 2,
            "operation": "read",
            "arguments": {"domain": "food", "query": "veg", "limit": 10},
        },
        "consent_token": _RUNTIME_TOKEN,
    }


@pytest.mark.asyncio
async def test_owner_pod_transport_rejects_a_changed_deployment():
    class _Registry:
        async def get(self, _owner_id):
            return {
                "user_id": "owner-a",
                "hushh_id": "other-pod",
                "backend_metadata": {"url": "https://pod.example"},
            }

    transport = OwnerPodConsumerMemoryTransport(registry=_Registry(), proxy_post=None)
    with pytest.raises(ConsumerMemoryUnavailable, match="binding changed"):
        await transport.execute(
            operation="read",
            owner_id="owner-a",
            deployment_id="pod-a",
            connection_id="connection-a",
            generation=2,
            grant_receipt="receipt-a",
            grant_token=_RUNTIME_TOKEN,
            arguments={"domain": "food", "query": "veg", "limit": 10},
        )
