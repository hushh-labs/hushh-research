"""Owner Allow: explicit per-request authority for automatic document sharing.

A Trusted-circle request receives the sealed ``trusted_auto`` marker when it is
created. A request from any other connection enters the same automatic search,
payment and sharing pipeline only after the owner taps Allow on that one
request. Allow re-seals the request envelope with ``trusted_auto`` plus an
``owner_allowed`` record holding the owner's price.

Every automatic recheck that used to require current Trusted membership accepts
either that membership or a valid owner Allow with an active connection. The
sealed marker is the authority. The plaintext
``drive_share_requests.owner_allowed_at`` column is the Consent Center's
projection hint, and it can only withdraw authority, never grant it: a
disconnect clears it, which ends the Allow for good. Reconnecting never restores
an Allow, as it never restores revoked scope grants or named Circles.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from typing import Any
from uuid import UUID

from sqlalchemy import text

from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.drive_sharing_contract import DriveSharingError

OWNER_ALLOWED_KEY = "owner_allowed"
OWNER_ALLOWED_VERSION = 1
DEFAULT_PRICE_CENTS = 50
MIN_OWNER_PRICE_CENTS = 50
MAX_OWNER_PRICE_CENTS = 50_000
LEGACY_REQUEST_POLICY = "oct13_restored"
LEGACY_DEFAULT_PRICE_CENTS = 1_000
# Sealed at creation on requester-origin requests since 2026-10-17: a Trusted
# request, or one the owner allowed, shares every in-period match after
# payment with no owner file selection, at a price from $0.50 in cents. Older
# sealed requests keep their own price and review contract.
AUTOSHARE_REQUEST_FLOW = "oct17_autoshare"
SEMANTIC_SEARCH_POLICY_VERSION = 4
SEMANTIC_SEARCH_ENROLLMENT_FLAG = "DRIVE_REQUEST_SEMANTIC_SEARCH_ENABLED"


def autoshare_enabled() -> bool:
    """New requests seal the autoshare flow everywhere except production.

    Production keeps the owner-review flow until it is approved there; requests
    already sealed keep their own contract either way.
    """
    return os.getenv("ENVIRONMENT", "").strip().lower() != "production"


def autoshare_request(private: Mapping[str, Any]) -> bool:
    """The request was created for automatic sharing of every in-period match."""
    return (
        private.get("request_flow") == AUTOSHARE_REQUEST_FLOW
        and private.get("agent_package_required") is not True
    )


def semantic_search_enrollment_enabled() -> bool:
    """Enroll new UAT requests; a flag change never reinterprets sealed requests."""
    return (
        os.getenv("ENVIRONMENT", "").strip().lower() == "uat"
        and os.getenv(SEMANTIC_SEARCH_ENROLLMENT_FLAG, "true").strip().lower() == "true"
    )


def activity_union_paused() -> bool:
    """Pause new-policy work while preserving saved readers and receipts."""
    return os.getenv("DRIVE_REQUEST_ACTIVITY_UNION_PAUSED", "false").strip().lower() == "true"


def new_semantic_search_policy_version() -> int:
    """Rollback changes enrollment, never the policy of a saved request."""
    enabled = os.getenv("DRIVE_REQUEST_ACTIVITY_UNION_ENABLED", "true").strip().lower() == "true"
    return SEMANTIC_SEARCH_POLICY_VERSION if enabled else 3


def new_semantic_model_binding(*, policy_version: int) -> dict | None:
    """Freeze the current processor and validate the new request's policy."""
    from hushh_mcp.runtime_providers.managed_text import managed_text_binding, managed_text_policy

    binding: dict | None
    if managed_text_policy() is not None:
        binding = managed_text_binding()
    else:
        provider = os.getenv("DRIVE_REQUEST_SEMANTIC_MODEL_PROVIDER", "gemini").strip().lower()
        if provider != "gemini":
            raise ValueError("Azure Documents requires the UAT administrator policy")
        binding = None
    if policy_version == 4 and (binding is None or binding.get("provider") != "azure_openai"):
        raise DriveSharingError("provider_unavailable")
    return binding


def semantic_search_request(private: Mapping[str, Any]) -> bool:
    """Only the exact policy sealed at creation selects semantic request search."""
    version = private.get("semantic_search_policy_version")
    return (
        type(version) is int
        and version in {1, 2, 3, 4}
        and autoshare_request(private)
        and private.get("v1_live_request") is not True
    )


def semantic_search_policy_view(private: Mapping[str, Any]) -> dict[str, bool]:
    """Project saved policy capabilities without reinterpreting enrollment flags."""
    version = private.get("semantic_search_policy_version")
    enabled = semantic_search_request(private)
    return {
        "semanticSearch": enabled,
        "providerResultsOnly": version in (3, 4),
        "activityDateUnion": version == 4,
        "discoveryDelivery": version in (2, 3, 4) and enabled,
    }


def whole_dollar_request(private: Mapping[str, Any]) -> bool:
    """Only an October 13 restored request without the autoshare flow keeps whole dollars."""
    return private.get("legacy_request_policy") == LEGACY_REQUEST_POLICY and not autoshare_request(
        private
    )


