"""Canonical AG-UI transport for the private agent's text experience."""

from __future__ import annotations

import functools
import hashlib
import json
import logging
import re
import uuid
from typing import Any, cast

from ag_ui.core import RunAgentInput
from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from google.adk.apps import App, ResumabilityConfig
from google.adk.events import Event
from google.adk.sessions import InMemorySessionService
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from api.middleware import require_vault_owner_token
from api.middlewares.chat_key import CHAT_KEY_REQUIRED_DETAIL, log_chat_key_refusal
from api.routes.one.agent_context import sanitize_agent_context
from api.routes.one.command_proposals import require_pod_process
from api.utils.firebase_auth import verify_firebase_bearer
from hushh_mcp.one_adk.agent_tree import (
    ONE_APP_NAME,
    STATE_CONSENT_TOKEN,
    STATE_CONVERSATION_ID,
    STATE_DRIVE_SEARCH_SELECTION,
    STATE_GMAIL_INFORMATION_REQUEST_CONTEXT,
    STATE_GMAIL_INFORMATION_REQUEST_WORKFLOW_ID,
    STATE_OWNER_DISPLAY_NAME,
    STATE_PKM_CONTEXT,
    STATE_SCREEN,
    STATE_TIMEZONE,
    STATE_USER_ID,
    STATE_VOICE_CONTEXT,
    build_one_intro_text_agent,
    build_one_text_agent,
)
from hushh_mcp.one_adk.agui_action_tools import action_id_from_tool_name
from hushh_mcp.one_adk.agui_factory import (
    FirstUseAgent,
    _authenticated_capabilities,
    build_authenticated_agui,
)
from hushh_mcp.one_adk.agui_factory import _DurableSessionManager as _DurableSessionManager
from hushh_mcp.one_adk.agui_turn_timing import HEAD_INTRO, TimedADKAgent
from hushh_mcp.one_adk.consent_continuation import (
    ConsentContinuationError,
    admit_consent_continuation,
    continued_outcomes,
)
from hushh_mcp.one_adk.consent_redaction import access_ended_outcome, redaction_for_history
from hushh_mcp.one_adk.conversation_titles import ensure_conversation_titles
from hushh_mcp.one_adk.encrypted_session_service import EncryptedAdkSessionService
from hushh_mcp.one_adk.external_read_boundary import (
    STATE_EXECUTION_SURFACE,
)
from hushh_mcp.one_adk.feed_attention import (
    FeedAttentionError,
    admit_feed_attention,
)
from hushh_mcp.one_adk.history_descriptors import (
    _event_text as _event_text,
)
from hushh_mcp.one_adk.history_descriptors import _request_source
from hushh_mcp.one_adk.history_descriptors import (
    _safe_agent_history_metadata as _safe_agent_history_metadata,
)
from hushh_mcp.one_adk.history_descriptors import (
    _safe_discovery_descriptor as _safe_discovery_descriptor,
)
from hushh_mcp.one_adk.history_descriptors import (
    _safe_document_request_descriptor as _safe_document_request_descriptor,
)
from hushh_mcp.one_adk.history_descriptors import (
    _safe_drive_bulk_share_descriptor as _safe_drive_bulk_share_descriptor,
)
from hushh_mcp.one_adk.history_descriptors import (
    _safe_drive_share_descriptor as _safe_drive_share_descriptor,
)
from hushh_mcp.one_adk.history_descriptors import (
    _safe_information_request_descriptor as _safe_information_request_descriptor,
)
from hushh_mcp.one_adk.history_descriptors import (
    _safe_scope_catalog as _safe_scope_catalog,
)
from hushh_mcp.one_adk.history_descriptors import (
    _safe_submitted_information_request_card as _safe_submitted_information_request_card,
)
from hushh_mcp.one_adk.history_descriptors import (
    _safe_submitted_information_request_descriptor as _safe_submitted_information_request_descriptor,
)
from hushh_mcp.one_adk.history_descriptors import (
    _session_title as _session_title,
)
from hushh_mcp.one_adk.history_descriptors import (
    _submitted_source_id as _submitted_source_id,
)
from hushh_mcp.one_adk.history_projection import (
    _ACTIVITY_TOOLS as _ACTIVITY_TOOLS,
)
from hushh_mcp.one_adk.history_projection import (
    _bounded_text as _bounded_text,
)
from hushh_mcp.one_adk.history_projection import (
    _call_providers,
    project_conversation_history,
)
from hushh_mcp.one_adk.history_projection import (
    _record as _record,
)
from hushh_mcp.one_adk.history_projection import (
    _safe_turn_activity as _safe_turn_activity,
)
from hushh_mcp.one_adk.history_projection import (
    _safe_workspace_connector_setup_descriptor as _safe_workspace_connector_setup_descriptor,
)
from hushh_mcp.one_adk.mcp_call_approval import STATE_MCP_APPROVAL, admit_resume_receipt
from hushh_mcp.one_adk.mcp_turn_scope import STATE_MCP_CONFIGURATION, admit_turn_configurations
from hushh_mcp.one_adk.owner_style import STATE_OWNER_STYLE, OwnerStyleError, admit_owner_style
from hushh_mcp.one_adk.pending_email_draft import (
    STATE_PENDING_EMAIL_DRAFT,
    admit_pending_email_draft,
)
from hushh_mcp.one_adk.queued_input import QueuedInputError
from hushh_mcp.one_adk.queued_input import registry as queued_input_registry
from hushh_mcp.one_adk.request_secrets import (
    consume_request_secret,
    resolve_request_secret,
    store_request_secret,
)
from hushh_mcp.one_adk.turn_completion import (
    newest_turn_answered,
    newest_turn_pending,
    notify_one_reply,
)
from hushh_mcp.one_adk.turn_location import STATE_TURN_LOCATION, admit_turn_location
from hushh_mcp.one_adk.workspace_mcp_tools import WORKSPACE_CHAT_ADMISSION_STATE
from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError
from hushh_mcp.services.action_gateway import get_action_gateway_action, list_action_gateway_actions
from hushh_mcp.services.actor_identity_service import ActorIdentityService
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
from hushh_mcp.services.owner_placement_guard import (
    HUB_CHAT_GUARD,
    admit_hub_content,
    hub_content_chat_owner,
    hub_content_owner,
    mark_inline_routes,
    require_vault_owner_chat_key,
)
from hushh_mcp.services.person_profile_service import PersonProfileService
from hushh_mcp.services.personal_agent_hosting import get_owner_hosting_mode

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Agent One"])


