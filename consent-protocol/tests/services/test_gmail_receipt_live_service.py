"""Focused contract tests for stateless, backend-owned Gmail receipt reads."""

from __future__ import annotations

import asyncio
import base64
import json
from datetime import datetime, timezone
from unittest.mock import AsyncMock

import httpx
import pytest

import hushh_mcp.services.gmail_live_receipts_service as live_receipts_module
from hushh_mcp.services.gmail_live_receipts_service import GmailLiveReceiptsService
from hushh_mcp.services.gmail_receipt_cutover import receipt_storage_writes_enabled
from hushh_mcp.services.gmail_receipts_service import GmailApiError, GmailReceiptsService

TEST_CONSENT_TOKEN = "synthetic-vault-owner-token"  # noqa: S105 -- inert test authority


def test_receipt_document_identifiers_require_exact_evidence_and_keep_types():
    result = live_receipts_module._receipt_enrichment(
        {
            "document_kind": "invoice",
            "document_evidence": "Tax invoice INV-1",
            "identifiers": [
                {"kind": "invoice", "value": "INV-1", "evidence": "Tax invoice INV-1"},
                {"kind": "order", "value": "ORD-2", "evidence": "Order ORD-2"},
                {"kind": "payment", "value": "MADEUP", "evidence": "Payment MADEUP"},
            ],
        },
        {"body": "Tax invoice INV-1. Order ORD-2."},
    )
    assert result["document_kind"] == "invoice"
    assert result["identifiers"] == [
        {"kind": "invoice", "value": "INV-1"},
        {"kind": "order", "value": "ORD-2"},
    ]


async def test_document_merchant_is_quote_bound_not_registry_only():
    service = _service(
        [
            _message(
                "quoted-brand",
                subject="Your receipt from Example Software",
                sender="billing@example.test",
                body="Example Software receipt. Amount Paid USD 20.00",
            )
        ]
    )

    async def extract(payload, _user, _token):
        return {
            **_model_for(payload),
            "merchant_name": "Example Software",
            "merchant_evidence_id": "merchant:document",
            "merchant_evidence": "Example Software receipt",
        }

    service._extractor = extract
    item = (await _scan(service))["items"][0]
    assert item["merchant_name"] == "Example Software"
    assert item["merchant_domain"] is None  # Never invent a logo domain.
    assert item["amount"] == 20


async def test_unverified_optional_merchant_does_not_abort_receipt_page():
    service = _service(
        [
            _message(
                "unverified-merchant",
                subject="Your shopping order receipt",
                sender="ship-confirm <notifications@unmapped.example>",
                body="Your shopping order receipt. Amount Paid USD 20.00",
            ),
            _message(
                "verified-merchant",
                subject="Your Apple order receipt",
                sender="Apple <orders@apple.com>",
                body="Your Apple order receipt. Amount Paid USD 30.00",
            ),
        ]
    )

    async def extract(payload, _user, _token):
        model = _model_for(payload)
        if payload["subject"] == "Your shopping order receipt":
            return {
                **model,
                "merchant_name": "ship-confirm",
                "merchant_evidence_id": "merchant:sender_name",
                "merchant_evidence": "ship-confirm",
                "category": "Shopping",
                "category_confidence": 0.95,
                "category_evidence": "shopping order receipt",
            }
        return model

    service._extractor = extract
    result = await _scan(service)

    assert len(result["items"]) == 2
    items = {item["gmail_message_id"]: item for item in result["items"]}
    assert items["unverified-merchant"]["merchant_name"] is None
    assert items["unverified-merchant"]["merchant_domain"] is None
    assert items["unverified-merchant"]["category"] == "Shopping"
    assert items["unverified-merchant"]["amount"] == 20
    assert items["verified-merchant"]["merchant_name"] == "Apple"


async def test_receipt_html_supplements_plain_without_total():
    message = _message(
        "html-total",
        subject="Your receipt",
        sender="billing@example.test",
        body="See your receipt below.",
    )
    plain = dict(message["payload"])
    message["payload"]["parts"] = [
        plain,
        {
            "mimeType": "text/html",
            "body": {"data": _b64("<p>Grand Total USD 20.00</p><script>bad()</script>")},
        },
    ]
    item = (await _scan(_service([message])))["items"][0]
    assert item["amount"] == 20


def test_attachment_quote_is_not_mislabelled_as_email_preview():
    result = live_receipts_module._receipt_enrichment(
        {"cleaned_preview": "Tax invoice INV-1"},
        {
            "body": "Attached receipt document: Tax invoice INV-1",
            "email_body": "Please see attached.",
        },
    )
    assert result["cleaned_preview"] is None


@pytest.mark.parametrize("failure", [None, "scanner", "timeout", "malformed", "network"])
async def test_optional_pdf_reuses_owner_reader_and_preserves_receipt_on_failure(
    monkeypatch, failure
):
    from hushh_mcp.services.drive_document_parser import ParsedText
    from hushh_mcp.services.drive_document_processor import ClamAvScanner, IsolatedDocumentParser
    from hushh_mcp.services.google_drive_adapter import DriveReadError

    message = _message(
        "pdf-receipt",
        subject="Your invoice",
        sender="billing@example.test",
        body="Please see the attached invoice.",
    )
    message["payload"]["parts"] = [
        dict(message["payload"]),
        {
            "mimeType": "application/pdf",
            "filename": "invoice.pdf",
            "body": {"attachmentId": "safe-attachment", "size": 100},
        },
    ]
    calls = []

    def handler(request):
        calls.append(request.url.path)
        assert request.headers["authorization"] == "Bearer synthetic-access"
        if request.url.path.endswith("/attachments/safe-attachment"):
            if failure == "network":
                raise httpx.ConnectError("synthetic attachment transport failure")
            return _response(
                {
                    "data": _b64(
                        "not a PDF" if failure == "malformed" else "%PDF-synthetic-test-only"
                    )
                }
            )
        if request.url.path.endswith("/messages"):
            return _response({"messages": [{"id": message["id"]}]})
        return _response(message)

    scan = AsyncMock(
        side_effect=DriveReadError("scanner_unavailable") if failure == "scanner" else None
    )
    parse = AsyncMock(
        side_effect=TimeoutError() if failure == "timeout" else None,
        return_value=ParsedText(("Invoice INV-1. Grand Total USD 42.00",), False),
    )
    monkeypatch.setattr(ClamAvScanner, "scan", scan)
    monkeypatch.setattr(IsolatedDocumentParser, "parse", parse)
    service = GmailLiveReceiptsService(
        gmail=_Gmail(),
        transport=httpx.MockTransport(handler),
        source_secret=b"s" * 32,
        extractor=_extractor,
    )
    item = (await _scan(service))["items"][0]
    assert item["amount"] == (42 if failure is None else None)
    assert any(path.endswith("/messages/pdf-receipt/attachments/safe-attachment") for path in calls)


