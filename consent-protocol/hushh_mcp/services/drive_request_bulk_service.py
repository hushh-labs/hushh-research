"""One requester, one durable Drive search, one exact frozen share review."""

from __future__ import annotations

import asyncio
import json
import re
from datetime import UTC, datetime
from uuid import uuid4

from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore
from hushh_mcp.services.drive_owner_search_service import DriveOwnerSearchService
from hushh_mcp.services.drive_permission_executor import recipient_identity_for_user
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.drive_sharing_store import DriveSharingStore
from hushh_mcp.services.drive_suggestion_service import (
    LiveSearchPlan,
    interpret_live_search,
    plan_live_search,
)
from hushh_mcp.services.drive_work_wake import wake_drive_work
from hushh_mcp.services.google_drive_adapter import DriveReadError

_DOCUMENT_NOUN = re.compile(r"\b(?:docs?|documents?)\b", re.I)
_PLURAL_DOCUMENT_NOUN = re.compile(r"\b(?:docs|documents)\b", re.I)
_OTHER_FILE_NOUN = re.compile(
    r"\b(?:photos?|images?|videos?|recordings?|audios?|sheets?|spreadsheets?|slides?|presentations?|pdfs?|folders?)\b",
    re.I,
)
_GENERIC_SEARCH_TERM = re.compile(
    r"\b(?:docs?|documents?|files?|pdfs?|months?|weeks?|days?)\b"
    r"|\b(?:last|past|latest|recent)\s+\d{1,2}\b",
    re.I,
)
_LITERAL_TITLE = re.compile(r"[\"“][^\"”]{3,}[\"”]|\S+\.(?:pdf|docx?|txt|md)\b", re.I)
_NAMED_TITLE_CUE = re.compile(r"\b(?:file|document|doc)\s+(?:named|called|titled)\b", re.I)
_TOPIC_NEAR_DOCUMENT = re.compile(
    r"\b([A-Za-z][A-Za-z0-9_-]*)\s+(?:docs?|documents?)\b"
    r"|\b(?:docs?|documents?)\s+(?:for|about|on|regarding)\s+([A-Za-z][A-Za-z0-9_-]*)\b",
    re.I,
)
_GENERIC_TOPIC = frozenset(
    {
        "all",
        "any",
        "my",
        "the",
        "some",
        "these",
        "those",
        "recent",
        "latest",
        # Count words next to "documents" are not a topic requirement. The
        # planner still owns the number; this validator never derives one.
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
        "nine",
        "ten",
        "eleven",
        "twelve",
        "thirteen",
        "fourteen",
        "fifteen",
        "sixteen",
        "seventeen",
        "eighteen",
        "nineteen",
        "twenty",
        "thirty",
        "forty",
        "fifty",
        "sixty",
        "seventy",
        "eighty",
        "ninety",
        "hundred",
        "thousand",
    }
)

_STATEMENT_NOUN = re.compile(r"\bstatements?\b", re.I)
_BROKERAGE_NOUN = re.compile(r"\b(?:brokerage|broker)\b", re.I)
_GENERIC_BANK_STATEMENT = re.compile(r"^\s*bank\s+statements?\s*$", re.I)
_SCHWAB_ISSUER = re.compile(r"\b(?:charles\s+)?schwab\b", re.I)


