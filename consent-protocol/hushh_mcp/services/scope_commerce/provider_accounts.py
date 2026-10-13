"""Hosted Connect onboarding and verified seller eligibility."""

from __future__ import annotations

from typing import Any

from hushh_mcp.services.connect_payout_binding import (
    PayoutBindingConflict,
    document_account_ids,
    require_separate_payout_account,
)

from .provider_contracts import ProviderContext, _derived_id, _operation_id
from .provider_onboarding_links import onboarding_urls, validate_onboarding_link
from .stripe_adapter import CommerceProviderError


async def _require_scope_source(
    connection: Any, owner: str, mode: bool, account: str | None
) -> None:
    foreign_ids = await document_account_ids(connection, owner, mode, account)
    try:
        require_separate_payout_account(account, foreign_ids)
    except PayoutBindingConflict:
        raise CommerceProviderError("provider_account_source_conflict") from None


class ConnectOnboarding(ProviderContext):
    async def _seller_binding(self, user_id: str) -> dict[str, Any] | None:
        async def read(connection: Any) -> dict[str, Any] | None:
            row = await connection.fetchrow(
                "SELECT * FROM scope_commerce_seller_accounts WHERE user_id=$1", user_id
            )
            await _require_scope_source(
                connection, user_id, self.config.livemode, row["account_id"] if row else None
            )
            return dict(row) if row is not None else None

        return await self.store._transaction(read)

    def _seller_eligible(self, account: dict[str, Any], country: str) -> bool:
        return (
            country in self.config.countries
            and account.get("country") == country
            and self._usd_payout_destination(account)
            and account.get("details_submitted") is True
            and account.get("payouts_enabled") is True
            and (account.get("capabilities") or {}).get("transfers") == "active"
            and not (account.get("requirements") or {}).get("disabled_reason")
            and (account.get("settings") or {})
            .get("payouts", {})
            .get("schedule", {})
            .get("interval")
            == "manual"
        )

    @staticmethod
    def _usd_payout_destination(account: dict[str, Any]) -> bool:
        """Inspect provider routing facts without retaining external-bank details.

        Connect external banks normally use status ``new``; ``verified`` is a
        customer-bank status, not a required Connect payout status. Missing USD
        default/bank evidence fails closed instead of assuming no conversion.
        """
        if account.get("default_currency") != "usd":
            return False
        external = account.get("external_accounts") or {}
        defaults = [
            bank
            for bank in external.get("data", [])
            if bank.get("currency") == "usd" and bank.get("default_for_currency") is True
        ]
        if len(defaults) != 1:
            return False
        bank = defaults[0]
        requirements = bank.get("requirements") or {}
        return (
            bank.get("object") == "bank_account"
            and bank.get("account") == account.get("id")
            and bank.get("status") in {"new", "validated", "verified"}
            and "standard" in (bank.get("available_payout_methods") or [])
            and not any(
                requirements.get(field)
                for field in ("currently_due", "past_due", "pending_verification")
            )
        )

    async def seller_status(self, user_id: str) -> dict[str, Any]:
        await self._admit(new_activity=False)
        saved = await self._seller_binding(user_id)
        if saved is None:
            return {"eligible": False, "country": None}
        account = await self.adapter.retrieve("seller_account", saved["account_id"])
        if (
            account.get("id") != saved["account_id"]
            or saved["livemode"] is not self.config.livemode
        ):
            raise CommerceProviderError("provider_account_mismatch")
        eligible = self._seller_eligible(account, saved["country"])

        async def update(connection: Any) -> None:
            await connection.execute(
                """UPDATE scope_commerce_seller_accounts SET eligible=$2,updated_at=clock_timestamp()
                WHERE user_id=$1 AND account_id=$3""",
                user_id,
                eligible,
                saved["account_id"],
            )
            seller = await self.store._seller(connection, user_id)
            await connection.execute(
                "UPDATE scope_commerce_sellers SET account_id=$2,country=$3,livemode=$4 WHERE seller_id=$1",
                seller["seller_id"],
                saved["account_id"],
                saved["country"],
                self.config.livemode,
            )

        await self.store._transaction(update)
        return {"accountId": saved["account_id"], "eligible": eligible, "country": saved["country"]}

    async def onboarding(self, *, user_id: str, country: str, operation_id: str) -> dict[str, Any]:
        operation_id = _operation_id(operation_id)
        self._admit_actor(user_id)
        await self._admit()
        if country not in self.config.countries:
            raise CommerceProviderError("seller_country_unavailable")
        saved = await self._prepare_seller_account(user_id=user_id, country=country)
        request = {
            "account": saved["account_id"],
            "type": "account_onboarding",
            **onboarding_urls(self.config.frontend_origin, self.config.return_path, operation_id),
            "collection_options": {"fields": "currently_due"},
        }

        # Recover the exact original intent after a release; a new attempt uses
        # incremental collection without changing an in-flight request hash.
        existing = await self._existing_operation(operation_id)
        if existing is not None:
            if existing["user_id"] != user_id or existing["kind"] != "onboarding":
                raise CommerceProviderError("provider_operation_conflict")
            previous = self._saved_request(existing)
            if (
                previous.get("account") != saved["account_id"]
                or previous.get("type") != "account_onboarding"
                or previous.get("return_url") != request["return_url"]
                or previous.get("refresh_url") != request["refresh_url"]
            ):
                raise CommerceProviderError("provider_operation_conflict")
            request = previous

        link = await self._run_operation(
            user_id=user_id,
            operation_id=operation_id,
            kind="onboarding",
            request=request,
            validate=validate_onboarding_link,
        )
        return {
            "accountId": saved["account_id"],
            "onboardingUrl": link["url"],
            "returnUrl": request["return_url"],
            "eligible": False,
        }

    async def _seller_creation_request(
        self, user_id: str, country: str, operation_id: str
    ) -> dict[str, Any]:
        metadata = self._metadata(operation_id, user_id)
        request = {
            "type": "express",
            "business_type": "individual",
            "business_profile": {
                "product_description": (
                    "Individual providing consented, time-limited access to their own "
                    "information through Hussh."
                )
            },
            "country": country,
            "capabilities": {"transfers": {"requested": True}},
            "metadata": metadata,
            "settings": {"payouts": {"schedule": {"interval": "manual"}}},
        }
        existing = await self._existing_operation(operation_id)
        if existing is not None:
            if existing["user_id"] != user_id or existing["kind"] != "seller_account":
                raise CommerceProviderError("provider_operation_conflict")
            previous = self._saved_request(existing)
            if (
                previous.get("type") != "express"
                or previous.get("country") != country
                or previous.get("metadata") != metadata
                or previous.get("capabilities") != request["capabilities"]
                or previous.get("settings") != request["settings"]
            ):
                raise CommerceProviderError("provider_operation_conflict")
            request = previous
        return request

    async def _prepare_seller_account(self, *, user_id: str, country: str) -> dict[str, Any]:
        saved = await self._seller_binding(user_id)
        if saved is None:
            account_operation = _derived_id(user_id, "seller_account")
            metadata = self._metadata(account_operation, user_id)
            request = await self._seller_creation_request(user_id, country, account_operation)

            def validate(account: dict[str, Any]) -> None:
                self._validate_object(account, object_type="account", metadata=metadata)
                if account.get("country") != country:
                    raise CommerceProviderError("provider_response_mismatch")

            account = await self._run_operation(
                user_id=user_id,
                operation_id=account_operation,
                kind="seller_account",
                request=request,
                validate=validate,
            )

            async def bind(connection: Any) -> dict[str, Any]:
                await _require_scope_source(
                    connection, user_id, self.config.livemode, account["id"]
                )
                await connection.execute(
                    """INSERT INTO scope_commerce_seller_accounts(user_id,account_id,country,livemode,eligible)
                    VALUES($1,$2,$3,$4,FALSE) ON CONFLICT(user_id) DO NOTHING""",
                    user_id,
                    account["id"],
                    country,
                    self.config.livemode,
                )
                winner = await connection.fetchrow(
                    "SELECT * FROM scope_commerce_seller_accounts WHERE user_id=$1 FOR UPDATE",
                    user_id,
                )
                if (
                    winner is None
                    or winner["account_id"] != account["id"]
                    or winner["country"] != country
                    or winner["livemode"] is not self.config.livemode
                ):
                    raise CommerceProviderError("provider_account_mismatch")
                seller = await self.store._seller(connection, user_id)
                await connection.execute(
                    "UPDATE scope_commerce_sellers SET account_id=$2,country=$3,livemode=$4 WHERE seller_id=$1",
                    seller["seller_id"],
                    account["id"],
                    country,
                    self.config.livemode,
                )
                return dict(winner)

            saved = await self.store._transaction(bind)
        if (
            saved is None
            or saved["country"] != country
            or saved["livemode"] is not self.config.livemode
        ):
            raise CommerceProviderError("provider_account_mismatch")
        return saved