def test_receipt_pdf_transport_filter_is_bounded():
    from hushh_mcp.services.gmail_receipt_documents import MAX_PDF_BYTES, pdf_candidates

    def part(name, size):
        return {"mimeType": "application/pdf", "filename": name, "body": {"size": size}}

    assert (
        pdf_candidates(
            {"parts": [part("advertisement.pdf", 10), part("invoice.pdf", MAX_PDF_BYTES + 1)]}
        )
        == []
    )
    assert len(pdf_candidates({"parts": [part("invoice.pdf", 10), part("receipt.pdf", 10)]})) == 1


def test_pdf_excerpt_remains_visible_after_a_long_email():
    message = _message(
        "long-body",
        subject="Your invoice",
        sender="billing@example.test",
        body="Receipt context. " * 1500,
    )
    message["_receipt_pdf_text"] = "Tax invoice INV-20. Grand Total USD 20.00"
    evidence = live_receipts_module._evidence(message)
    assert "Tax invoice INV-20" in evidence["body"]
    assert len(evidence["body"].encode()) <= 12000
    assert "Tax invoice INV-20" not in evidence["email_body"]


async def test_optional_attachment_budget_cannot_fail_mandatory_receipt_page(monkeypatch):
    from hushh_mcp.services.drive_document_parser import ParsedText
    from hushh_mcp.services.drive_document_processor import ClamAvScanner, IsolatedDocumentParser

    messages = [
        _message(
            f"large-pdf-{index}",
            subject="Your invoice",
            sender="billing@example.test",
            body="Please see your invoice.",
        )
        for index in range(6)
    ]
    for message in messages:
        message["payload"]["parts"] = [
            dict(message["payload"]),
            {
                "mimeType": "application/pdf",
                "filename": "invoice.pdf",
                "body": {"size": 512000, "attachmentId": "large-pdf"},
            },
        ]
    reads = []

    def handler(request):
        if "/attachments/" in request.url.path:
            # Every mandatory message must already have been fetched.
            assert len(reads) == 6
            return _response({"data": _b64("%PDF-" + "x" * 511995)})
        if request.url.path.endswith("/messages"):
            return _response({"messages": [{"id": item["id"]} for item in messages]})
        identity = request.url.path.rsplit("/", 1)[-1]
        reads.append(identity)
        return _response(next(item for item in messages if item["id"] == identity))

    monkeypatch.setattr(ClamAvScanner, "scan", AsyncMock())
    monkeypatch.setattr(
        IsolatedDocumentParser,
        "parse",
        AsyncMock(return_value=ParsedText(("Invoice INV-1",), False)),
    )
    service = GmailLiveReceiptsService(
        gmail=_Gmail(),
        transport=httpx.MockTransport(handler),
        source_secret=b"s" * 32,
        extractor=_extractor,
    )
    assert len((await _scan(service))["items"]) == 6


class _Gmail(GmailReceiptsService):
    def __init__(self) -> None:
        self.row = {
            "status": "connected",
            "revoked": False,
            "google_sub": "synthetic-account",
            "google_email": "owner@example.com",
            "scope_csv": "https://www.googleapis.com/auth/gmail.readonly",
            "connected_at": "2026-10-04T00:00:00+00:00",
            "token_updated_at": "synthetic-version-1",
            "refresh_token_ciphertext": "synthetic-ciphertext",
            "refresh_token_iv": "synthetic-iv",
            "refresh_token_tag": "synthetic-tag",
        }

    @property
    def db(self):  # pragma: no cover - a call is itself the regression
        raise AssertionError("live receipt reads must not access the legacy receipt database")

    async def get_read_access_token(self, *, user_id):
        assert user_id == "owner"
        return "synthetic-access"

    async def read_grant_binding(self, *, user_id):
        assert user_id == "owner"
        return (
            user_id,
            "gmail",
            str(self.row["google_sub"]),
            str(self.row["connected_at"]),
            str(self.row["token_updated_at"]),
        )

    async def _execute_raw_async(self, *_args, **_kwargs):
        raise AssertionError("live receipt reads must not issue legacy receipt SQL")

    async def _upsert_receipt(self, *_args, **_kwargs):
        raise AssertionError("live receipt reads must not invoke the legacy receipt upsert")


class _Bytes(httpx.AsyncByteStream):
    def __init__(self, data: bytes):
        self.data = data

    async def __aiter__(self):
        yield self.data


def _response(payload: dict, status: int = 200) -> httpx.Response:
    return httpx.Response(status, stream=_Bytes(json.dumps(payload).encode("utf-8")))


def _b64(value: str) -> str:
    return base64.urlsafe_b64encode(value.encode("utf-8")).decode("ascii").rstrip("=")


