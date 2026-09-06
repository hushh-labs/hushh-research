"""Contract-derived app action tools for One's agent tree.

The generated action gateway manifest (``contracts/kai/kai-action-gateway.vnext.json``,
loaded through ``hushh_mcp.services.action_gateway``) is the routing authority:

- Actions WITHOUT a wired ``delegate_agent_id`` execute as client directives:
  ``run_app_action`` validates policy + slots and parks a
  ``{kind: "action"}`` directive the relay forwards to the app. Zero LLM
  calls, zero agent hops; the app re-checks guards before executing.
- Actions whose ``delegate_agent_id`` maps to a wired specialist tool are
  REFUSED with a redirect to that ``ask_*`` tool, so contract ownership can
  never be bypassed by the model picking the wrong lane.
- ``manual_only`` actions are refused with where-to-do-it guidance;
  ``confirm_required`` actions park a directive flagged
  ``needsConfirmation`` so the app runs its confirmation surface.

``list_app_actions`` exposes the manifest as an on-demand ranked index
(bounded) instead of bloating the system instruction with 94 entries.
"""

from __future__ import annotations

import dataclasses
import json
import logging
import re
import uuid
from typing import Any, Callable, Literal

from google.adk.tools.tool_context import ToolContext

from hushh_mcp.consent.pii_sanitizer import mask_email
from hushh_mcp.consent.token import validate_token_with_db
from hushh_mcp.constants import ConsentScope
from hushh_mcp.one_adk import action_retrieval
from hushh_mcp.one_adk.action_retrieval import (
    RetrievedAction,
    is_retrieval_available,
    lexical_score,
    retrieval_error,
    search_actions,
)
from hushh_mcp.one_adk.request_secrets import resolve_request_secret
from hushh_mcp.one_adk.voice_domain_policy import (
    is_voice_domain_disabled,
    is_voice_entirely_disabled,
    resolve_voice_domain,
    voice_domain_label,
)
from hushh_mcp.operons.location.policy import (
    TIMED_LOCATION_SHARE_DURATION_MODE,
    UNTIL_STOPPED_LOCATION_SHARE_DURATION_MODE,
    normalize_duration_hours,
)
from hushh_mcp.services.action_gateway import (
    get_action_gateway_action,
    is_navigation_action,
    list_action_gateway_actions,
)
from hushh_mcp.services.connections_service import ConnectionsError, ConnectionsService
from hushh_mcp.services.consent_lifecycle_service import (
    ConsentLifecycleError,
    ConsentLifecycleService,
)
from hushh_mcp.services.domain_contracts import (
    CANONICAL_DOMAIN_REGISTRY,
    get_canonical_domain_metadata,
    normalize_domain_key,
)
from hushh_mcp.services.information_request_service import (
    InformationRequestError,
    InformationRequestService,
)
from hushh_mcp.services.live_voice_context import (
    read_completed_action,
    read_failed_action,
    read_live_voice_context,
    record_completed_action,
    record_failed_action,
)
from hushh_mcp.services.one_email_kyc_service import OneEmailKycService
from hushh_mcp.services.one_location_agent_service import (
    OneLocationAgentError,
    OneLocationAgentService,
)
from hushh_mcp.services.one_location_circle_service import (
    OneLocationCircleError,
    OneLocationCircleService,
)
from hushh_mcp.services.one_location_nearby_presence_service import (
    NearbyPresenceError,
    OneLocationNearbyPresenceService,
)
from hushh_mcp.services.person_profile_service import (
    PersonProfileNotFoundError,
    PersonProfileService,
)
from hushh_mcp.services.personal_knowledge_model_service import get_pkm_service
from hushh_mcp.services.spoken_name_resolver import (
    UnresolvedPersonName,
    ambiguous_match_names,
    join_names_for_speech,
    match_by_name,
    match_circle_by_name,
    normalize_spoken_name,
    resolve_spoken_names,
    split_spoken_names,
)

logger = logging.getLogger(__name__)

# Session state keys shared with agent_tree/adk_live (duplicated string to
# avoid a circular import; guarded by a test asserting equality).
_STATE_PENDING_DIRECTIVE = "hussh:pending_directive"
_STATE_PENDING_TOOL_TRACE = "hussh:tool_trace"
_STATE_SCREEN = "hussh:screen"
_STATE_VOICE_CONTEXT = "hussh:voice_context"
_STATE_GOAL_RUN = "hussh:goal_run"
_STATE_USER_ID = "hussh:user_id"
_STATE_CONSENT_TOKEN = "hussh:consent_token"  # noqa: S105

# Manifest delegate ids -> One's specialist tool names. Only these redirect;
# other delegate markers (e.g. "agent_kyc", which has no conversational
# specialist) fall through to normal policy handling.
_DELEGATE_TOOL_BY_AGENT_ID: dict[str, str] = {
    "agent_email": "ask_email_agent",
    "agent_location": "ask_location_agent",
    "agent_connections": "ask_consent_agent",
    "agent_connected_systems": "ask_connected_systems_agent",
    "agent_nav": "ask_consent_agent",
}

_MAX_LIST_RESULTS = 10
_MAX_QUERY_TOKENS = 8
# On-screen actions a queried call may keep for context after the real matches.
_MAX_QUERY_FILLER = 4
# Words that appear in almost every spoken request and would otherwise pull
# unrelated actions to the front of a bounded result list.
_QUERY_STOPWORDS = frozenset(
    {
        "the",
        "a",
        "an",
        "my",
        "me",
        "i",
        "you",
        "can",
        "could",
        "would",
        "please",
        "for",
        "to",
        "of",
        "on",
        "in",
        "at",
        "and",
        "or",
        "is",
        "it",
        "this",
        "that",
        "with",
        "do",
        "does",
        "want",
        "need",
        "get",
        "show",
        "let",
        "us",
        "we",
        "how",
        "what",
        "one",
    }
)
# Prefer what One can act on now when relevance ties.
_AVAILABILITY_ORDER = {
    "on_screen": 0,
    "journey": 1,
    "navigate_first": 2,
}


def _voice_context(tool_context: ToolContext) -> Any:
    """The freshest sanitized browser context available to this tool.

    ``run_live`` opens one long invocation per socket, so ``tool_context.state``
    is frozen at connect time: after a navigation the relay knows the new
    screen while every tool still reads the screen the person was on when they
    started talking. A cross-screen journey could therefore never continue, and
    each retry re-read the same stale value instead of converging.

    Prefer the relay's live publication, keyed by this session, and fall back
    to session state for non-live callers (typed chat, tests) which have no
    socket and no staleness problem.
    """
    session_id = getattr(getattr(tool_context, "session", None), "id", None)
    live = read_live_voice_context(session_id) if session_id else None
    if isinstance(live, dict):
        return live
    return tool_context.state.get(_STATE_VOICE_CONTEXT)


def _available_action_ids(tool_context: ToolContext) -> set[str] | None:
    """Return the browser-declared executable ids when live context exists.

    The browser may publish arbitrary descriptive metadata, but action ids are
    filtered against the generated gateway before reaching this state. An
    absent context preserves compatibility for non-live callers; a present but
    empty list deliberately means no executable controls are available.
    """
    context = _voice_context(tool_context)
    if not isinstance(context, dict) or "available_action_ids" not in context:
        return None
    ids = context.get("available_action_ids")
    if not isinstance(ids, list):
        return set()
    return {str(value).strip() for value in ids if isinstance(value, str) and value.strip()}


def _voice_settings(tool_context: ToolContext) -> dict[str, Any]:
    """The person's own restrictions on their already-authorized voice agent.

    Already bounded and allowlisted by sanitize_voice_settings on the way in;
    this only re-reads what the trust boundary already validated. Absent
    context (non-live callers, tests) means no restriction, matching
    sanitize_voice_settings' own fail-open default.
    """
    context = _voice_context(tool_context)
    settings = context.get("voice_settings") if isinstance(context, dict) else None
    return settings if isinstance(settings, dict) else {}


def _slot_fingerprint(slots: dict[str, Any]) -> str:
    """Stable identity for one action's inputs.

    Same shape the relay's directive dedupe uses, so "already done" means the
    same thing on both sides. Values are included, not just keys: sharing with
    Sarah and sharing with Abdul are different requests, and only the second
    should get through after the first has landed.
    """
    return json.dumps(
        {str(key): str(value) for key, value in sorted((slots or {}).items())},
        sort_keys=True,
    )


def _missing_required_slot(entry: dict[str, Any], slots: dict[str, Any]) -> dict[str, Any] | None:
    """First required goal input absent from ``slots`` (defaults count as filled)."""
    goal = entry.get("goal") or {}
    for spec in goal.get("required_inputs") or []:
        if not isinstance(spec, dict) or not spec.get("required"):
            continue
        slot_name = str(spec.get("slot") or spec.get("name") or "").strip()
        if not slot_name:
            continue
        if slots.get(slot_name) not in (None, ""):
            continue
        if spec.get("default_value") not in (None, ""):
            continue
        return {
            "slot": slot_name,
            "prompt": str(spec.get("prompt") or f"What should {slot_name} be?"),
        }
    return None


def _directive_flags(
    entry: dict[str, Any] | None, *, require_tap_confirmation: bool = False
) -> dict[str, bool]:
    """Return the generated contract's browser-execution boundary.

    Goal steps bypass ``run_app_action`` when they construct a route or
    continuation directive, so they must stamp the same flags. The browser
    intentionally fails closed when either flag is missing.
    """
    if not isinstance(entry, dict):
        return {
            "needsConfirmation": True,
            "trustedActivationRequired": True,
        }
    trusted_activation = str(entry.get("activation_policy") or "") == "trusted_activation_required"
    confirm_required = str(entry.get("execution_policy") or "") == "confirm_required"
    # Voice does not ask by default. `confirm_required` no longer raises a card
    # on its own, because being asked "are you sure?" after saying a thing out
    # loud is the thing people find most tiring about talking to this app --
    # and a spoken yes to a question One just asked adds no information the
    # sentence did not already carry. Product owner's call, made explicitly
    # and more than once.
    #
    # `trusted_activation_required` survives, and is a different kind of thing.
    # The two provider sign-ins open a browser popup, which platforms permit
    # only during a fresh user gesture; removing that would not streamline
    # sign-in, it would break it. Two actions of 151.
    #
    # `require_tap_confirmation` is the person's own opt-in override of that
    # default, not a second exception to it -- Voice settings, off by default,
    # same posture as the disabled-domains restriction next to it. Once on, a
    # `confirm_required` action needs the tap the browser already knows how to
    # raise for `trusted_activation_required`; nothing new on the client side.
    #
    # What this costs when the override is off (still the default), stated
    # rather than buried: a misheard sentence runs a `confirm_required` action
    # directly, including submitting a phone code and starting a location
    # share. The mitigation is elsewhere and deliberate -- destructive actions
    # resolve exactly one named target or refuse, and ambiguity names the
    # candidates rather than picking one.
    needs_confirmation = trusted_activation or (require_tap_confirmation and confirm_required)
    return {
        "needsConfirmation": needs_confirmation,
        "trustedActivationRequired": trusted_activation,
    }


# Action ids that skip the client-directive/local-handler round trip entirely
# and mutate through the backend service layer directly, the same functions
# the REST endpoints call. Deliberately narrow: only actions with no
# client-only secret (no live-coordinate encryption) and no editable draft
# state (nothing a person picks and reconsiders before confirming) belong
# here -- see the "Backend-direct voice execution" plan for the full
# reasoning. Extend this set action by action, not by widening the shape.
BACKEND_DIRECT_ACTION_IDS: frozenset[str] = frozenset(
    {
        "location.leave_circle",
        "location.delete_circle",
        "location.stop_share",
        "location.approve_request",
        "location.decline_request",
        "location.create_circle",
        "location.add_to_circle",
        "location.rename_circle",
        "connect.remove_connection",
        "connect.cancel_request",
        "connect.send_request",
        "connect.accept_request",
        "connect.reject_request",
        "location.checkout_nearby",
        "consent.request",
        "consent.deny",
        "consent.revoke",
        "consent.cancel_request",
    }
)

# Consent lifecycle actions are backend-direct and gated by a spoken yes (the
# `confirmed` slot), like connect.remove_connection. They have no local handler
# on any page, so the person's tap-confirmation preference must never park a
# browser directive for them: there would be nothing on screen to run it, and
# the action would silently die. The spoken confirmation is the gate.
BACKEND_DIRECT_VERBAL_CONFIRMATION_IDS: frozenset[str] = frozenset(
    {
        "consent.request",
        "consent.deny",
        "consent.revoke",
        "consent.cancel_request",
    }
)

# Proposals parked by propose_information_request, keyed by an opaque id the
# model hands back to consent.request. The model never sees a scope ref.
_STATE_INFORMATION_REQUEST_PROPOSALS = "hussh:information_request_proposals"
_STATE_LAST_INFORMATION_REQUEST = "hussh:last_information_request"
_INFORMATION_REQUEST_DEFAULT_HOURS = 168
_INFORMATION_REQUEST_MAX_HOURS = 720
_INFORMATION_REQUEST_MAX_PROPOSALS = 5

# Directory search shape connect.send_request's resolution mirrors exactly --
# app/connect/page-client.tsx's own DIRECTORY_RESOLVE_MAX_PAGES/_PAGE_SIZE.
_DIRECTORY_RESOLVE_MAX_PAGES = 5
_DIRECTORY_RESOLVE_PAGE_SIZE = 50

# Unlike BACKEND_DIRECT_ACTION_IDS, these two are only backend-direct when
# the model actually named a person -- there is no backend concept of
# "whatever's currently selected in the composer" for the frontend-driven
# tap-then-voice hybrid flow these actions were built for. When `person` is
# absent, _is_backend_direct() falls through to the normal directive-parking
# path below, which still correctly uses the browser's own selection state,
# completely unaffected.
BACKEND_DIRECT_WHEN_PERSON_NAMED_ACTION_IDS: frozenset[str] = frozenset(
    {
        "location.send_request",
        "location.share_selected",
    }
)


def _is_backend_direct(clean_id: str, clean_slots: dict[str, Any]) -> bool:
    """The one predicate every backend-direct eligibility check must share.

    Used identically at all three sites that need to agree on this (the
    available_action_ids guard exemption, the screen-reachability guard
    exemption, and the final dispatch decision) so they can never drift out
    of sync with each other -- exactly the failure mode this whole
    initiative exists to eliminate.
    """
    if clean_id in BACKEND_DIRECT_ACTION_IDS:
        return True
    if clean_id in BACKEND_DIRECT_WHEN_PERSON_NAMED_ACTION_IDS:
        return bool(str(clean_slots.get("person") or "").strip())
    return False


# Backend-direct errors that carry a spoken-safe .message, across the three
# service modules these actions mutate through.
_BackendDirectError = (
    OneLocationCircleError,
    OneLocationAgentError,
    ConnectionsError,
    NearbyPresenceError,
    ConsentLifecycleError,
)


class _BackendDirectConfirmationNeeded(Exception):  # noqa: N818 - control-flow signal, not a failure
    """Raised to ask the model to confirm before mutating, not to report a failure.

    connect.remove_connection is the one BACKEND_DIRECT_ACTION_IDS action with
    a hand-written two-step confirm gate independent of the contract's
    execution_policy (it is allow_direct; the browser's local handler always
    asked anyway, because removing a connection has no undo). Bypassing the
    browser means bypassing its confirm card too, so this reimplements the
    same two-step shape conversationally: the first call raises this, which
    _run_backend_direct_action turns into a `blocked` status carrying the
    question to ask; the model is expected to ask it, hear a real yes, and
    call again with `confirmed: true` in slots. Deliberately NOT recorded via
    record_failed_action -- asking a question is not a failure, and the
    already-failed guard must not stop the confirmed retry from going through.
    """


async def _verify_backend_direct_authorization(
    tool_context: ToolContext,
) -> tuple[bool, str, str]:
    """Re-validate auth for a backend-direct mutation, matching the REST layer exactly.

    A backend-direct action skips the browser round trip that would
    otherwise carry a REST call through ``require_vault_owner_token`` --
    without this, a directive-parked action would be LESS guarded than the
    same action run by tap, because the WebSocket's own consent token
    (``_STATE_CONSENT_TOKEN``) is stored raw and unvalidated the moment it
    arrives (``adk_live.py``'s app_context handler only length-bounds it).
    This re-runs the identical cryptographic check
    (``validate_token_with_db`` against ``ConsentScope.VAULT_OWNER``,
    including the DB-backed revocation check) the REST endpoints already
    depend on, plus a same-user cross-check the REST layer gets for free
    from its own auth dependency binding token to path.

    Returns ``(authorized, user_id, reason)`` -- ``reason`` is a message
    safe to hand back to the model on refusal, never the raw validation
    error.
    """
    session_user_id = str(tool_context.state.get(_STATE_USER_ID) or "").strip()
    if not session_user_id:
        return False, "", "The user is not signed in."
    token = resolve_request_secret(tool_context.state.get(_STATE_CONSENT_TOKEN))
    if not token:
        return False, "", "The vault is locked. Unlock it, then try again."
    valid, _reason, token_obj = await validate_token_with_db(token, ConsentScope.VAULT_OWNER)
    if not valid or token_obj is None:
        return (
            False,
            "",
            "The vault is locked or the session has expired. Unlock it, then try again.",
        )
    if str(token_obj.user_id) != session_user_id:
        # Should be structurally impossible (the token was minted for the
        # session that sent it) -- refuse rather than assume, since silently
        # trusting a mismatch here is exactly the class of bug this
        # re-validation exists to catch.
        logger.warning("backend_direct_token_user_mismatch action_user=%s", session_user_id)
        return False, "", "The vault is locked. Unlock it, then try again."
    return True, session_user_id, ""