async def _owner_display_name_for_turn(user_id: str) -> str:
    """Return bounded account metadata without making a chat turn depend on it."""

    try:
        identity = (await ActorIdentityService().get_many([user_id])).get(user_id) or {}
        try:
            return str(
                ActorIdentityService.validate_display_name(str(identity.get("display_name") or ""))
            )
        except ValueError:
            # A pre-enrichment Gmail connection can be repaired from its
            # owner-bound provider grant. This is still account metadata, not
            # an implicit PKM write.
            from hushh_mcp.services.gmail_receipts_service import get_gmail_receipts_service

            await get_gmail_receipts_service().refresh_owner_identity_profile(user_id=user_id)
            refreshed = (await ActorIdentityService().get_many([user_id])).get(user_id) or {}
            return str(
                ActorIdentityService.validate_display_name(str(refreshed.get("display_name") or ""))
            )
    except Exception:  # noqa: BLE001 - identity metadata is a best-effort nicety
        return ""


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
    if any(message.role == "system" for message in input_data.messages):
        raise HTTPException(400, detail={"code": "AGENT_SYSTEM_MESSAGE_REFUSED"})
    authorization = request.headers.get("authorization")
    consent_header = request.headers.get("x-hushh-consent")
    token: dict[str, Any] | None = None
    authorization_token = re.sub(r"^Bearer\s+", "", (authorization or "").strip(), flags=re.I)
    authorization_is_consent = authorization_token.startswith("HCT:")
    if consent_header is not None:
        token = await require_vault_owner_token(
            request=request, authorization=None, hushh_consent=consent_header
        )
    if authorization_is_consent:
        bearer_token = await require_vault_owner_token(
            request=request,
            authorization=authorization,
            hushh_consent=None,
        )
        if token is not None and bearer_token["user_id"] != token["user_id"]:
            raise HTTPException(status_code=403, detail="Credential owner mismatch")
        token = bearer_token
    firebase_uid = ""
    if authorization and not authorization_is_consent:
        firebase_uid = await run_in_threadpool(verify_firebase_bearer, authorization)
        if token is not None and firebase_uid != token["user_id"]:
            raise HTTPException(status_code=403, detail="Credential owner mismatch")
    owner_id = (token or {}).get("user_id") or firebase_uid  # Firebase-only is still an owner.
    await admit_hub_content(owner_id, "agent_chat", resolve_mode=get_owner_hosting_mode)
    forwarded = input_data.forwarded_props if isinstance(input_data.forwarded_props, dict) else {}
    if (
        forwarded.get("runtimeCredential")
        or input_data.context
        or (not token and forwarded.get("pkmContext"))
    ):
        raise HTTPException(status_code=400, detail="Private context requires the private agent")
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
            logger.info("one.gmail_information_request_context_unavailable code=%s", exc.code)
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
    feed_attention = await _admit_feed_attention(
        forwarded, input_data=input_data, owner_id=user_id if token else ""
    )
    # The device sends a coarse position only when the person already granted
    # location; pre-vault turns never keep it.
    turn_location = admit_turn_location(forwarded)
    # The person's unsent draft card, so a follow-up can revise it. Only an
    # unlocked owner turn keeps it; it never becomes conversation state.
    pending_email_draft = admit_pending_email_draft(forwarded)
    # The owner's Settings style choices, sent apart from the memory packet.
    # Closed schema: anything outside it refuses the turn instead of clipping.
    try:
        owner_style = admit_owner_style(forwarded, owner_admitted=bool(token and user_id))
    except OwnerStyleError:
        raise HTTPException(
            status_code=400, detail="Communication preferences are invalid."
        ) from None
    if not (token and user_id):
        consume_request_secret(turn_location)
        turn_location = ""
        consume_request_secret(pending_email_draft)
        pending_email_draft = ""
    owner_display_name = await _owner_display_name_for_turn(user_id) if token and user_id else ""
    return {
        STATE_EXECUTION_SURFACE: "typed_chat",
        STATE_TURN_LOCATION: turn_location,
        STATE_MCP_CONFIGURATION: mcp_configuration,
        STATE_MCP_APPROVAL: mcp_approval,
        WORKSPACE_CHAT_ADMISSION_STATE: bool(token and user_id),
        STATE_USER_ID: session_user_id,
        STATE_CONSENT_TOKEN: store_request_secret(str(token["token"])) if token else "",
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
        STATE_PKM_CONTEXT: store_request_secret(str(forwarded.get("pkmContext") or "")[:20000])
        if token
        else "",
        STATE_OWNER_STYLE: owner_style,
        STATE_OWNER_DISPLAY_NAME: store_request_secret(owner_display_name),
        STATE_GMAIL_INFORMATION_REQUEST_WORKFLOW_ID: workflow_id,
        STATE_GMAIL_INFORMATION_REQUEST_CONTEXT: store_request_secret(
            gmail_information_request_context
        )
        if workflow_id
        else "",
        **consent_continuation,
        **feed_attention,
        STATE_PENDING_EMAIL_DRAFT: pending_email_draft,
    }


