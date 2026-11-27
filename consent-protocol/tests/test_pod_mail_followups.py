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
        ("See attached.", ("agreement.pdf",), "", "agreement.pdf", False),
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
                    "content": b"Agreement executed by Lab Contact"
                    if completed
                    else b"Blank agreement form",
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
    if model_match in files:
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
        "next_run_at": request["due"],
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


def test_hub_does_not_register_mail_followup_content_routes():
    from api.routes.one._hub_router import router

    assert not any(route.path.startswith("/api/one/mail/followups") for route in router.routes)


@pytest.mark.parametrize(
    ("wording", "expected"),
    [
        ("on the 29th", ("2026-11-29", None)),
        ("29 November at 3 pm", ("2026-11-29", "15:00")),
        ("before the end of term", (None, None)),
        ("31 November", (None, None)),
    ],
)
def test_promise_due_is_anchored_to_email_and_preserves_precision(wording, expected):
    assert mail.promise_deadline(wording, "2026-11-25T12:00:00Z", "") == expected


async def test_wrong_mailbox_cannot_settle_the_obligation():
    reader = SimpleNamespace(read_threads=AsyncMock())
    with pytest.raises(HTTPException) as rejected:
        await mail.assess_mail(
            "check",
            mail.Tracked(**REQUEST),
            owner="owner",
            new_reader=lambda: reader,
            credential_id="slot-b",
            key_resolver=lambda: KEY,
            owner_address=lambda: "b@example.test",
            consent_token=None,
            model_factory=lambda: None,
        )
    assert rejected.value.status_code == 409
    reader.read_threads.assert_not_called()


async def test_professor_promise_preserves_source_due_day_and_no_time(monkeypatch):
    quote = "I will send the signed document on the 29th."
    message = row("mail:1", quote, "2026-11-26T11:00:00Z")
    message["headers_metadata"]["from"] = "Professor <professor@example.test>"
    response = {
        "promise": {
            "title": "Receive signed document",
            "reason": "The professor promised a signed document.",
            "participant": "Professor",
            "debtor": "professor@example.test",
            "waiting_on": "participant",
            "quote": quote,
            "fulfilment": "Receive the signed document from the professor.",
            "promised_wording": "on the 29th",
            "document": "signed document",
        }
    }
    monkeypatch.setattr(mail, "run_email_gene", AsyncMock(return_value=response))
    reader = SimpleNamespace(
        read_threads=AsyncMock(return_value={"untrusted_external_content": [message]}),
        offered_message_ids=lambda: ("abcd",),
        offered_thread_ids=lambda: ("cafe",),
        require_current=AsyncMock(),
    )
    finding = await mail.assess_mail(
        "track",
        mail.Track(account="c", connection="slot-c", source=SOURCE, expectation="signed document"),
        owner="owner",
        new_reader=lambda: reader,
        credential_id="slot-c",
        key_resolver=lambda: KEY,
        owner_address=lambda: "c@example.test",
        consent_token=None,
        model_factory=lambda: object(),
    )
    assert finding["source"] == SOURCE
    assert finding["debtor"] == "professor@example.test"
    assert finding["fulfilment"] == response["promise"]["fulfilment"]
    assert (finding["promised_wording"], finding["due_date"], finding["due_time"]) == (
        "on the 29th",
        "2026-11-29",
        None,
    )


@pytest.mark.asyncio
async def test_overview_thread_retains_selected_source_after_thread_truncation():
    selected = row("mail:1", "The selected message.", "2026-11-19T11:00:00Z")
    selection = mail.Source(**{key: REQUEST[key] for key in ("account", "connection", "source")})
    bounded = SimpleNamespace(
        read_threads=AsyncMock(
            return_value={"untrusted_external_content": [selected], "truncated": True}
        ),
        offered_message_ids=lambda: ("not-selected",),
    )
    exact = SimpleNamespace(
        read_threads=AsyncMock(
            return_value={"untrusted_external_content": [selected], "truncated": False}
        ),
        offered_message_ids=lambda: ("abcd",),
        require_current=AsyncMock(),
    )
    readers = iter((bounded, exact))
    result = await mail.assess_mail(
        "thread",
        selection,
        owner="owner",
        new_reader=lambda: next(readers),
        credential_id=selection.connection,
        key_resolver=lambda: KEY,
        owner_address=None,
        consent_token=None,
        model_factory=None,
    )
    assert result["truncated"] is True
    assert result["items"][0]["body"] == "The selected message."
    exact.read_threads.assert_awaited_once_with(message_ids=["abcd"], whole_thread=False)


@pytest.mark.parametrize(
    ("reference", "expected"),
    [("AB12CD", True), ("2026-11-28", False), ("booking", False), ("OTHER9", False)],
)
def test_overview_cross_thread_change_requires_matching_bookings(reference, expected):
    from datetime import UTC, datetime

    from hushh_mcp.services.mail_overview_brief import build_packet, verify_brief

    before = "Your booking AB12CD departs at 9:00 on 2026-11-28."
    after = "Your booking AB12CD departs at 10:30 on 2026-11-28."
    packet = build_packet(
        [
            {
                "message_id": "abcd",
                "thread_id": "t01",
                "direction": "received",
                "text": before,
                "received_at": "2026-11-24T09:00:00+00:00",
            },
            {
                "message_id": "cafe",
                "thread_id": "t02",
                "direction": "received",
                "text": after,
                "received_at": "2026-11-25T09:00:00+00:00",
            },
        ],
        now=datetime(2026, 11, 26, tzinfo=UTC),
    )
    original = next(row for row in packet.messages if row.message_id == "abcd")
    update = next(row for row in packet.messages if row.message_id == "cafe")
    result = verify_brief(
        {
            "updates": [
                {
                    "kind": "change",
                    "thread": update.thread,
                    "shared_reference": reference,
                    "title": "Booking time changed",
                    "line": "Moved from 9:00 to 10:30",
                    "before": {"ref": original.ref, "quote": before},
                    "after": {"ref": update.ref, "quote": after},
                }
            ]
        },
        packet,
        owner_user_id="owner",
        account="grant",
        seal=lambda **terms: terms["message_id"],
    )
    assert bool(result["updates"]) is expected
    if expected:
        assert [entry["source_id"] for entry in result["updates"][0]["evidence"]] == [
            "abcd",
            "cafe",
        ]
