"""One Location -> Consent Center contributor.

Maps the coordinate-free DTO returned by
``OneLocationAgentService.list_state`` into the shared ``ConsentCenterEntry``
shape consumed by the ``/consents`` Access Manager (Requests / Active Access /
History tabs) and the notification bell summary.

Design rules (see docs/future/one-location-consent-center-integration-plan.md):

* Reuse ``list_state`` -- do NOT issue raw SQL against ``one_location_*`` tables.
  ``list_state`` already assembles every location surface and never returns
  coordinates (those live only inside encrypted envelopes via
  ``view_latest_envelope``).
* Every emitted entry is coordinate-free. ``_assert_coordinate_free`` re-checks
  each metadata dict against the location agent's own redaction guards and
  raises if any coordinate-like key leaks in.
* The frontend recognizes these rows via
  ``metadata.request_source`` starting with ``one_location`` (see
  ``hushh-webapp/lib/consent/location-consent.ts``).

This module is pure mapping logic and is safe to unit test in isolation.
"""

from __future__ import annotations

import logging
from typing import Any

from hushh_mcp.services.one_location_agent_service import (
    COORDINATE_METADATA_KEYS,
    OneLocationAgentService,
    _contains_plaintext_location_key,
)

logger = logging.getLogger(__name__)

# Capability scope family for live location viewing. Kept as a constant so the
# consent center, scope catalog, and tests agree on one string.
LOCATION_VIEW_SCOPE = "cap.location.live.view"

_ACTIVE_GRANT_STATUSES = {"active", "approved", "granted"}
_PENDING_REQUEST_STATUSES = {"pending", "request_pending", "sent"}


def _safe_str(value: Any) -> str:
    return str(value or "").strip()


def _coerce_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    """Assert a metadata dict is coordinate-free, then return it unchanged.

    Mirrors the location agent's outbound guard so the consent center can never
    surface latitude/longitude/address/map data even if an upstream payload
    regresses.
    """
    for key in metadata:
        normalized = str(key or "").strip().lower()
        if normalized in COORDINATE_METADATA_KEYS:
            raise ValueError(
                f"one_location consent entry metadata contains forbidden coordinate key: {key}"
            )
    for value in metadata.values():
        if isinstance(value, str) and _contains_plaintext_location_key(value):
            raise ValueError(
                "one_location consent entry metadata contains a plaintext location value"
            )
    return metadata