async def _admit_feed_attention(
    forwarded: dict[str, Any], *, input_data: RunAgentInput, owner_id: str
) -> dict[str, Any]:
    """Admit the turn a push tap starts about one feed update, or nothing."""
    if forwarded.get("feedAttention") is None:
        return {}
    from hushh_mcp.services.feed_attention_push import get_offered_feed_item

    session = None
    if owner_id and input_data.thread_id:
        session = await _session_service.get_session(
            app_name=ONE_APP_NAME, user_id=owner_id, session_id=input_data.thread_id
        )
    try:
        return await admit_feed_attention(
            forwarded,
            owner_id=owner_id,
            messages=input_data.messages,
            session_state=dict(session.state) if session is not None else None,
            get_item=get_offered_feed_item,
        )
    except FeedAttentionError as exc:
        logger.info("one.feed_attention_refused status=%s", exc.status_code)
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from None


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


_session_service = EncryptedAdkSessionService()
_intro_session_service = InMemorySessionService()


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


# Built on first use, never at import: building a head resolves the managed model,
# and every pod imports this module, with no Google credentials off GCP (byoc-azure.md).
@functools.cache
def _one_head() -> TimedADKAgent:
    agent = build_authenticated_agui(
        build_one_text_agent(allow_workspace_tools=True, include_thought_summaries=True),
        _session_service,
        app_name=ONE_APP_NAME,
        user_id_extractor=_user_id,
    )
    agent.detached_turn_hook = _notify_detached_turn
    return agent


