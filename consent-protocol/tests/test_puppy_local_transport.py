"""Puppy inference over the pod's own broker, and when the factory chooses it.

The transport speaks the same frame vocabulary as the hub relay transport and
normalises the same way; only the wire differs. Selection is the load-bearing
part: a pod with a linked device dials no hub, a device still on the hub keeps the
hub path, and a hub process never sees the local transport at all.
"""

from __future__ import annotations

import asyncio

import pytest

from hushh_mcp.runtime_providers import factory
from hushh_mcp.runtime_providers import puppy_local_transport as local
from hushh_mcp.runtime_providers.puppy_transport import (
    PuppyRelayProtocolError,
    PuppyRelayTransport,
    PuppyRelayUnavailable,
)
from hushh_mcp.runtime_providers.translate import NeutralMessage, NeutralRequest
from hushh_mcp.services import pod_config
from hushh_mcp.services import puppy_broker as pb

KEY = ("ha1_owner", "tdv_mac_1")


class _Socket:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send(self, frame: dict) -> None:
        self.sent.append(frame)

    async def close(self, code: int, reason: str) -> None:
        return None


def _request() -> NeutralRequest:
    return NeutralRequest(
        messages=(NeutralMessage(role="user", text="hello"),),
        system_instruction="be brief",
        temperature=0.2,
        max_output_tokens=64,
        tools=(),
    )


async def test_generate_rides_the_broker_and_normalises_the_result():
    broker = pb.PuppyBroker()
    socket = _Socket()
    await broker.register(KEY, send=socket.send, close=socket.close, epoch=1)
    transport = local.PuppyLocalBrokerTransport(hushh_id=KEY[0], device_id=KEY[1], broker=broker)

    async def device():
        while not socket.sent:
            await asyncio.sleep(0)
        request_id = socket.sent[0]["requestId"]
        await broker.deliver(
            KEY, {"type": "inference.delta", "requestId": request_id, "text": "hel"}
        )
        await broker.deliver(
            KEY,
            {
                "type": "inference.result",
                "requestId": request_id,
                "text": "lo",
                "functionCalls": [{"name": "load_memory", "args": {"query": "q"}, "id": "call_1"}],
            },
        )

    from google.genai import types

    feeder = asyncio.create_task(device())
    response = await transport.aio.models.generate_content(
        model="local",
        contents=[types.Content(role="user", parts=[types.Part.from_text(text="hello")])],
    )
    await feeder
    assert response.text == "hello"
    assert [c.name for c in response.function_calls] == ["load_memory"]
    sent = socket.sent[0]
    assert sent["type"] == "inference.request" and sent["deviceId"] == KEY[1]
    assert sent["model"] == "local" and sent["messages"][0]["text"] == "hello"
    assert "Authorization" not in str(sent) and "pst1." not in str(sent)


async def test_stream_yields_chunks_in_order():
    broker = pb.PuppyBroker()
    socket = _Socket()
    await broker.register(KEY, send=socket.send, close=socket.close, epoch=1)
    transport = local.PuppyLocalBrokerTransport(hushh_id=KEY[0], device_id=KEY[1], broker=broker)

    async def device():
        while not socket.sent:
            await asyncio.sleep(0)
        request_id = socket.sent[0]["requestId"]
        for piece in ("a", "b"):
            await broker.deliver(
                KEY, {"type": "inference.delta", "requestId": request_id, "text": piece}
            )
        await broker.deliver(KEY, {"type": "inference.done", "requestId": request_id})

    feeder = asyncio.create_task(device())
    chunks = [
        c
        async for c in await transport.aio.models.generate_content_stream(
            model="local", contents="x"
        )
    ]
    await feeder
    assert [c.text for c in chunks] == ["a", "b"]


async def test_offline_fenced_and_refused_surface_as_the_typed_refusal_never_a_fallback():
    broker = pb.PuppyBroker()
    transport = local.PuppyLocalBrokerTransport(hushh_id=KEY[0], device_id=KEY[1], broker=broker)
    with pytest.raises(PuppyRelayUnavailable):
        await transport._generate(_request(), model="local")

    socket = _Socket()
    await broker.register(KEY, send=socket.send, close=socket.close, epoch=1)

    class _Fenced:
        async def is_current(self, *, force=False):
            return False

    fenced = local.PuppyLocalBrokerTransport(
        hushh_id=KEY[0], device_id=KEY[1], broker=broker, incarnation=_Fenced()
    )
    with pytest.raises(PuppyRelayUnavailable):
        await fenced._generate(_request(), model="local")
    assert socket.sent == []

    async def device_refuses():
        while not socket.sent:
            await asyncio.sleep(0)
        await broker.deliver(
            KEY,
            {
                "type": "inference.error",
                "requestId": socket.sent[0]["requestId"],
                "code": "UNSUPPORTED",
            },
        )

    feeder = asyncio.create_task(device_refuses())
    with pytest.raises(PuppyRelayUnavailable):
        await transport._generate(_request(), model="local")
    await feeder


