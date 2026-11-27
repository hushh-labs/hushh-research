"""Owner-reviewed Location effects backed by the canonical grants and requests."""

from __future__ import annotations

import hashlib
import json
import math
import os
from contextlib import nullcontext
from datetime import datetime, timedelta
from typing import Any, Literal, get_args
from uuid import UUID

from hushh_mcp.operons.location.policy import MAX_LOCATION_SHARE_HOURS
from hushh_mcp.services.account_deletion_lifecycle_service import AccountDeletionLifecycleService
from hushh_mcp.services.one_location_agent_service import (
    DEFAULT_APPROVAL_DURATION_HOURS,
    OneLocationAgentError,
    OneLocationAgentService,
    _assert_sharing_not_off,
    _fingerprint_public_key,
    _identity_display_label,
    _iso,
    _loads_json,
    _normalized_requested_duration,
    _parse_datetime,
    _request_expiry_has_passed,
    _resolve_share_duration,
    _utcnow,
)

LocationChatAction = Literal[
    "share_live",
    "share_pin",
    "ask",
    "view",
    "stop",
    "set_duration",
    "extend",
    "ask_extension",
    "approve",
    "decline",
]
LocationChatDurationMode = Literal["timed", "until_stopped"]

_ACTIONS = frozenset(get_args(LocationChatAction))
_SHARE_ACTIONS = {"share_live", "share_pin"}
_REQUEST_ACTIONS = {"approve", "decline"}
_OWNER_GRANT_ACTIONS = {"stop", "set_duration", "extend"}
_GRANT_ACTIONS = _OWNER_GRANT_ACTIONS | {"view", "ask_extension"}
_RELATIVE_ACTIONS = {"extend", "ask_extension"}
_DURATION_ACTIONS = _SHARE_ACTIONS | _RELATIVE_ACTIONS | {"set_duration", "ask", "approve"}
_PLAN_LIFETIME = timedelta(minutes=10)
_DEFAULT_PIN_HOURS = 1.0


def _changed(
    message: str = "This location plan changed. Review it again.",
) -> OneLocationAgentError:
    return OneLocationAgentError("LOCATION_CHAT_PLAN_CHANGED", message, status_code=409)


def _invalid(message: str) -> OneLocationAgentError:
    return OneLocationAgentError("LOCATION_CHAT_PLAN_INVALID", message, status_code=422)


def _require_current_action(action: str) -> None:
    if action == "share_pin":
        raise _invalid("Chat offers live location sharing. A one-time pin cannot be sent.")


def _not_found(message: str = "Location plan was not found.") -> OneLocationAgentError:
    return OneLocationAgentError("LOCATION_CHAT_PLAN_NOT_FOUND", message, status_code=404)


def _peer_unavailable() -> OneLocationAgentError:
    return OneLocationAgentError(
        "LOCATION_RECIPIENT_NOT_CONNECTED",
        "This person is unavailable for this location action.",
        status_code=403,
    )


def _require_enabled(action: str) -> None:
    if action in {"view", "stop"}:
        return
    if os.getenv("ONE_MAIN_CHAT_LOCATION_ENABLED", "").strip().lower() not in {
        "1",
        "true",
        "yes",
        "on",
    }:
        raise OneLocationAgentError(
            "LOCATION_CHAT_PLAN_DISABLED",
            "Open Location to continue with this action.",
            status_code=503,
        )


def _uuid(value: str | None) -> str | None:
    try:
        return str(UUID(str(value))) if value is not None else None
    except (AttributeError, ValueError) as exc:
        raise _invalid("This plan needs a valid Location reference.") from exc


