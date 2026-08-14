"""Who a Save my Soul alert may be emailed to.

This module answers one question — *which contacts is this caller allowed to
mail right now* — and nothing else. The message itself is rendered and sent by
One, through `hushh-mail-api`, the same service that sends every other product
mail (sign-in, phone conflict, capability linked). Only the webapp lane holds
`MAIL_API_KEY`/`MAIL_API_ENDPOINT`, and more importantly a second sender
identity is a deliverability risk we have already been bitten by: an emergency
mail is the worst place to discover an SPF/DKIM misalignment.

So the split is:

    backend (here)   authorization + recipient resolution
    One (Next.js)    render + send via hushh-mail-api

The rules below are the fence. Without them this would be an open mailer: the
sender supplies grant ids and free text, and the recipients are other people.

1. The grant is the authorization. A caller may only reach the recipients of
   live SOS grants their **own** account created.
2. Freshness. An SOS grant lives 8 hours; without a short window the rest of
   that day stays usable to send more mail.
3. One message per person, and a hard cap on how many people. An emergency
   contact list is a handful of people; anything larger is a bug or abuse.
4. A contact with no address on file is skipped silently. The caller gets a
   count, never "which of your contacts has no email".

Coordinates are deliberately absent from this module. They are never stored and
never logged; they travel from the sender's client to One's mail route only,
because `one_location_envelopes` keeps coordinates inside the ciphertext.
"""

from __future__ import annotations

from typing import Any, Iterable

#: A grant older than this is not the alert being sent right now.
GRANT_FRESHNESS_SECONDS = 15 * 60

#: Bound on how many contacts one alert may mail.
MAX_SOS_EMAIL_RECIPIENTS = 20


def select_emailable_recipients(
    grants: Iterable[dict[str, Any]],
    *,
    owner_user_id: str,
    now_epoch_seconds: float,
) -> list[dict[str, Any]]:
    """Filter grant rows down to the recipients this alert may mail.

    A row survives only when it is the caller's own, is an SOS share, is still
    active, was created moments ago, and names a recipient with an address.
    """
    selected: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in grants:
        if str(row.get("owner_user_id") or "") != owner_user_id:
            continue
        if str(row.get("share_kind") or "") != "sos":
            continue
        if str(row.get("status") or "") != "active":
            continue
        created_at_epoch = row.get("created_at_epoch")
        if not isinstance(created_at_epoch, (int, float)):
            continue
        if now_epoch_seconds - float(created_at_epoch) > GRANT_FRESHNESS_SECONDS:
            continue
        recipient_user_id = str(row.get("recipient_user_id") or "").strip()
        email = str(row.get("recipient_email") or "").strip()
        if not recipient_user_id or "@" not in email:
            continue
        if recipient_user_id in seen:
            continue
        seen.add(recipient_user_id)
        selected.append(row)
        if len(selected) >= MAX_SOS_EMAIL_RECIPIENTS:
            break
    return selected


__all__ = [
    "GRANT_FRESHNESS_SECONDS",
    "MAX_SOS_EMAIL_RECIPIENTS",
    "select_emailable_recipients",
]
