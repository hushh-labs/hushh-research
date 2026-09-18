"""Puppy inference over the pod's OWN broker: no hub socket, no relay URL.

The same neutral request, the same frame vocabulary and the same normalisation
as ``PuppyRelayTransport``; only the wire changes. Frames go to and come from
``puppy_broker.BROKER``, which holds the one persistent device socket the relay
route accepted, so a turn no longer opens a fresh WebSocket per request through
the hub. Selection lives here too (``select_puppy_transport``), keyed on pod mode,
the owner's configuration record and whether a device is actually linked, so the
hub-relayed path keeps working for a pod whose device still dials the hub.

An offline device or a fenced incarnation surfaces as ``PuppyRelayUnavailable``,
the typed refusal the runtime already knows. There is no fallback to another
provider: a person who chose their own model gets their own model or a clear no.
"""

from __future__ import annotations

import logging
import os
import uuid
from typing import Any, AsyncIterator, Optional

from .puppy_transport import (
    DEFAULT_TIMEOUT_SECONDS,
    DEVICE_CAPABILITY_NAMES,
    PuppyCapabilityUnsupported,
    PuppyRelayProtocolError,
    PuppyRelayTransport,
    PuppyRelayUnavailable,
    missing_capability,
)
from .translate import NeutralRequest

logger = logging.getLogger(__name__)


def declared_capability_map(
    names: Optional[tuple[str, ...]],
) -> Optional[dict[str, bool]]:
    """The in-pod LIST form rendered in the gate's name->bool vocabulary.

    Two vocabularies met here and nobody translated between them. The device
    spec and the in-pod door speak a list of SUPPORTED names; the hub path's
    gate, `missing_capability`, speaks a dict of name->bool. Handed a list, its
    reader returns None, and None is the gate's negative control, so it refuses
    nothing. That is why "refuse an unsupported capability before dispatch"
    -- which the hub transport does enforce, and which the handoff recorded as
    enforced "on both sides" -- did not run on the owner-direct path at all.

    None in, None out: a device that declared nothing is still judged by itself,
    exactly as on the hub path.
    """
    if names is None:
        return None
    declared = set(names)
    return {name: (name in declared) for name in DEVICE_CAPABILITY_NAMES}


class PuppyLocalBrokerTransport(PuppyRelayTransport):
    provider = "puppy"

    def __init__(
        self,
        *,
        hushh_id: str,
        device_id: str,
        broker: Any = None,
        incarnation: Any = None,
        timeout_seconds: float | None = None,
    ) -> None:
        # Deliberately not super().__init__: that constructor demands a relay URL and
        # a hub grant, neither of which exists on the owner-direct path.
        self._owner = str(hushh_id or "").strip()
        self._device_id = str(device_id or "").strip()
        self._timeout = float(timeout_seconds or DEFAULT_TIMEOUT_SECONDS)
        self._token = ""
        self._url = ""
        if not self._owner or not self._device_id:
            raise ValueError("Puppy local transport needs the owner and the device")
        if broker is None:
            from hushh_mcp.services.puppy_broker import BROKER  # noqa: PLC0415

            broker = BROKER
        self._broker = broker
        self._incarnation = incarnation

    @property
    def key(self) -> tuple[str, str]:
        return (self._owner, self._device_id)

    async def _frames(
        self, request: NeutralRequest, *, model: str
    ) -> AsyncIterator[dict[str, Any]]:
        from hushh_mcp.services.puppy_broker import (  # noqa: PLC0415
            PuppyBrokerFenced,
            PuppyBrokerOffline,
        )

        # REFUSE BEFORE DISPATCH, the same contract the hub transport keeps. A
        # declared capability gap is answered here, with nothing sent to the
        # device, so it never spends a cold model load on a request it was going
        # to drop a field from.
        link = await self._broker.get(self.key)
        if link is not None:
            lacking = missing_capability(
                request, declared_capability_map(getattr(link, "capabilities", None))
            )
            if lacking:
                raise PuppyCapabilityUnsupported(lacking)

        request_id = uuid.uuid4().hex
        payload = self._payload(request, model, request_id)
        try:
            async for frame in self._broker.dispatch(
                self.key, payload, incarnation=self._incarnation
            ):
                if str(frame.get("requestId") or "") != request_id:
                    raise PuppyRelayProtocolError("Puppy returned a mismatched request")
                kind = str(frame.get("type") or "")
                if kind == "inference.error":
                    raise PuppyRelayUnavailable("Puppy inference was refused")
                yield frame
                if kind in {"inference.done", "inference.result"}:
                    return
        except PuppyBrokerOffline as exc:
            raise PuppyRelayUnavailable("Puppy inference connection unavailable") from exc
        except PuppyBrokerFenced as exc:
            raise PuppyRelayUnavailable("this pod incarnation no longer serves inference") from exc


def relay_url_configured() -> bool:
    return bool(str(os.getenv("PUPPY_INFERENCE_RELAY_URL") or "").strip())


def select_puppy_transport(*, device_id: Optional[str]) -> Optional[PuppyLocalBrokerTransport]:
    """The owner-direct transport, or None when the hub relay is the right door.

    Local when this process is a pod, the owner's configuration keeps the in-pod
    broker on, and either the device is linked to THIS pod or there is no hub relay
    to fall back to. A device that still dials the hub keeps the hub path.
    """
    from hushh_mcp.runtime_settings import pod_mode  # noqa: PLC0415
    from hushh_mcp.services.pod_config import active_pod_config  # noqa: PLC0415

    device = str(device_id or "").strip()
    owner = str(os.getenv("HUSSH_ID") or "").strip()
    if not pod_mode() or not device or not owner or not active_pod_config().puppy_broker:
        return None
    from hushh_mcp.services.puppy_broker import BROKER  # noqa: PLC0415

    if not BROKER.is_linked((owner, device)) and relay_url_configured():
        return None
    incarnation = None
    try:
        from hushh_mcp.services.pod_session_authority import (  # noqa: PLC0415
            active_session_authority,
        )

        authority = active_session_authority()
        incarnation = authority.lease if authority is not None else None
    except Exception:  # noqa: BLE001 - no authority means no fence to consult
        incarnation = None
    return PuppyLocalBrokerTransport(
        hushh_id=owner, device_id=device, broker=BROKER, incarnation=incarnation
    )


__all__ = ["PuppyLocalBrokerTransport", "relay_url_configured", "select_puppy_transport"]
