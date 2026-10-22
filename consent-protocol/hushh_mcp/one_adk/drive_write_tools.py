"""Owner Drive writes for authenticated typed Chat, over the live (full ``drive``) grant.

Founder decision 2026-09-27: expose Drive through One's tools "like any other
MCP" -- create, copy, move/rename and comment run when the owner's agent calls
them. Sharing and trashing stay reviewed Google writes: the tool only prepares
an exact, ledger-bound review, and nothing reaches Drive until the owner
confirms that exact call through ``execute_reviewed_drive_action``.

Owner identity never comes from model input. Credentials stay server-held in
the existing OAuth store and never enter tool arguments, results or logs.
"""

from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Literal, cast

from google.adk.tools.tool_context import ToolContext

from hushh_mcp.consent.audit_logger import get_audit_logger
from hushh_mcp.runtime_settings import get_core_security_settings, pod_mode
from hushh_mcp.services.action_directive_ledger import (
    ActionDirectiveAuthorityError,
    ActionDirectiveStore,
    BoundActionTerms,
)
from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
from hushh_mcp.services.external_connector_oauth_service import get_external_connector_oauth_service
from hushh_mcp.services.google_drive_rest_transport import (
    DIRECT_WRITE_TOOLS,
    GoogleDriveRestTransport,
)
from hushh_mcp.services.google_drive_write_adapter import (
    FOLDER_MIME,
    MAX_SHARE_MESSAGE_CHARS,
    SHARE_ROLES,
    DriveWriteError,
    bounded_text,
    share_email,
)
from hushh_mcp.services.google_drive_write_adapter import file_id as valid_file_id

DRIVE_REVIEW_DIRECTIVE = "hussh:pending_directive:drive_review"
DRIVE_REVIEW_DELEGATE = "agent_documents"
DRIVE_REVIEW_TYPE = "drive.execute_review"
# action -> (ledger action id, transport tool)
REVIEWED_ACTIONS: dict[str, tuple[str, str]] = {
    "share": ("connector.drive.share_file", "share_file"),
    "trash": ("connector.drive.trash_file", "trash_file"),
}
_CONTEXT_REVISION = "drive-review:v1"
_direct_audit = get_audit_logger("hushh_mcp.audit.drive_direct_write")


@lru_cache(maxsize=1)
def _transport() -> GoogleDriveRestTransport:
    return GoogleDriveRestTransport()


def _writer(owner: str) -> GoogleDriveRestTransport:
    from hushh_mcp.services.pod_drive import transport_for

    return transport_for(owner, _transport)


async def _owner(tool_context: ToolContext) -> str | None:
    """The same typed-Chat owner authority as every Workspace read, rechecked per call.

    In an owner-cloud agent the person's own Drive login is the rollout: no staged flag."""
    from hushh_mcp.one_adk.workspace_mcp_tools import _owner as workspace_owner

    owner = await workspace_owner(tool_context, "drive")
    if owner is None or not (pod_mode() or connector_feature_enabled("google_drive_live", owner)):
        return None
    return owner


_TITLE_LIMIT = 80
# Quote marks a file name could use to close ours and forge the rest of a card.
_QUOTES = str.maketrans("", "", '"“”„‟«»‹›')


def card_title(value: object) -> str:
    """A Drive file name as review-card text: no quotes or control characters, <= 80 chars.

    The address and role are never read from here; the card shows them on their
    own lines from the validated arguments.
    """
    if not isinstance(value, str):
        return "this file"
    text = " ".join("".join(" " if ord(ch) < 32 or ord(ch) == 127 else ch for ch in value).split())
    text = text.translate(_QUOTES).strip()
    if not text:
        return "this file"
    return text if len(text) <= _TITLE_LIMIT else text[: _TITLE_LIMIT - 1].rstrip() + "…"


def _owner_ref(owner: str) -> str:
    return hmac.new(
        get_core_security_settings().app_signing_key.encode(),
        b"drive-audit-owner:" + owner.encode(),
        hashlib.sha256,
    ).hexdigest()[:16]


