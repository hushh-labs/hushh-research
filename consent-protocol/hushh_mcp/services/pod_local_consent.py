"""Judge an Ed25519 consent token inside the person's own agent.

``verify_consent`` asks this first. ``None`` means "not mine to judge" and keeps the
existing hub path exactly as it was: an HMAC token (a pod can never verify one), a
token for an internal principal whose lineage lives in another ledger (``self``,
Kai, a device-bound owner token), a reserved or commercial grant, or an unavailable
snapshot for the current serving incarnation. Covered grants are answered here:

* signature: ``token_signing.verify_payload`` under ``CONSENT_TOKENS`` with
  ``require_asymmetric`` (public keys from ``CONSENT_ED25519_PUBLIC_KEYS``), so an
  untagged signature is a downgrade and is refused;
* expiry, retired scopes and the exact scope, as ``validate_token`` checks them;
* currency: the token's fingerprint must be in the signed list's ``live`` set and not
  in its ``revoked`` set, and the list must be fresh. A stale list answers
  ``unavailable``, never valid. The list is a snapshot from the last heartbeat, so a
  token minted after it (a standing grant re-minted for this turn, the first turn
  after enrollment, a grant just approved) is in neither set: the agent has not heard
  of it yet, which is not a denial, so it goes to the hub. Only a token issued before
  the snapshot (less a commit margin) and absent from ``live`` is refused here;
* key: a signature under a key id this agent does not hold (a hub key rotation, or a
  placement whose environment was never given ``CONSENT_ED25519_PUBLIC_KEYS``) is
  not judged here. It goes to the hub, which holds every key; it is never refused
  locally as "invalid", which would turn "this agent lacks a key" into a denial;
* owner: the token must name the owner the list was issued for, and the list was
  issued for this pod's HusshID, so a token for anyone else is refused.
"""

from __future__ import annotations

import base64
import binascii
import time
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from hushh_mcp.services.pod_consent_client import ConsentVerdict

_PREFIX = "HCT"
_TAG = "ed25519."
_INTERNAL_AGENTS = frozenset({"", "self", "system", "kai", "agent_kai"})
#: A grant minted just before the list was read may commit just after it, so a token
#: issued within this margin before the snapshot is also treated as not heard of yet.
_COMMIT_MARGIN_MS = 2 * 60 * 1000


def _locally_covered(agent_id: str, scope: str) -> bool:
    from hushh_mcp.consent.pkm_scope_policy import is_reserved_domain_scope
    from hushh_mcp.constants import ACTIVE_RESERVED_SCOPE_VALUES

    agent = agent_id.strip().lower()
    # Reserved capabilities and paid grants have additional canonical policy;
    # a grant-head snapshot does not establish parity with that authorization.
    return not (
        agent in _INTERNAL_AGENTS
        or agent.startswith("device:")
        or scope in ACTIVE_RESERVED_SCOPE_VALUES
        or is_reserved_domain_scope(scope)
    )


def _refuse(reason: str, *, available: bool = True) -> "ConsentVerdict":
    from hushh_mcp.services.pod_consent_client import ConsentVerdict  # noqa: PLC0415

    return ConsentVerdict(valid=False, available=available, reason=reason)


def _scope_refusal(scope: str, expected_scope: str) -> Optional["ConsentVerdict"]:
    from hushh_mcp.consent.scope_helpers import scope_matches  # noqa: PLC0415
    from hushh_mcp.constants import ConsentScope  # noqa: PLC0415

    if ConsentScope.is_retired_scope(scope):
        return _refuse("scope retired")
    wanted = str(expected_scope or "").strip()
    if wanted and not scope_matches(scope, wanted):
        return _refuse("scope mismatch")
    return None


def local_ed25519_verdict(
    token: str, *, expected_scope: str = "", now_ms: Optional[int] = None
) -> Optional["ConsentVerdict"]:
    """The local verdict for ``token``, or None when the hub path still owns it."""
    prefix, _, signed = str(token or "").strip().partition(":")
    encoded, _, signature = signed.partition(".")
    if prefix != _PREFIX or not signature.startswith(_TAG):
        return None
    try:
        raw = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return _refuse("malformed token")
    parts = raw.split("|")
    if not (len(parts) == 5 or (len(parts) == 6 and parts[5] == "commercial")):
        return _refuse("malformed token")
    user_id, agent_id, scope, issued, expires = parts[:5]
    if len(parts) == 6 or not _locally_covered(agent_id, scope):
        return None

    from hushh_mcp.services.pod_consent_revocation import (  # noqa: PLC0415
        installed_revocation_list,
        token_fingerprint,
    )

    held = installed_revocation_list()
    if held is None:
        return None

    from hushh_mcp.consent.token_signing import (  # noqa: PLC0415
        CONSENT_TOKENS,
        known_kids,
        verify_payload,
    )

    # A missing key goes to the hub before anything else, stale list or not.
    try:
        held_keys = known_kids(CONSENT_TOKENS)
    except RuntimeError:
        return None  # a malformed or absent public-key pin cannot become a denial
    if signature[len(_TAG) :].partition(".")[0] not in held_keys:
        return None
    now = int(time.time() * 1000) if now_ms is None else int(now_ms)
    if not held.fresh(now):
        return _refuse("revocation list is stale", available=False)
    if not verify_payload(
        raw, signature, hmac_key="", namespace=CONSENT_TOKENS, require_asymmetric=True
    ):
        return _refuse("invalid signature")
    try:
        expired, issued_ms = now >= int(expires), int(issued)
    except ValueError:
        return _refuse("malformed token")
    if expired:
        return _refuse("token expired")

    refused = _scope_refusal(scope, expected_scope)
    if refused is not None:
        return refused
    fingerprint = token_fingerprint(str(token).strip())
    if fingerprint in held.revoked:
        return _refuse("consent has been revoked")
    if fingerprint not in held.live:
        if issued_ms >= held.issued_at_ms - _COMMIT_MARGIN_MS:
            return None  # minted after the snapshot: not heard of yet, the hub judges
        return _refuse("consent is not active")
    if not user_id or user_id != held.owner_id:
        return _refuse("token names another owner")

    from hushh_mcp.services.pod_consent_client import ConsentVerdict  # noqa: PLC0415

    return ConsentVerdict(
        valid=True,
        available=True,
        user_id=user_id,
        hushh_id=held.hushh_id,
        scope=scope,
        reason="verified inside the agent",
    )


__all__ = ["local_ed25519_verdict"]
