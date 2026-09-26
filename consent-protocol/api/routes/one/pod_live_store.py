"""Store-compatible pod port; directive authority remains on the admitted hub."""

from __future__ import annotations

from dataclasses import fields
from datetime import datetime
from typing import Any, TypeVar

from api.routes.one.pod_live_transport import PodLiveTransport
from hushh_mcp.services.action_directive_ledger import (
    ActionConfirmationReceipt,
    ActionDirectiveAuthorityError,
    IssuedActionDirective,
)

_Record = TypeVar("_Record", IssuedActionDirective, ActionConfirmationReceipt)


def _record(kind: type[_Record], value: dict[str, Any]) -> _Record:
    if set(value) != {field.name for field in fields(kind)}:
        raise ActionDirectiveAuthorityError("invalid voice authority result")
    decoded = dict(value)
    try:
        for name, item in value.items():
            if name in {"expires_at", "confirmed_at"}:
                if not isinstance(item, str):
                    raise ValueError()
                date = datetime.fromisoformat(item)
                if date.tzinfo is None:
                    raise ValueError()
                decoded[name] = date
            elif name == "trusted_activation":
                if type(item) is not bool:
                    raise ValueError()
            elif not isinstance(item, str) or not item:
                raise ValueError()
        return kind(**decoded)
    except (TypeError, ValueError):
        raise ActionDirectiveAuthorityError("invalid voice authority result") from None


class PodVoiceDirectiveStore:
    """Only the six voice ledger operations; no local persistence or fallback."""

    def __init__(self, transport: PodLiveTransport) -> None:
        self._transport = transport

    async def issue(self, **arguments: Any) -> IssuedActionDirective:
        return _record(IssuedActionDirective, await self._transport.request("issue", arguments))

    async def confirm(self, **arguments: Any) -> ActionConfirmationReceipt:
        return _record(
            ActionConfirmationReceipt, await self._transport.request("confirm", arguments)
        )

    async def consume(self, **arguments: Any) -> None:
        await self._transport.request("consume", arguments)

    async def settle(self, **arguments: Any) -> None:
        await self._transport.request("settle", arguments)

    async def settle_direct(self, **arguments: Any) -> None:
        await self._transport.request("settle_direct", arguments)

    async def cancel_voice(self, **arguments: Any) -> None:
        await self._transport.request("cancel_voice", arguments)