def _deterministic_statement_plan(
    purpose: dict, *, include_bank: bool = False
) -> LiveSearchPlan | None:
    """Plan supported brokerage and V1 bank-statement requests without a model call.

    The selected period belongs to the document contents. It is deliberately
    absent from Drive metadata filters, and provider matches remain candidates
    until the request evidence/approval path verifies them.
    """
    query = purpose.get("purpose", "")
    if not isinstance(query, str) or not _STATEMENT_NOUN.search(query):
        return None
    brokerage = bool(_BROKERAGE_NOUN.search(query))
    schwab = bool(_SCHWAB_ISSUER.search(query))
    # A named bank must remain a semantic plan so its issuer becomes an
    # explicit evidence requirement; this generic path has no issuer to bind.
    bank = include_bank and bool(_GENERIC_BANK_STATEMENT.fullmatch(query))
    if not (brokerage or schwab or bank):
        return None
    terms = []
    groups = []
    if schwab:
        terms.append("Schwab")
        groups.append(["Schwab", "Charles Schwab"])
    if brokerage:
        terms.append("brokerage")
        groups.append(["brokerage", "broker"])
    if bank:
        terms.append("bank")
        groups.append(["bank", "banking"])
    terms.append("statement")
    groups.append(["statement", "statements"])
    return LiveSearchPlan(
        mode="find",
        terms=terms,
        term_groups=groups,
        semantic_intent="institutional_statement",
        required_entities=["Schwab"] if schwab else [],
        subject_scope="specific_records",
        subject_complete=True,
        file_kind="document",
        time_intent="document_coverage",
    )


