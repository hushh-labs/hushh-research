"""Best-effort metadata FCM push to a user's registered devices.

Agent-agnostic notifier so any service can nudge a user's client to refresh
(e.g. a freshly-created connection request). Mirrors the location specialist's
metadata push but carries no domain coupling. It NEVER raises: push is
strictly best-effort, and it no-ops (touching no DB) when Firebase is not
configured, so unit tests and credential-less environments stay clean.
"""

from __future__ import annotations

import logging
from urllib.parse import quote

from hushh_mcp.branding import connection_accepted_body, connection_request_body

logger = logging.getLogger(__name__)


def send_user_data_push(
    user_id: str,
    *,
    notification_type: str,
    title: str,
    body: str,
    deep_link: str,
    notification_tag: str,
    notification_category: str,
    data: dict[str, str] | None = None,
    show_alert: bool = True,
) -> int:
    """Send a metadata push to every device registered for ``user_id``.

    Returns the number of devices a send was attempted for. Best-effort:
    returns 0 (and swallows everything) when the user is empty, Firebase is
    unconfigured, the user has no tokens, or any send fails. Firebase config is
    checked FIRST so that unconfigured environments never touch the database.
    """
    user_id = (user_id or "").strip()
    if not user_id:
        return 0
    try:
        from api.utils.firebase_admin import ensure_firebase_admin

        configured, _ = ensure_firebase_admin()
        if not configured:
            return 0

        from db.db_client import get_db

        rows = (
            get_db()
            .execute_raw(
                "SELECT token, platform FROM user_push_tokens WHERE user_id = :user_id",
                {"user_id": user_id},
            )
            .data
            or []
        )
        if not rows:
            return 0

        from firebase_admin import messaging

        from api.utils.fcm_messages import build_push_message

        message_data = {
            "type": notification_type,
            "user_id": user_id,
            "request_url": deep_link,
            "deep_link": deep_link,
            "notification_tag": notification_tag,
            "notification_category": notification_category,
            **{k: str(v) for k, v in (data or {}).items() if str(v or "").strip()},
        }

        sent = 0
        seen: set[str] = set()
        for row in rows:
            token = str(row.get("token") or "").strip()
            if not token or token in seen:
                continue
            seen.add(token)
            platform = str(row.get("platform") or "").strip().lower()
            message = build_push_message(
                messaging,
                token=token,
                platform=platform,
                data=message_data,
                title=title,
                body=body,
                request_url=deep_link,
                notification_tag=notification_tag,
                show_alert=show_alert,
            )
            try:
                messaging.send(message)
                sent += 1
            except (messaging.UnregisteredError, messaging.SenderIdMismatchError):
                try:
                    get_db().execute_raw(
                        "DELETE FROM user_push_tokens WHERE token = :token",
                        {"token": token},
                    )
                except Exception as cleanup_exc:  # noqa: BLE001
                    logger.warning(
                        "push.token_cleanup_failed type=%s error=%s",
                        notification_type,
                        cleanup_exc,
                    )
            except Exception as send_exc:  # noqa: BLE001
                logger.warning("push.send_failed type=%s error=%s", notification_type, send_exc)
        return sent
    except Exception as exc:  # noqa: BLE001
        logger.warning("push.notify_skipped type=%s error=%s", notification_type, exc)
        return 0


_GENERIC_CONNECTION_REQUEST_BODY = connection_request_body()

# Where a connection-request tap must land. The Consent Center opens the review
# sheet purely from the URL -- `selectedId = searchParams.get("requestId")` in
# consent-center-page.tsx -- so a link without the id can only ever render the
# list, which is what made "tapping the notification" a dead end. `tab=pending`
# is the shape `buildConsentCenterHref` emits and the one the Feed's Review
# action already uses, so all three entry points agree.
CONNECTION_REQUEST_LIST_LINK = "/one/consent?tab=connections"


def _connection_request_link(connection_request_id: str | None) -> str:
    request_id = str(connection_request_id or "").strip()
    if not request_id:
        return CONNECTION_REQUEST_LIST_LINK
    return f"/one/consent?tab=pending&requestId={quote(request_id, safe='')}"


def _connection_request_body(requester_name: str | None) -> str:
    """Connection-request banner copy. Names the requester when we have one,
    else falls back to the generic line — never emits ``None``/``undefined``.

    Thin wrapper kept for the existing call sites and tests; the sentence itself
    lives in ``hushh_mcp.branding`` so the web toast, the OS banner and the SSE
    body cannot drift apart again (that drift is how the brand misspelling
    survived on this surface — see issue #5422).
    """
    return connection_request_body(requester_name)


