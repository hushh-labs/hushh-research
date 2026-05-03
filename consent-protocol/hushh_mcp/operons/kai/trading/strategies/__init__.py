"""Strategy implementations for the Kai trading specialist.

Every strategy is a pure function of a `BarSeries` panel and prior risk
state. Strategies emit a `SignalSeries` (target weight per name per
timestamp); the harness composes signals with position sizing and risk
limits to produce executable orders.
"""

from .base import Signal, SignalSeries, Strategy, StrategyContext
from .momentum import CrossSectionalMomentum
from .mean_reversion import ZScoreReversion
from .renaissance_overlay import RenaissanceOverlay
from .risk_parity import InverseVolAllocator
from .trend import DonchianBreakout

__all__ = [
    "CrossSectionalMomentum",
    "DonchianBreakout",
    "InverseVolAllocator",
    "RenaissanceOverlay",
    "Signal",
    "SignalSeries",
    "Strategy",
    "StrategyContext",
    "ZScoreReversion",
]