def request_has_document_scope(private: Mapping[str, Any]) -> bool:
    """An exact server-bound packet may legitimately contain undated documents.

    This checks shape only, never grants authority. Callers still validate the
    current manifest, recipient, consent, owner Allow and frozen source versions.
    Ordinary free-text requests retain their explicit date requirement.
    """
    purpose = private.get("purpose", {})
    if isinstance(purpose, Mapping) and purpose.get("periodStart") and purpose.get("periodEnd"):
        return True
    packet = private.get("reusable_packet")
    if private.get("agent_package_required") is not True or not isinstance(packet, Mapping):
        return False
    try:
        UUID(packet["packetId"])
        return bool(
            type(packet["version"]) is int
            and packet["version"] >= 1
            and isinstance(packet["manifestDigest"], str)
            and re.fullmatch(r"[0-9a-f]{64}", packet["manifestDigest"])
            and type(packet["listingRevision"]) is int
            and packet["listingRevision"] >= 1
            and valid_owner_price_cents(packet["priceCents"])
            and isinstance(packet["ownerUserId"], str)
            and packet["ownerUserId"]
        )
    except (KeyError, TypeError, ValueError, AttributeError):
        return False


def valid_owner_price_cents(value: object) -> bool:
    """US dollars from $0.50 to $500, as integer cents. Booleans are not prices."""
    return type(value) is int and MIN_OWNER_PRICE_CENTS <= value <= MAX_OWNER_PRICE_CENTS


def valid_legacy_request_price_cents(value: object) -> bool:
    """October 13 restored requests keep their whole-dollar price contract."""
    return valid_owner_price_cents(value) and value >= 100 and value % 100 == 0


def valid_request_price_cents(private: Mapping[str, Any], value: object) -> bool:
    """The price rule sealed into this request: whole dollars, or cents from $0.50."""
    if whole_dollar_request(private):
        return valid_legacy_request_price_cents(value)
    return valid_owner_price_cents(value)


def owner_allowed_record(*, amount_cents: int | None, allowed_at: str) -> dict[str, Any]:
    """The sealed record Allow adds next to ``trusted_auto: True``."""
    if amount_cents is not None and not valid_owner_price_cents(amount_cents):
        raise ValueError("invalid owner price")
    return {
        "v": OWNER_ALLOWED_VERSION,
        "amount_cents": amount_cents,
        "allowed_at": allowed_at,
    }


def owner_allowed_marker(private: Mapping[str, Any]) -> dict[str, Any] | None:
    """Return the owner's sealed Allow record, or None when absent or malformed.

    A record without the ``trusted_auto`` marker beside it is not authority.
    """
    marker = private.get(OWNER_ALLOWED_KEY)
    if (
        not isinstance(marker, Mapping)
        or marker.get("v") != OWNER_ALLOWED_VERSION
        or private.get("trusted_auto") is not True
    ):
        return None
    amount = marker.get("amount_cents")
    if amount is not None and not valid_owner_price_cents(amount):
        return None
    return dict(marker)


def _complete_selection(marker: Mapping[str, Any]) -> dict[str, Any] | None:
    """Validate a sealed exact selection without deciding who authorized it."""
    sources = marker.get("selected_sources")
    positions = marker.get("selected_positions")
    if (
        type(marker.get("package_revision")) is not int
        or marker["package_revision"] < 1
        or type(marker.get("request_revision")) is not int
        or type(marker.get("connection_generation")) is not int
        or not isinstance(marker.get("search_job_id"), str)
        or not isinstance(marker.get("package_digest"), str)
        or not re.fullmatch(r"[0-9a-f]{64}", marker["package_digest"])
        or not isinstance(positions, list)
        or not 1 <= len(positions) <= 120
        or type(marker.get("package_selected_count")) is not int
        or marker["package_selected_count"] != len(positions)
        or any(type(p) is not int or p < 1 for p in positions)
        or positions != sorted(set(positions))
        or not isinstance(sources, list)
        or len(sources) != len(positions)
    ):
        return None
    for position, source in zip(positions, sources, strict=True):
        if (
            not isinstance(source, Mapping)
            or source.get("position") != position
            or not isinstance(source.get("source_version"), str)
            or not source["source_version"]
            or any(
                not isinstance(source.get(key), str)
                or not re.fullmatch(r"[0-9a-f]{64}", source[key])
                for key in ("file_digest", "content_fingerprint", "evidence_digest")
            )
        ):
            return None
    return dict(marker)


def trusted_selection_marker(private: Mapping[str, Any]) -> dict[str, Any] | None:
    """V1 machine selection under Trusted access; never represents an owner Allow."""
    marker = private.get("trusted_selection")
    if (
        private.get("v1_live_request") is not True
        or private.get("trusted_auto") is not True
        or private.get("agent_package_required") is not True
        or private.get("reusable_packet") is not None
        or private.get(OWNER_ALLOWED_KEY) is not None
        or not isinstance(marker, Mapping)
        or type(marker.get("v")) is not int
        or marker.get("v") != 1
        or not isinstance(marker.get("selected_at"), str)
        or not marker["selected_at"]
        or marker.get("amount_cents") is not None
        and not valid_owner_price_cents(marker["amount_cents"])
    ):
        return None
    return _complete_selection(marker)


