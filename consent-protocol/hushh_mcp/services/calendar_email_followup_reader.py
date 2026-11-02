"""Complete, account-fenced Gmail text reads for Calendar follow-up assessment.

The caller supplies a token for the selected Google account and a live grant
check. This reader never selects a default mailbox or writes provider content.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import httpx
from opentelemetry.instrumentation.utils import suppress_instrumentation

from hushh_mcp.services.gmail_message_text import MessageTextError, message_text

_GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me"
_PROVIDER_ID = re.compile(r"[A-Za-z0-9_-]{1,200}\Z")
_MAX_RESPONSE_BYTES = 4 * 1024 * 1024
_MAX_READABLE_BYTES = 512 * 1024
_MAX_PARTS = 200
_MAX_DEPTH = 12
_SECTION_BYTES = 12 * 1024
_SECTION_OVERLAP_CHARS = 256


class CompleteMailReadError(RuntimeError):
    """Value-free provider or coverage error; never includes message content."""

    def __init__(
        self, code: str, *, retryable: bool = False, retry_after: int | None = None
    ) -> None:
        super().__init__(code)
        self.code = code
        self.retryable = retryable
        # Seconds the provider asked us to wait; bounded by the caller.
        self.retry_after = retry_after


@dataclass(frozen=True)
class BodySection:
    index: int
    start: int
    end: int
    text: str
    digest: str


@dataclass(frozen=True)
class CompleteMailMessage:
    message_id: str
    thread_id: str
    internal_date_ms: int
    subject: str
    sender: str
    body: str
    body_digest: str
    sections: tuple[BodySection, ...]
    # Standard automated-mail hints (RFC 3834, list headers). Context for the
    # extraction child only; never a decision by themselves.
    signals: tuple[str, ...] = ()


@dataclass(frozen=True)
class MailPage:
    messages: tuple[tuple[str, str], ...]
    next_page_token: str | None


async def list_message_page(
    *,
    client: httpx.AsyncClient,
    token: str,
    after_ms: int,
    before_ms: int,
    page_token: str | None,
    require_current: Callable[[], Awaitable[None]],
) -> MailPage:
    """Read one 25-message candidate page without silently dropping nextPageToken."""
    if after_ms < 0 or before_ms <= after_ms or (page_token and len(page_token) > 2048):
        raise CompleteMailReadError("invalid_scan_window")
    params = {
        # Boundary overlap is filtered again against exact internalDate below.
        "q": f"after:{max(0, after_ms // 1000 - 1)} before:{(before_ms + 999) // 1000 + 1}",
        "maxResults": "25",
    }
    if page_token:
        params["pageToken"] = page_token
    await require_current()
    payload = await _bounded_get(client, url=f"{_GMAIL_BASE}/messages", token=token, params=params)
    await require_current()
    raw = payload.get("messages", [])
    if not isinstance(raw, list) or len(raw) > 25:
        raise CompleteMailReadError("invalid_provider_response")
    messages: list[tuple[str, str]] = []
    for item in raw:
        if not isinstance(item, dict) or not all(
            isinstance(item.get(key), str) and _PROVIDER_ID.fullmatch(item[key])
            for key in ("id", "threadId")
        ):
            raise CompleteMailReadError("invalid_provider_response")
        messages.append((item["id"], item["threadId"]))
    next_token = payload.get("nextPageToken")
    if next_token is not None and (not isinstance(next_token, str) or len(next_token) > 2048):
        raise CompleteMailReadError("invalid_provider_response")
    return MailPage(messages=tuple(messages), next_page_token=next_token)


async def thread_message_ids(
    *,
    client: httpx.AsyncClient,
    token: str,
    thread_id: str,
    require_current: Callable[[], Awaitable[None]],
) -> tuple[tuple[str, int], ...]:
    """Enumerate whole-thread IDs; oversized threads remain incomplete."""
    if not _PROVIDER_ID.fullmatch(thread_id):
        raise CompleteMailReadError("invalid_thread_id")
    await require_current()
    payload = await _bounded_get(
        client,
        url=f"{_GMAIL_BASE}/threads/{thread_id}",
        token=token,
        params={"format": "metadata", "fields": "id,messages(id,threadId,internalDate,labelIds)"},
    )
    await require_current()
    raw = payload.get("messages")
    if payload.get("id") != thread_id or not isinstance(raw, list) or not raw or len(raw) > 1000:
        raise CompleteMailReadError("incomplete_thread")
    messages: list[tuple[str, int]] = []
    for item in raw:
        if (
            not isinstance(item, dict)
            or item.get("threadId") != thread_id
            or not isinstance(item.get("id"), str)
            or not _PROVIDER_ID.fullmatch(item["id"])
            or not isinstance(item.get("internalDate"), str)
            or not item["internalDate"].isdigit()
        ):
            raise CompleteMailReadError("incomplete_thread")
        labels = item.get("labelIds", [])
        if not isinstance(labels, list) or any(not isinstance(label, str) for label in labels):
            raise CompleteMailReadError("incomplete_thread")
        if set(labels) & {"SPAM", "TRASH", "DRAFT"}:
            continue
        messages.append((item["id"], int(item["internalDate"])))
    return tuple(sorted(messages, key=lambda item: (item[1], item[0])))


async def profile_history_id(
    *,
    client: httpx.AsyncClient,
    token: str,
    require_current: Callable[[], Awaitable[None]],
) -> str:
    await require_current()
    payload = await _bounded_get(client, url=f"{_GMAIL_BASE}/profile", token=token)
    await require_current()
    value = payload.get("historyId")
    if not isinstance(value, str) or not value.isdigit():
        raise CompleteMailReadError("invalid_provider_response")
    return value


def split_complete_body(
    body: str,
    *,
    max_section_bytes: int = _SECTION_BYTES,
    overlap_chars: int = _SECTION_OVERLAP_CHARS,
) -> tuple[BodySection, ...]:
    """Cover the entire normalized body with bounded, overlapping sections."""

    if not isinstance(body, str) or not body.strip():
        raise CompleteMailReadError("no_readable_body")
    if not 64 <= max_section_bytes <= 32768 or not 0 <= overlap_chars < max_section_bytes // 2:
        raise ValueError("invalid section bounds")
    if len(body.encode("utf-8")) > _MAX_READABLE_BYTES:
        raise CompleteMailReadError("body_too_large")
    sections: list[BodySection] = []
    start = 0
    while start < len(body):
        end = start
        used = 0
        while end < len(body):
            width = len(body[end].encode("utf-8"))
            if used + width > max_section_bytes:
                break
            used += width
            end += 1
        if end <= start:
            raise CompleteMailReadError("body_too_large")
        section = body[start:end]
        sections.append(
            BodySection(
                index=len(sections),
                start=start,
                end=end,
                text=section,
                digest=hashlib.sha256(section.encode("utf-8")).hexdigest(),
            )
        )
        if end == len(body):
            break
        start = max(start + 1, end - overlap_chars)
    if sections[0].start != 0 or sections[-1].end != len(body):
        raise CompleteMailReadError("incomplete_body")
    if any(left.end < right.start for left, right in zip(sections, sections[1:], strict=False)):
        raise CompleteMailReadError("incomplete_body")
    return tuple(sections)


def _decode_size(data: str) -> int:
    try:
        return len(base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)))
    except (binascii.Error, ValueError):
        raise CompleteMailReadError("invalid_body") from None


async def _bounded_get(
    client: httpx.AsyncClient,
    *,
    url: str,
    token: str,
    params: dict[str, str] | list[tuple[str, str]] | None = None,
) -> dict[str, Any]:
    try:
        # Message IDs and mailbox query terms must not enter HTTP client traces.
        with suppress_instrumentation():
            async with asyncio.timeout(20):
                async with client.stream(
                    "GET",
                    url,
                    params=params,
                    headers={"Authorization": f"Bearer {token}", "Accept-Encoding": "identity"},
                    follow_redirects=False,
                ) as response:
                    return await _bounded_response(response)
    except (httpx.HTTPError, asyncio.TimeoutError):
        raise CompleteMailReadError("mail_temporarily_unavailable", retryable=True) from None


_RATE_REASONS = frozenset(
    {"ratelimitexceeded", "userratelimitexceeded", "quotaexceeded", "backenderror"}
)
_MAX_RETRY_AFTER = 3600


def _retry_after(response: httpx.Response) -> int | None:
    value = response.headers.get("retry-after", "")
    if value.isdigit():
        return min(int(value), _MAX_RETRY_AFTER)
    return None


async def _error_reason(response: httpx.Response) -> str:
    """Gmail's machine reason for a 403; content is never retained or logged."""
    content = bytearray()
    async for chunk in response.aiter_bytes():
        content.extend(chunk)
        if len(content) > 65536:
            return ""
    try:
        errors = json.loads(content)["error"]["errors"]
        return str(errors[0].get("reason", "")).casefold()
    except (ValueError, KeyError, IndexError, TypeError, AttributeError):
        return ""


