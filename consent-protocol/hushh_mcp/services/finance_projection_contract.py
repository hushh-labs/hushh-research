"""Strict plaintext schema used only after explicit owner and recipient model approval."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat


class Object(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Amount(Object):
    value: FiniteFloat
    currency: Literal["USD"]


class Allocation(Object):
    name: str = Field(max_length=160)
    percent: FiniteFloat
    amount: Amount | None = None


class Observation(Object):
    date: str = Field(max_length=40)
    value: FiniteFloat


class Performance(Object):
    balanceChangePct: FiniteFloat | None
    unit: Literal["percent", "USD"]
    history: list[Observation] = Field(max_length=366)
    total: Amount | None = None


class Holding(Object):
    symbol: str = Field(pattern=r"^[A-Z0-9.^-]{1,16}$")
    name: str = Field(max_length=160)
    weightPct: FiniteFloat
    gainLossPct: FiniteFloat | None
    amount: Amount | None = None
    quantity: FiniteFloat | None = None
    price: Amount | None = None
    gainLoss: Amount | None = None


class Projection(Object):
    schema_version: Literal["finance-share-v1"] = Field(alias="schema")
    source: Literal["statement", "plaid"]
    sourcePeriod: str | None = Field(max_length=100)
    allocation: list[Allocation] | None = Field(default=None, max_length=100)
    sectors: list[Allocation] | None = Field(default=None, max_length=100)
    performance: Performance | None = None
    holdings: list[Holding] | None = Field(default=None, max_length=100)
    note: str | None = Field(default=None, max_length=1000)
    commitmentNonce: str = Field(pattern=r"^[a-f0-9]{64}$")


def validate_finance_projection(value, sections, show_amounts):
    checked = Projection.model_validate(value)
    for field in ("allocation", "performance", "holdings", "note"):
        if (field in checked.model_fields_set) != (field in sections):
            raise ValueError("unapproved_section")
    if checked.sectors is not None and "allocation" not in sections:
        raise ValueError("unapproved_sectors")
    if not show_amounts:
        if (
            any(r.amount is not None for r in (checked.allocation or []) + (checked.sectors or []))
            or checked.performance is not None
            and (checked.performance.unit != "percent" or checked.performance.total is not None)
            or any(
                r.amount is not None
                or r.quantity is not None
                or r.price is not None
                or r.gainLoss is not None
                for r in checked.holdings or []
            )
        ):
            raise ValueError("unapproved_amount")
    return checked
