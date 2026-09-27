"""Canonical AG-UI transport for the private agent's text experience."""

from __future__ import annotations

import hashlib
import json
import logging
import re
import uuid
from typing import Any

from ag_ui.core import RunAgentInput
from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint
from ag_ui_adk.request_state_service import RequestStateSessionService
from ag_ui_adk.session_manager import SessionManager
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from google.adk.apps import App, ResumabilityConfig
from google.adk.events import Event
from google.adk.sessions import InMemorySessionService
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from api.middleware import require_vault_owner_token
from api.middlewares.chat_key import (
    CHAT_KEY_REQUIRED_DETAIL,
    log_chat_key_refusal,
    require_vault_owner_chat_key,
)
from api.routes.one.agent_context import sanitize_agent_context
from api.utils.firebase_auth import verify_firebase_bearer
from hushh_mcp.one_adk.agent_tree import (
    ONE_APP_NAME,
    STATE_CONSENT_TOKEN,
    STATE_CONVERSATION_ID,
    STATE_DRIVE_SEARCH_SELECTION,
    STATE_GMAIL_INFORMATION_REQUEST_CONTEXT,
    STATE_GMAIL_INFORMATION_REQUEST_WORKFLOW_ID,
    STATE_PKM_CONTEXT,
    STATE_SCREEN,
    STATE_TIMEZONE,
    STATE_USER_ID,
    STATE_VOICE_CONTEXT,
    build_one_intro_text_agent,
    build_one_text_agent,
)
from hushh_mcp.one_adk.agui_action_tools import action_id_from_tool_name
from hushh_mcp.one_adk.agui_turn_timing import HEAD_INTRO, HEAD_ONE, TimedADKAgent
from hushh_mcp.one_adk.consent_continuation import (
    CONSENT_OUTCOME_LABELS,
    ConsentContinuationError,
    admit_consent_continuation,
    continued_outcomes,
)
from hushh_mcp.one_adk.drive_result_privacy import _safe_result as safe_connector_result
from hushh_mcp.one_adk.encrypted_session_service import EncryptedAdkSessionService
from hushh_mcp.one_adk.external_read_boundary import READ_TOOLS, STATE_EXECUTION_SURFACE
from hushh_mcp.one_adk.external_read_projection import redacted_read_receipt
from hushh_mcp.one_adk.mcp_call_approval import STATE_MCP_APPROVAL, admit_resume_receipt
from hushh_mcp.one_adk.mcp_turn_scope import STATE_MCP_CONFIGURATION, admit_turn_configurations
from hushh_mcp.one_adk.pending_email_draft import (
    STATE_PENDING_EMAIL_DRAFT,
    admit_pending_email_draft,
)
from hushh_mcp.one_adk.request_secrets import consume_request_secret, store_request_secret
from hushh_mcp.one_adk.text_attachments import history_text_attachments
from hushh_mcp.one_adk.turn_completion import (
    newest_turn_answered,
    newest_turn_pending,
    notify_one_reply,
)
from hushh_mcp.one_adk.turn_location import STATE_TURN_LOCATION, admit_turn_location
from hushh_mcp.one_adk.workspace_mcp_tools import WORKSPACE_CHAT_ADMISSION_STATE
from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError
from hushh_mcp.services.action_gateway import get_action_gateway_action, list_action_gateway_actions
from hushh_mcp.services.chat_key import request_has_chat_key
from hushh_mcp.services.external_mcp_client import ExternalMcpError
from hushh_mcp.services.gmail_personal_information_request_service import (
    PersonalGmailInformationRequestError,
    get_personal_gmail_information_request_service,
)
from hushh_mcp.services.information_request_service import (
    InformationRequestError,
    InformationRequestService,
)
from hushh_mcp.services.person_profile_service import PersonProfileService

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Agent One"])


def _user_id(input_data: RunAgentInput) -> str:
    state = input_data.state if isinstance(input_data.state, dict) else {}
    value = str(state.get(STATE_USER_ID) or "").strip()
    if not value:
        raise ValueError("Authenticated Agent One user is missing.")
    return value


async def _admit_drive_search_selection(
    selection: object,
    *,
    request: Request,
    authorization: str | None,
    consent_header: str | None,
    owner_id: str,
    content_authorized: bool = False,
    share_authorized: bool = False,
) -> str:
    """Bound the untrusted pointer; the tool verifies owner and live Drive later."""
    if selection is None:
        return ""
    if (
        not owner_id
        or not isinstance(selection, dict)
        or set(selection) != {"jobId", "position"}
        or not isinstance(selection.get("jobId"), str)
        or type(selection.get("position")) is not int
        or not 1 <= selection["position"] <= 10000
    ):
        raise HTTPException(status_code=400, detail="Selected Drive result is invalid.")
    try:
        job_id = str(uuid.UUID(selection["jobId"]))
    except ValueError:
        raise HTTPException(status_code=400, detail="Selected Drive result is invalid.") from None

    async def require_current() -> None:
        try:
            current = await require_vault_owner_token(
                request=request,
                authorization=authorization,
                hushh_consent=consent_header,
            )
        except HTTPException:
            raise PermissionError("owner session changed") from None
        if str(current.get("user_id") or "") != owner_id:
            raise PermissionError("owner session changed")

    try:
        await require_current()
    except PermissionError:
        raise HTTPException(
            status_code=403, detail="Unlock One to use this Drive result."
        ) from None
    # Only the opaque lookup pointer crosses into the turn. One may pause on a
    # reviewed action for ten minutes, so cleanup is scheduled just after it.
    return store_request_secret(
        json.dumps(
            {
                "jobId": job_id,
                "position": selection["position"],
                "contentAllowed": content_authorized is True,
                "shareAllowed": share_authorized is True,
            }
        ),
        ttl_seconds=660,
    )


def _current_user_text(input_data: RunAgentInput) -> str:
    messages = input_data.messages
    last = messages[-1] if messages else None
    if getattr(last, "role", None) != "user":
        return ""
    text = getattr(last, "content", None)
    if isinstance(text, list):
        # A turn with a pasted attachment: only the typed text parts are the
        # person's request. The attachment is content, never an instruction.
        text = "\n".join(
            value
            for item in text
            if getattr(item, "type", None) == "text"
            and isinstance((value := getattr(item, "text", None)), str)
        )
    if not isinstance(text, str) or len(text) > 2048:
        return ""
    return text


def _selected_content_authorized(input_data: RunAgentInput) -> bool:
    """Only an explicit current owner request can authorize a selected-file export."""
    text = _current_user_text(input_data)
    return bool(
        re.match(
            r"^\s*(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?"
            r"(?:read\b|summari[sz]e\b|show\s+(?:me\s+)?(?:the\s+)?(?:contents?|text)\b|"
            r"what\s+(?:does\s+(?:this|the)\s+(?:file|document)\s+say|is\s+in\s+(?:this|the)\s+(?:file|document)))",
            text,
            re.IGNORECASE,
        )
    )


def _selected_share_authorized(input_data: RunAgentInput) -> bool:
    """Untrusted file metadata cannot induce an unasked-for share draft."""
    return bool(
        re.match(
            r"^\s*(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?"
            r"(?:share\b|send\s+(?:this|the)\s+(?:file|document)\b)",
            _current_user_text(input_data),
            re.IGNORECASE,
        )
    )


