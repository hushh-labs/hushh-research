"""Compatibility composition of the durable reconciliation lifecycle.

Every handler uses the same service context and canonical commercial store.
"""

from .provider_obligations import FundingRefundDrain, TransferRecovery
from .provider_reconciliation import ReconciliationCoordinator, WithdrawalRecovery
from .provider_retention import RetentionPolicy


class ScopeCommerceRecoveryMixin(
    ReconciliationCoordinator,
    WithdrawalRecovery,
    TransferRecovery,
    FundingRefundDrain,
    RetentionPolicy,
):
    """Existing recovery entrypoint retained behind cohesive handlers."""
