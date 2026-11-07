"""Exact arithmetic over already extracted, caller-authorized receipt rows."""

import re
from collections.abc import Sequence
from decimal import Decimal, localcontext

import pycountry
from pydantic import BaseModel, ConfigDict, Field, field_validator


class ReceiptAmount(BaseModel):
    model_config = ConfigDict(
        extra="forbid", strict=True, frozen=True, revalidate_instances="always"
    )

    currency: str = Field(pattern=r"^[A-Z]{3}$")
    amount: str = Field(pattern=r"^[+-]?[0-9]{1,18}(?:\.[0-9]{1,6})?$")
    source_ref: str = Field(
        min_length=1, max_length=4096, pattern=r"^[A-Za-z0-9_-]+(?:[:/][A-Za-z0-9_-]+)*$"
    )
    transaction_key: str | None = Field(default=None, min_length=1, max_length=256)
    label: str = Field(default="Receipt", min_length=1, max_length=120)
    evidence_quote: str | None = Field(default=None, min_length=1, max_length=256)

    @field_validator("currency")
    @classmethod
    def iso_currency(cls, value: str) -> str:
        if pycountry.currencies.get(alpha_3=value) is None:
            raise ValueError("Receipt currency must be a recognized ISO 4217 code")
        return value


_EVIDENCE_NUMBER = re.compile(
    r"(?<![\w.,+-])[+-]?(?:[1-9][0-9]{0,2}(?:,[0-9]{3})+|[0-9]+)"
    r"(?:\.[0-9]{1,6})?(?![\w,]|\.[0-9])"
)


def validate_receipt_amount_evidence(row: ReceiptAmount, source_text: str) -> bool:
    """Check exact quote and numeric value; the model selects the amount's meaning."""
    quote = row.evidence_quote
    if not quote or not isinstance(source_text, str) or quote not in source_text:
        return False
    expected = Decimal(row.amount)
    return any(
        Decimal(token.group().replace(",", "")) == expected
        for token in _EVIDENCE_NUMBER.finditer(quote)
    )


def sum_receipt_amounts(rows: Sequence[ReceiptAmount | dict]) -> dict:
    """Sum by currency; source_count counts distinct retained source references.

    Only caller-supplied transaction keys deduplicate. This function does not
    extract rows, infer transactions, validate source authority, or convert FX.
    """
    if len(rows) > 50:
        raise ValueError("At most 50 receipt rows are supported")
    totals: dict[str, Decimal] = {}
    transactions: dict[str, tuple[str, Decimal]] = {}
    sources: set[str] = set()
    with localcontext() as context:
        context.prec = 32  # 18 integer + 6 fraction digits, plus a bounded sum of 50.
        for raw in rows:
            row = ReceiptAmount.model_validate(raw)
            amount = Decimal(row.amount)
            identity = (row.currency, amount)
            if row.transaction_key is not None:
                previous = transactions.get(row.transaction_key)
                if previous is not None and previous != identity:
                    raise ValueError("Conflicting duplicate receipt transaction")
                if previous is not None:
                    continue
                transactions[row.transaction_key] = identity
            totals[row.currency] = totals.get(row.currency, Decimal(0)) + amount
            sources.add(row.source_ref)
    return {
        "currency_totals": {
            currency: format(total, "f") for currency, total in sorted(totals.items())
        },
        "source_count": len(sources),
    }
