from contextlib import contextmanager

import pytest

from hushh_mcp.services.consumer_mcp_connections import ConsumerConnection
from hushh_mcp.services.consumer_mcp_memory import (
    ConsumerMcpMemory,
    ConsumerMemoryInvalid,
    ConsumerMemoryUnavailable,
    UnavailableConsumerMemoryTransport,
    validate_memory_request,
)


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
    assert "vault_key" not in transport.call
    assert transport.call["arguments"]["content"] == "vegetarian"
