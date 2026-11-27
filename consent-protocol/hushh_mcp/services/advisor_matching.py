"""Bounded, explicit service aliases shared by the recommendation query owner.

These describe declared services, never inferred expertise or investor needs.
"""

from typing import Literal

AdvisorService = Literal[
    "portfolio_management", "retirement_planning", "tax_planning", "estate_planning"
]

SERVICE_ALIASES: dict[str, tuple[str, ...]] = {
    "portfolio_management": ("portfolio management", "investment management", "asset management"),
    "retirement_planning": ("retirement planning", "retirement plan consulting"),
    "tax_planning": ("tax planning",),
    "estate_planning": ("estate planning",),
}


def advisor_service_aliases(service: str) -> tuple[str, ...]:
    if service not in SERVICE_ALIASES:
        raise ValueError("Unknown advisor service")
    return SERVICE_ALIASES[service]
