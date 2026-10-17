"""Stable scope commerce facade: one transaction gate and one journal authority."""

from .access import CommercialAccess
from .activation import ActivationLease, EncryptedActivation
from .activity import CommerceActivity
from .finance import FinanceMixin
from .host import COMMERCE_GATE as COMMERCE_GATE
from .host import CommerceEnvironment, CommerceIdentity, CommerceJournal, CommerceRuntime
from .purchases import PurchaseReservations
from .quotes import ImmutableQuotes, QuoteApproval, QuoteReadProjection
from .readiness import CommerceReadiness
from .recovery import DisputeRecovery, WithdrawalProvenance
from .sandbox_readiness import SandboxReadiness
from .tariffs import ScopeTariffs


class ScopeCommerceService(
    CommerceRuntime,
    CommerceEnvironment,
    CommerceJournal,
    CommerceIdentity,
    ScopeTariffs,
    ImmutableQuotes,
    QuoteApproval,
    QuoteReadProjection,
    PurchaseReservations,
    ActivationLease,
    EncryptedActivation,
    CommercialAccess,
    CommerceActivity,
    CommerceReadiness,
    SandboxReadiness,
    FinanceMixin,
    WithdrawalProvenance,
    DisputeRecovery,
):
    """Compose bounded capabilities without creating additional authorities."""