async def _bounded_response(response: httpx.Response) -> dict[str, Any]:
    status = response.status_code
    if status == 401:
        raise CompleteMailReadError("mail_permission_required")
    if status == 403:
        # Gmail reports short-term rate limits as 403. Telling them apart from
        # a missing permission is what keeps a busy minute from asking the
        # owner to reconnect Mail.
        if await _error_reason(response) in _RATE_REASONS:
            raise CompleteMailReadError(
                "mail_rate_limited", retryable=True, retry_after=_retry_after(response)
            )
        raise CompleteMailReadError("mail_permission_required")
    if status == 404:
        raise CompleteMailReadError("source_unavailable")
    if status == 429:
        raise CompleteMailReadError(
            "mail_rate_limited", retryable=True, retry_after=_retry_after(response)
        )
    if status >= 400:
        raise CompleteMailReadError(
            "mail_temporarily_unavailable",
            retryable=status in {500, 502, 503, 504},
            retry_after=_retry_after(response),
        )
    if status != 200:
        raise CompleteMailReadError("invalid_provider_response")
    content = bytearray()
    async for chunk in response.aiter_bytes():
        content.extend(chunk)
        if len(content) > _MAX_RESPONSE_BYTES:
            raise CompleteMailReadError("provider_response_too_large")
    try:
        value = json.loads(content)
    except (json.JSONDecodeError, UnicodeError):
        raise CompleteMailReadError("invalid_provider_response") from None
    if not isinstance(value, dict):
        raise CompleteMailReadError("invalid_provider_response")
    return value


