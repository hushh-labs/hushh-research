"""Contracts for reading the owner's saved receipt memory (PKM canonical index).

The index is device-supplied, so these tests hold the boundary that matters: only
the closed, bounded fields ever enter, every value in an answer is copied from
the index and formatted by code, and anything missing is omitted, never filled in.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from hushh_mcp.services.receipt_memory_read import (
    NOT_READY_TEXT,
    RECEIPT_INDEX_MAX_BYTES,
    RECEIPT_INDEX_MAX_TRANSACTIONS,
    ReceiptMemoryIndex,
    ReceiptPlanError,
    ReceiptPlanFields,
    build_query,
    decode_cursor,
    format_amount,
    parse_receipt_index,
    read_receipt_memory,
)

NOW = datetime(2026, 10, 9, 10, 0, tzinfo=UTC)
LA = ZoneInfo("America/Los_Angeles")
UTC_ZONE = ZoneInfo("UTC")


def _txn(n: int, **over) -> dict:
    base = {
        "ref": f"txn_{n:016x}",
        "merchant": f"Shop {n}",
        "amount": 10.0 + n,
        "currency": "USD",
        "category": None,
        "status": "paid",
        "transaction_date": "2026-10-01",
        "identifiers": [],
        "detail": None,
    }
    base.update(over)
    return base


def _index(transactions: list[dict], *, generated_at="2026-10-08T09:00:00Z", total=None) -> dict:
    total = len(transactions) if total is None else total
    return {
        "schema": "receipt_canonical_index.v1",
        "generated_at": generated_at,
        "total_transactions": total,
        "truncated": total > len(transactions),
        "transactions": transactions,
    }


def _read(index, plan=None, *, cursor=None, zone=UTC_ZONE, now=NOW):
    return read_receipt_memory(
        index_raw=index,
        plan=plan or ReceiptPlanFields(),
        cursor_raw=cursor,
        zone=zone,
        now=now,
    )


def test_answer_uses_the_muse_layout_with_only_saved_facts():
    index = _index(
        [
            _txn(
                1,
                merchant="Supabase",
                amount=124.01,
                status="overdue",
                transaction_date="2026-10-04",
                identifiers=[{"kind": "invoice", "value": "ZSUQHV-00028"}],
            ),
            _txn(
                2,
                merchant="Anthropic",
                amount=20,
                status="paid",
                transaction_date="2026-09-18",
                detail="Claude Pro subscription",
            ),
        ]
    )
    outcome = _read(
        index, ReceiptPlanFields(since="2026-08-09", window_label="from the last 2 months")
    )
    assert outcome.status == "ok"
    assert outcome.text == (
        "Found 2 receipts from the last 2 months:\n\n"
        "- **Supabase** — $124.01 · Overdue · Oct 4  \n"
        "  Invoice ZSUQHV-00028.\n\n"
        "- **Anthropic** — $20.00 · Paid · Sep 18  \n"
        "  Claude Pro subscription."
    )
    # The raw internal reference is never part of the answer.
    assert "txn_" not in outcome.text


def test_newest_first_and_dates_follow_the_owner_zone_but_calendar_dates_never_shift():
    index = _index(
        [
            # 03:30 UTC on Oct 5 is still Oct 4 evening in Los Angeles.
            _txn(1, merchant="Instant", transaction_date="2026-10-05T03:30:00Z"),
            _txn(2, merchant="Calendar", transaction_date="2026-10-03"),
            _txn(3, merchant="Later", transaction_date="2026-10-04T20:00:00Z"),
        ]
    )
    text = _read(index, zone=LA).text
    assert [line for line in text.splitlines() if line.startswith("- ")] == [
        "- **Instant** — $11.00 · Paid · Oct 4",
        "- **Later** — $13.00 · Paid · Oct 4",
        "- **Calendar** — $12.00 · Paid · Oct 3",
    ]


def test_dates_outside_the_current_year_carry_the_year():
    index = _index([_txn(1, transaction_date="2025-12-30")])
    assert "Dec 30, 2025" in _read(index).text


def test_a_missing_amount_is_omitted_and_never_invented():
    index = _index(
        [
            _txn(1, merchant="NoAmount", amount=None, currency="USD", status="overdue"),
            # An amount with no currency cannot be a real currency string either.
            _txn(
                2, merchant="NoCurrency", amount=19.99, currency=None, transaction_date="2026-09-30"
            ),
            _txn(
                3, merchant="Bare", amount=None, currency=None, status=None, transaction_date=None
            ),
        ]
    )
    lines = [line for line in _read(index).text.splitlines() if line.startswith("- ")]
    assert lines == [
        "- **NoAmount** — Overdue · Oct 1",
        "- **NoCurrency** — Paid · Sep 30",
        "- **Bare**",
    ]


@pytest.mark.parametrize(
    ("amount", "currency", "expected"),
    [
        (124.01, "USD", "$124.01"),
        (20, "$", "$20.00"),
        (1249, "INR", "₹1,249.00"),
        (5.5, "EUR", "€5.50"),
        (7, "GBP", "£7.00"),
        (1234567.891, "CHF", "1,234,567.89 CHF"),
        (None, "USD", None),
        (9.99, None, None),
    ],
)
def test_amounts_are_real_currency_strings_or_nothing(amount, currency, expected):
    assert format_amount(amount, currency) == expected


def test_title_falls_back_like_the_receipts_page_and_identifier_types_are_preserved():
    index = _index(
        [
            _txn(
                1,
                merchant=None,
                category="Travel",
                identifiers=[{"kind": "pnr", "value": "AB12CD"}],
            ),
            _txn(2, merchant=None, category="Other", transaction_date="2026-09-30"),
            _txn(
                3,
                merchant="Shop",
                transaction_date="2026-09-29",
                identifiers=[
                    {"kind": "order", "value": "A-1"},
                    {"kind": "receipt", "value": "R-9"},
                    {"kind": "invoice", "value": "I-3"},
                ],
            ),
        ]
    )
    text = _read(index).text
    assert "- **Travel** — $11.00 · Paid · Oct 1  \n  PNR AB12CD." in text
    assert "- **Receipt** — $12.00 · Paid · Sep 30" in text
    # At most two identifiers, each with its own type, in the order saved.
    assert "  Order A-1. Receipt R-9." in text
    assert "I-3" not in text


def test_window_is_inclusive_in_the_owner_zone_and_undated_receipts_are_named_not_placed():
    index = _index(
        [
            _txn(1, transaction_date="2026-08-09"),
            _txn(2, transaction_date="2026-08-08"),
            _txn(3, transaction_date="2026-10-09"),
            _txn(4, transaction_date="2026-10-10"),
            _txn(5, transaction_date=None),
        ]
    )
    outcome = _read(index, ReceiptPlanFields(since="2026-08-09", until="2026-10-09"))
    assert outcome.coverage["matched"] == 2
    assert "Shop 1" in outcome.text and "Shop 3" in outcome.text
    assert "Shop 2" not in outcome.text and "Shop 4" not in outcome.text
    assert "1 saved receipt has no date, so I couldn't place it in that window." in outcome.text


def test_status_identifier_and_merchant_filters_apply_the_plan_exactly():
    index = _index(
        [
            _txn(
                1,
                merchant="Supabase",
                status="overdue",
                identifiers=[{"kind": "invoice", "value": "I-1"}],
            ),
            _txn(
                2,
                merchant="Supabase",
                status="paid",
                identifiers=[{"kind": "invoice", "value": "I-2"}],
            ),
            _txn(
                3,
                merchant="Amazon",
                status="overdue",
                identifiers=[{"kind": "order", "value": "O-3"}],
            ),
        ]
    )
    overdue = _read(index, ReceiptPlanFields(statuses=("overdue",)))
    assert overdue.text.startswith("Found 2 overdue receipts:")
    invoices = _read(index, ReceiptPlanFields(identifier_kinds=("invoice",)))
    assert invoices.text.startswith("Found 2 invoices:")
    assert "Amazon" not in invoices.text
    both = _read(index, ReceiptPlanFields(statuses=("overdue",), merchant="supa"))
    # The merchant is named as its own receipts spell it, not as the request typed it.
    assert both.text.startswith("Found 1 Supabase overdue receipt:")
    assert "I-1" in both.text and "I-2" not in both.text


def test_zero_matches_speaks_about_saved_memory_never_the_mailbox():
    index = _index([_txn(1, transaction_date="2026-10-01")])
    outcome = _read(
        index,
        ReceiptPlanFields(since="2026-01-01", until="2026-02-01", window_label="from January"),
    )
    assert outcome.text == "I don't see any receipts from January in your saved receipt memory."
    assert "mailbox" not in outcome.text.lower() and "inbox" not in outcome.text.lower()
    assert outcome.status == "ok" and not outcome.propose_open_receipts


def test_show_more_returns_the_next_page_of_the_same_list_and_ends_cleanly():
    transactions = [_txn(n, transaction_date=f"2026-09-{n:02d}") for n in range(1, 26)]
    index = _index(transactions)
    first = _read(index, ReceiptPlanFields(since="2026-09-01", window_label="since September"))
    assert first.text.startswith("Found 25 receipts since September. Here are the newest 10:")
    assert first.text.count("- **") == 10
    assert "Shop 25" in first.text and "Shop 16" in first.text and "Shop 15" not in first.text
    assert first.text.endswith("Say “show more” for the next 10.")
    assert first.cursor_action == "set" and first.has_more

    second = _read(index, ReceiptPlanFields(more=True), cursor=first.cursor)
    assert second.text.startswith("Showing 11–20 of 25 receipts since September:")
    assert "Shop 15" in second.text and "Shop 6" in second.text and "Shop 16" not in second.text
    assert second.text.endswith("Say “show more” for the next 5.")

    third = _read(index, ReceiptPlanFields(more=True), cursor=second.cursor)
    assert third.text.startswith("Showing 21–25 of 25 receipts since September:")
    assert "Shop 5" in third.text and "Shop 1" in third.text
    assert "show more" not in third.text
    assert third.cursor_action == "clear" and third.cursor is None


def test_a_cursor_cannot_outlive_its_list_its_save_or_its_ttl():
    transactions = [_txn(n, transaction_date=f"2026-09-{n:02d}") for n in range(1, 26)]
    index = _index(transactions)
    first = _read(index)
    parsed = parse_receipt_index(index)

    # Same save, inside the TTL: accepted.
    assert decode_cursor(first.cursor, index=parsed, now=NOW + timedelta(minutes=5)) is not None
    # Past the TTL: no list to continue.
    expired = _read(
        index, ReceiptPlanFields(more=True), cursor=first.cursor, now=NOW + timedelta(hours=1)
    )
    assert expired.text.startswith("I don't have an earlier receipts list to continue.")
    assert expired.cursor_action == "clear"
    # A newer save replaces the index, so the old position is meaningless.
    resaved = _index(transactions, generated_at="2026-10-09T08:00:00Z")
    stale = _read(resaved, ReceiptPlanFields(more=True), cursor=first.cursor)
    assert stale.text.startswith("I don't have an earlier receipts list to continue.")
    # Tampered or absent cursors are the same as none.
    assert _read(index, ReceiptPlanFields(more=True), cursor="not json").cursor_action == "clear"
    assert _read(index, ReceiptPlanFields(more=True), cursor=None).cursor_action == "clear"


def test_show_more_with_new_filters_is_ambiguous_and_leaves_the_stored_position():
    index = _index([_txn(n, transaction_date=f"2026-09-{n:02d}") for n in range(1, 26)])
    first = _read(index)
    outcome = _read(index, ReceiptPlanFields(more=True, statuses=("paid",)), cursor=first.cursor)
    assert outcome.status == "input_required" and outcome.cursor_action == "keep"
    assert outcome.cursor is None


@pytest.mark.parametrize(
    ("index", "now", "reason"),
    [
        (None, NOW, "missing"),
        ({"schema": "receipt_canonical_index.v1"}, NOW, "missing"),
        (_index([]), NOW, "empty"),
    ],
)
def test_missing_or_empty_memory_is_not_ready_and_never_claims_an_empty_mailbox(index, now, reason):
    outcome = _read(index, ReceiptPlanFields(since="2026-08-09"), now=now)
    assert outcome.text == NOT_READY_TEXT
    assert (
        NOT_READY_TEXT
        == "Your receipt memory is not ready yet. Sync and save your receipts in Mail."
    )
    assert outcome.status == "input_required"
    assert outcome.propose_open_receipts and outcome.coverage is None
    assert outcome.drift == (f"receipt_memory_{reason}",)
    assert "no receipts" not in outcome.text.lower()


def test_saved_receipts_persist_so_an_old_save_is_answered_with_when_it_was_last_synced():
    # A save keeps answering until the owner resets it: age never makes it unreadable.
    recent = _index([_txn(1)], generated_at="2026-10-02T10:00:00Z")
    assert "last synced" not in _read(recent).text
    old = _index([_txn(1)], generated_at="2026-09-01T09:00:00Z")
    outcome = _read(old)
    assert outcome.status == "ok" and outcome.text != NOT_READY_TEXT
    assert "Shop 1" in outcome.text
    assert (
        "These receipts were last synced on Sep 1. Sync again in Mail to refresh them."
        in outcome.text
    )
    assert outcome.coverage is not None and outcome.coverage["memory_old"] is True
    assert not outcome.propose_open_receipts
    # A device clock ahead of the server is not a reason to stop answering.
    future = _index([_txn(1)], generated_at="2026-10-20T09:00:00Z")
    assert _read(future).status == "ok"


def test_the_optional_logo_domain_and_account_reference_are_accepted_only_when_well_formed():
    good = _index([_txn(1, logo_domain="supabase.io")])
    good["account_ref"] = "acct_" + "ab" * 12
    parsed = parse_receipt_index(good)
    assert parsed is not None and parsed.transactions[0].logo_domain == "supabase.io"
    for bad_domain in ("https://evil.example/x", "evil.com/<script>", "Evil.COM", "a b.com"):
        assert parse_receipt_index(_index([_txn(1, logo_domain=bad_domain)])) is None
    for bad_ref in ("acct_zz", "someone@example.com", "x" * 80):
        bad = _index([_txn(1)])
        bad["account_ref"] = bad_ref
        assert parse_receipt_index(bad) is None


def test_a_truncated_index_says_older_receipts_may_be_missing():
    transactions = [_txn(n, transaction_date=f"2026-09-{n:02d}") for n in range(1, 4)]
    index = _index(transactions, total=140)
    text = _read(index).text
    assert "Your receipt memory holds your newest 3 receipts, so older ones may be missing." in text
    # A window that starts inside what is stored needs no such caveat.
    inside = _read(index, ReceiptPlanFields(since="2026-09-02")).text
    assert "older ones may be missing" not in inside


@pytest.mark.parametrize(
    "extra",
    [
        {"body": "Thanks for your order"},
        {"snippet": "preview"},
        {"subject": "Your invoice"},
        {"gmail_message_id": "18c0ffee"},
        {"source_id": "gmail_live_abc.0123"},
        {"tracking_url": "https://track.example/123"},
        # The device keeps sealed action references to itself; a stray one is refused.
        {"action": {"kind": "pay_due", "ref": "ra1.AAAAAAAAAAAA"}},
    ],
)
def test_index_admission_is_closed_so_no_raw_email_can_ride_along(extra):
    clean = _index([_txn(1)])
    assert parse_receipt_index(clean) is not None
    smuggled = _index([{**_txn(1), **extra}])
    assert parse_receipt_index(smuggled) is None
    top_level = {**clean, **extra}
    assert parse_receipt_index(top_level) is None


def test_index_admission_rejects_unbounded_inconsistent_or_unzoned_indexes():
    too_many = _index([_txn(n) for n in range(RECEIPT_INDEX_MAX_TRANSACTIONS + 1)])
    assert parse_receipt_index(too_many) is None
    assert parse_receipt_index(_index([_txn(1), _txn(1)])) is None  # duplicate ref
    assert parse_receipt_index({**_index([_txn(1)]), "total_transactions": 0}) is None
    assert parse_receipt_index({**_index([_txn(1)]), "truncated": True}) is None
    assert parse_receipt_index(_index([_txn(1)], generated_at="2026-10-08T09:00:00")) is None
    assert parse_receipt_index(_index([_txn(1, ref="gmail-message-18c0ffee")])) is None
    assert parse_receipt_index(_index([_txn(1, status="bogus")])) is None
    assert parse_receipt_index("x" * (RECEIPT_INDEX_MAX_BYTES + 1)) is None
    assert parse_receipt_index(None) is None and parse_receipt_index(["a"]) is None


def test_email_derived_text_is_inert_in_chat():
    index = parse_receipt_index(
        _index(
            [
                _txn(
                    1,
                    merchant="**Evil** [pay](https://x.test)",
                    detail="Open https://evil.test/pay now",
                    identifiers=[{"kind": "order", "value": "A-1"}],
                ),
                _txn(2, merchant="AT&T", detail="Line one\nLine two <b>bold</b>"),
                _txn(3, merchant="billing@shop.test", detail="x" * 400),
                _txn(4, detail="- Free trial\n# Billing\n1. Pro plan"),
            ]
        )
    )
    assert isinstance(index, ReceiptMemoryIndex)
    first, second, third, fourth = index.transactions
    # A link-bearing field is dropped whole, not trimmed into something plausible.
    assert first.detail is None and "https" not in (first.merchant or "")
    assert "*" not in (first.merchant or "") and "[" not in (first.merchant or "")
    assert second.merchant == "AT&T"
    assert second.detail == "Line one Line two b bold /b"
    assert third.merchant is None
    assert third.detail is not None and len(third.detail) <= 120 and third.detail.endswith("…")
    # A leading list or heading marker cannot turn the detail line into structure.
    assert fourth.detail == "Free trial # Billing 1. Pro plan"


def test_plan_fields_are_validated_not_repaired():
    with pytest.raises(ReceiptPlanError):
        build_query(ReceiptPlanFields(since="2026/08/09"))
    with pytest.raises(ReceiptPlanError):
        build_query(ReceiptPlanFields(since="2026-10-09", until="2026-08-09"))
    with pytest.raises(ReceiptPlanError):
        build_query(ReceiptPlanFields(statuses=("on_fire",)))
    with pytest.raises(ReceiptPlanError):
        build_query(ReceiptPlanFields(merchant="https://evil.test"))
    # An unusable window label is dropped; the header falls back to the dates.
    query = build_query(ReceiptPlanFields(since="2026-08-09", window_label="see https://x.test"))
    assert query.window_label == ""
    index = _index([_txn(1, transaction_date="2026-09-01")])
    text = _read(
        index, ReceiptPlanFields(since="2026-08-09", window_label="see https://x.test")
    ).text
    assert text.startswith("Found 1 receipt since Aug 9:")


def test_a_time_phrase_without_dates_is_never_claimed_as_a_window():
    index = _index([_txn(1, transaction_date="2024-01-01"), _txn(2, transaction_date="2026-10-01")])
    # No dates behind the phrase means no window was applied, so none is named.
    outcome = _read(index, ReceiptPlanFields(window_label="from this week"))
    assert outcome.text.startswith("Found 2 receipts:")
    assert "this week" not in outcome.text
    # With dates behind it, the planner's own words head the answer.
    dated = _read(index, ReceiptPlanFields(since="2026-09-01", window_label="from this month"))
    assert dated.text.startswith("Found 1 receipt from this month:")


def test_show_more_ignores_a_decorative_window_label_but_not_a_real_filter():
    index = _index([_txn(n, transaction_date=f"2026-09-{n:02d}") for n in range(1, 26)])
    first = _read(index)
    with_label = _read(
        index,
        ReceiptPlanFields(more=True, window_label="from the last 2 months"),
        cursor=first.cursor,
    )
    assert with_label.text.startswith("Showing 11–20 of 25 receipts:")
    with_filter = _read(index, ReceiptPlanFields(more=True, merchant="Shop"), cursor=first.cursor)
    assert with_filter.cursor_action == "keep" and with_filter.status == "input_required"
