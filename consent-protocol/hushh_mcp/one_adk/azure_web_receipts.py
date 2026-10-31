"""Bounded receipts from an Azure Responses API web-search result.

The response text is a research lead, not proof of a claim. Only provider URL
citations are admitted as profile sources, and only after a completed web search.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal, TypedDict

from pydantic import ValidationError

from hushh_mcp.one_adk.profile_research import ProfileSource

MAX_OUTPUT_ITEMS = 64
MAX_CONTENT_PARTS = 64
MAX_ANNOTATIONS = 200
MAX_SOURCES = 100
MAX_ANSWER_CHARS = 100_000
MAX_WEB_REQUESTS = 100
MAX_CITATION_TITLE_CHARS = 1024


class AzureCitation(TypedDict):
    start_index: int
    end_index: int
    title: str
    url: str


@dataclass(frozen=True, slots=True)
class AzureWebReceipts:
    """Search observation and cited sources; `answer` remains untrusted prose."""

    observed: bool
    answer: str
    sources: tuple[ProfileSource, ...]
    num_requests: int
    citations: tuple[AzureCitation, ...] = ()
    rejection_reason: Literal[
        "none", "no_retrieval", "invalid_citation", "no_sources", "overlap"
    ] = "none"


def _bounded_list(value: Any, *, limit: int, name: str) -> list[Any]:
    if not isinstance(value, list):
        raise ValueError(f"Azure {name} must be a list")
    if len(value) > limit:
        raise ValueError(f"Azure {name} exceeds supported bounds")
    return value


def _request_count(response: Mapping[str, Any]) -> int | None:
    usage = response.get("tool_usage")
    if usage is None:
        return None
    if not isinstance(usage, Mapping):
        raise ValueError("Azure tool usage has an invalid shape")
    web_search = usage.get("web_search")
    if web_search is None:
        return None
    if not isinstance(web_search, Mapping):
        raise ValueError("Azure web-search usage has an invalid shape")
    count = web_search.get("num_requests")
    if type(count) is not int or not 0 <= count <= MAX_WEB_REQUESTS:
        raise ValueError("Azure web-search request count is invalid")
    return count


def _citation(annotation: Any, text: str, *, offset: int) -> AzureCitation | None:
    if not isinstance(annotation, Mapping) or annotation.get("type") != "url_citation":
        return None
    start = annotation.get("start_index")
    end = annotation.get("end_index")
    # Azure citation offsets can be UTF-16 positions; never accept an unattached
    # or out-of-bounds annotation as a source receipt.
    text_units = len(text.encode("utf-16-le", errors="surrogatepass")) // 2
    if (
        type(start) is not int
        or type(end) is not int
        or start < 0
        or end <= start
        or end > text_units
    ):
        return None
    url = annotation.get("url")
    if not isinstance(url, str):
        return None
    title = annotation.get("title")
    if not isinstance(title, str) or len(title) > MAX_CITATION_TITLE_CHARS:
        return None
    try:
        # Keep provider reference text and URL byte-for-byte. The factual
        # source contract is narrower; long titles remain display references.
        ProfileSource(title="Source", url=url)
    except (ValidationError, ValueError):
        return None
    return {"start_index": offset + start, "end_index": offset + end, "title": title, "url": url}


def _completed_retrieval(output: list[Any], count: int | None) -> bool:
    completed_calls = [
        item
        for item in output
        if isinstance(item, Mapping)
        and item.get("type") == "web_search_call"
        and item.get("status") == "completed"
    ]
    actions = [
        item["action"].get("type")
        for item in completed_calls
        if isinstance(item.get("action"), Mapping)
    ]
    completed_retrieval = any(
        isinstance(action, str) and action in {"search", "open_page", "find_in_page"}
        for action in actions
    )
    # Opening/finding in an existing page can explicitly bill zero Bing queries.
    # An actual search still requires a positive count; missing usage stays unknown.
    if completed_calls and (count is None or ("search" in actions and count == 0)):
        raise ValueError("Completed Azure web retrieval has no valid billable request count")
    return completed_retrieval


def extract_azure_web_receipts(response: Mapping[str, Any]) -> AzureWebReceipts:
    """Extract completed search/page retrievals and their URL-citation receipts.

    `num_requests` is the provider's billable Bing request count, which can be
    larger than the number of visible `web_search_call` entries. Missing usage
    after a completed search fails closed so the caller cannot undercount spend.
    """
    if not isinstance(response, Mapping):
        raise ValueError("Azure response must be a mapping")
    output = _bounded_list(response.get("output"), limit=MAX_OUTPUT_ITEMS, name="output")
    count = _request_count(response)
    completed_retrieval = _completed_retrieval(output, count)
    if response.get("status") != "completed" or not completed_retrieval:
        return AzureWebReceipts(False, "", (), count or 0, rejection_reason="no_retrieval")

    answer_parts: list[str] = []
    sources: list[ProfileSource] = []
    citations: list[AzureCitation] = []
    seen_urls: set[str] = set()
    annotation_count = 0
    content_count = 0
    answer_length = 0
    for item in output:
        if not isinstance(item, Mapping) or item.get("type") != "message":
            continue
        if item.get("role") != "assistant" or item.get("status") != "completed":
            continue
        for part in _bounded_list(
            item.get("content"), limit=MAX_CONTENT_PARTS, name="message content"
        ):
            content_count += 1
            if content_count > MAX_CONTENT_PARTS:
                raise ValueError("Azure message content exceeds supported bounds")
            if not isinstance(part, Mapping) or part.get("type") != "output_text":
                continue
            text = part.get("text")
            if not isinstance(text, str):
                raise ValueError("Azure output text has an invalid shape")
            answer_length += len(text) + bool(answer_parts)
            if answer_length > MAX_ANSWER_CHARS:
                raise ValueError("Azure answer exceeds supported bounds")
            offset = sum(
                len(part.encode("utf-16-le", errors="surrogatepass")) // 2 + 1
                for part in answer_parts
            )
            answer_parts.append(text)
            annotations = _bounded_list(
                part.get("annotations", []), limit=MAX_ANNOTATIONS, name="citations"
            )
            annotation_count += len(annotations)
            if annotation_count > MAX_ANNOTATIONS:
                raise ValueError("Azure citations exceed supported bounds")
            for annotation in annotations:
                if not isinstance(annotation, Mapping) or annotation.get("type") != "url_citation":
                    continue
                citation = _citation(annotation, text, offset=offset)
                if citation is None:
                    # A partial reference set would misrepresent Bing output.
                    return AzureWebReceipts(
                        False, "", (), count or 0, rejection_reason="invalid_citation"
                    )
                citations.append(citation)
                title, url = citation["title"], citation["url"]
                if len(title) > 160 or url in seen_urls:
                    continue
                if len(sources) >= MAX_SOURCES:
                    raise ValueError("Azure sources exceed supported bounds")
                # Page-open citations may have no provider title. Preserve that
                # exact citation; this is only a display label, never new evidence.
                source = ProfileSource(title=title or "Public page", url=url)
                seen_urls.add(url)
                sources.append(source)
    if not sources:
        return AzureWebReceipts(False, "", (), count or 0, rejection_reason="no_sources")
    citations.sort(key=lambda value: (value["start_index"], value["end_index"]))
    if any(
        previous["end_index"] > current["start_index"]
        for previous, current in zip(citations, citations[1:], strict=False)
    ):
        return AzureWebReceipts(False, "", (), count or 0, rejection_reason="overlap")
    return AzureWebReceipts(
        True, "\n".join(answer_parts), tuple(sources), count or 0, tuple(citations)
    )