class OneLocationCenterContributor:
    """Maps ``OneLocationAgentService.list_state`` into ConsentCenterEntry dicts."""

    def __init__(self, location_service: OneLocationAgentService | None = None) -> None:
        self._location = location_service or OneLocationAgentService()

    # ----- public API ----------------------------------------------------

    def collect(self, user_id: str) -> dict[str, list[dict[str, Any]]]:
        """Return location-derived consent entries grouped by surface bucket.

        Buckets match ConsentCenterResponse keys so the caller can concatenate
        directly: ``incoming_requests``, ``outgoing_requests``,
        ``active_grants``, ``history``, ``invites``.
        """
        normalized_user = _safe_str(user_id)
        if not normalized_user:
            return self._empty()
        try:
            state = self._location.list_state(user_id=normalized_user)
        except Exception as exc:  # never let location break the consent surface
            logger.warning(
                "one_location.consent_center.list_state_failed user=%s error=%s",
                normalized_user,
                exc,
            )
            return self._empty()

        return {
            "incoming_requests": self._incoming_requests(state, normalized_user),
            "outgoing_requests": self._outgoing_requests(state, normalized_user),
            "active_grants": self._active_grants(state, normalized_user),
            "history": self._history(state, normalized_user),
            "invites": self._invites(state, normalized_user),
        }

    def counts(self, user_id: str) -> dict[str, int]:
        """Surface counts for the consent summary endpoint."""
        buckets = self.collect(user_id)
        return {
            "pending": len(buckets["incoming_requests"]),
            "active": len(buckets["active_grants"]),
            "previous": len(buckets["history"]),
        }

    # ----- mappers -------------------------------------------------------

    def _incoming_requests(self, state: dict[str, Any], user_id: str) -> list[dict[str, Any]]:
        entries: list[dict[str, Any]] = []
        for request in state.get("requests") or []:
            if _safe_str(request.get("ownerUserId")) != user_id:
                continue
            if _safe_str(request.get("status")) not in _PENDING_REQUEST_STATUSES:
                continue
            entries.append(
                self._request_entry(
                    request,
                    kind="incoming_request",
                    section="approvals",
                    counterpart_id=_safe_str(request.get("requesterUserId")),
                    counterpart_label=_safe_str(request.get("requesterDisplayName"))
                    or "Someone in your One Network",
                )
            )
        return entries

    def _outgoing_requests(self, state: dict[str, Any], user_id: str) -> list[dict[str, Any]]:
        entries: list[dict[str, Any]] = []
        for request in state.get("requests") or []:
            if _safe_str(request.get("requesterUserId")) != user_id:
                continue
            if _safe_str(request.get("ownerUserId")) == user_id:
                continue
            status = _safe_str(request.get("status"))
            kind = "outgoing_request" if status in _PENDING_REQUEST_STATUSES else "history"
            entries.append(
                self._request_entry(
                    request,
                    kind=kind,
                    section="my_requests",
                    counterpart_id=_safe_str(request.get("ownerUserId")),
                    counterpart_label=_safe_str(request.get("ownerDisplayName"))
                    or "Location owner",
                )
            )
        return entries

    def _active_grants(self, state: dict[str, Any], user_id: str) -> list[dict[str, Any]]:
        entries: list[dict[str, Any]] = []
        # Owner side: people who can see me.
        for grant in state.get("ownerGrants") or []:
            if _safe_str(grant.get("status")) not in _ACTIVE_GRANT_STATUSES:
                continue
            entries.append(
                self._grant_entry(
                    grant,
                    section="people",
                    counterpart_id=_safe_str(grant.get("recipientUserId")),
                    counterpart_label=_safe_str(grant.get("recipientDisplayName"))
                    or "A trusted person",
                )
            )
        # Recipient side: shared with me.
        for grant in state.get("receivedGrants") or []:
            if _safe_str(grant.get("status")) not in _ACTIVE_GRANT_STATUSES:
                continue
            entries.append(
                self._grant_entry(
                    grant,
                    section="shared",
                    counterpart_id=_safe_str(grant.get("ownerUserId")),
                    counterpart_label=_safe_str(grant.get("ownerDisplayName"))
                    or "A trusted person",
                )
            )
        # Active public links.
        for invite in state.get("publicInvites") or []:
            if _safe_str(invite.get("status")) != "active":
                continue
            entries.append(self._public_invite_entry(invite, kind="active_grant"))
        return entries

    def _history(self, state: dict[str, Any], user_id: str) -> list[dict[str, Any]]:
        entries: list[dict[str, Any]] = []
        terminal = {"revoked", "expired", "denied", "cancelled"}
        for bucket in ("ownerGrants", "receivedGrants"):
            for grant in state.get(bucket) or []:
                if _safe_str(grant.get("status")) not in terminal:
                    continue
                is_owner = bucket == "ownerGrants"
                entries.append(
                    self._grant_entry(
                        grant,
                        section="shared" if not is_owner else "people",
                        counterpart_id=_safe_str(
                            grant.get("recipientUserId") if is_owner else grant.get("ownerUserId")
                        ),
                        counterpart_label=_safe_str(
                            grant.get("recipientDisplayName")
                            if is_owner
                            else grant.get("ownerDisplayName")
                        )
                        or "A trusted person",
                        kind="history",
                    )
                )
        for invite in state.get("publicInvites") or []:
            if _safe_str(invite.get("status")) in {"revoked", "expired"}:
                entries.append(self._public_invite_entry(invite, kind="history"))
        return entries

    def _invites(self, state: dict[str, Any], user_id: str) -> list[dict[str, Any]]:
        entries: list[dict[str, Any]] = []
        for invite in state.get("circleInvites") or []:
            status = _safe_str(invite.get("status"))
            entries.append(
                {
                    "id": f"one_location_circle:{_safe_str(invite.get('id'))}",
                    "kind": "invite",
                    "status": status or "active",
                    "action": "INVITE",
                    "scope": LOCATION_VIEW_SCOPE,
                    "scope_description": "Invite to One Location",
                    "counterpart_type": "investor",
                    "counterpart_id": None,
                    "counterpart_label": "Invite to One",
                    "issued_at": invite.get("createdAt"),
                    "expires_at": invite.get("expiresAt"),
                    "metadata": _coerce_metadata(
                        {
                            "request_source": "one_location_circle_invite",
                            "section": "people",
                        }
                    ),
                }
            )
        return entries

    # ----- entry builders ------------------------------------------------

    def _grant_entry(
        self,
        grant: dict[str, Any],
        *,
        section: str,
        counterpart_id: str,
        counterpart_label: str,
        kind: str = "active_grant",
    ) -> dict[str, Any]:
        grant_id = _safe_str(grant.get("id"))
        duration_hours = grant.get("durationHours")
        metadata = _coerce_metadata(
            {
                "request_source": "one_location_share_grant",
                "section": section,
                "grant_id": grant_id,
                "requester_label": counterpart_label,
                **({"duration_label": _duration_label(duration_hours)} if duration_hours else {}),
            }
        )
        return {
            "id": f"one_location_grant:{grant_id}",
            "kind": kind,
            "status": _safe_str(grant.get("status")) or "active",
            "action": "CONSENT_GRANTED",
            "scope": LOCATION_VIEW_SCOPE,
            "scope_description": "Live location sharing",
            "counterpart_type": "investor",
            "counterpart_id": counterpart_id or None,
            "counterpart_label": counterpart_label,
            "issued_at": grant.get("createdAt") or grant.get("updatedAt"),
            "expires_at": grant.get("expiresAt"),
            "metadata": metadata,
        }

    def _request_entry(
        self,
        request: dict[str, Any],
        *,
        kind: str,
        section: str,
        counterpart_id: str,
        counterpart_label: str,
    ) -> dict[str, Any]:
        request_id = _safe_str(request.get("id"))
        metadata = _coerce_metadata(
            {
                "request_source": "one_location_access_request",
                "section": section,
                "request_id": request_id,
                "requester_label": counterpart_label,
            }
        )
        return {
            "id": f"one_location_request:{request_id}",
            "kind": kind,
            "status": _safe_str(request.get("status")) or "pending",
            "action": "REQUESTED",
            "scope": LOCATION_VIEW_SCOPE,
            "scope_description": "Live location access request",
            "counterpart_type": "investor",
            "counterpart_id": counterpart_id or None,
            "counterpart_label": counterpart_label,
            "request_id": request_id,
            "issued_at": request.get("requestedAt"),
            "reason": _safe_str(request.get("message")) or None,
            "metadata": metadata,
        }

    def _public_invite_entry(self, invite: dict[str, Any], *, kind: str) -> dict[str, Any]:
        invite_id = _safe_str(invite.get("id"))
        metadata = _coerce_metadata(
            {
                "request_source": "one_location_public_invite",
                "section": "public_responses",
            }
        )
        return {
            "id": f"one_location_public:{invite_id}",
            "kind": kind,
            "status": _safe_str(invite.get("status")) or "active",
            "action": "CONSENT_GRANTED",
            "scope": LOCATION_VIEW_SCOPE,
            "scope_description": "Public location link",
            "counterpart_type": "self",
            "counterpart_id": None,
            "counterpart_label": "Public location link",
            "issued_at": invite.get("createdAt") or invite.get("updatedAt"),
            "expires_at": invite.get("expiresAt"),
            "metadata": metadata,
        }

    @staticmethod
    def _empty() -> dict[str, list[dict[str, Any]]]:
        return {
            "incoming_requests": [],
            "outgoing_requests": [],
            "active_grants": [],
            "history": [],
            "invites": [],
        }


def _duration_label(duration_hours: Any) -> str:
    try:
        hours = float(duration_hours)
    except (TypeError, ValueError):
        return ""
    if hours <= 0:
        return ""
    if hours < 1:
        minutes = int(round(hours * 60))
        return f"{minutes} min"
    if hours % 24 == 0:
        days = int(hours // 24)
        return f"{days} day" if days == 1 else f"{days} days"
    whole = int(hours) if hours.is_integer() else hours
    return f"{whole} hour" if whole == 1 else f"{whole} hours"
