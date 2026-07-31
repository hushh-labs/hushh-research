from typing import Any, Dict

import httpx


class HusshClient:
    def __init__(
        self, api_key: str, endpoint: str, transport: httpx.AsyncBaseTransport | None = None
    ):
        self.api_key = api_key
        self.endpoint = endpoint.rstrip("/")
        self.client = httpx.AsyncClient(
            headers={"X-API-Key": self.api_key},
            transport=transport,
        )

    async def get_discovery(self) -> Dict[str, Any]:
        """Phase 0: Discovery"""
        response = await self.client.get(f"{self.endpoint}/.well-known/hussh")
        response.raise_for_status()
        return response.json()

    async def request_consent(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Phase 3: Consent (Handshake)"""
        response = await self.client.post(f"{self.endpoint}/consent/handshake", json=payload)
        response.raise_for_status()
        return response.json()

    async def get_context(self, crt: str) -> Dict[str, Any]:
        """Phase 4: Context Delivery"""
        response = await self.client.get(
            f"{self.endpoint}/consent/context", headers={"X-Hussh-Consent-Token": crt}
        )
        response.raise_for_status()
        return response.json()

    async def acknowledge(self, grant_id: str, effects: str) -> Dict[str, Any]:
        """Phase 5: Acknowledgment"""
        params = {"grant_id": grant_id, "effects": effects}
        response = await self.client.post(f"{self.endpoint}/consent/ack", params=params)
        response.raise_for_status()
        return response.json()

    async def close(self):
        await self.client.aclose()
