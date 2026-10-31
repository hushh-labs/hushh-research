"""Fixed-template delivery through the existing authenticated hushh-mail-api."""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
import time

import httpx

from hushh_mcp.services.email_auth.config import EmailAuthConfig

logger = logging.getLogger(__name__)


class MailApiTransport:
    def __init__(self, endpoint: str, api_key: str, client=None, token_provider=None):
        if endpoint != "https://hushh-mail-api-646258530541.us-central1.run.app":
            raise ValueError("Only the configured Hussh mail service is supported.")
        self.endpoint = endpoint
        self.api_key = api_key
        self.client = client
        if token_provider is None:
            from hushh_mcp.services.email_auth.one_sender import OneSenderTokenProvider

            token_provider = OneSenderTokenProvider()
        self.token_provider = token_provider

    async def prepare(self) -> None:
        # Refresh before acquiring a delivery lease, never while a lease ages.
        await self.token_provider.get()

    async def send(self, email: str, code: str, challenge_id: str, remaining: int) -> None:
        # The existing mail API owns the fixed One template and delivery.
        token = await self.token_provider.get()
        payload = {
            "transport": "one-delegated",
            "to": email,
            "code": code,
            "expiresInSeconds": remaining,
            "idempotencyKey": "email-otp:" + challenge_id,
        }

        async def dispatch(client):
            response = await client.post(
                self.endpoint + "/v1/send",
                json=payload,
                headers={"x-api-key": self.api_key, "x-one-gmail-access-token": token},
                timeout=8,
            )
            result = response.json() if response.is_success else {}
            if (
                not response.is_success
                or result.get("from") != "one@hushh.ai"
                or not result.get("success")
            ):
                # Never include the provider response, request or body in an error.
                raise RuntimeError("Email delivery was not accepted.")

        if self.client:
            await dispatch(self.client)
        else:
            async with httpx.AsyncClient(follow_redirects=False, trust_env=False) as client:
                await dispatch(client)


class EmailAuthDeliveryWorker:
    def __init__(self, service, transport):
        self.service = service
        self.transport = transport

    async def deliver_one(self) -> bool:
        store = self.service.store
        candidate = await store.delivery_candidate()
        if not candidate:
            return False
        lease_id = secrets.token_urlsafe(24)
        try:
            await self.service.approve_domain(candidate["domain"])
            if hasattr(self.transport, "prepare"):
                await self.transport.prepare()
            row = await store.lease_delivery(
                candidate, lease_id, self.service.evaluator.risk.version
            )
            if not row:
                return False
            async with store.delivery_authority(
                row["challenge_id"], lease_id, self.service.evaluator.risk.version
            ) as admitted:
                associated = f"otp:{admitted['challenge_id']}:{admitted['destination_hash']}:{admitted['expires_at'].isoformat()}"
                payload = json.loads(self.service.cipher.open(admitted["payload"], associated))
                remaining = int(admitted["expires_at"].timestamp() - time.time())
                if remaining < 15:
                    raise RuntimeError("Delivery expired.")
                EmailAuthConfig.from_env().require_ready()
                await self.transport.send(
                    payload["email"], payload["code"], admitted["challenge_id"], remaining
                )
            return True
        except Exception:
            await store.finish_delivery(candidate["challenge_id"], lease_id, False)
            await store.defer_delivery(candidate["challenge_id"])
            logger.warning("email_auth.delivery_deferred")
            return False

    async def run(self) -> None:
        while True:
            try:
                if not EmailAuthConfig.from_env().enabled:
                    return
                EmailAuthConfig.from_env().require_ready()
                await self.deliver_one()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning("email_auth.worker_unavailable")
            await asyncio.sleep(2)


async def run_retention(store_factory) -> None:
    """Expiry erasure continues even with issuance disabled or keys unavailable."""
    while True:
        try:
            store = await store_factory()
            await store.cleanup()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("email_auth.retention_unavailable")
        await asyncio.sleep(60)
