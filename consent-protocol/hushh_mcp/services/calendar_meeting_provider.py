"""Bounded Meet reads used by the Calendar meeting library."""

from __future__ import annotations

import asyncio
import json

import httpx
from opentelemetry.instrumentation.utils import suppress_instrumentation

from hushh_mcp.services.calendar_meeting_common import ArtifactUnavailable
from hushh_mcp.services.google_drive_adapter import classify_google_forbidden_response


async def meet_request(token, path, params=None):
    async with httpx.AsyncClient(timeout=8, follow_redirects=False) as client:
        with suppress_instrumentation():
            async with client.stream(
                "GET",
                "https://meet.googleapis.com/v2/" + path,
                headers={"Authorization": f"Bearer {token}", "Accept-Encoding": "identity"},
                params=params,
            ) as response:
                if response.status_code == 401:
                    raise ArtifactUnavailable("token_rejected")
                if response.status_code == 403:
                    reason = await classify_google_forbidden_response(response)
                    raise ArtifactUnavailable(
                        "temporarily_unavailable" if reason == "rate_limited" else reason,
                        retryable=reason == "rate_limited",
                    )
                if response.status_code == 404:
                    raise ArtifactUnavailable("unavailable")
                if response.status_code == 429 or response.status_code >= 500:
                    raise ArtifactUnavailable("temporarily_unavailable", retryable=True)
                if response.status_code != 200:
                    raise ArtifactUnavailable("temporarily_unavailable")
                raw = bytearray()
                async for chunk in response.aiter_bytes():
                    raw.extend(chunk)
                    if len(raw) > 262144:
                        raise ArtifactUnavailable("temporarily_unavailable")
                result = json.loads(raw)
                if not isinstance(result, dict):
                    raise ArtifactUnavailable("temporarily_unavailable")
                return result


async def collect_meet_pages(meet_call, token, path, field, params=None, *, page_size=100):
    items, seen, page = [], set(), None
    for _ in range(10):
        request_params = {
            **(params or {}),
            "pageSize": page_size,
            **({"pageToken": page} if page else {}),
        }
        try:
            response = await meet_call(token, path, request_params)
        except ArtifactUnavailable as error:
            if not error.retryable:
                raise
            await asyncio.sleep(0.2)
            response = await meet_call(token, path, request_params)
        rows = response.get(field)
        # Meet's protobuf JSON omits empty repeated fields, including on
        # a sparse page that still carries a continuation token.
        if rows is None and set(response).issubset({"nextPageToken"}):
            rows = []
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise ArtifactUnavailable("temporarily_unavailable")
        items.extend(rows)
        page = response.get("nextPageToken")
        if not page:
            return items
        if not isinstance(page, str) or len(page) > 2048 or page in seen:
            raise ArtifactUnavailable("temporarily_unavailable")
        seen.add(page)
    raise ArtifactUnavailable("temporarily_unavailable")