def _failure(error: Exception) -> dict[str, Any]:
    """Authored outcomes only: never a provider body, file ID or credential."""
    code = str(error)
    if isinstance(error, DriveWriteError) and error.outcome_unknown:
        return {
            "status": "outcome_unknown",
            "message": "Drive did not confirm the change. Check Drive before trying again.",
        }
    if code == "destination_shared":
        return {
            "status": "blocked",
            "reason": "destination_shared",
            "message": (
                "Other people can see that folder, so putting a file there would share it. "
                "Choose a folder only the person can see, or share the file for review."
            ),
        }
    if code == "invalid_argument":
        return {
            "status": "needs_clarification",
            "message": "Check the file, folder, name or text and try again.",
        }
    if code == "source_unavailable":
        return {
            "status": "unavailable",
            "message": "That file or folder is unavailable, or this Google account cannot change it.",
        }
    if code == "write_rejected":
        return {"status": "failed", "message": "Google Drive refused that change."}
    if isinstance(error, DriveOAuthError) and error.status_code in {401, 409}:
        return {
            "status": "permission_required",
            "provider": "drive",
            "message": "Reconnect Google Drive, then try again.",
        }
    return {"status": "unavailable", "message": "Drive could not make that change right now."}


async def _direct_write(
    tool_context: ToolContext, tool_name: str, arguments: dict[str, Any]
) -> dict[str, Any]:
    if tool_name not in DIRECT_WRITE_TOOLS:
        raise ValueError("Not a direct Drive write")
    owner = await _owner(tool_context)
    if owner is None:
        return {"status": "blocked", "message": "Live Drive is unavailable in this session."}
    # Metadata-only record, written before dispatch: never names, IDs or text.
    _direct_audit.info(
        "drive.direct_write",
        extra={
            "operation": tool_name,
            "owner_ref": _owner_ref(owner),
            "session_id": str(tool_context.state.get("hussh:conversation_id") or ""),
        },
    )
    try:
        result = await _writer(owner).write_tool(
            user_id=owner, tool_name=tool_name, arguments=arguments
        )
    except (DriveWriteError, DriveOAuthError) as error:
        return _failure(error)
    except Exception:  # noqa: BLE001 - provider diagnostics may contain private content
        return {"status": "unavailable", "message": "Drive could not make that change right now."}
    if await _owner(tool_context) != owner:
        return {"status": "blocked", "message": "The Drive session changed. Check Drive."}
    return {"status": "ok", "operation": tool_name, **result.payload}


def _present(**values: Any) -> dict[str, Any]:
    return {key: value for key, value in values.items() if value not in (None, "")}


async def create_drive_file(
    name: str,
    kind: Literal["document", "spreadsheet", "folder"],
    tool_context: ToolContext,
    content: str = "",
    content_format: Literal["markdown", "text", "csv"] = "markdown",
    folder_id: str = "",
) -> dict[str, Any]:
    """Create a Google Doc (from Markdown or plain text), a Sheet (from CSV) or a folder.

    Leave content empty for a blank file. A Sheet's content is CSV. folder_id
    must be a folder only the person can see; omit it for My Drive.
    """
    arguments = _present(name=name, kind=kind, content=content, folderId=folder_id)
    if content and kind != "folder":
        arguments["contentFormat"] = "csv" if kind == "spreadsheet" else content_format
    return await _direct_write(tool_context, "create_file", arguments)


async def copy_drive_file(
    file_id: str, tool_context: ToolContext, name: str = "", folder_id: str = ""
) -> dict[str, Any]:
    """Copy one Drive file by its exact ID, optionally renamed or into a private folder."""
    return await _direct_write(
        tool_context, "copy_file", _present(fileId=file_id, name=name, folderId=folder_id)
    )


async def move_drive_file(
    file_id: str, tool_context: ToolContext, folder_id: str = "", new_name: str = ""
) -> dict[str, Any]:
    """Move one Drive file into a folder only the person can see, give it a new name, or both."""
    return await _direct_write(
        tool_context, "move_file", _present(fileId=file_id, folderId=folder_id, name=new_name)
    )


async def comment_on_drive_file(
    file_id: str, text: str, tool_context: ToolContext
) -> dict[str, Any]:
    """Add one comment, as the person, to a Drive file by its exact ID."""
    return await _direct_write(tool_context, "add_comment", {"fileId": file_id, "text": text})


