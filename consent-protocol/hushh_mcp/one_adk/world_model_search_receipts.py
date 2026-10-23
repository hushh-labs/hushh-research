"""Native search receipt admission and numeric budget accounting; no semantic decisions."""

from collections.abc import Mapping
from typing import Any

from hushh_mcp.one_adk.azure_web_receipts import AzureWebReceipts, extract_azure_web_receipts
from hushh_mcp.one_adk.tavily_search import TavilyReceipts, extract_tavily_receipts


def normalize_search_receipts(
    raw: Mapping[str, Any], provider: str
) -> AzureWebReceipts | TavilyReceipts:
    return extract_tavily_receipts(raw) if provider == "tavily" else extract_azure_web_receipts(raw)


def billed_search_requests(attempts: dict[str, Any], provider: str, cap: int) -> int:
    total: int = 0
    for row in attempts.values():
        if not isinstance(row, dict):
            raise ValueError("PWM search checkpoint has an invalid shape")
        billed = row.get("search_requests" if provider == "tavily" else "bing_requests")
        if billed is None:
            # An unacknowledged dispatch may be billed: never replay it.
            return cap
        if type(billed) is not int or not 0 <= billed <= 100:
            raise ValueError("PWM search usage checkpoint is invalid")
        total += billed
    return total


def admit_search_receipts(evidence, receipts, *, provider, max_receipts, at):
    if len(receipts) + len(evidence.sources) > max_receipts:
        raise ValueError("Provider receipt exceeds supported bounds")
    admitted = dict(receipts)
    refs = []
    for source in evidence.sources:
        value = source.model_dump()
        ref = next((key for key, existing in admitted.items() if existing == value), None)
        if ref is None:
            ref = f"s{len(admitted) + 1}"
            admitted[ref] = value
        if ref not in refs:
            refs.append(ref)
    return admitted, {
        "observed": evidence.observed,
        "answer": evidence.answer,
        "source_refs": refs,
        "citations": list(evidence.citations),
        "state": "received" if evidence.observed else "unavailable",
        "bing_requests": evidence.num_requests if provider == "bing" else 0,
        "search_requests": evidence.num_requests,
        "search_credits": evidence.credits if isinstance(evidence, TavilyReceipts) else None,
        "at": at,
    }