@functools.cache
def _intro_head() -> TimedADKAgent:
    intro_app = App(
        name=f"{ONE_APP_NAME}_intro",
        root_agent=build_one_intro_text_agent(),
        resumability_config=ResumabilityConfig(is_resumable=True),
    )
    return TimedADKAgent.from_app(
        intro_app,
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


def __getattr__(name: str) -> Any:
    """The former import-time handles, now built on first read (PEP 562)."""
    if name == "_agent":
        return _one_head()
    if name == "_app":
        return _one_head()._app  # Construction is owned by agui_factory.
    if name == "_intro_agent":
        return _intro_head()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


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


async def _resolve_agent(_request: Request, input_data: RunAgentInput) -> ADKAgent:
    state = input_data.state if isinstance(input_data.state, dict) else {}
    reference = state.get(STATE_CONSENT_TOKEN)
    if not reference:
        return _intro_head()
    if (
        not isinstance(reference, str)
        or not reference.startswith("one_secret_ref:")
        or not resolve_request_secret(reference)
    ):
        raise HTTPException(status_code=409, detail={"code": "AGENT_PRIVATE_RUNTIME_REQUIRED"})
    return _one_head()


add_adk_fastapi_endpoint(
    router,
    cast(ADKAgent, FirstUseAgent(_one_head)),
    path="/api/one/agent-chat",
    extract_state_from_request=_extract_state,
    agent_resolver=_resolve_agent,
)
mark_inline_routes(router, "/api/one/agent-chat", "agent_chat")  # _extract_state admits


class RenameConversation(BaseModel):
    title: str = Field(min_length=1, max_length=160)


class RecordInformationRequestSubmission(BaseModel):
    source_activity_id: str = Field(min_length=1, max_length=256)
    bundle_id: uuid.UUID
    idempotency_key: str = Field(min_length=16, max_length=256)


@router.post("/api/one/agent-chat/history/{conversation_id}/information-requests")
async def record_information_request_submission(
    conversation_id: str,
    payload: RecordInformationRequestSubmission,
    token: dict = Depends(require_vault_owner_chat_key),
    _admitted: dict = Depends(hub_content_chat_owner),  # after token: callers pass it third
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
    source = _request_source(session, payload.source_activity_id)
    if source is None:
        raise HTTPException(status_code=404, detail="Request card not found.")
    source_card_id, source_card = source
    try:
        bundle = await InformationRequestService().verify_submission_receipt(
            requester_user_id=owner,
            bundle_id=str(payload.bundle_id),
            idempotency_key=payload.idempotency_key,
        )
    except InformationRequestError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    person = source_card["person"]
    if bundle["personRef"] != person.get("personRef") or not bundle.get("items"):
        raise HTTPException(status_code=409, detail="Request recipient did not match the card.")
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


@router.get("/api/one/agent-chat/conversations/{user_id}", dependencies=HUB_CHAT_GUARD)
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
    await ensure_conversation_titles(
        sessions=sessions,
        service=_session_service,
        owner=user_id,
        token=str(token.get("token") or ""),
    )
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


# At most this many shared requests are re-checked per history load.
_MAX_CONSENT_ACCESS_CHECKS = 10


async def _consent_access_for_history(
    owner: str, state: Any
) -> tuple[dict[str, str], dict[str, str]]:
    """``(invocation_id -> bundle_id, bundle_id -> ended outcome)`` for this load.

    A bundle latched as ended by a model turn is ended. Otherwise its current
    outcome is read (requester-bound) so a revoke is honoured on the very next
    history load, before any new turn runs. A failed read redacts: the safe
    direction, for this response only.
    """
    by_invocation, ended = redaction_for_history(state)
    pending = [bundle for bundle in dict.fromkeys(by_invocation.values()) if bundle not in ended]
    service = InformationRequestService()
    for bundle_id in pending[:_MAX_CONSENT_ACCESS_CHECKS]:
        try:
            outcome = access_ended_outcome(
                await service.get(requester_user_id=owner, bundle_id=bundle_id)
            )
        except Exception as exc:  # noqa: BLE001 - unknown means redact
            logger.info("one.history_consent_access_unknown error=%s", type(exc).__name__)
            outcome = "revoked"
        if outcome:
            ended[bundle_id] = outcome
    for bundle_id in pending[_MAX_CONSENT_ACCESS_CHECKS:]:
        ended[bundle_id] = "revoked"
    return by_invocation, ended


@router.get("/api/one/agent-chat/history/{conversation_id}", dependencies=HUB_CHAT_GUARD)
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
    submitted_discovery_ids = {
        source_id for event in session.events if (source_id := _submitted_source_id(event))
    }
    call_providers = _call_providers(session.events)
    consent_by_invocation, consent_ended = await _consent_access_for_history(user_id, session.state)
    result = project_conversation_history(
        session.events,
        conversation_id,
        limit,
        session_state=session.state,
        consent_by_invocation=consent_by_invocation,
        consent_ended=consent_ended,
        project_event=lambda event: (
            _event_text(event),
            _safe_agent_history_metadata(event, submitted_discovery_ids, call_providers),
        ),
    )
    result.update(
        turn={"pending": newest_turn_pending(session.events)},
        consentOutcomes=continued_outcomes(session.state),
        consentAccessEnded=consent_ended,
    )
    return result


@router.get("/api/one/agent-chat/information-requests/{bundle_id}/conversation")
async def information_request_conversation(
    bundle_id: uuid.UUID,
    token: dict = Depends(hub_content_chat_owner),
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


@router.patch("/api/one/agent-chat/conversations/{conversation_id}", dependencies=HUB_CHAT_GUARD)
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
    # No plaintext and no Shared placement needed: an owner whose agent moved still
    # erases their own hub conversation row, matched by id.
    deleted = await _session_service.delete_owned_session(
        app_name=ONE_APP_NAME, user_id=str(token["user_id"]), session_id=conversation_id
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    return {"conversation_id": conversation_id, "deleted": True}


# ── Queued input: messages sent while One is still working ─────────────────
# Owner-bound by the VAULT_OWNER token, no chat key. Only enqueue carries text, so
# only it admits Shared owners alone; withdraw, status and stop return ids. Queued
# text stays in memory until the turn seals it or it is returned. See queued_input.py.


class EnqueueQueuedInput(BaseModel):
    client_message_id: str = Field(min_length=8, max_length=64)
    text: str = Field(min_length=1, max_length=4000)


def _queued_input_receipt(receipt: Any) -> dict[str, str]:
    return {"clientMessageId": receipt.client_message_id, "status": receipt.status}


@router.post("/api/one/agent-chat/runs/{conversation_id}/queue")
async def enqueue_queued_input(
    conversation_id: str,
    payload: EnqueueQueuedInput,
    token: dict = Depends(hub_content_owner),
):
    try:
        receipt = queued_input_registry.enqueue(
            str(token["user_id"]), conversation_id, payload.client_message_id, payload.text
        )
    except QueuedInputError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    return _queued_input_receipt(receipt)


@router.delete("/api/one/agent-chat/runs/{conversation_id}/queue/{client_message_id}")
async def withdraw_queued_input(
    conversation_id: str,
    client_message_id: str,
    token: dict = Depends(require_vault_owner_token),
):
    try:
        receipt = queued_input_registry.withdraw(
            str(token["user_id"]), conversation_id, client_message_id
        )
    except QueuedInputError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    return _queued_input_receipt(receipt)


@router.get("/api/one/agent-chat/runs/{conversation_id}/queue")
async def queued_input_status(
    conversation_id: str,
    ids: list[str] = Query(default_factory=list, max_length=16),
    token: dict = Depends(require_vault_owner_token),
):
    try:
        receipts = queued_input_registry.status(str(token["user_id"]), conversation_id, ids)
    except QueuedInputError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    return {"receipts": [_queued_input_receipt(receipt) for receipt in receipts]}


@router.post("/api/one/agent-chat/runs/{conversation_id}/stop")
async def stop_agent_turn(
    conversation_id: str,
    token: dict = Depends(require_vault_owner_token),
):
    """End the running turn at its next step; queued messages come back unsent.

    ``stopped`` is false when no turn of this conversation runs in this process;
    the client then stops reading and sends what it queued as the next turn.
    """
    settlement = queued_input_registry.request_stop(str(token["user_id"]), conversation_id)
    if settlement is None:
        return {"stopped": False, "returned": []}
    return {"stopped": True, "returned": list(settlement.returned)}


# ── Proposal mode: action search and structured proposals ────────────────────


class ActionSearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2048)
    context: dict[str, Any] | None = None
    limit: int = Field(default=10, ge=1, le=20)


@router.post("/api/one/actions/search", dependencies=[Depends(require_pod_process)])
async def search_actions_endpoint(
    payload: ActionSearchRequest,
    request: Request,
    token: dict = Depends(hub_content_owner),
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