def _message(
    identity: str,
    *,
    subject: str,
    sender: str,
    body: str,
    snippet: str | None = None,
    labels: list[str] | None = None,
) -> dict:
    return {
        "id": identity,
        "threadId": f"thread-{identity}",
        "internalDate": str(int(datetime(2026, 10, 1, tzinfo=timezone.utc).timestamp() * 1000)),
        "labelIds": labels if labels is not None else ["CATEGORY_PURCHASES"],
        "snippet": snippet if snippet is not None else body[:180],
        "payload": {
            "mimeType": "text/plain",
            "headers": [
                {"name": "From", "value": sender},
                {"name": "Subject", "value": subject},
                {"name": "Date", "value": "Thu, 1 Oct 2026 10:00:00 +0000"},
            ],
            "body": {"data": _b64(body)},
        },
    }


def _model_for(payload: dict) -> dict:
    signals = payload["receipt_signals"]
    events = payload["event_candidates"]
    event = next(
        (
            item
            for kind in ("refund", "cancellation", "fulfillment", "purchase")
            for item in events
            if item["event_type"] == kind
        ),
        None,
    )
    merchant = payload["verified_merchant"]
    order = payload["order_candidates"][0] if payload["order_candidates"] else None
    totals = payload["total_candidates"]
    priority = {
        "grand total": 5,
        "order total": 5,
        "amount paid": 5,
        "total paid": 5,
        "total charged": 5,
        "invoice total": 4,
        "payment received": 3,
        "total amount": 3,
        "amount due": 2,
        "total": 1,
    }
    best = None
    if totals:
        best_rank = max(priority.get(item["label"].casefold(), 0) for item in totals)
        best_values = {
            (item["currency"], item["amount"])
            for item in totals
            if priority.get(item["label"].casefold(), 0) == best_rank
        }
        if len(best_values) == 1:
            best = next(
                item for item in totals if priority.get(item["label"].casefold(), 0) == best_rank
            )
    return {
        "is_receipt": bool(signals),
        "confidence": 0.97,
        "receipt_evidence_ids": [item["id"] for item in signals[:2]],
        "event_type": event["event_type"] if event else "unknown",
        "event_evidence_id": event["id"] if event else None,
        "merchant_name": merchant["name"] if merchant else None,
        "merchant_evidence_id": merchant["id"] if merchant else None,
        "order_id": order["value"] if order else None,
        "order_evidence_id": order["id"] if order else None,
        "amount_evidence_id": best["id"] if best else None,
        "category": "Uncategorized",
        "category_confidence": 0.95,
        "category_evidence": payload["subject"][:240],
        "recurrence": "unknown",
        "recurrence_evidence": None,
        "attention_state": "none",
        "attention_reason": None,
        "attention_evidence": None,
        "attention_is_prediction": False,
        "attention_date": None,
    }


async def _extractor(payload: dict, user_id: str, consent_token: str) -> dict:
    assert user_id == "owner"
    assert consent_token == TEST_CONSENT_TOKEN
    return _model_for(payload)


async def _allowed() -> None:
    return None


@pytest.mark.parametrize(
    "category,phrase",
    [
        ("Shopping", "Your clothing order is confirmed"),
        ("Food", "Your restaurant dinner order is confirmed"),
        ("Travel", "Your flight booking is confirmed"),
        ("Transport", "Your taxi ride fare receipt"),
        ("Subscription", "Your monthly membership renewal receipt"),
        ("Bills", "Your electricity bill payment receipt"),
    ],
)
async def test_category_quote_is_verified_without_requiring_merchant_or_amount(category, phrase):
    service = _service(
        [_message("category-test", subject=phrase, sender="receipts@unmapped.example", body=phrase)]
    )

    async def extract(payload, _user, _token):
        return {
            **_model_for(payload),
            "category": category,
            "category_confidence": 0.95,
            "category_evidence": phrase,
        }

    service._extractor = extract
    result = await _scan(service)
    item = result["items"][0]
    assert item["category"] == category
    assert item["merchant_name"] is None
    assert item["amount"] is None
    assert "category_evidence" not in item


@pytest.mark.parametrize(
    "confidence,quote", [(0.4, "Your order receipt"), (0.95, "Invented restaurant purchase")]
)
async def test_unverified_category_is_rejected(confidence, quote):
    service = _service(
        [
            _message(
                "bad-category",
                subject="Your order receipt",
                sender="receipts@unmapped.example",
                body="Your order receipt",
            )
        ]
    )

    async def extract(payload, _user, _token):
        return {
            **_model_for(payload),
            "category": "Food",
            "category_confidence": confidence,
            "category_evidence": quote,
        }

    service._extractor = extract
    with pytest.raises(GmailApiError) as caught:
        await _scan(service)
    assert caught.value.code == "GMAIL_RECEIPT_EXTRACTION_UNVERIFIED"


def _service(messages: list[dict], calls: list[httpx.Request] | None = None):
    by_id = {message["id"]: message for message in messages}

    def handler(request: httpx.Request):
        if calls is not None:
            calls.append(request)
        if request.url.path.endswith("/messages"):
            return _response({"messages": [{"id": identity} for identity in by_id]})
        identity = request.url.path.rsplit("/", 1)[-1]
        return _response(by_id[identity])

    return GmailLiveReceiptsService(
        gmail=_Gmail(),
        transport=httpx.MockTransport(handler),
        source_secret=b"s" * 32,
        extractor=_extractor,
    )


async def _scan(service: GmailLiveReceiptsService, **overrides):
    return await service.scan(
        user_id="owner",
        consent_token=TEST_CONSENT_TOKEN,
        require_access=_allowed,
        **overrides,
    )