async def _hydrate_readable_parts(
    payload: dict[str, Any],
    *,
    client: httpx.AsyncClient,
    token: str,
    message_id: str,
    require_current: Callable[[], Awaitable[None]],
) -> dict[str, Any]:
    """Fetch external body parts, leaving real file attachments untouched."""

    root: dict[str, Any] = dict(payload)
    stack: list[tuple[dict[str, Any], int]] = [(root, 0)]
    visited = 0
    readable_bytes = 0
    external_parts = 0
    while stack:
        part, depth = stack.pop()
        visited += 1
        if visited > _MAX_PARTS or depth > _MAX_DEPTH:
            raise CompleteMailReadError("invalid_body_tree")
        children = part.get("parts")
        if children is not None:
            if not isinstance(children, list):
                raise CompleteMailReadError("invalid_body_tree")
            copied: list[dict[str, Any]] = []
            for child in children:
                if not isinstance(child, dict):
                    raise CompleteMailReadError("invalid_body_tree")
                copied.append(dict(child))
            part["parts"] = copied
            stack.extend((child, depth + 1) for child in reversed(copied))
            continue
        mime_type = str(part.get("mimeType") or "").lower()
        if part.get("filename"):
            continue
        if (
            mime_type.startswith("message/")
            and isinstance(part.get("body"), dict)
            and part["body"].get("size")
        ):
            raise CompleteMailReadError("unsupported_readable_part")
        if mime_type not in {"text/plain", "text/html"}:
            continue
        raw_body = part.get("body")
        if not isinstance(raw_body, dict):
            raise CompleteMailReadError("incomplete_body")
        body = dict(raw_body)
        part["body"] = body
        data = body.get("data")
        if isinstance(data, str) and data:
            size = _decode_size(data)
            if type(body.get("size")) is int and body["size"] != size:
                raise CompleteMailReadError("incomplete_body")
            readable_bytes += size
        else:
            attachment_id = body.get("attachmentId")
            if not isinstance(attachment_id, str) or not _PROVIDER_ID.fullmatch(attachment_id):
                if body.get("size"):
                    raise CompleteMailReadError("incomplete_body")
                continue
            external_parts += 1
            if external_parts > 8:
                raise CompleteMailReadError("external_parts_limit")
            await require_current()
            attachment = await _bounded_get(
                client,
                url=f"{_GMAIL_BASE}/messages/{message_id}/attachments/{attachment_id}",
                token=token,
            )
            await require_current()
            data = attachment.get("data")
            if not isinstance(data, str) or not data:
                raise CompleteMailReadError("incomplete_body")
            body["data"] = data
            size = _decode_size(data)
            if type(attachment.get("size")) is int and attachment["size"] != size:
                raise CompleteMailReadError("incomplete_body")
            readable_bytes += size
        if readable_bytes > _MAX_READABLE_BYTES:
            raise CompleteMailReadError("body_too_large")
    return root