async def _run_backend_direct_action(
    clean_id: str,
    clean_slots: dict[str, Any],
    tool_context: ToolContext,
    *,
    label: str,
) -> dict[str, Any]:
    """Execute a BACKEND_DIRECT_ACTION_IDS action against the service layer directly.

    No client_directive is parked and no browser round trip happens. On
    success/failure this records the same completed/failed bookkeeping the
    settlement path would have, so the existing already_completed/
    already_failed loop-guard at the top of run_app_action still works with
    no browser involved at all.
    """
    session_id = getattr(getattr(tool_context, "session", None), "id", None)
    fingerprint = _slot_fingerprint(clean_slots)
    authorized, user_id, reason = await _verify_backend_direct_authorization(tool_context)
    if not authorized:
        logger.info("one_adk_action_decision action=%s status=unauthorized", clean_id)
        # Not recorded as a failure: an unauthorized attempt is not something
        # retrying-with-the-same-inputs would ever fix by itself (it needs a
        # sign-in/unlock in between), so it must not trip the "already
        # failed, don't try again" guard the way a real execution failure
        # should.
        return {"status": "blocked", "message": reason}

    try:
        result_message, result_subject = await _execute_backend_direct_mutation(
            clean_id, clean_slots, user_id, tool_context
        )
    except _BackendDirectConfirmationNeeded as exc:
        logger.info("one_adk_action_decision action=%s status=confirmation_needed", clean_id)
        return {"status": "blocked", "message": str(exc)}
    except _BackendDirectError as exc:
        record_failed_action(session_id, clean_id, fingerprint, exc.message)
        logger.info("one_adk_action_decision action=%s status=failed reason=%s", clean_id, exc.code)
        _park_action_result_directive(tool_context, clean_id, status="failed", message=exc.message)
        return {"status": "failed", "message": exc.message}
    except Exception:  # noqa: BLE001 - the model must be told something failed, not why internally
        record_failed_action(session_id, clean_id, fingerprint, "unexpected_error")
        logger.exception(
            "one_adk_action_decision action=%s status=failed reason=unexpected", clean_id
        )
        failure_message = f"{label} did not go through. Try again in a moment."
        _park_action_result_directive(
            tool_context, clean_id, status="failed", message=failure_message
        )
        return {"status": "failed", "message": failure_message}

    record_completed_action(session_id, clean_id, fingerprint)
    logger.info("one_adk_action_decision action=%s status=completed backend_direct=true", clean_id)
    _park_action_result_directive(
        tool_context,
        clean_id,
        status="completed",
        message=result_message,
        subject=result_subject,
    )
    return {
        "status": "completed",
        "message": result_message,
    }


def _park_action_result_directive(
    tool_context: ToolContext,
    action_id: str,
    *,
    status: Literal["completed", "failed"],
    message: str,
    subject: dict[str, str] | None = None,
) -> None:
    """Give a backend-direct mutation the same on-screen visibility any other
    action already gets, without a browser round trip.

    A BACKEND_DIRECT_ACTION_IDS mutation already knows its true outcome by
    the time this runs -- there is nothing for the browser to execute or
    settle back, unlike a `kind: "action"` directive. This rides the exact
    same turn-boundary `hussh:pending_directive` -> `clientDirective`
    delivery every other directive already uses (adk_live.py), just a kind
    the browser renders as an already-terminal step instead of dispatching
    to a local handler. adk_live.py's settlement-tracking/GC bookkeeping
    must treat this kind as never awaiting a settlement -- there is nothing
    for the browser to report back.

    ``subject`` names who the action was about (a resolved person's display
    name, already joined for speech the same way the spoken message was) so
    the action-result card can show a name, not just the message text.
    ``None`` for actions that never named a specific person -- the card
    still renders, just without a name line.
    """
    payload: dict[str, Any] = {"actionId": action_id, "status": status, "message": message}
    if subject is not None:
        payload["subject"] = subject
    tool_context.state[f"{_STATE_PENDING_DIRECTIVE}:{action_id}:result"] = {
        "kind": "action_result",
        "payload": payload,
    }


def _park_publish_location_envelopes_directive(
    tool_context: ToolContext, shares: list[dict[str, str]]
) -> None:
    """Ask the browser to encrypt-and-publish the live coordinate for grants
    location.share_selected just created backend-direct.

    Coordinates must never reach the backend in plaintext -- this is the one
    step a backend-direct mutation cannot do itself. Deliberately a NEW kind,
    not the `kind: "action"` + delegateAgentId: "agent_location" shape the
    older text-chat specialist pathway already uses for the same underlying
    work (runLocationDirective's publish_share branch): reusing that shape
    here would pull this into adk_live.py's issue()/settlement/GC
    bookkeeping, which only ever applies to `kind == "action"` -- there is
    nothing for the browser to settle back for this one, the grant already
    exists. Payload carries only grantId/recipientKeyId/label per share,
    never a public key: runLocationDirective already refuses to trust one
    from a directive and re-reads it from server state itself.
    """
    tool_context.state[f"{_STATE_PENDING_DIRECTIVE}:location.share_selected:publish"] = {
        "kind": "publish_location_envelopes",
        "payload": {"shares": shares},
    }


def _parse_share_duration(value: Any) -> tuple[float | None, str]:
    """A spoken/slot share duration -> (duration_hours, duration_mode).

    "until_stopped" is the one non-numeric value SHARE_VOICE_DURATION_VALUES
    (page.tsx) accepts -- everything else goes through the same authoritative
    normalize_duration_hours() create_grant itself is built on, rather than
    re-deriving the frontend's own silent clamp.
    """
    raw = str(value or "").strip()
    if raw == UNTIL_STOPPED_LOCATION_SHARE_DURATION_MODE:
        return None, UNTIL_STOPPED_LOCATION_SHARE_DURATION_MODE
    try:
        return normalize_duration_hours(raw), TIMED_LOCATION_SHARE_DURATION_MODE
    except ValueError as exc:
        raise OneLocationAgentError("LOCATION_SHARE_DURATION_INVALID", str(exc)) from exc


def _resolve_named_circle(
    circle_service: OneLocationCircleService, user_id: str, spoken: str
) -> dict[str, Any]:
    """Resolve a spoken circle name against this user's circles, or raise.

    Shared by every backend-direct action that names an existing circle
    (leave/delete/add-to/rename) so "which circle did you mean" reads the
    same way regardless of which of them asked.
    """
    circles: list[dict[str, Any]] = circle_service.list_circles(user_id=user_id)
    match = match_circle_by_name(circles, spoken, lambda c: str(c.get("name") or ""))
    if match.match is None and match.ambiguous:
        names = ", ".join(str(c.get("name") or "") for c in match.ambiguous[:4])
        raise OneLocationCircleError(
            "LOCATION_CIRCLE_AMBIGUOUS",
            f"More than one circle matches that: {names}. Say which one.",
        )
    resolved: dict[str, Any] | None = match.match
    if resolved is None:
        available = ", ".join(str(c.get("name") or "") for c in circles[:6])
        message = (
            f"You do not have a circle by that name. Your circles are: {available}."
            if available
            else "You do not have any circles yet."
        )
        raise OneLocationCircleError("LOCATION_CIRCLE_NOT_FOUND", message)
    return resolved


def _unresolved_people_note(
    unresolved: list[UnresolvedPersonName[Any]], name_of: Callable[[Any], str], noun: str
) -> str:
    """One trailing sentence naming what a multi-person resolution left out.

    Empty string when everyone named resolved. Shared by every backend-direct
    action that now accepts more than one person in a turn -- silently
    dropping "Bob" from "stop sharing with Sarah and Bob" without saying so
    would leave the person thinking Bob was included.
    """
    if not unresolved:
        return ""
    parts: list[str] = []
    for entry in unresolved:
        if entry.kind == "ambiguous":
            names = ambiguous_match_names(entry.matches, name_of)
            parts.append(f'more than one match for "{entry.spoken_text}" ({names})')
        else:
            parts.append(f'no {noun} for "{entry.spoken_text}"')
    return " Could not do this for: " + "; ".join(parts) + "."


def _partial_failure_note(failed_names: list[str]) -> str:
    """One trailing sentence naming who a resolved mutation failed for.

    Distinct from _unresolved_people_note: those people never had a real
    target to act on. These did -- the attempt itself failed partway (a
    transient service error, a stale key, a race with something else that
    changed their state) -- so they need a different sentence, one that
    says try again rather than one that reads like they were never found.
    """
    if not failed_names:
        return ""
    return f" Could not complete this for {join_names_for_speech(failed_names)} -- try again."


def _parse_positive_hours(value: Any, *, default: float) -> float:
    """A spoken/slot duration, or a safe default when absent or nonsense.

    location.send_request has no established voice-side duration floor/accept
    set the way location.share_selected's does (SHARE_VOICE_DURATION_VALUES) --
    deliberately not inventing one here; this only guards against a missing or
    malformed value, matching the frontend's own plain default (page.tsx's
    durationHours state starts at "1").
    """
    try:
        hours = float(str(value))
    except (TypeError, ValueError):
        return default
    return hours if hours > 0 else default


