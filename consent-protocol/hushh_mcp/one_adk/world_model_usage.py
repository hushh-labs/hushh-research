"""Numeric provider receipts; no prompts, content or pricing authority."""

from collections.abc import Mapping
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class UsageReceipt(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    input_tokens: int | None = Field(default=None, ge=0, le=10_000_000)
    output_tokens: int | None = Field(default=None, ge=0, le=10_000_000)
    cached_input_tokens: int | None = Field(default=None, ge=0, le=10_000_000)
    elapsed_ms: int = Field(ge=0)


class UsageSummary(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    model_calls: int = Field(ge=0, le=16)
    recorded_calls: int = Field(ge=0, le=16)
    input_tokens: int | None = Field(ge=0)
    output_tokens: int | None = Field(ge=0)
    cached_input_tokens: int | None = Field(ge=0)
    provider_elapsed_ms: int | None = Field(ge=0)
    bing_requests: int | None = Field(ge=0)


def public_result(result: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Keep strict existing JSON/SSE bodies compatible; metrics travel in a header."""
    if "_provider_usage" not in result:
        return result, None
    usage = UsageSummary.model_validate(result["_provider_usage"]).model_dump()
    return {key: value for key, value in result.items() if key != "_provider_usage"}, usage


def provider_usage(usage: Any, *, elapsed_ms: int) -> UsageReceipt:
    """Missing SDK usage is unknown, including when a response cannot parse."""

    def field(value: Any, key: str) -> Any:
        return value.get(key) if isinstance(value, Mapping) else getattr(value, key, None)

    def count(value: Any) -> int | None:
        return value if type(value) is int and 0 <= value <= 10_000_000 else None

    inputs = count(field(usage, "input_tokens"))
    cached = count(field(field(usage, "input_tokens_details"), "cached_tokens"))
    if inputs is not None and cached is not None and cached > inputs:
        cached = None
    return UsageReceipt(
        input_tokens=inputs,
        output_tokens=count(field(usage, "output_tokens")),
        cached_input_tokens=cached,
        elapsed_ms=max(0, elapsed_ms),
    )


def summarize_usage(
    records: dict[str, Any],
    *,
    model_slots: set[int],
    search_slots: set[int],
    searches: dict[str, Any],
) -> dict[str, Any]:
    """Report complete totals only when every charged call has its receipt."""
    receipts = []
    for slot, raw in records.items():
        if not slot.isdigit() or str(int(slot)) != slot or int(slot) not in model_slots:
            raise ValueError("PWM usage receipt has no charged model slot")
        receipts.append(UsageReceipt.model_validate(raw))

    def total(field: str) -> int | None:
        values: list[int | None] = [getattr(row, field) for row in receipts]
        if len(receipts) != len(model_slots) or any(value is None for value in values):
            return None
        return sum(value for value in values if value is not None)

    if any(not isinstance(row, dict) for row in searches.values()):
        raise ValueError("PWM search usage has an invalid shape")
    bing = [row.get("bing_requests") for row in searches.values()]
    bing_requests = (
        sum(bing)
        if set(searches) == {str(slot) for slot in search_slots}
        and all(type(value) is int and 0 <= value <= 100 for value in bing)
        else None
    )
    return UsageSummary.model_validate(
        {
            "model_calls": len(model_slots),
            "recorded_calls": len(receipts),
            "input_tokens": total("input_tokens"),
            "output_tokens": total("output_tokens"),
            "cached_input_tokens": total("cached_input_tokens"),
            "provider_elapsed_ms": total("elapsed_ms"),
            "bing_requests": bing_requests,
        }
    ).model_dump()
