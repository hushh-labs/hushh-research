"""Source-bound tracking and delivery contracts, using synthetic messages only."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from hushh_mcp.services import pod_mail_followups as mail
from hushh_mcp.services.gmail_reply_source_service import reply_source_from_message
from hushh_mcp.services.mail_source_identity import seal_source_id
from hushh_mcp.services.pod_scheduled_contracts import ScheduleRefused, ScheduleRequest
from hushh_mcp.services.pod_scheduled_mail import CAPABILITY, ScheduledMailFollowup

KEY = b"x" * 32
SOURCE = seal_source_id(key=KEY, owner_user_id="owner", account="slot-c", message_id="abcd")
REQUEST = dict(
    account="mail-c",
    connection="slot-c",
    source=SOURCE,
    debtor="lab@example.test",
    quote="I will send the signed agreement.",
    fulfilment="Signed agreement",
    document="agreement",
)
DRAFT = dict(
    to="lab@example.test", subject="Re: Agreement", body="Please send the signed agreement."
)


def row(ref, body, date, *, files=(), auto=""):
    return dict(
        source_ref=ref,
        body=body,
        body_truncated=False,
        received_at=date,
        headers_metadata={"from": "lab@example.test", "auto_submitted": auto},
        attachment_details=[{"filename": name, "size_bytes": 100} for name in files],
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body,files,auto,model_match,completed",
    [
        ("Thanks!", (), "", None, False),
        ("Out of office", (), "auto-replied", None, False),
        ("The brochure is attached.", ("brochure.pdf",), "", None, False),
        ("Signed agreement attached.", ("brochure.pdf",), "", "agreement.pdf", False),
        ("Signed agreement attached.", ("agreement.pdf",), "", "agreement.pdf", True),
    ],
)
async def test_exact_request_and_received_attachment(
    monkeypatch, body, files, auto, model_match, completed
):
    rows = [
        row("mail:1", REQUEST["quote"], "2026-11-19T11:00:00Z"),
        row("mail:2", body, "2026-11-20T11:00:00Z", files=files, auto=auto),
    ]
    held = SimpleNamespace(
        credential_id="slot-c", account_subject="subject-c", account_id="mail-c", status="connected"
    )
    monkeypatch.setattr(
        mail.credentials, "active_mail_account", lambda slot: held if slot == "mail-c" else None
    )
    monkeypatch.setattr(mail, "resolve_pod_log_key", lambda: KEY)

    def reader(**kwargs):
        assert kwargs["expect_account"] == held.account_subject
        return SimpleNamespace(
            get_attachment_bytes=AsyncMock(
                return_value={
                    "status": "ok",
                    "filename": "agreement.pdf",
                    "mime_type": "text/plain",
                    "content": b"Agreement executed by Lab Contact",
                    "attachments": [{"filename": "agreement.pdf"}],
                }
            ),
            read_threads=AsyncMock(
                return_value={"untrusted_external_content": rows, "truncated": False}
            ),
            offered_message_ids=lambda: ("abcd", "ef01"),
            offered_thread_ids=lambda: ("cafe", "cafe"),
            require_current=AsyncMock(),
        )

    monkeypatch.setattr(mail, "GmailMetadataReader", reader)
    gene = AsyncMock(
        return_value={
            "match": {"ref": "mail:2", "quote": body, "filename": model_match}
            if model_match
            else None
        }
    )
    if completed:
        gene.side_effect = [gene.return_value, {"evidence": "executed by Lab Contact"}]
    monkeypatch.setattr(mail, "run_email_gene", gene)
    token = "fixture"

    async def check():
        return await mail.run_mail(
            "check",
            mail.Tracked(**REQUEST),
            owner="owner",
            check=AsyncMock(),
            consent_token=token,
            model_factory=lambda: object(),
        )

    if model_match and model_match not in files:
        with pytest.raises(HTTPException):
            await check()
    else:
        result = await check()
        assert bool(result["source"]) == completed
        assert result["filename"] == (model_match if completed else None)
    if auto:
        gene.assert_not_awaited()


def test_request_identity_and_approval_bind_time_account_and_once():
    key = mail.obligation_key("slot-c", SOURCE, REQUEST["quote"])
    assert key != mail.obligation_key("slot-c", SOURCE, "I will send pricing.")
    assert key != mail.obligation_key("slot-a", SOURCE, REQUEST["quote"])
    params = dict(**REQUEST, due=1800000000, address="c@example.test", draft=DRAFT)
    schedule = ScheduleRequest(
        request_id=key,
        title="Mail",
        capability=CAPABILITY,
        parameters=params,
        first_run_at=params["due"],
        timezone="UTC",
        authorization_expires_at=params["due"] + 300,
        confirmed=True,
    )
    ScheduledMailFollowup.validate_request(schedule)
    for different in (
        {"repeat": "daily"},
        {"first_run_at": params["due"] + 1},
        {"request_id": "another-key"},
    ):
        with pytest.raises(ScheduleRefused):
            ScheduledMailFollowup.validate_request(schedule.model_copy(update=different))


def test_sent_request_uses_original_addressee_and_private_custody():
    message = {
        "id": "abcd",
        "threadId": "beef",
        "labelIds": ["SENT"],
        "payload": {
            "headers": [
                {"name": "From", "value": "c@example.test"},
                {"name": "To", "value": "lab@example.test"},
                {"name": "Subject", "value": "Agreement"},
            ]
        },
    }
    target = reply_source_from_message(
        message=message,
        account="subject-c",
        owner_email="c@example.test",
        followup_to_sent=True,
        fingerprint_key=KEY,
    )
    assert target.recipient_email == "lab@example.test"
    assert target.reply_context.thread_id == "beef"


@pytest.mark.asyncio
@pytest.mark.parametrize("already_received", [True, False])
async def test_claim_checks_for_reply_before_confirmed_thread_delivery(
    monkeypatch, already_received
):
    from contextlib import nullcontext
    from unittest.mock import Mock

    from hushh_mcp.services import pod_scheduled_mail as scheduled
    from hushh_mcp.services.gmail_delivery_service import GmailReplyContext

    request = {**REQUEST, "due": 1800000000, "address": "c@example.test", "draft": DRAFT}
    row = {
        "repeat": "once",
        "first_run_at": request["due"],
        "revision": 2,
        "last_run": {},
        "terms": {"request": request, "fingerprint": "source-proof", "model": {"id": "bound"}},
    }

    async def change(edit, **_kwargs):
        return edit({"scheduled": row})

    lease = SimpleNamespace(
        claimed=row,
        check=AsyncMock(),
        _current=lambda rows: rows["scheduled"],
        journal=SimpleNamespace(change=change, check_horizon=AsyncMock()),
    )
    grants = SimpleNamespace(
        owner_id="owner",
        authority=SimpleNamespace(hushh_id="pod"),
        invocation=lambda _: SimpleNamespace(bind=lambda: nullcontext("reference")),
    )
    runtime = ScheduledMailFollowup(grants, object(), AsyncMock())
    model = SimpleNamespace(
        binding=SimpleNamespace(model_dump=lambda: {"id": "bound"}), build=Mock()
    )
    monkeypatch.setattr(scheduled, "resolve_scheduled_model", AsyncMock(return_value=model))
    monkeypatch.setattr(scheduled, "resolve_request_secret", lambda _: "synthetic")
    reader = AsyncMock(return_value={"source": "received" if already_received else None})
    monkeypatch.setattr(scheduled, "run_mail", reader)
    held = SimpleNamespace(account_subject="subject-c", credential_id="slot-c", status="connected")
    monkeypatch.setattr(
        mail.credentials, "active_mail_account", lambda slot: held if slot == "mail-c" else None
    )
    token_port = AsyncMock(return_value="synthetic")
    connection = SimpleNamespace(_email="c@example.test", get_modify_access_token=token_port)
    envelope = SimpleNamespace(
        fingerprint="source-proof",
        recipient_email=DRAFT["to"],
        reply_context=GmailReplyContext("cafe"),
    )
    monkeypatch.setattr(runtime, "envelope", AsyncMock(return_value=(envelope, connection, held)))
    monkeypatch.setattr(scheduled, "resolve_pod_log_key", lambda: KEY)
    delivery = AsyncMock(return_value={"status": "sent", "message_id": "c0ffee"})
    monkeypatch.setattr(
        scheduled,
        "PodGmailMailboxActions",
        lambda owner, connection: SimpleNamespace(deliver_thread_reply=delivery),
    )
    outcome = await runtime.run_claimed(lease)
    assert reader.await_args.args[0] == "check"
    if already_received:
        assert outcome == "cancelled"
        delivery.assert_not_awaited()
        assert not row["last_run"]
    else:
        assert outcome == "completed"
        token_port.assert_awaited_once_with(user_id="owner", expected_google_sub="subject-c")
        assert delivery.await_args.args[1] == DRAFT
        assert delivery.await_args.args[2]["thread_id"] == "cafe"
        assert (
            mail.open_source_id(
                row["last_run"]["sent_source"], key=KEY, owner_user_id="owner"
            ).account
            == "slot-c"
        )


@pytest.mark.asyncio
async def test_shared_route_refuses_changed_connection_before_provider_read(monkeypatch):
    import json

    from starlette.requests import Request

    from api.routes.one import mail_followups as shared

    row = {
        "status": "connected",
        "revoked": False,
        "google_sub": "c",
        "google_email": "c@example.test",
        "followup_read_generation": "new",
    }
    provider = SimpleNamespace(_fetch_connection_row=lambda **_: row)
    monkeypatch.setattr(shared, "get_gmail_receipts_service", lambda: provider)
    monkeypatch.setattr(shared, "require_hub_content_current", AsyncMock())
    read = AsyncMock()
    monkeypatch.setattr(shared, "assess_mail", read)

    async def receive():
        return {
            "type": "http.request",
            "body": json.dumps({"account": "c", "connection": "old"}).encode(),
        }

    with pytest.raises(HTTPException) as refused:
        await shared.shared_mail(
            "account",
            Request({"type": "http", "headers": []}, receive),
            {"user_id": "owner", "token": "fixture"},
        )
    assert refused.value.status_code == 409
    read.assert_not_awaited()