@dataclass(frozen=True)
class DriveWriteReview:
    """Server-derived terms for one reviewed Drive write; never a client digest."""

    owner_id: str = field(repr=False)
    conversation_id: str = field(repr=False)
    action: Literal["share", "trash"]
    arguments: dict[str, Any] = field(repr=False)
    connection_generation: int

    @classmethod
    def build(
        cls,
        *,
        owner_id: str,
        conversation_id: str,
        action: str,
        arguments: dict[str, Any],
        connection_generation: int,
    ) -> DriveWriteReview:
        if action not in REVIEWED_ACTIONS or not owner_id or not conversation_id:
            raise ActionDirectiveAuthorityError("Drive review terms are invalid.")
        return cls(
            owner_id,
            conversation_id,
            cast(Literal["share", "trash"], action),
            normalized_arguments(action, arguments),
            int(connection_generation),
        )

    @property
    def action_id(self) -> str:
        return REVIEWED_ACTIONS[self.action][0]

    @property
    def tool_name(self) -> str:
        return REVIEWED_ACTIONS[self.action][1]

    @property
    def identity(self) -> dict[str, Any]:
        return {
            "user_id": self.owner_id,
            "session_id": self.conversation_id,
            "adk_app_name": "hussh_one",
            "action_id": self.action_id,
            "context_revision": _CONTEXT_REVISION,
        }

    @property
    def terms(self) -> BoundActionTerms:
        return BoundActionTerms(
            action_contract={
                "action_id": self.action_id,
                "execution_policy": "confirm_required",
                "activation_policy": "trusted_activation_required",
                "tool": self.tool_name,
            },
            slots=dict(self.arguments),
            resource_binding={
                "owner": self.owner_id,
                "connector": "google_drive",
                "connection_generation": self.connection_generation,
            },
        )


def normalized_arguments(action: str, arguments: object) -> dict[str, Any]:
    """The exact reviewed arguments, validated and in one canonical shape."""
    if not isinstance(arguments, dict):
        raise DriveWriteError("invalid_argument")
    if action == "trash":
        if set(arguments) != {"fileId"}:
            raise DriveWriteError("invalid_argument")
        return {"fileId": valid_file_id(arguments["fileId"])}
    if action != "share" or not set(arguments) <= {"fileId", "email", "role", "notify", "message"}:
        raise DriveWriteError("invalid_argument")
    role = arguments.get("role", "reader")
    notify = arguments.get("notify", True)
    message = arguments.get("message", "")
    if role not in SHARE_ROLES or type(notify) is not bool or (message and not notify):
        raise DriveWriteError("invalid_argument")
    return {
        "fileId": valid_file_id(arguments.get("fileId")),
        "email": share_email(arguments.get("email")).lower(),
        "role": role,
        "notify": notify,
        "message": bounded_text(message, limit=MAX_SHARE_MESSAGE_CHARS, allow_empty=True),
    }


async def _connection_generation(owner: str) -> int:
    row, _credential = (
        await get_external_connector_oauth_service()
        .drive()
        .current_credential(user_id=owner, required_profile="live")
    )
    if row.get("status") != "connected" or row.get("validation_state") != "verified":
        raise DriveOAuthError("reconnect_required", status_code=401)
    return int(row["connection_generation"])


async def _ledger_review(owner: str, conversation: str, action: str, exact: dict) -> Any:
    review = DriveWriteReview.build(
        owner_id=owner,
        conversation_id=conversation,
        action=action,
        arguments=exact,
        connection_generation=await _connection_generation(owner),
    )
    return await ActionDirectiveStore().issue(
        **review.identity,
        channel="adk_chat",
        action_contract=review.terms.action_contract,
        slots=review.terms.slots,
        resource_binding=review.terms.resource_binding,
        trusted_activation_required=True,
        ttl_seconds=300,
    )