async def _execute_backend_direct_mutation(
    action_id: str, slots: dict[str, Any], user_id: str, tool_context: ToolContext
) -> tuple[str, dict[str, str] | None]:
    """Resolve slots and call the real service function. Raises on failure.

    Returns the sentence the model should say -- computed here, server-side,
    rather than left generic, for the same reason ``_proposal_summary`` in
    the Calendar service composes its own sentence: this is the one place
    that knows exactly what happened -- alongside an optional subject naming
    who the action was about, for the browser's action-result card. ``None``
    for the three circle-only branches, which name a circle, not a person.

    ``tool_context`` is only used by location.share_selected, to park the
    ``publish_location_envelopes`` directive alongside the mutation -- every
    other branch ignores it.
    """
    if action_id in ("location.leave_circle", "location.delete_circle"):
        circle_service = OneLocationCircleService()
        spoken_circle = str(slots.get("circle") or "").strip()
        matched = _resolve_named_circle(circle_service, user_id, spoken_circle)
        circle_name = str(matched.get("name") or "this circle")
        circle_id = str(matched.get("id") or "")
        if action_id == "location.leave_circle":
            circle_service.leave_circle(user_id=user_id, circle_id=circle_id)
            return f"Left {circle_name}.", None
        circle_service.delete_circle(owner_user_id=user_id, circle_id=circle_id)
        return f"Deleted {circle_name}.", None

    if action_id == "location.create_circle":
        circle_service = OneLocationCircleService()
        spoken_name = str(slots.get("name") or "").strip()
        spoken_kind = str(slots.get("kind") or "").strip().lower()
        kind = spoken_kind if spoken_kind in ("family", "friends") else "other"
        # Exact name only, matching the browser handler: a near match must
        # still create the circle that was asked for, not silently reuse an
        # existing one that merely sounds similar.
        existing = circle_service.list_circles(user_id=user_id)
        duplicate = next(
            (
                c
                for c in existing
                if normalize_spoken_name(str(c.get("name") or ""))
                == normalize_spoken_name(spoken_name)
            ),
            None,
        )
        if duplicate is not None:
            return (
                f"You already have a circle called {duplicate.get('name') or spoken_name}.",
                None,
            )
        created = circle_service.create_circle(owner_user_id=user_id, name=spoken_name, kind=kind)
        created_name = str(created.get("name") or spoken_name)
        return f"Created the circle {created_name}. Nobody is in it yet -- say who to add.", None

    if action_id == "location.rename_circle":
        circle_service = OneLocationCircleService()
        spoken_circle = str(slots.get("circle") or "").strip()
        spoken_name = str(slots.get("name") or "").strip()
        matched = _resolve_named_circle(circle_service, user_id, spoken_circle)
        circle_id = str(matched.get("id") or "")
        old_name = str(matched.get("name") or "this circle")
        if normalize_spoken_name(old_name) == normalize_spoken_name(spoken_name):
            return f"{old_name} is already called that.", None
        existing = circle_service.list_circles(user_id=user_id)
        duplicate = next(
            (
                c
                for c in existing
                if str(c.get("id") or "") != circle_id
                and normalize_spoken_name(str(c.get("name") or ""))
                == normalize_spoken_name(spoken_name)
            ),
            None,
        )
        if duplicate is not None:
            raise OneLocationCircleError(
                "LOCATION_CIRCLE_NAME_TAKEN",
                f"You already have a circle called {duplicate.get('name') or spoken_name}. "
                "Pick a different name.",
            )
        renamed = circle_service.update_circle(
            owner_user_id=user_id, circle_id=circle_id, name=spoken_name
        )
        return f"Renamed {old_name} to {renamed.get('name') or spoken_name}.", None

    if action_id == "location.add_to_circle":
        circle_service = OneLocationCircleService()
        spoken_circle = str(slots.get("circle") or "").strip()
        matched = _resolve_named_circle(circle_service, user_id, spoken_circle)
        circle_id = str(matched.get("id") or "")
        circle_name = str(matched.get("name") or "this circle")
        raw_people = str(slots.get("person") or "").strip()
        if not raw_people:
            raise OneLocationCircleError(
                "LOCATION_CIRCLE_INVITE_BATCH_INVALID", "Say who you want to add to the circle."
            )
        eligible = circle_service.list_eligible_direct_connections(
            actor_user_id=user_id, circle_id=circle_id
        )
        resolution = resolve_spoken_names(
            eligible, raw_people, lambda c: str(c.get("displayName") or "")
        )
        if not resolution.resolved:
            ambiguous = next((u for u in resolution.unresolved if u.kind == "ambiguous"), None)
            if ambiguous is not None:
                names = ", ".join(str(c.get("displayName") or "") for c in ambiguous.matches[:4])
                raise OneLocationCircleError(
                    "LOCATION_CIRCLE_INVITE_AMBIGUOUS",
                    f"More than one person matches that name: {names}. Say which one.",
                )
            raise OneLocationCircleError(
                "LOCATION_CIRCLE_INVITE_NOT_FOUND",
                f"Nobody who can be added to {circle_name} matches that name. "
                "They have to be connected to you and not already in it.",
            )
        added = circle_service.create_member_invites(
            actor_user_id=user_id,
            circle_id=circle_id,
            invitee_user_ids=[str(c.get("userId") or "") for c in resolution.resolved],
        )
        added_names = [
            str(c.get("displayName") or "")
            for c in resolution.resolved
            if str(c.get("userId") or "") in set(added.get("addedUserIds") or [])
        ]
        if not added_names:
            added_names = [str(c.get("displayName") or "") for c in resolution.resolved]
        return (
            f"Added {join_names_for_speech(added_names)} to {circle_name}.",
            {"name": join_names_for_speech(added_names)},
        )

    if action_id in ("location.stop_share", "location.approve_request", "location.decline_request"):
        agent_service = OneLocationAgentService()
        raw_people = str(slots.get("person") or "").strip()
        if action_id == "location.stop_share":
            candidates = agent_service.list_active_owner_grants(owner_user_id=user_id)
            name_of = lambda g: str(g.get("recipientDisplayName") or "")  # noqa: E731
            resolution = resolve_spoken_names(candidates, raw_people, name_of)
            if not resolution.resolved:
                ambiguous = next((u for u in resolution.unresolved if u.kind == "ambiguous"), None)
                if ambiguous is not None:
                    names = ambiguous_match_names(ambiguous.matches, name_of)
                    raise OneLocationAgentError(
                        "LOCATION_GRANT_AMBIGUOUS",
                        f'More than one active share matches "{ambiguous.spoken_text}": {names}. '
                        "Say which one.",
                    )
                raise OneLocationAgentError(
                    "LOCATION_GRANT_NOT_FOUND",
                    "Nobody currently has your location shared with that name.",
                )
            stopped_names: list[str] = []
            failed_names: list[str] = []
            for grant in resolution.resolved:
                grant_name = str(grant.get("recipientDisplayName") or "them")
                try:
                    agent_service.revoke_grant(
                        owner_user_id=user_id, grant_id=str(grant.get("id") or "")
                    )
                except Exception:  # noqa: BLE001 - one failure must not lose or hide the rest
                    logger.exception("one_adk_backend_direct_partial_failure action=%s", action_id)
                    failed_names.append(grant_name)
                    continue
                stopped_names.append(grant_name)
            if not stopped_names:
                raise OneLocationAgentError(
                    "LOCATION_GRANT_STOP_FAILED",
                    f"Could not stop sharing with {join_names_for_speech(failed_names)}. "
                    "Try again in a moment.",
                )
            note = _unresolved_people_note(
                resolution.unresolved, name_of, "active share"
            ) + _partial_failure_note(failed_names)
            return (
                f"Stopped sharing your location with {join_names_for_speech(stopped_names)}.{note}",
                {"name": join_names_for_speech(stopped_names)},
            )

        candidates = agent_service.list_pending_owner_requests(owner_user_id=user_id)
        name_of = lambda r: str(r.get("requesterDisplayName") or "")  # noqa: E731
        resolution = resolve_spoken_names(candidates, raw_people, name_of)
        if not resolution.resolved:
            ambiguous = next((u for u in resolution.unresolved if u.kind == "ambiguous"), None)
            if ambiguous is not None:
                names = ambiguous_match_names(ambiguous.matches, name_of)
                raise OneLocationAgentError(
                    "LOCATION_REQUEST_AMBIGUOUS",
                    f'More than one request matches "{ambiguous.spoken_text}": {names}. '
                    "Say which one.",
                )
            raise OneLocationAgentError(
                "LOCATION_REQUEST_NOT_FOUND", "Nobody is waiting on your decision with that name."
            )
        settled_names: list[str] = []
        failed_names = []
        for request in resolution.resolved:
            request_name = str(request.get("requesterDisplayName") or "their")
            request_id = str(request.get("id") or "")
            try:
                if action_id == "location.approve_request":
                    agent_service.approve_request(
                        owner_user_id=user_id,
                        request_id=request_id,
                        approval_mode="manual",
                        duration_hours=None,
                        duration_mode=None,
                    )
                else:
                    agent_service.deny_request(owner_user_id=user_id, request_id=request_id)
            except Exception:  # noqa: BLE001 - one failure must not lose or hide the rest
                logger.exception("one_adk_backend_direct_partial_failure action=%s", action_id)
                failed_names.append(request_name)
                continue
            settled_names.append(request_name)
        verb = "Approved" if action_id == "location.approve_request" else "Declined"
        if not settled_names:
            raise OneLocationAgentError(
                "LOCATION_REQUEST_SETTLE_FAILED",
                f"Could not settle {join_names_for_speech(failed_names)}'s request. "
                "Try again in a moment.",
            )
        note = _unresolved_people_note(
            resolution.unresolved, name_of, "request"
        ) + _partial_failure_note(failed_names)
        return (
            f"{verb} {join_names_for_speech(settled_names)}'s request.{note}",
            {"name": join_names_for_speech(settled_names)},
        )

    if action_id == "location.share_selected":
        agent_service = OneLocationAgentService()
        raw_people = str(slots.get("person") or "").strip()
        candidates = agent_service.list_verified_recipients(owner_user_id=user_id)
        name_of = lambda c: str(c.get("displayName") or "")  # noqa: E731
        resolution = resolve_spoken_names(candidates, raw_people, name_of)
        if not resolution.resolved:
            ambiguous = next((u for u in resolution.unresolved if u.kind == "ambiguous"), None)
            if ambiguous is not None:
                names = ambiguous_match_names(ambiguous.matches, name_of)
                raise OneLocationAgentError(
                    "LOCATION_SHARE_TARGET_AMBIGUOUS",
                    f'More than one connection matches "{ambiguous.spoken_text}": {names}. '
                    "Say which one.",
                )
            raise OneLocationAgentError(
                "LOCATION_SHARE_TARGET_NOT_FOUND",
                f"{raw_people or 'That person'} is not one of your connections.",
            )
        duration_hours, duration_mode = _parse_share_duration(slots.get("duration_hours"))
        shared_names: list[str] = []
        shares: list[dict[str, str]] = []
        failed_names = []
        for recipient in resolution.resolved:
            recipient_name = str(recipient.get("displayName") or "them")
            try:
                grant = agent_service.create_grant(
                    owner_user_id=user_id,
                    recipient_user_id=str(recipient.get("userId") or ""),
                    recipient_key_id=(str(recipient.get("keyId") or "") or None),
                    duration_hours=duration_hours,
                    duration_mode=duration_mode,
                    enforce_connection=True,
                )
            except Exception:  # noqa: BLE001 - one failure must not lose or hide the rest
                # A recipient refused mid-batch (a stale key, a transient DB
                # error, ...) must never cost the recipients before them
                # their already-created grant, and must never leave a grant
                # that DID get created here without its publish directive --
                # both loop bodies below run only over what actually
                # succeeded, never over the raw resolved list.
                logger.exception("one_adk_backend_direct_partial_failure action=%s", action_id)
                failed_names.append(recipient_name)
                continue
            shared_names.append(recipient_name)
            # No public key in this payload -- runLocationDirective re-reads
            # it from server state itself rather than trusting a directive a
            # model produced. Grants with no key yet still publish nothing
            # (runLocationDirective's own "hasn't set up location sharing
            # yet" refusal already covers that gap) -- unaffected here.
            shares.append(
                {
                    "grantId": str(grant.get("id") or ""),
                    "recipientKeyId": str(recipient.get("keyId") or ""),
                    "recipientUserId": str(recipient.get("userId") or ""),
                    "label": recipient_name,
                }
            )
        if not shared_names:
            raise OneLocationAgentError(
                "LOCATION_SHARE_FAILED",
                f"Could not share your location with {join_names_for_speech(failed_names)}. "
                "Try again in a moment.",
            )
        # Fires for whatever grants DID get created, even when a later
        # recipient in the same batch failed -- an already-created grant
        # with no publish directive is a recipient permanently stuck on
        # "waiting for location," which is worse than the grant not
        # existing at all.
        _park_publish_location_envelopes_directive(tool_context, shares)
        note = _unresolved_people_note(
            resolution.unresolved, name_of, "connection"
        ) + _partial_failure_note(failed_names)
        # Reports success as soon as the grant exists -- the client-side
        # encrypt-and-publish step this directive triggers is real async work
        # a backend-direct call cannot await. If it later fails, the grant
        # still exists (recipient sees "waiting for location"), which is
        # already today's product state for that gap, not a new one.
        return (
            f"Shared your location with {join_names_for_speech(shared_names)}.{note}",
            {"name": join_names_for_speech(shared_names)},
        )

    if action_id == "location.send_request":
        agent_service = OneLocationAgentService()
        raw_people = str(slots.get("person") or "").strip()
        # Same pool share_selected resolves recipients against -- the
        # browser's own select_ask_recipient handler asks and shares from
        # "the identical pool of people" (page.tsx's own comment), so voice
        # answers the same question the same way regardless of direction.
        candidates = agent_service.list_verified_recipients(owner_user_id=user_id)
        name_of = lambda c: str(c.get("displayName") or "")  # noqa: E731
        resolution = resolve_spoken_names(candidates, raw_people, name_of)
        if not resolution.resolved:
            ambiguous = next((u for u in resolution.unresolved if u.kind == "ambiguous"), None)
            if ambiguous is not None:
                names = ambiguous_match_names(ambiguous.matches, name_of)
                raise OneLocationAgentError(
                    "LOCATION_REQUEST_TARGET_AMBIGUOUS",
                    f'More than one connection matches "{ambiguous.spoken_text}": {names}. '
                    "Say which one.",
                )
            raise OneLocationAgentError(
                "LOCATION_REQUEST_TARGET_NOT_FOUND",
                f"{raw_people or 'That person'} is not one of your connections.",
            )
        duration_hours = _parse_positive_hours(slots.get("duration_hours"), default=1.0)
        asked_names: list[str] = []
        failed_names = []
        for target in resolution.resolved:
            target_name = str(target.get("displayName") or "them")
            try:
                agent_service.request_access(
                    requester_user_id=user_id,
                    owner_user_id=str(target.get("userId") or ""),
                    requested_duration_hours=duration_hours,
                    requested_duration_mode="timed",
                )
            except Exception:  # noqa: BLE001 - one failure must not lose or hide the rest
                logger.exception("one_adk_backend_direct_partial_failure action=%s", action_id)
                failed_names.append(target_name)
                continue
            asked_names.append(target_name)
        if not asked_names:
            raise OneLocationAgentError(
                "LOCATION_REQUEST_SEND_FAILED",
                f"Could not ask {join_names_for_speech(failed_names)} for their location. "
                "Try again in a moment.",
            )
        note = _unresolved_people_note(
            resolution.unresolved, name_of, "connection"
        ) + _partial_failure_note(failed_names)
        return (
            f"Asked {join_names_for_speech(asked_names)} for their location.{note}",
            {"name": join_names_for_speech(asked_names)},
        )

    if action_id in (
        "connect.remove_connection",
        "connect.cancel_request",
        "connect.send_request",
        "connect.accept_request",
        "connect.reject_request",
    ):
        connections_service = ConnectionsService()
        raw_people = str(slots.get("person") or "").strip()
        if action_id == "connect.send_request":
            if not raw_people:
                raise ConnectionsError(
                    "CONNECTION_REQUEST_PERSON_REQUIRED", "Say who you want to connect with."
                )

            def _directory_name(c: dict[str, Any]) -> str:
                return str(c.get("displayName") or "")

            # Voice never chose scopes for a request before -- the tap flow's
            # own dialog is where that choice normally lives, and skipping it
            # must never be silent. This is the one opt-in exception: reuse
            # exactly what THIS recipient was already asked/offered last time,
            # never a guess extrapolated from someone else or a first request.
            # Read lazily, once, only if a request actually reaches the point
            # of being created -- every earlier outcome (ambiguous, not
            # found, already connected) never needs this preference at all.
            reuse_last_scopes: bool | None = None

            def _reuse_last_scopes() -> bool:
                nonlocal reuse_last_scopes
                if reuse_last_scopes is None:
                    reuse_last_scopes = bool(
                        connections_service.get_voice_preferences(user_id=user_id).get(
                            "shareScopesFromLastRequest"
                        )
                    )
                return reuse_last_scopes

            sent_names: list[str] = []
            already_connected_names: list[str] = []
            blocked_notes: list[str] = []
            not_found_names: list[str] = []
            ambiguous_entry: tuple[str, list[dict[str, Any]]] | None = None

            for spoken_name in split_spoken_names(raw_people):
                search_term = max(spoken_name.split() or [spoken_name], key=len)
                directory_candidates: list[dict[str, Any]] = []
                page = 1
                while page <= _DIRECTORY_RESOLVE_MAX_PAGES:
                    result = connections_service.search_directory(
                        user_id, query=search_term, page=page, limit=_DIRECTORY_RESOLVE_PAGE_SIZE
                    )
                    directory_candidates.extend(result.get("items") or [])
                    if not result.get("hasMore"):
                        break
                    page += 1
                matches = match_by_name(directory_candidates, spoken_name, _directory_name)
                if not matches:
                    not_found_names.append(spoken_name)
                    continue
                if len(matches) > 1:
                    if ambiguous_entry is None:
                        ambiguous_entry = (spoken_name, matches)
                    continue
                person = matches[0]
                display_name = _directory_name(person) or spoken_name
                relationship = str(person.get("relationship") or "none")
                # The backend already distinguishes these four states; asking
                # to connect with someone already connected is success (the
                # thing they wanted is already true), not a refusal.
                if relationship == "connected":
                    already_connected_names.append(display_name)
                elif relationship == "pending_outgoing":
                    blocked_notes.append(f"already asked {display_name}, waiting on them")
                elif relationship == "pending_incoming":
                    blocked_notes.append(
                        f"{display_name} already asked you -- call connect.accept_request "
                        "for them instead, once the person confirms"
                    )
                elif relationship != "none":
                    blocked_notes.append(f"a new request isn't available for {display_name}")
                else:
                    addressee_user_id = str(person.get("userId") or "")
                    requested_scope_handles: list[str] | None = None
                    offered_scope_handles: list[str] | None = None
                    if _reuse_last_scopes():
                        last_scopes = connections_service.get_last_request_scope_handles(
                            requester_user_id=user_id,
                            addressee_user_id=addressee_user_id,
                        )
                        requested_scope_handles = last_scopes["requestedScopeHandles"] or None
                        offered_scope_handles = last_scopes["offeredScopeHandles"] or None
                    try:
                        connections_service.create_request(
                            user_id,
                            addressee_user_id=addressee_user_id,
                            requested_scope_handles=requested_scope_handles,
                            offered_scope_handles=offered_scope_handles,
                        )
                    except Exception:  # noqa: BLE001 - one failure must not lose or hide the rest
                        # A transient failure sending to person 2 of 3 must
                        # never abort the loop and lose whatever already
                        # sent to person 1 -- the same reasoning every other
                        # multi-person branch in this function follows.
                        logger.exception(
                            "one_adk_backend_direct_partial_failure action=%s", action_id
                        )
                        blocked_notes.append(f"could not send to {display_name}, try again")
                        continue
                    sent_names.append(display_name)

            if not sent_names and not already_connected_names:
                if ambiguous_entry is not None:
                    spoken_name, matches = ambiguous_entry
                    names = ambiguous_match_names(matches, _directory_name)
                    raise ConnectionsError(
                        "CONNECTION_REQUEST_AMBIGUOUS",
                        f'More than one person matches "{spoken_name}": {names}. Say which one.',
                    )
                if blocked_notes:
                    raise ConnectionsError(
                        "CONNECTION_REQUEST_BLOCKED", "; ".join(blocked_notes).capitalize() + "."
                    )
                raise ConnectionsError(
                    "CONNECTION_REQUEST_NOT_FOUND",
                    f"I could not find {join_names_for_speech(not_found_names) or 'that person'} "
                    "in Connect.",
                )

            parts: list[str] = []
            if sent_names:
                parts.append(f"Sent a connection request to {join_names_for_speech(sent_names)}.")
            if already_connected_names:
                parts.append(
                    f"Already connected to {join_names_for_speech(already_connected_names)}, "
                    "so nothing to send there."
                )
            extra = list(blocked_notes)
            if not_found_names:
                extra.append(f"could not find {join_names_for_speech(not_found_names)}")
            if ambiguous_entry is not None:
                spoken_name, matches = ambiguous_entry
                names = ambiguous_match_names(matches, _directory_name)
                extra.append(f'more than one match for "{spoken_name}" ({names})')
            if extra:
                parts.append("Also: " + "; ".join(extra) + ".")
            # sent_names/already_connected_names cannot both be empty here --
            # the earlier guard already raised if neither had anything in it.
            subject_names = sent_names + already_connected_names
            return " ".join(parts), {"name": join_names_for_speech(subject_names)}

        if action_id == "connect.remove_connection":
            connections = connections_service.list_connections(user_id=user_id)
            name_of = lambda c: str(c.get("displayName") or "")  # noqa: E731
            resolution = resolve_spoken_names(connections, raw_people, name_of)
            if not resolution.resolved:
                ambiguous = next((u for u in resolution.unresolved if u.kind == "ambiguous"), None)
                if ambiguous is not None:
                    names = ambiguous_match_names(ambiguous.matches, name_of)
                    raise ConnectionsError(
                        "CONNECTION_AMBIGUOUS",
                        f'More than one connection matches "{ambiguous.spoken_text}": {names}. '
                        "Say which one.",
                    )
                raise ConnectionsError(
                    "CONNECTION_NOT_FOUND",
                    f"{raw_people or 'That person'} is not one of your connections.",
                )
            display_names = [
                str(c.get("displayName") or "this person") for c in resolution.resolved
            ]
            confirmed = bool(slots.get("confirmed") is True)
            if not confirmed:
                raise _BackendDirectConfirmationNeeded(
                    f"Ask: remove your connection{'s' if len(display_names) > 1 else ''} with "
                    f"{join_names_for_speech(display_names)}? Only call this action again with "
                    "confirmed set to true after they say yes -- do not assume, and do not ask twice."
                )
            removed_names: list[str] = []
            failed_names = []
            for connection in resolution.resolved:
                connection_name = str(connection.get("displayName") or "this person")
                try:
                    connections_service.remove_connection(
                        user_id=user_id, connection_id=str(connection.get("connectionId") or "")
                    )
                except Exception:  # noqa: BLE001 - one failure must not lose or hide the rest
                    logger.exception("one_adk_backend_direct_partial_failure action=%s", action_id)
                    failed_names.append(connection_name)
                    continue
                removed_names.append(connection_name)
            if not removed_names:
                raise ConnectionsError(
                    "CONNECTION_REMOVE_FAILED",
                    f"Could not remove {join_names_for_speech(failed_names)}. "
                    "Try again in a moment.",
                )
            note = _unresolved_people_note(
                resolution.unresolved, name_of, "connection"
            ) + _partial_failure_note(failed_names)
            return (
                f"Removed {join_names_for_speech(removed_names)}. They can no longer be picked "
                f"for location sharing.{note}",
                {"name": join_names_for_speech(removed_names)},
            )

        if action_id == "connect.cancel_request":
            # cancel_request's real target is the pending CONNECTION REQUEST,
            # not the connection graph -- but ConnectionsService.cancel_request()
            # already accepts the counterpart's user id as a fallback when no
            # request id resolves, so matching against connections here would
            # silently answer the wrong question (only settled connections,
            # never pending outgoing asks). List outgoing requests instead.
            outgoing = connections_service.list_requests(user_id=user_id, direction="outgoing")
            name_of = lambda r: str(r.get("counterpartDisplayName") or "")  # noqa: E731
            resolution = resolve_spoken_names(outgoing, raw_people, name_of)
            if not resolution.resolved:
                ambiguous = next((u for u in resolution.unresolved if u.kind == "ambiguous"), None)
                if ambiguous is not None:
                    names = ambiguous_match_names(ambiguous.matches, name_of)
                    raise ConnectionsError(
                        "CONNECTION_REQUEST_AMBIGUOUS",
                        f'More than one pending request matches "{ambiguous.spoken_text}": '
                        f"{names}. Say which one.",
                    )
                raise ConnectionsError(
                    "CONNECTION_REQUEST_NOT_FOUND",
                    f"You have no pending request to {raw_people or 'that person'}.",
                )
            cancelled_names: list[str] = []
            failed_names = []
            for request in resolution.resolved:
                request_name = str(request.get("counterpartDisplayName") or "that person")
                try:
                    connections_service.cancel_request(
                        user_id=user_id, request_id=str(request.get("id") or "")
                    )
                except Exception:  # noqa: BLE001 - one failure must not lose or hide the rest
                    logger.exception("one_adk_backend_direct_partial_failure action=%s", action_id)
                    failed_names.append(request_name)
                    continue
                cancelled_names.append(request_name)
            if not cancelled_names:
                raise ConnectionsError(
                    "CONNECTION_REQUEST_CANCEL_FAILED",
                    f"Could not cancel your request to {join_names_for_speech(failed_names)}. "
                    "Try again in a moment.",
                )
            note = _unresolved_people_note(
                resolution.unresolved, name_of, "pending request"
            ) + _partial_failure_note(failed_names)
            return (
                f"Cancelled your connection request to "
                f"{join_names_for_speech(cancelled_names)}.{note}",
                {"name": join_names_for_speech(cancelled_names)},
            )

        # connect.accept_request / connect.reject_request: the pending
        # request lives in the INCOMING direction from this user's side --
        # the same reasoning as cancel_request's own comment above applies
        # here too, matching against settled connections would silently
        # answer the wrong question for a request that has not been
        # accepted yet.
        incoming = connections_service.list_requests(user_id=user_id, direction="incoming")
        name_of = lambda r: str(r.get("counterpartDisplayName") or "")  # noqa: E731
        resolution = resolve_spoken_names(incoming, raw_people, name_of)
        if not resolution.resolved:
            ambiguous = next((u for u in resolution.unresolved if u.kind == "ambiguous"), None)
            if ambiguous is not None:
                names = ambiguous_match_names(ambiguous.matches, name_of)
                raise ConnectionsError(
                    "CONNECTION_REQUEST_AMBIGUOUS",
                    f'More than one pending request matches "{ambiguous.spoken_text}": {names}. '
                    "Say which one.",
                )
            raise ConnectionsError(
                "CONNECTION_REQUEST_NOT_FOUND",
                f"You have no pending request from {raw_people or 'that person'}.",
            )
        settled_names = []
        failed_names = []
        for request in resolution.resolved:
            request_name = str(request.get("counterpartDisplayName") or "that person")
            try:
                if action_id == "connect.accept_request":
                    # No scope selection here -- voice never chose one, the
                    # same reasoning send_request's own scope-reuse toggle
                    # documents. accept_request already accepts None for
                    # both and settles with none selected either way.
                    connections_service.accept_request(
                        user_id=user_id, request_id=str(request.get("id") or "")
                    )
                else:
                    connections_service.reject_request(
                        user_id=user_id, request_id=str(request.get("id") or "")
                    )
            except Exception:  # noqa: BLE001 - one failure must not lose or hide the rest
                logger.exception("one_adk_backend_direct_partial_failure action=%s", action_id)
                failed_names.append(request_name)
                continue
            settled_names.append(request_name)
        if not settled_names:
            verb = "accept" if action_id == "connect.accept_request" else "decline"
            raise ConnectionsError(
                "CONNECTION_REQUEST_RESOLVE_FAILED",
                f"Could not {verb} the request from {join_names_for_speech(failed_names)}. "
                "Try again in a moment.",
            )
        note = _unresolved_people_note(
            resolution.unresolved, name_of, "pending request"
        ) + _partial_failure_note(failed_names)
        if action_id == "connect.accept_request":
            message = (
                f"Accepted {join_names_for_speech(settled_names)}'s connection request. "
                f"You're connected now.{note}"
            )
        else:
            message = f"Declined {join_names_for_speech(settled_names)}'s connection request.{note}"
        return message, {"name": join_names_for_speech(settled_names)}

    if action_id == "location.checkout_nearby":
        # No coordinates, no place, nothing client-only -- checking out only
        # ever clears the caller's own presence row. No subject: this action
        # never names a person or a place.
        OneLocationNearbyPresenceService().checkout(user_id=user_id)
        return "Checked you out. You're no longer visible to people nearby.", None

    if action_id in BACKEND_DIRECT_VERBAL_CONFIRMATION_IDS:
        return await _execute_consent_lifecycle_action(action_id, slots, user_id, tool_context)

    raise AssertionError(f"{action_id} is in BACKEND_DIRECT_ACTION_IDS with no execution branch")


