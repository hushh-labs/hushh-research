"""Read and assess one owner's selected mail inside their private agent."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
from datetime import datetime, timezone
from email.utils import getaddresses
from functools import partial
from typing import Annotated, Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.agents.email.runtime import EMAIL_DRAFT_SCHEMA, run_email_gene
from hushh_mcp.services import pod_connector_credentials as credentials
from hushh_mcp.services.byoc_key_custody import resolve_pod_log_key
from hushh_mcp.services.calendar_email_followup_relevance import quoted_or_signature_regions
from hushh_mcp.services.gmail_metadata_reader import GmailMetadataError, GmailMetadataReader
from hushh_mcp.services.mail_promise_date import promise_deadline
from hushh_mcp.services.mail_source_identity import open_source_id, seal_source_id
from hushh_mcp.services.pod_gmail_local import PodGmailConnection


def _refuse(status, code):
    return HTTPException(status_code=status, detail={"code": code})


class Selection(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    account: str = Field(min_length=1, max_length=256)
    connection: str = Field(min_length=1, max_length=256)


class Search(Selection):
    query: str = Field(min_length=1, max_length=512)


class Source(Selection):
    source: str = Field(min_length=16, max_length=2048)


class OpenMessage(Source):
    summarize: bool = False


class Document(Source):
    filename: str = Field(min_length=1, max_length=255)


class Track(Source):
    tracked_quotes: list[Annotated[str, Field(min_length=3, max_length=500)]] = Field(
        default_factory=list, max_length=32
    )
    expectation: str = Field(min_length=1, max_length=500)


class Promise(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    title: str = Field(min_length=1, max_length=160)
    reason: str = Field(
        min_length=1,
        max_length=220,
        description="One brief reason this obligation needs attention, grounded in the selected email",
    )
    participant: str = Field(min_length=1, max_length=160)
    debtor: str = Field(
        min_length=3,
        max_length=320,
        description="Exact email address of the participant who owes this step, from the supplied headers",
    )
    waiting_on: Literal["owner", "participant"]
    quote: str = Field(min_length=3, max_length=500)
    fulfilment: str = Field(min_length=1, max_length=240)
    promised_wording: str | None = Field(default=None, max_length=80)
    document: str | None = Field(default=None, max_length=160)


class Tracked(Source):
    quote: str = Field(min_length=3, max_length=500)
    fulfilment: str = Field(min_length=1, max_length=240)
    document: str | None = Field(max_length=160)
    debtor: str = Field(min_length=3, max_length=320)


class Match(BaseModel):
    ref: str = Field(max_length=20)
    quote: str = Field(min_length=3, max_length=500)
    filename: str | None = Field(default=None, max_length=255)


class Completion(BaseModel):
    match: Match | None


def eligible_replies(rows, ids, threads, source, debtor):
    index = ids.index(source)
    origin = rows[index]
    since = datetime.fromisoformat(origin["received_at"])
    eligible = {}
    for row, identity, thread in zip(rows, ids, threads, strict=True):
        headers = row.get("headers_metadata", {})
        if (
            thread != threads[index]
            or identity == source
            or not row.get("received_at")
            or datetime.fromisoformat(row["received_at"]) <= since
            or row.get("body_truncated")
            or headers.get("auto_submitted", "").lower() not in {"", "no"}
            or set(headers.get("labels", [])) & {"DRAFT", "TRASH", "SPAM"}
        ):
            continue
        senders = getaddresses([headers.get("from", "")])
        if len(senders) == 1 and senders[0][1].casefold() == debtor.casefold():
            eligible[row["source_ref"]] = (identity, row)
    return eligible


def verified_match(match, eligible, document):
    if not match or match.ref not in eligible:
        return None
    identity, row = eligible[match.ref]
    body = row["body"]
    if body.count(match.quote) != 1:
        return None
    start = body.index(match.quote)
    if any(
        start < right and left < start + len(match.quote)
        for left, right in quoted_or_signature_regions(body)
    ):
        return None
    files = {
        file["filename"]
        for file in row.get("attachment_details", [])
        if (file.get("size_bytes") or 0) > 0
    }
    if (document or match.filename) and match.filename not in files:
        return None
    return identity


class Assessment(BaseModel):
    promise: Promise | None


def verify_promise(promise: Promise | None, body: str) -> Promise:
    if promise is None or body.count(promise.quote) != 1:
        raise _refuse(422, "MAIL_PROMISE_UNVERIFIED")
    start = body.index(promise.quote)
    if any(
        start < right and left < start + len(promise.quote)
        for left, right in quoted_or_signature_regions(body)
    ):
        raise _refuse(422, "MAIL_PROMISE_UNVERIFIED")
    if promise.promised_wording and promise.promised_wording not in promise.quote:
        raise _refuse(422, "MAIL_DATE_UNVERIFIED")
    return promise


class DocumentProof(BaseModel):
    evidence: str | None = Field(max_length=500)


async def verify_document(reader, identity, filename, request, owner, consent_token, model_factory):
    from hushh_mcp.services.mail_attachment_parser import parse_mail_attachment

    blob = await reader.get_attachment_bytes(message_id=identity, filename=filename)
    if (
        blob.get("status") != "ok"
        or blob.get("filename") != filename
        or sum(f["filename"] == filename for f in blob["attachments"]) != 1
    ):
        raise _refuse(409, "MAIL_DOCUMENT_CHANGED")
    mime = blob["mime_type"].lower()
    if mime not in {"application/pdf", "text/csv", "application/csv", "text/plain"}:
        raise _refuse(422, "MAIL_DOCUMENT_REVIEW_REQUIRED")
    if mime == "text/plain":
        if len(blob["content"]) > 16000:
            raise _refuse(422, "MAIL_DOCUMENT_REVIEW_REQUIRED")
        content = blob["content"].decode("utf-8")
    else:
        parsed = await parse_mail_attachment(
            blob["content"], "text/csv" if mime == "application/csv" else mime
        )
        content = "\n".join(parsed.pages)
        if parsed.truncated:
            raise _refuse(422, "MAIL_DOCUMENT_REVIEW_REQUIRED")
    if not content.strip() or len(content) > 16000:
        raise _refuse(422, "MAIL_DOCUMENT_REVIEW_REQUIRED")
    result = await run_email_gene(
        gene_id="agent_email_followup_extractor",
        user_id=owner,
        consent_token=consent_token,
        model=model_factory(),
        output_schema=DocumentProof,
        retry_on_failure=False,
        timeout_seconds=25,
        prompt=json.dumps(
            {
                "operation": "mail_verify_document",
                "obligation": request.quote,
                "required": request.fulfilment,
                "untrusted_document": content,
            }
        ),
    )
    evidence = DocumentProof.model_validate(result).evidence
    await reader.require_current()
    return bool(evidence and evidence.strip() and content.count(evidence) == 1)


def obligation_key(connection, source, quote):
    return hashlib.sha256(json.dumps([connection, source, quote]).encode()).hexdigest()


async def run_mail(operation, selection, *, owner, check, consent_token, model_factory):
    await check()

    held = credentials.active_mail_account(selection.account)
    if (
        not held
        or held.status != credentials.STATUS_CONNECTED
        or held.credential_id != selection.connection
    ):
        raise _refuse(409, "MAIL_CONNECTION_CHANGED")

    async def current():
        await check()
        active = credentials.active_mail_account(selection.account)
        if (
            not active
            or active.credential_id != held.credential_id
            or active.status != credentials.STATUS_CONNECTED
        ):
            raise _refuse(409, "MAIL_CONNECTION_CHANGED")

    connection = PodGmailConnection(owner, local_grant=held)

    def new_reader():
        from hushh_mcp.services.mail_overview import OverviewMailReader

        reader_type = (
            OverviewMailReader if operation in {"brief", "recent"} else GmailMetadataReader
        )
        return reader_type(
            gmail=connection,
            user_id=owner,
            require_access=current,
            expect_account=held.account_subject,
            expose_message_links=True,
        )

    return await assess_mail(
        operation,
        selection,
        owner=owner,
        new_reader=new_reader,
        credential_id=held.credential_id,
        key_resolver=resolve_pod_log_key,
        owner_address=lambda: connection._email,
        consent_token=consent_token,
        model_factory=model_factory,
        delivery_context=(connection, held),
    )


async def assess_mail(
    operation,
    selection,
    *,
    owner,
    new_reader,
    credential_id,
    key_resolver,
    owner_address,
    consent_token,
    model_factory,
    delivery_context=None,
):
    reader = new_reader()
    if operation == "account":
        profile = await reader.get_profile_and_history()
        return {
            "account": selection.account,
            "connection": credential_id,
            "address": profile["email_address"],
        }

    key = await asyncio.to_thread(key_resolver)

    def source_ref(identity):
        return seal_source_id(
            key=key, owner_user_id=owner, account=credential_id, message_id=identity
        )

    if operation == "recent":
        page = await reader.list_rows(query="", limit=12)
        return {
            "items": [
                {
                    "source": source_ref(row["message_id"]),
                    "subject": row["subject"] or "",
                    "sender": row["sender"] or "",
                }
                for row in page["rows"]
            ]
        }

    if operation == "brief":
        from hushh_mcp.services import mail_overview_brief as brief
        from hushh_mcp.services.pod_ai_selection import ai_selection_revision

        revision = ai_selection_revision()
        try:
            rows = await reader.brief_window(
                days=brief.BRIEF_WINDOW_DAYS, limit=brief.BRIEF_MAX_MESSAGES
            )
        except GmailMetadataError as error:
            if error.code != "response_too_large":
                raise
            reader = new_reader()
            rows = await reader.brief_window(
                days=brief.BRIEF_WINDOW_DAYS, limit=brief.BRIEF_SMALL_WINDOW
            )
        now = datetime.now(timezone.utc)
        packet = brief.build_packet(rows, now=now)
        verified = {"attention": [], "updates": []}
        if packet.messages:
            model = model_factory()
            if model is None:
                raise _refuse(503, "PRIVATE_MAIL_MODEL_UNAVAILABLE")
            raw = await brief._run_gene(
                brief.model_prompt(packet), owner, consent_token, model=model
            )
            verified = brief.verify_brief(
                raw,
                packet,
                owner_user_id=owner,
                account=credential_id,
                seal=partial(seal_source_id, key=key),
            )
        await reader.require_current()
        if ai_selection_revision() != revision:
            raise _refuse(409, "OWNER_AI_SELECTION_CHANGED")
        return {
            "account": selection.account,
            "generated_at": now.isoformat(),
            "coverage": {
                "messages": len(packet.messages),
                "window_days": brief.BRIEF_WINDOW_DAYS,
                "may_be_partial": reader.brief_has_more,
            },
            "incomplete": verified.get("incomplete", []),
            "attention": verified["attention"],
            "updates": verified["updates"],
        }

    if operation == "search":
        page = await reader.read(
            "search_inbox", {"query": selection.query, "mailbox": "anywhere", "limit": 12}
        )
    else:
        source = open_source_id(selection.source, owner_user_id=owner, key=key)
        if source.account != credential_id:
            raise _refuse(409, "MAIL_ACCOUNT_CHANGED")
        if operation == "document":
            result = await reader.get_attachment_bytes(
                message_id=source.message_id, filename=selection.filename
            )
            if (
                result.get("status") != "ok"
                or result["filename"] != selection.filename
                or sum(f["filename"] == selection.filename for f in result["attachments"]) != 1
            ):
                raise _refuse(409, "MAIL_DOCUMENT_CHANGED")
            await reader.require_current()
            return {"content": base64.b64encode(result["content"]).decode("ascii")}
        page = await reader.read_threads(
            message_ids=[source.message_id], whole_thread=operation == "check", include_headers=True
        )
    rows = page["untrusted_external_content"]
    ids = reader.offered_message_ids()
    if len(rows) != len(ids):
        raise _refuse(502, "MAIL_SOURCE_UNAVAILABLE")
    if operation == "search":
        return {
            "items": [
                {"source": source_ref(identity), "subject": row["subject"], "sender": row["sender"]}
                for row, identity in zip(rows, ids, strict=True)
            ]
        }
    if operation == "check":
        if page.get("truncated"):
            raise _refuse(409, "MAIL_SOURCE_INCOMPLETE")
        if source.message_id not in ids:
            raise _refuse(409, "MAIL_SOURCE_INCOMPLETE")
        origin = rows[ids.index(source.message_id)]
        if selection.quote not in origin["body"]:
            raise _refuse(409, "MAIL_SOURCE_CHANGED")
        eligible = eligible_replies(
            rows, ids, reader.offered_thread_ids(), source.message_id, selection.debtor
        )
        found = None
        if eligible:
            answer = await run_email_gene(
                gene_id="agent_email_followup_extractor",
                prompt=json.dumps(
                    {
                        "operation": "mail_check_request",
                        "obligation": selection.quote,
                        "required": selection.fulfilment,
                        "document": selection.document,
                        "untrusted_replies": [
                            {
                                "ref": ref,
                                "body": row["body"],
                                "files": row.get("attachment_details", []),
                            }
                            for ref, (_, row) in eligible.items()
                        ],
                    }
                ),
                user_id=owner,
                consent_token=consent_token,
                output_schema=Completion,
                model=model_factory(),
                timeout_seconds=25,
                retry_on_failure=False,
            )
            match = Completion.model_validate(answer).match
            found = verified_match(match, eligible, selection.document)
            if match and not found:
                raise _refuse(422, "MAIL_MATCH_UNVERIFIED")
        if (
            found
            and selection.document
            and not await verify_document(
                new_reader(), found, match.filename, selection, owner, consent_token, model_factory
            )
        ):
            found = None
        await reader.require_current()
        return {
            "source": source_ref(found) if found else None,
            "filename": match.filename if found else None,
        }
    if ids != (source.message_id,):
        raise _refuse(409, "MAIL_SOURCE_CHANGED")
    row = rows[0]
    if operation == "open":
        summary = {}
        if isinstance(selection, OpenMessage) and selection.summarize:
            from hushh_mcp.services.email_delegated_read import MailReadAnswer
            from hushh_mcp.services.pod_ai_selection import ai_selection_revision

            revision = ai_selection_revision()
            model = model_factory()
            if model is None or not (row.get("body") or "").strip():
                raise _refuse(503, "MAIL_SUMMARY_UNAVAILABLE")
            ref = row["source_ref"]
            answer = MailReadAnswer.model_validate(
                await run_email_gene(
                    gene_id="agent_email_read_interpreter",
                    prompt=json.dumps(
                        {
                            "user_request": (
                                "Summarize this email. Lead with what changed or what is needed. "
                                "Give a short bullet for each distinct request or blocker. Retain "
                                "names, owners, exact dates, amounts, attachments, technical terms "
                                "and conditions when relevant. Skip greetings and repeated headers."
                            ),
                            "retrieved_metadata": {
                                "untrusted_external_content": [
                                    {
                                        k: row.get(k)
                                        for k in ("source_ref", "subject", "body", "body_truncated")
                                    }
                                ]
                            },
                        }
                    ),
                    user_id=owner,
                    consent_token=consent_token,
                    model=model,
                    output_schema=MailReadAnswer,
                    retry_on_failure=False,
                    timeout_seconds=25,
                )
            )
            if answer.source_refs != [ref] or not answer.answer.strip():
                raise _refuse(502, "MAIL_SUMMARY_UNVERIFIED")
            summary = {"summary": answer.answer.strip(), "body": ""}
        await reader.require_current()
        if summary and ai_selection_revision() != revision:
            raise _refuse(409, "OWNER_AI_SELECTION_CHANGED")
        return {
            **{k: row.get(k) for k in ("subject", "sender", "body", "body_truncated")},
            **summary,
            "files": [f["filename"] for f in row.get("attachment_details", [])],
        }
    if operation in {"draft", "envelope"}:
        from hushh_mcp.services.gmail_reply_source_service import reply_source_from_message

        fresh = new_reader()
        message = await fresh.reply_source(source.message_id, include_cc=True)
        envelope = reply_source_from_message(
            message=message,
            account=reader.account,
            owner_email=owner_address(),
            followup_to_sent=True,
            fingerprint_key=key,
        )
        if operation == "envelope":
            await reader.require_current()
            return envelope, *delivery_context
        answer = await run_email_gene(
            gene_id="agent_email_draft",
            prompt=json.dumps(
                {"instruction": selection.expectation, "untrusted_source": row["body"]}
            ),
            user_id=owner,
            consent_token=consent_token,
            output_schema=EMAIL_DRAFT_SCHEMA,
            model=model_factory(),
            timeout_seconds=25,
            retry_on_failure=False,
        )
        await reader.require_current()
        if not isinstance(answer.get("body"), str) or not answer["body"].strip():
            raise _refuse(422, "MAIL_DRAFT_UNAVAILABLE")
        return {
            "to": envelope.recipient_email,
            "subject": envelope.subject,
            "body": answer["body"][:12000],
        }

    if not row.get("body") or row.get("body_truncated"):
        raise _refuse(422, "MAIL_SOURCE_INCOMPLETE")
    raw = await run_email_gene(
        gene_id="agent_email_followup_extractor",
        prompt=json.dumps(
            {
                "operation": "mail_track_request",
                "owner_expectation": selection.expectation,
                "tracked_quotes": [
                    q for q in selection.tracked_quotes if row["body"].count(q) == 1
                ],
                "addresses": {k: row["headers_metadata"].get(k) for k in ("from", "to", "cc")},
                "untrusted_message": {k: row.get(k) for k in ("subject", "sender", "body")},
            }
        ),
        user_id=owner,
        consent_token=consent_token,
        output_schema=Assessment,
        model=model_factory(),
        timeout_seconds=25,
        retry_on_failure=False,
    )
    await reader.require_current()
    promise = verify_promise(Assessment.model_validate(raw).promise, row["body"])
    headers = row["headers_metadata"]
    addresses = {
        address.casefold()
        for field in ("from", "to", "cc")
        if headers.get(field)
        for _, address in getaddresses([headers[field]])
        if address
    }
    if promise.debtor.casefold() not in addresses:
        raise _refuse(422, "MAIL_DEBTOR_UNVERIFIED")
    threads = reader.offered_thread_ids()
    if len(threads) != 1:
        raise _refuse(409, "MAIL_SOURCE_CHANGED")
    thread = source_ref(threads[0])
    identity = obligation_key(selection.connection, selection.source, promise.quote)
    due_date, due_time = promise_deadline(
        promise.promised_wording, row.get("received_at", ""), headers.get("date_header", "")
    )
    return {
        **promise.model_dump(),
        "due_date": due_date,
        "due_time": due_time,
        "source_kind": "mail_thread",
        "account": selection.account,
        "connection": selection.connection,
        "thread": thread,
        "source": selection.source,
        "key": identity,
    }
