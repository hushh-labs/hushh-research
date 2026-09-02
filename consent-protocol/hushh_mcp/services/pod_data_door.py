"""The pod data door: how a keyless pod READS an owner's DB-backed specialist.

A per-person pod holds no database credential -- that is the whole point of the
zero-role pod identity, and it is grep-guarded elsewhere. So a DB-backed
specialist (location, first) cannot read the owner's state in-pod; it returns
``runtime_unavailable``. This module is the read half of the fix. The pod does
not gain a credential; it asks the HUB to run one specific read on the owner's
own project and hand back a projection.

Three invariants make the door safe, and each is enforced in code here rather
than asserted in prose:

* **Read-only by construction.** ``POD_DATA_DOOR_READS`` maps a name to a read
  method and no reader here mutates the owner's DOMAIN state -- their location
  shares, mailbox contents, calendar events, or financial records. There is no
  write registry, no write reader, no branch that takes a verb. A pod that wants
  to CHANGE state uses the directive transport instead (it PROPOSES; the browser
  EXECUTES on the owner's session), a different, separately-authorized path. This
  flag can therefore never widen a pod's authority to write.

  The one permitted side effect is INFRASTRUCTURE housekeeping, never domain: an
  OAuth-backed reader (email, calendar) may prompt the hub's connection service to
  refresh a near-expiry access token in its own token cache. That is the hub
  keeping its own credential fresh to perform the read the owner authorized; it
  writes no mailbox, calendar, or financial state, is invisible to the owner's
  data, and grants the pod nothing. Location suppresses even its expiry
  housekeeping via ``read_only=True`` because it can; OAuth token refresh has no
  such suppression and is accepted here as the hub's infra, not a domain write.

* **Fail-closed projection.** Each read is projected through an ALLOWLIST of
  fields to KEEP, never a denylist of fields to drop. A column added to the
  underlying service later -- a new wrapped key, a coordinate, a raw phone --
  is dropped by default because it is not on the keep-list. Security by omission
  is the failure mode an allowlist removes.

* **The wrapped private key never crosses.** ``myRecipientKey`` carries the
  owner's ``encryptedPrivateKeyJwk`` -- their wrapped private key. The pod holds
  no key to open it and no reason to carry it; letting it cross would break Zero
  Knowledge. The projection keeps only the public half.

The broker route authenticates the pod and re-validates the per-turn scope; the
projection is what it returns. Keeping the projection here -- pure, DB-free,
importable without the heavy location service -- is what lets it be tested for
what it drops without a database.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

# --- Location egress allowlists -------------------------------------------------
# Only these fields may EVER reach a pod through the door. Everything else in the
# service payload -- present today or added tomorrow -- is dropped by omission.

#: A recipient the owner can share with. Masked email/phone are deliberately NOT
#: kept: a location answer never needs them, and a mask is still PII-adjacent.
#: ``publicKeyJwk`` is kept but its VALUE is re-projected (see ``_project_jwk``):
#: a keep-list guards which KEYS cross, not what rides inside a kept dict.
_LOCATION_RECIPIENT_KEEP = (
    "userId",
    "displayName",
    "phoneVerified",
    "keyId",
    "publicKeyJwk",
    "keyAlgorithm",
    "keyRegisteredAt",
    "canReceiveLocation",
)

#: An active or historical share grant. ``latestEnvelopeId`` is dropped: it names
#: ciphertext the pod cannot open and should not enumerate. Masked-phone joins
#: are dropped for the same reason as recipients.
_LOCATION_GRANT_KEEP = (
    "id",
    "ownerUserId",
    "recipientUserId",
    "ownerDisplayName",
    "recipientDisplayName",
    "recipientKeyId",
    "status",
    "consentScope",
    "capabilityScopes",
    "durationHours",
    "expiresAt",
    "createdAt",
    "updatedAt",
    "revokedAt",
    "sourceCircleId",
    "shareKind",
)

#: The owner's own recipient key. ``encryptedPrivateKeyJwk`` -- the wrapped
#: private key -- is the one field whose crossing would break Zero Knowledge, and
#: it is dropped by never appearing here. ``publicKeyJwk`` is re-projected too.
_LOCATION_MY_KEY_KEEP = (
    "keyId",
    "publicKeyJwk",
    "keyAlgorithm",
    "keyRegisteredAt",
)

#: A named circle the owner shares with. Only the display summary is kept; a
#: future ``members`` list (get_circle already returns member keys and verified
#: flags) is dropped by omission rather than riding through a passthrough.
_LOCATION_CIRCLE_KEEP = (
    "id",
    "name",
    "kind",
    "role",
    "memberCount",
    "memberLimit",
    "createdAt",
    "updatedAt",
)

#: An outstanding public share invite the owner created. No key material.
_LOCATION_PUBLIC_INVITE_KEEP = (
    "id",
    "ownerUserId",
    "status",
    "durationHours",
    "expiresAt",
    "createdAt",
    "updatedAt",
    "revokedAt",
    "ownerLabel",
    "locationAvailable",
)

#: Someone asking the owner for access. ``requesterMaskedPhone`` is dropped like
#: every other masked-phone join; the display name and message are what the
#: specialist needs to answer "who is requesting access to my location".
_LOCATION_REQUEST_KEEP = (
    "id",
    "ownerUserId",
    "requesterUserId",
    "requesterDisplayName",
    "referredByUserId",
    "status",
    "message",
    "requestedAt",
    "resolvedAt",
    "approvedGrantId",
)

#: The ONLY JWK members that may cross to a keyless pod: the public EC (``x``,
#: ``y``) and RSA (``e``, ``n``) parameters plus non-secret metadata. Every
#: private member -- ``d`` (EC/RSA private scalar), ``k`` (symmetric key), and the
#: RSA CRT secrets -- is dropped by never appearing here. A key keep-list is not
#: enough: ``publicKeyJwk`` is a KEPT key, so without this a JWK that ever carried
#: ``d`` (a registration bug, a JWK-confusion) would copy the owner's private
#: scalar straight through -- the exact Zero-Knowledge break the door exists to
#: prevent.
_PUBLIC_JWK_MEMBERS = (
    "kty",
    "crv",
    "x",
    "y",
    "alg",
    "kid",
    "use",
    "key_ops",
    "e",
    "n",
)


def _pick(row: Any, keep: tuple[str, ...]) -> dict[str, Any]:
    """A fresh dict holding only allow-listed keys of ``row`` (fail-closed)."""
    if not isinstance(row, dict):
        return {}
    return {key: row.get(key) for key in keep if key in row}


def _project_jwk(value: Any) -> dict[str, Any] | None:
    """A JWK holding only its public members, or None. Fail-closed at the VALUE
    level: a private member inside a kept ``publicKeyJwk`` is dropped by omission,
    so no key keep-list can accidentally admit a private scalar."""
    if not isinstance(value, dict):
        return None
    return {member: value.get(member) for member in _PUBLIC_JWK_MEMBERS if member in value}


def _project_key_bearing(row: Any, keep: tuple[str, ...]) -> dict[str, Any]:
    """``_pick`` plus a re-projected ``publicKeyJwk`` value, so the nested JWK
    cannot carry a private member through a kept key."""
    out = _pick(row, keep)
    if "publicKeyJwk" in out:
        out["publicKeyJwk"] = _project_jwk(out.get("publicKeyJwk"))
    return out


def project_location_state(raw: dict[str, Any]) -> dict[str, Any]:
    """Project the location specialist's ``list_state`` for pod egress.

    Rebuilds the payload from the keep-lists so no un-enumerated field -- above
    all the owner's wrapped private key -- can ride along. The shape the pod sees
    is a strict subset of what the owner sees, sufficient to answer the full range
    of location questions the hub answers (who can I share with, what is active,
    what circles, what public links, who is requesting access), and nothing more.

    Fail-closed at two levels: which KEYS cross (the keep-lists) and what rides
    inside a kept dict (``_project_jwk`` for key material, per-entry keep-lists for
    circles / invites / requests). A field added to the underlying service later,
    at either level, is dropped by omission.
    """
    empty: dict[str, Any] = {
        "recipients": [],
        "circles": [],
        "myRecipientKey": None,
        "ownerGrants": [],
        "receivedGrants": [],
        "publicInvites": [],
        "requests": [],
        "capabilityScopes": [],
    }
    if not isinstance(raw, dict):
        return empty
    my_key = raw.get("myRecipientKey")
    return {
        "recipients": [
            _project_key_bearing(r, _LOCATION_RECIPIENT_KEEP) for r in (raw.get("recipients") or [])
        ],
        "circles": [_pick(c, _LOCATION_CIRCLE_KEEP) for c in (raw.get("circles") or [])],
        "myRecipientKey": _project_key_bearing(my_key, _LOCATION_MY_KEY_KEEP)
        if isinstance(my_key, dict)
        else None,
        "ownerGrants": [_pick(g, _LOCATION_GRANT_KEEP) for g in (raw.get("ownerGrants") or [])],
        "receivedGrants": [
            _pick(g, _LOCATION_GRANT_KEEP) for g in (raw.get("receivedGrants") or [])
        ],
        "publicInvites": [
            _pick(p, _LOCATION_PUBLIC_INVITE_KEEP) for p in (raw.get("publicInvites") or [])
        ],
        "requests": [_pick(q, _LOCATION_REQUEST_KEEP) for q in (raw.get("requests") or [])],
        # Coerced to plain strings so a future structured entry cannot ride through.
        "capabilityScopes": [
            str(s) for s in (raw.get("capabilityScopes") or []) if isinstance(s, (str, int))
        ],
    }


# --- Email egress allowlist -----------------------------------------------------
# The email door reads a NUDGE summary -- what needs the owner's attention now:
# upcoming meetings and important unread senders -- never message bodies. Only
# display-safe fields cross; every raw address, opaque Gmail resource handle, and
# live join link is dropped by omission, the same fail-closed rule location uses.

#: One inbox nudge (an upcoming meeting or an important unread). Sender DISPLAY
#: name only -- the raw ``sender_email`` is dropped like every masked PII join.
#: ``thread_id`` / ``message_id`` name Gmail resources a keyless pod cannot open
#: and must not enumerate; ``meeting_url`` is a live join CAPABILITY, not display
#: data. All are dropped by never appearing on this keep-list.
_EMAIL_NUDGE_KEEP = (
    "type",
    "title",
    "sender",
    "received_at",
    "starts_at",
)


def project_email_state(raw: dict[str, Any]) -> dict[str, Any]:
    """Project the Gmail nudge summary for pod egress (fail-closed).

    Keeps only ``connected`` (bool), an optional coded ``reason`` (why a read
    could not run: ``not_connected`` / ``needs_reauth``), and display-safe nudge
    fields. Drops the owner's account address, every raw sender address, every
    Gmail resource handle, and any live meeting link. A field added upstream is
    dropped by omission. No message body appears in this read's source, and none
    could cross even if it did: the keep-list admits only the enumerated fields.
    """
    if not isinstance(raw, dict):
        return {"connected": False, "reason": "unavailable", "nudges": []}
    # A successful nudge read carries no explicit flag; presence of the payload
    # means the connection served the read, so default connected=True. The reader
    # sets connected=False + a coded reason for the not-connected / reauth cases.
    reason = raw.get("reason")
    return {
        "connected": bool(raw.get("connected", True)),
        "reason": str(reason) if isinstance(reason, str) and reason else None,
        "nudges": [
            _pick(n, _EMAIL_NUDGE_KEEP) for n in (raw.get("nudges") or []) if isinstance(n, dict)
        ],
    }


@dataclass(frozen=True)
class PodDataDoorRead:
    """One read the door exposes: a name, and the projection its output passes
    through. The reader itself is resolved lazily (below) so this module imports
    without the heavy, DB-bound specialist service -- which is what lets the
    projection be tested for what it drops without a database."""

    name: str
    project: Callable[[dict[str, Any]], dict[str, Any]]


#: The registry. Keyed on the specialist NAME, not a scope: location reads and
#: writes share one scope (``cap.location.live.view``), so a scope predicate
#: could not tell a read from a write. The name maps to fixed read-only code, so
#: the read/write boundary is structural, not a runtime check that could be
#: fooled. Adding a specialist here is a deliberate, reviewable act.
POD_DATA_DOOR_READS: dict[str, PodDataDoorRead] = {
    "location": PodDataDoorRead(name="location", project=project_location_state),
    "email": PodDataDoorRead(name="email", project=project_email_state),
}


async def _read_location(owner_id: str) -> dict[str, Any]:
    # Imported at call time, never at module import: this keeps the door's
    # registry and projection free of a DB dependency, and keeps the heavy
    # service off the import path of anything that only needs to project.
    from hushh_mcp.services.one_location_agent_service import OneLocationAgentService

    # read_only=True is not optional here: list_state otherwise runs expiry
    # HOUSEKEEPING WRITES (expire_stale_grants, expire_public_invite) on the
    # owner's DB. A door documented "read-only by construction" must not mutate,
    # so the read forces read-only end to end rather than trusting an env var.
    # list_state is synchronous DB I/O; run it off the event loop so the async
    # door path never blocks the hub while the location read runs.
    return await asyncio.to_thread(
        lambda: OneLocationAgentService().list_state(user_id=owner_id, read_only=True)
    )


async def _read_email(owner_id: str) -> dict[str, Any]:
    """Read the owner's Gmail NUDGE summary through the hub (OAuth, read-only).

    Returns a coded not-connected / needs-reauth marker instead of raising for
    the two EXPECTED "no live read is possible" cases, so the door renders a
    helpful answer (connect Gmail / reconnect Gmail) rather than degrading to
    runtime_unavailable. Any other failure propagates -- the broker surfaces it
    and the pod falls through, exactly as an unmapped read would.

    The only DB write this can trigger is the connection service refreshing a
    near-expiry OAuth token in its own cache (see the module docstring); it never
    reads a body and never sends, labels, or deletes mail.
    """
    from hushh_mcp.services.gmail_receipts_service import (
        GmailApiError,
        get_gmail_receipts_service,
    )

    try:
        return await get_gmail_receipts_service().list_nudges(user_id=owner_id, limit=10)
    except GmailApiError as exc:
        status = getattr(exc, "status_code", None)
        if status == 404:
            return {"connected": False, "reason": "not_connected", "nudges": []}
        if status == 401:
            return {"connected": False, "reason": "needs_reauth", "nudges": []}
        raise


#: Name -> the read that fetches raw owner state. Every value is a READ; there is
#: no sibling write table by design. Async because an OAuth-backed reader (email,
#: and calendar next) does network I/O; the sync location read wraps in a thread.
_READERS: dict[str, Callable[[str], Awaitable[dict[str, Any]]]] = {
    "location": _read_location,
    "email": _read_email,
}


async def run_pod_data_door_read(name: str, *, owner_id: str) -> dict[str, Any]:
    """Run an allow-listed read for ``owner_id`` and return its egress projection.

    Async so an OAuth-backed reader can await network I/O without blocking the
    hub. Raises ``KeyError`` for a name not in the registry -- the broker maps
    that to a refusal, never a fall-through that reads something adjacent.
    ``owner_id`` is the authenticated owner the broker resolved from the pod's
    identity and the per-turn scope; it is never a value the pod supplied for
    itself.
    """
    spec = POD_DATA_DOOR_READS.get(name)
    if spec is None:
        raise KeyError(name)
    raw = await _READERS[name](owner_id)
    return spec.project(raw)


__all__ = [
    "PodDataDoorRead",
    "POD_DATA_DOOR_READS",
    "project_location_state",
    "project_email_state",
    "run_pod_data_door_read",
]
