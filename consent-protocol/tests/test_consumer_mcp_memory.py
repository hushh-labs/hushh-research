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
from hushh_mcp.services.pod_consumer_memory import (
    PodConsumerMemoryConflict,
    PodConsumerMemoryExecutor,
    _encrypt,
)
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
    assert result["execution_target"] == "owner_pod"
    assert transport.call["owner_id"] == "owner-a"
    assert transport.call["deployment_id"] == "pod-owner-a"
    assert transport.call["grant_token"] == _RUNTIME_TOKEN
    assert "vault_key" not in transport.call
    assert transport.call["arguments"]["content"] == "vegetarian"


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

    assert result["execution_target"] == "owner_pod"
    assert calls == {
        "url": "https://pod.example",
        "path": "/api/one/pod/consumer/memory",
        "body": {
            "ownerId": "owner-a",
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