async def test_scan_revalidates_owner_authority_before_publishing_results():
    checks = 0

    async def revoked_after_read() -> None:
        nonlocal checks
        checks += 1
        if checks == 2:
            raise GmailApiError(
                "Open your private vault before loading receipts.",
                status_code=403,
                code="GMAIL_RECEIPT_VAULT_REQUIRED",
            )

    service = _service([])
    with pytest.raises(GmailApiError) as caught:
        await service.scan(
            user_id="owner",
            consent_token=TEST_CONSENT_TOKEN,
            require_access=revoked_after_read,
        )

    assert caught.value.code == "GMAIL_RECEIPT_VAULT_REQUIRED"
    assert checks == 2


async def test_scan_caps_page_size_and_extraction_concurrency():
    messages = [
        _message(
            f"msg-bounded-{index}",
            subject=f"Receipt order #BOUND-{index:04d}",
            sender="Apple <orders@apple.com>",
            body=f"Order total: USD {index + 1}.00",
        )
        for index in range(6)
    ]
    active = 0
    peak = 0

    async def tracked_extractor(payload: dict, user_id: str, consent_token: str) -> dict:
        nonlocal active, peak
        assert user_id == "owner"
        assert consent_token == TEST_CONSENT_TOKEN
        active += 1
        peak = max(peak, active)
        try:
            await asyncio.sleep(0.01)
            return _model_for(payload)
        finally:
            active -= 1

    service = _service(messages)
    service._extractor = tracked_extractor

    result = await _scan(service, per_page=99)

    assert result["coverage"]["listed_count"] == 6
    assert result["coverage"]["max_messages"] == 6
    assert result["returned_count"] == 6
    assert peak == 2


async def test_valid_myntra_receipt_uses_domain_mapping_and_preferred_total():
    message = _message(
        "msg-myntra",
        subject="Your Myntra order confirmation — Order #MYN-1001",
        sender="ship-confirm <ship-confirm@updates.myntra.com>",
        body="Item price INR 999.00\nSubtotal INR 999.00\nOrder total: INR 1,299.00",
    )

    result = await _scan(_service([message]))

    assert result["coverage"] == {
        "source": "gmail_live",
        "listed_count": 1,
        "candidate_count": 1,
        "matched_count": 1,
        "pages_scanned": 1,
        "max_messages": 6,
        "max_pages": 50,
        "max_scan_messages": 300,
        "window_start": result["coverage"]["window_start"],
        "window_end": result["coverage"]["window_end"],
        "reached_limit": False,
        "query_scope": "receipt_signals_all_mail_except_spam_trash",
        "rejection_counts": {
            "missing_receipt_signal": 0,
            "extractor_not_receipt": 0,
        },
        "evidence_counts": {
            "gmail_category": 1,
            "subject_signal": 1,
            "body_signal": 1,
            "verified_merchant": 1,
            "order_candidate": 1,
            "total_candidate": 1,
        },
    }
    item = result["items"][0]
    assert item["source_id"].startswith("gmail_live_")
    assert item["gmail_message_id"] == "msg-myntra"
    assert item["merchant_name"] == "Myntra"
    assert item["merchant_domain"] == "myntra.com"
    assert item["sender_domain"] == "updates.myntra.com"
    assert item["order_id"] == "MYN-1001"
    assert item["amount"] == 1299.0
    assert item["currency"] == "INR"
    assert item["classification_source"] == "agent"
    assert receipt_storage_writes_enabled() is False


async def test_missing_amount_and_unknown_merchant_remain_visible_without_guesses():
    message = _message(
        "msg-unknown",
        subject="Receipt for order #UNKNOWN-10",
        sender='"Myntra" <ship-confirm@unknown.example>',
        body="Thanks for your order. We will send an update soon.",
    )

    item = (await _scan(_service([message])))["items"][0]

    assert item["merchant_name"] is None
    assert item["merchant_domain"] is None
    assert item["sender_domain"] == "unknown.example"
    assert item["amount"] is None
    assert item["currency"] is None


async def test_distinct_orders_updates_refund_and_cancellation_stay_distinct():
    messages = [
        _message(
            "msg-order-a",
            subject="Order #MYN-A100 confirmed",
            sender="Myntra <orders@myntra.com>",
            body="Order total: INR 100.00",
        ),
        _message(
            "msg-order-b",
            subject="Order #MYN-B200 shipped",
            sender="Myntra <ship@updates.myntra.com>",
            body="Order total: INR 200.00",
        ),
        _message(
            "msg-delivery-b",
            subject="Order #MYN-B200 delivered",
            sender="Myntra <delivery@myntra.com>",
            body="Your package was delivered.",
        ),
        _message(
            "msg-refund-b",
            subject="Refund for order #MYN-B200",
            sender="Myntra <refunds@myntra.com>",
            body="Amount paid: INR 200.00 has been refunded.",
        ),
        _message(
            "msg-cancel-b",
            subject="Cancellation for order #MYN-B200",
            sender="Myntra <orders@myntra.com>",
            body="Your order was cancelled.",
        ),
    ]

    items = (await _scan(_service(messages)))["items"]

    assert len(items) == 5
    assert len({item["source_id"] for item in items}) == 5
    assert {item["order_id"] for item in items} == {"MYN-A100", "MYN-B200"}
    assert {item["event_type"] for item in items} == {
        "purchase",
        "fulfillment",
        "refund",
        "cancellation",
    }


async def test_purchase_with_return_and_cancel_boilerplate_remains_a_purchase():
    message = _message(
        "msg-purchase-policy-copy",
        subject="Receipt for order #MYN-PURCHASE-1",
        sender="Myntra <orders@myntra.com>",
        body=(
            "Amount paid: INR 200.00. Shipping: INR 0.00. "
            "You can cancel this order before dispatch. "
            "See our return policy for eligibility."
        ),
    )

    async def select_purchase(payload: dict, _user: str, _token: str) -> dict:
        result = _model_for(payload)
        purchase = next(
            item for item in payload["event_candidates"] if item["event_type"] == "purchase"
        )
        result["event_type"] = "purchase"
        result["event_evidence_id"] = purchase["id"]
        return result

    service = _service([message])
    service._extractor = select_purchase

    item = (await _scan(service))["items"][0]
    assert item["event_type"] == "purchase"