async def _extract_state(request: Request, input_data: RunAgentInput) -> dict[str, Any]:
    authorization = request.headers.get("authorization")
    consent_header = request.headers.get("x-hushh-consent")
    token: dict[str, Any] | None = None
    try:
        token = await require_vault_owner_token(
            request=request,
            authorization=authorization,
            hushh_consent=consent_header,
        )
    except HTTPException:
        token = None
    firebase_uid = ""
    if token is None and authorization:
        try:
            firebase_uid = await run_in_threadpool(verify_firebase_bearer, authorization)
        except HTTPException:
            firebase_uid = ""
    forwarded = input_data.forwarded_props if isinstance(input_data.forwarded_props, dict) else {}
    screen_payload = forwarded.get("screenContext")
    screen_context = sanitize_agent_context(
        screen_payload if isinstance(screen_payload, dict) else {}
    )

    # Client-provided tools are frontend execution requests, never new
    # authority. Every tool must already exist in the generated Action Gateway.
    for tool in input_data.tools:
        action_id = action_id_from_tool_name(tool.name)
        if not action_id or get_action_gateway_action(action_id) is None:
            raise HTTPException(
                status_code=400, detail="Agent tool is not in the generated action contract."
            )

    # Discard arbitrary client state before the middleware merges the trusted
    # projection. Sensitive values are represented only by expiring references.
    input_data.state = {}
    anonymous_seed = (
        f"{request.client.host if request.client else ''}|{request.headers.get('user-agent', '')}"
    )
    user_id = str((token or {}).get("user_id") or firebase_uid).strip()
    if token and user_id:
        # Durable history is sealed with the owner's chat key. Refuse before any
        # stream starts rather than failing mid-turn or reading without it.
        if not request_has_chat_key(user_id):
            log_chat_key_refusal(request, "CHAT_KEY_REQUIRED", owner_id=user_id)
            raise HTTPException(
                status_code=403,
                detail={"message": CHAT_KEY_REQUIRED_DETAIL, "code": "CHAT_KEY_REQUIRED"},
            )
        if input_data.thread_id and await _session_service.is_legacy_session(
            app_name=ONE_APP_NAME, user_id=user_id, session_id=input_data.thread_id
        ):
            raise HTTPException(
                status_code=409,
                detail={
                    "message": "This conversation is no longer available. Start a new chat.",
                    "code": "CHAT_CONVERSATION_RETIRED",
                },
            )
    drive_search_selection = await _admit_drive_search_selection(
        forwarded.get("driveSearchSelection"),
        request=request,
        authorization=authorization,
        consent_header=consent_header,
        owner_id=user_id if token else "",
        content_authorized=_selected_content_authorized(input_data),
        share_authorized=_selected_share_authorized(input_data),
    )
    forwarded.pop("driveSearchSelection", None)
    try:
        mcp_approval = admit_resume_receipt(
            forwarded, owner_id=user_id if token else "", conversation_id=input_data.thread_id
        )
    except ActionDirectiveAuthorityError:
        raise HTTPException(
            status_code=403,
            detail="Connector confirmation is unavailable. Unlock and review again.",
        ) from None
    session_user_id = (
        user_id or f"anonymous:{hashlib.sha256(anonymous_seed.encode()).hexdigest()[:24]}"
    )
    workflow_id = str(forwarded.get("gmailInformationRequestWorkflowId") or "").strip()
    if workflow_id and (len(workflow_id) > 128 or not re.fullmatch(r"[A-Za-z0-9-]+", workflow_id)):
        raise HTTPException(status_code=400, detail="Selected Gmail request is invalid.")
    gmail_information_request_context = ""
    if workflow_id:
        if not token or not user_id:
            raise HTTPException(
                status_code=403,
                detail="Unlock your vault before replying to the selected Gmail request.",
            )
        try:
            gmail_information_request_context = (
                await get_personal_gmail_information_request_service().get_chat_reply_context(
                    user_id=user_id,
                    workflow_id=workflow_id,
                )
            )
        except PersonalGmailInformationRequestError as exc:
            logger.info(
                "one.gmail_information_request_context_unavailable code=%s",
                exc.code,
            )
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001 - do not surface provider details to chat
            logger.warning(
                "one.gmail_information_request_context_failed error=%s", type(exc).__name__
            )
            raise HTTPException(
                status_code=503,
                detail="The selected Gmail request is temporarily unavailable. Please try again.",
            ) from exc
    try:
        mcp_configuration = admit_turn_configurations(
            forwarded, owner_id=user_id if token else "", conversation_id=input_data.thread_id
        )
    except ExternalMcpError:
        raise HTTPException(
            status_code=403, detail="Connector configuration is unavailable. Unlock and try again."
        ) from None
    consent_continuation = await _admit_consent_continuation(
        forwarded, input_data=input_data, owner_id=user_id if token else ""
    )
    # The device sends a coarse position only when the person already granted
    # location; pre-vault turns never keep it.
    turn_location = admit_turn_location(forwarded)
    # The person's unsent draft card, so a follow-up can revise it. Only an
    # unlocked owner turn keeps it; it never becomes conversation state.
    pending_email_draft = admit_pending_email_draft(forwarded)
    if not (token and user_id):
        consume_request_secret(turn_location)
        turn_location = ""
        consume_request_secret(pending_email_draft)
        pending_email_draft = ""
    return {
        STATE_EXECUTION_SURFACE: "typed_chat",
        STATE_TURN_LOCATION: turn_location,
        STATE_MCP_CONFIGURATION: mcp_configuration,
        STATE_MCP_APPROVAL: mcp_approval,
        WORKSPACE_CHAT_ADMISSION_STATE: bool(token and user_id),
        STATE_USER_ID: session_user_id,
        STATE_CONSENT_TOKEN: store_request_secret(str((token or {}).get("token") or "")),
        STATE_CONVERSATION_ID: input_data.thread_id,
        STATE_TIMEZONE: str(forwarded.get("timezone") or "")[:64],
        STATE_DRIVE_SEARCH_SELECTION: drive_search_selection,
        # This is only an untrusted selection request. The resolver validates
        # it against owner/thread-bound server-issued choices before any read.
        # A picker handle is an untrusted, current-turn admission request. The
        # ADK temp prefix keeps it out of persisted conversation state so an
        # expired selection cannot block or redirect a later typed prompt.
        "temp:hussh:requested_person_selection": str(forwarded.get("personSelectionHandle") or "")[
            :64
        ],
        # Typed chat carries the current screen snapshot in this request. It
        # must not inherit a stale live-voice publication that is still marked
        # as settling; that would suppress the consent confirmation card even
        # while the current browser frame is idle.
        "hussh:typed_chat_context": True,
        STATE_SCREEN: str(screen_context.get("screen") or "")[:64],
        STATE_VOICE_CONTEXT: screen_context,
        STATE_PKM_CONTEXT: store_request_secret(str(forwarded.get("pkmContext") or "")[:20000]),
        STATE_GMAIL_INFORMATION_REQUEST_WORKFLOW_ID: workflow_id,
        STATE_GMAIL_INFORMATION_REQUEST_CONTEXT: store_request_secret(
            gmail_information_request_context
        ),
        **consent_continuation,
        STATE_PENDING_EMAIL_DRAFT: pending_email_draft,
    }


async def _admit_consent_continuation(
    forwarded: dict[str, Any], *, input_data: RunAgentInput, owner_id: str
) -> dict[str, Any]:
    """Admit the follow-up turn that reports an owner's answer, or nothing."""
    if forwarded.get("consentContinuation") is None:
        return {}
    session = None
    if owner_id and input_data.thread_id:
        session = await _session_service.get_session(
            app_name=ONE_APP_NAME, user_id=owner_id, session_id=input_data.thread_id
        )
    session_state = dict(session.state) if session is not None else None

    def asked_here(bundle_id: str) -> bool:
        # The submission event this conversation recorded when the request was sent.
        for event in session.events if session is not None else []:
            metadata = _record(event.custom_metadata) or {}
            card = _record(metadata.get("card")) or {}
            if (
                metadata.get("kind") == "information_request_submission_v1"
                and str(card.get("bundleId") or "").lower() == bundle_id
            ):
                return True
        return False

    def person_name(person_ref: str) -> str:
        try:
            return str(PersonProfileService().get_public_profile(person_ref)["displayName"])
        except Exception:  # noqa: BLE001 - a missing name must not block the answer
            return ""

    try:
        return await admit_consent_continuation(
            forwarded,
            owner_id=owner_id,
            messages=input_data.messages,
            session_state=session_state,
            asked_here=asked_here,
            get_bundle=InformationRequestService().get,
            person_name=person_name,
        )
    except ConsentContinuationError as exc:
        logger.info("one.consent_continuation_refused status=%s", exc.status_code)
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from None
    except InformationRequestError as exc:
        logger.info("one.consent_continuation_refused status=%s", exc.status_code)
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from None


