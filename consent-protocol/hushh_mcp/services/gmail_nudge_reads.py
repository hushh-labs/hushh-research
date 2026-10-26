"""Owner-authorized nudge dispatch and metadata decoding; no stored task state."""

from datetime import datetime, timezone

from hushh_mcp.services.gmail_nudges import NudgeMessage, NudgeThread
from hushh_mcp.services.gmail_receipts_service import GmailApiError


def decode_thread_metadata(helpers, payload, clean_text):
    thread_id = clean_text(payload.get("id"))
    raw_messages = payload.get("messages")
    if not thread_id or not isinstance(raw_messages, list):
        return None
    messages: list[NudgeMessage] = []
    for raw in raw_messages:
        if not isinstance(raw, dict):
            continue
        headers = helpers._extract_headers(raw)
        from_name, from_email = helpers._parse_from_header(headers.get("from", ""))
        messages.append(
            NudgeMessage(
                message_id=clean_text(raw.get("id")),
                from_email=from_email or "",
                from_name=from_name or "",
                subject=clean_text(headers.get("subject")),
                received_at=helpers._message_received_at(raw, headers),
                sent_by_owner="SENT" in (raw.get("labelIds") or []),
            )
        )
    if not messages:
        return None
    messages.sort(key=lambda m: m.received_at or datetime.min.replace(tzinfo=timezone.utc))
    return NudgeThread(thread_id=thread_id, messages=tuple(messages))


async def list_owner_nudges(
    helpers,
    *,
    user_id: str,
    limit: int,
    scan_all: bool = False,
    cursor: str | None = None,
    require_access=None,
) -> dict:
    from hushh_mcp.services.gmail_token_reads import list_nudges_with_token

    if scan_all:
        from hushh_mcp.services.gmail_followup_scan import scan_followup_page

        initial_grant = await helpers.read_grant_binding(user_id=user_id, include_generation=True)
        if initial_grant is None:
            raise GmailApiError("Reconnect Mail before scanning.", status_code=403)
        access_token = await helpers.get_read_access_token(user_id=user_id)
        grant = await helpers.read_grant_binding(user_id=user_id, include_generation=True)
        if grant is None:
            raise GmailApiError("Reconnect Mail before scanning.", status_code=403)
        if initial_grant[:-1] != grant[:-1]:
            raise GmailApiError("Mail access changed. Restart the scan.", status_code=409)

        async def require_current() -> None:
            if require_access is not None:
                await require_access()
            if await helpers.read_grant_binding(user_id=user_id, include_generation=True) != grant:
                raise GmailApiError("Mail access changed. Restart the scan.", status_code=409)

        return await scan_followup_page(
            helpers,
            access_token=access_token,
            user_id=user_id,
            binding=list(grant[:-1]),
            cursor=cursor,
            require_current=require_current,
        )
    if cursor:
        raise GmailApiError("A continuation requires a mailbox scan.", status_code=400)
    access_token, _row = await helpers._ensure_access_token(user_id=user_id)
    return await list_nudges_with_token(
        helpers, access_token=access_token, user_id=user_id, limit=limit
    )