async def test_bare_dollar_preserves_symbol_without_inventing_currency_code():
    message = _message(
        "msg-dollar",
        subject="Receipt for order #DOLLAR-1",
        sender="Amazon <orders@amazon.com>",
        body="Order total: $19.99",
    )

    item = (await _scan(_service([message])))["items"][0]
    assert item["amount"] == 19.99
    assert item["currency"] == "$"


@pytest.mark.parametrize("prefix,currency", [("$", "$"), ("USD $", "USD")])
async def test_receipt_value_before_paid_is_extracted_ahead_of_item_prices(prefix, currency):
    message = _message(
        "msg-paid-pattern",
        subject="Your receipt",
        sender="Billing <billing@example.com>",
        body=(
            f"Receipt from Anthropic, PBC {prefix}20.00 Paid September 18, 2026\n"
            "Item price USD 18.00. Tax USD 2.00. Discount USD 5.00."
        ),
    )
    item = (await _scan(_service([message])))["items"][0]
    assert item["amount"] == 20.00
    assert item["currency"] == currency


async def test_zero_and_unformatted_four_digit_totals_are_preserved_when_explicit():
    messages = [
        _message(
            "msg-zero",
            subject="Receipt for order #ZERO-100",
            sender="Apple <orders@apple.com>",
            body="Order total: USD 0.00",
        ),
        _message(
            "msg-four-digit",
            subject="Receipt for order #FOUR-100",
            sender="Myntra <orders@myntra.com>",
            body="Amount paid: INR 1299.00",
        ),
    ]

    by_id = {item["gmail_message_id"]: item for item in (await _scan(_service(messages)))["items"]}
    assert by_id["msg-zero"]["amount"] == 0.0
    assert by_id["msg-zero"]["currency"] == "USD"
    assert by_id["msg-four-digit"]["amount"] == 1299.0
    assert by_id["msg-four-digit"]["currency"] == "INR"


async def test_conflicting_peer_totals_remain_missing_and_are_not_offered_to_model():
    message = _message(
        "msg-conflict",
        subject="Receipt for order #CONFLICT-100",
        sender="Apple <orders@apple.com>",
        body="Order total: USD 100.00\nGrand total: USD 200.00",
    )

    item = (await _scan(_service([message])))["items"][0]
    assert item["amount"] is None
    assert item["currency"] is None

    async def inspect_totals(payload: dict, _user: str, _token: str) -> dict:
        assert payload["total_candidates"] == []
        return _model_for(payload)

    service = _service([message])
    service._extractor = inspect_totals
    item = (await _scan(service))["items"][0]
    assert item["amount"] is None
    assert item["currency"] is None


async def test_empty_mailbox_is_successful_and_distinct_from_failure():
    result = await _scan(_service([]))
    assert result["items"] == []
    assert result["returned_count"] == 0
    assert result["coverage"]["listed_count"] == 0
    assert result["has_more"] is False


async def test_query_only_candidate_reports_missing_receipt_evidence_without_model_call():
    message = _message(
        "msg-query-only",
        subject="Transaction notification",
        sender="Alerts <alerts@bank.example>",
        body="A transaction was recorded on your account.",
        labels=[],
    )
    extractor = AsyncMock()
    service = _service([message])
    service._extractor = extractor

    result = await _scan(service)

    assert result["items"] == []
    assert result["coverage"]["rejection_counts"] == {
        "missing_receipt_signal": 1,
        "extractor_not_receipt": 0,
    }
    assert result["coverage"]["evidence_counts"] == {
        "gmail_category": 0,
        "subject_signal": 0,
        "body_signal": 0,
        "verified_merchant": 0,
        "order_candidate": 0,
        "total_candidate": 0,
    }
    extractor.assert_not_awaited()


async def test_cancelled_order_without_purchase_label_is_a_receipt_record():
    message = _message(
        "msg-cancelled",
        subject="Order #CANCEL-100 was cancelled",
        sender="Myntra <updates@myntra.com>",
        body="We cancelled order #CANCEL-100 at your request.",
        labels=[],
    )

    item = (await _scan(_service([message])))["items"][0]

    assert item["event_type"] == "cancellation"
    assert item["order_id"] == "CANCEL-100"
    assert item["merchant_name"] == "Myntra"
    assert item["amount"] is None


async def test_receipt_evidence_after_model_body_excerpt_limit_is_still_extracted():
    message = _message(
        "msg-long-body",
        subject="Your account update",
        sender="Apple <orders@apple.com>",
        body=("x" * (live_receipts_module._BODY_EVIDENCE_BYTES + 100))
        + " Order #LONG-100. Order total: USD 88.00",
        labels=[],
    )

    item = (await _scan(_service([message])))["items"][0]

    assert item["order_id"] == "LONG-100"
    assert item["amount"] == 88.0
    assert item["currency"] == "USD"


async def test_malformed_provider_message_is_an_error_not_empty():
    malformed = {"id": "bad-message", "threadId": "thread-bad", "payload": "not-an-object"}
    with pytest.raises(GmailApiError) as caught:
        await _scan(_service([malformed]))
    assert caught.value.code == "GMAIL_RECEIPT_INVALID_RESPONSE"


