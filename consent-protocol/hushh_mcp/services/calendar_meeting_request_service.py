"""Server-bound Calendar occurrence requests through the existing Drive owner."""

from __future__ import annotations

import asyncio
import re
from datetime import UTC, datetime, timedelta

from db.connection import get_pool
from hushh_mcp.services.actor_identity_service import ActorIdentityService
from hushh_mcp.services.calendar_account_board_service import account_schedule
from hushh_mcp.services.calendar_insights_service import CalendarInsightsService, _grant_id
from hushh_mcp.services.calendar_invitations import own_attendee
from hushh_mcp.services.calendar_meeting_references import library_attachment_refs
from hushh_mcp.services.drive_sharing_contract import (
    CalendarShareOrigin,
    DriveSharingError,
    VerifiedGoogleRecipient,
)
from hushh_mcp.services.drive_sharing_service import DriveSharingService
from hushh_mcp.services.drive_suggestion_service import DriveSuggestionService
from hushh_mcp.services.google_connection_service import get_google_connection_service
from hushh_mcp.services.google_drive_adapter import FILE_ID, DriveReadError, GoogleDriveAdapter


async def verified_calendar_recipient(
    user_id: str, account_id: str, *, expected_grant: str | None = None
) -> VerifiedGoogleRecipient:
    """Fresh selected OAuth subject and verified email, never the sign-in account."""
    connections = get_google_connection_service()
    try:
        async with asyncio.timeout(12):
            grant = await connections.read_calendar_grant_identity(
                user_id=user_id, account_id=account_id
            )
            if not grant or expected_grant and _grant_id(grant.binding) != expected_grant:
                raise DriveSharingError("recipient_changed")
            row = (
                await connections._connection(user_id)
                if account_id == "default"
                else await connections._calendar_account(user_id, account_id)
            )
            if not row or row.get("status") != "connected":
                raise DriveSharingError("recipient_changed")
            token = await connections.access_token(
                user_id=user_id, service="calendar", access_level="read", account_id=account_id
            )
            profile = await connections._userinfo(token)
            current = await connections.read_calendar_grant_identity(
                user_id=user_id, account_id=account_id
            )
            email = str(profile.get("email") or "").strip().lower()
            if (
                current != grant
                or profile.get("email_verified") is not True
                or profile.get("sub") != grant.provider_subject
                or not email
                or email != str(row.get("provider_email") or "").strip().lower()
                or "@" not in email
                or len(email) > 254
            ):
                raise DriveSharingError("recipient_changed")
            return VerifiedGoogleRecipient(
                user_id=user_id,
                subject=grant.provider_subject,
                email=email,
                verified_at=datetime.now(UTC),
                kind="calendar_grant",
                account_id=account_id,
                grant_id=_grant_id(grant.binding),
            )
    except DriveSharingError:
        raise
    except Exception:
        raise DriveSharingError("recipient_verification_unavailable", retryable=True) from None


async def _connected_organizer(user_id: str, email: str) -> str:
    """Resolve only the requester's active One peers, without directory disclosure."""
    pool = await get_pool()
    async with pool.acquire() as connection:
        rows = await connection.fetch(
            """SELECT DISTINCT CASE WHEN c.user_a_id=$1 THEN c.user_b_id ELSE c.user_a_id END AS peer
                 FROM connections c
                 WHERE c.status='active' AND (c.user_a_id=$1 OR c.user_b_id=$1)
                   AND (EXISTS (SELECT 1 FROM actor_identity_cache i
                       WHERE i.user_id=CASE WHEN c.user_a_id=$1 THEN c.user_b_id ELSE c.user_a_id END
                         AND i.email_verified AND lower(i.email)=$2)
                     OR EXISTS (SELECT 1 FROM actor_verified_email_aliases a
                       WHERE a.user_id=CASE WHEN c.user_a_id=$1 THEN c.user_b_id ELSE c.user_a_id END
                         AND a.email_normalized=$2 AND a.verification_status='verified'
                         AND a.revoked_at IS NULL))
                 LIMIT 3""",
            user_id,
            email,
            timeout=5,
        )
    if not rows or len(rows) != 1:
        raise DriveSharingError("calendar_organizer_unavailable")
    peer = str(rows[0]["peer"])
    try:
        fresh = await ActorIdentityService().sync_from_firebase(
            peer, force=True, require_success=True
        )
        async with pool.acquire() as connection:
            alias_verified = await connection.fetchval(
                """SELECT EXISTS (SELECT 1 FROM actor_verified_email_aliases
                   WHERE user_id=$1 AND email_normalized=$2
                     AND verification_status='verified' AND revoked_at IS NULL)""",
                peer,
                email,
                timeout=5,
            )
    except Exception:
        raise DriveSharingError("recipient_verification_unavailable", retryable=True) from None
    if (
        not (
            (fresh or {}).get("email_verified") is True
            and str((fresh or {}).get("email") or "").casefold() == email
        )
        and not alias_verified
    ):
        raise DriveSharingError("calendar_organizer_unavailable")
    return peer