async def _read_tool_result(label: str, key: str, call: Callable[[], Any]) -> dict[str, Any]:
    """Run a read tool's service call and shape the result the same way every
    read tool already does: ``{"status": "ok", <key>: <value>}`` on success,
    or the same clean failed-status dict ``_run_backend_direct_action``
    already gives every mutation, on a raised error.

    A DB hiccup (or any other unexpected exception) escaping a tool call
    crashes the whole live session outright -- Gemini Live's tool-response
    serialization has no error boundary of its own around a raised Python
    exception, so one escaping here is indistinguishable, from the model's
    side, from the process dying mid-turn. ``call`` is a zero-arg wrapper
    around the actual (synchronous) service call.
    """
    try:
        value = call()
    except _BackendDirectError as exc:
        logger.info("one_adk_read_tool_failed label=%s reason=%s", label, exc.code)
        return {"status": "failed", "message": exc.message}
    except Exception:  # noqa: BLE001 - the model must be told something failed, not why internally
        logger.exception("one_adk_read_tool_failed label=%s reason=unexpected", label)
        return {
            "status": "failed",
            "message": f"Could not check {label} right now. Try again in a moment.",
        }
    return {"status": "ok", key: value}


async def _read_tool_user_id(tool_context: ToolContext) -> tuple[str | None, dict[str, Any] | None]:
    """Shared auth gate for the backend-direct read tools below.

    Same re-validated check the backend-direct mutations use
    (``_verify_backend_direct_authorization``) -- these tools return
    consent-scoped personal and location data, so they get the real
    VAULT_OWNER re-validation, not a lighter signed-in-only check.
    """
    authorized, user_id, reason = await _verify_backend_direct_authorization(tool_context)
    if not authorized:
        return None, {"status": "blocked", "message": reason}
    return user_id, None


def _publish_tool_trace(
    tool_context: ToolContext, tool_name: str, *, kind: str, payload: dict[str, Any]
) -> None:
    """Park a read tool's display-safe result for the relay to forward to the
    browser alongside the spoken answer, so the app can render a card in sync
    with the readout (#6434).

    Only ever park what is already safe to speak -- never the raw service
    result. Optional: a read tool that returns nothing worth a visual (an
    empty list, no data yet) should simply not call this, not call it with an
    empty payload.
    """
    tool_context.state[f"{_STATE_PENDING_TOOL_TRACE}:{tool_name}"] = {
        "kind": kind,
        "payload": payload,
    }


def _trace_list_rows(
    rows: list[dict[str, Any]],
    *,
    id_key: str,
    name_key: str,
    photo_key: str | None = None,
    detail_fn: Callable[[dict[str, Any]], str | None] | None = None,
) -> list[dict[str, Any]]:
    """Reduce a raw service row list to the card-safe {id, name, detail,
    photoUrl} shape every list-shaped voice card renders -- never the raw
    row (key material, capability scopes, unmasked contact info, etc). A row
    with no usable id is dropped rather than shown with a broken React key.
    """
    items = [
        {
            "id": str(row.get(id_key) or ""),
            "name": str(row.get(name_key) or "").strip() or "Hussh member",
            "detail": detail_fn(row) if detail_fn else None,
            "photoUrl": (str(row.get(photo_key)) if photo_key and row.get(photo_key) else None),
        }
        for row in rows
    ]
    return [item for item in items if item["id"]]


def _publish_list_trace(
    tool_context: ToolContext,
    tool_name: str,
    *,
    kind: Literal["people_list", "circles_list"],
    heading: str,
    items: list[dict[str, Any]],
) -> None:
    """`_publish_tool_trace`, specialized for the list-shaped card -- parks
    nothing when there is nothing to show (an empty list is not a card).
    """
    if not items:
        return
    _publish_tool_trace(
        tool_context, tool_name, kind=kind, payload={"heading": heading, "items": items}
    )


async def list_my_location_circles(tool_context: ToolContext) -> dict[str, Any]:
    """List the person's own Location circles: name, kind, and role in each.

    Reads live from the backend, not from whatever the current screen has
    published -- safe to call from anywhere, any time.
    """
    user_id, blocked = await _read_tool_user_id(tool_context)
    if blocked is not None:
        return blocked
    if user_id is None:
        raise AssertionError("_read_tool_user_id returned no user_id with blocked=None")
    result = await _read_tool_result(
        "your circles", "circles", lambda: OneLocationCircleService().list_circles(user_id=user_id)
    )
    if result.get("status") == "ok":

        def _circle_detail(row: dict[str, Any]) -> str:
            count = int(row.get("memberCount") or 0)
            noun = "member" if count == 1 else "members"
            role = str(row.get("role") or "member").capitalize()
            return f"{count} {noun} · {role}"

        items = _trace_list_rows(
            result.get("circles") or [], id_key="id", name_key="name", detail_fn=_circle_detail
        )
        _publish_list_trace(
            tool_context,
            "list_my_location_circles",
            kind="circles_list",
            heading="Your circles",
            items=items,
        )
    return result


async def list_my_location_shares(tool_context: ToolContext) -> dict[str, Any]:
    """List who the person is currently sharing their live location with."""
    user_id, blocked = await _read_tool_user_id(tool_context)
    if blocked is not None:
        return blocked
    if user_id is None:
        raise AssertionError("_read_tool_user_id returned no user_id with blocked=None")
    result = await _read_tool_result(
        "your location shares",
        "shares",
        lambda: OneLocationAgentService().list_active_owner_grants(owner_user_id=user_id),
    )
    if result.get("status") == "ok":
        items = _trace_list_rows(
            result.get("shares") or [],
            id_key="recipientUserId",
            name_key="recipientDisplayName",
            photo_key="recipientPhotoUrl",
            detail_fn=lambda row: row.get("recipientMaskedPhone") or None,
        )
        _publish_list_trace(
            tool_context,
            "list_my_location_shares",
            kind="people_list",
            heading="Sharing your location with",
            items=items,
        )
    return result


async def list_location_shared_with_me(tool_context: ToolContext) -> dict[str, Any]:
    """List who is currently sharing their live location with this person."""
    user_id, blocked = await _read_tool_user_id(tool_context)
    if blocked is not None:
        return blocked
    if user_id is None:
        raise AssertionError("_read_tool_user_id returned no user_id with blocked=None")
    result = await _read_tool_result(
        "who's sharing with you",
        "shares",
        lambda: OneLocationAgentService().list_active_recipient_grants(recipient_user_id=user_id),
    )
    if result.get("status") == "ok":
        items = _trace_list_rows(
            result.get("shares") or [],
            id_key="ownerUserId",
            name_key="ownerDisplayName",
            photo_key="ownerPhotoUrl",
            detail_fn=lambda row: row.get("ownerMaskedPhone") or None,
        )
        _publish_list_trace(
            tool_context,
            "list_location_shared_with_me",
            kind="people_list",
            heading="Sharing their location with you",
            items=items,
        )
    return result


async def list_pending_location_requests(tool_context: ToolContext) -> dict[str, Any]:
    """List location access requests waiting on this person's approve/decline."""
    user_id, blocked = await _read_tool_user_id(tool_context)
    if blocked is not None:
        return blocked
    if user_id is None:
        raise AssertionError("_read_tool_user_id returned no user_id with blocked=None")
    result = await _read_tool_result(
        "your pending location requests",
        "requests",
        lambda: OneLocationAgentService().list_pending_owner_requests(owner_user_id=user_id),
    )
    if result.get("status") == "ok":
        items = _trace_list_rows(
            result.get("requests") or [],
            id_key="requesterUserId",
            name_key="requesterDisplayName",
            photo_key="requesterPhotoUrl",
            detail_fn=lambda row: row.get("requesterMaskedPhone") or None,
        )
        _publish_list_trace(
            tool_context,
            "list_pending_location_requests",
            kind="people_list",
            heading="Location requests waiting on you",
            items=items,
        )
    return result


