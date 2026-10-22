"""The capability declaration must survive the whole in-pod path.

THE SEAM, AND WHY EVERY PIECE OF IT PASSED ITS OWN TEST.

Three modules in one process disagreed about the shape of a device's declared
capabilities, and each was unit-tested against its own shape:

*   ``pod_puppy_relay.valid_capabilities`` reads a LIST, per the device spec's
    hello frame (section 5.1). Tested with a list.
*   ``puppy_broker`` stores and re-emits a LIST. Tested with a list.
*   ``puppy_transport.declared_capabilities`` reads a DICT of name -> bool and
    returns ``None`` for anything else. Tested with a dict.

``missing_capability(request, None)`` returns "", because None is its negative
control for a device that declared nothing. So a device that declared plenty,
correctly, had its declaration turned into None between the door and the gate,
and the "refuse an unsupported capability before dispatch" control did not run
at all on the owner-direct path. Nothing was red. The handoff recorded the
control as enforced "on both sides".

Worse, the old door returned ``()`` for an unparseable block too, so a device
sending the wrong shape entirely was indistinguishable from one that said
nothing. The fork sends a dict today, because its client was written for the
hub, so that was the live case.

These tests drive the REAL door, the REAL broker and the REAL transport gate in
one pass. A unit test on any single module cannot catch this class of defect,
which is the whole argument for the seam.
"""

from __future__ import annotations

import pytest

from api.routes.one import pod_puppy_relay
from hushh_mcp.runtime_providers.puppy_local_transport import PuppyLocalBrokerTransport
from hushh_mcp.runtime_providers.puppy_transport import PuppyCapabilityUnsupported
from hushh_mcp.runtime_providers.translate import NeutralMessage, NeutralRequest, NeutralTool
from hushh_mcp.services.puppy_broker import PuppyBroker

OWNER = "ha1_seam"
DEVICE = "tdv_seam"
KEY = (OWNER, DEVICE)


def _request(*, with_tools: bool) -> NeutralRequest:
    return NeutralRequest(
        messages=(NeutralMessage(role="user", text="what is my dog called"),),
        tools=(NeutralTool(name="load_memory", description="recall"),) if with_tools else (),
    )


async def _link(broker: PuppyBroker, hello_capabilities: object) -> list[dict]:
    """Admit a device exactly as the route does, and record what it is sent.

    The fake device ANSWERS. A recorder that only collects would leave every
    dispatch waiting on the broker's 120 s request deadline, so the negative
    controls would pass by timing out, which proves nothing.
    """
    sent: list[dict] = []

    async def send(frame: dict) -> None:
        sent.append(frame)
        request_id = str(frame.get("requestId") or "")
        if str(frame.get("type") or "") == "inference.request" and request_id:
            await broker.deliver(
                KEY, {"type": "inference.result", "requestId": request_id, "text": "Bo"}
            )

    async def close(code: int, reason: str) -> None:
        return None

    await broker.register(
        KEY,
        send=send,
        close=close,
        epoch=1,
        model="muse-glimmer",
        # The route's own parser, not a hand-built tuple: that is the seam.
        capabilities=pod_puppy_relay.valid_capabilities(hello_capabilities),
    )
    return sent


@pytest.mark.asyncio
async def test_a_declared_gap_is_refused_before_anything_reaches_the_device():
    """The live defect: this used to dispatch happily and the device coped."""
    broker = PuppyBroker()
    sent = await _link(broker, ["streaming", "json_schema"])  # no tool_calling
    transport = PuppyLocalBrokerTransport(hushh_id=OWNER, device_id=DEVICE, broker=broker)

    with pytest.raises(PuppyCapabilityUnsupported) as refused:
        async for _ in transport._frames(_request(with_tools=True), model="local"):
            pass

    assert "tool_calling" in str(refused.value)
    assert sent == [], "the request reached the device despite a declared gap"


@pytest.mark.asyncio
async def test_a_declared_capability_is_not_refused_negative_control():
    """A guard that refuses everything is the same as no guard."""
    broker = PuppyBroker()
    await _link(broker, ["tool_calling", "streaming"])
    transport = PuppyLocalBrokerTransport(hushh_id=OWNER, device_id=DEVICE, broker=broker)

    received = [
        frame async for frame in transport._frames(_request(with_tools=True), model="local")
    ]

    assert [f["type"] for f in received] == ["inference.result"]


@pytest.mark.asyncio
async def test_a_device_that_declared_nothing_is_still_judged_by_itself():
    """None is the negative control, and it has to survive the seam as None.

    An older device that says nothing is not refused here; the device remains
    the only judge, exactly as on the hub path. This is the case that must NOT
    become an empty declaration, or every such device is refused everything.
    """
    broker = PuppyBroker()
    await _link(broker, None)
    link = await broker.get(KEY)
    assert link is not None and link.capabilities is None

    transport = PuppyLocalBrokerTransport(hushh_id=OWNER, device_id=DEVICE, broker=broker)
    received = [
        frame async for frame in transport._frames(_request(with_tools=True), model="local")
    ]

    assert [f["type"] for f in received] == ["inference.result"]


@pytest.mark.asyncio
async def test_the_shape_the_fork_actually_sends_is_refused_loudly():
    """The fork sends a dict, written for the hub. That must not read as empty."""
    with pytest.raises(ValueError):
        pod_puppy_relay.valid_capabilities({"tool_calling": True, "streaming": True})
