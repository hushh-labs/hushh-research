"""Owner-bound marketplace read port; hub and signed-feed adapters share its API."""

import asyncio
from typing import Any


class PodMarketplaceReadPort:
    """Owner publication metadata only; no marketplace mutation authority."""

    def __init__(self, owner_user_id: str, scope_token: str) -> None:
        self._owner = owner_user_id
        self._scope_token = scope_token

    async def _read(self, user_id: str, **options: Any) -> dict:
        if user_id != self._owner:
            raise PermissionError("Marketplace owner mismatch")
        from hushh_mcp.services.pod_marketplace_read import MarketplaceReadOptions
        from hushh_mcp.services.pod_specialist_runtime import _hub_read

        validated = MarketplaceReadOptions.model_validate(options)
        return await asyncio.to_thread(
            _hub_read,
            "marketplace",
            self._scope_token,
            marketplace_read=validated.model_dump(),
        )

    async def list_published_slices(self, *, user_id: str) -> list[dict]:
        return (await self._read(user_id, operation="published"))["items"]

    async def list_publishable_slices(
        self, *, user_id: str, topic: str | None = None
    ) -> list[dict]:
        return (await self._read(user_id, operation="publishable", topic=topic))["items"]

    async def earnings_summary(self, *, user_id: str, power: str, mood: str) -> dict:
        return (await self._read(user_id, operation="earnings", power=power, mood=mood))["result"]

    async def scope_commerce_summary(self, *, user_id: str) -> dict:
        return await self._commerce_read(user_id, "commerce_summary")

    async def scope_commerce_activity(self, *, user_id: str, view: str, cursor: str | None) -> dict:
        return await self._commerce_read(user_id, "commerce_activity", view=view, cursor=cursor)

    async def _commerce_read(self, user_id: str, operation: str, **options: Any) -> dict:
        from hushh_mcp.services.pod_commerce_read import project_commerce_metadata
        from hushh_mcp.services.pod_specialist_runtime import PodSpecialistInformationUnavailable

        raw = await self._read(user_id, operation=operation, **options)
        if raw.get("operation") != operation:
            raise PodSpecialistInformationUnavailable("marketplace")
        try:
            return project_commerce_metadata(raw["result"], operation)["result"]
        except (KeyError, ValueError, TypeError):
            raise PodSpecialistInformationUnavailable("marketplace") from None
