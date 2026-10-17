"""Gmail inbox reads that take an access token instead of finding one.

``GmailReceiptsService.list_nudges`` and ``search_inbox`` used to look up the hub's
stored Gmail login and then read. The read itself never needed the hub: it is a
handful of stateless Gmail REST calls over one bearer token. These functions are that
read, unchanged, so the same code serves both callers:

* the hub, which still finds the token in its own connection row first;
* an owner-cloud agent (``pod_gmail_local``), which mints the token from the login
  sealed to it and never asks the hub for anything.

``helpers`` is any ``GmailReceiptsService`` (its HTTP and header helpers touch no
database). Its module constants are read through the service module so a test that
patches one there still patches it here.
"""

from __future__ import annotations

import asyncio
from typing import Any

from hushh_mcp.services import gmail_receipts_service as _svc
from hushh_mcp.services.gmail_nudges import derive_nudges, derive_upcoming_meeting_nudges


def _thread_ids(listing: dict[str, Any]) -> list[str]:
    entries = listing.get("messages")
    thread_ids: list[str] = []
    seen: set[str] = set()
    for entry in entries if isinstance(entries, list) else []:
        if not isinstance(entry, dict):
            continue
        thread_id = _svc._clean_text(entry.get("threadId"))
        if thread_id and thread_id not in seen:
            seen.add(thread_id)
            thread_ids.append(thread_id)
        if len(thread_ids) >= _svc._NUDGE_MAX_THREADS:
            break
    return thread_ids


async def list_nudges_with_token(
    helpers: Any, *, access_token: str, user_id: str, limit: int
) -> dict[str, Any]:
    """Inbox flashcard nudges ("Needs a reply" and upcoming meetings) for one token."""
    profile = await helpers._http_get_json(_svc._GMAIL_PROFILE_URL, token=access_token)
    user_email = _svc._clean_text(profile.get("emailAddress"))
    listing = await helpers._list_messages(
        access_token=access_token,
        query_text=_svc._NUDGE_INBOX_QUERY,
        page_token=None,
        max_results=100,
    )
    thread_ids = _thread_ids(listing)
    payloads = await asyncio.gather(
        *[
            helpers._get_thread_metadata(access_token=access_token, thread_id=thread_id)
            for thread_id in thread_ids
        ],
        return_exceptions=True,
    )
    threads = []
    for thread_id, payload in zip(thread_ids, payloads, strict=False):
        if isinstance(payload, BaseException):
            _svc.logger.warning(
                "gmail.nudges.thread_failed thread_id=%s reason=%s",
                thread_id,
                str(payload)[:200],
            )
            continue
        thread = helpers._nudge_thread_from_payload(payload)
        if thread is not None:
            threads.append(thread)

    bounded_limit = max(1, min(int(limit or _svc._NUDGE_DEFAULT_LIMIT), 50))
    needs_reply = derive_nudges(threads, user_email=user_email, limit=bounded_limit)
    # Upcoming meetings from calendar invites AND body-text meeting mentions
    # (best-effort: never fail the whole nudge response over meeting parsing).
    # Invite events are listed first so they win the per-thread de-dupe.
    try:
        invite_events, body_events = await asyncio.wait_for(
            asyncio.gather(
                helpers._fetch_meeting_events(access_token=access_token, limit=bounded_limit),
                helpers._fetch_body_meeting_events(access_token=access_token, limit=bounded_limit),
            ),
            timeout=_svc._NUDGE_MEETING_FETCH_TIMEOUT_SECONDS,
        )
        meetings = derive_upcoming_meeting_nudges(invite_events + body_events, limit=bounded_limit)
    except Exception:
        _svc.logger.warning("gmail.nudges.meetings_failed", exc_info=True)
        meetings = []
    return {
        "user_id": user_id,
        "account_email": user_email or None,
        "nudges": [nudge.to_dict() for nudge in needs_reply]
        + [nudge.to_dict() for nudge in meetings],
    }


async def search_inbox_with_token(
    helpers: Any, *, access_token: str, query: str, limit: int
) -> list[dict[str, Any]]:
    """A Gmail search as lightweight message summaries, read-only, for one token."""
    bounded_limit = max(1, min(int(limit or 10), 25))
    listing = await helpers._list_messages(
        access_token=access_token,
        query_text=_svc._clean_text(query),
        page_token=None,
        max_results=min(bounded_limit * 2, 50),
    )
    entries = listing.get("messages")
    message_ids: list[str] = []
    for entry in entries if isinstance(entries, list) else []:
        if not isinstance(entry, dict):
            continue
        message_id = _svc._clean_text(entry.get("id"))
        if message_id:
            message_ids.append(message_id)
        if len(message_ids) >= bounded_limit:
            break
    metas = await helpers._get_message_metadata_batch(
        access_token=access_token, gmail_message_ids=message_ids
    )
    summaries: list[dict[str, Any]] = []
    for meta in metas:
        headers = helpers._extract_headers(meta)
        from_name, from_email = helpers._parse_from_header(headers.get("from", ""))
        received_at = helpers._message_received_at(meta, headers)
        summaries.append(
            {
                "thread_id": _svc._clean_text(meta.get("threadId")),
                "subject": _svc._clean_text(headers.get("subject")) or "(no subject)",
                "from": from_name or from_email or "Unknown sender",
                "from_email": from_email or "",
                "snippet": _svc._clean_text(meta.get("snippet"))[:200],
                "received_at": received_at.isoformat() if received_at else None,
            }
        )
    return summaries


__all__ = ["list_nudges_with_token", "search_inbox_with_token"]