_app = App(
    name=ONE_APP_NAME,
    root_agent=build_one_text_agent(allow_workspace_tools=True, include_thought_summaries=True),
    resumability_config=ResumabilityConfig(is_resumable=True),
)
_intro_app = App(
    name=f"{ONE_APP_NAME}_intro",
    root_agent=build_one_intro_text_agent(),
    resumability_config=ResumabilityConfig(is_resumable=True),
)
_session_service = EncryptedAdkSessionService()
_intro_session_service = InMemorySessionService()


class _DurableSessionManager(SessionManager):
    """ag_ui_adk session manager without its idle-session sweeper.

    The library default re-reads every tracked session every five minutes from a
    background task, copies idle ones into an in-memory memory service, and then
    deletes them from storage twenty minutes after their last turn. For durable,
    person-key history that is both a background reader with no person present and
    a silent deletion of the person's history, so it never starts here.
    """

    def _start_cleanup_task(self) -> None:
        return None


_durable_session_manager = _DurableSessionManager(
    session_service=RequestStateSessionService(_session_service),
    delete_session_on_cleanup=False,
    save_session_to_memory_on_cleanup=False,
    use_thread_id_as_session_id=True,
)
_authenticated_capabilities = {
    "identity": {
        "name": "Agent One",
        "type": "google-adk",
        "description": "Hussh private agent",
        "version": "1.0.0",
        "provider": "Hussh",
    },
    "transport": {"streaming": True, "websocket": False, "httpBinary": False, "resumable": True},
    "tools": {"supported": True, "parallelCalls": False, "clientProvided": True},
    "state": {"snapshots": True, "deltas": True, "memory": False, "persistentState": True},
    "multiAgent": {"supported": True, "delegation": True, "handoffs": False},
    "reasoning": {"supported": True, "streaming": True, "encrypted": False},
    "humanInTheLoop": {
        "supported": True,
        "approvals": True,
        "interventions": True,
        "feedback": False,
        "interrupts": True,
        "approveWithEdits": False,
    },
}
_intro_capabilities = {
    **_authenticated_capabilities,
    "reasoning": {"supported": False, "streaming": False, "encrypted": False},
    "tools": {"supported": False, "parallelCalls": False, "clientProvided": False},
    "state": {"snapshots": True, "deltas": True, "memory": False, "persistentState": False},
    "multiAgent": {"supported": False, "delegation": False, "handoffs": False},
    "humanInTheLoop": {"supported": False, "interrupts": False},
}
# The bridge defaults to 10 concurrent executions per process, across every
# person, and keeps a slot for 600 s when a run leaves a pending tool call. Ten
# people mid-confirmation would lock the route for everyone. These bounds are
# per process, not per person; TimedADKAgent releases slots for runs that end
# in error or disconnect. Measured 2026-09-14 on localhost with the latency
# driver (agent-chat-migration-baseline).
_MAX_CONCURRENT_EXECUTIONS = 64
_EXECUTION_TIMEOUT_SECONDS = 200

_agent = TimedADKAgent.from_app(
    _app,
    head=HEAD_ONE,
    user_id_extractor=_user_id,
    max_concurrent_executions=_MAX_CONCURRENT_EXECUTIONS,
    execution_timeout_seconds=_EXECUTION_TIMEOUT_SECONDS,
    session_manager=_durable_session_manager,
    use_in_memory_services=True,
    use_thread_id_as_session_id=True,
    emit_messages_snapshot=True,
    capabilities=_authenticated_capabilities,
)
_intro_agent = TimedADKAgent.from_app(
    _intro_app,
    head=HEAD_INTRO,
    user_id_extractor=_user_id,
    max_concurrent_executions=_MAX_CONCURRENT_EXECUTIONS,
    execution_timeout_seconds=_EXECUTION_TIMEOUT_SECONDS,
    # Anonymous and Firebase-only pre-vault turns intentionally remain
    # ephemeral. Durable history begins only after VAULT_OWNER authority is
    # present, where the encrypted owner-bound store can enforce teardown.
    session_service=_intro_session_service,
    use_in_memory_services=True,
    use_thread_id_as_session_id=True,
    emit_messages_snapshot=True,
    capabilities=_intro_capabilities,
)


async def _notify_detached_turn(owner_id: str, conversation_id: str) -> None:
    """A turn finished after its client left: wake the owner's device, once.

    Runs from the turn's own background task, which still holds the chat key it
    received, so the sealed session can be read. The push carries no content.
    """
    session = await _session_service.get_session(
        app_name=ONE_APP_NAME, user_id=owner_id, session_id=conversation_id
    )
    if session is None or not newest_turn_answered(session.events):
        return
    await notify_one_reply(owner_id=owner_id, conversation_id=conversation_id)


_agent.detached_turn_hook = _notify_detached_turn


async def _resolve_agent(_request: Request, input_data: RunAgentInput) -> ADKAgent:
    state = input_data.state if isinstance(input_data.state, dict) else {}
    return _agent if state.get(STATE_CONSENT_TOKEN) else _intro_agent


add_adk_fastapi_endpoint(
    router,
    _agent,
    path="/api/one/agent-chat",
    extract_state_from_request=_extract_state,
    agent_resolver=_resolve_agent,
)


def _event_text(event: Any) -> str:
    from hushh_mcp.one_adk.output_privacy import public_text

    return public_text(event)


_SAFE_PROFILE_PATH = re.compile(r"^/people/[A-Za-z0-9_-]{16,128}$")


def _record(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError):
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