def _grant_snapshot(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {
        "id": str(row["id"]),
        "expiresAt": _iso(row.get("expires_at")),
        "mode": row.get("duration_mode") or "timed",
        "circleId": str(row["source_circle_id"]) if row.get("source_circle_id") else None,
    }


def _reviewed_expiry(plan: dict[str, Any]) -> datetime | None:
    value = plan["nextExpiresAt"]
    return _parse_datetime(value, field_name="nextExpiresAt") if value else None


class LocationChatPlanService:
    def __init__(self, location: OneLocationAgentService | None = None) -> None:
        self.location = location or OneLocationAgentService()

    def _grant(
        self,
        *,
        user_id: str,
        person_user_id: str | None,
        grant_id: str | None,
        outgoing: bool,
        lane: str = "live",
        lock: bool = False,
    ) -> dict[str, Any] | None:
        # lane restricts discovery, and an explicit reference is still checked
        # against both participants and the exact granted kind.
        return self.location._execute_one(
            """
            SELECT g.*
            FROM one_location_share_grants g
            JOIN LATERAL (
               SELECT CASE
                 WHEN metadata->>'share_kind' = 'pin' THEN 'pin'
                 WHEN metadata->>'share_kind' = 'sos'
                   OR (metadata->>'share_kind' IS NULL AND metadata->>'reason' = 'sos_panic')
                   THEN 'sos'
                 ELSE 'live'
               END
               AS lane
            ) kind ON ((:allow_pin AND kind.lane = 'pin') OR (:allow_live AND kind.lane = 'live'))
            WHERE (
                    (:outgoing AND owner_user_id = :user_id
                        AND (CAST(:person_id AS TEXT) IS NULL OR recipient_user_id = :person_id))
                    OR (NOT :outgoing AND recipient_user_id = :user_id
                        AND (CAST(:person_id AS TEXT) IS NULL OR owner_user_id = :person_id))
                  )
              AND (CAST(:grant_id AS UUID) IS NULL OR id = CAST(:grant_id AS UUID))
              AND status = 'active'
              AND (expires_at IS NULL OR expires_at > clock_timestamp())
            ORDER BY created_at DESC, id DESC
            LIMIT 1
            """
            + (" FOR UPDATE OF g" if lock else ""),  # nosec B608 - static lock clause
            {
                "allow_pin": lane in {"pin", "either"},
                "allow_live": lane in {"live", "either"},
                "outgoing": outgoing,
                "user_id": user_id,
                "person_id": person_user_id,
                "grant_id": grant_id,
            },
        )

    def _request(
        self, *, user_id: str, person_user_id: str | None, request_id: str | None
    ) -> dict[str, Any]:
        rows = [
            row
            for row in self.location._execute_many(
                """
                SELECT *
                FROM one_location_access_requests
                WHERE owner_user_id = :owner_id AND status = 'pending'
                  AND (CAST(:requester_id AS TEXT) IS NULL OR requester_user_id = :requester_id)
                  AND (CAST(:request_id AS UUID) IS NULL OR id = CAST(:request_id AS UUID))
                ORDER BY requested_at DESC, id DESC
                LIMIT 5
                """,
                {"owner_id": user_id, "requester_id": person_user_id, "request_id": request_id},
            )
            if not _request_expiry_has_passed(row)
        ]
        if not rows:
            raise _not_found("Pending location request was not found.")
        if len(rows) != 1:
            raise _invalid("Choose the specific location request you want to review.")
        return rows[0]

    def _outgoing_request_snapshot(self, *, user_id: str, person: str) -> dict[str, Any] | None:
        request = self.location._execute_one(
            """SELECT id, request_revision, expires_at FROM one_location_access_requests
            WHERE owner_user_id = :owner AND requester_user_id = :requester
              AND status = 'pending' AND referred_by_user_id IS NULL
              AND expires_at > clock_timestamp()
            ORDER BY requested_at DESC LIMIT 1""",
            {"owner": person, "requester": user_id},
        )
        if not request:
            return None
        return {
            "id": str(request["id"]),
            "revision": int(request.get("request_revision") or 1),
            "expiresAt": _iso(request.get("expires_at")),
        }

    def _duration(
        self,
        *,
        action: str,
        duration_hours: float | None,
        duration_mode: str | None,
        request: dict[str, Any] | None,
        grant: dict[str, Any] | None,
        now: datetime,
    ) -> tuple[float | None, str | None, datetime | None]:
        if action not in _DURATION_ACTIONS:
            return None, None, None
        if action == "approve" and request and duration_hours is None and duration_mode is None:
            duration_hours = request.get("requested_duration_hours")
            duration_mode = request.get("requested_duration_mode")
            if duration_mode != "until_stopped" and duration_hours is None:
                duration_hours = DEFAULT_APPROVAL_DURATION_HOURS
        if action == "ask":
            hours, mode = _normalized_requested_duration(
                duration_hours=duration_hours, duration_mode=duration_mode
            )
            return hours, mode, None
        relative = action in _RELATIVE_ACTIONS or (
            action == "approve" and request is not None and bool(request.get("extends_grant_id"))
        )
        hours, expiry, mode = _resolve_share_duration(
            duration_hours=duration_hours,
            duration_mode=duration_mode,
            share_kind="share",
            now=now,
        )
        if relative:
            if not grant or grant.get("expires_at") is None or hours is None:
                raise _invalid("Choose how much time to add to an active timed share.")
            current = _parse_datetime(grant["expires_at"], field_name="expiresAt")
            expiry = current + timedelta(hours=hours)
            if expiry > now + timedelta(hours=MAX_LOCATION_SHARE_HOURS):
                raise _invalid("Choose a new end time within 24 hours.")
        return hours, mode, expiry

    def prepare(
        self,
        *,
        user_id: str,
        action: LocationChatAction,
        person_user_id: str | None = None,
        grant_id: str | None = None,
        request_id: str | None = None,
        duration_hours: float | None = None,
        duration_mode: LocationChatDurationMode | None = None,
        circle_id: str | None = None,
        origin_id: str | None = None,
        attempt_id: str | None = None,
    ) -> dict[str, Any]:
        if action not in _ACTIONS:
            raise _invalid("Choose a supported location action.")
        if action != "share_pin":
            _require_enabled(action)
        grant_id, request_id, circle_id, origin_id = map(
            _uuid, (grant_id, request_id, circle_id, origin_id)
        )
        attempt_id = _uuid(attempt_id)
        if not (person_user_id or grant_id or request_id):
            raise _invalid("Choose a person, share, or request first.")
        if (
            (request_id and action not in _REQUEST_ACTIONS)
            or (grant_id and action not in _GRANT_ACTIONS | _SHARE_ACTIONS | {"approve"})
            or (action not in _DURATION_ACTIONS and (duration_hours is not None or duration_mode))
            or (duration_hours is not None and not math.isfinite(duration_hours))
            or (duration_hours is not None and duration_mode == "until_stopped")
            or (attempt_id and not origin_id)
            or (
                action == "share_pin"
                and (
                    duration_hours not in {None, _DEFAULT_PIN_HOURS}
                    or duration_mode == "until_stopped"
                )
            )
        ):
            raise _invalid("Choose terms for this location action.")
        intent_values = [
            action,
            person_user_id,
            grant_id,
            request_id,
            duration_hours,
            duration_mode,
            circle_id,
        ]
        if attempt_id:
            intent_values.append(attempt_id)
        intent = hashlib.sha256(
            json.dumps(intent_values, separators=(",", ":")).encode()
        ).hexdigest()
        with self.location.location_plan_writer() as connection:
            if origin_id:
                self.location._execute_one(
                    "SELECT pg_advisory_xact_lock(hashtextextended(:origin_lock, 0))",
                    {"origin_lock": f"one-location-chat-origin:{user_id}:{origin_id}"},
                )
                prior = self.location._execute_one(
                    """SELECT * FROM one_location_chat_plans
                    WHERE user_id = :user_id AND origin_id = CAST(:origin_id AS UUID)
                      AND intent_hash = :intent
                      AND (receipt IS NOT NULL OR expires_at > clock_timestamp())
                    ORDER BY created_at DESC LIMIT 1""",
                    {"user_id": user_id, "origin_id": origin_id, "intent": intent},
                )
                if prior:
                    return self._project(prior)

            _require_current_action(action)
            now = _utcnow()
            request = None
            grant = None
            if action in _REQUEST_ACTIONS:
                request = self._request(
                    user_id=user_id, person_user_id=person_user_id, request_id=request_id
                )
                person_user_id = str(request["requester_user_id"])
                request_id = str(request["id"])
                if action == "approve":
                    extension_id = str(request.get("extends_grant_id") or "") or None
                    if grant_id is not None and grant_id != extension_id:
                        raise _changed()
                    grant = self._grant(
                        user_id=user_id,
                        person_user_id=person_user_id,
                        grant_id=extension_id,
                        outgoing=True,
                    )
                    if bool(extension_id) != bool(grant):
                        raise _changed(
                            "The share this request refers to changed. Review it in Location."
                        )
            elif action in _GRANT_ACTIONS:
                grant = self._grant(
                    user_id=user_id,
                    person_user_id=person_user_id,
                    grant_id=grant_id,
                    outgoing=action in _OWNER_GRANT_ACTIONS,
                    lane="either"
                    if action == "view" or (action == "stop" and grant_id)
                    else "live",
                )
                if not grant:
                    raise _not_found("Active location share was not found.")
                peer_column = (
                    "recipient_user_id" if action in _OWNER_GRANT_ACTIONS else "owner_user_id"
                )
                person_user_id = str(grant[peer_column])
            elif person_user_id:
                grant = self._grant(
                    user_id=user_id,
                    person_user_id=person_user_id,
                    grant_id=None,
                    outgoing=action in _SHARE_ACTIONS,
                    lane="live",
                )
                if grant_id and (not grant or str(grant["id"]) != grant_id):
                    raise _changed()
                if action == "ask" and grant:
                    raise _changed(
                        "This person already shares their location with you. Ask for more time."
                    )

            if not person_user_id or person_user_id == user_id:
                raise _invalid("Choose a different person.")
            AccountDeletionLifecycleService.lock_user_writes_in_transaction(
                connection, user_ids=(user_id, person_user_id)
            )
            if action == "stop" and grant_id and grant:
                # The outgoing grant already proves the owner's authority to
                # revoke it, even if the recipient or Circle is now unavailable.
                if circle_id and circle_id != str(grant.get("source_circle_id") or ""):
                    raise _changed()
            else:
                self.location._assert_location_accounts_active(user_id, person_user_id)
                if action in _SHARE_ACTIONS | {"ask", "ask_extension"} or circle_id:
                    eligible, source = self.location._resolve_location_peer_eligibility(
                        owner_user_id=user_id,
                        other_user_id=person_user_id,
                        source_circle_id=circle_id,
                    )
                    if not eligible and (circle_id or action != "ask_extension"):
                        raise _peer_unavailable()
                    circle_id = source
            if not circle_id and request:
                binding = (_loads_json(request.get("metadata")) or {}).get(
                    "chat_plan_binding"
                ) or {}
                if binding.get("requestRevision") == int(request.get("request_revision") or 1):
                    circle_id = binding.get("circleId")
            if not circle_id and grant and action in {"approve", "ask_extension"}:
                circle_id = str(grant.get("source_circle_id") or "") or None

            hours, mode, next_expiry = self._duration(
                action=action,
                duration_hours=duration_hours,
                duration_mode=duration_mode,
                request=request,
                grant=grant,
                now=now,
            )
            key_id = None
            if action in _SHARE_ACTIONS:
                key_id = self.location._recipient_key_row(
                    recipient_user_id=person_user_id, require_phone_verified=False
                )["key_id"]
            snapshot = _grant_snapshot(grant)
            prior_ask = (
                self._outgoing_request_snapshot(user_id=user_id, person=person_user_id)
                if action in {"ask", "ask_extension"}
                else None
            )
            terms = {
                "attemptId": attempt_id,
                "personDisplayLabel": _identity_display_label(
                    self.location._identity_row(person_user_id)
                ),
                "grantId": snapshot["id"]
                if snapshot
                else (str(request.get("extends_grant_id") or "") or None if request else None),
                "currentExpiresAt": snapshot["expiresAt"] if snapshot else None,
                "nextExpiresAt": _iso(next_expiry),
                "requestId": request_id or (prior_ask["id"] if prior_ask else None),
                "requestRevision": int(request.get("request_revision") or 1) if request else None,
                "durationHours": hours,
                "durationMode": mode,
                "circleId": circle_id,
                "boundGrant": snapshot,
                "boundOutgoingRequest": prior_ask,
                "keyId": key_id,
            }
            row = self.location._execute_one(
                """
                INSERT INTO one_location_chat_plans (
                  user_id, person_user_id, origin_id, intent_hash, action, terms, expires_at
                ) VALUES (:user_id, :person_id, CAST(:origin_id AS UUID), :intent, :action,
                          CAST(:terms AS JSONB), :expires_at)
                RETURNING *
                """,
                {
                    "user_id": user_id,
                    "person_id": person_user_id,
                    "origin_id": origin_id,
                    "intent": intent,
                    "action": action,
                    "terms": json.dumps(terms),
                    "expires_at": now + _PLAN_LIFETIME,
                },
            )
            if row is None:
                raise RuntimeError("Location plan insert returned no row.")
            return self._project(row)

    def _read(self, user_id: str, plan_id: str, *, lock: bool = False) -> dict[str, Any]:
        row = self.location._execute_one(
            """SELECT * FROM one_location_chat_plans
            WHERE id = CAST(:plan_id AS UUID) AND user_id = :user_id"""
            + (" FOR UPDATE" if lock else ""),  # nosec B608 - static lock clause
            {"plan_id": _uuid(plan_id), "user_id": user_id},
        )
        if row is None:
            raise _not_found()
        if (
            row["receipt"] is None
            and _parse_datetime(row["expires_at"], field_name="expiresAt") <= _utcnow()
        ):
            raise OneLocationAgentError(
                "LOCATION_CHAT_PLAN_EXPIRED", "This location review expired.", status_code=410
            )
        return row

    def _project(self, row: dict[str, Any]) -> dict[str, Any]:
        terms = _loads_json(row["terms"])
        receipt = _loads_json(row["receipt"])
        if receipt is None:
            _require_current_action(row["action"])
        response = {
            "planId": str(row["id"]),
            "originId": str(row["origin_id"]) if row["origin_id"] else None,
            "attemptId": terms.get("attemptId"),
            "personUserId": row["person_user_id"],
            "personDisplayLabel": terms["personDisplayLabel"],
            "action": row["action"],
            "grantId": terms["grantId"],
            "requestId": terms["requestId"],
            "currentExpiresAt": terms["currentExpiresAt"],
            "nextExpiresAt": receipt.get("expiresAt", terms["nextExpiresAt"])
            if receipt
            else terms["nextExpiresAt"],
            "durationHours": terms["durationHours"],
            "durationMode": terms["durationMode"],
            "circleId": terms["circleId"],
            "expiresAt": _iso(row["expires_at"]),
            "status": "executed" if receipt is not None else "pending",
        }
        if receipt is not None:
            response["receipt"] = {
                key: receipt[key]
                for key in ("grantId", "requestId", "envelopeId")
                if key in receipt
            }
        elif terms["keyId"]:
            key = self.location._recipient_key_row(
                recipient_user_id=row["person_user_id"],
                recipient_key_id=terms["keyId"],
                require_phone_verified=False,
            )
            jwk = _loads_json(key["public_key_jwk"])
            response["recipientKey"] = {
                "keyId": key["key_id"],
                "publicKeyJwk": jwk,
                "keyFingerprint": _fingerprint_public_key(jwk),
            }
        return response

    def inspect(self, *, user_id: str, plan_id: str) -> dict[str, Any]:
        return self._project(self._read(user_id, plan_id))

    def for_origin(self, *, user_id: str, origin_id: str) -> list[dict[str, Any]]:
        return self.for_origin_page(user_id=user_id, origin_id=origin_id)["plans"]

    def for_origin_page(
        self, *, user_id: str, origin_id: str, cursor: str | None = None
    ) -> dict[str, Any]:
        rows = self.location._execute_many(
            """SELECT p.* FROM one_location_chat_plans p
            WHERE p.user_id = :user_id AND p.origin_id = CAST(:origin_id AS UUID)
              AND (p.receipt IS NOT NULL OR p.expires_at > clock_timestamp())
              AND (p.receipt IS NOT NULL OR p.action <> 'share_pin')
              AND (CAST(:cursor AS UUID) IS NULL OR (p.created_at, p.id) < (
                SELECT c.created_at, c.id FROM one_location_chat_plans c
                WHERE c.id = CAST(:cursor AS UUID)
                  AND c.user_id = :user_id AND c.origin_id = CAST(:origin_id AS UUID)
              ))
            ORDER BY p.created_at DESC, p.id DESC LIMIT 101""",
            {
                "user_id": user_id,
                "origin_id": _uuid(origin_id),
                "cursor": _uuid(cursor) if cursor else None,
            },
        )
        plans = []
        for row in rows[:100]:
            try:
                plans.append(self._project(row))
            except OneLocationAgentError as exc:
                if exc.code != "LOCATION_RECIPIENT_UNAVAILABLE":
                    raise
                # Rotation invalidates this pending review, not sibling receipts.
        return {"plans": plans, "nextCursor": str(rows[99]["id"]) if len(rows) > 100 else None}

    def purge_expired_reviews(self) -> int:
        row = self.location._execute_one(
            """WITH expired AS (
                 SELECT id FROM one_location_chat_plans
                 WHERE receipt IS NULL AND expires_at < clock_timestamp() - INTERVAL '1 day'
                 ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED
               ), deleted AS (
                 DELETE FROM one_location_chat_plans WHERE id IN (SELECT id FROM expired)
                 RETURNING id
               ) SELECT COUNT(*) AS count FROM deleted"""
        )
        return int((row or {}).get("count", 0))

    def execute(
        self,
        *,
        user_id: str,
        plan_id: str,
        envelope: dict[str, Any] | None = None,
        confirmed_at: datetime | None = None,
    ) -> dict[str, Any]:
        with self.location.location_plan_writer() as connection:
            row = self._read(user_id, plan_id)
            if row["receipt"] is not None:
                return self._project(row)
            person = row["person_user_id"]
            action = row["action"]
            _require_current_action(action)
            _require_enabled(action)
            AccountDeletionLifecycleService.lock_user_writes_in_transaction(
                connection, user_ids=(user_id, person)
            )
            row = self._read(user_id, plan_id, lock=True)
            if row["receipt"] is not None:
                return self._project(row)
            terms = _loads_json(row["terms"])
            if (action in _SHARE_ACTIONS) != (envelope is not None):
                raise _invalid(
                    "An encrypted location is required only when sharing a live location or pin."
                )
            if action != "stop":
                self.location._assert_location_accounts_active(user_id, person)
            if action in _SHARE_ACTIONS | {"approve", "extend", "set_duration"}:
                # Match Settings' lock order so switching sharing off can
                # revoke a committed effect or prevent it before it starts.
                self.location._execute_one(
                    """INSERT INTO one_location_account_settings (user_id)
                    VALUES (:user_id) ON CONFLICT (user_id) DO NOTHING""",
                    {"user_id": user_id},
                )
                self.location._execute_one(
                    """SELECT user_id FROM one_location_account_settings
                    WHERE user_id = :user_id FOR UPDATE""",
                    {"user_id": user_id},
                )
                _assert_sharing_not_off(
                    self.location._execute_one, owner_user_id=user_id, share_kind="share"
                )
            grant_direction_out = action not in {"ask", "ask_extension", "view"}
            owner, recipient = (user_id, person) if grant_direction_out else (person, user_id)
            pair_guard = (
                self.location._key_bound_writer_guard(
                    owner_user_id=owner, recipient_user_id=recipient
                )
                if action not in {"view", "decline"}
                else nullcontext()
            )
            with pair_guard:
                if action in {"ask", "ask_extension"}:
                    # Match the canonical request writer before taking grant
                    # locks so a parallel ask cannot replace reviewed terms.
                    self.location._execute_one(
                        "SELECT pg_advisory_xact_lock(hashtextextended(:request_lock, 0))",
                        {"request_lock": f"one-location-access-request:{person}:{user_id}:-"},
                    )
                    prior_ask = self._outgoing_request_snapshot(user_id=user_id, person=person)
                    if prior_ask != terms["boundOutgoingRequest"]:
                        raise _changed("The pending location request changed. Review it again.")
                if terms["circleId"] and action not in {"stop", "view", "decline"}:
                    self.location._lock_circle_share_eligibility(
                        connection,
                        owner_user_id=user_id,
                        recipient_user_id=person,
                        requested_circle_id=terms["circleId"],
                    )
                grant = None
                if action != "decline":
                    grant = self._grant(
                        user_id=user_id,
                        person_user_id=person,
                        outgoing=grant_direction_out,
                        grant_id=terms["grantId"] if action in _GRANT_ACTIONS else None,
                        lane="either" if action in {"view", "stop"} else "live",
                        lock=action != "view",
                    )
                    if action in {"view", "stop"}:
                        if not grant:
                            raise _changed("This share has ended.")
                    elif _grant_snapshot(grant) != terms["boundGrant"]:
                        raise _changed("The location share changed. Review the current details.")
                receipt = self._run(
                    user_id=user_id,
                    person=person,
                    action=action,
                    plan_id=plan_id,
                    terms=terms,
                    grant=grant,
                    envelope=envelope,
                    confirmed_at=confirmed_at,
                )
            saved = self.location._execute_one(
                """UPDATE one_location_chat_plans
                SET receipt = CAST(:receipt AS JSONB), executed_at = clock_timestamp()
                WHERE id = CAST(:plan_id AS UUID) AND user_id = :user_id
                RETURNING *""",
                {"plan_id": plan_id, "user_id": user_id, "receipt": json.dumps(receipt)},
            )
            if saved is None:
                raise RuntimeError("Location plan receipt update returned no row.")
            return self._project(saved)

    def _run(
        self,
        *,
        user_id: str,
        person: str,
        action: str,
        plan_id: str,
        terms: dict[str, Any],
        grant: dict[str, Any] | None,
        envelope: dict[str, Any] | None,
        confirmed_at: datetime | None,
    ) -> dict[str, Any]:
        operation = f"one-chat-location:{plan_id}"
        if action == "share_live":
            if envelope is None:
                raise _invalid("This location share requires an encrypted location.")
            self.location._assert_envelope_precision_matches_preference(
                owner_user_id=user_id, envelope=envelope, share_kind="share"
            )
            result = self.location.create_grant_with_initial_envelope(
                owner_user_id=user_id,
                recipient_user_id=person,
                recipient_key_id=terms["keyId"],
                duration_hours=terms["durationHours"],
                duration_mode=terms["durationMode"],
                client_operation_id=operation,
                confirmed_at=confirmed_at or _utcnow(),
                envelope=envelope,
                share_kind="share",
                source_circle_id=terms["circleId"],
                enforce_connection=True,
            )
            return {
                "grantId": result["grant"]["id"],
                "envelopeId": result["envelope"]["id"],
                "expiresAt": result["grant"]["expiresAt"],
            }
        if action in {"ask", "ask_extension"}:
            request = self.location.request_access(
                requester_user_id=user_id,
                owner_user_id=person,
                requested_duration_hours=terms["durationHours"],
                requested_duration_mode=terms["durationMode"],
                extends_grant_id=terms["grantId"],
                client_operation_id=operation,
                enforce_peer_eligibility=True,
                _reviewed_grant=grant or {},
                _reviewed_circle_id=terms["circleId"],
            )
            binding = {
                "requestRevision": request["requestRevision"],
                "grantExpiresAt": terms["currentExpiresAt"],
                "circleId": terms["circleId"],
            }
            self.location._execute_one(
                """UPDATE one_location_access_requests SET metadata =
                     COALESCE(metadata, '{}'::jsonb)
                     || jsonb_build_object('chat_plan_binding', CAST(:binding AS JSONB))
                WHERE id = CAST(:request_id AS UUID) AND requester_user_id = :user_id""",
                {"binding": json.dumps(binding), "request_id": request["id"], "user_id": user_id},
            )
            return {"requestId": request["id"], "grantId": request.get("extendsGrantId")}
        if action == "view":
            # The normal recipient route enforces key/expiry again and supplies
            # ciphertext only when the user opens the pinned Location target.
            return {"grantId": terms["grantId"]}
        if action == "stop":
            revoked = self.location.revoke_grant(owner_user_id=user_id, grant_id=terms["grantId"])
            return {"grantId": revoked["id"]}
        if action in {"set_duration", "extend"}:
            updated = self.location.set_grant_duration(
                owner_user_id=user_id,
                grant_id=terms["grantId"],
                duration_hours=terms["durationHours"],
                duration_mode=terms["durationMode"],
                client_operation_id=operation,
                _reviewed_expires_at=_reviewed_expiry(terms),
            )
            return {"grantId": updated["id"], "expiresAt": updated["expiresAt"]}
        if action == "approve":
            expiry = _reviewed_expiry(terms)
            outcome = self.location.approve_request(
                owner_user_id=user_id,
                request_id=terms["requestId"],
                approval_mode="manual",
                duration_hours=terms["durationHours"],
                duration_mode=terms["durationMode"],
                expected_request_revision=terms["requestRevision"],
                _reviewed_extension=(
                    (
                        str(grant["id"]),
                        _parse_datetime(grant["expires_at"], field_name="expiresAt"),
                        expiry,
                    )
                    if grant and expiry
                    else None
                ),
                _reviewed_circle_id=terms["circleId"],
            )
            return {
                "grantId": outcome["grant"]["id"],
                "requestId": outcome["request"]["id"],
                "expiresAt": outcome["grant"]["expiresAt"],
            }
        denied = self.location.deny_request(
            owner_user_id=user_id,
            request_id=terms["requestId"],
            _expected_request_revision=terms["requestRevision"],
        )
        return {"requestId": denied["id"]}
