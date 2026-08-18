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
  method and NOTHING in this module can mutate. There is no write registry, no
  write reader, no branch that takes a verb. A pod that wants to CHANGE state
  uses the directive transport instead (it PROPOSES; the browser EXECUTES on the
  owner's session), which is a different, separately-authorized path. This flag
  can therefore never widen a pod's authority to write.

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

from dataclasses import dataclass
from typing import Any, Callable

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
}


def _read_location(owner_id: str) -> dict[str, Any]:
    # Imported at call time, never at module import: this keeps the door's
    # registry and projection free of a DB dependency, and keeps the heavy
    # service off the import path of anything that only needs to project.
    from hushh_mcp.services.one_location_agent_service import OneLocationAgentService

    # read_only=True is not optional here: list_state otherwise runs expiry
    # HOUSEKEEPING WRITES (expire_stale_grants, expire_public_invite) on the
    # owner's DB. A door documented "read-only by construction" must not mutate,
    # so the read forces read-only end to end rather than trusting an env var.
    return OneLocationAgentService().list_state(user_id=owner_id, read_only=True)


#: Name -> the read that fetches raw owner state. Every value is a READ; there is
#: no sibling write table by design.
_READERS: dict[str, Callable[[str], dict[str, Any]]] = {
    "location": _read_location,
}


def run_pod_data_door_read(name: str, *, owner_id: str) -> dict[str, Any]:
    """Run an allow-listed read for ``owner_id`` and return its egress projection.

    Raises ``KeyError`` for a name not in the registry -- the broker maps that to
    a refusal, never a fall-through that reads something adjacent. ``owner_id`` is
    the authenticated owner the broker resolved from the pod's identity and the
    per-turn scope; it is never a value the pod supplied for itself.
    """
    spec = POD_DATA_DOOR_READS.get(name)
    if spec is None:
        raise KeyError(name)
    raw = _READERS[name](owner_id)
    return spec.project(raw)


__all__ = [
    "PodDataDoorRead",
    "POD_DATA_DOOR_READS",
    "project_location_state",
    "run_pod_data_door_read",
]
