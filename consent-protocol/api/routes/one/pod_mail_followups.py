"""Read and assess one owner's selected mail inside their private agent."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
from datetime import datetime
from email.utils import getaddresses
from typing import Literal

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from api.routes.one.pod_todo_sources import _admit, _door, _refuse, private_workspace_model
from api.utils.private_no_store import PrivateNoStoreRoute
from hushh_mcp.agents.email.runtime import EMAIL_DRAFT_SCHEMA, run_email_gene
from hushh_mcp.services import pod_connector_credentials as credentials
from hushh_mcp.services.byoc_key_custody import resolve_pod_log_key
from hushh_mcp.services.calendar_email_followup_relevance import quoted_or_signature_regions
from hushh_mcp.services.gmail_metadata_reader import GmailMetadataError, GmailMetadataReader
from hushh_mcp.services.mail_source_identity import open_source_id, seal_source_id
from hushh_mcp.services.pod_gmail_local import PodGmailConnection

router = APIRouter(prefix="/api/one/pod/gmail/followups", route_class=PrivateNoStoreRoute)


class Selection(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    account: str = Field(min_length=1, max_length=256)
    connection: str = Field(min_length=1, max_length=256)


class Search(Selection):
    query: str = Field(min_length=1, max_length=512)


class Source(Selection):
    source: str = Field(min_length=16, max_length=2048)


class Document(Source):
    filename: str = Field(min_length=1, max_length=255)


class Track(Source):
    expectation: str = Field(min_length=1, max_length=500)


class Promise(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    title: str = Field(min_length=1, max_length=160)
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


async def _run(operation, selection, door):
    owner = await _admit(door)

    held = credentials.active_mail_account(selection.account)
    if (
        not held
        or held.status != credentials.STATUS_CONNECTED
        or held.credential_id != selection.connection
    ):
        raise _refuse(409, "MAIL_CONNECTION_CHANGED")

    async def current():
        if await _admit(door) != owner:
            raise _refuse(403, "POD_OWNER_CHANGED")
        active = credentials.active_mail_account(selection.account)
        if (
            not active
            or active.credential_id != held.credential_id
            or active.status != credentials.STATUS_CONNECTED
        ):
            raise _refuse(409, "MAIL_CONNECTION_CHANGED")

    connection = PodGmailConnection(owner, account_id=held.account_id)

    def new_reader():
        return GmailMetadataReader(
            gmail=connection,
            user_id=owner,
            require_access=current,
            expect_account=held.account_subject,
            expose_message_links=True,
        )

    reader = new_reader()
    if operation == "account":
        profile = await reader.get_profile_and_history()
        return {
            "account": selection.account,
            "connection": held.credential_id,
            "address": profile["email_address"],
        }

    key = await asyncio.to_thread(resolve_pod_log_key)

    def source_ref(identity):
        return seal_source_id(
            key=key, owner_user_id=owner, account=held.credential_id, message_id=identity
        )

    if operation == "search":
        page = await reader.read(
            "search_inbox", {"query": selection.query, "mailbox": "anywhere", "limit": 12}
        )
    else:
        source = open_source_id(selection.source, owner_user_id=owner, key=key)
        if source.account != held.credential_id:
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
                consent_token=door["consent_token"],
                output_schema=Completion,
                model=private_workspace_model(),
                timeout_seconds=25,
                retry_on_failure=False,
            )
            match = Completion.model_validate(answer).match
            found = verified_match(match, eligible, selection.document)
        await reader.require_current()
        return {
            "source": source_ref(found) if found else None,
            "filename": match.filename if found else None,
        }
    if ids != (source.message_id,):
        raise _refuse(409, "MAIL_SOURCE_CHANGED")
    row = rows[0]
    if operation == "open":
        return {
            **{k: row.get(k) for k in ("subject", "sender", "body", "body_truncated")},
            "files": [f["filename"] for f in row.get("attachment_details", [])],
        }
    if operation == "draft":
        from hushh_mcp.services.gmail_reply_source_service import reply_source_from_message

        fresh = new_reader()
        message = await fresh.reply_source(source.message_id)
        envelope = reply_source_from_message(
            message=message, account=reader.account, owner_email=connection._email
        )
        answer = await run_email_gene(
            gene_id="agent_email_draft",
            prompt=json.dumps(
                {"instruction": selection.expectation, "untrusted_source": row["body"]}
            ),
            user_id=owner,
            consent_token=door["consent_token"],
            output_schema=EMAIL_DRAFT_SCHEMA,
            model=private_workspace_model(),
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
                "addresses": {k: row["headers_metadata"].get(k) for k in ("from", "to", "cc")},
                "untrusted_message": {k: row.get(k) for k in ("subject", "sender", "body")},
            }
        ),
        user_id=owner,
        consent_token=door["consent_token"],
        output_schema=Assessment,
        model=private_workspace_model(),
        timeout_seconds=25,
        retry_on_failure=False,
    )
    await reader.require_current()
    promise = verify_promise(Assessment.model_validate(raw).promise, row["body"])
    headers = row["headers_metadata"]
    addresses = {
        address.casefold()
        for _, address in getaddresses([headers.get(k, "") for k in ("from", "to", "cc")])
    }
    if promise.debtor.casefold() not in addresses:
        raise _refuse(422, "MAIL_DEBTOR_UNVERIFIED")
    threads = reader.offered_thread_ids()
    if len(threads) != 1:
        raise _refuse(409, "MAIL_SOURCE_CHANGED")
    thread = source_ref(threads[0])
    identity = hashlib.sha256(
        json.dumps([selection.connection, selection.source, promise.quote]).encode()
    ).hexdigest()
    return {
        **promise.model_dump(),
        "source_kind": "mail_thread",
        "account": selection.account,
        "connection": selection.connection,
        "thread": thread,
        "source": selection.source,
        "key": identity,
    }


async def mail_followups(
    operation: Literal["account", "search", "open", "track", "check", "draft", "document"],
    request: Request,
    authorization: str | None = Header(default=None),
    x_consent_token: str | None = Header(default=None, alias="X-Consent-Token"),
):
    door = await _door(x_consent_token, authorization)
    await _admit(door)
    try:
        async with asyncio.timeout(45):
            data = bytearray()
            async for chunk in request.stream():
                if len(data) + len(chunk) > 8192:
                    raise _refuse(413, "MAIL_REQUEST_TOO_LARGE")
                data.extend(chunk)
            classes = {
                "account": Selection,
                "search": Search,
                "open": Source,
                "track": Track,
                "check": Tracked,
                "draft": Track,
                "document": Document,
            }
            try:
                selection = (
                    classes[operation].model_validate_json(data) if operation in classes else None
                )
            except ValidationError:
                raise _refuse(422, "INVALID_MAIL_REQUEST") from None
            result = await _run(operation, selection, door)
            return JSONResponse(result, headers={"Cache-Control": "private, no-store"})
    except HTTPException:
        raise
    except GmailMetadataError as exc:
        raise _refuse(409, "MAIL_" + exc.code.upper()) from None
    except Exception:
        raise _refuse(503, "MAIL_FOLLOWUP_UNAVAILABLE") from None


def register(operation: str) -> None:
    async def handle(
        request: Request,
        authorization: str | None = Header(default=None),
        x_consent_token: str | None = Header(default=None, alias="X-Consent-Token"),
    ):
        return await mail_followups(operation, request, authorization, x_consent_token)

    router.add_api_route(
        "/" + operation, handle, methods=["POST"], name="mail_followup_" + operation
    )


for operation in ("account", "search", "open", "track", "check", "draft", "document"):
    register(operation)