def _lookup_display_name(user_id: str) -> str:
    """Best-effort, lock-screen-safe requester label. "" when unresolved.

    Delegates to ``requester_identity.resolve_requester_label``, which rejects
    technical identities (a raw Firebase uid is a legitimate value of
    ``actor_identity_cache.display_name``) and falls back to an email handle.

    Deliberately NOT gated on ``ensure_firebase_admin()``. It used to be, copied
    from ``send_user_data_push`` where the gate genuinely avoids a pointless
    token read. Here the same value also feeds the in-app/SSE copy, so the gate
    blanked a perfectly resolvable name in every environment without Firebase
    credentials — the database had it the whole time.
    """
    from hushh_mcp.services.requester_identity import resolve_requester_label

    return resolve_requester_label(user_id)


def send_connection_request_push(
    addressee_user_id: str,
    requester_user_id: str,
    *,
    requester_display_name: str | None = None,
    connection_request_id: str | None = None,
) -> int:
    """Nudge the addressee's client that a new connection request arrived.

    The payload's ``type`` drives the client (see notification-provider.tsx):
    on receipt it invalidates the consent-center cache so the incoming request
    surfaces without a manual refresh. The banner names the requester when the
    identity cache can, and degrades to the generic line otherwise
    (best-effort; the lookup never blocks or raises).

    ``requester_display_name`` lets the caller pass a name it already holds
    (``ConnectionsService`` has one at every notify site) so we skip the query.
    ``connection_request_id`` is the real ``connection_requests.id``; it is what
    makes the tap open the review sheet instead of a list, so pass it whenever
    it is known.
    """
    from hushh_mcp.services.requester_identity import resolve_requester_label

    requester_name = resolve_requester_label(
        requester_user_id,
        display_name=requester_display_name,
    )
    body = connection_request_body(requester_name)
    deep_link = _connection_request_link(connection_request_id)
    request_id = str(connection_request_id or "").strip()

    # Identity and routing fields the CLIENT needs, as opposed to the banner the
    # OS renders. The in-app toast reads only this data map -- it never sees
    # `body` -- which is exactly why it said "Someone" while the system banner
    # said the right thing. Empty values are dropped by send_user_data_push, so
    # an unresolved name simply omits the key and the client owns the fallback.
    client_data = {
        "requester_user_id": requester_user_id,
        "requester_label": requester_name,
        "request_id": request_id,
    }

    try:
        import asyncio

        from api.consent_listener import _push_to_consent_queue

        sse_payload = {
            "type": "connection_request",
            "action": "REQUESTED",
            # The real row id, not the old synthetic `conn_req:<uid>`. That value
            # was stable per *requester* rather than per request, so the SSE
            # de-dup in api/routes/sse.py silently swallowed every follow-up
            # request from the same person on one connection — and any client
            # promoting it into `?requestId` would resolve nothing.
            "request_id": request_id or f"conn_req:{requester_user_id}",
            "user_id": addressee_user_id,
            "requester_user_id": requester_user_id,
            # "" rather than "Someone": baking the placeholder into transport
            # meant the client's own (richer) fallback ladder could never fire,
            # because it received a label that merely looked real.
            "requester_label": requester_name,
            "title": "New connection request",
            "body": body,
            "deep_link": deep_link,
            "request_url": deep_link,
        }
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(_push_to_consent_queue(addressee_user_id, sse_payload))
        except RuntimeError:
            # No running loop: we are on a FastAPI threadpool worker, which is
            # where BOTH production callers actually run (`def
            # create_connection_request`, `def request_nearby_connection` are
            # sync). This used to `pass`, which silently discarded the event and
            # left the SSE lane dead for connection requests -- so a web client
            # without a push subscription could never learn about one.
            from api.consent_listener import push_to_consent_queue_threadsafe

            push_to_consent_queue_threadsafe(addressee_user_id, sse_payload)
    except Exception as exc:  # noqa: BLE001
        logger.warning("push.sse_queue_failed error=%s", exc)

    return send_user_data_push(
        addressee_user_id,
        notification_type="connection_request",
        title="New connection request",
        body=body,
        deep_link=deep_link,
        notification_tag=f"connection-request:{addressee_user_id}",
        notification_category="ONE_CONNECTIONS",
        data=client_data,
    )


def _connection_accepted_body(approver_name: str | None) -> str:
    """Connection-accepted banner copy. Names the approver when we have one,
    else falls back to the generic line -- never emits ``None``/``undefined``.

    Thin wrapper kept for the existing call sites and tests; the sentence
    itself lives in ``hushh_mcp.branding``, same reasoning as
    ``_connection_request_body`` above.
    """
    return connection_accepted_body(approver_name)


