"""Owner-bound, ephemeral access to the existing Connect account dashboard."""

from __future__ import annotations

from urllib.parse import urlsplit

from .provider_accounts import ConnectOnboarding
from .stripe_adapter import CommerceProviderError


class ConnectAccountManagement(ConnectOnboarding):
    async def management_link(self, *, user_id: str) -> dict[str, str]:
        """Manage only this owner's scope account, including during admission pause.

        Login links are short-lived presentation credentials, never ledger events
        or settlement receipts. Do not persist them in the operation journal.
        """
        self._admit_actor(user_id)
        await self._admit(new_activity=False)
        saved = await self._seller_binding(user_id)
        if saved is None:
            raise CommerceProviderError("seller_onboarding_required")
        account = await self.adapter.retrieve("seller_account", saved["account_id"])
        if (
            saved["livemode"] is not self.config.livemode
            or account.get("id") != saved["account_id"]
            or account.get("type") != "express"
            or account.get("deleted") is True
            or account.get("country") != saved["country"]
            or saved["country"] not in self.config.countries
            or account.get("details_submitted") is not True
        ):
            raise CommerceProviderError("provider_account_mismatch")
        link = await self.adapter.management_link(saved["account_id"])
        raw = link.get("url")
        parsed = urlsplit(raw) if isinstance(raw, str) else None
        if (
            link.get("object") != "login_link"
            or parsed is None
            or parsed.scheme != "https"
            or parsed.hostname not in {"connect.stripe.com", "stripe.com"}
            or not parsed.path.startswith("/express/")
            or not parsed.path.removeprefix("/express/")
            or parsed.username
            or parsed.password
            or parsed.port
            or parsed.fragment
        ):
            raise CommerceProviderError("provider_response_mismatch")
        current = await self._seller_binding(user_id)
        if (
            current is None
            or current["account_id"] != saved["account_id"]
            or current["livemode"] is not saved["livemode"]
            or current["country"] != saved["country"]
        ):
            raise CommerceProviderError("provider_account_mismatch")
        return {"url": raw}