def _connections_trace_people(connections: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Reduce a raw connections row list to the card-safe fields -- the same
    name+masked-email shape disambiguation candidates already show over
    voice, never the raw row (public key material, unmasked email, etc).
    """
    people = []
    for row in connections:
        email = row.get("email")
        people.append(
            {
                "id": str(row.get("connectionId") or row.get("userId") or ""),
                "name": str(row.get("displayName") or "").strip() or "Hussh member",
                "detail": mask_email(str(email)) if email else None,
                "photoUrl": row.get("photoUrl") or None,
            }
        )
    return [p for p in people if p["id"]]


async def list_my_connections(tool_context: ToolContext) -> dict[str, Any]:
    """List the person's Connect connections."""
    user_id, blocked = await _read_tool_user_id(tool_context)
    if blocked is not None:
        return blocked
    if user_id is None:
        raise AssertionError("_read_tool_user_id returned no user_id with blocked=None")
    result = await _read_tool_result(
        "your connections",
        "connections",
        lambda: ConnectionsService().list_connections(user_id=user_id),
    )
    if result.get("status") == "ok":
        people = _connections_trace_people(result.get("connections") or [])
        _publish_list_trace(
            tool_context,
            "list_my_connections",
            kind="people_list",
            heading="Your connections",
            items=people,
        )
    return result


# Domains this tool will never read back over voice, even though they are
# real PKM domains: runtime_secrets is BYOK model credential material, not
# personal information -- there is no phrasing of "what do you know about my
# X" that should ever resolve to it. Kept separate from the general domain
# registry rather than filtered ad hoc, so a new sensitive domain has one
# obvious place to be added.
_VOICE_UNREADABLE_PKM_DOMAINS = frozenset({"runtime_secrets"})

_PKM_READABLE_DOMAIN_KEYS = tuple(
    entry.domain_key
    for entry in CANONICAL_DOMAIN_REGISTRY
    if entry.domain_key not in _VOICE_UNREADABLE_PKM_DOMAINS
)


async def read_my_pkm_domain_summary(domain: str, tool_context: ToolContext) -> dict[str, Any]:
    """Read the person's own redacted PKM summary for one domain and report it.

    Covers every general information domain (financial, health, travel,
    subscriptions, professional, identity, and the rest of the canonical PKM
    registry) through one tool rather than one per domain, since they are all
    read the same way -- the discovery-only index, never decrypted holdings.
    Live app data with its own service (Connect's actual connections list,
    Location's circles) is deliberately out of scope here; use the
    dedicated read tools for those instead.

    The summary is whatever sanitized, non-sensitive metadata
    update_domain_summary() has accumulated for that domain -- it may be
    partial or empty even when the domain itself exists.
    """
    user_id, blocked = await _read_tool_user_id(tool_context)
    if blocked is not None:
        return blocked
    if user_id is None:
        raise AssertionError("_read_tool_user_id returned no user_id with blocked=None")

    requested = normalize_domain_key(domain)
    if requested not in _PKM_READABLE_DOMAIN_KEYS:
        return {
            "status": "failed",
            "message": (
                f'"{domain}" is not a domain I can read. Available domains: '
                + ", ".join(_PKM_READABLE_DOMAIN_KEYS)
                + "."
            ),
        }

    label = (
        get_canonical_domain_metadata(requested).display_name
        if get_canonical_domain_metadata(requested)
        else requested
    )
    # Not _read_tool_result: that helper's `call` is a zero-arg wrapper around
    # a *synchronous* service call (every existing read tool's service method
    # is sync), but get_index_v2 is genuinely async. Same shape and same
    # failure-boundary reasoning as _read_tool_result -- an exception must
    # never escape a live-session tool call -- just awaited instead of called.
    try:
        index = await get_pkm_service().get_index_v2(user_id)
    except Exception:  # noqa: BLE001 - the model must be told something failed, not why internally
        logger.exception("one_adk_read_tool_failed label=%s reason=unexpected", label)
        return {
            "status": "failed",
            "message": f"Could not check {label} right now. Try again in a moment.",
        }
    available = list(index.available_domains) if index else []
    if requested not in available:
        return {"status": "ok", "result": {"has_data": False, "domain": requested, "summary": {}}}
    summary = (index.domain_summaries or {}).get(requested) or {}
    if summary:
        # Only when there is something to show -- an empty summary dict would
        # otherwise render as a blank card while the spoken answer already
        # says "nothing on record yet".
        _publish_tool_trace(
            tool_context,
            "read_my_pkm_domain_summary",
            kind="pkm_domain_summary",
            payload={"domain": requested, "label": label, "summary": dict(summary)},
        )
    return {
        "status": "ok",
        "result": {"has_data": True, "domain": requested, "summary": dict(summary)},
    }


async def discover_person_information(
    person: str,
    tool_context: ToolContext,
    domain: str = "",
) -> dict[str, Any]:
    """Resolve a connected person and list the exact information they expose for requests.

    This is discovery only. It returns opaque ``scopeRef`` values and a public
    profile route; it never creates consent, exposes raw ``attr.*`` scopes, or
    reads a granted value. The profile review surface remains the sole place
    where the requester selects fields and confirms a request.
    """
    user_id, blocked = await _read_tool_user_id(tool_context)
    if blocked is not None:
        return blocked
    if user_id is None:
        raise AssertionError("_read_tool_user_id returned no user_id with blocked=None")

    try:
        try:
            person_ref, resolved_name = _resolve_person_for_information(
                ConnectionsService(), user_id, person
            )
        except ConsentLifecycleError as exc:
            status = {
                "PERSON_AMBIGUOUS": "needs_clarification",
                "PERSON_NOT_FOUND": "not_found",
                "PERSON_PROFILE_NOT_READY": "unavailable",
                "PERSON_REQUIRED": "needs_clarification",
            }.get(exc.code, "failed")
            return {"status": status, "message": exc.message}
        connection = {"displayName": resolved_name}
        profile = await PersonProfileService().get_viewer_profile(
            viewer_user_id=user_id,
            public_person_ref=person_ref,
        )
        requested_domain = normalize_spoken_name(domain)
        scopes = []
        for item in profile.get("requestableScopes") or []:
            item_domain = str(item.get("domain") or "").strip()
            if requested_domain and requested_domain not in normalize_spoken_name(item_domain):
                continue
            scopes.append(
                {
                    "scopeRef": item.get("scopeRef"),
                    "label": item.get("label") or "Information",
                    "description": item.get("description"),
                    "domain": item_domain or "Other",
                    "sensitivity": item.get("sensitivity") or "standard",
                }
            )
        return {
            "status": "ok",
            "person": {
                "displayName": profile.get("displayName")
                or connection.get("displayName")
                or "Hussh member",
                "personRef": person_ref,
                "profilePath": f"/people/{person_ref}",
                "relationship": (profile.get("relationship") or {}).get("status"),
            },
            "domainFilter": domain.strip() or None,
            "requestableScopes": scopes,
            "scopeCount": len(scopes),
            "nextStep": (
                "Present these exact fields grouped by domain, then link to profilePath. "
                "The person must select fields and confirm the request on that profile."
            ),
        }
    except (ConnectionsError, PersonProfileNotFoundError, ValueError) as exc:
        return {"status": "failed", "message": str(exc)}
    except Exception:  # noqa: BLE001 - consumer-safe boundary
        logger.exception("discover_person_information failed")
        return {
            "status": "failed",
            "message": "That information catalog is temporarily unavailable. Please try again.",
        }


def _directory_candidates(
    connections_service: ConnectionsService, user_id: str, spoken_name: str
) -> list[dict[str, Any]]:
    """Page the server-owned directory for one spoken name, exactly as connect.send_request does."""
    search_term = max(spoken_name.split() or [spoken_name], key=len)
    candidates: list[dict[str, Any]] = []
    page = 1
    while page <= _DIRECTORY_RESOLVE_MAX_PAGES:
        result = connections_service.search_directory(
            user_id, query=search_term, page=page, limit=_DIRECTORY_RESOLVE_PAGE_SIZE
        )
        candidates.extend(result.get("items") or [])
        if not result.get("hasMore"):
            break
        page += 1
    return candidates


def _person_display_name(person: dict[str, Any]) -> str:
    return str(person.get("displayName") or "")


def _resolve_person_for_information(
    connections_service: ConnectionsService, user_id: str, spoken: str
) -> tuple[str, str]:
    """Resolve one named person to ``(public_person_ref, display_name)``.

    Connections first, then the server-owned directory, the same two sources
    the Connect screen offers. Ambiguity names the candidates and refuses; a
    request is never sent to a guess. A relationship grants nothing here: the
    catalog and every mutation are still re-checked by the person profile
    service against the subject's own exposure choices.
    """
    spoken = str(spoken or "").strip()
    if not spoken:
        raise ConsentLifecycleError("PERSON_REQUIRED", "Say whose information you mean.")
    connections = connections_service.list_connections(user_id=user_id)
    resolution = resolve_spoken_names(connections, spoken, _person_display_name)
    person: dict[str, Any] | None = None
    if resolution.unresolved:
        unresolved = resolution.unresolved[0]
        if unresolved.kind == "ambiguous":
            raise ConsentLifecycleError(
                "PERSON_AMBIGUOUS",
                "More than one connection matched. Ask which person they mean: "
                f"{ambiguous_match_names(unresolved.matches, _person_display_name)}.",
            )
        try:
            candidates = _directory_candidates(connections_service, user_id, spoken)
        except Exception:  # noqa: BLE001 - the directory is a fallback, never a blocker
            logger.exception("information_request_directory_lookup_failed")
            candidates = []
        matches = match_by_name(candidates, spoken, _person_display_name)
        if not matches:
            raise ConsentLifecycleError(
                "PERSON_NOT_FOUND",
                f"{unresolved.spoken_text or spoken} is not in your connections or the directory.",
            )
        if len(matches) > 1:
            names = ", ".join(_person_display_name(c) for c in matches[:4])
            raise ConsentLifecycleError(
                "PERSON_AMBIGUOUS",
                f"More than one person matches that name: {names}. Say which one.",
            )
        person = matches[0]
    elif len(resolution.resolved) != 1:
        raise ConsentLifecycleError(
            "PERSON_AMBIGUOUS", "Name one person whose information you want."
        )
    else:
        person = resolution.resolved[0]
    person_ref = str(person.get("publicPersonRef") or "").strip()
    if not person_ref:
        raise ConsentLifecycleError(
            "PERSON_PROFILE_NOT_READY", "That person's request profile is not ready yet."
        )
    return person_ref, _person_display_name(person) or "Hussh member"


def _split_requested_fields(fields: str) -> list[str]:
    parts = re.split(r",|;|\band\b|\n", str(fields or ""))
    seen: list[str] = []
    for part in parts:
        cleaned = part.strip(" .")
        if cleaned and normalize_spoken_name(cleaned) not in {
            normalize_spoken_name(x) for x in seen
        }:
            seen.append(cleaned)
    return seen


def _match_requested_fields(
    requestable: list[dict[str, Any]], fields: str
) -> tuple[list[dict[str, Any]], list[str]]:
    """Match the person's words to catalog labels; a domain name selects that whole domain."""
    matched: list[dict[str, Any]] = []
    unmatched: list[str] = []
    for spoken in _split_requested_fields(fields):
        wanted = normalize_spoken_name(spoken)
        if not wanted:
            continue
        exact = [
            item
            for item in requestable
            if normalize_spoken_name(str(item.get("label") or "")) == wanted
        ]
        partial = [
            item
            for item in requestable
            if wanted in normalize_spoken_name(str(item.get("label") or ""))
            or normalize_spoken_name(str(item.get("label") or "")) in wanted
        ]
        by_domain = [
            item
            for item in requestable
            if normalize_spoken_name(str(item.get("domain") or "")) == wanted
        ]
        chosen = exact or partial or by_domain
        if not chosen:
            unmatched.append(spoken)
            continue
        for item in chosen:
            if all(item.get("scopeRef") != m.get("scopeRef") for m in matched):
                matched.append(item)
    return matched, unmatched


def _pending_scope_labels(scopes: list[dict[str, Any]]) -> list[str]:
    return [str(item.get("label") or "Information") for item in scopes]


async def list_pending_information_requests(tool_context: ToolContext) -> dict[str, Any]:
    """List the information requests waiting on the owner's decision: who asks, for what, until when.

    Labels only, never a raw scope or an internal id. Approval is not a tool:
    the browser shows each request as a card and the owner's tap approves it,
    because the export is encrypted in their unlocked browser. To decline one,
    use consent.deny with its requestId after the owner says yes.
    """
    user_id, blocked = await _read_tool_user_id(tool_context)
    if blocked is not None:
        return blocked
    if user_id is None:
        raise AssertionError("_read_tool_user_id returned no user_id with blocked=None")
    try:
        pending = await ConsentLifecycleService().list_pending_incoming(user_id)
    except Exception:  # noqa: BLE001 - consumer-safe boundary
        logger.exception("list_pending_information_requests failed")
        return {
            "status": "failed",
            "message": "Your pending requests are temporarily unavailable. Please try again.",
        }
    request_ids = [str(item.get("requestId") or "") for item in pending if item.get("requestId")]
    return {
        "status": "ok",
        "pendingRequests": pending,
        "count": len(pending),
        "pendingRequestIds": request_ids,
        "nextStep": (
            "Say who is asking and for what. The browser is showing each request as a card "
            "with Approve and Deny; approving is the owner's tap. To decline one from here, "
            "name it, get a yes, then run consent.deny with its requestId and confirmed true."
            if pending
            else "Nothing is waiting on them right now."
        ),
    }


async def propose_information_request(
    person: str,
    fields: str,
    purpose: str,
    tool_context: ToolContext,
    duration_hours: int = _INFORMATION_REQUEST_DEFAULT_HOURS,
) -> dict[str, Any]:
    """Prepare an information request to one named person for the fields they said, ready to confirm.

    Resolves the person (connections, then the directory), matches the spoken
    fields to that person's requestable catalog by label or domain, checks the
    purpose and duration, and parks a proposal. Nothing is sent: read the
    proposal back, and only after a yes run_app_action("consent.request") with
    the proposalId and confirmed true. If connectorReady is false the request
    cannot be sent from chat yet; open profilePath once to set up the secure
    connector.
    """
    user_id, blocked = await _read_tool_user_id(tool_context)
    if blocked is not None:
        return blocked
    if user_id is None:
        raise AssertionError("_read_tool_user_id returned no user_id with blocked=None")
    try:
        connections_service = ConnectionsService()
        person_ref, display_name = _resolve_person_for_information(
            connections_service, user_id, person
        )
        profile = await PersonProfileService().get_viewer_profile(
            viewer_user_id=user_id, public_person_ref=person_ref
        )
        requestable = [
            item for item in (profile.get("requestableScopes") or []) if item.get("scopeRef")
        ]
        profile_path = f"/people/{person_ref}"
        if not requestable:
            return {
                "status": "nothing_requestable",
                "person": {"displayName": display_name, "profilePath": profile_path},
                "message": f"{display_name} has not made any information requestable yet.",
            }
        matched, unmatched = _match_requested_fields(requestable, fields)
        if not matched:
            by_domain: dict[str, list[str]] = {}
            for item in requestable[:40]:
                by_domain.setdefault(str(item.get("domain") or "Other"), []).append(
                    str(item.get("label") or "Information")
                )
            return {
                "status": "needs_clarification",
                "person": {"displayName": display_name, "profilePath": profile_path},
                "unmatchedFields": unmatched,
                "availableFields": by_domain,
                "message": (
                    f"None of those fields match what {display_name} makes requestable. "
                    "Offer the available fields grouped by domain and ask which they want."
                ),
            }
        cleaned_purpose = str(purpose or "").strip()
        if not 8 <= len(cleaned_purpose) <= 500:
            return {
                "status": "needs_clarification",
                "person": {"displayName": display_name, "profilePath": profile_path},
                "message": "Ask for a purpose of at least a short sentence (8 to 500 characters); "
                "the other person reads it before deciding.",
            }
        try:
            hours = int(duration_hours or _INFORMATION_REQUEST_DEFAULT_HOURS)
        except (TypeError, ValueError):
            hours = _INFORMATION_REQUEST_DEFAULT_HOURS
        if not 1 <= hours <= _INFORMATION_REQUEST_MAX_HOURS:
            return {
                "status": "needs_clarification",
                "person": {"displayName": display_name, "profilePath": profile_path},
                "message": "Access lasts between 1 hour and 30 days (720 hours). Ask for a duration in that range.",
            }
        connector = await OneEmailKycService().get_client_connector(user_id=user_id)
        connector_ready = bool((connector or {}).get("configured"))
        proposal_id = uuid.uuid4().hex
        proposals = dict(tool_context.state.get(_STATE_INFORMATION_REQUEST_PROPOSALS) or {})
        proposals[proposal_id] = {
            "personRef": person_ref,
            "displayName": display_name,
            "scopeRefs": [str(item.get("scopeRef")) for item in matched],
            "labels": _pending_scope_labels(matched),
            "purpose": cleaned_purpose,
            "durationHours": hours,
        }
        for stale in list(proposals)[:-_INFORMATION_REQUEST_MAX_PROPOSALS]:
            proposals.pop(stale, None)
        tool_context.state[_STATE_INFORMATION_REQUEST_PROPOSALS] = proposals
        return {
            "status": "proposal_ready",
            "proposalId": proposal_id,
            "person": {"displayName": display_name, "profilePath": profile_path},
            "fields": _pending_scope_labels(matched),
            "unmatchedFields": unmatched,
            "purpose": cleaned_purpose,
            "durationHours": hours,
            "connectorReady": connector_ready,
            "nextStep": (
                "Read back the person, the fields, the purpose, and the duration, then ask for a yes. "
                "After the yes, call run_app_action with action_id consent.request and slots "
                "{proposal_id, confirmed: true}. Say nothing was sent until that result confirms it."
                if connector_ready
                else "This request cannot be sent from chat yet: their secure connector is not set up. "
                "Send them to profilePath once to set it up, then they can ask again."
            ),
        }
    except ConsentLifecycleError as exc:
        status = {
            "PERSON_AMBIGUOUS": "needs_clarification",
            "PERSON_NOT_FOUND": "not_found",
            "PERSON_PROFILE_NOT_READY": "unavailable",
        }.get(exc.code, "failed")
        return {"status": status, "message": exc.message}
    except (ConnectionsError, PersonProfileNotFoundError, ValueError) as exc:
        return {"status": "failed", "message": str(exc)}
    except Exception:  # noqa: BLE001 - consumer-safe boundary
        logger.exception("propose_information_request failed")
        return {
            "status": "failed",
            "message": "That information catalog is temporarily unavailable. Please try again.",
        }


async def _execute_consent_lifecycle_action(
    action_id: str, slots: dict[str, Any], user_id: str, tool_context: ToolContext
) -> tuple[str, dict[str, str] | None]:
    """The four consent transitions One may run after a spoken yes."""
    confirmed = bool(slots.get("confirmed") is True)
    if action_id == "consent.request":
        proposal_id = str(slots.get("proposal_id") or "").strip()
        proposals = tool_context.state.get(_STATE_INFORMATION_REQUEST_PROPOSALS) or {}
        proposal = proposals.get(proposal_id) if isinstance(proposals, dict) else None
        if not proposal:
            raise ConsentLifecycleError(
                "PROPOSAL_NOT_FOUND",
                "Propose the request first with propose_information_request, then confirm it.",
            )
        name = str(proposal.get("displayName") or "this person")
        labels = list(proposal.get("labels") or [])
        if not confirmed:
            raise _BackendDirectConfirmationNeeded(
                f"Ask: send {name} a request for {join_names_for_speech(labels)} "
                f"for {proposal.get('durationHours')} hours, purpose: {proposal.get('purpose')}? "
                "Only call this action again with confirmed set to true after they say yes."
            )
        connector = await OneEmailKycService().get_client_connector(user_id=user_id)
        connector_key_id = str(
            ((connector or {}).get("connector") or {}).get("connector_key_id") or ""
        )
        if not connector_key_id:
            raise ConsentLifecycleError(
                "CONNECTOR_NOT_READY",
                f"Your secure connector is not set up yet. Open {name}'s profile once to set it up, "
                "then ask me again.",
                status_code=409,
            )
        try:
            created = await InformationRequestService().create(
                requester_user_id=user_id,
                person_ref=str(proposal.get("personRef")),
                scope_refs=list(proposal.get("scopeRefs") or []),
                purpose=str(proposal.get("purpose") or ""),
                duration_seconds=int(proposal.get("durationHours") or 0) * 3600,
                connector_key_id=connector_key_id,
                idempotency_key=f"agent-chat-{proposal_id}",
            )
        except InformationRequestError as exc:
            raise ConsentLifecycleError(
                "INFORMATION_REQUEST_FAILED", str(exc), status_code=exc.status_code
            ) from exc
        except PersonProfileNotFoundError as exc:
            raise ConsentLifecycleError(
                "PERSON_NOT_FOUND", f"{name}'s request profile is no longer available."
            ) from exc
        remaining = dict(proposals)
        remaining.pop(proposal_id, None)
        tool_context.state[_STATE_INFORMATION_REQUEST_PROPOSALS] = remaining
        bundle_id = str((created or {}).get("bundleId") or (created or {}).get("bundle_id") or "")
        tool_context.state[_STATE_LAST_INFORMATION_REQUEST] = {
            "bundleId": bundle_id,
            "displayName": name,
        }
        return (
            f"Sent {name} a request for {join_names_for_speech(labels)}. "
            "They will see it in their Consent Center; what they approve appears on their profile.",
            {"name": name},
        )

    if action_id == "consent.deny":
        request_id = str(slots.get("request_id") or "").strip()
        if not request_id:
            raise ConsentLifecycleError(
                "CONSENT_REQUEST_ID_REQUIRED",
                "Say which request to deny; list_pending_information_requests names them.",
            )
        if not confirmed:
            raise _BackendDirectConfirmationNeeded(
                "Ask: deny that request? Only call this action again with confirmed set to true "
                "after they say yes."
            )
        result = await ConsentLifecycleService().deny_pending_request(user_id, request_id)
        return f"Denied that request. {result.get('message') or ''}".strip(), None

    if action_id == "consent.revoke":
        revoke_request_id = str(slots.get("request_id") or "").strip() or None
        scope = str(slots.get("scope") or "").strip() or None
        if not revoke_request_id and not scope:
            raise ConsentLifecycleError(
                "CONSENT_REVOKE_TARGET_REQUIRED", "Say which grant to revoke."
            )
        if not confirmed:
            raise _BackendDirectConfirmationNeeded(
                "Ask: revoke that access now? Only call this action again with confirmed set to "
                "true after they say yes."
            )
        await ConsentLifecycleService().revoke_active_grant(
            user_id, scope=scope, request_id=revoke_request_id
        )
        return "Revoked. They no longer have that access.", None

    if action_id == "consent.cancel_request":
        bundle_id = str(slots.get("bundle_id") or "").strip()
        last = tool_context.state.get(_STATE_LAST_INFORMATION_REQUEST) or {}
        if bundle_id.lower() in ("", "last", "latest", "that", "it"):
            bundle_id = str(last.get("bundleId") or "")
        if not bundle_id:
            raise ConsentLifecycleError(
                "INFORMATION_REQUEST_ID_REQUIRED",
                "Say which request to cancel; the ones you sent are on that person's profile.",
            )
        if not confirmed:
            raise _BackendDirectConfirmationNeeded(
                "Ask: cancel that request? Only call this action again with confirmed set to true "
                "after they say yes."
            )
        try:
            await InformationRequestService().cancel(requester_user_id=user_id, bundle_id=bundle_id)
        except InformationRequestError as exc:
            raise ConsentLifecycleError(
                "INFORMATION_REQUEST_CANCEL_FAILED", str(exc), status_code=exc.status_code
            ) from exc
        if str(last.get("bundleId") or "") == bundle_id:
            tool_context.state[_STATE_LAST_INFORMATION_REQUEST] = {}
        return "Cancelled that request.", None

    raise AssertionError(f"{action_id} is not a consent lifecycle action")


async def list_pending_connection_requests(
    tool_context: ToolContext,
    direction: Literal["incoming", "outgoing"] = "incoming",
) -> dict[str, Any]:
    """List pending Connect requests. "incoming" = waiting on this person to accept;
    "outgoing" = this person's own asks still waiting on someone else."""
    user_id, blocked = await _read_tool_user_id(tool_context)
    if blocked is not None:
        return blocked
    if user_id is None:
        raise AssertionError("_read_tool_user_id returned no user_id with blocked=None")
    result = await _read_tool_result(
        "your pending connection requests",
        "requests",
        lambda: ConnectionsService().list_requests(user_id=user_id, direction=direction),
    )
    if result.get("status") == "ok":
        # No photo/masked-contact field on a connection-request row (see
        # ConnectionsService.list_requests) -- name only, same as any other
        # row a service genuinely has nothing more to say about.
        items = _trace_list_rows(
            result.get("requests") or [],
            id_key="counterpartUserId",
            name_key="counterpartDisplayName",
        )
        heading = (
            "Requests you've sent"
            if direction == "outgoing"
            else "Connection requests waiting on you"
        )
        _publish_list_trace(
            tool_context,
            "list_pending_connection_requests",
            kind="people_list",
            heading=heading,
            items=items,
        )
    return result


async def list_my_outgoing_location_requests(tool_context: ToolContext) -> dict[str, Any]:
    """List this person's own asks for someone else's location still waiting
    on that person's approve/decline -- the mirror of
    list_pending_location_requests, which is the incoming direction."""
    user_id, blocked = await _read_tool_user_id(tool_context)
    if blocked is not None:
        return blocked
    if user_id is None:
        raise AssertionError("_read_tool_user_id returned no user_id with blocked=None")
    result = await _read_tool_result(
        "your outgoing location requests",
        "requests",
        lambda: OneLocationAgentService().list_pending_requester_requests(
            requester_user_id=user_id
        ),
    )
    if result.get("status") == "ok":
        items = _trace_list_rows(
            result.get("requests") or [],
            id_key="ownerUserId",
            name_key="ownerDisplayName",
            photo_key="ownerPhotoUrl",
            detail_fn=lambda row: row.get("ownerMaskedPhone") or None,
        )
        _publish_list_trace(
            tool_context,
            "list_my_outgoing_location_requests",
            kind="people_list",
            heading="Requests you've sent",
            items=items,
        )
    return result


async def get_location_circle_members(circle: str, tool_context: ToolContext) -> dict[str, Any]:
    """List who is actually in a named Location circle, by name and role.

    list_my_location_circles only returns a member COUNT per circle, not who
    they are -- this is the tool for "who's in Family" once the circle is
    named. Resolves 'circle' the same way every backend-direct circle action
    does (_resolve_named_circle): exact, then word-boundary, then substring,
    refusing to guess on ambiguity.
    """
    user_id, blocked = await _read_tool_user_id(tool_context)
    if blocked is not None:
        return blocked
    if user_id is None:
        raise AssertionError("_read_tool_user_id returned no user_id with blocked=None")
    circle_service = OneLocationCircleService()
    try:
        resolved = _resolve_named_circle(circle_service, user_id, circle)
        detail = circle_service.get_circle(user_id=user_id, circle_id=str(resolved.get("id") or ""))
    except OneLocationCircleError as exc:
        return {"status": "not_found", "message": str(exc)}
    except Exception:  # noqa: BLE001 - the model must be told something failed, not why internally
        logger.exception("one_adk_read_tool_failed label=%s reason=unexpected", "circle members")
        return {
            "status": "failed",
            "message": "Could not check who's in that circle right now. Try again in a moment.",
        }
    # Deliberately not the raw member payload: that also carries each
    # member's public recipient key (keyId/publicKeyJwk/keyAlgorithm), which
    # has no business flowing through a voice transcript even though it is
    # cryptographically "public" -- the browser needs it to render a share
    # picker, a spoken roster does not.
    members = [
        {
            "displayName": str(member.get("displayName") or "Circle member"),
            "role": str(member.get("role") or "member"),
            "relationship": str(member.get("relationship") or "none"),
        }
        for member in (detail.get("members") or [])
    ]
    circle_name = str(detail.get("name") or "That circle")
    # No stable id on a member row (deliberately -- see the comment above);
    # the row's position is a fine React key for a roster that only exists
    # for the life of this one card.
    trace_items = [
        {
            "id": f"member-{index}",
            "name": member["displayName"],
            "detail": member["role"].capitalize(),
            "photoUrl": None,
        }
        for index, member in enumerate(members)
    ]
    _publish_list_trace(
        tool_context,
        "get_location_circle_members",
        kind="people_list",
        heading=f"{circle_name} members",
        items=trace_items,
    )
    return {
        "status": "ok",
        "circle": {"name": str(detail.get("name") or ""), "kind": str(detail.get("kind") or "")},
        "members": members,
    }


async def run_app_action(
    action_id: str, slots: dict[str, Any], tool_context: ToolContext
) -> dict[str, Any]:
    """Run a governed app action by its exact action id.

    Call list_app_actions first unless the person's own words are already a
    close match to a visible label -- do not decide this by how confident it
    feels. Pass required inputs in slots (e.g. {"symbol": "NVDA"}). The app
    validates guards and confirms sensitive actions; never claim an outcome
    beyond this tool's status.
    """
    clean_id = str(action_id or "").strip()
    clean_slots = {k: v for k, v in (slots or {}).items() if v not in (None, "")}
    entry = get_action_gateway_action(clean_id)
    if entry is None:
        logger.info("one_adk_action_decision action=%s status=unknown_action", clean_id[:128])
        return {
            "status": "unknown_action",
            "message": f"'{clean_id}' is not a known app action.",
        }

    context = _voice_context(tool_context)
    if isinstance(context, dict) and context.get("context_pending") is True:
        # The live relay seeded this marker at session start; the browser's
        # first app_context frame has not landed yet. Refusing outright here
        # read as "actions never fire" on cold connects; instead report a
        # recoverable status the model can retry after a beat.
        logger.info("one_adk_action_decision action=%s status=context_not_ready", clean_id)
        return {
            "status": "context_not_ready",
            "message": (
                "The app is still publishing its screen state. Acknowledge the "
                "request, wait a moment, and retry this exact action."
            ),
        }
    # Already done, this turn, with these exact inputs.
    #
    # A tool cannot see settlements through `tool_context.state` -- it is
    # frozen when the streaming invocation opens -- so `run_app_action` had no
    # way to know the thing it was about to park a directive for had just
    # succeeded. Live, that produced a hard loop: the share went through, the
    # composer cleared its selection the way it always does after a send, and
    # One (never having learned it worked) tried again, found an empty
    # composer, was told "nobody is selected yet", and tried again.
    #
    # Refused HERE rather than by injecting a note into the live turn.
    # Injection preempts One mid-sentence and loops; a tool return reaches the
    # model where its turn already ends.
    session_id = getattr(getattr(tool_context, "session", None), "id", None)
    completed_fingerprint = read_completed_action(session_id, clean_id)
    if completed_fingerprint is not None and completed_fingerprint == _slot_fingerprint(
        clean_slots
    ):
        logger.info("one_adk_action_decision action=%s status=already_completed", clean_id)
        return {
            "status": "already_completed",
            "message": (
                f"{clean_id} already succeeded a moment ago with these exact "
                "inputs, and doing it again would do it twice. Tell the person "
                "what was done, once, and stop. Only run it again if they ask "
                "for it again."
            ),
        }
    # Already tried, this turn, with these exact inputs, and it did not work.
    #
    # The already-completed refusal above only covers actions that SUCCEEDED,
    # because only successes were ever recorded. That left the louder case
    # unguarded: a failure leaves the person's request unsatisfied, so One keeps
    # trying to satisfy it, and nothing in the loop can tell it the attempt is
    # hopeless. Live, `location.share_selected` went out 24 times in 15 seconds
    # against a recipient who had no encryption keys and never would within that
    # turn.
    #
    # The recorded reason is handed back rather than a bare refusal. One is not
    # being asked to fall silent -- it is being given the sentence it should
    # have said the first time, which is what actually ends the loop.
    failed_record = read_failed_action(session_id, clean_id)
    if failed_record is not None and failed_record[0] == _slot_fingerprint(clean_slots):
        failure_reason = failed_record[1] or "The app did not say why."
        logger.info("one_adk_action_decision action=%s status=already_failed", clean_id)
        return {
            "status": "already_failed",
            "message": (
                f"{clean_id} was just tried with these exact inputs and failed: "
                f"{failure_reason} Running it again right now would fail the same "
                "way. Tell the person what went wrong, once, and stop. If they "
                "change something or ask again, it will be allowed through."
            ),
        }
    if isinstance(context, dict) and context.get("pending_settlement") is True:
        # A previous action or navigation has not settled yet. Executing
        # against the outgoing screen's inventory would validate the request
        # against stale state, so hold this turn instead of refusing it.
        logger.info("one_adk_action_decision action=%s status=settling", clean_id)
        return {
            "status": "settling",
            "message": (
                "The previous action is still settling. Wait for the app's "
                "settlement report, then run this action against the fresh "
                "screen state."
            ),
        }

    onboarding = context.get("onboarding") if isinstance(context, dict) else {}
    onboarding = onboarding if isinstance(onboarding, dict) else {}
    if clean_id == "onboarding.claim_one" and (
        (isinstance(context, dict) and context.get("signed_in") is True)
        or onboarding.get("root_resolved") is True
    ):
        return {
            "status": "terminal",
            "message": "One is already claimed for this session.",
        }
    if clean_id == "setup.hub_master_ack" and onboarding.get("root_resolved") is True:
        return {
            "status": "terminal",
            "message": "Setup acknowledgement is already complete.",
        }
    if (
        clean_id in {"phone_mandate.submit_number", "phone_mandate.submit_code"}
        and onboarding.get("phone_verified") is True
    ):
        return {
            "status": "terminal",
            "message": "Phone verification is already complete.",
        }

    policy = str(entry.get("execution_policy") or "allow_direct")
    label = str(entry.get("label") or clean_id)
    if policy == "manual_only":
        screens = (entry.get("scope") or {}).get("screens") or []
        where = f" It lives on the {screens[0]} screen." if screens else ""
        logger.info("one_adk_action_decision action=%s status=manual_only", clean_id)
        return {
            "status": "manual_only",
            "message": (
                f"{label} must be done by the user in the app; I cannot trigger it.{where}"
            ),
            # Guide mode: manual_only is not a dead end. State the guidance once
            # and hand off -- the next [App route context] note (already
            # re-injected on any visible_modules/interaction_layer change,
            # regardless of action) is the existing, generic signal that the
            # person acted; resume narrating from there.
            "next_step": (
                "Tell the person exactly what to do, then wait silently. Do not "
                "repeat this guidance and do not propose an alternate action. "
                "When a fresh [App route context] note arrives, that is your "
                "signal the person acted -- resume narrating the next step from "
                "its available action inventory."
            ),
        }

    execution_target = entry.get("execution_target") or {}
    execution_status = str(execution_target.get("status") or "unwired")
    if execution_status != "wired":
        reason = str(
            execution_target.get("reason") or "This action is not available in the current runtime."
        )
        logger.info(
            "one_adk_action_decision action=%s status=%s",
            clean_id,
            execution_status,
        )
        return {
            "status": execution_status,
            "message": reason,
        }

    voice_settings = _voice_settings(tool_context)
    if is_voice_entirely_disabled(voice_settings):
        logger.info("one_adk_action_decision action=%s status=domain_disabled domain=all", clean_id)
        return {
            "status": "domain_disabled",
            "message": (
                "Voice control is turned off in your settings. Turn it back on "
                "in Profile, Preferences, Voice, or do this by tap instead."
            ),
        }
    voice_domain = resolve_voice_domain(clean_id)
    if is_voice_domain_disabled(voice_domain, voice_settings.get("disabled_domains")):
        logger.info(
            "one_adk_action_decision action=%s status=domain_disabled domain=%s",
            clean_id,
            voice_domain,
        )
        return {
            "status": "domain_disabled",
            "message": (
                f"Voice control is turned off for {voice_domain_label(voice_domain)} "
                "in your settings. Turn it back on in Profile, Preferences, Voice, "
                "or do this by tap instead."
            ),
        }

    available_action_ids = _available_action_ids(tool_context)
    # Navigation actions (route.*, allow_direct) are invocable from any
    # screen by design; the browser's per-screen inventory does not bound
    # them. Backend-direct actions are the same in spirit: they mutate
    # through the service layer directly and were never going to ask the
    # browser to run a local handler, so there is no screen inventory for
    # them to be missing from -- the person can be looking at anything.
    # All other actions must be declared by the current surface.
    if (
        available_action_ids is not None
        and clean_id not in available_action_ids
        and not is_navigation_action(entry)
        and not _is_backend_direct(clean_id, clean_slots)
    ):
        # A journey entry action is legitimately off-screen right now, but it is
        # not out of reach: start_app_goal navigates to its authored destination
        # first. Say so, instead of reporting a dead end the model can only
        # answer by falling back to plain navigation.
        if _is_journey_startable(entry):
            logger.info("one_adk_action_decision action=%s status=use_start_app_goal", clean_id)
            return {
                "status": "use_start_app_goal",
                "message": (
                    f"'{clean_id}' is not on this screen, but it is a journey. "
                    "Call start_app_goal with this exact action id and its "
                    "required slots; it will open the right screen first."
                ),
            }
        logger.info("one_adk_action_decision action=%s status=action_unavailable", clean_id)
        return {
            "status": "action_unavailable",
            "message": (
                f"'{clean_id}' is not available in the current app state. "
                "Call list_app_actions for the controls currently available."
            ),
        }

    delegate_id = str(entry.get("delegate_agent_id") or "").strip()
    delegate_tool = _DELEGATE_TOOL_BY_AGENT_ID.get(delegate_id)
    if delegate_tool:
        return {
            "status": "delegated",
            "message": (
                f"'{clean_id}' belongs to a specialist. Call {delegate_tool} "
                "with the user's request instead."
            ),
            "use_tool": delegate_tool,
        }

    # Screen-reachability guard (defense in depth): if the action declares the
    # screens it lives on and the user is NOT on one of them, refuse rather than
    # park a directive for a control that isn't on screen. This is what stops
    # One from, e.g., trying to run phone verification while the user is on the
    # setup hub. Actions with no declared screens are screen-agnostic (global
    # navigation) and always allowed; if we don't know the current screen we
    # cannot judge reachability, so we allow.
    # The relay publishes the current screen for this long-lived Live turn;
    # `tool_context.state` is the session snapshot from connect time and can
    # still name the source screen after an authored route settlement.
    current_screen = str(
        (context.get("screen") if isinstance(context, dict) else None)
        or tool_context.state.get(_STATE_SCREEN)
        or ""
    ).strip()
    action_screens = {
        str(s).strip() for s in ((entry.get("scope") or {}).get("screens") or []) if str(s).strip()
    }
    if (
        current_screen
        and action_screens
        and current_screen not in action_screens
        and not is_navigation_action(entry)
        and not _is_backend_direct(clean_id, clean_slots)
    ):
        label = str(entry.get("label") or clean_id)
        where = sorted(action_screens)[0]
        logger.info("one_adk_action_decision action=%s status=wrong_screen", clean_id)
        return {
            "status": "wrong_screen",
            "message": (
                f"{label} isn't available on the current screen; it lives on "
                f"the {where} screen. Run the matching route action to open "
                "that screen first."
            ),
            "reachable_screens": sorted(action_screens),
        }

    missing = _missing_required_slot(entry, clean_slots)
    if missing is not None:
        logger.info("one_adk_action_decision action=%s status=input_needed", clean_id)
        return {
            "status": "input_needed",
            "missing_slot": missing["slot"],
            "message": missing["prompt"],
        }

    if clean_id == "kyc.draft.request_redraft":
        instruction = clean_slots.get("instruction")
        instruction = instruction.strip() if isinstance(instruction, str) else ""
        if not instruction or len(instruction) > 1000:
            return {
                "status": "input_needed",
                "missing_slot": "instruction",
                "message": "How should I revise the current response draft?",
            }
        # This action admits one bounded model slot only. Workflow IDs, draft
        # bodies, exports, and scopes are resolved by the mounted KYC handler.
        clean_slots = {"instruction": instruction}

    # Whether an action must be confirmed is the CONTRACT's call.
    #
    # This was hardcoded True, and so was its counterpart in the browser
    # (`agent-bar.tsx`). The two are ONE invariant expressed on both sides of
    # the trust boundary and must always be changed together: the browser
    # decides whether to raise a card, this decides whether the ledger will
    # accept a settlement without a confirm. Changing only the browser half
    # made every allow_direct action run and then fail settlement, because the
    # directive it was settling had been parked here as needing a confirm.
    #
    # allow_direct issues ready to run. Everything else still waits, and two
    # cases deliberately keep waiting whatever the policy says: an action the
    # gateway does not know (unknown is not a licence) and
    # trusted_activation_required, whose provider window the browser will only
    # open on a fresh human gesture.
    flags = _directive_flags(
        entry,
        require_tap_confirmation=voice_settings.get("require_tap_confirmation") is True,
    )
    trusted_activation = flags["trustedActivationRequired"]
    needs_confirmation = flags["needsConfirmation"]
    if clean_id in BACKEND_DIRECT_VERBAL_CONFIRMATION_IDS:
        needs_confirmation = False

    # Backend-direct actions never reach the directive-parking path below --
    # once no confirmation is owed (the ordinary case; the person's own
    # require_tap_confirmation preference still routes through the normal
    # browser confirm card, unchanged), the mutation happens right here and
    # the browser is never involved.
    if (
        _is_backend_direct(clean_id, clean_slots)
        and not needs_confirmation
        and not trusted_activation
    ):
        label = str(entry.get("label") or clean_id)
        return await _run_backend_direct_action(clean_id, clean_slots, tool_context, label=label)

    directive_payload: dict[str, Any] = {
        "actionId": clean_id,
        "slots": clean_slots,
        "needsConfirmation": needs_confirmation,
        "trustedActivationRequired": trusted_activation,
    }
    tool_context.state[f"{_STATE_PENDING_DIRECTIVE}:{clean_id}"] = {
        "kind": "action",
        "payload": directive_payload,
    }
    logger.info(
        "one_adk_action_decision action=%s status=%s",
        clean_id,
        "confirm_pending" if needs_confirmation else "ready_to_run",
    )
    return {
        "status": "confirm_pending" if needs_confirmation else "ready_to_run",
        # The AG-UI text chat has no session-state directive relay (that is the
        # Live voice path), so the browser learns about the parked action from
        # this tool result and stages or runs it itself.
        "directive": directive_payload,
        # The model reads this and says it out loud, so it has to match what
        # will actually happen. Promising a confirmation that never comes --
        # "I'll ask you to confirm", followed by the thing simply happening --
        # is how One starts sounding untrustworthy about everything else.
        "message": (
            f"The app will present the exact {label} action for a trusted tap."
            if trusted_activation
            else f"The app will ask the user to confirm {label}."
            if needs_confirmation
            else f"{label} is running now; tell the user what you did, briefly."
        ),
        "action_id": clean_id,
        # Proactive-prompting: like open_screen, this text is the tool
        # RESULT the model reads on its next turn - there is no separate
        # server-injected system turn after a tool call. Nudging here means
        # One offers a next step after every governed action it runs, not
        # only after an onboarding screen change.
        # Waiting for a confirmation that is never coming is a loop, not
        # patience. This told One to "wait for explicit confirmation and the
        # correlated settlement" on every action -- true while every action
        # raised a card, and false the moment confirmation was removed. One
        # waited, heard nothing, proposed again, and said the same sentence
        # each time. Reported as the share request getting stuck in a loop.
        #
        # Only the trusted-activation pair still has anything to wait for.
        "next_step": (
            (
                "The app is showing the person a control they must tap for "
                f"{label}. Say so once and then wait; do not propose it again."
            )
            if trusted_activation
            else (
                f"{label} is already running. Wait for its settlement before "
                "saying it completed, say nothing further until that arrives, "
                "and do not call this action again -- calling it twice would "
                "do it twice. Then acknowledge only the reported outcome and, "
                "if there is an obvious next step, offer it."
            )
        ),
    }


def _context_revision(tool_context: ToolContext) -> str:
    context = _voice_context(tool_context)
    if not isinstance(context, dict):
        return ""
    return str(context.get("context_revision") or "").strip()[:128]


def _settled_journey_definition(entry: dict[str, Any], action_id: str) -> dict[str, Any] | None:
    """Return a validated, authored two-stage journey for ``action_id``.

    Generated contracts may describe many goal shapes.  This runtime only
    treats the deliberately small ``action -> destination choice`` form as a
    deferred journey.  Everything else stays on the legacy direct-action path
    until it has an equally explicit runtime contract.
    """
    goal = entry.get("goal")
    if not isinstance(goal, dict):
        return None
    goal_id = str(goal.get("goal_id") or "").strip()
    steps = goal.get("workflow_steps")
    if not goal_id or not isinstance(steps, list) or len(steps) < 2:
        return None
    initial = steps[0] if isinstance(steps[0], dict) else {}
    choice = steps[1] if isinstance(steps[1], dict) else {}
    settlement_target = initial.get("settlement_target")
    choice_action_ids = choice.get("action_ids")
    if (
        initial.get("type") != "action"
        or str(initial.get("action_id") or "") != action_id
        or not isinstance(settlement_target, dict)
        or not str(settlement_target.get("route") or "").strip()
        or not str(settlement_target.get("screen") or "").strip()
        or choice.get("type") != "choice"
        or not isinstance(choice_action_ids, list)
    ):
        return None
    choices = [
        str(value).strip()
        for value in choice_action_ids
        if isinstance(value, str) and str(value).strip()
    ]
    if not choices:
        return None
    return {
        "goal_id": goal_id,
        "settlement_target": {
            "route": str(settlement_target["route"]).strip(),
            "screen": str(settlement_target["screen"]).strip(),
        },
        "choice_action_ids": choices,
        "carry_explicit_choice": choice.get("carry_explicit_choice") is True,
    }


_JOURNEY_SLOT_MAX_CHARS = 64


def _journey_slots(entry: dict[str, Any], slots: dict[str, Any]) -> dict[str, Any]:
    """Bounded slot values for a journey run, per the action's goal contract.

    Only slots the generated contract declares survive, so a journey can never
    carry arbitrary model-authored state across a navigation. Values are
    trimmed and length-capped; declared defaults fill an omitted slot.
    """
    raw_goal = entry.get("goal")
    goal: dict[str, Any] = raw_goal if isinstance(raw_goal, dict) else {}
    raw_schema = goal.get("slot_schema")
    schema: dict[str, str] = (
        {str(key): str(value) for key, value in raw_schema.items()}
        if isinstance(raw_schema, dict)
        else {}
    )
    defaults: dict[str, Any] = {}
    for spec in goal.get("required_inputs") or []:
        if not isinstance(spec, dict):
            continue
        slot_name = str(spec.get("slot") or spec.get("name") or "").strip()
        if not slot_name:
            continue
        schema.setdefault(slot_name, str(spec.get("resolver") or ""))
        if spec.get("default_value") not in (None, ""):
            defaults[slot_name] = spec["default_value"]

    resolved: dict[str, Any] = {}
    for slot_name, resolver in schema.items():
        name = slot_name.strip()
        if not name:
            continue
        raw = (slots or {}).get(name)
        if raw in (None, ""):
            raw = defaults.get(name)
        if raw in (None, ""):
            continue
        value = str(raw).strip()[:_JOURNEY_SLOT_MAX_CHARS]
        # The contract names the resolver, so normalization stays declared
        # rather than hardcoded per action. A ticker is canonically uppercase.
        if resolver == "ticker_symbol":
            value = value.upper()
        resolved[name] = value
    return resolved


def _navigation_action_for_route(route: str) -> str | None:
    """The wired action that opens ``route``, if one exists.

    A navigate-then-execute journey is only real when One actually has a
    generated way to reach the destination. Resolving it from the gateway --
    rather than naming one in code -- is what keeps the journey authored in
    the contract. Sorted so the choice is deterministic when a route has more
    than one navigation action.
    """
    clean_route = str(route or "").strip()
    if not clean_route:
        return None
    candidates: list[str] = []
    for candidate in list_action_gateway_actions():
        action_id = str(candidate.get("action_id") or "").strip()
        if not action_id:
            continue
        # Any action that navigates to this route can walk someone there,
        # whatever it is named. Requiring the ``route.`` prefix made whole
        # destinations look unreachable: /one/setup/finance is opened only by
        # ``setup.open_finance``, and /one/connect only by ``route.one_connect``.
        target = candidate.get("execution_target") or {}
        if target.get("path") != "route" or target.get("status") != "wired":
            continue
        if str(target.get("target") or "").strip() == clean_route:
            candidates.append(action_id)
    # Prefer a `route.*` escort when the destination has one. Plain alphabetical
    # order picked `location.open_now` over `route.one_location`, and -- worse --
    # `location.add_connections` to escort a CONNECT journey, purely because
    # "location" sorts before "route". Both navigate correctly, but only the
    # `route.*` ones are in the browser's global-navigation set, so they are the
    # ones guaranteed to be offered from any screen. Deterministic either way:
    # alphabetical still breaks ties inside each group.
    return (
        sorted(candidates, key=lambda action: (not action.startswith("route."), action))[0]
        if candidates
        else None
    )


def _navigation_journey_definition(entry: dict[str, Any], action_id: str) -> dict[str, Any] | None:
    """Return an authored navigate-then-execute journey for ``action_id``.

    The complement of ``_settled_journey_definition``: that shape runs an
    action HERE and then offers a choice where it lands, while this one
    navigates to an authored destination FIRST and runs the action there.

    Both are declared entirely by the generated contract. This one is a single
    ``action`` step naming itself plus the ``settlement_target`` it needs to be
    standing on. Adding a second journey is therefore a contract edit, not a
    code change -- which is the whole point: this path used to be a literal
    ``if action_id != "analysis.start"``, so the app could only ever have one.
    """
    if action_id.startswith("route."):
        # Navigation actions already ARE the navigation. Wrapping one in a
        # journey would make it navigate to itself.
        return None
    execution_target = entry.get("execution_target")
    if (
        isinstance(execution_target, dict)
        and execution_target.get("status") == "wired"
        and execution_target.get("path") == "route"
    ):
        # The name prefix above was only ever a proxy for this: an action that
        # executes BY navigating is its own navigation, whatever it is called.
        # The Location surface authors its tabs and flows as ``location.*``
        # route actions, and without this check the one whose target matches a
        # wired ``route.*`` action exactly becomes a journey to where it
        # already goes.
        return None
    goal = entry.get("goal")
    if not isinstance(goal, dict):
        return None
    goal_id = str(goal.get("goal_id") or "").strip()
    steps = goal.get("workflow_steps")
    if not goal_id or not isinstance(steps, list) or len(steps) != 1:
        return None
    step = steps[0] if isinstance(steps[0], dict) else {}
    settlement_target = step.get("settlement_target")
    if (
        step.get("type") != "action"
        or str(step.get("action_id") or "") != action_id
        or not isinstance(settlement_target, dict)
    ):
        return None
    route = str(settlement_target.get("route") or "").strip()
    screen = str(settlement_target.get("screen") or "").strip()
    if not route or not screen:
        return None
    navigation_action_id = _navigation_action_for_route(route)
    if not navigation_action_id or navigation_action_id == action_id:
        # Nothing can escort itself. Once the resolver stopped requiring a
        # `route.` name prefix it began finding surface-named navigations like
        # `setup.open_email` -- including, for that action, itself.
        return None
    return {
        "goal_id": goal_id,
        "destination_route": route,
        "destination_screen": screen,
        "navigation_action_id": navigation_action_id,
        "label": str(step.get("label") or "").strip(),
    }


def _is_journey_startable(entry: dict[str, Any]) -> bool:
    """True when ``start_app_goal`` can begin this action from ANY screen.

    This deliberately mirrors ``start_app_goal``'s own two accepted paths so
    discovery can never advertise an action the runtime would then refuse: an
    authored two-stage journey, or an authored navigate-then-execute journey.
    Every other action still falls through to ``run_app_action``, which
    correctly requires the control to be mounted on the current screen.

    Without this, a journey's own entry action was unlistable from anywhere
    except the screen it already lives on -- so One could never discover that
    "analyze Nvidia" had a real cross-screen path, and settled for the plain
    route.* navigation it could see instead.
    """
    action_id = str(entry.get("action_id") or "").strip()
    if not action_id:
        return False
    if _settled_journey_definition(entry, action_id) is not None:
        return True
    return _navigation_journey_definition(entry, action_id) is not None


def _deferred_choice(
    slots: dict[str, Any], journey: dict[str, Any]
) -> tuple[dict[str, Any], str | None]:
    """Separate the volatile next-screen choice from normal action slots."""
    clean_slots = {
        key: value for key, value in (slots or {}).items() if key != "deferred_action_id"
    }
    raw = (slots or {}).get("deferred_action_id")
    deferred_action_id = str(raw or "").strip() or None
    if deferred_action_id and deferred_action_id not in journey["choice_action_ids"]:
        return clean_slots, ""
    return clean_slots, deferred_action_id


async def _start_settled_journey(
    action_id: str,
    slots: dict[str, Any],
    tool_context: ToolContext,
    entry: dict[str, Any],
    journey: dict[str, Any],
) -> dict[str, Any]:
    """Execute one current action and park only an eligible destination choice."""
    action_slots, deferred_action_id = _deferred_choice(slots, journey)
    if deferred_action_id == "":
        return {
            "status": "invalid_choice",
            "message": "That next-screen choice is not authorized by this journey.",
        }
    if deferred_action_id and not journey["carry_explicit_choice"]:
        return {
            "status": "invalid_choice",
            "message": "This journey does not carry a choice between screens.",
        }

    result = await run_app_action(action_id, action_slots, tool_context)
    if result.get("status") == "use_start_app_goal":
        # We ARE start_app_goal. Forwarding its "call start_app_goal" redirect
        # would bounce the model straight back here forever, so collapse it to
        # the honest terminal status: this journey's own first step is not
        # mounted on the current screen, so the journey cannot begin.
        return {
            "status": "action_unavailable",
            "message": (
                f"'{action_id}' cannot start from this screen. "
                "Call list_app_actions for the controls currently available."
            ),
        }
    # `ready_to_run` joins these: it is the same successfully-parked directive
    # as `confirm_pending`, differing only in whether a confirmation gates it.
    # Omitting it here would make every allow_direct action look like a
    # failure to the journey path that calls this.
    if result.get("status") not in {"ok", "confirm_pending", "ready_to_run"}:
        return result

    pending_key = f"{_STATE_PENDING_DIRECTIVE}:{action_id}"
    pending = tool_context.state.get(pending_key)
    if not isinstance(pending, dict) or not isinstance(pending.get("payload"), dict):
        # A direct action must create the same generated directive it would
        # outside a journey.  Never invent a second browser transport path.
        return {
            "status": "settling",
            "message": "The current action is preparing. Wait for its browser directive.",
        }

    run = {
        "schema_version": "one.settled_action_journey.v1",
        "journey_id": journey["goal_id"],
        "goal_id": journey["goal_id"],
        "source_action_id": action_id,
        "settlement_target": journey["settlement_target"],
        "choice_action_ids": journey["choice_action_ids"],
        # This is the sole carried user intent. It is an already-authored id,
        # never speech, slots, a credential, or a durable workflow record.
        "deferred_action_id": deferred_action_id,
        "source_context_revision": _context_revision(tool_context),
        "status": "awaiting_destination_context",
    }
    tool_context.state[_STATE_GOAL_RUN] = run
    tool_context.state[pending_key] = {
        **pending,
        "payload": {
            **pending["payload"],
            "goalId": journey["goal_id"],
            "goalRun": run,
        },
    }
    return {
        "status": "journey_started",
        "message": "Opening the next screen before continuing.",
        "goal_id": journey["goal_id"],
        "deferred_choice": bool(deferred_action_id),
    }


async def start_app_goal(
    action_id: str, slots: dict[str, Any], tool_context: ToolContext
) -> dict[str, Any]:
    """Start a generated cross-surface app goal.

    Direct actions remain bound to mounted controls.  Explicit generated
    journeys add exactly one safe continuation: execute a current-screen
    action, wait for its authored destination context, then make a named
    destination action eligible.  No planner or alternate browser executor is
    introduced here.
    """
    clean_id = str(action_id or "").strip()
    entry = get_action_gateway_action(clean_id)
    # Checked here, before either journey branch below, because both bypass
    # run_app_action entirely -- a settled journey never reaches it, and a
    # navigation journey only reaches it (via the non-journey fallthrough)
    # after parking its own navigation directive first. One check here covers
    # both; the plain run_app_action call further down repeats it harmlessly.
    goal_voice_settings = _voice_settings(tool_context)
    if is_voice_entirely_disabled(goal_voice_settings):
        logger.info("one_adk_goal_decision action=%s status=domain_disabled domain=all", clean_id)
        return {
            "status": "domain_disabled",
            "message": (
                "Voice control is turned off in your settings. Turn it back on "
                "in Profile, Preferences, Voice, or do this by tap instead."
            ),
        }
    voice_domain = resolve_voice_domain(clean_id)
    if is_voice_domain_disabled(voice_domain, goal_voice_settings.get("disabled_domains")):
        logger.info(
            "one_adk_goal_decision action=%s status=domain_disabled domain=%s",
            clean_id,
            voice_domain,
        )
        return {
            "status": "domain_disabled",
            "message": (
                f"Voice control is turned off for {voice_domain_label(voice_domain)} "
                "in your settings. Turn it back on in Profile, Preferences, Voice, "
                "or do this by tap instead."
            ),
        }
    if entry is not None:
        journey = _settled_journey_definition(entry, clean_id)
        if journey is not None:
            return await _start_settled_journey(clean_id, slots, tool_context, entry, journey)
    navigation_journey = (
        _navigation_journey_definition(entry, clean_id) if entry is not None else None
    )
    if navigation_journey is None:
        return await run_app_action(clean_id, slots, tool_context)
    goal_id = navigation_journey["goal_id"]
    destination_screen = navigation_journey["destination_screen"]
    # Every early return below refuses the journey before a single directive
    # exists, so the relay log stayed completely silent on them. "One never
    # tried" and "One tried and the app turned it away" then looked identical
    # -- both an empty log -- which is not a distinction that can be guessed
    # from the person's side of a voice session.
    missing = _missing_required_slot(entry or {}, slots or {})
    if missing is not None:
        logger.info(
            "one_adk_goal_decision goal=%s action=%s status=input_needed slot=%s",
            goal_id,
            clean_id,
            missing["slot"],
        )
        return {
            "status": "input_needed",
            "missing_slot": missing["slot"],
            "message": missing["prompt"],
        }
    journey_slots = _journey_slots(entry or {}, slots or {})
    context = _voice_context(tool_context)
    if not isinstance(context, dict) or context.get("context_pending") is True:
        logger.info(
            "one_adk_goal_decision goal=%s action=%s status=context_not_ready", goal_id, clean_id
        )
        return {
            "status": "context_not_ready",
            "message": "The app is still publishing its screen state. Please try again in a moment.",
        }
    if context.get("pending_settlement") is True:
        logger.info("one_adk_goal_decision goal=%s action=%s status=settling", goal_id, clean_id)
        return {
            "status": "settling",
            "message": "The previous action is still settling. Wait for the fresh screen state.",
        }

    current_screen = str(context.get("screen") or "")
    # Asking for the action while already ON its destination needs no
    # navigation, so there is no incoming context to wait for.
    already_on_destination = current_screen == destination_screen
    run = {
        "schema_version": "one.goal_run.v1",
        "goal_id": goal_id,
        "action_id": clean_id,
        # Bounded, non-sensitive action slots declared by the action's own
        # generated goal contract. Nothing outside that schema is carried.
        "slots": journey_slots,
        "step_cursor": 0,
        "expected_screen": destination_screen,
        # This revision exists so continue_app_goal refuses to act on the
        # OUTGOING screen's context after a navigation. With no navigation,
        # stamping the current revision made that guard compare the value
        # against itself and settle forever -- "analyse Nvidia" from the
        # Analysis tab could never start, and retrying could never clear it
        # because nothing was coming to change the revision. Leaving it empty
        # stands the guard down for exactly the case it does not police.
        "expected_context_revision": (
            "" if already_on_destination else _context_revision(tool_context)
        ),
        "status": "awaiting_destination_screen",
    }
    tool_context.state[_STATE_GOAL_RUN] = run
    if already_on_destination:
        return await continue_app_goal(tool_context)

    navigation_action_id = navigation_journey["navigation_action_id"]
    navigation_flags = _directive_flags(
        get_action_gateway_action(navigation_action_id),
        require_tap_confirmation=_voice_settings(tool_context).get("require_tap_confirmation")
        is True,
    )
    tool_context.state[f"{_STATE_PENDING_DIRECTIVE}:goal:{goal_id}"] = {
        "kind": "action",
        "payload": {
            "actionId": navigation_action_id,
            "slots": {},
            **navigation_flags,
            "goalId": goal_id,
            "goalRun": run,
        },
    }
    # This navigation is indistinguishable from a bare route.* directive in the
    # relay log -- both surface as the same route action. Without this line
    # there is no way to tell "One started the journey" from "One just
    # navigated and gave up", which is exactly the failure being chased.
    logger.info(
        "one_adk_goal_decision goal=%s action=%s status=navigation_started",
        goal_id,
        clean_id,
    )
    return {
        "status": "navigation_started",
        "message": (
            f"Opening the {destination_screen.replace('_', ' ')} screen, then I will continue."
        ),
        "goal_id": goal_id,
    }


async def _continue_settled_journey(
    run: dict[str, Any], tool_context: ToolContext
) -> dict[str, Any]:
    """Make an authored choice eligible only on its accepted destination."""
    context = _voice_context(tool_context)
    if not isinstance(context, dict) or context.get("context_pending") is True:
        return {"status": "settling", "message": "Waiting for the destination screen."}
    expected = run.get("settlement_target")
    expected = expected if isinstance(expected, dict) else {}
    if (
        context.get("pending_settlement") is True
        or str(context.get("route_pattern") or "") != str(expected.get("route") or "")
        or str(context.get("screen") or "") != str(expected.get("screen") or "")
    ):
        tool_context.state[_STATE_GOAL_RUN] = None
        return {
            "status": "journey_interrupted",
            "message": "The destination changed, so the pending choice was cleared.",
        }
    source_revision = str(run.get("source_context_revision") or "")
    current_revision = _context_revision(tool_context)
    if source_revision and source_revision == current_revision:
        return {"status": "settling", "message": "Waiting for fresh destination context."}
    available = _available_action_ids(tool_context) or set()
    allowed_choices = {
        str(value).strip()
        for value in (run.get("choice_action_ids") or [])
        if isinstance(value, str) and str(value).strip()
    }
    if not allowed_choices or not allowed_choices.issubset(available):
        tool_context.state[_STATE_GOAL_RUN] = None
        return {
            "status": "journey_interrupted",
            "message": "The destination does not expose this journey's authorized choices.",
        }
    deferred_action_id = str(run.get("deferred_action_id") or "").strip()
    if not deferred_action_id:
        tool_context.state[_STATE_GOAL_RUN] = None
        return {
            "status": "choice_needed",
            "message": "The destination is ready. Ask the person to choose one available option.",
            "action_ids": sorted(allowed_choices),
        }
    # Clear before issuing the confirmation directive. The action itself still
    # performs current-surface and trusted-activation validation.
    tool_context.state[_STATE_GOAL_RUN] = None
    return await run_app_action(deferred_action_id, {}, tool_context)


async def continue_app_goal(tool_context: ToolContext) -> dict[str, Any]:
    """Continue an authored goal only after fresh route context has settled."""
    run = tool_context.state.get(_STATE_GOAL_RUN)
    if isinstance(run, dict) and run.get("schema_version") == "one.settled_action_journey.v1":
        return await _continue_settled_journey(run, tool_context)
    # Every outcome below is logged with a distinct reason. A stalled journey
    # ("it opened Analysis and then nothing happened") is indistinguishable
    # from a never-started one in the relay log, because both end at the same
    # route.kai_analysis settlement. The reason tag is what separates "One
    # never continued" from "One continued but the screen was not ready yet".
    if (
        not isinstance(run, dict)
        or run.get("schema_version") != "one.goal_run.v1"
        or not str(run.get("goal_id") or "").strip()
    ):
        logger.info("one_adk_goal_decision status=no_active_goal")
        return {"status": "no_active_goal", "message": "There is no app goal waiting to continue."}
    goal_id = str(run["goal_id"])
    journey_action_id = str(run.get("action_id") or "").strip()
    destination_screen = str(run.get("expected_screen") or "").strip()
    context = _voice_context(tool_context)
    if not isinstance(context, dict) or context.get("context_pending") is True:
        logger.info("one_adk_goal_decision status=settling reason=context_pending")
        return {"status": "settling", "message": "Waiting for fresh destination context."}
    if (
        context.get("pending_settlement") is True
        or str(context.get("screen") or "") != destination_screen
    ):
        logger.info(
            "one_adk_goal_decision status=settling reason=screen_not_settled screen=%s",
            str(context.get("screen") or "")[:64],
        )
        return {"status": "settling", "message": "Waiting for the destination screen to settle."}
    expected_revision = str(run.get("expected_context_revision") or "")
    current_revision = _context_revision(tool_context)
    if (
        expected_revision
        and current_revision
        and expected_revision == current_revision
        and run.get("step_cursor") == 0
    ):
        logger.info("one_adk_goal_decision status=settling reason=stale_context_revision")
        return {"status": "settling", "message": "Waiting for a fresh destination context."}

    # The preview is minted exactly once per goal. Without this, every later
    # continue_app_goal call re-minted a fresh analysis.start directive: the
    # staleness guard above only inspects step_cursor 0, so once the preview
    # had started there was nothing left to stop the loop, and the person got
    # a new confirmation card every turn while none of them could complete.
    if run.get("step_cursor", 0) >= 1:
        logger.info("one_adk_goal_decision goal=%s status=preview_already_open", goal_id)
        return {
            "status": "preview_already_open",
            # SAY NOTHING is the whole point of this branch, and the previous
            # wording said the opposite: "Ask the person to confirm it there"
            # instructed One to speak on a call whose only meaning is that it
            # already spoke. Reported as the agent repeating its line when
            # picking a person -- One called continue_app_goal twice, and the
            # second answer told it to ask again, so it did.
            #
            # This is a tool RETURN, so it reaches the model where its turn
            # already ends. Do not solve repetition by injecting content into
            # a live turn: that preempts One mid-sentence and loops.
            "message": (
                "Already done and waiting on the person -- this call changed "
                "nothing. Say nothing at all and do not repeat your question; "
                "you have already asked it and they have heard you. Wait for "
                "the settlement."
            ),
            "goal_id": goal_id,
        }

    slots = run.get("slots") if isinstance(run.get("slots"), dict) else {}
    action_flags = _directive_flags(
        get_action_gateway_action(journey_action_id),
        require_tap_confirmation=_voice_settings(tool_context).get("require_tap_confirmation")
        is True,
    )
    next_run = {
        **run,
        "step_cursor": 1,
        "expected_context_revision": current_revision,
        "status": "preview_started",
    }
    tool_context.state[_STATE_GOAL_RUN] = next_run
    tool_context.state[f"{_STATE_PENDING_DIRECTIVE}:goal:{goal_id}:preview"] = {
        "kind": "action",
        "payload": {
            "actionId": journey_action_id,
            "slots": slots,
            **action_flags,
            "goalId": goal_id,
            "goalRun": next_run,
        },
    }
    logger.info(
        "one_adk_goal_decision goal=%s action=%s status=preview_started",
        goal_id,
        journey_action_id,
    )
    return {
        "status": "preview_started",
        "message": (
            "The journey's step is open on the screen. It waits for the person's confirmation."
        ),
        "goal_id": goal_id,
    }


def _query_tokens(query: str) -> list[str]:
    """Unicode-normalized word tokens from a model query, bounded and deduplicated.

    Delegates to the shared semantic-retrieval normalizer so Hindi and Hinglish
    words are preserved.  Falls back to a whitespace split on transient retrieval
    errors so the caller still gets a token list.
    """
    try:
        normalized = action_retrieval._normalize_query(query)  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001 - graceful degradation
        normalized = str(query or "")
    tokens: list[str] = []
    for raw in re.split(r"\s+", normalized):
        token = raw.strip()
        if len(token) < 2 or token in _QUERY_STOPWORDS or token in tokens:
            continue
        tokens.append(token)
        if len(tokens) >= _MAX_QUERY_TOKENS:
            break
    return tokens


def _relevance_score(entry: dict[str, Any], tokens: list[str]) -> int:
    """Deprecated: lexical overlap score.

    Retained only as a fallback signal.  Semantic retrieval via
    ``action_retrieval.search_actions`` is the primary ranking path; this
    function always returns 0 so callers do not accidentally use it as a
    decision gate.
    """
    return 0


def _reachability(
    entry: dict[str, Any],
    action_id: str,
    available_action_ids: set[str] | None,
) -> tuple[str, str | None]:
    """How One could actually reach ``action_id`` from where it is standing.

    Discovery is not authority: ``run_app_action`` still refuses anything the
    browser has not declared. What this adds is an honest next step, so an
    off-screen answer becomes "open X first" instead of a dead end.
    """
    if available_action_ids is None or action_id in available_action_ids:
        return "on_screen", None
    if is_navigation_action(entry):
        return "on_screen", None
    if _is_journey_startable(entry):
        return "journey", None
    for route in (entry.get("reachability") or {}).get("routes") or []:
        navigation_action_id = _navigation_action_for_route(str(route))
        if navigation_action_id:
            return "navigate_first", navigation_action_id
    return "unreachable_from_here", None


async def list_app_actions(query: str, tool_context: ToolContext) -> dict[str, Any]:
    """List generated actions One can reach from the active app context.

    Uses semantic retrieval (embedding + RRF fusion) for natural-language
    queries so that meaning-based matches surface even when the query shares
    no words with an action's label or aliases.  An empty query still returns
    the screen-available actions as a bounded context window.

    Execution authority is unchanged. Everything here is still filtered by the
    generated manifest, and ``run_app_action`` still refuses any action the
    browser has not declared on the current screen.
    """
    available_action_ids = _available_action_ids(tool_context)

    semantic_results: list[RetrievedAction] = []
    if query and str(query).strip():
        # Semantic retrieval path: natural-language query.  ``search_actions``
        # ranks against the generated catalog, so it takes the gateway - not
        # the ToolContext, which carries live screen state instead.
        try:
            # Must be the SAME filtered catalog that resolves results below.
            # load_action_gateway() is unfiltered; list_action_gateway_actions()
            # drops CRM actions when the CRM product is off. Passing the
            # unfiltered one lets CRM hits consume result slots and then vanish
            # at resolution, returning fewer actions than One asked for.
            semantic_results = search_actions(query, {"actions": list_action_gateway_actions()})
        except Exception:  # noqa: BLE001 - graceful degradation to local
            logger.exception("semantic_retrieval_failed")
            semantic_results = []

    selected: list[RetrievedAction] = []

    if semantic_results:
        # Retrieval ranks against the catalog and cannot see the live screen,
        # so recompute reachability here where the browser-declared ids exist.
        for item in semantic_results:
            entry = get_action_gateway_action(item.action_id) or {}
            availability, open_first = _reachability(entry, item.action_id, available_action_ids)
            # Same filter the lexical branch applies. A dead-end action has no
            # next step for One to take: offering it produces a list -> run ->
            # refused -> list loop rather than an answer.
            if availability == "unreachable_from_here":
                continue
            selected.append(
                dataclasses.replace(
                    item,
                    availability=availability,
                    navigation=({"open_first_action_id": open_first} if open_first else None),
                )
            )
    else:
        # Fallback: list wired actions filtered by reachability (lexical path).
        candidates: list[tuple[int, str, dict[str, Any], str, str | None]] = []
        for entry in list_action_gateway_actions():
            if (entry.get("execution_target") or {}).get("status") != "wired":
                continue
            action_id = str(entry.get("action_id") or "")
            if not action_id:
                continue
            availability, open_first = _reachability(entry, action_id, available_action_ids)
            if availability == "unreachable_from_here":
                continue
            candidates.append(
                (
                    _AVAILABILITY_ORDER.get(availability, 9),
                    str(entry.get("label") or ""),
                    entry,
                    availability,
                    open_first,
                )
            )

        # Degraded path: the embedding model is unavailable, so rank by the
        # query lexically rather than returning a query-blind list.  Sorting
        # only by (availability, label) drops the action a person actually
        # asked for outside the truncation window -- One then cannot see it at
        # all.  This is a ranking signal, never an execution decision.
        if query and str(query).strip():
            candidates.sort(
                key=lambda item: (
                    -lexical_score(item[2], str(query)),
                    item[0],
                    item[1],
                )
            )
        else:
            candidates.sort(key=lambda item: (item[0], item[1]))
        selected = [
            RetrievedAction(
                action_id=str(entry.get("action_id") or ""),
                score=0.0,
                source="lexical",
                meaning=str(entry.get("meaning") or ""),
                semantic_boundaries=None,
                required_inputs={
                    spec.get("slot", ""): spec
                    for spec in (entry.get("goal") or {}).get("required_inputs", [])
                    if isinstance(spec, dict)
                },
                policy=str(entry.get("execution_policy") or "allow_direct"),
                availability=availability,
                navigation=({"open_first_action_id": open_first} if open_first else None),
                goal=entry.get("goal"),
            )
            for _, _, entry, availability, open_first in candidates[:_MAX_LIST_RESULTS]
        ]

    # Build a lookup from action_id to entry for tool/availability resolution.
    all_entries: dict[str, dict[str, Any]] = {
        str(e.get("action_id") or ""): e for e in list_action_gateway_actions()
    }

    results = []
    for ra in selected:
        action_entry = all_entries.get(ra.action_id)
        if action_entry is None:
            continue

        delegate_tool = _DELEGATE_TOOL_BY_AGENT_ID.get(
            str(action_entry.get("delegate_agent_id") or "")
        )
        use_tool = delegate_tool or (
            "start_app_goal" if _is_journey_startable(action_entry) else "run_app_action"
        )
        availability = ra.availability if isinstance(ra.availability, str) else "on_screen"

        result_dict: dict[str, Any] = {
            "action_id": ra.action_id,
            "label": str(action_entry.get("label") or ""),
            "meaning": ra.meaning,
            "policy": ra.policy,
            "availability": availability,
            **({"use_tool": use_tool} if use_tool else {}),
        }
        if ra.semantic_boundaries:
            result_dict["semantic_boundaries"] = ra.semantic_boundaries
        nav = ra.navigation
        if isinstance(nav, dict) and nav.get("open_first_action_id"):
            result_dict["open_first_action_id"] = nav["open_first_action_id"]
        results.append(result_dict)

    payload: dict[str, Any] = {
        "status": "ok",
        "total_actions": len(list_action_gateway_actions()),
        "results": results,
    }
    # Say so when ranking is lexical-only. Without this the degraded path is
    # indistinguishable from a working one -- the same invisibility that let
    # the original retrieval bug ride into production looking healthy.
    if query and str(query).strip() and not is_retrieval_available():
        payload["ranking"] = "lexical_only"
        payload["ranking_degraded_reason"] = retrieval_error() or "unavailable"
    return payload


async def list_available_models(tool_context: ToolContext) -> dict[str, Any]:
    """List the models this agent can run on, which one the owner picked, and which is running.

    The catalog is server-side, so the choices are whatever the deployment can actually
    serve rather than anything the model believes exists.
    """
    user_id, blocked = await _read_tool_user_id(tool_context)
    if blocked is not None:
        return blocked
    if user_id is None:
        return {"status": "blocked", "message": "Sign in to see which models are available."}
    try:
        from hushh_mcp.services.model_preference_service import get_preference

        preference = await get_preference(user_id=user_id)
    except Exception:
        logger.exception("list_available_models failed")
        return {"status": "error", "message": "Could not read the available models."}
    return {
        "status": "ok",
        "models": [
            {
                "model": choice["label"],
                "model_id": choice["model_id"],
                "running_now": choice["is_active"],
                "default": choice["is_default"],
            }
            for choice in preference["choices"]
        ],
        "chosen_by_owner": preference["selected_model"] is not None,
        "running_now": preference["effective_model"],
    }


async def set_preferred_model(model_id: str, tool_context: ToolContext) -> dict[str, Any]:
    """Set the model this owner's agent runs on. Pass an empty string to follow the default again.

    Takes effect on the owner's next message; nothing is redeployed and no other person
    is affected. A model outside the served catalog is refused with the list that is.
    """
    user_id, blocked = await _read_tool_user_id(tool_context)
    if blocked is not None:
        return blocked
    if user_id is None:
        return {"status": "blocked", "message": "Sign in to choose a model."}
    try:
        from hushh_mcp.services.model_preference_service import (
            ModelPreferenceError,
            set_preference,
        )

        preference = await set_preference(user_id=user_id, model_id=model_id)
    except ModelPreferenceError as exc:
        return {"status": "rejected", "message": str(exc)}
    except Exception:
        logger.exception("set_preferred_model failed")
        return {"status": "error", "message": "Could not change the model."}
    return {
        "status": "ok",
        "running_now": preference["effective_model"],
        "following_default": preference["selected_model"] is None,
        "takes_effect": "next_message",
    }