async def test_a_frame_for_another_request_is_a_protocol_error():
    broker = pb.PuppyBroker()
    socket = _Socket()
    await broker.register(KEY, send=socket.send, close=socket.close, epoch=1)
    transport = local.PuppyLocalBrokerTransport(hushh_id=KEY[0], device_id=KEY[1], broker=broker)

    async def rogue(request_id: str):
        await asyncio.sleep(0)
        # Bypass deliver's routing to plant a frame with the wrong id on the right queue.
        link = await broker.get(KEY)
        link.pending[request_id].put_nowait({"type": "inference.done", "requestId": "someone-else"})

    async def device():
        while not socket.sent:
            await asyncio.sleep(0)
        await rogue(socket.sent[0]["requestId"])

    feeder = asyncio.create_task(device())
    with pytest.raises(PuppyRelayProtocolError):
        await transport._generate(_request(), model="local")
    await feeder


def test_the_transport_needs_an_owner_and_a_device():
    with pytest.raises(ValueError):
        local.PuppyLocalBrokerTransport(hushh_id="", device_id="tdv_1", broker=pb.PuppyBroker())
    with pytest.raises(ValueError):
        local.PuppyLocalBrokerTransport(hushh_id="ha1", device_id="", broker=pb.PuppyBroker())


# -- selection --------------------------------------------------------------------------


@pytest.fixture
def pod_env(monkeypatch):
    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    monkeypatch.setenv("HUSSH_ID", KEY[0])
    monkeypatch.delenv("PUPPY_INFERENCE_RELAY_URL", raising=False)
    pod_config.set_active_pod_config(None)
    yield
    pod_config.set_active_pod_config(None)
    pb.BROKER._links.clear()


def test_a_hub_process_never_selects_the_local_transport(monkeypatch):
    monkeypatch.delenv("HUSSH_POD_MODE", raising=False)
    monkeypatch.setenv("PUPPY_INFERENCE_RELAY_URL", "wss://hub.example/api/one/puppy/relay")
    assert local.select_puppy_transport(device_id="tdv_mac_1") is None
    client = factory.build_runtime_client("puppy", "grant", puppy_device_id="tdv_mac_1")
    assert type(client) is PuppyRelayTransport


def test_a_pod_with_no_hub_relay_serves_locally_even_before_the_device_links(pod_env):
    chosen = local.select_puppy_transport(device_id="tdv_mac_1")
    assert isinstance(chosen, local.PuppyLocalBrokerTransport)
    assert chosen.key == KEY
    client = factory.build_runtime_client("puppy", "pod-session:sid", puppy_device_id="tdv_mac_1")
    assert isinstance(client, local.PuppyLocalBrokerTransport)


async def test_a_linked_device_wins_over_a_configured_hub_relay(pod_env, monkeypatch):
    monkeypatch.setenv("PUPPY_INFERENCE_RELAY_URL", "wss://hub.example/api/one/puppy/relay")
    assert local.select_puppy_transport(device_id="tdv_mac_1") is None  # still on the hub
    socket = _Socket()
    await pb.BROKER.register(KEY, send=socket.send, close=socket.close, epoch=1)
    chosen = local.select_puppy_transport(device_id="tdv_mac_1")
    assert isinstance(chosen, local.PuppyLocalBrokerTransport)


def test_the_owners_configuration_can_turn_the_broker_off(pod_env):
    pod_config.set_active_pod_config(pod_config.PodConfig(puppy_broker=False))
    assert local.select_puppy_transport(device_id="tdv_mac_1") is None


def test_selection_never_reads_a_new_environment_variable():
    from pathlib import Path

    source = Path(local.__file__).read_text(encoding="utf-8")
    names = {
        line.split('os.getenv("', 1)[1].split('"', 1)[0]
        for line in source.splitlines()
        if 'os.getenv("' in line
    }
    assert names <= {"PUPPY_INFERENCE_RELAY_URL", "HUSSH_ID"}