def _bounded_text(value: Any, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = " ".join(value.split()).strip()
    return normalized[:limit] or None


def _safe_scope_catalog(value: Any, *, scope_count: int) -> dict[str, Any] | None:
    """Keep only bounded pagination metadata on a restored discovery card.

    The encrypted session descriptor must not become a second scope authority:
    the current page remains the only place where requestable field metadata is
    projected. These fields only let the client ask the server for the next
    page, and the server rechecks the catalog revision and current authority.
    """
    catalog = _record(value)
    if not catalog:
        return None

    def bounded_integer(raw: Any, *, minimum: int, maximum: int | None = None) -> int | None:
        if isinstance(raw, bool) or not isinstance(raw, int) or raw < minimum:
            return None
        if maximum is not None and raw > maximum:
            return None
        return int(raw)

    page = bounded_integer(catalog.get("page"), minimum=1)
    limit = bounded_integer(catalog.get("limit"), minimum=1, maximum=100)
    total_count = bounded_integer(catalog.get("totalCount"), minimum=0)
    revision = _bounded_text(catalog.get("catalogRevision"), 64)
    has_more = catalog.get("hasMore")
    next_page = catalog.get("nextPage")
    if (
        page is None
        or limit is None
        or total_count is None
        or total_count < scope_count
        or not revision
        or not re.fullmatch(r"[a-f0-9]{64}", revision)
        or not isinstance(has_more, bool)
    ):
        return None

    if has_more:
        if next_page != page + 1:
            return None
    elif next_page is not None:
        return None

    domains: list[dict[str, Any]] = []
    raw_domains = catalog.get("domains")
    if isinstance(raw_domains, list):
        for raw_domain in raw_domains[:128]:
            domain = _record(raw_domain)
            name = _bounded_text(domain.get("domain") if domain else None, 80)
            count = bounded_integer(domain.get("count") if domain else None, minimum=0)
            if name and count is not None:
                domains.append({"domain": name, "count": count})

    return {
        "page": page,
        "nextPage": next_page if has_more else None,
        "totalCount": total_count,
        "limit": limit,
        "hasMore": has_more,
        "catalogRevision": revision,
        "paginationReset": catalog.get("paginationReset") is True,
        "domains": domains,
    }


def _safe_discovery_descriptor(
    event: Any, selected_parts: list[Any] | None = None
) -> dict[str, Any] | None:
    """Project one display-safe discovery card out of an encrypted event.

    The session remains encrypted at rest. This projection is deliberately
    narrower than the tool result: it carries no personal values, email
    addresses, credentials, or executable action payloads. It exists so a
    returning owner can see the same AG-UI card without replaying the action.
    """
    parts = (
        selected_parts
        if selected_parts is not None
        else (getattr(getattr(event, "content", None), "parts", None) or [])
    )
    for part in parts:
        function_response = getattr(part, "function_response", None)
        if (
            function_response is None
            or getattr(function_response, "name", "") != "discover_person_information"
        ):
            continue
        result = _record(getattr(function_response, "response", None)) or {}
        for key in ("result", "content", "data"):
            nested = _record(result.get(key))
            if nested and (nested.get("status") == "ok" or "requestableScopes" in nested):
                result = nested
                break
        if result.get("status") != "ok":
            return None
        person = _record(result.get("person")) or {}
        display_name = _bounded_text(person.get("displayName"), 120)
        profile_path = _bounded_text(person.get("profilePath"), 180)
        if not display_name or not profile_path or not _SAFE_PROFILE_PATH.fullmatch(profile_path):
            return None
        profile_person_ref = profile_path.rsplit("/", 1)[-1]
        person_ref = _bounded_text(person.get("personRef"), 128)
        if person_ref and (
            not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", person_ref)
            or person_ref != profile_person_ref
        ):
            return None
        scopes: list[dict[str, Any]] = []
        raw_scopes = result.get("requestableScopes")
        if isinstance(raw_scopes, list):
            for raw_scope in raw_scopes[:250]:
                scope = _record(raw_scope)
                if scope is None:
                    continue
                scope_ref = _bounded_text(scope.get("scopeRef"), 180)
                label = _bounded_text(scope.get("label"), 120)
                domain = _bounded_text(scope.get("domain"), 80)
                if not scope_ref or not label or not domain:
                    continue
                sensitivity = _bounded_text(scope.get("sensitivity"), 32)
                scopes.append(
                    {
                        "scopeRef": scope_ref,
                        "label": label,
                        "description": _bounded_text(scope.get("description"), 280),
                        "domain": domain,
                        "sensitivity": sensitivity or "standard",
                        "pathSegments": [
                            value
                            for part in (scope.get("pathSegments") or [])[:32]
                            if (value := _bounded_text(part, 120))
                        ]
                        if isinstance(scope.get("pathSegments"), list)
                        else [],
                    }
                )
        scope_catalog = _safe_scope_catalog(result.get("scopeCatalog"), scope_count=len(scopes))
        return {
            "activityType": "one.scope_discovery.v1",
            "content": {
                "status": "ok",
                "person": {
                    "displayName": display_name,
                    "profilePath": profile_path,
                    **({"personRef": person_ref} if person_ref else {}),
                    "relationship": _bounded_text(person.get("relationship"), 64),
                },
                "domainFilter": _bounded_text(result.get("domainFilter"), 80),
                "requestableScopes": scopes,
                **({"scopeCatalog": scope_catalog} if scope_catalog is not None else {}),
                "catalogIncomplete": (
                    (scope_catalog is not None and scope_catalog["hasMore"])
                    or (isinstance(raw_scopes, list) and len(raw_scopes) > 250)
                ),
            },
        }
    return None


def _safe_information_request_descriptor(
    event: Any, selected_parts: list[Any] | None = None
) -> dict[str, Any] | None:
    """Project a proposal review card without retaining executable handles.

    A returning owner may see what they were preparing to ask, but a history
    descriptor must never become a replayable consent mutation. The proposal
    id, opaque scope references, connector metadata, and any values therefore
    stay in the encrypted session only; the restored card is explanatory.
    """
    parts = (
        selected_parts
        if selected_parts is not None
        else (getattr(getattr(event, "content", None), "parts", None) or [])
    )
    for part in parts:
        function_response = getattr(part, "function_response", None)
        if (
            function_response is None
            or getattr(function_response, "name", "") != "propose_information_request"
        ):
            continue
        result = _record(getattr(function_response, "response", None)) or {}
        for key in ("result", "content", "data"):
            nested = _record(result.get(key))
            if nested and nested.get("status"):
                result = nested
                break
        if result.get("status") != "proposal_ready":
            return None
        person = _record(result.get("person")) or {}
        display_name = _bounded_text(person.get("displayName"), 120)
        subject_ref = _bounded_text(person.get("personRef"), 128)
        if subject_ref and not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", subject_ref):
            subject_ref = None
        purpose = _bounded_text(result.get("purpose"), 500)
        duration_hours = result.get("durationHours")
        if (
            not display_name
            or not purpose
            or isinstance(duration_hours, bool)
            or not isinstance(duration_hours, int)
            or not 1 <= duration_hours <= 720
        ):
            return None
        raw_fields = result.get("fields")
        if not isinstance(raw_fields, list):
            return None
        fields = [
            {
                "label": label,
                "domain": "Information",
                "sensitivity": "standard",
            }
            for raw_field in raw_fields[:50]
            if (label := _bounded_text(raw_field, 120))
        ]
        if not fields:
            return None
        duration_label = (
            f"{duration_hours // 24} {'day' if duration_hours // 24 == 1 else 'days'}"
            if duration_hours % 24 == 0
            else f"{duration_hours} {'hour' if duration_hours == 1 else 'hours'}"
        )
        content = {
            "direction": "outgoing",
            "phase": "draft",
            "status": "awaiting_review",
            "personName": display_name,
            "purpose": purpose,
            "durationLabel": duration_label,
            "fields": fields,
        }
        if subject_ref:
            content["subjectRef"] = subject_ref
        return {
            "activityType": "one.information_request_review.v1",
            "content": content,
        }
    return None


def _safe_submitted_information_request_card(card: Any) -> dict[str, Any] | None:
    """Allowlist display-only submission metadata, never consent authority."""
    card = _record(card) or {}
    if (
        card.get("activityType") != "one.information_request_review.v1"
        or card.get("direction") != "outgoing"
        or card.get("phase") != "submitted"
    ):
        return None
    person_name = _bounded_text(card.get("personName"), 120)
    purpose = _bounded_text(card.get("purpose"), 500)
    duration_label = _bounded_text(card.get("durationLabel"), 100)
    status = _bounded_text(card.get("status"), 32)
    if (
        not person_name
        or not purpose
        or not duration_label
        or status
        not in {"pending", "mixed", "cancelled", "granted", "denied", "expired", "revoked"}
    ):
        return None
    raw_fields = card.get("fields")
    if not isinstance(raw_fields, list):
        return None
    fields: list[dict[str, Any]] = []
    for raw_field in raw_fields[:50]:
        field = _record(raw_field)
        if not field:
            continue
        label = _bounded_text(field.get("label"), 120)
        domain = _bounded_text(field.get("domain"), 80)
        if not label or not domain:
            continue
        projected = {
            "label": label,
            "domain": domain,
            "sensitivity": _bounded_text(field.get("sensitivity"), 32) or "standard",
        }
        request_id = _bounded_text(field.get("requestId"), 128)
        if request_id and re.fullmatch(r"[A-Za-z0-9_-]{8,128}", request_id):
            projected["requestId"] = request_id
        field_status = _bounded_text(field.get("status"), 32)
        if field_status in {"pending", "cancelled", "granted", "denied", "expired", "revoked"}:
            projected["status"] = field_status
        fields.append(projected)
    if not fields:
        return None
    content: dict[str, Any] = {
        "direction": "outgoing",
        "phase": "submitted",
        "status": status,
        "personName": person_name,
        "purpose": purpose,
        "durationLabel": duration_label,
        "fields": fields,
    }
    for key, pattern in (
        ("subjectRef", r"^[A-Za-z0-9_-]{16,128}$"),
        ("bundleId", r"^[A-Za-z0-9_-]{8,128}$"),
        ("requestId", r"^[A-Za-z0-9_-]{8,128}$"),
    ):
        value = _bounded_text(card.get(key), 128)
        if value and re.fullmatch(pattern, value):
            content[key] = value
    return {"activityType": "one.information_request_review.v1", "content": content}


def _safe_document_request_descriptor(
    event: Any, selected_parts: list[Any] | None = None
) -> dict[str, Any] | None:
    parts = (
        selected_parts
        if selected_parts is not None
        else (getattr(getattr(event, "content", None), "parts", None) or [])
    )
    for part in parts:
        response = getattr(part, "function_response", None)
        if response is None or getattr(response, "name", "") != "propose_document_request":
            continue
        result = _record(getattr(response, "response", None)) or {}
        for key in ("result", "content", "data"):
            nested = _record(result.get(key))
            if nested and nested.get("status"):
                result = nested
                break
        if result.get("status") != "proposal_ready":
            return None
        person = _record(result.get("person")) or {}
        purpose = _record(result.get("purpose")) or {}
        person_ref = _bounded_text(person.get("personRef"), 36)
        client_id = _bounded_text(result.get("clientRequestId"), 36)
        person_name = _bounded_text(person.get("displayName"), 120)
        purpose_text = _bounded_text(purpose.get("purpose"), 2000)
        if (
            not person_ref
            or not client_id
            or not person_name
            or not purpose_text
            or not re.fullmatch(r"[0-9a-f-]{36}", person_ref)
            or not re.fullmatch(r"[0-9a-f-]{36}", client_id)
        ):
            return None
        start = purpose.get("periodStart")
        end = purpose.get("periodEnd")
        if (start is None) != (end is None):
            return None
        if start is not None and (
            not isinstance(start, str)
            or not isinstance(end, str)
            or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", start)
            or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", end)
        ):
            return None
        return {
            "activityType": "one.document_request_review.v1",
            "content": {
                "personRef": person_ref,
                "personName": person_name,
                "clientRequestId": client_id,
                "purpose": purpose_text,
                "periodStart": start,
                "periodEnd": end,
            },
        }
    return None


def _safe_drive_share_descriptor(
    event: Any, selected_parts: list[Any] | None = None
) -> dict[str, Any] | None:
    """Restore the owner's Drive share card: a person and the files in words.

    It carries no file id and grants nothing; the card searches and shares
    only after the owner's own taps, through the owner-authenticated routes.
    """
    parts = (
        selected_parts
        if selected_parts is not None
        else (getattr(getattr(event, "content", None), "parts", None) or [])
    )
    for part in parts:
        response = getattr(part, "function_response", None)
        if response is None or getattr(response, "name", "") != "propose_drive_share":
            continue
        result = _record(getattr(response, "response", None)) or {}
        for key in ("result", "content", "data"):
            nested = _record(result.get(key))
            if nested and nested.get("status"):
                result = nested
                break
        if result.get("status") != "proposal_ready":
            return None
        client_id = _bounded_text(result.get("clientRequestId"), 36)
        files_request = _bounded_text(result.get("filesRequest"), 2000)
        if result.get("audience") == "trusted_circle":
            if not client_id or not files_request or not re.fullmatch(r"[0-9a-f-]{36}", client_id):
                return None
            return {
                "activityType": "one.drive_share_review.v1",
                "content": {
                    "audience": "trusted_circle",
                    "clientRequestId": client_id,
                    "filesRequest": files_request,
                },
            }
        person = _record(result.get("person")) or {}
        person_ref = _bounded_text(person.get("personRef"), 36)
        person_name = _bounded_text(person.get("displayName"), 120)
        if (
            not person_ref
            or not client_id
            or not person_name
            or not files_request
            or not re.fullmatch(r"[0-9a-f-]{36}", person_ref)
            or not re.fullmatch(r"[0-9a-f-]{36}", client_id)
        ):
            return None
        return {
            "activityType": "one.drive_share_review.v1",
            "content": {
                "personRef": person_ref,
                "personName": person_name,
                "clientRequestId": client_id,
                "filesRequest": files_request,
            },
        }
    return None


def _safe_drive_bulk_share_descriptor(
    event: Any, selected_parts: list[Any] | None = None
) -> dict[str, Any] | None:
    """Restore a review-only saved-search proposal without private file metadata."""
    parts = (
        selected_parts
        if selected_parts is not None
        else (getattr(getattr(event, "content", None), "parts", None) or [])
    )
    for part in parts:
        response = getattr(part, "function_response", None)
        if response is None or getattr(response, "name", "") != "propose_drive_bulk_share":
            continue
        result = _record(getattr(response, "response", None)) or {}
        for key in ("result", "content", "data"):
            nested = _record(result.get(key))
            if nested and nested.get("status"):
                result = nested
                break
        if result.get("status") != "proposal_ready" or result.get("audience") != "trusted_circle":
            return None
        try:
            search_job_id = str(uuid.UUID(str(result.get("searchJobId"))))
            client_request_id = str(uuid.UUID(str(result.get("clientRequestId"))))
        except (ValueError, TypeError, AttributeError):
            return None
        return {
            "activityType": "one.drive_bulk_share_review.v1",
            "content": {
                "audience": "trusted_circle",
                "searchJobId": search_job_id,
                "clientRequestId": client_request_id,
            },
        }
    return None


_WORKSPACE_SETUP_TOOLS = frozenset({"discover_workspace_tools", "read_workspace_tool"})
_WORKSPACE_PROVIDERS = frozenset({"drive", "gmail", "calendar"})
_CUSTOM_CONNECTOR_ID = re.compile(r"^custom_[a-f0-9]{32}$")
_CUSTOM_CONNECTOR_STATUSES = frozenset({"saved", "disabled", "reconnect_needed"})


def _status_result(value: Any) -> dict[str, Any]:
    """Unwrap the tool envelope the same way the browser's card parser does."""
    outer = _record(value) or {}
    if isinstance(outer.get("status"), str):
        return outer
    for key in ("result", "content", "data"):
        nested = _record(outer.get(key))
        if nested and nested.get("status"):
            return nested
    return outer


def _call_providers(events: list[Any]) -> dict[str, str]:
    """Provider enum from each workspace tool call, keyed by call id.

    Only the provider enum crosses: it is the one argument the live card uses,
    and the only one a restored card may use.
    """
    providers: dict[str, str] = {}
    for event in events:
        for part in getattr(getattr(event, "content", None), "parts", None) or []:
            call = getattr(part, "function_call", None)
            if call is None or getattr(call, "name", "") not in _WORKSPACE_SETUP_TOOLS:
                continue
            call_id = _bounded_text(getattr(call, "id", None), 128)
            provider = (_record(getattr(call, "args", None)) or {}).get("provider")
            if call_id and provider in _WORKSPACE_PROVIDERS:
                providers[call_id] = provider
    return providers


def _safe_workspace_connector_setup_descriptor(
    event: Any,
    selected_parts: list[Any] | None = None,
    call_providers: dict[str, str] | None = None,
) -> dict[str, Any] | None:
    """Project the connect/manage card: a provider enum and a status, nothing else.

    The card never authorizes a connection; the owner still taps through the
    connector surface, which re-reads the grant. So the restored card carries
    no grant, scope, account, or result content.
    """
    parts = (
        selected_parts
        if selected_parts is not None
        else (getattr(getattr(event, "content", None), "parts", None) or [])
    )
    for part in parts:
        response = getattr(part, "function_response", None)
        name = getattr(response, "name", "") if response is not None else ""
        result = _status_result(getattr(response, "response", None)) if response else {}
        if name == "inspect_private_connectors":
            if result.get("status") != "setup_available" or result.get("provider") != "custom":
                continue
            saved: list[dict[str, str]] = []
            raw_saved = result.get("saved")
            if isinstance(raw_saved, list) and len(raw_saved) <= 32:
                for raw in raw_saved:
                    item = _record(raw) or {}
                    connector_id = item.get("id")
                    raw_name = item.get("name")
                    label = (
                        _bounded_text(raw_name, 100)
                        if isinstance(raw_name, str)
                        and len(raw_name) <= 100
                        and not re.search(r"[\x00-\x1f\x7f]", raw_name)
                        else None
                    )
                    status = item.get("status")
                    if (
                        not isinstance(connector_id, str)
                        or not _CUSTOM_CONNECTOR_ID.fullmatch(connector_id)
                        or not label
                        or status not in _CUSTOM_CONNECTOR_STATUSES
                    ):
                        saved = []
                        break
                    saved.append({"id": connector_id, "name": label, "status": status})
            return {
                "activityType": "one.workspace_connector_setup.v1",
                "content": {
                    "provider": "custom",
                    "status": "manage_available",
                    **({"saved": saved} if saved else {}),
                },
            }
        if name not in _WORKSPACE_SETUP_TOOLS:
            continue
        status = result.get("status")
        if status == "permission_required":
            setup_status = "connect_required"
        elif name == "discover_workspace_tools" and status in {"api_available", "ok"}:
            setup_status = "manage_available"
        else:
            continue
        result_provider = result.get("provider")
        call_id = _bounded_text(getattr(response, "id", None), 128)
        argument_provider = (call_providers or {}).get(call_id or "")
        if result_provider and argument_provider and result_provider != argument_provider:
            continue
        provider = result_provider or argument_provider
        if provider not in _WORKSPACE_PROVIDERS:
            continue
        return {
            "activityType": "one.workspace_connector_setup.v1",
            "content": {"provider": provider, "status": setup_status},
        }
    return None


# App-owned tool identities the browser already labels in the live Activity
# panel. Anything else (sub-agent transfers, confirmation plumbing) is not a
# step the owner saw by name, so it is not restored.
# Every tool on One's roster, so a reopened turn keeps the Activity rows it
# showed live. Each row is this name plus outcome enums; the browser labels it
# from its own table (SERVER_TOOL_PRESENTATION in
# hushh-webapp/lib/services/agent-chat-client.ts), which carries exactly these
# keys. A roster tool missing from either side rendered as "Agent step" live
# and vanished on reload; tests/routes/test_agent_chat_turn_restore.py holds
# both sides to the roster.
_ACTIVITY_TOOLS = frozenset(
    {
        "discover_person_information",
        "list_pending_information_requests",
        "propose_information_request",
        "list_my_connections",
        "inspect_selected_drive_files",
        "inspect_private_connectors",
        "discover_workspace_tools",
        "read_workspace_tool",
        "read_selected_drive_search_result",
        "ask_email_agent",
        "ask_documents_agent",
        "ask_connected_systems_agent",
        "ask_consent_agent",
        "list_pending_connection_requests",
        "google_search",
        "finance",
        "wallet",
        "ask_memory_agent",
        "read_my_pkm_domain_summary",
        "add_to_pkm",
        "read_my_profile_status",
        "ask_location_agent",
        "list_my_location_circles",
        "get_location_circle_members",
        "list_my_location_shares",
        "list_location_shared_with_me",
        "list_pending_location_requests",
        "list_my_outgoing_location_requests",
        "list_information_shared_with_me",
        "list_active_grants",
        "list_my_outgoing_information_requests",
        "propose_document_request",
        "list_available_models",
        "set_preferred_model",
        "calendar_summary",
        "calendar_events",
        "calendar_availability",
        "calendar_free_slots",
        "propose_calendar_event",
        "propose_calendar_reschedule",
        "propose_calendar_cancellation",
        "open_gmail_email_draft",
        "open_gmail_information_request_reply",
        "propose_gmail_mailbox_change",
        "propose_drive_share",
        "propose_drive_bulk_share",
        "propose_drive_file_share",
        "propose_drive_file_trash",
        "create_drive_file",
        "copy_drive_file",
        "move_drive_file",
        "comment_on_drive_file",
        "open_screen",
        "run_app_action",
        "propose_app_action",
        "report_no_app_action",
        "list_app_actions",
        "start_app_goal",
        "continue_app_goal",
        "resolve_onboarding_goal",
        "get_current_time",
        "get_my_location",
    }
)
_MCP_ACTIVITY_TOOL = re.compile(r"^mcp_[0-9a-f]{40}$")
_READ_STATUSES = frozenset(
    {
        "ok",
        "input_required",
        "connect_required",
        "reconnect_required",
        "connection_changed",
        "permission_denied",
        "source_changed",
        "response_too_large",
        "invalid_argument",
        "unavailable",
    }
)
_MAX_ACTIVITY_STEPS = 10


def _activity_step_from_response(name: str, response: Any) -> dict[str, Any]:
    """Outcome enums only. Result bodies, arguments and provider text never cross."""
    if _MCP_ACTIVITY_TOOL.fullmatch(name):
        safe = safe_connector_result(response)
        step: dict[str, Any] = {}
        if safe["status"] == "ok":
            step["status"] = "done"
            if safe.get("review") in {"read_only", "no_credential"}:
                step["review"] = safe["review"]
        elif safe["status"] == "review_required":
            step["status"] = "waiting"
            step["review"] = "required"
        else:
            step["status"] = "blocked"
        if safe.get("connectorId"):
            step["connectorId"] = safe["connectorId"]
        return step
    if name == "read_selected_drive_search_result":
        status = (_record(response) or {}).get("status")
        return {
            "status": "done",
            "readStatus": status
            if isinstance(status, str) and status in _READ_STATUSES
            else "unavailable",
        }
    if name in READ_TOOLS and name != "inspect_selected_drive_files":
        structured = redacted_read_receipt(_record(response) or {}).get("structured")
        read_status = (_record(structured) or {}).get("status")
        return {
            "status": "done",
            **({"readStatus": read_status} if read_status in _READ_STATUSES else {}),
        }
    if name == "inspect_selected_drive_files":
        checked = _status_result(response).get("status") == "ok"
        return {"status": "done", **({"readStatus": "status_checked"} if checked else {})}
    return {"status": "done"}


def _safe_turn_activity(events: list[Any]) -> dict[str, Any] | None:
    """Rebuild one turn's Activity rows from its own tool calls and results.

    Each row is a tool identity from a fixed allowlist plus outcome enums: the
    same facts the live panel showed, and nothing it did not.
    """
    steps: list[dict[str, Any]] = []
    by_call: dict[str, dict[str, Any]] = {}
    providers = _call_providers(events)
    for event in events:
        event_identity = _bounded_text(getattr(event, "id", None), 128) or "event"
        for index, part in enumerate(getattr(getattr(event, "content", None), "parts", None) or []):
            call = getattr(part, "function_call", None)
            response = getattr(part, "function_response", None)
            item = call or response
            name = str(getattr(item, "name", "") or "")
            if item is None or not (name in _ACTIVITY_TOOLS or _MCP_ACTIVITY_TOOL.fullmatch(name)):
                continue
            call_id = _bounded_text(getattr(item, "id", None), 128) or f"{event_identity}:{index}"
            step = by_call.get(call_id)
            if step is None:
                step = {"id": call_id, "tool": name, "status": "interrupted"}
                if call_id in providers:
                    step["provider"] = providers[call_id]
                by_call[call_id] = step
                steps.append(step)
            if response is not None:
                step.update(_activity_step_from_response(name, getattr(response, "response", None)))
                provider = _status_result(getattr(response, "response", None)).get("provider")
                if name in _WORKSPACE_SETUP_TOOLS and provider in _WORKSPACE_PROVIDERS:
                    step["provider"] = provider
    if not steps:
        return None
    return {
        "activityType": "one.turn_activity.v1",
        "content": {"steps": steps[-_MAX_ACTIVITY_STEPS:]},
    }


def _safe_submitted_information_request_descriptor(
    event: Any, selected_parts: list[Any] | None = None
) -> dict[str, Any] | None:
    """Restore existing app-action settlements without replaying their authority."""
    parts = (
        selected_parts
        if selected_parts is not None
        else (getattr(getattr(event, "content", None), "parts", None) or [])
    )
    for part in parts:
        response = getattr(part, "function_response", None)
        if response is None or response.name != "run_app_action":
            continue
        result = _record(response.response) or {}
        if result.get("status") != "succeeded":
            continue
        data = _record(result.get("data")) or {}
        descriptor = _safe_submitted_information_request_card(data.get("consentCard"))
        if descriptor:
            return descriptor
    return None


def _safe_agent_history_metadata(
    event: Any,
    suppressed_discovery_ids: set[str] | None = None,
    call_providers: dict[str, str] | None = None,
) -> dict[str, Any] | None:
    descriptors = []
    seen = set()
    presentation = _record(getattr(event, "custom_metadata", None)) or {}
    if presentation.get("kind") == "information_request_submission_v1":
        if _submitted_source_id(event) is None:
            return None
        descriptor = _safe_submitted_information_request_card(presentation.get("card"))
        return (
            {
                "kind": "structured_experience",
                "structuredExperiences": [{"id": event.id, **descriptor}],
                "structuredExperience": descriptor,
                "structuredExperienceId": event.id,
            }
            if descriptor
            else None
        )
    event_identity = (
        _bounded_text(getattr(event, "id", None), 128)
        or _bounded_text(getattr(event, "invocation_id", None), 128)
        or "event"
    )
    for index, part in enumerate(getattr(getattr(event, "content", None), "parts", None) or []):
        descriptor = _safe_discovery_descriptor(event, [part])
        if descriptor is None:
            descriptor = _safe_submitted_information_request_descriptor(event, [part])
        if descriptor is None:
            descriptor = _safe_information_request_descriptor(event, [part])
        if descriptor is None:
            descriptor = _safe_document_request_descriptor(event, [part])
        if descriptor is None:
            descriptor = _safe_drive_share_descriptor(event, [part])
        if descriptor is None:
            descriptor = _safe_drive_bulk_share_descriptor(event, [part])
        if descriptor is None:
            descriptor = _safe_workspace_connector_setup_descriptor(event, [part], call_providers)
        if descriptor is None:
            continue
        invocation_identity = _bounded_text(
            getattr(getattr(part, "function_response", None), "id", None), 128
        )
        card_id = f"{event_identity}:{invocation_identity or index}"
        if card_id in (suppressed_discovery_ids or set()) and _safe_discovery_descriptor(
            event, [part]
        ):
            continue
        if card_id in seen:
            continue
        seen.add(card_id)
        descriptors.append({"id": card_id, **descriptor})
    if not descriptors:
        return None
    return {
        "kind": "structured_experience",
        "structuredExperiences": descriptors,
        "structuredExperience": {
            key: value for key, value in descriptors[0].items() if key != "id"
        },
        "structuredExperienceId": str(getattr(event, "id", "") or "").strip() or None,
    }


def _session_title(session: Any) -> str:
    authored = str((session.state or {}).get("hussh:thread_title") or "").strip()
    if authored:
        return authored
    for event in session.events:
        if event.author == "user":
            text = _event_text(event)
            if text:
                return text[:80]
    return "New conversation"


class RenameConversation(BaseModel):
    title: str = Field(min_length=1, max_length=160)


class RecordInformationRequestSubmission(BaseModel):
    source_activity_id: str = Field(min_length=1, max_length=256)
    bundle_id: uuid.UUID
    idempotency_key: str = Field(min_length=16, max_length=256)


def _discovery_source(session: Any, activity_id: str) -> tuple[str, dict[str, Any]] | None:
    matches: list[tuple[str, dict[str, Any]]] = []
    for event in session.events:
        event_id = (
            _bounded_text(getattr(event, "id", None), 128)
            or _bounded_text(getattr(event, "invocation_id", None), 128)
            or "event"
        )
        for index, part in enumerate(getattr(getattr(event, "content", None), "parts", None) or []):
            descriptor = _safe_discovery_descriptor(event, [part])
            if descriptor is None:
                continue
            tool_id = _bounded_text(
                getattr(getattr(part, "function_response", None), "id", None), 128
            )
            card_id = f"{event_id}:{tool_id or index}"
            if activity_id in {card_id, tool_id}:
                matches.append((card_id, descriptor["content"]))
    return matches[0] if len(matches) == 1 else None


def _submitted_source_id(event: Any) -> str | None:
    presentation = _record(getattr(event, "custom_metadata", None)) or {}
    if presentation.get("kind") != "information_request_submission_v1" or event.content is not None:
        return None
    if _safe_submitted_information_request_card(presentation.get("card")) is None:
        return None
    source_id = _bounded_text(presentation.get("sourceCardId"), 256)
    expected_id = f"request_submission_{hashlib.sha256(str(source_id).encode()).hexdigest()[:32]}"
    return source_id if source_id and event.id == expected_id else None


@router.post("/api/one/agent-chat/history/{conversation_id}/information-requests")
async def record_information_request_submission(
    conversation_id: str,
    payload: RecordInformationRequestSubmission,
    token: dict = Depends(require_vault_owner_chat_key),
):
    """Record one confirmed browser request in the existing encrypted ADK history.

    The caller supplies locators and the one-time request key, never a card body.
    The request ledger and this owner's conversation derive every display field.
    """
    owner = str(token["user_id"])
    session = await _session_service.get_session(
        app_name=ONE_APP_NAME, user_id=owner, session_id=conversation_id
    )
    if session is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    source = _discovery_source(session, payload.source_activity_id)
    if source is None:
        raise HTTPException(status_code=404, detail="Discovery card not found.")
    source_card_id, discovery = source
    try:
        bundle = await InformationRequestService().verify_submission_receipt(
            requester_user_id=owner,
            bundle_id=str(payload.bundle_id),
            idempotency_key=payload.idempotency_key,
        )
    except InformationRequestError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    person = discovery["person"]
    if bundle["personRef"] != person.get("personRef") or not bundle.get("items"):
        raise HTTPException(status_code=409, detail="Request recipient did not match discovery.")
    statuses = [item["status"] for item in bundle["items"]]
    status = statuses[0] if all(value == statuses[0] for value in statuses) else "mixed"
    hours = bundle["durationSeconds"] // 3600
    duration_label = (
        f"{hours // 24} {'day' if hours // 24 == 1 else 'days'}"
        if hours % 24 == 0
        else f"{hours} {'hour' if hours == 1 else 'hours'}"
    )
    card = {
        "activityType": "one.information_request_review.v1",
        "direction": "outgoing",
        "phase": "submitted",
        "status": status,
        "personName": person["displayName"],
        "subjectRef": bundle["personRef"],
        "bundleId": bundle["bundleId"],
        "purpose": bundle["purpose"],
        "durationLabel": duration_label,
        "fields": [
            {
                "requestId": item["requestId"],
                "label": item["label"],
                "domain": "Information",
                "sensitivity": item.get("sensitivity") or "standard",
                "status": item["status"],
            }
            for item in bundle["items"]
        ],
    }
    descriptor = _safe_submitted_information_request_card(card)
    if descriptor is None:
        raise HTTPException(status_code=409, detail="Request receipt could not be projected.")
    event = Event(
        id=f"request_submission_{hashlib.sha256(source_card_id.encode()).hexdigest()[:32]}",
        author="one",
        invocation_id=f"information_request_{payload.bundle_id}",
        custom_metadata={
            "kind": "information_request_submission_v1",
            "sourceCardId": source_card_id,
            "card": card,
        },
    )
    persisted = await _session_service.append_event_once(
        app_name=ONE_APP_NAME, user_id=owner, session_id=conversation_id, event=event
    )
    persisted_metadata = _record(persisted.custom_metadata) or {}
    persisted_descriptor = _safe_submitted_information_request_card(persisted_metadata.get("card"))
    if _submitted_source_id(persisted) != source_card_id or not persisted_descriptor:
        raise HTTPException(status_code=409, detail="Discovery was already submitted.")
    if persisted_descriptor["content"].get("bundleId") != str(payload.bundle_id):
        raise HTTPException(status_code=409, detail="Discovery was already submitted.")
    return {"descriptor": persisted_descriptor, "sourceActivityId": source_card_id}


@router.get("/api/one/agent-chat/conversations/{user_id}")
async def list_conversations(
    user_id: str,
    limit: int = Query(default=5, ge=1, le=20),
    token: dict = Depends(require_vault_owner_chat_key),
):
    if str(token["user_id"]) != user_id:
        raise HTTPException(status_code=403, detail="Conversation owner mismatch.")
    response = await _session_service.list_sessions(app_name=ONE_APP_NAME, user_id=user_id)
    sessions = sorted(response.sessions, key=lambda item: item.last_update_time, reverse=True)[
        :limit
    ]
    return {
        "user_id": user_id,
        "conversations": [
            {
                "id": session.id,
                "title": _session_title(session),
                "status": "active",
                "model": None,
                "message_count": sum(1 for event in session.events if _event_text(event)),
                "created_at": None,
                "updated_at": session.last_update_time,
                "last_message_at": session.last_update_time,
            }
            for session in sessions
        ],
    }


@router.get("/api/one/agent-chat/history/{conversation_id}")
async def conversation_history(
    conversation_id: str,
    limit: int = Query(default=50, ge=1, le=100),
    token: dict = Depends(require_vault_owner_chat_key),
):
    user_id = str(token["user_id"])
    session = await _session_service.get_session(
        app_name=ONE_APP_NAME, user_id=user_id, session_id=conversation_id
    )
    if session is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    messages: list[dict[str, object]] = []
    submitted_discovery_ids = {
        source_id for event in session.events if (source_id := _submitted_source_id(event))
    }
    call_providers = _call_providers(session.events)
    receipts: dict[str, dict[str, Any]] = {}
    last_answer: dict[str, int] = {}
    last_card: dict[str, int] = {}
    turn_events: dict[str, list[Any]] = {}
    projected: list[tuple[str, dict[str, Any] | None]] = []
    for index, event in enumerate(session.events):
        text = _event_text(event)
        metadata = _safe_agent_history_metadata(event, submitted_discovery_ids, call_providers)
        projected.append((text, metadata))
        if event.invocation_id:
            turn_events.setdefault(event.invocation_id, []).append(event)
            if event.author == "one" and text:
                last_answer[event.invocation_id] = index
            if metadata and not text:
                last_card[event.invocation_id] = index
        for part in event.content.parts or [] if event.content else []:
            response = part.function_response
            if response and response.name in READ_TOOLS:
                receipt = redacted_read_receipt(response.response)
                if isinstance(receipt.get("structured"), dict):
                    receipts[event.invocation_id] = receipt["structured"]
    # A follow-up turn that reported an owner's answer shows as a status chip.
    consent_outcomes = continued_outcomes(session.state)
    outcome_labels = {CONSENT_OUTCOME_LABELS[outcome] for outcome in consent_outcomes.values()}
    # A turn's cards and Activity belong with its answer, as they were shown
    # live. Card-only tool events fold into the answer; a turn without an
    # answer keeps its last card message as the anchor.
    held_cards: dict[str, list[dict[str, Any]]] = {}
    for index, event in enumerate(session.events):
        text, metadata = projected[index]
        # Pasted text restores as the chip it was sent as, not as message text.
        # An attachment-only turn has no text and must still come back.
        attachments = history_text_attachments(event)
        if attachments:
            metadata = {**(metadata or {}), "attachments": attachments}
        if (event.author not in {"user", "one"} and not metadata) or (not text and not metadata):
            continue
        if event.author not in {"user", "one"}:
            text = ""  # Tool events restore only allowlisted safe descriptors.
        turn = event.invocation_id
        answer_index = last_answer.get(turn) if turn else None
        if (
            metadata
            and not text
            and answer_index is not None
            and answer_index > index
            and metadata.get("structuredExperiences")
        ):
            held_cards.setdefault(turn, []).extend(metadata["structuredExperiences"])
            continue
        is_anchor = (
            bool(turn)
            and event.author != "user"
            and index == (answer_index if answer_index is not None else last_card.get(turn))
        )
        if is_anchor:
            cards = [
                *held_cards.pop(turn, []),
                *((metadata or {}).get("structuredExperiences") or []),
            ]
            activity = _safe_turn_activity(turn_events.get(turn, []))
            if cards:
                metadata = {
                    **(metadata or {}),
                    "kind": "structured_experience",
                    "structuredExperiences": cards,
                    "structuredExperience": {
                        key: value for key, value in cards[0].items() if key != "id"
                    },
                    "structuredExperienceId": (metadata or {}).get("structuredExperienceId")
                    or cards[0]["id"],
                }
            if activity:
                metadata = {**(metadata or {}), "turnActivity": activity}
            if event.author == "one" and turn in receipts and answer_index == index:
                metadata = {**(metadata or {}), "specialist_read": receipts[turn]}
        if event.author == "user" and text in outcome_labels:
            metadata = {**(metadata or {}), "kind": "selection", "display": text}
        messages.append(
            {
                "id": event.id or f"{event.invocation_id}:{len(messages)}",
                "conversation_id": conversation_id,
                "role": "user" if event.author == "user" else "assistant",
                "status": "interrupted" if event.interrupted else "complete",
                "content": text,
                "model": event.model_version,
                "created_at": event.timestamp,
                "completed_at": event.timestamp,
                "metadata": metadata,
            }
        )
    return {
        "conversation_id": conversation_id,
        "messages": messages[-limit:],
        # A client that left mid-turn reattaches while this is true; the turn
        # keeps running server-side and its answer appears here when it settles.
        "turn": {"pending": newest_turn_pending(session.events)},
        # Requests whose answer this conversation already continued with.
        "consentOutcomes": consent_outcomes,
    }


@router.get("/api/one/agent-chat/information-requests/{bundle_id}/conversation")
async def information_request_conversation(
    bundle_id: uuid.UUID,
    token: dict = Depends(require_vault_owner_chat_key),
):
    """The requester's own conversation that sent this request, after unlock.

    A push about an answered request carries only the bundle id; the conversation
    lives in the requester's sealed history, which only their chat key opens.
    """
    owner = str(token["user_id"])
    wanted = str(bundle_id)
    response = await _session_service.list_sessions(app_name=ONE_APP_NAME, user_id=owner)
    for session in sorted(response.sessions, key=lambda item: item.last_update_time, reverse=True):
        for event in session.events:
            metadata = _record(event.custom_metadata) or {}
            card = _record(metadata.get("card")) or {}
            if (
                metadata.get("kind") == "information_request_submission_v1"
                and str(card.get("bundleId") or "") == wanted
            ):
                return {"conversationId": session.id}
    raise HTTPException(status_code=404, detail="Conversation not found.")


@router.patch("/api/one/agent-chat/conversations/{conversation_id}")
async def rename_conversation(
    conversation_id: str,
    payload: RenameConversation,
    token: dict = Depends(require_vault_owner_chat_key),
):
    session = await _session_service.set_title(
        app_name=ONE_APP_NAME,
        user_id=str(token["user_id"]),
        session_id=conversation_id,
        title=payload.title,
    )
    if session is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    return {
        "id": session.id,
        "title": _session_title(session),
        "status": "active",
        "message_count": len(session.events),
    }


@router.delete("/api/one/agent-chat/conversations/{conversation_id}")
async def delete_conversation(
    conversation_id: str,
    token: dict = Depends(require_vault_owner_token),
):
    # Deleting needs no plaintext, so it needs no chat key: only the owner's
    # current conversation row, matched by id, is removed.
    deleted = await _session_service.delete_owned_session(
        app_name=ONE_APP_NAME, user_id=str(token["user_id"]), session_id=conversation_id
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    return {"conversation_id": conversation_id, "deleted": True}


# ── Proposal mode: action search and structured proposals ────────────────────


class ActionSearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2048)
    context: dict[str, Any] | None = None
    limit: int = Field(default=10, ge=1, le=20)


@router.post("/api/one/actions/search")
async def search_actions_endpoint(
    payload: ActionSearchRequest,
    request: Request,
    token: dict = Depends(require_vault_owner_token),
):
    """Return related generated capabilities for a natural-language query.

    This is a read-only search. No action is executed.
    """
    from hushh_mcp.one_adk.action_retrieval import search_actions_for_command_palette

    query = payload.query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="Query must not be empty.")

    app_runtime_state: dict[str, Any] = {}
    if isinstance(payload.context, dict):
        # Only redacted routing fields cross this search boundary. The action
        # gateway remains the execution authority and revalidates everything.
        for key in ("screen", "available_action_ids", "executable_action_ids"):
            value = payload.context.get(key)
            if key == "screen" and isinstance(value, str):
                app_runtime_state[key] = value
            elif (
                key != "screen"
                and isinstance(value, list)
                and all(isinstance(item, str) for item in value)
            ):
                app_runtime_state[key] = value[:100]
    screen = request.headers.get("x-hushh-screen")
    if screen:
        app_runtime_state["screen"] = screen

    try:
        results = search_actions_for_command_palette(
            query,
            {"actions": list_action_gateway_actions()},
            app_runtime_state=app_runtime_state,
            limit=payload.limit,
        )
    except Exception:
        logger.exception("action_search_failed")
        raise HTTPException(status_code=500, detail="Search temporarily unavailable.")

    return {
        "status": "ok",
        "query": query,
        "total": len(results),
        "results": results,
    }