async def test_provider_timeout_is_typed_and_never_partial_empty():
    def timeout(_request: httpx.Request):
        raise httpx.ReadTimeout("poison provider detail")

    service = GmailLiveReceiptsService(
        gmail=_Gmail(),
        transport=httpx.MockTransport(timeout),
        source_secret=b"s" * 32,
        extractor=_extractor,
    )
    with pytest.raises(GmailApiError) as caught:
        await _scan(service)
    assert caught.value.code == "GMAIL_PROVIDER_UNAVAILABLE"
    assert "poison" not in str(caught.value)


async def test_model_timeout_is_typed_and_never_returns_partial_rows(monkeypatch):
    message = _message(
        "msg-model-timeout",
        subject="Receipt for order #TIMEOUT-100",
        sender="Apple <orders@apple.com>",
        body="Order total: USD 10.00",
    )

    async def blocked_extractor(_payload: dict, _user: str, _token: str) -> dict:
        await asyncio.sleep(1)
        raise AssertionError("unreachable")

    service = _service([message])
    service._extractor = blocked_extractor
    monkeypatch.setattr(live_receipts_module, "_EXTRACTOR_TIMEOUT_SECONDS", 0.01)

    with pytest.raises(GmailApiError) as caught:
        await _scan(service)
    assert caught.value.code == "GMAIL_RECEIPT_EXTRACTION_TIMEOUT"


async def test_transient_extractor_unavailable_is_retried_once(monkeypatch):
    message = _message(
        "msg-model-retry",
        subject="Receipt for order #RETRY-100",
        sender="Apple <orders@apple.com>",
        body="Order total: USD 10.00",
    )
    attempts = 0

    async def transient_extractor(payload: dict, _user: str, _token: str) -> dict:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise GmailApiError(
                "Receipt extraction is temporarily unavailable.",
                status_code=503,
                code="GMAIL_RECEIPT_EXTRACTION_UNAVAILABLE",
            )
        return _model_for(payload)

    service = _service([message])
    service._extractor = transient_extractor
    monkeypatch.setattr(live_receipts_module, "_EXTRACTOR_RETRY_DELAY_SECONDS", 0)

    result = await _scan(service)

    assert attempts == 2
    assert result["returned_count"] == 1
    assert result["items"][0]["amount"] == 10.0


async def test_persistent_extractor_unavailable_remains_typed(monkeypatch):
    message = _message(
        "msg-model-retry-exhausted",
        subject="Receipt for order #RETRY-200",
        sender="Apple <orders@apple.com>",
        body="Order total: USD 10.00",
    )
    attempts = 0

    async def unavailable_extractor(_payload: dict, _user: str, _token: str) -> dict:
        nonlocal attempts
        attempts += 1
        raise GmailApiError(
            "Receipt extraction is temporarily unavailable.",
            status_code=503,
            code="GMAIL_RECEIPT_EXTRACTION_UNAVAILABLE",
        )

    service = _service([message])
    service._extractor = unavailable_extractor
    monkeypatch.setattr(live_receipts_module, "_EXTRACTOR_RETRY_DELAY_SECONDS", 0)

    with pytest.raises(GmailApiError) as caught:
        await _scan(service)

    assert attempts == 2
    assert caught.value.code == "GMAIL_RECEIPT_EXTRACTION_UNAVAILABLE"


async def test_overall_timeout_releases_owner_even_when_child_delays_cancellation(monkeypatch):
    message = _message(
        "msg-stubborn-timeout",
        subject="Receipt for order #STUBBORN-100",
        sender="Apple <orders@apple.com>",
        body="Order total: USD 10.00",
    )
    release_child = asyncio.Event()

    async def stubborn_extractor(payload: dict, _user: str, _token: str) -> dict:
        try:
            await release_child.wait()
        except asyncio.CancelledError:
            await release_child.wait()
        return _model_for(payload)

    service = _service([message])
    service._extractor = stubborn_extractor
    monkeypatch.setattr(live_receipts_module, "_DEADLINE_SECONDS", 0.01)
    monkeypatch.setattr(live_receipts_module, "_CANCEL_DRAIN_SECONDS", 0.01)

    started_at = asyncio.get_running_loop().time()
    with pytest.raises(GmailApiError) as caught:
        await _scan(service)
    elapsed = asyncio.get_running_loop().time() - started_at
    assert caught.value.code == "GMAIL_RECEIPT_SCAN_TIMEOUT"
    assert elapsed < 0.5
    assert service._active_scans == {}

    service._extractor = _extractor
    monkeypatch.setattr(live_receipts_module, "_DEADLINE_SECONDS", 1.0)
    result = await _scan(service)
    assert result["returned_count"] == 1
    release_child.set()
    await asyncio.sleep(0)


async def test_stale_receipt_scan_is_cancelled_and_retry_claims_a_new_lease(monkeypatch):
    message = _message(
        "msg-stale",
        subject="Receipt for order #STALE-100",
        sender="Apple <orders@apple.com>",
        body="Order total: USD 10.00",
    )
    entered = asyncio.Event()

    async def blocked_extractor(payload: dict, _user: str, _token: str) -> dict:
        entered.set()
        await asyncio.Event().wait()
        return _model_for(payload)

    service = _service([message])
    service._extractor = blocked_extractor
    monkeypatch.setattr(live_receipts_module, "_SCAN_STALE_SECONDS", 0.01)
    monkeypatch.setattr(live_receipts_module, "_CANCEL_DRAIN_SECONDS", 0.1)
    first = asyncio.create_task(_scan(service))
    await asyncio.wait_for(entered.wait(), timeout=1)
    await asyncio.sleep(0.02)
    service._extractor = _extractor

    result = await _scan(service)

    assert result["returned_count"] == 1
    with pytest.raises(asyncio.CancelledError):
        await first
    assert service._active_scans == {}


