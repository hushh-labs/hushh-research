"""A connection asks; the owner allows or denies; Allow runs one live Drive turn.

Create, Deny and Cancel never read Drive and wake no worker. Allow claims the exact
stored question once and runs the owner's own bounded chat turn
(``DriveChatService.run_live_query``), fenced on every step by the owner's
current authority and the claim. The requester receives answer text and file
titles only: no Drive links, file ids, dates or owner-directed instructions.

When the question has search words and no exact title, a tool-less selector
gene judges the keyword-found files before any title is released. The requester
gets only the titles it chose, worded as what they are (judged from names,
types and dates, not opened), or the no-clear-match text when it chose none.
A date-only listing (no search words) and an exact-title match skip the
selector, record the skip (``not_applicable_metadata_query`` / ``exact_title``)
and release the found titles worded as found, not judged.
"""

from uuid import NAMESPACE_URL, uuid5

from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.drive_chat_service import DriveChatService
from hushh_mcp.services.drive_live_query_store import DriveLiveQueryStore
from hushh_mcp.services.drive_permission_executor import recipient_identity_for_user
from hushh_mcp.services.drive_sharing_contract import DriveSharingError, ShareRequestPurpose

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
        elif stage in {"completed", "completed_over_limit"}:
            text = (
                "These files in their Drive look like a match, going by file names, types "
                "and dates. Their private agent didn't open them."
            )
        else:
            text = "These files were found in their Drive for this question."
        if outcome["found_truncated"] or len(outcome["files"]) > 10:
            text += " More matches may exist."
        return {"text": text, "titles": outcome["titles"], "truncated": outcome["truncated"]}
    text = outcome["answer"]
    # A count only: which files and why stay with the owner.
    unread = len(outcome.get("not_read") or [])
    if unread == 1:
        text += " 1 matching file couldn't be read."
    elif unread > 1:
        text += f" {unread} matching files couldn't be read."
    return {"text": text, "titles": outcome["titles"], "truncated": outcome["truncated"]}


class DriveLiveQueryService:
    def __init__(
        self,
        *,
        store=None,
        chat=None,
        require_owner=None,
        sharing=None,
        suggestions=None,
        recipient_identity=None,
    ):
        self.store = store or DriveLiveQueryStore()
        self.chat = chat or DriveChatService()
        self.require_owner = require_owner
        # Factories, so each share uses this request's owner authority.
        self.sharing = sharing
        self.suggestions = suggestions
        self.recipient_identity = recipient_identity or recipient_identity_for_user

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

    async def cancel(self, *, user_id, request_id, revision):
        """The asker withdraws their question; never touches the chat turn."""
        await self._require_owner()
        return await self.store.cancel(user_id=user_id, request_id=request_id, revision=revision)

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
                    owner_files=outcome.get("share_files") or [],
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

    async def share(self, *, user_id, request_id, file_refs):
        """A shares chosen files from B's answered question as Viewer.

        The existing exact-file lane does the work: a request bound to B's
        verified Google identity, a review of exactly these files (no planner,
        model or content read), and A's explicit approval on the ledger. Grants
        are queued for the permission worker; B sees each link once Google
        confirms it.
        """
        await self._require_owner()
        selection = await self.store.owner_selection(
            user_id=user_id, request_id=request_id, refs=file_refs
        )
        if selection["shareRequestId"]:
            raise DriveSharingError("request_already_decided")
        recipient = await self.recipient_identity(selection["requesterUserId"])
        await self._require_owner()
        sharing = self.sharing(self.require_owner)
        # One share per question: a retry finds the same request.
        created = await sharing.store.create_request(
            recipient=recipient,
            owner_user_id=user_id,
            client_request_id=str(uuid5(NAMESPACE_URL, f"hushh:drive-query-share:{request_id}")),
            purpose=ShareRequestPurpose(purpose=selection["query"][:2000]),
        )
        share_id = created["requestId"]
        prepared = await self.suggestions(self.require_owner).run_one(
            user_id=user_id, request_id=share_id, owner_selected=selection["files"]
        )
        if prepared != "review_ready":
            raise DriveSharingError("drive_share_unavailable", retryable=True)
        review = await sharing.review(user_id=user_id, request_id=share_id)
        if review.get("canApprove"):
            await sharing.approve(
                user_id=user_id,
                request_id=share_id,
                revision=review["revision"],
                review_digest=review["reviewDigest"],
                document_ids=[item["documentId"] for item in review["files"]],
                confirmed=True,
            )
        elif review.get("status") not in {"approved", "partial", "completed"}:
            # An existing document trust rule may already have approved it.
            raise DriveSharingError("drive_share_unavailable", retryable=True)
        return await self.store.record_share(
            user_id=user_id, request_id=request_id, share_request_id=share_id
        )
