"""Information Marketplace -> Consent Center contributor.

Maps durable marketplace access requests (``marketplace_access_requests``,
migration 076) into the shared ``ConsentCenterEntry`` dict shape consumed by the
``/consents`` Access Manager, so a seller approves/denies data-slice requests in
the same Consent Guardian surface they use for every other grant — instead of a
redundant marketplace inbox.

Design rules (mirrors ``one_location_center_contributor.py``):

* Reuse ``MarketplaceRequestService`` -- do NOT issue raw SQL. The service
  already scopes reads to the caller as owner (``list_requests``) or buyer
  (``list_buyer_requests``).
* The frontend recognizes these rows via ``metadata.request_source ==
  "marketplace_access_request"`` (see
  ``hushh-webapp/lib/consent/marketplace-consent.ts``). Approval is routed to the
  dedicated marketplace approve endpoint + envelope publish, never the generic
  developer-consent flow.
* Only the safe-summary projection of a slice is ever involved; no plaintext
  slice value passes through the consent surface.

This module is pure mapping logic over an injectable service and is safe to unit
test in isolation.
"""

from __future__ import annotations

import logging
from typing import Any

from hushh_mcp.services.marketplace_request_service import MarketplaceRequestService

logger = logging.getLogger(__name__)

# The request source flag the frontend recognizer keys off of.
MARKETPLACE_REQUEST_SOURCE = "marketplace_access_request"

_PENDING_STATUSES = {"pending"}
_ACTIVE_STATUSES = {"approved"}
_TERMINAL_STATUSES = {"denied", "expired"}


def _safe_str(value: Any) -> str:
    return str(value or "").strip()


class MarketplaceCenterContributor:
    """Maps marketplace access requests into ConsentCenterEntry dicts."""

    def __init__(self, request_service: MarketplaceRequestService | None = None) -> None:
        self._requests = request_service or MarketplaceRequestService()

    # ----- public API ----------------------------------------------------

    async def collect(self, user_id: str) -> dict[str, list[dict[str, Any]]]:
        """Return marketplace-derived consent entries grouped by surface bucket.

        Buckets match ConsentCenterResponse keys so the caller can concatenate
        directly: ``incoming_requests`` (someone wants the caller's slice),
        ``outgoing_requests`` (the caller's own pending asks), ``active_grants``
        (approved), ``history`` (resolved), ``invites`` (always empty here).
        """
        normalized_user = _safe_str(user_id)
        if not normalized_user:
            return self._empty()

        owned = await self._safe_list(self._requests.list_requests, owner_user_id=normalized_user)
        bought = await self._safe_list(
            self._requests.list_buyer_requests, buyer_user_id=normalized_user
        )

        incoming: list[dict[str, Any]] = []
        active: list[dict[str, Any]] = []
        history: list[dict[str, Any]] = []
        outgoing: list[dict[str, Any]] = []

        # Owner side: someone is requesting the caller's published slice.
        for request in owned:
            status = _safe_str(request.get("status"))
            if status in _PENDING_STATUSES:
                incoming.append(self._request_entry(request, role="owner", kind="incoming_request"))
            elif status in _ACTIVE_STATUSES:
                active.append(self._request_entry(request, role="owner", kind="active_grant"))
            elif status in _TERMINAL_STATUSES:
                history.append(self._request_entry(request, role="owner", kind="history"))

        # Buyer side: the caller's own requests against other people's slices.
        for request in bought:
            status = _safe_str(request.get("status"))
            if status in _PENDING_STATUSES:
                outgoing.append(self._request_entry(request, role="buyer", kind="outgoing_request"))
            else:
                history.append(self._request_entry(request, role="buyer", kind="history"))

        return {
            "incoming_requests": incoming,
            "outgoing_requests": outgoing,
            "active_grants": active,
            "history": history,
            "invites": [],
        }

    async def counts(self, user_id: str) -> dict[str, int]:
        """Surface counts for the consent summary endpoint."""
        buckets = await self.collect(user_id)
        return {
            "pending": len(buckets["incoming_requests"]),
            "active": len(buckets["active_grants"]),
            "previous": len(buckets["history"]),
        }

    # ----- helpers -------------------------------------------------------

    async def _safe_list(self, fn, **kwargs) -> list[dict[str, Any]]:
        """Run a scoped list call, never letting a marketplace failure break the
        consent surface."""
        try:
            return list(await fn(**kwargs) or [])
        except Exception as exc:
            logger.warning("marketplace.consent_center.list_failed kwargs=%s error=%s", kwargs, exc)
            return []

    def _request_entry(self, request: dict[str, Any], *, role: str, kind: str) -> dict[str, Any]:
        """Shape a marketplace request row into a ConsentCenterEntry dict.

        ``role`` is the caller's role for this row: ``owner`` (the seller whose
        slice is requested) or ``buyer`` (the caller made the request). It drives
        the counterpart label and which section the deep link points at.
        """
        request_id = _safe_str(request.get("id"))
        status = _safe_str(request.get("status")) or "pending"
        domain = _safe_str(request.get("domain"))
        scope_handle = _safe_str(request.get("scopeHandle"))
        slice_name = _safe_str(request.get("sliceName")) or "Data slice"

        if role == "owner":
            counterpart_id = _safe_str(request.get("buyerUserId"))
            counterpart_label = _safe_str(request.get("buyerLabel")) or "A marketplace buyer"
            section = "requests"
        else:
            # The buyer directory is anonymized, so the owner's identity is never
            # surfaced to the buyer here.
            counterpart_id = ""
            counterpart_label = "Data owner"
            section = "received"

        metadata: dict[str, Any] = {
            "request_source": MARKETPLACE_REQUEST_SOURCE,
            "section": section,
            "role": role,
            "request_id": request_id,
            "requester_label": counterpart_label,
            "slice_name": slice_name,
            "domain": domain,
        }
        if scope_handle:
            metadata["scope_handle"] = scope_handle
        price_cents = request.get("priceCents")
        if price_cents is not None:
            metadata["price_cents"] = price_cents
            metadata["currency"] = _safe_str(request.get("currency")) or "USD"

        return {
            "id": f"marketplace_request:{request_id}",
            "kind": kind,
            "status": status,
            "action": _action_for_status(status),
            # Display-oriented; the frontend hook resolves the real export scope
            # (attr.<domain>.<path>.*) from the domain + scope_handle at approve.
            "scope": scope_handle or (f"attr.{domain}" if domain else "attr.marketplace"),
            "scope_description": slice_name,
            "counterpart_type": "investor",
            "counterpart_id": counterpart_id or None,
            "counterpart_label": counterpart_label,
            "request_id": request_id,
            "issued_at": request.get("createdAt"),
            "reason": _safe_str(request.get("message")) or None,
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


def _action_for_status(status: str) -> str:
    if status == "approved":
        return "CONSENT_GRANTED"
    if status == "denied":
        return "CONSENT_DENIED"
    if status == "expired":
        return "EXPIRED"
    return "REQUESTED"
