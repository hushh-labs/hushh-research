"""Compatibility facade for the consumer scope-commerce provider lifecycle.

One canonical store and replaceable Stripe adapter are shared by every handler.
Public methods, value exports, private helper imports and replay behavior remain
available through this entrypoint.
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

from .provider_accounts import ConnectOnboarding
from .provider_config import CountryPayoutPolicy as CountryPayoutPolicy
from .provider_config import ScopeCommerceProviderConfig as ScopeCommerceProviderConfig
from .provider_contracts import _derived_id as _derived_id
from .provider_contracts import _hosted_url as _hosted_url
from .provider_contracts import _opaque as _opaque
from .provider_contracts import _operation_id as _operation_id
from .provider_contracts import _projection as _projection
from .provider_funding import FundingCheckout, FundingReceipt, SourceRefundAccess
from .provider_operations import DurableOperationRunner
from .provider_payouts import PayoutReceiptSettlement
from .provider_prerequisites import connect_webhook_reason, provider_prerequisites
from .provider_recovery import ScopeCommerceRecoveryMixin
from .provider_transfers import TransferDelivery
from .provider_webhooks import VerifiedWebhookHandlers
from .provider_withdrawal import WithdrawalIntent
from .stripe_adapter import CommerceProviderError, ScopeCommerceProvider, StripeScopeCommerceAdapter

if TYPE_CHECKING:
    from .service import ScopeCommerceService


class ScopeCommerceProviderService(
    FundingCheckout,
    FundingReceipt,
    SourceRefundAccess,
    ConnectOnboarding,
    WithdrawalIntent,
    TransferDelivery,
    PayoutReceiptSettlement,
    VerifiedWebhookHandlers,
    ScopeCommerceRecoveryMixin,
    DurableOperationRunner,
):
    def __init__(
        self,
        store: ScopeCommerceService,
        *,
        adapter: ScopeCommerceProvider | None = None,
        config: ScopeCommerceProviderConfig | None = None,
    ) -> None:
        self.store = store
        self.config = config or ScopeCommerceProviderConfig.from_env()
        self._uses_process_provider = adapter is None
        if adapter is None:
            prerequisites = provider_prerequisites(self.config, new_activity=False)
            if not prerequisites["ready"]:
                reason = prerequisites["reason_code"]
                if reason not in {
                    "provider_sandbox_policy_required",
                    "provider_sandbox_environment_mismatch",
                }:
                    reason = "provider_unavailable"
                raise CommerceProviderError(reason)
            secret = os.getenv("SCOPE_COMMERCE_STRIPE_SECRET_KEY") or ""
            webhook = os.getenv("SCOPE_COMMERCE_STRIPE_WEBHOOK_SECRET") or ""
            connected = os.getenv("SCOPE_COMMERCE_STRIPE_CONNECT_WEBHOOK_SECRET") or ""
            webhook_mode = os.getenv("SCOPE_COMMERCE_STRIPE_WEBHOOK_MODE") or "endpoints"
            adapter = StripeScopeCommerceAdapter(
                secret, webhook, connect_webhook_secret=connected, webhook_mode=webhook_mode
            )
        self.adapter = adapter

    async def _admit(self, *, new_activity: bool = True) -> None:
        if new_activity and self._uses_process_provider:
            prerequisites = provider_prerequisites(self.config, new_activity=True)
            if not prerequisites["ready"]:
                raise CommerceProviderError(prerequisites["reason_code"] or "provider_unavailable")
        elif isinstance(self.adapter, StripeScopeCommerceAdapter):
            reason = connect_webhook_reason(
                new_activity=new_activity,
                mode=self.adapter.webhook_mode,
                connected_secret=self.adapter.connect_webhook_secret,
            )
            if reason:
                raise CommerceProviderError(reason)
        await super()._admit(new_activity=new_activity)