async def test_page_two_walks_bounded_list_pages_and_fetches_only_selected_page():
    calls: list[httpx.Request] = []
    messages = {
        "msg-page-1": _message(
            "msg-page-1",
            subject="Receipt order #PAGE-100",
            sender="Apple <orders@apple.com>",
            body="Order total: USD 10.00",
        ),
        "msg-page-2": _message(
            "msg-page-2",
            subject="Receipt order #PAGE-200",
            sender="Apple <orders@apple.com>",
            body="Order total: USD 20.00",
        ),
    }

    def handler(request: httpx.Request):
        calls.append(request)
        if request.url.path.endswith("/messages"):
            if request.url.params.get("pageToken") == "cursor-2":
                return _response({"messages": [{"id": "msg-page-2"}]})
            return _response({"messages": [{"id": "msg-page-1"}], "nextPageToken": "cursor-2"})
        identity = request.url.path.rsplit("/", 1)[-1]
        return _response(messages[identity])

    service = GmailLiveReceiptsService(
        gmail=_Gmail(),
        transport=httpx.MockTransport(handler),
        source_secret=b"s" * 32,
        extractor=_extractor,
    )
    result = await _scan(service, page=2, per_page=1)

    assert [item["gmail_message_id"] for item in result["items"]] == ["msg-page-2"]
    assert result["coverage"]["pages_scanned"] == 2
    assert sum(request.url.path.endswith("/messages") for request in calls) == 2
    assert not any(request.url.path.endswith("/msg-page-1") for request in calls)
    assert "cursor-2" not in json.dumps(result)


async def test_pagination_stops_truthfully_and_rejects_unsafe_or_repeated_tokens():
    list_calls = 0

    def ended_handler(request: httpx.Request):
        nonlocal list_calls
        assert request.url.path.endswith("/messages")
        list_calls += 1
        return _response({"messages": []})

    ended = GmailLiveReceiptsService(
        gmail=_Gmail(),
        transport=httpx.MockTransport(ended_handler),
        source_secret=b"s" * 32,
        extractor=_extractor,
    )
    result = await _scan(ended, page=10, per_page=6)
    assert list_calls == 1
    assert result["coverage"]["pages_scanned"] == 1
    assert result["has_more"] is False

    for token in ("unsafe\nvalue", "cursor-2"):
        calls = 0

        def invalid_handler(request: httpx.Request, *, pagination_token=token):
            nonlocal calls
            assert request.url.path.endswith("/messages")
            calls += 1
            return _response({"messages": [], "nextPageToken": pagination_token})

        invalid = GmailLiveReceiptsService(
            gmail=_Gmail(),
            transport=httpx.MockTransport(invalid_handler),
            source_secret=b"s" * 32,
            extractor=_extractor,
        )
        requested_page = 1 if "\n" in token else 2
        with pytest.raises(GmailApiError) as caught:
            await _scan(invalid, page=requested_page, per_page=1)
        assert caught.value.code == "GMAIL_RECEIPT_INVALID_RESPONSE"
        assert calls == requested_page


async def test_signed_continuation_scans_300_without_replaying_or_changing_window():
    queries = []

    def handler(request: httpx.Request):
        if request.url.path.endswith("/messages"):
            page = int(request.url.params.get("pageToken", "1"))
            queries.append(request.url.params["q"])
            return _response(
                {
                    "messages": [{"id": f"m-{page}-{i}"} for i in range(6)],
                    "nextPageToken": str(page + 1),
                }
            )
        identity = request.url.path.rsplit("/", 1)[-1]
        return _response(
            _message(
                identity,
                subject="Your receipt",
                sender="orders@example.com",
                body="Order total: USD 20.00",
            )
        )

    service = GmailLiveReceiptsService(
        gmail=_Gmail(),
        transport=httpx.MockTransport(handler),
        source_secret=b"s" * 32,
        extractor=_extractor,
    )
    cursor = None
    identities = set()
    for page in range(1, 51):
        result = await _scan(service, page=page, cursor=cursor)
        identities.update(item["source_id"] for item in result["items"])
        assert result["coverage"]["pages_scanned"] == 1
        cursor = result["next_cursor"]
        if page == 1:
            with pytest.raises(GmailApiError):
                await _scan(service, page=2, cursor=cursor + "tampered")
            with pytest.raises(GmailApiError):
                await _scan(service, page=3, cursor=cursor)
    assert len(queries) == 50
    assert len(set(queries)) == 1
    assert "after:" in queries[0] and "before:" in queries[0]
    assert len(identities) == 300
    assert cursor is None and result["has_more"] is False
    assert result["coverage"]["reached_limit"] is True


async def test_continuation_rejects_cross_request_provider_cursor_cycle():
    def handler(request: httpx.Request):
        token = request.url.params.get("pageToken")
        return _response({"messages": [], "nextPageToken": "B" if token == "A" else "A"})

    service = GmailLiveReceiptsService(
        gmail=_Gmail(),
        transport=httpx.MockTransport(handler),
        source_secret=b"s" * 32,
        extractor=_extractor,
    )
    first = await _scan(service)
    second = await _scan(service, page=2, cursor=first["next_cursor"])
    with pytest.raises(GmailApiError) as caught:
        await _scan(service, page=3, cursor=second["next_cursor"])
    assert caught.value.code == "GMAIL_RECEIPT_INVALID_RESPONSE"


@pytest.mark.parametrize(
    "status", ["paid", "overdue", "refunded", "cancelled", "trial", "delivered"]
)
def test_receipt_enrichment_requires_source_quotes(status):
    passage = f"Invoice INV-20 is {status}. Monthly software membership."
    result = live_receipts_module._receipt_enrichment(
        {
            "status": status,
            "status_evidence": passage,
            "identifier_kind": "invoice",
            "identifier_value": "INV-20",
            "identifier_evidence": "Invoice INV-20",
            "short_detail": "Monthly software membership.",
            "cleaned_preview": passage,
        },
        {"body": passage},
    )
    assert result == {
        "status": status,
        "identifier_kind": "invoice",
        "identifier_value": "INV-20",
        "short_detail": "Monthly software membership.",
        "cleaned_preview": passage,
        "identifiers": [{"kind": "invoice", "value": "INV-20"}],
        "document_kind": None,
        "transaction_date": None,
    }


