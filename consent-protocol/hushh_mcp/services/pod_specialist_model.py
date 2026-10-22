"""One specialist invocation's provider calls and explicit client lifetime."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from hushh_mcp.runtime_providers.lifecycle import close_owned_model_client
from hushh_mcp.runtime_providers.puppy_transport import PuppyCapabilityUnsupported


class PodSpecialistModelCalls:
    def __init__(
        self,
        *,
        model: str,
        runtime_mode: str | None,
        client_factory: Callable[[], Any],
        check: Callable[[], Awaitable[None]],
        timeout: float,
        on_unsupported: Callable[[str], None],
        unsupported_error: type[PuppyCapabilityUnsupported],
    ):
        self.model, self.mode, self.client_factory = model, runtime_mode, client_factory
        self.check, self.timeout = check, timeout
        self.on_unsupported, self.unsupported_error = on_unsupported, unsupported_error
        self.client: Any = None
        self.closed = False

    async def generate(self, contents: Any, config: Any) -> Any:
        await self.check()
        if self.closed or self.mode is None:
            raise RuntimeError("Pod model authority unavailable")
        if self.client is None:
            self.client = self.client_factory()
        try:
            result = await asyncio.wait_for(
                self.client.aio.models.generate_content(
                    model=self.model, contents=contents, config=config
                ),
                timeout=self.timeout,
            )
        except PuppyCapabilityUnsupported as exc:
            self.on_unsupported(exc.capability)
            raise self.unsupported_error(exc.capability) from None
        except Exception:
            raise RuntimeError("Pod specialist provider unavailable") from None
        await self.check()
        return result

    async def aclose(self) -> None:
        self.closed = True
        held, self.client = self.client, None
        if held is not None:
            await close_owned_model_client(held)