def send_connection_accepted_push(requester_user_id: str, approver_user_id: str) -> int:
    """Tell the original requester that their connection request was accepted.

    Addressed to the requester only -- the approver just took the action
    themselves and does not need a push confirming their own tap. The banner
    names the approver when the identity cache has a display name, and
    degrades to a generic line otherwise (best-effort; the lookup never
    blocks or raises)."""
    approver_name = _lookup_display_name(approver_user_id)
    body = _connection_accepted_body(approver_name)
    return send_user_data_push(
        requester_user_id,
        notification_type="connection_accepted",
        title="Connection accepted",
        body=body,
        deep_link="/one/consent?tab=connections",
        notification_tag=f"connection-accepted:{requester_user_id}",
        notification_category="ONE_CONNECTIONS",
        # The in-app toast reads only this data map, never `body` -- the same
        # reason send_connection_request_push's data carries requester_label
        # (see #5422). Without approver_label here, the toast would say
        # "Someone" even when the OS banner named the right person.
        data={"approver_user_id": approver_user_id, "approver_label": approver_name},
    )


def send_circle_code_joined_push(
    *,
    inviter_user_id: str,
    joiner_display_name: str,
    circle_id: str,
    circle_name: str,
) -> int:
    """Tell whoever shared a code that it actually worked.

    Sharing a Circle code was previously a one-way act: the sender pasted it
    into a message and never learned whether anyone used it. That silence is
    where the invite loop leaked -- there was no signal to act on and no reason
    to open the app again.

    Addressed to the code's creator, not the whole Circle: they did the
    inviting, and they are the one person for whom this is news.
    """

    deep_link = f"/one/location?tab=people&circleId={circle_id}"
    return send_user_data_push(
        inviter_user_id,
        notification_type="location_circle_code_joined",
        title=circle_name or "Your Circle",
        body=f"{joiner_display_name} joined using your code.",
        deep_link=deep_link,
        notification_tag=f"location-circle-code-joined:{circle_id}",
        notification_category="ONE_LOCATION",
        data={
            "circle_id": circle_id,
            "circle_name": circle_name,
        },
    )


def send_circle_member_added_push(
    *,
    member_user_id: str,
    added_by_user_id: str,
    added_by_display_name: str,
    circle_id: str,
    circle_name: str,
) -> int:
    """Tell someone they are in a Circle, and who put them there.

    Being added is not being invited: there was no card to tap and no decision
    to make, so this is the only moment they learn about it. That makes naming
    the person non-negotiable -- "You were added to a Circle" reads as an
    intrusion by nobody in particular, and the one thing that turns it back
    into an ordinary social act is knowing whose Circle it is.

    ``added_by_display_name`` comes from the caller's ``_lookup_display_name``
    so the same resolved name reaches the banner, the toast and the feed.
    """

    adder = str(added_by_display_name or "").strip()
    circle = str(circle_name or "").strip()
    if adder and circle:
        body = f'{adder} added you to "{circle}".'
    elif adder:
        body = f"{adder} added you to their Circle."
    elif circle:
        body = f'You were added to "{circle}".'
    else:
        body = "You were added to a Circle."
    deep_link = f"/one/location?tab=people&circleId={circle_id}"
    return send_user_data_push(
        member_user_id,
        notification_type="location_circle_member_added",
        title="Added to a Circle",
        body=body,
        deep_link=deep_link,
        notification_tag=f"location-circle-member-added:{circle_id}",
        notification_category="ONE_LOCATION",
        # The in-app toast reads only this map, never `body` -- the same reason
        # send_connection_accepted_push carries approver_label (see #5422).
        # Without added_by_label here the toast says "Someone" while the OS
        # banner two inches above it has the name right.
        data={
            "circle_id": circle_id,
            "circle_name": circle,
            "added_by_user_id": added_by_user_id,
            "added_by_label": adder,
        },
    )


def send_circle_member_invite_push(
    *,
    invitee_user_id: str,
    inviter_user_id: str,
    circle_id: str,
    invite_id: str,
) -> int:
    """Nudge one exact invitee about a pending named Circle invitation."""

    deep_link = f"/one/location?tab=people&circleInviteId={invite_id}"
    return send_user_data_push(
        invitee_user_id,
        notification_type="location_circle_member_invite",
        title="Circle invitation",
        body="You have a new Circle invitation.",
        deep_link=deep_link,
        notification_tag=f"location-circle-member-invite:{invite_id}",
        notification_category="ONE_LOCATION",
        data={
            "invite_id": invite_id,
            "circle_id": circle_id,
            "inviter_user_id": inviter_user_id,
        },
    )