class DriveRequestBulkService:
    def __init__(
        self,
        *,
        sharing=None,
        search=None,
        bulk=None,
        planner=interpret_live_search,
        recipient_identity=None,
        require_owner=None,
        wake=None,
    ):
        self.sharing = sharing or DriveSharingStore()
        self.search = search or DriveOwnerSearchService()
        self.bulk = bulk or DriveBulkShareStore()
        self.planner = planner
        self.recipient_identity = recipient_identity or recipient_identity_for_user
        self.require_owner = require_owner
        self.wake = wake or wake_drive_work

    async def _owner(self):
        if self.require_owner is None:
            raise DriveSharingError("owner_authority_required")
        await self.require_owner()

    async def _context(self, user_id, request_id, *, start=False):
        await self._owner()
        context = await self.sharing.request_bulk_context(
            user_id=user_id, request_id=request_id, start=start
        )
        await self._owner()
        return context

    async def _plan(self, *, user_id, purpose, timezone, requested_at=None):
        query = purpose["purpose"]
        prompt = {
            "document_request": purpose,
            "transaction_search": True,
            "current_time_utc": (
                requested_at if isinstance(requested_at, datetime) else datetime.now(UTC)
            )
            .astimezone(UTC)
            .isoformat(timespec="seconds"),
            "user_timezone": timezone,
        }
        documents_only = bool(_DOCUMENT_NOUN.search(query) and not _OTHER_FILE_NOUN.search(query))
        near_kind = _TOPIC_NEAR_DOCUMENT.search(query)
        topic_required = bool(
            near_kind
            and next((part for part in near_kind.groups() if part), "").casefold()
            not in _GENERIC_TOPIC
        )
        async with asyncio.timeout(65):
            for attempt in (1, 2):
                plan = await plan_live_search(
                    self.planner,
                    prompt=json.dumps(prompt, ensure_ascii=False),
                    user_id=user_id,
                )
                if plan.mode != "find":
                    raise DriveReadError("invalid_argument")
                mismatch = (
                    documents_only
                    and plan.semantic_intent != "broad_financial_records"
                    and plan.file_kind != "document"
                    or any(_GENERIC_SEARCH_TERM.search(term) for term in plan.terms)
                    or bool(
                        plan.exact_title
                        and _PLURAL_DOCUMENT_NOUN.search(query)
                        and not _LITERAL_TITLE.search(query)
                        and not _NAMED_TITLE_CUE.search(query)
                    )
                    or topic_required
                    and not plan.terms
                    and not plan.exact_title
                )
                if not mismatch:
                    return plan
                if attempt == 2:
                    break
                # Reject a valid-shaped but contradictory plan and ask the
                # semantic planner to correct it. Never silently change its
                # selected terms or type in the host.
                prompt["plan_validation"] = (
                    "The search plan is inconsistent with the request. When it asks for "
                    "documents without another file type, use file_kind=document, including "
                    "Google Docs, PDFs and text files. Keep only distinctive subject terms; "
                    "file-type words and date-window phrases are not search terms. Use "
                    "exact_title only when the request names one literal file. A named "
                    "topic needs at least one distinctive subject term."
                )
        raise DriveReadError("invalid_argument")

    async def start_search(
        self, *, user_id, request_id, timezone="UTC", authority_mode="owner", after_page=None
    ):
        if authority_mode not in {"owner", "trusted_auto", "agent_package"}:
            raise DriveSharingError("invalid_argument")
        context = await self._context(user_id, request_id)
        if context.get("agentPackageRequired"):
            authority_mode = "agent_package"
            await self.sharing.package_preparation_authority(user_id=user_id, request_id=request_id)
        purpose = context["purpose"]
        if not (purpose.get("periodStart") and purpose.get("periodEnd")) and not context.get(
            "reusablePacket"
        ):
            raise DriveSharingError("date_range_required")
        # The requester authored words such as "yesterday". Freeze that
        # calendar context when the request is created, before a delayed worker
        # or an owner in a different timezone can reinterpret it.
        timezone = context.get("requestTimeZone") or timezone
        requested_at = context.get("requestCreatedAt")
        statement_plan = (
            _deterministic_statement_plan(purpose, include_bank=bool(context.get("v1LiveRequest")))
            if authority_mode != "agent_package" or context.get("v1LiveRequest")
            else None
        )
        existing = await self.search.store.by_client(user_id=user_id, client_request_id=request_id)
        if existing is not None and statement_plan is not None and not context.get("v1LiveRequest"):
            replanned, changed = await self.search.replan_legacy_statement_request(
                user_id=user_id, request_id=request_id, context=context
            )
            if replanned is not None:
                existing = replanned
            if changed:
                await self.wake("v1")
        if (
            existing is not None
            and existing["status"] == "completed"
            and await self.search.store.clear_legacy_completed_request(
                user_id=user_id, request_id=request_id
            )
        ):
            # Refresh unfrozen legacy results before takeover can return them.
            # The store preserves current selections and frozen/paid history.
            existing = None
        if authority_mode == "owner":
            # This authenticated owner action can explicitly take over an
            # earlier automatic request. Its exact results and frozen batches
            # survive; the auto worker loses authority at the mode fence.
            takeover = await self.search.store.takeover_request(
                user_id=user_id, request_id=request_id
            )
            if takeover is not None:
                await self._owner()
                if takeover["status"] == "queued":
                    await self.wake("suggestions")
                # Queued auto effects are now fenced. Let the sharing worker
                # settle them as never-posted skips so owner recovery appears.
                await self.wake("sharing")
                return takeover
        if existing is not None and existing["status"] not in {"failed", "limited", "stopped"}:
            return existing
        if existing is not None and existing["status"] == "failed":
            # A retry continues the same frozen plan, provider cursor and
            # result positions. Recreating a search could duplicate or change
            # progressive batches already bound to those positions.
            context = await self._context(user_id, request_id, start=True)
            recovered, changed = await self.search.store.retry_failed_request(
                user_id=user_id,
                request_id=request_id,
                request_revision=context["revision"],
                authority_mode=authority_mode,
            )
            if recovered is not None:
                if changed:
                    await self.wake("v1" if context.get("v1LiveRequest") else "suggestions")
                return recovered
        route = None
        if authority_mode == "agent_package" and not context.get("v1LiveRequest"):
            route = await self.search.request_evidence_route(
                user_id=user_id, reusable_packet=context.get("reusablePacket"), request=purpose
            )
        if route and route["kind"] in {"packet", "index"}:
            # Meaning is assessed against all indexed facts. No filename/date
            # metadata filter is allowed to discard a relevant candidate.
            plan = {
                "mode": "find",
                "terms": [],
                "file_kind": "any",
                "time_intent": "document_coverage",
            }
        else:
            plan = (
                statement_plan
                if statement_plan is not None
                else await self._plan(
                    user_id=user_id,
                    purpose=context["purpose"],
                    timezone=timezone,
                    requested_at=requested_at,
                )
            ).model_dump(mode="json")
        context = await self._context(user_id, request_id, start=True)
        await self._owner()
        return await self.search.create_for_request(
            user_id=user_id,
            request_id=request_id,
            request_revision=context["revision"],
            purpose=context["purpose"],
            plan=plan,
            timezone=timezone,
            requested_at=requested_at,
            require_current=self.require_owner,
            authority_mode=authority_mode,
            **({"v1_live_request": True} if context.get("v1LiveRequest") else {}),
            **({"evidence_route": route} if route is not None else {}),
            **({"after_page": after_page} if after_page is not None else {}),
        )

    async def search_status(self, *, user_id, request_id):
        await self._context(user_id, request_id)
        return await self.search.store.by_client(user_id=user_id, client_request_id=request_id)

    async def search_files(self, *, user_id, request_id, cursor=None):
        state = await self.search_status(user_id=user_id, request_id=request_id)
        if state is None:
            raise DriveReadError("search_not_found")
        return await self.search.results(
            user_id=user_id,
            job_id=state["jobId"],
            cursor=cursor,
            request_id=request_id,
            require_current=self.require_owner,
        )

    async def review_context(self, *, user_id, request_id):
        context = await self._context(user_id, request_id)
        if not context["searchStarted"]:
            # Batch fields exist only with a search. The owner's review parser
            # rejects them without one, so a new request would never load.
            return {"search": None, "bulkShare": None}
        search = await self.search.store.by_client(user_id=user_id, client_request_id=request_id)
        if (
            search is not None
            and search["status"] == "completed"
            and not context.get("agentPackageRequired")
            and _deterministic_statement_plan(context["purpose"]) is not None
        ):
            replanned, changed = await self.search.replan_legacy_statement_request(
                user_id=user_id, request_id=request_id, context=context
            )
            if replanned is not None:
                search = replanned
            if changed:
                await self.wake("v1")
        if search is not None and search["status"] == "completed":
            await self.bulk.refresh_request(user_id=user_id, request_id=request_id)
        batches = await self.bulk.batches_by_request(user_id=user_id, request_id=request_id)
        await self._owner()
        return {
            "search": search,
            "bulkShare": batches["batches"][0] if batches["batches"] else None,
            **batches,
        }

    async def prepare(self, *, user_id, request_id, excluded_positions=None, positions=None):
        context = await self._context(user_id, request_id)
        if context.get("agentPackageRequired") and not context.get("packageAllowed"):
            raise DriveSharingError("package_not_allowed")
        purpose = context["purpose"]
        if context.get("reusablePacket"):
            await self.search.request_evidence_route(
                user_id=user_id, reusable_packet=context["reusablePacket"]
            )
        elif not (purpose.get("periodStart") and purpose.get("periodEnd")):
            raise DriveSharingError("date_range_required")
        if context["status"] not in {"pending", "review_ready"} or not context["searchStarted"]:
            raise DriveSharingError("request_changed")
        state = await self.search.store.by_client(user_id=user_id, client_request_id=request_id)
        if state is None:
            raise DriveSharingError("search_not_found")
        if (
            state["status"]
            not in ({"queued", "running", "completed"} if positions is not None else {"completed"})
            or state["incompleteSearch"]
        ):
            raise DriveSharingError("search_incomplete")
        verified = await self.recipient_identity(context["recipientUserId"])
        if (
            verified.user_id != context["recipientUserId"]
            or verified.subject != context["recipient"]["subject"]
            or verified.email != context["recipient"]["email"]
            or verified.kind != context["recipient"].get("kind", "google_provider")
        ):
            raise DriveSharingError("recipient_changed")
        await self._owner()
        result = await self.bulk.create_review(
            user_id=user_id,
            search_job_id=state["jobId"],
            client_request_id=str(uuid4()) if positions is not None else request_id,
            origin_request_id=request_id,
            recipients=[
                {
                    "userId": verified.user_id,
                    "email": verified.email,
                    "subject": verified.subject,
                    "kind": verified.kind,
                    "name": None,
                }
            ],
            excluded=[],
            excluded_positions=excluded_positions or [],
            selected_positions=positions,
        )
        await self._owner()
        return result
