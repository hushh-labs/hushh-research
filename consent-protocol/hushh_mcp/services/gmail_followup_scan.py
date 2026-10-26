"""Bounded, resumable mailbox follow-up reads; provider cursors remain sealed."""

import asyncio
import hashlib
import time
from datetime import datetime, timezone

from hushh_mcp.services.gmail_nudges import derive_needs_reply_nudges
from hushh_mcp.services.gmail_receipt_continuity import open_state, seal_state
from hushh_mcp.services.gmail_receipts_service import _GMAIL_PROFILE_URL, GmailApiError

PAGE_SIZE = 25
THREADS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/threads"


def invalid_cursor() -> GmailApiError:
    return GmailApiError(
        "Restart the email follow-up scan.", status_code=409, code="GMAIL_FOLLOWUP_SCAN_RESTART"
    )


def load_scan_state(secret, aad, cursor):
    now = int(time.time())
    if cursor:
        try:
            state = open_state(secret, aad, cursor)
            if (
                state.get("kind") != "followups"
                or not now < state["expires"] <= now + 7200
                or not isinstance(state.get("cutoff"), int)
                or not isinstance(state.get("scanned"), int)
                or state["scanned"] < 0
            ):
                raise ValueError
            if not isinstance(state.get("seen"), list) or len(state["seen"]) > 64:
                raise ValueError
            if any(not isinstance(item, str) or len(item) != 16 for item in state["seen"]):
                raise ValueError
            if state.get("page_token") is not None and (
                not isinstance(state["page_token"], str) or len(state["page_token"]) > 4096
            ):
                raise ValueError
        except Exception:
            raise invalid_cursor() from None
    else:
        state = {
            "kind": "followups",
            "cutoff": now,
            "expires": now + 7200,
            "scanned": 0,
            "seen": [],
            "page_token": None,
        }
    return state


async def list_followup_threads(helpers, access_token, state):
    profile = await helpers._http_get_json(_GMAIL_PROFILE_URL, token=access_token)
    owner_email = profile.get("emailAddress")
    if not isinstance(owner_email, str) or "@" not in owner_email or not owner_email.strip():
        raise GmailApiError(
            "Email account could not be verified.",
            status_code=502,
            code="GMAIL_PROFILE_INVALID",
        )
    token = state["page_token"]
    params = {
        "q": f"in:anywhere -in:spam -in:trash before:{state['cutoff']}",
        "maxResults": PAGE_SIZE,
    }
    if token:
        params["pageToken"] = token
    listing = await helpers._http_get_json(THREADS_URL, token=access_token, params=params)
    entries = listing.get("threads", [])
    if (
        not isinstance(entries, list)
        or len(entries) > PAGE_SIZE
        or any(
            not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"]
            for item in entries
        )
    ):
        raise invalid_cursor()
    ids = list(dict.fromkeys(item["id"] for item in entries))
    next_token = listing.get("nextPageToken") or None
    digest = None
    if next_token is not None:
        if not isinstance(next_token, str) or len(next_token) > 4096:
            raise invalid_cursor()
        digest = hashlib.sha256(next_token.encode()).hexdigest()[:16]
        if not ids or digest in state["seen"]:
            raise invalid_cursor()
    return profile, ids, next_token, digest


async def read_followup_threads(helpers, access_token, ids):
    semaphore = asyncio.Semaphore(5)

    async def fetch(thread_id):
        try:
            async with semaphore:
                payload = await asyncio.wait_for(
                    helpers._get_thread_metadata(access_token=access_token, thread_id=thread_id),
                    4,
                )
            return helpers._nudge_thread_from_payload(payload)
        except Exception:
            return None

    threads = await asyncio.gather(*(fetch(thread_id) for thread_id in ids))
    return threads


async def scan_followup_page(
    helpers,
    *,
    access_token: str,
    user_id: str,
    binding: list[str],
    cursor: str | None,
    require_current,
) -> dict:
    secret = helpers._state_secret().encode("utf-8")
    aad = ["gmail-followup-v1", *binding, str(PAGE_SIZE)]
    state = load_scan_state(secret, aad, cursor)
    await require_current()
    async with asyncio.timeout(24):
        profile, ids, next_token, digest = await list_followup_threads(helpers, access_token, state)
        threads = await read_followup_threads(helpers, access_token, ids)
    await require_current()
    failed = [thread_id for thread_id, thread in zip(ids, threads, strict=True) if thread is None]
    scanned = state["scanned"] + len(ids) - len(failed)
    # A partial page is retried in full. Never advance past an unread thread,
    # and never embed an unbounded list of provider ids in the continuation.
    if not failed:
        state["scanned"], state["page_token"] = scanned, next_token
        if digest is not None:
            state["seen"] = [*state["seen"][-63:], digest]
    more = bool(failed or next_token)
    continuation = seal_state(secret, aad, state) if more else None
    if continuation and len(continuation) > 8100:
        raise invalid_cursor()
    nudges = derive_needs_reply_nudges(
        [thread for thread in threads if thread is not None],
        user_email=profile.get("emailAddress", ""),
        limit=PAGE_SIZE,
        max_age_days=None,
    )
    return {
        "user_id": user_id,
        "account_email": profile.get("emailAddress") or None,
        "nudges": [item.to_dict() for item in nudges],
        "next_cursor": continuation,
        "has_more": more,
        "coverage": {
            "scope": "mailbox_excluding_spam_trash",
            "scanned_threads": scanned,
            "failed_threads": len(failed),
            "complete": not more,
            "as_of": datetime.fromtimestamp(state["cutoff"], timezone.utc).isoformat(),
        },
    }