async def _propose(
    tool_context: ToolContext, action: Literal["share", "trash"], arguments: dict[str, Any]
) -> dict[str, Any]:
    owner = await _owner(tool_context)
    conversation = tool_context.state.get("hussh:conversation_id")
    if owner is None or not isinstance(conversation, str) or not conversation:
        return {"status": "blocked", "message": "Live Drive is unavailable in this session."}
    try:
        exact = normalized_arguments(action, arguments)
        # What the owner reviews is the file as Drive names it now, never a
        # model-typed title. This read changes nothing.
        facts = await _writer(owner).read_tool(
            user_id=owner, tool_name="get_file_metadata", arguments={"fileId": exact["fileId"]}
        )
        from hushh_mcp.services.pod_drive import pod_review

        issued = await (pod_review if pod_mode() else _ledger_review)(
            owner, conversation, action, exact
        )
    except ActionDirectiveAuthorityError:
        return {"status": "unavailable", "message": "Drive review could not be prepared right now."}
    except (DriveWriteError, DriveOAuthError) as error:
        return _failure(error)
    except Exception:  # noqa: BLE001 - provider diagnostics may contain private content
        return {"status": "unavailable", "message": "Drive review could not be prepared right now."}
    if await _owner(tool_context) != owner:
        return {"status": "blocked", "message": "The Drive session changed. Try again."}
    file = facts.payload.get("file") if isinstance(facts.payload, dict) else None
    file = file if isinstance(file, dict) else {}
    title = card_title(file.get("title"))
    folder = file.get("mimeType") == FOLDER_MIME
    target = f"the folder “{title}” and everything in it" if folder else f"“{title}”"
    if action == "share":
        summary = f"Share {target}"
        confirm_label = "Share"
    else:
        summary = f"Move {target} to trash"
        confirm_label = "Move to trash"
    directive = {
        "kind": "action",
        "delegateAgentId": DRIVE_REVIEW_DELEGATE,
        "payload": {
            "type": DRIVE_REVIEW_TYPE,
            "directiveId": issued.directive_id,
            "conversationId": conversation,
            "action": action,
            "arguments": exact,
            "file": {
                "title": title,
                "isFolder": folder,
                "mimeType": file.get("mimeType"),
                "viewUrl": file.get("viewUrl"),
            },
            "summary": summary,
            "confirmLabel": confirm_label,
            "expiresAt": issued.expires_at.isoformat(),
        },
    }
    tool_context.state[DRIVE_REVIEW_DIRECTIVE] = directive
    return {
        "status": "confirmation_required",
        "directive": directive,
        "message": f"Review the card. Nothing changes in Drive until the person taps {confirm_label}.",
    }


async def propose_drive_file_share(
    file_id: str,
    email: str,
    tool_context: ToolContext,
    role: Literal["reader", "commenter", "writer"] = "reader",
    notify: bool = True,
    message: str = "",
) -> dict[str, Any]:
    """Prepare sharing one Drive file (exact ID) with any email address as Viewer
    (reader), Commenter or Editor (writer). Nothing is shared until the person
    reviews the exact file, address and role and taps Share."""
    return await _propose(
        tool_context,
        "share",
        {"fileId": file_id, "email": email, "role": role, "notify": notify, "message": message},
    )


async def propose_drive_file_trash(file_id: str, tool_context: ToolContext) -> dict[str, Any]:
    """Prepare moving one Drive file (exact ID) to the trash. Nothing is trashed
    until the person reviews it and taps Move to trash."""
    return await _propose(tool_context, "trash", {"fileId": file_id})


async def execute_reviewed_drive_action(
    *,
    owner_id: str,
    conversation_id: str,
    directive_id: str,
    action: str,
    arguments: dict[str, Any],
    transport: GoogleDriveRestTransport | None = None,
    ledger: ActionDirectiveStore | None = None,
) -> dict[str, Any]:
    """Run one reviewed Drive write after the owner's authenticated confirmation.

    The ledger matches HMACs of terms rebuilt here from the submitted
    arguments and the owner's CURRENT Drive connection, so a changed file,
    address, role, conversation, owner or reconnect since review fails before
    Drive is called. Consumed once; never retried.
    """
    store = ledger or ActionDirectiveStore()
    review = DriveWriteReview.build(
        owner_id=owner_id,
        conversation_id=conversation_id,
        action=action,
        arguments=arguments,
        connection_generation=await _connection_generation(owner_id),
    )
    receipt = await store.confirm(
        **review.identity, directive_id=directive_id, trusted_activation=True, terms=review.terms
    )
    await store.consume(
        **review.identity, directive_id=directive_id, receipt=receipt.receipt, terms=review.terms
    )
    status: Literal["succeeded", "failed"] = "failed"
    reason = "error"
    try:
        result = await (transport or _transport()).write_tool(
            user_id=owner_id,
            tool_name=review.tool_name,
            arguments=review.arguments,
            expected_generation=review.connection_generation,
        )
        status, reason = "succeeded", "ok"
        return {"status": "ok", "action": action, **result.payload}
    except DriveWriteError as error:
        reason = "outcome_unknown" if error.outcome_unknown else str(error)
        raise
    finally:
        try:
            await store.settle(
                directive_id=directive_id,
                receipt=receipt.receipt,
                user_id=owner_id,
                action_id=review.action_id,
                context_revision=_CONTEXT_REVISION,
                status=status,
                reason_code=reason,
            )
        except ActionDirectiveAuthorityError:
            # The write's outcome stands; a settlement bookkeeping miss never
            # turns into a retry or a second write.
            pass