class CalendarMeetingRequestService:
    def __init__(self, sharing: DriveSharingService | None = None):
        self.sharing = sharing or DriveSharingService()

    async def create(
        self,
        *,
        user_id: str,
        account_id: str,
        calendar_id: str,
        event_id: str,
        expected_grant: str,
        occurrence_id: str,
        date: str,
        time_zone: str,
        requested_types: tuple[str, ...],
    ) -> dict:
        recipient = await verified_calendar_recipient(
            user_id, account_id, expected_grant=expected_grant
        )
        insights = CalendarInsightsService(
            schedule=account_schedule(account_id), account_id=account_id
        )
        grant, event = await insights.raw_event(
            user_id=user_id,
            calendar_id=calendar_id,
            event_id=event_id,
            expected_account_email=recipient.email,
            expected_grant=expected_grant,
            occurrence_id=occurrence_id,
            date=date,
            time_zone=time_zone,
        )
        if _grant_id(grant.binding) != recipient.grant_id:
            raise DriveSharingError("recipient_changed")
        attendee = own_attendee(event, recipient.email, raw=True)
        if not attendee or attendee.get("responseStatus") == "declined":
            raise DriveSharingError("calendar_organizer_unavailable")
        organizer_email = str((event.get("organizer") or {}).get("email") or "").strip().lower()
        if not organizer_email or "@" not in organizer_email:
            raise DriveSharingError("calendar_organizer_unavailable")
        organizer = await _connected_organizer(user_id, organizer_email)
        summary = insights.calendar._event_summary(event)
        origin = CalendarShareOrigin(
            account_id=account_id,
            grant_id=recipient.grant_id,
            occurrence_id=occurrence_id,
            calendar_id=calendar_id,
            event_id=event_id,
            date=date,
            time_zone=time_zone,
            title=summary.get("title") or "Meeting",
            start_at=(event.get("start") or {}).get("dateTime") or "",
            end_at=(event.get("end") or {}).get("dateTime") or "",
            organizer_email=organizer_email,
            requested_types=tuple(requested_types),
            exact_refs=tuple(
                {
                    ref["file_id"]: {"file_id": ref["file_id"], "kind": ref["kind"]}
                    for ref in library_attachment_refs(event)
                    if ref["kind"] in requested_types
                }.values()
            )[:8],
        )
        await self.sharing._require_owner()
        result = await self.sharing.store.create_calendar_request(
            recipient=recipient, owner_user_id=organizer, origin=origin
        )
        await self.sharing._require_owner()
        return result

    async def owner_preview(self, *, user_id: str, request_id: str) -> dict:
        await self.sharing._require_owner()
        return await self.sharing.store.calendar_request_preview(
            user_id=user_id, request_id=request_id
        )

    def _candidate_response(
        self,
        *,
        user_id: str,
        request_id: str,
        files: list[dict],
        generation: int,
        revision: int,
        account_label: str | None,
        has_more: bool = False,
    ) -> dict:
        candidate = self.sharing.store.sharing_cipher.seal(
            {
                "files": files,
                "generation": generation,
                "revision": revision,
                "expires_at": (datetime.now(UTC) + timedelta(minutes=5)).isoformat(),
            },
            user_id=user_id,
            resource_id=request_id,
            purpose="calendar-candidates",
        )
        return {
            "files": files,
            "candidateToken": candidate,
            "hasMore": has_more,
            "accountLabel": account_label,
        }

    async def exact_owner_files(self, *, user_id: str, request_id: str) -> dict:
        """Check provider IDs linked to the exact Calendar event under owner Drive."""
        preview = await self.owner_preview(user_id=user_id, request_id=request_id)
        refs = (preview["meeting"].get("exact_refs") or [])[:8]
        if not refs:
            raise DriveSharingError("no_relevant_files")
        row, credential = await self.sharing.oauth.current_credential(
            user_id=user_id, required_profile="live"
        )
        files = []
        for ref in refs:
            try:
                facts = await GoogleDriveAdapter().get_file_facts(
                    file_id=ref["file_id"], access_token=credential["accessToken"]
                )
            except DriveReadError as error:
                if error.status_code in {403, 404}:
                    continue
                raise
            mime = facts["mimeType"]
            kind = (
                "recording"
                if isinstance(mime, str) and mime.startswith("video/")
                else "notes"
                if mime in {"application/vnd.google-apps.document", "text/plain", "text/markdown"}
                else None
            )
            if (
                kind == ref["kind"]
                and (facts.get("capabilities") or {}).get("canShare") is True
                and isinstance(facts.get("title"), str)
                and 1 <= len(facts["title"]) <= 1024
            ):
                files.append(
                    {
                        "file_id": ref["file_id"],
                        "name": facts["title"],
                        "mime_type": mime,
                        "artifact_kind": kind,
                    }
                )
        await self.sharing._require_owner()
        current = await self.sharing.oauth.lifecycle.read(
            user_id=user_id, connector_id="google_drive"
        )
        if not current or current["connection_generation"] != row["connection_generation"]:
            raise DriveSharingError("connection_changed")
        latest = await self.sharing.store.calendar_request_preview(
            user_id=user_id, request_id=request_id
        )
        if latest["revision"] != preview["revision"]:
            raise DriveSharingError("review_changed")
        return self._candidate_response(
            user_id=user_id,
            request_id=request_id,
            files=files,
            generation=row["connection_generation"],
            revision=preview["revision"],
            account_label=credential.get("accountLabel"),
        )

    async def search_owner_files(self, *, user_id: str, request_id: str, query: str) -> dict:
        """One explicit, bounded Drive name search; no model or content access."""
        if not 3 <= len(query.strip()) <= 80 or not re.fullmatch(r"[\w .()'-]+", query):
            raise DriveSharingError("invalid_argument")
        preview = await self.owner_preview(user_id=user_id, request_id=request_id)
        row, credential = await self.sharing.oauth.current_credential(
            user_id=user_id, required_profile="live"
        )
        escaped = query.strip().replace("\\", "\\\\").replace("'", "\\'")
        result = await GoogleDriveAdapter().list_files(
            access_token=credential["accessToken"],
            query=f"trashed = false and name contains '{escaped}'",
            page_size=25,
            order_by="modifiedTime desc",
        )
        await self.sharing._require_owner()
        current = await self.sharing.oauth.lifecycle.read(
            user_id=user_id, connector_id="google_drive"
        )
        if not current or current["connection_generation"] != row["connection_generation"]:
            raise DriveSharingError("connection_changed")
        await self.sharing.store.calendar_request_preview(user_id=user_id, request_id=request_id)
        allowed = set(preview["meeting"]["requested_types"])
        files = []
        for item in result.get("files") or []:
            if not isinstance(item, dict):
                continue
            mime = item.get("mimeType")
            kind = (
                "recording"
                if isinstance(mime, str) and mime.startswith("video/")
                else "notes"
                if mime in {"application/vnd.google-apps.document", "text/plain", "text/markdown"}
                else None
            )
            if (
                kind not in allowed
                or not isinstance(item.get("id"), str)
                or not FILE_ID.fullmatch(item["id"])
                or not isinstance(item.get("name"), str)
                or not 1 <= len(item["name"]) <= 1024
                or (item.get("capabilities") or {}).get("canShare") is not True
            ):
                continue
            files.append(
                {
                    "file_id": item["id"],
                    "name": item["name"],
                    "mime_type": mime,
                    "artifact_kind": kind,
                }
            )
        return self._candidate_response(
            user_id=user_id,
            request_id=request_id,
            files=files,
            generation=row["connection_generation"],
            revision=preview["revision"],
            account_label=credential.get("accountLabel"),
            has_more=bool(result.get("nextPageToken") or result.get("incompleteSearch")),
        )

    async def prepare_owner_review(
        self,
        *,
        user_id: str,
        request_id: str,
        candidate_token: dict,
        file_ids: list[str],
        occurrence_confirmed: bool,
    ) -> dict:
        if occurrence_confirmed is not True:
            raise DriveSharingError("confirmation_required")
        preview = await self.owner_preview(user_id=user_id, request_id=request_id)
        try:
            candidate = self.sharing.store.sharing_cipher.open(
                candidate_token,
                user_id=user_id,
                resource_id=request_id,
                purpose="calendar-candidates",
            )
            expires = datetime.fromisoformat(candidate["expires_at"])
            if expires.tzinfo is None or expires <= datetime.now(UTC):
                raise ValueError()
            if candidate["revision"] != preview["revision"]:
                raise DriveSharingError("review_changed")
            selected = [item for item in candidate["files"] if item["file_id"] in file_ids]
            if (
                not 1 <= len(file_ids) <= 8
                or len(set(file_ids)) != len(file_ids)
                or len(selected) != len(file_ids)
                or any(
                    item["artifact_kind"] not in preview["meeting"]["requested_types"]
                    for item in selected
                )
            ):
                raise ValueError()
        except (KeyError, TypeError, ValueError):
            raise DriveSharingError("invalid_selection") from None
        row, _ = await self.sharing.oauth.current_credential(
            user_id=user_id, required_profile="live"
        )
        if row["connection_generation"] != candidate["generation"]:
            raise DriveSharingError("connection_changed")
        await self.sharing.store.reset_calendar_preparation(
            user_id=user_id,
            request_id=request_id,
            expected_revision=candidate["revision"],
        )
        prepared = await DriveSuggestionService(
            oauth=self.sharing.oauth, require_owner=self.sharing.require_owner
        ).run_one(user_id=user_id, request_id=request_id, owner_selected=selected)
        if prepared != "review_ready":
            raise DriveSharingError("drive_share_unavailable", retryable=True)
        review = await self.sharing.review(user_id=user_id, request_id=request_id)
        if review.get("requestType") != "calendar_meeting" or not review.get("canApprove"):
            raise DriveSharingError("review_changed")
        return review