_KEPT_HEADERS = frozenset(
    {"subject", "from", "auto-submitted", "precedence", "list-id", "list-unsubscribe"}
)
_NO_REPLY = re.compile(r"(?:^|[<\s])(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?)@", re.I)


def automated_signals(headers: dict[str, str]) -> tuple[str, ...]:
    """Standard machine-mail hints; they inform the model, never decide for it."""
    signals: set[str] = set()
    if headers.get("auto-submitted", "no").strip().casefold() not in {"", "no"}:
        signals.add("auto_submitted")
    if headers.get("precedence", "").strip().casefold() in {"bulk", "list", "junk"}:
        signals.add("bulk_precedence")
    if headers.get("list-id") or headers.get("list-unsubscribe"):
        signals.add("mailing_list")
    if _NO_REPLY.search(headers.get("from", "")):
        signals.add("no_reply_sender")
    return tuple(sorted(signals))


async def read_complete_message(
    *,
    client: httpx.AsyncClient,
    token: str,
    message_id: str,
    require_current: Callable[[], Awaitable[None]],
) -> CompleteMailMessage:
    """Read one exact message with a grant check around every provider request."""

    if not isinstance(message_id, str) or not _PROVIDER_ID.fullmatch(message_id):
        raise CompleteMailReadError("invalid_message_id")
    await require_current()
    message = await _bounded_get(
        client,
        url=f"{_GMAIL_BASE}/messages/{message_id}",
        token=token,
        params={"format": "full"},
    )
    await require_current()
    thread_id = message.get("threadId")
    payload = message.get("payload")
    date_raw = message.get("internalDate")
    if (
        message.get("id") != message_id
        or not isinstance(thread_id, str)
        or not _PROVIDER_ID.fullmatch(thread_id)
        or not isinstance(payload, dict)
        or not isinstance(date_raw, str)
        or not date_raw.isdigit()
    ):
        raise CompleteMailReadError("invalid_provider_response")
    hydrated = await _hydrate_readable_parts(
        payload,
        client=client,
        token=token,
        message_id=message_id,
        require_current=require_current,
    )
    await require_current()
    try:
        body = message_text(hydrated)
    except MessageTextError:
        raise CompleteMailReadError("invalid_body") from None
    sections = split_complete_body(body)
    headers = payload.get("headers")
    if not isinstance(headers, list) or len(headers) > 100:
        raise CompleteMailReadError("invalid_provider_response")
    safe_headers: dict[str, str] = {}
    for header in headers:
        if not isinstance(header, dict):
            raise CompleteMailReadError("invalid_provider_response")
        key, value = header.get("name"), header.get("value")
        if not isinstance(key, str) or not isinstance(value, str):
            raise CompleteMailReadError("invalid_provider_response")
        if key.lower() in _KEPT_HEADERS and key.lower() not in safe_headers:
            safe_headers[key.lower()] = value[:512]
    return CompleteMailMessage(
        message_id=message_id,
        thread_id=thread_id,
        internal_date_ms=int(date_raw),
        subject=safe_headers.get("subject", ""),
        sender=safe_headers.get("from", ""),
        body=body,
        body_digest=hashlib.sha256(body.encode("utf-8")).hexdigest(),
        sections=sections,
        signals=automated_signals(safe_headers),
    )
