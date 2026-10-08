"""Compatibility composition of canonical financial capabilities."""

from .capital import OperatingCapital
from .disputes import FundingDisputes
from .earnings import AccessEarnings
from .erasure import FinancialErasure
from .funding import FundingAdmission, FundingReceipts
from .obligations import DurableObligations
from .refunds import SourceRefundReceipts, SourceRefundReservations
from .treasury import TreasuryBacking
from .withdrawals import WithdrawalReceipts, WithdrawalReservations


class FinanceMixin(
    OperatingCapital,
    TreasuryBacking,
    FundingAdmission,
    FundingReceipts,
    AccessEarnings,
    SourceRefundReservations,
    SourceRefundReceipts,
    FundingDisputes,
    DurableObligations,
    WithdrawalReservations,
    WithdrawalReceipts,
    FinancialErasure,
):
    """Financial methods retain the service host transaction and journal."""