def package_allow_marker(private: Mapping[str, Any]) -> dict[str, Any] | None:
    """Exact sealed selection, from owner Allow or the current V1 Trusted lane.

    Shape alone never grants access. Every caller must separately recheck the
    matching authority with automatic_recipient_current before effects.
    """
    if private.get("agent_package_required") is not True:
        return None
    marker = owner_allowed_marker(private)
    return _complete_selection(marker) if marker is not None else trusted_selection_marker(private)


def autoshare_owner_allow_authority(private: Mapping[str, Any]) -> bool:
    """The owner's sealed Allow is the whole payment authority for this request.

    The autoshare flow prices a requested period, never a file list, so the
    requester may be asked to pay as soon as the owner allows: no frozen batch
    and no owner file review stand between Allow and the payment ask. Package
    and V1 requests bind an exact digest instead and keep their own lane.
    Callers must still recheck the live pair with automatic_recipient_current.
    """
    return (
        autoshare_request(private)
        and private.get("agent_package_required") is not True
        and private.get("v1_live_request") is not True
        and private.get("trusted_auto") is True
        and owner_allowed_marker(private) is not None
    )


def owner_allowed_price_cents(private: Mapping[str, Any]) -> int | None:
    """The owner's chosen price, or None for a free or non-allowed request."""
    marker = owner_allowed_marker(private)
    return None if marker is None else marker.get("amount_cents")


def request_connection_current(
    connection: Any, owner: str, recipient: str, request_id: str
) -> bool:
    """The pair is connected, the requester is admitted, and no disconnect ended this Allow."""
    if owner == recipient or not connector_feature_enabled("drive_document_sharing", recipient):
        return False
    return bool(
        connection.execute(
            text("""
            SELECT EXISTS(SELECT 1 FROM connections
              WHERE status='active' AND ((user_a_id=:owner AND user_b_id=:recipient)
                OR (user_b_id=:owner AND user_a_id=:recipient)))
              AND EXISTS(SELECT 1 FROM drive_share_requests
                WHERE request_id=:request AND user_id=:owner
                  AND recipient_user_id=:recipient AND owner_allowed_at IS NOT NULL)
        """),
            {"owner": owner, "recipient": recipient, "request": str(request_id)},
        ).scalar_one()
    )


def automatic_recipient_current(
    connection: Any, owner: str, recipient: str, private: Mapping[str, Any], *, request_id: str
) -> bool:
    """Recheck for automatic work: current Trusted membership, or this request's owner Allow."""
    from hushh_mcp.services.drive_sharing_store import DriveSharingStore

    if private.get("agent_package_required") is True:
        if trusted_selection_marker(private) is not None:
            return DriveSharingStore._trusted_recipient_current(connection, owner, recipient)
        return package_allow_marker(private) is not None and request_connection_current(
            connection, owner, recipient, request_id
        )
    if DriveSharingStore._trusted_recipient_current(connection, owner, recipient):
        return True
    return owner_allowed_marker(private) is not None and request_connection_current(
        connection, owner, recipient, request_id
    )


def end_owner_allows_for_disconnected_pair(
    connection: Any, *, user_a_id: str, user_b_id: str
) -> int:
    """End every owner Allow between two people, inside their disconnect transaction.

    Clearing ``owner_allowed_at`` withdraws the Allow from every automatic
    recheck, and nothing sets it again. A pending automatic request returns to
    the owner's manual review, as a Trusted request does when its Trusted
    relationship changes. Nothing is shared, revoked or announced here.
    """
    if not user_a_id or not user_b_id or user_a_id == user_b_id:
        return 0
    # Databases before migration 291 have no Allow to end.
    if not connection.execute(
        text("""SELECT EXISTS (SELECT 1 FROM pg_attribute
          WHERE attrelid=to_regclass('drive_share_requests')
            AND attname='owner_allowed_at' AND NOT attisdropped)""")
    ).scalar_one():
        return 0
    from hushh_mcp.services.document_delivery.background_consent import end_for_pair

    end_for_pair(connection, user_a_id, user_b_id)
    ended = connection.execute(
        text("""
        UPDATE drive_share_requests SET owner_allowed_at=NULL,
          preparation_error_code=CASE
            WHEN status='pending' AND preparation_error_code IN
              ('trusted_auto_queued','trusted_auto_active','background_preparation_required')
            THEN 'trusted_relationship_changed' ELSE preparation_error_code END,
          updated_at=clock_timestamp()
        WHERE owner_allowed_at IS NOT NULL
          AND ((user_id=:a AND recipient_user_id=:b) OR (user_id=:b AND recipient_user_id=:a))
        RETURNING request_id
    """),
        {"a": user_a_id, "b": user_b_id},
    )
    return len(ended.all())
