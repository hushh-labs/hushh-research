"""A connection asks; the owner allows or denies; Allow runs one live Drive turn.

Create and Deny never read Drive and wake no worker. Allow claims the exact
stored question once and runs the owner's own bounded chat turn
(``DriveChatService.run_live_query``), fenced on every step by the owner's
current authority and the claim. The requester receives answer text and file
titles only: no Drive links, file ids, dates or owner-directed instructions.

Before any title is released, a tool-less selector gene judges the files the
keyword search found. The requester gets only the titles it chose, worded as
what they are (judged from names, types and dates, not opened), or the
no-clear-match text when it chose none.
"""

from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.drive_chat_service import DriveChatService
from hushh_mcp.services.drive_live_query_store import DriveLiveQueryStore
from hushh_mcp.services.drive_sharing_contract import DriveSharingError

NO_CLEAR_MATCH = (
    "Their Drive didn't have a clear match for this question. Try asking more specifically."
)


def requester_answer(outcome: dict) -> dict:
    """Project a live turn outcome to what the requester may see."""
    if outcome["status"] != "ok":
        return {"text": NO_CLEAR_MATCH, "titles": [], "truncated": False}
    if outcome["files"] is not None:
        # Older outcomes carry no selection trace.
        stage = (outcome.get("selection") or {}).get("stage")
        if outcome["unreadable"]:
            text = "These files look like a match, but their contents couldn't be read."
        elif stage == "completed":
            text = (
                "These files in their Drive look like a match, going by file names, types "
                "and dates. Their private agent didn't open them."
            )
        else:
            text = "These files were found in their Drive for this question."
        if outcome["found_truncated"] or len(outcome["files"]) > 10:
            text += " More matches may exist."
        return {"text": text, "titles": outcome["titles"], "truncated": outcome["truncated"]}
    return {
        "text": outcome["answer"],
        "titles": outcome["titles"],
        "truncated": outcome["truncated"],
    }


class DriveLiveQueryService:
    def __init__(self, *, store=None, chat=None, require_owner=None):
        self.store = store or DriveLiveQueryStore()
        self.chat = chat or DriveChatService()
        self.require_owner = require_owner

    async def _require_owner(self):
        if self.require_owner is None:
            raise DriveSharingError("owner_authority_required")
        await self.require_owner()

    async def create(self, *, requester_user_id, owner_user_id, client_request_id, query):
        return await self.store.create(
            requester_user_id=requester_user_id,
            owner_user_id=owner_user_id,
            client_request_id=client_request_id,
            query=query,
        )

    async def list_requests(self, **kwargs):
        return await self.store.list_requests(**kwargs)

    async def status(self, **kwargs):
        return await self.store.status(**kwargs)

    async def deny(self, *, user_id, request_id, revision):
        await self._require_owner()
        return await self.store.deny(user_id=user_id, request_id=request_id, revision=revision)

    async def allow(self, *, user_id, request_id, revision, consent_token, timezone="UTC"):
        await self._require_owner()
        if not connector_feature_enabled("google_drive_chat_reads", user_id):
            raise DriveSharingError("sharing_unavailable")
        claim = await self.store.claim(user_id=user_id, request_id=request_id, revision=revision)
        claimed = claim["revision"]

        async def require_access():
            await self._require_owner()
            if not connector_feature_enabled("google_drive_chat_reads", user_id):
                raise PermissionError("Document reads are unavailable")
            await self.store.require_claim(user_id=user_id, request_id=request_id, revision=claimed)

        try:
            outcome = await self.chat.run_live_query(
                user_id=user_id,
                consent_token=consent_token,
                query=claim["query"],
                require_access=require_access,
                timezone=timezone,
                require_live=True,
            )
            if outcome["status"] in {"ok", "input_required"}:
                return await self.store.complete(
                    user_id=user_id,
                    request_id=request_id,
                    revision=claimed,
                    answer=requester_answer(outcome),
                )
        except Exception:
            await self.store.release(
                user_id=user_id,
                request_id=request_id,
                revision=claimed,
                error_code="drive_query_unavailable",
            )
            raise
        code = (
            "reconnect_required"
            if outcome["status"] in {"connect_required", "reconnect_required"}
            else "drive_query_unavailable"
        )
        await self.store.release(
            user_id=user_id, request_id=request_id, revision=claimed, error_code=code
        )
        raise DriveSharingError(code, retryable=code == "drive_query_unavailable")
