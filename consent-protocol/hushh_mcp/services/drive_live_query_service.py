"""A connection asks; the owner allows or denies; Allow runs one live Drive turn.

Create, Deny and Cancel never read Drive and wake no worker. A new question,
an answer and a decline each queue one opaque notification (drive_query_events,
migration 244) that the scheduled drain delivers. Allow claims the exact
stored question once and runs the owner's own bounded chat turn
(``DriveChatService.run_live_query``), fenced on every step by the owner's
current authority and the claim. The requester receives answer text and file
titles only: no Drive links, file ids, dates or owner-directed instructions.

When the question has search words and no exact title, a tool-less selector
gene judges the keyword-found files before any title is released. The requester
gets only the titles it chose, worded as what they are (judged from names,
types and dates, not opened), or the no-clear-match text when it chose none.
A date-only listing (no search words) and an exact-title match skip the
selector, record the skip (``metadata_listing`` / ``exact_title``)
and release the found titles worded as found, not judged.
"""

from uuid import uuid4

from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.drive_chat_service import DriveChatService
from hushh_mcp.services.drive_live_query_store import (
    FOLDER_MIME,
    MAX_OWNER_FILES,
    DriveLiveQueryStore,
)
from hushh_mcp.services.drive_owner_share_store import DriveOwnerShareStore
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
        # B never sees more titles than A can share (f1..f8).
        more = outcome["found_truncated"] or len(outcome["files"]) > MAX_OWNER_FILES
        if more:
            text += " More matches may exist."
        return {
            "text": text,
            "titles": outcome["titles"][:MAX_OWNER_FILES],
            "truncated": outcome["truncated"] or more,
        }
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
        owner_shares=None,
    ):
        self.store = store or DriveLiveQueryStore()
        self.owner_shares = owner_shares or DriveOwnerShareStore()
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
        share_id = await self._share_files(
            user_id=user_id,
            recipient_user_id=selection["requesterUserId"],
            purpose=selection["query"],
            files=selection["files"],
        )
        return await self.store.record_share(
            user_id=user_id, request_id=request_id, share_request_id=share_id
        )

    async def prepare_owner_share(
        self,
        *,
        user_id,
        recipient_user_id,
        client_request_id,
        query,
        consent_token,
        timezone="UTC",
    ):
        """A searches A's own Drive to share with connection B, from chat.

        One live turn under A's own authority, the same as A's chat; nothing
        is shared and B learns nothing here. The found files (at most 8, no
        folders) are sealed so the share binds exactly what A saw. A retried
        tap returns the first search instead of searching again.
        """
        await self._require_owner()
        if not connector_feature_enabled("google_drive_chat_reads", user_id):
            raise DriveSharingError("sharing_unavailable")
        existing = await self.owner_shares.existing(
            user_id=user_id,
            recipient_user_id=recipient_user_id,
            client_request_id=client_request_id,
        )
        if existing is not None:
            return existing
        files, no_match = await self._owner_search(
            user_id=user_id, query=query, consent_token=consent_token, timezone=timezone
        )
        if no_match is not None:
            return no_match
        await self._require_owner()
        return await self.owner_shares.create(
            user_id=user_id,
            recipient_user_id=recipient_user_id,
            client_request_id=client_request_id,
            query=query,
            owner_files=files,
        )

    async def prepare_trusted_share(
        self, *, user_id, client_request_id, query, consent_token, timezone="UTC"
    ):
        """A searches A's own Drive to share with A's Trusted circle, from chat.

        Only Trusted members A accepted by request or invite are recipients;
        the rest are listed with a reason and never receive anything. One
        search, one sealed row per recipient with the same files, so each
        share runs through the same per-person lane. Nothing is shared here.
        """
        await self._require_owner()
        if not connector_feature_enabled("google_drive_chat_reads", user_id):
            raise DriveSharingError("sharing_unavailable")
        circle = await self.owner_shares.trusted_recipients(user_id=user_id)
        eligible, excluded = [], list(circle["excluded"])
        for member in circle["eligible"]:
            try:
                await self.recipient_identity(member["userId"])
            except DriveSharingError:
                excluded.append({**member, "reason": "no_google_account"})
                continue
            eligible.append(member)
        excluded_view = [{"name": item["name"], "reason": item["reason"]} for item in excluded]
        existing = await self.owner_shares.existing_group(
            user_id=user_id, client_request_id=client_request_id
        )
        if existing:
            return self._group_view(existing, excluded_view)
        if not eligible:
            return {
                "status": "no_recipients",
                "files": [],
                "recipients": [],
                "excluded": excluded_view,
                "message": None,
            }
        files, no_match = await self._owner_search(
            user_id=user_id, query=query, consent_token=consent_token, timezone=timezone
        )
        if no_match is not None:
            return {**no_match, "recipients": [], "excluded": excluded_view}
        rows = []
        for member in eligible:
            await self._require_owner()
            rows.append(
                await self.owner_shares.create(
                    user_id=user_id,
                    recipient_user_id=member["userId"],
                    client_request_id=client_request_id,
                    query=query,
                    owner_files=files,
                )
            )
        return self._group_view(rows, excluded_view)

    @staticmethod
    def _group_view(rows, excluded):
        return {
            "status": "ready" if any(row["status"] == "ready" for row in rows) else "shared",
            "files": rows[0]["files"],
            "recipients": [
                {
                    "requestId": row["requestId"],
                    "name": row["recipientName"],
                    "status": row["status"],
                    "shareRequestId": row["shareRequestId"],
                }
                for row in rows
            ],
            "excluded": excluded,
            "message": None,
        }

    async def _owner_search(self, *, user_id, query, consent_token, timezone):
        """One live turn under A's own authority. Returns (files, None) or (None, no_match)."""

        async def require_access():
            await self._require_owner()
            if not connector_feature_enabled("google_drive_chat_reads", user_id):
                raise PermissionError("Document reads are unavailable")

        outcome = await self.chat.run_live_query(
            user_id=user_id,
            consent_token=consent_token,
            query=query,
            require_access=require_access,
            timezone=timezone,
            require_live=True,
        )
        if outcome["status"] in {"connect_required", "reconnect_required"}:
            raise DriveSharingError("reconnect_required")
        if outcome["status"] not in {"ok", "input_required"}:
            # A failed search (provider, model or timeout) is not "no match".
            raise DriveSharingError("drive_query_unavailable", retryable=True)
        files = (outcome.get("share_files") or []) if outcome["status"] == "ok" else []
        if not any(item.get("mime_type") != FOLDER_MIME for item in files):
            # A's own words from A's own search (e.g. "Which file do you mean?").
            message = outcome.get("answer") if outcome["status"] == "input_required" else None
            return None, {
                "requestId": None,
                "status": "no_match",
                "files": [],
                "message": str(message)[:600] if message else None,
            }
        return files, None

    async def share_owner_files(self, *, user_id, request_id, file_refs):
        """A shares chosen files from A's own search with B, as Viewer."""
        await self._require_owner()
        selection = await self.owner_shares.owner_selection(
            user_id=user_id, request_id=request_id, refs=file_refs
        )
        share_id = await self._share_files(
            user_id=user_id,
            recipient_user_id=selection["recipientUserId"],
            purpose=selection["query"],
            files=selection["files"],
        )
        return await self.owner_shares.record_share(
            user_id=user_id, request_id=request_id, share_request_id=share_id
        )

    async def _share_files(self, *, user_id, recipient_user_id, purpose, files):
        """The one owner-initiated share: A's exact files to B, approved by A.

        A request bound to B's verified Google identity, a review of exactly
        these files (no planner, model or content read), and A's explicit
        approval on the ledger. Grants are queued for the permission worker;
        B sees each link once Google confirms it. Returns the share request id.
        """
        recipient = await self.recipient_identity(recipient_user_id)
        await self._require_owner()
        sharing = self.sharing(self.require_owner)
        # A fresh request per attempt, so one failed attempt never blocks a retry.
        created = await sharing.store.create_request(
            recipient=recipient,
            owner_user_id=user_id,
            client_request_id=str(uuid4()),
            purpose=ShareRequestPurpose(purpose=purpose[:2000]),
            owner_initiated=True,
        )
        share_id = created["requestId"]
        try:
            prepared = await self.suggestions(self.require_owner).run_one(
                user_id=user_id, request_id=share_id, owner_selected=files
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
                raise DriveSharingError("drive_share_unavailable", retryable=True)
        except BaseException:
            await self._abandon(sharing, user_id=user_id, request_id=share_id)
            raise
        return share_id

    async def _abandon(self, sharing, *, user_id, request_id):
        """Close a failed attempt's request so nothing can prepare or share it later."""
        try:
            status = await sharing.store.request_status(user_id=user_id, request_id=request_id)
            await sharing.store.decline_or_cancel(
                user_id=user_id,
                request_id=request_id,
                revision=status["revision"],
                decision="declined",
            )
        except Exception:  # noqa: BLE001 - the original failure is the one to report
            return