def test_receipt_attention_and_recurrence_are_independent_quote_bound_axes():
    passage = "Your recurring subscription renews October 18. Renewal due October 18."
    result = live_receipts_module._receipt_enrichment(
        {
            "status": "renewal_due",
            "status_evidence": "Renewal due October 18",
            "recurrence": "recurring",
            "recurrence_evidence": "recurring subscription renews October 18",
            "attention_state": "coming_up",
            "attention_reason": "renewal_due",
            "attention_evidence": "recurring subscription renews October 18",
            "attention_is_prediction": True,
            "attention_date": "October 18",
        },
        {"body": passage},
    )
    assert result["status"] == "renewal_due"
    assert result["recurrence"] == "recurring"
    assert result["attention_state"] == "coming_up"
    assert result["attention_reason"] == "renewal_due"
    assert result["attention_is_prediction"] is True
    assert result["attention_date"] == "October 18"


def test_receipt_prediction_without_recurring_evidence_fails_closed():
    result = live_receipts_module._receipt_enrichment(
        {
            "recurrence": "unknown",
            "recurrence_evidence": None,
            "attention_state": "coming_up",
            "attention_reason": "renewal_due",
            "attention_evidence": "Renewal due soon",
            "attention_is_prediction": True,
        },
        {"body": "Renewal due soon"},
    )
    assert result["recurrence"] == "unknown"
    assert result["attention_state"] == "none"
    assert result["attention_reason"] is None
    assert result["attention_is_prediction"] is False


async def test_explicit_invoice_amount_followed_by_due_is_a_verified_candidate():
    service = _service(
        [
            _message(
                "due-total",
                subject="Your Supabase invoice is overdue",
                sender="billing@unmapped.example",
                body="Your organization has an unpaid invoice with **$124.01 due since October 2**.",
            )
        ]
    )

    async def extract_overdue(payload, _user, _token):
        return {
            **_model_for(payload),
            "merchant_name": "Supabase",
            "merchant_evidence_id": "merchant:document",
            "merchant_evidence": "Supabase invoice",
            "status": "overdue",
            "status_evidence": "Supabase invoice is overdue",
            "attention_state": "needs_attention",
            "attention_reason": "overdue",
            "attention_evidence": "Supabase invoice is overdue",
        }

    service._extractor = extract_overdue
    item = (await _scan(service))["items"][0]
    assert item["amount"] == 124.01
    assert item["currency"] == "$"  # A bare dollar symbol does not prove USD.
    assert item["merchant_name"] == "Supabase"
    assert item["status"] == "overdue"
    assert item["attention_state"] == "needs_attention"
    assert item["attention_reason"] == "overdue"


def test_fulfillment_role_subdomain_is_not_verified_as_the_transaction_merchant():
    assert live_receipts_module._verified_merchant("shipping.amazon.in") is None
    assert live_receipts_module._verified_merchant("amazon.in").name == "Amazon"


def test_missing_or_invented_enrichment_never_falls_back_to_raw_body():
    evidence = {
        "body": "Your order is shipping. Return policy: request a refund. https://tracking.example/private"
    }
    assert all(
        value is None or value == []
        for value in live_receipts_module._receipt_enrichment({}, evidence).values()
    )
    result = live_receipts_module._receipt_enrichment(
        {
            "status": "paid",
            "status_evidence": "Payment completed",
            "identifier_kind": "pnr",
            "identifier_value": "MADEUP",
            "identifier_evidence": "PNR MADEUP",
            "short_detail": "Invented subscription",
            "cleaned_preview": evidence["body"],
        },
        evidence,
    )
    assert all(value is None or value == [] for value in result.values())


async def test_detail_is_account_bound_and_returns_only_labelled_bounded_excerpt():
    message = _message(
        "msg-detail",
        subject="Receipt order #DETAIL-10",
        sender="PayPal <receipts@paypal.com>",
        body="Order total: USD 42.00\nPrivate receipt excerpt",
    )
    service = _service([message])

    async def extract_preview(payload, _user, _token):
        return {**_model_for(payload), "cleaned_preview": "Private receipt excerpt"}

    service._extractor = extract_preview
    item = (await _scan(service))["items"][0]

    detail = await service.detail(
        user_id="owner",
        source_id=item["source_id"],
        consent_token=TEST_CONSENT_TOKEN,
        require_access=_allowed,
    )

    assert detail["item"]["source_id"] == item["source_id"]
    assert detail["item"]["gmail_message_id"] == "msg-detail"
    assert detail["email_excerpt"]["kind"] == "email_excerpt"
    assert detail["email_excerpt"]["label"] == "Email preview"
    assert "Private receipt excerpt" in detail["email_excerpt"]["text"]

    with pytest.raises(GmailApiError) as tampered:
        await service.detail(
            user_id="owner",
            source_id=item["source_id"][:-1] + ("0" if item["source_id"][-1] != "0" else "1"),
            consent_token=TEST_CONSENT_TOKEN,
            require_access=_allowed,
        )
    assert tampered.value.code == "GMAIL_RECEIPT_NOT_FOUND"

    service._gmail.row["google_sub"] = "different-account"
    with pytest.raises(GmailApiError) as caught:
        await service.detail(
            user_id="owner",
            source_id=item["source_id"],
            consent_token=TEST_CONSENT_TOKEN,
            require_access=_allowed,
        )
    assert caught.value.code == "GMAIL_RECEIPT_NOT_FOUND"
